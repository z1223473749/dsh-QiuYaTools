import type { SidebarWorkspace, Source } from './model.ts'
import { nativeSidebarMenuTrigger } from './native-menu.ts'

interface WorkspaceMenuOptions {
  workspaces: Source<{ items: readonly SidebarWorkspace[] }>
  copyPath(id: string): Promise<void>
  openDirectory(id: string): Promise<void>
  moveToTop(id: string): Promise<void>
}

const ROW = '[data-slot="sidebar.workspaces"] [data-row-key^="workspace:"]'
const ICONS = {
  top: '<path d="M3 3h10M8 13V6m-3 3 3-3 3 3"/>',
  copy: '<rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M10 3H4a1 1 0 0 0-1 1v6"/>',
  folder: '<path d="M2 5a2 2 0 0 1 2-2h3l2 2h3a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"/>',
}

/**
 * 0.2.1 exposes no Workspace-menu slot. Observe only the native ellipsis
 * trigger and add rows to that newly mounted menu; never intercept contextmenu,
 * replace the Workspace component, inspect React fibers, or reorder DOM rows.
 */
export function installWorkspaceMenuTools(options: WorkspaceMenuOptions, target: Window): () => void {
  const doc = target.document
  const win = target as Window & typeof globalThis
  let disposed = false
  let pending: { id: string; trigger: HTMLButtonElement; previous: Set<Element>; panel?: HTMLElement } | undefined
  const added = new Set<HTMLElement>()
  const pendingFocusCleanups = new Set<() => void>()
  const prune = (): void => { for (const node of added) if (!node.isConnected) added.delete(node) }
  const augment = (): void => {
    if (disposed) return
    prune()
    const state = pending
    if (!state || !state.trigger.isConnected) return
    if (state.panel && !state.panel.isConnected) { pending = undefined; return }
    if (!options.workspaces.getSnapshot().items.some(item => item.workspaceId === state.id)) return
    const panel = state.panel ?? [...doc.querySelectorAll<HTMLElement>('[role="menu"]')].find(item => !state.previous.has(item) && !item.classList.contains('qyt-bulk-archive'))
    if (!panel || panel.querySelector('[data-qyt-workspace-tools]')) return
    const native = panel.querySelector<HTMLButtonElement>('button[role="menuitem"]')
    if (!native) return
    state.panel = panel
    const actions = [
      { key: 'top', label: '移到顶部', run: () => options.moveToTop(state.id) },
      { key: 'copy', label: '复制工作区路径', run: () => options.copyPath(state.id) },
      { key: 'folder', label: '打开工作区目录', run: () => options.openDirectory(state.id) },
    ] as const
    const container = doc.createElement('div')
    container.dataset.qytWorkspaceTools = state.id
    const first = options.workspaces.getSnapshot().items[0]
    for (const action of actions) {
      const wrap = doc.createElement('div')
      if (native.parentElement && native.parentElement !== panel && native.parentElement.getAttribute('role') !== 'presentation') wrap.className = native.parentElement.className
      const button = doc.createElement('button')
      button.className = native.className
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.dataset.qytWorkspaceAction = action.key
      button.disabled = action.key === 'top' && first?.workspaceId === state.id
      const icon = doc.createElement('span')
      icon.className = native.querySelector('svg')?.parentElement?.className ?? ''
      icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[action.key]}</svg>`
      const label = doc.createElement('span')
      label.textContent = action.label
      button.append(icon, label)
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation()
        if (disposed || button.disabled) return
        let focusStayedInMenu = panel.contains(doc.activeElement)
        const focusMoved = (focusEvent: FocusEvent): void => {
          if (focusEvent.target instanceof win.Node && focusEvent.target !== doc.body && !panel.contains(focusEvent.target)) focusStayedInMenu = false
        }
        const stopFocusWatch = (): void => { doc.removeEventListener('focusin', focusMoved, true); pendingFocusCleanups.delete(stopFocusWatch) }
        doc.addEventListener('focusin', focusMoved, true)
        pendingFocusCleanups.add(stopFocusWatch)
        button.disabled = true
        void action.run().then(() => {
          const active = doc.activeElement
          const restoreFocus = panel.contains(active) || focusStayedInMenu && (active === doc.body || active === null)
          stopFocusWatch()
          if (disposed || !panel.isConnected || !state.trigger.isConnected) return
          state.trigger.click()
          // Added DOM rows do not pass through Menu's selection callback.
          // Give keyboard focus back only if this action still owned it; a
          // composer selected while the Host request ran keeps its focus.
          queueMicrotask(() => {
            if (disposed || !restoreFocus || !state.trigger.isConnected || state.trigger.disabled) return
            const current = doc.activeElement
            if (current === doc.body || current === null || panel.contains(current)) state.trigger.focus({ preventScroll: true })
          })
        }).catch(() => {
          stopFocusWatch()
          if (!disposed && button.isConnected) { label.textContent = `${action.label}失败，请重试`; button.disabled = false }
        })
      })
      wrap.append(button)
      container.append(wrap)
    }
    added.add(container)
    ;(native.closest<HTMLElement>('[role="presentation"]') ?? panel).append(container)
  }
  const click = (event: MouseEvent): void => {
    if (!(event.target instanceof win.Element)) return
    const row = event.target.closest<HTMLElement>(ROW)
    const trigger = event.target.closest<HTMLButtonElement>('button')
    if (!row || !trigger || trigger !== nativeSidebarMenuTrigger(row)) return
    const id = row.dataset.rowKey?.slice('workspace:'.length)
    if (!id || !options.workspaces.getSnapshot().items.some(item => item.workspaceId === id)) return
    const state = { id, trigger, previous: new Set(doc.querySelectorAll('[role="menu"]')) }
    pending = state
    queueMicrotask(() => {
      augment()
      queueMicrotask(() => { augment(); if (pending === state && !pending.panel) pending = undefined })
    })
  }
  const observer = new win.MutationObserver(augment)
  observer.observe(doc.body, { subtree: true, childList: true })
  doc.addEventListener('click', click, true)
  return () => {
    if (disposed) return
    disposed = true; pending = undefined
    observer.disconnect()
    doc.removeEventListener('click', click, true)
    for (const cleanup of pendingFocusCleanups) cleanup()
    pendingFocusCleanups.clear()
    for (const node of added) node.remove()
    added.clear()
  }
}
