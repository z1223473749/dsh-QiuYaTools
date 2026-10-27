import React, { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_PREFERENCES, getThemeMotion, type Preferences } from '../shared.ts'
import { MONO_ICON_DATA_URL } from './brand-assets.ts'
import { installQTheme } from './q-theme.ts'
import type { ThemeDefinition } from './theme-catalog.ts'

// This is only the miniature host's layout. Art, palettes, motion, reduced
// motion and all scene disposal stay in the same framework as the real app.
const FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:#fafaf8;color:var(--qyt-q-ink,#24282b)}.preview-shell{display:grid;grid-template-columns:70px minmax(0,1fr);width:100%;height:100%}[data-slot="sidebar"]{min-width:0}[data-slot="sidebar"]>aside{display:flex;flex-direction:column;align-items:center;gap:12px;height:100%;padding:16px 10px;border-right:1px solid var(--qyt-q-line)}.brand{width:24px;height:24px;flex:none;margin-bottom:3px;background:var(--qyt-q-accent);mask:url("${MONO_ICON_DATA_URL}") center/contain no-repeat;-webkit-mask:url("${MONO_ICON_DATA_URL}") center/contain no-repeat}aside>i{width:30px;height:5px;border-radius:4px;background:color-mix(in srgb,var(--qyt-q-ink) 14%,var(--qyt-q-surface))}aside>i:first-of-type{background:var(--qyt-q-accent);box-shadow:0 0 0 5px var(--qyt-q-selected)}main{min-width:0;height:100%}[data-phase]{width:100%;height:100%}.preview-main{position:relative;z-index:1;display:flex;flex-direction:column;align-items:flex-start;gap:12px;min-width:0;height:100%;padding:13px 16px}.top{display:flex;align-items:center;justify-content:space-between;align-self:stretch;margin-bottom:2px}.top>span{width:62px;height:5px;border-radius:4px;background:var(--qyt-q-line)}.top>i{width:6px;height:6px;border-radius:50%;background:var(--qyt-q-accent)}.bubble{display:grid;gap:5px;width:58%;padding:10px;border-radius:9px;background:color-mix(in srgb,var(--qyt-q-surface) 88%,transparent)}.bubble>span{height:4px;border-radius:3px;background:color-mix(in srgb,var(--qyt-q-ink) 18%,var(--qyt-q-surface))}.bubble>span:last-child{width:62%}.user{align-self:flex-end;width:42%;margin-inline-end:40%;background:var(--qyt-q-selected);border-bottom-right-radius:3px}.user>span{background:color-mix(in srgb,var(--qyt-q-accent) 30%,var(--qyt-q-surface))}.answer{border-bottom-left-radius:3px}.composer{display:flex;align-items:center;justify-content:space-between;align-self:stretch;gap:12px;margin-top:auto;padding:7px 8px;border:1px solid var(--qyt-q-line);border-radius:8px;background:color-mix(in srgb,var(--qyt-q-surface) 88%,transparent)}.composer>span{width:44%;height:4px;border-radius:3px;background:var(--qyt-q-line)}.composer>i{width:12px;height:12px;border-radius:4px;background:var(--dsw-alias-button-info-fill)}
</style></head><body><div class="preview-shell"><div data-slot="sidebar"><aside><span class="brand"></span><i></i><i></i><i></i></aside></div><main data-slot="main.conversation"><div data-phase="hero"><div class="preview-main"><div class="top"><span></span><i></i></div><div class="bubble user"><span></span><span></span></div><div class="bubble answer"><span></span><span></span><span></span></div><div class="composer"><span></span><i></i></div></div></div></main></div></body></html>`

export function ThemePreview({ ctx, form, theme, title }: {
  ctx: Context
  form: ConfigForm<Preferences>
  theme: ThemeDefinition
  title: string
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [frameDocument, setFrameDocument] = useState<Document | null>(null)

  useEffect(() => {
    const element = frame.current
    const doc = frameDocument
    if (!element || !doc?.body || !doc.head) return
    const parent = element.ownerDocument
    const view = parent.defaultView
    if (!view) return
    let disposed = false
    const listeners = new Set<() => void>()
    const bounds = element.getBoundingClientRect()
    let inView = bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 && bounds.left < view.innerWidth && bounds.top < view.innerHeight
    const notify = (): void => { if (!disposed) for (const listener of [...listeners]) listener() }
    const projected: ConfigForm<Preferences> = {
      getSnapshot() {
        const snapshot = form.getSnapshot()
        const value = { ...DEFAULT_PREFERENCES, ...snapshot.value, qThemeEnabled: true, qThemeId: theme.id }
        return {
          ...snapshot, writable: false,
          value: {
            ...value,
            qThemeSettings: {
              ...DEFAULT_PREFERENCES.qThemeSettings, ...value.qThemeSettings,
              [theme.id]: { ...value.qThemeSettings?.[theme.id], motion: inView && !parent.hidden ? getThemeMotion(value, theme.id) : 'static' },
            },
          },
        }
      },
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      // A preview only consumes accepted Host snapshots. It never writes a
      // setting, even while the real Q Theme switch is off.
      async mutate() { return false },
      async set() { return false },
      async unset() { return false },
    }
    const unsubscribe = form.subscribe(notify)
    const syncAppearance = (): void => { doc.body.toggleAttribute('data-ds-dark-theme', parent.body.hasAttribute('data-ds-dark-theme')) }
    syncAppearance()
    const appearance = new view.MutationObserver(syncAppearance)
    appearance.observe(parent.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    const stop = installQTheme(ctx, projected, doc)
    // Keep the approved subject crop on the static Begonia backdrop. Ocean's
    // default matches its renderer's viewport mapping in both motion modes.
    const crop = doc.createElement('style')
    crop.textContent = 'body[data-qyt-q-theme] [data-slot="main.conversation"] > [data-phase]{background-position:center,center,center,var(--qyt-preview-art-position,right bottom)}'
    doc.body.style.setProperty('--qyt-preview-art-position', theme.previewPosition ?? 'right bottom')
    doc.head.append(crop)
    const intersection = view.IntersectionObserver ? new view.IntersectionObserver(entries => {
      const entry = entries.find(entry => entry.target === element)
      if (!entry || disposed || inView === entry.isIntersecting) return
      inView = entry.isIntersecting
      notify()
    }) : null
    intersection?.observe(element)
    parent.addEventListener('visibilitychange', notify)
    return () => {
      disposed = true
      stop()
      unsubscribe()
      listeners.clear()
      appearance.disconnect()
      intersection?.disconnect()
      parent.removeEventListener('visibilitychange', notify)
      crop.remove()
      doc.body.style.removeProperty('--qyt-preview-art-position')
    }
  }, [ctx, form, frameDocument, theme.id, theme.previewPosition])

  return <iframe ref={frame} className="qyt-theme-preview-frame" data-qyt-theme-preview="" title={title} aria-hidden="true" tabIndex={-1} srcDoc={FRAME_HTML} onLoad={() => { setFrameDocument(frame.current?.contentDocument ?? null) }}/>
}
