import { ComputerError, requireIdentity, parseComputerAction } from '../computer-use/contract.ts'
import type { ComputerAction, ComputerObservation } from '../computer-use/contract.ts'
import { uuid, siteOrigin } from './contract.ts'
import type { SiteDecision, SiteRequest, WorkbenchTarget } from './contract.ts'
export const WORKBENCH_ENDPOINT = 'qiuya-tools.workbench'
export interface WorkbenchConnection { rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: { code?: string; message?: string } }> } }
export interface WorkbenchStatus { views: WorkbenchTarget[]; pendingRequests: SiteRequest[]; allowedOrigins: string[]; environments?: { environmentId: string; kind: string; state: string; title: string }[] }
export interface WorkbenchFrame { target: WorkbenchTarget; observation: ComputerObservation; viewOnly: boolean }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('工作台数据无效'); return value as Record<string, unknown> }
function text(value: unknown, max = 4096): string { if (typeof value !== 'string' || value.length > max) throw Error('工作台文本无效'); return value }
function number(value: unknown, min: number, max: number): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw Error('工作台尺寸无效'); return value }
function list<T>(value: unknown, max: number, read: (v: unknown) => T): T[] { if (!Array.isArray(value) || value.length > max) throw Error('工作台列表无效'); return value.map(read) }
export function parseWorkbenchTarget(value: unknown, chat: string): WorkbenchTarget {
  const v = object(value); if (v.chatSessionId !== chat || (v.kind !== 'browser' && v.kind !== 'desktop')) throw Error('工作台不属于当前聊天')
  const target: WorkbenchTarget = { chatSessionId: chat, environmentId: uuid(v.environmentId), workbenchTabId: uuid(v.workbenchTabId), kind: v.kind as 'browser' | 'desktop', targetId: requireIdentity(v.targetId), appId: requireIdentity(v.appId), epoch: number(v.epoch, 0, Number.MAX_SAFE_INTEGER), title: text(v.title), state: text(v.state, 64) }
  if (!Number.isSafeInteger(target.epoch)) throw Error('工作台控制周期无效')
  if (v.origin !== undefined) target.origin = siteOrigin(v.origin)
  return target
}
function pending(value: unknown, chat: string): SiteRequest {
  const v = object(value)
  if (v.chatSessionId !== chat || v.requestVersion !== 1 || v.state !== 'pending' || (v.browser !== 'chrome' && v.browser !== 'edge')) throw Error('网站请求不属于当前聊天')
  return { requestId: uuid(v.requestId), requestVersion: 1, chatSessionId: chat, browser: v.browser as 'chrome' | 'edge', origin: siteOrigin(v.origin), reason: text(v.reason, 600), createdAt: number(v.createdAt, 0, Number.MAX_SAFE_INTEGER), expiresAt: number(v.expiresAt, 0, Number.MAX_SAFE_INTEGER), state: 'pending' }
}
export function parseWorkbenchStatus(value: unknown, chat: string): WorkbenchStatus {
  const v = object(value), views = list(v.views, 512, item => parseWorkbenchTarget(item, chat))
  if (new Set(views.map(view => view.workbenchTabId)).size !== views.length) throw Error('工作台视图编号重复')
  return { views, pendingRequests: list(v.pendingRequests, 32, item => pending(item, chat)), allowedOrigins: list(v.allowedOrigins, 128, siteOrigin), ...(v.environments === undefined ? {} : { environments: list(v.environments, 129, item => { const e = object(item); return { environmentId: uuid(e.environmentId), kind: text(e.kind, 32), state: text(e.state, 64), title: text(e.title) } }) }) }
}
export function parseWorkbenchFrame(value: unknown, expected: WorkbenchTarget): WorkbenchFrame {
  const v = object(value), target = parseWorkbenchTarget(v.target, expected.chatSessionId), o = object(v.observation), g = object(o.geometry)
  if (target.environmentId !== expected.environmentId || target.workbenchTabId !== expected.workbenchTabId || target.targetId !== expected.targetId || o.targetId !== expected.targetId || typeof v.viewOnly !== 'boolean' || o.mediaType !== 'image/jpeg') throw Error('当前画面归属已变化')
  const imageBase64 = text(o.imageBase64, 32 * 1024 * 1024)
  if (!imageBase64 || imageBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(imageBase64)) throw Error('实时画面无效')
  const observation: ComputerObservation = { targetId: target.targetId, frameId: requireIdentity(o.frameId), width: number(o.width, 1, 16384), height: number(o.height, 1, 16384), imageBase64, mediaType: 'image/jpeg', elements: '', geometry: { x: number(g.x, -100000, 100000), y: number(g.y, -100000, 100000), width: number(g.width, 1, 100000), height: number(g.height, 1, 100000), scale: number(g.scale, .1, 16) } }
  if (!Number.isInteger(observation.width) || !Number.isInteger(observation.height)) throw Error('实时画面尺寸无效')
  if (o.aiCursor !== undefined) { const c = object(o.aiCursor); if (c.actor !== 'ai' || typeof c.visible !== 'boolean') throw Error('指针数据无效'); if (c.visible) observation.aiCursor = { actor: 'ai', visible: c.visible, x: number(c.x, 0, observation.width), y: number(c.y, 0, observation.height), ...(c.epoch === undefined ? {} : { epoch: number(c.epoch, 1, Number.MAX_SAFE_INTEGER) }) } }
  return { target, observation, viewOnly: v.viewOnly }
}
export function createWorkbenchAPI(connection: () => WorkbenchConnection | undefined) {
  const call = async (payload: Record<string, unknown>, signal: AbortSignal) => { signal.throwIfAborted(); const peer = connection(); if (!peer) throw Error('连接尚未就绪'); const result = await peer.rpc.call('/api', WORKBENCH_ENDPOINT, payload, signal); signal.throwIfAborted(); if (connection() !== peer) throw Error('工作台连接已变化'); if (!result.ok) throw new ComputerError(result.error?.code ?? 'WORKBENCH_UNAVAILABLE', result.error?.message || '工作台操作未能确认，请刷新查看，不要重复提交。'); return result.value }
  const scope = (target: WorkbenchTarget) => ({ chatSessionId: target.chatSessionId, environmentId: target.environmentId, workbenchTabId: target.workbenchTabId })
  return {
    async status(chat: string, signal: AbortSignal) { return parseWorkbenchStatus(await call({ op: 'status', chatSessionId: requireIdentity(chat) }, signal), chat) },
    async permissions(signal: AbortSignal) { return list(object(await call({ op: 'permissions' }, signal)).allowedOrigins, 128, siteOrigin) },
    async decide(request: SiteRequest, decision: SiteDecision, signal: AbortSignal) { return call({ op: 'decide', chatSessionId: request.chatSessionId, requestId: request.requestId, requestVersion: request.requestVersion, decision }, signal) },
    async revoke(origin: string, signal: AbortSignal) { return call({ op: 'revoke', origin: siteOrigin(origin) }, signal) },
    async preview(target: WorkbenchTarget, signal: AbortSignal) { return parseWorkbenchFrame(await call({ op: 'preview', ...scope(target) }, signal), target) },
    async control(target: WorkbenchTarget, operation: 'pause' | 'takeover' | 'resume' | 'stop', signal: AbortSignal) { return call({ op: 'control', ...scope(target), operation }, signal) },
    async humanAct(target: WorkbenchTarget, frameId: string, action: ComputerAction, signal: AbortSignal) { return call({ op: 'humanAct', ...scope(target), actionId: crypto.randomUUID(), frameId: requireIdentity(frameId), action: parseComputerAction(action) }, signal) },
    async navigation(target: WorkbenchTarget, signal: AbortSignal) { const v = object(await call({ op: 'navigation', ...scope(target) }, signal)); if (typeof v.canGoBack !== 'boolean' || typeof v.canGoForward !== 'boolean') throw Error('网页历史不可用'); return { canGoBack: v.canGoBack, canGoForward: v.canGoForward, ...(v.url === undefined ? {} : { url: text(v.url, 8192) }) } },
    async open(chat: string, url: string, browser: 'chrome' | 'edge', decision: 'once' | 'always', signal: AbortSignal) { return parseWorkbenchTarget(await call({ op: 'open', chatSessionId: requireIdentity(chat), actionId: crypto.randomUUID(), url, browser, decision }, signal), chat) },
    async closeEnvironment(chat: string, environmentId: string, signal: AbortSignal) { return call({ op: 'closeEnvironment', chatSessionId: requireIdentity(chat), environmentId: uuid(environmentId) }, signal) },
  }
}
export type WorkbenchAPI = ReturnType<typeof createWorkbenchAPI>
