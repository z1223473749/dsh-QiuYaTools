import { workbenchCursor } from './preview-model.ts'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BrowserSession, BrowserDeviceDriver } from '../computer-use/browser.ts'
import type { BrowserOptions } from '../computer-use/browser.ts'
import { ComputerSessionService } from '../computer-use/session.ts'
import { ComputerError, requireIdentity } from '../computer-use/contract.ts'
import type { ComputerActionRequest, ComputerActionResult, ComputerObservation, DeviceDriver } from '../computer-use/contract.ts'
import type { BrowserExecution, BrowserGrantScope, BrowserPermissionBackend, SiteOwnerScope } from './site-permissions.ts'
import type { WorkbenchTarget } from './contract.ts'
import { website, uuid } from './contract.ts'

type BrowserKind = 'chrome' | 'edge'
type Runtime = Pick<BrowserSession, 'deviceId' | 'profileDir' | 'launch' | 'list' | 'open' | 'closeTab' | 'closeOwnedTab' | 'close' | 'setAllowedOrigins' | 'allowedOrigins' | 'preview' | 'navigationState' | 'hasOwnedRuntime'>
export interface BrowserRegistryOptions {
  directory: string; enabled(): boolean
  isAllowed(chat: string, browser: BrowserKind, origin: string): boolean
  isCallerCurrent(exec: BrowserExecution): boolean
  create?(options: BrowserOptions): { browser: Runtime; driver: DeviceDriver }
}
interface Entry {
  chat: string; kind: BrowserKind; environmentId: string; generation: number
  browser: Runtime; driver: DeviceDriver; service: ComputerSessionService; views: Map<string, WorkbenchTarget>
  ready?: Promise<void>; launchFailed?: boolean; tail: Promise<unknown>; retiring: boolean; closeAttempted: boolean; cleanupError?: unknown
}
/** Host-only captured authority. Never serialize or accept this object through model/RPC parameters. */
export interface HostWorkbenchContext {
  readonly chatSessionId: string; readonly environmentId: string; readonly workbenchTabId: string
  readonly targetId: string; readonly epoch: number; readonly service: ComputerSessionService
  assertCurrent(): void
}
const error = (code: string, message: string) => new ComputerError(code, message)
/** Owns dedicated browsers separately from the native manager; it never switches a native router. */
export class BrowserWorkbenchRegistry implements BrowserPermissionBackend {
  private readonly entries = new Map<string, Entry>()
  private readonly generations = new Map<string, number>()
  private readonly contexts = new WeakMap<object, { signal: AbortSignal; entry: Entry; assertIdentity(): void }>()
  private disposed = false
  constructor(private readonly options: BrowserRegistryOptions) {}
  private key(chat: string, kind: BrowserKind) { return requireIdentity(chat, '聊天') + '\0' + kind }
  generation(chat: string, kind: BrowserKind) { return this.generations.get(this.key(chat, kind)) ?? 0 }
  private live() { if (this.disposed || !this.options.enabled()) throw error('DISABLED', '电脑操控未启用。') }
  canOperate(chat: string, kind: BrowserKind) {
    const entry = this.entries.get(this.key(chat, kind)), state = entry?.service.get(chat)?.state
    return !this.disposed && !entry?.retiring && !entry?.cleanupError && !['paused', 'humanControl', 'pausing', 'handingOver', 'resuming', 'stopping'].includes(state ?? '')
  }
  private make(scope: BrowserGrantScope, kind: BrowserKind): Entry {
    const key = this.key(scope.chatSessionId, kind), old = this.entries.get(key)
    if (old) return old
    if (this.entries.size >= 128) throw error('ENVIRONMENT_LIMIT', '浏览器环境已达上限，请先停止闲置任务。')
    const settings: BrowserOptions = { browser: kind, profileDir: join(this.options.directory, 'browser-profiles', createHash('sha256').update(scope.chatSessionId).digest('hex'), kind), allowedOrigins: [...scope.allowedOrigins] }
    const actual = this.options.create?.(settings) ?? (() => { const browser = new BrowserSession(settings); return { browser, driver: new BrowserDeviceDriver(browser) } })()
    const entry: Entry = { chat: scope.chatSessionId, kind, environmentId: randomUUID(), generation: scope.generation, ...actual, views: new Map(), tail: Promise.resolve(), retiring: false, closeAttempted: false, service: undefined! }
    entry.service = new ComputerSessionService(actual.driver, { enabled: () => !entry.retiring && !this.disposed && this.options.enabled(), initialEpoch: randomInt(1, 2 ** 40), readAllowedApps: () => [...entry.views.values()].filter(v => v.origin && this.options.isAllowed(entry.chat, kind, v.origin)).map(v => v.appId) })
    this.entries.set(key, entry); return entry
  }
  private assertEntry(entry: Entry) {
    this.live()
    if (this.entries.get(this.key(entry.chat, entry.kind)) !== entry || entry.retiring || entry.cleanupError || this.generation(entry.chat, entry.kind) !== entry.generation) throw error('ENVIRONMENT_CHANGED', '浏览器环境已失效，请重新请求。')
  }
  private synchronize(entry: Entry, candidates: readonly string[]) {
    const allowed = [...new Set([...entry.browser.allowedOrigins(), ...candidates])].filter(origin => this.options.isAllowed(entry.chat, entry.kind, origin))
    entry.browser.setAllowedOrigins(allowed)
  }
  async open(scope: BrowserGrantScope, input: { url: string; origin: string; browser: BrowserKind }): Promise<WorkbenchTarget> {
    this.live(); scope.assertCurrent()
    if (scope.browser !== input.browser || website(input.url).origin !== input.origin || !scope.allowedOrigins.includes(input.origin)) throw error('SITE_NOT_ALLOWED', '当前授权不包含这个网站。')
    const entry = this.make(scope, input.browser)
    const operation = entry.tail.catch(() => {}).then(async () => {
      scope.assertCurrent(); this.assertEntry(entry); this.synchronize(entry, scope.allowedOrigins)
      if (entry.views.size >= 128) throw error('VIEW_LIMIT', '此浏览器已打开较多网页，请先关闭闲置网页。')
      let created: string | undefined, startedEpoch: number | undefined
      try {
        entry.ready ??= entry.browser.launch(scope.signal).catch(failure => { entry.launchFailed = true; throw failure })
        await entry.ready; scope.assertCurrent(); this.assertEntry(entry)
        const tab = await entry.browser.open(input.url, scope.signal, scope.assertCurrent); created = tab.id
        scope.assertCurrent(); this.assertEntry(entry)
        const target = (await entry.driver.targets(scope.signal)).find(t => t.id === tab.id)
        scope.assertCurrent(); this.assertEntry(entry)
        if (!target || website(tab.url).origin !== input.origin || target.appId !== entry.browser.deviceId + ':' + input.origin) throw error('TARGET_CHANGED', '新网页实际来源与本次授权目标不一致。')
        const current = entry.service.get(entry.chat)
        if (current && ['ready', 'running'].includes(current.state)) { await entry.service.stop(entry.chat); scope.assertCurrent(); this.assertEntry(entry) }
        const snapshot = await entry.service.start(entry.chat, target.id, { allowOnce: true, signal: scope.signal, expectedTarget: target }); startedEpoch = snapshot.epoch
        scope.assertCurrent(); this.assertEntry(entry)
        const view: WorkbenchTarget = { chatSessionId: entry.chat, environmentId: entry.environmentId, workbenchTabId: randomUUID(), kind: 'browser', targetId: target.id, appId: target.appId, epoch: snapshot.epoch, title: tab.title || input.origin, origin: input.origin, state: snapshot.state }
        entry.views.set(view.workbenchTabId, view); return structuredClone(view)
      } catch (failure) {
        const current = entry.service.get(entry.chat)
        if (startedEpoch !== undefined && current?.epoch === startedEpoch) await entry.service.stop(entry.chat).catch(e => { entry.cleanupError = e })
        // A stale navigation cannot be replayed. Retain the exact owner whenever cleanup is unconfirmed.
        if (created) try { await entry.browser.closeOwnedTab(created) } catch (cleanup) { entry.cleanupError = cleanup }
        // This known pre-spawn error is retryable only after proving that this exact runtime owns no child/channel.
        if (!created && !startedEpoch && failure instanceof ComputerError && failure.code === 'BROWSER_NOT_INSTALLED' && !entry.browser.hasOwnedRuntime()) {
          entry.retiring = true; this.generations.set(this.key(entry.chat, entry.kind), entry.generation + 1)
          try { await entry.service.dispose(); if (this.entries.get(this.key(entry.chat, entry.kind)) === entry) this.entries.delete(this.key(entry.chat, entry.kind)) } catch (cleanup) { entry.cleanupError = cleanup }
        }
        throw failure
      }
    })
    entry.tail = operation; return operation
  }
  private find(chat: string, environmentId: string, tabId?: string): { entry: Entry; view?: WorkbenchTarget } {
    this.live(); requireIdentity(chat, '聊天'); uuid(environmentId)
    const entry = [...this.entries.values()].find(v => v.chat === chat && v.environmentId === environmentId)
    if (!entry) throw error('ENVIRONMENT_CHANGED', '当前聊天无法操作这个浏览器环境。')
    this.assertEntry(entry)
    const view = tabId === undefined ? undefined : entry.views.get(uuid(tabId))
    if (tabId !== undefined && (!view || view.chatSessionId !== chat || view.environmentId !== environmentId)) throw error('TARGET_CHANGED', '网页不属于这个工作台视图。')
    if (view && (!view.origin || !this.options.isAllowed(chat, entry.kind, view.origin))) throw error('SITE_REVOKED', '这个网站尚未授权或许可已撤销。')
    return { entry, ...(view ? { view } : {}) }
  }
  environments(chat: string) {
    this.live(); requireIdentity(chat, '聊天')
    return [...this.entries.values()].filter(entry => entry.chat === chat).map(entry => ({ environmentId: entry.environmentId, kind: 'browser' as const, browser: entry.kind, state: entry.cleanupError ? 'cleanupRequired' : entry.launchFailed ? 'startupUnconfirmed' : entry.retiring ? 'stopping' : entry.service.get(chat)?.state ?? (entry.ready ? 'connecting' : 'idle'), title: entry.kind === 'edge' ? 'Edge 浏览器' : 'Chrome 浏览器' }))
  }
  views(chat: string): WorkbenchTarget[] {
    this.live(); requireIdentity(chat, '聊天')
    return [...this.entries.values()].filter(e => e.chat === chat && !e.retiring).flatMap(entry => [...entry.views.values()].map(view => {
      const current = entry.service.get(chat), permitted = !!view.origin && this.options.isAllowed(chat, entry.kind, view.origin)
      return { ...view, title: permitted ? view.title : '网站未授权', state: permitted ? current?.target?.id === view.targetId ? current.state : 'background' : 'awaitingPermission', epoch: current?.target?.id === view.targetId ? current.epoch : 0 }
    }))
  }
  viewsFor(exec: BrowserExecution): WorkbenchTarget[] {
    exec.signal.throwIfAborted(); if (!exec.agent || !this.options.isCallerCurrent(exec)) throw error('CALLER_NOT_LIVE', '当前聊天 Agent 已失效。')
    return this.views(exec.agent.id).filter(view => view.state !== 'awaitingPermission')
  }
  capture(exec: BrowserExecution, environmentId: string, tabId: string): HostWorkbenchContext {
    if (!exec.agent || !this.options.isCallerCurrent(exec)) throw error('CALLER_NOT_LIVE', '当前聊天 Agent 已失效。')
    const { entry, view } = this.find(exec.agent.id, environmentId, tabId), snapshot = entry.service.get(entry.chat)
    if (!view || !snapshot?.target || snapshot.target.id !== view.targetId || !['ready', 'running'].includes(snapshot.state)) throw error('TARGET_NOT_ACTIVE', '请明确选择当前操作的网页，并重新观察。')
    const epoch = snapshot.epoch, generation = entry.generation, agent = exec.agent, assertIdentity = () => {
      exec.signal.throwIfAborted(); this.assertEntry(entry)
      if (entry.generation !== generation) throw error('CONTROL_CHANGED', '浏览器任务已结束。')
      if (exec.agent !== agent || !this.options.isCallerCurrent(exec)) throw error('CALLER_NOT_LIVE', '当前聊天 Agent 已失效。')
    }, assertCurrent = () => {
      assertIdentity()
      const current = entry.service.get(entry.chat)
      if (current?.epoch !== epoch || current.target?.id !== view.targetId || current.target.appId !== view.appId || !['ready', 'running'].includes(current.state) || !view.origin || !this.options.isAllowed(entry.chat, entry.kind, view.origin)) throw error('CONTROL_CHANGED', '网页、授权或控制周期已变化，请重新观察。')
    }
    assertCurrent()
    const context = Object.freeze({ chatSessionId: entry.chat, environmentId: entry.environmentId, workbenchTabId: view.workbenchTabId, targetId: view.targetId, epoch, service: entry.service, assertCurrent })
    this.contexts.set(context, { signal: exec.signal, entry, assertIdentity }); return context
  }
  private authentic(context: HostWorkbenchContext) { if (!this.contexts.has(context)) throw error('INVALID_CONTEXT', '控制上下文只能由 Host 创建。'); context.assertCurrent() }
  /** Exact ownership/permission postcondition, including a confirmed navigation target; no old-frame reuse. */
  assertAfter(context: HostWorkbenchContext): void {
    const captured = this.contexts.get(context)
    if (!captured) throw error('INVALID_CONTEXT', '控制上下文只能由 Host 创建。')
    captured.assertIdentity()
    const current = context.service.get(context.chatSessionId)
    if (current?.state === 'stopped') return
    if (!current?.target || current.epoch !== context.epoch || !['ready', 'running'].includes(current.state)) throw error('CONTROL_CHANGED', '浏览器控制权已变化。')
    const prefix = captured.entry.browser.deviceId + ':'
    if (!current.target.appId.startsWith(prefix) || !this.options.isAllowed(context.chatSessionId, captured.entry.kind, website(current.target.appId.slice(prefix.length)).origin)) throw error('SITE_REVOKED', '目标网站许可已撤销。')
  }
  /** Explicit model selection; a UI tab focus/preview never calls this method. */
  async select(exec: BrowserExecution, environmentId: string, tabId: string): Promise<WorkbenchTarget> {
    exec.signal.throwIfAborted(); if (!exec.agent || !this.options.isCallerCurrent(exec)) throw error('CALLER_NOT_LIVE', '当前聊天 Agent 已失效。')
    const { entry, view } = this.find(exec.agent.id, environmentId, tabId)
    if (!view) throw error('TARGET_CHANGED', '网页目标不可用。')
    const agent = exec.agent, check = () => { exec.signal.throwIfAborted(); this.assertEntry(entry); if (exec.agent !== agent || !this.options.isCallerCurrent(exec) || this.find(agent.id, environmentId, tabId).view !== view) throw error('CONTROL_CHANGED', '网页或调用者已变化。') }
    const operation = entry.tail.catch(() => {}).then(async () => {
      check(); const current = entry.service.get(entry.chat)
      if (!current || !['ready', 'running'].includes(current.state)) throw error('OWNER_RESUME_REQUIRED', '此浏览器任务已暂停或由你接管，请先点击继续。')
      const snapshot = await entry.service.selectTarget(entry.chat, view.targetId, exec.signal); check()
      if (!snapshot.target || snapshot.target.id !== view.targetId || snapshot.target.appId !== view.appId) throw error('TARGET_CHANGED', '所选网页实际来源已变化。')
      const updated = { ...view, epoch: snapshot.epoch, state: snapshot.state }; entry.views.set(view.workbenchTabId, updated); return structuredClone(updated)
    })
    entry.tail = operation; return operation
  }

  /** Used only by the trusted model-target selector/H1 authority, never owner RPC parameters. */
  readEnvironment(context: HostWorkbenchContext) {
    this.assertAfter(context)
    const snapshot = context.service.get(context.chatSessionId)
    if (!snapshot?.target || !['ready', 'running'].includes(snapshot.state)) return undefined
    return { environmentId: context.environmentId, epoch: snapshot.epoch, target: structuredClone(snapshot.target), ...(snapshot.lastObservation ? { observation: structuredClone(snapshot.lastObservation) } : {}) }
  }
  async pause(context: HostWorkbenchContext) { this.authentic(context); const snapshot = await context.service.pause(context.chatSessionId); this.contexts.get(context)!.assertIdentity(); return snapshot }
  async observe(context: HostWorkbenchContext): Promise<ComputerObservation> { this.authentic(context); const value = await context.service.observe(context.chatSessionId, this.contexts.get(context)!.signal); context.assertCurrent(); return value }
  async act(context: HostWorkbenchContext, request: ComputerActionRequest): Promise<ComputerActionResult & { workbench?: WorkbenchTarget }> {
    this.authentic(context); const captured = this.contexts.get(context)!, result = await context.service.act(context.chatSessionId, request, captured.signal)
    captured.assertIdentity()
    const current = context.service.get(context.chatSessionId)
    if (result.actionId !== request.actionId || result.epoch !== context.epoch || result.targetId !== context.targetId || current?.lastAction?.actionId !== request.actionId || current.lastAction.phase !== 'completed') throw error('ACTION_UNCONFIRMED', '本次操作的确认状态不完整，请不要重复输入。')
    if (request.action.kind === 'closeTab' && current.state === 'stopped') { captured.entry.views.delete(context.workbenchTabId); return result }
    if (current.epoch !== context.epoch || !current.target || !['ready', 'running'].includes(current.state)) throw error('CONTROL_CHANGED', '操作已结束，但当前控制权已变化。')
    const prefix = captured.entry.browser.deviceId + ':'
    if (!current.target.appId.startsWith(prefix)) throw error('TARGET_CHANGED', '浏览器目标实例已变化。')
    const origin = website(current.target.appId.slice(prefix.length)).origin
    if (!this.options.isAllowed(context.chatSessionId, captured.entry.kind, origin)) throw error('SITE_REVOKED', '目标网站许可已撤销。')
    const previous = [...captured.entry.views.values()].find(v => v.targetId === current.target!.id)
    const workbench: WorkbenchTarget = { chatSessionId: context.chatSessionId, environmentId: context.environmentId, workbenchTabId: previous?.workbenchTabId ?? randomUUID(), targetId: current.target.id, appId: current.target.appId, epoch: current.epoch, kind: 'browser', origin, title: current.target.title, state: current.state }
    captured.entry.views.set(workbench.workbenchTabId, workbench); return { ...result, workbench: structuredClone(workbench) }
  }
  async preview(chat: string, environmentId: string, tabId: string, owner: SiteOwnerScope): Promise<{ target: WorkbenchTarget; observation: ComputerObservation; viewOnly: boolean }> {
    owner.signal.throwIfAborted(); owner.assertCurrent(); const { entry, view } = this.find(chat, environmentId, tabId)
    if (!view) throw error('TARGET_CHANGED', '网页目标不可用。')
    const check = () => { owner.signal.throwIfAborted(); owner.assertCurrent(); if (this.find(chat, environmentId, tabId).view !== view) throw error('VIEW_CHANGED', '网页内容版本已变化。') }
    const before = (await entry.driver.targets(owner.signal)).find(target => target.id === view.targetId); check()
    if (!before || before.appId !== view.appId) throw error('VIEW_CHANGED', '网页来源已变化，请刷新工作台。')
    const current = entry.service.get(chat), active = current?.target?.id === view.targetId
    const observation = await (active ? entry.service.preview(chat, owner.signal) : entry.browser.preview(view.targetId, owner.signal)); check()
    const after = (await entry.driver.targets(owner.signal)).find(target => target.id === view.targetId); check()
    if (!after || after.appId !== before.appId || after.pid !== before.pid) throw error('VIEW_CHANGED', '网页来源已变化，请刷新工作台。')
    observation.aiCursor = workbenchCursor(observation, entry.service.get(chat))
    return { target: { ...view, state: active ? entry.service.get(chat)!.state : 'background', epoch: active ? entry.service.get(chat)!.epoch : 0 }, observation, viewOnly: !active || entry.service.get(chat)?.state !== 'humanControl' }
  }
  async control(chat: string, environmentId: string, tabId: string, operation: 'pause' | 'takeover' | 'resume' | 'stop', owner: SiteOwnerScope) {
    owner.signal.throwIfAborted(); owner.assertCurrent(); const { entry, view } = this.find(chat, environmentId, tabId)
    if (!view) throw error('TARGET_CHANGED', '网页目标不可用。')
    const check = () => { owner.signal.throwIfAborted(); owner.assertCurrent(); this.find(chat, environmentId, tabId) }
    let current = entry.service.get(chat)
    if (current?.target?.id !== view.targetId) {
      if (operation !== 'takeover') throw error('TARGET_NOT_ACTIVE', '这不是当前操作的网页，请选择接管此页。')
      if (current && !['stopped', 'faulted', 'disconnected'].includes(current.state)) { await entry.service.stop(chat); check() }
      const target = (await entry.driver.targets(owner.signal)).find(value => value.id === view.targetId); check()
      if (!target || target.appId !== view.appId) throw error('TARGET_CHANGED', '网页目标已变化，请重新请求。')
      await entry.service.start(chat, target.id, { allowOnce: true, signal: owner.signal, expectedTarget: target }); check()
    }
    if (operation === 'stop') { entry.generation++; this.generations.set(this.key(chat, entry.kind), entry.generation) }
    const snapshot = await entry.service[operation](chat); if (operation === 'stop') { owner.signal.throwIfAborted(); owner.assertCurrent(); this.assertEntry(entry) } else check()
    return snapshot
  }
  async humanAct(chat: string, environmentId: string, tabId: string, request: ComputerActionRequest, owner: SiteOwnerScope): Promise<ComputerActionResult & { workbench?: WorkbenchTarget }> {
    owner.signal.throwIfAborted(); owner.assertCurrent(); const { entry, view } = this.find(chat, environmentId, tabId)
    const current = entry.service.get(chat)
    if (!view || current?.target?.id !== view.targetId || current.target.appId !== view.appId || current.state !== 'humanControl') throw error('OWNER_TAKEOVER_REQUIRED', '请先接管这个网页，再操作预览画面。')
    const result = await entry.service.humanAct(chat, request, owner.signal)
    owner.signal.throwIfAborted(); owner.assertCurrent(); this.assertEntry(entry)
    const after = entry.service.get(chat)
    if (result.actionId !== request.actionId || result.targetId !== view.targetId || result.epoch !== current.epoch || after?.lastAction?.actionId !== request.actionId || after.lastAction.phase !== 'completed') throw error('ACTION_UNCONFIRMED', '本次接管操作结果未能确认。')
    if (request.action.kind === 'closeTab' && after.state === 'stopped') { entry.views.delete(view.workbenchTabId); return result }
    if (after.state !== 'humanControl' || after.epoch !== current.epoch || !after.target) throw error('CONTROL_CHANGED', '接管状态已变化。')
    const prefix = entry.browser.deviceId + ':'
    if (!after.target.appId.startsWith(prefix)) throw error('TARGET_CHANGED', '网页实例已变化。')
    const origin = website(after.target.appId.slice(prefix.length)).origin
    if (!this.options.isAllowed(chat, entry.kind, origin)) throw error('SITE_REVOKED', '目标网站许可已撤销。')
    const previous = [...entry.views.values()].find(value => value.targetId === after.target!.id)
    const updated: WorkbenchTarget = { chatSessionId: chat, environmentId, workbenchTabId: previous?.workbenchTabId ?? randomUUID(), kind: 'browser', targetId: after.target.id, appId: after.target.appId, title: after.target.title, origin, epoch: after.epoch, state: after.state }
    entry.views.set(updated.workbenchTabId, updated); return { ...result, workbench: structuredClone(updated) }
  }
  async navigation(chat: string, environmentId: string, tabId: string, owner: SiteOwnerScope) {
    owner.signal.throwIfAborted(); owner.assertCurrent(); const { entry, view } = this.find(chat, environmentId, tabId)
    if (!view) throw error('TARGET_CHANGED', '网页目标不可用。')
    const result = await entry.browser.navigationState(view.targetId, owner.signal)
    owner.signal.throwIfAborted(); owner.assertCurrent(); if (this.find(chat, environmentId, tabId).view !== view) throw error('VIEW_CHANGED', '网页已变化。')
    return result
  }
  invalidateOrigin(origin: string): Promise<void> {
    const pending: Promise<unknown>[] = []
    for (const entry of this.entries.values()) {
      entry.browser.setAllowedOrigins(entry.browser.allowedOrigins().filter(value => value !== origin))
      const snapshot = entry.service.get(entry.chat), view = [...entry.views.values()].find(v => v.targetId === snapshot?.target?.id)
      if (view?.origin === origin) pending.push(entry.service.stop(entry.chat))
    }
    return Promise.all(pending).then(() => {})
  }
  /** Feature off retires each task's once capability and fences pending input before awaiting cleanup. */
  stopAll(): Promise<void> {
    const work: Promise<unknown>[] = []
    for (const entry of this.entries.values()) { entry.generation++; this.generations.set(this.key(entry.chat, entry.kind), entry.generation); if (entry.service.get(entry.chat)) work.push(entry.service.stop(entry.chat)) }
    return Promise.allSettled(work).then(results => { const failed = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected'); if (failed.length) throw new AggregateError(failed.map(value => value.reason), '部分浏览器输入尚未确认释放。') })
  }
  async stopEnvironment(chat: string, environmentId: string, owner: SiteOwnerScope): Promise<void> {
    owner.signal.throwIfAborted(); owner.assertCurrent(); requireIdentity(chat, '聊天'); uuid(environmentId)
    const entry = [...this.entries.values()].find(value => value.chat === chat && value.environmentId === environmentId)
    if (!entry) throw error('ENVIRONMENT_CHANGED', '当前聊天无法停止这个浏览器。')
    entry.retiring = true; this.generations.set(this.key(chat, entry.kind), entry.generation + 1)
    try { await entry.tail.catch(() => {}); if (!entry.closeAttempted) { entry.closeAttempted = true; await entry.service.dispose() } else await entry.driver.dispose?.(); this.entries.delete(this.key(chat, entry.kind)); owner.signal.throwIfAborted(); owner.assertCurrent() }
    catch (failure) { entry.cleanupError = failure; throw failure }
  }
  async dispose(): Promise<void> {
    this.disposed = true; const failures: unknown[] = []
    for (const entry of this.entries.values()) { entry.retiring = true; try { await entry.tail.catch(() => {}); if (!entry.closeAttempted) { entry.closeAttempted = true; await entry.service.dispose() } else await entry.driver.dispose?.(); this.entries.delete(this.key(entry.chat, entry.kind)) } catch (failure) { entry.cleanupError = failure; failures.push(failure) } }
    if (failures.length) throw new AggregateError(failures, '部分浏览器环境尚未确认退出。')
  }
}
