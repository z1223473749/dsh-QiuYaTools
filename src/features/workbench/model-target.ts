import { ComputerError } from '../computer-use/contract.ts'
import type { ComputerEnvironmentManager } from '../computer-use/environment-manager.ts'
import type { BrowserWorkbenchRegistry, HostWorkbenchContext } from './browser-registry.ts'
import type { BrowserExecution, SiteOwnerScope } from './site-permissions.ts'
type Agent = NonNullable<BrowserExecution['agent']>
export interface HostModelTargetContext { readonly kind: 'browser' | 'desktop'; readonly environmentId: string; readonly targetId: string; readonly appId: string; readonly epoch: number; assertCurrent(): void; assertIdentity(): void; stop(owner: SiteOwnerScope): Promise<boolean> }
type DesktopController = Pick<ComputerEnvironmentManager, 'runEnvironment'> & Partial<Pick<ComputerEnvironmentManager, 'stop' | 'get' | 'modelObservationGeneration'>>
type Selected = { kind: 'desktop'; agent: Agent } | { kind: 'browser'; agent: Agent; context: HostWorkbenchContext }
/** Model-facing authority source. SDK view focus/float/dock/close never writes this registry. */
export class ModelTargetRegistry {
  private readonly selected = new Map<string, Selected>()
  private readonly revisions = new Map<string, number>()
  constructor(private readonly desktops: DesktopController, private readonly browsers: BrowserWorkbenchRegistry, private readonly current: (agent: Agent) => boolean) {}
  private agent(exec: BrowserExecution): Agent { exec.signal.throwIfAborted(); if (!exec.agent || !this.current(exec.agent)) throw new ComputerError('CALLER_NOT_LIVE', '当前聊天主 Agent 已失效。'); return exec.agent }
  selectDesktop(exec: BrowserExecution): void {
    const agent = this.agent(exec)
    if (!this.desktops.runEnvironment(agent.id)) throw new ComputerError('ENVIRONMENT_CHANGED', '当前聊天没有就绪的桌面操作目标。')
    const prior = this.selected.get(agent.id)
    if (prior?.kind === 'browser' || prior && prior.agent !== agent) this.revisions.set(agent.id, (this.revisions.get(agent.id) ?? 0) + 1)
    this.selected.set(agent.id, { kind: 'desktop', agent })
  }
  selectBrowser(exec: BrowserExecution, context: HostWorkbenchContext): void {
    const agent = this.agent(exec)
    context.assertCurrent()
    if (context.chatSessionId !== agent.id || !this.browsers.readEnvironment(context)) throw new ComputerError('INVALID_CONTEXT', '浏览器目标不属于当前聊天。')
    const prior = this.selected.get(agent.id), actual = this.browsers.readEnvironment(context)
    let previous: typeof actual
    try { previous = prior?.kind === 'browser' ? this.browsers.readEnvironment(prior.context) : undefined } catch { previous = undefined }
    if (prior?.kind !== 'browser' || prior.agent !== agent || prior.context.service !== context.service || !previous || !actual || previous.environmentId !== actual.environmentId || previous.epoch !== actual.epoch || previous.target.id !== actual.target.id || previous.target.appId !== actual.target.appId) this.revisions.set(agent.id, (this.revisions.get(agent.id) ?? 0) + 1)
    this.selected.set(agent.id, { kind: 'browser', agent, context })
  }
  runEnvironment(chat: string) {
    const selection = this.selected.get(chat)
    if (!selection) return this.desktops.runEnvironment(chat)
    if (!this.current(selection.agent) || selection.agent.id !== chat) return undefined
    try { return selection.kind === 'browser' ? this.browsers.readEnvironment(selection.context) : this.desktops.runEnvironment(chat) } catch { return undefined }
  }
  /** Host-only trusted successful observe receipt from the exact selected service, independent of UI tabs. */
  modelObservationGeneration(chat: string): number | undefined {
    const selection = this.selected.get(chat)
    if (selection && (!this.current(selection.agent) || selection.agent.id !== chat)) return undefined
    try { return selection?.kind === 'browser' ? this.browsers.readObservationGeneration(selection.context) : this.desktops.modelObservationGeneration?.(chat) } catch { return undefined }
  }
  assertBrowser(exec: BrowserExecution, context: HostWorkbenchContext) {
    const agent = this.agent(exec), selection = this.selected.get(agent.id)
    this.browsers.assertAfter(context)
    if (selection?.kind !== 'browser' || selection.agent !== agent || selection.context.service !== context.service || selection.context.environmentId !== context.environmentId) throw new ComputerError('CONTROL_CHANGED', '本次验收与浏览器执行环境不一致。')
    const environment = this.runEnvironment(agent.id)
    if (!environment || environment.environmentId !== context.environmentId || environment.epoch !== context.epoch) throw new ComputerError('CONTROL_CHANGED', '本次浏览器执行周期已变化。')
  }
  /** Host-only workflow capability. stop attests device release only; the caller must independently drain the actual Agent. Serialized ids or view focus cannot create it. */
  captureTarget(exec: BrowserExecution, cancelAgent: () => void): HostModelTargetContext {
    const agent = this.agent(exec), selected = this.selected.get(agent.id), environment = this.runEnvironment(agent.id)
    if (!environment) throw new ComputerError('ENVIRONMENT_CHANGED', '当前聊天没有就绪的验收目标。')
    const revision = this.revisions.get(agent.id) ?? 0
    const kind = selected?.kind === 'browser' ? 'browser' : 'desktop', browser = selected?.kind === 'browser' ? selected.context : undefined
    const identity = () => { if (!this.current(agent)) throw new ComputerError('CALLER_NOT_LIVE', '当前聊天主 Agent 已变化。') }
    const current = () => {
      exec.signal.throwIfAborted(); identity()
      const selection = this.selected.get(agent.id), actual = this.runEnvironment(agent.id)
      if ((this.revisions.get(agent.id) ?? 0) !== revision || (selection?.kind === 'browser' ? 'browser' : 'desktop') !== kind || browser && (selection?.kind !== 'browser' || selection.context.service !== browser.service) || !actual || actual.environmentId !== environment.environmentId || actual.epoch !== environment.epoch || actual.target.id !== environment.target.id || actual.target.appId !== environment.target.appId) throw new ComputerError('CONTROL_CHANGED', '验收目标、网站或控制周期已变化。')
    }
    current()
    return Object.freeze({ kind, environmentId: environment.environmentId, targetId: environment.target.id, appId: environment.target.appId, epoch: environment.epoch, assertCurrent: current, assertIdentity: identity, stop: async (owner: SiteOwnerScope) => {
      owner.signal.throwIfAborted(); owner.assertCurrent(); current()
      // The exact service synchronously invalidates input before cancelling the Agent.
      // Cleanup then uses owner/identity fences, never a fabricated replacement Tool exec.
      if (!browser && (!this.desktops.stop || !this.desktops.get)) throw new ComputerError('ENVIRONMENT_CHANGED', '当前宿主无法确认桌面任务停止。')
      const stopping = browser ? this.browsers.control(agent.id, environment.environmentId, browser.workbenchTabId, 'stop', owner) : this.desktops.stop!(agent.id)
      void stopping.catch(() => {})
      cancelAgent()
      await stopping
      owner.signal.throwIfAborted(); owner.assertCurrent(); identity()
      const stopped = browser ? browser.service.get(agent.id) : this.desktops.get!(agent.id)
      return !!stopped && stopped.state === 'stopped' && stopped.epoch > environment.epoch && stopped.target?.id === environment.target.id && stopped.target.appId === environment.target.appId
    } })
  }
  clear() { for (const id of this.selected.keys()) this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1); this.selected.clear() }
}
