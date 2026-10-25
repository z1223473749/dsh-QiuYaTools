/** Test-only byte-preserving CDP observer. No browser is launched and no command is created/replayed. */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createPerMessageDeflateDiagnostic } from './cdp-permessage-deflate-diagnostic.mjs'

const MAX_MESSAGE_BYTES = 48 * 1024 * 1024
const MAX_RECORDS = 8192
const validId = value => Number.isSafeInteger(value) && value >= 0
const validMethod = value => typeof value === 'string' && /^(?:Target|Page|Runtime|Accessibility|Input|DOM|CSS|Network|Browser|Emulation|Fetch|Log|Security|Inspector)\.[A-Za-z][A-Za-z0-9]{0,79}$/u.test(value)

/** A side observer only: original Buffers are always piped unchanged, including fragmentation/masking. */
class FrameObserver {
  buffer = Buffer.alloc(0)
  fragments = []
  fragmentBytes = 0
  text = false
  ignored = false
  compressedText = false
  headerRecorded = false
  fragmentCount = 0
  messageOpcode = 0
  inflater
  constructor(message, invalid, onFrame = () => {}) { this.message = message; this.invalid = invalid; this.onFrame = onFrame }
  configureCompression(noContextTakeover) { this.inflater = createPerMessageDeflateDiagnostic({ noContextTakeover }) }
  dispose() { this.inflater?.dispose(); this.buffer = Buffer.alloc(0); this.fragments = []; this.ignored = true }
  feed(chunk, deliverySequence) {
    if (this.ignored) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const first = this.buffer[0], second = this.buffer[1], masked = !!(second & 128), opcode = first & 15
      let length = second & 127, offset = 2
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4 }
      else if (length === 127) {
        if (this.buffer.length < 10) return
        const size = this.buffer.readBigUInt64BE(2)
        if (size > BigInt(MAX_MESSAGE_BYTES)) { this.stop(); return }
        length = Number(size); offset = 10
      }
      if (!this.headerRecorded) { this.headerRecorded = true; this.onFrame({ phase: 'header', opcode, length, rsv: (first >> 4) & 7, final: !!(first & 128), masked }) }
      if (length > MAX_MESSAGE_BYTES) { this.stop(); return }
      const maskOffset = offset; if (masked) offset += 4
      if (this.buffer.length < offset + length) return
      this.onFrame({ phase: 'complete', opcode, length, rsv: (first >> 4) & 7, final: !!(first & 128), masked }); this.headerRecorded = false
      if (first & 48 || opcode >= 8 && (first & 64 || !(first & 128) || length > 125)) { this.stop(); return }
      if (opcode === 1 || opcode === 2 || opcode === 0) {
        if (opcode === 0 && (!this.text || first & 64) || opcode !== 0 && this.text) { this.stop(); return }
        if (opcode !== 0) { this.fragments = []; this.fragmentBytes = 0; this.fragmentCount = 0; this.text = true; this.messageOpcode = opcode; this.compressedText = !!(first & 64) }
        this.fragmentBytes += length
        if (this.fragmentBytes > MAX_MESSAGE_BYTES || ++this.fragmentCount > 1024) { this.stop(); return }
        const payload = Buffer.from(this.buffer.subarray(offset, offset + length))
        if (masked) for (let index = 0; index < payload.length; index++) payload[index] ^= this.buffer[maskOffset + index % 4]
        this.fragments.push(payload)
        if (first & 128) {
          try {
            const compressed = Buffer.concat(this.fragments), data = this.compressedText ? this.inflater?.decode(compressed) : compressed
            if (!data || this.messageOpcode !== 1) this.invalid()
            else this.message(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)), { deliverySequence })
          } catch { this.invalid() }
          this.fragments = []; this.fragmentBytes = 0; this.text = false; this.compressedText = false
        }
      }
      this.buffer = this.buffer.subarray(offset + length)
    }
  }
  stop() { this.ignored = true; this.buffer = Buffer.alloc(0); this.fragments = []; this.fragmentBytes = 0; this.invalid('frame-parser-stopped') }
}

export async function createCDPMetadataProxy(upstreamEndpoint, { preserveCompression = false } = {}) {
  assert.equal(typeof preserveCompression, 'boolean')
  const endpoint = new URL(upstreamEndpoint)
  assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1')
  assert.ok(endpoint.port && Number(endpoint.port) > 0 && Number(endpoint.port) <= 65535)
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/')
  const version = await fetch(new URL('/json/version', endpoint), { redirect: 'error', signal: AbortSignal.timeout(5000) })
  assert.equal(version.status, 200)
  const versionBytes = await version.text(); assert.ok(Buffer.byteLength(versionBytes) <= 64 * 1024)
  const information = JSON.parse(versionBytes), upstreamWS = new URL(information.webSocketDebuggerUrl)
  assert.equal(upstreamWS.protocol, 'ws:'); assert.equal(upstreamWS.hostname, endpoint.hostname); assert.equal(upstreamWS.port, endpoint.port)
  assert.ok(!upstreamWS.username && !upstreamWS.password && !upstreamWS.search && !upstreamWS.hash && /^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(upstreamWS.pathname))
  const records = [], frames = [], deliveries = [], connections = new Map(), sockets = new Set(), requests = new Set()
  let origin, nextConnection = 0, droppedRecords = 0, undecodedMessages = 0, frameParserFailures = 0, droppedFrames = 0, droppedDeliveries = 0, deliveryFailures = 0, compressedConnections = 0, closed = false
  const record = value => { if (records.length < MAX_RECORDS) records.push(value); else droppedRecords++ }
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/json/version' || closed) { response.writeHead(404); response.end(); return }
    const bytes = JSON.stringify({ ...information, webSocketDebuggerUrl: origin.replace('http:', 'ws:') + upstreamWS.pathname })
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(bytes) }); response.end(bytes)
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (request, client, head) => {
    if (closed || request.method !== 'GET' || request.url !== upstreamWS.pathname || request.headers.upgrade?.toLowerCase() !== 'websocket') { client.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return }
    client.pause()
    const connectionStarted = performance.now()
    const id = ++nextConnection, pending = new Map(), state = { id, pending, closed: false }
    connections.set(id, state)
    const finish = () => {
      if (state.closed) return
      state.closed = true
      for (const [number, item] of pending) record({ connection: id, id: number, method: item.method, elapsedMs: Math.round(performance.now() - item.started), outcome: 'connection-closed' })
      pending.clear()
    }
    state.finish = () => { finish(); incoming.dispose(); outgoing.dispose() }
    client.once('close', finish)
    client.once('error', finish)
    const frame = direction => value => { if (frames.length < MAX_RECORDS) frames.push({ connection: id, direction, relativeMs: Math.round(performance.now() - connectionStarted), ...value }); else droppedFrames++ }
    const incoming = new FrameObserver((value, transport) => {
      if (!value || typeof value !== 'object' || !validId(value.id) || !validMethod(value.method)) return
      // Duplicate IDs remain visible as such; do not merge different sockets or silently overwrite a request.
      if (pending.has(value.id)) { const old = pending.get(value.id); record({ connection: id, id: value.id, method: old.method, elapsedMs: Math.round(performance.now() - old.started), outcome: 'duplicate-id' }) }
      pending.set(value.id, { method: value.method, started: performance.now() })
      record({ connection: id, id: value.id, method: value.method, elapsedMs: 0, outcome: 'sent', deliverySequence: transport.deliverySequence })
    }, reason => { undecodedMessages++; if (reason === 'frame-parser-stopped') frameParserFailures++ }, frame('client-to-browser'))
    const outgoing = new FrameObserver((value, transport) => {
      if (!value || typeof value !== 'object' || !validId(value.id)) return
      const item = pending.get(value.id); if (!item) return
      pending.delete(value.id)
      record({ connection: id, id: value.id, method: item.method, elapsedMs: Math.round(performance.now() - item.started), outcome: value.error ? 'cdp-error' : 'replied', deliverySequence: transport.deliverySequence })
    }, reason => { undecodedMessages++; if (reason === 'frame-parser-stopped') frameParserFailures++ }, frame('browser-to-client'))
    // Refuse the optional permessage-deflate negotiation so observational
    // decoding sees plain JSON. All subsequent WebSocket frame bytes still
    // pass through unchanged; the handshake is explicitly not claimed exact.
    const headersWithoutCompression = request.rawHeaders.filter((_value, index, headers) => headers[index - index % 2].toLowerCase() !== 'sec-websocket-extensions')
    const upstreamRequest = httpRequest(new URL(upstreamWS.pathname, endpoint), { method: 'GET', headers: preserveCompression ? request.rawHeaders : headersWithoutCompression, timeout: 10000 })
    requests.add(upstreamRequest)
    const failed = () => { record({ connection: id, outcome: 'handshake-failed' }); client.destroy(); upstreamRequest.destroy(); finish() }
    upstreamRequest.once('timeout', failed); upstreamRequest.once('error', failed)
    upstreamRequest.once('response', response => { response.resume(); failed() })
    upstreamRequest.once('close', () => requests.delete(upstreamRequest))
    upstreamRequest.once('upgrade', (response, upstream, upstreamHead) => {
      upstreamRequest.setTimeout(0)
      const extensions = response.headers['sec-websocket-extensions']
      if (typeof extensions === 'string' && /(?:^|,)\s*permessage-deflate(?:[;,]|$)/u.test(extensions)) {
        compressedConnections++
        incoming.configureCompression(/(?:^|[;,])\s*client_no_context_takeover\s*(?:[;,]|$)/u.test(extensions))
        outgoing.configureCompression(/(?:^|[;,])\s*server_no_context_takeover\s*(?:[;,]|$)/u.test(extensions))
      }
      sockets.add(upstream); upstream.once('close', () => { sockets.delete(upstream); client.destroy(); finish() })
      upstream.once('error', () => { client.destroy(); finish() }); client.once('error', () => { upstream.destroy(); finish() }); client.once('close', () => upstream.destroy())
      const headers = response.rawHeaders.map((value, index) => index % 2 === 0 ? value + ': ' : value + '\r\n').join('')
      client.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${headers}\r\n`)
      let deliverySequence = 0
      const delivery = value => { if (deliveries.length < MAX_RECORDS) deliveries.push({ connection: id, relativeMs: Math.round(performance.now() - connectionStarted), ...value }); else droppedDeliveries++ }
      const forward = (source, target, direction, observer, chunk) => {
        const sequence = ++deliverySequence
        delivery({ sequence, direction, length: chunk.length, phase: 'queued' })
        const accepted = target.write(chunk, error => { if (error) deliveryFailures++; delivery({ sequence, direction, length: chunk.length, phase: error ? 'write-failed' : 'written' }) })
        // Queue original bytes before independent JSON/deflate analysis. A write
        // callback proves local socket delivery, never remote JS consumption.
        observer.feed(chunk, sequence)
        if (!accepted) { source.pause(); target.once('drain', () => { if (!state.closed) source.resume() }) }
      }
      client.on('data', chunk => forward(client, upstream, 'client-to-browser', incoming, chunk))
      upstream.on('data', chunk => forward(upstream, client, 'browser-to-client', outgoing, chunk))
      client.once('end', () => upstream.end()); upstream.once('end', () => client.end())
      client.once('close', () => { incoming.dispose(); outgoing.dispose() })
      if (head.length) forward(client, upstream, 'client-to-browser', incoming, head)
      if (upstreamHead.length) forward(upstream, client, 'browser-to-client', outgoing, upstreamHead)
      // No JSON reserialization, frame rewriting, command injection, retries or response suppression.
      client.resume()
    })
    upstreamRequest.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  origin = `http://127.0.0.1:${server.address().port}`
  const snapshot = () => ({ version: 1, scope: 'test-owned-loopback-CDP-method-metadata-only', candidateModified: false, originalWebSocketBytesForwarded: true, handshakeUnchanged: false, compressionNegotiationUnchanged: preserveCompression, compressionDisabledForObservation: !preserveCompression, preserveCompressionRequested: preserveCompression, compressedConnections,
    connections: connections.size, droppedRecords, droppedFrames, droppedDeliveries, deliveryFailures, frameParserFailures, undecodedMessages, diagnosticLevel: compressedConnections ? undecodedMessages ? 'frames-compressed-json-incomplete' : 'frames-and-independent-deflate-json' : 'frames-and-json', independentDecoder: 'node-zlib-sync-flush-dictionary-with-exact-consumption', timingUnchanged: false, deliveryCompletionMeaning: 'local-socket-write-callback-not-remote-JavaScript-consumption', deliveries: deliveries.map(row => ({ ...row })), frameObservationComplete: droppedFrames === 0 && frameParserFailures === 0, frames: frames.map(row => ({ ...row })), validForTimeoutAttribution: droppedRecords === 0 && droppedFrames === 0 && droppedDeliveries === 0 && deliveryFailures === 0 && undecodedMessages === 0, ...(undecodedMessages ? { incompleteReason: 'undecodable-websocket-message' } : droppedRecords ? { incompleteReason: 'metadata-record-limit' } : {}), records: records.map(row => ({ ...row })), pending: [...connections.values()].flatMap(state => [...state.pending].map(([id, value]) => ({ connection: state.id, id, method: value.method, elapsedMs: Math.round(performance.now() - value.started), outcome: 'pending' }))),
    savedParams: false, savedURLs: false, savedFrames: false, savedResponseBodies: false, commandsCreated: 0, commandsReplayed: 0, closed })
  return { endpoint: origin, snapshot, async close() { if (closed) return; closed = true; for (const state of connections.values()) state.finish?.(); for (const request of requests) request.destroy(); for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
