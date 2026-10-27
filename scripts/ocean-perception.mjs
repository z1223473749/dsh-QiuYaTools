/** Perceptual acceptance uses real rendered pixels, with a fixed shader clock. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function inspectWakeMotion(page, output) {
  const epochs = [0, .2, .35, .5, .65, .75, .8, 1, 1.2, 1.5, 2.25, 3, 3.75, 4.5, 5.25, 6], baseFrames = [], foam = []
  for (const epoch of epochs) {
    const full = await page.evaluate(time => window.__oceanFixture.captureAt(time), epoch)
    for (const [name, clip] of Object.entries({ front: { x: 550, y: 690, width: 285, height: 215 }, right: { x: 1210, y: 690, width: 200, height: 210 }, fin: { x: 865, y: 725, width: 540, height: 265 } })) await page.screenshot({ path: join(output, `wake-${name}-${epoch}s.png`), clip })
    const base = await page.evaluate(time => window.__oceanFixture.captureAt(time, { skipLayers: [2] }), epoch)
    baseFrames.push(base)
    foam.push(await page.evaluate(async ({ full, base, epoch }) => {
      async function decode(source) { const image = new Image(); image.src = source; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, image.width, image.height) }
      const [a, b] = await Promise.all([decode(full), decode(base)]), scene = document.querySelector('canvas[data-qyt-ocean-scene]'), bounds = scene.getBoundingClientRect()
      function measure(rect) {
        let energy = 0, brightenedPixels = 0
        for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
          const offset = (Math.round((y - bounds.top) * a.height / bounds.height) * a.width + Math.round((x - bounds.left) * a.width / bounds.width)) * 4
          const delta = (a.data[offset] + a.data[offset + 1] + a.data[offset + 2] - b.data[offset] - b.data[offset + 1] - b.data[offset + 2]) / 3
          if (Math.min(a.data[offset], a.data[offset + 1], a.data[offset + 2]) > 190 && delta > 8) { energy += delta; brightenedPixels++ }
        }
        return { brightenedPixels, energy }
      }
      return { epoch, front: measure({ x: 550, y: 690, width: 285, height: 215 }), right: measure({ x: 1210, y: 690, width: 200, height: 210 }) }
    }, { full, base, epoch }))
  }
  const fin = await page.evaluate(async ({ frames, epochs }) => {
    const scene = document.querySelector('canvas[data-qyt-ocean-scene]'), bounds = scene.getBoundingClientRect(), fit = Math.max(innerWidth / 1600, innerHeight / 900)
    const images = await Promise.all(frames.map(async source => { const image = new Image(); image.src = source; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, image.width, image.height).data }))
    const point = (x, y) => [(innerWidth - 1600 * fit + x * fit - bounds.left) * scene.width / bounds.width, (innerHeight - 900 * fit + y * fit - bounds.top) * scene.height / bounds.height]
    const regions = Object.fromEntries(Object.entries({ body: [1008, 600, 1050, 631], torso: [1335, 620, 1375, 650], inner: [1190, 725, 1260, 775], tip: [1420, 800, 1485, 840] }).map(([name, r]) => { const [x, y] = point(r[0], r[1]), [right, bottom] = point(r[2], r[3]); return [name, { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) }] }))
    function match(target, roi, expected = null) {
      const reference = images[0], pixels = [], width = scene.width
      for (let y = roi.y; y < roi.y + roi.height; y += 2) for (let x = roi.x; x < roi.x + roi.width; x += 2) { const offset = (y * width + x) * 4; if (Math.abs(reference[offset] - reference[offset + 4]) + Math.abs(reference[offset] - reference[offset + width * 4]) > 8) pixels.push([x, y, offset]) }
      const score = (dx, dy) => { let sum = 0; for (const [x, y, p] of pixels) { const q = ((y + dy) * width + x + dx) * 4; for (let c = 0; c < 3; c++) sum += Math.abs(reference[p + c] - target[q + c]) } return sum / Math.max(1, pixels.length * 3) }
      let best = { dx: 0, dy: 0, error: Infinity }
      if (expected) {
        for (let dy = expected.dy - 8; dy <= expected.dy + 8; dy++) for (let dx = expected.dx - 8; dx <= expected.dx + 8; dx++) { const error = score(dx, dy); if (error < best.error) best = { dx, dy, error } }
        return best
      }
      for (let dy = -64; dy <= 64; dy += 4) for (let dx = -64; dx <= 64; dx += 4) { const error = score(dx, dy); if (error < best.error) best = { dx, dy, error } }
      const coarse = best
      for (let dy = coarse.dy - 4; dy <= coarse.dy + 4; dy++) for (let dx = coarse.dx - 4; dx <= coarse.dx + 4; dx++) { const error = score(dx, dy); if (error < best.error) best = { dx, dy, error } }
      return best
    }
    const measurements = epochs.map((epoch, index) => {
      const body = index ? match(images[index], regions.body) : { dx: 0, dy: 0 }
      return { epoch, regions: Object.fromEntries(Object.entries(regions).map(([name, roi]) => [name, name === 'body' ? body : index ? match(images[index], roi, name === 'torso' ? body : null) : { dx: 0, dy: 0 }])) }
    })
    const range = list => ({ x: Math.max(...list.map(v => v.dx)) - Math.min(...list.map(v => v.dx)), y: Math.max(...list.map(v => v.dy)) - Math.min(...list.map(v => v.dy)) })
    const relative = Object.fromEntries(['inner', 'tip'].map(name => { const values = measurements.map(v => ({ epoch: v.epoch, dx: v.regions[name].dx - v.regions.body.dx, dy: v.regions[name].dy - v.regions.body.dy })); return [name, { ...range(values), values }] }))
    const eye = regions.body, torso = regions.torso, vector = { x: torso.x + torso.width / 2 - eye.x - eye.width / 2, y: torso.y + torso.height / 2 - eye.y - eye.height / 2 }
    const lengths = measurements.map(v => Math.hypot(vector.x + v.regions.torso.dx - v.regions.body.dx, vector.y + v.regions.torso.dy - v.regions.body.dy))
    return { epochs, measurements, relative, coreLengthVariationPx: Math.max(...lengths) - Math.min(...lengths) }
  }, { frames: baseFrames, epochs })
  await page.evaluate(() => window.__oceanFixture.resumeTime())
  const references = {
    finDisplacement: 'Tip and inner displacements are relative to the distant whale-eye patch. With a flexible spine, the inner-fin value can be reduced by the local attachment frame and is diagnostic only.',
    coreDistance: 'coreLengthVariationPx compares two distant patches and is expected to vary with body bending. It is not a local thickness or rigid-core pass criterion.',
  }
  const report = { fin, foam, references, evidenceBoundary: 'Fin registration uses actual GPU frames with only the foreground-water pass skipped. Foam energy compares complete and skipped-layer-2 frames at the same shader epoch. Phase screenshots retain the normal UI and all passes. Brightness difference supports timing review; visual contact and edge quality still require human inspection.' }
  await writeFile(join(output, 'wake-motion.json'), JSON.stringify(report, null, 2) + '\n')
  assert.ok(fin.relative.tip.y >= 30, `Fin tip must visibly stroke relative to the body: ${fin.relative.tip.y}px`)
  // Inner-fin displacement against the distant eye is diagnostic once the
  // spine flexes: the local attachment frame can counter that global motion.
  // The torso now intentionally flexes. This old pairwise-length metric is
  // diagnostic; spine curvature and local thickness are checked separately.
  return report
}

export async function inspectSceneMotion(page, output) {
  const epochs = [0, 1.5, 3, 4.5, 6, 8], frames = []
  for (const epoch of epochs) {
    frames.push(await page.evaluate(time => window.__oceanFixture.captureAt(time), epoch))
    await page.screenshot({ path: join(output, `scene-epoch-${epoch}.png`) })
    await page.screenshot({ path: join(output, `subject-epoch-${epoch}.png`), clip: { x: 550, y: 330, width: 860, height: 650 } })
  }
  const result = await page.evaluate(async ({ frames, epochs }) => {
    const scene = document.querySelector('canvas[data-qyt-ocean-scene]'), bounds = scene.getBoundingClientRect(), fit = Math.max(innerWidth / 1600, innerHeight / 900)
    const decoded = await Promise.all(frames.map(async source => {
      const image = new Image(); image.src = source; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0)
      return { canvas, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data }
    }))
    const point = (x, y) => [
      (innerWidth - 1600 * fit + x * fit - bounds.left) * scene.width / bounds.width,
      (innerHeight - 900 * fit + y * fit - bounds.top) * scene.height / bounds.height,
    ]
    const rectangle = ([x1, y1, x2, y2]) => { const [x, y] = point(x1, y1), [right, bottom] = point(x2, y2); return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) } }
    const regions = Object.fromEntries(Object.entries({ highCloud: [1120, 198, 1228, 280], lowCloud: [880, 400, 950, 435], bodyEye: [1008, 600, 1050, 631], leftTail: [1248, 336, 1287, 382], rightTail: [1430, 390, 1475, 440], frontFin: [1190, 725, 1260, 775] }).map(([name, values]) => [name, rectangle(values)]))
    function match(target, roi, name) {
      const reference = decoded[0].pixels, width = scene.width, pixels = []
      for (let y = roi.y; y < roi.y + roi.height; y += 2) for (let x = roi.x; x < roi.x + roi.width; x += 2) {
        const offset = (y * width + x) * 4, edge = Math.abs(reference[offset] - reference[offset + 4]) + Math.abs(reference[offset] - reference[offset + width * 4])
        if (edge > (name.includes('Cloud') ? 2 : 8)) pixels.push([x, y, offset])
      }
      function error(dx, dy) {
        let total = 0
        for (const [x, y, offset] of pixels) { const shifted = ((y + dy) * width + x + dx) * 4; for (let channel = 0; channel < 3; channel++) total += Math.abs(reference[offset + channel] - target[shifted + channel]) }
        return total / Math.max(1, pixels.length * 3)
      }
      let best = { dx: 0, dy: 0, meanError: Infinity, edgePixels: pixels.length }
      // Coarse-to-fine search supports visible motion without a per-pixel
      // brute-force search through hundreds of possible displacements.
      for (let dy = -64; dy <= 64; dy += 4) for (let dx = -96; dx <= 96; dx += 4) { const meanError = error(dx, dy); if (meanError < best.meanError) best = { dx, dy, meanError, edgePixels: pixels.length } }
      const coarse = best
      for (let dy = coarse.dy - 4; dy <= coarse.dy + 4; dy++) for (let dx = coarse.dx - 4; dx <= coarse.dx + 4; dx++) { const meanError = error(dx, dy); if (meanError < best.meanError) best = { dx, dy, meanError, edgePixels: pixels.length } }
      return best
    }
    const measurements = epochs.map((epoch, index) => ({ epoch, regions: Object.fromEntries(Object.entries(regions).map(([name, roi]) => [name, index ? match(decoded[index].pixels, roi, name) : { dx: 0, dy: 0 }])) }))
    const extent = values => ({ xRange: Math.max(...values.map(value => value.dx)) - Math.min(...values.map(value => value.dx)), yRange: Math.max(...values.map(value => value.dy)) - Math.min(...values.map(value => value.dy)) })
    const ranges = Object.fromEntries(Object.keys(regions).map(name => [name, extent(measurements.map(value => value.regions[name]))]))
    const relativeTail = Object.fromEntries(['leftTail', 'rightTail'].map(name => {
      const values = measurements.map(value => ({ epoch: value.epoch, dx: value.regions[name].dx - value.regions.bodyEye.dx, dy: value.regions[name].dy - value.regions.bodyEye.dy }))
      const range = extent(values)
      return [name, { ...range, rangeDistance: Math.hypot(range.xRange, range.yRange), values }]
    }))
    const clouds = measurements.map(value => value.regions.highCloud.dx), cloudDriftIsMonotonic = clouds.every((value, index) => index === 0 || value >= clouds[index - 1] - 1)
    const strips = {}
    for (const [name, roi] of Object.entries(regions)) {
      const strip = document.createElement('canvas'), padding = 25, zoom = 2
      const width = roi.width + padding * 2, height = roi.height + padding * 2
      strip.width = width * zoom * decoded.length; strip.height = height * zoom + 28
      const ctx = strip.getContext('2d'); ctx.fillStyle = '#fafaf8'; ctx.fillRect(0, 0, strip.width, strip.height); ctx.fillStyle = '#24282b'; ctx.font = '15px sans-serif'
      decoded.forEach((frame, index) => { ctx.drawImage(frame.canvas, roi.x - padding, roi.y - padding, width, height, index * width * zoom, 28, width * zoom, height * zoom); ctx.fillText(`${epochs[index]}s`, index * width * zoom + 7, 20) })
      strips[name] = strip.toDataURL('image/png')
    }
    return { epochs, fit, screenPixelsPerArtPixel: fit, regions, measurements, ranges, relativeTail, cloudDriftIsMonotonic, cloudDriftDirection: clouds.at(-1) > 0 ? 'right' : 'left', strips }
  }, { frames, epochs })
  const longTermEpochs = [60, 180, 600]
  for (const epoch of longTermEpochs) {
    await page.evaluate(time => window.__oceanFixture.captureAt(time), epoch)
    await page.screenshot({ path: join(output, `scene-long-${epoch}s.png`) })
    await page.screenshot({ path: join(output, `clouds-long-${epoch}s.png`), clip: { x: 850, y: 80, width: 590, height: 350 } })
  }
  await page.evaluate(() => window.__oceanFixture.resumeTime())
  const { strips, ...report } = { ...result, longTermEpochs }
  for (const [name, source] of Object.entries(strips)) await writeFile(join(output, `${name}-motion-comparison.png`), Buffer.from(source.split(',')[1], 'base64'))
  await writeFile(join(output, 'perceived-motion.json'), JSON.stringify(report, null, 2) + '\n')
  assert.ok(result.ranges.highCloud.xRange >= 25 * result.screenPixelsPerArtPixel, `Cloud drift must be visible over eight seconds: ${result.ranges.highCloud.xRange}px`)
  assert.equal(result.cloudDriftIsMonotonic, true, 'Clouds must drift continuously in one direction')
  assert.equal(result.cloudDriftDirection, 'right', 'Cloud drift must follow the same wind direction as the hair and clothing')
  assert.ok(result.ranges.bodyEye.yRange >= 15, `Whale body must visibly float: ${result.ranges.bodyEye.yRange}px`)
  assert.ok(Math.max(...Object.values(result.relativeTail).map(tail => tail.rangeDistance)) >= 12, 'Tail must visibly move relative to the body')
  return report
}

/** Capture the actual composed UI; keep recording separate from FPS tests. */
export async function recordOceanUi(page, output, durationMs = 16_000) {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = innerWidth; canvas.height = innerHeight
    const context = canvas.getContext('2d'), stream = canvas.captureStream(60), chunks = []
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'].find(value => MediaRecorder.isTypeSupported(value))
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 })
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
    window.__oceanUiRecording = {
      async frame(data) { const image = new Image(); image.src = `data:image/jpeg;base64,${data}`; await image.decode(); context.drawImage(image, 0, 0, canvas.width, canvas.height) },
      async stop() { const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true })); recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop()); return new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType })) }) },
    }
    recorder.start()
  })
  const session = await page.context().newCDPSession(page), timestamps = []
  let queue = Promise.resolve()
  session.on('Page.screencastFrame', frame => {
    timestamps.push(frame.metadata.timestamp)
    session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
    queue = queue.then(() => page.evaluate(data => window.__oceanUiRecording.frame(data), frame.data))
  })
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1440, maxHeight: 1000, everyNthFrame: 1 })
  await page.waitForTimeout(durationMs)
  await session.send('Page.stopScreencast'); await queue
  const video = await page.evaluate(() => window.__oceanUiRecording.stop())
  await session.detach()
  await writeFile(join(output, 'ocean-ui-motion.webm'), Buffer.from(video, 'base64'))
  const report = { frames: timestamps.length, durationSeconds: timestamps.at(-1) - timestamps[0], observedCaptureFps: (timestamps.length - 1) / (timestamps.at(-1) - timestamps[0]), evidence: 'Continuous Chrome compositor recording of the normal UI, including CSS wash, text, and input controls. No mouse movement or debug UI is used to create apparent scene motion. Recording overhead is excluded from performance measurements.' }
  await writeFile(join(output, 'ui-recording.json'), JSON.stringify(report, null, 2) + '\n')
  assert.ok(report.frames > 100, 'The normal UI recording must contain continuous scene frames')
  return report
}
