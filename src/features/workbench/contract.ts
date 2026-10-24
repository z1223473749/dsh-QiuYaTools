import { ComputerError, requireIdentity } from '../computer-use/contract.ts'

/** View identity is never a device target or a grant. All ids are minted by Host. */
export type WorkbenchKind = 'browser' | 'desktop' | 'run' | 'report'
export interface WorkbenchTarget {
  chatSessionId: string; environmentId: string; workbenchTabId: string
  kind: 'browser' | 'desktop'; targetId: string; appId: string; epoch: number
  title: string; origin?: string; state: string
}
export interface SiteRequest {
  requestId: string; requestVersion: 1; chatSessionId: string; browser: 'chrome' | 'edge'
  origin: string; reason: string; createdAt: number; expiresAt: number; state: 'pending'
}
export type SiteDecision = 'once' | 'always' | 'deny'
export function website(value: unknown): { url: string; origin: string } {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f]/u.test(value)) throw new ComputerError('INVALID_SITE', '请输入完整的 HTTP 或 HTTPS 网站地址。')
  let url: URL
  try { url = new URL(value) } catch { throw new ComputerError('INVALID_SITE', '网站地址无效。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === 'null') throw new ComputerError('INVALID_SITE', '网站地址不能包含账号、密码或其他协议。')
  return { url: url.href, origin: url.origin }
}
export function siteOrigin(value: unknown): string {
  const parsed = website(value)
  if (parsed.url !== parsed.origin + '/' && parsed.url !== parsed.origin) throw new ComputerError('INVALID_SITE', '网站许可必须是完整来源，不能包含路径、查询或片段。')
  return parsed.origin
}
export function workbenchAddress(chat: string, tabId: string): string {
  return 'dsh-resource://qiuya-workbench/' + encodeURIComponent(requireIdentity(chat, '聊天')) + '/' + uuid(tabId)
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) throw new ComputerError('INVALID_VIEW', '工作台视图已失效。')
  return value
}
export function parseWorkbenchAddress(address: string): { chatSessionId: string; workbenchTabId: string } | null {
  try { const u = new URL(address), parts = u.pathname.split('/'); if (u.protocol !== 'dsh-resource:' || u.hostname !== 'qiuya-workbench' || u.username || u.password || u.port || u.search || u.hash || parts.length !== 3) return null
    const chatSessionId = requireIdentity(decodeURIComponent(parts[1]!), '聊天'), workbenchTabId = uuid(parts[2]); if (address !== workbenchAddress(chatSessionId, workbenchTabId)) return null
    return { chatSessionId, workbenchTabId }
  } catch { return null }
}
