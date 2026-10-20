import { NativeCompanionDriver } from './native.ts'
import { RemoteComputerDriver, type RemoteComputerOptions } from './remote.ts'
import type { DeviceDriver, NativeComputerEvent, ComputerAction } from './contract.ts'

/** Switching is performed only after the Host has stopped every active session. */
export class ComputerDriverRouter implements DeviceDriver {
  private current: DeviceDriver
  private readonly local = new NativeCompanionDriver()
  private readonly listeners = new Set<(event: NativeComputerEvent) => void>()
  private unsubscribe?: () => void
  private unLocal: () => void
  mode: 'local' | 'remote' = 'local'
  constructor() {
    this.current = this.local
    this.unLocal = this.local.subscribe(event => { if (this.mode === 'local' || event.event === 'previewClosed') this.emit(event) })
  }
  private emit(event: NativeComputerEvent) { for (const listener of this.listeners) listener(event) }
  subscribe(listener: (event: NativeComputerEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  async useLocal() {
    this.unsubscribe?.(); this.unsubscribe = undefined
    if (this.current !== this.local) await this.current.dispose?.()
    this.current = this.local; this.mode = 'local'
  }
  async useRemote(options: RemoteComputerOptions) {
    const next = new RemoteComputerDriver(options)
    try { await next.status() } catch (error) { await next.dispose(); throw error }
    this.unsubscribe?.()
    if (this.current !== this.local) await this.current.dispose?.()
    this.current = next; this.mode = 'remote'; this.unsubscribe = next.subscribe(event => this.emit(event))
  }
  status(signal?: AbortSignal) { return this.current.status(signal).then(status => ({ ...status, mode: this.mode })) }
  targets(signal?: AbortSignal) { return this.current.targets(signal) }
  observe(targetId: string, signal?: AbortSignal) { return this.current.observe(targetId, signal) }
  preview(targetId: string, signal?: AbortSignal) { return this.current.preview ? this.current.preview(targetId, signal) : this.current.observe(targetId, signal) }
  lease(epoch: number, signal?: AbortSignal) { return this.current.lease(epoch, signal) }
  release(epoch: number, signal?: AbortSignal) { return this.current.release(epoch, signal) }
  act(epoch: number, targetId: string, action: ComputerAction, signal?: AbortSignal) { return this.current.act(epoch, targetId, action, signal) }
  openPreview(url: string, title: string, sessionId: string, signal?: AbortSignal) { return this.local.openPreview(url, title, sessionId, signal) }
  closePreview(signal?: AbortSignal) { return this.local.closePreview(signal) }
  async dispose() { this.unsubscribe?.(); this.unLocal(); if (this.current !== this.local) await this.current.dispose?.(); await this.local.dispose(); this.listeners.clear() }
}
