import { maskSignature, type MotionCrop, type MotionPlan, type MotionStroke, type MotionAssets, type MotionPoint } from '../smart-motion.ts'
import type { Context } from '@deepseek-ai/cordis'
import { segmentMotionObjects, motionSegmentationCandidates } from './smart-segmentation.ts'
import { digest, cacheMotionAssets } from './smart-theme-api.ts'
export async function decodeMotionImage(source: string): Promise<HTMLImageElement> {
  const image = new Image(); image.src = source; await image.decode()
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 4096 || image.naturalHeight > 4096) throw new Error('invalid-assets')
  return image
}
export function canvas2d(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) throw new Error('renderer-unavailable')
  return [canvas, context]
}
/** Magnify each candidate with context; do not draw the proposal over its edges,
 * which would bias the reviewer toward repeating the original coarse outline. */
export async function prepareMotionReview(source: string, plan: MotionPlan, signal: AbortSignal, services?: Context, selectedOnly = false): Promise<{ image: string; crops: MotionCrop[]; choices: Record<string, number[]> }> {
  const image = await decodeMotionImage(source); signal.throwIfAborted()
  const crops = plan.regions.map(region => {
    const xs = region.polygon.map(p => p[0] * image.naturalWidth), ys = region.polygon.map(p => p[1] * image.naturalHeight)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2
    let width = Math.max(100, (Math.max(...xs) - Math.min(...xs)) * 1.35), height = Math.max(75, (Math.max(...ys) - Math.min(...ys)) * 1.35)
    width = Math.min(image.naturalWidth, Math.max(width, height * 4 / 3)); height = Math.min(image.naturalHeight, Math.max(height, width * 3 / 4))
    const x = Math.max(0, Math.min(image.naturalWidth - width, cx - width / 2)), y = Math.max(0, Math.min(image.naturalHeight - height, cy - height / 2))
    return { id: region.id, x: x / image.naturalWidth, y: y / image.naturalHeight, width: width / image.naturalWidth, height: height / image.naturalHeight }
  })
  const targets=plan.regions.filter(r=>['sway','wave','float'].includes(r.kind)).map(r=>({...r,segmentation:{crop:crops.find(c=>c.id===r.id)!,positive:[],negative:[]}}))
  const candidates=await motionSegmentationCandidates(services,image,source,targets,signal)
  const numbers=plan.regions.map(r=>selectedOnly&&r.segmentation?.choice!==undefined?[r.segmentation.choice]:(candidates.get(r.id)?.map((_,i)=>i)??[0]))
  const rows=numbers.map(list=>Math.max(1,Math.ceil(list.length/8)))
  const [contact, paint]=canvas2d(1440,rows.reduce((a,b)=>a+b,0)*160),choices:Record<string,number[]>={}
  paint.fillStyle='#141a24';paint.fillRect(0,0,contact.width,contact.height)
  for(const [index,r]of plan.regions.entries()){
    const crop=crops[index], masks=candidates.get(r.id), y=rows.slice(0,index).reduce((a,b)=>a+b,0)*160
    choices[r.id]=numbers[index]
    for(let row=0;row<rows[index];row++){
      const ty=y+row*160, pictures=[null,...numbers[index].slice(row*8,row*8+8).map(n=>masks?.[n]??null)]
      paint.fillStyle='#fff';paint.font='bold 14px sans-serif';paint.fillText(r.id+' · '+r.label,8,ty+17,1400)
      for(let i=0;i<pictures.length;i++){
        const x=i*160;paint.fillStyle='#fff';paint.font='12px sans-serif';paint.fillText(i===0?'ORIGINAL':String(numbers[index][row*8+i-1]),x+5,ty+35)
        paint.drawImage(image,crop.x*image.naturalWidth,crop.y*image.naturalHeight,crop.width*image.naturalWidth,crop.height*image.naturalHeight,x,ty+40,160,120)
        if(i){const [overlay,context]=canvas2d(160,120)
          if(pictures[i])context.drawImage(pictures[i]!,crop.x*image.naturalWidth,crop.y*image.naturalHeight,crop.width*image.naturalWidth,crop.height*image.naturalHeight,0,0,160,120)
          else{context.fillStyle='#fff';path(context,r.polygon.map(([px,py])=>[(px-crop.x)/crop.width,(py-crop.y)/crop.height]),160,120)}
          context.globalCompositeOperation='source-in';context.fillStyle='rgba(255,0,110,.78)';context.fillRect(0,0,160,120);paint.drawImage(overlay,x,ty+40)
        }
      }
    }
  }
  signal.throwIfAborted()
  if(selectedOnly){const [large,context]=canvas2d(960,480);context.drawImage(contact,0,0,320,160,0,0,960,480);return {image:large.toDataURL('image/webp',.95),crops,choices}}
  return { image: contact.toDataURL('image/webp', .93), crops, choices }
}
function path(ctx: CanvasRenderingContext2D, polygon: MotionPoint[], w: number, h: number) {
  ctx.beginPath(); polygon.forEach(([x, y], i) => i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)); ctx.closePath(); ctx.fill()
}
/** Edge-aware smoothing preserves strong color boundaries instead of blurring a cutout into its background. */
export function refineMotionMask(mask: Uint8ClampedArray, image: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const result = new Uint8ClampedArray(mask.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let sum = 0, weights = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = Math.max(0, Math.min(w - 1, x + dx)), ny = Math.max(0, Math.min(h - 1, y + dy)), j = ny * w + nx
      const distance = Math.abs(image[i * 4] - image[j * 4]) + Math.abs(image[i * 4 + 1] - image[j * 4 + 1]) + Math.abs(image[i * 4 + 2] - image[j * 4 + 2])
      const weight = 1 / (1 + distance * distance / 900) / (1 + dx * dx + dy * dy)
      sum += mask[j] * weight; weights += weight
    }
    result[i] = sum / weights
  }
  return result
}
/** A distance feather pins the full boundary, including holes around protected
 * faces. This prevents coarse AI polygons from becoming visibly moving patches. */
export function featherMotionMask(mask: Uint8ClampedArray, w: number, h: number, radius?: number): Uint8ClampedArray {
  const distance = new Float32Array(mask.length), output = new Uint8ClampedArray(mask.length)
  let left = w, right = -1, top = h, bottom = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    if (mask[i] < 16) continue
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
    distance[i] = x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 1 : 1e6
  }
  if (right < left) return output
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    if (x) distance[i] = Math.min(distance[i], distance[i - 1] + 1)
    if (y) distance[i] = Math.min(distance[i], distance[i - w] + 1)
    if (x && y) distance[i] = Math.min(distance[i], distance[i - w - 1] + 1.414)
    if (y && x < w - 1) distance[i] = Math.min(distance[i], distance[i - w + 1] + 1.414)
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x
    if (x < w - 1) distance[i] = Math.min(distance[i], distance[i + 1] + 1)
    if (y < h - 1) distance[i] = Math.min(distance[i], distance[i + w] + 1)
    if (x < w - 1 && y < h - 1) distance[i] = Math.min(distance[i], distance[i + w + 1] + 1.414)
    if (x && y < h - 1) distance[i] = Math.min(distance[i], distance[i + w - 1] + 1.414)
  }
  const feather = radius ?? Math.min(20, Math.max(3, Math.min(right - left + 1, bottom - top + 1) * .14))
  for (let i = 0; i < mask.length; i++) { const value = Math.min(1, Math.max(0, (distance[i] - 1) / feather)); output[i] = mask[i] * value * value * (3 - 2 * value) }
  return output
}
/** Local nearest-boundary texture extension, used only under moving cutouts.
 * It reconstructs the narrow reveal margin; it does not invent hidden scene semantics. */
export function extendMotionBackground(pixels: Uint8ClampedArray, erase: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const count = width * height, output = new Uint8ClampedArray(pixels), known = new Uint8Array(count), queue = new Uint32Array(count)
  let tail = 0, head = 0
  for (let i = 0; i < count; i++) known[i] = erase[i] < 8 ? 1 : 0
  for (let i = 0; i < count; i++) if (known[i] && ((i % width && !known[i - 1]) || (i % width < width - 1 && !known[i + 1]) || (i >= width && !known[i - width]) || (i + width < count && !known[i + width]))) queue[tail++] = i
  while (head < tail) {
    const i = queue[head++]
    for (const j of [i % width ? i - 1 : -1, i % width < width - 1 ? i + 1 : -1, i >= width ? i - width : -1, i + width < count ? i + width : -1]) {
      if (j < 0 || known[j]) continue
      known[j] = 1; queue[tail++] = j
      for (let c = 0; c < 3; c++) output[j * 4 + c] = output[i * 4 + c]
    }
  }
  return output
}
export async function prepareMotionAssets(source: string, previewImage: string, plan: MotionPlan, strokes: MotionStroke[], signal: AbortSignal, services?: Context): Promise<{ assetId: string; sourceHash: string }> {
  const image = await decodeMotionImage(source); signal.throwIfAborted()
  const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.max(1, Math.round(image.naturalWidth * scale)), h = Math.max(1, Math.round(image.naturalHeight * scale))
  const [base, ctx] = canvas2d(w, h); ctx.drawImage(image, 0, 0, w, h)
  const selections = await segmentMotionObjects(services, image, source, plan, signal)
  const pixels = ctx.getImageData(0, 0, w, h)
  const [protection, protect] = canvas2d(w, h)
  protect.fillStyle = '#fff'; for (const polygon of plan.protect) path(protect, polygon, w, h)
  for (const stroke of strokes.filter(s => s.mode === 'protect')) drawStroke(protect, stroke, w, h)
  const protectedPixels = protect.getImageData(0, 0, w, h).data
  const masks: Uint8ClampedArray[] = [], erase = new Uint8ClampedArray(w * h)
  for (const region of plan.regions) {
    signal.throwIfAborted()
    const [canvas, context] = canvas2d(w, h); context.fillStyle = '#fff'; const selection = selections.get(region.id); if (selection) context.drawImage(selection, 0, 0, w, h); else path(context, region.polygon, w, h)
    for (const stroke of strokes.filter(s => s.regionId === region.id && s.mode !== 'protect')) {
      context.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over'; drawStroke(context, stroke, w, h)
    }
    const rgba = context.getImageData(0, 0, w, h).data, mask = new Uint8ClampedArray(w * h)
    for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3] * (1 - protectedPixels[i * 4 + 3] / 255)
    const refined = refineMotionMask(mask, pixels.data, w, h)
    for (let i = 0; i < mask.length; i++) { refined[i] *= 1 - protectedPixels[i * 4 + 3] / 255; if (!['ripple', 'pulse'].includes(region.kind)) erase[i] = Math.max(erase[i], refined[i]) }
    masks.push(featherMotionMask(refined, w, h, selection ? 2 : undefined)); canvas.width = canvas.height = 1
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  const atlases = Array.from({ length: 3 }, (_, atlas) => {
    const [canvas, context] = canvas2d(w, h), data = context.createImageData(w, h)
    for (let i = 0; i < w * h; i++) { for (let c = 0; c < 3; c++) data.data[i * 4 + c] = masks[atlas * 3 + c]?.[i] ?? 0; data.data[i * 4 + 3] = 255 }
    context.putImageData(data, 0, 0); return canvas.toDataURL('image/png')
  }) as [string, string, string]
  const [plate, plateContext] = canvas2d(w, h)
  const platePixels = plateContext.createImageData(w, h); platePixels.data.set(extendMotionBackground(pixels.data, erase, w, h)); plateContext.putImageData(platePixels, 0, 0)
  const sourceHash = await digest(previewImage)
  const assets: MotionAssets = { version: 1, maskVersion: 2, sourceHash, maskHash: await digest(maskSignature(plan, strokes)), width: image.naturalWidth, height: image.naturalHeight, source, plate: plate.toDataURL('image/webp', .9), masks: atlases, protection: protection.toDataURL('image/png') }
  signal.throwIfAborted()
  const assetId = await cacheMotionAssets(assets)
  base.width = base.height = 1; return { assetId, sourceHash }
}
function drawStroke(ctx: CanvasRenderingContext2D, stroke: MotionStroke, w: number, h: number) {
  ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = stroke.radius * w * 2; ctx.lineCap = ctx.lineJoin = 'round'
  ctx.beginPath(); stroke.points.forEach(([x, y], i) => i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)); ctx.stroke()
  if (stroke.points.length === 1) { ctx.beginPath(); ctx.arc(stroke.points[0][0] * w, stroke.points[0][1] * h, stroke.radius * w, 0, Math.PI * 2); ctx.fill() }
}
