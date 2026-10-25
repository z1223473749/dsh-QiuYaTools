import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { deflateRawSync, constants as zlibConstants } from 'node:zlib'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createCDPMetadataProxy } from '../scripts/cdp-metadata-proxy.mjs'

function frame(text, { mask = false, opcode = 1, final = true, compressed = false } = {}) {
  const payload = Buffer.from(text), header = Buffer.alloc(payload.length < 126 ? 2 : 4), key = Buffer.from([23, 45, 67, 89])
  header[0] = (final ? 128 : 0) | (compressed ? 64 : 0) | opcode; header[1] = (mask ? 128 : 0) | (payload.length < 126 ? payload.length : 126)
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2)
  if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= key[index % 4]
  return Buffer.concat([header, ...(mask ? [key] : []), payload])
}
async function upstream(t, { compression = false, noContextTakeover = true, invalidCompression = false } = {}) {
  const sockets = new Set(), received = [], raw = [], emitted = [], messageBodies = [], offeredExtensions = []
  let endpoint
  const server = createServer((q, s) => { if (q.url !== '/json/version') { s.writeHead(404).end(); return }; s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ Browser: 'Synthetic-only', webSocketDebuggerUrl: endpoint.replace('http:', 'ws:') + '/devtools/browser/test-owned' })) })
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (q, socket, head) => {
    offeredExtensions.push(q.headers['sec-websocket-extensions'])
    const accept = createHash('sha1').update(q.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    const useCompression = compression && !!q.headers['sec-websocket-extensions']
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + (useCompression ? '\r\nSec-WebSocket-Extensions: permessage-deflate' + (noContextTakeover ? '; server_no_context_takeover' : '') : '') + '\r\n\r\n')
    let buffer = Buffer.from(head), fragments = [], dictionary = Buffer.alloc(0)
    const consume = chunk => {
      raw.push(Buffer.from(chunk)); buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 2) {
        let length = buffer[1] & 127, offset = 2
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4 }
        const masked = !!(buffer[1] & 128), key = buffer.subarray(offset, offset + 4); if (masked) offset += 4
        if (buffer.length < offset + length) return
        const opcode = buffer[0] & 15, final = !!(buffer[0] & 128), payload = Buffer.from(buffer.subarray(offset, offset + length)); if (masked) for (let index = 0; index < payload.length; index++) payload[index] ^= key[index % 4]
        buffer = buffer.subarray(offset + length)
        if (opcode !== 1 && opcode !== 0) continue
        fragments.push(payload); if (!final) continue
        const body = Buffer.concat(fragments).toString(); fragments = []; messageBodies.push(body)
        const message = JSON.parse(body); received.push(message)
        if (message.method === 'Page.getFrameTree') continue
        const reply = JSON.stringify(message.method === 'Target.attachToTarget' ? { id: message.id, error: { code: -1, message: 'PRIVATE_RESPONSE_BODY' } } : { id: message.id, result: { data: 'PRIVATE_RESPONSE_BODY', secret: message.params?.private } })
        // Exercise server-side fragmentation too, without changing the JSON body.
        const encoded = useCompression ? invalidCompression ? Buffer.from([255, 255, 255]) : deflateRawSync(Buffer.from(reply), { finishFlush: zlibConstants.Z_SYNC_FLUSH, ...(!noContextTakeover && dictionary.length ? { dictionary } : {}) }).subarray(0, -4) : Buffer.from(reply)
        if (useCompression && !noContextTakeover) dictionary = Buffer.concat([dictionary, Buffer.from(reply)]).subarray(-32768)
        const split = Math.floor(encoded.length / 2), bytes = Buffer.concat([frame(encoded.subarray(0, split), { final: false, compressed: useCompression }), frame(encoded.subarray(split), { opcode: 0 })]); emitted.push(bytes); socket.write(bytes)
      }
    }
    socket.on('data', consume)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); endpoint = 'http://127.0.0.1:' + server.address().port
  t.after(async () => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { endpoint, received, raw, emitted, messageBodies, offeredExtensions }
}
async function client(endpoint, { compression = false } = {}) {
  const info = await (await fetch(endpoint + '/json/version')).json(), ws = new URL(info.webSocketDebuggerUrl)
  assert.equal(ws.hostname, '127.0.0.1'); assert.equal(ws.port, new URL(endpoint).port)
  return new Promise((resolve, reject) => {
    const req = request(new URL(ws.pathname, endpoint), { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': Buffer.from('fixture-key-16-b').toString('base64'), 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits' } })
    req.once('error', reject); req.once('upgrade', (_res, socket, head) => { assert.equal(!!_res.headers['sec-websocket-extensions'], compression); const received = [head]; socket.on('error', () => {}); socket.on('data', bytes => received.push(bytes)); resolve({ socket, received }) }); req.end()
  })
}
async function wait(read) { const deadline = performance.now() + 2000; while (performance.now() < deadline) { const value = read(); if (value) return value; await delay(5) }; throw Error('Fixture transport checkpoint unavailable') }

test('real private loopback relay preserves original masked/fragmented bytes and saves only projected method metadata', async t => {
  const own = await upstream(t), proxy = await createCDPMetadataProxy(own.endpoint); t.after(() => proxy.close())
  const a = await client(proxy.endpoint), b = await client(proxy.endpoint); t.after(() => { a.socket.destroy(); b.socket.destroy() })
  const body = JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { private: 'PRIVATE_REQUEST_PARAMS', url: 'https://private.invalid/payload', image: 'PRIVATE_SCREENSHOT' } }), split = Math.floor(body.length / 2)
  const input = Buffer.concat([frame(body.slice(0, split), { mask: true, final: false }), frame('ping', { mask: true, opcode: 9 }), frame(body.slice(split), { mask: true, opcode: 0 })])
  a.socket.write(input.subarray(0, 3)); a.socket.write(input.subarray(3))
  await wait(() => own.received.length === 1 && proxy.snapshot().records.some(row => row.outcome === 'replied'))
  assert.deepEqual(Buffer.concat(own.raw), input, 'Client frames are never unmasked/rewritten in transit')
  await wait(() => Buffer.concat(a.received).length === own.emitted[0].length)
  assert.deepEqual(Buffer.concat(a.received), own.emitted[0], 'Browser response frames remain byte-for-byte identical')
  b.socket.write(frame(JSON.stringify({ id: 7, method: 'Target.attachToTarget', params: { targetId: 'PRIVATE_TARGET' } }), { mask: true }))
  await wait(() => proxy.snapshot().records.some(row => row.outcome === 'cdp-error'))
  const report = proxy.snapshot(), serialized = JSON.stringify(report)
  assert.equal(report.compressionDisabledForObservation, true); assert.equal(report.handshakeUnchanged, false); assert.deepEqual(own.offeredExtensions, [undefined, undefined]);
  assert.equal(report.connections, 2); assert.equal(report.undecodedMessages, 0); assert.equal(report.droppedRecords, 0)
  assert.deepEqual(report.records.filter(row => row.id === 7 && row.outcome !== 'sent').map(row => [row.connection, row.method, row.outcome]), [[1, 'Runtime.evaluate', 'replied'], [2, 'Target.attachToTarget', 'cdp-error']])
  for (const text of ['PRIVATE_', 'private.invalid', 'params', 'targetId', 'secret', '"error"', '"result"']) assert.ok(!serialized.includes(text), text)
  assert.ok(report.records.every(row => Object.keys(row).every(key => ['connection', 'id', 'method', 'elapsedMs', 'outcome', 'deliverySequence'].includes(key))))
  assert.equal(report.commandsCreated + report.commandsReplayed, 0)
})

test('unanswered CDP methods remain pending with elapsed time, and cleanup closes only observer-owned sockets', async t => {
  const own = await upstream(t), proxy = await createCDPMetadataProxy(own.endpoint), a = await client(proxy.endpoint)
  a.socket.write(frame('{"id":9,"method":"Page.getFrameTree","params":{"private":"NO_SAVE"}}', { mask: true }))
  await wait(() => proxy.snapshot().pending.length === 1); await delay(10)
  const before = proxy.snapshot(); assert.equal(before.pending[0].method, 'Page.getFrameTree'); assert.ok(before.pending[0].elapsedMs >= 5)
  await proxy.close(); await proxy.close()
  const after = proxy.snapshot(); assert.equal(after.closed, true); assert.equal(after.pending.length, 0)
  assert.ok(after.records.some(row => row.id === 9 && row.outcome === 'connection-closed'))
  assert.equal((await fetch(own.endpoint + '/json/version')).status, 200, 'The observer never closes the owned browser itself')
  await assert.rejects(fetch(proxy.endpoint + '/json/version'))
  a.socket.destroy()
})

test('observer refuses non-loopback, credential-bearing and unexpected HTTP endpoints without opening a relay', async () => {
  for (const endpoint of ['http://example.invalid:9222', 'https://127.0.0.1:9222', 'http://user:secret@127.0.0.1:9222', 'http://127.0.0.1:9222/private']) await assert.rejects(createCDPMetadataProxy(endpoint))
})


test('preserved compression independently decodes the exact response ID and correlates original-frame socket delivery', async t => {
  const own = await upstream(t, { compression: true }), proxy = await createCDPMetadataProxy(own.endpoint, { preserveCompression: true }); t.after(() => proxy.close())
  const a = await client(proxy.endpoint, { compression: true }); t.after(() => a.socket.destroy())
  const requestBytes = frame('{"id":4,"method":"Page.getLayoutMetrics","params":{"private":"NO_PERSIST"}}', { mask: true })
  a.socket.write(requestBytes)
  await wait(() => proxy.snapshot().records.some(row => row.id === 4 && row.outcome === 'replied'))
  let observed = proxy.snapshot()
  assert.equal(observed.compressionDisabledForObservation, false)
  assert.equal(observed.compressionNegotiationUnchanged, true)
  assert.equal(observed.compressedConnections, 1)
  assert.equal(observed.validForTimeoutAttribution, true)
  assert.equal(observed.frameObservationComplete, true)
  assert.equal(observed.diagnosticLevel, 'frames-and-independent-deflate-json')
  assert.ok(observed.frames.some(row => row.direction === 'browser-to-client' && row.phase === 'header' && row.rsv === 4 && row.opcode === 1))
  assert.ok(observed.frames.some(row => row.direction === 'browser-to-client' && row.phase === 'complete' && row.opcode === 0))
  assert.ok(observed.frames.every(row => Object.keys(row).every(key => ['connection', 'direction', 'relativeMs', 'phase', 'opcode', 'length', 'rsv', 'final', 'masked'].includes(key))))
  assert.equal(observed.records.filter(row => row.id === 4 && row.outcome === 'replied').length, 1)
  const reply = observed.records.find(row => row.id === 4 && row.outcome === 'replied')
  await wait(() => proxy.snapshot().deliveries.some(row => row.sequence === reply.deliverySequence && row.phase === 'written' && row.direction === 'browser-to-client'))
  assert.equal(observed.timingUnchanged, false)
  assert.match(observed.deliveryCompletionMeaning, /not-remote-JavaScript-consumption/u)
  assert.deepEqual(Buffer.concat(own.raw), requestBytes)
  await wait(() => Buffer.concat(a.received).length === own.emitted[0].length)
  assert.deepEqual(Buffer.concat(a.received), own.emitted[0])
  a.socket.write(frame('{"id":5,"method":"Target.getTargets"}', { mask: true }))
  await wait(() => proxy.snapshot().records.filter(row => row.outcome === 'replied').length === 2)
  observed = proxy.snapshot()
  assert.ok(observed.frames.filter(row => row.direction === 'browser-to-client' && row.phase === 'complete').length >= 4, 'Each compressed response retains frame-level evidence')
  assert.ok(!JSON.stringify(observed).includes('PRIVATE_RESPONSE_BODY'))
  assert.ok(!JSON.stringify(observed).includes('NO_PERSIST'))
})


test('preserved compressed takeover replies use their own per-direction rolling context for seven sequential IDs', async t => {
  const own = await upstream(t, { compression: true, noContextTakeover: false }), proxy = await createCDPMetadataProxy(own.endpoint, { preserveCompression: true }); t.after(() => proxy.close())
  const a = await client(proxy.endpoint, { compression: true }); t.after(() => a.socket.destroy())
  for (let id = 1; id <= 7; id++) {
    a.socket.write(frame(JSON.stringify({ id, method: 'Runtime.evaluate', params: { private: 'PRIVATE_DICTIONARY_' + 'takeover-fixture-content'.repeat(100) + id } }), { mask: true }))
    await wait(() => proxy.snapshot().records.some(row => row.id === id && row.outcome === 'replied'))
  }
  const observed = proxy.snapshot()
  assert.equal(observed.undecodedMessages, 0); assert.equal(observed.validForTimeoutAttribution, true)
  assert.equal(observed.records.filter(row => row.outcome === 'replied').length, 7)
  assert.ok(!JSON.stringify(observed).includes('PRIVATE_DICTIONARY_'))
})

test('unsupported compressed messages invalidate JSON attribution while subsequent original frame timing remains observable', async t => {
  const own = await upstream(t, { compression: true, invalidCompression: true }), proxy = await createCDPMetadataProxy(own.endpoint, { preserveCompression: true }); t.after(() => proxy.close())
  const a = await client(proxy.endpoint, { compression: true }); t.after(() => a.socket.destroy())
  for (const id of [1, 2]) {
    a.socket.write(frame(JSON.stringify({ id, method: 'Runtime.evaluate' }), { mask: true }))
    await wait(() => proxy.snapshot().undecodedMessages === id)
  }
  const observed = proxy.snapshot()
  assert.equal(observed.validForTimeoutAttribution, false)
  assert.equal(observed.frameObservationComplete, true)
  assert.equal(observed.diagnosticLevel, 'frames-compressed-json-incomplete')
  assert.equal(observed.records.filter(row => row.outcome === 'replied').length, 0)
  assert.equal(observed.frames.filter(row => row.direction === 'browser-to-client' && row.phase === 'complete').length, 4)
})
