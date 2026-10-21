import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { WKFrameReceiver, macResourceVerdict, wkPreviewInstrumentation } from '../scripts/computer-wkwebview-soak-evidence.mjs'

const frame = (generation, sequence, atMs) => ({ kind: 'frame', generation, sequence, atMs, stamp: atMs % 2 ** 32, width: 1280, height: 720 })
const batch = (generation, index, events) => ({ generation, batch: index, events, transportFailures: 0, document: { visibility: 'visible' } })

test('WK delivery deduplicates immutable HTTP retry and rejects missing frame batches', () => {
  const receiver = new WKFrameReceiver(); receiver.useGeneration(1); receiver.stats.begin(1000)
  const value = batch(1, 1, [frame(1, 1, 1100)])
  receiver.receive(value, 1100); assert.deepEqual(receiver.receive(value, 1100), { duplicate: true })
  assert.equal(receiver.stats.frames.length, 1)
  assert.throws(() => receiver.receive(batch(1, 3, [frame(1, 2, 1200)]), 1200), /sequence/)
})

test('WK statistics exclude warm-up and retired pages but include fault wall-clock gap', () => {
  const receiver = new WKFrameReceiver(); receiver.useGeneration(1)
  receiver.receive(batch(1, 1, [frame(1, 1, 900)]), 900); receiver.stats.begin(1000)
  receiver.receive(batch(1, 2, [frame(1, 2, 1100)]), 1100); receiver.useGeneration(2)
  receiver.receive(batch(1, 3, [frame(1, 3, 1200)]), 1200)
  receiver.receive(batch(2, 1, [frame(2, 1, 5100)]), 5100); receiver.stats.finish(6000)
  const summary = receiver.stats.summary()
  assert.equal(summary.frames, 2); assert.equal(summary.warmupFramesExcluded, 1)
  assert.equal(summary.endToEndFps, .4); assert.equal(summary.maxFrameGapMs, 4000)
  assert.equal(summary.ignoredRetiredNotifications, 1)
})

test('Mac resource acceptance fails closed when XPC attribution is unverified or RSS exceeds unchanged limits', () => {
  const row = { birthMicros: '100', uniqueId: '123', residentBytes: 200 }
  const sample = { node: { rss: 100 }, attribution: { complete: true }, processes: [row] }
  assert.equal(macResourceVerdict([sample]).passed, true)
  assert.equal(macResourceVerdict([{ ...sample, attribution: { complete: false } }]).passed, false)
  assert.equal(macResourceVerdict([{ ...sample, processes: [{ ...row, residentBytes: 1536 * 1024 ** 2 + 1 }] }]).passed, false)
  assert.equal(macResourceVerdict([]).passed, false)
})

test('WK instrumentation installs before production draw without rewriting production canvas code', () => {
  const production = '<!doctype html><html><head><title>fixture</title></head><body><script>productionDraw()</script></body></html>'
  const result = wkPreviewInstrumentation(production, { generation: 1, reportPath: '/__wk_soak/12345678-1234-1234-1234-123456789abc/frames' })
  assert.ok(result.indexOf('__qytWKSoakFrame') < result.indexOf('productionDraw()'))
  assert.ok(result.includes('<body><script>productionDraw()</script></body>'))
  assert.throws(() => wkPreviewInstrumentation(production, { generation: 1, reportPath: 'https://remote/frames' }), /isolated/)
})

test('WK probe accepts the actual shipped implicit-head preview and preserves its script', async () => {
  const built = await build({ entryPoints: ['src/features/computer-use/preview-page.ts'], bundle: true, write: false, format: 'esm' })
  const { computerPreviewPage } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
  const result = wkPreviewInstrumentation(computerPreviewPage, { generation: 1, reportPath: '/__wk_soak/12345678-1234-1234-1234-123456789abc/frames' })
  assert.ok(result.indexOf('__qytWKSoakFrame') < result.indexOf("(()=>{'use strict'"))
  assert.ok(result.includes(computerPreviewPage.slice(computerPreviewPage.indexOf('<script>'))))
  assert.throws(() => wkPreviewInstrumentation('<html>no scripts</html>', { generation: 1, reportPath: '/__wk_soak/12345678-1234-1234-1234-123456789abc/frames' }), /script was not found/)
})
