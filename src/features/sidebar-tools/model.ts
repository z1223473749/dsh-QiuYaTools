/** Plugin-owned markers are separate from Harness's automatic completion reminders. */
export const SIDEBAR_UNREAD_KEY = 'qiuya-tools:sidebar-unread:v1'

export interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export interface SidebarSession { id: string; displayTitle: string; cwd?: string; blank?: boolean; origin?: string }
export interface SidebarWorkspace { workspaceId: string; title: string; path: string }

/** Only finite, plugin-owned explanations reach the menu; never raw Host errors or paths. */
export class SidebarDirectoryError extends Error {
  constructor(readonly reason: 'unavailable' | 'authentication' | 'directory' | 'launcher' | 'transport') {
    const messages = { unavailable: '当前主机没有可用的文件管理器', authentication: '连接已失效，请重新打开 Harness', directory: '目录不存在或无权访问', launcher: '文件管理器启动失败，请重试', transport: '目录服务暂时无法连接，请重试' }
    super(messages[reason])
  }
}

export function validSidebarId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/u.test(value)
}

export function parseUnread(value: string | null): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.slice(0, 10_000).filter(validSidebarId) : [])
  } catch { return new Set() }
}

/** Origin-bound browser storage; no titles, paths, credentials, or message contents are saved. */
export class SidebarUnreadStore implements Source<ReadonlySet<string>> {
  private snapshot: ReadonlySet<string>
  private listeners = new Set<() => void>()
  private disposed = false
  private storageFailed = false
  private selected: string | undefined

  constructor(private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    this.snapshot = this.read() ?? new Set()
  }

  getSnapshot = (): ReadonlySet<string> => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private read(): ReadonlySet<string> | undefined {
    try { return this.storage && !this.storageFailed ? parseUnread(this.storage.getItem(SIDEBAR_UNREAD_KEY)) : undefined }
    catch { return undefined }
  }
  private publish(next: ReadonlySet<string>): void {
    if (this.disposed || next.size === this.snapshot.size && [...next].every(id => this.snapshot.has(id))) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
  /** Storage events synchronize the plugin's own marker across same-origin windows. */
  acceptStorage(value: string | null): void { this.publish(parseUnread(value)) }
  set(id: string, unread: boolean): void {
    if (this.disposed || !validSidebarId(id)) return
    const next = new Set(this.read() ?? this.snapshot)
    if (unread) next.add(id)
    else next.delete(id)
    try { this.storage?.setItem(SIDEBAR_UNREAD_KEY, JSON.stringify([...next])) } catch { this.storageFailed = true }
    this.publish(next)
  }
  /** Marking the currently visible Session unread persists until a later explicit revisit. */
  select(id: string | undefined): void {
    if (this.disposed || id === this.selected) return
    this.selected = id
    if (id && this.snapshot.has(id)) this.set(id, false)
  }
  dispose(): void { this.disposed = true; this.listeners.clear() }
}

export async function copySidebarText(value: string, target: Window): Promise<void> {
  try {
    if (target.navigator.clipboard?.writeText) { await target.navigator.clipboard.writeText(value); return }
  } catch { /* Fall back only inside this explicit menu gesture. */ }
  const doc = target.document
  const active = doc.activeElement as HTMLElement | null
  const selection = doc.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []
  const textarea = doc.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;pointer-events:none'
  doc.body.append(textarea)
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    if (!doc.execCommand?.('copy')) throw new Error('复制失败，请重试')
  } finally {
    textarea.remove()
    active?.focus({ preventScroll: true })
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range) }
  }
}
