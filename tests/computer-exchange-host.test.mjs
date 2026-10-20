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
