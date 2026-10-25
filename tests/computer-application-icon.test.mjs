import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { deflateSync } from 'node:zlib'

const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/application-icon.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { applicationIconDataUrl } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const dataUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`

// Real PNG chunks let size and dimension boundaries describe usable images,
// rather than accepting an invented header as the positive fixture.
function chunk(type, payload) {
  const name = Buffer.from(type), body = Buffer.concat([name, payload])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const prefix = Buffer.alloc(4), suffix = Buffer.alloc(4)
  prefix.writeUInt32BE(payload.length); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([prefix, body, suffix])
}
function png(width = 32, height = 32, byteLength) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const start = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)])
  const pixels = chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), end = chunk('IEND', Buffer.alloc(0))
  if (byteLength === undefined) return Buffer.concat([start, pixels, end])
  const paddingLength = byteLength - start.length - pixels.length - end.length - 12
  assert.ok(paddingLength >= 4)
  return Buffer.concat([start, chunk('tEXt', Buffer.from(`pad\0${'x'.repeat(paddingLength - 4)}`)), pixels, end])
}

test('application icons accept embedded PNGs through the inclusive 64 px and 16 KiB limits', () => {
  for (const bytes of [png(1, 1), png(), png(64, 64), png(1, 1, 16 * 1024)]) {
    const icon = dataUrl(bytes)
    assert.equal(applicationIconDataUrl(icon), icon)
  }
  assert.equal(applicationIconDataUrl(dataUrl(png(1, 1, 16 * 1024 + 1))), undefined)
  for (const dimensions of [[65, 1], [1, 65]]) assert.equal(applicationIconDataUrl(dataUrl(png(...dimensions))), undefined)
  const zeroWidth = png(); zeroWidth.writeUInt32BE(0, 16)
  const zeroHeight = png(); zeroHeight.writeUInt32BE(0, 20)
  assert.equal(applicationIconDataUrl(dataUrl(zeroWidth)), undefined)
  assert.equal(applicationIconDataUrl(dataUrl(zeroHeight)), undefined)
})

test('application icons reject links, SVG, unknown values and malformed base64 without throwing', () => {
  const valid = dataUrl(png())
  for (const value of [
    undefined, null, false, 3, {}, [],
    'https://example.invalid/icon.png', 'file:///Applications/Private.app/icon.png',
    'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/jpeg;base64,/9j/2Q==',
    'data:image/png;base64,', 'data:image/png;base64,!!!!',
    'data:image/png;base64,A===', 'data:image/png;base64,AAA',
    `${valid.slice(0, -4)}=AAA`, `${valid}\n`, valid.replace('base64,', 'base64, '),
  ]) assert.equal(applicationIconDataUrl(value), undefined, `must discard ${String(value).slice(0, 100)}`)
})

test('application icons reject truncated PNGs and a wrong signature or first chunk', () => {
  for (const length of [0, 8, 16, 32]) assert.equal(applicationIconDataUrl(dataUrl(png().subarray(0, length))), undefined)
  const signature = png(); signature[0] = 0
  const chunkType = png(); chunkType.write('IDAT', 12, 'ascii')
  const headerLength = png(); headerLength.writeUInt32BE(12, 8)
  for (const bytes of [signature, chunkType, headerLength]) assert.equal(applicationIconDataUrl(dataUrl(bytes)), undefined)
})
