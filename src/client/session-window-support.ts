import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { SESSION_WINDOW_CHANNEL, SESSION_WINDOW_STATUS_ENDPOINT } from '../features/session-windows/contract.ts'
import { sessionWindowVersionCompatibility, type SessionWindowVersionCompatibility } from '../features/session-windows/compatibility.ts'
import type { Preferences } from '../shared.ts'

export interface SessionWindowSupportSnapshot extends SessionWindowVersionCompatibility {
  status: 'checking' | 'ready' | 'unavailable'
}

type SupportConnection = Pick<ConnectionHandle, 'generation' | 'rpc'>

/** One Host version check per connection generation, shared by settings and feature activation. */
export class SessionWindowSupportStore {
  private snapshot: SessionWindowSupportSnapshot = { ...sessionWindowVersionCompatibility(undefined), status: 'unavailable' }
  private readonly listeners = new Set<() => void>()
  private epoch = 0
  private retry: ReturnType<typeof setTimeout> | undefined
  private detach: (() => void) | undefined
  private closed = false

  getSnapshot = (): SessionWindowSupportSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(snapshot: SessionWindowSupportSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  /** A replaced/disconnected service can never retain an earlier Host's permission. */
  connect(connection: SupportConnection): () => void {
    this.detach?.()
    if (this.closed) return () => {}
    let attached = true
    const refresh = (): void => {
      const epoch = ++this.epoch
      clearTimeout(this.retry)
      this.retry = undefined
      const generation = connection.generation?.getSnapshot()
      this.publish({ ...sessionWindowVersionCompatibility(undefined), status: generation === undefined ? 'unavailable' : 'checking' })
      if (generation === undefined) return
      let attempts = 0
      const current = (): boolean => attached && !this.closed && epoch === this.epoch
        && connection.generation.getSnapshot() === generation
      const failed = (): void => {
        if (!current()) return
        this.publish({ ...sessionWindowVersionCompatibility(undefined), status: 'unavailable' })
        // Host endpoint contributions may register shortly after the renderer connects.
        if (attempts < 4) this.retry = setTimeout(request, attempts * 500)
      }
      const request = (): void => {
        if (!current()) return
        attempts++
        void Promise.resolve().then(() => connection.rpc.call(SESSION_WINDOW_CHANNEL, SESSION_WINDOW_STATUS_ENDPOINT, {})).then(result => {
          if (!current()) return
          if (!result.ok) { failed(); return }
          const value = result.value as Partial<SessionWindowVersionCompatibility> | null
          if (value === null || typeof value !== 'object' || typeof value.versionSupported !== 'boolean'
            || typeof value.minimumHarnessVersion !== 'string') { failed(); return }
          const compatibility = sessionWindowVersionCompatibility(value.harnessVersion)
          this.publish({ ...compatibility, versionSupported: compatibility.versionSupported && value.versionSupported,
            status: compatibility.harnessVersion === undefined ? 'unavailable' : 'ready' })
        }).catch(failed)
      }
      request()
    }
    const offGeneration = connection.generation?.subscribe(refresh)
    const detach = (): void => {
      if (!attached) return
      attached = false
      ++this.epoch
      clearTimeout(this.retry)
      this.retry = undefined
      offGeneration?.()
      if (this.detach === detach) this.detach = undefined
      this.publish({ ...sessionWindowVersionCompatibility(undefined), status: 'unavailable' })
    }
    this.detach = detach
    refresh()
    return detach
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.detach?.()
    this.listeners.clear()
  }
}

const stores = new WeakMap<Context, SessionWindowSupportStore>()

/** The same plugin Context is supplied to both the feature board and settings section. */
export function getSessionWindowSupport(ctx: Context): SessionWindowSupportStore {
  const existing = stores.get(ctx)
  if (existing) return existing
  const store = new SessionWindowSupportStore()
  stores.set(ctx, store)
  ctx.inject(['connection'], scope => {
    scope.effect(() => store.connect((scope as unknown as { connection: SupportConnection }).connection))
  })
  ctx.effect(() => () => { store.dispose(); stores.delete(ctx) })
  return store
}

/** Keep saved user intent, while an unverified Host cannot activate window gestures or menus. */
export function effectiveSessionWindowPreferences(preferences: Preferences, support: SessionWindowVersionCompatibility): Preferences {
  return { ...preferences, sessionWindowsEnabled: preferences.sessionWindowsEnabled && support.versionSupported }
}
