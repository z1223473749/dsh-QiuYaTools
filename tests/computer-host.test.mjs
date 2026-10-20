import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
const result = await build({ entryPoints: [new URL('../src/features/computer-use/host.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' })
const { installComputerHost } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
function fixture({ enabled = true, owner = true } = {}) {
  const routes = new Map(), actions = [], target = { id: 'fixture:1', appId: 'fixture-app', title: 'Fixture', pid: 10, x: 0, y: 0, width: 100, height: 100, scale: 1 }
  let frame = 0
  const driver = {
    status: async () => ({ available: true }), targets: async () => [target], lease: async epoch => actions.push(['lease', epoch]), release: async epoch => actions.push(['release', epoch]),
    observe: async () => ({ targetId: target.id, frameId: String(++frame), imageBase64: 'aW1hZ2U=', mediaType: 'image/jpeg', width: 100, height: 100, elements: '', geometry: target }),
    act: async (...args) => { actions.push(['act', ...args]); return {} }, openPreview: async url => { actions.push(['preview', url]); return {} }, closePreview: async () => {}, dispose: async () => {},
  }
  const ctx = { get: name => name === 'sessions' ? { get: id => id === 'chat-1' ? {} : undefined } : undefined, webServer: { port: 5000 }, connection: {
    browserPeer: { principal: { kind: owner ? 'owner' : 'guest' } }, authenticatedUrl: url => url,
    fetch: { register: route => { routes.set(route.path, route); return async () => { routes.delete(route.path) } } },
  } }
  return { driver, ctx, routes, actions, enabled, async call(op, extra = {}) {
    const request = new Request('http://127.0.0.1:5000/api/qiuya-tools.computer.control', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'qiuya-tools.computer.control', payload: { op, sessionId: 'chat-1', ...extra } }) })
    const response = await routes.get('/api/qiuya-tools.computer.control').fetch(request)
    return response.status === 200 ? (await response.json()).result : { status: response.status }
  } }
}
test('owner route starts only existing chats, frames never act, and human input requires takeover', async () => {
  const f = fixture(), host = await installComputerHost(f.ctx, () => f.enabled, { driver: f.driver })
  try {
    assert.equal((await f.call('start', { targetId: 'fixture:1', sessionId: 'missing' })).ok, false)
    assert.equal((await f.call('start', { targetId: 'fixture:1' })).ok, true)
    let frame = (await f.call('frame')).value
    const act = { actionId: 'human-1', frameId: frame.frameId, action: { kind: 'click', x: 50, y: 50 } }
    assert.equal((await f.call('act', { request: act })).ok, false)
    assert.equal((await f.call('takeover')).ok, true)
    frame = (await f.call('frame')).value
    assert.equal((await f.call('act', { request: { ...act, frameId: frame.frameId } })).ok, true)
    assert.equal(f.actions.filter(a => a[0] === 'act').length, 1)
    assert.equal((await f.call('stop')).ok, true)
    f.enabled = false
    assert.equal((await f.call('targets')).ok, false)
  } finally { await host.dispose() }
  assert.equal(f.routes.size, 0)
})
test('non-owner cannot invoke native controls or read preview', async () => {
  const f = fixture({ owner: false }), host = await installComputerHost(f.ctx, () => true, { driver: f.driver })
  try {
    assert.equal((await f.call('targets')).status, 403)
    const response = await f.routes.get('/api/qiuya-tools.computer.preview').fetch(new Request('http://127.0.0.1/api/qiuya-tools.computer.preview'))
    assert.equal(response.status, 403)
    assert.deepEqual(f.actions, [])
  } finally { await host.dispose() }
})

test('preview GET declares the body mode required by the real Connection bridge', async () => {
  const ctx = new Context(), f = fixture()
  const server = ctx.plugin(child => child.provide('webServer', { port: 19445 }))
  await server.await()
  const connection = ctx.plugin(child => { new HostConnectionService(child, [], { isAuthenticated: () => true }) })
  await connection.await()
  let installer
  const plugin = ctx.plugin(child => {
    installer = child.inject(['connection', 'webServer'], injected => {
      injected.effect(async () => {
        const host = await installComputerHost(injected, () => true, { driver: f.driver })
        return () => host.dispose()
      })
    })
  })
  await plugin.await(); await installer.await()
  try {
    const service = ctx.get('connection'), shared = service.createSharedFetchHandler('/api')
    const url = new URL('http://127.0.0.1:19445/api/qiuya-tools.computer.preview?session=chat-1')
    // The actual SDK returns undefined for an omitted mode and then takes its
    // streaming branch. A streaming body is invalid for WHATWG GET Request.
    assert.equal(shared.requestBodyMode({ method: 'GET', url }), 'buffered')
    const response = await shared.fetch(new Request(url), service.browserPeer)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /id="screen"[\s\S]*id="pause"|id="pause"[\s\S]*id="screen"/u)
  } finally { await plugin.dispose(); await connection.dispose(); await server.dispose() }
})
