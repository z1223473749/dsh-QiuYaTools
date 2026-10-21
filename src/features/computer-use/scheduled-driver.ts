import { ComputerError, requireIdentity } from './contract.ts'
import type { ComputerAction, ComputerSystemPermission, DeviceDriver, NativeTarget, NativeComputerEvent } from './contract.ts'

/** FIFO for a physical input surface. Different surfaces never share a tail. */
export class ComputerInputScheduler {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly counts = new Map<string, number>()
  private readonly identities = new WeakMap<object, number>()
  private serial = 0
  private readonly surfaceVersions = new Map<string, number>()
  private readonly launchFences = new Map<string, { owner: object; afterSerial: number; retired: boolean }>()
  register(owner: object): void { if (!this.identities.has(owner)) this.identities.set(owner, ++this.serial) }
  launchUnconfirmed(surface: string, owner: object): void { if (!this.launchFences.has(surface)) { this.surfaceVersions.set(surface, (this.surfaceVersions.get(surface) ?? 0) + 1); this.launchFences.set(surface, { owner, afterSerial: this.serial, retired: false }) } }
  private assertSurface(surface: string, version?: number): void { if (this.launchFences.has(surface) || version !== undefined && version !== (this.surfaceVersions.get(surface) ?? 0)) throw new ComputerError('APPLICATION_LAUNCH_UNCONFIRMED', '此电脑有未确认的应用启动，须由用户重新连接并确认当前窗口。') }
  requiresOwnerReconnect(surface: string): boolean { return this.launchFences.has(surface) }
  retired(owner: object): void { for (const fence of this.launchFences.values()) if (fence.owner === owner) fence.retired = true }
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
    const version = this.surfaceVersions.get(surface) ?? 0
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
      signal.throwIfAborted(); this.assertSurface(surface, version); return await work()
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
  constructor(readonly inner: DeviceDriver, readonly surface: string, readonly scheduler: ComputerInputScheduler) { requireIdentity(surface, '输入设备'); scheduler.register(this) }
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
    this.highest = epoch; this.active = { epoch, actor: options?.actor ?? 'ai', controller: new AbortController() }
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
  async release(epoch: number) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new ComputerError('INVALID_EPOCH', '控制周期无效')
    this.highest = Math.max(this.highest, epoch)
    if (this.active && this.active.epoch <= epoch) {
      this.active.controller.abort(new ComputerError('CONTROL_CHANGED', '用户已暂停或停止此聊天的输入'))
      this.active = undefined
    }
    // A late old release cannot cancel a newer chat/native epoch.
    if (this.physical && this.physical.logicalEpoch <= epoch) await this.releasePhysical()
    return { released: true }
  }
  act(epoch: number, targetId: string, action: ComputerAction, signal?: AbortSignal): Promise<unknown> {
    const lease = this.fence(epoch), operationSignal = signal ? AbortSignal.any([signal, lease.controller.signal]) : lease.controller.signal
    const operation = this.scheduler.run(this.surface, operationSignal, async () => {
      this.fence(epoch); operationSignal.throwIfAborted()
      // Retry only an acknowledged cleanup boundary, never the target action.
      await this.releasePhysical(); this.fence(epoch); operationSignal.throwIfAborted()
      if (this.issuedNativeEpoch >= Number.MAX_SAFE_INTEGER) throw new ComputerError('EPOCH_LIMIT', '请重新连接此电脑')
      const physical = { epoch: ++this.issuedNativeEpoch, logicalEpoch: epoch }
      this.physical = physical
      try {
        await this.inner.lease(physical.epoch, operationSignal, { actor: lease.actor })
        this.fence(epoch); operationSignal.throwIfAborted()
        const result = await this.inner.act(physical.epoch, targetId, action, operationSignal)
        this.fence(epoch); operationSignal.throwIfAborted(); return result
      } finally { await this.releasePhysical(physical) }
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
    const disposing = (async () => {
      await Promise.allSettled([...this.pending])
      try { await this.releasePhysical() } finally { await this.inner.dispose?.() }
      this.scheduler.retired(this)
    })()
    this.disposing = disposing
    void disposing.catch(() => { if (this.disposing === disposing) this.disposing = undefined })
    return disposing
  }
}
