/** Test-only instrumentation. The production capture, Host and preview are unmodified. */
import { createHash } from 'node:crypto'
import { installWebViewClockProbe, WebViewClockAccumulator } from './computer-webview2-soak-evidence.mjs'

export { WebViewClockAccumulator }

export function wkPreviewInstrumentation(html, { generation, reportPath }) {
  if (!Number.isSafeInteger(generation) || generation < 1 || !/^\/__wk_soak\/[a-f0-9-]{36}\/frames$/u.test(reportPath)) throw new Error('Invalid isolated WK probe destination')
  const source = `(${installWKFrameReporter.toString()})(${JSON.stringify({ generation, reportPath })});(${installWebViewClockProbe.toString()})(${JSON.stringify({ bindingName: '__qytWKSoakFrame', generation })});`
  // Install before the production script can draw its first frame. This has the
  // same observation role as addInitScript/CDP, without enabling native debug.
  if (/<head[\s>]/iu.test(html)) return html.replace(/<head\b[^>]*>/iu, match => `${match}<script>${source}</script>`)
  // The shipped self-contained page relies on HTML's implicit head. Observe
  // before its first script rather than requiring a tag the product omits.
  if (!/<script[\s>]/iu.test(html)) throw new Error('Production preview script was not found')
  return html.replace(/<script(?=[\s>])/iu, `<script>${source}</script><script`)
}

/** Runs only inside this UUID's actual production WKWebView document. */
export function installWKFrameReporter({ generation, reportPath }) {
  let queue = [], batch = 0, sending = false, stopped = false, sequence = 0, transportFailures = 0, probeError
  let pending
  const flush = async () => {
    if (sending || stopped) return
    sending = true
    if (!pending) pending = { generation, batch: ++batch, events: queue.splice(0, 64), transportFailures, probeError,
      document: { visibility: document.visibilityState, width: innerWidth, height: innerHeight, devicePixelRatio } }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2500)
    try {
      const result = await fetch(reportPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending), signal: controller.signal, cache: 'no-store' })
      if (!result.ok) throw new Error('Isolated clock receipt was rejected')
      pending = undefined
    } catch { transportFailures++ }
    finally { clearTimeout(timer); sending = false }
  }
  window.__qytWKSoakFrame = value => {
    const frame = JSON.parse(value)
    if (queue.length >= 128) { probeError = 'clock-queue-overflow'; return }
    queue.push({ ...frame, sequence: ++sequence }); if (queue.length >= 32) void flush()
  }
  // A pending immutable batch may be retried because the receiver deduplicates
  // it. Native input is never retried by this transport.
  const interval = setInterval(flush, 200)
  window.addEventListener('pagehide', () => { clearInterval(interval) }, { once: true })
}

export class WKFrameReceiver {
  constructor(options) {
    this.stats = new WebViewClockAccumulator(options); this.generations = new Map(); this.active = 0
  }
  useGeneration(generation) {
    this.active = generation; this.stats.useGeneration(generation)
    this.generations.set(generation, { batch: 0, sequence: 0, frames: 0, transportFailures: 0 })
  }
  receive(value, now = Date.now()) {
    if (!value || !Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.batch) || value.batch < 1 || !Array.isArray(value.events) || value.events.length > 64) throw new Error('Malformed isolated WK clock batch')
    if (value.generation !== this.active) { this.stats.ignoredRetired += value.events.length; return { ignored: true } }
    if (value.probeError || value.transportFailures > 0) throw new Error('WK clock probe/transport failed')
    const record = this.generations.get(value.generation), hash = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    if (value.batch === record.batch && hash === record.lastBatchHash) return { duplicate: true }
    if (value.batch !== record.batch + 1 || !Number.isSafeInteger(value.transportFailures) || value.transportFailures < 0 || value.document?.visibility !== 'visible') throw new Error('WK clock delivery sequence/visibility changed')
    for (const event of value.events) {
      if (event.generation !== value.generation || event.sequence !== record.sequence + 1 || !Number.isSafeInteger(event.atMs) || event.atMs > now + 2000) throw new Error('WK clock frame sequence is invalid')
      if (this.stats.accept(value.generation, event)) record.frames++
      record.sequence++
    }
    record.batch = value.batch; record.lastBatchHash = hash; record.transportFailures = value.transportFailures; record.document = value.document
    return { received: value.events.length }
  }
}

export function macResourceVerdict(samples) {
  const limits = { nodeRssBytes: 512 * 1024 ** 2, ownedRssBytes: 1536 * 1024 ** 2 }
  const complete = samples.length > 0 && samples.every(sample => sample.attribution?.complete === true && sample.processes?.length > 0 && sample.processes.every(row => Number.isSafeInteger(row.residentBytes) && row.residentBytes >= 0 && /^\d+$/u.test(row.birthMicros) && /^\d+$/u.test(row.uniqueId)))
  const maxNodeRssBytes = Math.max(0, ...samples.map(sample => sample.node.rss))
  const maxOwnedRssBytes = Math.max(0, ...samples.map(sample => sample.processes.reduce((sum, row) => sum + row.residentBytes, 0)))
  return { limits, attributionComplete: complete, maxNodeRssBytes, maxOwnedRssBytes,
    passed: complete && maxNodeRssBytes <= limits.nodeRssBytes && maxOwnedRssBytes <= limits.ownedRssBytes }
}
