import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { inspectOwnedFixtureFrame, ownedFixtureColors } from '../scripts/owned-fixture-pixels.mjs'
const require = createRequire(import.meta.url), { jpegjs } = require(join(dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js'))
function frame(variant, width = 240, height = 160) {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < data.length; i += 4) { data[i] = ownedFixtureColors[variant][0]; data[i + 1] = ownedFixtureColors[variant][1]; data[i + 2] = ownedFixtureColors[variant][2]; data[i + 3] = 255 }
  return { targetId: 'owned-' + variant, mediaType: 'image/jpeg', frameId: 'fixture-frame', imageBase64: jpegjs.encode({ data, width, height }, 80).data.toString('base64') }
}
test('three real JPEG baselines decode to distinct task-bound RGB corners and bounded proof without image data', () => {
  const proofs = Object.keys(ownedFixtureColors).map(variant => inspectOwnedFixtureFrame(frame(variant), { targetId: 'owned-' + variant, variant }, jpegjs.decode))
  assert.equal(new Set(proofs.map(value => value.imageSha256)).size, 3)
  for (const proof of proofs) { assert.equal(proof.width, 240); assert.equal(proof.height, 160); assert.equal(proof.pixels.length, 3); assert.equal(JSON.stringify(proof).includes('imageBase64'), false) }
})
test('frontmost image cannot masquerade as a background task, even with a forged target field', () => {
  const wrong = frame('browser'); wrong.targetId = 'owned-orders'
  assert.throws(() => inspectOwnedFixtureFrame(wrong, { targetId: 'owned-orders', variant: 'orders' }, jpegjs.decode), /pixels must belong/u)
  assert.throws(() => inspectOwnedFixtureFrame(frame('orders'), { targetId: 'other-task', variant: 'orders' }, jpegjs.decode), /target must match/u)
})
test('invalid type, bytes, dimensions and unknown variants fail rather than becoming screenshot proof', () => {
  for (const observation of [{ ...frame('orders'), mediaType: 'image/png' }, { ...frame('orders'), imageBase64: 'invalid jpeg' }, { ...frame('orders'), imageBase64: Buffer.alloc(120).toString('base64') }, frame('orders', 80, 80)]) assert.throws(() => inspectOwnedFixtureFrame(observation, { targetId: 'owned-orders', variant: 'orders' }, jpegjs.decode))
  assert.throws(() => inspectOwnedFixtureFrame(frame('orders'), { targetId: 'owned-orders', variant: 'unknown' }, jpegjs.decode))
})
