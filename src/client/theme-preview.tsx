import React, { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { getCustomThemes, type CustomTheme } from '../custom-themes.ts'
import { createCustomTheme } from './custom-theme-definition.ts'
import { DEFAULT_PREFERENCES, getThemeMotion, type Preferences, type QPresetThemeId } from '../shared.ts'
import { MONO_ICON_DATA_URL } from './brand-assets.ts'
import { installQTheme } from './q-theme.ts'
import { getQTheme, type ThemeDefinition } from './theme-catalog.ts'

// This is only the miniature host's layout. Art, palettes, motion, reduced
// motion and all scene disposal stay in the same framework as the real app.
const FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:#fafaf8;color:var(--qyt-q-ink,#24282b)}.preview-shell{display:grid;grid-template-columns:70px minmax(0,1fr);width:100%;height:100%}[data-slot="sidebar"]{min-width:0}[data-slot="sidebar"]>aside{display:flex;flex-direction:column;align-items:center;gap:12px;height:100%;padding:16px 10px;border-right:1px solid var(--qyt-q-line)}.brand{width:24px;height:24px;flex:none;margin-bottom:3px;background:var(--qyt-q-accent);mask:url("${MONO_ICON_DATA_URL}") center/contain no-repeat;-webkit-mask:url("${MONO_ICON_DATA_URL}") center/contain no-repeat}aside>i{width:30px;height:5px;border-radius:4px;background:color-mix(in srgb,var(--qyt-q-ink) 14%,var(--qyt-q-surface))}aside>i:first-of-type{background:var(--qyt-q-accent);box-shadow:0 0 0 5px var(--qyt-q-selected)}main{min-width:0;height:100%}[data-phase]{width:100%;height:100%}.preview-main{position:relative;z-index:1;display:flex;flex-direction:column;align-items:flex-start;gap:12px;min-width:0;height:100%;padding:13px 16px}.top{display:flex;align-items:center;justify-content:space-between;align-self:stretch;margin-bottom:2px}.top>span{width:62px;height:5px;border-radius:4px;background:var(--qyt-q-line)}.top>i{width:6px;height:6px;border-radius:50%;background:var(--qyt-q-accent)}.bubble{display:grid;gap:5px;width:58%;padding:10px;border-radius:9px;background:var(--qyt-q-paper,color-mix(in srgb,var(--qyt-q-surface) 88%,transparent))}.bubble>span{height:4px;border-radius:3px;background:color-mix(in srgb,var(--qyt-q-ink) 18%,var(--qyt-q-surface))}.bubble>span:last-child{width:62%}.user{align-self:flex-end;width:42%;margin-inline-end:40%;background:var(--qyt-q-selected);border-bottom-right-radius:3px}.user>span{background:color-mix(in srgb,var(--qyt-q-accent) 30%,var(--qyt-q-surface))}.answer{width:clamp(40px,calc(100vw - 300px),58%);border-bottom-left-radius:3px}.composer{display:flex;align-items:center;justify-content:space-between;align-self:stretch;gap:12px;margin-top:auto;padding:7px 8px;border:1px solid var(--qyt-q-line);border-radius:8px;background:var(--qyt-q-paper,color-mix(in srgb,var(--qyt-q-surface) 88%,transparent))}.composer>span{width:44%;height:4px;border-radius:3px;background:var(--qyt-q-line)}.composer>i{width:12px;height:12px;border-radius:4px;background:var(--dsw-alias-button-info-fill)}
</style></head><body><div data-slot="root" style="display:contents"><div class="preview-shell"><div data-slot="sidebar"><aside><span class="brand"></span><i></i><i></i><i></i></aside></div><div data-slot="main" style="display:contents"><main data-slot="main.conversation"><div data-phase="hero"><div class="preview-main"><div class="top"><span></span><i></i></div><div class="bubble user"><span></span><span></span></div><div class="bubble answer"><span></span><span></span><span></span></div><div class="composer"><span></span><i></i></div></div></div></main></div><div data-rightbar-col hidden></div></div></div></body></html>`

const SETTINGS_FRAME_HTML = FRAME_HTML.replace('</style>', `
.preview-settings{position:absolute;inset:8% 8%;z-index:2;display:grid;grid-template-columns:minmax(64px,26%) minmax(0,1fr);grid-template-rows:32px minmax(0,1fr);overflow:hidden;border:1px solid var(--qyt-q-line);border-radius:11px;background:var(--qyt-q-paper);color:var(--qyt-q-ink);box-shadow:0 12px 36px #0a131c65}
.preview-settings header{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;padding:0 10px;background:var(--qyt-q-chrome);border-bottom:1px solid var(--qyt-q-line);font-size:11px}
.preview-settings nav,.preview-settings article{display:grid;align-content:start;gap:7px;padding:9px;min-width:0;overflow:hidden}
.preview-settings nav>span{display:flex;align-items:center;gap:4px;min-height:18px;font-size:9px;overflow:hidden;white-space:nowrap;color:var(--qyt-q-sidebar-ink,var(--qyt-q-ink))}
.preview-settings nav>span:last-child{padding:0 4px;border-radius:5px;background:var(--qyt-q-selected)}
.preview-settings article{background:var(--qyt-q-paper);font-size:10px}
.preview-settings-card{display:flex;justify-content:space-between;align-items:center;gap:3px;min-height:25px;padding:4px 7px;border:1px solid var(--qyt-q-line);border-radius:6px;background:var(--qyt-q-paper)}
.preview-settings-card i{width:18px;height:9px;border-radius:8px;background:var(--qyt-q-accent)}
.preview-settings-card i::after{content:'';display:block;width:6px;height:6px;margin:1px 0 0 10px;border-radius:50%;background:white}
.preview-settings-tabs{display:flex;gap:5px;flex-wrap:wrap}
.preview-settings-tabs span{padding:3px 5px;border-radius:5px;background:var(--qyt-q-chrome)}
.preview-settings-tabs span:first-child{color:var(--qyt-q-accent);background:var(--qyt-q-selected)}
</style>`).replace('</body>', `
<div class="preview-settings" data-shortcut-modal="settings">
  <header><b data-preview-label="settings"></b><span>×</span></header>
  <nav><span data-preview-label="general"></span><span data-preview-label="models"></span><span>QiuYaTools</span></nav>
  <article><div class="preview-settings-card"><b>QiuYaTools</b><i></i></div>
    <div class="preview-settings-tabs"><span data-preview-label="theme"></span><span data-preview-label="attachments"></span></div>
    <div class="preview-settings-card"><span data-preview-label="enabled"></span><i></i></div>
  </article>
</div></body>`)

export function ThemePreview({ ctx, form, theme, draftVideo, title, appearance, settingsLabels, onMotionStatus }: {
  ctx: Context
  title: string
  appearance?: 'light' | 'dark'
  settingsLabels?: { settings: string; general: string; models: string; theme: string; attachments: string; enabled: string }
  onMotionStatus?(status: 'loading' | 'playing' | 'failed' | 'reduced' | 'static'): void
} & ({ form: ConfigForm<Preferences>; theme: ThemeDefinition; draftVideo?: never } | {
  form?: never; theme?: never; draftVideo: { theme: CustomTheme; url: string }
})) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [frameDocument, setFrameDocument] = useState<Document | null>(null)
  const liveDraft = useRef(draftVideo)
  const notifyDraft = useRef<() => void>()
  const themeId = theme?.id ?? draftVideo!.theme.id

  useEffect(() => {
    liveDraft.current = draftVideo
    notifyDraft.current?.()
  }, [draftVideo])
  useEffect(() => {
    if (!settingsLabels || !frameDocument) return
    for (const [key, value] of Object.entries(settingsLabels)) {
      const label = frameDocument.querySelector(`[data-preview-label="${key}"]`)
      if (label) label.textContent = value
    }
  }, [settingsLabels, frameDocument])

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
    notifyDraft.current = notify
    const projected: ConfigForm<Preferences> = {
      getSnapshot() {
        const draft = liveDraft.current
        const snapshot = form?.getSnapshot() ?? { status: 'ready' as const, writable: false, base: DEFAULT_PREFERENCES, user: {}, revision: 0, value: DEFAULT_PREFERENCES }
        const value = { ...DEFAULT_PREFERENCES, ...snapshot.value, qThemeEnabled: true, qThemeId: themeId,
          ...(draft ? { qCustomThemes: [draft.theme] } : {}) }
        return {
          ...snapshot, writable: false,
          value: {
            ...value,
            qCustomThemes: getCustomThemes(value).map(item => item.id === themeId && (!inView || parent.hidden) ? { ...item, motion: 'static' as const } : item),
            qThemeSettings: {
              ...DEFAULT_PREFERENCES.qThemeSettings, ...value.qThemeSettings,
              ...(themeId.startsWith('custom:') ? {} : { [themeId]: { ...value.qThemeSettings?.[themeId as QPresetThemeId], muted: true, motion: inView && !parent.hidden ? getThemeMotion(value, themeId) : 'static' } }),
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
    const unsubscribe = form?.subscribe(notify)
    const syncAppearance = (): void => { doc.body.toggleAttribute('data-ds-dark-theme', appearance ? appearance === 'dark' : parent.body.hasAttribute('data-ds-dark-theme')) }
    syncAppearance()
    const appearanceObserver = new view.MutationObserver(syncAppearance)
    appearanceObserver.observe(parent.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    const stop = installQTheme(ctx, projected, doc, (id, prefs) => {
      const draft = liveDraft.current
      return draft ? createCustomTheme(draft.theme, draft.url) : getQTheme(id, prefs)
    })
    const motionStatus = () => {
      if (!onMotionStatus) return
      const snapshot = projected.getSnapshot().value
      const item = getCustomThemes(snapshot).find(item => item.id === themeId)
      if (!item?.smartMotion || item.motion === 'static') { onMotionStatus('static'); return }
      if (view.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || view.matchMedia?.('(forced-colors: active)')?.matches) { onMotionStatus('reduced'); return }
      const state = doc.querySelector<HTMLElement>('[data-qyt-smart-motion]')?.dataset.qytSmartMotion
      onMotionStatus(state === 'failed' ? 'failed' : state === 'ready' ? 'playing' : 'loading')
    }
    const motionObserver = new view.MutationObserver(motionStatus)
    motionObserver.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-qyt-smart-motion'] })
    const motionPreference = view.matchMedia?.('(prefers-reduced-motion: reduce)')
    motionPreference?.addEventListener('change', motionStatus)
    motionStatus()
    // Keep each theme's subject crop in the miniature. Landscape motion also
    // consumes this variable; Ocean retains its renderer's viewport mapping.
    const crop = doc.createElement('style')
    crop.textContent = 'body[data-qyt-q-theme] [data-slot="main.conversation"] > [data-phase]{background-position:center,center,center,var(--qyt-preview-art-position,right bottom)}'
    doc.body.style.setProperty('--qyt-preview-art-position', theme?.previewPosition ?? (liveDraft.current ? 'center' : 'right bottom'))
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
      motionObserver.disconnect()
      motionPreference?.removeEventListener('change', motionStatus)
      unsubscribe?.()
      notifyDraft.current = undefined
      listeners.clear()
      appearanceObserver.disconnect()
      intersection?.disconnect()
      parent.removeEventListener('visibilitychange', notify)
      crop.remove()
      doc.body.style.removeProperty('--qyt-preview-art-position')
    }
  }, [ctx, form, frameDocument, themeId, theme?.revision, theme?.previewPosition, appearance, onMotionStatus])

  return <iframe ref={frame} className="qyt-theme-preview-frame" data-qyt-theme-preview="" title={title} aria-hidden="true" tabIndex={-1} srcDoc={settingsLabels ? SETTINGS_FRAME_HTML : FRAME_HTML} onLoad={() => { setFrameDocument(frame.current?.contentDocument ?? null) }}/>
}
