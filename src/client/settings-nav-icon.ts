import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { SETTINGS_ID } from '../shared.ts'
import { MONO_ICON_DATA_URL } from './brand-assets.ts'
import { createMenuBrandIcon } from './brand-icon.ts'

interface SettingsNavigationServices {
  slots: {
    inject(key: 'settings.section', effect: () => (() => void)): () => void
    entries(key: 'settings.section'): readonly StoredEntry[]
    subscribe(key: 'settings.section', listener: () => void): () => void
  }
  locale: { subscribe(listener: () => void): () => void }
}

/** Adapt only this section's fixed gear until Harness exposes a navigation icon seat. */
export function installSettingsNavIcon(ctx: Context, target: Window = window): () => void {
  const doc = target.document
  const view = target as Window & typeof globalThis
  if (!doc?.body || typeof view.MutationObserver !== 'function' || MONO_ICON_DATA_URL.length === 0) return () => {}
  const services = ctx as unknown as SettingsNavigationServices
  return services.slots.inject('settings.section', () => {
    let disposed = false
    let queued = false
    const mounted = new Map<HTMLButtonElement, { native: SVGElement; icon: HTMLSpanElement; restore(): void }>()
    const nativeIcon = (button: HTMLButtonElement): SVGElement | undefined => [...button.children].find((node): node is SVGElement => node instanceof view.SVGElement)
    const ownButtons = (): HTMLButtonElement[] => {
      // The installed SettingsPanel builds its buttons from this exact public
      // ledger and stable order. Position plus label proves the section id;
      // an unrelated plugin using the same display name is never a match.
      const rows = [...services.slots.entries('settings.section')].sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
      const index = rows.findIndex(row => row.options.id === SETTINGS_ID)
      if (index < 0 || rows.filter(row => row.options.id === SETTINGS_ID).length !== 1) return []
      const entryLabel = rows[index].options.label
      const label = typeof entryLabel === 'function' ? entryLabel() : entryLabel
      if (typeof label !== 'string' || label.length === 0) return []
      const buttons: HTMLButtonElement[] = []
      for (const panel of doc.querySelectorAll<HTMLElement>('[role="dialog"][data-shortcut-modal="settings"]')) {
        const nav = [...panel.children].find(node => node.tagName === 'NAV')
        if (!nav) continue
        const candidates = [...nav.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.closest('nav') === nav)
        const button = candidates[index]
        if (candidates.length === rows.length && button && [...button.children].some(child => child.tagName === 'SPAN' && child.textContent === label)) buttons.push(button)
      }
      return buttons
    }
    const reconcile = (): void => {
      if (disposed) return
      const buttons = new Set(ownButtons())
      for (const [button, entry] of mounted) {
        if (!buttons.has(button) || !button.isConnected || nativeIcon(button) !== entry.native || entry.icon.parentElement !== button) { entry.restore(); mounted.delete(button) }
      }
      for (const button of buttons) {
        if (mounted.has(button) || button.querySelector('[data-qyt-settings-nav-icon]')) continue
        const native = nativeIcon(button)
        if (!native) continue
        const previousDisplay = native.style.getPropertyValue('display')
        const previousPriority = native.style.getPropertyPriority('display')
        const hadStyle = native.hasAttribute('style')
        const icon = createMenuBrandIcon(doc)
        icon.dataset.qytSettingsNavIcon = 'true'
        button.dataset.qytSettingsNavButton = 'true'
        native.style.setProperty('display', 'none', 'important')
        button.insertBefore(icon, native)
        mounted.set(button, { native, icon, restore() {
          icon.remove()
          delete button.dataset.qytSettingsNavButton
          if (previousDisplay) native.style.setProperty('display', previousDisplay, previousPriority)
          else native.style.removeProperty('display')
          if (!hadStyle && native.getAttribute('style') === '') native.removeAttribute('style')
        } })
      }
    }
    const schedule = (): void => {
      if (disposed || queued) return
      queued = true
      queueMicrotask(() => { queued = false; reconcile() })
    }
    const observer = new view.MutationObserver(schedule)
    observer.observe(doc.body, { subtree: true, childList: true, characterData: true })
    const offLocale = services.locale.subscribe(schedule)
    const offSections = services.slots.subscribe('settings.section', schedule)
    reconcile()
    return () => {
      if (disposed) return
      disposed = true
      observer.disconnect()
      offLocale()
      offSections()
      for (const entry of mounted.values()) entry.restore()
      mounted.clear()
    }
  })
}
