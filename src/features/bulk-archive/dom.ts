import { SidebarSelection, type ArchiveTarget } from './model.ts'
import type { BulkArchiveLocaleKey } from './locales.ts'
import { bulkArchiveCSS, selectionMarker } from './styles.ts'

export interface SidebarBulkArchiveOptions {
  targets(): Map<string, readonly ArchiveTarget[]>
  archive(id: string): Promise<void>
  subscribe(refresh: () => void): () => void
  t(key: BulkArchiveLocaleKey, params?: Record<string, number>): string
}

const ROW = '[data-slot="sidebar.workspaces"] [data-row-key^="session:"]'
const WORKSPACE_ROW = '[data-slot="sidebar.workspaces"] [data-row-key^="workspace:"]'
const MENU = '[role="menu"]'
const ACTION = 'button, input, textarea, select, a, [contenteditable="true"]'

/**
 * Additive adapter for the official workspace DOM (stable data-row-key identities).
 * No Desktop globals or package patches are needed. All writes go through archive().
 */
export function installSidebarBulkArchive(options: SidebarBulkArchiveOptions, doc: Document = document): () => void {
  const win = doc.defaultView
  if (win === null) return () => {}
  const selection = new SidebarSelection()
  const selected = selection.selected
  const style = doc.createElement('style')
  style.dataset.qytFeature = 'bulk-archive'
  style.textContent = bulkArchiveCSS
  doc.head.appendChild(style)
  let menu: HTMLDivElement | undefined
  let openingSelectionMenu = false
  let busy = false
  let disposed = false
  let result: string | undefined
  const failureReasons = new Map<string, string>()
  let pendingWorkspaceMenu: {
    rowKey: string
    trigger: HTMLButtonElement
    previous: Set<Element>
    panel?: HTMLElement
  } | undefined
  const addedWorkspaceItems = new Set<HTMLElement>()
  let pendingSelectionMenu: {
    trigger: HTMLButtonElement
    previous: Set<Element>
    panel?: HTMLElement
  } | undefined
  const addedSelectionItems = new Set<HTMLElement>()

  const isElement = (node: EventTarget | null): node is Element => node instanceof win.Element
  const rowAt = (event: Event): HTMLElement | undefined => isElement(event.target)
    ? event.target.closest<HTMLElement>(ROW) ?? undefined : undefined
  const workspaceAt = (event: Event): HTMLElement | undefined => isElement(event.target)
    ? event.target.closest<HTMLElement>(WORKSPACE_ROW) ?? undefined : undefined
  const isAction = (event: Event): boolean => isElement(event.target) && event.target.closest(ACTION) !== null
  const stop = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation() }
  const rows = (): HTMLElement[] => [...doc.querySelectorAll<HTMLElement>(ROW)]
  const membersAt = (row: HTMLElement): readonly ArchiveTarget[] => options.targets().get(row.dataset.rowKey ?? '') ?? []
  const insideOwnUI = (event: Event): boolean => event.target instanceof win.Node
    && menu?.contains(event.target) === true
  const closeMenu = (): void => { menu?.remove(); menu = undefined }
  const render = (): void => {
    for (const row of rows()) {
      const members = membersAt(row)
      if (members.length > 0 && members.every(member => selected.has(member.id))) row.setAttribute(selectionMarker, 'true')
      else row.removeAttribute(selectionMarker)
    }
    for (const item of addedWorkspaceItems) {
      const button = item.querySelector('button')
      if (button) { button.textContent = options.t('workspace'); button.disabled = busy }
    }
  }
  const clear = (): void => {
    if (busy) return
    selection.clear()
    result = undefined
    failureReasons.clear()
    closeMenu()
    pendingSelectionMenu = undefined
    for (const item of addedSelectionItems) item.remove()
    addedSelectionItems.clear()
    render()
  }

  const archive = async (requested: readonly ArchiveTarget[], workspaceKey?: string): Promise<void> => {
    if (busy || disposed) return
    // Deduplicate by identity even if a host membership contains a duplicate.
    const batch = [...new Map(requested.map(member => [member.id, member] as const)).values()]
    if (batch.length === 0) return
    busy = true
    selected.clear()
    batch.forEach(member => selected.set(member.id, member))
    result = undefined
    failureReasons.clear()
    closeMenu()
    render()
    let succeeded = 0
    const failed: ArchiveTarget[] = []
    for (const member of batch) {
      if (disposed) break
      try {
        if (workspaceKey !== undefined && !options.targets().get(workspaceKey)?.some(item => item.id === member.id)) {
          throw new Error(options.t('membershipChanged'))
        }
        // Preserve the Host's running-session refusal: never request stopActivity.
        await options.archive(member.id)
        succeeded++
      } catch (cause) {
        failed.push(member)
        if (!disposed) failureReasons.set(member.id, `${member.title}: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    if (disposed) return
    selected.clear()
    failed.forEach(member => selected.set(member.id, member))
    busy = false
    result = failed.length > 0 ? options.t('failed', { n: succeeded, failed: failed.length }) : undefined
    render()
  }

  /**
   * Official 0.2.1 has Session-menu slots but no Workspace-menu slot. Associate
   * only the menu mounted by the clicked real-Workspace trigger; never infer
   * workspace identity from a translated title or alter another menu.
   */
  const augmentWorkspaceMenu = (): void => {
    const pending = pendingWorkspaceMenu
    if (pending === undefined || !pending.trigger.isConnected || disposed) return
    if (pending.panel && !pending.panel.isConnected) { pendingWorkspaceMenu = undefined; return }
    const panel = pending.panel ?? [...doc.querySelectorAll<HTMLElement>(MENU)]
      .find(item => !pending.previous.has(item) && !item.classList.contains('qyt-bulk-archive'))
    if (panel === undefined || panel.querySelector('[data-qyt-workspace-archive]')) return
    const nativeItem = panel.querySelector<HTMLButtonElement>('button[role="menuitem"]')
    if (nativeItem === null) return
    pending.panel = panel
    const wrap = doc.createElement('div')
    wrap.dataset.qytWorkspaceArchive = pending.rowKey
    const button = doc.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.className = nativeItem.className
    button.textContent = options.t('workspace')
    button.disabled = busy
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      if (busy || disposed) return
      // Close through the original trigger so its React owner stays consistent.
      pending.trigger.click()
      const batch = options.targets().get(pending.rowKey) ?? []
      void archive(batch, pending.rowKey)
    })
    const nativeWrap = nativeItem.parentElement
    if (nativeWrap && nativeWrap !== panel && nativeWrap.getAttribute('role') !== 'presentation') wrap.className = nativeWrap.className
    wrap.appendChild(button)
    addedWorkspaceItems.add(wrap)
    // Stay inside Menu's scrolling viewport rather than outside its content box.
    ;(nativeItem.closest<HTMLElement>('[role="presentation"]') ?? panel).appendChild(wrap)
  }
  const rememberWorkspaceMenu = (event: MouseEvent): void => {
    pendingWorkspaceMenu = undefined
    const row = workspaceAt(event)
    if (row === undefined || row.dataset.rowKey === 'workspace:' || !isElement(event.target)) return
    const trigger = event.target.closest<HTMLButtonElement>('button')
    // The official real-Workspace row puts its menu trigger before New Session.
    if (trigger === null || trigger !== row.querySelector('button') || row.querySelectorAll('button').length < 2) return
    const rowKey = row.dataset.rowKey
    if (rowKey === undefined || !options.targets().has(rowKey)) return
    const pending = { rowKey, trigger, previous: new Set(doc.querySelectorAll(MENU)) }
    pendingWorkspaceMenu = pending
    queueMicrotask(() => {
      augmentWorkspaceMenu()
      queueMicrotask(() => {
        augmentWorkspaceMenu()
        // A closed trigger must not leave a future, unrelated menu eligible.
        if (pendingWorkspaceMenu === pending && pendingWorkspaceMenu.panel === undefined) pendingWorkspaceMenu = undefined
      })
    })
  }
  const appendFailureDetails = (parent: HTMLElement): void => {
    if (result === undefined || failureReasons.size === 0) return
    const details = doc.createElement('div')
    details.className = 'qyt-bulk-archive-failures'
    details.dataset.qytArchiveFailures = 'true'
    const summary = doc.createElement('p')
    summary.textContent = result
    const reasons = doc.createElement('ul')
    for (const [id, reason] of failureReasons) {
      if (!selected.has(id)) continue
      const item = doc.createElement('li')
      item.textContent = reason
      reasons.appendChild(item)
    }
    details.append(summary, reasons)
    parent.appendChild(details)
  }
  const augmentSelectionMenu = (): void => {
    const pending = pendingSelectionMenu
    if (pending === undefined || disposed || selected.size !== 1 || !pending.trigger.isConnected) return
    if (pending.panel && !pending.panel.isConnected) { pendingSelectionMenu = undefined; return }
    const panel = pending.panel ?? [...doc.querySelectorAll<HTMLElement>(MENU)]
      .find(item => !pending.previous.has(item) && !item.classList.contains('qyt-bulk-archive'))
    if (panel === undefined || panel.querySelector('[data-qyt-selection-clear]')) return
    const nativeItem = panel.querySelector<HTMLButtonElement>('button[role="menuitem"]')
    if (nativeItem === null) return
    pending.panel = panel
    const wrap = doc.createElement('div')
    wrap.dataset.qytSelectionClear = 'true'
    const button = doc.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.className = nativeItem.className
    button.textContent = options.t('clear')
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation()
      if (busy) return
      pending.trigger.click()
      clear()
    })
    const nativeWrap = nativeItem.parentElement
    if (nativeWrap && nativeWrap !== panel && nativeWrap.getAttribute('role') !== 'presentation') wrap.className = nativeWrap.className
    wrap.appendChild(button)
    appendFailureDetails(wrap)
    addedSelectionItems.add(wrap)
    ;(nativeItem.closest<HTMLElement>('[role="presentation"]') ?? panel).appendChild(wrap)
  }
  const pointerDown = (event: PointerEvent): void => {
    if (insideOwnUI(event)) return
    closeMenu()
    if (event.button === 0 && (event.shiftKey || event.metaKey || event.ctrlKey) && rowAt(event) !== undefined && !isAction(event)) {
      event.preventDefault()
    }
  }
  const click = (event: MouseEvent): void => {
    if (openingSelectionMenu || insideOwnUI(event)) return
    rememberWorkspaceMenu(event)
    const row = rowAt(event)
    if (row === undefined || isAction(event)) { clear(); return }
    const member = membersAt(row)[0]
    if (!event.shiftKey && !event.metaKey && !event.ctrlKey) {
      if (!busy) { clear(); selection.anchor(member) }
      return
    }
    // Preserve normal behavior for non-archivable placeholders and archived rows.
    if (member === undefined) return
    stop(event)
    if (busy) return
    if (event.shiftKey) selection.range(member, rows().flatMap(item => membersAt(item)))
    else selection.toggle(member)
    result = undefined
    failureReasons.clear()
    render()
  }
  const contextMenu = (event: MouseEvent): void => {
    const row = rowAt(event)
    if (row === undefined || isAction(event)) return
    const member = membersAt(row)[0]
    if (member === undefined) return
    if (!selected.has(member.id)) clear()
    if (selected.size < 2) {
      const trigger = row.querySelector<HTMLButtonElement>('button')
      if (trigger) {
        stop(event)
        const pending = selected.size === 1 ? { trigger, previous: new Set(doc.querySelectorAll(MENU)), panel: undefined as HTMLElement | undefined } : undefined
        pendingSelectionMenu = pending
        openingSelectionMenu = pending !== undefined
        try { trigger.click() } finally { openingSelectionMenu = false }
        if (pending !== undefined) queueMicrotask(() => {
          augmentSelectionMenu()
          queueMicrotask(() => {
            augmentSelectionMenu()
            if (pendingSelectionMenu === pending && pending.panel === undefined) pendingSelectionMenu = undefined
          })
        })
      }
      return
    }
    stop(event)
    if (busy) return
    closeMenu()
    const batch = [...selected.values()]
    menu = doc.createElement('div')
    menu.className = 'qyt-bulk-archive qyt-bulk-archive-menu'
    menu.setAttribute('role', 'menu')
    appendFailureDetails(menu)
    for (const key of ['pin', 'rename', 'fork'] as const) {
      const disabled = doc.createElement('button')
      disabled.type = 'button'
      disabled.setAttribute('role', 'menuitem')
      disabled.disabled = true
      disabled.textContent = options.t(key)
      menu.appendChild(disabled)
    }
    const button = doc.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.textContent = options.t('archive', { n: batch.length })
    button.addEventListener('click', () => { void archive(batch) })
    menu.appendChild(button)
    const cancel = doc.createElement('button')
    cancel.type = 'button'
    cancel.setAttribute('role', 'menuitem')
    cancel.textContent = options.t('clear')
    cancel.addEventListener('click', clear)
    menu.appendChild(cancel)
    doc.body.appendChild(menu)
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(0, Math.min(event.clientX, win.innerWidth - rect.width))}px`
    menu.style.top = `${Math.max(0, Math.min(event.clientY, win.innerHeight - rect.height))}px`
    button.focus()
  }
  const keyDown = (event: KeyboardEvent): void => {
    const inSelectionMenu = event.target instanceof win.Node && pendingSelectionMenu?.panel?.contains(event.target) === true
    if (event.key === 'Escape' && (menu !== undefined || selected.size > 0) && !busy && (!isAction(event) || insideOwnUI(event) || inSelectionMenu)) {
      stop(event)
      if (pendingSelectionMenu?.panel?.isConnected) pendingSelectionMenu.trigger.click()
      clear()
    }
    else if (event.key === 'Escape' && menu !== undefined) { stop(event); closeMenu() }
    else if (event.key === 'Tab') closeMenu()
  }
  const doubleClick = (event: MouseEvent): void => {
    if ((event.shiftKey || event.metaKey || event.ctrlKey) && rowAt(event) !== undefined && !isAction(event)) stop(event)
  }
  const dragStart = (event: Event): void => {
    if (selected.size > 0 && rowAt(event) !== undefined) stop(event)
  }
  const refresh = (): void => {
    if (disposed) return
    if (!busy) { selection.reconcile(options.targets()); closeMenu() }
    render()
  }
  const unsubscribe = options.subscribe(refresh)
  const observer = new win.MutationObserver(records => {
    augmentWorkspaceMenu()
    augmentSelectionMenu()
    if (records.some(record => record.target instanceof win.Element && record.target.closest('[data-slot="sidebar"]') !== null)) render()
    for (const item of addedWorkspaceItems) if (!item.isConnected) addedWorkspaceItems.delete(item)
    for (const item of addedSelectionItems) if (!item.isConnected) addedSelectionItems.delete(item)
  })
  observer.observe(doc.body, { childList: true, subtree: true })
  const events = [
    ['pointerdown', pointerDown], ['click', click], ['contextmenu', contextMenu],
    ['keydown', keyDown], ['dblclick', doubleClick], ['dragstart', dragStart],
  ] as const
  for (const [name, handler] of events) doc.addEventListener(name, handler as EventListener, true)
  win.addEventListener('resize', closeMenu)
  win.addEventListener('blur', closeMenu)
  render()
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    observer.disconnect()
    for (const [name, handler] of events) doc.removeEventListener(name, handler as EventListener, true)
    win.removeEventListener('resize', closeMenu)
    win.removeEventListener('blur', closeMenu)
    closeMenu()
    pendingWorkspaceMenu = undefined
    for (const item of addedWorkspaceItems) item.remove()
    addedWorkspaceItems.clear()
    pendingSelectionMenu = undefined
    for (const item of addedSelectionItems) item.remove()
    addedSelectionItems.clear()
    failureReasons.clear()
    style.remove()
    for (const row of rows()) row.removeAttribute(selectionMarker)
  }
}
