import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('Mac owned-target fixture compiles and checks ancestry, offscreen stability and ambiguous reuse without GUI or activation', { skip: process.platform !== 'darwin', timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-mac-target-static-')), run = promisify(execFile)
  try {
    const executable = join(directory, 'target-fixture')
    await run('/usr/bin/swiftc', ['-parse-as-library', '-framework', 'AppKit', '-framework', 'ApplicationServices', fileURLToPath(new URL('fixtures/harness-target-macos.swift', import.meta.url)), '-o', executable], { timeout: 60_000 })
    const response = JSON.parse((await run(executable, ['--self-test'], { timeout: 5000 })).stdout)
    assert.deepEqual(response, { ok: true, result: { ownership: true, stableOffscreenTransition: true, duplicateAndWrongFrontRejected: true, metadataOnly: true, inputEventsPosted: 0, activationCalls: 0, raiseCalls: 0 } })
    for (const request of ['{}', '{"op":"activate","label":"other-window"}', 'not JSON']) {
      const invalid = JSON.parse((await run(executable, ['--request', request], { timeout: 5000 })).stdout)
      assert.equal(invalid.ok, false); assert.deepEqual(invalid.diagnostic, { inputEventsPosted: 0, activationCalls: 0, raiseCalls: 0 })
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Mac E2E fixture setup precedes model authorization and repeat-open uses bound stable readiness', async () => {
  const source = await readFile(new URL('../scripts/e2e-harness.mjs', import.meta.url), 'utf8')
  const setup = source.indexOf("activation = await ownMacTarget('activate', alpha)")
  const request = source.indexOf('const approval = inlinePreview.getByRole')
  assert.ok(setup > 0 && request > setup)
  assert.match(source, /if \(process\.platform === 'darwin' && macTargetBinding\) await ownMacTarget\('wait', alpha\)/u)
  assert.match(source, /host\.exitCode === null/u)
  assert.match(source, /authorizationStarted: false, inputEventsPosted: 0/u)
})
