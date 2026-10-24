import { ComputerError, requireIdentity } from '../computer-use/contract.ts'
import type { ComputerActionRequest } from '../computer-use/contract.ts'
import type { BrowserWorkbenchRegistry } from './browser-registry.ts'
import type { DesktopWorkbenchRegistry } from './desktop-registry.ts'
import type { SiteOwnerScope } from './site-permissions.ts'
import { uuid } from './contract.ts'
/** Only Host creates these adapters. An address is a view lookup, never an execution context. */
export class WorkbenchRegistry {
  constructor(readonly browsers: BrowserWorkbenchRegistry, readonly desktops?: DesktopWorkbenchRegistry) {}
  views(chat: string) { requireIdentity(chat, '聊天'); return [...this.browsers.views(chat), ...(this.desktops?.views(chat) ?? [])] }
  environments(chat: string) { return [...this.browsers.environments(chat), ...(this.desktops?.views(chat) ?? []).map(view => ({ environmentId: view.environmentId, kind: 'desktop' as const, state: view.state, title: view.title }))] }
  private route(chat: string, environmentId: string, viewId: string) {
    uuid(environmentId); uuid(viewId)
    const matches = this.views(chat).filter(view => view.environmentId === environmentId && view.workbenchTabId === viewId)
    if (matches.length !== 1) throw new ComputerError('VIEW_CHANGED', '工作台视图已失效，请重新打开。')
    const view = matches[0]!, registry = view.kind === 'browser' ? this.browsers : this.desktops
    if (!registry) throw new ComputerError('VIEW_CHANGED', '当前环境不可用。')
    return { view, registry }
  }
  preview(chat: string, environmentId: string, viewId: string, owner: SiteOwnerScope) { owner.assertCurrent(); owner.signal.throwIfAborted(); return this.route(chat, environmentId, viewId).registry.preview(chat, environmentId, viewId, owner) }
  control(chat: string, environmentId: string, viewId: string, operation: 'pause' | 'takeover' | 'resume' | 'stop', owner: SiteOwnerScope) { owner.assertCurrent(); owner.signal.throwIfAborted(); return this.route(chat, environmentId, viewId).registry.control(chat, environmentId, viewId, operation, owner) }
  humanAct(chat: string, environmentId: string, viewId: string, request: ComputerActionRequest, owner: SiteOwnerScope) { owner.assertCurrent(); owner.signal.throwIfAborted(); return this.route(chat, environmentId, viewId).registry.humanAct(chat, environmentId, viewId, request, owner) }
  navigation(chat: string, environmentId: string, viewId: string, owner: SiteOwnerScope) { owner.assertCurrent(); owner.signal.throwIfAborted(); if (this.route(chat, environmentId, viewId).view.kind !== 'browser') throw new ComputerError('BROWSER_ACTION_UNSUPPORTED', '这个桌面视图没有浏览器历史。'); return this.browsers.navigation(chat, environmentId, viewId, owner) }
  stopEnvironment(chat: string, environmentId: string, owner: SiteOwnerScope) {
    owner.assertCurrent(); owner.signal.throwIfAborted(); uuid(environmentId)
    const kinds = new Set(this.environments(chat).filter(value => value.environmentId === environmentId).map(value => value.kind))
    if (kinds.size !== 1) throw new ComputerError('ENVIRONMENT_CHANGED', '这个操作环境已失效。')
    const registry = kinds.has('browser') ? this.browsers : this.desktops
    if (!registry) throw new ComputerError('ENVIRONMENT_CHANGED', '这个操作环境已失效。')
    return registry.stopEnvironment(chat, environmentId, owner)
  }
}
