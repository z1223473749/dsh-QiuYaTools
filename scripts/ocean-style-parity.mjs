/** Compare static Ocean chrome with the live, same-frame dock presentation. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sceneSelector = 'canvas[data-qyt-ocean-scene][data-ready="true"]'
const dockSelector = '[data-composer-seat][data-qyt-ocean-dock-live] > [data-qyt-ocean-dock]'
// Both comparison paths use 8-bit channels, but the native WebGL-canvas copy
// and a PNG-decoded source can rasterize fractional crop coordinates differently.
// The diagnostic run measured 25 valid frames at MAE .2765-.3506, max 7-10,
// and <=.0061 pixels with any channel differing by >3. That is consistent with
// subpixel/raster quantization; it does not establish the cause conclusively.
// Frozen real dock buffers measured MAE >=7.14 and >.72 bad pixels; white
// boards measured MAE >=53.88. Keep those actual fault controls on every run.
const alignmentTolerance = { meanAbsoluteError: .5, maximumError: 16, badPixelFraction: .01, badPixelDifference: 3 }

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function ready(page) {
  await page.waitForSelector(sceneSelector, { state: 'attached' })
  await page.waitForSelector(dockSelector, { state: 'attached' })
  await settle(page)
}

async function uiSnapshot(page) {
  return page.evaluate(() => {
    const phase = document.querySelector('[data-phase="active"]')
    if (!phase) throw Error('The parity fixture must show an active conversation')
    const items = [
      ['card', '[data-composer-seat] [data-composer-card]'],
      ['seat', '[data-composer-seat]'],
      ['paper', '[data-conversation-scroll]'],
      ['header', '[data-slot="conversation.header"] > header'],
      ['textarea', '[data-composer-seat] textarea'],
    ]
    const properties = [
      'color', 'background-color', 'background-image', 'opacity', 'border-radius', 'box-shadow',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'display', 'position', 'z-index', 'font-size', 'line-height', 'filter', 'backdrop-filter', 'transform',
    ]
    const nodes = Object.fromEntries(items.map(([name, selector]) => {
      const element = phase.querySelector(selector)
      if (!element) throw Error(`Missing native parity surface: ${name}`)
      return [name, element]
    }))
    for (const kind of ['activity', 'usage']) {
      const controls = [...phase.querySelectorAll(`[data-composer-stat="${kind}"] > :is(button,span)`)]
      if (!controls.length) throw Error(`The parity fixture needs native ${kind} statistics`)
      controls.forEach((element, index) => { nodes[`stat-${kind}-${index}`] = element })
    }
    const styles = Object.fromEntries(Object.entries(nodes).map(([name, element]) => {
      const computed = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return [name, {
        style: Object.fromEntries(properties.map(property => [property, computed.getPropertyValue(property)])),
        rect: Object.fromEntries(['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'].map(key => [key, rect[key]])),
      }]
    }))
    const body = getComputedStyle(document.body)
    return { styles, tokens: Object.fromEntries([
      '--qyt-q-base', '--qyt-q-paper', '--qyt-q-chrome', '--qyt-q-art-wash',
      '--qyt-q-composer-fill', '--qyt-q-composer-dock', '--qyt-q-stat-fill',
    ].map(name => [name, body.getPropertyValue(name)])) }
  })
}

async function decorationSnapshot(page, dynamic) {
  return page.evaluate(dynamic => {
    const seat = document.querySelector('[data-phase="active"] [data-composer-seat]')
    const element = dynamic ? seat.querySelector('[data-qyt-ocean-dock]') : seat
    const style = getComputedStyle(element, dynamic ? null : '::before')
    const properties = ['position', 'top', 'right', 'bottom', 'left', 'z-index', 'opacity', 'pointer-events', 'mask-image', '-webkit-mask-image', 'mask-size', 'mask-position', 'mask-repeat']
    return { content: getComputedStyle(seat, '::before').content, visibility: style.visibility,
      style: Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)])) }
  }, dynamic)
}

async function inspectWash(page) {
  return page.evaluate(() => {
    const phase = document.querySelector('[data-phase="active"]')
    const main = phase.querySelector(':scope > [data-qyt-ocean-wash]')
    const dock = phase.querySelector('[data-qyt-ocean-dock] > [data-qyt-ocean-wash]')
    if (!main || !dock) throw Error('Both live surfaces need the common Ocean wash')
    const properties = ['background-image', 'background-attachment', 'background-position', 'background-size', 'background-repeat', 'opacity']
    const snapshot = element => {
      const style = getComputedStyle(element)
      return Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]))
    }
    return { main: snapshot(main), dock: snapshot(dock) }
  })
}

async function inspectFrame(page, epoch, fault = null) {
  return page.evaluate(async ({ epoch, fault, badPixelDifference }) => {
    // captureAt resolves in the microtask after this frame's complete WebGL
    // draw and dock copy. Read the mirror before another animation frame runs.
    const faultMirror = document.querySelector('[data-qyt-ocean-dock] canvas[data-qyt-ocean-dock-frame]')
    const faultContext = fault ? faultMirror?.getContext('2d') : null
    const restorers = []
    if (fault) {
      if (!faultContext) throw Error('A negative control requires the real dock context')
      if (fault === 'white-board') {
        faultContext.save(); faultContext.setTransform(1, 0, 0, 1, 0, 0)
        faultContext.fillStyle = '#fff'; faultContext.fillRect(0, 0, faultMirror.width, faultMirror.height)
        faultContext.restore()
      }
      for (const operation of ['clearRect', 'drawImage']) {
        const descriptor = Object.getOwnPropertyDescriptor(faultContext, operation)
        Object.defineProperty(faultContext, operation, { value() {}, configurable: true })
        restorers.push(() => descriptor ? Object.defineProperty(faultContext, operation, descriptor) : delete faultContext[operation])
      }
    }
    let primarySource, mirrorSource
    try {
      primarySource = await window.__oceanFixture.captureAt(epoch)
      mirrorSource = document.querySelector('[data-qyt-ocean-dock] canvas[data-qyt-ocean-dock-frame]').toDataURL('image/png')
    } finally { restorers.reverse().forEach(restore => restore()) }
    const primary = document.querySelector('canvas[data-qyt-ocean-scene]')
    const dock = document.querySelector('[data-qyt-ocean-dock]')
    const mirror = dock?.querySelector('canvas[data-qyt-ocean-dock-frame]')
    if (!primary || !dock || !mirror) throw Error('The live frame and dock mirror must both exist')
    const host = primary.getBoundingClientRect(), bounds = dock.getBoundingClientRect()
    const rect = value => Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(key => [key, value[key]]))
    async function decode(source) {
      const image = new Image(); image.src = source; await image.decode(); return image
    }
    const [primaryImage, mirrorImage] = await Promise.all([decode(primarySource), decode(mirrorSource)])
    const actual = document.createElement('canvas'), expected = document.createElement('canvas')
    actual.width = expected.width = mirror.width
    actual.height = expected.height = mirror.height
    const actualContext = actual.getContext('2d', { willReadFrequently: true })
    const expectedContext = expected.getContext('2d', { willReadFrequently: true })
    actualContext.drawImage(mirrorImage, 0, 0)
    // The expected crop is defined in viewport CSS coordinates. Its backing
    // ratios can differ from both the primary buffer and the dock's CSS size.
    const left = Math.max(0, host.left, bounds.left), top = Math.max(0, host.top, bounds.top)
    const right = Math.min(innerWidth, host.right, bounds.right), bottom = Math.min(innerHeight, host.bottom, bounds.bottom)
    if (right <= left || bottom <= top) throw Error('The dock must have a visible image region')
    const sourceX = primaryImage.width / host.width, sourceY = primaryImage.height / host.height
    const destinationX = mirror.width / bounds.width, destinationY = mirror.height / bounds.height
    expectedContext.drawImage(primaryImage,
      (left - host.left) * sourceX, (top - host.top) * sourceY,
      (right - left) * sourceX, (bottom - top) * sourceY,
      (left - bounds.left) * destinationX, (top - bounds.top) * destinationY,
      (right - left) * destinationX, (bottom - top) * destinationY)
    const a = actualContext.getImageData(0, 0, actual.width, actual.height).data
    const b = expectedContext.getImageData(0, 0, expected.width, expected.height).data
    let pixels = 0, error = 0, maximum = 0, badPixels = 0, transparentPixels = 0
    const channelHistogram = Array(256).fill(0), pixelHistogram = Array(256).fill(0)
    const tiles = Array.from({ length: 32 }, () => ({ pixels: 0, error: 0, maximumError: 0 }))
    const x0 = Math.ceil((left - bounds.left) * destinationX) + 2
    const y0 = Math.ceil((top - bounds.top) * destinationY) + 2
    const x1 = Math.floor((right - bounds.left) * destinationX) - 2
    const y1 = Math.floor((bottom - bounds.top) * destinationY) - 2
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const offset = (y * actual.width + x) * 4
      let localMaximum = 0
      for (let channel = 0; channel < 4; channel++) {
        const difference = Math.abs(a[offset + channel] - b[offset + channel])
        error += difference; maximum = Math.max(maximum, difference); localMaximum = Math.max(localMaximum, difference)
        channelHistogram[difference]++
      }
      pixelHistogram[localMaximum]++
      const tile = tiles[Math.min(3, Math.floor((y - y0) * 4 / (y1 - y0))) * 8 + Math.min(7, Math.floor((x - x0) * 8 / (x1 - x0)))]
      tile.pixels++; tile.maximumError = Math.max(tile.maximumError, localMaximum)
      for (let channel = 0; channel < 4; channel++) tile.error += Math.abs(a[offset + channel] - b[offset + channel])
      if (localMaximum > badPixelDifference) badPixels++
      if (a[offset + 3] !== 255) transparentPixels++
      pixels++
    }
    const percentile = (histogram, fraction) => {
      const target = histogram.reduce((sum, count) => sum + count, 0) * fraction
      let count = 0
      for (let value = 0; value < histogram.length; value++) { count += histogram[value]; if (count >= target) return value }
      return 0
    }
    return { epoch, fault, host: rect(host), bounds: rect(bounds),
      primaryBacking: { width: primaryImage.width, height: primaryImage.height },
      mirrorBacking: { width: mirror.width, height: mirror.height },
      crop: { css: { left, top, right, bottom }, source: { x: (left - host.left) * sourceX, y: (top - host.top) * sourceY, width: (right - left) * sourceX, height: (bottom - top) * sourceY }, destination: { x: (left - bounds.left) * destinationX, y: (top - bounds.top) * destinationY, width: (right - left) * destinationX, height: (bottom - top) * destinationY }, backingRatios: { sourceX, sourceY, destinationX, destinationY }, inspectedPixels: { x0, y0, x1, y1 } },
      pixels, meanAbsoluteError: error / Math.max(1, pixels * 4), maximumError: maximum,
      badPixels, badPixelFraction: badPixels / Math.max(1, pixels), transparentPixels,
      channelErrorPercentiles: Object.fromEntries([.5, .9, .95, .99, .999].map(fraction => [fraction, percentile(channelHistogram, fraction)])),
      pixelErrorPercentiles: Object.fromEntries([.5, .9, .95, .99, .999].map(fraction => [fraction, percentile(pixelHistogram, fraction)])),
      channelHistogram, pixelHistogram,
      tiles: tiles.map(({ error, ...tile }, index) => ({ column: index % 8, row: Math.floor(index / 8), ...tile, meanAbsoluteError: error / Math.max(1, tile.pixels * 4) })),
      mirrorSource }
  }, { epoch, fault, badPixelDifference: alignmentTolerance.badPixelDifference })
}

function alignmentFailures(frame) {
  const failures = []
  if (frame.pixels <= 1000) failures.push('inspect a substantive visible dock crop')
  if (frame.meanAbsoluteError > alignmentTolerance.meanAbsoluteError) failures.push(`mean absolute error ${frame.meanAbsoluteError} exceeds ${alignmentTolerance.meanAbsoluteError}`)
  if (frame.maximumError > alignmentTolerance.maximumError) failures.push(`maximum pixel error ${frame.maximumError} exceeds ${alignmentTolerance.maximumError}`)
  if (frame.badPixelFraction > alignmentTolerance.badPixelFraction) failures.push(`bad pixel fraction ${frame.badPixelFraction} exceeds ${alignmentTolerance.badPixelFraction}`)
  if (frame.transparentPixels !== 0) failures.push(`visible dock contains ${frame.transparentPixels} transparent pixels`)
  return failures
}

async function motionDifference(page, first, second) {
  return page.evaluate(async ({ first, second }) => {
    const decode = async source => {
      const image = new Image(); image.src = source; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0)
      return { width: image.width, height: image.height, pixels: context.getImageData(0, 0, image.width, image.height).data }
    }
    const [a, b] = await Promise.all([decode(first), decode(second)])
    if (a.width !== b.width || a.height !== b.height) throw Error('Motion comparison requires the same dock geometry')
    let changed = 0, error = 0, pixels = 0
    for (let offset = 0; offset < a.pixels.length; offset += 4) {
      if (a.pixels[offset + 3] === 0 || b.pixels[offset + 3] === 0) continue
      let maximum = 0
      for (let channel = 0; channel < 3; channel++) {
        const delta = Math.abs(a.pixels[offset + channel] - b.pixels[offset + channel])
        maximum = Math.max(maximum, delta); error += delta
      }
      if (maximum > 2) changed++
      pixels++
    }
    return { pixels, changedPixels: changed, changedFraction: changed / Math.max(1, pixels), meanAbsoluteDifference: error / Math.max(1, pixels * 3) }
  }, { first, second })
}

/** Run against the account-free Ocean fixture; no user data or live app is used. */
export async function inspectOceanStyleParity(page, output) {
  await mkdir(output, { recursive: true })
  const cases = [], stress = [], screenshots = [], frames = [], negativeControls = [], failures = []
  let performanceSample
  const recordFrame = async (label, epoch, fault = null) => {
    const frame = await inspectFrame(page, epoch, fault)
    const { mirrorSource, ...metrics } = frame
    const rejectedBy = alignmentFailures(frame)
    const result = { label, ...metrics, rejectedBy }
    frames.push(result)
    if (!fault && rejectedBy.length) failures.push({ label, failures: rejectedBy })
    // Save the complete non-base64 metrics before any assertion can throw.
    await writeFile(join(output, 'style-parity-frames.json'), JSON.stringify({ alignmentTolerance, frames, negativeControls, failures }, null, 2) + '\n')
    await writeFile(join(output, `style-parity-${label}.png`), Buffer.from(mirrorSource.split(',')[1], 'base64'))
    return frame
  }
  const switchMode = async dynamic => {
    await page.evaluate(value => window.__oceanFixture.setMotion(value), dynamic)
    if (dynamic) await ready(page)
    else {
      await page.waitForFunction(() => !document.querySelector('canvas[data-qyt-ocean-scene]') && !document.querySelector('[data-qyt-ocean-dock-live]'))
      await settle(page)
    }
  }
  const screenshot = async name => { await page.screenshot({ path: join(output, name) }); screenshots.push(name) }
  const compare = async label => {
    await switchMode(false)
    const still = await uiSnapshot(page), decoration = await decorationSnapshot(page, false)
    assert.notEqual(decoration.content, 'none', `${label}: static mode retains its original illustrated footer`)
    await switchMode(true)
    const first = await recordFrame(`${label}-dock-1.5s`, 1.5)
    const live = await uiSnapshot(page), liveDecoration = await decorationSnapshot(page, true), wash = await inspectWash(page)
    assert.deepEqual(live, still, `${label}: motion must not alter UI colors, opacity, borders, shadows or geometry`)
    assert.deepEqual(liveDecoration.style, decoration.style, `${label}: the mirrored footer must retain the original fade and stacking`)
    assert.equal(liveDecoration.content, 'none', `${label}: the frozen footer copy must be withdrawn only when the mirror is ready`)
    assert.equal(liveDecoration.visibility, 'visible')
    assert.deepEqual(wash.dock, wash.main, `${label}: both image surfaces need the same wash`)
    assert.ok(wash.main['background-attachment'].split(',').every(value => value.trim() === 'fixed'), `${label}: wash gradients use viewport coordinates`)
    // Freeze the actual dock's clear/copy operations, advance the main scene,
    // and prove that an unchanged old frame is rejected by the same matcher.
    const stale = await recordFrame(`${label}-negative-stale-frame`, 4.5, 'stale-frame')
    const staleReasons = alignmentFailures(stale)
    assert.equal(stale.mirrorSource, first.mirrorSource, `${label}: stale control must literally retain the previous dock buffer`)
    negativeControls.push({ label, fault: 'stale-frame', oldEpoch: 1.5, primaryEpoch: 4.5, literalPreviousBuffer: true, rejectedBy: staleReasons })
    if (!staleReasons.length) failures.push({ label, failures: ['The matcher accepted a literal stale dock frame'] })
    const second = await recordFrame(`${label}-dock-4.5s`, 4.5)
    const movement = await motionDifference(page, first.mirrorSource, second.mirrorSource)
    assert.ok(movement.changedFraction > .005 && movement.meanAbsoluteDifference > .05, `${label}: the dock crop must keep moving instead of freezing`)
    const white = await recordFrame(`${label}-negative-white-board`, 4.5, 'white-board')
    const whiteReasons = alignmentFailures(white)
    negativeControls.push({ label, fault: 'white-board', primaryEpoch: 4.5, rejectedBy: whiteReasons })
    if (!whiteReasons.length) failures.push({ label, failures: ['The matcher accepted a white dock board'] })
    // Leave the displayed screenshot on a freshly copied, valid frame.
    await recordFrame(`${label}-dock-recovered`, 4.5)
    const { mirrorSource: ignoredFirstSource, ...firstReport } = first, { mirrorSource: ignoredSecondSource, ...secondReport } = second
    return { label, ui: still, decoration: decoration.style, wash: wash.main, frames: [firstReport, secondReport], movement }
  }
  try {
    for (const viewport of [{ width: 1880, height: 1068 }, { width: 1280, height: 900 }, { width: 480, height: 820 }]) {
      for (const dark of [false, true]) {
        const label = `${viewport.width}-${dark ? 'dark' : 'light'}`
        await page.setViewportSize(viewport)
        await page.evaluate(dark => { window.__oceanFixture.resumeTime(); window.__oceanFixture.setDark(dark); window.__oceanFixture.setMotion(false); window.__oceanFixture.rebuild('active') }, dark)
        await settle(page)
        if (viewport.width === 1880 && !dark) await screenshot('style-parity-1880-light-static.png')
        const result = await compare(label)
        cases.push(result)
        if (viewport.width === 1880 || viewport.width === 480) await screenshot(`style-parity-${label}-dynamic.png`)
        if (viewport.width === 1880 && !dark) {
          await page.evaluate(() => { const scroll = document.querySelector('[data-conversation-scroll]'); scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * .65 })
          await settle(page)
          assert.ok(await page.locator('[data-conversation-scroll]').evaluate(element => element.scrollTop > 100), 'The fixture must exercise a long, scrolled conversation')
          stress.push(await compare('1880-light-scrolled'))
          const beforeHeight = await page.locator('[data-composer-seat]').evaluate(element => element.getBoundingClientRect().height)
          await page.locator('[data-composer-seat] textarea').evaluate(element => { element.value = '多行输入\n让输入框增高\n保持背景连续\n检查底部覆盖'; element.style.height = '180px'; element.dispatchEvent(new Event('input', { bubbles: true })) })
          await settle(page)
          const afterHeight = await page.locator('[data-composer-seat]').evaluate(element => element.getBoundingClientRect().height)
          assert.ok(afterHeight > beforeHeight + 60, 'The enlarged composer must resize the mirrored footer')
          stress.push(await compare('1880-light-tall-composer'))
          const primary = await page.locator(sceneSelector).elementHandle()
          await page.setViewportSize({ width: 1767, height: 1001 })
          await ready(page)
          assert.equal(await primary.evaluate(element => element === document.querySelector('canvas[data-qyt-ocean-scene]')), true, 'A resize reuses the active scene')
          const resized = await recordFrame('same-scene-resize', 2.25)
          const { mirrorSource: ignored, ...resizedReport } = resized
          stress.push({ label: 'same-scene-resize', frame: resizedReport })
          await primary.dispose()
          await page.setViewportSize(viewport); await ready(page)
          await page.evaluate(() => window.__oceanFixture.resumeTime())
          await page.waitForTimeout(600)
          await page.evaluate(() => (window.__oceanPerformance ?? window.__oceanFixture.performance).start())
          // Sampling excludes screenshots, PNG encoding and pixel readback.
          await page.waitForTimeout(6000)
          performanceSample = await page.evaluate(() => (window.__oceanPerformance ?? window.__oceanFixture.performance).stop())
          assert.ok(performanceSample.webglDraws.frames > 0 && performanceSample.browserRaf.frames > 0, 'Measure actual scene and browser frames')
          assert.ok(performanceSample.webglDraws.fps >= performanceSample.browserRaf.fps * .85, `The background must follow browser refresh: ${performanceSample.webglDraws.fps} actual WebGL FPS / ${performanceSample.browserRaf.fps} browser rAF FPS`)
          assert.ok(performanceSample.webglDraws.p95Ms <= performanceSample.browserRaf.p95Ms * 1.8 + 4, `The background frame interval is uneven: P95 ${performanceSample.webglDraws.p95Ms}ms`)
          assert.ok(performanceSample.durationMs >= 6000)
        }
      }
    }
    const report = { passed: failures.length === 0, viewports: ['1880x1068', '1280x900', '480x820'], alignmentTolerance, cases, stress, frames, negativeControls, failures, screenshots, performance: performanceSample,
      evidenceBoundary: 'Exact computed-style and UI rectangle equality across static/live modes in Chromium. PNG-decoded primary and dock buffers compare the same shader epoch and viewport crop, before CSS wash/fade. Small 8-bit raster differences have a measured tolerance; subpixel sampling quantization is a possible explanation, not a proven cause. Every case must reject a real frozen previous dock buffer and a white dock board using the same comparison. Resize, scroll and a taller composer exercise live mirror geometry. Performance uses the existing refresh-following and P95 limits in a separate six-second active-conversation sample without readback or recording.' }
    await writeFile(join(output, 'style-parity.json'), JSON.stringify(report, null, 2) + '\n')
    assert.equal(failures.length, 0, `Pixel diagnosis found ${failures.length} failures; complete metrics are in style-parity.json and style-parity-frames.json`)
    return report
  } catch (error) {
    await writeFile(join(output, 'style-parity.json'), JSON.stringify({ passed: false, error: error.message, alignmentTolerance, cases, stress, frames, negativeControls, failures, screenshots, performance: performanceSample }, null, 2) + '\n')
    await page.screenshot({ path: join(output, 'style-parity-failure.png') }).catch(() => {})
    throw error
  } finally {
    // Leave the shared fixture in the original state for the full browser suite.
    await page.setViewportSize({ width: 1440, height: 1000 }).catch(() => {})
    await page.evaluate(() => { window.__oceanFixture.resumeTime(); window.__oceanFixture.setDark(false); window.__oceanFixture.setMotion(true); window.__oceanFixture.rebuild('hero') }).catch(() => {})
  }
}
