import { workbenchCursor } from './preview-model.ts'
import { randomUUID } from 'node:crypto'
import type { ComputerEnvironmentManager } from '../computer-use/environment-manager.ts'
import { ComputerError, requireIdentity } from '../computer-use/contract.ts'
import type { ComputerActionRequest, ComputerActionResult, ComputerObservation } from '../computer-use/contract.ts'
import type { WorkbenchTarget } from './contract.ts'
import type { SiteOwnerScope } from './site-permissions.ts'
import { uuid } from './contract.ts'
type Manager = Pick<ComputerEnvironmentManager, 'workbenchEnvironment' | 'preview' | 'pause' | 'takeover' | 'resume' | 'stop' | 'humanAct'> & Partial<Pick<ComputerEnvironmentManager, 'listTasks' | 'resolveTask'>>
/** A view adapter over the existing desktop manager. It never makes/connects a router or grants an app. */
export class DesktopWorkbenchRegistry {
  private viewsByOperation = new Map<string, WorkbenchTarget>()
  constructor(private readonly manager: Manager) {}
  views(chat: string): WorkbenchTarget[] {
    requireIdentity(chat, '聊天')
    const operations = [chat, ...(this.manager.listTasks?.(chat) ?? []).map(task => this.manager.resolveTask!(chat, task.taskId))]
    const owned = new Set(operations), views: WorkbenchTarget[] = []
    for (const [id, view] of this.viewsByOperation) if (view.chatSessionId === chat && !owned.has(id)) this.viewsByOperation.delete(id)
    for (const operation of operations) {
      const actual = this.manager.workbenchEnvironment(operation), previous = this.viewsByOperation.get(operation)
      if (!actual?.snapshot.target) { this.viewsByOperation.delete(operation); continue }
      const snapshot = actual.snapshot, target = snapshot.target!
      const view: WorkbenchTarget = { chatSessionId: chat, environmentId: actual.environmentId, workbenchTabId: previous?.environmentId === actual.environmentId && previous.targetId === target.id && previous.appId === target.appId ? previous.workbenchTabId : randomUUID(), kind: 'desktop', targetId: target.id, appId: target.appId, epoch: snapshot.epoch, title: snapshot.taskLabel ?? target.title, state: snapshot.state }
      this.viewsByOperation.set(operation, view); views.push(structuredClone(view))
    }
    return views
  }
  private operation(view: WorkbenchTarget): string {
    const row = [...this.viewsByOperation].find(([, value]) => value.chatSessionId === view.chatSessionId && value.environmentId === view.environmentId && value.workbenchTabId === view.workbenchTabId)
    if (!row) throw new ComputerError('VIEW_CHANGED', '这个电脑任务已失效。')
    if (row[0] !== view.chatSessionId) this.manager.resolveTask?.(view.chatSessionId, row[0])
    return row[0]
  }
  private find(chat: string, environmentId: string, viewId: string) {
    uuid(environmentId); uuid(viewId)
    const view = this.views(chat).find(value => value.environmentId === environmentId && value.workbenchTabId === viewId)
    if (!view) throw new ComputerError('VIEW_CHANGED', '这个桌面视图已失效，请重新打开。')
    return view
  }
  private current(chat: string, expected: WorkbenchTarget, owner: SiteOwnerScope, compareEpoch = true) {
    owner.signal.throwIfAborted(); owner.assertCurrent()
    // Entry lookup still rejects an invalid view as VIEW_CHANGED. Once a view
    // was verified, pause/stop/replacement during a device wait invalidates the
    // old control context; it must not publish that late frame as current.
    const view = this.views(chat).find(value => value.environmentId === expected.environmentId && value.workbenchTabId === expected.workbenchTabId)
    if (!view || view.targetId !== expected.targetId || view.appId !== expected.appId || compareEpoch && view.epoch !== expected.epoch) throw new ComputerError('CONTROL_CHANGED', '桌面窗口或控制周期已变化。')
    return view
  }
  async preview(chat: string, environmentId: string, viewId: string, owner: SiteOwnerScope): Promise<{ target: WorkbenchTarget; observation: ComputerObservation; viewOnly: boolean }> {
    owner.signal.throwIfAborted(); owner.assertCurrent(); const view = this.find(chat, environmentId, viewId)
    this.current(chat, view, owner)
    const observation = await this.manager.preview(this.operation(view), owner.signal)
    const after = this.current(chat, view, owner)
    if (observation.targetId !== view.targetId) throw new ComputerError('VIEW_CHANGED', '画面归属未能确认。')
    observation.aiCursor = workbenchCursor(observation, this.manager.workbenchEnvironment(this.operation(view))?.snapshot)
    return { target: after, observation, viewOnly: after.state !== 'humanControl' }
  }
  async control(chat: string, environmentId: string, viewId: string, operation: 'pause' | 'takeover' | 'resume' | 'stop', owner: SiteOwnerScope) {
    owner.signal.throwIfAborted(); owner.assertCurrent(); const view = this.find(chat, environmentId, viewId)
    this.current(chat, view, owner)
    const result = await this.manager[operation](this.operation(view))
    owner.signal.throwIfAborted(); owner.assertCurrent()
    if (operation !== 'stop') this.current(chat, view, owner, false)
    return result
  }
  async humanAct(chat: string, environmentId: string, viewId: string, request: ComputerActionRequest, owner: SiteOwnerScope): Promise<ComputerActionResult> {
    owner.signal.throwIfAborted(); owner.assertCurrent(); const view = this.find(chat, environmentId, viewId)
    if (view.state !== 'humanControl') throw new ComputerError('OWNER_TAKEOVER_REQUIRED', '请先接管这个桌面窗口。')
    this.current(chat, view, owner)
    const result = await this.manager.humanAct(this.operation(view), request, owner.signal)
    this.current(chat, view, owner)
    return result
  }
  async stopEnvironment(chat: string, environmentId: string, owner: SiteOwnerScope) {
    owner.signal.throwIfAborted(); owner.assertCurrent(); const view = this.views(chat).find(value => value.environmentId === uuid(environmentId))
    if (!view) throw new ComputerError('VIEW_CHANGED', '桌面任务已结束。')
    await this.control(chat, environmentId, view.workbenchTabId, 'stop', owner)
  }
}
