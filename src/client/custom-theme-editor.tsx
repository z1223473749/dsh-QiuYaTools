import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_PREFERENCES, type Preferences } from '../shared.ts'
import { isCustomTheme, type CustomTheme } from '../custom-themes.ts'
import { createCustomTheme } from './custom-theme-definition.ts'
import { ThemePreview } from './theme-preview.tsx'
import { importThemeImage } from './theme-image.ts'
import type { LocaleKey } from './locales.ts'

export function CustomThemeEditor({ ctx, original, disabled, t, onClose, onSave, onDelete }: {
  ctx: Context; original?: CustomTheme; disabled: boolean; t: (key: LocaleKey) => string; onClose(): void
  onSave(theme: CustomTheme): Promise<boolean>; onDelete?(id: CustomTheme['id']): Promise<boolean>
}) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), file = useRef<HTMLInputElement>(null)
  const alive = useRef(true), importGeneration = useRef(0)
  const [draft, setDraft] = useState<CustomTheme>(() => original ?? {
    id: `custom:${crypto.randomUUID()}`, name: '', image: '', width: 1, height: 1, accent: '#ad563e',
    motion: 'dynamic', movement: 'parallax', atmosphere: 'glow', intensity: .35, speed: .45, x: 50, y: 62, zoom: 1, mask: .9,
  })
  const [appearance, setAppearance] = useState<'light' | 'dark'>('light')
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<LocaleKey | null>(null), [extracted, setExtracted] = useState(draft.accent)
  const busy = disabled || loading || saving
  const drag = useRef<{ pointer: number; left: number; top: number; x: number; y: number } | null>(null)
  const change = <K extends keyof CustomTheme>(key: K, value: CustomTheme[K]) => { setDraft(current => ({ ...current, [key]: value })); setError(null) }
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
      const result = await importThemeImage(image)
      if (!alive.current || generation !== importGeneration.current) return
      setDraft(current => ({ ...current, ...result, x: 50, y: 50, zoom: 1, name: current.name || image.name.replace(/\.[^.]+$/, '').slice(0, 40) }))
      setExtracted(result.accent)
    } catch (err) {
      if (alive.current && generation === importGeneration.current) setError(err instanceof Error && err.message === 'qThemeImageLarge' ? 'qThemeImageLarge' : 'qThemeImageInvalid')
    } finally { if (alive.current && generation === importGeneration.current) setLoading(false) }
  }
  async function save(): Promise<void> {
    if (busy) return
    const value = { ...draft, name: draft.name.trim() }
    if (!isCustomTheme(value)) { setError('qThemeCustomRequired'); return }
    setSaving(true); setError(null)
    try { if (!await onSave(value) && alive.current) setError('qThemeCustomSaveError') }
    catch { if (alive.current) setError('qThemeCustomSaveError') }
    finally { if (alive.current) setSaving(false) }
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
  return createPortal(<dialog ref={dialog} className="qyt-custom-dialog" style={{ '--editor-accent': previewTheme.accent } as React.CSSProperties} aria-labelledby={`${id}-title`} onCancel={e => { e.preventDefault(); if (!saving) onClose() }}>
    <header><div><h3 id={`${id}-title`}>{t('qThemeCustom')}</h3><p>{t('qThemeCustomIntro')}</p></div><button type="button" aria-label={t('qThemeClose')} disabled={saving} onClick={onClose}>×</button></header>
    <form className="qyt-editor-body" onSubmit={e => { e.preventDefault(); void save() }}>
      <fieldset disabled={busy}>
        <label className="qyt-editor-field">{t('qThemeCustomName')}<input autoFocus maxLength={40} value={draft.name} placeholder={t('qThemeCustomNamePlaceholder')} onChange={e => change('name', e.target.value)}/></label>
        <div className="qyt-editor-field"><span>{t('qThemeImage')}</span><button type="button" className="qyt-editor-upload" onClick={() => file.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void upload(e.dataTransfer.files[0]) }}>
          {draft.image && <img src={draft.image} alt=""/>}<span>{loading ? t('qThemeImageLoading') : draft.image ? `${t('qThemeReplaceImage')} · ${draft.width} × ${draft.height}` : t('qThemeUploadImage')}</span><span aria-hidden="true">↑</span>
        </button><input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-label={t('qThemeUploadImage')} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }}/><small>{t('qThemeImageHint')}</small></div>
        <div className="qyt-editor-section"><strong>{t('qThemeLivePreview')}</strong><div className="qyt-editor-pills">{(['light', 'dark'] as const).map(mode => <button type="button" key={mode} aria-pressed={appearance === mode} onClick={() => setAppearance(mode)}>{t(mode === 'light' ? 'qThemeLight' : 'qThemeDark')}</button>)}</div></div>
        <div className="qyt-editor-preview" style={{ touchAction: 'none' }} onPointerDown={e => { if (!draft.image || busy) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { pointer: e.pointerId, left: e.clientX, top: e.clientY, x: draft.x, y: draft.y } }} onPointerMove={e => {
          const start = drag.current; if (!start || start.pointer !== e.pointerId || busy) return
          const rect = e.currentTarget.getBoundingClientRect()
          setDraft(current => ({ ...current, x: Math.max(0, Math.min(100, start.x - (e.clientX - start.left) / rect.width * 100)), y: Math.max(0, Math.min(100, start.y - (e.clientY - start.top) / rect.height * 100)) }))
        }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
          {draft.image ? <ThemePreview ctx={ctx} form={previewForm} theme={previewTheme} title={t('qThemeLivePreview')} appearance={appearance}/> : <span>{t('qThemePreviewEmpty')}</span>}
        </div>
        <small>{t('qThemeDragHint')}</small>
        {range('zoom', 'qThemeImageZoom', 1, 2, .01, `${Math.round(draft.zoom * 100)}%`)}
        <div className="qyt-editor-columns">{range('x', 'qThemeImageX', 0, 100, 1, `${Math.round(draft.x)}%`)}{range('y', 'qThemeImageY', 0, 100, 1, `${Math.round(draft.y)}%`)}</div>
        <div className="qyt-editor-section"><strong>{t('qThemeEffects')}</strong><div className="qyt-editor-pills">{(['dynamic', 'static'] as const).map(mode => <button type="button" key={mode} aria-pressed={draft.motion === mode} onClick={() => change('motion', mode)}>{t(mode === 'dynamic' ? 'qThemeMotionDynamic' : 'qThemeMotionStatic')}</button>)}</div></div>
        <fieldset disabled={busy || draft.motion === 'static'}>
          <div className="qyt-editor-options"><span>{t('qThemeMovement')}</span><div className="qyt-editor-pills">{(['parallax', 'pan', 'none'] as const).map(value => <button type="button" key={value} aria-pressed={draft.movement === value} onClick={() => change('movement', value)}>{t(value === 'parallax' ? 'qThemeParallax' : value === 'pan' ? 'qThemePan' : 'qThemeNone')}</button>)}</div></div>
          <div className="qyt-editor-options"><span>{t('qThemeAtmosphere')}</span><div className="qyt-editor-pills">{(['glow', 'petals', 'snow', 'none'] as const).map(value => <button type="button" key={value} aria-pressed={draft.atmosphere === value} onClick={() => change('atmosphere', value)}>{t(value === 'glow' ? 'qThemeGlow' : value === 'petals' ? 'qThemePetals' : value === 'snow' ? 'qThemeSnow' : 'qThemeNone')}</button>)}</div></div>
          <div className="qyt-editor-columns">{range('intensity', 'qThemeIntensity', 0, 1, .05, `${Math.round(draft.intensity * 100)}%`)}{range('speed', 'qThemeSpeed', .1, 2, .05, `${draft.speed.toFixed(2)}×`)}</div>
        </fieldset>
        <div className="qyt-editor-options"><label htmlFor={`${id}-color`}>{t('qThemeColor')}</label><input id={`${id}-color`} type="color" value={draft.accent} onChange={e => change('accent', e.target.value)}/><button type="button" disabled={!draft.image} onClick={() => change('accent', extracted)}>{t('qThemeExtractColor')}</button></div>
        {range('mask', 'qThemeReadingMask', .5, 1, .01, `${Math.round(draft.mask * 100)}%`)}
      </fieldset>
      {error && <p role="alert" className="qyt-editor-error">{t(error)}</p>}
      <button type="submit" hidden disabled={busy}/>
    </form>
    <footer>{original && onDelete && <div className="qyt-editor-delete">{deleting ? <><button type="button" disabled={busy} onClick={() => { void remove() }}>{t('qThemeConfirmDelete')}</button><button type="button" disabled={busy} onClick={() => setDeleting(false)}>{t('qThemeCancel')}</button></> : <button type="button" disabled={busy} onClick={() => setDeleting(true)}>{t('qThemeDelete')}</button>}</div>}<span/><button type="button" disabled={saving} onClick={onClose}>{t('qThemeCancel')}</button><button type="button" className="qyt-editor-save" disabled={busy || !draft.image || !draft.name.trim()} onClick={() => { void save() }}>{saving ? t('saving') : t('qThemeSaveApply')}</button></footer>
  </dialog>, document.body)
}
