/** Perceptual acceptance uses real rendered pixels, with a fixed shader clock. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
      (innerWidth - 1600 * fit + ((x / 1600 - .5) * 1.035 + .5) * 1600 * fit - bounds.left) * scene.width / bounds.width,
      (innerHeight - 900 * fit + ((y / 900 - .5) * 1.035 + .5) * 900 * fit - bounds.top) * scene.height / bounds.height,
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
    return { epochs, fit, screenPixelsPerArtPixel: fit * 1.035, regions, measurements, ranges, relativeTail, cloudDriftIsMonotonic, cloudDriftDirection: clouds.at(-1) > 0 ? 'right' : 'left', strips }
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
