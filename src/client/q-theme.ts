import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_PREFERENCES, getQThemeId, getThemeMotion, type Preferences, type QThemeId } from '../shared.ts'
import type { SceneDisposer } from './video-scene.ts'
import css from './q-theme.css'
import { getQTheme, type ThemeDefinition } from './theme-catalog.ts'

const ATTRIBUTE = 'data-qyt-q-theme'
interface ThemeMount {
  body: HTMLElement
  style: HTMLStyleElement
  previous: string | null
  owners: Set<symbol>
  revision?: string
  themeId: QThemeId
  sceneKey?: string
  disposeScene?: SceneDisposer
  disposeSidebarZoom?: () => void
}
const mounts = new WeakMap<Document, ThemeMount>()

function installSidebarZoom(doc: Document, zoom: ThemeDefinition['sidebarZoom']): (() => void) | undefined {
  const win = doc.defaultView
  if (!zoom || !win?.ResizeObserver) return
  const selector = '[data-slot="sidebar"] > :first-child, [data-shortcut-modal="settings"] > nav'
  const nodes = new Set<HTMLElement>()
  const property = '--qyt-sidebar-cover-size'
  function size(node: HTMLElement) {
    node.style.setProperty(property, `max(${zoom!.factor * 100}%, ${node.clientHeight * zoom!.factor * zoom!.aspect}px) auto`)
  }
  const resize = new win.ResizeObserver(entries => entries.forEach(({ target }) => size(target as HTMLElement)))
  function sync() {
    const current = new Set(doc.querySelectorAll<HTMLElement>(selector))
    for (const node of nodes) {
      if (current.has(node)) continue
      resize.unobserve(node)
      node.style.removeProperty(property)
      nodes.delete(node)
    }
    for (const node of current) {
      if (nodes.has(node)) continue
      nodes.add(node)
      size(node)
      resize.observe(node)
    }
  }
  const mutations = new win.MutationObserver(records => {
    if (records.some(record => record.target instanceof win.Element && record.target.matches('[data-slot="sidebar"], [data-shortcut-modal="settings"]')
      || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof win.Element && (node.matches(selector) || node.querySelector(selector))))) sync()
  })
  mutations.observe(doc.body, { childList: true, subtree: true })
  sync()
  return () => {
    mutations.disconnect()
    resize.disconnect()
    for (const node of nodes) node.style.removeProperty(property)
  }
}

function stopScene(mount: ThemeMount): void {
  const dispose = mount.disposeScene
  mount.disposeScene = undefined
  // An adapter must not prevent another theme from mounting or retain the
  // shared presentation layer when its own cleanup fails.
  try { dispose?.() } catch { /* continue releasing the common layer */ }
}

/**
 * Add the selected presentation layer over Harness's own light/dark tokens.
 * The native theme presenter continues to own data-ds-dark-theme, user
 * preference, inline token layers and code highlighting. The caller owns this
 * disposer through ctx.effect; accepted ConfigForm updates reach every client.
 */
export function installQTheme(_ctx: Context, form: ConfigForm<Preferences>, target?: Document, resolveTheme = getQTheme): () => void {
  const doc = target ?? (typeof document === 'undefined' ? undefined : document)
  if (!doc?.body || !doc.head) return () => {}
  const owner = Symbol('qiuya-theme')
  let active = false
  let disposed = false

  const remove = (): void => {
    if (!active) return
    active = false
    const mount = mounts.get(doc)
    if (!mount || !mount.owners.delete(owner) || mount.owners.size > 0) return
    stopScene(mount)
    mount.disposeSidebarZoom?.()
    mount.style.remove()
    // Restore only our marker. Another actor's later attribute change is
    // outside this layer's ownership, just like the body's inline styles.
    if (mount.body.getAttribute(ATTRIBUTE) === mount.themeId) {
      if (mount.previous === null) mount.body.removeAttribute(ATTRIBUTE)
      else mount.body.setAttribute(ATTRIBUTE, mount.previous)
    }
    mounts.delete(doc)
  }

  const sync = (): void => {
    if (disposed) return
    const snapshot = form.getSnapshot()
    if (snapshot.status !== 'ready' || (snapshot.value?.qThemeEnabled ?? DEFAULT_PREFERENCES.qThemeEnabled) !== true) { remove(); return }
    const theme = resolveTheme(getQThemeId(snapshot.value), snapshot.value)
    let mount = mounts.get(doc)
    if (!mount) {
      const style = doc.createElement('style')
      style.dataset.plugin = 'dsh-qiuya-tools'
      style.dataset.qytQTheme = theme.id
      style.textContent = createQThemeStyles(theme)
      mount = { body: doc.body, style, previous: doc.body.getAttribute(ATTRIBUTE), owners: new Set(), themeId: theme.id, revision: theme.revision,
        disposeSidebarZoom: installSidebarZoom(doc, theme.sidebarZoom) }
      doc.head.append(style)
      doc.body.setAttribute(ATTRIBUTE, theme.id)
      mounts.set(doc, mount)
    }
    mount.owners.add(owner)
    active = true
    if (mount.themeId !== theme.id || mount.revision !== theme.revision) {
      mount.disposeSidebarZoom?.()
      mount.disposeSidebarZoom = installSidebarZoom(doc, theme.sidebarZoom)
      mount.themeId = theme.id
      mount.revision = theme.revision
      mount.style.dataset.qytQTheme = theme.id
      mount.style.textContent = createQThemeStyles(theme)
      mount.body.setAttribute(ATTRIBUTE, theme.id)
    }
    const sceneKey = `${theme.id}:${theme.sceneRevision ?? theme.revision ?? ''}:${getThemeMotion(snapshot.value, theme.id)}`
    if (sceneKey !== mount.sceneKey) {
      stopScene(mount)
      mount.sceneKey = sceneKey
      if (getThemeMotion(snapshot.value, theme.id) === 'dynamic') {
        // Art and reading surfaces are already installed. Unsupported motion
        // must never prevent selecting a theme or using its static fallback.
        try { mount.disposeScene = theme.installScene?.(doc, _ctx) } catch { /* retain static art */ }
      }
    }
  }

  const unsubscribe = form.subscribe(sync)
  sync()
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    remove()
  }
}

export function createQThemeStyles(theme: ThemeDefinition): string {
  return theme.palette.replaceAll('__QYT_THEME_SCENE__', theme.art).replaceAll('__QYT_THEME_SIDEBAR__', theme.sidebarArt ?? theme.art) + '\n' + css
}
