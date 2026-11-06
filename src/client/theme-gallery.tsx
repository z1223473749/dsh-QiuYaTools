import React, { useEffect, useId, useRef, useState } from 'react'
import type { QThemeId } from '../shared.ts'
import type { LocaleKey } from './locales.ts'
import type { ThemeDefinition } from './theme-catalog.ts'

export function ThemeGalleryIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9" r="1.5"/><path d="m4 17 4-4 3 3 4-5 5 6"/></svg>
}

export function ThemeEditIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4.5-1 12-12a2.8 2.8 0 0 0-4-4l-12 12L4 20z"/></svg>
}

export type ThemeEditorKind = 'smart' | 'video'

function ThemeEditorIcon({ kind }: { kind: ThemeEditorKind }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'smart'
      ? <><path d="M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6M4 17l5-4 4 4 3-3 4 4"/><path d="M18 2c0 3-1 4-4 4 3 0 4 1 4 4 0-3 1-4 4-4-3 0-4-1-4-4Z"/></>
      : <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16m10-16v16M3 9h4m10 0h4M3 15h4m10 0h4m-10-6 4 3-4 3z"/></>}
  </svg>
}

function ThemeDeleteDialog({ name, t, onConfirm, onClose }: {
  name: string
  t: (key: LocaleKey) => string
  onConfirm: () => Promise<boolean>
  onClose: (deleted: boolean) => void
}) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])

  function close(deleted: boolean) {
    dialog.current?.close()
    onClose(deleted)
  }

  return <dialog ref={dialog} role="alertdialog" className="qyt-theme-delete-dialog" aria-labelledby={id} aria-describedby={`${id}-name`}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!saving) close(false) }}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}>
    <h4 id={id}>{t('qThemeDelete')}</h4>
    <p id={`${id}-name`}>{name}</p>
    {failed && <p role="alert">{t('saveError')}</p>}
    <footer>
      <button type="button" autoFocus className="qyt-button" disabled={saving} onClick={() => close(false)}>{t('qThemeCancel')}</button>
      <button type="button" className="qyt-button qyt-theme-delete-confirm" disabled={saving} onClick={async () => {
        setSaving(true)
        setFailed(false)
        if (await onConfirm()) close(true)
        else { setSaving(false); setFailed(true) }
      }}>{t(saving ? 'saving' : 'qThemeConfirmDelete')}</button>
    </footer>
  </dialog>
}

export function ThemeGallery({ themes, themeId, disabled, saving, atCustomLimit, t, onSelect, onEdit, onDelete, onClose, onCreate }: {
  themes: readonly ThemeDefinition[]
  themeId: QThemeId
  disabled: boolean
  saving: boolean
  atCustomLimit: boolean
  t: (key: LocaleKey) => string
  onSelect: (themeId: QThemeId) => Promise<boolean>
  onEdit: (themeId: QThemeId) => void
  onDelete: (themeId: QThemeId, revision: string | undefined) => Promise<boolean>
  onClose: () => void
  onCreate: (kind: ThemeEditorKind) => void
}) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const create = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [failed, setFailed] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ThemeDefinition>()
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])

  function close() {
    if (!dialog.current) return
    dialog.current.close()
    onClose()
  }

  return <dialog ref={dialog} className="qyt-theme-gallery" aria-labelledby={id}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); close() }}
    onKeyDown={event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (creating) { event.preventDefault(); setCreating(false); create.current?.focus() }
    }}
    onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <header className="qyt-theme-gallery-header">
      <span className="qyt-theme-gallery-emblem"><ThemeGalleryIcon/></span>
      <div className="qyt-theme-gallery-title">
        <h3 id={id}>{t('qThemeGallery')}</h3>
        {failed ? <p role="alert">{t('saveError')}</p> : <p role="status">{t(saving ? 'saving' : 'qThemeGalleryIntro')}</p>}
      </div>
      <div className="qyt-theme-create-menu"
        onPointerEnter={event => { if (event.pointerType === 'mouse' && !disabled && !atCustomLimit) setCreating(true) }}
        onPointerLeave={event => { if (event.pointerType === 'mouse' && !event.currentTarget.contains(document.activeElement)) setCreating(false) }}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setCreating(false) }}>
        <button type="button" ref={create} className="qyt-button qyt-button-primary qyt-theme-gallery-create"
          aria-expanded={creating} aria-controls={`${id}-create`}
          disabled={disabled || atCustomLimit} title={atCustomLimit ? t('qThemeCustomLimit') : undefined}
          onClick={event => setCreating(open => event.detail === 0 ? !open : true)}>{t('qThemeNew')}
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
        </button>
        <div className="qyt-theme-create-options" id={`${id}-create`} hidden={!creating} role="group" aria-label={t('qThemeNew')}>
          {(['smart', 'video'] as const).map(kind => <button key={kind} type="button" disabled={disabled || atCustomLimit}
            onClick={() => { create.current?.focus(); setCreating(false); onCreate(kind) }}>
            <ThemeEditorIcon kind={kind}/>{t(kind === 'smart' ? 'qThemeCreateSmart' : 'qThemeGalleryVideos')}
          </button>)}
        </div>
      </div>
      <button ref={closeButton} type="button" autoFocus className="qyt-button qyt-theme-gallery-close" aria-label={t('qThemeClose')} onClick={close}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>
      </button>
    </header>
    <div className="qyt-theme-gallery-body">
      {([true, false] as const).map(video => {
        const entries = themes.filter(option => Boolean(option.video) === video)
        return <section key={String(video)} className="qyt-theme-gallery-section" data-kind={video ? 'video' : 'image'} aria-labelledby={`${id}-${video}`}>
          <div className="qyt-theme-gallery-section-heading">
            <span className="qyt-theme-gallery-section-icon">{video ? <ThemeEditorIcon kind="video"/> : <ThemeGalleryIcon/>}</span>
            <h4 id={`${id}-${video}`}>{t(video ? 'qThemeGalleryVideos' : 'qThemePickerTitle')}</h4>
            <span className="qyt-theme-gallery-count" aria-hidden="true">{entries.length}</span>
          </div>
          <div className="qyt-theme-gallery-grid">
            {entries.map(option => {
              const selected = option.id === themeId
              const custom = option.id.startsWith('custom:')
              const name = option.displayName ?? t(option.name)
              return <div className="qyt-theme-gallery-tile" data-custom={custom || undefined} key={option.id}>
                <button type="button" className="qyt-theme-gallery-card" data-theme={option.id} disabled={disabled && !saving} aria-disabled={saving || undefined} aria-pressed={selected}
                  onClick={async () => {
                    if (disabled) return
                    setFailed(false)
                    if (!await onSelect(option.id)) setFailed(true)
                  }}>
                  <span className="qyt-theme-gallery-art" aria-hidden="true" style={{ backgroundImage: `url("${option.art}")`, backgroundPosition: option.previewPosition }}>
                    {video && <span className="qyt-theme-gallery-play"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.5v9l7-4.5z"/></svg></span>}
                    {selected && <span className="qyt-theme-gallery-selected"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 8 3 3 5-6"/></svg></span>}
                  </span>
                  <span className="qyt-theme-gallery-label" title={name}>{name}</span>
                </button>
                {custom && <div className="qyt-theme-gallery-actions">
                  <button type="button" title={t('qThemeGalleryEdit')} aria-label={`${t('qThemeGalleryEdit')} · ${name}`} disabled={disabled} onClick={() => onEdit(option.id)}>
                    <ThemeEditIcon/>
                  </button>
                  <button type="button" title={t('qThemeDelete')} aria-label={`${t('qThemeDelete')} · ${name}`} disabled={disabled} onClick={() => setDeleting(option)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/></svg>
                  </button>
                </div>}
              </div>
            })}
          </div>
        </section>
      })}
    </div>
    {deleting && <ThemeDeleteDialog name={deleting.displayName ?? t(deleting.name)} t={t}
      onConfirm={() => onDelete(deleting.id, deleting.revision)}
      onClose={deleted => { setDeleting(undefined); if (deleted) closeButton.current?.focus() }}/>}
  </dialog>
}
