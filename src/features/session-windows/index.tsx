import React, { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionGeneration } from '@deepseek-ai/dsh-client-connection/client'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { SESSION_WINDOW_CHANNEL, SESSION_WINDOW_STATUS_ENDPOINT, SESSION_WINDOW_OPEN_ENDPOINT, SESSION_WINDOW_QUERY, SESSION_WINDOW_MENU, validSessionId, isExternalSessionDrop, type SessionWindowRequest, type SessionWindowStatus } from './contract.ts'

interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface Summary { id: string; displayTitle?: string; blank?: boolean; retainedBy?: Readonly<Record<string, number>> }
interface WindowSessionSnapshot { sessionId: string; openState: string; removed: boolean; blank: boolean }
interface WindowNavigationServices {
  uiSession: { adapter: { current: Source<{ key: string | undefined }> } }
  layout: { panelInfo: Source<{ activePanelId: string | null }>; beginNavigation(): AbortSignal; selectPanel(id: null): void }
  sidebarRight: { mounted: Source<string | undefined> }
}
interface Actions { canOpen(id: string): boolean; reason(id: string): string | undefined; prepare(id: string): void; cancel(id: string): void; open(id: string, source: 'menu' | 'drag', event?: DragEvent): void; status: Source<SessionWindowStatus> }
interface MenuProps { sessionId: string; useMenuOpenState(): readonly [boolean, (open: boolean) => void]; actions: Actions; label: string }
interface Services {
  slots: { inject(key: string, register: () => (() => void)): () => void; register(options: object, component: React.FunctionComponent<MenuProps>): () => void }
  sessions: {
    list: Source<{ phase: string; byId: Record<string, Summary> }>
    refresh?(): Promise<void>
    binding?(id: string): { session: Source<WindowSessionSnapshot> } | undefined
  }
  workspaces: { list: Source<{ phase: string; archivedSessionIds: readonly string[] }> }
  uiWorkspace: { openSession(id: string): void }
  locale: { getSnapshot(): { active: string } }
  connection: { generation?: Source<ConnectionGeneration | undefined>; rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }> } }
}
declare global {
  interface Window {
    __QIUYA_SESSION_WINDOW__?: string
    webkit?: { messageHandlers?: { qiuyaSession?: { postMessage(value: object): void } } }
  }
}

/** Safe, finite diagnostics: never expose URLs, headers, credentials, or arbitrary exception text. */
export function sessionWindowTransportReason(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const status = /HTTP (\d{3})\b/u.exec(message)?.[1]
  if (status) return `host-http-${status}`
  if (/invalid RPC target/u.test(message)) return 'invalid-rpc-target'
  return 'host-transport'
}
function sessionWindowReasonText(reason: string): string {
  if (reason.startsWith('host-http-')) return `窗口服务 HTTP ${reason.slice('host-http-'.length)}`
  const known: Record<string, string> = { loading: '正在连接', platform: '当前系统暂不支持', 'helper-missing': '缺少窗口组件', 'reader-missing': '会话读取服务未就绪', 'host-transport': '窗口服务连接失败', 'host-rejected': '窗口服务拒绝请求', 'host': '窗口服务未就绪', 'invalid-rpc-target': '窗口通信地址无效', 'session-missing': '会话尚未同步', 'session-blank': '空会话暂不可用', 'session-archived': '会话已归档', 'selection-multiple': '请先取消多选' }
  if (reason.startsWith('sessions-')) return `会话列表 ${reason.slice('sessions-'.length)}`
  if (reason.startsWith('workspaces-')) return `工作区 ${reason.slice('workspaces-'.length)}`
  return known[reason] ?? '窗口暂不可用'
}

function OpenWindowItem({ sessionId, useMenuOpenState, actions, label }: MenuProps) {
  const [, setOpen] = useMenuOpenState()
  const state = useSyncExternalStore(actions.status.subscribe, actions.status.getSnapshot, actions.status.getSnapshot)
  const reason = state.available ? actions.reason(sessionId) : state.reason
  const suffix = reason ? sessionWindowReasonText(reason) : ''
  return <MenuItemButton disabled={!state.available || !actions.canOpen(sessionId)} icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor"/><path d="M2 6h12M5 4.5h.01M7 4.5h.01" stroke="currentColor" strokeLinecap="round"/></svg>} onSelect={() => { setOpen(false); actions.open(sessionId, 'menu') }}><span title={reason}>{label}{suffix ? `（${suffix}）` : ''}</span></MenuItemButton>
}

/** DOM adapter is limited to the upstream Session row identity; ordinary reordering stays upstream-owned. */
export function installSessionWindowDrag(target: Window, options: { canOpen(id: string): boolean; prepare?(id: string): void; cancel?(id: string): void; open(id: string, source: 'drag', event: DragEvent): void }): () => void {
  type Drag = { id: string; row: Element; cancelled: boolean; dropped: boolean; detached: boolean }
  let drag: Drag | undefined
  let resetting = false
  const constructors = target as Window & typeof globalThis
  const rowFor = (event: Event): Element | null => event.target instanceof constructors.Element ? event.target.closest('[data-row-key^="session:"]') : null
  const outsideTree = (event: Event): boolean => event.target instanceof constructors.Element && !event.target.closest('[role="tree"], [class*="_sidebarCol"], .dshDesktopSidebarSurface, [data-shell-leading]')
  const start = (event: DragEvent): void => {
    if (resetting) return
    const row = rowFor(event)
    const id = row?.getAttribute('data-row-key')?.slice('session:'.length)
    if (!row || !validSessionId(id) || !options.canOpen(id) || target.document.querySelector('[data-qyt-bulk-selected="true"]') !== null) return
    if (drag && !drag.detached) options.cancel?.(drag.id)
    drag = { id, row, cancelled: false, dropped: false, detached: false }
    options.prepare?.(id)
  }
  const key = (event: KeyboardEvent): void => { if (event.key === 'Escape' && drag) drag.cancelled = true }
  const over = (event: DragEvent): void => {
    if (resetting || !drag || drag.cancelled || !options.canOpen(drag.id) || !outsideTree(event)) return
    event.preventDefault(); event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  }
  const drop = (event: DragEvent): void => {
    if (!drag) return
    drag.dropped = true
    if (drag.cancelled || !options.canOpen(drag.id) || !outsideTree(event)) return
    event.preventDefault(); event.stopPropagation()
    drag.detached = true
    options.open(drag.id, 'drag', event)
  }
  const end = (event: DragEvent): void => {
    const state = drag; drag = undefined
    if (!state) return
    const external = isExternalSessionDrop(event, state, { width: target.innerWidth, height: target.innerHeight })
    if (external && options.canOpen(state.id)) { state.detached = true; options.open(state.id, 'drag', event) }
    if (!state.detached) options.cancel?.(state.id)
    // Upstream commits its last-hover fallback even on a cancelled/outside drag.
    // Its discrete dragstart resets that private hover state; replay it once
    // synchronously, then let the real dragend clean up. A continuous dragover
    // cannot be flushed synchronously through React's native event dispatcher.
    if ((external || state.detached || state.cancelled || (!state.dropped && event.dataTransfer?.dropEffect === 'none')) && state.row.isConnected) {
      const rect = state.row.getBoundingClientRect()
      resetting = true
      try {
        flushSync(() => state.row.dispatchEvent(new constructors.DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: event.dataTransfer, clientX: rect.left + 1, clientY: rect.top + rect.height / 2 })))
      } finally { resetting = false }
    }
  }
  // Capture dragend before React dispatches to the row; dragstart runs after the upstream handler.
  target.document.addEventListener('dragstart', start)
  target.document.addEventListener('keydown', key, true)
  target.document.addEventListener('dragover', over, true)
  target.document.addEventListener('drop', drop, true)
  target.document.addEventListener('dragend', end, true)
  return () => {
    if (drag && !drag.detached) options.cancel?.(drag.id)
    drag = undefined
    target.document.removeEventListener('dragstart', start)
    target.document.removeEventListener('keydown', key, true)
    target.document.removeEventListener('dragover', over, true)
    target.document.removeEventListener('drop', drop, true)
    target.document.removeEventListener('dragend', end, true)
  }
}

/** Install into one Client fiber. The returned disposer withdraws menu, gestures, and child navigation. */
export function installSessionWindows(ctx: Context): () => void {
  const fiber = ctx.inject(['slots', 'sessions', 'workspaces', 'uiWorkspace', 'uiSession', 'layout', 'sidebarRight', 'locale', 'connection'], scope => {
    const services = scope as unknown as Services
    const targetId = window.__QIUYA_SESSION_WINDOW__ || new URL(window.location.href).searchParams.get(SESSION_WINDOW_QUERY)
    const availabilityReason = (id: string): string | undefined => {
      const list = services.sessions.list.getSnapshot()
      const workspaces = services.workspaces.list.getSnapshot()
      if (list.phase !== 'ready') return `sessions-${list.phase}`
      if (workspaces.phase !== 'ready') return `workspaces-${workspaces.phase}`
      const summary = Object.values(list.byId).find(item => item.id === id)
      if (!validSessionId(id) || !summary) return 'session-missing'
      if (summary.blank) return 'session-blank'
      if (workspaces.archivedSessionIds.includes(id)) return 'session-archived'
      return undefined
    }
    const available = (id: string): boolean => availabilityReason(id) === undefined
    if (targetId && validSessionId(targetId)) {
      scope.effect(() => installWindowNavigation(services as Services & WindowNavigationServices, targetId))
      return
    }
    scope.effect(() => {
      let disposed = false
      let state: SessionWindowStatus = { available: false, reason: 'loading' }
      const listeners = new Set<() => void>()
      let notice: HTMLDivElement | undefined
      let noticeTimer: ReturnType<typeof setTimeout> | undefined
      let statusTimer: ReturnType<typeof setTimeout> | undefined
      let statusAttempts = 0
      // Preserve gesture order across asynchronous Host validation. In
      // particular, cancel must follow the receipt of its own preparation.
      let dragOperations: Promise<unknown> = Promise.resolve()
      const dragRequest = (request: SessionWindowRequest) => {
        const result = dragOperations.then(() => services.connection.rpc.call(SESSION_WINDOW_CHANNEL, SESSION_WINDOW_OPEN_ENDPOINT, request))
        dragOperations = result.catch(() => undefined)
        return result
      }
      const showError = (message: string): void => {
        notice?.remove()
        notice = document.createElement('div')
        notice.dataset.qytSessionWindowNotice = 'true'; notice.setAttribute('role', 'alert')
        notice.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:100000;max-width:80vw;padding:12px 18px;border-radius:10px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-text-primary,#111);box-shadow:0 4px 24px #0003;border:1px solid #8885;white-space:pre-wrap;'
        notice.textContent = message
        document.body.append(notice)
        clearTimeout(noticeTimer)
        noticeTimer = setTimeout(() => { notice?.remove(); notice = undefined }, 8000)
      }
      const actions: Actions = {
        canOpen: id => state.available && actions.reason(id) === undefined,
        reason: id => document.querySelectorAll('[data-qyt-bulk-selected="true"]').length > 1 ? 'selection-multiple' : availabilityReason(id),
        status: { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } },
        prepare: id => {
          if (disposed || !available(id)) return
          void dragRequest({ sessionId: id, source: 'drag', action: 'prepare' }).catch(() => {})
        },
        cancel: id => {
          // Cleanup remains valid after the feature was disabled or a row
          // disappeared; the Host never starts a helper for cancellation.
          void dragRequest({ sessionId: id, source: 'drag', action: 'cancel' }).catch(() => {})
        },
        open: (id, source, event) => {
          if (!available(id)) return
          const request: SessionWindowRequest = { sessionId: id, source, ...(event ? { position: { x: event.screenX, y: event.screenY } } : {}) }
          const pending = source === 'drag' ? dragRequest(request) : services.connection.rpc.call(SESSION_WINDOW_CHANNEL, SESSION_WINDOW_OPEN_ENDPOINT, request)
          void pending.then(result => {
            if (!result.ok && !disposed) showError(result.error.message)
          }).catch(() => { if (!disposed) showError('无法打开会话窗口，请重试。') })
        },
      }
      const statusFailed = (reason = 'host'): void => {
        if (disposed) return
        state = { available: false, reason }
        for (const listener of listeners) listener()
        // Host contributions and the renderer can activate concurrently. Retry
        // a short startup race; an unavailable native component is definitive.
        if (statusAttempts < 4) statusTimer = setTimeout(refreshStatus, statusAttempts * 500)
      }
      const refreshStatus = (): void => {
        statusAttempts++
        void services.connection.rpc.call(SESSION_WINDOW_CHANNEL, SESSION_WINDOW_STATUS_ENDPOINT, {}).then(result => {
          if (disposed) return
          if (!result.ok) { statusFailed('host-rejected'); return }
          const value = result.value as Partial<SessionWindowStatus> | null
          if (!value || typeof value.available !== 'boolean') { statusFailed(); return }
          state = { available: value.available, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) }
          for (const listener of listeners) listener()
        }).catch(error => statusFailed(sessionWindowTransportReason(error)))
      }
      refreshStatus()
      const offMenu = services.slots.inject('sidebar.workspaces.session.menu.item', () => services.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: SESSION_WINDOW_MENU, order: 50, inject: () => ({ actions, label: services.locale.getSnapshot().active.startsWith('zh') ? '新窗口打开' : 'Open in new window' }) }, OpenWindowItem))
      const offDrag = installSessionWindowDrag(window, actions)
      return () => { disposed = true; offMenu(); offDrag(); notice?.remove(); clearTimeout(noticeTimer); clearTimeout(statusTimer); listeners.clear() }
    })
  })
  return () => { void fiber.dispose() }
}

const SESSION_LOADING_CSS = `
body[data-qyt-session-window]:not([data-qyt-session-window-state="ready"]) #root{visibility:hidden!important;pointer-events:none!important}
body[data-qyt-session-window] :is([data-qyt-session-navigation],[data-qyt-session-window-bootstrap]){display:grid;place-items:center;position:fixed;inset:0;z-index:99999;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111)}
body[data-qyt-session-window] :is([data-qyt-session-navigation],[data-qyt-session-window-bootstrap])[hidden]{display:none!important}
.qyt-window-loading-card{width:min(380px,calc(100vw - 64px));display:flex;flex-direction:column;gap:32px}
.qyt-window-loading-brand{display:flex;align-items:center;justify-content:center;gap:10px;font:600 25px/1.2 system-ui,sans-serif;letter-spacing:-.7px}
.qyt-window-loading-brand img{width:34px;height:34px;object-fit:contain}
.qyt-window-loading-brand small{font:500 9px/1.1 system-ui,sans-serif;letter-spacing:1px;border:1px solid currentColor;border-radius:3px;padding:3px 5px;margin-left:1px;opacity:.7}
.qyt-window-loading-skeleton{display:flex;flex-direction:column;gap:12px;opacity:.75}
.qyt-window-loading-skeleton i{height:11px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#edf0f4);position:relative;overflow:hidden}
.qyt-window-loading-skeleton i:first-child{width:52%;height:15px;margin-bottom:7px}
.qyt-window-loading-skeleton i:last-child{width:71%}
.qyt-window-loading-skeleton i:after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,transparent,rgba(130,140,160,.10),transparent);transform:translateX(-100%);animation:qyt-window-shimmer 1.6s ease-in-out infinite}
[data-qyt-session-navigation-message]{font:400 13px/1.6 system-ui,sans-serif;color:var(--dsw-alias-label-tertiary,#7e8590);text-align:center;margin:0}
[data-qyt-session-navigation][data-state="unavailable"] .qyt-window-loading-skeleton{display:none}
@keyframes qyt-window-shimmer{to{transform:translateX(100%)}}
@media(prefers-reduced-motion:reduce){.qyt-window-loading-skeleton i:after{animation:none}}
`

function sessionLoadingNotice(doc: Document, message: string): HTMLDivElement {
  const notice = doc.createElement('div')
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  const card = doc.createElement('div')
  card.className = 'qyt-window-loading-card'
  const brand = doc.createElement('div')
  brand.className = 'qyt-window-loading-brand'
  brand.setAttribute('aria-hidden', 'true')
  const icon = doc.createElement('img')
  icon.src = '/favicon.svg'
  icon.alt = ''
  const name = doc.createElement('span')
  name.textContent = 'deepseek'
  const badge = doc.createElement('small')
  badge.textContent = 'HARNESS'
  brand.append(icon, name, badge)
  const skeleton = doc.createElement('div')
  skeleton.className = 'qyt-window-loading-skeleton'
  skeleton.setAttribute('aria-hidden', 'true')
  for (let line = 0; line < 4; line++) skeleton.append(doc.createElement('i'))
  const text = doc.createElement('p')
  text.dataset.qytSessionNavigationMessage = 'true'
  text.textContent = message
  card.append(brand, skeleton, text)
  notice.append(card)
  return notice
}

/**
 * A native child already names a Host-authorized Session. Begin its local
 * retention before the asynchronous settings mirror and full guard are ready.
 * This bootstrap never acknowledges success; installWindowNavigation does.
 */
export function installEarlySessionWindowNavigation(ctx: Context, target: Window = window): () => void {
  const targetId = target.__QIUYA_SESSION_WINDOW__
  if (!validSessionId(targetId)) return () => {}
  const doc = target.document
  const style = doc.createElement('style')
  style.dataset.qytSessionWindowBootstrap = 'true'
  style.textContent = SESSION_LOADING_CSS
  const notice = sessionLoadingNotice(doc, target.navigator.language.toLowerCase().startsWith('zh') ? '正在打开会话…' : 'Opening the conversation…')
  notice.dataset.qytSessionWindowBootstrap = 'true'
  doc.head.append(style)
  doc.body.dataset.qytSessionWindow = targetId
  doc.body.dataset.qytSessionWindowState = 'loading'
  doc.body.append(notice)
  const fiber = ctx.inject(['sessions', 'uiWorkspace', 'layout'], scope => {
    const early = scope as unknown as Pick<Services, 'uiWorkspace' | 'sessions'> & Pick<WindowNavigationServices, 'layout'>
    let started = false
    let disposed = false
    let offList: (() => void) | undefined
    const begin = (): void => {
      if (disposed || started) return
      // uiWorkspace owns a Session Controller. Wait only for this identity to
      // be known, never for unrelated configuration, resources, or sidebar UI.
      const summary = early.sessions.list.getSnapshot().byId[targetId]
      if (summary === undefined || summary.id !== targetId || summary.blank) return
      started = true
      try {
        early.layout.beginNavigation()
        early.uiWorkspace.openSession(targetId)
        offList?.()
      } catch { started = false /* The full guard reports a definitive opening failure. */ }
    }
    scope.effect(() => {
      offList = early.sessions.list.subscribe(begin)
      begin()
      return () => { disposed = true; offList?.() }
    })
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    void fiber.dispose()
    style.remove()
    notice.remove()
    // The confirmed feature guard may have adopted this document meanwhile.
    if (!doc.querySelector('style[data-qyt-session-window="true"]')) {
      delete doc.body.dataset.qytSessionWindow
      delete doc.body.dataset.qytSessionWindowState
    }
  }
}

/** Pin this document's own UI selection; never rewrite shared browser storage. */
export function installWindowNavigation(services: Services & WindowNavigationServices, targetId: string, target: Window = window): () => void {
  const doc = target.document
  let disposed = false
  let queued = false
  let verified = false
  let frame: number | undefined
  let lastAttempt: string | undefined
  let lastAckTitle: string | undefined
  let lastFailure: string | undefined
  const catalogRetryDelays = [250, 500, 1000] as const
  let catalogRequest: object | undefined
  let catalogRetryTimer: number | undefined
  let catalogRetries = 0
  let catalogRecoveryStarted = false
  let catalogRecoveryEpoch = 0
  let catalogExhausted = false
  const catalogGeneration = services.connection?.generation
  let catalogGenerationId = catalogGeneration?.getSnapshot()?.id
  let sessionSource: Source<WindowSessionSnapshot> | undefined
  let offSession: (() => void) | undefined
  const style = doc.createElement('style')
  style.dataset.qytSessionWindow = 'true'
  style.textContent = SESSION_LOADING_CSS + `
body[data-qyt-session-window] #root{height:100%!important}
body[data-qyt-session-window] [class*="_frame"]:has(>[data-rightbar-col]){display:flex!important;height:100%!important;padding:0!important;border:0!important}
body[data-qyt-session-window] :is([data-shell-leading],[data-conversation-header-leading],[class*="_sidebarCol"]){display:none!important}
body[data-qyt-session-window] [class*="_centerCol"]{flex:1;min-width:0;border-radius:0!important}
body[data-qyt-session-window] [data-rightbar-col]{flex:0 0 45%;min-width:0}
body[data-qyt-session-window] [data-rightbar-collapsed]>[data-rightbar-col]{display:none!important}
body[data-qyt-session-window] [data-rightbar-fullscreen]>[data-rightbar-col]{flex:1}
body[data-qyt-session-window] [data-rightbar-fullscreen]>[class*="_centerCol"]{display:none!important}
body[data-qyt-session-window] [class*="_frame"]:has(>[data-rightbar-col])>[data-side]{display:none!important}
body[data-qyt-session-window] [data-shell-overlay]{position:absolute;inset:0;pointer-events:none}
body[data-qyt-session-window] [data-shell-overlay]>*{pointer-events:auto}
`
  doc.head.append(style)
  doc.body.dataset.qytSessionWindow = targetId
  const notice = sessionLoadingNotice(doc, '')
  notice.dataset.qytSessionNavigation = 'true'
  doc.body.append(notice)
  // Synchronous takeover of the early skeleton: never leave a second cover
  // in front of a now-verified Session or reveal the saved Session in between.
  for (const bootstrap of doc.querySelectorAll('[data-qyt-session-window-bootstrap]')) bootstrap.remove()
  const send = (type: string, title?: string, reason?: string): void => target.webkit?.messageHandlers?.qiuyaSession?.postMessage({ type, sessionId: targetId, ...(title === undefined ? {} : { title }), ...(reason === undefined ? {} : { reason }) })
  const conceal = (reason: string, failure = false): void => {
    // A restored verified view must refresh native state as well, including
    // its title after an unavailable notice. Confirmation still checks IDs.
    if (verified) lastAckTitle = undefined
    verified = false
    if (frame !== undefined) { target.cancelAnimationFrame(frame); frame = undefined }
    doc.body.dataset.qytSessionWindowState = failure ? 'unavailable' : 'loading'
    notice.hidden = false
    notice.dataset.reason = reason
    notice.dataset.state = failure ? 'unavailable' : 'loading'
    const zh = services.locale.getSnapshot().active.startsWith('zh')
    const text = failure
      ? zh ? '无法打开指定会话，请在主窗口中查看或重试。' : 'Could not open this session. Return to the main window or retry.'
      : zh ? '正在打开指定会话…' : 'Opening the requested session…'
    const message = notice.querySelector('[data-qyt-session-navigation-message]')
    if (message && message.textContent !== text) message.textContent = text
    if (failure && lastFailure !== reason) { lastFailure = reason; send('unavailable', undefined, reason) }
  }
  const mainContent = (): HTMLElement | undefined => {
    // An embedded sidebar conversation cannot prove which Session the main body draws.
    const main = doc.querySelector('[data-slot="main.conversation"]') ?? doc.querySelector('[data-slot="main"]')
    return main?.querySelector<HTMLElement>('[data-conversation-content]') ?? undefined
  }
  const targetConfirmed = (): boolean => {
    const list = services.sessions.list.getSnapshot()
    const workspaces = services.workspaces.list.getSnapshot()
    const summary = list.byId[targetId]
    const session = sessionSource?.getSnapshot()
    const content = mainContent()
    return list.phase === 'ready' && workspaces.phase === 'ready' && summary?.id === targetId && !summary.blank
      && !workspaces.archivedSessionIds.includes(targetId) && (summary.retainedBy?.mainView ?? 0) > 0
      && services.uiSession.adapter.current.getSnapshot().key === targetId
      && services.layout.panelInfo.getSnapshot().activePanelId === null
      && services.sidebarRight.mounted.getSnapshot() === targetId
      && session?.sessionId === targetId && session.openState === 'open' && !session.removed && !session.blank
      && content?.getAttribute('data-conversation-session') === targetId && content.getAttribute('data-content-phase') === 'active'
  }
  const acknowledge = (): void => {
    if (disposed || !targetConfirmed()) return
    verified = true
    lastAttempt = undefined
    lastFailure = undefined
    const title = services.sessions.list.getSnapshot().byId[targetId]?.displayTitle || 'DeepSeek Harness'
    doc.body.dataset.qytSessionWindowState = 'ready'
    notice.hidden = true
    doc.title = `${title} — QiuYaTools`
    if (lastAckTitle !== title) { lastAckTitle = title; send('ready', title) }
  }
  const checkAfterPaint = (): void => {
    if (frame !== undefined || disposed) return
    // Store agreement precedes React's commit. Confirm again after two frames,
    // including its real main-body identity, before revealing or acknowledging.
    frame = target.requestAnimationFrame(() => {
      frame = undefined
      if (disposed || !targetConfirmed()) { schedule(); return }
      frame = target.requestAnimationFrame(() => {
        frame = undefined
        if (disposed) return
        if (targetConfirmed()) acknowledge()
        else schedule()
      })
    })
  }
  const resetCatalogRecovery = (): void => {
    if (!catalogRecoveryStarted) return
    catalogRecoveryStarted = false
    catalogRecoveryEpoch++
    if (catalogRetryTimer !== undefined) { target.clearTimeout(catalogRetryTimer); catalogRetryTimer = undefined }
    catalogRetries = 0
    catalogExhausted = false
    // A shared upstream request cannot be cancelled here. Keep its in-flight
    // ownership until it settles, while ignoring that older recovery outcome.
  }
  const synchronizeCatalogGeneration = (): boolean => {
    const next = catalogGeneration?.getSnapshot()?.id
    if (next === catalogGenerationId) return false
    catalogGenerationId = next
    resetCatalogRecovery()
    // The official handleConnected fences its older request and starts the new
    // baseline. Stop waiting on the previous generation; the next pull only
    // joins that new baseline, and an old completion cannot spend its budget.
    catalogRequest = undefined
    return true
  }
  const pullCatalog = (): void => {
    synchronizeCatalogGeneration()
    if (disposed || catalogRequest || catalogRetryTimer !== undefined || catalogExhausted || !services.sessions.refresh) return
    if (services.sessions.list.getSnapshot().phase === 'ready') { resetCatalogRecovery(); return }
    // Public refresh before the first event generation would race the official
    // handleConnected refresh, which deliberately supersedes that early pull.
    if (catalogGeneration && catalogGeneration.getSnapshot() === undefined) return
    catalogRecoveryStarted = true
    const epoch = catalogRecoveryEpoch
    const generationId = catalogGenerationId
    const request = {}
    catalogRequest = request
    const settled = (): void => {
      // The official manager publishes a successful list before its refresh
      // settles. A RemoteFailure may resolve instead of rejecting, so inspect
      // only the public phase after that Promise and the projection microtask.
      queueMicrotask(() => {
        if (catalogRequest !== request) return
        catalogRequest = undefined
        if (disposed) return
        if (catalogGeneration?.getSnapshot()?.id !== generationId) { synchronizeCatalogGeneration(); schedule(); return }
        if (epoch !== catalogRecoveryEpoch) { schedule(); return }
        if (services.sessions.list.getSnapshot().phase === 'ready') { resetCatalogRecovery(); schedule(); return }
        if (catalogRetries >= catalogRetryDelays.length) catalogExhausted = true
        else catalogRetryTimer = target.setTimeout(() => {
          catalogRetryTimer = undefined
          if (disposed) return
          if (synchronizeCatalogGeneration() || (catalogGeneration && catalogGeneration.getSnapshot() === undefined)) { schedule(); return }
          if (services.sessions.list.getSnapshot().phase === 'ready') resetCatalogRecovery()
          else { catalogRetries++; pullCatalog() }
          schedule()
        }, catalogRetryDelays[catalogRetries])
        schedule()
      })
    }
    try { void Promise.resolve(services.sessions.refresh()).then(() => settled(), settled) }
    catch { settled() }
  }
  const reconcile = (): void => {
    if (disposed) return
    synchronizeCatalogGeneration()
    const nextSource = services.sessions.binding?.(targetId)?.session
    if (nextSource !== sessionSource) {
      offSession?.()
      sessionSource = nextSource
      offSession = sessionSource?.subscribe(schedule)
    }
    const list = services.sessions.list.getSnapshot()
    const workspaces = services.workspaces.list.getSnapshot()
    if (list.phase !== 'ready') {
      pullCatalog()
      conceal(catalogExhausted ? 'catalog-refresh-failed' : 'catalog-loading', catalogExhausted)
      return
    }
    resetCatalogRecovery()
    if (workspaces.phase !== 'ready') { conceal('catalog-loading'); return }
    const summary = list.byId[targetId]
    if (!summary || summary.id !== targetId) { conceal('session-missing', true); return }
    if (summary.blank) { conceal('session-blank', true); return }
    if (workspaces.archivedSessionIds.includes(targetId)) { conceal('session-archived', true); return }
    const current = services.uiSession.adapter.current.getSnapshot().key
    const panel = services.layout.panelInfo.getSnapshot().activePanelId
    if (current !== targetId || (summary.retainedBy?.mainView ?? 0) <= 0 || panel !== null) {
      conceal('navigation-pending')
      const signature = JSON.stringify([current ?? null, panel, summary.retainedBy?.mainView ?? 0])
      // A rejected/no-op navigation is diagnostic, not a tight retry loop. A
      // later genuine selection change starts a new, event-driven correction.
      if (lastAttempt === signature) return
      lastAttempt = signature
      try {
        // Cancel the official asynchronous restoreBlank/start-session flow
        // before it can commit a saved Session over this window's fixed target.
        services.layout.beginNavigation()
        if (current !== targetId || (summary.retainedBy?.mainView ?? 0) <= 0) services.uiWorkspace.openSession(targetId)
        else services.layout.selectPanel(null)
      } catch { conceal('navigation-failed', true); return }
      schedule()
      return
    }
    lastAttempt = undefined
    if (services.sidebarRight.mounted.getSnapshot() !== targetId) { conceal('sidebar-binding-pending'); return }
    const session = sessionSource?.getSnapshot()
    if (session?.removed) { conceal('session-removed', true); return }
    if (session?.openState === 'error') { conceal('session-open-failed', true); return }
    if (session?.sessionId !== targetId || session.openState !== 'open' || session.blank) { conceal('session-loading'); return }
    if (!targetConfirmed()) { conceal('conversation-render-pending'); return }
    if (verified) acknowledge()
    else checkAfterPaint()
  }
  const schedule = (): void => {
    if (disposed) return
    if (verified && !targetConfirmed()) conceal('navigation-changed')
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; if (!disposed) reconcile() })
  }
  conceal('catalog-loading')
  const stops = [
    services.sessions.list.subscribe(schedule), services.workspaces.list.subscribe(schedule),
    services.uiSession.adapter.current.subscribe(schedule), services.layout.panelInfo.subscribe(schedule),
    services.sidebarRight.mounted.subscribe(schedule),
  ]
  const stopGeneration = catalogGeneration?.subscribe(() => { synchronizeCatalogGeneration(); schedule() })
  if (stopGeneration) stops.push(stopGeneration)
  const view = target as Window & typeof globalThis
  const observer = new view.MutationObserver(records => {
    if (records.some(record => {
      if (record.type === 'attributes') return true
      return [...record.addedNodes, ...record.removedNodes].some(node => node instanceof view.Element
        && (node.matches('[data-conversation-content], [data-slot="main.conversation"], [data-slot="main"]')
          || node.querySelector('[data-conversation-content], [data-slot="main.conversation"], [data-slot="main"]') !== null))
    })) schedule()
  })
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-conversation-session', 'data-content-phase'] })
  reconcile()
  return () => {
    if (disposed) return
    disposed = true
    for (const stop of stops) stop()
    if (catalogRetryTimer !== undefined) target.clearTimeout(catalogRetryTimer)
    offSession?.()
    observer.disconnect()
    if (frame !== undefined) target.cancelAnimationFrame(frame)
    style.remove()
    notice.remove()
    delete doc.body.dataset.qytSessionWindow
    delete doc.body.dataset.qytSessionWindowState
  }
}
