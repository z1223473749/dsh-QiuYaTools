import { NativeCompanionDriver } from './native.ts'
import { RemoteComputerDriver, type RemoteComputerOptions } from './remote.ts'
import { BrowserSession, BrowserDeviceDriver, type BrowserOptions } from './browser.ts'
import { ComputerError, type DeviceDriver, type NativeComputerEvent, type ComputerAction, type NativeTarget } from './contract.ts'

/** Switching is performed only after the Host has stopped every active session. */
export class ComputerDriverRouter implements DeviceDriver {
  private current: DeviceDriver
  private readonly local: DeviceDriver
  private readonly listeners = new Set<(event: NativeComputerEvent) => void>()
  private unsubscribe?: () => void
  private unLocal: () => void
  private readonly remoteFactory: (options: RemoteComputerOptions) => DeviceDriver
  private readonly browserFactory: (options: BrowserOptions) => BrowserSession
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
  async useLocal() {
    this.unsubscribe?.(); this.unsubscribe = undefined
    if (this.current !== this.local) await this.current.dispose?.()
    this.current = this.local; this.mode = 'local'
  }
  async useRemote(options: RemoteComputerOptions) {
    const next = this.remoteFactory(options)
    try { await next.status() } catch (error) { await next.dispose?.(); throw error }
    this.unsubscribe?.()
    if (this.current !== this.local) await this.current.dispose?.()
    this.current = next; this.mode = 'remote'; this.unsubscribe = next.subscribe?.(event => this.emit(event))
  }
  async useBrowser(options: BrowserOptions, initialUrl?: string, signal?: AbortSignal) {
    const browser = this.browserFactory(options)
    if (this.current instanceof BrowserDeviceDriver && this.current.browser.profileDir === browser.profileDir && this.current.browser.options.cdpEndpoint === options.cdpEndpoint) {
      const previous = this.current
      this.unsubscribe?.(); this.unsubscribe = undefined; this.current = this.local; this.mode = 'local'
      await previous.dispose()
    }
    const next = new BrowserDeviceDriver(browser)
    try {
      await browser.launch(signal)
      if (initialUrl) await browser.open(initialUrl, signal)
      await next.status(signal)
    } catch (error) { await next.dispose(); throw error }
    this.unsubscribe?.()
    if (this.current !== this.local) await this.current.dispose?.()
    this.current = next; this.mode = 'browser'; this.unsubscribe = next.subscribe(event => this.emit(event))
  }
  status(signal?: AbortSignal) { const current = this.current, mode = this.mode; return current.status(signal).then(status => ({ ...status, mode })) }
  targets(signal?: AbortSignal) { return this.current.targets(signal) }
  observe(targetId: string, signal?: AbortSignal) { return this.current.observe(targetId, signal) }
  preview(targetId: string, signal?: AbortSignal) { return this.current.preview ? this.current.preview(targetId, signal) : this.current.observe(targetId, signal) }
  lease(epoch: number, signal?: AbortSignal) { return this.current.lease(epoch, signal) }
  release(epoch: number, signal?: AbortSignal) { return this.current.release(epoch, signal) }
  act(epoch: number, targetId: string, action: ComputerAction, signal?: AbortSignal) {
    if (this.mode !== 'browser' && ['navigate', 'openTab', 'closeTab', 'selectorClick', 'selectorType'].includes(action.kind)) throw new ComputerError('BROWSER_ACTION_UNSUPPORTED', '浏览器专用操作需要先连接浏览器通道。')
    return this.current.act(epoch, targetId, action, signal)
  }
  async resolveActionTarget(target: NativeTarget, action: ComputerAction, result: unknown, signal?: AbortSignal) {
    if (!this.current.resolveActionTarget) throw new ComputerError('BROWSER_ACTION_UNSUPPORTED', '当前操作环境不支持浏览器导航。')
    return this.current.resolveActionTarget(target, action, result, signal)
  }
  openPreview(url: string, title: string, sessionId: string, signal?: AbortSignal) { return this.local.openPreview(url, title, sessionId, signal) }
  closePreview(signal?: AbortSignal) { return this.local.closePreview(signal) }
  async dispose() { this.unsubscribe?.(); this.unLocal(); if (this.current !== this.local) await this.current.dispose?.(); await this.local.dispose?.(); this.listeners.clear() }
}
