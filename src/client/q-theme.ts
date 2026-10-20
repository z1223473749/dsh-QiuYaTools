import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Preferences } from '../shared.ts'
import css from './q-theme.css'
import { OCEAN_SCENE_DATA_URL } from './brand-assets.ts'

const ATTRIBUTE = 'data-qyt-q-theme'
interface ThemeMount {
  body: HTMLElement
  style: HTMLStyleElement
  previous: string | null
  owners: Set<symbol>
}
const mounts = new WeakMap<Document, ThemeMount>()

/**
 * Add an Ocean presentation layer over Harness's own light/dark tokens.
 * The native theme presenter continues to own data-ds-dark-theme, user
 * preference, inline token layers and code highlighting. The caller owns this
 * disposer through ctx.effect; accepted ConfigForm updates reach every client.
 */
export function installQTheme(_ctx: Context, form: ConfigForm<Preferences>): () => void {
  if (typeof document === 'undefined' || !document.body || !document.head) return () => {}
  const doc = document
  const owner = Symbol('qiuya-ocean-theme')
  let active = false
  let disposed = false

  const remove = (): void => {
    if (!active) return
    active = false
    const mount = mounts.get(doc)
    if (!mount || !mount.owners.delete(owner) || mount.owners.size > 0) return
    mount.style.remove()
    // Restore only our marker. Another actor's later attribute change is
    // outside this layer's ownership, just like the body's inline styles.
    if (mount.body.getAttribute(ATTRIBUTE) === 'ocean') {
      if (mount.previous === null) mount.body.removeAttribute(ATTRIBUTE)
      else mount.body.setAttribute(ATTRIBUTE, mount.previous)
    }
    mounts.delete(doc)
  }

  const sync = (): void => {
    if (disposed) return
    const snapshot = form.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.value?.qThemeEnabled !== true) { remove(); return }
    if (active) return
    let mount = mounts.get(doc)
    if (!mount) {
      const style = doc.createElement('style')
      style.dataset.plugin = 'dsh-qiuya-tools'
      style.dataset.qytQTheme = 'ocean'
      style.textContent = css.replaceAll('__QYT_OCEAN_SCENE__', OCEAN_SCENE_DATA_URL)
      mount = { body: doc.body, style, previous: doc.body.getAttribute(ATTRIBUTE), owners: new Set() }
      doc.head.append(style)
      doc.body.setAttribute(ATTRIBUTE, 'ocean')
      mounts.set(doc, mount)
    }
    mount.owners.add(owner)
    active = true
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
