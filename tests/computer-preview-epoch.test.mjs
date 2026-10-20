import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/host.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { installComputerHost } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const target = { id: 'fixture', appId: 'fixture-app', title: 'Owned fixture', pid: 1, x: 0, y: 0, width: 10, height: 10, scale: 1 }
async function fixture(t) {
  const routes = new Map(), releases = []
  const driver = { async status() { return { available: true } }, async targets() { return [target] }, async lease() {}, async release(epoch) { releases.push(epoch) }, async observe() { return { targetId: target.id, frameId: 'fixture-frame', imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', elements: '', width: 10, height: 10, geometry: target } }, async dispose() {} }
  const host = await installComputerHost({ connection: { browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: value => value, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } }, webServer: { port: 1 } }, () => true, { driver })
  t.after(() => host.dispose())
  const call = async extra => (await (await routes.get('/api/qiuya-tools.computer.control').fetch(new Request('http://127.0.0.1/api/qiuya-tools.computer.control', { method: 'POST', body: JSON.stringify({ type: 'client-request', method: 'qiuya-tools.computer.control', rpcId: 'fixture', payload: { op: 'pause', sessionId: 'chat', ...extra } }) }))).json()).result
  return { host, driver, releases, call, start: () => host.service.start('chat', target.id, { allowOnce: true }) }
}

test('a delayed automatic pause from an old epoch cannot cancel a fresh connecting session', async t => {
  const f = await fixture(t), old = await f.start()
  await f.host.service.stop('chat')
  let entered, release
  const began = new Promise(done => { entered = done }), barrier = new Promise(done => { release = done })
  f.driver.targets = async () => { entered(); await barrier; return [target] }
  const starting = f.start(); void starting.catch(() => {}); await began
  let deadline
  try {
    const fresh = f.host.service.get('chat'), releasedBefore = f.releases.length
    assert.equal(fresh.state, 'connecting')
    const ignored = await Promise.race([f.call({ expectedEpoch: old.epoch }), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Stale pause blocked on the new acquisition')), 1000) })])
    assert.equal(ignored.ok, true); assert.equal(ignored.value.state, 'connecting'); assert.equal(ignored.value.epoch, fresh.epoch)
    assert.equal(f.releases.length, releasedBefore)
    release(); assert.equal((await starting).state, 'ready')
  } finally { clearTimeout(deadline); release(); await starting.catch(() => {}) }
})

test('matching automatic pause and unconditional manual pause retain their stop semantics; malformed epochs reject', async t => {
  const f = await fixture(t), initial = await f.start()
  for (const expectedEpoch of [0, -1, '1', null, 1.5]) assert.equal((await f.call({ expectedEpoch })).ok, false)
  assert.equal(f.host.service.get('chat').state, 'ready'); assert.equal(f.releases.length, 0)
  assert.equal((await f.call({ expectedEpoch: initial.epoch })).value.state, 'paused')
  await f.host.service.resume('chat')
  assert.equal((await f.call({})).value.state, 'paused')
  assert.equal(f.releases.length, 2)
})
