import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/host.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { installComputerHost } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
test('Host removes every exact route even when driver shutdown and one route disposer fail', async () => {
  const routes = new Map(), removed = []
  const ctx = { get() {}, webServer: { port: 5000 }, connection: { browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: url => url, fetch: { register(route) { routes.set(route.path, route); return async () => { removed.push(route.path); routes.delete(route.path); if (removed.length === 1) throw new Error('route cleanup failed') } } } } }
  const driver = { async status() {}, async targets() {}, async observe() {}, async lease() {}, async release() {}, async act() {}, async openPreview() {}, async closePreview() {}, async dispose() { throw new Error('native cleanup failed') } }
  const host = await installComputerHost(ctx, () => true, { driver })
  assert.equal(routes.size, 2)
  await assert.rejects(host.dispose(), /native cleanup failed/)
  assert.equal(removed.length, 2); assert.equal(routes.size, 0)
  await host.dispose(); assert.equal(removed.length, 2)
})
