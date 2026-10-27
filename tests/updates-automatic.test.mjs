import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const compiled = await build({ entryPoints: ['src/client/update-notice.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22' })
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, setTimeout, clearTimeout })
const { UpdateNoticeStore, installAutomaticUpdateChecks, UPDATE_CHECK_INTERVAL, UPDATE_RETRY_INTERVAL } = module.exports
const latest = { status: 'available', currentVersion: '0.6.2', canInstall: true, release: { version: '0.6.3', title: 'Update', tag: 'v0.6.3', notes: '', publishedAt: '', url: 'https://github.com/example/tools/releases/tag/v0.6.3' } }
const pause = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(t, handler, initial = { status: 'ready', value: {} }, extra = {}) {
  let timestamp = 10_000, preferences = initial, nextId = 0
  const calls = [], timers = new Map(), listeners = new Set()
  const ctx = { connection: { rpc: { async call(channel, endpoint, payload) { calls.push({ channel, endpoint, payload: structuredClone(payload) }); return handler(calls.length) } } } }
  const store = new UpdateNoticeStore(ctx, () => timestamp)
  const form = { getSnapshot: () => preferences, subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback) } }
  const options = { store, now: () => timestamp, setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: timestamp + delay }); return id }, clearTimeout(id) { timers.delete(id) }, ...extra }
  const stop = installAutomaticUpdateChecks(ctx, form, options)
  t.after(stop)
  return { store, calls, timers, stop, listeners, restart() { const stopAgain = installAutomaticUpdateChecks(ctx, form, options); t.after(stopAgain); return stopAgain }, change(value) { preferences = value; for (const listener of listeners) listener() },
    async advance(ms) { timestamp += ms; const due = [...timers].filter(([, timer]) => timer.at <= timestamp); for (const [id, timer] of due) { timers.delete(id); timer.callback() } await pause() },
  }
}

test('startup checks are fresh, share a simultaneous manual check, wait a day, and never request installation', async t => {
  const pending = deferred()
  const f = fixture(t, count => count === 1 ? pending.promise : { ok: true, value: latest })
  assert.equal(f.calls.length, 0, 'startup schedules work outside the render/installation path')
  await f.advance(0)
  const manual = f.store.check(true)
  const repeatedManual = f.store.check(true)
  assert.equal(manual, repeatedManual)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0], { channel: '/api', endpoint: 'qiuya-tools.updates.check', payload: { force: true } })
  pending.resolve({ ok: true, value: latest }); await manual; await pause()
  assert.equal(f.store.getSnapshot().notice.version, '0.6.3')
  assert.equal(f.calls.length, 1, 'an explicit check can share a background request that is already fresh')
  await f.advance(UPDATE_CHECK_INTERVAL - 1); assert.equal(f.calls.length, 1)
  await f.advance(1); assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].payload.force, true, 'a due daily check must reach GitHub')
  assert(f.calls.every(row => row.endpoint === 'qiuya-tools.updates.check'))
  await f.store.check(true)
  assert.equal(f.calls.length, 3)
  assert.equal(f.calls[2].payload.force, true, 'explicit checks bypass Host automatic cache')
})

test('manual checks behind a cached background request queue exactly one fresh check', async t => {
  const pending = deferred()
  const f = fixture(t, count => count === 1 ? pending.promise : { ok: true, value: latest }, { status: 'ready', value: { autoCheckUpdates: false } })
  const automatic = f.store.check(false, { background: true, accept: () => false })
  const manual = f.store.check(true)
  assert.notEqual(manual, automatic)
  assert.equal(f.store.check(true), manual)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].payload.force, false)
  pending.resolve({ ok: true, value: latest })
  assert.equal(await automatic, null, 'the old automatic generation still cannot accept its receipt')
  await manual
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].payload.force, true)
  assert.equal(f.store.getSnapshot().notice.version, '0.6.3')
})

test('a ready connection checks once on startup even with a future daily deadline in the retained store', async t => {
  const f = fixture(t, () => ({ ok: true, value: latest }), undefined, { disposeStore: false })
  await f.advance(0)
  const deadline = f.store.getSnapshot().nextAutomaticCheck
  assert.equal(deadline, 10_000 + UPDATE_CHECK_INTERVAL)
  f.stop()
  f.restart()
  for (let i = 0; i < 4; i++) f.change({ status: 'ready', value: {} })
  await f.advance(0)
  assert.equal(f.calls.length, 2, 'the new connection must not wait for the retained deadline')
  assert.equal(f.calls[1].payload.force, true)
  for (let i = 0; i < 4; i++) f.change({ status: 'ready', value: {} })
  await f.advance(0)
  assert.equal(f.calls.length, 2, 'repeated ready notifications do not repeat the startup request')
  assert.equal(f.timers.size, 1)
  await f.advance(UPDATE_CHECK_INTERVAL - 1)
  assert.equal(f.calls.length, 2)
  await f.advance(1)
  assert.equal(f.calls.length, 3)
  f.store.dispose()
})

test('failed transport and error results retry hourly without reporting up-to-date or erasing a known release', async t => {
  const f = fixture(t, count => count === 1 ? { ok: true, value: latest } : count === 2 ? Promise.reject(Error('private token/path')) : { ok: true, value: { status: 'error', currentVersion: '0.6.2', canInstall: false, problem: { code: 'network', message: 'Network unavailable' } } })
  await f.advance(0)
  await f.store.check(true)
  assert.match(f.store.getSnapshot().error, /更新服务暂时无法连接/)
  assert.equal(JSON.stringify(f.store.getSnapshot()).includes('private token'), false)
  assert.equal(f.store.getSnapshot().notice.version, '0.6.3')
  await f.advance(UPDATE_RETRY_INTERVAL - 1); assert.equal(f.calls.length, 2)
  await f.advance(1); assert.equal(f.calls.length, 3)
  assert.equal(f.calls[2].payload.force, true, 'hourly retries must bypass a prior successful Host cache')
  assert.equal(f.store.getSnapshot().result.status, 'error')
  assert.equal(f.store.getSnapshot().notice.version, '0.6.3')
})

test('explicitly disabled and loading profiles make no request; disabling in flight rejects its late result', async t => {
  const pending = deferred(), f = fixture(t, () => pending.promise, { status: 'loading' })
  await f.advance(UPDATE_CHECK_INTERVAL); assert.equal(f.calls.length, 0)
  f.change({ status: 'ready', value: { autoCheckUpdates: false } }); await f.advance(UPDATE_CHECK_INTERVAL); assert.equal(f.calls.length, 0)
  f.change({ status: 'ready', value: {} }); await f.advance(0); assert.equal(f.calls.length, 1)
  f.change({ status: 'ready', value: { autoCheckUpdates: false } })
  pending.resolve({ ok: true, value: latest }); await pause()
  assert.equal(f.store.getSnapshot().notice, null)
  assert.equal(f.store.getSnapshot().result, null)
  assert.equal(f.store.getSnapshot().nextAutomaticCheck, null)
  assert.equal(f.timers.size, 0)
})

test('forced background errors and failures are discarded after automatic checks are disabled', async t => {
  for (const mode of ['error-result', 'transport-error']) await t.test(mode, async t => {
    const pending = deferred()
    const f = fixture(t, () => pending.promise)
    await f.advance(0)
    assert.equal(f.calls[0].payload.force, true)
    f.change({ status: 'ready', value: { autoCheckUpdates: false } })
    if (mode === 'transport-error') pending.reject(Error('private connection info'))
    else pending.resolve({ ok: true, value: { status: 'error', currentVersion: '0.6.2', canInstall: false, problem: { code: 'network', message: 'Network unavailable' } } })
    await pause()
    assert.equal(f.store.getSnapshot().result, null)
    assert.equal(f.store.getSnapshot().error, null)
    assert.equal(f.store.getSnapshot().nextAutomaticCheck, null)
    assert.equal(f.timers.size, 0)
  })
})

test('an explicit user check sharing a fresh startup request may accept the receipt after disabling automation', async t => {
  const pending = deferred()
  const f = fixture(t, () => pending.promise)
  await f.advance(0)
  const manual = f.store.check(true)
  f.change({ status: 'ready', value: { autoCheckUpdates: false } })
  pending.resolve({ ok: true, value: latest })
  assert.equal((await manual).release.version, '0.6.3')
  assert.equal(f.calls.length, 1)
  assert.equal(f.store.getSnapshot().notice.version, '0.6.3')
  assert.equal(f.timers.size, 0)
})

test('disabling and re-enabling in flight rejects the old generation then checks afresh once', async t => {
  const pending = deferred()
  const f = fixture(t, count => count === 1 ? pending.promise : { ok: true, value: latest })
  await f.advance(0)
  f.change({ status: 'ready', value: { autoCheckUpdates: false } })
  f.change({ status: 'ready', value: {} })
  await f.advance(0)
  assert.equal(f.calls.length, 1, 'the old operation stays deduplicated until it settles')
  pending.resolve({ ok: true, value: latest })
  await pause()
  assert.equal(f.store.getSnapshot().notice, null)
  await f.advance(0)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].payload.force, true)
  assert.equal(f.store.getSnapshot().notice.version, '0.6.3')
})

test('unloading clears subscriptions and timers and ignores an in-flight receipt', async t => {
  const pending = deferred(), f = fixture(t, () => pending.promise)
  await f.advance(0); const before = f.store.getSnapshot(); f.stop()
  assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0)
  pending.resolve({ ok: true, value: latest }); await pause()
  assert.equal(f.store.getSnapshot(), before)
  await f.advance(UPDATE_CHECK_INTERVAL); assert.equal(f.calls.length, 1)
})

test('successful up-to-date checks clear badges and explicit installs change them to restart-required', async t => {
  const f = fixture(t, count => ({ ok: true, value: count === 1 ? latest : { status: 'up-to-date', currentVersion: '0.6.3', canInstall: false } }))
  await f.advance(0)
  f.store.recordInstall({ status: 'restart-required', currentVersion: '0.6.2', version: '0.6.3' })
  assert.equal(f.store.getSnapshot().notice.restart, true)
  assert.equal(f.store.getSnapshot().result.canInstall, false)
  await f.store.check(true)
  assert.equal(f.store.getSnapshot().notice, null)
})

test('a restarted connection retains its root store while rejecting the old automatic receipt', async t => {
  const pending = deferred()
  const f = fixture(t, count => count === 1 ? pending.promise : { ok: true, value: latest }, undefined, { disposeStore: false })
  await f.advance(0); f.stop()
  f.restart(); await f.advance(0)
  assert.equal(f.calls.length, 1, 'the new scheduler waits for the abandoned request instead of sharing its old generation')
  pending.resolve({ ok: true, value: latest }); await pause()
  assert.equal(f.store.getSnapshot().notice, null)
  await f.advance(0)
  assert.equal(f.calls.length, 2)
  assert.equal(f.store.getSnapshot().notice.version, '0.6.3')
  f.store.dispose()
})

test('independent client roots never share update receipts or preference state', async t => {
  const a = fixture(t, () => ({ ok: true, value: latest }))
  const b = fixture(t, () => ({ ok: true, value: { status: 'up-to-date', currentVersion: '0.6.3', canInstall: false } }), { status: 'ready', value: { autoCheckUpdates: false } })
  await a.advance(0); await b.advance(0)
  assert.equal(a.store.getSnapshot().notice.version, '0.6.3')
  assert.equal(b.store.getSnapshot().notice, null); assert.equal(b.calls.length, 0)
  await b.store.check(true)
  assert.equal(b.store.getSnapshot().result.status, 'up-to-date')
  assert.equal(a.store.getSnapshot().notice.version, '0.6.3')
})
