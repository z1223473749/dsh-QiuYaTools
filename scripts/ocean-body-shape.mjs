/** Diagnose body bending from actual GPU pixels; no production pose is reproduced. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function inspectBodyShape(page, output) {
  await mkdir(output, { recursive: true })
  const epochs = [0, .75, 1.5, 2.25, 3, 3.75, 4.5, 5.25, 6]
  const frames = []
  let result
  try {
    for (const epoch of epochs) {
      frames.push(await page.evaluate(time => window.__oceanFixture.captureAt(time, { skipLayers: [2] }), epoch))
    }
    result = await page.evaluate(async ({ frames, epochs }) => {
      const scene = document.querySelector('canvas[data-qyt-ocean-scene]')
      if (!scene) throw Error('Body inspection requires the live Ocean canvas')
      const bounds = scene.getBoundingClientRect(), fit = Math.max(innerWidth / 1600, innerHeight / 900)
      const scaleX = fit * scene.width / bounds.width, scaleY = fit * scene.height / bounds.height
      // This is only the documented art-to-canvas placement, not the motion.
      const point = (x, y) => ({
        x: (innerWidth - 1600 * fit + x * fit - bounds.left) * scene.width / bounds.width,
        y: (innerHeight - 900 * fit + y * fit - bounds.top) * scene.height / bounds.height,
      })
      const anchors = {
        head: [900, 560], headRear: [1000, 575], mid: [1100, 605], rear: [1280, 650], caudal: [1415, 600],
        midUpper: [1110, 595], midLower: [1110, 645], rearUpper: [1330, 600], rearLower: [1330, 670],
      }
      const chain = ['head', 'headRear', 'mid', 'rear', 'caudal']
      const decoded = await Promise.all(frames.map(async source => {
        const image = new Image(); image.src = source; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        const luma = new Float32Array(canvas.width * canvas.height)
        for (let i = 0; i < luma.length; i++) luma[i] = pixels[i * 4] * .2126 + pixels[i * 4 + 1] * .7152 + pixels[i * 4 + 2] * .0722
        return { canvas, luma, width: canvas.width, height: canvas.height }
      }))
      if (decoded.some(frame => frame.width !== scene.width || frame.height !== scene.height)) throw Error('Canvas dimensions changed during body inspection')
      const sample = (frame, x, y) => {
        if (x < 0 || y < 0 || x >= frame.width - 1 || y >= frame.height - 1) return NaN
        const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, offset = iy * frame.width + ix
        return (frame.luma[offset] * (1 - fx) + frame.luma[offset + 1] * fx) * (1 - fy)
          + (frame.luma[offset + frame.width] * (1 - fx) + frame.luma[offset + frame.width + 1] * fx) * fy
      }
      const templates = Object.fromEntries(Object.entries(anchors).map(([name, [x, y]]) => {
        const center = point(x, y), pixels = [], radiusX = Math.max(7, 11 * scaleX), radiusY = Math.max(7, 11 * scaleY)
        for (let oy = -radiusY; oy <= radiusY; oy += 2) for (let ox = -radiusX; ox <= radiusX; ox += 2) {
          const value = sample(decoded[0], center.x + ox, center.y + oy)
          if (Number.isFinite(value)) pixels.push({ x: center.x + ox, y: center.y + oy, value })
        }
        const mean = pixels.reduce((sum, pixel) => sum + pixel.value, 0) / Math.max(1, pixels.length)
        const variance = pixels.reduce((sum, pixel) => sum + (pixel.value - mean) ** 2, 0)
        return [name, { center, pixels, mean, variance, standardDeviation: Math.sqrt(variance / Math.max(1, pixels.length)) }]
      }))
      function register(frame, template, expected = { dx: 0, dy: 0 }, fullSearch = false) {
        const { pixels, mean, variance } = template
        if (pixels.length < 25 || variance < pixels.length) return { available: false, reason: 'Insufficient visible texture', samplePixels: pixels.length, standardDeviation: template.standardDeviation }
        function correlation(dx, dy) {
          let sum = 0, squared = 0, numerator = 0
          for (const pixel of pixels) {
            const value = sample(frame, pixel.x + dx, pixel.y + dy)
            if (!Number.isFinite(value)) return -Infinity
            sum += value; squared += value * value; numerator += (pixel.value - mean) * value
          }
          return numerator / Math.sqrt(variance * Math.max(.0001, squared - sum * sum / pixels.length))
        }
        // Small head motion needs an exhaustive grid: coarse sampling can
        // miss a narrow true texture peak and lock onto a similar brush mark.
        const radius = fullSearch ? Math.ceil(18 * Math.max(scene.width / bounds.width, scene.height / bounds.height)) : Math.ceil(36 * Math.max(scaleX, scaleY))
        const step = fullSearch ? 1 : Math.max(2, Math.round(3 * Math.max(scaleX, scaleY))), candidates = []
        let best = { dx: expected.dx, dy: expected.dy, correlation: -Infinity }
        for (let dy = Math.round(expected.dy - radius); dy <= expected.dy + radius; dy += step) {
          for (let dx = Math.round(expected.dx - radius); dx <= expected.dx + radius; dx += step) {
            const value = correlation(dx, dy); candidates.push({ dx, dy, correlation: value })
            if (value > best.correlation) best = { dx, dy, correlation: value }
          }
        }
        const coarse = { ...best }
        for (let dy = coarse.dy - step; dy <= coarse.dy + step; dy++) for (let dx = coarse.dx - step; dx <= coarse.dx + step; dx++) {
          const value = correlation(dx, dy); if (value > best.correlation) best = { dx, dy, correlation: value }
        }
        const fine = { ...best }
        for (let oy = -.75; oy <= .75; oy += .25) for (let ox = -.75; ox <= .75; ox += .25) {
          const value = correlation(fine.dx + ox, fine.dy + oy); if (value > best.correlation) best = { dx: fine.dx + ox, dy: fine.dy + oy, correlation: value }
        }
        const competitor = Math.max(...candidates.filter(value => Math.hypot(value.dx - best.dx, value.dy - best.dy) > 6 * Math.max(scaleX, scaleY)).map(value => value.correlation))
        return {
          ...best, available: Number.isFinite(best.correlation), samplePixels: pixels.length, standardDeviation: template.standardDeviation,
          distinctPeakMargin: Number.isFinite(competitor) ? best.correlation - competitor : null,
          nearSearchBoundary: Math.max(Math.abs(best.dx - expected.dx), Math.abs(best.dy - expected.dy)) >= radius - step,
        }
      }
      const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
      const measurements = epochs.map((epoch, index) => {
        const reference = { dx: 0, dy: 0, correlation: 1, available: true, nearSearchBoundary: false }
        const head = index ? register(decoded[index], templates.head, undefined, true) : reference
        const registered = Object.fromEntries(Object.keys(anchors).map(name => [name, name === 'head' ? head : index ? register(decoded[index], templates[name], head.available ? head : undefined) : reference]))
        const tracked = Object.fromEntries(Object.entries(anchors).map(([name, [x, y]]) => [name, registered[name].available ? { x: x + registered[name].dx / scaleX, y: y + registered[name].dy / scaleY } : null]))
        let rigidPose = null, residuals = null
        if (tracked.head && tracked.caudal) {
          const originalHead = { x: anchors.head[0], y: anchors.head[1] }, originalTail = { x: anchors.caudal[0], y: anchors.caudal[1] }
          const angle = Math.atan2(tracked.caudal.y - tracked.head.y, tracked.caudal.x - tracked.head.x) - Math.atan2(originalTail.y - originalHead.y, originalTail.x - originalHead.x)
          const origin = { x: (originalHead.x + originalTail.x) / 2, y: (originalHead.y + originalTail.y) / 2 }
          const target = { x: (tracked.head.x + tracked.caudal.x) / 2, y: (tracked.head.y + tracked.caudal.y) / 2 }
          const c = Math.cos(angle), s = Math.sin(angle), chord = Math.atan2(tracked.caudal.y - tracked.head.y, tracked.caudal.x - tracked.head.x)
          rigidPose = { angleRadians: angle, referenceMidpoint: origin, targetMidpoint: target, endpointDistanceArtPx: distance(tracked.head, tracked.caudal) }
          residuals = Object.fromEntries(chain.map(name => {
            if (!tracked[name]) return [name, null]
            const [x, y] = anchors[name], prediction = { x: target.x + c * (x - origin.x) - s * (y - origin.y), y: target.y + s * (x - origin.x) + c * (y - origin.y) }
            const dx = tracked[name].x - prediction.x, dy = tracked[name].y - prediction.y
            return [name, { dxArtPx: dx, dyArtPx: dy, normalArtPx: -Math.sin(chord) * dx + Math.cos(chord) * dy, tangentArtPx: Math.cos(chord) * dx + Math.sin(chord) * dy, distanceArtPx: Math.hypot(dx, dy) }]
          }))
        }
        const pairs = { head: ['head', 'headRear'], midThickness: ['midUpper', 'midLower'], rearThickness: ['rearUpper', 'rearLower'] }
        const localDistances = Object.fromEntries(Object.entries(pairs).map(([name, [a, b]]) => [name, tracked[a] && tracked[b] ? distance(tracked[a], tracked[b]) : null]))
        return { epoch, registration: registered, trackedArt: tracked, rigidPose, residuals, localDistances }
      })
      const extent = values => {
        const finite = values.filter(Number.isFinite)
        return finite.length ? { minimum: Math.min(...finite), maximum: Math.max(...finite), range: Math.max(...finite) - Math.min(...finite), samples: finite.length } : null
      }
      const normalResiduals = Object.fromEntries(chain.slice(1, -1).map(name => [name, extent(measurements.map(value => value.residuals?.[name]?.normalArtPx))]))
      const localShape = Object.fromEntries(['head', 'midThickness', 'rearThickness'].map(name => {
        const values = measurements.map(value => value.localDistances[name]), range = extent(values), initial = values[0]
        return [name, range && initial ? { ...range, referenceArtPx: initial, rangePercent: range.range / initial * 100 } : null]
      }))
      const concerns = []
      for (const frame of measurements) for (const [name, value] of Object.entries(frame.registration)) {
        if (!value.available) concerns.push(`${frame.epoch}s ${name}: ${value.reason ?? 'registration unavailable'}`)
        else if (value.correlation < .75 || value.nearSearchBoundary || value.distinctPeakMargin != null && value.distinctPeakMargin < .05) concerns.push(`${frame.epoch}s ${name}: inspect registration (NCC ${value.correlation.toFixed(3)}, distinct peak margin ${value.distinctPeakMargin?.toFixed(3) ?? 'n/a'}, boundary ${value.nearSearchBoundary})`)
      }
      const cropStart = point(790, 480), cropEnd = point(1520, 800)
      const crop = { x: Math.max(0, Math.floor(cropStart.x)), y: Math.max(0, Math.floor(cropStart.y)), width: Math.min(scene.width, Math.ceil(cropEnd.x)) - Math.max(0, Math.floor(cropStart.x)), height: Math.min(scene.height, Math.ceil(cropEnd.y)) - Math.max(0, Math.floor(cropStart.y)) }
      if (crop.width <= 0 || crop.height <= 0) throw Error('Body is outside the current viewport')
      const tileWidth = Math.min(680, crop.width), tileScale = tileWidth / crop.width, tileHeight = crop.height * tileScale, titleHeight = 28
      const comparison = document.createElement('canvas'), aligned = document.createElement('canvas')
      for (const canvas of [comparison, aligned]) { canvas.width = tileWidth * 3; canvas.height = Math.ceil((tileHeight + titleHeight) * 3) }
      const closeups = []
      decoded.forEach((frame, index) => {
        const closeup = document.createElement('canvas'); closeup.width = crop.width; closeup.height = crop.height
        closeup.getContext('2d').drawImage(frame.canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
        closeups.push({ epoch: epochs[index], source: closeup.toDataURL('image/png') })
        for (const [canvas, normalized] of [[comparison, false], [aligned, true]]) {
          const context = canvas.getContext('2d'), x = index % 3 * tileWidth, y = Math.floor(index / 3) * (tileHeight + titleHeight)
          context.fillStyle = '#fafaf8'; context.fillRect(x, y, tileWidth, titleHeight + tileHeight)
          context.fillStyle = '#243840'; context.font = '14px sans-serif'; context.fillText(`${epochs[index]}s${normalized ? ' · rigid pose removed' : ' · actual GPU frame'}`, x + 8, y + 19)
          context.save(); context.beginPath(); context.rect(x, y + titleHeight, tileWidth, tileHeight); context.clip()
          context.translate(x, y + titleHeight); context.scale(tileScale, tileScale); context.translate(-crop.x, -crop.y)
          const pose = measurements[index].rigidPose
          if (normalized && pose) {
            const reference = point(pose.referenceMidpoint.x, pose.referenceMidpoint.y), target = point(pose.targetMidpoint.x, pose.targetMidpoint.y)
            context.translate(reference.x, reference.y); context.rotate(-pose.angleRadians); context.translate(-target.x, -target.y)
          }
          context.drawImage(frame.canvas, 0, 0)
          context.strokeStyle = '#dc6548'; context.fillStyle = '#fff9e8'; context.lineWidth = 1.5 / tileScale
          for (const name of chain) {
            const anchor = measurements[index].trackedArt[name]; if (!anchor) continue
            const at = point(anchor.x, anchor.y); context.beginPath(); context.arc(at.x, at.y, 3 / tileScale, 0, Math.PI * 2); context.fill(); context.stroke()
          }
          context.restore()
        }
      })
      return {
        epochs, fit, canvas: { width: scene.width, height: scene.height, bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } },
        artPixelsToBufferPixels: { x: scaleX, y: scaleY }, anchors, measurements, normalResidualsArtPx: normalResiduals, localShape, concerns,
        comparison: comparison.toDataURL('image/png'), registeredComparison: aligned.toDataURL('image/png'), closeups,
      }
    }, { frames, epochs })
  } finally {
    await page.evaluate(() => window.__oceanFixture.resumeTime())
  }
  const { comparison, registeredComparison, closeups, ...measurements } = result
  for (const [file, source] of [['body-shape-comparison.png', comparison], ['body-shape-registered-comparison.png', registeredComparison], ...closeups.map(value => [`body-shape-${value.epoch}s.png`, value.source])]) {
    await writeFile(join(output, file), Buffer.from(source.split(',')[1], 'base64'))
  }
  const report = {
    ...measurements,
    evidenceBoundary: 'Measured from nine actual GPU frames with only the foreground contact-water pass skipped. Blue-skin texture registration is independent of the shader pose. A translation/rotation fit to the head and caudal endpoint removes common rigid motion; intermediate signed normal residuals reveal changes beyond that fit. Local head and vertical texture-pair distances diagnose stretching without assuming the implementation. NCC confidence and annotated raw/aligned phase grids must be reviewed before interpreting numerical movement; there is deliberately no first-run motion pass threshold. Internal texture-pair distances are a local shape proxy, not a direct anatomical silhouette-thickness measurement.',
    artifacts: ['body-shape-comparison.png', 'body-shape-registered-comparison.png', ...epochs.map(epoch => `body-shape-${epoch}s.png`)],
  }
  await writeFile(join(output, 'body-shape.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}
