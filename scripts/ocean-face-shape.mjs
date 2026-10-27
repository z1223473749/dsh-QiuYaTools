/** Original-art fidelity and rigid face geometry from actual GPU frames. */
import assert from 'node:assert/strict'
import{readFile,writeFile}from'node:fs/promises'
import{join}from'node:path'
export async function inspectFaceShape(page,output,{enforce=true}={}){
  const original=`data:image/webp;base64,${(await readFile(new URL('../assets/q-ocean-scene.webp',import.meta.url))).toString('base64')}`
  const epochs=[0,.5,1,1.5,2.25,3.75,4.5,5.25,6,8,12],frames=[]
  for(const epoch of epochs)frames.push(await page.evaluate(time=>window.__oceanFixture.captureAt(time),epoch))
  const result = await page.evaluate(async ({ frames, epochs, original }) => {
    async function decode(source) { const image = new Image(); image.src = source; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0); return { canvas, pixels: ctx.getImageData(0, 0, image.width, image.height).data } }
    const decoded = await Promise.all(frames.map(decode)), source = await decode(original), scene = document.querySelector('canvas[data-qyt-ocean-scene]'), bounds = scene.getBoundingClientRect(), fit = Math.max(innerWidth / 1600, innerHeight / 900)
    const point = (x, y) => [(innerWidth - 1600 * fit + x * fit - bounds.left) * scene.width / bounds.width, (innerHeight - 900 * fit + y * fit - bounds.top) * scene.height / bounds.height]
    const landmarks = { nose: [1057, 405, 5], eye: [1077, 397, 5], mouth: [1065, 411, 5], ear: [1107, 411, 6], temple: [1098, 402, 5] }
    const regions = Object.fromEntries(Object.entries(landmarks).map(([name, [x, y, radius]]) => { const p = point(x, y); return [name, { x: p[0], y: p[1], radius: radius * fit }] }))
    function sample(data, x, y, channel) {
      const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, width = scene.width
      const at = (a, b) => data[(b * width + a) * 4 + channel]
      return at(ix, iy) * (1 - fx) * (1 - fy) + at(ix + 1, iy) * fx * (1 - fy) + at(ix, iy + 1) * (1 - fx) * fy + at(ix + 1, iy + 1) * fx * fy
    }
    function match(target, roi, center = { dx: 0, dy: 0 }, limit = 16) {
      const reference = decoded[0].pixels, points = []
      for (let y = Math.ceil(roi.y - roi.radius); y < roi.y + roi.radius; y++) for (let x = Math.ceil(roi.x - roi.radius); x < roi.x + roi.radius; x++) {
        const p = (y * scene.width + x) * 4
        if (Math.abs(reference[p] - reference[p + 4]) + Math.abs(reference[p] - reference[p + scene.width * 4]) > 5) points.push([x, y, p])
      }
      const score = (dx, dy) => { let sum = 0; for (const [x, y, p] of points) for (let c = 0; c < 3; c++) sum += Math.abs(reference[p + c] - sample(target, x + dx, y + dy, c)); return sum / Math.max(1, points.length * 3) }
      let best = { dx: 0, dy: 0, error: Infinity }
      for (let dy = Math.round(center.dy) - limit; dy <= Math.round(center.dy) + limit; dy++) for (let dx = Math.round(center.dx) - limit; dx <= Math.round(center.dx) + limit; dx++) { const error = score(dx, dy); if (error < best.error) best = { dx, dy, error } }
      const coarse = best
      for (let dy = coarse.dy - .75; dy <= coarse.dy + .75; dy += .25) for (let dx = coarse.dx - .75; dx <= coarse.dx + .75; dx += .25) { const error = score(dx, dy); if (error < best.error) best = { dx, dy, error } }
      return best
    }
    const measurements = epochs.map((epoch, index) => {
      const nose = index ? match(decoded[index].pixels, regions.nose) : { dx: 0, dy: 0, error: 0 }
      const points = Object.fromEntries(Object.entries(regions).map(([name, roi]) => [name, name === 'nose' ? nose : index ? match(decoded[index].pixels, roi, nose, 7) : { dx: 0, dy: 0, error: 0 }]))
      return { epoch, points }
    })
    const pairs = [['nose', 'eye'], ['nose', 'mouth'], ['eye', 'ear'], ['mouth', 'ear'], ['eye', 'temple']]
    const pairChanges = measurements.map(value => ({ epoch: value.epoch, changes: Object.fromEntries(pairs.map(([a, b]) => { const pa = regions[a], pb = regions[b], da = value.points[a], db = value.points[b]; return [`${a}-${b}`, Math.hypot(pb.x - pa.x + db.dx - da.dx, pb.y - pa.y + db.dy - da.dy) - Math.hypot(pb.x - pa.x, pb.y - pa.y)] })) }))
    const crops = {}, [x, y] = point(1045, 348), [right, bottom] = point(1155, 445)
    for (let index = 0; index < decoded.length; index++) { const crop = document.createElement('canvas'); crop.width = 660; crop.height = 582; crop.getContext('2d').drawImage(decoded[index].canvas, x, y, right - x, bottom - y, 0, 0, 660, 582); crops[String(epochs[index])] = crop.toDataURL('image/png') }
    const ref = document.createElement('canvas'); ref.width = 660; ref.height = 582; ref.getContext('2d').drawImage(source.canvas, 1045, 348, 110, 97, 0, 0, 660, 582)
    let skinPixels=0,missingSkinPixels=0;
    const skin=(x,y)=>{const i=(y*source.canvas.width+x)*4;return source.pixels[i]>source.pixels[i+1]+8&&source.pixels[i+1]>source.pixels[i+2]+8&&source.pixels[i]-source.pixels[i+2]>35};
    for(let y=385;y<=434;y++)for(let x=1050;x<=1118;x++){if(!skin(x,y)||!skin(x-1,y)||!skin(x+1,y)||!skin(x,y-1)||!skin(x,y+1))continue;skinPixels++;const [px,py]=point(x+.5,y+.5),i=(y*source.canvas.width+x)*4;let difference=0;for(let c=0;c<3;c++)difference+=Math.abs(source.pixels[i+c]-sample(decoded[0].pixels,px-.5,py-.5,c));const actual=[0,1,2].map(c=>sample(decoded[0].pixels,px-.5,py-.5,c));const retainsSkin=actual[0]>actual[1]+4&&actual[1]>actual[2]+5&&actual[0]-actual[2]>25;if(difference/3>12&&!retainsSkin)missingSkinPixels++;}
    const fidelity={skinPixels,missingSkinPixels,missingSkinFraction:missingSkinPixels/Math.max(1,skinPixels)};
    const maxPairDistanceChangePx=Math.max(...pairChanges.flatMap(v=>Object.values(v.changes).map(Math.abs)));
    return { epochs, regions, measurements, pairChanges, fidelity, maxPairDistanceChangePx, crops, original: ref.toDataURL('image/png') }
  }, { frames, epochs, original })
  const oldFace=await readFile(join(output,'v4-before','face-0s.png')).catch(()=>null)
  const comparison=await page.evaluate(async items=>{
    const canvas=document.createElement('canvas');canvas.width=660*items.length;canvas.height=614
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fafaf8';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#24282b';ctx.font='18px sans-serif'
    for(let i=0;i<items.length;i++){const image=new Image();image.src=items[i].source;await image.decode();ctx.fillText(items[i].label,i*660+12,23);ctx.drawImage(image,i*660,32,660,582)}
    return canvas.toDataURL('image/png')
  },[{label:'Original artwork',source:result.original},...(oldFace?[{label:'v4 clipped cheek',source:`data:image/png;base64,${oldFace.toString('base64')}`}]:[]),{label:'Current t = 0s',source:result.crops['0']},{label:'Current t = 2.25s',source:result.crops['2.25']}])
  await writeFile(join(output,'face-shape-comparison.png'),Buffer.from(comparison.split(',')[1],'base64'))
  for(const[epoch,data]of Object.entries(result.crops))await writeFile(join(output,`face-phase-${epoch}s.png`),Buffer.from(data.split(',')[1],'base64'))
  await writeFile(join(output,'face-original.png'),Buffer.from(result.original.split(',')[1],'base64'))
  await page.evaluate(()=>window.__oceanFixture.resumeTime())
  const{crops,original:reference,...report}=result
  await writeFile(join(output,'face-shape.json'),JSON.stringify(report,null,2)+'\n')
  if(enforce){assert.ok(report.fidelity.missingSkinFraction<=.01,`Original face skin must be preserved at t=0: ${report.fidelity.missingSkinPixels}/${report.fidelity.skinPixels} missing pixels`);assert.ok(report.maxPairDistanceChangePx<=1,`Face/ear landmark distances must stay rigid: ${report.maxPairDistanceChangePx}px`)}
  return report
}
