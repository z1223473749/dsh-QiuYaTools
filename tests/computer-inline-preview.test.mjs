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
  const scheduled = new Map(), subscribers = new Set(), calls = [], planned = [], states = new Map([['A', snapshot('A')], ['B', snapshot('B', 'running')]]), detached = new Map()
  let sequence = 0, preferences = initial, disposeFeature, declarationInjection, featureInjection
  const clock = { setTimeout(callback, milliseconds) { assert.equal(milliseconds, 1200, 'only the component polling clock is controlled'); const id = ++sequence; scheduled.set(id, callback); return id }, clearTimeout(id) { scheduled.delete(id) } }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', source)(require, module, module.exports, clock.setTimeout, clock.clearTimeout)
  const form = { getSnapshot: () => preferences, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener) } }
  const status = () => ({ sessions: [...states.values()].map(value => structuredClone(value)), environments: [...states.keys()].map(sessionId => ({ sessionId, previewDetached: detached.get(sessionId) === true })) })
  const connection = { rpc: { async call(channel, method, input, signal) {
    assert.equal(channel, '/api'); assert.equal(method, endpoint)
    const call = { input: structuredClone(input), signal }; calls.push(call)
    const index = planned.findIndex(row => row.op === input.op && row.sessionId === input.sessionId)
    if (index >= 0) return planned.splice(index, 1)[0].pending.promise // Deliberately ignores abort to exercise fencing.
    if (input.op === 'status') return { ok: true, value: status() }
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
  return { dom, registry, calls, states, detached, status, render, container, button, click, plan, mutations, updatePreferences, poll, scheduled, subscribers,
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
  assert.match(f.container('right').textContent, /正在操作/u); assert.equal(f.button('left', '继续电脑任务').disabled, false)
  await f.click('left', '继续电脑任务'); await f.click('right', '接管电脑任务'); await f.click('right', '停止电脑任务')
  assert.deepEqual(f.mutations(), [{ op: 'pause', sessionId: 'A' }, { op: 'resume', sessionId: 'A' }, { op: 'takeover', sessionId: 'B' }, { op: 'stop', sessionId: 'B' }])
  assert.ok(f.container('left').querySelector('iframe')); assert.equal(f.container('right').querySelector('iframe'), null)
})

test('detach shows a placeholder and redock restores the inline view without stop; collapse restores the same chat', async t => {
  const f = await fixture(t); await f.render({ left: 'A', right: 'B' })
  const rightFrame = f.container('right').querySelector('iframe')
  await f.click('left', '弹出电脑预览')
  assert.equal(f.container('left').querySelector('iframe'), null); assert.match(f.container('left').textContent, /预览已弹出/u)
  assert.equal(f.container('right').querySelector('iframe'), rightFrame)
  await f.click('left', '收回到聊天')
  assert.equal(new URL(f.container('left').querySelector('iframe').src).searchParams.get('session'), 'A')
  await f.click('left', '收起电脑实时预览')
  assert.equal(f.container('left').querySelector('iframe'), null); assert.equal(f.button('left', '显示电脑实时预览').getAttribute('aria-expanded'), 'false')
  await f.click('left', '显示电脑实时预览')
  assert.ok(f.container('left').querySelector('iframe')); assert.equal(f.button('left', '收起电脑实时预览').getAttribute('aria-expanded'), 'true')
  assert.deepEqual(f.mutations(), [{ op: 'preview', sessionId: 'A' }, { op: 'redock', sessionId: 'A' }])
})

test('a late status from the old session is aborted and cannot replace the new chat or its detached state', async t => {
  const f = await fixture(t), old = f.plan('status', 'A')
  await f.render({ seat: 'A' }); const oldCall = f.calls[0]
  assert.equal(f.container('seat').querySelector('iframe'), null)
  f.detached.set('B', true); await f.render({ seat: 'B' })
  assert.equal(oldCall.signal.aborted, true); assert.match(f.container('seat').textContent, /Target B/u)
  await act(async () => { old.resolve({ ok: true, value: { sessions: [snapshot('A')], environments: [{ sessionId: 'A', previewDetached: false }] } }); await settle() })
  assert.equal(f.container('seat').querySelector('[data-qyt-computer-chat]').dataset.qytComputerChat, 'B')
  assert.match(f.container('seat').textContent, /Target B/u); assert.match(f.container('seat').textContent, /预览已弹出/u)
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
  assert.equal(f.button('seat', '暂停电脑任务').disabled, false); assert.match(f.container('seat').textContent, /你正在接管/u)
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
  assert.match(f.container('left').textContent, /已暂停/u); assert.match(f.container('right').textContent, /正在操作/u)
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
