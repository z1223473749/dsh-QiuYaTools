import { randomUUID } from 'node:crypto'
import { ComputerError } from '../computer-use/contract.ts'
import type { ComputerToolRunContext } from '../computer-use/tools.ts'
import type { BrowserWorkbenchRegistry, HostWorkbenchContext } from '../workbench/browser-registry.ts'
import type { RunReadScope } from '../acceptance-runs/service.ts'
import { DiagnosticCollector } from './collector.ts'
import { DIAGNOSTICS_LIMITS, diagnosticId, diagnosticString } from './contract.ts'
import type { DiagnosticRequest, DiagnosticSnapshot, DiagnosticAssociation } from './contract.ts'
type Agent = NonNullable<ComputerToolRunContext['agent']>
interface Pending { card: DiagnosticRequest; exec: ComputerToolRunContext; context: HostWorkbenchContext; source: ReturnType<BrowserWorkbenchRegistry['diagnosticSource']>; resolve(value: DiagnosticSnapshot): void; reject(error: unknown): void; clean(): void }
interface Active { snapshot: Omit<DiagnosticSnapshot, 'entries' | 'dropped'>; collector: DiagnosticCollector; context: HostWorkbenchContext; agent: Agent; signal: AbortSignal; remove?: () => Promise<void>; cancelled: AbortController; stop?: Promise<void>; guard?(): void }
export interface DiagnosticOwnerScope extends RunReadScope { readonly grantSignal: AbortSignal; assertGrantCurrent(): void }
export interface DiagnosticOptions {
  registry: Pick<BrowserWorkbenchRegistry, 'capture' | 'diagnosticSource'>
  enabled(): boolean; current(agent: Agent): boolean; canRequest(agent: Agent): boolean
  selected(exec: ComputerToolRunContext, context: HostWorkbenchContext): void
  association?(exec: ComputerToolRunContext, context: HostWorkbenchContext): DiagnosticAssociation | undefined
}
const fail = (code: string) => new ComputerError(code, '浏览器诊断已变化，请重新检查当前任务。')
/** Permission is exact attempt/Agent/service/target/epoch, never a persistent site grant. */
export class BrowserDiagnosticsService {
  private readonly pending = new Map<string, Pending>(); private readonly active = new Map<string, Active>()
  private readonly calls = new WeakMap<object, Map<string, Promise<DiagnosticSnapshot>>>()
  private disposed = false; private readonly lifetime = new AbortController(); private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly options: DiagnosticOptions) { this.timer = setInterval(() => this.sweep(), 200); this.timer.unref() }
  private caller(exec: ComputerToolRunContext): Agent { exec.signal.throwIfAborted(); if (this.disposed || !this.options.enabled() || !exec.agent || !this.options.current(exec.agent)) throw fail('CALLER_NOT_LIVE'); return exec.agent }
  private guard(exec: ComputerToolRunContext, context: HostWorkbenchContext) { const agent = this.caller(exec); if (context.chatSessionId !== agent.id) throw fail('CALLER_NOT_LIVE'); context.assertCurrent(); this.options.selected(exec, context) }
  request(exec: ComputerToolRunContext, input: { environmentId: string; workbenchTabId: string; reason: string }): Promise<DiagnosticSnapshot> {
    const agent = this.caller(exec); if (!this.options.canRequest(agent)) return Promise.reject(fail('APPROVAL_DISABLED'))
    const environmentId = diagnosticId(input.environmentId), workbenchTabId = diagnosticId(input.workbenchTabId), reason = diagnosticString(input.reason, 600), context = this.options.registry.capture(exec, environmentId, workbenchTabId)
    this.guard(exec, context)
    const previous = this.calls.get(agent)?.get(exec.callId); if (previous) return Promise.reject(fail('DIAGNOSTICS_CALL_REUSED'))
    if (this.pending.size >= DIAGNOSTICS_LIMITS.pending || [...this.pending.values()].some(p => p.card.chatSessionId === agent.id) || [...this.active.values()].some(a => a.snapshot.chatSessionId === agent.id && a.snapshot.state === 'collecting')) return Promise.reject(fail('DIAGNOSTICS_LIMIT'))
    const source = this.options.registry.diagnosticSource(context), requestId = randomUUID(), card: DiagnosticRequest = { requestId, chatSessionId: agent.id, origin: source.origin, environmentId, workbenchTabId, reason, expiresAt: Date.now() + DIAGNOSTICS_LIMITS.durationMs }
    const promise = new Promise<DiagnosticSnapshot>((resolve, reject) => {
      const abort = () => { const p = this.pending.get(requestId); if (p) { this.pending.delete(requestId); p.clean(); reject(fail('DIAGNOSTICS_CANCELLED')) } }
      const clean = () => exec.signal.removeEventListener('abort', abort)
      this.pending.set(requestId, { card, exec, context, source, resolve, reject, clean }); exec.signal.addEventListener('abort', abort, { once: true }); if (exec.signal.aborted) abort()
    })
    const calls = this.calls.get(agent) ?? new Map(); if (calls.size >= 128) { const p = this.pending.get(requestId); if (p) { this.pending.delete(requestId); p.clean(); p.reject(fail('DIAGNOSTICS_LIMIT')) } return promise }
    calls.set(exec.callId, promise); this.calls.set(agent, calls); return promise
  }
  status(scope: RunReadScope) { this.owner(scope); this.sweep(); return { pending: [...this.pending.values()].filter(p => p.card.chatSessionId === scope.chatSessionId).map(p => structuredClone(p.card)), sessions: [...this.active.values()].filter(a => a.snapshot.chatSessionId === scope.chatSessionId).map(a => this.view(a)) } }
  private owner(scope: RunReadScope) { scope.signal.throwIfAborted(); scope.assertCurrent(); if (this.disposed) throw fail('DIAGNOSTICS_UNAVAILABLE') }
  async decide(scope: DiagnosticOwnerScope, requestId: string, allow: boolean): Promise<DiagnosticSnapshot | { denied: true }> {
    this.owner(scope); const p = this.pending.get(diagnosticId(requestId)); if (!p || p.card.chatSessionId !== scope.chatSessionId || Date.now() >= p.card.expiresAt) throw fail('DIAGNOSTICS_STALE')
    this.pending.delete(requestId); p.clean()
    if (!allow) { p.reject(fail('DIAGNOSTICS_DENIED')); return { denied: true } }
    let a: Active | undefined
    try {
      this.owner(scope); this.guard(p.exec, p.context)
      const association = () => { this.guard(p.exec, p.context); return this.options.association?.(p.exec, p.context) }; this.owner(scope); this.guard(p.exec, p.context)
      if (this.active.size >= DIAGNOSTICS_LIMITS.sessions) { const first = [...this.active.entries()].find(([, value]) => value.snapshot.state === 'stopped'); if (!first) throw fail('DIAGNOSTICS_LIMIT'); first[1].collector.clear(); this.active.delete(first[0]) }
      const diagnosticId = randomUUID(), cancelled = new AbortController(), signal = AbortSignal.any([p.exec.signal, scope.grantSignal, cancelled.signal, this.lifetime.signal])
      a = { context: p.context, agent: p.exec.agent!, signal, cancelled, collector: new DiagnosticCollector(p.source.origin, association), snapshot: { diagnosticId, chatSessionId: p.card.chatSessionId, environmentId: p.context.environmentId, workbenchTabId: p.context.workbenchTabId, targetId: p.context.targetId, epoch: p.context.epoch, origin: p.source.origin, state: 'collecting', startedAt: Date.now(), endedAt: null, reason: null, privacy: 'metadata-only', verdict: 'diagnostic-only' } }
      const captured = a, current = () => { scope.assertGrantCurrent(); signal.throwIfAborted(); this.guard(p.exec, p.context); if (captured.snapshot.state !== 'collecting') throw fail('DIAGNOSTICS_STOPPED') }
      a.guard = current
      this.active.set(diagnosticId, a)
      const remove = await p.source.subscribe(current, event => { current(); a!.collector.ingest(event) }, () => { if (captured.snapshot.state === 'collecting') void this.stopActive(captured, 'page-or-authority-changed', true).catch(() => {}) }, signal)
      a.remove = remove
      if (a.snapshot.state !== 'collecting') await remove()
      try { this.owner(scope); current() } catch (failure) { await this.stopActive(a, 'permission-unconfirmed', true); throw failure }
      const view = this.view(a); p.resolve(view); return view
    } catch (failure) { if (a) await this.stopActive(a, 'permission-unconfirmed', true); p.reject(failure); throw failure }
  }
  private view(a: Active, filter: 'all' | 'errors' | 'network' = 'all'): DiagnosticSnapshot { return { ...structuredClone(a.snapshot), entries: a.collector.snapshot(filter), dropped: a.collector.dropped } }
  read(exec: ComputerToolRunContext, id: string, filter: 'all' | 'errors' | 'network' = 'all') { const agent = this.caller(exec), a = this.active.get(diagnosticId(id)); if (!a || a.agent !== agent) throw fail('DIAGNOSTICS_UNAVAILABLE'); this.guard(exec, a.context); if (a.snapshot.state === 'collecting') { try { a.guard?.() } catch (failure) { void this.stopActive(a, 'scope-ended', true).catch(() => {}); throw failure } } if (filter !== 'all' && filter !== 'errors' && filter !== 'network') throw fail('INVALID_REQUEST'); return this.view(a, filter) }
  async stop(exec: ComputerToolRunContext, id: string) { const agent = this.caller(exec), a = this.active.get(diagnosticId(id)); if (!a || a.agent !== agent) throw fail('DIAGNOSTICS_UNAVAILABLE'); await this.stopActive(a, 'model-stopped'); this.caller(exec); return this.view(a) }
  ownerRead(scope: RunReadScope, id: string) { this.owner(scope); this.sweep(); const a = this.active.get(diagnosticId(id)); if (!a || a.snapshot.chatSessionId !== scope.chatSessionId) throw fail('DIAGNOSTICS_UNAVAILABLE'); return this.view(a) }
  async ownerStop(scope: RunReadScope, id: string) { this.owner(scope); const a = this.active.get(diagnosticId(id)); if (!a || a.snapshot.chatSessionId !== scope.chatSessionId) throw fail('DIAGNOSTICS_UNAVAILABLE'); await this.stopActive(a, 'owner-revoked', true); this.owner(scope); return this.view(a) }
  private stopActive(a: Active, reason: string, clear = false): Promise<void> {
    if (clear) a.collector.clear(); else a.collector.stop()
    if (a.stop) return a.stop
    let resolve!: () => void, reject!: (failure: unknown) => void
    a.stop = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    a.snapshot.state = 'stopped'; a.snapshot.endedAt = Date.now(); a.snapshot.reason = reason; a.cancelled.abort()
    Promise.resolve().then(() => a.remove?.()).then(resolve, failure => { a.snapshot.reason = 'cleanup-unconfirmed'; reject(failure) })
    return a.stop
  }
  sweep() {
    for (const [id, p] of this.pending) { try { this.guard(p.exec, p.context); if (Date.now() >= p.card.expiresAt) throw fail('DIAGNOSTICS_EXPIRED') } catch (failure) { this.pending.delete(id); p.clean(); p.reject(failure) } }
    for (const a of this.active.values()) if (a.snapshot.state === 'collecting') { try { if (this.disposed || !this.options.enabled() || !this.options.current(a.agent) || Date.now() >= a.snapshot.startedAt + DIAGNOSTICS_LIMITS.durationMs) throw fail('DIAGNOSTICS_STOPPED'); a.signal.throwIfAborted(); a.context.assertCurrent(); a.guard?.() } catch { void this.stopActive(a, 'scope-ended', true).catch(() => {}) } }
  }
  async dispose() { if (this.disposed) return; this.disposed = true; clearInterval(this.timer); this.lifetime.abort(); for (const p of this.pending.values()) { p.clean(); p.reject(fail('DIAGNOSTICS_CANCELLED')) } this.pending.clear(); const results = await Promise.allSettled([...this.active.values()].map(a => this.stopActive(a, 'closed', true))); this.active.clear(); const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected'); if (failed.length) throw new AggregateError(failed.map(r => r.reason), '浏览器诊断清理尚未确认。') }
}
