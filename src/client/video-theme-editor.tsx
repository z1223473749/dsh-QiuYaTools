import React, { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import { isCustomTheme, type CustomTheme } from '../custom-themes.ts'
import { readMp4Tracks } from '../theme-video.ts'
import { importThemeImage } from './theme-image.ts'
import { ThemePreview } from './theme-preview.tsx'
import { discardLocalThemeVideo, localThemeVideoInfo, saveLocalThemeVideo } from './theme-video-api.ts'
import type { LocaleKey } from './locales.ts'

type Cover = Pick<CustomTheme, 'image' | 'width' | 'height' | 'accent'>
type VideoOptions = NonNullable<CustomTheme['video']>
type Clip = { size: number; audio: boolean } & ({ file: File; url?: never } | { file?: never; url: string })
const bounds = (value: number) => Math.round(Math.max(0, Math.min(100, value)))

function VideoIcon({ name }: { name: 'film' | 'upload' | 'image' | 'sidebar' | 'sound' | 'play' | 'pause' | 'close' }) {
  const paths = {
    film: 'M4 5h16v14H4zM8 5v14m8-14v14M4 9h4m8 0h4M4 15h4m8 0h4',
    upload: 'M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
    sidebar: 'M4 5h16v14H4zM9 5v14',
    sound: 'M4 9h4l4-4v14l-4-4H4zM16 9a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10',
    play: 'm9 5 11 7-11 7z',
    pause: 'M9 5v14m6-14v14',
    close: 'm6 6 12 12M18 6 6 18',
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>
}

function timecode(seconds: number): string {
  const hundredths = Math.round(seconds * 100)
  return `${Math.floor(hundredths / 6000)}:${((hundredths % 6000) / 100).toFixed(2).padStart(5, '0')}`
}

async function captureFrame(video: HTMLVideoElement): Promise<Cover> {
  const canvas = video.ownerDocument.createElement('canvas')
  const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight))
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw Error('invalid-frame')
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', .94))
  if (!blob) throw Error('invalid-frame')
  const { image, width, height, accent } = await importThemeImage(new File([blob], 'frame.webp', { type: blob.type }))
  return { image, width, height, accent }
}

export function VideoThemeEditor({ ctx, original, disabled, t, onClose, onSave, onDelete }: {
  ctx: Context
  original?: CustomTheme
  disabled: boolean
  t: (key: LocaleKey) => string
  onClose(): void
  onSave(value: CustomTheme): Promise<boolean>
  onDelete?(id: CustomTheme['id']): Promise<boolean>
}) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const player = useRef<HTMLVideoElement>(null)
  const drag = useRef<{ pointer: number; left: number; top: number; x: number; y: number } | null>(null)
  const dropDepth = useRef(0)
  const generation = useRef(0)
  const alive = useRef(true)
  const upload = useRef<AbortController>()
  const [themeId] = useState<CustomTheme['id']>(() => original?.id ?? `custom:${crypto.randomUUID()}`)
  const [name, setName] = useState(original?.name ?? '')
  const [fileName, setFileName] = useState('')
  const [dropping, setDropping] = useState(false)
  const [manualAccent, setManualAccent] = useState(original?.video?.coverAccent ? original.accent : undefined)
  const [mask, setMask] = useState(original?.mask ?? .9)
  const [cover, setCover] = useState<Cover | undefined>(() => original && ({
    image: original.image, width: original.width, height: original.height, accent: original.video?.coverAccent ?? original.accent,
  }))
  const [options, setOptions] = useState<Omit<VideoOptions, 'assetId' | 'coverAccent'>>(() => {
    const video = original?.video
    return { sound: video?.sound ?? false, sidebar: video?.sidebar ?? 'video', x: video?.x ?? 50, y: video?.y ?? 50,
      zoom: video?.zoom ?? 1, frame: video?.frame ?? 0 }
  })
  const [clip, setClip] = useState<Clip>()
  const [source, setSource] = useState('')
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(!!original)
  const [saving, setSaving] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [listening, setListening] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [view, setView] = useState<'frames' | 'workspace' | 'settings'>('frames')
  const [appearance, setAppearance] = useState<'light' | 'dark'>(() => document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light')
  const [previewMotion, setPreviewMotion] = useState<'dynamic' | 'static'>('dynamic')
  const [error, setError] = useState<LocaleKey>()
  const busy = disabled || saving
  const canClose = !saving || Boolean(upload.current)
  const assetId = original?.video?.assetId
  const sidebarZoom = options.zoom ?? 1

  useEffect(() => {
    alive.current = true
    const element = dialog.current
    element?.showModal()
    return () => { alive.current = false; generation.current++; upload.current?.abort(); element?.close() }
  }, [])
  useEffect(() => {
    if (!assetId) return
    const abort = new AbortController()
    const current = generation.current
    void localThemeVideoInfo(assetId, abort.signal).then(resource => {
      if (abort.signal.aborted || current !== generation.current) return
      setClip(resource)
    }).catch(() => {
      if (!abort.signal.aborted && current === generation.current) setError('qThemeVideoUnavailable')
    }).finally(() => {
      if (!abort.signal.aborted && current === generation.current) setLoading(false)
    })
    return () => abort.abort()
  }, [assetId])
  useEffect(() => {
    if (!clip) return
    if (clip.file) {
      const url = URL.createObjectURL(clip.file)
      setSource(url)
      return () => URL.revokeObjectURL(url)
    }
    setSource(clip.url)
  }, [clip])
  useEffect(() => {
    if (!listening) return
    const doc = player.current?.ownerDocument
    const stop = () => { player.current?.pause() }
    const visibility = () => { if (doc?.hidden) stop() }
    doc?.addEventListener('visibilitychange', visibility)
    doc?.defaultView?.addEventListener('blur', stop)
    return () => {
      doc?.removeEventListener('visibilitychange', visibility)
      doc?.defaultView?.removeEventListener('blur', stop)
    }
  }, [listening])

  async function importVideo(file?: File) {
    if (!file || busy) return
    const current = ++generation.current
    setCapturing(false)
    setLoading(true)
    setError(undefined)
    try {
      const tracks = await readMp4Tracks(file.size, async (offset, count) => {
        if (generation.current !== current) throw Error('superseded')
        return new Uint8Array(await file.slice(offset, offset + count).arrayBuffer())
      })
      if (!tracks.video) throw Error('qThemeVideoInvalid')
      if (generation.current !== current) return
      player.current?.pause()
      setListening(false)
      setCapturing(false)
      setReady(false)
      setDuration(0)
      setTime(0)
      setCover(undefined)
      const stem = file.name.replace(/\.[^.]+$/, '')
      setName(name => name || (/^[a-f0-9-]{24,}$/i.test(stem) ? t('qThemeVideoDefaultName') : stem.slice(0, 40)))
      setFileName(file.name)
      setOptions(value => ({ ...value, frame: 0, sound: tracks.audio && value.sound }))
      setClip({ file, size: file.size, audio: tracks.audio })
    } catch {
      if (generation.current === current) setError('qThemeVideoInvalid')
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }

  function metadata(video: HTMLVideoElement) {
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
      setError('qThemeVideoInvalid')
      return
    }
    setDuration(video.duration)
    const position = clip?.file ? Math.min(.35, video.duration / 4) : options.frame
    if (position > 0) video.currentTime = Math.min(position, Math.max(0, video.duration - .01))
  }

  async function selectFrame(video: HTMLVideoElement) {
    if (video.seeking || !duration || video.readyState < 2 || capturing) return
    video.pause()
    const current = generation.current, frame = video.currentTime
    setCapturing(true)
    setError(undefined)
    try {
      const image = await captureFrame(video)
      if (generation.current !== current) return
      setCover(image)
      setOptions(value => ({ ...value, frame }))
    } catch {
      if (generation.current === current) setError('qThemeVideoFrameError')
    } finally {
      if (generation.current === current) setCapturing(false)
    }
  }

  function frameReady(video: HTMLVideoElement) {
    if (video.seeking || video.readyState < 2 || !duration) return
    setReady(true)
    setTime(video.currentTime)
    if (!cover && !capturing) void selectFrame(video)
  }

  function draftTheme(image: Cover, id: string, motion: CustomTheme['motion']): CustomTheme {
    return {
      id: themeId, name: name.trim() || t('qThemeVideoDefaultName'), ...image, accent: manualAccent ?? image.accent, motion,
      movement: 'none', atmosphere: 'none', intensity: 0, speed: 1, x: 50, y: 50, zoom: 1, mask,
      video: { ...options, sound: Boolean(clip?.audio && options.sound), assetId: id,
        ...(manualAccent ? { coverAccent: image.accent } : {}) },
    }
  }

  async function save() {
    if (busy || loading || capturing || !clip || !ready || !cover || !name.trim()) return
    player.current?.pause()
    setSaving(true)
    setError(undefined)
    let uploaded: string | undefined
    let saved = false
    try {
      if (clip.file) {
        const abort = new AbortController()
        upload.current = abort
        try {
          uploaded = await saveLocalThemeVideo(clip.file, abort.signal)
          abort.signal.throwIfAborted()
        } finally { upload.current = undefined }
      }
      const value = draftTheme(cover, uploaded ?? assetId ?? '', original?.motion ?? 'dynamic')
      if (!isCustomTheme(value) || !await onSave(value)) throw Error('save-failed')
      saved = true
    } catch (error) {
      if (alive.current) setError(error instanceof Error && error.message === 'video-storage-full' ? 'qThemeVideoStorageFull' : 'qThemeCustomSaveError')
    } finally {
      if (uploaded && !saved) await discardLocalThemeVideo(uploaded).catch(() => {})
      if (alive.current) setSaving(false)
    }
  }

  async function remove() {
    if (!onDelete || busy) return
    setSaving(true)
    try {
      if (!await onDelete(themeId) && alive.current) setError('qThemeCustomSaveError')
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  function close() {
    if (!canClose) return
    upload.current?.abort()
    dialog.current?.close()
    onClose()
  }

  return createPortal(<dialog ref={dialog} className="qyt-video-editor" aria-labelledby={id}
    onDragEnterCapture={event => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      event.stopPropagation()
      dropDepth.current++
      setDropping(!busy)
    }}
    onDragOverCapture={event => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
    }}
    onDragLeaveCapture={event => {
      if (!dropDepth.current) return
      event.stopPropagation()
      if (!--dropDepth.current) setDropping(false)
    }}
    onDropCapture={event => {
      if (!event.dataTransfer.types.includes('Files') && !event.dataTransfer.files.length) return
      event.preventDefault()
      event.stopPropagation()
      dropDepth.current = 0
      setDropping(false)
      void importVideo(event.dataTransfer.files[0])
    }}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); close() }}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}>
    <header>
      <span className="qyt-video-editor-emblem"><VideoIcon name="film"/></span>
      <div><h3 id={id}>{t(original ? 'qThemeVideoEdit' : 'qThemeVideoNew')}</h3><p>{t('qThemeVideoEditorIntro')}</p></div>
      <button className="qyt-video-close" type="button" aria-label={t('qThemeClose')} disabled={!canClose} onClick={close}><VideoIcon name="close"/></button>
    </header>
    <fieldset className="qyt-video-editor-content" disabled={busy}>
      <section className="qyt-video-stage">
        <label className="qyt-video-upload">
          <span className="qyt-video-upload-icon"><VideoIcon name="upload"/></span>
          <span className="qyt-video-upload-text">
            <strong title={fileName || undefined}>{fileName || t(clip ? 'qThemeVideoSavedFile' : 'qThemeVideoFile')}</strong>
            <small>{clip ? `MP4 · ${(clip.size / 1024 / 1024).toFixed(1)} MiB` : t('qThemeVideoImportHint')}</small>
          </span>
          {clip && <span className="qyt-video-upload-cta">{t('qThemeVideoReplace')}</span>}
          <input aria-label={t('qThemeVideoFile')} type="file" accept=".mp4,video/mp4" onChange={event => {
            void importVideo(event.currentTarget.files?.[0])
            event.currentTarget.value = ''
          }}/>
        </label>
        <div className="qyt-video-views" role="group" aria-label={t('qThemeLivePreview')}>
          {(['frames', 'workspace', 'settings'] as const).map(mode => <button type="button" key={mode} aria-pressed={view === mode}
            onClick={() => { if (mode !== 'frames') player.current?.pause(); setView(mode) }}>
            {t(mode === 'frames' ? 'qThemeVideoViewFrames' : mode === 'workspace' ? 'qThemeVideoViewWorkspace' : 'qThemeVideoViewSettings')}
          </button>)}
        </div>
        <div className="qyt-video-player" hidden={view !== 'frames'}>
          <div className="qyt-video-canvas">
            {loading && <span role="status" className="qyt-video-loading">{t('loading')}</span>}
            {!source && <div className="qyt-video-empty"><VideoIcon name="film"/><span>{t('qThemeVideoEmpty')}</span></div>}
            {source && <video key={source} ref={player} src={source} preload="auto" playsInline muted={!listening}
              aria-label={t('qThemeVideoFrame')}
              onLoadedMetadata={event => metadata(event.currentTarget)}
              onLoadedData={event => frameReady(event.currentTarget)}
              onSeeked={event => frameReady(event.currentTarget)}
              onPlay={() => setPlaying(true)}
              onPause={() => { setPlaying(false); setListening(false) }}
              onEnded={() => { setPlaying(false); setListening(false) }}
              onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
              onError={() => { setReady(false); setError('qThemeVideoInvalid') }}/>}
          </div>
          <div className="qyt-video-transport">
            <input aria-label={t('qThemeVideoFrame')} className="qyt-video-timeline" type="range" min={0} max={Math.max(0, duration - .01)} step={.01} value={Math.min(time, Math.max(0, duration - .01))} disabled={!duration || loading || capturing}
              onChange={event => {
                const video = player.current
                if (!video) return
                video.pause()
                setReady(false)
                video.currentTime = Number(event.currentTarget.value)
                setTime(video.currentTime)
                if (!video.seeking) frameReady(video)
              }}/>
            <div className="qyt-video-actions">
              <button className="qyt-video-play" type="button" aria-label={t(playing ? 'qThemeVideoPause' : 'qThemeVideoPlay')} disabled={!ready || loading} onClick={() => {
                const video = player.current
                if (!video) return
                if (!video.paused) video.pause()
                else { video.muted = true; void video.play().catch(() => setError('qThemeVideoInvalid')) }
              }}><VideoIcon name={playing ? 'pause' : 'play'}/></button>
              <output className="qyt-video-time">{timecode(time)} <span>/ {timecode(duration)}</span></output>
              <button className="qyt-video-capture" type="button" disabled={!ready || capturing || loading} onClick={() => { if (player.current) void selectFrame(player.current) }}>
                <VideoIcon name="image"/>{t('qThemeVideoSetCover')}
              </button>
            </div>
          </div>
        </div>
        {view !== 'frames' && <div className="qyt-video-live">
          {cover ? <ThemePreview key={view} ctx={ctx} appearance={appearance}
            title={t(view === 'workspace' ? 'qThemeVideoViewWorkspace' : 'qThemeVideoViewSettings')}
            draftVideo={{ theme: draftTheme(cover, assetId ?? '00000000-0000-0000-0000-000000000000', source ? previewMotion : 'static'), url: source }}
            settingsLabels={view === 'settings' ? {
              settings: t('qThemeVideoPreviewSettingsTitle'), general: t('qThemeVideoPreviewGeneral'), models: t('qThemeVideoPreviewModels'),
              theme: t('qThemeTab'), attachments: t('pastedTextTab'), enabled: t('qTheme'),
            } : undefined}/>
            : <div className="qyt-video-live-empty"><VideoIcon name="image"/>{t('qThemeVideoEmpty')}</div>}
          <div className="qyt-video-live-toolbar">
            <span><i/>{t('qThemeLivePreview')}</span>
            <div role="group" aria-label={t('qThemeVideoPreviewAppearance')}>
              {(['light', 'dark'] as const).map(mode => <button type="button" key={mode} aria-pressed={appearance === mode}
                onClick={() => setAppearance(mode)}>{t(mode === 'light' ? 'qThemeLight' : 'qThemeDark')}</button>)}
            </div>
            <div role="group" aria-label={t('qThemeVideoPreviewMotion')}>
              {(['dynamic', 'static'] as const).map(mode => <button type="button" key={mode} aria-pressed={previewMotion === mode}
                onClick={() => setPreviewMotion(mode)}>{t(mode === 'dynamic' ? 'qThemeMotionDynamic' : 'qThemeMotionStatic')}</button>)}
            </div>
          </div>
        </div>}
      </section>
      <section className="qyt-video-options">
        <label className="qyt-video-name">{t('qThemeCustomName')}
          <input autoFocus maxLength={40} value={name} placeholder={t('qThemeVideoDefaultName')} onChange={event => setName(event.target.value)}/>
        </label>
        <figure className="qyt-video-cover">
          {cover ? <img src={cover.image} alt={t('qThemeVideoCover')}/> : <span className="qyt-video-cover-empty"><VideoIcon name="image"/></span>}
          <figcaption><strong>{t('qThemeVideoCover')}</strong><small>{cover ? timecode(options.frame) : t('qThemeVideoCoverEmpty')}</small></figcaption>
        </figure>
        <div className="qyt-video-setting qyt-video-color">
          <label><strong>{t('qThemeColor')}</strong>
            <input type="color" value={manualAccent ?? cover?.accent ?? '#226584'} onChange={event => setManualAccent(event.currentTarget.value)}/>
          </label>
          <button type="button" disabled={!manualAccent} onClick={() => setManualAccent(undefined)}>{t('qThemeVideoColorFromCover')}</button>
        </div>
        <div className="qyt-video-setting">
          <label className="qyt-video-mask">
            <strong>{t('qThemeReadingMask')}</strong><output>{Math.round(mask * 100)}%</output>
            <input aria-label={t('qThemeReadingMask')} type="range" min={.5} max={1} step={.01} value={mask} onChange={event => setMask(Number(event.currentTarget.value))}/>
          </label>
        </div>
        <div className="qyt-video-setting">
          <h4><VideoIcon name="sidebar"/>{t('qThemeVideoSidebar')}</h4>
          <div className="qyt-video-segments" role="group" aria-label={t('qThemeVideoSidebar')}>
            {(['video', 'cover'] as const).map(sidebar => <button key={sidebar} type="button" aria-pressed={options.sidebar === sidebar}
              onClick={() => setOptions(value => ({ ...value, sidebar }))}>
              {t(sidebar === 'video' ? 'qThemeVideoSidebarFollow' : 'qThemeVideoSidebarCover')}
            </button>)}
          </div>
        </div>
        {cover && options.sidebar === 'cover' && <div className="qyt-video-crop">
          <div className="qyt-video-sidebar-sample" role="img" aria-label={t('qThemeVideoSidebarCrop')}
            onPointerDown={event => {
              if (busy || event.button !== 0) return
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = { pointer: event.pointerId, left: event.clientX, top: event.clientY, x: options.x, y: options.y }
            }}
            onPointerMove={event => {
              const start = drag.current
              if (!start || start.pointer !== event.pointerId || busy) return
              const rect = event.currentTarget.getBoundingClientRect()
              const aspect = cover.width / cover.height
              const width = Math.max(rect.width, rect.height * aspect) * sidebarZoom
              const overflowX = width - rect.width, overflowY = width / aspect - rect.height
              setOptions(value => ({ ...value,
                x: overflowX > .5 ? bounds(start.x - (event.clientX - start.left) / overflowX * 100) : value.x,
                y: overflowY > .5 ? bounds(start.y - (event.clientY - start.top) / overflowY * 100) : value.y,
              }))
            }}
            onLostPointerCapture={() => { drag.current = null }}>
            <img src={cover.image} alt="" draggable={false} style={{
              width: `${sidebarZoom * 100}%`, height: `${sidebarZoom * 100}%`,
              left: `${(1 - sidebarZoom) * options.x}%`, top: `${(1 - sidebarZoom) * options.y}%`,
              objectPosition: `${options.x}% ${options.y}%`,
            }}/>
          </div>
          <div>
            <label className="qyt-editor-field">{t('qThemeImageZoom')}
              <input type="range" min={1} max={2} step={.01} value={sidebarZoom} onChange={event => {
                const zoom = Number(event.currentTarget.value)
                setOptions(value => ({ ...value, zoom }))
              }}/>
            </label>
            {(['x', 'y'] as const).map(axis => <label className="qyt-editor-field" key={axis}>{t(axis === 'x' ? 'qThemeImageX' : 'qThemeImageY')}
              <input type="range" min={0} max={100} value={options[axis]} onChange={event => {
                const position = Number(event.currentTarget.value)
                setOptions(value => ({ ...value, [axis]: position }))
              }}/>
            </label>)}
          </div>
        </div>}
        <div className="qyt-video-setting qyt-video-sound">
          <div>
            <h4><VideoIcon name="sound"/>{t('qThemeVideoSoundLabel')}</h4>
            <small>{t(clip && !clip.audio ? 'qThemeVideoNoAudio' : options.sound ? 'qThemeVideoSoundOn' : 'qThemeVideoSoundOff')}</small>
          </div>
          <label className="qyt-video-switch">
            <input aria-label={t('qThemeVideoSound')} type="checkbox" checked={options.sound} disabled={!clip?.audio} onChange={event => {
              const sound = event.currentTarget.checked
              setOptions(value => ({ ...value, sound }))
            }}/><span aria-hidden="true"/>
          </label>
          {clip?.audio && <button className="qyt-video-listen" type="button" disabled={!ready || loading || capturing} onClick={() => {
            const video = player.current
            if (!video) return
            if (listening) { video.muted = true; setListening(false); return }
            setView('frames')
            video.muted = false
            setListening(true)
            void video.play().catch(() => { video.muted = true; setListening(false); setError('qThemeVideoSoundUnavailable') })
          }}>{t(listening ? 'qThemeVideoStopAudio' : 'qThemeVideoListen')}</button>}
        </div>
      </section>
    </fieldset>
    {error && <p className="qyt-video-error" role="alert">{t(error)}</p>}
    <footer>
      {original && onDelete && <button type="button" disabled={busy} onClick={() => { if (deleting) void remove(); else setDeleting(true) }}>{t(deleting ? 'qThemeConfirmDelete' : 'qThemeDelete')}</button>}
      <span/>
      <button type="button" disabled={!canClose} onClick={close}>{t('qThemeCancel')}</button>
      <button type="button" className="qyt-video-save" disabled={busy || loading || capturing || !ready || !cover || !name.trim()} onClick={() => { void save() }}>{t(saving ? 'saving' : 'qThemeSaveApply')}</button>
    </footer>
    {dropping && !busy && <div className="qyt-video-drop-overlay" role="status">
      <span><VideoIcon name="upload"/>{t('qThemeVideoDrop')}</span>
    </div>}
  </dialog>, document.body)
}
