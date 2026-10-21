import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasVisibleMacPreviewFrame, waitForOwnedMacPreview } from './fixtures/harness-preview-readiness.mjs'

const readyPreview = () => ({ labels: ['暂停', '接管', '继续', '停止', '实时电脑画面'], canvas: { width: 434, height: 360 }, recognizedText: ['38 ms'] })

test('Mac owned preview readiness requires visible pixel latency as well as actual image and controls', () => {
  assert.equal(hasVisibleMacPreviewFrame(readyPreview()), true)
  assert.equal(hasVisibleMacPreviewFrame({ ...readyPreview(), recognizedText: [], labels: [...readyPreview().labels, '38 ms'] }), false, 'AX-only text cannot stand in for the visible footer pixels')
  assert.equal(hasVisibleMacPreviewFrame({ ...readyPreview(), canvas: null }), false)
  assert.equal(hasVisibleMacPreviewFrame({ ...readyPreview(), labels: ['暂停', '实时电脑画面'] }), false)
})

test('Mac owned preview readiness waits through partial AX publication without triggering input', async () => {
  const frames = [{ labels: ['暂停'] }, { ...readyPreview(), recognizedText: [] }, readyPreview()], attempts = []
  let reads = 0
  const actual = await waitForOwnedMacPreview(async () => frames[reads++], { intervalMs: 1, onAttempt: view => attempts.push(view) })
  assert.equal(actual, frames[2]); assert.equal(reads, 3); assert.deepEqual(attempts, frames)
})

test('Mac owned preview readiness fails boundedly when only controls ever appear and retains attempts', async () => {
  const attempts = []
  await assert.rejects(waitForOwnedMacPreview(async () => ({ labels: ['暂停'] }), { timeoutMs: 8, intervalMs: 1, onAttempt: view => attempts.push(view) }), /visible successful frame latency/u)
  assert.ok(attempts.length > 0)
})

test('Mac owned preview fixture compiles and rejects invalid input without UI, events or activation', { skip: process.platform !== 'darwin' }, async () => {
  const run = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'qiuya-preview-static-'))
  try {
    const executable = join(directory, 'preview-fixture')
    await run('/usr/bin/swiftc', ['-parse-as-library', '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'Vision', '-module-cache-path', join(tmpdir(), 'qiuya-harness-preview-test-module-cache'), fileURLToPath(new URL('fixtures/harness-preview-macos.swift', import.meta.url)), '-o', executable], { timeout: 60000 })
    const response = JSON.parse((await run(executable, ['--self-test'], { timeout: 5000 })).stdout)
    assert.equal(response.ok, true)
    assert.deepEqual(response.result, { projection: true, outsideRejected: true, identityRetirement: true, visibleLatencyRecognition: true, inputEventsPosted: 0, activationCalls: 0 })
    for (const request of ['{}', '{"op":"global-click","x":1,"y":2}', 'not JSON']) {
      await assert.rejects(() => run(executable, ['--request', request], { timeout: 5000 }), error => {
        assert.equal(error.code, 1)
        assert.equal(JSON.parse(error.stdout).error, request === 'not JSON' ? 'owned-preview-observer-failed' : 'invalid-owned-preview-request')
        return true
      })
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
