import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { build } from 'esbuild'

const source = (await build({ stdin: { contents: `export {ComputerEnvironmentManager} from './src/features/computer-use/environment-manager.ts';export {ComputerDriverRouter} from './src/features/computer-use/driver-router.ts';export {ScheduledComputerDriver} from './src/features/computer-use/scheduled-driver.ts';export {installComputerHost} from './src/features/computer-use/host.ts';export {installComputerTools} from './src/features/computer-use/tools.ts';export {createComputerAgentServer} from './src/features/computer-use/remote.ts';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-environments-unit-')), bundle = join(temporary, 'runtime.mjs')
await writeFile(bundle, source); after(() => rm(temporary, { recursive: true, force: true }))
const { ComputerEnvironmentManager, ComputerDriverRouter, ScheduledComputerDriver, installComputerHost, installComputerTools, createComputerAgentServer } = await import(pathToFileURL(bundle).href)
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const tick = () => new Promise(done => setImmediate(done))
const bounded = (promise, phase) => new Promise((done, reject) => {
  const timer = setTimeout(() => reject(Error('Synthetic environment test timed out: ' + phase)), 8000)
  Promise.resolve(promise).then(done, reject).finally(() => clearTimeout(timer))
})
const target = { id: 'window', appId: 'fixture.app', title: 'Synthetic fixture', pid: 10, x: 0, y: 0, width: 100, height: 80, scale: 1 }
const geometry = { x: target.x, y: target.y, width: target.width, height: target.height, scale: target.scale }
const request = (frameId, actionId = 'action') => ({ actionId, frameId, action: { kind: 'click', x: 10, y: 10 } })
function device(label) {
  const listeners = new Set(), calls = []; let frame = 0
  return { calls, label, emit(event) { for (const callback of listeners) callback(event) },
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback) },
    async status() { return { available: true, label } }, async targets() { return [target] },
    async observe() { return { targetId: target.id, frameId: `${label}-${++frame}`, imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 100, height: 80, elements: label, geometry } },
    async lease(epoch, _signal, options) { calls.push(['lease', epoch, options?.actor]) }, async release(epoch) { calls.push(['release', epoch]) },
    async act(epoch, _id, _action, signal) { signal?.throwIfAborted(); calls.push(['act', epoch]); return { label } },
    async openPreview(_url, _title, sessionId) { calls.push(['preview', sessionId]); return { opened: true } },
    async closePreview(_signal, options) { calls.push(['closePreview', options]); return { closed: true } }, async dispose() { calls.push(['dispose']) },
  }
}
function fixture(options = {}) {
  const locals = new Map(), remotes = new Map(), browsers = []
  const manager = new ComputerEnvironmentManager({ directory: '/tmp/synthetic-profile', ...options,
    createRouter(id, scheduler) {
      const local = device(id ?? 'legacy'); locals.set(id, local)
      const router = new ComputerDriverRouter({ local: new ScheduledComputerDriver(local, 'same-test-desktop', scheduler),
        remoteFactory(value) { const remote = device('remote-' + (id ?? 'legacy')); remote.exchange = async () => ({ enabled: true }); remotes.set(id, remote); return remote },
        browserFactory(value) { browsers.push({ id, ...value }); return { options: value, profileDir: value.profileDir, async launch() {}, async open() {}, async list() { return [] }, allowedOrigins() { return value.allowedOrigins }, subscribe() { return () => {} }, async close() {} } },
      })
      options.router?.(id, router, local); return router
    },
  })
  return { manager, locals, remotes, browsers }
}

test('two chats remain ready on one desktop; input is FIFO while observation remains concurrent', async t => {
  const f = fixture(); t.after(() => f.manager.dispose())
  await Promise.all(['A', 'B'].map(id => f.manager.start(id, target.id, { allowOnce: true })))
  assert.equal(f.manager.get('A').state, 'ready'); assert.equal(f.manager.get('B').state, 'ready')
  assert.equal([...f.locals.values()].flatMap(value => value.calls).filter(row => row[0] === 'lease').length, 0, 'logical readiness must not take an OS input lease')
  const fa = await f.manager.observe('A'), fb = await f.manager.observe('B'), entered = deferred(), complete = deferred(), order = []
  f.locals.get('A').act = async () => { order.push('A'); entered.resolve(); await complete.promise; return {} }
  f.locals.get('B').act = async () => { order.push('B'); return {} }
  const first = f.manager.act('A', request(fa.frameId)); await entered.promise
  const second = f.manager.act('B', request(fb.frameId)); await tick()
  assert.deepEqual(order, ['A'])
  assert.equal((await f.manager.preview('B')).targetId, target.id, 'preview must not wait for physical input')
  complete.resolve(); await Promise.all([first, second]); assert.deepEqual(order, ['A', 'B'])
  for (const local of f.locals.values()) assert.deepEqual(local.calls.filter(row => ['lease', 'release'].includes(row[0])).map(row => row[0]), ['lease', 'release'])
})

test('switching one chat fences only that chat; unscoped legacy connect cannot cancel another chat', async t => {
  const entered = deferred(), finish = deferred()
  const f = fixture({ router(id, router) { if (id === 'A') router.useRemote = async () => { entered.resolve(); await finish.promise } } }); t.after(() => { finish.resolve(); return f.manager.dispose() })
  await Promise.all(['A', 'B'].map(id => f.manager.start(id, target.id, { allowOnce: true })))
  const switching = f.manager.connect('A', { mode: 'remote', endpoint: 'http://127.0.0.1', token: 'synthetic' }); await entered.promise
  assert.equal(f.manager.isSwitching('A'), true); assert.equal(f.manager.isSwitching('B'), false)
  await assert.rejects(f.manager.start('A', target.id, { allowOnce: true }), { code: 'DISABLED' })
  const fb = await f.manager.observe('B'); await f.manager.act('B', request(fb.frameId))
  const epoch = f.manager.get('B').epoch
  await f.manager.connect(undefined, { mode: 'remote', endpoint: 'http://127.0.0.1', token: 'synthetic' })
  assert.equal(f.manager.get('B').state, 'ready'); assert.equal(f.manager.get('B').epoch, epoch)
  assert.equal((await f.manager.status()).mode, 'remote'); assert.equal((await f.manager.statusFor('B')).mode, 'local')
  finish.resolve(); await switching
})

test('an unconfigured chat starts its own local connection instead of inheriting another pairing', async t => {
  const f = fixture(); t.after(() => f.manager.dispose())
  await f.manager.connect('A', { mode: 'remote', endpoint: 'http://127.0.0.1', token: 'synthetic' })
  await f.manager.connect(undefined, { mode: 'remote', endpoint: 'http://127.0.0.1', token: 'synthetic-default' })
  await f.manager.start('B', target.id, { allowOnce: true })
  assert.equal((await f.manager.statusFor('A')).mode, 'remote'); assert.equal((await f.manager.statusFor('B')).mode, 'local')
  assert.equal(f.remotes.has('B'), false)
})

test('browser profiles are isolated by chat hashes, with neither session paths nor shared credentials', async t => {
  const f = fixture(); t.after(() => f.manager.dispose())
  const options = { mode: 'browser', browser: 'chrome', allowedOrigins: ['https://example.com'] }
  await Promise.all([f.manager.connect('A/../B', options), f.manager.connect('B', options)])
  assert.equal(f.browsers.length, 2); assert.notEqual(f.browsers[0].profileDir, f.browsers[1].profileDir)
  for (const row of f.browsers) {
    assert.equal(basename(row.profileDir), 'chrome')
    assert.match(basename(dirname(row.profileDir)), /^[a-f0-9]{64}$/u)
    assert.equal(dirname(dirname(row.profileDir)), join('/tmp/synthetic-profile', 'browser-profiles'))
  }
})

test('global revocation stops every affected chat before its single serialized permission write settles', async t => {
  const gate = deferred(), writes = []; let hold = false
  const f = fixture({ writeAllowedApps: async apps => { writes.push(apps); if (hold) await gate.promise } }); t.after(() => { gate.resolve(); return f.manager.dispose() })
  await f.manager.setAppAllowed(target.appId, true)
  await Promise.all(['A', 'B'].map(id => f.manager.start(id, target.id)))
  hold = true; const revoking = f.manager.setAppAllowed(target.appId, false)
  assert.deepEqual(f.manager.allowedApps(), [])
  assert.ok(['stopping', 'stopped'].includes(f.manager.get('A').state)); assert.ok(['stopping', 'stopped'].includes(f.manager.get('B').state))
  gate.resolve(); await revoking
  assert.equal(f.manager.get('A').state, 'stopped'); assert.equal(f.manager.get('B').state, 'stopped')
  assert.deepEqual(writes, [[target.appId], []])
})

test('permission writes from different chats serialize; a failed revoke never restores an older grant', async t => {
  const first = deferred(), entered = deferred(), writes = []; let failRevoke = false
  const f = fixture({ writeAllowedApps: async apps => { writes.push(apps); if (writes.length === 1) { entered.resolve(); await first.promise } if (failRevoke && !apps.includes('one')) throw Error('synthetic disk failure') } }); t.after(() => f.manager.dispose())
  const one = f.manager.setAppAllowed('one', true); await entered.promise
  const two = f.manager.setAppAllowed('two', true); assert.equal(writes.length, 1)
  first.resolve(); await Promise.all([one, two]); assert.deepEqual(f.manager.allowedApps(), ['one', 'two'])
  failRevoke = true; await assert.rejects(f.manager.setAppAllowed('one', false), /synthetic disk failure/)
  assert.deepEqual(f.manager.allowedApps(), ['two'])
})

test('redocking preserves the control epoch and a late open ACK cannot override the newer dock intent', async t => {
  const f = fixture(); t.after(() => f.manager.dispose())
  await f.manager.start('A', target.id, { allowOnce: true }); const epoch = f.manager.get('A').epoch, pending = deferred()
  f.locals.get('A').openPreview = async () => pending.promise
  const opening = f.manager.openPreview('A', 'http://127.0.0.1/preview', 'test'); await tick()
  await f.manager.redock('A'); pending.resolve({ opened: true }); await opening
  assert.equal(f.manager.environments()[0].previewDetached, false)
  assert.equal(f.manager.get('A').epoch, epoch); assert.equal(f.manager.get('A').state, 'ready')
  assert.deepEqual(f.locals.get('A').calls.find(row => row[0] === 'closePreview')[1], { preserveSession: true })
  f.locals.get('A').openPreview = async () => ({ opened: true }); await f.manager.openPreview('A', 'http://127.0.0.1/preview', 'test')
  assert.equal(f.manager.environments()[0].previewDetached, true)
  f.locals.get('A').emit({ event: 'previewClosed', sessionId: 'A' }); await tick()
  assert.equal(f.manager.environments()[0].previewDetached, false); assert.equal(f.manager.get('A').state, 'paused')
})

test('idle cleanup retains failed owners and capacity, then retries and preserves epochs on recreation', async t => {
  let now = 1000, fail = true
  const f = fixture({ maxEnvironments: 1, idleMs: 100, now: () => now, router(id, _router, local) { if (id === 'A') local.dispose = async () => { if (fail) throw Error('native not retired') } } }); t.after(() => { fail = false; return f.manager.dispose() })
  await f.manager.start('A', target.id, { allowOnce: true }); await f.manager.stop('A'); const old = f.manager.get('A').epoch
  now += 101; await assert.rejects(f.manager.sweep(), /闲置电脑环境清理未完成/)
  assert.equal(f.manager.environments()[0].retiring, true)
  assert.throws(() => f.manager.start('B', target.id, { allowOnce: true }), { code: 'SESSION_LIMIT' })
  fail = false; await f.manager.sweep(); assert.equal(f.manager.environments().length, 0)
  await f.manager.start('A', target.id, { allowOnce: true }); assert.ok(f.manager.get('A').epoch > old)
})

test('stop and pause of a retired chat are idempotent without creating a driver or disturbing a live chat', async t => {
  let now = 1000, creations = 0
  const f = fixture({ idleMs: 100, now: () => now, router() { creations++ } }); t.after(() => f.manager.dispose())
  await Promise.all(['A', 'B'].map(id => f.manager.start(id, target.id, { allowOnce: true })))
  await f.manager.stop('A'); const stopped = f.manager.get('A'), otherEpoch = f.manager.get('B').epoch
  now += 101; await f.manager.sweep()
  assert.deepEqual(f.manager.environments().map(row => row.sessionId), ['B'])
  const retiredCalls = f.locals.get('A').calls.length
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.manager.stop('A')).state, 'stopped')
    assert.equal((await f.manager.pause('A')).epoch, stopped.epoch)
  }
  assert.equal(creations, 2); assert.equal(f.locals.get('A').calls.length, retiredCalls)
  assert.equal(f.manager.get('B').state, 'ready'); assert.equal(f.manager.get('B').epoch, otherEpoch)
  const frame = await f.manager.observe('B'); await f.manager.act('B', request(frame.frameId))
})

test('stop of a failed retirement cannot report success until cleanup is acknowledged; another chat stays live', async t => {
  let now = 1000, fail = true
  const f = fixture({ idleMs: 100, now: () => now, router(id, _router, local) { if (id === 'A') local.dispose = async () => { if (fail) throw Error('synthetic owned process still alive') } } }); t.after(() => { fail = false; return f.manager.dispose() })
  await Promise.all(['A', 'B'].map(id => f.manager.start(id, target.id, { allowOnce: true })))
  await f.manager.stop('A'); now += 101
  await assert.rejects(f.manager.sweep()); await assert.rejects(f.manager.stop('A'), /电脑环境退役未完成/)
  assert.equal(f.manager.get('B').state, 'ready'); assert.equal(f.manager.environments().find(row => row.sessionId === 'A').retiring, true)
  fail = false; assert.equal((await f.manager.pause('A')).state, 'stopped')
  assert.equal((await f.manager.stop('A')).state, 'stopped')
  assert.deepEqual(f.manager.environments().map(row => row.sessionId), ['B'])
})

test('dispose attempts every environment, reports failure, and a later call retries the retained driver', async () => {
  let fail = true
  const f = fixture({ router(id, _router, local) { if (id === 'A') local.dispose = async () => { local.calls.push(['dispose']); if (fail) throw Error('cleanup still active') } } })
  await Promise.all(['A', 'B'].map(id => f.manager.start(id, target.id, { allowOnce: true })))
  await assert.rejects(f.manager.dispose(), /部分电脑环境未能退出/)
  assert.ok(f.locals.get('A').calls.some(row => row[0] === 'dispose')); assert.ok(f.locals.get('B').calls.some(row => row[0] === 'dispose'))
  assert.equal(f.manager.environments().length, 1, 'failed owner cannot disappear from resource tracking')
  fail = false; await f.manager.dispose(); assert.equal(f.manager.environments().length, 0)
})

test('manager disposal waits for its serialized permission store instead of leaving a late profile write', async () => {
  const entered = deferred(), complete = deferred(), f = fixture({ writeAllowedApps: async () => { entered.resolve(); await complete.promise } })
  const grant = f.manager.setAppAllowed('synthetic.app', true); await entered.promise
  let disposed = false; const disposal = f.manager.dispose().then(() => { disposed = true })
  await tick(); assert.equal(disposed, false)
  complete.resolve(); await Promise.all([grant, disposal]); assert.equal(disposed, true)
})

test('actual paired HTTP drivers serialize one endpoint and allow another endpoint to act concurrently', { timeout: 15000 }, async t => {
  const token = 'synthetic-test-only-' + 'a'.repeat(48), first = device('first-remote'), other = device('other-remote'), entered = deferred(), complete = deferred()
  let firstCount = 0, otherCount = 0
  first.act = async () => { if (++firstCount === 1) { entered.resolve(); await complete.promise } return { applied: true } }
  other.act = async () => { otherCount++; return { applied: true } }
  const server = await createComputerAgentServer(first, { token, host: '127.0.0.1', port: 0 })
  let secondServer, manager
  t.after(async () => { complete.resolve(); try { await manager?.dispose() } finally { await server.close(); await secondServer?.close() } })
  secondServer = await createComputerAgentServer(other, { token, host: '127.0.0.1', port: 0 })
  manager = new ComputerEnvironmentManager()
  for (const id of ['A', 'B', 'C']) {
    await manager.connect(id, { mode: 'remote', endpoint: id === 'C' ? secondServer.endpoint : server.endpoint, token })
    await manager.start(id, target.id, { allowOnce: true })
  }
  assert.equal(first.calls.filter(row => row[0] === 'lease').length, 0)
  const fa = await manager.observe('A'), fb = await manager.observe('B'), fc = await manager.observe('C')
  const a = manager.act('A', request(fa.frameId))
  await bounded(Promise.race([entered.promise, a.then(() => { throw Error('First synthetic action finished before its entry gate') })]), 'first input entry')
  const b = manager.act('B', request(fb.frameId)); void b.catch(() => {}); await tick(); assert.equal(firstCount, 1)
  await bounded(manager.act('C', request(fc.frameId)), 'independent endpoint'); assert.equal(otherCount, 1); assert.equal(firstCount, 1)
  complete.resolve(); await bounded(Promise.all([a, b]), 'shared endpoint drain'); assert.equal(firstCount, 2)
  const events = first.calls.filter(row => ['lease', 'release'].includes(row[0])), leases = events.filter(row => row[0] === 'lease')
  assert.equal(leases.length, 2); assert.ok(leases[1][1] > leases[0][1])
  for (const lease of leases) assert.ok(events.some(row => row[0] === 'release' && row[1] === lease[1]))
  assert.ok(events.findIndex(row => row[0] === 'release' && row[1] === leases[0][1]) < events.indexOf(leases[1]), 'next lease cannot precede acknowledged cleanup of the first owner')
})

test('Host and model tools route only their selected chat while status aggregates environments', async t => {
  const routes = new Map(), locals = new Map(), definitions = new Map()
  const ctx = { get: name => name === 'sessions' ? { get: id => ['A', 'B'].includes(id) ? {} : undefined } : undefined,
    webServer: { port: 5000 }, connection: { browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: url => url, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } },
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } }, attachments: { async saveImage() { return { attachmentId: 'synthetic', mediaType: 'image/jpeg', width: 100, height: 80, bytes: 4 } } },
  }
  const host = await installComputerHost(ctx, () => true, { environments: { createRouter(id, scheduler) { const local = device(id); locals.set(id, local); return new ComputerDriverRouter({ local: new ScheduledComputerDriver(local, 'same-test-desktop', scheduler) }) } } })
  const disposeTools = installComputerTools(ctx, host.service); t.after(async () => { disposeTools(); await host.dispose() })
  const call = async (op, sessionId, extra = {}) => (await (await routes.get('/api/qiuya-tools.computer.control').fetch(new Request('http://127.0.0.1/api/qiuya-tools.computer.control', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'qiuya-tools.computer.control', payload: { op, ...(sessionId ? { sessionId } : {}), ...extra } }) }))).json()).result
  assert.equal((await call('start', 'missing', { targetId: target.id })).ok, false)
  for (const id of ['A', 'B']) assert.equal((await call('start', id, { targetId: target.id })).ok, true)
  const status = (await call('status', 'B')).value
  assert.equal(status.sessions.length, 2); assert.equal(status.native.label, 'B'); assert.equal(status.environments.length, 2)
  const exec = { agent: { id: 'B' }, callId: 'model', signal: new AbortController().signal }
  const observed = await definitions.get('qiuya_computer_observe').execute({}, exec)
  assert.equal(observed.elements, 'B'); assert.match(observed.frameId, /^B-/u)
  await definitions.get('qiuya_computer_pause').execute({}, exec)
  assert.equal(host.service.get('A').state, 'ready'); assert.equal(host.service.get('B').state, 'paused')
  await call('preview', 'A'); const before = host.service.get('A').epoch
  assert.equal((await call('redock', 'A')).ok, true); assert.equal(host.service.get('A').epoch, before)
})

test('discovery and permission preflight work before a task without reading windows or leasing input', async t => {
  const f = fixture({ router(_id, _router, local) {
    local.status = async () => ({ available: true, platform: 'darwin', permissions: { screenRecording: false, accessibility: false } })
    local.targets = async () => { throw Error('Window contents must stay unavailable before permission') }
    local.applications = async () => [{ appId: 'fixture.app', name: '测试应用', running: false, launchable: true }]
    local.openSystemSettings = async kind => { local.calls.push(['settings', kind]); return { opened: true, kind } }
  } }); t.after(() => f.manager.dispose())
  assert.equal((await f.manager.status()).permissions.screenRecording, false)
  assert.deepEqual(await f.manager.applicationsFor('chat'), [{ appId: 'fixture.app', name: '测试应用', running: false, launchable: true }])
  assert.deepEqual(f.manager.list(), [])
  assert.equal([...f.locals.values()].flatMap(local => local.calls).length, 0)
  assert.deepEqual(await f.manager.openSystemSettings('accessibility'), { opened: true, kind: 'accessibility' })
  assert.throws(() => f.manager.openSystemSettings('file:///arbitrary'), { code: 'INVALID_PERMISSION' })
})

test('authorization generations isolate chats and legacy connections while owner controls cancel pending grants', async t => {
  const f = fixture(); t.after(() => f.manager.dispose())
  await Promise.all(['A', 'B'].map(id => f.manager.authorizationStatus(id)))
  const a = f.manager.authorizationGeneration('A'), b = f.manager.authorizationGeneration('B')
  await f.manager.connect(undefined, { mode: 'local' })
  assert.equal(f.manager.authorizationGeneration('A'), a); assert.equal(f.manager.authorizationGeneration('B'), b)
  f.locals.get('A').emit({ event: 'humanInput' })
  assert.notEqual(f.manager.authorizationGeneration('A'), a); assert.equal(f.manager.authorizationGeneration('B'), b)
  await assert.rejects(f.manager.authorizationStart('A', target.id, { allowOnce: true, expectedGeneration: a, expectedTarget: target }), { code: 'CONTROL_CHANGED' })
  await f.manager.authorizationStart('B', target.id, { allowOnce: true, expectedGeneration: b, expectedTarget: target })
  await f.manager.pause('B')
  assert.notEqual(f.manager.authorizationGeneration('B'), b)
  await assert.rejects(f.manager.authorizationStart('B', target.id, { allowOnce: true, expectedGeneration: f.manager.authorizationGeneration('B'), expectedTarget: target }), { code: 'OWNER_RESUME_REQUIRED' })
})

test('owner-approved application switch cleans the old task and keeps the exact grant generation', async t => {
  const next = { ...target, id: 'second-window', appId: 'second.app' }
  const f = fixture({ router(_id, _router, local) { local.targets = async () => [target, next] } }); t.after(() => f.manager.dispose())
  const generation = f.manager.authorizationGeneration('A')
  await f.manager.authorizationStart('A', target.id, { allowOnce: true, expectedGeneration: generation, expectedTarget: target })
  const before = f.manager.get('A').epoch
  await f.manager.authorizationStart('A', next.id, { allowOnce: true, expectedGeneration: generation, expectedTarget: next })
  assert.equal(f.manager.get('A').target.appId, 'second.app'); assert.ok(f.manager.get('A').epoch > before)
  assert.equal(f.manager.authorizationGeneration('A'), generation)
  await f.manager.setAppAllowed('second.app', false)
  assert.notEqual(f.manager.authorizationGeneration('A'), generation)
  assert.equal(f.manager.get('A').state, 'stopped')
})

test('a target switch waiting for discovery cannot start after an owner stop', async t => {
  const gate = deferred(), entered = deferred()
  const f = fixture({ router(_id, _router, local) { local.targets = async () => { entered.resolve(); await gate.promise; return [target] } } }); t.after(() => { gate.resolve(); return f.manager.dispose() })
  const generation = f.manager.authorizationGeneration('A')
  const starting = f.manager.authorizationStart('A', target.id, { allowOnce: true, expectedGeneration: generation, expectedTarget: target })
  const rejected = assert.rejects(starting)
  await entered.promise; const stopping = f.manager.stop('A'); gate.resolve(); await Promise.all([stopping, rejected])
  assert.equal(f.manager.get('A').state, 'stopped')
  assert.equal(f.locals.get('A').calls.filter(row => ['lease', 'act'].includes(row[0])).length, 0)
})

test('a one-time approval pins application and process through the final start enumeration', async t => {
  const changed = { ...target, appId: 'unapproved.app', pid: 20 }
  const f = fixture({ router(_id, _router, local) { local.targets = async () => [changed] } }); t.after(() => f.manager.dispose())
  await assert.rejects(f.manager.authorizationStart('A', target.id, { allowOnce: true, expectedGeneration: f.manager.authorizationGeneration('A'), expectedTarget: target }), { code: 'TARGET_CHANGED' })
  assert.equal(f.manager.get('A').state, 'faulted'); assert.equal(f.manager.get('A').target, null)
  assert.equal(f.locals.get('A').calls.some(row => ['lease', 'act'].includes(row[0])), false)
})

test('idle chat status never creates a native environment, while explicit preflight does', async t => {
  const f = fixture(); t.after(() => f.manager.dispose())
  for (let i = 0; i < 40; i++) assert.equal(await f.manager.statusIfPresentFor('unrequested-' + i), null)
  assert.equal(f.locals.size, 0)
  await f.manager.authorizationStatus(); assert.equal(f.locals.size, 1)
  await f.manager.authorizationStatus('requested'); assert.equal(f.locals.size, 2)
  await f.manager.statusIfPresentFor('requested'); assert.equal(f.locals.size, 2)
  assert.deepEqual(f.manager.list(), [])
})

test('pending authorization protects only its own idle environment until the request ends', async t => {
  let now = 0
  const f = fixture({ now: () => now, idleMs: 60_000 }); t.after(() => f.manager.dispose())
  await f.manager.authorizationStatus('awaiting-owner'); await f.manager.authorizationStatus('unprotected')
  now = 119_000; await f.manager.sweep(['awaiting-owner'])
  assert.deepEqual(f.manager.environments().map(row => row.sessionId), ['awaiting-owner'])
  assert.equal(f.locals.get('awaiting-owner').calls.some(row => row[0] === 'dispose'), false)
  await f.manager.sweep([]); assert.deepEqual(f.manager.environments(), [])
  assert.equal(f.locals.get('awaiting-owner').calls.filter(row => row[0] === 'dispose').length, 1)
})

test('owner stop cancels application activation still queued behind another chat input', async t => {
  const gate = deferred(), entered = deferred(); let launches = 0
  const f = fixture({ router(_id, _router, local) { local.launchApplication = async () => { launches++; return {} } } }); t.after(() => { gate.resolve(); return f.manager.dispose() })
  await f.manager.start('A', target.id, { allowOnce: true }); const frame = await f.manager.observe('A')
  f.locals.get('A').act = async () => { entered.resolve(); await gate.promise; return {} }
  const acting = f.manager.act('A', request(frame.frameId)); await entered.promise
  const launching = f.manager.launchApplicationFor('B', 'fixture.app'), rejected = assert.rejects(launching, { code: 'CONTROL_CHANGED' })
  await assert.rejects(Promise.resolve().then(() => f.manager.stop('B')), { code: 'SESSION_NOT_STARTED' })
  await rejected; assert.equal(launches, 0)
  gate.resolve(); await acting
})
