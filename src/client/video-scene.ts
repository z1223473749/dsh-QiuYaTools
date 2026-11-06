import { THEME_SOUND_EVENT } from '../theme-video.ts'

export type SceneDisposer = () => void

/** One silent video behind the native frame keeps sidebar, main content and
 * dock panels on the same decoded frame and continuous image coordinates. */
export function installVideoScene(doc: Document, options: {
  source(signal: AbortSignal): Promise<{ url: string; dispose(): void }>
  poster: string
  sidebarCover?: boolean
  sound?: boolean
}): SceneDisposer {
  const win = doc.defaultView
  if (!win?.matchMedia || !win.MutationObserver) return () => {}
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)')
  const forced = win.matchMedia('(forced-colors: active)')
  let disposed = false, failed = false, intersecting = true
  let host: HTMLElement | null = null, video: HTMLVideoElement | null = null, wash: HTMLElement | null = null
  let pending = false
  let soundBlocked = false
  let loading: AbortController | null = null, resource: { url: string; dispose(): void } | null = null

  function rendered(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect(), style = win!.getComputedStyle(element)
    return element.isConnected && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      && rect.bottom > 0 && rect.right > 0 && rect.top < win!.innerHeight && rect.left < win!.innerWidth
  }
  function canPlay(): boolean {
    return !disposed && !doc.hidden && !reduced.matches && !forced.matches && intersecting && !!host && rendered(host)
  }
  function release(): void {
    loading?.abort(); loading = null
    intersection?.disconnect()
    host?.removeAttribute('data-qyt-theme-live')
    host?.removeAttribute('data-qyt-video-host')
    host?.removeAttribute('data-qyt-video-surface')
    host?.removeAttribute('data-qyt-video-position')
    host?.removeAttribute('data-qyt-video-sidebar-cover')
    if (video) {
      video.removeEventListener('loadeddata', ready)
      video.removeEventListener('error', error)
      video.pause(); video.removeAttribute('src'); video.load(); video.remove()
    }
    resource?.dispose(); resource = null
    wash?.remove()
    host = video = wash = null; pending = false; intersecting = true
  }
  function ready(): void {
    if (video && video.readyState >= 2) { video.dataset.ready = 'true'; host?.setAttribute('data-qyt-theme-live', '') }
  }
  function error(): void { failed = true; release() }
  const wantsSound = () => options.sound && win.top === win && !doc.body.hasAttribute('data-qyt-session-window')
    && doc.hasFocus() && !doc.querySelector('.qyt-video-editor[open]')
  function play(gesture = false): void {
    if (!video?.hasAttribute('src') || !canPlay()) return
    const audible = wantsSound() && (gesture || !soundBlocked)
    if (!audible) video.muted = true
    if (pending || (!video.paused && video.muted === !audible)) return
    const current = video
    current.muted = !audible
    pending = true
    void current.play().then(() => {
      if (video === current && audible) soundBlocked = false
    }).catch(async () => {
      if (video !== current || !audible) return
      soundBlocked = true
      current.muted = true
      if (canPlay()) await current.play().catch(() => {})
    }).finally(() => {
      if (video !== current) return
      pending = false
      if (!wantsSound()) current.muted = true
      if (!canPlay()) current.pause()
    })
  }
  const intersection = win.IntersectionObserver ? new win.IntersectionObserver(entries => {
    const entry = entries.find(entry => entry.target === host)
    if (entry) { intersecting = entry.isIntersecting; sync() }
  }) : null
  function sync(): void {
    if (disposed || failed) return
    if (reduced.matches || forced.matches) { release(); return }
    // The native slots may use display:contents. The real frame owns all three
    // columns; putting one video there avoids independent playback or crops.
    // Miniature previews and simplified hosts retain their local fallback.
    const candidates = [
      ...doc.querySelectorAll<HTMLElement>('[data-slot="root"] > :has(> [data-rightbar-col])'),
      ...[...doc.querySelectorAll<HTMLElement>('[data-slot="main"]')].map(slot =>
        win!.getComputedStyle(slot).display === 'contents' ? slot.parentElement! : slot),
      ...doc.querySelectorAll<HTMLElement>('[data-slot="main.conversation"] > [data-phase], [data-plugin-panel], [data-testid="task-manager-page"]'),
    ]
    const next = candidates.find(rendered) ?? candidates[0]
    if (!next) { release(); return }
    if (host !== next || video?.parentElement !== next) {
      if (doc.hidden || !rendered(next)) { release(); return }
      release(); host = next
      // The real frame is fixed with inset sizing. Keep its native positioning;
      // only static fallback containers need a local positioning context.
      if (win!.getComputedStyle(next).position === 'static') next.dataset.qytVideoPosition = 'relative'
      host.dataset.qytVideoHost = ''
      if (options.sidebarCover) host.dataset.qytVideoSidebarCover = ''
      video = doc.createElement('video')
      video.dataset.qytVideoScene = ''; video.setAttribute('aria-hidden', 'true'); video.setAttribute('inert', '')
      video.tabIndex = -1; video.loop = true; video.playsInline = true; video.preload = 'metadata'
      video.defaultMuted = true; video.muted = true; video.poster = options.poster
      video.style.cssText = 'object-fit:cover;object-position:var(--qyt-preview-art-position,center);'
      video.addEventListener('loadeddata', ready); video.addEventListener('error', error)
      wash = doc.createElement('div'); wash.dataset.qytThemeWash = ''; wash.setAttribute('aria-hidden', 'true')
      next.prepend(video, wash)
      loading = new AbortController()
      const current = video, controller = loading
      void options.source(controller.signal).then(source => {
        if (controller.signal.aborted || video !== current || disposed) { source.dispose(); return }
        resource = source; current.src = source.url; sync()
      }).catch(() => {
        if (controller.signal.aborted || video !== current || disposed) return
        // Leave the poster visible. A mode/theme change can retry later.
        error()
      })
      intersection?.observe(next)
    }
    const conversation = next.matches('[data-phase]') || [...next.querySelectorAll<HTMLElement>('[data-slot="main.conversation"] > [data-phase]')].some(rendered)
    next.dataset.qytVideoSurface = conversation ? 'conversation' : 'page'
    if (!canPlay()) video?.pause()
    else play()
  }
  function gesture(): void { play() }
  function soundGesture(): void { play(true) }
  const mutations = new win.MutationObserver(records => {
    if (options.sound || !host?.isConnected || records.some(record => record.type === 'attributes'
      ? record.target === host || (record.target as Element).contains(host)
      : [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && ((node as Element).matches('[data-slot="main"], [data-slot="main.conversation"], [data-phase], [data-plugin-panel], [data-testid="task-manager-page"]') || (node as Element).querySelector('[data-slot="main"], [data-phase], [data-plugin-panel], [data-testid="task-manager-page"]'))))) sync()
  })
  mutations.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'data-phase', 'open'] })
  reduced.addEventListener('change', sync); forced.addEventListener('change', sync)
  doc.addEventListener('visibilitychange', sync); doc.addEventListener('scroll', sync, { passive: true, capture: true })
  doc.addEventListener('pointerdown', gesture, true); doc.addEventListener('keydown', gesture, true)
  if (options.sound) {
    doc.addEventListener(THEME_SOUND_EVENT, soundGesture)
    win.addEventListener('focus', sync); win.addEventListener('blur', sync)
  }
  win.addEventListener('resize', sync)
  sync()
  return () => {
    if (disposed) return
    disposed = true; mutations.disconnect(); reduced.removeEventListener('change', sync); forced.removeEventListener('change', sync)
    doc.removeEventListener('visibilitychange', sync); doc.removeEventListener('scroll', sync, true)
    doc.removeEventListener('pointerdown', gesture, true); doc.removeEventListener('keydown', gesture, true)
    doc.removeEventListener(THEME_SOUND_EVENT, soundGesture)
    win.removeEventListener('focus', sync); win.removeEventListener('blur', sync)
    win.removeEventListener('resize', sync); release()
  }
}
