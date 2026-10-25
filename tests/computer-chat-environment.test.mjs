import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import React, { act, useSyncExternalStore } from 'react'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'

// Initialize ReactDOM's input support against a real DOM before the per-test
// documents are installed. Otherwise focus activates its obsolete IE shim.
const detection = new JSDOM(''), detectionGlobals = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.assign(globalThis, { window: detection.window, document: detection.window.document })
const { createRoot } = await import('react-dom/client')
detection.window.close()
for (const [key, descriptor] of detectionGlobals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]

const require = createRequire(import.meta.url), { Simulate } = require('react-dom/test-utils')
let renderer
new Function('window', await readFile(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8'))({ __ModuleLoader__: { load(entry) { renderer = entry.factory(require) } } })
const { SlotRegistry } = renderer
const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/chat-environment.tsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })).outputFiles[0].text
const slot = 'conversation.input.left', endpoint = 'qiuya-tools.computer.control'
const settle = () => new Promise(done => setImmediate(done))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const readyPreferences = { status: 'ready', value: { enabled: true, computerUseEnabled: true } }

async function fixture(t, { initial = readyPreferences } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1/' })
  const saved = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const scheduled = new Map(), subscribers = new Set(), calls = [], plans = [], unresolved = new Set(), environments = new Map(), sessions = new Map()
  let preferences = initial, timerId = 0, disposeFeature, declarationInjection, featureInjection, rootMounted = true, globalSeatReads = 0
  const clock = {
    setTimeout(callback, milliseconds) { assert.equal(milliseconds, 3000, 'only the environment status polling clock is controlled'); const id = ++timerId; scheduled.set(id, callback); return id },
    clearTimeout(id) { scheduled.delete(id) },
  }
  const primitives = {
    MenuSurface: React.forwardRef(function Surface(props, ref) { return React.createElement('div', { ...props, ref }) }),
    useAnchoredPosition: () => ({ left: 12, top: 12 }),
    // Positioning/outside-pointer integration is exercised in the actual
    // browser suite; this suite retains the real component and SlotRegistry.
    useDismissOnOutsidePointer() {},
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', source)(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(id), module, module.exports, clock.setTimeout, clock.clearTimeout)
  const form = { getSnapshot: () => preferences, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener) } }
  const stateFor = sessionId => {
    if (!sessions.has(sessionId)) sessions.set(sessionId, { session: { removed: false, subagent: null, openState: 'open' }, input: { phase: 'plain' }, listeners: new Set() })
    return sessions.get(sessionId)
  }
  const status = () => ({ native: { available: true, platform: 'win32' }, environments: [...environments].map(([sessionId, mode]) => ({ sessionId, mode })) })
  const connection = { rpc: { async call(channel, method, input, signal) {
    assert.equal(channel, '/api'); assert.equal(method, endpoint)
    assert.ok(['A', 'B'].includes(input.sessionId), 'every request must use its public slot Session, never the global current seat')
    calls.push({ input: structuredClone(input), signal })
    const index = plans.findIndex(row => row.op === input.op && row.sessionId === input.sessionId)
    if (index >= 0) return plans.splice(index, 1)[0].pending.promise // Deliberately ignore abort, testing late-response fences.
    if (input.op === 'status') return { ok: true, value: status() }
    assert.equal(input.op, 'connect', 'mount, disable and disposal must never stop a background task')
    environments.set(input.sessionId, input.mode)
    return { ok: true, value: { available: true, mode: input.mode } }
  } } }
  const ctx = new Context(), registryPlugin = ctx.plugin(SlotRegistry); await registryPlugin.await()
  const peerPlugin = ctx.plugin(child => {
    child.provide('connection', connection)
    child.provide('uiSession', { adapter: { current: { getSnapshot() { globalSeatReads++; return { key: 'GLOBAL-WRONG-SESSION' } }, subscribe() { throw Error('The global current seat must not be observed by a Session slot') } } } })
  }); await peerPlugin.await()
  const declarationPlugin = ctx.plugin(child => {
    declarationInjection = child.inject(['slots'], active => {
      active.slots.register({ name: 'root', children: { [slot]: { kind: 'list', scope: 'session' } } }, () => null)
      active.slots.register({ name: slot, id: 'official-existing-control', order: 1 }, () => React.createElement('span', { 'data-official-control': true }, 'Official control'))
    })
  }); await declarationPlugin.await(); await declarationInjection.await()
  const featurePlugin = ctx.plugin(child => {
    featureInjection = child.inject(['slots', 'connection'], active => { disposeFeature = module.exports.installChatComputerEnvironment(active, form) })
  }); await featurePlugin.await(); await featureInjection.await()
  const registry = ctx.get('slots'), root = createRoot(dom.window.document.querySelector('#root'))
  function PublicSlotOccurrence({ sessionId }) {
    const entries = useSyncExternalStore(listener => registry.subscribe(slot, listener), () => registry.entries(slot), () => registry.entries(slot))
    const state = stateFor(sessionId)
    const useSession = select => useSyncExternalStore(listener => { state.listeners.add(listener); return () => state.listeners.delete(listener) }, () => select(state.session), () => select(state.session))
    const useInput = select => useSyncExternalStore(listener => { state.listeners.add(listener); return () => state.listeners.delete(listener) }, () => select(state.input), () => select(state.input))
    return React.createElement(React.Fragment, {}, entries.map(entry => React.createElement(entry.component, { key: entry.options.id, sessionId, useSession, useInput })))
  }
  const render = seats => act(async () => { root.render(React.createElement(React.Fragment, {}, ...Object.entries(seats).map(([seat, sessionId]) => React.createElement('div', { key: seat, 'data-seat': seat }, React.createElement(PublicSlotOccurrence, { sessionId }))))); await settle() })
  const container = seat => dom.window.document.querySelector(`[data-seat="${seat}"]`)
  const trigger = seat => container(seat)?.querySelector('[aria-haspopup="dialog"]')
  const panel = sessionId => dom.window.document.querySelector(`[data-qyt-environment-session="${sessionId}"]`)
  const click = async node => { assert.ok(node, 'the requested control must exist'); await act(async () => { node.click(); await settle() }) }
  const open = async seat => { await click(trigger(seat)); assert.equal(trigger(seat).getAttribute('aria-expanded'), 'true') }
  const choose = async (sessionId, mode) => click(panel(sessionId)?.querySelector(`input[type="radio"][value="${mode}"]`))
  const submit = async sessionId => { const form = panel(sessionId)?.querySelector('form'); assert.ok(form); await act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await settle() }) }
  const edit = async (sessionId, label, value) => {
    const input = [...panel(sessionId).querySelectorAll('label')].find(row => row.firstChild?.textContent === label)?.querySelector('input,textarea')
    assert.ok(input, `Field ${label} must exist`)
    await act(async () => { Simulate.change(input, { target: { value } }); await settle() })
  }
  const plan = (op, sessionId) => { const pending = deferred(); unresolved.add(pending); plans.push({ op, sessionId, pending }); return pending }
  const mutations = () => calls.filter(row => row.input.op !== 'status').map(row => row.input)
  const updatePreferences = async value => act(async () => { preferences = value; for (const listener of subscribers) listener(); await settle() })
  const updateSession = async (sessionId, { session, input }) => act(async () => {
    const state = stateFor(sessionId); if (session) state.session = { ...state.session, ...session }; if (input) state.input = { ...state.input, ...input }
    for (const listener of [...state.listeners]) listener(); await settle()
  })
  const poll = async () => act(async () => { const callbacks = [...scheduled.values()]; scheduled.clear(); await Promise.all(callbacks.map(callback => callback())); await settle() })
  t.after(async () => {
    for (const pending of unresolved) pending.resolve({ ok: false, error: { message: 'Fixture disposed' } })
    await act(async () => { await featurePlugin.dispose(); await settle(); if (rootMounted) { root.unmount(); rootMounted = false } })
    await declarationPlugin.dispose(); await peerPlugin.dispose(); await registryPlugin.dispose(); dom.window.close()
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
  })
  return { dom, registry, calls, scheduled, subscribers, environments, status, render, container, trigger, panel, click, open, choose, submit, edit, plan, mutations, updatePreferences, updateSession, poll,
    get globalSeatReads() { return globalSeatReads },
    async disposeSlot() { await act(async () => { disposeFeature(); await settle() }) },
    async unmount() { await act(async () => { root.unmount(); rootMounted = false; await settle() }) },
  }
}

test('the additive public composer slot keeps official controls and reads each Session without connecting or consulting the global seat', async t => {
  const f = await fixture(t)
  f.environments.set('A', 'browser'); f.environments.set('B', 'remote'); f.environments.set(undefined, 'local')
  await f.render({ left: 'A', right: 'B' })
  assert.deepEqual(f.registry.entries(slot).map(entry => entry.options.id), ['official-existing-control', 'qiuya-tools-computer-environment'])
  assert.equal(f.trigger('left').getAttribute('aria-label'), '操作环境：独立浏览器')
  assert.equal(f.trigger('right').getAttribute('aria-label'), '操作环境：远端电脑')
  assert.deepEqual(f.calls.map(row => row.input), [{ op: 'status', sessionId: 'A' }, { op: 'status', sessionId: 'B' }])
  assert.deepEqual(f.mutations(), []); assert.equal(f.globalSeatReads, 0); assert.equal(f.scheduled.size, 2)
  assert.equal(f.dom.window.document.querySelector('[role="dialog"]'), null)
})

test('a confirmed environment change carries only the public slot Session and refreshes its own label', async t => {
  const f = await fixture(t); await f.render({ left: 'A', right: 'B' }); await f.open('left'); await f.choose('A', 'remote')
  await f.edit('A', '配对地址', 'https://synthetic-a.invalid/v1/computer'); await f.edit('A', '配对密钥', 'synthetic-a-pair')
  assert.deepEqual(f.mutations(), [], 'opening a menu and preparing a draft never connects')
  await f.submit('A')
  assert.deepEqual(f.mutations(), [{ op: 'connect', sessionId: 'A', mode: 'remote', endpoint: 'https://synthetic-a.invalid/v1/computer', token: 'synthetic-a-pair', allowPrivateNetwork: false }])
  assert.equal(f.trigger('left').getAttribute('aria-label'), '操作环境：远端电脑'); assert.equal(f.trigger('right').getAttribute('aria-label'), '操作环境：这台电脑')
  assert.equal(f.panel('A'), null); assert.equal(f.dom.window.document.activeElement, f.trigger('left'))
})

test('a late status from the former Session is aborted and cannot replace a new Session environment', async t => {
  const f = await fixture(t), previous = f.plan('status', 'A'); f.environments.set('B', 'browser')
  await f.render({ seat: 'A' }); const oldRequest = f.calls[0]
  await f.render({ seat: 'B' }); assert.equal(oldRequest.signal.aborted, true)
  await act(async () => { previous.resolve({ ok: true, value: { environments: [{ sessionId: 'B', mode: 'remote' }] } }); await settle() })
  assert.equal(f.trigger('seat').getAttribute('aria-label'), '操作环境：独立浏览器'); assert.equal(f.scheduled.size, 1)
  assert.deepEqual(f.mutations(), [])
})

test('disabling closes open menus and polling without stopping background work; enabling reads the saved Session environments', async t => {
  const f = await fixture(t); f.environments.set('A', 'remote'); await f.render({ left: 'A', right: 'B' }); await f.open('left')
  const activeStatusSignals = f.calls.filter(row => row.input.op === 'status').map(row => row.signal)
  await f.updatePreferences({ status: 'ready', value: { enabled: true, computerUseEnabled: false } })
  assert.equal(f.dom.window.document.querySelector('[role="dialog"]'), null); assert.equal(f.trigger('left'), null); assert.equal(f.scheduled.size, 0)
  assert.ok(activeStatusSignals.every(signal => signal.aborted)); assert.deepEqual(f.mutations(), [])
  await f.updatePreferences(readyPreferences)
  assert.equal(f.trigger('left').getAttribute('aria-label'), '操作环境：远端电脑'); assert.equal(f.scheduled.size, 2); assert.deepEqual(f.mutations(), [])
})

for (const lock of [{ name: 'adjudicating input', input: { phase: 'adjudicating' } }, { name: 'submitting input', input: { phase: 'submitting' } }, { name: 'removed Session', session: { removed: true } }, { name: 'subagent Session', session: { subagent: { address: { mode: 'continuable' } } } }]) test(`${lock.name} locks the selector, closes its menu and cannot dispatch an environment change`, async t => {
  const f = await fixture(t); await f.render({ seat: 'A' }); await f.open('seat')
  await f.updateSession('A', lock)
  assert.equal(f.trigger('seat').disabled, true); assert.equal(f.panel('A'), null); assert.equal(f.scheduled.size, 0)
  await f.click(f.trigger('seat')); assert.equal(f.panel('A'), null); assert.deepEqual(f.mutations(), [])
})

for (const outcome of ['success', 'error']) test(`a late ${outcome} connection for old A cannot close B's menu, refresh A or dispatch B`, async t => {
  const f = await fixture(t); await f.render({ seat: 'A' }); await f.open('seat'); const previous = f.plan('connect', 'A')
  await f.submit('A'); const oldCall = f.calls.find(row => row.input.op === 'connect')
  await f.render({ seat: 'B' }); assert.equal(oldCall.signal.aborted, true); await f.open('seat'); await f.choose('B', 'browser'); await f.edit('B', '允许的网站来源（每行一个）', 'https://synthetic-b.invalid')
  const callCount = f.calls.length
  await act(async () => { previous.resolve(outcome === 'success' ? { ok: true, value: { available: true, mode: 'local' } } : { ok: false, error: { message: 'OLD_A_CONNECTION_FAILED' } }); await settle() })
  assert.equal(f.calls.length, callCount); assert.ok(f.panel('B')); assert.equal(f.trigger('seat').getAttribute('aria-expanded'), 'true')
  assert.equal(f.panel('B').querySelector('input[value="browser"]').checked, true)
  assert.equal(f.panel('B').querySelector('textarea').value, 'https://synthetic-b.invalid'); assert.equal(f.panel('B').querySelector('[role="alert"]'), null)
  assert.deepEqual(f.mutations(), [{ op: 'connect', sessionId: 'A', mode: 'local' }])
})

test('Escape closes only the environment popover and returns focus to its own trigger', async t => {
  const f = await fixture(t); await f.render({ seat: 'A' }); await f.open('seat')
  assert.equal(f.dom.window.document.activeElement, f.panel('A').closest('[role="dialog"]'))
  const event = new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => { f.dom.window.document.activeElement.dispatchEvent(event); await settle() })
  assert.equal(event.defaultPrevented, true); assert.equal(f.panel('A'), null); assert.equal(f.dom.window.document.activeElement, f.trigger('seat'))
  assert.deepEqual(f.mutations(), [])
})

for (const keyboard of [{ isComposing: true }, { keyCode: 229 }]) test(`an IME Escape (${Object.keys(keyboard)[0]}) leaves the environment draft open and lets the input method handle the event`, async t => {
  const f = await fixture(t); await f.render({ seat: 'A' }); await f.open('seat'); await f.choose('A', 'remote')
  await f.edit('A', '配对地址', 'https://synthetic-ime.invalid/v1/computer'); await f.edit('A', '配对密钥', 'synthetic-ime-pair')
  const input = f.panel('A').querySelector('input[type="url"]'); input.focus()
  let propagated = false
  const onKey = () => { propagated = true }
  f.dom.window.addEventListener('keydown', onKey, { once: true })
  const event = new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...keyboard })
  await act(async () => { input.dispatchEvent(event); await settle() })
  assert.equal(event.defaultPrevented, false); assert.equal(propagated, true)
  assert.equal(f.trigger('seat').getAttribute('aria-expanded'), 'true'); assert.equal(f.dom.window.document.activeElement, input)
  assert.equal(f.panel('A').querySelector('input[type="url"]').value, 'https://synthetic-ime.invalid/v1/computer')
  assert.equal(f.panel('A').querySelector('input[type="password"]').value, 'synthetic-ime-pair'); assert.deepEqual(f.mutations(), [])
})

test('disposing unregisters only this additive control and releases polls and subscriptions without owner mutations', async t => {
  const f = await fixture(t); await f.render({ left: 'A', right: 'B' }); await f.open('left')
  assert.equal(f.subscribers.size, 2)
  await f.disposeSlot()
  assert.deepEqual(f.registry.entries(slot).map(entry => entry.options.id), ['official-existing-control'])
  assert.equal(f.dom.window.document.querySelectorAll('[data-official-control]').length, 2)
  assert.equal(f.dom.window.document.querySelector('[role="dialog"]'), null); assert.equal(f.subscribers.size, 0); assert.equal(f.scheduled.size, 0)
  assert.deepEqual(f.mutations(), []); await f.disposeSlot(); assert.deepEqual(f.mutations(), [])
})

test('unmount aborts an in-flight status and ignores its eventual result without renewing its poll', async t => {
  const f = await fixture(t), pending = f.plan('status', 'A'); await f.render({ seat: 'A' }); const signal = f.calls[0].signal
  await f.unmount(); assert.equal(signal.aborted, true); assert.equal(f.subscribers.size, 0)
  await act(async () => { pending.resolve({ ok: true, value: { environments: [{ sessionId: 'A', mode: 'remote' }] } }); await settle() })
  assert.equal(f.scheduled.size, 0); assert.equal(f.dom.window.document.querySelector('[data-qyt-computer-environment]'), null); assert.deepEqual(f.mutations(), [])
})

test('loading and master-disabled preferences never read status or mount an environment selector', async t => {
  const f = await fixture(t, { initial: { status: 'loading', value: undefined } }); await f.render({ seat: 'A' })
  assert.deepEqual(f.calls, []); assert.equal(f.trigger('seat'), null)
  await f.updatePreferences({ status: 'ready', value: { enabled: false, computerUseEnabled: true } })
  assert.deepEqual(f.calls, []); assert.equal(f.trigger('seat'), null)
  await f.updatePreferences(readyPreferences); assert.deepEqual(f.calls.map(row => row.input), [{ op: 'status', sessionId: 'A' }]); assert.ok(f.trigger('seat'))
})
