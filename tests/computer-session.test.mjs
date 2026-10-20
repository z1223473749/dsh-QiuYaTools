import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const source = (await build({ entryPoints: [new URL('../src/features/computer-use/session.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { ComputerSessionService } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture() {
  const geometry = { x: -200, y: 30, width: 200, height: 100, scale: 2 }
  const target = { ...geometry, id: 'window:1', appId: 'fixture.app', pid: 123, title: 'Fixture' }
  const records = [], listeners = new Set()
  let frame = 0, lease = 0
  const driver = {
    async status() { return { available: true } },
    async targets() { return [{ ...target }] },
    async observe(targetId) { return { targetId, frameId: `f${++frame}`, imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 400, height: 200, elements: 'fixture', geometry: { x: target.x, y: target.y, width: target.width, height: target.height, scale: target.scale } } },
    async lease(epoch) { assert.ok(epoch > lease); lease = epoch; records.push(['lease', epoch]) },
    async release(epoch) { records.push(['release', epoch]); if (epoch === lease) lease = 0 },
    async act(epoch, targetId, action, signal) { signal?.throwIfAborted(); assert.equal(epoch, lease); records.push(['input', epoch, targetId, action]); return { applied: true } },
    async openPreview() {}, async closePreview() {},
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    emit(event) { listeners.forEach(listener => listener(event)) },
  }
  const service = new ComputerSessionService(driver)
  return { driver, service, records, target }
}
async function start(f) { await f.service.start('chat', f.target.id, { allowOnce: true }); return f.service.observe('chat') }
const request = (frame, id = 'a1', action = { kind: 'click', x: 30, y: 40 }) => ({ frameId: frame.frameId, actionId: id, action })

test('owner authorization and one-desktop lease isolate chats; snapshot contains no image bytes', async () => {
  const f = fixture()
  await assert.rejects(f.service.start('chat', f.target.id), { code: 'APP_NOT_ALLOWED' })
  assert.equal(f.records.some(row => row[0] === 'lease'), false)
  await f.service.setAppAllowed(f.target.appId, true)
  await f.service.start('chat', f.target.id)
  await assert.rejects(f.service.start('other', f.target.id, { allowOnce: true }), { code: 'DEVICE_BUSY' })
  const observed = await f.service.observe('chat')
  assert.equal(f.service.get('chat').lastObservation.frameId, observed.frameId)
  assert.equal(JSON.stringify(f.service.list()).includes('imageBase64'), false)
  const snapshot = f.service.get('chat'); snapshot.target.pid = 999
  assert.equal(f.service.get('chat').target.pid, 123)
  await f.service.dispose()
})

test('action id dedup executes exactly once and forbids reuse with a changed body', async () => {
  const f = fixture(), frame = await start(f)
  const a = f.service.act('chat', request(frame)), b = f.service.act('chat', request(frame))
  assert.deepEqual(await a, await b)
  assert.equal(f.records.filter(row => row[0] === 'input').length, 1)
  assert.throws(() => f.service.act('chat', request(frame, 'a1', { kind: 'key', key: 'Enter' })), { code: 'ACTION_ID_CONFLICT' })
  assert.throws(() => f.service.act('chat', request(frame, 'new')), { code: 'STALE_OBSERVATION' })
  await f.service.dispose()
})

test('preview frames do not invalidate Agent observations; changed geometry prevents input', async () => {
  const f = fixture(), frame = await start(f)
  await f.service.preview('chat'); await f.service.preview('chat')
  await f.service.act('chat', request(frame))
  const second = await f.service.observe('chat')
  f.target.x += 1
  await assert.rejects(f.service.act('chat', request(second, 'moved')), { code: 'STALE_OBSERVATION' })
  assert.equal(f.records.filter(row => row[0] === 'input').length, 1)
  assert.equal(f.service.get('chat').state, 'paused')
  await f.service.dispose()
})

test('pause fences an action awaiting target lookup and ACK follows input release', async () => {
  const f = fixture(), frame = await start(f), entered = deferred(), lookup = deferred()
  f.driver.targets = async () => { entered.resolve(); return lookup.promise }
  const action = f.service.act('chat', request(frame))
  // Install rejection observation immediately, avoiding a test-created unhandled rejection.
  const rejected = assert.rejects(action, error => ['CONTROL_CHANGED', 'ABORTED'].includes(error.code))
  await entered.promise
  const pausing = f.service.pause('chat')
  assert.equal(f.service.get('chat').state, 'pausing')
  lookup.resolve([{ ...f.target }])
  await rejected; await pausing
  assert.equal(f.records.filter(row => row[0] === 'input').length, 0)
  assert.equal(f.service.get('chat').state, 'paused')
  assert.equal(f.records.at(-1)[0], 'release')
  await f.service.dispose()
})

test('takeover rejects Agent input, allows preview human input, then resumes with fresh observation and epoch', async () => {
  const f = fixture(), oldFrame = await start(f), oldEpoch = f.service.get('chat').epoch
  await f.service.takeover('chat')
  assert.throws(() => f.service.act('chat', request(oldFrame)), { code: 'CONTROL_CHANGED' })
  const humanFrame = await f.service.preview('chat')
  await f.service.humanAct('chat', request(humanFrame, 'human'))
  assert.equal(f.service.get('chat').state, 'humanControl')
  await f.service.resume('chat')
  assert.ok(f.service.get('chat').epoch > oldEpoch)
  assert.notEqual(f.service.get('chat').lastObservation.frameId, oldFrame.frameId)
  assert.throws(() => f.service.act('chat', request(oldFrame, 'old-frame')), { code: 'STALE_OBSERVATION' })
  await f.service.dispose()
})

test('caller cancellation stops the native lease and does not return ready while input may continue', async () => {
  const f = fixture(), frame = await start(f), entered = deferred(), abort = new AbortController()
  f.driver.act = async (_epoch, _targetId, _action, signal) => { entered.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }
  const action = f.service.act('chat', request(frame), abort.signal)
  const rejected = assert.rejects(action)
  await entered.promise; abort.abort(new Error('caller cancelled')); await rejected
  assert.equal(f.service.get('chat').state, 'paused')
  assert.equal(f.records.at(-1)[0], 'release')
  await f.service.dispose()
})

test('revocation stops existing sessions; preview close pauses; stale releases cannot revive old epochs', async () => {
  const f = fixture()
  await f.service.setAppAllowed(f.target.appId, true); await f.service.start('chat', f.target.id)
  f.driver.emit({ event: 'previewClosed', sessionId: 'chat' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.service.get('chat').state, 'paused')
  await f.service.resume('chat')
  await f.service.setAppAllowed(f.target.appId, false)
  assert.equal(f.service.get('chat').state, 'stopped')
  await assert.rejects(f.service.start('chat', f.target.id), { code: 'APP_NOT_ALLOWED' })
  await f.service.dispose()
})

test('out of bounds and malformed actions never reach native input', async () => {
  const f = fixture(), frame = await start(f)
  for (const action of [{ kind: 'click', x: 400, y: 1 }, { kind: 'drag', x: 10, y: 20, toX: -1, toY: 2 }, { kind: 'click', x: NaN, y: 1 }, { kind: 'type', text: 'safe', shell: 'bad' }, { kind: 'key', key: '\0' }]) assert.throws(() => f.service.act('chat', request(frame, 'bad', action)))
  assert.equal(f.records.filter(row => row[0] === 'input').length, 0)
  await f.service.dispose()
})

test('stop during start prevents a late native lease', async () => {
  const f = fixture(), entered = deferred(), lookup = deferred()
  f.driver.targets = async () => { entered.resolve(); return lookup.promise }
  const starting = f.service.start('chat', f.target.id, { allowOnce: true })
  const rejected = assert.rejects(starting)
  await entered.promise
  const stopping = f.service.stop('chat')
  lookup.resolve([{ ...f.target }]); await rejected; await stopping
  assert.equal(f.service.get('chat').state, 'stopped')
  assert.equal(f.records.some(row => row[0] === 'lease'), false)
  await f.service.dispose()
})

test('disabled service rejects new input immediately but still permits stop cleanup', async () => {
  const f = fixture(); let enabled = true
  const service = new ComputerSessionService(f.driver, { enabled: () => enabled })
  await service.start('chat', f.target.id, { allowOnce: true })
  const frame = await service.observe('chat')
  enabled = false
  assert.throws(() => service.act('chat', request(frame)), { code: 'DISABLED' })
  await assert.rejects(service.preview('chat'), { code: 'DISABLED' })
  assert.equal((await service.stop('chat')).state, 'stopped')
  await service.dispose(); await f.service.dispose()
})

test('failed permission persistence never silently grants and failed revoke still fences current process', async () => {
  const f = fixture(); let stored = [], fail = true
  const service = new ComputerSessionService(f.driver, { readAllowedApps: () => stored, writeAllowedApps: ids => { if (fail) throw new Error('disk failed'); stored = ids } })
  await assert.rejects(service.setAppAllowed(f.target.appId, true), /disk failed/)
  await assert.rejects(service.start('chat', f.target.id), { code: 'APP_NOT_ALLOWED' })
  fail = false; await service.setAppAllowed(f.target.appId, true); await service.start('chat', f.target.id)
  fail = true; await assert.rejects(service.setAppAllowed(f.target.appId, false), /disk failed/)
  assert.equal(service.get('chat').state, 'stopped')
  assert.equal(service.allowedApps().includes(f.target.appId), false)
  await assert.rejects(service.start('chat', f.target.id), { code: 'APP_NOT_ALLOWED' })
  await service.dispose(); await f.service.dispose()
})

test('a recycled window id cannot expose a different application through preview or resume', async () => {
  const f = fixture(); await start(f)
  const observe = f.driver.observe; let captured = 0
  f.driver.observe = async (...args) => { captured++; return observe(...args) }
  f.target.pid = 456; f.target.appId = 'unapproved.app'
  await assert.rejects(f.service.preview('chat'), { code: 'TARGET_CHANGED' })
  await f.service.pause('chat')
  await assert.rejects(f.service.resume('chat'), { code: 'TARGET_CHANGED' })
  assert.equal(captured, 0)
  await f.service.dispose()
})

test('human clicks accept a recently displayed frame despite the next preview, but reject expired or geometrically stale frames', async () => {
  const f = fixture(); let now = 1000
  const service = new ComputerSessionService(f.driver, { now: () => now })
  await service.start('chat', f.target.id, { allowOnce: true }); await service.takeover('chat')
  const shown = await service.preview('chat')
  await service.preview('chat')
  await service.humanAct('chat', request(shown, 'human-recent'))
  assert.equal(f.records.filter(row => row[0] === 'input').length, 1)
  const expired = await service.preview('chat'); now += 2001
  assert.throws(() => service.humanAct('chat', request(expired, 'human-expired')), { code: 'STALE_OBSERVATION' })
  const stale = await service.preview('chat'); f.target.x += 10
  await assert.rejects(service.humanAct('chat', request(stale, 'human-moved')), { code: 'STALE_OBSERVATION' })
  assert.equal(f.records.filter(row => row[0] === 'input').length, 1)
  await service.dispose(); await f.service.dispose()
})
