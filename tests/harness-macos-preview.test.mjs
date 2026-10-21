import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('Mac owned preview fixture compiles and rejects invalid input without UI, events or activation', { skip: process.platform !== 'darwin' }, async () => {
  const run = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'qiuya-preview-static-'))
  try {
    const executable = join(directory, 'preview-fixture')
    await run('/usr/bin/swiftc', ['-parse-as-library', '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-module-cache-path', join(tmpdir(), 'qiuya-harness-preview-test-module-cache'), fileURLToPath(new URL('fixtures/harness-preview-macos.swift', import.meta.url)), '-o', executable], { timeout: 60000 })
    const response = JSON.parse((await run(executable, ['--self-test'], { timeout: 5000 })).stdout)
    assert.equal(response.ok, true)
    assert.deepEqual(response.result, { projection: true, outsideRejected: true, identityRetirement: true, inputEventsPosted: 0, activationCalls: 0 })
    for (const request of ['{}', '{"op":"global-click","x":1,"y":2}', 'not JSON']) {
      await assert.rejects(() => run(executable, ['--request', request], { timeout: 5000 }), error => {
        assert.equal(error.code, 1)
        assert.equal(JSON.parse(error.stdout).error, request === 'not JSON' ? 'owned-preview-observer-failed' : 'invalid-owned-preview-request')
        return true
      })
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
