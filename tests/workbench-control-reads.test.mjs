import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url)), entry = join(repository, 'src/features/workbench/client.tsx')
const compiled = (await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', external: ['react', 'react-dom'], plugins: [{ name: 'original-control-read-regression', setup(builder) { builder.onLoad({ filter: /\/workbench\/client\.tsx$/ }, async () => {
  let contents = await readFile(entry, 'utf8')
  // Test-only red proof: the original inline control called ordinary mutate,
  // without a target read fence. No production file is rewritten by this mode.
  if (process.env.QYT_STOP_READ_BASELINE === '1') contents = contents.replace(', { target: displayed, operation })', ')').replace(', { target: selected, operation })', ')')
  return { contents, loader: 'tsx' }
}) } }] })).outputFiles[0].text
const directory = await mkdtemp('/private/tmp/qyt-control-read-unit-')
await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'), 'dir')
await writeFile(join(directory, 'runtime.mjs'), compiled)
const { WorkbenchInline, WorkbenchTab } = await import(pathToFileURL(join(directory, 'runtime.mjs')).href)
test.after(() => rm(directory, { recursive: true, force: true }))
const turn = () => new Promise(done => setImmediate(done))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const view = (name, chat = 'chat-A') => ({ chatSessionId: chat, environmentId: randomUUID(), workbenchTabId: randomUUID(), kind: 'desktop', targetId: 'own-' + name, appId: 'own-app-' + name, epoch: 1, title: name, state: 'ready' })
const frame = target => ({ target, viewOnly: true, observation: { targetId: target.targetId, frameId: randomUUID(), imageBase64: target.title === 'A' ? 'QUFBQQ==' : 'QkJCQg==', mediaType: 'image/jpeg', width: 100, height: 100, elements: '', geometry: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } })
const snapshot = views => ({ views, pendingRequests: [], environments: [], allowedOrigins: [] })

async function fixture(t, { detached = false, both = false, detachedEpoch = 1, holdFirstPreview = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://test-owned.invalid/' }), previous = new Map()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { constructor(fn) { this.fn = fn } observe() { this.fn() } disconnect() {} } })) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 180, right: 300, bottom: 180, x: 0, y: 0, toJSON() { return {} } })
  const a = view('A'), b = view('B'), previews = [], controls = [], statuses = [], root = createRoot(dom.window.document.getElementById('root'))
  const api = {
    status(chat, signal) { const response = deferred(); statuses.push({ chat, signal, ...response }); if (!detached && statuses.length === 1) response.resolve(snapshot([b, a])); return response.promise },
    async preview(target, signal) { const response = deferred(); previews.push({ target, signal, ...response }); if (!holdFirstPreview || previews.length > 1) response.resolve(frame(target)); return response.promise },
    control(target, operation, signal) { const response = deferred(); controls.push({ target, operation, signal, ...response }); return response.promise },
    async navigation() { return { canGoBack: false, canGoForward: false } },
  }
  let selectedChat = 'chat-A', resource = { status: 'live', value: { target: { ...a, epoch: detachedEpoch } } }, showInline = !detached || both, showDetached = detached || both
  let formState = { status: 'ready', value: { enabled: true, computerUseEnabled: true } }
  const listeners = new Set(), form = { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => formState }
  const nativeCall = async () => ({ pendingRequests: [] }), current = chat => chat === selectedChat, info = { tab: { id: 'own-tab', visible: true, signal: new AbortController().signal, navigation: { address: `dsh-resource://qiuya-workbench/chat-A/${a.workbenchTabId}`, revision: 1 }, actions: { bindCommands() { return () => {} }, close() {}, openResource() {} } }, panel: { id: 'own-panel' } }
  const props = kind => kind ? { sessionId: selectedChat, api, current, form, useTabInfo: () => info, useResource: () => resource, open() {}, refresh() {}, float() {}, dock() {}, split() {}, binding() {} } : { sessionId: selectedChat, api, current, form, nativeCall, open() {} }
  const render = async () => { await act(async () => { root.render(React.createElement(React.Fragment, null, showInline && React.createElement(WorkbenchInline, { ...props(false), key: 'inline' }), showDetached && React.createElement(WorkbenchTab, { ...props(true), key: 'detached' }))); await turn() }) }
  await render()
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] })
  return { a, b, api, previews, controls, statuses, dom,
    async tick(ms = 100) { await act(async () => { t.mock.timers.tick(ms); await turn() }) },
    async resolve(job, value) { await act(async () => { job.resolve(value); await turn() }) },
    async reject(job, error = Error('UNKNOWN_CONTROL_RESULT')) { await act(async () => { job.reject(error); await turn() }) },
    async click(label, scope) { const root = scope ? dom.window.document.querySelector(scope) : dom.window.document; assert.ok(root, scope); const button = [...root.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('title') === label); assert.ok(button, label); assert.equal(button.disabled, false, label); await act(async () => { button.click(); await turn() }) },
    async select(target) { const button = [...dom.window.document.querySelectorAll('[role="tab"]')].find(node => node.getAttribute('title') === target.title); assert.ok(button); assert.equal(button.disabled, false); await act(async () => { button.click(); await turn() }) },
    async chat(chat, target) { selectedChat = chat; if (target) resource = { status: 'live', value: { target } }; await render() },
    async resource(target) { resource = { status: 'live', value: { target } }; await render() },
    async navigate(target) { info.tab.navigation = { address: `dsh-resource://qiuya-workbench/${target.chatSessionId}/${target.workbenchTabId}`, revision: info.tab.navigation.revision + 1 }; resource = { status: 'live', value: { target } }; await render() },
    async enabled(value) { await act(async () => { formState = { ...formState, value: { ...formState.value, computerUseEnabled: value } }; for (const listener of listeners) listener(); await turn() }) },
    async hideInline() { showInline = false; await render() },
    async hideDetached() { showDetached = false; await render() },
  }
}

test('inline stop entry cancels its exact read immediately; after ACK no old poll restarts while fresh status is slow and sibling B continues', async t => {
  const f = await fixture(t), first = f.previews.at(-1)
  assert.equal(first.target.targetId, f.a.targetId)
  await f.click('停止'); assert.equal(first.signal.aborted, true)
  const before = f.previews.filter(row => row.target.targetId === f.a.targetId).length
  await f.tick(1000); assert.equal(f.previews.filter(row => row.target.targetId === f.a.targetId).length, before)
  await f.resolve(f.controls[0], {})
  assert.equal(f.statuses.length, 2); assert.equal(f.controls.length, 1)
  await f.tick(1000)
  assert.equal(f.previews.filter(row => row.target.targetId === f.a.targetId).length, before)
  assert.ok(f.previews.some(row => row.target.targetId === f.b.targetId), 'Confirmed stop removes only A so B can keep previewing before slow status returns')
  await f.resolve(f.statuses[1], snapshot([f.b])); await f.tick(100)
  assert.equal(f.previews.at(-1).target.targetId, f.b.targetId)
})

test('an older status completed after control and a fresh read cannot resurrect the confirmed stopped inline view', async t => {
  const f = await fixture(t); await f.tick(1200); const older = f.statuses[1]
  await f.click('停止'); await f.resolve(f.controls[0], {})
  const fresh = f.statuses.at(-1); assert.notEqual(fresh, older)
  await f.resolve(fresh, snapshot([f.b])); const before = f.previews.filter(row => row.target.targetId === f.a.targetId).length
  await f.resolve(older, snapshot([f.b, f.a])); await f.tick(1200)
  assert.equal(f.previews.filter(row => row.target.targetId === f.a.targetId).length, before)
  assert.equal(f.dom.window.document.querySelector('[title="A"]'), null)
})

test('unknown inline control preserves the view/error and blocks only A until fresh readonly status confirms reality; it never retries control', async t => {
  const f = await fixture(t); await f.click('停止'); const before = f.previews.filter(row => row.target.targetId === f.a.targetId).length
  await f.reject(f.controls[0]); assert.match(f.dom.window.document.body.textContent, /未能确认/u)
  assert.ok(f.dom.window.document.querySelector('[title="A"]'), 'An unknown outcome must not pretend A was stopped')
  await f.tick(500); assert.equal(f.previews.filter(row => row.target.targetId === f.a.targetId).length, before)
  await f.select(f.b); await f.tick(100); assert.equal(f.previews.at(-1).target.targetId, f.b.targetId)
  await f.resolve(f.statuses.at(-1), snapshot([f.b, { ...f.a, epoch: 2 }]))
  await f.select(f.a); await f.tick(100); assert.equal(f.previews.at(-1).target.epoch, 2)
  assert.equal(f.controls.length, 1); assert.match(f.dom.window.document.body.textContent, /未能确认/u)
})

test('changing chats or disabling the feature while control is pending cannot publish an old ACK or revive its preview', async t => {
  const f = await fixture(t); await f.click('停止'); const old = f.controls[0], before = f.previews.length
  await f.chat('chat-B'); await f.resolve(old, {}); await f.tick(1000)
  assert.equal(f.previews.length, before); assert.equal(f.dom.window.document.querySelector('[data-qyt-workbench-chat="chat-A"]'), null)
  await f.enabled(false); await f.resolve(f.statuses.at(-1), snapshot([f.a])); await f.tick(1000)
  assert.equal(f.previews.length, before); assert.equal(f.controls.length, 1)
})

for (const detached of [false, true]) test(`${detached ? 'detached' : 'inline'} same-chat feature disable aborts a pending control/read and ignores its late receipt`, async t => {
  const f = await fixture(t, { detached }); await f.click('停止'); const control = f.controls[0], before = f.previews.length
  await f.enabled(false); assert.equal(control.signal.aborted, true)
  await f.resolve(control, {}); await f.tick(1200)
  assert.equal(f.previews.length, before); assert.equal(f.controls.length, 1)
  assert.equal(f.statuses.length, detached ? 0 : 1, 'A disabled old control cannot issue a fresh verification call')
})

for (const detached of [false, true]) test(`${detached ? 'detached' : 'inline'} re-enabling the same chat accepts one new control after fresh status, without waiting for an old unknown ACK`, async t => {
  const f = await fixture(t, { detached }); await f.click('停止'); await f.enabled(false); await f.enabled(true)
  const fresh = f.statuses.at(-1); assert.ok(fresh)
  await f.resolve(fresh, snapshot([f.b, { ...f.a, epoch: 2 }]))
  if (!detached) await f.select(f.a)
  await f.click('停止'); assert.equal(f.controls.length, 2); assert.equal(f.controls[0].signal.aborted, true)
  assert.equal(f.controls[1].target.epoch, 2)
})

test('an explicitly rejected inline control and failed status keep only A blocked; readonly status retry can recover without another control', async t => {
  const f = await fixture(t); await f.click('停止'); await f.reject(f.controls[0], Object.assign(Error('fixture refusal'), { code: 'BROWSER_CLEANUP_FAILED' }))
  const count = f.previews.filter(row => row.target.targetId === f.a.targetId).length
  await f.reject(f.statuses.at(-1)); await f.select(f.b); await f.tick(1200)
  assert.equal(f.previews.filter(row => row.target.targetId === f.a.targetId).length, count)
  assert.equal(f.previews.at(-1).target.targetId, f.b.targetId); assert.equal(f.controls.length, 1)
  await f.resolve(f.statuses.at(-1), snapshot([f.b, { ...f.a, epoch: 2 }]))
  await f.select(f.a); assert.equal(f.previews.at(-1).target.epoch, 2)
})

test('detached stop immediately cancels its read and late old resource metadata cannot restart it while fresh status is slow or after retirement', async t => {
  const f = await fixture(t, { detached: true }), first = f.previews.at(-1)
  assert.equal(f.previews.length, 1, 'An unchanged pane render must not create a preview request storm')
  await f.tick(100); assert.equal(f.previews.length, 2)
  await f.click('停止'); assert.equal(first.signal.aborted, true)
  const count = f.previews.length; await f.resolve(f.controls[0], {}); assert.equal(f.statuses.length, 1)
  await f.resource({ ...f.a }); await f.tick(1000); assert.equal(f.previews.length, count)
  await f.resolve(f.statuses[0], snapshot([])); await f.resource({ ...f.a }); await f.tick(1000)
  assert.equal(f.previews.length, count); assert.match(f.dom.window.document.body.textContent, /已结束/u)
  await f.navigate(f.b); assert.equal(f.previews.at(-1).target.targetId, f.b.targetId); assert.equal(f.controls.length, 1)
})

test('detached unknown control retains the view and error, never retries, and only an independent fresh status permits reads again', async t => {
  const f = await fixture(t, { detached: true }); await f.click('停止'); await f.reject(f.controls[0])
  assert.match(f.dom.window.document.body.textContent, /未能确认/u)
  const count = f.previews.length; await f.resource({ ...f.a }); await f.tick(1000)
  assert.equal(f.previews.length, count); assert.doesNotMatch(f.dom.window.document.body.textContent, /此视图已结束/u)
  await f.resolve(f.statuses[0], snapshot([{ ...f.a, epoch: 2 }]))
  assert.equal(f.previews.at(-1).target.epoch, 2); await f.tick(1000)
  assert.equal(f.controls.length, 1); assert.match(f.dom.window.document.body.textContent, /未能确认/u)
})

for (const origin of ['inline', 'detached']) test(`shared exact-view read gate: ${origin} stop cancels both mounts and permanently stale higher-epoch resource cannot revive A while B continues`, async t => {
  const f = await fixture(t, { both: true, detachedEpoch: 2 }), initial = f.previews.filter(row => row.target.targetId === f.a.targetId)
  assert.equal(initial.length, 2); assert.deepEqual(initial.map(row => row.target.epoch).sort(), [1, 2])
  await f.click('停止', origin === 'inline' ? '.qyt-workbench-small' : '.qyt-workbench-pane')
  for (const read of initial) assert.equal(read.signal.aborted, true, 'Control entry cancels both mounts before its receipt')
  const before = f.previews.filter(row => row.target.targetId === f.a.targetId).length
  await f.tick(500); assert.equal(f.previews.filter(row => row.target.targetId === f.a.targetId).length, before)
  await f.resolve(f.controls[0], {}); await f.tick(500)
  assert.equal(f.previews.filter(row => row.target.targetId === f.a.targetId).length, before, 'A stale resource from before the ACK cannot prove a new view, regardless of epoch')
  assert.ok(f.previews.some(row => row.target.targetId === f.b.targetId), 'B remains independent of the stopped A')
  await f.resolve(f.statuses.at(-1), snapshot([f.b])); await f.resource({ ...f.a, epoch: 99 }); await f.tick(2500)
  assert.equal(f.previews.filter(row => row.target.targetId === f.a.targetId).length, before)
  assert.match(f.dom.window.document.querySelector('.qyt-workbench-pane').textContent, /已结束/u)
  assert.equal(f.controls.length, 1)
})

test('shared unknown result never pretends either pane stopped; independent fresh status restores both panes and B remains readable', async t => {
  const f = await fixture(t, { both: true, detachedEpoch: 2 }); await f.click('停止', '.qyt-workbench-small'); await f.reject(f.controls[0])
  const count = f.previews.filter(row => row.target.targetId === f.a.targetId).length
  assert.doesNotMatch(f.dom.window.document.querySelector('.qyt-workbench-pane').textContent, /此视图已结束/u)
  await f.resource({ ...f.a, epoch: 99 }); await f.select(f.b); await f.tick(500)
  assert.equal(f.previews.filter(row => row.target.targetId === f.a.targetId).length, count)
  assert.equal(f.previews.at(-1).target.targetId, f.b.targetId)
  await f.resolve(f.statuses.at(-1), snapshot([f.b, { ...f.a, epoch: 3 }]))
  await f.select(f.a); await f.tick(100)
  assert.ok(f.previews.filter(row => row.target.targetId === f.a.targetId && row.target.epoch === 3).length >= 2, 'Both mounts use the independently confirmed epoch instead of stale resource epoch 99')
  assert.equal(f.controls.length, 1)
})

test('an in-flight original frame arriving after stop cannot publish an image or restart the old poll', async t => {
  const f = await fixture(t, { holdFirstPreview: true }), original = f.previews[0]
  assert.equal(f.dom.window.document.querySelector('img'), null)
  await f.click('停止'); assert.equal(original.signal.aborted, true)
  await f.resolve(f.controls[0], {}); await f.resolve(original, frame(f.a)); await f.tick(500)
  assert.equal(f.previews.filter(row => row.target.targetId === f.a.targetId).length, 1)
  assert.ok([...f.dom.window.document.querySelectorAll('img')].every(image => !image.src.endsWith('QUFBQQ==')), 'Only the surviving B can publish a new frame')
})

for (const origin of ['inline', 'detached']) test(`unmounting the ${origin} control entry keeps its unknown result fenced; surviving pane can verify readonly reality without replaying control`, async t => {
  const f = await fixture(t, { both: true }); await f.click('停止', origin === 'inline' ? '.qyt-workbench-small' : '.qyt-workbench-pane')
  const old = f.controls[0], before = f.previews.length
  if (origin === 'inline') await f.hideInline(); else await f.hideDetached()
  assert.equal(old.signal.aborted, true)
  await f.tick(1200); const fresh = f.statuses.at(-1)
  assert.ok(f.statuses.length >= 2, 'The surviving pane obtains fresh status after the abandoned controller')
  assert.equal(f.previews.length, before, 'Unmount does not imply control success or release the preview fence')
  await f.resolve(fresh, snapshot([{ ...f.a, epoch: 2 }, f.b])); await f.resolve(old, {}); await f.tick(100)
  assert.equal(f.controls.length, 1)
  assert.ok(f.previews.some(row => row.target.targetId === f.a.targetId && row.target.epoch === 2) || f.previews.some(row => row.target.targetId === f.b.targetId))
})

test('a status issued while stop is still pending cannot release the exact-view read fence, while sibling B remains available', async t => {
  const f = await fixture(t, { both: true }); await f.click('停止', '.qyt-workbench-pane'); await f.tick(1200)
  const before = f.previews.filter(row => row.target.targetId === f.a.targetId).length
  await f.resolve(f.statuses.at(-1), snapshot([f.b, { ...f.a, epoch: 2 }]))
  await f.select(f.b); await f.tick(100)
  assert.equal(f.previews.filter(row => row.target.targetId === f.a.targetId).length, before)
  assert.equal(f.previews.at(-1).target.targetId, f.b.targetId)
  assert.equal(f.controls.length, 1)
})
