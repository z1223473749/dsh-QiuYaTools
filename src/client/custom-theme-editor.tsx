import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_PREFERENCES, type Preferences } from '../shared.ts'
import { isCustomTheme, THEME_MOVEMENTS, THEME_ATMOSPHERES, ATMOSPHERE_COLORS, type CustomTheme } from '../custom-themes.ts'
import { createCustomTheme } from './custom-theme-definition.ts'
import { useSmartThemeEditor } from './smart-theme-editor.tsx'
import { ThemeColorWheel } from './theme-color-wheel.tsx'
import { ThemePreview } from './theme-preview.tsx'
import { importThemeImage } from './theme-image.ts'
import type { LocaleKey } from './locales.ts'

const movementLabels: Record<CustomTheme['movement'], LocaleKey> = { parallax: 'qThemeParallax', pan: 'qThemePan', breathe: 'qThemeBreathe', float: 'qThemeFloat', orbit: 'qThemeOrbit', none: 'qThemeNone' }
const atmosphereLabels: Record<CustomTheme['atmosphere'], LocaleKey> = { glow: 'qThemeGlow', petals: 'qThemePetals', snow: 'qThemeSnow', fireflies: 'qThemeFireflies', stars: 'qThemeStars', bubbles: 'qThemeBubbles', aurora: 'qThemeAurora', none: 'qThemeNone' }

function currentThemeAccent(): string {
  const accent = typeof document === 'undefined' ? '' : document.defaultView?.getComputedStyle(document.body).getPropertyValue('--qyt-q-accent').trim() ?? ''
  return /^#[\da-f]{6}$/i.test(accent) ? accent : '#ad563e'
}

export function CustomThemeEditor({ ctx, original, disabled, t, onClose, onSave, onDelete }: {
  ctx: Context; original?: CustomTheme; disabled: boolean; t: (key: LocaleKey) => string; onClose(): void
  onSave(theme: CustomTheme): Promise<boolean>; onDelete?(id: CustomTheme['id']): Promise<boolean>
}) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), file = useRef<HTMLInputElement>(null)
  const alive = useRef(true), importGeneration = useRef(0), playbackEdited = useRef(false)
  const [draft, setDraft] = useState<CustomTheme>(() => original ?? {
    id: `custom:${crypto.randomUUID()}`, name: '', image: '', width: 1, height: 1, accent: currentThemeAccent(),
    motion: 'dynamic', movement: 'parallax', atmosphere: 'glow', intensity: .35, speed: .45, x: 50, y: 62, zoom: 1, mask: .9,
  })
  const [panel, setPanel] = useState<'image' | 'motion' | 'atmosphere'>(original?.smartMotion ? 'motion' : 'image')
  const [workingImage, setWorkingImage] = useState(draft.image)
  const [motionStatus, setMotionStatus] = useState<'loading' | 'playing' | 'failed' | 'reduced' | 'static'>('static')
  const [appearance, setAppearance] = useState<'light' | 'dark'>('light')
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<LocaleKey | null>(null), [extracted, setExtracted] = useState(draft.accent)
  const busy = disabled || loading || saving
  const drag = useRef<{ pointer: number; left: number; top: number; x: number; y: number } | null>(null)
  const change = <K extends keyof CustomTheme>(key: K, value: CustomTheme[K]) => { if (key === 'intensity' || key === 'speed') playbackEdited.current = true; setDraft(current => ({ ...current, [key]: value })); setError(null) }
  const smart = useSmartThemeEditor(ctx, draft, workingImage, busy, t, value => setDraft(current => ({ ...current, smartMotion: value, ...(value && !current.smartMotion ? { motion: 'dynamic' as const, ...(!playbackEdited.current ? { intensity: .75, speed: 1 } : {}) } : {}) })))
  const previewTheme = useMemo(() => createCustomTheme({ ...draft, name: draft.name || t('qThemeCustom') }), [draft, t])
  const previewForm = useMemo<ConfigForm<Preferences>>(() => ({
    getSnapshot: () => ({ status: 'ready', writable: false, base: DEFAULT_PREFERENCES, user: {}, revision: 0, value: { ...DEFAULT_PREFERENCES, qThemeId: draft.id, qCustomThemes: [{ ...draft, name: draft.name || t('qThemeCustom') }] } }),
    subscribe: () => () => {}, async mutate() { return false }, async set() { return false }, async unset() { return false },
  }), [draft, t])
  useEffect(() => {
    alive.current = true
    const element = dialog.current
    element?.showModal()
    return () => { alive.current = false; importGeneration.current++; element?.close() }
  }, [])
  async function upload(image?: File): Promise<void> {
    if (!image || busy) return
    const generation = ++importGeneration.current
    setLoading(true); setError(null)
    try {
      const { workingImage, ...result } = await importThemeImage(image)
      if (!alive.current || generation !== importGeneration.current) return
      setWorkingImage(workingImage)
      setDraft(current => ({ ...current, ...result, smartMotion: undefined, x: 50, y: 50, zoom: 1, name: current.name || image.name.replace(/\.[^.]+$/, '').slice(0, 40) }))
      setExtracted(result.accent)
    } catch (err) {
      if (alive.current && generation === importGeneration.current) setError(err instanceof Error && err.message === 'qThemeImageLarge' ? 'qThemeImageLarge' : 'qThemeImageInvalid')
    } finally { if (alive.current && generation === importGeneration.current) setLoading(false) }
  }
  async function save(): Promise<void> {
    if (busy || smart.pending) return
    const value = { ...draft, name: draft.name.trim() }
    if (!isCustomTheme(value)) { setError('qThemeCustomRequired'); return }
    setSaving(true); setError(null)
    try { await smart.persist(); if (!await onSave(value)) { await smart.releaseFailedSave(); if (alive.current) setError('qThemeCustomSaveError') } }
    catch { await smart.releaseFailedSave().catch(() => {}); if (alive.current) setError('qThemeCustomSaveError') }
    finally { if (alive.current) setSaving(false) }
  }
  async function close(): Promise<void> {
    if (saving) return
    setSaving(true)
    try { await smart.discard(); onClose() }
    catch { if (alive.current) { setError('qThemeCustomSaveError'); setSaving(false) } }
  }
  async function remove(): Promise<void> {
    if (!onDelete || busy) return
    setSaving(true)
    try { if (!await onDelete(draft.id) && alive.current) setError('qThemeCustomSaveError') }
    catch { if (alive.current) setError('qThemeCustomSaveError') }
    finally { if (alive.current) setSaving(false) }
  }
  function range(key: 'zoom' | 'x' | 'y' | 'intensity' | 'speed' | 'mask', label: LocaleKey, min: number, max: number, step: number, value: string) {
    return <label className="qyt-editor-range"><span>{t(label)}</span><input aria-label={t(label)} type="range" min={min} max={max} step={step} value={draft[key]} onChange={e => change(key, Number(e.target.value))}/><output>{value}</output></label>
  }
  return createPortal(<dialog ref={dialog} {...{ closedby: 'none' }} className="qyt-custom-dialog" aria-labelledby={`${id}-title`} onCancel={e => e.preventDefault()} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation() } }}>
    <header><div><h3 id={`${id}-title`}>{t('qThemeCustom')}</h3><p>{t('qThemeCustomIntro')}</p></div><button type="button" aria-label={t('qThemeClose')} disabled={saving} onClick={() => { void close() }}>×</button></header>
    <form className="qyt-editor-body" onSubmit={e => { e.preventDefault(); void save() }}>
      <fieldset disabled={busy} className="qyt-editor-grid">
        <section className="qyt-editor-stage"><div className="qyt-editor-section qyt-editor-stage-toolbar"><strong>{t('qThemeLivePreview')}</strong><div className="qyt-editor-pills"><button type="button" aria-pressed={!smart.editing} onClick={() => smart.setEditing(false)}>{t('qThemeAiWatch')}</button>{draft.smartMotion && <button type="button" aria-pressed={smart.editing} onClick={() => smart.setEditing(true)}>{t('qThemeAiEdit')}</button>}</div><div className="qyt-editor-pills">{(['light', 'dark'] as const).map(mode => <button type="button" key={mode} aria-pressed={appearance === mode} onClick={() => setAppearance(mode)}>{t(mode === 'light' ? 'qThemeLight' : 'qThemeDark')}</button>)}</div></div>
        {smart.editing && smart.editor ? smart.editor : <div className="qyt-editor-preview" style={{ touchAction: 'none' }} onPointerDown={e => { if (!draft.image || busy) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { pointer: e.pointerId, left: e.clientX, top: e.clientY, x: draft.x, y: draft.y } }} onPointerMove={e => {
          const start = drag.current; if (!start || start.pointer !== e.pointerId || busy) return
          const rect = e.currentTarget.getBoundingClientRect()
          setDraft(current => ({ ...current, x: Math.max(0, Math.min(100, start.x - (e.clientX - start.left) / rect.width * 100)), y: Math.max(0, Math.min(100, start.y - (e.clientY - start.top) / rect.height * 100)) }))
        }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
          {draft.image ? <ThemePreview ctx={ctx} form={previewForm} theme={previewTheme} title={t('qThemeLivePreview')} appearance={appearance} onMotionStatus={setMotionStatus}/> : <span>{t('qThemePreviewEmpty')}</span>}
        </div>}
        {!smart.editing && draft.smartMotion && <p className={motionStatus === 'failed' ? 'qyt-editor-error' : 'qyt-motion-preview-status'} role="status">{motionStatus === 'failed' ? t('qThemeAiRendererFailed') : motionStatus === 'reduced' ? t('qThemeAiSystemStatic') : motionStatus === 'playing' ? '▶ ' + t('qThemeAiPlaying') : motionStatus === 'loading' ? t('qThemeAiBuilding') : t('qThemeMotionStatic')}</p>}
        <div className="qyt-editor-framing"><small>{t('qThemeDragHint')}</small>
        {range('zoom', 'qThemeImageZoom', 1, 2, .01, `${Math.round(draft.zoom * 100)}%`)}
        <div className="qyt-editor-columns">{range('x', 'qThemeImageX', 0, 100, 1, `${Math.round(draft.x)}%`)}{range('y', 'qThemeImageY', 0, 100, 1, `${Math.round(draft.y)}%`)}</div></div>
        </section>
        <section className="qyt-editor-inspector">
        <div className="qyt-editor-inspector-tabs" role="tablist" aria-label={t('qThemeEditorSections')}>{(['image', 'motion', 'atmosphere'] as const).map(value => <button key={value} type="button" role="tab" id={`${id}-tab-${value}`} aria-controls={`${id}-panel-${value}`} aria-selected={panel === value} tabIndex={panel === value ? 0 : -1} onClick={() => setPanel(value)} onKeyDown={event => {
          const choices = ['image', 'motion', 'atmosphere'] as const, index = choices.indexOf(value)
          const next = event.key === 'ArrowRight' ? choices[(index + 1) % 3] : event.key === 'ArrowLeft' ? choices[(index + 2) % 3] : event.key === 'Home' ? 'image' : event.key === 'End' ? 'atmosphere' : null
          if (next) { event.preventDefault(); setPanel(next); document.getElementById(`${id}-tab-${next}`)?.focus() }
        }}>{t(value === 'image' ? 'qThemeImageTab' : value === 'motion' ? 'qThemeMotionTab' : 'qThemeAtmosphereTab')}</button>)}</div>
        <div className="qyt-editor-inspector-content">
        <section role="tabpanel" id={`${id}-panel-image`} aria-labelledby={`${id}-tab-image`} hidden={panel !== 'image'}>
        <label className="qyt-editor-field">{t('qThemeCustomName')}<input autoFocus maxLength={40} value={draft.name} placeholder={t('qThemeCustomNamePlaceholder')} onChange={e => change('name', e.target.value)}/></label>
        <div className="qyt-editor-field"><span>{t('qThemeImage')}</span><button type="button" className="qyt-editor-upload" onClick={() => file.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void upload(e.dataTransfer.files[0]) }}>
          {draft.image && <img src={draft.image} alt=""/>}<span>{loading ? t('qThemeImageLoading') : draft.image ? `${t('qThemeReplaceImage')} · ${draft.width} × ${draft.height}` : t('qThemeUploadImage')}</span><span aria-hidden="true">↑</span>
        </button><input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-label={t('qThemeUploadImage')} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }}/><small>{t('qThemeImageHint')}</small></div>
        <button className="qyt-editor-next" type="button" disabled={!draft.image || busy} onClick={() => setPanel('motion')}>{t('qThemeNextMotion')} <span aria-hidden="true">→</span></button>
        </section>
        <section role="tabpanel" id={`${id}-panel-motion`} aria-labelledby={`${id}-tab-motion`} hidden={panel !== 'motion'}>{smart.controls}</section>
        <section role="tabpanel" id={`${id}-panel-atmosphere`} aria-labelledby={`${id}-tab-atmosphere`} hidden={panel !== 'atmosphere'}>
        <fieldset disabled={busy || draft.motion === 'static'}>          <div className="qyt-editor-effect-group"><span>{t('qThemeMovement')}</span><div className="qyt-editor-pills">{THEME_MOVEMENTS.map(value => <button type="button" key={value} aria-pressed={draft.movement === value} onClick={() => change('movement', value)}>{t(movementLabels[value])}</button>)}</div></div>
          <div className="qyt-editor-effect-group"><span>{t('qThemeAtmosphere')}</span><div className="qyt-editor-pills qyt-atmosphere-choices">{THEME_ATMOSPHERES.map(value => <button type="button" key={value} aria-pressed={draft.atmosphere === value} onClick={() => change('atmosphere', value)}><span className={`qyt-effect-icon qyt-effect-icon-${value}`} aria-hidden="true"/>{t(atmosphereLabels[value])}</button>)}</div></div>
          <ThemeColorWheel value={draft.atmosphereColor ?? ATMOSPHERE_COLORS[draft.atmosphere]} automatic={!draft.atmosphereColor} disabled={busy || draft.motion === 'static' || draft.atmosphere === 'none'} t={t} onChange={color => change('atmosphereColor', color)} onReset={() => change('atmosphereColor', undefined)}/>
        </fieldset>
        <div className="qyt-editor-options"><label htmlFor={`${id}-color`}>{t('qThemeColor')}</label><input id={`${id}-color`} type="color" value={draft.accent} onChange={e => change('accent', e.target.value)}/><button type="button" disabled={!draft.image} onClick={() => change('accent', extracted)}>{t('qThemeExtractColor')}</button></div>
        {range('mask', 'qThemeReadingMask', .5, 1, .01, `${Math.round(draft.mask * 100)}%`)}
        </section>
        </div>
        <div className="qyt-editor-playback"><div className="qyt-editor-section"><strong>{t('qThemePlayback')}</strong><div className="qyt-editor-pills">{(['dynamic', 'static'] as const).map(mode => <button type="button" key={mode} aria-pressed={draft.motion === mode} onClick={() => change('motion', mode)}>{t(mode === 'dynamic' ? 'qThemeMotionDynamic' : 'qThemeMotionStatic')}</button>)}</div></div><fieldset disabled={busy || draft.motion === 'static'}>          <div className="qyt-editor-columns">{range('intensity', 'qThemeIntensity', 0, 1, .05, `${Math.round(draft.intensity * 100)}%`)}{range('speed', 'qThemeSpeed', .1, 5, .05, `${draft.speed.toFixed(2)}×`)}</div>
</fieldset></div>
        </section>
      </fieldset>
      {error && <p role="alert" className="qyt-editor-error">{t(error)}</p>}
      <button type="submit" hidden disabled={busy}/>
    </form>
    <footer>{original && onDelete && <div className="qyt-editor-delete">{deleting ? <><button type="button" disabled={busy} onClick={() => { void remove() }}>{t('qThemeConfirmDelete')}</button><button type="button" disabled={busy} onClick={() => setDeleting(false)}>{t('qThemeCancel')}</button></> : <button type="button" disabled={busy} onClick={() => setDeleting(true)}>{t('qThemeDelete')}</button>}</div>}<span/><button type="button" disabled={saving} onClick={() => { void close() }}>{t('qThemeCancel')}</button><button type="button" className="qyt-editor-save" disabled={busy || smart.pending || !draft.image || !draft.name.trim()} onClick={() => { void save() }}>{saving ? t('saving') : t('qThemeSaveApply')}</button></footer>
  </dialog>, document.body)
}
