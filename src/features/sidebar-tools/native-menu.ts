const SIDEBAR_ROW = '[data-slot="sidebar.workspaces"] [data-row-key][role="treeitem"]'
const ACTION = 'button, a, input, textarea, select, [contenteditable], [role="button"]'

/**
 * Harness 0.2.1's row-actions strip starts with the Menu's span wrapper and
 * its direct ellipsis button. Workspace collapse is a span / row click, and
 * New Session plus Session hover actions come after this wrapper. Restricting
 * to that structure avoids mistaking an action or plugin decoration for it.
 */
export function nativeSidebarMenuTrigger(row: HTMLElement): HTMLButtonElement | undefined {
  const strip = [...row.children].find(child => [...child.classList].some(name => name.endsWith('_rowActions')))
  const wrapper = strip?.firstElementChild
  if (wrapper?.tagName !== 'SPAN') return undefined
  const button = [...wrapper.children].find(child => child.tagName === 'BUTTON') as HTMLButtonElement | undefined
  if (!button?.getAttribute('aria-label') || button.disabled || button.getAttribute('role') === 'menuitem') return undefined
  return button
}

/**
 * A bubble-phase fallback when no earlier owner handled right-click. The
 * existing bulk-archive capture adapter wins naturally, so it cannot open a
 * second menu. This forwards only to the verified native trigger; it never
 * creates another menu or implements a second menu event capture path.
 */
export function installNativeSidebarContextMenu(target: Window, canOpen: (rowKey: string) => boolean): () => void {
  const doc = target.document
  const win = target as Window & typeof globalThis
  const opening = new WeakSet<HTMLButtonElement>()
  const contextMenu = (event: MouseEvent): void => {
    if (event.defaultPrevented || !(event.target instanceof win.Element) || event.target.closest(ACTION)) return
    const row = event.target.closest<HTMLElement>(SIDEBAR_ROW)
    const rowKey = row?.dataset.rowKey
    if (!row || !rowKey || !canOpen(rowKey)) return
    const trigger = nativeSidebarMenuTrigger(row)
    if (!trigger) return
    event.preventDefault()
    // Menu state is owned by React. Do not toggle a currently open native
    // menu closed, nor dispatch a second click while the first is committing.
    if (trigger.getAttribute('aria-expanded') === 'true' || [...row.classList].some(name => name.endsWith('_menuOpen')) || opening.has(trigger)) return
    opening.add(trigger)
    try { trigger.click() } finally { queueMicrotask(() => opening.delete(trigger)) }
  }
  doc.addEventListener('contextmenu', contextMenu)
  return () => doc.removeEventListener('contextmenu', contextMenu)
}
