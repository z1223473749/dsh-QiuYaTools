import type { Context } from '@deepseek-ai/cordis'
import type { MotionPlan, MotionRegion } from '../smart-motion.ts'
import { smartThemeRequest } from './smart-theme-api.ts'
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), c => c.charCodeAt(0))
/** In-memory reuse avoids repeating inference after each brush stroke. */
let cachedSource = ''; const cache = new Map<string, { signature: string; masks: HTMLCanvasElement[]; complete: boolean }>()
export function releaseMotionSegmentation(source?: string): void {
  if (source && source !== cachedSource) return
  for (const entry of cache.values()) for (const mask of entry.masks) if (mask) mask.width = mask.height = 1
  cache.clear(); cachedSource = ''
}
export async function segmentMotionObjects(ctx: Context | undefined, image: HTMLImageElement, source: string, plan: MotionPlan, signal: AbortSignal): Promise<Map<string, HTMLCanvasElement>> {
  const regions = plan.regions.filter(r=>r.segmentation)
  const candidates = await motionSegmentationCandidates(ctx,image,source,regions,signal,false)
  return new Map(regions.map(r=>{const mask=candidates.get(r.id)?.[r.segmentation?.choice??0];if(!mask)throw new Error('segmentation-unavailable');return [r.id,mask]}))
}
export async function motionSegmentationCandidates(ctx: Context | undefined, image: HTMLImageElement, source: string, input: MotionRegion[], signal: AbortSignal, complete = true): Promise<Map<string, HTMLCanvasElement[]>> {
  if(cachedSource!==source){for(const entry of cache.values())for(const mask of entry.masks)if(mask)mask.width=mask.height=1;cache.clear();cachedSource=source}
  const signature=(r:MotionRegion)=>JSON.stringify([r.segmentation?.crop,r.segmentation?.choice===undefined?r.segmentation?.positive:[],r.segmentation?.choice===undefined?r.segmentation?.negative:[]])
  const regions=input.filter(r=>cache.get(r.id)?.signature!==signature(r)||complete&&!cache.get(r.id)?.complete)
  const existing=()=>new Map(input.map(r=>[r.id,cache.get(r.id)!.masks]))
  if(!regions.length)return existing()
  if (!ctx) throw new Error('segmentation-unavailable')
  const entries = await Promise.all(['worker', 'ort', 'binding', 'wasm', 'encoder', 'decoder'].map(async part => [part, decode(await smartThemeRequest<string>(ctx, 'runtime', { part }, signal))] as const))
  signal.throwIfAborted(); const runtime = Object.fromEntries(entries), url = URL.createObjectURL(new Blob([new Uint8Array(runtime.worker)], { type: 'text/javascript' }))
  const worker = new Worker(url, { type: 'module' })
  const jobs = regions.map(r => {
    const s = r.segmentation!, crop = s.crop, canvas = document.createElement('canvas')
    const w = crop.width * image.naturalWidth, h = crop.height * image.naturalHeight, scale = 512 / Math.max(w, h)
    canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale))
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(image, crop.x * image.naturalWidth, crop.y * image.naturalHeight, crop.width * image.naturalWidth, crop.height * image.naturalHeight, 0, 0, canvas.width, canvas.height)
    const local = ([x, y]: number[]) => [Math.max(0, Math.min(1, (x - crop.x) / crop.width)), Math.max(0, Math.min(1, (y - crop.y) / crop.height))]
    return { id: r.id, proposals: s.choice!==undefined||!s.positive.length, width: canvas.width, height: canvas.height, rgba: context.getImageData(0, 0, canvas.width, canvas.height).data.buffer, positive: s.positive.map(local), negative: s.negative.map(local) }
  })
  try {
    const result = await new Promise<any>((resolve, reject) => {
      const stop = () => finish(undefined, new Error('cancelled')), timer = setTimeout(() => finish(undefined, new Error('segmentation-unavailable')), 90_000)
      const finish = (value?: unknown, error?: Error) => { clearTimeout(timer); signal.removeEventListener('abort', stop); error ? reject(error) : resolve(value) }
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) { finish(undefined, new Error('cancelled')); return }
      worker.onmessage = ({ data }) => data.ok ? finish(data.outputs) : finish(undefined, new Error('segmentation-unavailable'))
      worker.onerror = () => finish(undefined, new Error('segmentation-unavailable'))
      worker.postMessage({ runtime, jobs }, [...Object.values(runtime).map(b => b.buffer), ...jobs.map(j => j.rgba)])
    })
    signal.throwIfAborted(); const masks = new Map<string, HTMLCanvasElement[]>()
    for (const output of result) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256
      const context = canvas.getContext('2d')!, rgba = context.createImageData(256, 256)
      for (let i = 0; i < output.mask.length; i++) { rgba.data[i * 4] = rgba.data[i * 4 + 1] = rgba.data[i * 4 + 2] = 255; rgba.data[i * 4 + 3] = output.mask[i] }
      context.putImageData(rgba, 0, 0)
      const mask = document.createElement('canvas'); mask.width = image.naturalWidth; mask.height = image.naturalHeight
      const crop = regions.find(r => r.id === output.id)!.segmentation!.crop
      mask.getContext('2d')!.drawImage(canvas, 0, 0, output.width, output.height, crop.x * mask.width, crop.y * mask.height, crop.width * mask.width, crop.height * mask.height)
      const list=masks.get(output.id)??[];list[output.choice??0]=mask;masks.set(output.id,list)
    }
    for(const r of regions){const list=masks.get(r.id);if(!list?.length)throw new Error('segmentation-unavailable');cache.set(r.id,{signature:signature(r),masks:list,complete:true})}
    return existing()
  } finally { worker.terminate(); URL.revokeObjectURL(url) }
}
/** The overview anchor can sit on adjacent skin. Snap it to the selected
 * material before bending so the actual attachment stays still. */
export async function alignSegmentedMotion(ctx: Context | undefined, source: string, plan: MotionPlan, signal: AbortSignal): Promise<MotionPlan> {
  const image = new Image(); image.src = source; await image.decode(); signal.throwIfAborted()
  const masks = await segmentMotionObjects(ctx, image, source, plan, signal)
  const aligned = { ...plan, regions: plan.regions.map(region => {
    const mask = masks.get(region.id)
    if (!mask || !['sway','wave'].includes(region.kind)) return region
    const pixels = mask.getContext('2d')!.getImageData(0,0,mask.width,mask.height).data
    return { ...region, ...snapMotionGeometry(region, pixels, mask.width, mask.height) }
  }) }
  // Review grids are temporary: keep only the selected full-image mask per
  // object instead of retaining up to 24 large canvases for all eight objects.
  for(const region of plan.regions){const choice=region.segmentation?.choice,entry=cache.get(region.id);if(choice===undefined||!entry)continue;const selected=entry.masks[choice];for(const [index,mask]of entry.masks.entries())if(mask&&index!==choice)mask.width=mask.height=1;entry.masks=[];entry.masks[choice]=selected;entry.complete=false}
  return aligned
}
export function snapMotionGeometry(region: MotionRegion, pixels: Uint8ClampedArray, width: number, height: number): Pick<MotionRegion,'anchor'|'tip'> {
  const nearest = (point: number[]) => {
    let best = Infinity, result = point as [number,number]
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(pixels[(y*width+x)*4+3]>127){
      const distance=(x-point[0]*width)**2+(y-point[1]*height)**2
      if(distance<best){best=distance;result=[(x+.5)/width,(y+.5)/height]}
    }
    return result
  }
  const anchor=nearest(region.anchor),tip=nearest(region.tip)
  return Math.hypot((tip[0]-anchor[0])*width,(tip[1]-anchor[1])*height)>2 ? {anchor,tip} : {anchor:region.anchor,tip:region.tip}
}
