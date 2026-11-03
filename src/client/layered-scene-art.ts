import type { LandscapeArt } from './landscape-scene.ts'

/** Registered artwork and mattes; the shared landscape runtime owns scheduling. */
export interface LayeredSceneArtOptions {
  width: number
  height: number
  marker: `data-${string}`
  art: string
  plate: string
  fragmentShader: string
  regions: readonly { color: string; paths: readonly string[]; blur?: number }[]
}

const MAX_PIXELS = 1_500_000

const VERTEX = `attribute vec2 a_position;
varying vec2 v_uv;
void main(){gl_Position=vec4(a_position,0.,1.);v_uv=vec2((a_position.x+1.)*.5,(1.-a_position.y)*.5);}`

export function createLayeredSceneArt(doc: Document, options: LayeredSceneArtOptions): LandscapeArt | null {
  const win = doc.defaultView
  if (!win?.Path2D || !win.Image) return null
  const canvas = doc.createElement('canvas')
  canvas.setAttribute(options.marker, '')
  canvas.setAttribute('aria-hidden', 'true')
  canvas.setAttribute('inert', '')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;visibility:hidden;pointer-events:none;'
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false })
  if (!gl) return null
  const shaders: WebGLShader[] = [], textures: WebGLTexture[] = []
  let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null
  let disposed = false, failed = false, ready = 0
  const images = [new win.Image(), new win.Image()]
  const onLost = (event: Event) => { event.preventDefault(); failed = true }
  canvas.addEventListener('webglcontextlost', onLost)
  const dispose = () => {
    if (disposed) return
    disposed = true
    canvas.removeEventListener('webglcontextlost', onLost)
    for (const image of images) { image.onload = image.onerror = null; image.src = '' }
    for (const texture of textures) gl.deleteTexture(texture)
    for (const shader of shaders) gl.deleteShader(shader)
    if (buffer) gl.deleteBuffer(buffer)
    if (program) gl.deleteProgram(program)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    canvas.remove(); canvas.width = canvas.height = 1
  }
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('Cannot allocate cloth shader')
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Cannot compile cloth shader')
      return shader
    }
    program = gl.createProgram()
    if (!program) throw new Error('Cannot allocate cloth program')
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, options.fragmentShader))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Cannot link cloth shader')
    gl.useProgram(program)
    buffer = gl.createBuffer()
    if (!buffer) throw new Error('Cannot allocate cloth buffer')
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW)
    const attribute = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0)
    const uniform = (name: string) => gl.getUniformLocation(program!, name)
    const size = uniform('u_size'), viewport = uniform('u_viewport'), origin = uniform('u_origin')
    const time = uniform('u_time'), anchor = uniform('u_anchor')
    const upload = (source: TexImageSource, index: number, name: string) => {
      const texture = gl.createTexture()
      if (!texture) throw new Error('Cannot allocate cloth texture')
      textures.push(texture); gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      gl.uniform1i(uniform(name), index)
    }
    const matte = doc.createElement('canvas'); matte.width = options.width; matte.height = options.height
    const context = matte.getContext('2d')
    if (!context) throw new Error('Cannot create cloth matte')
    context.fillStyle = '#000'; context.fillRect(0, 0, options.width, options.height)
    for (const region of options.regions) {
      context.fillStyle = region.color; context.filter = `blur(${region.blur ?? .6}px)`
      for (const path of region.paths) context.fill(new win.Path2D(path))
    }
    upload(matte, 2, 'u_matte')
    for (const [index, image] of images.entries()) {
      image.onload = () => {
        if (disposed || failed) return
        try {
          if (image.naturalWidth !== options.width || image.naturalHeight !== options.height) throw new Error('Cloth artwork registration changed')
          gl.useProgram(program); upload(image, index, index === 0 ? 'u_art' : 'u_plate'); ready++
        } catch { failed = true }
      }
      image.onerror = () => { failed = true }
      image.src = index === 0 ? options.art : options.plate
    }
    return {
      element: canvas, dispose,
      draw(seconds) {
        if (disposed) return
        if (failed || gl.isContextLost()) throw new Error('Cloth renderer unavailable')
        if (ready !== 2) return
        const bounds = canvas.getBoundingClientRect()
        if (bounds.width <= 0 || bounds.height <= 0) return
        const dpr = Math.min(win.devicePixelRatio || 1, 1.5, Math.sqrt(MAX_PIXELS / (bounds.width * bounds.height)))
        const width = Math.max(1, Math.round(bounds.width * dpr)), height = Math.max(1, Math.round(bounds.height * dpr))
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
        gl.viewport(0, 0, width, height); gl.useProgram(program)
        gl.uniform2f(size, bounds.width, bounds.height); gl.uniform2f(viewport, win.innerWidth, win.innerHeight)
        gl.uniform2f(origin, bounds.left, bounds.top); gl.uniform1f(time, seconds)
        const position = win.getComputedStyle(doc.body).getPropertyValue('--qyt-preview-art-position')
        gl.uniform1f(anchor, position.includes('top') ? 0 : 1)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Cloth drawing failed')
        canvas.style.visibility = 'visible'; canvas.dataset.ready = 'true'
      },
    }
  } catch { dispose(); return null }
}
