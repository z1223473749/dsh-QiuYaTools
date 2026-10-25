import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeflateRaw, deflateRawSync, inflateRawSync, constants } from 'node:zlib'
import { createPerMessageDeflateDiagnostic } from '../scripts/cdp-permessage-deflate-diagnostic.mjs'

const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff])
const CODE = 'CDP_DEFLATE_DIAGNOSTIC_FAILED'
const compressed = input => deflateRawSync(input, { finishFlush: constants.Z_SYNC_FLUSH }).subarray(0, -4)
const matches = reason => error => {
  assert.equal(error.code, CODE)
  assert.equal(error.message, CODE)
  assert.equal(error.reason, reason)
  assert.deepEqual(Object.keys(error).sort(), ['code', 'reason'])
  assert.equal(error.cause, undefined)
  return true
}

async function compressor(t) {
  const stream = createDeflateRaw()
  t.after(() => stream.destroy())
  return {
    reset: () => stream.reset(),
    encode: input => new Promise((resolve, reject) => {
      const chunks = []
      const onData = bytes => chunks.push(bytes)
      const onError = error => { stream.off('data', onData); reject(error) }
      stream.on('data', onData)
      stream.once('error', onError)
      stream.write(input)
      stream.flush(constants.Z_SYNC_FLUSH, () => {
        stream.off('data', onData)
        stream.off('error', onError)
        const bytes = Buffer.concat(chunks)
        assert.deepEqual(bytes.subarray(-4), TAIL)
        resolve(bytes.subarray(0, -4))
      })
    }),
  }
}

test('independent complete-message decoder preserves caller bytes and returns only the decoded Buffer', () => {
  const plain = Buffer.from('{"id":11,"result":{"private":"DO_NOT_PERSIST"}}')
  const payload = compressed(plain), before = Buffer.from(payload)
  const decoder = createPerMessageDeflateDiagnostic({ noContextTakeover: true })
  assert.deepEqual(Object.keys(decoder).sort(), ['decode', 'dispose'])
  const decoded = decoder.decode(payload)
  assert.ok(Buffer.isBuffer(decoded))
  assert.deepEqual(decoded, plain)
  assert.deepEqual(payload, before)
  assert.equal(JSON.stringify(decoder), '{}', 'The public instance never projects payloads or a history snapshot')
  decoder.dispose()
  decoder.dispose()
  assert.deepEqual(decoded, plain, 'Disposal only clears its private dictionary')
  assert.throws(() => decoder.decode(payload), matches('DISPOSED'))
})

test('seven actual zlib takeover messages require and retain the complete rolling window', async t => {
  const encoder = await compressor(t)
  const decoder = createPerMessageDeflateDiagnostic({ noContextTakeover: false })
  t.after(() => decoder.dispose())
  // Longer than the 32 KiB window, followed by short messages that must retain
  // earlier output as well as their own few bytes in the rolling dictionary.
  const seed = Buffer.from('0123456789-abcdefghijklmnop'.repeat(2300))
  const sources = [seed, ...Array.from({ length: 6 }, (_, index) => Buffer.from('0123456789-abcdefghijklmnop'.repeat(index + 1)))]
  let second
  for (let index = 0; index < sources.length; index++) {
    const payload = await encoder.encode(sources[index])
    assert.deepEqual(decoder.decode(payload), sources[index])
    if (index === 1) second = payload
  }
  assert.throws(() => inflateRawSync(Buffer.concat([second, TAIL]), { finishFlush: constants.Z_SYNC_FLUSH }), error => error.code === 'Z_DATA_ERROR', 'A stateless inflater cannot pass this takeover fixture')
})

test('seven independently flushed/reset messages decode without context takeover', async t => {
  const encoder = await compressor(t)
  const decoder = createPerMessageDeflateDiagnostic({ noContextTakeover: true })
  t.after(() => decoder.dispose())
  for (let index = 0; index < 7; index++) {
    const source = Buffer.from(JSON.stringify({ id: index, result: { fixture: 'abcdefghij'.repeat(6500) } }))
    const payload = await encoder.encode(source)
    assert.deepEqual(decoder.decode(payload), source)
    encoder.reset()
  }
})

test('uncompressed traffic bypasses the decoder and cannot replace the compressed-message dictionary', async t => {
  const encoder = await compressor(t)
  const decoder = createPerMessageDeflateDiagnostic({ noContextTakeover: false })
  t.after(() => decoder.dispose())
  const source = Buffer.from('ONLY_THE_COMPRESSED_WINDOW_'.repeat(1100))
  assert.deepEqual(decoder.decode(await encoder.encode(source)), source)
  const uncompressed = Buffer.from('UNCOMPRESSED_WINDOW_MUST_NOT_BE_USED_'.repeat(1100))
  assert.ok(uncompressed.length > 32768)
  // FrameObserver handles these as plain messages. No call/reset here.
  const payload = await encoder.encode(source)
  assert.deepEqual(decoder.decode(payload), source)
  assert.throws(() => inflateRawSync(Buffer.concat([payload, TAIL]), { finishFlush: constants.Z_SYNC_FLUSH }), error => error.code === 'Z_DATA_ERROR')
})

test('connections and directions own independent windows; an invalid dependency permanently stops only that decoder', async t => {
  const encoder = await compressor(t)
  const a = createPerMessageDeflateDiagnostic({ noContextTakeover: false })
  const b = createPerMessageDeflateDiagnostic({ noContextTakeover: false })
  t.after(() => { a.dispose(); b.dispose() })
  const source = Buffer.from('DIRECTION_A_PRIVATE_FIXTURE'.repeat(1000))
  const first = await encoder.encode(source), second = await encoder.encode(source)
  assert.deepEqual(a.decode(first), source)
  assert.throws(() => b.decode(second), matches('INVALID_DEFLATE'))
  assert.deepEqual(a.decode(second), source)
  assert.throws(() => b.decode(first), matches('DISPOSED'))
})

test('output limit stops a real compression bomb without leaking zlib messages or decoded content', () => {
  const source = Buffer.alloc(32768, 65)
  const payload = compressed(source)
  assert.ok(payload.length < 100)
  const decoder = createPerMessageDeflateDiagnostic({ noContextTakeover: true, maxOutputBytes: 256 })
  assert.throws(() => decoder.decode(payload), matches('OUTPUT_LIMIT'))
  assert.throws(() => decoder.decode(compressed(Buffer.from('safe'))), matches('DISPOSED'))
})

test('exact output limit is allowed, while malformed DEFLATE invalidates its private stream', () => {
  const source = Buffer.alloc(256, 66)
  const exact = createPerMessageDeflateDiagnostic({ noContextTakeover: true, maxOutputBytes: source.length })
  assert.deepEqual(exact.decode(compressed(source)), source)
  exact.dispose()
  const broken = createPerMessageDeflateDiagnostic({ noContextTakeover: false })
  assert.throws(() => broken.decode(Buffer.from([0xff, 0xff, 0xff, 0xff])), matches('INVALID_DEFLATE'))
  assert.throws(() => broken.decode(compressed(source)), matches('DISPOSED'))
})

test('BFINAL streams, including the legal RFC example, and early-final streams with trailing bytes are rejected as incomplete evidence', () => {
  const fixtures = [
    // RFC 7692 section 7.2.3.4: valid PMD, outside this SYNC_FLUSH-only decoder.
    Buffer.from([0xf3, 0x48, 0xcd, 0xc9, 0xc9, 0x07, 0x00, 0x00]),
    deflateRawSync(Buffer.from('{"id":99}')),
    Buffer.concat([deflateRawSync(Buffer.from('{"id":99}')), Buffer.from('PRIVATE_TRAILING_BYTES')]),
  ]
  for (const payload of fixtures) {
    const decoder = createPerMessageDeflateDiagnostic({ noContextTakeover: true })
    assert.throws(() => decoder.decode(payload), matches('UNSUPPORTED_END'))
    assert.throws(() => decoder.decode(compressed(Buffer.from('safe'))), matches('DISPOSED'))
  }
})

test('invalid options and non-Buffer payloads fail with fixed public error metadata', () => {
  for (const options of [undefined, {}, { noContextTakeover: 'false' }, ...[0, -1, 0.5, Infinity, NaN, 48 * 1024 * 1024 + 1].map(maxOutputBytes => ({ noContextTakeover: true, maxOutputBytes }))]) {
    assert.throws(() => createPerMessageDeflateDiagnostic(options), matches('INVALID_OPTIONS'))
  }
  for (const payload of ['PRIVATE_PAYLOAD', new Uint8Array([1]), null, { private: 'NO_SAVE' }]) {
    const decoder = createPerMessageDeflateDiagnostic({ noContextTakeover: true })
    assert.throws(() => decoder.decode(payload), matches('INVALID_PAYLOAD'))
    assert.throws(() => decoder.decode(Buffer.alloc(0)), matches('DISPOSED'))
  }
})
