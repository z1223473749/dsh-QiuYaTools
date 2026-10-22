import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { WKFrameReceiver, macProcessCheckPassed, macResourceVerdict, macSelfResponsibleNative, wkPreviewInstrumentation } from '../scripts/computer-wkwebview-soak-evidence.mjs'

const frame = (generation, sequence, atMs) => ({ kind: 'frame', generation, sequence, atMs, stamp: atMs % 2 ** 32, width: 1280, height: 720 })
const batch = (generation, index, events) => ({ generation, batch: index, events, transportFailures: 0, document: { visibility: 'visible' } })

test('SETEXEC carrier attribution requires the actual native PID, executable and parent, never shared Codex responsibility', () => {
  const row = { pid: 100, role: 'native', parentPid: 99, responsiblePid: 100, path: '/owned/companion', birthMicros: '100001', uniqueId: '42' }
  const expected = { helperPath: row.path, runnerPid: 99 }
  assert.equal(macSelfResponsibleNative(row, expected), true)
  for (const change of [{ responsiblePid: 76586 }, { path: '/owned/launcher' }, { parentPid: 1 }, { role: 'descendant' }, { uniqueId: '0' }, { birthMicros: null }, { birthMicros: 100001 }, { uniqueId: 42 }]) assert.equal(macSelfResponsibleNative({ ...row, ...change }, expected), false)
})

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

test('Diagnostic WebKit candidates cannot substitute for verified owned process/resource evidence', () => {
  const diagnostic = { pid: 123, diagnosticOnly: true, adoptedByName: false, path: '/System/Volumes/Preboot/Cryptexes/App/example/WebKit.WebContent', rowExclusion: 'unique-identity-unavailable:1' }
  const sample = { node: { rss: 100 }, attribution: { complete: false, errors: ['owned-webcontent-not-verified'] }, processes: [{ birthMicros: '100', uniqueId: '123', residentBytes: 200 }], webKitDiagnostics: [diagnostic] }
  assert.equal(macResourceVerdict([sample]).passed, false)
  assert.equal(macResourceVerdict([{ ...sample, processes: [], attribution: { complete: true } }]).passed, false)
})

test('Mac cleanup schema requires exact complete gone identities and rejects unreadable or missing results', () => {
  const identity = { pid: 123, birthMicros: '100', uniqueId: '234' }
  const result = state => ({ passed: true, results: [{ ...identity, state }] })
  assert.equal(macProcessCheckPassed(result('exited'), [identity]), true)
  assert.equal(macProcessCheckPassed(result('reused-pid-skipped'), [identity]), true)
  for (const state of ['unverified', 'alive', 'unknown']) assert.equal(macProcessCheckPassed(result(state), [identity]), false)
  assert.equal(macProcessCheckPassed({ passed: true, results: [] }, [identity]), false)
  assert.equal(macProcessCheckPassed(result('exited'), [{ ...identity, uniqueId: '235' }]), false)
  assert.equal(macProcessCheckPassed({ passed: false, results: [] }, []), false)
  assert.equal(macProcessCheckPassed({ passed: true, results: [] }, []), true)
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

test('WK view receipts reject wrong helpers, stale page clocks, missing roles and a newly created network process before OS adoption', async () => {
  const { WKAssociationReceipts } = await import('../scripts/computer-wkwebview-soak-evidence.mjs')
  const native = { pid: 101, birthMicros: '1000', uniqueId: '1010', path: '/own/helper' }, nonce = '12345678-1234-1234-1234-123456789abc'
  const start = () => new WKAssociationReceipts({ native, nonce })
  const row = () => ({ schemaVersion: 1, nonce, helper: native, sequence: 1, event: 'association', verified: true, errors: [], windowId: 42,
    page: { nonceVerified: true, visibility: 'visible', iframes: 0, tick: 1 },
    associated: ['WebContent', 'GPU', 'Networking'].map((role, index) => ({ role, identity: { pid: 200 + index, birthMicros: '1100', uniqueId: String(2200 + index), path: '/system/' + role, device: '10', inode: String(300 + index) } })),
    networkFence: { verified: true, existsBefore: true, existsAfter: true, getterBeforeUnixMicros: '1200' } })
  assert.equal(start().accept(row()).length, 3)
  for (const change of [r => { r.helper = { ...native, uniqueId: '1011' } }, r => { r.nonce = 'other' }, r => { r.sequence = 2 }, r => { r.page.iframes = 1 }, r => { r.verified = false }, r => { r.verified = 1 }, r => { r.associated.pop() }, r => { r.associated[2].identity.birthMicros = '1201' }, r => { r.associated[0].identity.uniqueId = '0' }, r => { r.networkFence.existsBefore = false }, r => { r.associated[0].identity.pid = 201 }]) {
    const value = row(); change(value); assert.throws(() => start().accept(value), /WK/)
  }
  const receiver = start(); receiver.accept(row()); assert.throws(() => receiver.accept({ ...row(), sequence: 2 }), /continuously/)
  const next = row(); next.sequence = 2; next.page.tick = 2; assert.equal(receiver.accept(next).length, 3)
})

test('WK rejected getter evidence survives validation failure without acknowledging a resource association', async () => {
  const { WKAssociationReceipts, consumeWKAssociationRows } = await import('../scripts/computer-wkwebview-soak-evidence.mjs')
  const native = { pid: 101, birthMicros: '1000', uniqueId: '1010', path: '/own/helper' }, nonce = '12345678-1234-1234-1234-123456789abc'
  const state = { rows: [], rowsRead: 0, receiver: new WKAssociationReceipts({ native, nonce }) }
  const rejected = { schemaVersion: 1, nonce, helper: native, sequence: 1, event: 'association', verified: false, errors: ['GPU-pid-unverified'] }
  assert.throws(() => consumeWKAssociationRows(state, JSON.stringify(rejected) + '\n'), /resource getters unverified: GPU-pid-unverified/)
  assert.deepEqual(state.rows, [rejected]); assert.equal(state.rowsRead, 1)
  assert.deepEqual(state.receiver.latest, []); assert.equal(state.receiver.samples.length, 0)
  assert.throws(() => consumeWKAssociationRows(state, ''), /sequence/)
})
