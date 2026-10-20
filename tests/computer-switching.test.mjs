import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const source = (await build({ stdin: { contents: 'export { installComputerHost } from "./src/features/computer-use/host.ts";export { ComputerDriverRouter } from "./src/features/computer-use/driver-router.ts";', resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'computer-switching-fixture.ts' }, bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { installComputerHost, ComputerDriverRouter } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('backend switching fences owner starts and Agent actions before awaiting connection and blocks concurrent switches', async () => {
  const entered = deferred(), connected = deferred(), actions = [], routes = new Map()
  const target = { id: 'window-1', appId: 'fixture', title: 'Fixture', pid: 10, x: 0, y: 0, width: 100, height: 100, scale: 1 }
  const local = { async status() { return { available: true } }, async targets() { return [target] }, async lease(epoch) { actions.push(['lease', epoch]) }, async release(epoch) { actions.push(['release', epoch]) }, async observe() { return { targetId: target.id, frameId: 'frame', imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 100, height: 100, elements: '', geometry: target } }, async act() { actions.push(['input']) }, async openPreview() {}, async closePreview() {}, async dispose() {} }
  class SlowRouter extends ComputerDriverRouter {
    async useRemote() { entered.resolve(); await connected.promise }
  }
  const router = new SlowRouter({ local })
  const ctx = { get: name => name === 'sessions' ? { get: id => id === 'chat' ? {} : undefined } : undefined, webServer: { port: 5000 }, connection: { browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: url => url, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }
  const host = await installComputerHost(ctx, () => true, { driver: router })
  let requestId = 0
  const call = async (op, extra = {}) => {
    const response = await routes.get('/api/qiuya-tools.computer.control').fetch(new Request('http://127.0.0.1:5000/api/qiuya-tools.computer.control', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: String(++requestId), method: 'qiuya-tools.computer.control', payload: { sessionId: 'chat', op, ...extra } }) }))
    return (await response.json()).result
  }
  try {
    assert.equal((await call('start', { targetId: target.id })).ok, true)
    const frame = await host.service.observe('chat')
    const switching = call('connect', { mode: 'remote', endpoint: 'http://127.0.0.1:1234', token: 'fixture-token' })
    await entered.promise
    assert.equal(host.service.get('chat').state, 'stopped')
    assert.equal((await call('start', { targetId: target.id })).ok, false)
    await assert.rejects(host.service.start('chat', target.id, { allowOnce: true }), { code: 'DISABLED' })
    assert.throws(() => host.service.act('chat', { actionId: 'late-agent', frameId: frame.frameId, action: { kind: 'key', key: 'Enter' } }), { code: 'DISABLED' })
    assert.equal((await call('connect', { mode: 'local' })).ok, false)
    const status = await call('status'); assert.equal(status.value.switching, true); assert.equal(status.value.native.available, false)
    connected.resolve(); assert.equal((await switching).ok, true)
    assert.equal((await call('start', { targetId: target.id })).ok, true)
    assert.equal(actions.filter(action => action[0] === 'input').length, 0)
  } finally { connected.resolve(); await host.dispose() }
})
