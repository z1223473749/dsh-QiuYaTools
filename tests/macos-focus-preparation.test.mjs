import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

// This compiles the actual native input boundary but runs only pure metadata
// and injected readiness backends: no GUI, AX request or native input is sent.
test('macOS exact-window readiness refuses same-process siblings and preserves cancellation/budgets without AX content', { skip: process.platform !== 'darwin', timeout: 120_000 }, async t => {
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/test-macos-computer.mjs', import.meta.url))], { timeout: 110_000, maxBuffer: 1_000_000 })
  assert.match(stdout, /exact-window CG metadata\/ambiguity\/front-order zero-post matrices/u)
  assert.match(stdout, /exact ordered-prefix\/destination-specific identity matrices/u)
  assert.match(stdout, /exact pointer route\/negative-screen\/zero-post matrices/u)
  assert.match(stdout, /strict AX keyboard-root\/non-key-sibling\/error\/drift matrices/u)
  assert.match(stdout, /per-post human-generation\/partial-input\/independent-UP matrices/u)
  assert.match(stdout, /bounded focus readiness\/human\/cancel\/epoch\/deadline matrices \(no real activation\/AX\/input\)/u)
  t.diagnostic('Actual Swift sources compiled; exact-window metadata, same-PID sibling, explicit pointer routing, strict AX keyboard root, foreground switch and zero-post readiness matrices passed. No GUI or native input.')
})
