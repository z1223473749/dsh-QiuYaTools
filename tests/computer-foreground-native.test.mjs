import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const directory = await mkdtemp(join(tmpdir(), 'qiuya-foreground-native-'))
const source = (await build({ stdin: { contents: "export * from './src/features/computer-use/native.ts';export * from './src/features/computer-use/scheduled-driver.ts';export * from './src/features/computer-use/foreground-handoff.ts'", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { NativeCompanionDriver, ScheduledComputerDriver, ComputerInputScheduler, foregroundActionSHA256 } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const helper = fileURLToPath(new URL('./fixtures/computer-foreground-native.mjs', import.meta.url))
const move = { kind: 'move', x: 3, y: 5 }
let serial = 0
test.after(() => rm(directory, { recursive: true, force: true }))
async function fixture({ fault = 'none', gated = false } = {}) {
  const n = ++serial, journal = join(directory, `${n}.jsonl`), gate = join(directory, `${n}.gate`)
  const driver = new NativeCompanionDriver({ executable: process.execPath, args: [helper, journal, gated ? gate : '-', fault], timeoutMs: 10_000 })
  const read = async () => (await readFile(journal, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split('\n').filter(Boolean).map(JSON.parse)
  const wait = async predicate => {
    const deadline = performance.now() + 3000
    while (performance.now() < deadline) { const rows = await read(); if (predicate(rows)) return rows; await delay(5) }
    throw new Error('The exact JSONL foreground fixture checkpoint was not reached')
  }
  return { driver, read, wait, unblock: () => writeFile(gate, 'complete-one-ACK') }
}
const input = { epoch: 1, logicalEpoch: 0, targetId: 'fixture', actionSHA256: foregroundActionSHA256(move), surfaceGeneration: 1 }
test('real JSONL capability binds actual child PID, parent, executable hash and exact private action ticket', async () => {
  const f = await fixture(), scheduler = new ComputerInputScheduler(), driver = new ScheduledComputerDriver(f.driver, 'local-desktop', scheduler)
  try {
    assert.equal((await driver.status()).available, true); assert.ok(f.driver.foregroundHandoff)
    await driver.lease(0); const result = await driver.act(0, 'fixture', move); assert.equal(result.performed, true)
    const rows = await f.read(), prepared = rows.find(row => row.phase === 'prepare-ack'), act = rows.find(row => row.op === 'act')
    assert.equal(rows.filter(row => row.op === 'foregroundPrepare').length, 1)
    assert.equal(rows.filter(row => row.op === 'act').length, 1)
    assert.equal(act.foregroundTicket.ticketId, prepared.ticketId)
    assert.equal(act.foregroundTicket.actionSHA256, foregroundActionSHA256(move))
    assert.equal(act.foregroundTicket.logicalEpoch, 0); assert.equal(act.foregroundTicket.identity.parentPid, process.pid)
    assert.equal(act.foregroundTicket.identity.pid, act.pid)
    assert.equal((await f.driver.status()).pendingTicket, null)
  } finally { await driver.dispose() }
})
test('pause after native prepare but before its JSONL ACK retains exact cancellation ownership and permits a new fresh action', async () => {
  const f = await fixture({ gated: true }), driver = new ScheduledComputerDriver(f.driver, 'local-desktop', new ComputerInputScheduler())
  try {
    await driver.status(); await driver.lease(1)
    const rejected = assert.rejects(driver.act(1, 'fixture', move), { code: 'CONTROL_CHANGED' })
    const preparedRows = await f.wait(rows => rows.some(row => row.phase === 'prepared'))
    const ticketId = preparedRows.find(row => row.phase === 'prepared').ticketId
    await driver.release(1)
    assert.ok(!(await f.read()).some(row => row.op === 'foregroundCancel'), 'No unknown/wide cancel is sent before the ACK reveals the ticket')
    await f.unblock(); await rejected
    let rows = await f.read(), cancels = rows.filter(row => row.op === 'foregroundCancel')
    assert.deepEqual(cancels.map(row => row.ticketId), [ticketId]); assert.ok(cancels.every(row => !row.releaseTokenId))
    assert.equal(rows.filter(row => row.op === 'foregroundPrepare').length, 1)
    assert.equal(rows.filter(row => row.op === 'act' || row.op === 'lease').length, 0)
    assert.equal((await f.driver.status()).pendingTicket, null)
    await driver.lease(2); await driver.act(2, 'fixture', move)
    rows = await f.read(); assert.equal(rows.filter(row => row.op === 'foregroundPrepare').length, 2)
    assert.equal(rows.filter(row => row.op === 'act').length, 1)
    assert.notEqual(rows.filter(row => row.phase === 'prepared')[1].ticketId, ticketId)
  } finally { await f.unblock(); await driver.dispose() }
})
test('a signal already aborted before prepare sends no mutating request', async () => {
  const f = await fixture(), abort = new AbortController()
  try {
    await f.driver.status(); abort.abort(new Error('already cancelled'))
    await assert.rejects(f.driver.foregroundHandoff.prepare(input, abort.signal), /already cancelled/u)
    assert.equal((await f.read()).filter(row => row.op === 'foregroundPrepare').length, 0)
  } finally { await f.driver.dispose() }
})
for (const fault of ['pid', 'parent', 'path', 'image']) test('actual JSONL identity mismatch rejects ' + fault + ' before any physical lease or action', async () => {
  const f = await fixture({ fault }), driver = new ScheduledComputerDriver(f.driver, 'local-desktop', new ComputerInputScheduler())
  try {
    await driver.status(); await assert.rejects(driver.lease(1), { code: 'NATIVE_PROTOCOL' })
    assert.ok(!(await f.read()).some(row => row.op === 'foregroundPrepare' || row.op === 'lease' || row.op === 'act'))
  } finally { await driver.dispose() }
})
test('actual JSONL ticket action mismatch cannot reach physical input', async () => {
  const f = await fixture({ fault: 'ticket-action' }), driver = new ScheduledComputerDriver(f.driver, 'local-desktop', new ComputerInputScheduler())
  try {
    await driver.status(); await driver.lease(1); await assert.rejects(driver.act(1, 'fixture', move), { code: 'NATIVE_PROTOCOL' })
    const rows = await f.read(); assert.ok(!rows.some(row => row.op === 'lease' || row.op === 'act'))
    assert.deepEqual(rows.filter(row => row.op === 'foregroundCancel').map(row => row.ticketId), rows.filter(row => row.phase === 'prepared').map(row => row.ticketId))
    assert.equal((await f.driver.status()).pendingTicket, null)
  } finally { await driver.dispose() }
})
for (const fault of ['legacy', 'mac']) test('actual JSONL ' + fault + ' helper retains its original protocol without foreground handoff calls', async () => {
  const f = await fixture({ fault }), driver = new ScheduledComputerDriver(f.driver, 'local-desktop', new ComputerInputScheduler())
  try {
    await driver.status(); assert.equal(f.driver.foregroundHandoff, undefined)
    await driver.lease(1); await driver.act(1, 'fixture', move)
    const rows = await f.read(); assert.ok(!rows.some(row => row.op.startsWith('foreground')))
    assert.equal(rows.filter(row => row.op === 'act').length, 1)
  } finally { await driver.dispose() }
})
test('an adapter from a naturally disposed child cannot send a ticket request to a replacement worker', async () => {
  const f = await fixture()
  await f.driver.status(); const adapter = f.driver.foregroundHandoff
  await f.driver.dispose(); await assert.rejects(adapter.prepare(input), { code: 'CONTROL_CHANGED' })
  assert.equal((await f.read()).filter(row => row.op === 'foregroundPrepare').length, 0)
})

test('an unidentifiable prepare ACK retires that exact worker without sending a broad cancellation', async () => {
  const f = await fixture({ fault: 'ticket-malformed' }), driver = new ScheduledComputerDriver(f.driver, 'local-desktop', new ComputerInputScheduler())
  try {
    await driver.status(); await driver.lease(1); await assert.rejects(driver.act(1, 'fixture', move), { code: 'NATIVE_PROTOCOL' })
    await f.wait(rows => rows.some(row => row.phase === 'eof'))
    const rows = await f.read(); assert.ok(!rows.some(row => row.op === 'foregroundCancel' || row.op === 'lease' || row.op === 'act'))
    assert.equal(new Set(rows.map(row => row.pid)).size, 1)
  } finally { await driver.dispose() }
})
test('a failed exact ticket cleanup retains the binding error and cleanup error and retires the worker', async () => {
  const f = await fixture({ fault: 'ticket-cancel-failure' }), driver = new ScheduledComputerDriver(f.driver, 'local-desktop', new ComputerInputScheduler())
  try {
    await driver.status(); await driver.lease(1)
    await assert.rejects(driver.act(1, 'fixture', move), error => error.code === 'INPUT_CLEANUP_FAILED' && error.actionError?.code === 'NATIVE_PROTOCOL' && error.cleanupErrors[0]?.code === 'fixture-exact-cancel-failed')
    await f.wait(rows => rows.some(row => row.phase === 'eof'))
    const rows = await f.read(); assert.deepEqual(rows.filter(row => row.op === 'foregroundCancel').map(row => row.ticketId), rows.filter(row => row.phase === 'prepared').map(row => row.ticketId))
    assert.ok(!rows.some(row => row.op === 'lease' || row.op === 'act')); assert.equal(new Set(rows.map(row => row.pid)).size, 1)
  } finally { await driver.dispose() }
})

test('a malformed release ACK with its exact token ID is cancelled before the validation error is returned', async () => {
  const f = await fixture({ fault: 'release-malformed' })
  try {
    await f.driver.status(); await f.driver.lease(1); await f.driver.act(1, 'fixture', move)
    await assert.rejects(f.driver.release(1), { code: 'NATIVE_PROTOCOL' })
    const rows = await f.read(), cancels = rows.filter(row => row.op === 'foregroundCancel')
    assert.equal(cancels.length, 1); assert.match(cancels[0].releaseTokenId, /^[a-f0-9]{32}$/u); assert.equal(cancels[0].ticketId, undefined)
  } finally { await f.driver.dispose() }
})
test('a malformed release ACK without an identifiable token retires the exact child without a broad cancel', async () => {
  const f = await fixture({ fault: 'release-unidentifiable' })
  try {
    await f.driver.status(); await f.driver.lease(1); await f.driver.act(1, 'fixture', move)
    await assert.rejects(f.driver.release(1), { code: 'NATIVE_PROTOCOL' })
    await f.wait(rows => rows.some(row => row.phase === 'eof'))
    const rows = await f.read(); assert.ok(!rows.some(row => row.op === 'foregroundCancel')); assert.equal(new Set(rows.map(row => row.pid)).size, 1)
  } finally { await f.driver.dispose() }
})
