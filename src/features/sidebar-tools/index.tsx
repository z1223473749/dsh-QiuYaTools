import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { copySidebarText, SIDEBAR_UNREAD_KEY, SidebarUnreadStore, SidebarDirectoryError, validSidebarId, type SidebarSession, type SidebarWorkspace, type Source } from './model.ts'
import { installWorkspaceMenuTools } from './workspace-menu.ts'
import { installNativeSidebarContextMenu } from './native-menu.ts'

interface SessionSnapshot { phase: string; ids: readonly string[]; byId: Readonly<Record<string, SidebarSession>> }
interface WorkspaceSnapshot { phase: string; items: readonly SidebarWorkspace[]; archivedSessionIds: readonly string[] }
export interface SidebarToolsServices {
  slots: { inject(key: string, register: () => (() => void)): () => void; register<Props extends object>(options: object, component: React.FunctionComponent<Props>): () => void }
  sessions: { list: Source<SessionSnapshot> }
  workspaces: { list: Source<WorkspaceSnapshot>; insertBefore(id: string, before?: string): Promise<void> }
  uiSession: { adapter: { current: Source<{ key?: string }> } }
}

type SessionAction = 'unread' | 'title' | 'copy-directory' | 'open-directory'
interface SessionMenuProps { sessionId: string; displayTitle: string; useMenuOpenState(): readonly [boolean, (open: boolean) => void]; actions: SidebarToolsActions; kind: SessionAction }
export interface SidebarToolsActions {
  unread: SidebarUnreadStore
  sessions: Source<SessionSnapshot>
  available(id: string): boolean
  perform(kind: SessionAction, id: string): Promise<void>
  copyPath(id: string): Promise<void>
  openDirectory(id: string): Promise<void>
  moveToTop(id: string): Promise<void>
  dispose(): void
}

/** Commands resolve the latest Host catalog at click time, never translated DOM labels. */
export function createSidebarToolsActions(services: SidebarToolsServices, target: Window, unread: SidebarUnreadStore): SidebarToolsActions {
  let disposed = false
  const lifetime = new AbortController()
  let fileManager: Promise<string> | undefined
  const requireSession = (id: string): SidebarSession => {
    const snapshot = services.sessions.list.getSnapshot()
    const session = snapshot.byId[id]
    if (disposed || snapshot.phase !== 'ready' || !snapshot.ids.includes(id) || !session || session.blank || session.origin === 'subagent' || !validSidebarId(id)) throw new Error('会话暂不可用')
    return session
  }
  const requireWorkspace = (id: string): SidebarWorkspace => {
    const snapshot = services.workspaces.list.getSnapshot()
    const item = snapshot.items.find(row => row.workspaceId === id)
    if (disposed || snapshot.phase !== 'ready' || !item) throw new Error('工作区暂不可用')
    return item
  }
  const openPath = async (path: string | undefined): Promise<void> => {
    if (disposed || !path?.trim()) throw new Error('没有可打开的目录')
    try {
      // Match Harness's Session-header Finder button. Its directory launcher
      // uses document-relative authenticated HTTP routes; the separate Session
      // file-preview RPC requires a composed filesystem mapping and can refuse
      // an otherwise valid native Workspace path.
      fileManager ??= (async () => {
        const response = await target.fetch('open-in-app/apps', { headers: { accept: 'application/json' }, credentials: 'same-origin', signal: lifetime.signal })
        if (response.status === 401 || response.status === 403) throw new SidebarDirectoryError('authentication')
        if (!response.ok) throw new SidebarDirectoryError('unavailable')
        const payload: unknown = await response.json()
        const apps = payload && typeof payload === 'object' && 'apps' in payload && Array.isArray(payload.apps) ? payload.apps : []
        const app = ['finder', 'explorer', 'filemanager'].find(id => apps.includes(id))
        if (!app) throw new SidebarDirectoryError('unavailable')
        return app
      })().catch(error => { fileManager = undefined; throw error })
      const app = await fileManager
      lifetime.signal.throwIfAborted()
      const response = await target.fetch('open-in-app/open', {
        method: 'POST', credentials: 'same-origin', signal: lifetime.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app, path }),
      })
      if (response.status === 401 || response.status === 403) throw new SidebarDirectoryError('authentication')
      if (response.status === 404) throw new SidebarDirectoryError('directory')
      if (!response.ok) throw new SidebarDirectoryError('launcher')
    } catch (error) {
      if (error instanceof SidebarDirectoryError || lifetime.signal.aborted) throw error
      throw new SidebarDirectoryError('transport')
    }
  }
  return {
    unread,
    sessions: services.sessions.list,
    available(id) { try { requireSession(id); return true } catch { return false } },
    async perform(kind, id) {
      const session = requireSession(id)
      if (kind === 'unread') { unread.set(id, !unread.getSnapshot().has(id)); return }
      if (kind === 'open-directory') { await openPath(session.cwd); return }
      const value = kind === 'title' ? session.displayTitle : session.cwd
      if (!value) throw new Error('没有可复制的内容')
      await copySidebarText(value, target)
    },
    async copyPath(id) { await copySidebarText(requireWorkspace(id).path, target) },
    async openDirectory(id) { await openPath(requireWorkspace(id).path) },
    async moveToTop(id) {
      requireWorkspace(id)
      const first = services.workspaces.list.getSnapshot().items[0]
      if (first && first.workspaceId !== id) await services.workspaces.insertBefore(id, first.workspaceId)
    },
    dispose() { if (disposed) return; disposed = true; lifetime.abort() },
  }
}

function ActionIcon({ kind }: { kind: SessionAction }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'unread'
    ? <><rect x="2" y="3" width="12" height="10" rx="2" /><path d="m3 4 5 4 5-4" /></>
    : kind.includes('directory') ? <path d="M2 5a2 2 0 0 1 2-2h3l2 2h3a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
        : <><rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M10 3H4a1 1 0 0 0-1 1v6" /></>}</svg>
}

function SessionToolItem({ sessionId, useMenuOpenState, actions, kind }: SessionMenuProps) {
  const [, close] = useMenuOpenState()
  const marked = useSyncExternalStore(actions.unread.subscribe, actions.unread.getSnapshot, actions.unread.getSnapshot).has(sessionId)
  const snapshot = useSyncExternalStore(actions.sessions.subscribe, actions.sessions.getSnapshot, actions.sessions.getSnapshot)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<string>()
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const label = kind === 'unread' ? marked ? '标记为已读' : '标记为未读'
    : kind === 'title' ? '复制会话标题'
      : kind === 'copy-directory' ? '复制会话工作目录' : '打开会话工作目录'
  const cwd = snapshot.byId[sessionId]?.cwd
  const unavailable = !actions.available(sessionId) || kind.includes('directory') && !cwd
  return <MenuItemButton icon={<ActionIcon kind={kind} />} separatorBefore={kind === 'unread'} disabled={pending || unavailable} onSelect={() => {
    if (pending || unavailable) return
    setPending(true); setFailed(undefined)
    void actions.perform(kind, sessionId).then(() => { if (mounted.current) close(false) }).catch(error => {
      if (mounted.current) { setPending(false); setFailed(error instanceof SidebarDirectoryError ? error.message : '失败，请重试') }
    })
  }}><span title={failed ?? (kind === 'unread' ? '手动未读标记；再次进入会话时自动清除。' : undefined)}>{label}{pending ? '…' : failed ? `（${failed}）` : ''}</span></MenuItemButton>
}

function UnreadIndicator({ sessionId, unread }: { sessionId: string; unread: SidebarUnreadStore }) {
  const marked = useSyncExternalStore(unread.subscribe, unread.getSnapshot, unread.getSnapshot).has(sessionId)
  return marked ? <span data-qyt-manual-unread="true" role="img" aria-label="手动标记未读" title="手动标记未读" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-state-business-primary, #177e93)', display: 'inline-block' }} /> : null
}

/** Public slots own Session rows; the Workspace fallback augments only its native menu. */
export function installSidebarTools(ctx: Context, target: Window = window): () => void {
  const fiber = ctx.inject(['slots', 'sessions', 'workspaces', 'uiSession'], scope => {
    const services = scope as unknown as SidebarToolsServices
    scope.effect(() => {
      let storage: Storage | undefined
      try { storage = target.localStorage } catch { /* Private browser policy: use memory markers. */ }
      const unread = new SidebarUnreadStore(storage)
      const actions = createSidebarToolsActions(services, target, unread)
      const disposers: (() => void)[] = []
      try {
        // Native pin / rename / fork / archive / copy-ID entries remain the
        // sole owners of their actions and Host ordering semantics.
        for (const [index, kind] of (['unread', 'title', 'copy-directory', 'open-directory'] as const).entries()) disposers.push(services.slots.inject('sidebar.workspaces.session.menu.item', () => services.slots.register({
          name: 'sidebar.workspaces.session.menu.item', id: `qiuya-tools/sidebar/${kind}`, order: 500 + index * 10, inject: () => ({ actions, kind }),
        }, SessionToolItem)))
        disposers.push(services.slots.inject('sidebar.session.row.leading', () => services.slots.register({ name: 'sidebar.session.row.leading', id: 'qiuya-tools/manual-unread', order: 50, inject: () => ({ unread }) }, UnreadIndicator)))
        const select = (): void => unread.select(services.uiSession.adapter.current.getSnapshot().key)
        select()
        disposers.push(services.uiSession.adapter.current.subscribe(select))
        const storageChanged = (event: StorageEvent): void => { if (event.key === SIDEBAR_UNREAD_KEY && (!event.storageArea || event.storageArea === storage)) unread.acceptStorage(event.newValue) }
        target.addEventListener('storage', storageChanged)
        disposers.push(() => target.removeEventListener('storage', storageChanged))
        disposers.push(installWorkspaceMenuTools({ workspaces: services.workspaces.list, copyPath: actions.copyPath, openDirectory: actions.openDirectory, moveToTop: actions.moveToTop }, target))
        disposers.push(installNativeSidebarContextMenu(target, rowKey => {
          if (rowKey.startsWith('session:')) return actions.available(rowKey.slice('session:'.length))
          const workspaces = services.workspaces.list.getSnapshot()
          return workspaces.phase === 'ready' && rowKey.startsWith('workspace:') && workspaces.items.some(item => rowKey === `workspace:${item.workspaceId}`)
        }))
      } catch (cause) { for (const dispose of disposers.reverse()) dispose(); actions.dispose(); unread.dispose(); throw cause }
      return () => { for (const dispose of disposers.reverse()) dispose(); actions.dispose(); unread.dispose() }
    })
  })
  return () => { void fiber.dispose() }
}
