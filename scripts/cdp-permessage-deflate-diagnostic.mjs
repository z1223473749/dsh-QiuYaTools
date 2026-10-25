/** Test-only, bounded PMD side decoder. It never opens a socket or records payloads. */
import { constants, inflateRawSync } from 'node:zlib'

const MAX_DIAGNOSTIC_BYTES = 48 * 1024 * 1024
const WINDOW_BYTES = 32768
const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff])
const PUBLIC_CODE = 'CDP_DEFLATE_DIAGNOSTIC_FAILED'

function diagnosticError(reason) {
  const error = new Error(PUBLIC_CODE)
  error.code = PUBLIC_CODE
  error.reason = reason
  return error
}

function nextWindow(previous, output) {
  const outputBytes = Math.min(output.length, WINDOW_BYTES)
  const previousBytes = Math.min(previous.length, WINDOW_BYTES - outputBytes)
  const next = Buffer.allocUnsafe(previousBytes + outputBytes)
  previous.copy(next, 0, previous.length - previousBytes)
  output.copy(next, previousBytes, output.length - outputBytes)
  return next
}

/**
 * Decode complete compressed message payloads, after unmasking/reassembling frames.
 * Create a distinct instance for each connection and direction. Uncompressed
 * messages and control frames must bypass this API without altering its window.
 *
 * Supports the SYNC_FLUSH message form. Legal BFINAL streams that terminate
 * before the reconstructed tail are conservatively rejected, so a partial
 * decode cannot be presented as proof of a complete CDP reply.
 */
export function createPerMessageDeflateDiagnostic(options) {
  const { noContextTakeover, maxOutputBytes = MAX_DIAGNOSTIC_BYTES } = options ?? {}
  if (typeof noContextTakeover !== 'boolean' || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_DIAGNOSTIC_BYTES) {
    throw diagnosticError('INVALID_OPTIONS')
  }

  let dictionary = Buffer.alloc(0)
  let disposed = false
  const dispose = () => {
    disposed = true
    dictionary.fill(0)
    dictionary = Buffer.alloc(0)
  }
  const fail = reason => { dispose(); throw diagnosticError(reason) }

  return {
    decode(payload) {
      if (disposed) throw diagnosticError('DISPOSED')
      if (!Buffer.isBuffer(payload) || payload.length > MAX_DIAGNOSTIC_BYTES) fail('INVALID_PAYLOAD')
      const input = Buffer.concat([payload, TAIL])
      let result
      try {
        result = inflateRawSync(input, {
          windowBits: 15,
          finishFlush: constants.Z_SYNC_FLUSH,
          maxOutputLength: maxOutputBytes,
          info: true,
          ...(!noContextTakeover && dictionary.length ? { dictionary } : {}),
        })
      } catch (error) {
        fail(error?.code === 'ERR_BUFFER_TOO_LARGE' ? 'OUTPUT_LIMIT' : 'INVALID_DEFLATE')
      } finally {
        // This is our own copy; caller-owned frame bytes are never mutated.
        input.fill(0)
      }
      if (result.engine.bytesWritten !== input.length) {
        result.buffer.fill(0)
        fail('UNSUPPORTED_END')
      }

      const output = result.buffer
      const next = noContextTakeover ? Buffer.alloc(0) : nextWindow(dictionary, output)
      dictionary.fill(0)
      dictionary = next
      return output
    },
    dispose,
  }
}
