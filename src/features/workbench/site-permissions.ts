import { randomUUID } from 'node:crypto'
import { ComputerError, requireIdentity } from '../computer-use/contract.ts'
import { website, siteOrigin, uuid } from './contract.ts'
import type { SiteRequest, SiteDecision, WorkbenchTarget } from './contract.ts'

/** Agent comes from the public tool execution, never from model parameters. */
export interface BrowserExecution { callId: string; agent?: { id: string; session?: unknown }; signal: AbortSignal }
export interface BrowserGrantScope {
  readonly chatSessionId: string; readonly browser: 'chrome' | 'edge'; readonly generation: number; readonly signal: AbortSignal
  readonly allowedOrigins: readonly string[]; assertCurrent(): void
}
export interface BrowserPermissionBackend {
  generation(chat: string, browser: 'chrome' | 'edge'): number
  canOperate(chat: string, browser: 'chrome' | 'edge'): boolean
  /** Must use scope.assertCurrent around each awaited launch/read/target operation and clean stale owned candidates. */
  open(scope: BrowserGrantScope, input: { url: string; origin: string; browser: 'chrome' | 'edge' }): Promise<WorkbenchTarget>
  /** Synchronously fence epochs, observations and queued input before returning any cleanup promise. */
  invalidateOrigin(origin: string): Promise<void>
}
export interface SitePermissionOptions {
  enabled(): boolean; lookupAgent(id: string): unknown; isRootAgent(agent: NonNullable<BrowserExecution['agent']>): boolean
  canRequest?(agent: NonNullable<BrowserExecution['agent']>): boolean
  backend: BrowserPermissionBackend; readAllowedOrigins?(): readonly string[]; writeAllowedOrigins?(origins: string[]): Promise<void>
  now?(): number; requestTtlMs?: number
}
interface Binding { chatSessionId: string; browser: 'chrome' | 'edge'; agent: NonNullable<BrowserExecution['agent']>; generation: number }
interface Pending extends Binding {
  card: SiteRequest; url: string; controller: AbortController; signal: AbortSignal
  resolve(value: WorkbenchTarget): void; reject(error: unknown): void; detach(): void
  deciding?: Promise<SiteDecisionReceipt>; choice?: SiteDecision
}
interface Call { agent: Binding['agent']; generation: number; url: string; browser: 'chrome' | 'edge'; promise: Promise<WorkbenchTarget>; expiresAt: number }
export interface SiteOwnerScope { readonly signal: AbortSignal; assertCurrent(): void }
export interface SiteDecisionReceipt { requestId: string; state: 'approved' | 'denied'; decision: SiteDecision; target?: WorkbenchTarget }
const fail = (code: string, message: string): ComputerError => new ComputerError(code, message)
/** Exact-origin permission only. It never authorizes native application control or changes the visible chat. */
export class BrowserPermissionCoordinator {
  private readonly requests = new Map<string, Pending>()
  private readonly calls = new Map<string, Call>()
  private readonly ownerCalls = new Set<string>()
  private readonly desired = new Set<string>()
  private readonly blocked = new Set<string>()
  private readonly versions = new Map<string, number>()
  private readonly once = new Map<string, { generation: number; origins: Map<string, Set<symbol>> }>()
  private readonly decisions = new Map<string, { chat: string; choice: SiteDecision; result: SiteDecisionReceipt; expiresAt: number }>()
  private writes: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly options: SitePermissionOptions) {
    const initial = options.readAllowedOrigins?.() ?? []
    if (initial.length > 128) throw fail('SITE_LIMIT', '网站许可数量超出限制。')
    try { for (const value of initial) this.desired.add(siteOrigin(value)) } catch { this.desired.clear() }
    const ttl = options.requestTtlMs ?? 120000
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 120000) throw fail('INVALID_TIMEOUT', '网站授权有效期无效。')
    this.timer = setInterval(() => this.sweep(), 250); this.timer.unref()
  }
  private now() { return this.options.now?.() ?? Date.now() }
  private live() { if (this.disposed || !this.options.enabled()) throw fail('DISABLED', '电脑操控未启用。') }
  private bind(exec: BrowserExecution, browser: 'chrome' | 'edge'): Binding {
    this.live(); exec.signal.throwIfAborted(); requireIdentity(exec.callId, '工具调用')
    const agent = exec.agent
    if (!agent || this.options.lookupAgent(agent.id) !== agent || !this.options.isRootAgent(agent)) throw fail('CALLER_NOT_LIVE', '请由当前聊天的主 Agent 请求浏览器。')
    return { chatSessionId: requireIdentity(agent.id, '聊天'), agent, browser, generation: this.options.backend.generation(agent.id, browser) }
  }
  private check(binding: Binding, signal?: AbortSignal) {
    this.live(); signal?.throwIfAborted()
    if (this.options.lookupAgent(binding.chatSessionId) !== binding.agent || !this.options.isRootAgent(binding.agent)) throw fail('CALLER_NOT_LIVE', '发起请求的 Agent 已失效。')
    if (this.options.backend.generation(binding.chatSessionId, binding.browser) !== binding.generation) throw fail('REQUEST_STALE', '浏览器环境已变化，请重新请求。')
    if (!this.options.backend.canOperate(binding.chatSessionId, binding.browser)) throw fail('OWNER_RESUME_REQUIRED', '此浏览器任务已暂停或由你接管，请先点击继续。')
  }
  allowedOrigins() { return [...this.desired].filter(origin => !this.blocked.has(origin)).sort() }
  isAllowed(chatSessionId: string, browser: 'chrome' | 'edge', origin: string): boolean {
    if (this.disposed || !this.options.enabled()) return false
    const generation = this.options.backend.generation(chatSessionId, browser), grant = this.once.get(chatSessionId + '\0' + browser)
    return !this.blocked.has(origin) && (this.desired.has(origin) || grant?.generation === generation && grant.origins.has(origin))
  }
  pending(chat?: string): SiteRequest[] {
    this.sweep()
    return [...this.requests.values()].filter(p => chat === undefined || p.chatSessionId === chat).map(p => ({ ...p.card }))
  }
  private key(binding: Pick<Binding, 'chatSessionId' | 'browser'>) { return binding.chatSessionId + '\0' + binding.browser }
  private approved(binding: Pick<Binding, 'chatSessionId' | 'browser' | 'generation'>, origin: string) {
    const once = this.once.get(this.key(binding))
    return !this.blocked.has(origin) && (this.desired.has(origin) || once?.generation === binding.generation && once.origins.has(origin))
  }
  private permit(binding: Pick<Binding, 'chatSessionId' | 'browser' | 'generation'>, origin: string): () => void {
    const key = this.key(binding)
    let grant = this.once.get(key)
    if (grant?.generation !== binding.generation) { grant = { generation: binding.generation, origins: new Map() }; this.once.set(key, grant) }
    const source = Symbol('owner-approved-once'), exact = grant!, origins = exact.origins.get(origin) ?? new Set<symbol>()
    origins.add(source); exact.origins.set(origin, origins)
    // Roll back only this precise decision. A simultaneous valid approval remains independent.
    return () => { if (this.once.get(key) !== exact || exact.origins.get(origin) !== origins) return; origins.delete(source); if (!origins.size) exact.origins.delete(origin); if (!exact.origins.size) this.once.delete(key) }
  }
  private scope(binding: Binding, origin: string, signal: AbortSignal, additionalGuard?: () => void): BrowserGrantScope {
    const version = this.versions.get(origin) ?? 0
    const assertCurrent = () => { additionalGuard?.(); this.check(binding, signal); if (this.versions.get(origin) !== undefined && this.versions.get(origin) !== version || !this.approved(binding, origin)) throw fail('SITE_REVOKED', '网站许可已撤销，请重新授权。') }
    assertCurrent()
    return { chatSessionId: binding.chatSessionId, browser: binding.browser, generation: binding.generation, signal, allowedOrigins: [...new Set([...this.allowedOrigins(), ...(this.once.get(this.key(binding))?.generation === binding.generation ? this.once.get(this.key(binding))!.origins.keys() : [])])].filter(value => this.approved(binding, value)), assertCurrent }
  }
  private async open(binding: Binding, input: { url: string; origin: string; browser: 'chrome' | 'edge' }, signal: AbortSignal, additionalGuard?: () => void) {
    const scope = this.scope(binding, input.origin, signal, additionalGuard), target = await this.options.backend.open(scope, input)
    scope.assertCurrent()
    if (target.chatSessionId !== binding.chatSessionId || target.kind !== 'browser' || target.origin !== input.origin || !Number.isSafeInteger(target.epoch) || target.epoch <= 0) throw fail('TARGET_CHANGED', '浏览器返回的目标归属无效。')
    uuid(target.environmentId); uuid(target.workbenchTabId); requireIdentity(target.targetId, '浏览器目标'); requireIdentity(target.appId, '浏览器实例')
    return target
  }
  async request(exec: BrowserExecution, input: { url: unknown; reason: unknown; browser?: unknown }): Promise<WorkbenchTarget> {
    const parsed = website(input.url), browser = input.browser ?? (process.platform === 'win32' ? 'edge' : 'chrome')
    if ((browser !== 'chrome' && browser !== 'edge')) throw fail('INVALID_BROWSER', '请选择 Chrome 或 Edge。')
    const binding = this.bind(exec, browser as 'chrome' | 'edge')
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 600 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(input.reason)) throw fail('INVALID_REQUEST', '请简要说明要访问网站完成的任务。')
    this.check(binding, exec.signal); this.sweep()
    const key = binding.chatSessionId + '\0' + exec.callId, old = this.calls.get(key)
    if (old) { if (old.agent !== binding.agent || old.generation !== binding.generation || old.url !== parsed.url || old.browser !== browser) throw fail('CALL_REUSED', '工具调用编号不能用于另一项浏览器请求。'); return old.promise }
    if (this.calls.size >= 128 || this.requests.size >= 32) throw fail('REQUEST_LIMIT', '浏览器请求过多，请先处理已有任务。')
    let promise: Promise<WorkbenchTarget>
    if (this.approved(binding, parsed.origin)) promise = this.open(binding, { ...parsed, browser: browser as 'chrome' | 'edge' }, exec.signal)
    else {
      if (this.options.canRequest?.(binding.agent) === false) throw fail('APPROVAL_DISABLED', '当前聊天禁止新的交互授权。')
      if ([...this.requests.values()].some(p => p.chatSessionId === binding.chatSessionId)) throw fail('REQUEST_PENDING', '当前聊天已有待处理的网站授权。')
      let resolve!: Pending['resolve'], reject!: Pending['reject']; promise = new Promise((yes, no) => { resolve = yes; reject = no })
      const requestId = randomUUID(), controller = new AbortController(), signal = AbortSignal.any([exec.signal, controller.signal])
      const aborted = () => this.cancel(binding.chatSessionId, requestId)
      const pending: Pending = { ...binding, url: parsed.url, controller, signal, resolve, reject, detach: () => exec.signal.removeEventListener('abort', aborted), card: { requestId, requestVersion: 1, chatSessionId: binding.chatSessionId, browser: browser as 'chrome' | 'edge', origin: parsed.origin, reason: input.reason.trim(), createdAt: this.now(), expiresAt: this.now() + (this.options.requestTtlMs ?? 120000), state: 'pending' } }
      this.requests.set(requestId, pending); exec.signal.addEventListener('abort', aborted, { once: true }); if (exec.signal.aborted) aborted()
    }
    void promise.catch(() => {})
    this.calls.set(key, { agent: binding.agent, generation: binding.generation, url: parsed.url, browser: browser as 'chrome' | 'edge', promise, expiresAt: this.now() + 180000 })
    return promise
  }
  private drop(p: Pending) { if (this.requests.get(p.card.requestId) === p) this.requests.delete(p.card.requestId); p.detach() }
  cancel(chat: string, requestId?: string) {
    for (const p of this.requests.values()) if (p.chatSessionId === chat && (requestId === undefined || p.card.requestId === requestId)) { this.drop(p); p.controller.abort(fail('REQUEST_CANCELLED', '网站授权已取消。')); p.reject(fail('REQUEST_CANCELLED', '网站授权已取消。')) }
  }
  private persist() {
    const writing = this.writes.catch(() => {}).then(async () => { if (!this.options.writeAllowedOrigins) throw fail('PROFILE_REQUIRED', '当前 Host 无法保存网站许可，请使用允许一次。'); await this.options.writeAllowedOrigins([...this.desired].sort()) })
    this.writes = writing.catch(() => {}); return writing
  }
  async revoke(value: unknown): Promise<{ origin: string; revoked: true }> {
    const origin = siteOrigin(value); this.versions.set(origin, (this.versions.get(origin) ?? 0) + 1); this.blocked.add(origin); this.desired.delete(origin)
    for (const grant of this.once.values()) grant.origins.delete(origin)
    for (const p of [...this.requests.values()]) if (p.card.origin === origin) this.cancel(p.chatSessionId, p.card.requestId)
    // The backend must invalidate synchronously here, before any disk await.
    const cleanup = this.options.backend.invalidateOrigin(origin); void cleanup.catch(() => {})
    await this.persist(); await cleanup
    return { origin, revoked: true }
  }
  async decide(chat: string, requestId: string, version: unknown, decision: unknown, owner: SiteOwnerScope): Promise<SiteDecisionReceipt> {
    owner.signal.throwIfAborted(); owner.assertCurrent(); this.live(); requireIdentity(chat, '聊天'); requireIdentity(requestId, '网站授权')
    if (version !== 1 || (decision !== 'once' && decision !== 'always' && decision !== 'deny')) throw fail('INVALID_DECISION', '网站授权选择无效。')
    const choice = decision as SiteDecision, old = this.decisions.get(requestId)
    if (old && old.chat === chat && old.choice === choice && old.expiresAt > this.now()) return structuredClone(old.result)
    const p = this.requests.get(requestId)
    if (!p || p.chatSessionId !== chat || p.card.expiresAt <= this.now()) throw fail('REQUEST_STALE', '网站授权请求已失效。')
    this.check(p, p.signal)
    if (p.deciding) { if (p.choice !== choice) throw fail('DECISION_CONFLICT', '此网站请求正在处理另一项授权选择。'); return p.deciding }
    p.choice = choice
    const current = () => { owner.signal.throwIfAborted(); owner.assertCurrent(); this.check(p, p.signal); if (this.requests.get(requestId) !== p || p.card.expiresAt <= this.now()) throw fail('REQUEST_STALE', '网站授权请求已失效。') }
    p.deciding = (async () => {
      let alwaysVersion: number | undefined, rollbackOnce: (() => void) | undefined
      try {
        current()
        if (choice === 'deny') { const receipt: SiteDecisionReceipt = { requestId, decision: choice, state: 'denied' }; this.drop(p); p.reject(fail('SITE_DENIED', '你已拒绝本次网站访问。')); this.decisions.set(requestId, { chat, choice, result: receipt, expiresAt: this.now() + 180000 }); return receipt }
        if (choice === 'always') {
          if (!this.desired.has(p.card.origin) && this.desired.size >= 128) throw fail('SITE_LIMIT', '网站许可已达上限。')
          // Another chat may have granted this origin while this card was pending.
          // This decision cannot later roll back that independent valid grant.
          if (!this.desired.has(p.card.origin) || this.blocked.has(p.card.origin)) {
            alwaysVersion = (this.versions.get(p.card.origin) ?? 0) + 1; this.versions.set(p.card.origin, alwaysVersion); this.desired.add(p.card.origin); this.blocked.add(p.card.origin)
            await this.persist(); current()
            if (this.versions.get(p.card.origin) !== alwaysVersion) throw fail('SITE_REVOKED', '网站许可已变化。')
            this.blocked.delete(p.card.origin)
          }
        }
        if (choice === 'once') this.blocked.delete(p.card.origin)
        if (choice === 'once') rollbackOnce = this.permit(p, p.card.origin)
        current()
        const target = await this.open(p, { url: p.url, origin: p.card.origin, browser: p.card.browser }, AbortSignal.any([p.signal, owner.signal]), current); current()
        const receipt: SiteDecisionReceipt = { requestId, decision: choice, state: 'approved', target }; this.drop(p); p.resolve(target); this.decisions.set(requestId, { chat, choice, result: receipt, expiresAt: this.now() + 180000 }); return structuredClone(receipt)
      } catch (error) {
        rollbackOnce?.(); this.drop(p); p.controller.abort(error); p.reject(error)
        // A late/disconnected owner cannot leave this attempt's persistent grant enabled.
        if (alwaysVersion !== undefined && this.versions.get(p.card.origin) === alwaysVersion) await this.revoke(p.card.origin).catch(() => {})
        throw error
      }
    })()
    void p.deciding.catch(() => {}); return p.deciding
  }
  /** Explicit owner address/new-page gesture. Uses its real owner scope; never fabricates a Tool exec or Agent. */
  async openFromOwner(owner: SiteOwnerScope, chatSessionId: string, input: { actionId: unknown; url: unknown; browser: unknown; decision: unknown }): Promise<WorkbenchTarget> {
    this.live(); owner.signal.throwIfAborted(); owner.assertCurrent(); requireIdentity(chatSessionId, '聊天')
    const actionId = uuid(input.actionId), parsed = website(input.url)
    if ((input.browser !== 'chrome' && input.browser !== 'edge') || (input.decision !== 'once' && input.decision !== 'always')) throw fail('INVALID_DECISION', '请明确选择本次网站许可。')
    const browser = input.browser as 'chrome' | 'edge', key = chatSessionId + '\0' + actionId
    if (this.ownerCalls.has(key)) throw fail('ACTION_REPLAY_FORBIDDEN', '此打开网页请求已经提交，请刷新查看结果，不要重复打开。')
    if (this.ownerCalls.size >= 1024) throw fail('REQUEST_LIMIT', '本次 Host 的网页请求已达上限，请先结束闲置任务。')
    this.ownerCalls.add(key)
    const binding = { chatSessionId, browser, generation: this.options.backend.generation(chatSessionId, browser) }
    const check = () => { this.live(); owner.signal.throwIfAborted(); owner.assertCurrent(); if (this.options.backend.generation(chatSessionId, browser) !== binding.generation) throw fail('ENVIRONMENT_CHANGED', '浏览器环境已变化。'); if (!this.options.backend.canOperate(chatSessionId, browser)) throw fail('OWNER_RESUME_REQUIRED', '请先继续此浏览器任务。') }
    let rollbackOnce: (() => void) | undefined, alwaysVersion: number | undefined
    try {
      check()
      if (input.decision === 'always') {
        if (!this.desired.has(parsed.origin) && this.desired.size >= 128) throw fail('SITE_LIMIT', '网站许可已达上限。')
        if (!this.desired.has(parsed.origin) || this.blocked.has(parsed.origin)) {
          alwaysVersion = (this.versions.get(parsed.origin) ?? 0) + 1; this.versions.set(parsed.origin, alwaysVersion); this.desired.add(parsed.origin); this.blocked.add(parsed.origin)
          await this.persist(); check(); if (this.versions.get(parsed.origin) !== alwaysVersion) throw fail('SITE_REVOKED', '网站许可已变化。')
          this.blocked.delete(parsed.origin)
        }
      } else { this.blocked.delete(parsed.origin); rollbackOnce = this.permit(binding, parsed.origin) }
      const version = this.versions.get(parsed.origin) ?? 0, assertCurrent = () => { check(); if ((this.versions.get(parsed.origin) ?? 0) !== version || !this.approved(binding, parsed.origin)) throw fail('SITE_REVOKED', '网站许可已撤销。') }
      assertCurrent()
      const scope: BrowserGrantScope = { ...binding, signal: owner.signal, allowedOrigins: [...new Set([...this.allowedOrigins(), ...(this.once.get(this.key(binding))?.generation === binding.generation ? this.once.get(this.key(binding))!.origins.keys() : [])])].filter(origin => !this.blocked.has(origin)), assertCurrent }
      const target = await this.options.backend.open(scope, { url: parsed.url, origin: parsed.origin, browser }); assertCurrent()
      if (target.chatSessionId !== chatSessionId || target.kind !== 'browser' || target.origin !== parsed.origin || !Number.isSafeInteger(target.epoch) || target.epoch <= 0) throw fail('TARGET_CHANGED', '网页目标归属无效。')
      uuid(target.environmentId); uuid(target.workbenchTabId); return target
    } catch (error) { rollbackOnce?.(); if (alwaysVersion !== undefined && this.versions.get(parsed.origin) === alwaysVersion) await this.revoke(parsed.origin).catch(() => {}); throw error }
  }
  sweep() {
    for (const p of [...this.requests.values()]) if (this.disposed || !this.options.enabled() || p.card.expiresAt <= this.now() || this.options.lookupAgent(p.chatSessionId) !== p.agent || this.options.backend.generation(p.chatSessionId, p.browser) !== p.generation) this.cancel(p.chatSessionId, p.card.requestId)
    for (const [key, call] of this.calls) if (call.expiresAt <= this.now()) this.calls.delete(key)
    for (const [key, value] of this.decisions) if (value.expiresAt <= this.now()) this.decisions.delete(key)
  }
  async dispose() { if (this.disposed) return; this.disposed = true; clearInterval(this.timer); for (const p of [...this.requests.values()]) this.cancel(p.chatSessionId, p.card.requestId); this.once.clear(); this.calls.clear(); this.ownerCalls.clear(); this.decisions.clear(); await this.writes }
}
