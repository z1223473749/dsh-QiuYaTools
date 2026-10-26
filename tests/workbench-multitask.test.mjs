import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { build } from 'esbuild'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const repository = fileURLToPath(new URL('../', import.meta.url)), directory = await mkdtemp('/private/tmp/qiuya-workbench-multitask-')
const source = (await build({ stdin: { resolveDir: repository, contents: `export {ComputerEnvironmentManager} from './src/features/computer-use/environment-manager.ts';export {ComputerDriverRouter} from './src/features/computer-use/driver-router.ts';export {ScheduledComputerDriver} from './src/features/computer-use/scheduled-driver.ts';export {DesktopWorkbenchRegistry} from './src/features/workbench/desktop-registry.ts';export {installWorkbenchClient} from './src/features/workbench/client.tsx';` }, bundle: true, write: false, platform: 'node', format: 'esm', external: ['react', 'react-dom'] })).outputFiles[0].text
await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'), 'dir')
await writeFile(join(directory, 'runtime.mjs'), source)
after(() => rm(directory, { recursive: true, force: true }))
const runtime = await import(pathToFileURL(join(directory, 'runtime.mjs')).href)
const tick = () => new Promise(done => setImmediate(done))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const geometry = { x: 0, y: 0, width: 100, height: 80, scale: 1 }
const target = { ...geometry, id: 'same-window', appId: 'same.application', pid: 123, title: '相同窗口标题' }

function fixture() {
  const devices = new Map(), rpc = [], nativeRequests = [], opens = []
  const manager = new runtime.ComputerEnvironmentManager({ enabled: () => true, createRouter(operationId, scheduler) {
    const state = { captures: 0, actions: [], beforeObserve: undefined, image: Buffer.from(operationId ?? 'legacy').toString('base64') }
    const device = { async status() { return { available: true, platform: 'win32' } }, async targets() { return [{ ...target }] },
      async observe(targetId) { state.captures++; await state.beforeObserve?.(); return { targetId, frameId: `${operationId}-${state.captures}`, imageBase64: state.image, mediaType: 'image/jpeg', width: geometry.width, height: geometry.height, geometry: { ...geometry }, elements: '' } },
      async lease() {}, async release() {}, async act(_epoch, targetId, action) { state.actions.push({ targetId, action }); return {} }, async dispose() {},
    }
    devices.set(operationId, state)
    return new runtime.ComputerDriverRouter({ local: new runtime.ScheduledComputerDriver(device, 'multitask-desktop', scheduler) })
  } })
  const registry = new runtime.DesktopWorkbenchRegistry(manager)
  const owner = signal => ({ signal, assertCurrent() { signal.throwIfAborted() } })
  const peer = { rpc: { async call(channel, endpoint, input, signal = new AbortController().signal) {
    assert.equal(channel, '/api'); rpc.push({ endpoint, input: structuredClone(input), signal })
    if (endpoint === 'qiuya-tools.computer.control') {
      if (input.op === 'pending') return { ok: true, value: { pendingRequests: structuredClone(nativeRequests) } }
      assert.ok(['decide', 'openSettings'].includes(input.op)); return { ok: true, value: {} }
    }
    assert.equal(endpoint, 'qiuya-tools.workbench')
    if (input.op === 'status') return { ok: true, value: { views: registry.views(input.chatSessionId), pendingRequests: [], allowedOrigins: [] } }
    if (input.op === 'preview') return { ok: true, value: await registry.preview(input.chatSessionId, input.environmentId, input.workbenchTabId, owner(signal)) }
    if (input.op === 'control') return { ok: true, value: await registry.control(input.chatSessionId, input.environmentId, input.workbenchTabId, input.operation, owner(signal)) }
    throw Error('Unexpected workbench mutation: ' + input.op)
  } } }
  return { manager, registry, devices, rpc, nativeRequests, opens, peer,
    async ready(chat = 'chat-A') { const a = manager.createTask(chat, '任务 A'), b = manager.createTask(chat, '任务 B'); await Promise.all([chat, a, b].map(id => manager.start(id, target.id, { allowOnce: true }))); return { a, b } },
  }
}

async function mountInstalled(f, initialChat = 'chat-A', { delayedMounted = false } = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://isolated.test/' }), previous = new Map()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { constructor(callback) { this.callback = callback } observe() { this.callback() } disconnect() {} } })) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 300, height: 180, right: 300, bottom: 180, x: 0, y: 0, toJSON() { return {} } } }
  const slots = [], mountedListeners = new Set(); let chat = initialChat, mountedChat = delayedMounted ? undefined : initialChat, activeTab
  const snapshot = { status: 'ready', value: { enabled: true, computerUseEnabled: true } }, form = { subscribe() { return () => {} }, getSnapshot() { return snapshot } }
  const ctx = { get(name) { if (name === 'connection') return f.peer; return undefined }, resources: { register() { return () => {} } }, sidebarRightTabs: { register(definition) { assert.equal(definition.multiple, true); return () => {} } },
    slots: { inject(_name, callback) { return callback() }, register(definition, component) { slots.push({ definition, component }); return () => {} } },
    sidebarRight: { mounted: { getSnapshot: () => mountedChat, subscribe(callback) { mountedListeners.add(callback); return () => mountedListeners.delete(callback) } }, openResource(address) { f.opens.push(address); activeTab = { id: 'fixture-tab', kind: 'qiuya-workbench', contentId: address } }, active: () => activeTab, float() {}, dock() {}, split() {} },
  }
  const dispose = runtime.installWorkbenchClient(ctx, form)
  const entry = slots.find(value => value.definition.id === 'qiuya-tools-workbench-inline')
  assert.ok(entry, 'The actual production installer must register its workbench preview contribution')
  assert.equal(f.rpc.length, 0, 'Registration itself must not query or control a device')
  const root = createRoot(dom.window.document.getElementById('root'))
  const render = async next => { chat = next; mountedChat = next; await act(async () => { root.render(React.createElement(entry.component, { sessionId: chat })); await tick() }) }
  await act(async () => { root.render(React.createElement(entry.component, { sessionId: chat })); await tick() })
  const button = label => [...dom.window.document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label || node.getAttribute('title') === label)
  const click = async label => { const node = button(label); assert.ok(node, label); await act(async () => { node.click(); await tick() }) }
  return { dom, render, button, click, async setMountedChat(value) { await act(async () => { mountedChat = value; for (const callback of mountedListeners) callback(); await tick() }) }, async cleanup() { await act(async () => root.unmount()); dispose(); dom.window.close(); for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } }
}

test('production desktop registry exposes multiple same-chat tasks with stable view IDs and routes pause/stop to the exact operation', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); const { a, b } = await f.ready(), views = f.registry.views('chat-A')
  assert.equal(views.length, 3); assert.equal(new Set(views.map(view => view.environmentId)).size, 3); assert.equal(new Set(views.map(view => view.workbenchTabId)).size, 3)
  assert.deepEqual(views.map(view => view.title), ['相同窗口标题', '任务 A', '任务 B'])
  assert.deepEqual(f.registry.views('chat-A').map(view => view.workbenchTabId), views.map(view => view.workbenchTabId))
  assert.deepEqual(f.registry.views('chat-B'), [])
  const scope = { signal: new AbortController().signal, assertCurrent() {} }, viewA = views[1], viewB = views[2]
  await assert.rejects(f.registry.preview('chat-B', viewA.environmentId, viewA.workbenchTabId, scope), { code: 'VIEW_CHANGED' })
  await f.registry.control('chat-A', viewA.environmentId, viewA.workbenchTabId, 'pause', scope)
  assert.equal(f.manager.get(a).state, 'paused'); assert.equal(f.manager.get(b).state, 'ready'); assert.equal(f.manager.get('chat-A').state, 'ready')
  assert.equal((await f.registry.preview('chat-A', viewB.environmentId, viewB.workbenchTabId, scope)).observation.imageBase64, f.devices.get(b).image)
  await f.registry.control('chat-A', viewA.environmentId, viewA.workbenchTabId, 'stop', scope)
  assert.deepEqual(f.registry.views('chat-A').map(view => view.title), ['相同窗口标题', '任务 B'])
  assert.equal(f.manager.get(b).state, 'ready'); assert.equal([...f.devices.values()].flatMap(value => value.actions).length, 0)
})

test('a pending native preview cannot publish after that task stops, while its same-chat sibling remains live', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); const { a, b } = await f.ready(), gate = deferred(), entered = deferred()
  f.devices.get(a).beforeObserve = () => { entered.resolve(); return gate.promise }
  const view = f.registry.views('chat-A').find(value => value.title === '任务 A'), scope = { signal: new AbortController().signal, assertCurrent() {} }
  const pending = f.registry.preview('chat-A', view.environmentId, view.workbenchTabId, scope), rejected = assert.rejects(pending)
  await entered.promise; const stopping = f.manager.stop(a); gate.resolve(); await Promise.all([stopping, rejected])
  assert.equal(f.manager.get(b).state, 'ready'); assert.equal(f.registry.views('chat-A').some(value => value.title === '任务 B'), true)
})

test('the production-installed inline preview switches views without input, rejects a late A frame over B and pauses only displayed B', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); const { a, b } = await f.ready(), mounted = await mountInstalled(f); t.after(() => mounted.cleanup())
  const tabs = () => [...mounted.dom.window.document.querySelectorAll('[role="tab"]')]
  assert.equal(tabs().length, 3)
  assert.equal(mounted.dom.window.document.querySelector('img').getAttribute('src'), 'data:image/jpeg;base64,' + f.devices.get(b).image)
  const late = deferred(), entered = deferred(); f.devices.get(a).beforeObserve = () => { entered.resolve(); return late.promise }
  await mounted.click('切换电脑任务 2：任务 A'); await entered.promise
  await mounted.click('切换电脑任务 3：任务 B')
  const imageB = mounted.dom.window.document.querySelector('img').getAttribute('src')
  await act(async () => { late.resolve(); await tick() })
  assert.equal(mounted.dom.window.document.querySelector('img').getAttribute('src'), imageB)
  assert.equal(tabs().find(node => node.getAttribute('aria-selected') === 'true').title, '任务 B')
  assert.equal(f.rpc.some(row => ['control', 'act', 'humanAct', 'decide', 'start'].includes(row.input.op)), false, 'View selection is not a model or human control command')
  await mounted.click('暂停')
  assert.equal(f.manager.get(b).state, 'paused'); assert.equal(f.manager.get(a).state, 'ready'); assert.equal(f.manager.get('chat-A').state, 'ready')
  const controls = f.rpc.filter(row => row.input.op === 'control'); assert.equal(controls.length, 1)
  assert.equal(controls[0].input.environmentId, f.manager.workbenchEnvironment(b).environmentId)
  assert.equal([...f.devices.values()].flatMap(value => value.actions).length, 0)
})

test('the production-installed preview passes the chosen permission card task ID while keeping the real root chat identity', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); const a = f.manager.createTask('chat-A'), b = f.manager.createTask('chat-A')
  for (const [taskId, name] of [[a, '应用 A'], [b, '应用 B']]) f.nativeRequests.push({ requestId: randomUUID(), requestVersion: 1, sessionId: 'chat-A', taskId, appId: 'fixture.app', appName: name, reason: '当前任务授权', createdAt: Date.now(), expiresAt: Date.now() + 60000, state: 'pending', preflight: { platform: 'win32', available: true } })
  const mounted = await mountInstalled(f); t.after(() => mounted.cleanup())
  const cards = [...mounted.dom.window.document.querySelectorAll('[aria-label="电脑操作授权"]')]
  assert.equal(cards.length, 2)
  await act(async () => { [...cards[1].querySelectorAll('button')].find(node => node.textContent === '允许一次').click(); await tick() })
  const decisions = f.rpc.filter(row => row.input.op === 'decide')
  assert.equal(decisions.length, 1); assert.deepEqual(decisions[0].input, { op: 'decide', sessionId: 'chat-A', requestId: f.nativeRequests[1].requestId, requestVersion: 1, taskId: b, decision: 'once' })
  assert.equal(f.devices.size, 0, 'Rendering metadata-only approval cards must not create a desktop environment')
})

test('changing the real mounted chat discards a late old task frame in the production-installed preview', async t => {
  const f = fixture(), late = deferred(), entered = deferred(); let mounted
  t.after(async () => { late.resolve(); await mounted?.cleanup(); await f.manager.dispose() })
  const previous = await f.ready('chat-A'), next = await f.ready('chat-B')
  f.devices.get(previous.b).beforeObserve = () => { entered.resolve(); return late.promise }
  mounted = await mountInstalled(f, 'chat-A'); await entered.promise
  await mounted.render('chat-B')
  const currentImage = 'data:image/jpeg;base64,' + f.devices.get(next.b).image
  assert.equal(mounted.dom.window.document.querySelector('img').getAttribute('src'), currentImage)
  const oldRequest = f.rpc.find(row => row.input.op === 'preview' && row.input.chatSessionId === 'chat-A')
  assert.equal(oldRequest.signal.aborted, true)
  await act(async () => { late.resolve(); await tick() })
  assert.equal(mounted.dom.window.document.querySelector('img').getAttribute('src'), currentImage)
  assert.equal(mounted.dom.window.document.querySelector('[data-qyt-workbench-chat]').dataset.qytWorkbenchChat, 'chat-B')
  assert.equal(f.rpc.some(row => ['control', 'act', 'humanAct', 'decide', 'start'].includes(row.input.op)), false)
})

test('the production preview starts when the official mounted-session store arrives after the header slot, without a manual remount', async t => {
  const f = fixture(); let mounted
  t.after(async () => { await mounted?.cleanup(); await f.manager.dispose() })
  const tasks = await f.ready('chat-A')
  mounted = await mountInstalled(f, 'chat-A', { delayedMounted: true })
  assert.equal(f.rpc.length, 0); assert.equal(mounted.dom.window.document.querySelector('img'), null)
  await mounted.setMountedChat('chat-A')
  assert.equal(mounted.dom.window.document.querySelectorAll('[role="tab"]').length, 3, 'The SDK mounted notification must activate the already-mounted production slot')
  assert.equal(mounted.dom.window.document.querySelector('img').getAttribute('src'), 'data:image/jpeg;base64,' + f.devices.get(tasks.b).image)
  await mounted.setMountedChat(undefined)
  assert.equal(mounted.dom.window.document.querySelector('[data-qyt-workbench-chat]'), null, 'Losing the mounted session immediately hides the old preview')
  assert.equal(f.rpc.some(row => ['control', 'act', 'humanAct', 'decide', 'start'].includes(row.input.op)), false)
})

test('the real public slot registry adds exactly one overlay preview in Hero and active phases without replacing the official single corner control', async t => {
  const require = createRequire(import.meta.url), officialSource = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8')
  const declarationSource = await readFile(join(repository, 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts'), 'utf8')
  assert.match(declarationSource, /'conversation\.session\.header\.corner':\s*\{\s*kind: 'single';\s*scope: 'session';/u)
  assert.match(declarationSource, /'conversation\.input\.overlay':\s*\{\s*kind: 'list';\s*scope: 'session';/u)
  const inputOverlay = officialSource.indexOf('children: renderSlot("conversation.input.overlay", {})')
  assert.ok(inputOverlay > 0); assert.match(officialSource.slice(inputOverlay - 220, inputOverlay), /sessionId !== void 0[\s\S]*data-composer-overlay/u)
  // Run the actual installed SDK header implementation with only its metadata
  // helpers and CSS names supplied. Its hideChrome branch remains untouched.
  const start = officialSource.indexOf('function ConversationSessionHeader('), end = officialSource.indexOf('//#endregion', start)
  assert.ok(start > 0 && end > start)
  const OfficialHeader = new Function('react_jsx_runtime', 'clsx', 'ConversationRoot_module_css_default', 'deriveAncestry', 'equalBreadcrumbs', 'resolveActiveView', officialSource.slice(start, end) + '\nreturn ConversationSessionHeader')(require('react/jsx-runtime'), (...values) => values.filter(Boolean).join(' '), new Proxy({}, { get: (_target, key) => String(key) }), () => [], () => true, () => undefined)
  let renderer
  new Function('window', await readFile(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8'))({ __ModuleLoader__: { load(entry) { renderer = entry.factory(require) } } })
  const f = fixture(), tasks = await f.ready(), dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://isolated.test/' }), previous = new Map()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { constructor(callback) { this.callback = callback } observe() { this.callback() } disconnect() {} } })) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 300, height: 180, right: 300, bottom: 180, x: 0, y: 0, toJSON() { return {} } } }
  const context = new Context(), registryPlugin = context.plugin(renderer.SlotRegistry); await registryPlugin.await()
  let declarationInjection, featureInjection, disposeFeature
  const officialCorner = () => React.createElement('button', { 'data-official-sidebar-expand': true }, '官方侧栏展开')
  const declarations = context.plugin(child => { declarationInjection = child.inject(['slots'], active => {
    active.slots.register({ name: 'root', children: { 'conversation.input.overlay': { kind: 'list', scope: 'session' }, 'conversation.session.header.utilities': { kind: 'list', scope: 'session' }, 'conversation.session.header.corner': { kind: 'single', scope: 'session' }, 'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' }, 'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' } } }, () => null)
    active.slots.register({ name: 'conversation.session.header.corner' }, officialCorner)
    active.slots.register({ name: 'conversation.session.header.utilities', id: 'official-utility' }, () => React.createElement('span', { 'data-official-utility': true }, '官方工具'))
    active.slots.register({ name: 'conversation.input.overlay', id: 'existing-overlay' }, () => React.createElement('span', { 'data-existing-overlay': true }))
  }) }); await declarations.await(); await declarationInjection.await()
  const snapshot = { status: 'ready', value: { enabled: true, computerUseEnabled: true } }, form = { getSnapshot: () => snapshot, subscribe() { return () => {} } }
  const feature = context.plugin(child => { featureInjection = child.inject(['slots'], active => { disposeFeature = runtime.installWorkbenchClient({ slots: active.slots, get: name => name === 'connection' ? f.peer : undefined, resources: { register() { return () => {} } }, sidebarRightTabs: { register() { return () => {} } }, sidebarRight: { mounted: { getSnapshot: () => 'chat-A', subscribe() { return () => {} } }, openResource() {}, active() {}, float() {}, dock() {}, split() {} } }, form); return disposeFeature }) }); await feature.await(); await featureInjection.await()
  const registry = context.get('slots'), root = createRoot(dom.window.document.getElementById('root'))
  t.after(async () => { await act(async () => { root.unmount(); await feature.dispose() }); await declarations.dispose(); await registryPlugin.dispose(); await f.manager.dispose(); dom.window.close(); for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] })
  assert.equal(registry.spec('conversation.input.overlay').kind, 'list'); assert.equal(registry.spec('conversation.session.header.corner').kind, 'single')
  assert.equal(registry.entries('conversation.session.header.corner').length, 1)
  assert.equal(registry.entries('conversation.session.header.corner')[0].component, officialCorner)
  assert.equal(registry.entries('conversation.session.header.utilities').some(entry => entry.options.id === 'qiuya-tools-workbench-inline'), false)
  assert.equal(registry.entries('conversation.input.overlay').filter(entry => entry.options.id === 'qiuya-tools-workbench-inline').length, 1)
  function Occurrence({ name }) { const entries = useSyncExternalStore(listener => registry.subscribe(name, listener), () => registry.entries(name), () => registry.entries(name)); return React.createElement(React.Fragment, {}, entries.map((entry, index) => React.createElement(entry.component, { key: entry.options.id ?? index, sessionId: 'chat-A' }))) }
  function Shell({ hero }) { return React.createElement(React.Fragment, {}, React.createElement(OfficialHeader, { sessionId: 'chat-A', hideChrome: hero, useSessions: () => [], useConversationViews: () => [], useStore: selector => selector({ view: null }), renderSlot: name => React.createElement(Occurrence, { name }), open() {}, selectView() {}, t: value => value }), React.createElement('div', { 'data-composer-overlay': true }, React.createElement(Occurrence, { name: 'conversation.input.overlay' }))) }
  for (const hero of [true, false, true]) {
    await act(async () => { root.render(React.createElement(Shell, { hero })); await tick() })
    assert.equal(dom.window.document.querySelectorAll('[data-official-sidebar-expand]').length, 1)
    assert.equal(dom.window.document.querySelectorAll('[data-official-utility]').length, hero ? 0 : 1)
    assert.equal(dom.window.document.querySelectorAll('[aria-label="电脑实时预览"]').length, 1)
    assert.equal(dom.window.document.querySelectorAll('[data-existing-overlay]').length, 1)
    assert.equal(dom.window.document.querySelector('img').getAttribute('src'), 'data:image/jpeg;base64,' + f.devices.get(tasks.b).image)
    assert.equal(dom.window.document.getElementById('root').querySelector('[aria-label="电脑实时预览"]'), null, 'The preview portal must escape the composer containing block')
  }
  await act(async () => { disposeFeature(); await tick() })
  assert.equal(dom.window.document.querySelector('[aria-label="电脑实时预览"]'), null)
  assert.equal(dom.window.document.querySelectorAll('[data-official-sidebar-expand]').length, 1)
  assert.equal(registry.entries('conversation.session.header.corner')[0].component, officialCorner)
  assert.equal(f.manager.get(tasks.b).state, 'ready')
  assert.equal(f.rpc.some(row => ['control', 'act', 'humanAct', 'decide', 'start'].includes(row.input.op)), false)
})
