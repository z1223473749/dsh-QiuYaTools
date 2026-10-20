import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { SETTINGS_ID } from '../shared.ts'
import { createMenuBrandIcon } from './brand-icon.ts'

interface AccountMenuServices {
  slots: {
    inject(key: 'settings.launcher', effect: () => (() => void)): () => void
    entriesOfSlot(key: 'sidebar.settings'): readonly StoredEntry[]
    subscribe(key: 'sidebar.settings', listener: () => void): () => void
  }
  locale: { bind(namespace: string): (key: string) => string; subscribe(listener: () => void): () => void }
}

type OpenSection = (id: string) => void

/** The shipped Settings shell exposes its existing root instance through this public store seat. */
export function settingsSectionOpener(slots: AccountMenuServices['slots']): OpenSection | undefined {
  const entry = slots.entriesOfSlot('sidebar.settings')[0]
  const handle = entry?.store
  if (handle === null || typeof handle !== 'object' || !('create' in handle) || typeof handle.create !== 'function') return undefined
  const instance: unknown = handle.create()
  // A generic store factory creates unrelated state. Only the shell's stable
  // instance (the one its rendered component uses) is a navigation authority.
  if (instance !== handle.create() || instance === null || typeof instance !== 'object' || !('actions' in instance)) return undefined
  const actions = instance.actions
  if (actions === null || typeof actions !== 'object' || !('openSection' in actions) || typeof actions.openSection !== 'function') return undefined
  return id => { (actions.openSection as OpenSection)(id) }
}

/**
 * Harness 0.2.1 has a settings.launcher slot, but its AccountMenu has no item
 * slot. Add one DOM row only inside that identified menu, leaving the account
 * component and every built-in action under their original owner.
 */
export function installAccountMenuEntry(ctx: Context, label: () => string, target: Window = window): () => void {
  const doc = target.document
  const view = target as Window & typeof globalThis
  if (!doc?.body || typeof view.MutationObserver !== 'function') return () => {}
  const services = ctx as unknown as AccountMenuServices
  return services.slots.inject('settings.launcher', () => {
    let disposed = false
    let queued = false
    const mounted = new Map<HTMLElement, { container: HTMLElement; button: HTMLButtonElement; cleanup(): void }>()
    const accountCopy = services.locale.bind('settings.account')
    const rowLabel = (row: HTMLButtonElement, text: string): boolean => [...row.children].some(child => child.textContent?.trim() === text) || row.textContent?.trim() === text
    const accountMenu = (): { menu: HTMLElement; trigger: HTMLButtonElement; settings: HTMLButtonElement } | undefined => {
      const trigger = doc.querySelector<HTMLButtonElement>('[data-slot="settings.launcher"] button[data-signed-out][aria-haspopup="menu"][aria-expanded="true"]')
      if (!trigger) return undefined
      for (const menu of doc.querySelectorAll<HTMLElement>('[role="menu"]')) {
        const rows = [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].filter(row => row.closest('[role="menu"]') === menu && !row.hasAttribute('data-qyt-account-menu-entry'))
        const settings = rows.find(row => rowLabel(row, accountCopy('settings')))
        if (settings && rows.some(row => rowLabel(row, accountCopy('contactUs'))) && rows.some(row => rowLabel(row, accountCopy('signOut')) || rowLabel(row, accountCopy('signIn')))) return { menu, trigger, settings }
      }
      return undefined
    }
    const reconcile = (): void => {
      if (disposed) return
      const match = accountMenu()
      for (const [menu, entry] of mounted) {
        if (match?.menu !== menu || !entry.container.isConnected || !menu.contains(entry.container)) { entry.cleanup(); mounted.delete(menu) }
      }
      if (!match) return
      let entry = mounted.get(match.menu)
      if (!entry) {
        const container = doc.createElement('div')
        const nativeContainer = match.settings.parentElement
        if (nativeContainer && nativeContainer !== match.menu) container.className = nativeContainer.className
        const button = doc.createElement('button')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        button.dataset.qytAccountMenuEntry = 'true'
        button.className = match.settings.className
        // The plugin owns its glyph and button. Only the icon wrapper's
        // layout class is shared with the native menu.
        const nativeIcon = match.settings.querySelector('svg')
        const icon = doc.createElement('span')
        icon.className = nativeIcon?.parentElement?.className ?? ''
        icon.append(createMenuBrandIcon(doc))
        button.append(icon)
        const text = doc.createElement('span')
        text.dataset.qytAccountMenuLabel = 'true'
        const nativeLabel = [...match.settings.children].find(child => child.textContent?.trim() === accountCopy('settings'))
        if (nativeLabel instanceof view.HTMLElement) text.className = nativeLabel.className
        button.append(text)
        const select = (event: MouseEvent): void => {
          event.preventDefault()
          event.stopPropagation()
          if (disposed || button.disabled) return
          const openSection = settingsSectionOpener(services.slots)
          if (!openSection) return
          // The verified account trigger closes its own menu. No synthetic
          // events are dispatched to any Session or built-in menu row.
          if (match.trigger.getAttribute('aria-expanded') === 'true') match.trigger.click()
          openSection(SETTINGS_ID)
        }
        button.addEventListener('click', select)
        container.append(button)
        const anchor = nativeContainer && nativeContainer !== match.menu ? nativeContainer : match.settings
        anchor.after(container)
        entry = { container, button, cleanup() { button.removeEventListener('click', select); container.remove() } }
        mounted.set(match.menu, entry)
      }
      const text = entry.button.querySelector('[data-qyt-account-menu-label]')!
      const next = label()
      if (text.textContent !== next) text.textContent = next
      entry.button.disabled = settingsSectionOpener(services.slots) === undefined
    }
    const schedule = (): void => {
      if (disposed || queued) return
      queued = true
      queueMicrotask(() => { queued = false; reconcile() })
    }
    const observer = new view.MutationObserver(schedule)
    observer.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-expanded', 'data-signed-out'] })
    const offLocale = services.locale.subscribe(schedule)
    const offSettings = services.slots.subscribe('sidebar.settings', schedule)
    reconcile()
    return () => {
      if (disposed) return
      disposed = true
      observer.disconnect()
      offLocale()
      offSettings()
      for (const entry of mounted.values()) entry.cleanup()
      mounted.clear()
    }
  })
}
