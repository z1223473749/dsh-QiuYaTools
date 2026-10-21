import { NativeCompanionDriver } from './native.ts'
import { RemoteComputerDriver, type RemoteComputerOptions } from './remote.ts'
import { BrowserSession, BrowserDeviceDriver, type BrowserOptions } from './browser.ts'
import { ComputerError, type DeviceDriver, type NativeComputerEvent, type ComputerAction, type NativeTarget } from './contract.ts'
import type { ExchangeResult } from './exchange.ts'

/** Switching is performed only after the Host has stopped every active session. */
export class ComputerDriverRouter implements DeviceDriver {
  private current: DeviceDriver
  private readonly local: DeviceDriver
  private readonly listeners = new Set<(event: NativeComputerEvent) => void>()
  private unsubscribe?: () => void
  private unLocal: () => void
  private readonly remoteFactory: (options: RemoteComputerOptions) => DeviceDriver
  private readonly browserFactory: (options: BrowserOptions) => BrowserSession
  private disposed = false
  private generation = 0
  private readonly candidates = new Set<DeviceDriver>()
  private readonly controllers = new Set<AbortController>()
  private readonly retirement = new WeakMap<DeviceDriver, Promise<void>>()
  private readonly retiring = new Set<Promise<void>>()
  private readonly failedRetirements = new Set<DeviceDriver>()
  private disposing?: Promise<void>
  mode: 'local' | 'remote' | 'browser' = 'local'
  constructor(options: { local?: DeviceDriver; remoteFactory?: (options: RemoteComputerOptions) => DeviceDriver; browserFactory?: (options: BrowserOptions) => BrowserSession } = {}) {
    this.local = options.local ?? new NativeCompanionDriver()
    this.remoteFactory = options.remoteFactory ?? (value => new RemoteComputerDriver(value))
    this.browserFactory = options.browserFactory ?? (value => new BrowserSession(value))
    this.current = this.local
    this.unLocal = this.local.subscribe?.(event => { if (this.mode === 'local' || event.event === 'previewClosed') this.emit(event) }) ?? (() => {})
  }
  private emit(event: NativeComputerEvent) { for (const listener of this.listeners) listener(event) }
  subscribe(listener: (event: NativeComputerEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private assertLive() { if (this.disposed) throw new ComputerError('DISPOSED', '电脑执行器路由已关闭') }
  private assertGeneration(generation: number) { this.assertLive(); if (this.generation !== generation) throw new ComputerError('CONTROL_CHANGED', '设备连接已被更新的请求替代') }
  private retire(driver: DeviceDriver): Promise<void> {
    const previous = this.retirement.get(driver); if (previous) return previous
    const pending = Promise.resolve().then(async () => { await driver.dispose?.() })
    this.retirement.set(driver, pending); this.retiring.add(pending)
    void pending.then(() => { this.retiring.delete(pending); this.failedRetirements.delete(driver) }, () => {
      this.retiring.delete(pending); this.failedRetirements.add(driver)
      if (this.retirement.get(driver) === pending) this.retirement.delete(driver)
    })
    return pending
  }
  private async switching(run: (generation: number, signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<void> {
    this.assertLive(); signal?.throwIfAborted()
    const generation = ++this.generation
    for (const controller of this.controllers) controller.abort(new ComputerError('CONTROL_CHANGED', '连接请求已被替代'))
    const controller = new AbortController(); this.controllers.add(controller)
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    try {
      // A previous failed cleanup remains a resource owner. Retry it before
      // starting any replacement, rather than forgetting its rejected promise.
      for (const driver of [...this.failedRetirements]) await this.retire(driver)
      controller.signal.throwIfAborted(); this.assertGeneration(generation)
      await run(generation, controller.signal)
    }
    finally { this.controllers.delete(controller); signal?.removeEventListener('abort', abort) }
  }
  private async fallbackLocal(generation: number): Promise<void> {
    this.assertGeneration(generation)
    const previous = this.current
    if (previous !== this.local) await this.retire(previous)
    this.assertGeneration(generation)
    this.unsubscribe?.(); this.unsubscribe = undefined; this.current = this.local; this.mode = 'local'
  }
  useLocal() { return this.switching(async generation => { await this.fallbackLocal(generation) }) }
  useRemote(options: RemoteComputerOptions) {
    return this.switching(async (generation, signal) => {
      const next = this.remoteFactory(options); this.candidates.add(next)
      try {
        await next.status(signal); signal.throwIfAborted(); this.assertGeneration(generation)
        await this.fallbackLocal(generation); signal.throwIfAborted()
        this.current = next; this.mode = 'remote'; this.unsubscribe = next.subscribe?.(event => this.emit(event))
      } catch (error) { await this.retire(next); throw error }
      finally { this.candidates.delete(next) }
    })
  }
  useBrowser(options: BrowserOptions, initialUrl?: string, signal?: AbortSignal) {
    return this.switching(async (generation, operationSignal) => {
      const browser = this.browserFactory(options), next = new BrowserDeviceDriver(browser)
      this.candidates.add(next)
      try {
        if (this.current instanceof BrowserDeviceDriver && this.current.browser.profileDir === browser.profileDir && this.current.browser.options.cdpEndpoint === options.cdpEndpoint) await this.fallbackLocal(generation)
        operationSignal.throwIfAborted(); this.assertGeneration(generation)
        await browser.launch(operationSignal)
        if (initialUrl) await browser.open(initialUrl, operationSignal)
        await next.status(operationSignal); operationSignal.throwIfAborted(); this.assertGeneration(generation)
        await this.fallbackLocal(generation); operationSignal.throwIfAborted()
        this.current = next; this.mode = 'browser'; this.unsubscribe = next.subscribe(event => this.emit(event))
      } catch (error) { await this.retire(next); throw error }
      finally { this.candidates.delete(next) }
    }, signal)
  }
  status(signal?: AbortSignal) { this.assertLive(); const current = this.current, mode = this.mode; return current.status(signal).then(status => ({ ...status, mode })) }
  targets(signal?: AbortSignal) { this.assertLive(); return this.current.targets(signal) }
  async exchange(request: unknown, signal?: AbortSignal): Promise<ExchangeResult> {
    this.assertLive()
    const current = this.current as DeviceDriver & { exchange?(request: unknown, signal?: AbortSignal): Promise<ExchangeResult> }, generation = this.generation
    if (this.mode !== 'remote' || !current.exchange) throw new ComputerError('EXCHANGE_REMOTE_ONLY', '文件交换仅适用于已配对的独立电脑。')
    const result = await current.exchange(request, signal)
    this.assertGeneration(generation); return result
  }
  observe(targetId: string, signal?: AbortSignal) { this.assertLive(); return this.current.observe(targetId, signal) }
  preview(targetId: string, signal?: AbortSignal) { this.assertLive(); return this.current.preview ? this.current.preview(targetId, signal) : this.current.observe(targetId, signal) }
  lease(epoch: number, signal?: AbortSignal, options?: { actor: 'ai' | 'human' }) { this.assertLive(); return this.current.lease(epoch, signal, options) }
  release(epoch: number, signal?: AbortSignal) { this.assertLive(); return this.current.release(epoch, signal) }
  act(epoch: number, targetId: string, action: ComputerAction, signal?: AbortSignal) {
    this.assertLive()
    if (this.mode !== 'browser' && ['navigate', 'openTab', 'closeTab', 'selectorClick', 'selectorType'].includes(action.kind)) throw new ComputerError('BROWSER_ACTION_UNSUPPORTED', '浏览器专用操作需要先连接浏览器通道。')
    return this.current.act(epoch, targetId, action, signal)
  }
  async resolveActionTarget(target: NativeTarget, action: ComputerAction, result: unknown, signal?: AbortSignal) {
    this.assertLive()
    if (!this.current.resolveActionTarget) throw new ComputerError('BROWSER_ACTION_UNSUPPORTED', '当前操作环境不支持浏览器导航。')
    return this.current.resolveActionTarget(target, action, result, signal)
  }
  openPreview(url: string, title: string, sessionId: string, signal?: AbortSignal) { this.assertLive(); return this.local.openPreview(url, title, sessionId, signal) }
  closePreview(signal?: AbortSignal, options?: { preserveSession?: boolean }) { this.assertLive(); return this.local.closePreview(signal, options) }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.disposed = true; this.generation++
    for (const controller of this.controllers) controller.abort(new ComputerError('DISPOSED', '电脑执行器路由已关闭'))
    this.unsubscribe?.(); this.unLocal(); this.listeners.clear()
    const all = new Set([...this.candidates, ...this.failedRetirements, this.current, this.local])
    this.disposing = (async () => {
      const results = await Promise.allSettled([...all].map(driver => this.retire(driver)).concat([...this.retiring]))
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) { this.disposing = undefined; throw failure.reason }
    })()
    return this.disposing
  }
}
