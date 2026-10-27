import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Preferences } from '../shared.ts'
import { UPDATES_CHANNEL, UPDATES_CHECK_ENDPOINT, type UpdateCheckResult, type UpdateInstallResult } from '../updates/contract.ts'

export const UPDATE_CHECK_INTERVAL = 24 * 60 * 60_000
export const UPDATE_RETRY_INTERVAL = 60 * 60_000
export interface UpdateNoticeSnapshot {
  result: UpdateCheckResult | null
  checking: boolean
  error: string | null
  nextAutomaticCheck: number | null
  notice: { version: string; restart: boolean } | null
}
export interface UpdateNoticeSource {
  getSnapshot(): UpdateNoticeSnapshot
  subscribe(listener: () => void): () => void
}
export interface UpdateBadgeOptions {
  source: UpdateNoticeSource
  label(restart: boolean): string
  open?(): void
}

/** The client can request only an authenticated check or the existing explicit install. */
export async function requestUpdate<T>(ctx: Context, endpoint: string, payload: unknown): Promise<T> {
  const connection = (typeof ctx?.get === 'function' ? ctx.get('connection') : (ctx as unknown as { connection?: unknown })?.connection) as {
    rpc?: { call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: true; value: unknown } | { ok: false }> }
  } | undefined
  if (!connection?.rpc) throw new Error('Update service unavailable')
  const reply = await connection.rpc.call(UPDATES_CHANNEL, endpoint, payload)
  if (!reply.ok) throw new Error('Update service unavailable')
  return reply.value as T
}

/** One state per client root: opening Settings never starts an extra request. */
export class UpdateNoticeStore implements UpdateNoticeSource {
  private value: UpdateNoticeSnapshot = Object.freeze({ result: null, checking: false, error: null, nextAutomaticCheck: null, notice: null })
  private readonly listeners = new Set<() => void>()
  private pending: Promise<UpdateCheckResult | null> | undefined
  private pendingForce = false
  private manualRefresh: Promise<UpdateCheckResult | null> | undefined
  private refreshManual = false
  private manualPending = false
  private closed = false
  constructor(private readonly ctx: Context, private readonly now: () => number = Date.now) {}
  getSnapshot = (): UpdateNoticeSnapshot => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(value: Partial<UpdateNoticeSnapshot>): void {
    if (this.closed) return
    this.value = Object.freeze({ ...this.value, ...value })
    for (const listener of this.listeners) listener()
  }
  check(force = true, options: { background?: boolean; accept?: () => boolean } = {}): Promise<UpdateCheckResult | null> {
    if (this.closed) return Promise.resolve(null)
    const manual = options.background !== true
    const accept = options.accept ?? (() => true)
    if (this.pending) {
      if (!force || this.pendingForce) {
        // A user may join an already fresh background check even if its
        // scheduler is disabled or disconnected before the reply arrives.
        if (manual) this.manualPending = true
        return this.pending
      }
      if (this.manualRefresh) { if (manual) this.refreshManual = true; return this.manualRefresh }
      // An automatic check may be served from the Host's daily cache. A
      // manual refresh behind it must still issue one fresh request.
      this.refreshManual = manual
      const refresh = this.pending.then(() => this.check(true, { ...options, background: !this.refreshManual })).finally(() => {
        if (this.manualRefresh === refresh) { this.manualRefresh = undefined; this.refreshManual = false }
      })
      this.manualRefresh = refresh
      return refresh
    }
    this.manualPending = manual
    this.pendingForce = force
    this.publish({ checking: true, error: null })
    const operation = (async (): Promise<UpdateCheckResult | null> => {
      try {
        const result = await requestUpdate<UpdateCheckResult>(this.ctx, UPDATES_CHECK_ENDPOINT, { force })
        if (this.closed || !this.manualPending && !accept()) return null
        const failed = result.status === 'error'
        const notice = result.pendingVersion ? { version: result.pendingVersion, restart: true }
          : result.status === 'available' && result.release ? { version: result.release.version, restart: false }
            : failed ? this.value.notice : null
        this.publish({ result, notice, nextAutomaticCheck: this.now() + (failed ? UPDATE_RETRY_INTERVAL : UPDATE_CHECK_INTERVAL) })
        return result
      } catch {
        if (!this.closed && (this.manualPending || accept())) this.publish({ error: '更新服务暂时无法连接，请重新打开 Harness 后重试。', nextAutomaticCheck: this.now() + UPDATE_RETRY_INTERVAL })
        return null
      } finally { this.manualPending = false; this.publish({ checking: false }) }
    })()
    const pending = operation.finally(() => { if (this.pending === pending) { this.pending = undefined; this.pendingForce = false; this.publish({}) } })
    this.pending = pending
    return pending
  }
  recordInstall(result: UpdateInstallResult): void {
    if (result.status === 'restart-required' && result.version) {
      this.publish({ notice: { version: result.version, restart: true }, result: this.value.result ? { ...this.value.result, pendingVersion: result.version, canInstall: false } : null })
    } else if (result.status === 'installed' || result.status === 'already-current') this.publish({ notice: null })
  }
  dispose(): void { this.closed = true; this.listeners.clear() }
}

const stores = new WeakMap<object, UpdateNoticeStore>()
export function getUpdateNotice(ctx: Context): UpdateNoticeStore {
  let store = stores.get(ctx)
  if (!store) { store = new UpdateNoticeStore(ctx); stores.set(ctx, store) }
  return store
}
export function disposeUpdateNotice(ctx: Context, store: UpdateNoticeStore): void {
  store.dispose()
  if (stores.get(ctx) === store) stores.delete(ctx)
}

interface SchedulerOptions {
  store?: UpdateNoticeStore
  now?: () => number
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
  /** The root retains its shared store when only the connection child restarts. */
  disposeStore?: boolean
}

/** Check each ready startup afresh, then daily or hourly after failure. */
export function installAutomaticUpdateChecks(ctx: Context, form: ConfigForm<Preferences>, options: SchedulerOptions = {}): () => void {
  const store = options.store ?? getUpdateNotice(ctx)
  const now = options.now ?? Date.now
  const schedule = options.setTimeout ?? setTimeout
  const cancel = options.clearTimeout ?? clearTimeout
  let disposed = false, generation = 0, enabled = false, startupPending = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = (): void => { if (timer !== undefined) { cancel(timer); timer = undefined } }
  const sync = (): void => {
    clear()
    if (disposed) return
    const preferences = form.getSnapshot()
    const nextEnabled = preferences.status === 'ready' && preferences.value?.autoCheckUpdates !== false
    if (nextEnabled !== enabled) { enabled = nextEnabled; generation++; if (enabled) startupPending = true }
    if (!enabled || store.getSnapshot().checking) return
    const delay = startupPending ? 0 : Math.max(0, (store.getSnapshot().nextAutomaticCheck ?? now()) - now())
    const currentGeneration = generation
    timer = schedule(() => {
      timer = undefined
      if (disposed || !enabled || generation !== currentGeneration) return
      startupPending = false
      // This scheduler owns the daily/hourly cadence; every due check must
      // reach GitHub instead of reusing the Host's earlier successful cache.
      void store.check(true, { background: true, accept: () => !disposed && enabled && generation === currentGeneration })
    }, delay)
  }
  const offForm = form.subscribe(sync), offStore = store.subscribe(sync)
  sync()
  return () => { if (disposed) return; disposed = true; generation++; clear(); offForm(); offStore(); if (options.disposeStore !== false) disposeUpdateNotice(ctx, store) }
}
