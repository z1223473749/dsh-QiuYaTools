/** Test-only pixel oracle. Decoder must be the runtime's pure JPEG library. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
export const ownedFixtureColors = Object.freeze({ default: Object.freeze([232, 242, 242]), orders: Object.freeze([248, 224, 208]), browser: Object.freeze([215, 227, 255]) })
export function inspectOwnedFixtureFrame(observation, { targetId, variant }, decode) {
  assert(Object.hasOwn(ownedFixtureColors, variant), 'Unknown owned fixture variant')
  assert.equal(observation?.targetId, targetId, 'JPEG target must match the exact installed task')
  assert.equal(observation?.mediaType, 'image/jpeg', 'Installed frame must be JPEG')
  const encoded = observation.imageBase64
  assert(typeof encoded === 'string' && encoded.length <= 12 * 1024 * 1024 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(encoded), 'Invalid bounded JPEG encoding')
  const bytes = Buffer.from(encoded, 'base64'); assert(bytes.length > 100 && bytes.length <= 8 * 1024 * 1024, 'Invalid bounded JPEG bytes')
  const image = decode(bytes, { useTArray: true, maxMemoryUsageInMB: 64, maxResolutionInMP: 8 })
  assert(image.width > 100 && image.height > 100 && image.width * image.height <= 8 * 1024 * 1024, 'Invalid decoded fixture dimensions')
  const expected = ownedFixtureColors[variant], pixels = []
  for (const [x, y] of [[8, 8], [image.width - 9, 8], [8, image.height - 9]]) {
    const offset = (y * image.width + x) * 4, actual = [...image.data.subarray(offset, offset + 3)]
    assert.equal(actual.length, 3)
    assert(actual.every((value, index) => Math.abs(value - expected[index]) <= 6), 'JPEG pixels must belong to the expected owned task')
    pixels.push({ x, y, rgb: actual })
  }
  return { targetId, variant, frameId: observation.frameId, width: image.width, height: image.height, imageSha256: createHash('sha256').update(bytes).digest('hex'), expectedRGB: [...expected], pixels }
}
