import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { setTimeout as delay } from 'node:timers/promises'

const source = (await build({ entryPoints: [new URL('../src/features/computer-use/remote.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { RemoteComputerDriver, createComputerAgentServer, computerAgentEndpoint } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const token = 'test-pair-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t, options = {}) {
  const input = [], released = [], leased = [], target = { id: 'window-1', appId: 'fixture.app', pid: 10, title: 'Fixture', x: 0, y: 0, width: 100, height: 100, scale: 1 }
  let active = 0, sequence = 0
  const listeners = new Set()
  const driver = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async status() { return { available: true, platform: 'win32' } },
    async targets() { return [target] },
    async observe(targetId) { return { targetId, frameId: `frame-${++sequence}`, imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 100, height: 100, elements: 'button', geometry: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } },
    async lease(epoch) { assert.ok(epoch > Math.max(0, ...leased)); leased.push(epoch); active = epoch },
    async release(epoch) { released.push(epoch); if (active === epoch) active = 0 },
    async act(epoch, targetId, action, signal) { signal.throwIfAborted(); assert.equal(epoch, active); input.push({ epoch, targetId, action }); return { applied: true } },
    async openPreview() { throw new Error('server must not open preview') }, async closePreview() {},
  }
  const agent = await createComputerAgentServer(driver, { token, ...options })
  const clients = []
  const remote = (id, extra = {}) => { const client = new RemoteComputerDriver({ endpoint: agent.endpoint, token, clientId: id, ...extra }); clients.push(client); return client }
  const raw = async (extra = {}, headers = {}) => {
    const response = await fetch(agent.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ version: 1, requestId: 1, clientId: 'raw-owner', op: 'status', payload: {}, ...extra }) })
    return { status: response.status, value: await response.json() }
  }
  t.after(async () => { await Promise.allSettled(clients.map(client => client.dispose())); await agent.close() })
  return { agent, driver, remote, raw, input, leased, released, target, emit: event => { for (const listener of listeners) listener(event) } }
}

test('endpoint policy permits trusted TLS/loopback and requires explicit opt-in for paired private HTTP', () => {
  assert.equal(computerAgentEndpoint('http://127.0.0.1:4000'), 'http://127.0.0.1:4000/v1/computer')
  assert.ok(computerAgentEndpoint('https://agent.example/v1/computer').startsWith('https://'))
  assert.throws(() => computerAgentEndpoint('http://10.211.55.3:4000'), { code: 'UNSAFE_ENDPOINT' })
  assert.ok(computerAgentEndpoint('http://10.211.55.3:4000', true).includes('10.211.55.3'))
  for (const endpoint of ['http://public.example', 'http://8.8.8.8', 'https://user:pass@agent.example', 'https://agent.example?token=secret', 'file:///tmp/agent', 'http://127.0.0.1#secret']) assert.throws(() => computerAgentEndpoint(endpoint, true))
})

test('actual HTTP pairing isolates lease owners and namespaces applications to the configured device', async t => {
  const f = await fixture(t), a = f.remote('owner-a'), b = f.remote('owner-b')
  assert.equal((await a.status()).protocolVersion, 1)
  const targets = await a.targets()
  assert.equal(targets[0].id, f.target.id)
  assert.equal(targets[0].appId, `${a.deviceId}:fixture.app`)
  await a.lease(20)
  await assert.rejects(b.lease(1), { code: 'DEVICE_BUSY' })
  await assert.rejects(b.act(20, f.target.id, { kind: 'key', key: 'Enter' }), { code: 'CONTROL_CHANGED' })
  const frame = await a.observe(f.target.id); assert.equal(frame.targetId, f.target.id)
  await a.act(20, f.target.id, { kind: 'click', x: 5, y: 6 })
  assert.equal(f.input.length, 1)
  await a.release(20)
  await assert.rejects(b.lease(1), { code: 'STALE_EPOCH' }, 'an attempted client epoch cannot be replayed after a failed acquisition')
  await b.lease(2)
  assert.deepEqual(f.leased, [1, 2], 'client epochs map to strictly increasing native epochs')
  await a.release(20)
  await b.act(2, f.target.id, { kind: 'key', key: 'Enter' })
  assert.equal(f.input.length, 2, 'old owner release cannot revoke the new owner')
})

test('wrong token, protocol mismatch, arbitrary operations and browser origins are rejected before native calls', async t => {
  const f = await fixture(t), wrong = f.remote('wrong', { token: `${token}-wrong` })
  await assert.rejects(wrong.status(), { code: 'PAIR_UNAUTHORIZED' })
  assert.equal((await f.raw({ version: 99 })).value.error.code, 'VERSION_MISMATCH')
  assert.equal((await f.raw({ op: 'exec', payload: { cmd: 'anything' } })).value.error.code, 'OP_NOT_ALLOWED')
  assert.equal((await f.raw({}, { Origin: 'https://web.invalid' })).value.error.code, 'ORIGIN_DENIED')
  assert.equal(f.leased.length, 0); assert.equal(f.input.length, 0)
})

test('pair revocation releases active input and invalidates old credentials immediately', async t => {
  const f = await fixture(t), a = f.remote('owner')
  await a.lease(1)
  await f.agent.revoke(`${token}-new`)
  assert.deepEqual(f.released, [1])
  await assert.rejects(a.status(), { code: 'PAIR_UNAUTHORIZED' })
  const newClient = f.remote('new-owner', { token: `${token}-new` })
  assert.notEqual(newClient.deviceId, a.deviceId, 'rotated pairing cannot inherit app approvals')
  await newClient.lease(1)
  assert.deepEqual(f.leased, [1, 2])
})

test('bounded request and response streams reject excess payloads', async t => {
  const f = await fixture(t, { maxRequestBytes: 512, maxResponseBytes: 512 })
  const large = await f.raw({ op: 'act', payload: { epoch: 1, targetId: 'window-1', action: { kind: 'type', text: 'x'.repeat(1000) } } })
  assert.equal(large.status, 413); assert.equal(large.value.error.code, 'REQUEST_LIMIT')
  f.driver.observe = async () => ({ imageBase64: 'x'.repeat(2000) })
  const a = f.remote('owner')
  await assert.rejects(a.observe('window-1'), { code: 'RESPONSE_LIMIT' })
  const tiny = f.remote('tiny', { maxResponseBytes: 32 })
  await assert.rejects(tiny.status(), { code: 'REMOTE_RESPONSE_LIMIT' })
  assert.equal(f.input.length, 0)
})

test('server watchdog fences disconnected clients while heartbeats keep healthy ownership', async t => {
  const f = await fixture(t, { leaseTimeoutMs: 150 }), a = f.remote('live', { heartbeatMs: 35 })
  await a.lease(1)
  await delay(260)
  await a.act(1, 'window-1', { kind: 'key', key: 'Enter' })
  await a.release(1)
  const dormant = f.remote('disconnected', { heartbeatMs: 10_000 })
  await dormant.lease(1)
  const deadline = Date.now() + 1000
  while (f.released.length < 2 && Date.now() < deadline) await delay(20)
  assert.ok(f.released.includes(2), 'server released the native lease without needing client cleanup')
  await assert.rejects(dormant.act(1, 'window-1', { kind: 'key', key: 'Enter' }), { code: 'CONTROL_CHANGED' })
})

test('HTTP action cancellation triggers native release and cannot produce a successful late action', async t => {
  const f = await fixture(t), a = f.remote('owner'), entered = deferred(), cancelled = deferred()
  f.driver.act = async (_epoch, _target, _action, signal) => { entered.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled.resolve(); reject(signal.reason) }, { once: true })) }
  await a.lease(1)
  const abort = new AbortController(), action = a.act(1, 'window-1', { kind: 'key', key: 'Enter' }, abort.signal), rejected = assert.rejects(action)
  await entered.promise; abort.abort(new Error('human takeover')); await rejected
  await Promise.race([cancelled.promise, delay(1000).then(() => { throw new Error('native action was not cancelled') })])
  assert.ok(f.released.includes(1))
})

test('client rejects incompatible remote protocol and never follows credential-carrying redirects', async () => {
  const driver = new RemoteComputerDriver({ endpoint: 'http://127.0.0.1:1', token, fetch: async (_url, options) => { assert.equal(options.redirect, 'error'); return Response.json({ version: 2, requestId: 1, ok: true, result: {} }) } })
  await assert.rejects(driver.status(), { code: 'VERSION_MISMATCH' }); await driver.dispose()
})

test('failed native release remains pending and retry releases the original epoch', async t => {
  const f = await fixture(t), a = f.remote('owner'), original = f.driver.release, attempts = []; let fail = true
  f.driver.release = async epoch => { attempts.push(epoch); if (fail) { fail = false; throw new Error('native release offline') }; return original(epoch) }
  await a.lease(1)
  await assert.rejects(a.release(1), /native release offline/)
  assert.equal((await a.status()).cleanupPending, true)
  await a.release(1)
  assert.deepEqual(attempts, [1, 1]); assert.equal((await a.status()).cleanupPending, false)
})

test('pair rotation denies old credentials immediately and blocks new input until failed cleanup is retried', async t => {
  const f = await fixture(t), a = f.remote('old-owner'), original = f.driver.release; let fail = true
  f.driver.release = async epoch => { if (fail) throw new Error('native cleanup unavailable'); return original(epoch) }
  await a.lease(1)
  await assert.rejects(f.agent.revoke(`${token}-rotated`), /cleanup unavailable/)
  await assert.rejects(a.status(), { code: 'PAIR_UNAUTHORIZED' })
  const b = f.remote('new-owner', { token: `${token}-rotated` })
  await assert.rejects(b.lease(1), /cleanup unavailable/)
  assert.deepEqual(f.leased, [1], 'new native lease cannot replace the uncertain old lease')
  fail = false
  await b.lease(2)
  assert.deepEqual(f.released, [1]); assert.deepEqual(f.leased, [1, 2])
})

test('release waits for an uncertain acquisition and fences it again after its reply arrives', async t => {
  const f = await fixture(t), a = f.remote('owner'), entered = deferred(), finish = deferred(), original = f.driver.lease
  f.driver.lease = async epoch => { entered.resolve(); await finish.promise; return original(epoch) }
  const starting = a.lease(1), rejected = assert.rejects(starting, { code: 'CONTROL_CHANGED' })
  await entered.promise
  let acknowledged = false
  const stopping = a.release(1).then(() => { acknowledged = true })
  await delay(40); assert.equal(acknowledged, false)
  finish.resolve(); await rejected; await stopping
  assert.deepEqual(f.released, [1, 1]); assert.equal((await a.status()).cleanupPending, false)
})

test('watchdog retries failed cleanup without losing the old native epoch', async t => {
  const f = await fixture(t, { leaseTimeoutMs: 120 }), a = f.remote('offline', { heartbeatMs: 10_000 }), original = f.driver.release; let attempts = 0
  f.driver.release = async epoch => { if (++attempts === 1) throw new Error('temporary cleanup failure'); return original(epoch) }
  await a.lease(1)
  const deadline = Date.now() + 1000
  while (!f.released.includes(1) && Date.now() < deadline) await delay(20)
  assert.ok(attempts >= 2); assert.deepEqual(f.released, [1])
})

test('late older lease response cannot replace a newer client heartbeat/disposal epoch', async () => {
  const delayed = deferred(), releases = []; let first
  const remote = new RemoteComputerDriver({ endpoint: 'http://127.0.0.1:1', token, heartbeatMs: 10_000, fetch: async (_url, options) => {
    const input = JSON.parse(options.body)
    if (input.op === 'release') releases.push(input.payload.epoch)
    if (input.op === 'lease' && input.payload.epoch === 11) { first = input; return delayed.promise }
    return Response.json({ version: 1, requestId: input.requestId, ok: true, result: {} })
  } })
  const older = remote.lease(11), rejected = assert.rejects(older, { code: 'CONTROL_CHANGED' })
  await remote.lease(12)
  delayed.resolve(Response.json({ version: 1, requestId: first.requestId, ok: true, result: {} }))
  await rejected; await remote.dispose()
  assert.deepEqual(releases, [11, 12])
})

test('physical intervention in the guest revokes its lease and pauses the paired owner through heartbeat', async t => {
  const f = await fixture(t), a = f.remote('owner', { heartbeatMs: 25 }), events = []
  a.subscribe(event => events.push(event))
  await a.lease(1)
  f.emit({ event: 'humanInput', reason: 'escape' })
  const deadline = Date.now() + 1000
  while (!events.length && Date.now() < deadline) await delay(10)
  assert.deepEqual(events, [{ event: 'humanInput' }])
  assert.ok(f.released.includes(1))
  await assert.rejects(a.act(1, 'window-1', { kind: 'key', key: 'Enter' }), { code: 'HUMAN_INPUT' })
  assert.equal(f.input.length, 0)
  await a.lease(2)
  await a.act(2, 'window-1', { kind: 'key', key: 'Enter' })
  assert.equal(f.input.length, 1, 'explicit fresh lease may resume after physical intervention')
})
