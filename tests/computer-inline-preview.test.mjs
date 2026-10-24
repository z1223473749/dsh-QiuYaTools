import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
// Load the official browser module through its documented factory carrier;
// invoking apply() would mount an entire Harness shell, which this test does
// not need. The SlotRegistry class and its effect ownership remain genuine.
let renderer
new Function('window', await readFile(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8'))({ __ModuleLoader__: { load(entry) { renderer = entry.factory(require) } } })
const { SlotRegistry } = renderer
const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/inline-preview.tsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })).outputFiles[0].text
const slot = 'conversation.session.header.utilities', endpoint = 'qiuya-tools.computer.control'
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const settle = () => new Promise(done => setImmediate(done))
const snapshot = (sessionId, state = 'ready') => ({ sessionId, state, epoch: 1, updatedAt: 1, target: { id: `window-${sessionId}`, appId: `own-${sessionId}`, pid: sessionId === 'A' ? 10 : 20, title: `Target ${sessionId}`, x: 0, y: 0, width: 100, height: 80, scale: 1 } })

async function fixture(t, { initial = { status: 'ready', value: { enabled: true, computerUseEnabled: true } } } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1/' })
  const saved = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const scheduled = new Map(), subscribers = new Set(), calls = [], planned = [], states = new Map([['A', snapshot('A')], ['B', snapshot('B', 'running')]]), detached = new Map(), requests = new Map(), native = { value: { platform: 'win32', available: true } }
  let sequence = 0, preferences = initial, disposeFeature, declarationInjection, featureInjection
  const clock = { setTimeout(callback, milliseconds) { assert.equal(milliseconds, 1200, 'only the component polling clock is controlled'); const id = ++sequence; scheduled.set(id, callback); return id }, clearTimeout(id) { scheduled.delete(id) } }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', source)(require, module, module.exports, clock.setTimeout, clock.clearTimeout)
  const form = { getSnapshot: () => preferences, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener) } }
  const status = () => ({ native: structuredClone(native.value), pendingRequests: [...requests.values()].map(value => structuredClone(value)), sessions: [...states.values()].map(value => structuredClone(value)), environments: [...states.keys()].map(sessionId => ({ sessionId, previewDetached: detached.get(sessionId) === true })) })
  const connection = { rpc: { async call(channel, method, input, signal) {
    assert.equal(channel, '/api'); assert.equal(method, endpoint)
    const call = { input: structuredClone(input), signal }; calls.push(call)
    const index = planned.findIndex(row => row.op === input.op && row.sessionId === input.sessionId)
    if (index >= 0) return planned.splice(index, 1)[0].pending.promise // Deliberately ignores abort to exercise fencing.
    if (input.op === 'status') return { ok: true, value: status() }
    if (input.op === 'openSettings') { assert.ok(['screenRecording', 'accessibility', 'inputMonitoring'].includes(input.kind)); return { ok: true, value: { opened: true } } }
    if (input.op === 'decide') { const request = requests.get(input.requestId); assert.ok(request); assert.equal(request.sessionId, input.sessionId); assert.equal(request.requestVersion, input.requestVersion); requests.delete(input.requestId); if (input.decision !== 'deny') states.set(input.sessionId, snapshot(input.sessionId)); return { ok: true, value: { requestId: input.requestId, state: input.decision === 'deny' ? 'denied' : 'approved' } } }
    const current = states.get(input.sessionId); assert.ok(current, 'control needs a fixture-owned session')
    if (input.op === 'preview' || input.op === 'redock') detached.set(input.sessionId, input.op === 'preview')
    else if (['pause', 'takeover', 'resume', 'stop'].includes(input.op)) states.set(input.sessionId, { ...current, state: { pause: 'paused', takeover: 'humanControl', resume: 'ready', stop: 'stopped' }[input.op] })
    else throw Error('Unexpected owner control')
    return { ok: true, value: states.get(input.sessionId) }
  } } }
  const ctx = new Context(), registryPlugin = ctx.plugin(SlotRegistry); await registryPlugin.await()
  const peerPlugin = ctx.plugin(child => child.provide('connection', connection)); await peerPlugin.await()
  const declarationPlugin = ctx.plugin(child => {
    declarationInjection = child.inject(['slots'], active => {
      active.slots.register({ name: 'root', children: { [slot]: { kind: 'list', scope: 'session' } } }, () => null)
      active.slots.register({ name: slot, id: 'official-existing-utility', order: 1 }, () => React.createElement('span', { 'data-official-utility': true }, 'Official utility'))
    })
  })
  await declarationPlugin.await(); await declarationInjection.await()
  const featurePlugin = ctx.plugin(child => {
    featureInjection = child.inject(['slots', 'connection'], active => { disposeFeature = module.exports.installInlineComputerPreview(active, form) })
  })
  await featurePlugin.await(); await featureInjection.await()
  const registry = ctx.get('slots'), root = createRoot(dom.window.document.querySelector('#root'))
  // Render the actual component supplied to the public registry, with the
  // documented sessionId runtime seat. No component internals are replaced.
  function PublicSlotOccurrence({ sessionId }) {
    const entries = useSyncExternalStore(listener => registry.subscribe(slot, listener), () => registry.entries(slot), () => registry.entries(slot))
    return React.createElement(React.Fragment, {}, entries.map(entry => React.createElement(entry.component, { key: entry.options.id, sessionId })))
  }
  const render = seats => act(async () => { root.render(React.createElement(React.Fragment, {}, ...Object.entries(seats).map(([seat, sessionId]) => React.createElement('div', { key: seat, 'data-seat': seat }, React.createElement(PublicSlotOccurrence, { sessionId }))))); await settle() })
  const container = seat => dom.window.document.querySelector(`[data-seat="${seat}"]`)
  const button = (seat, label) => [...container(seat).querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  const click = async (seat, label) => { const node = button(seat, label); assert.ok(node, `Button ${label} must exist in ${seat}`); await act(async () => { node.click(); await settle() }) }
  const plan = (op, sessionId) => { const pending = deferred(); planned.push({ op, sessionId, pending }); return pending }
  const mutations = () => calls.filter(row => row.input.op !== 'status').map(row => row.input)
  const updatePreferences = async update => act(async () => { preferences = update; for (const listener of subscribers) listener(); await settle() })
  const poll = async () => act(async () => { const callbacks = [...scheduled.values()]; scheduled.clear(); await Promise.all(callbacks.map(callback => callback())); await settle() })
  t.after(async () => {
    for (const row of planned) row.pending.resolve({ ok: false, error: { message: 'Fixture disposed' } })
    await act(async () => { await featurePlugin.dispose(); await settle(); root.unmount() })
    await declarationPlugin.dispose(); await peerPlugin.dispose(); await registryPlugin.dispose(); dom.window.close()
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
  })
  return { dom, registry, calls, states, detached, requests, native, status, render, container, button, click, plan, mutations, updatePreferences, poll, scheduled, subscribers,
    async disposeSlot() { await act(async () => { disposeFeature(); await settle() }) },
    async unmount() { await act(async () => { root.unmount(); await settle() }) },
  }
}

test('two real public-slot instances render their own inline iframe and route pause/takeover/resume/stop only to that chat', async t => {
  const f = await fixture(t); await f.render({ left: 'A', right: 'B' })
  assert.deepEqual(f.registry.entries(slot).map(row => row.options.id), ['official-existing-utility', 'qiuya-tools-computer-inline'])
  for (const [seat, sessionId] of [['left', 'A'], ['right', 'B']]) {
    const frame = f.container(seat).querySelector('iframe'), url = new URL(frame.src)
    assert.equal(url.pathname, '/api/qiuya-tools.computer.preview'); assert.equal(url.searchParams.get('session'), sessionId); assert.equal(url.searchParams.get('view'), 'inline')
    assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer')
    assert.equal(f.container(seat).querySelector('[data-qyt-computer-chat]').dataset.qytComputerChat, sessionId)
  }
  await f.click('left', '暂停电脑任务')
  assert.equal(f.states.get('A').state, 'paused'); assert.equal(f.states.get('B').state, 'running')
  assert.equal(f.container('right').querySelector('[data-qyt-computer-inline]').dataset.state, 'running'); assert.equal(f.button('left', '继续电脑任务').disabled, false)
  await f.click('left', '继续电脑任务'); await f.click('right', '接管电脑任务'); await f.click('right', '停止电脑任务')
  assert.deepEqual(f.mutations(), [{ op: 'pause', sessionId: 'A' }, { op: 'resume', sessionId: 'A' }, { op: 'takeover', sessionId: 'B' }, { op: 'stop', sessionId: 'B' }])
  assert.ok(f.container('left').querySelector('iframe')); assert.equal(f.container('right').querySelector('iframe'), null)
})

test('detach and redock retain the same live inline frame; hiding controls never collapses its picture', async t => {
  const f = await fixture(t); await f.render({ left: 'A', right: 'B' })
  const leftFrame = f.container('left').querySelector('iframe'), rightFrame = f.container('right').querySelector('iframe')
  await f.click('left', '弹出电脑预览')
  assert.equal(f.container('left').querySelector('iframe'), leftFrame); assert.equal(f.container('left').querySelector('[aria-label="预览已弹出"]'), null)
  assert.ok(f.button('left', '收回电脑预览'))
  assert.equal(f.container('right').querySelector('iframe'), rightFrame)
  await f.click('left', '收回电脑预览')
  assert.equal(f.container('left').querySelector('iframe'), leftFrame)
  await f.click('left', '隐藏预览控件')
  assert.equal(f.container('left').querySelector('iframe'), leftFrame); assert.equal(f.container('left').querySelector('[data-qyt-computer-inline]').dataset.controlsHidden, 'true')
  assert.deepEqual(f.mutations(), [{ op: 'preview', sessionId: 'A' }, { op: 'redock', sessionId: 'A' }])
})

test('a late status from the old session is aborted and cannot replace the new chat or its detached state', async t => {
  const f = await fixture(t), old = f.plan('status', 'A')
  await f.render({ seat: 'A' }); const oldCall = f.calls[0]
  assert.equal(f.container('seat').querySelector('iframe'), null)
  f.detached.set('B', true); await f.render({ seat: 'B' })
  assert.equal(oldCall.signal.aborted, true); assert.equal(f.container('seat').querySelector('[data-qyt-computer-inline]').dataset.targetId, 'window-B')
  await act(async () => { old.resolve({ ok: true, value: { sessions: [snapshot('A')], environments: [{ sessionId: 'A', previewDetached: false }] } }); await settle() })
  assert.equal(f.container('seat').querySelector('[data-qyt-computer-chat]').dataset.qytComputerChat, 'B')
  assert.equal(f.container('seat').querySelector('[data-qyt-computer-inline]').dataset.targetId, 'window-B'); assert.ok(f.button('seat', '收回电脑预览')); assert.ok(f.container('seat').querySelector('iframe'))
  assert.deepEqual(f.mutations(), [])
})

for (const outcome of ['success', 'error']) test(`a late ${outcome} control for the former session cannot refresh it, show an error, or unlock the new chat's pending control`, async t => {
  const f = await fixture(t); await f.render({ seat: 'A' })
  const previous = f.plan('pause', 'A'); await f.click('seat', '暂停电脑任务')
  assert.equal(f.button('seat', '暂停电脑任务').disabled, true)
  await f.render({ seat: 'B' }); const current = f.plan('takeover', 'B'); await f.click('seat', '接管电脑任务')
  const requestsBefore = f.calls.filter(row => row.input.op === 'status').length
  await act(async () => { previous.resolve(outcome === 'success' ? { ok: true, value: snapshot('A', 'paused') } : { ok: false, error: { message: 'OLD_A_CONTROL_FAILED' } }); await settle() })
  assert.equal(f.button('seat', '暂停电脑任务').disabled, true, 'former finally must not clear current pending state')
  assert.equal(f.container('seat').querySelector('[role=alert]'), null)
  assert.equal(f.calls.filter(row => row.input.op === 'status').length, requestsBefore, 'former success must not request another old-session refresh')
  f.states.set('B', snapshot('B', 'humanControl'))
  await act(async () => { current.resolve({ ok: true, value: snapshot('B', 'humanControl') }); await settle() })
  assert.equal(f.button('seat', '暂停电脑任务').disabled, false); assert.equal(f.container('seat').querySelector('[data-qyt-computer-inline]').dataset.state, 'humanControl')
  assert.deepEqual(f.mutations(), [{ op: 'pause', sessionId: 'A' }, { op: 'takeover', sessionId: 'B' }])
})

test('disabled preferences hide both instances and abort polling; enabling restores them without pausing a background task', async t => {
  const f = await fixture(t); await f.render({ left: 'A', right: 'B' })
  assert.equal(f.scheduled.size, 2)
  await f.updatePreferences({ status: 'ready', value: { enabled: true, computerUseEnabled: false } })
  assert.equal(f.dom.window.document.querySelector('iframe'), null); assert.equal(f.scheduled.size, 0)
  assert.equal(f.registry.entries(slot).length, 2, 'disabling hides the contribution while keeping its public registration')
  assert.deepEqual(f.mutations(), [])
  await f.updatePreferences({ status: 'ready', value: { enabled: true, computerUseEnabled: true } })
  assert.equal(f.dom.window.document.querySelectorAll('iframe').length, 2)
  f.states.set('A', snapshot('A', 'paused')); await f.poll()
  assert.equal(f.container('left').querySelector('[data-qyt-computer-inline]').dataset.state, 'paused'); assert.equal(f.container('right').querySelector('[data-qyt-computer-inline]').dataset.state, 'running')
  assert.deepEqual(f.mutations(), [])
})

test('slot disposer unregisters only its additive entry and unmounting emits no pause, stop or other owner input', async t => {
  const f = await fixture(t); await f.render({ left: 'A', right: 'B' })
  assert.equal(f.subscribers.size, 2)
  await f.disposeSlot()
  assert.deepEqual(f.registry.entries(slot).map(row => row.options.id), ['official-existing-utility'])
  assert.equal(f.dom.window.document.querySelector('iframe'), null); assert.equal(f.subscribers.size, 0); assert.equal(f.scheduled.size, 0)
  assert.equal(f.dom.window.document.querySelectorAll('[data-official-utility]').length, 2)
  assert.deepEqual(f.mutations(), [])
  await f.disposeSlot(); assert.deepEqual(f.mutations(), [])
})

test('unmount drops an in-flight status result without owner control or a renewed polling timer', async t => {
  const f = await fixture(t), pending = f.plan('status', 'A')
  await f.render({ seat: 'A' }); const signal = f.calls[0].signal
  await f.unmount(); assert.equal(signal.aborted, true); assert.equal(f.subscribers.size, 0)
  await act(async () => { pending.resolve({ ok: true, value: { sessions: [snapshot('A')], environments: [] } }); await settle() })
  assert.equal(f.dom.window.document.querySelector('iframe'), null); assert.equal(f.scheduled.size, 0); assert.deepEqual(f.mutations(), [])
})

test('loading and master-disabled preference snapshots do not read status or display a live iframe', async t => {
  const f = await fixture(t, { initial: { status: 'loading', value: undefined } }); await f.render({ seat: 'A' })
  assert.deepEqual(f.calls, []); assert.equal(f.dom.window.document.querySelector('iframe'), null)
  await f.updatePreferences({ status: 'ready', value: { enabled: false, computerUseEnabled: true } })
  assert.deepEqual(f.calls, []); assert.equal(f.dom.window.document.querySelector('iframe'), null)
  await f.updatePreferences({ status: 'ready', value: { enabled: true, computerUseEnabled: true } })
  assert.equal(f.calls[0].input.sessionId, 'A'); assert.ok(f.dom.window.document.querySelector('iframe'))
})

const approval = (sessionId, overrides = {}) => ({ requestId: `request-${sessionId}`, requestVersion: 1, sessionId, appId: 'own-app', appName: '<b>自有应用</b>', targetTitle: '<img src=x onerror=alert(1)>', reason: '读取图表并填写中文', createdAt: Date.now(), expiresAt: Date.now() + 60000, state: 'pending', ...overrides })

test('pending-only public chat card presents plain text and routes exact request identity without manual setup', async t => {
  const f = await fixture(t); f.states.clear(); f.requests.set('request-A', approval('A')); f.requests.set('request-B', approval('B'))
  await f.render({ left: 'A', right: 'B' })
  assert.equal(f.container('left').querySelector('iframe'), null)
  assert.equal(f.container('left').querySelector('img,b'), null, 'model text must never become markup')
  assert.match(f.container('left').textContent, /<b>自有应用<\/b>/u)
  await f.click('left', '允许一次')
  assert.deepEqual(f.mutations(), [{ op: 'decide', sessionId: 'A', requestId: 'request-A', requestVersion: 1, decision: 'once' }])
  assert.ok(f.container('left').querySelector('iframe')); assert.equal(f.container('right').querySelector('iframe'), null)
  await f.click('right', '拒绝'); assert.equal(f.container('right').querySelector('[data-qyt-computer-chat]'), null)
})

test('Mac pending card opens fixed permission settings, reads refreshed permissions and gates grants while denial remains available', async t => {
  const f = await fixture(t); f.states.clear(); f.requests.set('request-A', approval('A')); f.native.value = { platform: 'darwin', permissions: { screenRecording: false, accessibility: false, postEvents: false, inputMonitoring: false } }
  await f.render({ seat: 'A' })
  for (const label of ['允许一次', '始终允许']) assert.equal(f.button('seat', label).disabled, true)
  assert.equal(f.button('seat', '拒绝').disabled, false)
  await f.click('seat', '前往开启屏幕录制'); await f.click('seat', '前往开启辅助功能'); await f.click('seat', '前往开启输入监控')
  assert.deepEqual(f.mutations(), ['screenRecording', 'accessibility', 'inputMonitoring'].map(kind => ({ op: 'openSettings', sessionId: 'A', kind })))
  assert.equal(f.button('seat', '允许一次').disabled, true, 'opening Settings is not evidence of permission')
  f.native.value.permissions = { screenRecording: true, accessibility: true, postEvents: true, inputMonitoring: false }
  await f.click('seat', '刷新权限')
  assert.equal(f.button('seat', '允许一次').disabled, false); assert.equal(f.button('seat', '始终允许').disabled, false)
  assert.match(f.container('seat').textContent, /建议开启输入监控/u)
  assert.equal(f.mutations().some(row => row.op === 'refresh'), false, 'refresh reads status, not a fabricated mutation')
  await f.click('seat', '始终允许'); assert.equal(f.mutations().at(-1).decision, 'always')
})

test('Windows and independent-browser pending cards do not inherit macOS TCC gates', async t => {
  const f = await fixture(t); f.states.clear(); f.requests.set('request-A', approval('A')); f.native.value = { platform: 'win32', available: true, permissions: { screenRecording: false, accessibility: false } }
  await f.render({ seat: 'A' })
  assert.equal(f.button('seat', '允许一次').disabled, false); assert.equal(f.container('seat').querySelector('[aria-label="系统权限引导"]'), null)
  f.native.value = { mode: 'browser', available: true }; await f.poll()
  assert.equal(f.button('seat', '允许一次').disabled, false)
  await f.click('seat', '拒绝'); assert.equal(f.mutations().at(-1).decision, 'deny')
})

test('expired request stays noninteractive and a late former-chat approval cannot refresh or unlock the current card', async t => {
  const f = await fixture(t); f.states.clear(); f.requests.set('request-A', approval('A')); f.requests.set('request-B', approval('B'))
  await f.render({ seat: 'A' }); const old = f.plan('decide', 'A'); await f.click('seat', '允许一次')
  await f.render({ seat: 'B' }); const fresh = f.plan('decide', 'B'); await f.click('seat', '始终允许')
  const statusCount = f.calls.filter(row => row.input.op === 'status').length
  await act(async () => { old.resolve({ ok: true, value: { requestId: 'request-A', state: 'approved' } }); await settle() })
  assert.equal(f.button('seat', '拒绝').disabled, true); assert.equal(f.calls.filter(row => row.input.op === 'status').length, statusCount)
  f.requests.set('request-B', approval('B', { expiresAt: Date.now() - 1 }))
  await act(async () => { fresh.resolve({ ok: true, value: { requestId: 'request-B', state: 'denied' } }); await settle() })
  assert.match(f.container('seat').textContent, /请求已过期/u); assert.equal(f.button('seat', '允许一次'), undefined)
})


test('active inline preview is image-first and keeps controls in a hover/focus overlay without permanent title/status/settings', async t => {
  const f = await fixture(t); await f.render({ seat: 'A' })
  const card = f.container('seat').querySelector('[data-qyt-computer-inline]')
  assert.equal(card.querySelector('.qyt-computer-inline-title,.qyt-computer-status-badge,.qyt-computer-inline-settings'), null)
  assert.equal(card.textContent.includes('Target A'), false); assert.equal(card.textContent.includes('已就绪'), false)
  assert.equal(f.button('seat', '显示电脑实时预览'), undefined)
  const image = card.querySelector('.qyt-computer-inline-image'); assert.ok(image.querySelector('iframe'))
  assert.ok(image.querySelector('[aria-label="电脑预览悬浮控件"]')); assert.ok(f.button('seat', '拖动电脑小预览'))
  const css = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.qyt-computer-inline-card:hover \.qyt-computer-inline-actions,\.qyt-computer-inline-card:focus-within \.qyt-computer-inline-actions/u)
  assert.match(css, /opacity:0; pointer-events:none/u); assert.match(css, /data-dragging="true"[^}]*box-shadow/u)
  assert.deepEqual(f.mutations(), [])
})

function installGeometry(f) {
  const view = f.dom.window
  Object.defineProperty(view, 'innerWidth', { configurable: true, value: 800 }); Object.defineProperty(view, 'innerHeight', { configurable: true, value: 600 })
  view.HTMLElement.prototype.getBoundingClientRect = function() {
    const widget = this.matches('[data-qyt-computer-inline]'), x = widget ? parseFloat(this.style.left) || 0 : 760, y = widget ? parseFloat(this.style.top) || 0 : 40, width = widget ? Math.min(300, view.innerWidth - 16) : 0, height = widget ? Math.min(180, view.innerHeight - 18) : 0
    return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height }
  }
  const pointer = async (node, type, x, y, pointerId = 1) => act(async () => { const event = new view.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, cancelable: true }); Object.defineProperty(event, 'pointerId', { value: pointerId }); Object.defineProperty(event, 'isPrimary', { value: true }); node.dispatchEvent(event); await settle() })
  return { pointer, async resize(width, height) { await act(async () => { Object.defineProperty(view, 'innerWidth', { configurable: true, value: width }); Object.defineProperty(view, 'innerHeight', { configurable: true, value: height }); view.dispatchEvent(new view.Event('resize')); await settle() }) } }
}

test('AI image dragging clamps to this viewport and never sends input; resize and chat changes recheck containment', async t => {
  const f = await fixture(t), g = installGeometry(f); await f.render({ seat: 'A' })
  let card = f.container('seat').querySelector('[data-qyt-computer-inline]'), surface = card.querySelector('.qyt-computer-inline-drag-surface')
  assert.equal(card.style.left, '460px'); assert.equal(card.style.top, '50px')
  await g.pointer(surface, 'pointerdown', 500, 100); await g.pointer(card, 'pointermove', -1000, 2000)
  assert.equal(card.style.left, '8px'); assert.equal(card.style.top, '412px'); assert.equal(card.dataset.dragging, 'true')
  await g.pointer(card, 'pointerup', -1000, 2000); assert.equal(card.dataset.dragging, 'false'); assert.deepEqual(f.mutations(), [])
  await g.resize(200, 130); assert.equal(card.style.left, '8px'); assert.equal(card.style.top, '10px')
  await f.render({ seat: 'B' }); card = f.container('seat').querySelector('[data-qyt-computer-inline]')
  assert.equal(card.style.left, '8px'); assert.equal(card.style.top, '10px'); assert.equal(card.dataset.dragging, 'false')
  assert.deepEqual(f.mutations(), [])
})

test('human takeover leaves the entire canvas free; only the grip drags, keyboard nudges clamp and blur cancels capture', async t => {
  const f = await fixture(t), g = installGeometry(f); f.states.set('A', snapshot('A', 'humanControl')); await f.render({ seat: 'A' })
  const card = f.container('seat').querySelector('[data-qyt-computer-inline]'), frame = card.querySelector('iframe'), grip = f.button('seat', '拖动电脑小预览')
  assert.equal(card.querySelector('.qyt-computer-inline-drag-surface'), null)
  const original = { left: card.style.left, top: card.style.top }
  await g.pointer(frame, 'pointerdown', 20, 30); await g.pointer(card, 'pointermove', 200, 200); await g.pointer(card, 'pointerup', 200, 200)
  assert.equal(card.style.left, original.left); assert.equal(card.style.top, original.top)
  await g.pointer(grip, 'pointerdown', 500, 100); await g.pointer(card, 'pointermove', 510, 120)
  assert.equal(card.style.left, '470px'); assert.equal(card.style.top, '70px')
  await act(async () => { f.dom.window.dispatchEvent(new f.dom.window.Event('blur')); await settle() }); assert.equal(card.dataset.dragging, 'false')
  await g.pointer(card, 'pointermove', 600, 300); assert.equal(card.style.left, '470px')
  await act(async () => { grip.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })); await settle() })
  assert.equal(card.style.left, '492px'); assert.deepEqual(f.mutations(), [])
})

test('hidden controls restore on unpressed re-entry or keyboard focus and cannot follow another chat', async t => {
  const f = await fixture(t); f.states.set('A', snapshot('A', 'humanControl')); f.states.set('B', snapshot('B', 'humanControl')); await f.render({ seat: 'A' })
  let card = f.container('seat').querySelector('[data-qyt-computer-inline]'); const frame = card.querySelector('iframe')
  await f.click('seat', '隐藏预览控件'); assert.equal(card.dataset.controlsHidden, 'true')
  const enter = buttons => act(async () => { card.dispatchEvent(new f.dom.window.MouseEvent('pointerover', { bubbles: true, buttons, relatedTarget: null })); await settle() })
  await enter(1); assert.equal(card.dataset.controlsHidden, 'true', 'A returning held drag cannot re-cover the target pixels')
  await enter(0); assert.equal(card.dataset.controlsHidden, 'false')
  await f.click('seat', '隐藏预览控件')
  await act(async () => { f.button('seat', '拖动电脑小预览').focus(); await settle() })
  assert.equal(card.dataset.controlsHidden, 'false', 'Keyboard focus restores the same live controls')
  await f.click('seat', '隐藏预览控件'); assert.equal(card.querySelector('iframe'), frame)
  await f.render({ seat: 'B' }); card = f.container('seat').querySelector('[data-qyt-computer-inline]')
  assert.equal(card.dataset.controlsHidden, 'false')
  assert.deepEqual(f.mutations(), [])
})

test('a macOS browser request uses its own browser preflight and one real DOM approval click never inherits local TCC', async t => {
  const f = await fixture(t); f.states.clear()
  f.native.value = { platform: 'darwin', mode: 'local', available: true, permissions: { screenRecording: false, accessibility: false, postEvents: false } }
  f.requests.set('request-A', approval('A', { preflight: { platform: 'darwin', mode: 'browser', available: true, permissions: {} } }))
  await f.render({ seat: 'A' })
  assert.equal(f.button('seat', '允许一次').disabled, false)
  assert.equal(f.button('seat', '始终允许').disabled, false)
  assert.equal(f.container('seat').querySelector('[aria-label="系统权限引导"]'), null)
  const once = f.button('seat', '允许一次')
  await act(async () => { once.click(); once.click(); await settle() })
  assert.deepEqual(f.mutations(), [{ op: 'decide', sessionId: 'A', requestId: 'request-A', requestVersion: 1, decision: 'once' }])
  assert.ok(f.container('seat').querySelector('iframe'))
})

test('a native macOS request missing TCC stays blocked even when current global status belongs to a browser', async t => {
  const f = await fixture(t); f.states.clear()
  f.native.value = { platform: 'darwin', mode: 'browser', available: true, permissions: {} }
  f.requests.set('request-A', approval('A', { preflight: { platform: 'darwin', mode: 'local', available: true, permissions: {} } }))
  await f.render({ seat: 'A' })
  assert.equal(f.button('seat', '允许一次').disabled, true); assert.equal(f.button('seat', '始终允许').disabled, true)
  assert.ok(f.container('seat').querySelector('[aria-label="系统权限引导"]'))
  await f.click('seat', '允许一次'); assert.deepEqual(f.mutations(), [])
  await f.click('seat', '拒绝'); assert.deepEqual(f.mutations(), [{ op: 'decide', sessionId: 'A', requestId: 'request-A', requestVersion: 1, decision: 'deny' }])
})

test('simultaneous browser and remote-native approvals retain each request preflight and exact Session routing', async t => {
  const f = await fixture(t); f.states.clear(); f.native.value = { platform: 'win32', mode: 'local', available: true }
  f.requests.set('request-A', approval('A', { preflight: { platform: 'darwin', mode: 'browser', available: true, permissions: {} } }))
  f.requests.set('request-B', approval('B', { preflight: { platform: 'darwin', mode: 'remote', available: true, permissions: { screenRecording: false, accessibility: false } } }))
  await f.render({ browser: 'A', remote: 'B' })
  assert.equal(f.button('browser', '允许一次').disabled, false); assert.equal(f.container('browser').querySelector('[aria-label="系统权限引导"]'), null)
  assert.equal(f.button('remote', '允许一次').disabled, true); assert.equal(f.button('remote', '始终允许').disabled, true)
  assert.match(f.container('remote').textContent, /请在独立电脑上开启以下权限/u)
  assert.equal(f.button('remote', '前往开启屏幕录制'), undefined)
  await f.click('browser', '允许一次'); assert.equal(f.requests.has('request-B'), true)
  assert.deepEqual(f.mutations(), [{ op: 'decide', sessionId: 'A', requestId: 'request-A', requestVersion: 1, decision: 'once' }])
})

test('request-scoped native permission refresh keeps postEvents refusal and later unlocks only that request', async t => {
  const f = await fixture(t); f.states.clear(); f.native.value = { platform: 'darwin', mode: 'browser', available: true }
  const preflight = { platform: 'darwin', mode: 'local', permissions: { screenRecording: true, accessibility: true, postEvents: false, inputMonitoring: false } }
  f.requests.set('request-A', approval('A', { preflight })); await f.render({ seat: 'A' })
  assert.equal(f.button('seat', '允许一次').disabled, true)
  f.requests.get('request-A').preflight.permissions.postEvents = true; await f.click('seat', '刷新权限')
  assert.equal(f.button('seat', '允许一次').disabled, false); assert.match(f.container('seat').textContent, /建议开启输入监控/u)
  await f.click('seat', '始终允许'); assert.deepEqual(f.mutations(), [{ op: 'decide', sessionId: 'A', requestId: 'request-A', requestVersion: 1, decision: 'always' }])
})
