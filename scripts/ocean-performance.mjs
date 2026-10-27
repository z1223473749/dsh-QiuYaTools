/** Measure real Ocean WebGL submissions alongside browser animation frames. */
import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

/** Stringified into the browser fixture; keep this function self-contained. */
export function installOceanPerformanceProbe() {
  if (window.__oceanPerformance) return window.__oceanPerformance
  const win = window, started = performance.now(), rolling = { draws: [], rafs: [] }, sample = { draws: [], rafs: [] }, restorers = []
  let capturing = false, frame = 0, sampleStarted = 0, disposed = false
  function append(kind, time) {
    rolling[kind].push(time)
    if (rolling[kind].length > 2400) rolling[kind].splice(0, rolling[kind].length - 2400)
    if (capturing) sample[kind].push(time)
  }
  for (const type of [win.WebGLRenderingContext, win.WebGL2RenderingContext]) {
    if (!type) continue
    for (const operation of ['drawArrays', 'drawElements']) {
      const native = type.prototype[operation]
      const wrapped = function(...args) {
        const value = native.apply(this, args)
        if (this.canvas?.hasAttribute('data-qyt-ocean-scene')) append('draws', performance.now())
        return value
      }
      type.prototype[operation] = wrapped
      restorers.push(() => { if (type.prototype[operation] === wrapped) type.prototype[operation] = native })
    }
  }
  function tick(time) { if (disposed) return; append('rafs', time); frame = win.requestAnimationFrame(tick) }
  frame = win.requestAnimationFrame(tick)
  function summarize(times, elapsed) {
    const intervals = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => a - b)
    const percentile = value => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * value))] ?? null
    return { frames: times.length, fps: Number((times.length / (elapsed / 1000)).toFixed(2)), p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: intervals.at(-1) ?? null, over25Ms: intervals.filter(value => value > 25).length, over50Ms: intervals.filter(value => value > 50).length }
  }
  const probe = {
    start() { sample.draws.length = 0; sample.rafs.length = 0; sampleStarted = performance.now(); capturing = true; return sampleStarted },
    stop() { capturing = false; const ended = performance.now(), durationMs = ended - sampleStarted; return { durationMs, webglDraws: summarize(sample.draws, durationMs), browserRaf: summarize(sample.rafs, durationMs) } },
    snapshot(windowMs = 2000) { const now = performance.now(), durationMs = Math.max(1, Math.min(windowMs, now - started)); return { durationMs, webglDraws: summarize(rolling.draws.filter(time => time > now - windowMs), durationMs), browserRaf: summarize(rolling.rafs.filter(time => time > now - windowMs), durationMs) } },
    dispose() { disposed = true; win.cancelAnimationFrame(frame); restorers.reverse().forEach(restore => restore()) },
  }
  win.__oceanPerformance = probe
  return probe
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
const argument = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
const url = argument('--url') ?? 'http://127.0.0.1:4317/'
const target = new URL(url)
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Performance inspection only supports the local preview')
const duration = Number(argument('--duration') ?? 6000)
assert.ok(duration >= 1000 && duration <= 30_000)
const destination = resolve(argument('--output') ?? 'artifacts/ocean-scene/performance.json')
await mkdir(resolve(destination, '..'), { recursive: true })
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  await page.addInitScript(installOceanPerformanceProbe)
  await page.goto(url)
  await page.waitForSelector('canvas[data-qyt-ocean-scene][data-ready="true"]')
  await page.waitForTimeout(800)
  await page.evaluate(() => window.__oceanPerformance.start())
  await page.waitForTimeout(duration)
  const sample = await page.evaluate(() => ({ ...window.__oceanPerformance.stop(), renderer: (() => { const canvas = document.querySelector('canvas[data-qyt-ocean-scene]'), gl = canvas.getContext('webgl') ?? canvas.getContext('webgl2'); if (!gl) return null; const debug = gl.getExtension('WEBGL_debug_renderer_info'); return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) })() }))
  const report = { browser: await browser.version(), url, viewport: { width: 1440, height: 1000 }, ...sample, evidenceBoundary: 'Counts actual scene WebGL draw submissions and an independent browser rAF probe. Does not claim GPU completion or display presentation timing. No screenshot, readPixels, recording, or synchronous GPU finish runs during the sampling window.' }
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await browser?.close() }
}
