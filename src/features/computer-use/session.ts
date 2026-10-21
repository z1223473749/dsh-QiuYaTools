import { ComputerError, checkActionBounds, computerError, parseComputerAction, requireIdentity, sameGeometry, validGeometry } from './contract.ts'
import type { ComputerActionRequest, ComputerActionResult, ComputerObservation, ComputerSessionSnapshot, ComputerState, DeviceDriver, NativeTarget } from './contract.ts'

interface SessionRecord { snapshot: ComputerSessionSnapshot; controllers: Set<AbortController>; pending: Set<Promise<unknown>>; actions: Map<string, { fingerprint: string; promise: Promise<ComputerActionResult>; settled: boolean }>; allowOnce: boolean; previewFrames: Map<string, { metadata: NonNullable<ComputerSessionSnapshot['lastObservation']>; capturedAt: number }>; transition?: Promise<ComputerSessionSnapshot> }
export interface ComputerSessionOptions {
  enabled?: () => boolean
  readAllowedApps?: () => readonly string[]
  writeAllowedApps?: (appIds: string[]) => void | Promise<void>
  now?: () => number
}
/** One service owns one real desktop. Native epoch fencing remains authoritative. */
export class ComputerSessionService {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly listeners = new Set<() => void>()
  private readonly allowed = new Set<string>()
  private readonly denied = new Set<string>()
  private permissionTail: Promise<void> = Promise.resolve()
  private permissionVersion = 0
  private readonly permissionIntents = new Map<string, number>()
  /** Native leases survive generation invalidation until release is confirmed. */
  private readonly leases = new Map<number, string>()
  private readonly releasing = new Map<number, Promise<void>>()
  private ownerControlVersion = 0
  private activeSession: string | undefined
  private nextEpoch = 0
  private disposed = false
  private disposing?: Promise<void>
  private tail: Promise<unknown> = Promise.resolve()
  private readonly unsubscribe?: () => void
  constructor(readonly driver: DeviceDriver, private readonly options: ComputerSessionOptions = {}) {
    this.unsubscribe = driver.subscribe?.(event => {
      if (event.event === 'previewClosed' || event.event === 'humanInput') {
        const id = event.sessionId ?? this.activeSession
        if (id) void this.pause(id).catch(() => {})
      } else if (event.event === 'disconnected') {
        for (const record of this.sessions.values()) if (!['stopped', 'faulted', 'disconnected'].includes(record.snapshot.state)) { this.invalidate(record); this.change(record, 'disconnected', new ComputerError('DISCONNECTED', '电脑操控连接已断开')) }
        this.activeSession = undefined
      }
    })
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private notify(): void { for (const listener of this.listeners) { try { listener() } catch {} } }
  private clock(): number { return this.options.now?.() ?? Date.now() }
  private change(record: SessionRecord, state: ComputerState, error?: unknown): void {
    record.snapshot = { ...record.snapshot, state, updatedAt: this.clock(), ...(error ? { error: computerError(error) } : {}) }
    if (!error) delete record.snapshot.error
    this.notify()
  }
  private assertLive(): void { if (this.disposed) throw new ComputerError('DISPOSED', '电脑操控已停用') }
  private assertEnabled(): void { this.assertLive(); if (this.options.enabled?.() === false) throw new ComputerError('DISABLED', '电脑操控未启用') }
  private record(sessionId: string): SessionRecord {
    this.assertLive(); requireIdentity(sessionId, '会话')
    const record = this.sessions.get(sessionId)
    if (!record) throw new ComputerError('SESSION_NOT_STARTED', '请先在电脑操控面板选择应用并开始')
    return record
  }
  get(sessionId: string): ComputerSessionSnapshot | undefined { const value = this.sessions.get(sessionId)?.snapshot; return value ? structuredClone(value) : undefined }
  list(): ComputerSessionSnapshot[] { return [...this.sessions.keys()].map(id => this.get(id)!) }
  status(signal?: AbortSignal) { this.assertLive(); return this.driver.status(signal) }
  targets(signal?: AbortSignal) { this.assertLive(); return this.driver.targets(signal) }
  allowedApps(): string[] { return [...new Set([...(this.options.readAllowedApps?.() ?? []), ...this.allowed])].filter(id => !this.denied.has(id)).sort() }
  setAppAllowed(appId: string, allowed: boolean): Promise<void> {
    this.assertLive(); requireIdentity(appId, '应用')
    const version = ++this.permissionVersion
    this.permissionIntents.set(appId, version)
    if (allowed && !this.allowedApps().includes(appId)) this.denied.add(appId)
    let stopping: Promise<unknown> = Promise.resolve()
    if (!allowed) {
      // Revocation takes effect even if persisting the preference later fails.
      this.denied.add(appId); this.allowed.delete(appId)
      const affected = [...this.sessions.values()].filter(record => record.snapshot.target?.appId === appId)
      stopping = Promise.all(affected.map(record => this.stop(record.snapshot.sessionId)))
    }
    this.notify()
    // Attach the rejection observer immediately even when an earlier disk
    // operation is still running. The caller still receives the failure.
    void stopping.catch(() => {})
    const writing = this.permissionTail.catch(() => {}).then(async () => {
      const values = new Set(this.allowedApps())
      if (allowed) values.add(appId); else values.delete(appId)
      await this.options.writeAllowedApps?.([...values].sort())
      if (this.permissionIntents.get(appId) === version) {
        if (allowed) this.denied.delete(appId)
        this.allowed.clear(); values.forEach(value => this.allowed.add(value))
        this.notify()
      }
      // Persist a deny even if native cleanup fails. A successful revoke still
      // waits for both storage and the independent immediate input release.
      await stopping
    })
    this.permissionTail = writing.catch(() => {})
    return writing
  }
  private hasLease(sessionId: string): boolean { return [...this.leases.values()].includes(sessionId) }
  private async releaseLeases(sessionId: string): Promise<void> {
    for (const [epoch, owner] of this.leases) {
      if (owner !== sessionId) continue
      let pending = this.releasing.get(epoch)
      if (!pending) {
        pending = this.driver.release(epoch).then(() => { this.leases.delete(epoch) })
        this.releasing.set(epoch, pending)
        void pending.then(() => { this.releasing.delete(epoch) }, () => { this.releasing.delete(epoch) })
      }
      await pending
    }
  }
  private async acquireLease(record: SessionRecord, epoch: number, signal?: AbortSignal, actor: 'ai' | 'human' = 'ai'): Promise<void> {
    await this.releaseLeases(record.snapshot.sessionId)
    signal?.throwIfAborted()
    if (record.snapshot.epoch !== epoch) throw new ComputerError('CONTROL_CHANGED', '租约建立已取消')
    this.assertEnabled()
    if (this.leases.size) throw new ComputerError('NATIVE_LEASE_UNRELEASED', '旧电脑输入租约尚未完成清理')
    // Record before dispatch: a lost reply can still mean the native lease ran.
    this.leases.set(epoch, record.snapshot.sessionId)
    await this.driver.lease(epoch, signal, { actor })
  }
  private isAllowed(record: SessionRecord): boolean { return record.allowOnce || this.allowedApps().includes(record.snapshot.target?.appId ?? '') }
  async permittedTargets(sessionId: string, signal?: AbortSignal): Promise<NativeTarget[]> {
    const record = this.record(sessionId)
    this.fence(record, record.snapshot.epoch)
    const apps = new Set(this.allowedApps())
    if (record.allowOnce && record.snapshot.target) apps.add(record.snapshot.target.appId)
    return (await this.targets(signal)).filter(target => apps.has(target.appId))
  }
  /** Agents may change targets only within grants the owner has already made. */
  async selectTarget(sessionId: string, targetId: string, signal?: AbortSignal): Promise<ComputerSessionSnapshot> {
    const record = this.record(sessionId), epoch = record.snapshot.epoch
    const controlVersion = this.ownerControlVersion
    this.fence(record, epoch)
    const target = (await this.permittedTargets(sessionId, signal)).find(item => item.id === targetId)
    this.fence(record, epoch); signal?.throwIfAborted()
    if (!target) throw new ComputerError('APP_NOT_ALLOWED', '目标应用尚未授权或已关闭')
    const allowOnce = record.allowOnce && target.appId === record.snapshot.target?.appId
    await this.transition(sessionId, 'stopped')
    signal?.throwIfAborted()
    if (this.ownerControlVersion !== controlVersion || record.snapshot.state !== 'stopped') throw new ComputerError('CONTROL_CHANGED', '切换目标已被用户控制动作取消')
    return this.start(sessionId, targetId, { allowOnce, signal })
  }
  private fence(record: SessionRecord, epoch: number, human = false): void {
    this.assertEnabled()
    if (this.activeSession !== record.snapshot.sessionId || record.snapshot.epoch !== epoch || !(human ? record.snapshot.state === 'humanControl' : ['ready', 'running'].includes(record.snapshot.state))) throw new ComputerError('CONTROL_CHANGED', '操作控制权已变化，请重新观察后继续')
    if (!this.isAllowed(record)) throw new ComputerError('APP_NOT_ALLOWED', '应用授权已撤销')
  }
  private invalidate(record: SessionRecord): number {
    const oldEpoch = record.snapshot.epoch
    record.snapshot = { ...record.snapshot, epoch: ++this.nextEpoch }
    delete record.snapshot.lastObservation
    record.previewFrames.clear()
    for (const controller of record.controllers) controller.abort(new ComputerError('CONTROL_CHANGED', '操作已暂停或停止'))
    return oldEpoch
  }
  private async operation<T>(record: SessionRecord, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
    record.controllers.add(controller)
    const promise = (async () => { controller.signal.throwIfAborted(); return run(controller.signal) })()
    record.pending.add(promise)
    try { return await promise } finally { record.pending.delete(promise); record.controllers.delete(controller); signal?.removeEventListener('abort', abort) }
  }
  async start(sessionId: string, targetId: string, options: { allowOnce?: boolean; signal?: AbortSignal } = {}): Promise<ComputerSessionSnapshot> {
    this.assertEnabled(); requireIdentity(sessionId, '会话'); requireIdentity(targetId, '目标')
    if (this.activeSession && this.activeSession !== sessionId) throw new ComputerError('DEVICE_BUSY', '另一个会话正在控制此电脑，请先停止')
    const previous = this.sessions.get(sessionId)
    if (previous && !['stopped', 'faulted', 'disconnected'].includes(previous.snapshot.state)) throw new ComputerError('ALREADY_STARTED', '此会话已开始，请先停止或继续')
    if (!previous && this.sessions.size >= 128) {
      for (const [id, record] of this.sessions) if (['stopped', 'faulted', 'disconnected'].includes(record.snapshot.state)) { this.sessions.delete(id); if (this.sessions.size < 128) break }
      if (this.sessions.size >= 128) throw new ComputerError('SESSION_LIMIT', '电脑会话数量已达上限')
    }
    const record: SessionRecord = { snapshot: { sessionId, state: 'connecting', target: null, epoch: ++this.nextEpoch, updatedAt: this.clock() }, controllers: new Set(), pending: new Set(), actions: new Map(), previewFrames: new Map(), allowOnce: options.allowOnce === true }
    this.sessions.set(sessionId, record); this.activeSession = sessionId; this.notify()
    const epoch = record.snapshot.epoch
    try {
      await this.operation(record, options.signal, async signal => {
        const targets = await this.driver.targets(signal)
        signal.throwIfAborted()
        if (record.snapshot.epoch !== epoch) throw new ComputerError('CONTROL_CHANGED', '开始操作已取消')
        const target = targets.find(item => item.id === targetId)
        if (!target || !validGeometry(target)) throw new ComputerError('TARGET_NOT_FOUND', '目标窗口已关闭或不可用')
        requireIdentity(target.appId, '应用')
        if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || typeof target.title !== 'string') throw new ComputerError('INVALID_TARGET', '执行器返回的应用身份无效')
        record.snapshot.target = { ...target }
        if (!this.isAllowed(record)) throw new ComputerError('APP_NOT_ALLOWED', '请先允许此应用，或从面板授权本次操作')
        await this.acquireLease(record, epoch, signal)
        signal.throwIfAborted()
        if (record.snapshot.epoch !== epoch) throw new ComputerError('CONTROL_CHANGED', '开始操作已取消')
      })
      this.change(record, 'ready'); return this.get(sessionId)!
    } catch (error) {
      if (record.snapshot.epoch === epoch) { this.invalidate(record); this.change(record, 'faulted', error) }
      await this.releaseLeases(sessionId).catch(() => {})
      if (!this.hasLease(sessionId) && this.activeSession === sessionId && record.snapshot.state === 'faulted') this.activeSession = undefined
      throw error
    }
  }
  async observe(sessionId: string, signal?: AbortSignal): Promise<ComputerObservation> { return this.capture(sessionId, signal, false) }
  async preview(sessionId: string, signal?: AbortSignal): Promise<ComputerObservation> { return this.capture(sessionId, signal, true) }
  private validateObservation(observation: ComputerObservation, target: NativeTarget): void {
    if (observation.targetId !== target.id || observation.mediaType !== 'image/jpeg' || !validGeometry(observation.geometry) || !Number.isInteger(observation.width) || observation.width < 1 || !Number.isInteger(observation.height) || observation.height < 1 || typeof observation.elements !== 'string' || observation.elements.length > 2_000_000 || typeof observation.imageBase64 !== 'string' || observation.imageBase64.length === 0 || observation.imageBase64.length > 32 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(observation.imageBase64) || observation.imageBase64.length % 4 !== 0) throw new ComputerError('INVALID_OBSERVATION', '原生执行器返回了无效画面')
    requireIdentity(observation.frameId, '帧')
  }
  private async capture(sessionId: string, signal: AbortSignal | undefined, preview: boolean): Promise<ComputerObservation> {
    this.assertEnabled()
    const record = this.record(sessionId), target = record.snapshot.target, epoch = record.snapshot.epoch
    if (!target || !['ready', 'running', 'paused', 'humanControl'].includes(record.snapshot.state)) throw new ComputerError('NOT_READY', '电脑会话尚未就绪')
    return this.operation(record, signal, async operationSignal => {
      const current = (await this.driver.targets(operationSignal)).find(item => item.id === target.id)
      operationSignal.throwIfAborted()
      if (!current || current.pid !== target.pid || current.appId !== target.appId) throw new ComputerError('TARGET_CHANGED', '目标应用身份已变化，请重新选择并授权')
      const observation = await (preview && this.driver.preview ? this.driver.preview(target.id, operationSignal) : this.driver.observe(target.id, operationSignal))
      operationSignal.throwIfAborted()
      if (record.snapshot.epoch !== epoch) throw new ComputerError('CONTROL_CHANGED', '观察期间控制权已变化')
      this.validateObservation(observation, target)
      record.snapshot.target = { ...current, ...observation.geometry }
      const { imageBase64: _, elements: _elements, mediaType: _mediaType, ...metadata } = observation
      if (preview) {
        const now = this.clock()
        for (const [id, frame] of record.previewFrames) if (now - frame.capturedAt > 2000) record.previewFrames.delete(id)
        record.previewFrames.set(metadata.frameId, { metadata: structuredClone(metadata), capturedAt: now })
        while (record.previewFrames.size > 8) record.previewFrames.delete(record.previewFrames.keys().next().value!)
      }
      else { record.snapshot.lastObservation = structuredClone(metadata); this.notify() }
      return observation
    })
  }
  act(sessionId: string, request: ComputerActionRequest, signal?: AbortSignal): Promise<ComputerActionResult> { return this.dispatch(sessionId, request, signal, false) }
  humanAct(sessionId: string, request: ComputerActionRequest, signal?: AbortSignal): Promise<ComputerActionResult> { return this.dispatch(sessionId, request, signal, true) }
  private dispatch(sessionId: string, request: ComputerActionRequest, signal: AbortSignal | undefined, human: boolean): Promise<ComputerActionResult> {
    const record = this.record(sessionId), epoch = record.snapshot.epoch
    requireIdentity(request?.actionId, '操作'); requireIdentity(request?.frameId, '帧')
    const action = parseComputerAction(request.action)
    if (['navigate', 'openTab', 'closeTab', 'selectorClick', 'selectorType'].includes(action.kind) && !this.driver.resolveActionTarget) throw new ComputerError('BROWSER_ACTION_UNSUPPORTED', '当前执行器不支持浏览器专用操作')
    const fingerprint = JSON.stringify({ epoch, frameId: request.frameId, action, human })
    const old = record.actions.get(request.actionId)
    if (old) {
      if (old.fingerprint !== fingerprint) throw new ComputerError('ACTION_ID_CONFLICT', '操作标识已用于其他内容或控制周期')
      return old.promise
    }
    this.fence(record, epoch, human)
    const readObservation = () => {
      if (!human) return record.snapshot.lastObservation
      const frame = record.previewFrames.get(request.frameId)
      return frame && this.clock() - frame.capturedAt <= 2000 ? frame.metadata : undefined
    }
    const observation = readObservation()
    if (!observation || observation.frameId !== request.frameId) throw new ComputerError('STALE_OBSERVATION', '请先获取当前截图再执行操作')
    checkActionBounds(action, observation)
    for (const [id, entry] of record.actions) if (record.actions.size >= 128 && entry.settled) record.actions.delete(id)
    if (record.actions.size >= 128) throw new ComputerError('QUEUE_FULL', '操作队列已满')
    const target = record.snapshot.target!
    const execute = async (): Promise<ComputerActionResult> => {
      this.fence(record, epoch, human)
      if (readObservation()?.frameId !== request.frameId) throw new ComputerError('STALE_OBSERVATION', '截图已过期，请重新观察')
      if (!human) this.change(record, 'running')
      try {
        const result = await this.operation(record, signal, async operationSignal => {
          const targets = await this.driver.targets(operationSignal)
          const current = targets.find(value => value.id === target.id)
          this.fence(record, epoch, human); operationSignal.throwIfAborted()
          if (!current || current.pid !== target.pid || current.appId !== target.appId || !sameGeometry(current, observation.geometry)) throw new ComputerError('STALE_OBSERVATION', '目标窗口或缩放已变化，请重新观察')
          record.snapshot.lastAction = { actionId: request.actionId, action: { ...action }, phase: 'executing', at: this.clock() }; this.notify()
          return this.driver.act(epoch, target.id, action, operationSignal)
        })
        this.fence(record, epoch, human)
        if (['navigate', 'openTab', 'closeTab'].includes(action.kind)) {
          if (!this.driver.resolveActionTarget) throw new ComputerError('BROWSER_ACTION_UNSUPPORTED', '当前执行器不支持浏览器标签页操作')
          const next = await this.driver.resolveActionTarget(target, action, result, signal)
          this.fence(record, epoch, human)
          if (next === null) {
            this.invalidate(record)
            await this.releaseLeases(sessionId)
            record.allowOnce = false
            if (this.activeSession === sessionId) this.activeSession = undefined
            record.snapshot.lastAction = { actionId: request.actionId, action: { ...action }, phase: 'completed', at: this.clock() }
            this.change(record, 'stopped')
            return { actionId: request.actionId, targetId: target.id, epoch, result }
          }
          if (!validGeometry(next) || !Number.isSafeInteger(next.pid) || next.pid <= 0) throw new ComputerError('INVALID_TARGET', '浏览器目标身份无效')
          requireIdentity(next.id, '目标'); requireIdentity(next.appId, '应用')
          record.snapshot.target = { ...next }
          // The browser adapter attests this target is inside the owner's
          // explicit site allowlist; this workflow grant is never persisted.
          record.allowOnce = true
        }
        delete record.snapshot.lastObservation
        record.previewFrames.clear()
        record.snapshot.lastAction = { actionId: request.actionId, action: { ...action }, phase: 'completed', at: this.clock() }
        this.change(record, human ? 'humanControl' : 'ready')
        return { actionId: request.actionId, targetId: target.id, epoch, result }
      } catch (error) {
        delete record.snapshot.lastObservation
        record.previewFrames.clear()
        if (record.snapshot.lastAction?.actionId === request.actionId) { record.snapshot.lastAction = { ...record.snapshot.lastAction, phase: 'failed', at: this.clock() }; this.notify() }
        if (record.snapshot.epoch === epoch) {
          this.invalidate(record)
          this.change(record, 'pausing', error)
          try { await this.releaseLeases(sessionId); this.change(record, 'paused', error) } catch (releaseError) { this.change(record, 'faulted', releaseError) }
        }
        throw error
      }
    }
    const promise = this.tail.then(execute)
    const entry = { fingerprint, promise, settled: false }
    record.actions.set(request.actionId, entry)
    this.tail = promise.catch(() => {})
    void promise.then(() => { entry.settled = true }, () => { entry.settled = true })
    return promise
  }
  private transition(sessionId: string, state: 'paused' | 'humanControl' | 'stopped'): Promise<ComputerSessionSnapshot> {
    const record = this.record(sessionId)
    if (record.transition) return record.transition.then(() => this.transition(sessionId, state))
    if (record.snapshot.state === 'stopped') return Promise.resolve(this.get(sessionId)!)
    if (record.snapshot.state === state) return Promise.resolve(this.get(sessionId)!)
    this.invalidate(record)
    this.change(record, state === 'stopped' ? 'stopping' : state === 'humanControl' ? 'handingOver' : 'pausing')
    const promise = (async () => {
      try {
        await this.releaseLeases(sessionId)
        await Promise.allSettled([...record.pending])
        // A cancelled acquisition may have registered its uncertain native
        // lease while we were waiting for its owned operation to settle.
        await this.releaseLeases(sessionId)
        if (state === 'humanControl') await this.acquireLease(record, record.snapshot.epoch, undefined, 'human')
        this.change(record, state)
        if (state === 'stopped') { record.allowOnce = false; if (this.activeSession === sessionId) this.activeSession = undefined }
        return this.get(sessionId)!
      } catch (error) { this.change(record, 'faulted', error); throw error }
    })()
    record.transition = promise
    void promise.then(() => { record.transition = undefined }, () => { record.transition = undefined })
    return promise
  }
  pause(sessionId: string) { this.ownerControlVersion++; return this.transition(sessionId, 'paused') }
  takeover(sessionId: string) { this.ownerControlVersion++; return this.transition(sessionId, 'humanControl') }
  stop(sessionId: string) { this.ownerControlVersion++; return this.transition(sessionId, 'stopped') }
  async resume(sessionId: string): Promise<ComputerSessionSnapshot> {
    this.ownerControlVersion++
    this.assertEnabled()
    const record = this.record(sessionId)
    if (record.transition) await record.transition
    if (!['paused', 'humanControl'].includes(record.snapshot.state)) throw new ComputerError('NOT_PAUSED', '会话未暂停')
    if (this.activeSession && this.activeSession !== sessionId) throw new ComputerError('DEVICE_BUSY', '设备正在被其他会话控制')
    if (!this.isAllowed(record)) throw new ComputerError('APP_NOT_ALLOWED', '应用授权已撤销')
    this.activeSession = sessionId
    const epoch = record.snapshot.epoch = ++this.nextEpoch
    this.change(record, 'resuming')
    try {
      await this.operation(record, undefined, async signal => {
        const target = record.snapshot.target!
        const current = (await this.driver.targets(signal)).find(item => item.id === target.id)
        signal.throwIfAborted()
        if (!current || current.pid !== target.pid || current.appId !== target.appId) throw new ComputerError('TARGET_CHANGED', '目标应用身份已变化，请重新选择并授权')
        const observation = await this.driver.observe(record.snapshot.target!.id, signal)
        signal.throwIfAborted()
        if (record.snapshot.epoch !== epoch) throw new ComputerError('CONTROL_CHANGED', '继续操作已取消')
        this.validateObservation(observation, record.snapshot.target!)
        record.snapshot.target = { ...current, ...observation.geometry }
        const { imageBase64: _, elements: _elements, mediaType: _mediaType, ...metadata } = observation
        record.snapshot.lastObservation = metadata
        await this.acquireLease(record, epoch, signal)
        signal.throwIfAborted()
        if (record.snapshot.epoch !== epoch) throw new ComputerError('CONTROL_CHANGED', '继续操作已取消')
      })
      this.change(record, 'ready'); return this.get(sessionId)!
    } catch (error) { await this.releaseLeases(sessionId).catch(() => {}); if (record.snapshot.epoch === epoch) this.change(record, 'faulted', error); throw error }
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.unsubscribe?.()
    const stopping = [...this.sessions.keys()].map(id => this.stop(id))
    this.disposed = true
    this.disposing = (async () => {
      try { await Promise.allSettled([...stopping, this.permissionTail]) } finally { this.listeners.clear(); await this.driver.dispose?.() }
    })()
    return this.disposing
  }
}
