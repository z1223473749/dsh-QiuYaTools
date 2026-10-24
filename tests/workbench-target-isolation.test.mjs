import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// Optional offline review dependency anchor; the normal project run resolves its own public packages.
const anchor = process.env.QIUYA_H2_REVIEW_DEPENDENCY_ANCHOR ?? fileURLToPath(new URL('../package.json', import.meta.url))
const require = createRequire(anchor), { build } = require('esbuild')
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { ToolRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)
const root = fileURLToPath(new URL('../', import.meta.url))
const built = await build({ stdin: { resolveDir: root, contents: "export * from './src/features/workbench/model-target.ts';export * from './src/features/workbench/desktop-registry.ts';export * from './src/features/workbench/browser-registry.ts';export * from './src/features/workbench/site-permissions.ts';export * from './src/features/workbench/integration.ts';export {ComputerEnvironmentManager} from './src/features/computer-use/environment-manager.ts';export {ComputerDriverRouter} from './src/features/computer-use/driver-router.ts';export {BrowserDeviceDriver} from './src/features/computer-use/browser.ts';export {createComputerRunBridge} from './src/features/acceptance-runs/integration.ts';export {WORKBENCH_ENDPOINT} from './src/features/workbench/client-api.ts';export {currentModelObservationGeneration} from './src/features/computer-use/model-observation.ts';" }, bundle: true, write: false, platform: 'node', format: 'esm', nodePaths: [join(dirname(anchor), 'node_modules')] })
const api = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

/** Production manager/router/session and browser registry, with only deterministic non-OS devices. */
async function fixture(t) {
  const agents = new Map(), roots = [], desktops = new Map(), browserStates = [], profile = await realpath(await mkdtemp(join(tmpdir(), 'qiuya-h2-target-pure-')))
  const geometry = { x: 0, y: 0, width: 20, height: 20, scale: 1 }
  const manager = new api.ComputerEnvironmentManager({ directory: profile, enabled: () => true, createRouter(chat) {
    const state = { captures: 0, actions: [], beforeObserve: null, beforeAct: null, lease: 0 }
    const target = { ...geometry, id: 'shared-target', appId: 'fixture.app', pid: 12, title: 'same window title' }
    const driver = { async status() { return { available: true, capabilities: { capture: true, input: true, backgroundInput: true } } }, async targets() { return [{ ...target }] },
      async lease(epoch) { state.lease = epoch }, async release(epoch) { if (state.lease === epoch) state.lease = 0 },
      async observe(targetId, signal) { await state.beforeObserve?.(); signal?.throwIfAborted(); return { targetId, frameId: 'native-frame-' + (++state.captures), imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 20, height: 20, elements: 'isolated native ' + chat, geometry: { ...geometry } } },
      async act(epoch, targetId, action, signal) { await state.beforeAct?.(); signal?.throwIfAborted(); assert.equal(state.lease, epoch); state.actions.push({ targetId, action }); return { applied: true } }, async dispose() {},
    }
    desktops.set(chat, state); return new api.ComputerDriverRouter({ local: driver })
  } })
  const agent = (id = 'chat-one') => { if (!agents.has(id)) { const value = { id }; agents.set(id, value); roots.push(value) } return agents.get(id) }
  const current = value => agents.get(value.id) === value && roots.includes(value)
  const execution = (id = 'chat-one') => ({ callId: randomUUID(), agent: agent(id), signal: new AbortController().signal })
  let permissions
  const browsers = new api.BrowserWorkbenchRegistry({ directory: profile, enabled: () => true, isAllowed: (...args) => permissions.isAllowed(...args), isCallerCurrent: exec => !!exec.agent && current(exec.agent) && !exec.signal.aborted, create(options) {
    const state = { rows: [], allowed: [...options.allowedOrigins], frames: 0, actions: [], previews: 0 }, deviceId = 'browser:review-' + browserStates.length
    const browser = { deviceId, profileDir: options.profileDir, async launch() {}, hasOwnedRuntime() { return false }, subscribe() { return () => {} },
      allowedOrigins() { return [...state.allowed] }, setAllowedOrigins(value) { state.allowed = [...value] },
      async open(url, signal, guard) { signal?.throwIfAborted(); guard?.(); const tab = { id: state.rows.length ? 'another-target-' + state.rows.length : 'shared-target', url, title: 'same window title', allowed: true }; state.rows.push(tab); return { ...tab } },
      async list() { return state.rows.map(row => ({ ...row, allowed: state.allowed.includes(new URL(row.url).origin) })) }, async metrics() { return { ...geometry } },
      async observe(targetId) { return { targetId, frameId: 'browser-frame-' + (++state.frames), imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 20, height: 20, elements: 'isolated browser', geometry: { ...geometry } } }, async preview(targetId) { state.previews++; return this.observe(targetId) },
      async act(targetId, action, signal, guard) { signal?.throwIfAborted(); guard?.(); state.actions.push({ targetId, action }); return { applied: true } }, invalidateObservations() {}, async releaseInputs() {},
      async closeOwnedTab(id) { state.rows = state.rows.filter(row => row.id !== id) }, async closeTab(id) { return this.closeOwnedTab(id) }, async navigationState() { return { canGoBack: false, canGoForward: false } }, async close() {},
    }
    browserStates.push(state); return { browser, driver: new api.BrowserDeviceDriver(browser) }
  } })
  permissions = new api.BrowserPermissionCoordinator({ backend: browsers, enabled: () => true, lookupAgent: id => agents.get(id), isRootAgent: current, readAllowedOrigins: () => ['https://allowed.test'], writeAllowedOrigins: async () => {} })
  const target = new api.ModelTargetRegistry(manager, browsers, current), desktop = new api.DesktopWorkbenchRegistry(manager)
  const owner = () => { const controller = new AbortController(); let live = true; return { signal: controller.signal, controller, invalidate() { live = false }, assertCurrent() { controller.signal.throwIfAborted(); if (!live) throw Error('OWNER_CHANGED') } } }
  const native = async (id = 'chat-one') => { const exec = execution(id); await manager.start(id, 'shared-target', { allowOnce: true }); return { exec, view: desktop.views(id)[0] } }
  const browser = async (id = 'chat-one') => { const exec = execution(id), view = await permissions.request(exec, { url: 'https://allowed.test/page', browser: 'chrome', reason: 'isolated authority review' }); return { exec, view, context: browsers.capture(exec, view.environmentId, view.workbenchTabId) } }
  t.after(async () => { await permissions.dispose(); await browsers.dispose(); await manager.dispose(); await rm(profile, { recursive: true, force: true }) })
  return { manager, desktops, browsers, browserStates, permissions, target, desktop, agents, roots, agent, execution, current, owner, native, browser, profile }
}
const identity = value => value && { environmentId: value.environmentId, epoch: value.epoch, targetId: value.target.id, appId: value.target.appId }

test('100 owner view-only switches across desktop/browser never change the model-selected execution target', async t => {
  const f = await fixture(t), native = await f.native(), browser = await f.browser(), owner = f.owner(); f.target.selectBrowser(browser.exec, browser.context)
  const before = identity(f.target.runEnvironment('chat-one'))
  for (let i = 0; i < 100; i++) { const chosen = i % 2 ? native.view : browser.view; if (chosen.kind === 'desktop') await f.desktop.preview('chat-one', chosen.environmentId, chosen.workbenchTabId, owner); else await f.browsers.preview('chat-one', chosen.environmentId, chosen.workbenchTabId, owner); assert.deepEqual(identity(f.target.runEnvironment('chat-one')), before) }
  assert.equal(f.desktops.get('chat-one').actions.length, 0); assert.equal(f.browserStates[0].actions.length, 0)
})
test('stale or paused browser selection returns unavailable and never falls back to a still-ready native desktop', async t => {
  const f = await fixture(t), native = await f.native(), browser = await f.browser(); f.target.selectBrowser(browser.exec, browser.context)
  await f.browsers.control('chat-one', browser.view.environmentId, browser.view.workbenchTabId, 'pause', f.owner())
  assert.ok(f.manager.runEnvironment('chat-one')); assert.equal(f.target.runEnvironment('chat-one'), undefined)
  assert.throws(() => f.target.assertBrowser(browser.exec, browser.context)); f.target.selectDesktop(native.exec); assert.equal(f.target.runEnvironment('chat-one').environmentId, native.view.environmentId)
})
test('browser revocation cannot silently replace the selected target with native even when ids and titles match', async t => {
  const f = await fixture(t), native = await f.native(), browser = await f.browser(); assert.equal(native.view.targetId, browser.view.targetId); assert.equal(native.view.title, browser.view.title)
  f.target.selectBrowser(browser.exec, browser.context); await f.permissions.revoke('https://allowed.test')
  assert.equal(f.target.runEnvironment('chat-one'), undefined); assert.ok(f.manager.runEnvironment('chat-one')); assert.equal(f.desktops.get('chat-one').actions.length, 0)
})
test('same-title/same-target-id native and browser views remain isolated across two actual manager services', async t => {
  const f = await fixture(t), a = await f.native('chat-a'), b = await f.native('chat-b'), ba = await f.browser('chat-a'), bb = await f.browser('chat-b')
  assert.equal(a.view.targetId, b.view.targetId); assert.equal(ba.view.targetId, bb.view.targetId); assert.notEqual(a.view.environmentId, b.view.environmentId); assert.notEqual(ba.view.environmentId, bb.view.environmentId)
  f.target.selectBrowser(ba.exec, ba.context); f.target.selectDesktop(b.exec)
  assert.equal(f.target.runEnvironment('chat-a').environmentId, ba.view.environmentId); assert.equal(f.target.runEnvironment('chat-b').environmentId, b.view.environmentId)
  assert.throws(() => f.target.selectBrowser(b.exec, ba.context)); await assert.rejects(f.desktop.preview('chat-b', a.view.environmentId, a.view.workbenchTabId, f.owner()), { code: 'VIEW_CHANGED' })
  const observed = await f.desktop.preview('chat-b', b.view.environmentId, b.view.workbenchTabId, f.owner()); assert.equal(observed.observation.elements, 'isolated native chat-b')
})
test('copied opaque browser context and same-id forged Agent cannot select or record a model target', async t => {
  const f = await fixture(t), browser = await f.browser(); f.target.selectBrowser(browser.exec, browser.context)
  assert.throws(() => f.target.selectBrowser(browser.exec, { ...browser.context, assertCurrent() {} }), { code: 'INVALID_CONTEXT' })
  assert.throws(() => f.target.selectBrowser({ ...browser.exec, agent: { ...browser.exec.agent } }, browser.context), { code: 'CALLER_NOT_LIVE' })
  assert.throws(() => f.target.assertBrowser(browser.exec, { ...browser.context, assertCurrent() {} }), { code: 'INVALID_CONTEXT' })
})
test('replacement Root Agent with the same chat id invalidates the old selected browser without a native fallback', async t => {
  const f = await fixture(t); await f.native(); const browser = await f.browser(); f.target.selectBrowser(browser.exec, browser.context)
  f.agents.set('chat-one', { id: 'chat-one' }); assert.equal(f.target.runEnvironment('chat-one'), undefined); assert.throws(() => f.target.selectDesktop(browser.exec), { code: 'CALLER_NOT_LIVE' })
})
test('a browser recorder context cannot attach to a run when the model explicitly selected the native environment', async t => {
  const f = await fixture(t), native = await f.native(), browser = await f.browser(); f.target.selectDesktop(native.exec)
  assert.throws(() => f.target.assertBrowser(browser.exec, browser.context), { code: 'CONTROL_CHANGED' }); assert.equal(f.target.runEnvironment('chat-one').environmentId, native.view.environmentId)
})
test('desktop preview rejects a late owner change after the real session capture completes', async t => {
  const f = await fixture(t), native = await f.native(), barrier = deferred(), entered = deferred(), owner = f.owner(), state = f.desktops.get('chat-one')
  state.beforeObserve = () => { entered.resolve(); return barrier.promise }
  const reading = f.desktop.preview('chat-one', native.view.environmentId, native.view.workbenchTabId, owner); await entered.promise; owner.invalidate(); barrier.resolve(); await assert.rejects(reading, /OWNER_CHANGED/u); assert.equal(state.actions.length, 0)
})
test('desktop owner signal cancellation during pending capture prevents a completed frame from being published', async t => {
  const f = await fixture(t), native = await f.native(), barrier = deferred(), entered = deferred(), owner = f.owner(), state = f.desktops.get('chat-one')
  state.beforeObserve = () => { entered.resolve(); return barrier.promise }
  const reading = f.desktop.preview('chat-one', native.view.environmentId, native.view.workbenchTabId, owner); await entered.promise; owner.controller.abort(); barrier.resolve(); await assert.rejects(reading); assert.equal(state.actions.length, 0)
})
test('desktop humanAct requires real takeover and the real service consumes its human preview frame once', async t => {
  const f = await fixture(t), native = await f.native(), owner = f.owner()
  await assert.rejects(f.desktop.humanAct('chat-one', native.view.environmentId, native.view.workbenchTabId, { actionId: randomUUID(), frameId: 'not-human', action: { kind: 'click', x: 2, y: 2 } }, owner), { code: 'OWNER_TAKEOVER_REQUIRED' })
  await f.desktop.control('chat-one', native.view.environmentId, native.view.workbenchTabId, 'takeover', owner)
  const preview = await f.desktop.preview('chat-one', native.view.environmentId, native.view.workbenchTabId, owner), request = { actionId: randomUUID(), frameId: preview.observation.frameId, action: { kind: 'click', x: 2, y: 2 } }
  const ack = await f.desktop.humanAct('chat-one', native.view.environmentId, native.view.workbenchTabId, request, owner); assert.equal(ack.actionId, request.actionId)
  await assert.rejects(f.desktop.humanAct('chat-one', native.view.environmentId, native.view.workbenchTabId, { ...request, actionId: randomUUID() }, owner), { code: 'STALE_OBSERVATION' }); assert.equal(f.desktops.get('chat-one').actions.length, 1)
})
test('late owner loss rejects a desktop human action result and never automatically replays already-issued input', async t => {
  const f = await fixture(t), native = await f.native(), owner = f.owner(); await f.desktop.control('chat-one', native.view.environmentId, native.view.workbenchTabId, 'takeover', owner)
  const preview = await f.desktop.preview('chat-one', native.view.environmentId, native.view.workbenchTabId, owner), state = f.desktops.get('chat-one'), barrier = deferred(), entered = deferred()
  state.beforeAct = () => { entered.resolve(); return barrier.promise }
  const request = { actionId: randomUUID(), frameId: preview.observation.frameId, action: { kind: 'click', x: 2, y: 2 } }, acting = f.desktop.humanAct('chat-one', native.view.environmentId, native.view.workbenchTabId, request, owner)
  await entered.promise; owner.invalidate(); barrier.resolve(); await assert.rejects(acting, /OWNER_CHANGED/u); assert.equal(state.actions.length, 1)
})
test('owner signal cancellation reaches the real desktop service and prevents pending device input dispatch', async t => {
  const f = await fixture(t), native = await f.native(), owner = f.owner(); await f.desktop.control('chat-one', native.view.environmentId, native.view.workbenchTabId, 'takeover', owner)
  const preview = await f.desktop.preview('chat-one', native.view.environmentId, native.view.workbenchTabId, owner), state = f.desktops.get('chat-one'), barrier = deferred(), entered = deferred()
  state.beforeAct = () => { entered.resolve(); return barrier.promise }
  const acting = f.desktop.humanAct('chat-one', native.view.environmentId, native.view.workbenchTabId, { actionId: randomUUID(), frameId: preview.observation.frameId, action: { kind: 'click', x: 2, y: 2 } }, owner)
  await entered.promise; owner.controller.abort(); barrier.resolve(); await assert.rejects(acting); assert.equal(state.actions.length, 0)
})

const beginInput = () => ({ title: '目标隔离验收', checks: [{ checkId: 'own-check', title: '核验自有画面', expected: '证据始终绑定实际环境', required: true, minimumEvidence: 1, verifierId: null }], budget: { maxAttempts: 2, maxActions: 2, maxEvidence: 2, deadlineMs: 60000 }, idempotencyKey: randomUUID(), previousRunId: null })
test('real H1 store/authority bind browser run, UI preview leaves it live, stale browser stays historical instead of native', async t => {
  const f = await fixture(t), native = await f.native(), browser = await f.browser(); f.target.selectBrowser(browser.exec, browser.context)
  const bridge = api.createComputerRunBridge({ agents: { get: id => f.agents.get(id), roots: () => f.roots }, attachments: { async readImage() { throw Error('no evidence has been saved') } }, manager: f.target, profileDirectory: f.profile, enabled: () => true, version: 'offline-test' }); t.after(() => bridge.dispose())
  const began = await bridge.service.begin(browser.exec, beginInput()), running = await bridge.onBegin(browser.exec, began)
  assert.equal(running.record.binding.environmentId, browser.view.environmentId); assert.notEqual(running.record.binding.environmentId, native.view.environmentId)
  await f.desktop.preview('chat-one', native.view.environmentId, native.view.workbenchTabId, f.owner()); assert.equal((await bridge.service.get(browser.exec, running.record.runId)).readOnly, false)
  await f.browsers.control('chat-one', browser.view.environmentId, browser.view.workbenchTabId, 'pause', f.owner()); assert.ok(f.manager.runEnvironment('chat-one')); assert.equal(f.target.runEnvironment('chat-one'), undefined)
  await assert.rejects(bridge.service.begin(browser.exec, beginInput()))
  const scope = { chatSessionId: 'chat-one', signal: new AbortController().signal, assertCurrent() {} }, historical = await bridge.reader.get(scope, running.record.runId)
  assert.equal(historical.readOnly, true); assert.equal(historical.state, 'inconclusive'); assert.equal(historical.record.binding.environmentId, browser.view.environmentId)
})
test('explicit model native selection makes the old browser H1 run read-only while a new run binds actual native', async t => {
  const f = await fixture(t), native = await f.native(), browser = await f.browser(); f.target.selectBrowser(browser.exec, browser.context)
  const bridge = api.createComputerRunBridge({ agents: { get: id => f.agents.get(id), roots: () => f.roots }, attachments: { async readImage() { throw Error('no evidence') } }, manager: f.target, profileDirectory: f.profile, enabled: () => true, version: 'offline-test' }); t.after(() => bridge.dispose())
  const began = await bridge.service.begin(browser.exec, beginInput()); await bridge.onBegin(browser.exec, began); f.target.selectDesktop(native.exec)
  const old = await bridge.service.get(native.exec, began.record.runId); assert.equal(old.readOnly, true); assert.equal(old.state, 'inconclusive')
  const next = await bridge.service.begin({ ...native.exec, callId: randomUUID() }, beginInput()); assert.equal(next.record.binding.environmentId, native.view.environmentId); assert.notEqual(next.record.binding.environmentId, began.record.binding.environmentId)
})

async function installed(t, f, { query, headerId } = {}) {
  const ctx = new Context(), routes = [], peer = { principal: { kind: 'owner' } }, connection = { browserPeer: peer, fetch: { register(route) { routes.push(route); return async () => { routes.splice(routes.indexOf(route), 1) } } } }, queries = [], disposals = []
  const provided = ctx.plugin(child => { child.provide('systemPrompt', { tools() { return () => {} } }); child.provide('profileContext', { dir: f.profile }); child.provide('agents', { get: id => f.agents.get(id), roots: () => f.roots }); child.provide('sessionQuery', { async observeSession(id, options) { queries.push({ id, options }); await query?.(id, options); return { header: { id: headerId ?? id }, [Symbol.dispose]() { disposals.push(id) } } } }); child.provide('connection', connection); child.provide('attachments', { async saveImage() { throw Error('no model screenshot expected') } }) }); await provided.await()
  const tools = ctx.plugin(ToolRuntime); await tools.await()
  const workbench = await api.installWorkbench(ctx, f.manager, { enabled: () => true, recorder: () => undefined })
  t.after(async () => { await workbench.dispose(); await tools.dispose(); await provided.dispose() })
  const call = async input => { const response = await routes[0].fetch(new Request('http://unit.test/api/' + api.WORKBENCH_ENDPOINT, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: api.WORKBENCH_ENDPOINT, payload: input }) })); return response.json() }
  return { ctx, routes, connection, workbench, queries, disposals, call }
}
test('actual workbench installer uses public session query and real desktop registry without launching a browser', async t => {
  const f = await fixture(t), native = await f.native(), own = await installed(t, f)
  const status = await own.call({ op: 'status', chatSessionId: 'chat-one' }); assert.equal(status.result.ok, true); assert.equal(status.result.value.views[0].environmentId, native.view.environmentId); assert.equal(status.result.value.views[0].kind, 'desktop')
  assert.equal(own.workbench.browsers.environments('chat-one').length, 0); assert.equal(own.queries.length, 1); assert.equal(own.queries[0].options.projectionMode, 'none'); assert.deepEqual(own.disposals, ['chat-one'])
  assert.equal(own.workbench.modelTarget.runEnvironment('chat-one').environmentId, native.view.environmentId)
})
test('owner swap while actual installer session query awaits rejects before desktop status projection and disposes the result', async t => {
  const f = await fixture(t); await f.native(); const barrier = deferred(), entered = deferred(), own = await installed(t, f, { query: async () => { entered.resolve(); await barrier.promise } })
  const status = own.call({ op: 'status', chatSessionId: 'chat-one' }); await entered.promise; own.connection.browserPeer = { principal: { kind: 'owner' } }; barrier.resolve(); const result = await status
  assert.equal(result.result.ok, false); assert.equal(result.result.value, undefined); assert.deepEqual(own.disposals, ['chat-one']); assert.equal(f.desktops.get('chat-one').actions.length, 0)
})
test('foreign public session header is rejected before the actual desktop registry can expose another chat', async t => {
  const f = await fixture(t); await f.native(); const own = await installed(t, f, { headerId: 'different-chat' }), result = await own.call({ op: 'status', chatSessionId: 'chat-one' })
  assert.equal(result.result.ok, false); assert.equal(result.result.value, undefined); assert.deepEqual(own.disposals, ['chat-one']); assert.equal(f.desktops.get('chat-one').actions.length, 0)
})
test('actual 2s query budget rejects a pending scope and safely disposes a late result without reviving authority', { timeout: 6000 }, async t => {
  const f = await fixture(t); await f.native(); const barrier = deferred(), entered = deferred(), own = await installed(t, f, { query: async () => { entered.resolve(); await barrier.promise } })
  const status = own.call({ op: 'status', chatSessionId: 'chat-one' }); await entered.promise; const result = await status
  assert.equal(result.result.ok, false); assert.equal(result.result.value, undefined); assert.equal(own.queries[0].options.signal.aborted, true); assert.deepEqual(own.disposals, [])
  barrier.resolve(); await turn(); assert.deepEqual(own.disposals, ['chat-one']); assert.equal(f.desktops.get('chat-one').actions.length, 0)
})


test('trusted model receipt follows the real selected service and cached view switches cannot advance its Host ticket', async t => {
  const f = await fixture(t), native = await f.native(), chat = native.exec.agent.id
  assert.equal(f.target.modelObservationGeneration(chat), undefined)
  await f.manager.observe(chat)
  const nativeTicket = f.target.modelObservationGeneration(chat)
  assert(Number.isSafeInteger(nativeTicket) && nativeTicket > 0)
  await f.manager.preview(chat)
  assert.equal(f.target.modelObservationGeneration(chat), nativeTicket)
  const browser = await f.browser(), context = browser.context
  f.target.selectBrowser(browser.exec, context)
  assert.equal(f.target.modelObservationGeneration(chat), undefined)
  await f.browsers.observe(context)
  const browserTicket = f.target.modelObservationGeneration(chat), boundary = api.currentModelObservationGeneration()
  assert(browserTicket > nativeTicket && browserTicket <= boundary)
  await f.browsers.preview(chat, browser.view.environmentId, browser.view.workbenchTabId, f.owner())
  assert.equal(f.target.modelObservationGeneration(chat), browserTicket)
  assert.equal(api.currentModelObservationGeneration(), boundary)
  f.target.selectDesktop(native.exec)
  assert.equal(f.target.modelObservationGeneration(chat), nativeTicket)
  assert(f.target.modelObservationGeneration(chat) <= boundary)
  f.target.selectBrowser(browser.exec, context)
  assert.equal(f.target.modelObservationGeneration(chat), browserTicket)
  assert.throws(() => f.browsers.readObservationGeneration({ ...context }), { code: 'INVALID_CONTEXT' })
  assert.equal(f.desktops.get(chat).actions.length + f.browserStates[0].actions.length, 0)
})

test('real selected browser receipt disappears after caller replacement rather than falling back to desktop cache', async t => {
  const f = await fixture(t), native = await f.native(); await f.manager.observe(native.exec.agent.id)
  const b = await f.browser(); f.target.selectBrowser(b.exec, b.context); await f.browsers.observe(b.context)
  assert(Number.isSafeInteger(f.target.modelObservationGeneration(b.exec.agent.id)))
  f.agents.set(b.exec.agent.id, { id: b.exec.agent.id })
  assert.equal(f.target.modelObservationGeneration(b.exec.agent.id), undefined)
  assert.equal(f.desktops.get(b.exec.agent.id).actions.length + f.browserStates[0].actions.length, 0)
})
