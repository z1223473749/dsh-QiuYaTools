import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { HARNESS_HOST_STARTUP_MS, waitForHarnessHostUrl } from '../scripts/harness-host-readiness.mjs'

test('installer accepts the observed 48-second bootstrap within the existing UI startup budget', async () => {
  let now = 0
  const url = await waitForHarnessHostUrl(() => ({ exited: false, url: now >= 48005 ? 'http://127.0.0.1:12345/?token=owned-fixture' : undefined }), { now: () => now, sleep: async milliseconds => { now += milliseconds } })
  assert.equal(url, 'http://127.0.0.1:12345/?token=owned-fixture')
  assert.equal(now, 48100)
  assert.equal(HARNESS_HOST_STARTUP_MS, 90000)
})

test('Host bootstrap still fails at the fixed 90-second boundary without retrying or waiting indefinitely', async () => {
  let now = 0, reads = 0
  await assert.rejects(waitForHarnessHostUrl(() => { reads++; return { exited: false } }, { now: () => now, sleep: async milliseconds => { now += milliseconds } }), /within 90000 ms/u)
  assert.equal(now, 90000)
  assert.equal(reads, 900)
})

test('an exited Host fails immediately with its already-redacted diagnostic', async () => {
  let sleeps = 0
  await assert.rejects(waitForHarnessHostUrl(() => ({ exited: true, error: 'own Host failed; token=<redacted>' }), { sleep: async () => { sleeps++ } }), /own Host failed; token=<redacted>/u)
  assert.equal(sleeps, 0)
})

test('the real installer and Windows carrier include readiness helper while UI retains its original 90-second wait', async () => {
  const [installer, carrier, runtime, ui] = await Promise.all(['scripts/test-harness-install.mjs', 'scripts/e2e-windows-harness-pd.mjs', 'scripts/prepare-windows-test-runtime.mjs', 'scripts/e2e-harness.mjs'].map(path => readFile(new URL('../' + path, import.meta.url), 'utf8')))
  assert.match(installer, /const url = await waitForHarnessHostUrl/u)
  assert.match(carrier, /files\.set\('harness-host-readiness\.mjs'/u)
  assert.match(carrier, /\['previous\.tgz', 'test-harness-install\.mjs', 'harness-host-readiness\.mjs'\]/u)
  assert.ok(runtime.includes("'scripts/harness-host-readiness.mjs'"))
  assert.match(ui, /'Isolated Harness did not start', 90000/u)
})
