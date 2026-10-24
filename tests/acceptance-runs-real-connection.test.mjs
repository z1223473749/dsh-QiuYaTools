import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const directory = await mkdtemp(join(tmpdir(), 'qiuya-h1-real-connection-test-'))
after(() => rm(directory, { recursive: true, force: true }))
const root = fileURLToPath(new URL('../', import.meta.url)), built = await build({ stdin: { resolveDir: root, contents: "export { installComputerAcceptanceRuns } from './src/features/acceptance-runs/integration.ts'; export { installAcceptanceRunHost } from './src/features/acceptance-runs/host.ts'" }, bundle: true, write: false, platform: 'node', format: 'esm' })
const modulePath = join(directory, 'module.mjs'); await writeFile(modulePath, built.outputFiles[0].text)
const { installComputerAcceptanceRuns, installAcceptanceRunHost } = await import(pathToFileURL(modulePath).href)
const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
async function fixture({ hostOnly = false } = {}) {
  const ctx = new Context(), profile = await realpath(await mkdtemp(join(directory, 'profile-'))), providers = [], state = { queries: 0, observationsDisposed: 0, reads: 0, beforeQuery: undefined, beforeRead: undefined }, definitions = new Map()
  let connection, connectionOwner, active, injection
  const provider = ctx.plugin(child => { connectionOwner = child; connection = new HostConnectionService(child, [], { isAuthenticated() { throw Error('No HTTP authentication is used by this in-memory SDK test') } }) }); await provider.await(); providers.push(provider)
  const services = {
    profileContext: { dir: profile }, agents: { get() { return undefined }, roots() { return [] } },
    sessionQuery: { async observeSession(id, options) { assert.equal(options.projectionMode, 'none'); state.queries++; await state.beforeQuery?.(); return { header: { id }, [Symbol.dispose]() { state.observationsDisposed++ } } } },
    attachments: { async readImage() { throw Error('No attachment should be read by empty history') } },
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } },
  }
  for (const [name, value] of Object.entries(services)) { const child = ctx.plugin(scope => scope.provide(name, value)); await child.await(); providers.push(child) }
  const binding = ctx.plugin(child => { injection = child.inject(['connection', ...Object.keys(services)], value => { active = value }) }); await binding.await(); await injection.await()
  const reader = { async list(scope) { scope.assertCurrent(); state.reads++; await state.beforeRead?.(); scope.assertCurrent(); return [] } }
  const installed = hostOnly ? { dispose: installAcceptanceRunHost(active, reader, { resolveScope(chatSessionId, signal) { return { chatSessionId, signal, assertCurrent() {} } }, async readEvidence() { throw Error('No evidence') } }) } : installComputerAcceptanceRuns(active, { runEnvironment() { return undefined } }, { enabled: () => true, version: 'real-sdk-owner-test' })
  const handler = ctx.get('connection').createSharedFetchHandler('/api')
  const execute = async (op = 'list', extra = {}) => { const response = await handler.fetch(new Request('http://isolated.test/api/qiuya-tools.runs.read', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'qiuya-tools.runs.read', payload: { op, chatSessionId: 'finished-own-chat', ...extra } }) }), connection.browserPeer); return response.json() }
  return { ctx, connection, connectionOwner, active, state, definitions, execute, handler, async dispose() { await installed.dispose(); await binding.dispose(); for (const child of providers.reverse()) await child.dispose() } }
}
test('actual Cordis HostConnectionService returns fresh wrappers for one exact underlying public service', async () => { const f = await fixture({ hostOnly: true }); try { const first = f.active.get('connection'), second = f.active.get('connection'); assert.notEqual(first, second); assert.equal(first[symbols.original], f.connection); assert.equal(second[symbols.original], f.connection); assert.equal(first.browserPeer, second.browserPeer); assert.equal(first.browserPeer.principal, second.browserPeer.principal) } finally { await f.dispose() } })
test('owner Host route accepts unchanged actual HostConnectionService despite fresh trace wrappers', async () => { const f = await fixture({ hostOnly: true }); try { const result = await f.execute(); assert.equal(result.result.ok, true, JSON.stringify(result.result)); assert.deepEqual(result.result.value, []); assert.equal(f.state.reads, 1) } finally { await f.dispose() } })
test('actual full H1 install can read finished-chat history without an active model Agent', async () => { const f = await fixture(); try { const result = await f.execute(); assert.equal(result.result.ok, true, JSON.stringify(result.result)); assert.deepEqual(result.result.value, []); assert.equal(f.state.queries, 1); assert.equal(f.state.observationsDisposed, 1); assert.ok(f.definitions.size > 0) } finally { await f.dispose() } })
test('another actual Service sharing the same peer/principal cannot replace the captured connection', async () => { const f = await fixture({ hostOnly: true }); let other; try { class ReplacementConnection extends Service { constructor(ctx) { super(ctx, 'alternateConnection'); this.browserPeer = f.connection.browserPeer; this.fetch = f.connection.fetch } } const provider = f.ctx.plugin(child => { other = new ReplacementConnection(child) }); await provider.await(); try { f.connectionOwner.set('connection', other); const result = await f.execute(); assert.equal(result.result.ok, false); assert.equal(result.result.error.code, 'OWNER_CHANGED'); assert.equal(f.state.reads, 0) } finally { f.connectionOwner.set('connection', f.connection); await provider.dispose() } } finally { await f.dispose() } })
for (const change of ['peer', 'principal', 'kind']) test('actual Service retains exact ' + change + ' identity fencing during reader await', async () => { const f = await fixture({ hostOnly: true }), held = deferred(); try { f.state.beforeRead = () => held.promise; const pending = f.execute(); await turn(); assert.equal(f.state.reads, 1); if (change === 'peer') f.connection.browserPeer = { principal: { kind: 'owner' } }; if (change === 'principal') f.connection.browserPeer.principal = { kind: 'owner' }; if (change === 'kind') f.connection.browserPeer.principal.kind = 'api'; held.resolve(); const result = await pending; assert.equal(result.result.ok, false); assert.equal(result.result.error.code, 'OWNER_CHANGED'); assert.equal(result.result.value, undefined) } finally { held.resolve(); await f.dispose() } })
