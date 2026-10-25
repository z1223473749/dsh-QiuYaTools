import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ComputerError, requireIdentity, type ComputerSessionSnapshot, type ComputerStatus, type NativeApplication, type NativeTarget } from './contract.ts'

/** This context comes from the SDK, never from model-controlled arguments. */
export interface ComputerEntryExecution { callId: string; agent?: { id: string; session?: unknown }; signal: AbortSignal; operationSessionId?: string }
export interface ComputerEntryBackend {
  resolveTask?(chatSessionId: string, taskId?: string): string
  get(sessionId: string): ComputerSessionSnapshot | undefined
  allowedApps(): string[]
  setAppAllowed(appId: string, allowed: boolean): Promise<unknown>
  applicationsFor?(sessionId: string, signal?: AbortSignal): Promise<NativeApplication[]>
  targetsFor(sessionId: string, signal?: AbortSignal): Promise<NativeTarget[]>
  authorizationGeneration(sessionId: string): number
  authorizationStatus(sessionId: string, signal?: AbortSignal): Promise<ComputerStatus>
  launchApplicationFor?(sessionId: string, appId: string, signal?: AbortSignal): Promise<unknown>
  authorizationStart(sessionId: string, targetId: string, options: { allowOnce: boolean; signal: AbortSignal; expectedGeneration: number; expectedTarget: Pick<NativeTarget, 'id' | 'appId' | 'pid'> }): Promise<ComputerSessionSnapshot>
}
export interface ComputerPermissionPreflight { available: boolean; platform?: string; mode?: string; permissions: Record<string, boolean>; capabilities: Record<string, boolean> }
export interface ComputerPendingPermission {
  requestId: string; requestVersion: 1; sessionId: string; taskId?: string; appId: string; appName: string
  reason: string; createdAt: number; expiresAt: number; state: 'pending'; preflight: ComputerPermissionPreflight
}
interface Binding { sessionId: string; agent: NonNullable<ComputerEntryExecution['agent']>; generation: number }
interface Candidate extends Binding { id: string; application: NativeApplication; expiresAt: number; preflight: ComputerPermissionPreflight }
interface Pending extends Binding {
  card: ComputerPendingPermission; candidate: Candidate; controller: AbortController
  resolve(value: ComputerSessionSnapshot): void; reject(error: unknown): void
  cleanup(): void; deciding?: Promise<DecisionResult>; decidingChoice?: string
}
interface CallRecord { generation: number; candidateId: string; agent: Binding['agent']; promise: Promise<ComputerSessionSnapshot>; expiresAt: number }
interface DecisionResult { requestId: string; state: 'approved' | 'denied' | 'cancelled'; decision?: 'once' | 'always' | 'deny'; session?: ComputerSessionSnapshot }
export interface ComputerPermissionOptions {
  backend: ComputerEntryBackend; enabled(): boolean
  lookupAgent(id: string): unknown; isRootAgent(agent: Binding['agent']): boolean
  canRequest?(agent: Binding['agent']): boolean
  now?(): number; candidateTtlMs?: number; requestTtlMs?: number
}
function failure(code = 'REQUEST_CANCELLED', message = '电脑操控授权请求已取消，请重新发现应用。'): ComputerError { return new ComputerError(code, message) }
function safeName(appId: string): string {
  // Compatibility for old drivers only. A raw Windows executable path must
  // never enter a model response, and window titles are never used as labels.
  const leaf = appId.split(/[\\/]/u).at(-1) ?? ''
  if (!/[\\/]/u.test(appId) && !/\.exe$/iu.test(leaf)) return '应用'
  return (leaf.replace(/\.exe$/iu, '').replace(/[\x00-\x1f\x7f]/gu, '').slice(0, 80) || '应用')
}
function permissionProjection(status: ComputerStatus): ComputerPermissionPreflight {
  const permissions: Record<string, boolean> = {}, capabilities: Record<string, boolean> = {}
  for (const key of ['screen', 'screenRecording', 'accessibility', 'postEvents', 'inputMonitoring']) if (typeof status.permissions?.[key] === 'boolean') permissions[key] = status.permissions[key]
  if (status.capabilities && !Array.isArray(status.capabilities)) for (const key of ['capture', 'input', 'applications', 'launchApplication']) if (typeof status.capabilities[key] === 'boolean') capabilities[key] = status.capabilities[key]
  return { available: status.available === true, ...(['darwin', 'win32', 'linux'].includes(String(status.platform)) ? { platform: String(status.platform) } : {}), ...(['local', 'remote', 'browser'].includes(String(status.mode)) ? { mode: String(status.mode) } : {}), permissions, capabilities }
}
/** Owner decisions are the only route from an opaque candidate to a grant.
 * No screenshot, AX text, title, executable path or pairing secret is disclosed
 * during discovery. Pending requests hold no input lease. */
export class ComputerPermissionCoordinator {
  private readonly candidates = new Map<string, Candidate>()
  private readonly requests = new Map<string, Pending>()
  private readonly calls = new Map<string, CallRecord>()
  private readonly decisions = new Map<string, { sessionId: string; value: DecisionResult; expiresAt: number }>()
  private readonly timer: ReturnType<typeof setInterval>
  private disposed = false
  constructor(private readonly options: ComputerPermissionOptions) {
    this.timer = setInterval(() => this.sweep(), 250); this.timer.unref()
  }
  private now(): number { return this.options.now?.() ?? Date.now() }
  /** Pure public-SDK caller validation for task metadata tools; no OS query. */
  assertCaller(exec: ComputerEntryExecution): void { this.bind(exec) }
  private bind(exec: ComputerEntryExecution): Binding {
    exec.signal.throwIfAborted()
    if (this.disposed || !this.options.enabled()) throw failure('DISABLED', '电脑操控未启用。')
    const agent = exec.agent
    if (!agent || this.options.lookupAgent(agent.id) !== agent) throw failure('CALLER_NOT_LIVE', '当前 Agent 已失效，不能申请电脑操控。')
    if (!this.options.isRootAgent(agent)) throw failure('DELEGATED_CALLER', '电脑操控授权必须由当前聊天的主 Agent 申请。')
    requireIdentity(exec.callId, '工具调用')
    const chatSessionId = requireIdentity(agent.id, '会话'), sessionId = exec.operationSessionId === undefined ? chatSessionId : requireIdentity(exec.operationSessionId, '电脑任务')
    // operationSessionId is supplied by the Host resolver. Recheck ownership
    // here so a manually constructed execution cannot bypass that resolver.
    const resolved = this.options.backend.resolveTask?.(chatSessionId, sessionId === chatSessionId ? undefined : sessionId)
    if (sessionId !== chatSessionId && resolved !== sessionId || resolved !== undefined && resolved !== sessionId) throw failure('TASK_NOT_FOUND', '电脑任务不存在或不属于当前聊天。')
    return { sessionId, agent, generation: this.options.backend.authorizationGeneration(sessionId) }
  }
  private check(binding: Binding, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (this.disposed || !this.options.enabled()) throw failure('DISABLED', '电脑操控未启用。')
    if (this.options.lookupAgent(binding.agent.id) !== binding.agent || !this.options.isRootAgent(binding.agent)) throw failure('CALLER_NOT_LIVE', '发起请求的 Agent 已失效。')
    if (binding.sessionId !== binding.agent.id && this.options.backend.resolveTask?.(binding.agent.id, binding.sessionId) !== binding.sessionId) throw failure('TASK_NOT_FOUND', '电脑任务不存在或不属于当前聊天。')
    if (this.options.backend.authorizationGeneration(binding.sessionId) !== binding.generation) throw failure('REQUEST_STALE', '操作环境或控制权已变化，请重新申请。')
    const state = this.options.backend.get(binding.sessionId)?.state
    if (state && ['paused', 'humanControl', 'pausing', 'handingOver', 'resuming', 'stopping'].includes(state)) throw failure('OWNER_RESUME_REQUIRED', '会话已暂停或由用户接管，需要用户先恢复控制。')
  }
  async discover(exec: ComputerEntryExecution, filter: { query?: string; kind?: 'all' | 'application' | 'browser' } = {}): Promise<object> {
    if (filter.query !== undefined && (typeof filter.query !== 'string' || filter.query.length > 160 || /[\x00-\x1f\x7f]/u.test(filter.query)) || filter.kind !== undefined && !['all', 'application', 'browser'].includes(filter.kind)) throw failure('INVALID_REQUEST', '应用搜索条件无效。')
    const binding = this.bind(exec); this.sweep()
    const backend = this.options.backend
    let status: ComputerStatus, applications: NativeApplication[]
    try {
      status = await backend.authorizationStatus(binding.sessionId, exec.signal); this.check(binding, exec.signal)
      if (backend.applicationsFor) applications = await backend.applicationsFor(binding.sessionId, exec.signal)
      else {
        const targets = await backend.targetsFor(binding.sessionId, exec.signal)
        applications = [...new Map(targets.map(target => [target.appId, { appId: target.appId, name: safeName(target.appId), running: true }])).values()]
      }
    } catch {
      // Driver setup and network errors may contain local paths or pairing
      // details. Pre-authorization model output must not echo those strings.
      this.check(binding, exec.signal)
      throw failure('DISCOVERY_UNAVAILABLE', '暂时无法读取应用目录，请用户检查电脑操控连接和系统权限。')
    }
    this.check(binding, exec.signal)
    // Expire this chat's prior discovery so repeated calls have bounded memory.
    for (const [id, candidate] of this.candidates) if (candidate.sessionId === binding.sessionId) this.candidates.delete(id)
    const query = filter.query?.trim().toLocaleLowerCase() ?? ''
    const matching = applications.filter(app => {
      if (!app || typeof app.appId !== 'string' || typeof app.name !== 'string') return false
      const browser = /(?:chrome|chromium|firefox|safari|msedge|microsoft edge|brave|vivaldi|opera|browser|浏览器|(?:^|\.)arc(?:\.|$)|https?:)/iu.test(`${app.name} ${app.appId}`)
      return (!query || `${app.name} ${app.appId}`.toLocaleLowerCase().includes(query)) && (filter.kind === undefined || filter.kind === 'all' || (filter.kind === 'browser' ? browser : !browser))
    })
    const rows = [], allowed = new Set(backend.allowedApps()), seen = new Set<string>()
    for (const raw of matching) {
      const app = { ...raw, name: /^(?:[A-Za-z]:[\\/]|[\\/])/u.test(raw.name) ? safeName(raw.name) : raw.name }
      if (!app || typeof app.appId !== 'string' || !app.appId || app.appId.length > 512 || /[\x00-\x1f\x7f]/u.test(app.appId) || seen.has(app.appId) || typeof app.name !== 'string' || !app.name || app.name.length > 640 || Array.from(app.name).length > 160 || /[\x00-\x1f\x7f]/u.test(app.name)) continue
      if (this.candidates.size >= 256 || rows.length >= 64) break
      seen.add(app.appId)
      const id = randomUUID(), expiresAt = this.now() + (this.options.candidateTtlMs ?? 60_000)
      this.candidates.set(id, { ...binding, id, application: { appId: app.appId, name: app.name, running: app.running, launchable: app.launchable }, expiresAt, preflight: permissionProjection(status) })
      rows.push({ candidateId: id, appName: app.name, running: app.running === true, granted: allowed.has(app.appId) || this.hasSessionGrant(binding.sessionId, app.appId), expiresAt })
    }
    return { applications: rows, truncated: matching.length > rows.length, preflight: permissionProjection(status), next: 'Choose a candidateId and call qiuya_computer_request_control. New application access requires the owner’s decision.' }
  }
  requestControl(exec: ComputerEntryExecution, candidateId: string, reason: string): Promise<ComputerSessionSnapshot> {
    const binding = this.bind(exec); this.sweep(); this.check(binding, exec.signal)
    const key = `${binding.sessionId}\0${exec.callId}`
    const prior = this.calls.get(key)
    if (prior) {
      if (prior.agent !== binding.agent || prior.candidateId !== candidateId || prior.generation !== binding.generation) throw failure('CALL_REPLAY_MISMATCH', '工具调用编号不可用于另一授权请求。')
      return prior.promise
    }
    const candidate = this.candidates.get(candidateId)
    if (!candidate || candidate.expiresAt <= this.now() || candidate.agent !== binding.agent || candidate.sessionId !== binding.sessionId || candidate.generation !== binding.generation) throw failure('CANDIDATE_EXPIRED', '应用候选已过期，请重新发现。')
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 600 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(reason)) throw failure('INVALID_REQUEST', '请简要说明要执行的操作。')
    if (this.calls.size >= 128 || this.requests.size >= 32) throw failure('REQUEST_LIMIT', '待处理的授权请求过多，请先处理已有请求。')
    let promise: Promise<ComputerSessionSnapshot>
    if (this.options.backend.allowedApps().includes(candidate.application.appId) || this.hasSessionGrant(binding.sessionId, candidate.application.appId)) promise = this.start(candidate, !this.options.backend.allowedApps().includes(candidate.application.appId), exec.signal)
    else {
      if (this.options.canRequest?.(binding.agent) === false) throw failure('APPROVAL_DISABLED', '当前聊天禁止新的交互授权，请由用户调整授权设置。')
      if ([...this.requests.values()].some(item => item.sessionId === binding.sessionId)) throw failure('REQUEST_PENDING', '当前聊天已有待处理的电脑操控授权。')
      let resolve!: Pending['resolve'], reject!: Pending['reject']
      promise = new Promise((yes, no) => { resolve = yes; reject = no })
      const requestId = randomUUID(), controller = new AbortController()
      const aborted = () => this.cancelRequest(binding.sessionId, requestId, 1)
      const pending: Pending = { ...binding, candidate, controller, resolve, reject,
        card: { requestId, requestVersion: 1, sessionId: binding.agent.id, ...(binding.sessionId === binding.agent.id ? {} : { taskId: binding.sessionId }), appId: candidate.application.appId, appName: candidate.application.name, reason: reason.trim(), createdAt: this.now(), expiresAt: this.now() + (this.options.requestTtlMs ?? 120_000), state: 'pending', preflight: candidate.preflight },
        cleanup: () => exec.signal.removeEventListener('abort', aborted),
      }
      this.requests.set(requestId, pending); exec.signal.addEventListener('abort', aborted, { once: true })
      if (exec.signal.aborted) aborted()
    }
    // Host cancellation may precede the Agent awaiting its promise.
    void promise.catch(() => {})
    this.calls.set(key, { generation: binding.generation, candidateId, agent: binding.agent, promise, expiresAt: this.now() + 180_000 })
    return promise
  }
  private hasSessionGrant(sessionId: string, appId: string): boolean {
    const current = this.options.backend.get(sessionId)
    return !!current && ['ready', 'running'].includes(current.state) && current.target?.appId === appId
  }
  private async start(candidate: Candidate, once: boolean, signal: AbortSignal): Promise<ComputerSessionSnapshot> {
    const backend = this.options.backend
    this.check(candidate, signal)
    await this.assertPreflight(candidate, signal)
    let targets = await backend.targetsFor(candidate.sessionId, signal); this.check(candidate, signal)
    const currentTarget = backend.get(candidate.sessionId)?.target
    let target = targets.find(item => item.appId === candidate.application.appId && item.id === currentTarget?.id) ?? targets.find(item => item.appId === candidate.application.appId)
    if (!target && candidate.application.launchable && backend.launchApplicationFor) {
      await backend.launchApplicationFor(candidate.sessionId, candidate.application.appId, signal); this.check(candidate, signal)
      // Launch is issued once. Only read-only enumeration is retried while
      // the OS creates its first window; input and launch are never replayed.
      const deadline = Date.now() + 4000
      do {
        targets = await backend.targetsFor(candidate.sessionId, signal); this.check(candidate, signal)
        target = targets.find(item => item.appId === candidate.application.appId)
        if (target || Date.now() >= deadline) break
        await delay(Math.min(150, Math.max(1, deadline - Date.now())), undefined, { signal }); this.check(candidate, signal)
      } while (!target)
    }
    if (!target) throw failure('APPLICATION_WINDOW_REQUIRED', '应用没有可操控窗口。请打开应用窗口后重新申请。')
    return backend.authorizationStart(candidate.sessionId, target.id, { allowOnce: once, signal, expectedGeneration: candidate.generation, expectedTarget: { id: target.id, appId: target.appId, pid: target.pid } })
  }
  private async assertPreflight(binding: Binding, signal: AbortSignal): Promise<void> {
    const status = await this.options.backend.authorizationStatus(binding.sessionId, signal); this.check(binding, signal)
    const pending = [...this.requests.values()].find(item => item.sessionId === binding.sessionId && item.generation === binding.generation)
    if (pending) pending.card.preflight = permissionProjection(status)
    if (status.available !== true || ['screen', 'screenRecording', 'accessibility', 'postEvents'].some(key => status.permissions?.[key] === false)) throw failure('SYSTEM_PERMISSION_REQUIRED', '请由用户打开系统权限设置，允许屏幕录制和辅助功能后再确认此授权。')
  }
  pending(sessionId?: string): ComputerPendingPermission[] {
    this.sweep()
    return [...this.requests.values()].filter(item => !sessionId || item.sessionId === sessionId || item.agent.id === sessionId).map(item => ({ ...item.card }))
  }
  async pendingWithPreflight(sessionId?: string, signal?: AbortSignal): Promise<ComputerPendingPermission[]> {
    this.sweep()
    const pending = [...this.requests.values()].filter(item => !sessionId || item.sessionId === sessionId || item.agent.id === sessionId)
    let index = 0
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (index < pending.length) {
        signal?.throwIfAborted()
        const item = pending[index++]
        try {
          const status = await this.options.backend.authorizationStatus(item.sessionId, signal); this.check(item)
          if (this.requests.get(item.card.requestId) === item) item.card.preflight = permissionProjection(status)
        } catch {
          signal?.throwIfAborted()
          if (this.requests.get(item.card.requestId) === item) item.card.preflight = { available: false, permissions: {}, capabilities: {} }
        }
      }
    }))
    return this.pending(sessionId)
  }
  async decide(sessionId: string, requestId: string, requestVersion: unknown, decision: unknown): Promise<DecisionResult> {
    this.sweep(); this.validateVersion(requestVersion)
    if (!['once', 'always', 'deny'].includes(String(decision))) throw failure('INVALID_REQUEST', '授权决定无效。')
    const previous = this.decisions.get(requestId)
    if (previous) {
      if (previous.sessionId !== sessionId || previous.value.decision !== decision) throw failure('REQUEST_STALE', '授权请求已经结束。')
      return previous.value
    }
    const pending = this.requests.get(requestId)
    if (!pending || pending.sessionId !== sessionId) throw failure('REQUEST_STALE', '授权请求已过期或不属于此聊天。')
    if (pending.deciding) { if (pending.decidingChoice !== decision) throw failure('REQUEST_STALE', '授权决定已在处理中。'); return pending.deciding }
    if (decision === 'deny') return this.finish(pending, { requestId, state: 'denied', decision: 'deny' }, failure('APP_DENIED', '用户拒绝了应用操控授权。'))
    pending.decidingChoice = String(decision)
    pending.deciding = (async () => {
      try {
        this.check(pending, pending.controller.signal)
        if (this.options.canRequest?.(pending.agent) === false) throw failure('APPROVAL_DISABLED', '当前聊天已禁止新的交互授权。')
        await this.assertPreflight(pending, pending.controller.signal)
        this.check(pending, pending.controller.signal)
        if (this.options.canRequest?.(pending.agent) === false) throw failure('APPROVAL_DISABLED', '当前聊天已禁止新的交互授权。')
        if (decision === 'always') {
          await this.options.backend.setAppAllowed(pending.candidate.application.appId, true)
          this.check(pending, pending.controller.signal)
        }
        const session = await this.start(pending.candidate, decision === 'once', pending.controller.signal)
        this.check(pending, pending.controller.signal)
        return this.finish(pending, { requestId, state: 'approved', decision: decision as 'once' | 'always', session })
      } catch (error) {
        // Opening OS settings is an owner action. Keep this exact card and
        // model waiter alive while permission is missing; no grant is written.
        if (error instanceof ComputerError && error.code === 'SYSTEM_PERMISSION_REQUIRED' && this.requests.get(requestId) === pending) { pending.deciding = undefined; pending.decidingChoice = undefined; throw error }
        if (this.requests.get(requestId) === pending) { this.requests.delete(requestId); pending.cleanup(); pending.reject(error) }
        throw error
      }
    })()
    return pending.deciding
  }
  cancelRequest(sessionId: string, requestId: string, requestVersion: unknown): DecisionResult {
    this.validateVersion(requestVersion)
    const pending = this.requests.get(requestId)
    if (!pending || pending.sessionId !== sessionId) throw failure('REQUEST_STALE', '授权请求已过期或不属于此聊天。')
    pending.controller.abort(failure())
    return this.finish(pending, { requestId, state: 'cancelled' }, failure())
  }
  private validateVersion(value: unknown): void { if (value !== 1) throw failure('REQUEST_STALE', '授权请求版本已失效。') }
  private finish(pending: Pending, value: DecisionResult, error?: unknown): DecisionResult {
    this.requests.delete(pending.card.requestId); pending.cleanup()
    this.decisions.set(pending.card.requestId, { sessionId: pending.sessionId, value, expiresAt: this.now() + 180_000 })
    if (error) pending.reject(error); else pending.resolve(value.session!)
    return value
  }
  cancelSession(sessionId?: string): void {
    for (const item of [...this.requests.values()]) if (!sessionId || item.sessionId === sessionId) this.cancelRequest(item.sessionId, item.card.requestId, 1)
    for (const [id, candidate] of this.candidates) if (!sessionId || candidate.sessionId === sessionId) this.candidates.delete(id)
  }
  /** Whole-chat teardown is explicit; pausing the default operation must not
   * cancel its sibling tasks merely because pending(root) aggregates them. */
  cancelChat(chatSessionId: string): void {
    requireIdentity(chatSessionId, '聊天')
    for (const item of [...this.requests.values()]) if (item.agent.id === chatSessionId) this.cancelRequest(item.sessionId, item.card.requestId, 1)
    for (const [id, candidate] of this.candidates) if (candidate.agent.id === chatSessionId) this.candidates.delete(id)
  }
  cancelApp(appId: string): void { for (const item of [...this.requests.values()]) if (item.candidate.application.appId === appId) this.cancelRequest(item.sessionId, item.card.requestId, 1); for (const [id, candidate] of this.candidates) if (candidate.application.appId === appId) this.candidates.delete(id) }
  private sweep(): void {
    const now = this.now()
    for (const [id, candidate] of this.candidates) if (candidate.expiresAt <= now) this.candidates.delete(id)
    for (const [id, call] of this.calls) if (call.expiresAt <= now) this.calls.delete(id)
    for (const [id, decision] of this.decisions) if (decision.expiresAt <= now) this.decisions.delete(id)
    for (const item of [...this.requests.values()]) {
      try { this.check(item, item.controller.signal); if (item.card.expiresAt <= now) throw failure('REQUEST_EXPIRED', '授权请求已超时，请重新申请。') }
      catch (error) { item.controller.abort(error); this.requests.delete(item.card.requestId); item.cleanup(); item.reject(error) }
    }
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; clearInterval(this.timer); this.cancelSession(); this.calls.clear(); this.decisions.clear() }
}
