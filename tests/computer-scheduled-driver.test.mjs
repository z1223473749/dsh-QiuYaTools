import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
const source = (await build({ stdin: { contents: "export * from './src/features/computer-use/scheduled-driver.ts';export * from './src/features/computer-use/session.ts'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { ComputerInputScheduler, ScheduledComputerDriver, ComputerSessionService } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(done => setImmediate(done))
function fixture(name, scheduler, surface = 'local-desktop') {
  const records = [], target = { id: name, pid: 1, appId: 'fixture', title: name, x: 0, y: 0, width: 100, height: 100, scale: 1 }
  let frame = 0, current
  const inner = {
    async status() { return { available: true } }, async targets() { return [target] },
    async observe() { return { targetId: name, frameId: name + ++frame, mediaType: 'image/jpeg', imageBase64: '/9j/2Q==', width: 100, height: 100, elements: '', geometry: target } },
    async lease(epoch, signal, options) { signal?.throwIfAborted(); assert.equal(current, undefined); current = epoch; records.push(['lease', epoch, options.actor]) },
    async release(epoch) { records.push(['release', epoch]); if (current === epoch) current = undefined },
    async act(epoch, targetId, action, signal) { signal?.throwIfAborted(); assert.equal(current, epoch); records.push(['act', epoch, targetId]); return { applied: true } },
    async openPreview() {}, async closePreview(_signal, options) { records.push(['closePreview', options]) },
    async dispose() { records.push(['dispose']) },
  }
  const driver = new ScheduledComputerDriver(inner, surface, scheduler)
  return { driver, inner, target, records }
}
test('two chats remain ready and observe independently while actual local input runs FIFO', async () => {
  const scheduler = new ComputerInputScheduler(), a = fixture('a', scheduler), b = fixture('b', scheduler), order = [], held = deferred()
  const sa = new ComputerSessionService(a.driver), sb = new ComputerSessionService(b.driver)
  await sa.start('a', 'a', { allowOnce: true }); await sb.start('b', 'b', { allowOnce: true })
  assert.equal(sa.get('a').state, 'ready'); assert.equal(sb.get('b').state, 'ready')
  assert.deepEqual(a.records, []); assert.deepEqual(b.records, [])
  const fa = await sa.observe('a'), fb = await sb.observe('b'), originalA = a.inner.act, originalB = b.inner.act
  a.inner.act = async (...args) => { order.push('a-start'); await held.promise; const r = await originalA(...args); order.push('a-end'); return r }
  b.inner.act = async (...args) => { order.push('b-start'); return originalB(...args) }
  const pa = sa.act('a', { actionId: 'a1', frameId: fa.frameId, action: { kind: 'move', x: 1, y: 1 } })
  const pb = sb.act('b', { actionId: 'b1', frameId: fb.frameId, action: { kind: 'move', x: 1, y: 1 } })
  await tick(); assert.deepEqual(order, ['a-start']); held.resolve(); await Promise.all([pa, pb])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start'])
  await Promise.all([sa.dispose(), sb.dispose()])
})
test('independent computer surfaces execute concurrently', async () => {
  const s = new ComputerInputScheduler(), a = fixture('a', s, 'vm-a'), b = fixture('b', s, 'vm-b'), gate = deferred(), entered = []
  for (const f of [a, b]) { await f.driver.lease(1); f.inner.act = async () => { entered.push(f.target.id); await gate.promise; return {} } }
  const pa = a.driver.act(1, 'a', { kind: 'move' }), pb = b.driver.act(1, 'b', { kind: 'move' })
  await tick(); assert.deepEqual(entered.sort(), ['a', 'b']); gate.resolve(); await Promise.all([pa, pb])
  await Promise.all([a.driver.dispose(), b.driver.dispose()])
})
test('pausing a queued chat removes its input without waiting or replaying it', async () => {
  const s = new ComputerInputScheduler(), a = fixture('a', s), b = fixture('b', s), gate = deferred()
  await a.driver.lease(1); await b.driver.lease(1); a.inner.act = () => gate.promise
  const pa = a.driver.act(1, 'a', { kind: 'move' }); await tick()
  const pb = b.driver.act(1, 'b', { kind: 'move' }); const rejected = assert.rejects(pb, { code: 'CONTROL_CHANGED' })
  await b.driver.release(1); await rejected; assert.deepEqual(b.records, [])
  gate.resolve({}); await pa; await Promise.all([a.driver.dispose(), b.driver.dispose()])
})
test('uncertain acquisition is released without executing an action, and native epochs increase', async () => {
  const f = fixture('a', new ComputerInputScheduler()), original = f.inner.lease
  f.inner.lease = async (...args) => { await original(...args); throw new Error('lost lease reply') }
  await f.driver.lease(7)
  await assert.rejects(f.driver.act(7, 'a', { kind: 'move' }), /lost lease reply/)
  assert.deepEqual(f.records, [['lease', 1, 'ai'], ['release', 1]])
  f.inner.lease = original; await f.driver.act(7, 'a', { kind: 'move' })
  assert.deepEqual(f.records.slice(2), [['lease', 2, 'ai'], ['act', 2, 'a'], ['release', 2]])
  await f.driver.dispose()
})
test('failed physical cleanup remains retryable while action is never replayed', async () => {
  const f = fixture('a', new ComputerInputScheduler()), original = f.inner.release
  let releaseAttempts = 0
  f.inner.release = async epoch => { if (++releaseAttempts === 1) throw new Error('release unconfirmed'); return original(epoch) }
  await f.driver.lease(1)
  await assert.rejects(f.driver.act(1, 'a', { kind: 'move' }), /release unconfirmed/)
  await f.driver.release(1)
  assert.equal(releaseAttempts, 2); assert.equal(f.records.filter(row => row[0] === 'act').length, 1)
  await f.driver.dispose()
})
test('human actor is retained per logical lease and an old release cannot cancel its successor', async () => {
  const f = fixture('a', new ComputerInputScheduler())
  await f.driver.lease(1); await f.driver.release(1); await f.driver.lease(2, undefined, { actor: 'human' })
  await f.driver.release(1); await f.driver.act(2, 'a', { kind: 'move' })
  assert.equal(f.records[0][2], 'human')
  await f.driver.closePreview(undefined, { preserveSession: true })
  assert.deepEqual(f.records.at(-1), ['closePreview', { preserveSession: true }]); await f.driver.dispose()
})

test('failed disposal retains a closed input fence but permits explicit cleanup retry', async () => {
  const f = fixture('a', new ComputerInputScheduler()); let attempts = 0
  f.inner.dispose = async () => { if (++attempts === 1) throw new Error('native cleanup not yet confirmed') }
  await f.driver.lease(1)
  await assert.rejects(f.driver.dispose(), /not yet confirmed/)
  await assert.rejects(f.driver.lease(2), { code: 'DISPOSED' })
  await f.driver.dispose(); assert.equal(attempts, 2)
})

test('application activation waits for physical input and is dispatched once without an input lease', async () => {
  const scheduler = new ComputerInputScheduler(), a = fixture('a', scheduler), b = fixture('b', scheduler), gate = deferred(), order = []
  a.inner.act = async () => { order.push('typing'); await gate.promise; order.push('typed'); return {} }
  b.inner.launchApplication = async id => { order.push('launch:' + id); return { launched: true } }
  await a.driver.lease(1)
  const action = a.driver.act(1, 'a', { kind: 'type', text: 'owned text' }); await tick()
  const launch = b.driver.launchApplication('appB'); await tick(); assert.deepEqual(order, ['typing'])
  gate.resolve(); await Promise.all([action, launch]); assert.deepEqual(order, ['typing', 'typed', 'launch:appB'])
  assert.equal(b.records.some(row => row[0] === 'lease'), false)
  await Promise.all([a.driver.dispose(), b.driver.dispose()])
})

test('disposing a queued application launch removes it before activation without replay', async () => {
  const scheduler = new ComputerInputScheduler(), a = fixture('a', scheduler), b = fixture('b', scheduler), gate = deferred()
  let launched = 0
  a.inner.act = () => gate.promise; b.inner.launchApplication = async () => { launched++ }
  await a.driver.lease(1); const action = a.driver.act(1, 'a', { kind: 'drag' }); await tick()
  const launch = b.driver.launchApplication('appB'), rejected = assert.rejects(launch, { code: 'DISPOSED' })
  await b.driver.dispose(); await rejected; assert.equal(launched, 0)
  gate.resolve({}); await action; await a.driver.dispose()
})
