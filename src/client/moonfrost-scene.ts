import { MOONFROST_SCENE_DATA_URL, MOONFROST_CLEAN_PLATE_DATA_URL } from './brand-assets.ts'
import { installLandscapeScene, type LandscapeArt } from './landscape-scene.ts'

const WIDTH = 1672, HEIGHT = 941, MAX_PIXELS = 1_500_000

// Only the loose train and trailing silk enter this matte. The head, hands,
// bodice, exposed legs and heels always come from the original still image.
export const MOONFROST_CLOTH_PATHS = [
  `M 1226 352 C 1205 414 1181 459 1148 498
   C 1087 540 1045 551 1006 565 C 956 589 927 613 892 636
   C 847 663 800 682 792 706 L 810 754 L 774 789
   C 742 814 704 840 624 852 C 680 871 732 856 781 872
   C 860 884 940 864 1008 866 C 1070 868 1120 841 1151 807
   C 1138 785 1137 762 1152 737 C 1173 681 1185 631 1203 577
   C 1220 523 1233 471 1241 422 Z`,
  `M 1198 355 C 1158 395 1117 428 1076 429
   C 1031 433 1007 406 974 400 C 948 397 923 407 895 403
   C 923 415 942 414 962 414 C 1012 433 1032 451 1074 445
   C 1124 437 1159 409 1205 376 Z`,
  `M 1126 465 C 1061 495 1020 502 989 500
   C 951 495 917 482 881 491 C 918 491 945 509 980 514
   C 1034 519 1078 501 1139 482 Z`,
] as const

const VERTEX = `attribute vec2 a_position;
varying vec2 v_uv;
void main(){gl_Position=vec4(a_position,0.,1.);v_uv=vec2((a_position.x+1.)*.5,(1.-a_position.y)*.5);}`

export const MOONFROST_FRAGMENT_SHADER = `precision highp float;
varying vec2 v_uv;
uniform sampler2D u_art,u_plate,u_matte;
uniform vec2 u_size,u_viewport,u_origin;
uniform float u_time,u_anchor;
vec2 wind(vec2 p){
  // Waist attachment stays fixed; increasingly loose fabric receives a
  // traveling wave, rather than translating or warping the whole figure.
  float loose=smoothstep(0.,1.,clamp((1238.-p.x)/550.,0.,1.));
  float wave=sin(u_time*1.8-p.x*.013+p.y*.004);
  return vec2(sin(u_time*1.45-p.y*.016)*7.,wave*17.+sin(u_time*2.1-p.x*.025)*3.)*loose;
}
void main(){
  vec2 source=vec2(1672.,941.);
  float fit=max(u_viewport.x/source.x,u_viewport.y/source.y);
  vec2 scaled=source*fit;
  vec2 offset=(u_viewport-scaled)*vec2(1.,u_anchor);
  vec2 uv=(u_origin+v_uv*u_size-offset)/scaled;
  vec2 p=uv*source;
  vec2 warped=uv-wind(p)/source;
  // Original cloth is erased over a registered clean plate before the moving
  // cloth is composited. This prevents a second, stationary hem underneath.
  float erase=texture2D(u_matte,uv).r;
  float alpha=texture2D(u_matte,warped).r;
  vec3 base=mix(texture2D(u_art,uv).rgb,texture2D(u_plate,uv).rgb,erase);
  gl_FragColor=vec4(mix(base,texture2D(u_art,warped).rgb,alpha),1.);
}`

/** GPU drawing plugs into the same visibility, motion and disposal lifecycle
 * used by the other landscape themes; it never owns a separate animation loop. */
export function createMoonfrostArt(doc: Document): LandscapeArt | null {
  const win = doc.defaultView
  if (!win?.Path2D || !win.Image) return null
  const canvas = doc.createElement('canvas')
  canvas.dataset.qytMoonfrostCloth = ''
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
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, MOONFROST_FRAGMENT_SHADER))
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
    const matte = doc.createElement('canvas'); matte.width = WIDTH; matte.height = HEIGHT
    const context = matte.getContext('2d')
    if (!context) throw new Error('Cannot create cloth matte')
    context.fillStyle = '#000'; context.fillRect(0, 0, WIDTH, HEIGHT)
    context.fillStyle = '#fff'; context.filter = 'blur(.6px)'
    for (const path of MOONFROST_CLOTH_PATHS) context.fill(new win.Path2D(path))
    upload(matte, 2, 'u_matte')
    for (const [index, image] of images.entries()) {
      image.onload = () => {
        if (disposed || failed) return
        try {
          if (image.naturalWidth !== WIDTH || image.naturalHeight !== HEIGHT) throw new Error('Cloth artwork registration changed')
          gl.useProgram(program); upload(image, index, index === 0 ? 'u_art' : 'u_plate'); ready++
        } catch { failed = true }
      }
      image.onerror = () => { failed = true }
      image.src = index === 0 ? MOONFROST_SCENE_DATA_URL : MOONFROST_CLEAN_PLATE_DATA_URL
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

export function installMoonfrostScene(doc: Document): () => void {
  return installLandscapeScene(doc, { movement: 'none', atmosphere: 'snow', intensity: .4, speed: .85, position: 'right bottom', createArt: createMoonfrostArt })
}
