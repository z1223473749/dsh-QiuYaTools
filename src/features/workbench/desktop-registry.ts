import { workbenchCursor } from './preview-model.ts'
import { randomUUID } from 'node:crypto'
import type { ComputerEnvironmentManager } from '../computer-use/environment-manager.ts'
import { ComputerError, requireIdentity } from '../computer-use/contract.ts'
import type { ComputerActionRequest, ComputerActionResult, ComputerObservation } from '../computer-use/contract.ts'
import type { WorkbenchTarget } from './contract.ts'
import type { SiteOwnerScope } from './site-permissions.ts'
import { uuid } from './contract.ts'
type Manager = Pick<ComputerEnvironmentManager, 'workbenchEnvironment' | 'preview' | 'pause' | 'takeover' | 'resume' | 'stop' | 'humanAct'>
/** A view adapter over the existing desktop manager. It never makes/connects a router or grants an app. */
export class DesktopWorkbenchRegistry {
  private viewsByChat = new Map<string, WorkbenchTarget>()
  constructor(private readonly manager: Manager) {}
  views(chat: string): WorkbenchTarget[] {
    requireIdentity(chat, '聊天')
    const actual = this.manager.workbenchEnvironment(chat), previous = this.viewsByChat.get(chat)
    if (!actual?.snapshot.target) { this.viewsByChat.delete(chat); return [] }
    const snapshot = actual.snapshot, target = snapshot.target!
    const view: WorkbenchTarget = { chatSessionId: chat, environmentId: actual.environmentId, workbenchTabId: previous?.environmentId === actual.environmentId && previous.targetId === target.id && previous.appId === target.appId ? previous.workbenchTabId : randomUUID(), kind: 'desktop', targetId: target.id, appId: target.appId, epoch: snapshot.epoch, title: target.title, state: snapshot.state }
    this.viewsByChat.set(chat, view); return [structuredClone(view)]
  }
  private find(chat: string, environmentId: string, viewId: string) {
    uuid(environmentId); uuid(viewId)
    const view = this.views(chat).find(value => value.environmentId === environmentId && value.workbenchTabId === viewId)
    if (!view) throw new ComputerError('VIEW_CHANGED', '这个桌面视图已失效，请重新打开。')
    return view
  }
  private current(chat: string, expected: WorkbenchTarget, owner: SiteOwnerScope, compareEpoch = true) {
    owner.signal.throwIfAborted(); owner.assertCurrent()
    const view = this.find(chat, expected.environmentId, expected.workbenchTabId)
    if (view.targetId !== expected.targetId || view.appId !== expected.appId || compareEpoch && view.epoch !== expected.epoch) throw new ComputerError('VIEW_CHANGED', '桌面窗口或控制周期已变化。')
    return view
  }
  async preview(chat: string, environmentId: string, viewId: string, owner: SiteOwnerScope): Promise<{ target: WorkbenchTarget; observation: ComputerObservation; viewOnly: boolean }> {
    owner.signal.throwIfAborted(); owner.assertCurrent(); const view = this.find(chat, environmentId, viewId)
    this.current(chat, view, owner)
    const observation = await this.manager.preview(chat, owner.signal)
    const after = this.current(chat, view, owner)
    if (observation.targetId !== view.targetId) throw new ComputerError('VIEW_CHANGED', '画面归属未能确认。')
    observation.aiCursor = workbenchCursor(observation, this.manager.workbenchEnvironment(chat)?.snapshot)
    return { target: after, observation, viewOnly: after.state !== 'humanControl' }
  }
  async control(chat: string, environmentId: string, viewId: string, operation: 'pause' | 'takeover' | 'resume' | 'stop', owner: SiteOwnerScope) {
    owner.signal.throwIfAborted(); owner.assertCurrent(); const view = this.find(chat, environmentId, viewId)
    this.current(chat, view, owner)
    const result = await this.manager[operation](chat)
    owner.signal.throwIfAborted(); owner.assertCurrent()
    if (operation !== 'stop') this.current(chat, view, owner, false)
    return result
  }
  async humanAct(chat: string, environmentId: string, viewId: string, request: ComputerActionRequest, owner: SiteOwnerScope): Promise<ComputerActionResult> {
    owner.signal.throwIfAborted(); owner.assertCurrent(); const view = this.find(chat, environmentId, viewId)
    if (view.state !== 'humanControl') throw new ComputerError('OWNER_TAKEOVER_REQUIRED', '请先接管这个桌面窗口。')
    this.current(chat, view, owner)
    const result = await this.manager.humanAct(chat, request, owner.signal)
    this.current(chat, view, owner)
    return result
  }
  async stopEnvironment(chat: string, environmentId: string, owner: SiteOwnerScope) {
    owner.signal.throwIfAborted(); owner.assertCurrent(); const view = this.views(chat).find(value => value.environmentId === uuid(environmentId))
    if (!view) throw new ComputerError('VIEW_CHANGED', '桌面任务已结束。')
    await this.control(chat, environmentId, view.workbenchTabId, 'stop', owner)
  }
}
