import { readModelObservationGeneration } from './model-observation.ts'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ComputerDriverRouter } from './driver-router.ts'
import { ComputerSessionService, type ComputerSessionOptions } from './session.ts'
import { ComputerInputScheduler, ScheduledComputerDriver } from './scheduled-driver.ts'
import { NativeCompanionDriver } from './native.ts'
import { RemoteComputerDriver } from './remote.ts'
import { ComputerError, computerError, requireIdentity } from './contract.ts'
import type { ComputerActionRequest, ComputerSessionSnapshot, ComputerSystemPermission, NativeTarget } from './contract.ts'
import type { ComputerTaskIdentity } from './task-types.ts'

export type ComputerServiceFacade = Pick<ComputerSessionService, 'get' | 'list' | 'subscribe' | 'allowedApps' | 'setAppAllowed' | 'start' | 'pause' | 'takeover' | 'resume' | 'stop' | 'observe' | 'preview' | 'act' | 'humanAct' | 'permittedTargets' | 'selectTarget'>
export interface ComputerConnectionOptions {
  mode: 'local' | 'remote' | 'browser'; endpoint?: string; token?: string; allowPrivateNetwork?: boolean
  browser?: 'chrome' | 'edge'; allowedOrigins?: string[]; initialUrl?: string; cdpEndpoint?: string
}
export interface ComputerEnvironmentOptions extends Pick<ComputerSessionOptions, 'enabled' | 'readAllowedApps' | 'writeAllowedApps' | 'now'> {
  directory?: string
  createRouter?: (sessionId: string | undefined, scheduler: ComputerInputScheduler) => ComputerDriverRouter
  maxEnvironments?: number
  idleMs?: number
}
interface Environment {
  environmentId: string; sessionId?: string; driver: ComputerDriverRouter; service: ComputerSessionService; switching: boolean
  lastUsed: number; files: Set<AbortController>; unsubscribe: () => void
  retiring: boolean; closeAttempted: boolean; retirement?: Promise<void>; cleanupError?: { code: string; message: string }
  previewDetached: boolean; previewIntent: number
}
const terminal = (state: string) => ['stopped', 'faulted', 'disconnected'].includes(state)
const failures = (rows: PromiseSettledResult<unknown>[]) => rows.filter((row): row is PromiseRejectedResult => row.status === 'rejected').map(row => row.reason)
const failMany = (errors: unknown[], message: string) => { if (errors.length) throw new AggregateError(errors, message) }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const invoke = <T>(run: () => T | Promise<T>): Promise<T> => { try { return Promise.resolve(run()) } catch (error) { return Promise.reject(error) } }

/** Remote exchange remains owner-only while physical input uses the shared FIFO. */
class ScheduledRemoteComputerDriver extends ScheduledComputerDriver {
  constructor(private readonly remote: RemoteComputerDriver, scheduler: ComputerInputScheduler) { super(remote, `remote:${hash(remote.endpoint)}`, scheduler) }
  exchange(request: unknown, signal?: AbortSignal) { return this.remote.exchange(request, signal) }
}

/** One service/router per chat. Default connection exists only for legacy owner
 * calls without a chat and cannot switch or cancel another environment. */
export class ComputerEnvironmentManager implements ComputerServiceFacade {
  private readonly entries = new Map<string, Environment>()
  private readonly tasks = new Map<string, ComputerTaskIdentity>()
  private legacy?: Environment
  private readonly snapshots = new Map<string, ComputerSessionSnapshot>()
  private readonly listeners = new Set<() => void>()
  private readonly scheduler = new ComputerInputScheduler()
  private readonly allowed = new Set<string>()
  private readonly denied = new Set<string>()
  private readonly permissionIntents = new Map<string, number>()
  private permissionVersion = 0
  private permissionTail: Promise<void> = Promise.resolve()
  private readonly permissionWrites = new Set<Promise<void>>()
  private authorizationSerial = 0
  private authorizationBase = 0
  private readonly authorizationVersions = new Map<string, number>()
  private readonly authorizationStarts = new Set<string>()
  private readonly authorizationLaunches = new Map<string, Set<AbortController>>()
  // A fresh Host/HMR lifetime also starts far from the old page's cached
  // epochs. Native physical epochs remain the driver's separate counter.
  private epochHighWater = randomInt(1, 2 ** 40)
  private disposed = false
  private disposing?: Promise<void>
  private sweeping?: Promise<void>
  constructor(private readonly options: ComputerEnvironmentOptions = {}) {
    for (const app of options.readAllowedApps?.() ?? []) this.allowed.add(app)
    if (!Number.isInteger(options.maxEnvironments ?? 128) || (options.maxEnvironments ?? 128) < 1 || (options.maxEnvironments ?? 128) > 128) throw new ComputerError('INVALID_LIMIT', '电脑环境数量上限无效')
    if (!Number.isFinite(options.idleMs ?? 60_000) || (options.idleMs ?? 60_000) < 0) throw new ComputerError('INVALID_TIMEOUT', '电脑环境空闲时间无效')
  }
  private now() { return this.options.now?.() ?? Date.now() }
  private assertLive() { if (this.disposed) throw new ComputerError('DISPOSED', '电脑环境管理已关闭') }
  private assertEnabled() { this.assertLive(); if (this.options.enabled?.() === false) throw new ComputerError('DISABLED', '电脑操控未启用') }
  private notify() { for (const listener of this.listeners) { try { listener() } catch {} } }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private assertChatIdentity(chatSessionId: string): void {
    requireIdentity(chatSessionId, '聊天')
    if (this.tasks.has(chatSessionId)) throw new ComputerError('TASK_NOT_FOUND', '电脑任务编号不能用作聊天身份')
  }
  /** Reserving a task records owner metadata only. No driver or OS query is
   * created until an explicit environment/application request needs one. */
  createTask(chatSessionId: string, label?: string): string {
    this.assertEnabled(); this.assertChatIdentity(chatSessionId)
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || Array.from(label.trim()).length > 120 || /[\x00-\x1f\x7f]/u.test(label))) throw new ComputerError('INVALID_REQUEST', '电脑任务名称无效')
    // Reclaim only terminal tasks whose native environment already completed
    // retirement. Pending creation, live input and failed cleanup stay owned.
    const reclaim = (allChats = false) => {
      for (const [id, identity] of this.tasks) if ((allChats || identity.chatSessionId === chatSessionId) && !this.entries.has(id) && this.snapshots.has(id) && terminal(this.snapshots.get(id)!.state)) { this.tasks.delete(id); this.snapshots.delete(id) }
    }
    if (this.listTasks(chatSessionId).length >= 7) reclaim()
    if (new Set([...this.entries.keys(), ...this.tasks.keys()]).size >= (this.options.maxEnvironments ?? 128)) reclaim(true)
    if (this.listTasks(chatSessionId).length >= 7) throw new ComputerError('TASK_LIMIT', '当前聊天最多保留 8 个电脑任务，请先停止并释放闲置任务')
    if (new Set([...this.entries.keys(), ...this.tasks.keys()]).size >= (this.options.maxEnvironments ?? 128)) throw new ComputerError('TASK_LIMIT', '电脑任务数量已达上限，请先停止并释放闲置任务')
    let taskId = randomUUID()
    while (taskId === chatSessionId || this.tasks.has(taskId) || this.entries.has(taskId) || this.snapshots.has(taskId) || [...this.tasks.values()].some(task => task.chatSessionId === taskId)) taskId = randomUUID()
    this.tasks.set(taskId, { chatSessionId, taskId, ...(label === undefined ? {} : { taskLabel: label.trim() }) })
    this.notify(); return taskId
  }
  resolveTask(chatSessionId: string, taskId?: string): string {
    this.assertLive(); this.assertChatIdentity(chatSessionId)
    if (taskId === undefined) return chatSessionId
    requireIdentity(taskId, '电脑任务')
    if (this.tasks.get(taskId)?.chatSessionId !== chatSessionId) throw new ComputerError('TASK_NOT_FOUND', '电脑任务不存在或不属于当前聊天')
    return taskId
  }
  listTasks(chatSessionId: string): ComputerTaskIdentity[] {
    this.assertLive(); this.assertChatIdentity(chatSessionId)
    return [...this.tasks.values()].filter(task => task.chatSessionId === chatSessionId).map(task => ({ ...task }))
  }
  private projectSnapshot(snapshot: ComputerSessionSnapshot): ComputerSessionSnapshot & Partial<ComputerTaskIdentity> {
    const identity = this.tasks.get(snapshot.sessionId)
    return identity ? { ...snapshot, ...identity } : snapshot
  }
  authorizationGeneration(sessionId: string) { requireIdentity(sessionId, '会话'); return this.authorizationVersions.get(sessionId) ?? this.authorizationBase }
  private invalidateAuthorization(sessionId?: string) {
    if (sessionId === undefined) { this.authorizationBase = ++this.authorizationSerial; this.authorizationVersions.clear() }
    else this.authorizationVersions.set(sessionId, ++this.authorizationSerial)
    const controllers = sessionId === undefined ? [...this.authorizationLaunches.values()].flatMap(values => [...values]) : [...this.authorizationLaunches.get(sessionId) ?? []]
    for (const controller of controllers) controller.abort(new ComputerError('CONTROL_CHANGED', '应用启动已被用户控制动作取消'))
  }
  private invalidateEntryAuthorization(entry: Environment) {
    if (entry.sessionId !== undefined) this.invalidateAuthorization(entry.sessionId)
    else for (const row of entry.service.list()) this.invalidateAuthorization(row.sessionId)
  }
  allowedApps(): string[] { return [...this.allowed].filter(app => !this.denied.has(app)).sort() }
  setAppAllowed(appId: string, allowed: boolean): Promise<void> {
    this.assertLive(); requireIdentity(appId, '应用')
    const version = ++this.permissionVersion; this.permissionIntents.set(appId, version)
    if (allowed && !this.allowedApps().includes(appId)) this.denied.add(appId)
    let stopping: Promise<unknown> = Promise.resolve()
    if (!allowed) {
      this.invalidateAuthorization()
      this.denied.add(appId); this.allowed.delete(appId)
      // Call stop synchronously on all services before waiting for disk. This
      // invalidates action epochs and aborts queued native input immediately.
      const affected = this.all().flatMap(entry => entry.service.list().filter(row => row.target?.appId === appId).map(row => invoke(() => entry.service.stop(row.sessionId))))
      stopping = Promise.allSettled(affected).then(rows => failMany(failures(rows), '应用撤权后部分电脑环境尚未释放'))
    }
    void stopping.catch(() => {}); this.notify()
    const writing = this.permissionTail.catch(() => {}).then(async () => {
      const values = new Set(this.allowedApps()); if (allowed) values.add(appId); else values.delete(appId)
      await this.options.writeAllowedApps?.([...values].sort())
      if (this.permissionIntents.get(appId) === version) {
        this.allowed.clear(); for (const app of values) this.allowed.add(app)
        if (allowed) this.denied.delete(appId)
        this.notify()
      }
      await stopping
    })
    this.permissionWrites.add(writing)
    void writing.then(() => this.permissionWrites.delete(writing), () => this.permissionWrites.delete(writing))
    this.permissionTail = writing.catch(() => {}); return writing
  }
  private all() { return [...(this.legacy ? [this.legacy] : []), ...this.entries.values()] }
  private existing(sessionId?: string) { return sessionId === undefined ? this.legacy : this.entries.get(sessionId) }
  private entry(sessionId?: string): Environment {
    this.assertLive(); if (sessionId !== undefined) requireIdentity(sessionId, '会话')
    let entry = this.existing(sessionId)
    if (!entry) {
      if (sessionId !== undefined && !this.tasks.has(sessionId) && new Set([...this.entries.keys(), ...this.tasks.keys()]).size >= (this.options.maxEnvironments ?? 128)) throw new ComputerError('SESSION_LIMIT', '电脑环境数量已达上限，请停止闲置环境并等待释放')
      const driver = this.options.createRouter?.(sessionId, this.scheduler) ?? new ComputerDriverRouter({
        local: new ScheduledComputerDriver(new NativeCompanionDriver(), 'local-desktop', this.scheduler),
        remoteFactory: value => new ScheduledRemoteComputerDriver(new RemoteComputerDriver(value), this.scheduler),
      })
      const created = { environmentId: randomUUID(), sessionId, driver, lastUsed: this.now(), switching: false, retiring: false, closeAttempted: false, previewDetached: false, previewIntent: 0, files: new Set<AbortController>(), unsubscribe: () => {} } as Environment
      created.service = new ComputerSessionService(driver, { enabled: () => !this.disposed && !created.switching && !created.retiring && this.options.enabled?.() !== false,
        readAllowedApps: () => this.allowedApps(), now: this.options.now, initialEpoch: this.epochHighWater })
      const unService = created.service.subscribe(() => {
        for (const row of created.service.list()) {
          this.epochHighWater = Math.max(this.epochHighWater, row.epoch); this.snapshots.set(row.sessionId, row)
        }
        created.lastUsed = this.now(); this.trimSnapshots(); this.notify()
      })
      const unDriver = driver.subscribe(event => {
        if (['humanInput', 'disconnected', 'previewClosed'].includes(event.event) && (event.sessionId === undefined || event.sessionId === sessionId)) this.invalidateEntryAuthorization(created)
        if (event.event === 'previewClosed' && (event.sessionId === undefined || event.sessionId === sessionId)) { created.previewIntent++; created.previewDetached = false; this.notify() }
      })
      created.unsubscribe = () => { unService(); unDriver() }
      if (sessionId === undefined) this.legacy = created; else this.entries.set(sessionId, created)
      entry = created
    }
    if (entry.retiring) throw new ComputerError('ENVIRONMENT_RETIRING', '此聊天的旧电脑环境尚未完成清理，请稍后重试')
    return entry
  }
  private trimSnapshots() {
    for (const [id, snapshot] of this.snapshots) {
      if (this.snapshots.size <= 128) break
      if (!this.entries.has(id) && terminal(snapshot.state)) { this.snapshots.delete(id); this.tasks.delete(id) }
    }
  }
  private forSession(sessionId: string, create = false) {
    requireIdentity(sessionId, '会话'); this.assertLive()
    const entry = this.entries.get(sessionId) ?? (this.legacy?.service.get(sessionId) ? this.legacy : undefined) ?? (create ? this.entry(sessionId) : undefined)
    if (!entry) throw new ComputerError('SESSION_NOT_STARTED', '请先在当前聊天请求操作应用并完成授权')
    if (entry.retiring) throw new ComputerError('ENVIRONMENT_RETIRING', '此聊天的电脑环境正在清理')
    entry.lastUsed = this.now(); return entry
  }
  get(sessionId: string) { const snapshot = this.entries.get(sessionId)?.service.get(sessionId) ?? this.legacy?.service.get(sessionId) ?? (this.snapshots.has(sessionId) ? structuredClone(this.snapshots.get(sessionId)!) : undefined); return snapshot ? this.projectSnapshot(snapshot) : undefined }
  list() {
    const values = new Map(this.snapshots)
    for (const entry of this.all()) for (const row of entry.service.list()) values.set(row.sessionId, row)
    return [...values.values()].map(row => this.projectSnapshot(structuredClone(row)))
  }
  /** Read-only workbench view identity, including an owner-paused environment. No router/OS query is created. */
  workbenchEnvironment(sessionId: string) {
    if (this.disposed || this.options.enabled?.() === false) return undefined
    const entry = this.entries.get(sessionId) ?? (this.legacy?.service.get(sessionId) ? this.legacy : undefined)
    if (!entry || entry.retiring || entry.switching) return undefined
    const snapshot = entry.service.get(sessionId)
    if (!snapshot?.target || !['ready', 'running', 'paused', 'humanControl'].includes(snapshot.state)) return undefined
    return { environmentId: entry.environmentId, mode: entry.driver.mode, snapshot: this.projectSnapshot(structuredClone(snapshot)) }
  }
  /** Read existing runtime identity only. Never creates a router, queries the OS or revives history. */
  runEnvironment(sessionId: string) {
    if (this.disposed || this.options.enabled?.() === false) return undefined
    const entry = this.entries.get(sessionId) ?? (this.legacy?.service.get(sessionId) ? this.legacy : undefined)
    if (!entry || entry.retiring || entry.switching) return undefined
    const snapshot = entry.service.get(sessionId)
    if (!snapshot?.target || !['ready', 'running'].includes(snapshot.state)) return undefined
    return { environmentId: entry.environmentId, epoch: snapshot.epoch, target: structuredClone(snapshot.target), ...(snapshot.lastObservation ? { observation: structuredClone(snapshot.lastObservation) } : {}) }
  }
  /** Host-only successful model observation receipt, never a preview or a serialized frame field. */
  modelObservationGeneration(sessionId: string): number | undefined {
    if (this.disposed || this.options.enabled?.() === false) return undefined
    const entry = this.entries.get(sessionId) ?? (this.legacy?.service.get(sessionId) ? this.legacy : undefined)
    if (!entry || entry.retiring || entry.switching) return undefined
    return readModelObservationGeneration(entry.service, sessionId, entry.service.get(sessionId))
  }
  environments() { return this.all().map(entry => ({ environmentId: entry.environmentId, ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId, ...this.tasks.get(entry.sessionId) }), mode: entry.driver.mode, switching: entry.switching, retiring: entry.retiring, previewDetached: entry.previewDetached, ...(entry.cleanupError ? { cleanupError: entry.cleanupError } : {}) })) }
  isSwitching(sessionId?: string) { return this.existing(sessionId)?.switching === true }
  async statusFor(sessionId?: string, signal?: AbortSignal) {
    this.assertLive(); if (sessionId !== undefined) requireIdentity(sessionId, '会话')
    const entry = this.entry(sessionId)
    if (entry.switching || entry.retiring) return { available: false, mode: entry.driver.mode, message: entry.retiring ? '电脑环境正在清理' : '正在切换操作环境' }
    entry.lastUsed = this.now()
    return entry.service.status(signal)
  }
  async statusIfPresentFor(sessionId: string, signal?: AbortSignal) {
    this.assertLive(); requireIdentity(sessionId, '会话')
    if (!this.existing(sessionId)) return null
    return this.statusFor(sessionId, signal)
  }
  status(signal?: AbortSignal) { return this.statusFor(undefined, signal) }
  authorizationStatus(sessionId?: string, signal?: AbortSignal) { return this.statusFor(sessionId, signal) }
  applicationsFor(sessionId?: string, signal?: AbortSignal) {
    this.assertEnabled(); const entry = this.entry(sessionId)
    if (entry.switching) throw new ComputerError('CONTROL_CHANGED', '此聊天正在切换操作环境')
    entry.lastUsed = this.now(); return entry.driver.applications(signal)
  }
  async launchApplicationFor(sessionId: string, appId: string, signal?: AbortSignal) {
    this.assertEnabled(); requireIdentity(appId, '应用'); const entry = this.entry(sessionId)
    if (entry.switching) throw new ComputerError('CONTROL_CHANGED', '此聊天正在切换操作环境')
    const controller = new AbortController(), pending = this.authorizationLaunches.get(sessionId) ?? new Set<AbortController>()
    pending.add(controller); this.authorizationLaunches.set(sessionId, pending)
    const generation = this.authorizationGeneration(sessionId)
    try {
      entry.lastUsed = this.now()
      const result = await entry.driver.launchApplication(appId, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
      controller.signal.throwIfAborted(); this.assertEnabled()
      if (this.authorizationGeneration(sessionId) !== generation) throw new ComputerError('CONTROL_CHANGED', '应用启动期间控制权已变化')
      return result
    } finally { pending.delete(controller); if (!pending.size) this.authorizationLaunches.delete(sessionId) }
  }
  openSystemSettings(kind: ComputerSystemPermission, signal?: AbortSignal) {
    this.assertEnabled()
    if (!['screenRecording', 'accessibility', 'inputMonitoring'].includes(kind)) throw new ComputerError('INVALID_PERMISSION', '系统权限类型无效')
    return this.entry().driver.openSystemSettings(kind, signal)
  }
  targetsFor(sessionId?: string, signal?: AbortSignal) { this.assertEnabled(); const entry = this.entry(sessionId); if (entry.switching) throw new ComputerError('CONTROL_CHANGED', '此聊天正在切换操作环境'); entry.lastUsed = this.now(); return entry.service.targets(signal) }
  targets(signal?: AbortSignal) { return this.targetsFor(undefined, signal) }
  start(sessionId: string, targetId: string, options: { allowOnce?: boolean; signal?: AbortSignal } = {}) { this.assertEnabled(); return this.forSession(sessionId, true).service.start(sessionId, targetId, options) }
  /** Owner-approved transition. External pause/stop/revoke/connect invalidates
   * every awaited boundary, while this internal target switch keeps its token. */
  async authorizationStart(sessionId: string, targetId: string, options: { allowOnce?: boolean; signal?: AbortSignal; expectedGeneration: number; expectedTarget: Pick<NativeTarget, 'id' | 'appId' | 'pid'> }) {
    const check = () => {
      this.assertEnabled(); options.signal?.throwIfAborted()
      if (this.authorizationGeneration(sessionId) !== options.expectedGeneration) throw new ComputerError('CONTROL_CHANGED', '授权请求已失效，请在当前聊天重新请求')
    }
    check()
    if (this.authorizationStarts.has(sessionId)) throw new ComputerError('CONTROL_CHANGED', '此聊天正在处理另一个应用授权')
    this.authorizationStarts.add(sessionId)
    try {
      const entry = this.forSession(sessionId, true), current = entry.service.get(sessionId)
      if (current && ['paused', 'humanControl', 'pausing', 'handingOver', 'resuming', 'stopping'].includes(current.state)) throw new ComputerError('OWNER_RESUME_REQUIRED', '此聊天已暂停或接管，请由用户点击继续')
      if (current && ['ready', 'running'].includes(current.state)) {
        if (current.target?.id === targetId) {
          if (current.target.appId !== options.expectedTarget.appId || current.target.pid !== options.expectedTarget.pid || targetId !== options.expectedTarget.id) throw new ComputerError('TARGET_CHANGED', '目标应用身份已变化，请重新申请授权')
          return current
        }
        await entry.service.stop(sessionId); check()
      }
      const result = await entry.service.start(sessionId, targetId, options)
      try { check() } catch (error) { if (entry.service.get(sessionId)?.epoch === result.epoch) await entry.service.stop(sessionId); throw error }
      return result
    } finally { this.authorizationStarts.delete(sessionId) }
  }
  observe(sessionId: string, signal?: AbortSignal) { return this.forSession(sessionId).service.observe(sessionId, signal) }
  preview(sessionId: string, signal?: AbortSignal) { return this.forSession(sessionId).service.preview(sessionId, signal) }
  act(sessionId: string, request: ComputerActionRequest, signal?: AbortSignal) { return this.forSession(sessionId).service.act(sessionId, request, signal) }
  humanAct(sessionId: string, request: ComputerActionRequest, signal?: AbortSignal) { return this.forSession(sessionId).service.humanAct(sessionId, request, signal) }
  permittedTargets(sessionId: string, signal?: AbortSignal) { return this.forSession(sessionId).service.permittedTargets(sessionId, signal) }
  selectTarget(sessionId: string, targetId: string, signal?: AbortSignal) { return this.forSession(sessionId).service.selectTarget(sessionId, targetId, signal) }
  private stopOrPause(sessionId: string, pause: boolean): Promise<ComputerSessionSnapshot> {
    this.assertLive(); requireIdentity(sessionId, '会话')
    this.invalidateAuthorization(sessionId)
    const entry = this.entries.get(sessionId) ?? (this.legacy?.service.get(sessionId) ? this.legacy : undefined)
    if (entry?.retiring) {
      // A failed retirement is still an owner. Do not acknowledge its old
      // stopped snapshot until the retained driver has actually retired.
      return this.retire(entry).then(() => this.get(sessionId)!)
    }
    if (!entry) {
      const previous = this.snapshots.get(sessionId)
      if (previous && terminal(previous.state)) return Promise.resolve(this.projectSnapshot(structuredClone(previous)))
      if (!pause && this.tasks.has(sessionId)) {
        // Closing a metadata-only task must not create a native worker merely
        // to stop it. Retain a tombstone until bounded task reclamation.
        const stopped: ComputerSessionSnapshot = { sessionId, state: 'stopped', target: null, epoch: ++this.epochHighWater, updatedAt: this.now() }
        this.snapshots.set(sessionId, stopped); this.notify()
        return Promise.resolve(this.projectSnapshot(structuredClone(stopped)))
      }
    }
    const service = this.forSession(sessionId).service
    return pause ? service.pause(sessionId) : service.stop(sessionId)
  }
  pause(sessionId: string) { return this.stopOrPause(sessionId, true) }
  takeover(sessionId: string) { this.invalidateAuthorization(sessionId); return this.forSession(sessionId).service.takeover(sessionId) }
  resume(sessionId: string) { return this.forSession(sessionId).service.resume(sessionId) }
  stop(sessionId: string) { return this.stopOrPause(sessionId, false) }
  cancelFiles(sessionId?: string, all = false) {
    for (const entry of all ? this.all() : [this.existing(sessionId)].filter((value): value is Environment => !!value)) for (const controller of entry.files) controller.abort(new ComputerError('CONTROL_CHANGED', '文件交换已停止'))
  }
  async connect(sessionId: string | undefined, options: ComputerConnectionOptions, signal?: AbortSignal) {
    this.assertEnabled(); signal?.throwIfAborted()
    const previous = this.existing(sessionId)
    if (previous?.driver.requiresOwnerReconnect) {
      // Only this explicit owner route may replace an uncertain launch owner.
      // Automatic discovery/sweep never acknowledges the physical-surface fence.
      await this.retire(previous); this.assertEnabled(); signal?.throwIfAborted()
    }
    const entry = this.entry(sessionId)
    if (entry.switching) throw new ComputerError('CONTROL_CHANGED', '此聊天正在切换操作环境，请稍候')
    this.invalidateEntryAuthorization(entry)
    entry.environmentId = randomUUID(); entry.switching = true; entry.lastUsed = this.now(); this.cancelFiles(sessionId); this.notify()
    try {
      const stopped = await Promise.allSettled(entry.service.list().map(row => invoke(() => entry.service.stop(row.sessionId))))
      failMany(failures(stopped), '旧电脑环境尚未释放，不能切换')
      this.assertEnabled(); signal?.throwIfAborted()
      if (options.mode === 'local') await entry.driver.useLocal()
      else if (options.mode === 'remote' && typeof options.endpoint === 'string' && typeof options.token === 'string') await entry.driver.useRemote({ endpoint: options.endpoint, token: options.token, allowInsecurePrivateNetwork: options.allowPrivateNetwork === true })
      else if (options.mode === 'browser') {
        if (!this.options.directory) throw new ComputerError('PROFILE_REQUIRED', '浏览器连接需要独立的 Host 配置目录')
        if (!['chrome', 'edge'].includes(options.browser ?? '') || !Array.isArray(options.allowedOrigins) || options.allowedOrigins.length < 1 || options.allowedOrigins.length > 128 || options.allowedOrigins.some(origin => typeof origin !== 'string' || origin.length > 2048)) throw new ComputerError('INVALID_BROWSER_OPTIONS', '请选择浏览器并填写允许的网站来源')
        if (options.initialUrl !== undefined && (typeof options.initialUrl !== 'string' || options.initialUrl.length > 8192) || options.cdpEndpoint !== undefined && (typeof options.cdpEndpoint !== 'string' || options.cdpEndpoint.length > 2048)) throw new ComputerError('INVALID_BROWSER_OPTIONS', '浏览器地址无效')
        await entry.driver.useBrowser({ browser: options.browser, profileDir: join(this.options.directory, 'browser-profiles', sessionId === undefined ? 'legacy' : hash(sessionId), options.browser!), allowedOrigins: options.allowedOrigins, ...(options.cdpEndpoint ? { cdpEndpoint: options.cdpEndpoint } : {}) }, options.initialUrl, signal)
      } else throw new ComputerError('INVALID_CONNECTION', '请选择本机或提供独立电脑的配对地址与密钥')
      this.assertEnabled(); signal?.throwIfAborted()
      const status = await entry.driver.status(signal)
      this.assertEnabled(); signal?.throwIfAborted()
      if (status.available === true) entry.driver.acknowledgeOwnerReconnect()
      else if (entry.driver.requiresOwnerReconnect) throw new ComputerError('APPLICATION_LAUNCH_UNCONFIRMED', '新执行器尚未就绪，不能恢复此电脑的输入。')
      return status
    } finally { entry.switching = false; entry.lastUsed = this.now(); this.notify() }
  }
  async exchange(sessionId: string | undefined, request: unknown, signal?: AbortSignal, expectedEnvironmentId?: unknown) {
    this.assertEnabled(); signal?.throwIfAborted(); if (sessionId !== undefined) requireIdentity(sessionId, '会话')
    // A local digest or another window can outlive a remote-to-remote reconnect.
    // Bind every scoped RPC to the exact connection that showed the file area;
    // reject before creating a router or forwarding even a filename elsewhere.
    const expected = expectedEnvironmentId === undefined ? undefined : requireIdentity(expectedEnvironmentId, '电脑环境')
    if ((sessionId !== undefined && !expected) || (expected !== undefined && this.existing(sessionId)?.environmentId !== expected)) throw new ComputerError('CONTROL_CHANGED', '文件交换环境已变化，请刷新当前聊天的操作环境后重试。')
    const entry = this.entry(sessionId), environmentId = entry.environmentId
    if (entry.switching) throw new ComputerError('CONTROL_CHANGED', '此聊天正在切换操作环境')
    const controller = new AbortController(); entry.files.add(controller)
    try {
      const result = await entry.driver.exchange(request, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
      this.assertEnabled(); signal?.throwIfAborted(); controller.signal.throwIfAborted()
      if (this.existing(sessionId) !== entry || entry.environmentId !== environmentId) throw new ComputerError('CONTROL_CHANGED', '文件交换环境已变化，请刷新当前聊天的操作环境后重试。')
      return result
    } finally { entry.files.delete(controller); entry.lastUsed = this.now() }
  }
  async openPreview(sessionId: string, url: string, title: string, signal?: AbortSignal) {
    this.assertEnabled(); const entry = this.forSession(sessionId), intent = ++entry.previewIntent
    const result = await entry.driver.openPreview(url, title, sessionId, signal)
    if (entry.previewIntent === intent && !entry.retiring && !this.disposed) entry.previewDetached = true
    this.notify(); return result
  }
  async redock(sessionId: string, signal?: AbortSignal) {
    this.assertEnabled(); const entry = this.forSession(sessionId), intent = ++entry.previewIntent
    const result = await entry.driver.closePreview(signal, { preserveSession: true })
    if (entry.previewIntent === intent) entry.previewDetached = false
    this.notify(); return result
  }
  async stopAll() {
    this.invalidateAuthorization()
    this.cancelFiles(undefined, true)
    const stopped = this.all().flatMap<Promise<unknown>>(entry => entry.retiring ? [this.retire(entry)] : entry.service.list().map(row => invoke(() => entry.service.stop(row.sessionId))))
    const result = await Promise.allSettled(stopped); failMany(failures(result), '部分电脑环境尚未完成停止')
  }
  private retire(entry: Environment): Promise<void> {
    if (entry.retirement) return entry.retirement
    this.invalidateEntryAuthorization(entry)
    entry.retiring = true; this.cancelFiles(entry.sessionId); this.notify()
    const retiring = (async () => {
      const errors: unknown[] = []
      if (!entry.closeAttempted) {
        entry.closeAttempted = true
        const stopped = await Promise.allSettled(entry.service.list().map(row => invoke(() => entry.service.stop(row.sessionId))))
        errors.push(...failures(stopped))
        try { await entry.service.dispose() } catch (error) { errors.push(error) }
      }
      // Retry the driver itself after a previous service-disposal failure. A
      // rejected service promise is never evidence that native cleanup ran.
      try { await entry.driver.dispose() } catch (error) { errors.push(error) }
      failMany(errors, '电脑环境退役未完成')
      for (const row of entry.service.list()) {
        // No driver remains after the ACK. A previous failed stop may have
        // left a faulted snapshot, but it no longer represents live input.
        const stopped = { ...row, state: 'stopped' as const, updatedAt: this.now() }; delete stopped.error
        this.snapshots.set(row.sessionId, stopped)
      }
      entry.unsubscribe()
      if (entry.sessionId === undefined) { if (this.legacy === entry) this.legacy = undefined }
      else if (this.entries.get(entry.sessionId) === entry) this.entries.delete(entry.sessionId)
      this.trimSnapshots(); this.notify()
    })()
    entry.retirement = retiring
    void retiring.catch(error => { entry.cleanupError = computerError(error); entry.retirement = undefined; this.notify() })
    return retiring
  }
  sweep(protectedSessions: readonly string[] = []): Promise<void> {
    if (this.sweeping) return this.sweeping
    if (this.disposed) return Promise.resolve()
    const protectedIds = new Set(protectedSessions)
    const now = this.now(), ready = this.all().filter(entry => !entry.switching && !entry.files.size && (entry.retiring || (entry.sessionId === undefined || !protectedIds.has(entry.sessionId) && !protectedIds.has(this.tasks.get(entry.sessionId)?.chatSessionId ?? '')) && now - entry.lastUsed >= (this.options.idleMs ?? 60_000) && entry.service.list().every(row => terminal(row.state))))
    const pending = Promise.allSettled(ready.map(entry => this.retire(entry))).then(rows => failMany(failures(rows), '闲置电脑环境清理未完成'))
    this.sweeping = pending
    void pending.then(() => { this.sweeping = undefined }, () => { this.sweeping = undefined }); return pending
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.disposed = true; this.invalidateAuthorization(); this.cancelFiles(undefined, true)
    const pending = Promise.allSettled([...this.all().map(entry => this.retire(entry)), ...this.permissionWrites]).then(rows => { failMany(failures(rows), '部分电脑环境未能退出'); this.listeners.clear() })
    this.disposing = pending
    void pending.catch(() => { this.disposing = undefined }); return pending
  }
}
