/** Test-only instrumentation. The production capture, Host and preview are unmodified. */
import { createHash } from 'node:crypto'
import { installWebViewClockProbe, WebViewClockAccumulator } from './computer-webview2-soak-evidence.mjs'

export { WebViewClockAccumulator }

/** The test carrier is accepted only after independent post-exec metadata. */
export function macSelfResponsibleNative(row, { helperPath, runnerPid }) {
  return Number.isSafeInteger(row?.pid) && row.pid > 0 && row.role === 'native' &&
    row.path === helperPath && row.parentPid === runnerPid && row.responsiblePid === row.pid &&
    typeof row.birthMicros === 'string' && /^\d+$/u.test(row.birthMicros) &&
    typeof row.uniqueId === 'string' && /^\d+$/u.test(row.uniqueId) && row.uniqueId !== '0'
}

/** Cleanup ACKs must cover every exact identity and contain only proven gone states. */
export function macProcessCheckPassed(value, expected) {
  if (value?.passed !== true || !Array.isArray(value.results) || !Array.isArray(expected) || value.results.length !== expected.length) return false
  const key = item => Number.isSafeInteger(item?.pid) && item.pid > 0 && /^\d+$/u.test(item.birthMicros) && /^\d+$/u.test(item.uniqueId) ? `${item.pid}:${item.birthMicros}:${item.uniqueId}` : null
  const remaining = new Set(expected.map(key))
  if (remaining.has(null) || remaining.size !== expected.length) return false
  for (const item of value.results) {
    const identity = key(item)
    if (!['exited', 'reused-pid-skipped'].includes(item.state) || !identity || !remaining.delete(identity)) return false
  }
  return remaining.size === 0
}

export function wkPreviewInstrumentation(html, { generation, reportPath, associationNonce }) {
  if (!Number.isSafeInteger(generation) || generation < 1 || !/^\/__wk_soak\/[a-f0-9-]{36}\/frames$/u.test(reportPath)) throw new Error('Invalid isolated WK probe destination')
  if (associationNonce !== undefined && !/^[a-f0-9-]{36}$/u.test(associationNonce)) throw new Error('Invalid isolated WK association nonce')
  const source = `(${installWKFrameReporter.toString()})(${JSON.stringify({ generation, reportPath, associationNonce })});(${installWebViewClockProbe.toString()})(${JSON.stringify({ bindingName: '__qytWKSoakFrame', generation })});`
  // Install before the production script can draw its first frame. This has the
  // same observation role as addInitScript/CDP, without enabling native debug.
  if (/<head[\s>]/iu.test(html)) return html.replace(/<head\b[^>]*>/iu, match => `${match}<script>${source}</script>`)
  // The shipped self-contained page relies on HTML's implicit head. Observe
  // before its first script rather than requiring a tag the product omits.
  if (!/<script[\s>]/iu.test(html)) throw new Error('Production preview script was not found')
  return html.replace(/<script(?=[\s>])/iu, `<script>${source}</script><script`)
}

/** Runs only inside this UUID's actual production WKWebView document. */
export function installWKFrameReporter({ generation, reportPath, associationNonce }) {
  if (associationNonce) { document.documentElement.dataset.qytAssociationNonce = associationNonce; document.documentElement.dataset.qytAssociationTick = '0' }
  let queue = [], batch = 0, sending = false, stopped = false, sequence = 0, transportFailures = 0, probeError
  let pending
  const flush = async () => {
    if (associationNonce) document.documentElement.dataset.qytAssociationTick = String(Number(document.documentElement.dataset.qytAssociationTick || 0) + 1)
    if (sending || stopped) return
    sending = true
    if (!pending) pending = { generation, batch: ++batch, events: queue.splice(0, 64), transportFailures, probeError,
      document: { visibility: document.visibilityState, width: innerWidth, height: innerHeight, devicePixelRatio } }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2500)
    try {
      const result = await fetch(reportPath, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-qyt-wk-generation': String(generation), 'x-qyt-wk-nonce': associationNonce??reportPath.split('/')[2] }, body: JSON.stringify(pending), signal: controller.signal, cache: 'no-store' })
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

/** Read-only WK getter receipts identify participation in one test-owned view.
 * They do not grant ownership by coalition, process name or a reported PID alone.
 * The native OS observer must independently pin every returned identity.
 */
export class WKAssociationReceipts {
  constructor({ nonce, native }) { this.nonce = nonce; this.native = native; this.sequence = 0; this.tick = -1; this.samples = []; this.latest = [] }
  accept(row) {
    const validIdentity = value => value && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2147483647 &&
      typeof value.birthMicros === 'string' && /^[1-9][0-9]{0,31}$/u.test(value.birthMicros) && typeof value.uniqueId === 'string' && /^[1-9][0-9]{0,31}$/u.test(value.uniqueId) &&
      typeof value.path === 'string' && value.path.startsWith('/') && value.path.length <= 4096 && !value.path.includes('\0')
    const same = (a, b) => validIdentity(a) && validIdentity(b) && ['pid', 'birthMicros', 'uniqueId', 'path'].every(key => a[key] === b[key])
    if (!row || row.schemaVersion !== 1 || row.nonce !== this.nonce || !same(row.helper, this.native) || !Number.isSafeInteger(row.sequence) || row.sequence !== this.sequence + 1) throw new Error('WK association receipt identity/sequence changed')
    if (row.event === 'probe-ready') { if (row.changesResponsibility !== false) throw new Error('WK association carrier changed responsibility'); this.sequence = row.sequence; return [] }
    if (row.event === 'probe-ended') { this.sequence = row.sequence; return [] }
    if (row.event !== 'association') throw new Error('WK association probe did not verify its own page')
    if (row.verified !== true || row.errors?.length !== 0) {
      const allowed = new Set(['WebContent-pid-unverified', 'GPU-pid-unverified', 'Networking-pid-unverified'])
      const reasons = Array.isArray(row.errors) ? row.errors.slice(0, 3).map(value => allowed.has(value) ? value : 'unknown') : ['unknown']
      throw new Error('WK association resource getters unverified: ' + reasons.join(','))
    }
    if (row.page?.nonceVerified !== true || row.page.visibility !== 'visible' || row.page.iframes !== 0 || !Number.isSafeInteger(row.windowId) || row.windowId <= 0) throw new Error('WK association own page nonce, visibility or window was not verified')
    if (!Number.isSafeInteger(row.page.tick) || row.page.tick <= this.tick) throw new Error('WK association page clock was not continuously advancing')
    const roles = new Set(['WebContent', 'GPU', 'Networking']), pids = new Set()
    if (!Array.isArray(row.associated) || row.associated.length !== roles.size) throw new Error('WK association omitted a resource process role')
    const latest = row.associated.map(item => {
      if (!roles.delete(item.role) || !validIdentity(item.identity) || !/^[0-9]+$/u.test(item.identity.device) || !/^[1-9][0-9]*$/u.test(item.identity.inode) || pids.has(item.identity.pid) || BigInt(item.identity.birthMicros) < BigInt(this.native.birthMicros)) throw new Error('WK association resource process metadata is invalid')
      pids.add(item.identity.pid)
      if (item.role === 'Networking' && (row.networkFence?.verified !== true || row.networkFence.existsBefore !== true || row.networkFence.existsAfter !== true || !/^[1-9][0-9]*$/u.test(row.networkFence.getterBeforeUnixMicros) || BigInt(item.identity.birthMicros) >= BigInt(row.networkFence.getterBeforeUnixMicros))) throw new Error('WK network process did not predate its guarded getter')
      return { native: this.native, process: item.identity, kind: item.role }
    })
    this.sequence = row.sequence; this.tick = row.page.tick; this.latest = latest; this.samples.push({ sequence: row.sequence, tick: row.page.tick, windowId: row.windowId, associated: latest })
    if (this.samples.length > 3600) throw new Error('WK association sample bound exceeded')
    return latest
  }
}

/** Persist a bounded own-probe row before validating it so a failed getter or
 * page check remains reviewable. Recording never turns a rejection into an ACK.
 */
export function consumeWKAssociationRows(state, bytes) {
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > 8 * 1024 ** 2) throw new Error('WK association receipt file bound')
  const lines = bytes.slice(0, bytes.lastIndexOf('\n') + 1).split('\n').filter(Boolean)
  if (lines.length > 4000 || lines.length < state.rowsRead) throw new Error('WK association receipt sequence/file bound')
  for (const line of lines.slice(state.rowsRead)) {
    const row = JSON.parse(line)
    state.rows.push(row); state.rowsRead++
    state.receiver.accept(row)
  }
  return state.receiver.latest
}
