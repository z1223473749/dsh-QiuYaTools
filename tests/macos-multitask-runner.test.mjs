import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

// Importing the GUI runner would execute it. Exercise its actual read-only
// gates in isolation; no native helper, GUI or input is launched by these tests.
const source = await readFile(new URL('../scripts/test-macos-multitask-manager.mjs', import.meta.url), 'utf8')
function extract(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first)
  assert.ok(first > 0 && last > first)
  return source.slice(first, last)
}
const settleSource = extract('async function settledCapture(', '\nasync function pin(')
const retireSource = extract('async function retireObserverAfterAudit(', '\nasync function fixtureState(')
const waitSource = extract('async function waitExit(', '\nasync function retireObserverAfterAudit(')
const owner = { pid: 55, startSeconds: '100', startMicroseconds: '3', uniqueId: 'own', executablePath: '/own/fixture' }
const target = { id: 'mac-window:88', pid: 55, appId: 'own.fixture', x: 100, y: -1200, width: 640, height: 492, scale: 1 }
const fixturePoint = { x: 420, y: -954 }
const same = (a, b) => !!a && !!b && ['pid', 'startSeconds', 'startMicroseconds', 'executablePath'].every(field => a[field] === b[field])

function geometry(mode) {
  let clock = 0, snapshots = 0, reads = 0
  const operations = [], geometrySettles = [], fixture = { identity: owner, target }, fixtures = new Map([['chat-B', fixture]])
  const context = {
    assert, fixtures, geometrySettles, setTimeout, clearTimeout, same,
    performance: { now: () => clock }, sleep: async ms => { clock += ms },
    observer: { async ok(op) { operations.push(op); return { identity: { ...owner, ...(mode === 'reused' ? { startMicroseconds: '4' } : {}) } } } },
    os: async () => { operations.push('snapshot'); snapshots++; return { foregroundPid: 99, windows: mode === 'transition' && snapshots === 1 ? [] : [{ ...target, id: 88, onScreen: true, alpha: 1 }] } },
    manager: { async targetsFor() { operations.push('targets'); return [{ ...target, ...(mode === 'different-app' ? { appId: 'other.fixture' } : {}) }] } },
    capture: async () => {
      operations.push('observe'); reads++
      if (mode === 'timeout') throw Object.assign(new Error('capture timeout'), { code: 'CAPTURE_TIMEOUT' })
      const geometry = mode === 'mismatch' ? { ...target, width: 630 } : reads % 2 ? { scale: 1, height: 492, width: 640, y: -1200, x: 100 } : { x: 100, y: -1200, width: 640, height: 492, scale: 1 }
      return { targetId: target.id, frameId: `frame-${reads}`, width: 1280, height: 984, geometry }
    },
    fixtureState: async () => ({ pid: 55, windowId: 88, bundleId: 'own.fixture', point: fixturePoint, visible: true }),
    point: (value, frame) => ({ x: (value.settledPoint.x - frame.geometry.x) * frame.width / frame.geometry.width, y: (value.settledPoint.y - frame.geometry.y) * frame.height / frame.geometry.height }),
  }
  return { run: () => vm.runInNewContext(`(${settleSource})`, context)('chat-B', 'before-input'), operations, geometrySettles, fixture, reads: () => reads, clock: () => clock }
}

test('default-manager GUI runner waits for exact stable CG/native geometry without activating its background chat', async () => {
  const state = geometry('transition'), frame = await state.run(), evidence = state.geometrySettles[0]
  assert.equal(frame.frameId, `frame-${state.reads()}`)
  assert.ok(evidence.stableMs >= 200 && evidence.agreeingSamples >= 3)
  assert.deepEqual(state.fixture.settledPoint, fixturePoint)
  assert.equal(evidence.point.x, 640); assert.equal(evidence.point.y, 492)
  assert.equal(evidence.samples[0].window, null)
  assert.ok(state.operations.every(op => ['identity', 'snapshot', 'targets', 'observe'].includes(op)))
})

test('default-manager GUI runner rejects identity drift, unmatched geometry and unknown read failures before any action', async () => {
  for (const [mode, pattern] of [['reused', /identity changed/u], ['different-app', /target identity changed/u], ['mismatch', /did not become continuously stable/u], ['timeout', /CAPTURE_TIMEOUT/u]]) {
    const state = geometry(mode)
    await assert.rejects(state.run(), pattern)
    assert.ok(state.operations.every(op => ['identity', 'snapshot', 'targets', 'observe'].includes(op)))
    if (mode === 'timeout') assert.equal(state.reads(), 1, 'Unknown capture failure is not silently replayed')
    if (mode === 'mismatch') assert.ok(state.clock() <= 8025)
  }
})

async function cleanupCase(mode) {
  const cleanup = { errors: [], forced: [], exits: [] }, operations = [], child = { pid: 55, exitCode: null, signalCode: null, stdin: { end: () => operations.push('EOF') }, kill: () => operations.push('KILL') }
  let waits = 0
  const value = { child, label: 'observer', identity: owner, async ok() { operations.push('audit'); if (mode === 'audit-failure') throw Error('audit unavailable'); return { leftButtonDown: mode === 'held', rightButtonDown: false, middleButtonDown: false, keysDown: [] } } }
  const context = { assert, cleanup, same, empty: state => !state.leftButtonDown && !state.rightButtonDown && !state.middleButtonDown && state.keysDown.length === 0,
    waitExit: async () => { operations.push('wait'); if (mode === 'eof-timeout' && waits++ === 0) throw Error('EOF timeout'); child.exitCode = 0; return { code: 0, signal: null } },
    fallbackIdentity: async () => mode === 'eof-timeout' && !operations.includes('KILL') ? owner : null,
    until: async read => assert.ok(await read()),
  }
  await vm.runInNewContext(`(${retireSource})`, context)(value)
  return { cleanup, operations }
}

test('default-manager observer still retires by EOF when held-input audit fails or throws', async () => {
  for (const mode of ['held', 'audit-failure']) {
    const { cleanup, operations } = await cleanupCase(mode)
    assert.deepEqual(operations, ['audit', 'EOF', 'wait'])
    assert.equal(cleanup.observerNaturalExit, true); assert.equal(cleanup.observerEofAttempted, true)
    assert.equal(cleanup.errors.length, 1); assert.equal(cleanup.forced.length, 0)
  }
})

test('default-manager observer fallback kill requires failed bounded EOF rather than only a failed input audit', async () => {
  const { cleanup, operations } = await cleanupCase('eof-timeout')
  assert.deepEqual(operations, ['audit', 'EOF', 'wait', 'KILL', 'wait'])
  assert.deepEqual(cleanup.forced, ['observer']); assert.equal(cleanup.errors.length, 1)
})

test('default-manager native child retirement wait is bounded when exit acknowledgement never arrives', async () => {
  const wait = vm.runInNewContext(`(${waitSource})`, { setTimeout, clearTimeout, Promise, Error })
  await assert.rejects(wait({ exited: new Promise(() => {}), label: 'native-chat-B' }, 5), /native-chat-B exit timeout/u)
})
