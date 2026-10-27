const HOST = '[data-slot="main.conversation"] > [data-phase]'
const FRAME_MS = 1000 / 30
const MAX_PIXELS = 1_200_000
const PETALS = 14
const MOTES = 6

/** A transparent decorative layer. The shared theme CSS owns the artwork and
 * paper surfaces; the girl and the static painting never pass through canvas. */
export function installBegoniaScene(doc: Document): () => void {
  const view = doc.defaultView
  if (!doc.body || !view?.requestAnimationFrame || !view.cancelAnimationFrame || !view.matchMedia || !view.ResizeObserver || !view.MutationObserver) return () => {}
  const win = view
  let reduced: MediaQueryList, forced: MediaQueryList
  try {
    reduced = win.matchMedia('(prefers-reduced-motion: reduce)')
    forced = win.matchMedia('(forced-colors: active)')
  } catch { return () => {} }
  if (!reduced.addEventListener || !forced.addEventListener) return () => {}

  let disposed = false, failed = false, visible = false, intersecting = true
  let host: HTMLElement | null = null
  let canvas: HTMLCanvasElement | null = null
  let context: CanvasRenderingContext2D | null = null
  let bounds: DOMRect | null = null
  let frame = 0, generation = 0, lastPaint: number | null = null, time = 0
  const allowed = (): boolean => !disposed && !failed && !reduced.matches && !forced.matches
  const cancel = (): void => {
    generation++
    if (frame) win.cancelAnimationFrame(frame)
    frame = 0
    lastPaint = null
  }
  const resize = new win.ResizeObserver(() => { if (!disposed) sync() })
  const intersection = win.IntersectionObserver ? new win.IntersectionObserver(entries => {
    if (disposed) return
    const entry = entries.find(entry => entry.target === host)
    if (!entry) return
    intersecting = entry.isIntersecting
    if (intersecting) sync()
    else cancel()
  }) : null
  const release = (): void => {
    cancel()
    resize.disconnect()
    intersection?.disconnect()
    canvas?.removeEventListener('contextlost', onContextLost)
    canvas?.remove()
    if (canvas) canvas.width = canvas.height = 1
    canvas = null; context = null; host = null; bounds = null
    visible = false; intersecting = true
  }
  function onContextLost(): void {
    if (disposed) return
    failed = true
    release()
  }
  const rendered = (element: HTMLElement, rect: DOMRect): boolean => {
    const style = win.getComputedStyle(element)
    return !element.hidden && element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
      && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
  }
  const inViewport = (rect: DOMRect): boolean => rect.right > 0 && rect.bottom > 0 && rect.left < win.innerWidth && rect.top < win.innerHeight

  function schedule(): void {
    if (frame || !allowed() || !context || !host || !visible || !intersecting || doc.hidden) return
    const token = ++generation
    frame = win.requestAnimationFrame(now => {
      // Canceled callbacks can already be queued by a WebView. They must not
      // reset a newer frame handle or restart an unmounted scene.
      if (token !== generation || disposed) return
      draw(now)
    })
  }
  function draw(now: number): void {
    frame = 0
    if (!allowed() || !context || !canvas || !host || !visible || !intersecting || doc.hidden) { cancel(); return }
    if (!host.isConnected || canvas.parentElement !== host) { sync(); return }
    if (lastPaint !== null && now - lastPaint < FRAME_MS) { schedule(); return }
    const dt = lastPaint === null ? 0 : Math.min((now - lastPaint) / 1000, .08)
    lastPaint = now
    time += dt
    const rect = bounds!
    try {
      const dpr = Math.min(win.devicePixelRatio || 1, 1.25, Math.sqrt(MAX_PIXELS / (rect.width * rect.height)))
      const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
      context.setTransform(width / rect.width, 0, 0, height / rect.height, 0, 0)
      context.clearRect(0, 0, rect.width, rect.height)
      // Reading paper attenuates anything behind its center by 90%. Put the
      // living details in the visible margins instead of dimming them twice.
      // Small settings previews use the same adapter with smaller petals.
      const reading = host.dataset.phase === 'active'
      const scale = Math.min(1, Math.max(.5, Math.min(rect.width / 1000, rect.height / 720)))
      const margin = Math.max(26, (rect.width - Math.min(720, rect.width - 24)) / 2 - 26)
      const lane = (index: number, phase: number): number => {
        const spread = ((index * .381966) % 1)
        const inset = 20 * scale + spread * Math.max(0, margin - 36 * scale)
        const sway = Math.sin(time * .42 + phase) * Math.min(14 * scale, margin * .12)
        return index % 2 === 0 ? inset + sway : rect.width - inset + sway
      }
      for (let index = 0; index < PETALS; index++) {
        const seed = index * 2.399963
        const progress = (index / PETALS + time * (.035 + index % 4 * .005)) % 1
        const heroSide = index % 4 === 0 ? .12 : .64 + index % 5 * .065
        const x = reading ? lane(index, seed) : (heroSide + Math.sin(time * .42 + seed) * .035) * rect.width
        const y = progress * (rect.height + 70 * scale) - 35 * scale
        const size = (10 + index % 4 * 2.2) * scale
        context.save()
        context.translate(x, y)
        context.rotate(seed + time * (.3 + index % 3 * .07))
        context.scale(1, .62 + Math.abs(Math.sin(time * .55 + seed)) * .32)
        context.globalAlpha = .66 + index % 3 * .1
        context.fillStyle = index % 3 === 0 ? '#e18b69' : index % 3 === 1 ? '#bd353f' : '#d65d4c'
        context.beginPath()
        context.moveTo(0, -size)
        context.bezierCurveTo(size * 1.4, -size * .4, size, size * .8, 0, size)
        context.bezierCurveTo(-size, size * .6, -size * .8, -size * .7, 0, -size)
        context.fill()
        context.restore()
      }
      for (let index = 0; index < MOTES; index++) {
        const phase = time * .6 + index * 1.7
        const x = reading ? lane(index + 2, phase) : (.58 + index * .07 + Math.sin(phase) * .025) * rect.width
        const y = ((index / MOTES - time * .014) % 1 + 1) % 1 * rect.height
        context.globalAlpha = .45 + (Math.sin(phase) + 1) * .2
        context.fillStyle = '#eac477'
        context.shadowColor = '#a86a25'
        context.shadowBlur = 9 * scale
        context.beginPath()
        context.arc(x, y, (2.8 + index % 3 * .8) * scale, 0, Math.PI * 2)
        context.fill()
      }
      context.shadowBlur = 0
      context.globalAlpha = 1
    } catch { failed = true; release(); return }
    schedule()
  }
  function sync(): void {
    if (!allowed()) { release(); return }
    const candidates = [...doc.querySelectorAll<HTMLElement>(HOST)]
    const next = candidates.find(element => {
      const rect = element.getBoundingClientRect()
      return rendered(element, rect) && inViewport(rect)
    }) ?? (host?.isConnected && candidates.includes(host) ? host : candidates[0])
    if (!next) { release(); return }
    if (host !== next || canvas?.parentElement !== next) {
      release()
      const overlay = doc.createElement('canvas')
      overlay.dataset.qytBegoniaPetals = ''
      overlay.setAttribute('aria-hidden', 'true')
      overlay.setAttribute('inert', '')
      overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;'
      let painter: CanvasRenderingContext2D | null = null
      try { painter = overlay.getContext('2d', { alpha: true }) } catch {}
      if (!painter) { failed = true; return }
      host = next; canvas = overlay; context = painter
      overlay.addEventListener('contextlost', onContextLost)
      host.prepend(overlay)
      resize.observe(host)
      intersection?.observe(host)
    }
    bounds = next.getBoundingClientRect()
    visible = rendered(next, bounds) && inViewport(bounds)
    if (!visible || !intersecting || doc.hidden) cancel()
    else schedule()
  }
  const onVisibility = (): void => { if (doc.hidden) cancel(); else sync() }
  const onLayout = (): void => { if (!disposed) sync() }
  const mutations = new win.MutationObserver(records => {
    if (disposed) return
    if (!host?.isConnected || canvas?.parentElement !== host || records.some(record => {
      if (record.type === 'attributes') return record.target === host || (record.target as Element).contains(host)
      return [...record.addedNodes, ...record.removedNodes].some(node => {
        const element = node.nodeType === 1 ? node as Element : null
        return element?.matches('[data-slot="main.conversation"], [data-phase]') || element?.querySelector('[data-slot="main.conversation"], [data-phase]')
      })
    })) sync()
  })
  mutations.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-phase', 'hidden', 'style', 'class'] })
  reduced.addEventListener('change', sync)
  forced.addEventListener('change', sync)
  doc.addEventListener('visibilitychange', onVisibility)
  doc.addEventListener('scroll', onLayout, { passive: true, capture: true })
  win.addEventListener('resize', onLayout, { passive: true })
  sync()
  return () => {
    if (disposed) return
    disposed = true
    mutations.disconnect()
    resize.disconnect()
    intersection?.disconnect()
    reduced.removeEventListener('change', sync)
    forced.removeEventListener('change', sync)
    doc.removeEventListener('visibilitychange', onVisibility)
    doc.removeEventListener('scroll', onLayout, true)
    win.removeEventListener('resize', onLayout)
    release()
  }
}
