import { ComputerError } from '../computer-use/contract.ts'
import type { ComputerEnvironmentManager } from '../computer-use/environment-manager.ts'
import type { BrowserWorkbenchRegistry, HostWorkbenchContext } from './browser-registry.ts'
import type { BrowserExecution } from './site-permissions.ts'
type Agent = NonNullable<BrowserExecution['agent']>
type Selected = { kind: 'desktop'; agent: Agent } | { kind: 'browser'; agent: Agent; context: HostWorkbenchContext }
/** Model-facing authority source. SDK view focus/float/dock/close never writes this registry. */
export class ModelTargetRegistry {
  private readonly selected = new Map<string, Selected>()
  constructor(private readonly desktops: Pick<ComputerEnvironmentManager, 'runEnvironment'>, private readonly browsers: BrowserWorkbenchRegistry, private readonly current: (agent: Agent) => boolean) {}
  private agent(exec: BrowserExecution): Agent { exec.signal.throwIfAborted(); if (!exec.agent || !this.current(exec.agent)) throw new ComputerError('CALLER_NOT_LIVE', '当前聊天主 Agent 已失效。'); return exec.agent }
  selectDesktop(exec: BrowserExecution): void {
    const agent = this.agent(exec)
    if (!this.desktops.runEnvironment(agent.id)) throw new ComputerError('ENVIRONMENT_CHANGED', '当前聊天没有就绪的桌面操作目标。')
    this.selected.set(agent.id, { kind: 'desktop', agent })
  }
  selectBrowser(exec: BrowserExecution, context: HostWorkbenchContext): void {
    const agent = this.agent(exec)
    context.assertCurrent()
    if (context.chatSessionId !== agent.id || !this.browsers.readEnvironment(context)) throw new ComputerError('INVALID_CONTEXT', '浏览器目标不属于当前聊天。')
    this.selected.set(agent.id, { kind: 'browser', agent, context })
  }
  runEnvironment(chat: string) {
    const selection = this.selected.get(chat)
    if (!selection) return this.desktops.runEnvironment(chat)
    if (!this.current(selection.agent) || selection.agent.id !== chat) return undefined
    try { return selection.kind === 'browser' ? this.browsers.readEnvironment(selection.context) : this.desktops.runEnvironment(chat) } catch { return undefined }
  }
  assertBrowser(exec: BrowserExecution, context: HostWorkbenchContext) {
    const agent = this.agent(exec), selection = this.selected.get(agent.id)
    this.browsers.assertAfter(context)
    if (selection?.kind !== 'browser' || selection.agent !== agent || selection.context.service !== context.service || selection.context.environmentId !== context.environmentId) throw new ComputerError('CONTROL_CHANGED', '本次验收与浏览器执行环境不一致。')
    const environment = this.runEnvironment(agent.id)
    if (!environment || environment.environmentId !== context.environmentId || environment.epoch !== context.epoch) throw new ComputerError('CONTROL_CHANGED', '本次浏览器执行周期已变化。')
  }
  clear() { this.selected.clear() }
}
