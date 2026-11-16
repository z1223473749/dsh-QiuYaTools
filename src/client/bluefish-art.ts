import { BLUEFISH_MOTION_DATA_URL, BLUEFISH_POSES, BLUEFISH_PORTRAIT_DATA_URL } from './brand-assets.ts'

export type Point = readonly [number, number]
export type Artwork = keyof typeof BLUEFISH_POSES
export const STAGE = 512
export const pins = (name: Artwork) => BLUEFISH_POSES[name].pins
export const origin = (name: Artwork): Point | undefined => {
  const pose = BLUEFISH_POSES[name]
  return 'origin' in pose ? pose.origin : undefined
}
const COLUMNS = 7
const PIN_COUNT = 13
const GRID = 32
const offset = (name: Artwork): Point => {
  const { cell } = BLUEFISH_POSES[name]
  return [cell % COLUMNS * STAGE, Math.floor(cell / COLUMNS) * STAGE]
}

const VERTEX = `
attribute vec2 position;
uniform vec2 fromPins[${PIN_COUNT}], toPins[${PIN_COUNT}];
uniform float progress, breath, turn;
varying vec2 source, target, stage;
vec2 alignHead(vec2 p, vec2 axis, vec2 nextAxis) {
  vec2 perpendicular = vec2(-axis.y, axis.x);
  vec2 nextPerpendicular = vec2(-nextAxis.y, nextAxis.x);
  return (dot(p, axis) * nextAxis + dot(p, perpendicular) * nextPerpendicular) / max(.0001, dot(axis, axis));
}
void main() {
  stage = position;
  vec2 at = position;
  vec2 shift = vec2(0.);
  float total = 25.;
  for (int i = 0; i < ${PIN_COUNT}; i++) {
    vec2 delta = at - mix(fromPins[i], toPins[i], progress);
    float d = dot(delta, delta);
    float weight = exp(-d * 55.) / (.000045 + d);
    shift += (toPins[i] - fromPins[i]) * weight;
    total += weight;
  }
  shift /= total;
  vec2 centerA = (fromPins[0] + fromPins[1]) * .5;
  vec2 centerB = (toPins[0] + toPins[1]) * .5;
  vec2 center = mix(centerA, centerB, progress);
  vec2 axisA = fromPins[3] - centerA, axisB = toPins[3] - centerB;
  vec2 axis = mix(axisA, axisB, progress);
  vec2 faceDelta = (at - center + vec2(0., .085)) / vec2(.175, .245);
  float head = 1. - smoothstep(.47, 1.1, dot(faceDelta, faceDelta));
  at -= vec2(turn * head, breath * (1. - smoothstep(.67, .91, at.y)));
  source = mix(at - progress * shift, centerA + alignHead(at - center, axis, axisA), head);
  target = mix(at + (1. - progress) * shift, centerB + alignHead(at - center, axis, axisB), head);
  gl_Position = vec4(position.x * 2. - 1., 1. - position.y * 2., 0., 1.);
}`

const FRAGMENT = `
precision highp float;
uniform sampler2D atlas;
uniform vec2 atlasSize, fromCell, toCell;
uniform vec2 eyesA[2], eyesB[2], mouthA, mouthB, gaze;
uniform float progress, expression;
varying vec2 source, target, stage;
float spot(vec2 p, vec2 center, vec2 radius) {
  vec2 v = (p - center) / radius;
  return 1. - smoothstep(.12, 1., dot(v, v));
}
vec4 paint(vec2 cell, vec2 uv) {
  return texture2D(atlas, (cell + clamp(uv, vec2(.001), vec2(.999)) * 512.) / atlasSize);
}
vec2 features(vec2 uv, vec2 left, vec2 right, vec2 mouth) {
  vec2 iris = vec2(.022, .031);
  float tracking = max(spot(uv, left, iris), spot(uv, right, iris));
  float smile = spot(uv, mouth, vec2(.032, .022));
  return uv - gaze * tracking + vec2(0., expression * smile);
}
void main() {
  vec2 eyeRadius = vec2(.044, .037);
  float face = max(spot(stage, mix(mouthA, mouthB, progress), vec2(.043, .047)),
    max(spot(stage, mix(eyesA[0], eyesB[0], progress), eyeRadius),
        spot(stage, mix(eyesA[1], eyesB[1], progress), eyeRadius)));
  vec4 a = paint(fromCell, features(source, eyesA[0], eyesA[1], mouthA));
  vec4 b = paint(toCell, features(target, eyesB[0], eyesB[1], mouthB));
  // Aligned paint can dissolve. Distinct edges use the locally preferred
  // warped exposure so high-contrast lace, eyes and soles stay legible.
  float difference = max(length(a.rgb - b.rgb), abs(a.a - b.a));
  float threshold = .49 + (stage.y - .5) * .22 + (stage.x - .5) * .12;
  float sharp = smoothstep(threshold - .085, threshold + .085, progress);
  float blend = mix(progress, sharp, smoothstep(.13, .55, difference));
  blend = mix(blend, step(.5, progress), smoothstep(.22, .60, face));
  gl_FragColor = mix(a, b, blend);

}`

export type Paint = {
  from: Artwork
  to: Artwork
  progress: number
  gaze: Point
  breath: number
  turn: number
  expression: number
}

function makeMesh() {
  const vertices: number[] = []
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [0, 1], [1, 0], [1, 1]]) {
      vertices.push((x + dx!) / GRID, (y + dy!) / GRID)
    }
  }
  return new Float32Array(vertices)
}

function createWarp(canvas: HTMLCanvasElement, image: HTMLImageElement) {
  const gl = canvas.getContext('webgl', { antialias: false, depth: false, stencil: false })
  if (!gl || image.width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || image.height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return
  const program = gl.createProgram()
  const buffer = gl.createBuffer()
  const texture = gl.createTexture()
  const shaders: WebGLShader[] = []
  const dispose = () => {
    for (const shader of shaders) gl.deleteShader(shader)
    gl.deleteTexture(texture)
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  try {
    if (!program || !buffer || !texture) throw Error('Could not allocate Bluefish artwork')
    for (const [type, code] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw Error('Could not allocate Bluefish shader')
      shaders.push(shader)
      gl.shaderSource(shader, code)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader) ?? '')
      gl.attachShader(program, shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program) ?? '')
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const mesh = makeMesh()
    gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    if (gl.getError() !== gl.NO_ERROR) throw Error('Could not upload Bluefish artwork')
    const uniform = (name: string) => gl.getUniformLocation(program, name)
    gl.uniform2f(uniform('atlasSize'), image.width, image.height)
    gl.viewport(0, 0, canvas.width, canvas.height)
    const a = uniform('fromPins[0]'), b = uniform('toPins[0]')
    const eyeA = uniform('eyesA[0]'), eyeB = uniform('eyesB[0]')
    const mouthA = uniform('mouthA'), mouthB = uniform('mouthB')
    const cellA = uniform('fromCell'), cellB = uniform('toCell')
    const progress = uniform('progress'), breath = uniform('breath'), turn = uniform('turn')
    const gaze = uniform('gaze'), expression = uniform('expression')
    let previousFrom: Artwork | undefined, previousTo: Artwork | undefined
    function register(name: Artwork, joints: WebGLUniformLocation | null, eyes: WebGLUniformLocation | null,
      mouth: WebGLUniformLocation | null, cell: WebGLUniformLocation | null) {
      const points = pins(name)
      gl!.uniform2fv(joints, points.flat().map(value => value / STAGE))
      gl!.uniform2fv(eyes, points.slice(0, 2).flat().map(value => value / STAGE))
      gl!.uniform2f(mouth, points[2][0] / STAGE, points[2][1] / STAGE)
      gl!.uniform2f(cell, ...offset(name))
    }
    return {
      dispose,
      draw(frame: Paint) {
        if (gl.isContextLost()) return false
        if (frame.from !== previousFrom) {
          register(frame.from, a, eyeA, mouthA, cellA)
          previousFrom = frame.from
        }
        if (frame.to !== previousTo) {
          register(frame.to, b, eyeB, mouthB, cellB)
          previousTo = frame.to
        }
        gl.uniform1f(progress, frame.progress)
        gl.uniform1f(breath, frame.breath)
        gl.uniform1f(turn, frame.turn)
        gl.uniform2f(gaze, ...frame.gaze)
        gl.uniform1f(expression, frame.expression)
        gl.drawArrays(gl.TRIANGLES, 0, mesh.length / 2)
        return true
      },
    }
  } catch {
    dispose()
    return undefined
  }
}

export function createBluefishArt(doc: Document) {
  const element = doc.createElement('div')
  element.className = 'qyt-bluefish-character'
  element.setAttribute('aria-hidden', 'true')
  element.style.backgroundImage = `url("${BLUEFISH_PORTRAIT_DATA_URL}")`
  const shadow = doc.createElement('i')
  shadow.className = 'qyt-bluefish-ground'
  element.append(shadow)
  const canvas = doc.createElement('canvas')
  canvas.width = canvas.height = STAGE
  const image = doc.createElement('img')
  let warp: ReturnType<typeof createWarp>
  let initialized = false
  let fallback: CanvasRenderingContext2D | null = null
  image.src = BLUEFISH_MOTION_DATA_URL
  return {
    element,
    ground(x: number, height: number, visible: boolean) {
      shadow.style.left = `${x * 100}%`
      shadow.style.opacity = visible ? String(Math.max(.10, .29 - height * 2.8)) : '0'
      shadow.style.scale = String(Math.max(.70, 1 - height * 2.4))
    },
    draw(frame: Paint) {
      if (!image.complete || !image.naturalWidth) return
      if (!initialized) {
        initialized = true
        warp = createWarp(canvas, image)
        if (warp) element.append(canvas)
      }
      if (warp?.draw(frame)) {
        element.dataset.renderer = 'mesh'
      } else {
        if (!fallback) {
          const alternate = doc.createElement('canvas')
          alternate.width = alternate.height = STAGE
          fallback = alternate.getContext('2d')
          canvas.remove()
          element.append(alternate)
        }
        if (!fallback) return
        const [x, y] = offset(frame.progress < .5 ? frame.from : frame.to)
        fallback.clearRect(0, 0, STAGE, STAGE)
        fallback.drawImage(image, x, y, STAGE, STAGE, 0, -frame.breath * STAGE, STAGE, STAGE)
        element.dataset.renderer = 'painted'
      }
      if (element.style.backgroundImage) element.style.backgroundImage = ''
    },
    dispose() {
      warp?.dispose()
      element.remove()
    },
  }
}
