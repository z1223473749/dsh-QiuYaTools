export interface LandscapeArt {
  readonly element: HTMLElement
  draw(time: number): void
  dispose(): void
}

/** Shared scene lifecycle. Theme painters only own decorative artwork. */
export interface LandscapeOptions {
  movement?: 'parallax' | 'pan' | 'none'
  atmosphere?: 'glow' | 'petals' | 'snow' | 'none'
  intensity?: number
  speed?: number
  zoom?: number
  position?: string
  createArt?: (doc: Document) => LandscapeArt | null
}

export function installLandscapeScene(doc: Document, options: LandscapeOptions = {}): () => void {
  const win = doc.defaultView
  if (!win?.requestAnimationFrame || !win.matchMedia || !win.ResizeObserver || !win.MutationObserver) return () => {}
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)')
  const forced = win.matchMedia('(forced-colors: active)')
  if (!reduced.addEventListener || !forced.addEventListener) return () => {}
  const movement = options.movement ?? 'parallax', atmosphere = options.atmosphere ?? 'glow'
  const strength = Math.max(0, Math.min(1, options.intensity ?? .35)), speed = Math.max(.1, Math.min(2, options.speed ?? .45))
  let disposed = false, failed = false, frame = 0, generation = 0, last: number | null = null, time = 0, intersecting = true
  let painter: LandscapeArt | null = null
  let host: HTMLElement | null = null, layer: HTMLElement | null = null, art: HTMLElement | null = null
  let particles: HTMLElement[] = [], targetX = 0, targetY = 0, x = 0, y = 0
  const cancel = () => { generation++; if (frame) win.cancelAnimationFrame(frame); frame = 0; last = null }
  const pointer = (event: PointerEvent) => {
    if (!host) return
    const rect = host.getBoundingClientRect()
    targetX = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1))
    targetY = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1))
  }
  const leave = () => { targetX = targetY = 0 }
  const resize = new win.ResizeObserver(() => sync())
  const intersection = win.IntersectionObserver ? new win.IntersectionObserver(entries => {
    const entry = entries.find(entry => entry.target === host)
    if (!entry || disposed) return
    intersecting = entry.isIntersecting
    sync()
  }) : null
  function release(): void {
    cancel(); resize.disconnect(); intersection?.disconnect()
    host?.removeEventListener('pointermove', pointer); host?.removeEventListener('pointerleave', leave)
    try { painter?.dispose() } finally { painter = null }
    layer?.remove(); host = layer = art = null; particles = []; intersecting = true; leave(); x = y = 0
  }
  function rendered(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect(), style = win!.getComputedStyle(element)
    return element.isConnected && element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
      && style.visibility !== 'hidden' && style.display !== 'none' && rect.bottom > 0 && rect.right > 0 && rect.top < win!.innerHeight && rect.left < win!.innerWidth
  }
  function schedule(): void {
    if (disposed || frame || !host || !rendered(host) || doc.hidden || !intersecting) return
    const token = ++generation
    frame = win!.requestAnimationFrame(now => {
      if (token !== generation || disposed) return
      frame = 0
      if (!host || !art || !rendered(host) || doc.hidden || !intersecting) { cancel(); return }
      if (last !== null && now - last < 1000 / 30) { schedule(); return }
      time += last === null ? 0 : Math.min(.08, (now - last) / 1000) * speed
      last = now
      x += (targetX - x) * .065; y += (targetY - y) * .065
      const dx = movement === 'parallax' ? x * strength * 10 : movement === 'pan' ? Math.sin(time * .18) * strength * 12 : 0
      const dy = movement === 'parallax' ? y * strength * 7 : 0
      art.style.transform = `translate(${dx}px,${dy}px) scale(${Math.max(1, options.zoom ?? 1) * (movement === 'none' ? 1 : 1.045)})`
      try { painter?.draw(time) } catch { failed = true; release(); return }
      const rect = host.getBoundingClientRect(), reading = host.dataset.phase === 'active'
      const margin = Math.max(20, (rect.width - 720) / 2 - 20)
      for (const [i, particle] of particles.entries()) {
        const seed = i * 2.399963
        const progress = ((i / particles.length + time * (atmosphere === 'glow' ? -.024 : .06)) % 1 + 1) % 1
        const px = reading ? (i % 2 ? rect.width - 10 - (i * 17 % margin) : 10 + (i * 17 % margin)) : (.1 + (i * .618034 % .8)) * rect.width
        const py = progress * (rect.height + 24) - 12
        particle.style.transform = `translate(${px + Math.sin(time + seed) * 6 * strength}px,${py}px) rotate(${seed + time * .4}rad)`
        particle.style.opacity = String((.25 + strength * .6) * (.6 + Math.sin(time + seed) * .3))
      }
      schedule()
    })
  }
  function sync(): void {
    if (disposed || failed) return
    if (reduced.matches || forced.matches) { release(); return }
    const candidates = [...doc.querySelectorAll<HTMLElement>('[data-slot="main.conversation"] > [data-phase]')]
    const next = candidates.find(rendered) ?? candidates[0]
    if (!next) { release(); return }
    if (host !== next || layer?.parentElement !== next) {
      release(); host = next
      layer = doc.createElement('div'); layer.dataset.qytLandscapeScene = ''
      layer.setAttribute('aria-hidden', 'true'); layer.setAttribute('inert', '')
      layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;z-index:-1;pointer-events:none;user-select:none;'
      art = doc.createElement('div'); art.dataset.qytLandscapeArt = ''
      art.style.cssText = 'position:absolute;inset:0;background-image:var(--qyt-theme-art);background-size:cover;background-repeat:no-repeat;will-change:transform;'
      // Miniature previews can preserve a portrait subject's face without
      // changing the full application's framing in either motion mode.
      art.style.backgroundPosition = `var(--qyt-preview-art-position, ${options.position ?? 'center 62%'})`
      if (options.createArt) {
        try { painter = options.createArt(doc) } catch { painter = null }
        if (painter) art.append(painter.element)
      }
      const wash = doc.createElement('div')
      wash.style.cssText = 'position:absolute;inset:0;background-image:var(--qyt-q-canvas-wash);'
      layer.append(art, wash)
      const count = atmosphere === 'none' ? 0 : atmosphere === 'glow' ? 14 : 20
      particles = Array.from({ length: count }, (_, i) => {
        const dot = doc.createElement('i'), size = atmosphere === 'petals' ? 7 : 2 + i % 3
        dot.style.cssText = `position:absolute;top:0;left:0;width:${size}px;height:${size}px;opacity:0;border-radius:${atmosphere === 'petals' ? '80% 10% 80% 30%' : '50%'};background:${atmosphere === 'snow' ? '#fff' : atmosphere === 'petals' ? 'var(--qyt-q-accent)' : '#ffe4a3'};box-shadow:${atmosphere === 'glow' ? '0 0 8px 2px #ffd78080' : 'none'};`
        layer!.append(dot); return dot
      })
      next.prepend(layer); resize.observe(next); intersection?.observe(next)
      next.addEventListener('pointermove', pointer, { passive: true }); next.addEventListener('pointerleave', leave)
    }
    if (doc.hidden || !intersecting || !rendered(next)) cancel()
    else schedule()
  }
  // Ignore our own per-frame style writes; observe only the host and ancestors.
  const mutations = new win.MutationObserver(records => {
    if (disposed) return
    if (!host?.isConnected || records.some(record => record.type === 'attributes'
      ? record.target === host || (record.target as Element).contains(host)
      : [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && ((node as Element).matches('[data-slot="main.conversation"], [data-phase]') || (node as Element).querySelector('[data-phase]'))))) sync()
  })
  mutations.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'data-phase'] })
  reduced.addEventListener('change', sync); forced.addEventListener('change', sync)
  doc.addEventListener('visibilitychange', sync); doc.addEventListener('scroll', sync, { passive: true, capture: true }); win.addEventListener('resize', sync)
  sync()
  return () => {
    if (disposed) return
    disposed = true; mutations.disconnect(); reduced.removeEventListener('change', sync); forced.removeEventListener('change', sync)
    doc.removeEventListener('visibilitychange', sync); doc.removeEventListener('scroll', sync, true); win.removeEventListener('resize', sync); release()
  }
}
