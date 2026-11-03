import type { Context } from '@deepseek-ai/cordis'
import type { CustomTheme } from '../custom-themes.ts'
import { maskSignature } from '../smart-motion.ts'
import { loadMotionAssets, digest } from './smart-theme-api.ts'
import { featherMotionMask } from './smart-theme-processing.ts'
import type { LandscapeArt } from './landscape-scene.ts'
const VERTEX = 'attribute vec2 a_position;varying vec2 v_uv;void main(){gl_Position=vec4(a_position,0.,1.);v_uv=vec2((a_position.x+1.)*.5,(1.-a_position.y)*.5);}'
export const SMART_MOTION_FRAGMENT = `precision highp float;
varying vec2 v_uv;uniform sampler2D u_source,u_plate,u_mask0,u_mask1,u_mask2,u_protect;
uniform vec2 u_size,u_image,u_position;uniform float u_time,u_strength,u_reveal;
uniform vec4 u_geometry[8],u_motion[8];uniform float u_kind[8],u_segmented[8];
float region(int i,vec2 p){
 if(p.x<0.||p.x>1.||p.y<0.||p.y>1.)return 0.;
 vec3 a=i<3?texture2D(u_mask0,p).rgb:(i<6?texture2D(u_mask1,p).rgb:texture2D(u_mask2,p).rgb);
 int c=i-(i/3)*3;return c==0?a.r:(c==1?a.g:a.b);
}
vec2 flow(vec2 p,vec4 g,vec4 m,float kind){
 float t=u_time*m.y;vec2 metric=vec2(1.,u_image.y/u_image.x);
 vec2 axis=(g.zw-g.xy)*metric;float span=length(axis);
 float progress=dot((p-g.xy)*metric,axis)/max(dot(axis,axis),.0001);
 float loose=smoothstep(.03,.95,clamp(progress,0.,1.));
 float wave=sin(t*1.12-clamp(progress,0.,1.)*.85)+.16*sin(t*1.78+.6-progress*.5);
 vec2 direction=vec2(cos(m.z),sin(m.z));
 vec2 shift=direction*wave*min(m.x*1.8,min(.03,span*.17))*loose;
 if(kind>1.5&&kind<2.5)shift=direction*sin(t*.82+p.y*2.)*min(m.x*2.5,.018);
 if(kind>2.5&&kind<3.5)shift=vec2(sin(p.y*55.-t*1.35)+.25*sin(p.y*87.+t*.73),sin(p.x*37.+t*.9)*.12)*min(m.x*2.2,.006);
 if(kind>3.5&&kind<4.5)shift=vec2(sin(t*.76)*.4,sin(t*.95))*min(m.x*2.,.012);
 if(kind>4.5)shift=vec2(0.);
 return shift/metric;
}
void main(){
 float fit=max(u_size.x/u_image.x,u_size.y/u_image.y);vec2 scaled=u_image*fit;
 vec2 uv=(v_uv*u_size-(u_size-scaled)*u_position)/scaled;
 vec2 displacement=vec2(0.);float weight=0.;float light=0.;
 ${Array.from({ length: 8 }, (_, i) => `if(u_motion[${i}].w>.5&&u_segmented[${i}]<.5){float mask=region(${i},uv);displacement+=flow(uv,u_geometry[${i}],u_motion[${i}],u_kind[${i}])*mask;weight+=mask;if(u_kind[${i}]>4.5)light+=sin(u_time*u_motion[${i}].y*1.15)*clamp(u_motion[${i}].x*40.,0.,.09)*mask;}`).join('\n')}
 // One inverse lookup preserves edges and avoids layered ghosts or exposed
 // nearest-color repair patches. Overlapping masks share one displacement.
 float amount=clamp(u_strength,0.,1.)*smoothstep(0.,1.,u_reveal)*(1.-texture2D(u_protect,uv).a);
 vec2 delta=displacement/max(1.,weight)*amount;
 vec3 color=texture2D(u_source,uv-delta).rgb;
 color*=1.+light*amount;
 ${Array.from({ length: 8 }, (_, i) => `if(u_motion[${i}].w>.5&&u_segmented[${i}]>.5){vec2 d=flow(uv,u_geometry[${i}],u_motion[${i}],u_kind[${i}])*amount;float before=region(${i},uv);float moved=region(${i},uv-d);color=mix(color,texture2D(u_plate,uv).rgb,max(0.,before-moved));color=mix(color,texture2D(u_source,uv-d).rgb,moved*(1.-texture2D(u_protect,uv).a));}`).join('\n')}
 gl_FragColor=vec4(color,1.);
}`
export function createSmartThemeArt(doc: Document, theme: CustomTheme, ctx?: Context): LandscapeArt | null {
  const motion = theme.smartMotion, win = doc.defaultView
  if (!motion || !win) return null
  const canvas = doc.createElement('canvas'); canvas.dataset.qytSmartMotion = 'loading'
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;visibility:hidden;pointer-events:none;'
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false })
  if (!gl) {
    canvas.dataset.qytSmartMotion = 'failed'
    return { element: canvas, draw() {}, dispose() { canvas.remove() } }
  }
  const controller = new AbortController(), shaders: WebGLShader[] = [], textures: WebGLTexture[] = [], images: HTMLImageElement[] = []
  let revealAt: number | null = null
  let disposed = false, failed = false, ready = false, program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null
  const lost = (event: Event) => { event.preventDefault(); failed = true; canvas.dataset.qytSmartMotion = 'failed'; canvas.style.visibility = 'hidden' }
  canvas.addEventListener('webglcontextlost', lost)
  const dispose = () => {
    if (disposed) return
    disposed = true; controller.abort(); canvas.removeEventListener('webglcontextlost', lost)
    for (const image of images) { image.onload = image.onerror = null; image.src = '' }
    for (const texture of textures) gl.deleteTexture(texture)
    for (const shader of shaders) gl.deleteShader(shader)
    if (buffer) gl.deleteBuffer(buffer); if (program) gl.deleteProgram(program)
    gl.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove(); canvas.width = canvas.height = 1
  }
  try {
    const compile = (type: number, text: string) => {
      const shader = gl.createShader(type); if (!shader) throw new Error('renderer-unavailable')
      shaders.push(shader); gl.shaderSource(shader, text); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'renderer-unavailable')
      return shader
    }
    program = gl.createProgram(); if (!program) throw new Error('renderer-unavailable')
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, SMART_MOTION_FRAGMENT)); gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('renderer-unavailable')
    gl.useProgram(program); buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW)
    const attribute = gl.getAttribLocation(program, 'a_position'); gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0)
    const uniform = (name: string) => gl.getUniformLocation(program!, name)
    const geometry = new Float32Array(32), tuning = new Float32Array(32), kinds = new Float32Array(8), segmented = new Float32Array(8)
    motion.regions.forEach((r, i) => { geometry.set([...r.anchor, ...r.tip], i * 4); tuning.set([r.amplitude, r.speed, r.direction * Math.PI / 180, r.enabled ? 1 : 0], i * 4); segmented[i] = r.segmentation && ['sway','wave'].includes(r.kind) ? 1 : 0; kinds[i] = ['sway', 'wave', 'drift', 'ripple', 'float', 'pulse'].indexOf(r.kind) })
    gl.uniform4fv(uniform('u_geometry[0]'), geometry); gl.uniform4fv(uniform('u_motion[0]'), tuning); gl.uniform1fv(uniform('u_kind[0]'), kinds); gl.uniform1fv(uniform('u_segmented[0]'), segmented)
    const time = uniform('u_time'), reveal = uniform('u_reveal'), size = uniform('u_size'), imageSize = uniform('u_image'), position = uniform('u_position')
    gl.uniform1f(uniform('u_strength'), theme.intensity)
    void (async () => {
      const assets = await loadMotionAssets(ctx, motion.assetId, controller.signal)
      if (assets.sourceHash !== await digest(theme.image) || motion.sourceHash !== assets.sourceHash || assets.maskHash !== await digest(maskSignature(motion, motion.strokes))) throw new Error('invalid-assets')
      const sources = [assets.source, assets.plate, ...assets.masks, assets.protection], names = ['u_source', 'u_plate', 'u_mask0', 'u_mask1', 'u_mask2', 'u_protect']
      await Promise.all(sources.map((source, i) => new Promise<void>((resolve, reject) => {
        const image = new win.Image(); images.push(image)
        image.onerror = () => reject(new Error('invalid-assets'))
        image.onload = () => {
          if (disposed || failed) { resolve(); return }
          if (!image.naturalWidth || image.naturalWidth > 2048 || image.naturalHeight > 2048) { reject(new Error('invalid-assets')); return }
          const texture = gl.createTexture(); if (!texture) { reject(new Error('renderer-unavailable')); return }
          textures.push(texture); gl.useProgram(program); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, texture)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
          let upload: TexImageSource = image
          // Older saved assets retain their identity; prepare soft boundaries
          // in memory instead of requiring another API request or overwriting.
          if (i >= 2 && i <= 4 && assets.maskVersion !== 2) {
            const mask = doc.createElement('canvas'); mask.width = image.naturalWidth; mask.height = image.naturalHeight
            const context = mask.getContext('2d', { willReadFrequently: true })
            if (!context) { reject(new Error('renderer-unavailable')); return }
            context.drawImage(image, 0, 0); const rgba = context.getImageData(0, 0, mask.width, mask.height)
            for (let c = 0; c < 3; c++) {
              const channel = new Uint8ClampedArray(mask.width * mask.height)
              for (let p = 0; p < channel.length; p++) channel[p] = rgba.data[p * 4 + c]
              const soft = featherMotionMask(channel, mask.width, mask.height)
              for (let p = 0; p < channel.length; p++) rgba.data[p * 4 + c] = soft[p]
            }
            context.putImageData(rgba, 0, 0); upload = mask
          }
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, upload); gl.uniform1i(uniform(names[i]), i); resolve()
        }
        image.src = source
      })))
      if (disposed || failed) return
      gl.useProgram(program); gl.uniform2f(imageSize, assets.width, assets.height); ready = true
    })().catch(error => { if (!disposed) { failed = true; canvas.dataset.qytSmartMotion = 'failed'; canvas.style.visibility = 'hidden' } })
    return { element: canvas, dispose, draw(seconds) {
      if (disposed || failed || !ready) return
      const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return
      const dpr = Math.min(win.devicePixelRatio || 1, 1.5, Math.sqrt(1_500_000 / (rect.width * rect.height)))
      const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      const preview = win.getComputedStyle(doc.body).getPropertyValue('--qyt-preview-art-position').trim().match(/^([\d.]+)%\s+([\d.]+)%$/)
      gl.useProgram(program); gl.viewport(0, 0, w, h); gl.uniform2f(size, rect.width, rect.height); gl.uniform2f(position, preview ? Number(preview[1]) / 100 : theme.x / 100, preview ? Number(preview[2]) / 100 : theme.y / 100); gl.uniform1f(time, seconds); revealAt ??= seconds; gl.uniform1f(reveal, Math.min(1, (seconds - revealAt) / 1.2))
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      if (gl.getError() !== gl.NO_ERROR) { failed = true; canvas.style.visibility = 'hidden'; canvas.dataset.qytSmartMotion = 'failed'; return }
      canvas.style.visibility = 'visible'
      if (canvas.dataset.qytSmartMotion !== 'ready') canvas.dataset.qytSmartMotion = 'ready'
    } }
  } catch (error) {
    dispose(); canvas.dataset.qytSmartMotion = 'failed'
    return { element: canvas, draw() {}, dispose() { canvas.remove() } }
  }
}
