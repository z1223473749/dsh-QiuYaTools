import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const source = (await build({ stdin: { contents: 'export {installComputerHost} from "./src/features/computer-use/host.ts";export {ComputerDriverRouter} from "./src/features/computer-use/driver-router.ts";export {installComputerTools} from "./src/features/computer-use/tools.ts";', resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { installComputerHost, ComputerDriverRouter, installComputerTools } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t) {
  const routes = new Map(), calls = []
  const native = () => ({ async status() { return { available: true } }, async targets() { return [] }, async observe() {}, async lease() {}, async release() {}, async act() {}, async openPreview() {}, async closePreview() {}, async dispose() {} })
  const remote = { ...native(), async exchange(request) { calls.push(request); return { enabled: true, maxBytes: 8388608, chunkBytes: 131072, files: [] } } }
  const router = new ComputerDriverRouter({ local: native(), remoteFactory: () => remote })
  let enabled = true
  const principal = { kind: 'owner' }, ctx = { webServer: { port: 1 }, connection: { browserPeer: { principal }, authenticatedUrl: url => url, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }
  const host = await installComputerHost(ctx, () => enabled, { driver: router })
  t.after(() => host.dispose())
  const call = async (op, extra = {}) => {
    const response = await routes.get('/api/qiuya-tools.computer.control').fetch(new Request('http://127.0.0.1/api/qiuya-tools.computer.control', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'qiuya-tools.computer.control', payload: { op, ...extra } }) }))
    return response.status === 200 ? (await response.json()).result : { status: response.status }
  }
  return { remote, router, principal, calls, call, disable: () => { enabled = false } }
}

test('only owner can exchange and only actual remote mode works, independent of chat selection', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('exchange', { request: { action: 'list' } })).error.code, 'EXCHANGE_REMOTE_ONLY')
  await f.router.useRemote({ endpoint: 'http://127.0.0.1', token: 'fixture' })
  f.principal.kind = 'guest'; assert.equal((await f.call('exchange', { request: { action: 'list' } })).status, 403); assert.equal(f.calls.length, 0)
  f.principal.kind = 'owner'; assert.equal((await f.call('exchange', { request: { action: 'list' } })).ok, true)
  assert.equal(f.calls.length, 1)
  f.disable(); assert.equal((await f.call('exchange', { request: { action: 'list' } })).ok, false)
})

test('switching aborts in-flight owner file requests and cannot return a late download', async t => {
  const f = await fixture(t), entered = deferred(), finish = deferred()
  await f.router.useRemote({ endpoint: 'http://127.0.0.1', token: 'fixture' })
  let receivedSignal
  f.remote.exchange = async (_request, signal) => { receivedSignal = signal; entered.resolve(); await finish.promise; return { data: 'cHJpdmF0ZQ==' } }
  const downloading = f.call('exchange', { request: { action: 'read', name: 'file', offset: 0, version: 'version' } })
  await entered.promise
  assert.equal((await f.call('connect', { mode: 'local' })).ok, true)
  assert.equal(receivedSignal.aborted, true)
  finish.resolve(); const result = await downloading
  assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('cHJpdmF0ZQ=='), false)
})

test('disabling cancels an in-flight file response and rejects later file requests', async t => {
  const f = await fixture(t), entered = deferred()
  await f.router.useRemote({ endpoint: 'http://127.0.0.1', token: 'fixture' })
  let observed
  f.remote.exchange = async (_request, signal) => { observed = signal; entered.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }
  const reading = f.call('exchange', { request: { action: 'list' } }); await entered.promise; f.disable()
  let timer
  const result = await Promise.race([reading, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('disable did not cancel file request')), 1500) })]).finally(() => clearTimeout(timer))
  assert.equal(observed.aborted, true); assert.equal(result.ok, false)
  assert.equal((await f.call('exchange', { request: { action: 'list' } })).ok, false)
})

test('128 KiB base64 fits the existing Host request ceiling; excess bodies are rejected', async t => {
  const f = await fixture(t)
  await f.router.useRemote({ endpoint: 'http://127.0.0.1', token: 'fixture' })
  const request = { action: 'chunk', id: 'fixture', offset: 0, data: Buffer.alloc(128 * 1024).toString('base64') }
  assert.equal((await f.call('exchange', { request })).ok, true)
  assert.equal(f.calls[0].data.length, 174764)
  assert.equal((await f.call('exchange', { request: { ...request, data: 'x'.repeat(256000) } })).status, 413)
  assert.equal(f.calls.length, 1)
})

test('registered model tool capabilities remain unchanged and expose no file exchange or host path', async () => {
  const definitions = []
  const dispose = installComputerTools({ tools: { register(definition) { definitions.push(definition); return () => {} } }, attachments: { saveImage() { throw new Error('not invoked') } } }, {})
  try {
    assert.equal(definitions.length, 6)
    assert.equal(definitions.some(definition => /exchange|upload|download|file/i.test(definition.name)), false)
    const action = definitions.find(definition => definition.name === 'qiuya_computer_act')
    assert.equal(Object.keys(action.parameters.properties.action.properties).some(key => /path|file|upload/i.test(key)), false)
    assert.equal(action.parameters.properties.action.properties.kind.enum.some(value => /file|upload|download/i.test(value)), false)
  } finally { dispose() }
})

// This production-shaped fixture uses the per-chat manager rather than the
// explicitly injected legacy driver above. Each reconnect creates a new remote.
async function managedFixture(t) {
  const routes = new Map(), remotes = [], routers = [], principal = { kind: 'owner' }
  const device = () => ({ async status() { return { available: true } }, async targets() { return [] }, async observe() {}, async lease() {}, async release() {}, async act() {}, async openPreview() {}, async closePreview() {}, async dispose() {} })
  const ctx = { webServer: { port: 1 }, connection: { browserPeer: { principal }, authenticatedUrl: url => url, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }
  const host = await installComputerHost(ctx, () => true, { environments: { createRouter(sessionId) {
    routers.push(sessionId)
    return new ComputerDriverRouter({ local: device(), remoteFactory(options) {
      const calls = [], remote = { ...device(), sessionId, endpoint: options.endpoint, calls, async exchange(request, signal) { calls.push({ request, signal }); return { enabled: true, files: [] } } }
      remotes.push(remote); return remote
    } })
  } } })
  t.after(() => host.dispose())
  const call = async (op, sessionId, extra = {}) => {
    const response = await routes.get('/api/qiuya-tools.computer.control').fetch(new Request('http://127.0.0.1/api/qiuya-tools.computer.control', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'scoped-test', method: 'qiuya-tools.computer.control', payload: { op, sessionId, ...extra } }) }))
    return response.status === 200 ? (await response.json()).result : { status: response.status }
  }
  const connect = async (sessionId, suffix = remotes.length) => {
    assert.equal((await call('connect', sessionId, { mode: 'remote', endpoint: `https://synthetic-${suffix}.invalid/v1/computer`, token: 'synthetic-pair-only' })).ok, true)
    const status = (await call('status', sessionId)).value
    return status.environments.find(row => row.sessionId === sessionId).environmentId
  }
  return { call, connect, host, principal, remotes, routers }
}

test('scoped Host exchange requires an exact current environment identity, including for every file action', async t => {
  const f = await managedFixture(t)
  const a = await f.connect('A'), b = await f.connect('B')
  assert.match(a, /^[a-f0-9-]{36}$/u); assert.notEqual(a, b)
  assert.equal((await f.call('status', 'A')).value.environments.find(row => row.sessionId === 'A').environmentId, a, 'read-only status does not rotate connection identity')
  const metadata = JSON.stringify((await f.call('status', 'A')).value.environments)
  assert.equal(/synthetic-|synthetic-pair-only/u.test(metadata), false, 'environment identity does not expose pairing credentials or endpoint')
  for (const action of ['status', 'list', 'begin', 'chunk', 'commit', 'abort', 'read']) {
    const request = { action, name: 'old-private-name.txt' }
    assert.equal((await f.call('exchange', 'A', { request })).error.code, 'CONTROL_CHANGED', `${action} cannot omit its environment identity`)
    assert.equal((await f.call('exchange', 'A', { request, expectedEnvironmentId: b })).error.code, 'CONTROL_CHANGED', `${action} cannot use another chat identity`)
  }
  for (const invalid of [null, false, {}, '', '\u0000', 'x'.repeat(513)]) assert.equal((await f.call('exchange', 'A', { request: { action: 'list' }, expectedEnvironmentId: invalid })).error.code, 'INVALID_REQUEST')
  assert.equal((await f.call('exchange', 'missing', { request: { action: 'list' }, expectedEnvironmentId: a })).error.code, 'CONTROL_CHANGED')
  assert.deepEqual(f.routers, ['A', 'B'], 'a stale exchange must not create a native/router environment')
  assert.ok(f.remotes.every(remote => remote.calls.length === 0))
  assert.equal((await f.call('exchange', 'A', { request: { action: 'list' }, expectedEnvironmentId: a })).ok, true)
  assert.equal(f.remotes[0].calls.length, 1); assert.equal(f.remotes[1].calls.length, 0)
  f.principal.kind = 'guest'
  assert.equal((await f.call('exchange', 'A', { request: { action: 'list' }, expectedEnvironmentId: a })).status, 403)
  assert.equal(f.remotes[0].calls.length, 1)
})

test('a remote reconnect in another window rejects an old post-digest begin before sending its name or bytes to the new device', async t => {
  const f = await managedFixture(t), before = await f.connect('A'), after = await f.connect('A')
  assert.notEqual(before, after, 'a remote-to-remote reconnect rotates the connection identity even for the same chat')
  const privateRequest = { action: 'begin', name: 'private-file-before-pairing-change.txt', size: 14, sha256: '0'.repeat(64) }
  const refused = await f.call('exchange', 'A', { request: privateRequest, expectedEnvironmentId: before })
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'CONTROL_CHANGED')
  assert.equal(f.remotes[0].calls.length, 0); assert.equal(f.remotes[1].calls.length, 0)
  assert.equal((await f.call('exchange', 'A', { request: { action: 'list' }, expectedEnvironmentId: after })).ok, true)
  assert.deepEqual(f.remotes[1].calls.map(row => row.request), [{ action: 'list' }])
})

for (const phase of ['begin', 'read']) test(`a late ${phase} response cannot survive another window reconnect or continue through its replacement driver`, async t => {
  const f = await managedFixture(t), before = await f.connect('A'), entered = deferred(), finish = deferred()
  let observedSignal
  f.remotes[0].exchange = async (request, signal) => { f.remotes[0].calls.push({ request, signal }); observedSignal = signal; entered.resolve(); await finish.promise; return phase === 'begin' ? { id: 'private-old-upload-id' } : { data: 'cHJpdmF0ZS1vbGQtZGV2aWNlLWJ5dGVz' } }
  const pending = f.call('exchange', 'A', { request: { action: phase, name: 'private-old-name.txt' }, expectedEnvironmentId: before })
  await entered.promise
  const after = await f.connect('A'); assert.notEqual(after, before); assert.equal(observedSignal.aborted, true)
  finish.resolve(); const late = await pending
  assert.equal(late.ok, false); assert.equal(late.error.code, 'CONTROL_CHANGED')
  assert.equal(JSON.stringify(late).includes('private-old-upload-id'), false)
  assert.equal(JSON.stringify(late).includes('cHJpdmF0ZS1vbGQtZGV2aWNlLWJ5dGVz'), false)
  for (const action of ['chunk', 'commit', 'abort']) assert.equal((await f.call('exchange', 'A', { request: { action, id: 'private-old-upload-id', data: 'cHJpdmF0ZQ==' }, expectedEnvironmentId: before })).error.code, 'CONTROL_CHANGED')
  assert.equal(f.remotes[1].calls.length, 0, 'no late continuation or cleanup crosses into the replacement remote')
})

test('legacy injected Host drivers refuse scoped or identity-bearing exchange instead of silently ignoring the fence', async t => {
  const f = await fixture(t)
  await f.router.useRemote({ endpoint: 'http://127.0.0.1', token: 'fixture' })
  for (const extra of [{ sessionId: 'A' }, { expectedEnvironmentId: 'unrecognized-environment' }]) {
    const result = await f.call('exchange', { request: { action: 'list' }, ...extra })
    assert.equal(result.ok, false); assert.equal(result.error.code, 'CONTROL_CHANGED')
  }
  assert.equal(f.calls.length, 0)
  assert.equal((await f.call('exchange', { request: { action: 'list' } })).ok, true, 'the original unscoped owner contract remains available')
})

test('production manager preserves unscoped owner exchange while an optional legacy identity still cannot cross into another connection', async t => {
  const f = await managedFixture(t), legacy = await f.connect(undefined), scoped = await f.connect('A')
  assert.equal((await f.call('exchange', undefined, { request: { action: 'list' } })).ok, true)
  assert.equal((await f.call('exchange', undefined, { request: { action: 'list' }, expectedEnvironmentId: legacy })).ok, true)
  assert.equal((await f.call('exchange', undefined, { request: { action: 'list' }, expectedEnvironmentId: scoped })).error.code, 'CONTROL_CHANGED')
  assert.equal(f.remotes[0].calls.length, 2); assert.equal(f.remotes[1].calls.length, 0)
})
