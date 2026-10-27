import { OCEAN_SCENE_DATA_URL } from './brand-assets.ts'
import { createOceanMesh, OCEAN_FRAGMENT_SHADER, OCEAN_VERTEX_SHADER, type OceanMesh } from './ocean-scene-art.ts'

const HOST = '[data-slot="main.conversation"] > [data-phase]'
const LIVE = 'data-qyt-ocean-live'
const MAX_PIXELS = 1_800_000
const ART_WIDTH = 1600
const ART_HEIGHT = 900

interface Painter {
  draw(bounds: DOMRect, time: number, pointer: number[], ripples: Float32Array, amount: number): void
  dispose(): void
}

/** Each installation owns one low-power GPU context. All failure paths leave
 * the CSS illustration in place; no animation is necessary to use the app. */
function createPainter(canvas: HTMLCanvasElement, image: HTMLImageElement, mesh: OceanMesh): Painter | null {
  const gl = canvas.getContext('webgl', {
    alpha: false, antialias: false, depth: false, stencil: false,
  })
  if (!gl) return null
  const shaders: WebGLShader[] = []
  const textures: WebGLTexture[] = []
  const buffers: WebGLBuffer[] = []
  let program: WebGLProgram | null = null
  const dispose = (): void => {
    textures.forEach(texture => gl.deleteTexture(texture))
    shaders.forEach(shader => gl.deleteShader(shader))
    buffers.forEach(buffer => gl.deleteBuffer(buffer))
    if (program) gl.deleteProgram(program)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  try {
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('Ocean shader allocation failed')
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Ocean shader compilation failed')
      return shader
    }
    const vertex = compile(gl.VERTEX_SHADER, OCEAN_VERTEX_SHADER)
    const fragment = compile(gl.FRAGMENT_SHADER, OCEAN_FRAGMENT_SHADER)
    program = gl.createProgram()
    if (!program) throw new Error('Ocean program allocation failed')
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Ocean program linking failed')
    gl.useProgram(program)
    for (const [target, data] of [[gl.ARRAY_BUFFER, mesh.vertices], [gl.ELEMENT_ARRAY_BUFFER, mesh.indices]] as const) {
      const buffer = gl.createBuffer()
      if (!buffer) throw new Error('Ocean mesh allocation failed')
      buffers.push(buffer)
      gl.bindBuffer(target, buffer)
      gl.bufferData(target, data, gl.STATIC_DRAW)
    }
    for (const [name, size, offset] of [['a_position', 2, 0], ['a_region', 3, 8], ['a_detail', 4, 20]] as const) {
      const location = gl.getAttribLocation(program, name)
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 36, offset)
    }
    const texture = gl.createTexture()
    if (!texture) throw new Error('Ocean texture allocation failed')
    textures.push(texture)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    const uniform = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program!, name)
    const viewport = uniform('u_viewport'), boundsUniform = uniform('u_bounds'), pointerUniform = uniform('u_pointer')
    const timeUniform = uniform('u_time'), ripplesUniform = uniform('u_ripples[0]'), amountUniform = uniform('u_amount')
    gl.uniform1i(uniform('u_art'), 0)
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error('Ocean texture initialization failed')
    const win = canvas.ownerDocument.defaultView!
    let firstDraw = true
    return {
      draw(bounds, time, pointer, ripples, amount) {
        const dpr = Math.min(win.devicePixelRatio || 1, 1.5, Math.sqrt(MAX_PIXELS / (bounds.width * bounds.height)))
        const width = Math.max(1, Math.round(bounds.width * dpr)), height = Math.max(1, Math.round(bounds.height * dpr))
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
        gl.viewport(0, 0, width, height)
        gl.uniform2f(viewport, win.innerWidth, win.innerHeight)
        gl.uniform4f(boundsUniform, bounds.left, bounds.top, bounds.width, bounds.height)
        gl.uniform2f(pointerUniform, pointer[0], pointer[1])
        gl.uniform1f(timeUniform, time)
        gl.uniform1f(amountUniform, amount)
        gl.uniform3fv(ripplesUniform, ripples)
        gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0)
        if (firstDraw) {
          firstDraw = false
          if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error('Ocean first frame failed')
        }
      },
      dispose,
    }
  } catch {
    dispose()
    return null
  }
}

export function installOceanScene(doc: Document): () => void {
  const win = doc.defaultView
  // Also keeps server rendering, plugin smoke documents and older WebViews
  // entirely static without trying to create a GPU context.
  if (!doc.body || !win?.requestAnimationFrame || !win.matchMedia || !win.ResizeObserver || !win.MutationObserver) return () => {}
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)')
  const forced = win.matchMedia('(forced-colors: active)')
  let disposed = false, failed = false, loaded = false, loading = false
  let host: HTMLElement | null = null
  let canvas: HTMLCanvasElement | null = null, wash: HTMLDivElement | null = null
  let painter: Painter | null = null
  let mesh: OceanMesh | null = null
  let bounds: DOMRect | null = null
  let frame = 0, lastDraw = 0, time = 0, inView = true, measure = true
  let pointerTarget = [0, 0], pointer = [0, 0]
  let rippleIndex = 0, lastRipple = 0, lastX = 0, lastY = 0
  const ripples: { x: number; y: number; born: number }[] = []
  const rippleUniform = new Float32Array([0, 0, 10, 0, 0, 10, 0, 0, 10])
  const image = new win.Image()
  const allowed = (): boolean => !disposed && !failed && !reduced.matches && !forced.matches
  const cancel = (): void => {
    if (frame) win.cancelAnimationFrame(frame)
    frame = 0
    lastDraw = 0
  }
  const resetPointer = (): void => { pointerTarget = [0, 0] }
  const onContextLost = (): void => {
    // Keep the original CSS art for this installation after a GPU reset. A
    // theme toggle can try a fresh context; never spin up a retry loop.
    failed = true
    release()
  }
  const resize = new win.ResizeObserver(() => { measure = true; sync() })
  const intersection = win.IntersectionObserver ? new win.IntersectionObserver(entries => {
    inView = entries.some(entry => entry.isIntersecting)
    if (inView) schedule()
    else cancel()
  }) : null
  const release = (): void => {
    cancel()
    resize.disconnect()
    intersection?.disconnect()
    host?.removeAttribute(LIVE)
    canvas?.removeEventListener('webglcontextlost', onContextLost)
    canvas?.remove()
    wash?.remove()
    painter?.dispose()
    painter = null; host = null; canvas = null; wash = null; bounds = null
    pointer = [0, 0]; pointerTarget = [0, 0]; ripples.length = 0
    inView = true; measure = true
  }
  const draw = (now: number): void => {
    frame = 0
    if (!allowed() || !painter || !host || doc.hidden || !inView) { lastDraw = 0; return }
    if (!host.isConnected) { sync(); return }
    // Draw once per display refresh, including 120 Hz. A 30 fps timestamp gate
    // made mouse motion visibly step and could skip an extra refresh.
    const dt = lastDraw ? Math.min((now - lastDraw) / 1000, .08) : 0
    lastDraw = now
    time += dt
    if (measure || !bounds) { bounds = host.getBoundingClientRect(); measure = false }
    if (bounds.width <= 0 || bounds.height <= 0) { cancel(); return }
    const ease = 1 - Math.exp(-dt * 3.7)
    pointer = pointer.map((value, index) => value + (pointerTarget[index] - value) * ease)
    for (let index = 0; index < 3; index++) {
      const ripple = ripples[index]
      rippleUniform.set(ripple ? [ripple.x, ripple.y, time - ripple.born] : [0, 0, 10], index * 3)
    }
    try {
      painter.draw(bounds, time, pointer, rippleUniform, host.dataset.phase === 'hero' ? 1 : .38)
      if (canvas!.dataset.ready !== 'true') {
        canvas!.dataset.ready = 'true'
        host.setAttribute(LIVE, '')
      }
    } catch {
      failed = true
      release()
      return
    }
    schedule()
  }
  function schedule(): void {
    if (!frame && allowed() && painter && !doc.hidden && inView) frame = win!.requestAnimationFrame(draw)
  }
  function sync(): void {
    if (!allowed()) { release(); return }
    if (host?.isConnected && !host.hidden && host.getClientRects().length > 0) { measure = true; schedule(); return }
    const next = [...doc.querySelectorAll<HTMLElement>(HOST)].find(element => {
      const rect = element.getBoundingClientRect()
      return !element.hidden && rect.width > 0 && rect.height > 0
    })
    release()
    if (!next) return
    if (!loaded) {
      if (!loading) { loading = true; image.src = OCEAN_SCENE_DATA_URL }
      return
    }
    try { mesh ??= createOceanMesh(doc) } catch { mesh = null }
    if (!mesh) { failed = true; return }
    canvas = doc.createElement('canvas')
    canvas.dataset.qytOceanScene = ''
    canvas.setAttribute('aria-hidden', 'true')
    canvas.addEventListener('webglcontextlost', onContextLost)
    try { painter = createPainter(canvas, image, mesh) } catch { painter = null }
    if (!painter) { failed = true; release(); return }
    host = next
    wash = doc.createElement('div')
    wash.dataset.qytOceanWash = ''
    wash.setAttribute('aria-hidden', 'true')
    host.prepend(canvas, wash)
    resize.observe(host)
    intersection?.observe(host)
    schedule()
  }
  image.onload = () => {
    if (!allowed()) { loading = false; return }
    loaded = image.naturalWidth > 0
    if (!loaded) failed = true
    sync()
  }
  image.onerror = () => { failed = true; release() }
  const onPointer = (event: PointerEvent): void => {
    if (!allowed() || !host || event.pointerType === 'touch' || !event.isPrimary) return
    const rect = bounds ?? host.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { resetPointer(); return }
    pointerTarget = [(event.clientX / win.innerWidth - .5) * 2, (event.clientY / win.innerHeight - .5) * 2]
    const target = event.target as Element | null
    if (target?.closest?.('button,a,input,textarea,select,[contenteditable="true"],[role="menu"],[role="dialog"]')) return
    const fit = Math.max(win.innerWidth / ART_WIDTH, win.innerHeight / ART_HEIGHT)
    const x = ((event.clientX - win.innerWidth + ART_WIDTH * fit) / (ART_WIDTH * fit) - .5) / 1.035 + .5
    const y = ((event.clientY - win.innerHeight + ART_HEIGHT * fit) / (ART_HEIGHT * fit) - .5) / 1.035 + .5
    if (y < .58 || time - lastRipple < .18 || Math.hypot(event.clientX - lastX, event.clientY - lastY) < 22) return
    ripples[rippleIndex++ % 3] = { x, y, born: time }
    lastRipple = time; lastX = event.clientX; lastY = event.clientY
  }
  const onVisibility = (): void => { if (doc.hidden) cancel(); else { measure = true; sync() } }
  const onResize = (): void => { measure = true; sync() }
  const onScroll = (): void => { measure = true }
  const mutations = new win.MutationObserver(records => {
    // Streaming message text also mutates the body. Only host replacement,
    // phase changes and an absent host need a new scene discovery pass.
    if (!host?.isConnected || records.some(record => record.type === 'attributes' && record.target === host)) sync()
  })
  mutations.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-phase', 'hidden'] })
  reduced.addEventListener('change', sync)
  forced.addEventListener('change', sync)
  doc.addEventListener('visibilitychange', onVisibility)
  doc.addEventListener('pointermove', onPointer, { passive: true })
  doc.addEventListener('pointerleave', resetPointer)
  doc.addEventListener('scroll', onScroll, { passive: true, capture: true })
  win.addEventListener('resize', onResize, { passive: true })
  win.addEventListener('blur', resetPointer)
  sync()
  return () => {
    if (disposed) return
    disposed = true
    mutations.disconnect()
    reduced.removeEventListener('change', sync)
    forced.removeEventListener('change', sync)
    doc.removeEventListener('visibilitychange', onVisibility)
    doc.removeEventListener('pointermove', onPointer)
    doc.removeEventListener('pointerleave', resetPointer)
    doc.removeEventListener('scroll', onScroll, true)
    win.removeEventListener('resize', onResize)
    win.removeEventListener('blur', resetPointer)
    image.onload = null; image.onerror = null
    release()
    mesh = null
  }
}
