import { ComputerActionCleanupError, ComputerError, requireIdentity } from './contract.ts'
import { foregroundActionSHA256, foregroundRelease, foregroundSiblings, sameForegroundIdentity } from './foreground-handoff.ts'
import type { ComputerAction, ComputerSystemPermission, DeviceDriver, ForegroundActionTicket, ForegroundHandoffDriver, ForegroundReleaseToken, NativeTarget, NativeComputerEvent } from './contract.ts'

interface ForegroundDonor { owner: object; api: ForegroundHandoffDriver; logicalEpoch: number; token: ForegroundReleaseToken; revoked: boolean }
interface PendingForeground { api: ForegroundHandoffDriver; ticket: ForegroundActionTicket; logicalEpoch: number; cancellation?: Promise<unknown> }

/** FIFO for a physical input surface. Different surfaces never share a tail. */
export class ComputerInputScheduler {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly counts = new Map<string, number>()
  private readonly identities = new WeakMap<object, number>()
  private serial = 0
  private readonly surfaceVersions = new Map<string, number>()
  private readonly launchFences = new Map<string, { owner: object; afterSerial: number; retired: boolean }>()
  private readonly foregroundVersions = new Map<string, number>()
  private readonly foregroundDonors = new Map<string, ForegroundDonor>()
  foregroundVersion(surface: string): number { return this.foregroundVersions.get(surface) ?? 1 }
  assertForeground(surface: string, version: number): void { if (this.foregroundVersion(surface) !== version) throw new ComputerError('CONTROL_CHANGED', '人类输入或桌面状态已变化，旧的排队操作已取消') }
  interruptForeground(surface: string): void { this.foregroundVersions.set(surface, this.foregroundVersion(surface) + 1); this.clearForeground(surface) }
  foregroundDonor(surface: string): ForegroundDonor | undefined { return this.foregroundDonors.get(surface) }
  clearForeground(surface: string): void { const donor = this.foregroundDonors.get(surface); if (donor) donor.revoked = true; this.foregroundDonors.delete(surface) }
  forgetForeground(owner: object, epoch = Number.MAX_SAFE_INTEGER): ForegroundDonor | undefined {
    for (const [surface, donor] of this.foregroundDonors) if (donor.owner === owner && donor.logicalEpoch <= epoch) { this.clearForeground(surface); return donor }
  }
  rememberForeground(surface: string, donor: ForegroundDonor): void { this.clearForeground(surface); this.foregroundDonors.set(surface, donor) }
  register(owner: object): void { if (!this.identities.has(owner)) this.identities.set(owner, ++this.serial) }
  launchUnconfirmed(surface: string, owner: object): void { if (!this.launchFences.has(surface)) { this.surfaceVersions.set(surface, (this.surfaceVersions.get(surface) ?? 0) + 1); this.launchFences.set(surface, { owner, afterSerial: this.serial, retired: false }) } }
  private assertSurface(surface: string, version?: number): void { if (this.launchFences.has(surface) || version !== undefined && version !== (this.surfaceVersions.get(surface) ?? 0)) throw new ComputerError('APPLICATION_LAUNCH_UNCONFIRMED', '此电脑有未确认的应用启动，须由用户重新连接并确认当前窗口。') }
  requiresOwnerReconnect(surface: string): boolean { return this.launchFences.has(surface) }
  retired(owner: object): void { this.forgetForeground(owner); for (const fence of this.launchFences.values()) if (fence.owner === owner) fence.retired = true }
  acknowledgeOwnerReconnect(surface: string, owner: object): void {
    const fence = this.launchFences.get(surface)
    if (!fence) return
    if (!fence.retired || (this.identities.get(owner) ?? 0) <= fence.afterSerial) throw new ComputerError('APPLICATION_LAUNCH_UNCONFIRMED', '旧执行器尚未退出，或新执行器身份未建立，不能恢复此电脑的输入。')
    // This is explicit owner reauthorization, not evidence that a previously
    // accepted OS launch was undone. Actual input still verifies foreground.
    this.launchFences.delete(surface)
  }
  async run<T>(surface: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    requireIdentity(surface, '输入设备'); signal.throwIfAborted(); this.assertSurface(surface)
    const version = this.surfaceVersions.get(surface) ?? 0, foregroundVersion = this.foregroundVersion(surface)
    if ((this.counts.get(surface) ?? 0) >= 128) throw new ComputerError('QUEUE_FULL', '此电脑等待中的操作过多')
    const previous = this.tails.get(surface) ?? Promise.resolve()
    let complete!: () => void
    const owned = new Promise<void>(done => { complete = done })
    const tail = previous.then(() => owned)
    this.tails.set(surface, tail); this.counts.set(surface, (this.counts.get(surface) ?? 0) + 1)
    try {
      await new Promise<void>((done, reject) => {
        const abort = () => { clean(); reject(signal.reason) }
        const clean = () => signal.removeEventListener('abort', abort)
        signal.addEventListener('abort', abort, { once: true })
        previous.then(() => { clean(); done() }, error => { clean(); reject(error) })
        if (signal.aborted) abort()
      })
      signal.throwIfAborted(); this.assertSurface(surface, version); this.assertForeground(surface, foregroundVersion); return await work()
    } finally {
      complete()
      const count = (this.counts.get(surface) ?? 1) - 1
      if (count) this.counts.set(surface, count); else this.counts.delete(surface)
      void tail.then(() => { if (this.tails.get(surface) === tail) this.tails.delete(surface) })
    }
  }
}

/** Each chat owns a logical lease; actual OS input is leased for one action.
 * Native guards remain authoritative across other Hosts/processes. Nothing
 * retries input, and cleanup failure is retained until release is confirmed.
 */
export class ScheduledComputerDriver implements DeviceDriver {
  private highest = -1
  private issuedNativeEpoch = 0
  private active?: { epoch: number; actor: 'ai' | 'human'; controller: AbortController }
  private physical?: { epoch: number; logicalEpoch: number; release?: Promise<unknown> }
  private readonly pending = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private disposed = false
  private disposing?: Promise<void>
  private pendingForeground?: PendingForeground
  private readonly unsubscribeForeground?: () => void
  constructor(readonly inner: DeviceDriver, readonly surface: string, readonly scheduler: ComputerInputScheduler) {
    requireIdentity(surface, '输入设备'); scheduler.register(this)
    this.unsubscribeForeground = inner.subscribe?.(event => {
      if (surface !== 'local-desktop') return
      if (event.event === 'foregroundContextInvalidated' || event.event === 'humanInput' && inner.foregroundHandoff) scheduler.interruptForeground(surface)
      else if (event.event === 'disconnected' || event.event === 'previewClosed') scheduler.forgetForeground(this)
    })
  }
  private assertLive() { if (this.disposed) throw new ComputerError('DISPOSED', '此聊天的电脑连接已关闭') }
  private fence(epoch: number) {
    this.assertLive()
    if (!this.active || this.active.epoch !== epoch) throw new ComputerError('CONTROL_CHANGED', '此聊天的输入授权已暂停或变化')
    return this.active
  }
  status(signal?: AbortSignal) { this.assertLive(); return this.inner.status(signal) }
  applications(signal?: AbortSignal) {
    this.assertLive()
    if (this.inner.applications) return this.inner.applications(signal)
    return this.inner.targets(signal).then(targets => [...new Map(targets.map(target => [target.appId, { appId: target.appId, name: target.appId, running: true, launchable: false }])).values()])
  }
  get requiresOwnerReconnect(): boolean { return this.scheduler.requiresOwnerReconnect(this.surface) }
  acknowledgeOwnerReconnect(): void { this.assertLive(); this.scheduler.acknowledgeOwnerReconnect(this.surface, this) }
  launchApplication(appId: string, signal?: AbortSignal) {
    this.assertLive(); requireIdentity(appId, '应用')
    if (!this.inner.launchApplication) throw new ComputerError('APPLICATION_LAUNCH_UNSUPPORTED', '请先手动打开该应用')
    const operationSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    // Launch may activate a native window, so it shares the same physical
    // surface FIFO as typing/dragging and is issued exactly once.
    const operation = this.scheduler.run(this.surface, operationSignal, async () => {
      this.assertLive(); operationSignal.throwIfAborted()
      this.scheduler.clearForeground(this.surface)
      try { return await this.inner.launchApplication!(appId, operationSignal) }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'APPLICATION_LAUNCH_UNCONFIRMED') this.scheduler.launchUnconfirmed(this.surface, this)
        throw error
      }
    })
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }
  openSystemSettings(kind: ComputerSystemPermission, signal?: AbortSignal) { this.assertLive(); if (!this.inner.openSystemSettings) throw new ComputerError('SETTINGS_UNSUPPORTED', '此设备不支持直接打开系统设置'); return this.inner.openSystemSettings(kind, signal) }
  targets(signal?: AbortSignal) { this.assertLive(); return this.inner.targets(signal) }
  observe(targetId: string, signal?: AbortSignal) { this.assertLive(); return this.inner.observe(targetId, signal) }
  preview(targetId: string, signal?: AbortSignal) { this.assertLive(); return this.inner.preview ? this.inner.preview(targetId, signal) : this.inner.observe(targetId, signal) }
  async lease(epoch: number, signal?: AbortSignal, options?: { actor: 'ai' | 'human' }) {
    this.assertLive(); signal?.throwIfAborted()
    if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch <= this.highest) throw new ComputerError('STALE_EPOCH', '聊天控制周期必须递增')
    if (this.active) throw new ComputerError('CONTROL_CHANGED', '请先释放此前的聊天输入授权')
    if (options?.actor !== undefined && !['ai', 'human'].includes(options.actor)) throw new ComputerError('INVALID_ACTOR', '输入来源无效')
    this.highest = epoch
    const active = { epoch, actor: options?.actor ?? 'ai', controller: new AbortController() }; this.active = active
    const foreground = this.surface === 'local-desktop' ? this.inner.foregroundHandoff : undefined
    if (foreground) try {
      await foreground.context(signal ? AbortSignal.any([signal, active.controller.signal]) : active.controller.signal)
      this.fence(epoch); signal?.throwIfAborted()
    } catch (error) { if (this.active === active) { active.controller.abort(error); this.active = undefined }; throw error }
    return { epoch, scheduled: true }
  }
  private releasePhysical(physical = this.physical): Promise<unknown> {
    if (!physical) return Promise.resolve({ released: true })
    if (physical.release) return physical.release
    const release = Promise.resolve().then(() => this.inner.release(physical.epoch))
    physical.release = release
    void release.then(() => { if (this.physical === physical) this.physical = undefined }, () => { physical.release = undefined })
    return release
  }
  private cancelForeground(pending: PendingForeground): Promise<unknown> {
    pending.cancellation ??= pending.api.cancel({ ticketId: pending.ticket.ticketId }).finally(() => { if (this.pendingForeground === pending) this.pendingForeground = undefined })
    return pending.cancellation
  }
  async release(epoch: number) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new ComputerError('INVALID_EPOCH', '控制周期无效')
    this.highest = Math.max(this.highest, epoch)
    const donor = this.scheduler.forgetForeground(this, epoch)
    if (this.active && this.active.epoch <= epoch) {
      this.active.controller.abort(new ComputerError('CONTROL_CHANGED', '用户已暂停或停止此聊天的输入'))
      this.active = undefined
    }
    // A late old release cannot cancel a newer chat/native epoch.
    const errors: unknown[] = []
    if (this.physical && this.physical.logicalEpoch <= epoch) try { await this.releasePhysical() } catch (error) { errors.push(error) }
    if (this.pendingForeground && this.pendingForeground.logicalEpoch <= epoch) try { await this.cancelForeground(this.pendingForeground) } catch (error) { errors.push(error) }
    if (donor) try { await donor.api.cancel({ releaseTokenId: donor.token.tokenId }) } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new ComputerActionCleanupError(undefined, errors)
    return { released: true }
  }
  act(epoch: number, targetId: string, action: ComputerAction, signal?: AbortSignal): Promise<unknown> {
    const lease = this.fence(epoch), operationSignal = signal ? AbortSignal.any([signal, lease.controller.signal]) : lease.controller.signal
    const foreground = this.surface === 'local-desktop' ? this.inner.foregroundHandoff : undefined, queuedSequence = foreground?.physicalSequence
    const operation = this.scheduler.run(this.surface, operationSignal, async () => {
      this.fence(epoch); operationSignal.throwIfAborted()
      // Retry only an acknowledged cleanup boundary, never the target action.
      await this.releasePhysical(); this.fence(epoch); operationSignal.throwIfAborted()
      if (this.issuedNativeEpoch >= Number.MAX_SAFE_INTEGER) throw new ComputerError('EPOCH_LIMIT', '请重新连接此电脑')
      const nativeEpoch = ++this.issuedNativeEpoch, foregroundVersion = this.scheduler.foregroundVersion(this.surface)
      const fence = () => { this.fence(epoch); operationSignal.throwIfAborted(); this.scheduler.assertForeground(this.surface, foregroundVersion) }
      let physical: { epoch: number; logicalEpoch: number; release?: Promise<unknown> } | undefined, pending: PendingForeground | undefined, result: unknown, actionError: unknown, actionFailed = false, succeeded = false, released: unknown
      const cleanupErrors: unknown[] = []
      try {
        if (foreground) {
          const context = await foreground.context(operationSignal); fence()
          if (queuedSequence === undefined || context.physicalSequence !== queuedSequence || foreground.physicalSequence !== queuedSequence) throw new ComputerError('CONTROL_CHANGED', '排队期间检测到人类输入，旧操作已取消')
          const prepared = await foreground.prepare({ epoch: nativeEpoch, logicalEpoch: epoch, targetId, actionSHA256: foregroundActionSHA256(action), surfaceGeneration: foregroundVersion }, operationSignal)
          pending = { api: foreground, ticket: prepared.ticket, logicalEpoch: epoch }; this.pendingForeground = pending
          fence()
          if (!sameForegroundIdentity(context.identity, prepared.ticket.identity) || prepared.physicalSequence !== queuedSequence || foreground.physicalSequence !== queuedSequence) throw new ComputerError('CONTROL_CHANGED', '前台交接的执行器或物理输入状态已变化')
          const donor = this.scheduler.foregroundDonor(this.surface)
          if (donor && donor.owner !== this) {
            const from = await donor.api.context(operationSignal); fence()
            if (donor.revoked || this.scheduler.foregroundDonor(this.surface) !== donor || !sameForegroundIdentity(from.identity, donor.token.identity) || from.physicalSequence !== donor.token.physicalSequence || !foregroundSiblings(from.identity, context.identity)) throw new ComputerError('CONTROL_CHANGED', '此前的前台交接来源已经变化')
            if (!from.release) { if (this.scheduler.foregroundDonor(this.surface) === donor) this.scheduler.clearForeground(this.surface); throw new ComputerError('CONTROL_CHANGED', '此前的前台交接授权已经过期，请检查当前窗口') }
            {
              if (from.release.tokenId !== donor.token.tokenId) throw new ComputerError('CONTROL_CHANGED', '此前的前台交接票据已经变化')
              try {
                const grant = await donor.api.grant({ releaseToken: donor.token, recipient: context.identity, ticket: prepared.ticket }, operationSignal); fence()
                if (donor.revoked || this.scheduler.foregroundDonor(this.surface) !== donor || !grant.attempted || !grant.allowed || grant.error !== 0 || !sameForegroundIdentity(grant.donor, from.identity) || !sameForegroundIdentity(grant.recipient, context.identity) || grant.ticketId !== prepared.ticket.ticketId || grant.releaseTokenId !== donor.token.tokenId || grant.physicalSequence !== donor.token.physicalSequence) throw new ComputerError('FOREGROUND_HANDOFF_DENIED', 'Windows 未确认本次前台交接，请检查目标窗口，不要重复输入')
              } catch (error) {
                // Grant consumes the native release even on BOOL false or a lost ACK.
                // Remove only this old donor; never replace or retry its grant/action.
                if (this.scheduler.foregroundDonor(this.surface) === donor) this.scheduler.clearForeground(this.surface)
                try { await donor.api.cancel({ releaseTokenId: donor.token.tokenId }) }
                catch (cleanup) { throw new ComputerActionCleanupError(error, [cleanup]) }
                throw error
              }
            }
          }
          fence(); this.scheduler.clearForeground(this.surface)
        } else this.scheduler.clearForeground(this.surface)
        physical = { epoch: nativeEpoch, logicalEpoch: epoch }; this.physical = physical
        await this.inner.lease(physical.epoch, operationSignal, { actor: lease.actor })
        this.fence(epoch); operationSignal.throwIfAborted()
        result = await this.inner.act(physical.epoch, targetId, action, operationSignal, pending ? { foregroundTicket: pending.ticket } : undefined)
        this.fence(epoch); operationSignal.throwIfAborted(); succeeded = true
      } catch (error) { actionError = error; actionFailed = true }
      if (physical) try { released = await this.releasePhysical(physical) } catch (error) { cleanupErrors.push(error) }
      if (pending) try { await this.cancelForeground(pending) } catch (error) { cleanupErrors.push(error) }
      // A release can mint a donor even when the action ACK was cancelled.
      // Always own that exact token, then either publish it or cancel it.
      let token: ForegroundReleaseToken | undefined
      if (foreground && released && typeof released === 'object' && 'foregroundRelease' in released && released.foregroundRelease) try {
        token = foregroundRelease(released.foregroundRelease)
        if (token.epoch !== nativeEpoch || !pending || !sameForegroundIdentity(token.identity, pending.ticket.identity)) throw new ComputerError('NATIVE_PROTOCOL', '前台交接释放回执与本次操作不一致')
      } catch (error) { cleanupErrors.push(error) }
      if (token && foreground) {
        if (succeeded && !actionFailed && !cleanupErrors.length && !this.disposed && this.active?.epoch === epoch && !operationSignal.aborted && this.scheduler.foregroundVersion(this.surface) === foregroundVersion && token.physicalSequence === foreground.physicalSequence) this.scheduler.rememberForeground(this.surface, { owner: this, api: foreground, logicalEpoch: epoch, token, revoked: false })
        else try { await foreground.cancel({ releaseTokenId: token.tokenId }) } catch (error) { cleanupErrors.push(error) }
      }
      if (cleanupErrors.length) {
        if (actionFailed || cleanupErrors.length > 1) throw new ComputerActionCleanupError(actionError, cleanupErrors)
        throw cleanupErrors[0]
      }
      if (actionFailed) throw actionError
      return result
    })
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }
  resolveActionTarget(target: NativeTarget, action: ComputerAction, result: unknown, signal?: AbortSignal) {
    this.assertLive()
    if (!this.inner.resolveActionTarget) throw new ComputerError('BROWSER_ACTION_UNSUPPORTED', '当前环境不支持标签页切换')
    return this.inner.resolveActionTarget(target, action, result, signal)
  }
  openPreview(url: string, title: string, sessionId: string, signal?: AbortSignal) { this.assertLive(); return this.inner.openPreview(url, title, sessionId, signal) }
  closePreview(signal?: AbortSignal, options?: { preserveSession?: boolean }) { this.assertLive(); return this.inner.closePreview(signal, options) }
  subscribe(listener: (event: NativeComputerEvent) => void) { return this.inner.subscribe?.(listener) ?? (() => {}) }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.disposed = true; this.lifetime.abort(new ComputerError('DISPOSED', '电脑连接已关闭')); this.active?.controller.abort(new ComputerError('DISPOSED', '电脑连接已关闭')); this.active = undefined
    const donor = this.scheduler.forgetForeground(this)
    const disposing = (async () => {
      await Promise.allSettled([...this.pending])
      try {
        await this.releasePhysical()
        if (this.pendingForeground) await this.cancelForeground(this.pendingForeground)
        if (donor) await donor.api.cancel({ releaseTokenId: donor.token.tokenId })
      } finally { this.unsubscribeForeground?.(); await this.inner.dispose?.() }
      this.scheduler.retired(this)
    })()
    this.disposing = disposing
    void disposing.catch(() => { if (this.disposing === disposing) this.disposing = undefined })
    return disposing
  }
}
