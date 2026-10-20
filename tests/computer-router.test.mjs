import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const source = (await build({ entryPoints: [new URL('../src/features/computer-use/driver-router.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { ComputerDriverRouter } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function driver(name) {
  const calls = [], listeners = new Set()
  return { calls, async status() { return { available: true, name } }, async targets() { return [] }, async observe() {}, async lease(epoch) { calls.push(['lease', epoch]) }, async release(epoch) { calls.push(['release', epoch]) }, async act(...args) { calls.push(['act', ...args]) }, async openPreview(...args) { calls.push(['preview', ...args]) }, async closePreview() {}, async dispose() { calls.push(['dispose']) }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, emit(event) { listeners.forEach(listener => listener(event)) } }
}

test('status response retains its original backend mode even if a switch completes while awaiting it', async () => {
  const local = driver('local'), remote = driver('remote'), status = deferred()
  local.status = () => status.promise
  const router = new ComputerDriverRouter({ local, remoteFactory: () => remote })
  const reading = router.status()
  await router.useRemote({ endpoint: 'http://127.0.0.1', token: 'fixture-token' })
  status.resolve({ available: true, name: 'local' })
  const old = await reading
  assert.equal(old.mode, 'local'); assert.equal(old.name, 'local')
  assert.equal((await router.status()).mode, 'remote')
  await router.dispose()
})

test('remote input and local preview stay on separate drivers; local capture failure cannot disconnect remote input', async () => {
  const local = driver('local'), remote = driver('remote'), events = []
  const router = new ComputerDriverRouter({ local, remoteFactory: () => remote })
  router.subscribe(event => events.push(event))
  await router.useRemote({ endpoint: 'http://127.0.0.1', token: 'fixture-token' })
  await router.lease(10); await router.act(10, 'guest-target', { kind: 'key', key: 'Enter' })
  await router.openPreview('http://127.0.0.1/preview', 'Fixture', 'chat')
  assert.equal(remote.calls.filter(call => call[0] === 'act').length, 1)
  assert.equal(local.calls.filter(call => call[0] === 'act').length, 0)
  assert.equal(local.calls.filter(call => call[0] === 'preview').length, 1)
  local.emit({ event: 'disconnected' }); assert.equal(events.length, 0)
  local.emit({ event: 'previewClosed', sessionId: 'chat' }); assert.equal(events[0].event, 'previewClosed')
  remote.emit({ event: 'disconnected' }); assert.equal(events[1].event, 'disconnected')
  await router.dispose()
})

test('same browser profile reconnect closes its previous owner first, and launch failure leaves safe local fallback', async () => {
  const local = driver('local'), activeProfiles = new Set(), events = []
  let sequence = 0, fail = false
  const browserFactory = options => {
    const id = ++sequence
    return { profileDir: options.profileDir, options,
      async launch() { events.push(`launch:${id}`); if (activeProfiles.has(options.profileDir)) throw new Error('profile in use'); if (fail) throw new Error('launch failed'); activeProfiles.add(options.profileDir) },
      async open() {}, async list() { return [] }, allowedOrigins() { return options.allowedOrigins }, subscribe() { return () => {} },
      async close() { events.push(`close:${id}`); activeProfiles.delete(options.profileDir) },
    }
  }
  const router = new ComputerDriverRouter({ local, browserFactory }), options = { browser: 'chrome', profileDir: '/fixture/profile', allowedOrigins: ['https://example.com'] }
  await router.useBrowser(options)
  await router.useBrowser({ ...options, allowedOrigins: ['https://other.example'] })
  assert.deepEqual(events.slice(0, 3), ['launch:1', 'close:1', 'launch:2'])
  assert.equal((await router.status()).mode, 'browser')
  fail = true
  await assert.rejects(router.useBrowser(options), /launch failed/)
  assert.equal((await router.status()).mode, 'local')
  assert.equal(activeProfiles.size, 0)
  await router.dispose()
})
