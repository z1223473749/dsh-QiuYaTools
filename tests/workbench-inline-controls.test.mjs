import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const compiled = (await build({
  stdin: { contents: "export { WorkbenchControls } from './src/features/workbench/Views.tsx'; export { WorkbenchInline } from './src/features/workbench/client.tsx'", resolveDir: repository },
  bundle: true, write: false, platform: 'node', format: 'esm', external: ['react', 'react-dom'],
})).outputFiles[0].text
const directory = await mkdtemp('/private/tmp/qyt-inline-controls-unit-')
await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'), 'dir')
await writeFile(join(directory, 'runtime.mjs'), compiled)
const { WorkbenchControls, WorkbenchInline } = await import(pathToFileURL(join(directory, 'runtime.mjs')).href)
test.after(() => rm(directory, { recursive: true, force: true }))

const turn = () => new Promise(done => setImmediate(done))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const target = (extra = {}) => ({ chatSessionId: 'chat-a', environmentId: randomUUID(), workbenchTabId: randomUUID(), kind: 'browser', targetId: randomUUID(), appId: 'owned-fixture-browser', epoch: 1, title: 'Owned fixture page', origin: 'https://fixture.test', state: 'ready', ...extra })
const frame = (value, pixels = 'QUFBQQ==') => ({ target: value, viewOnly: true, observation: { targetId: value.targetId, frameId: randomUUID(), imageBase64: pixels, mediaType: 'image/jpeg', width: 100, height: 100, elements: '', geometry: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } })

async function mount(t, Component, props) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://fixture.test/' }), previous = new Map()
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } }
  for (const [key, value] of Object.entries(globals)) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }) }
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 180, width: 300, height: 180, x: 0, y: 0, toJSON() { return {} } })
  const root = createRoot(dom.window.document.getElementById('root'))
  const render = async next => { await act(async () => { root.render(React.createElement(Component, next)); await turn() }) }
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
  })
  await render(props)
  const button = label => dom.window.document.querySelector(`button[aria-label="${label}"]`)
  return { dom, render, button, async click(label) { const node = button(label); assert.ok(node, label); assert.equal(node.disabled, false, label); await act(async () => { node.click(); await turn() }) } }
}

const labels = ['暂停电脑任务', '接管电脑任务', '继续电脑任务', '停止电脑任务', '弹出电脑预览', '关闭电脑预览']

test('compact preview actions expose named icon buttons and retain state and busy restrictions', async t => {
  const value = target(), calls = [], props = { target: value, compact: true, busy: false, control: operation => calls.push(operation), open() {}, hide() {} }
  const mounted = await mount(t, WorkbenchControls, props)
  const buttons = [...mounted.dom.window.document.querySelectorAll('button')]
  assert.deepEqual(buttons.map(button => button.getAttribute('aria-label')), labels)
  for (const button of buttons) {
    assert.ok(button.title.trim(), button.getAttribute('aria-label'))
    assert.equal(button.textContent.trim(), '', 'Compact actions show their icon without a text label')
    assert.ok(button.querySelector('svg[aria-hidden="true"]'), button.getAttribute('aria-label'))
  }
  for (const [state, disabled] of [
    ['ready', [false, false, true, false, false]],
    ['running', [false, false, true, false, false]],
    ['paused', [true, false, false, false, false]],
    ['humanControl', [true, true, false, false, false]],
  ]) {
    await mounted.render({ ...props, target: { ...value, state } })
    assert.deepEqual(labels.slice(0, 5).map(label => mounted.button(label).disabled), disabled, state)
  }
  await mounted.render({ ...props, busy: true })
  assert.ok(labels.slice(0, 5).every(label => mounted.button(label).disabled))
  assert.equal(mounted.button('关闭电脑预览').disabled, false, 'Hiding the local preview stays available while device control is pending')
  assert.deepEqual(calls, [])
})

test('compact icons route each operation once and view selection only chooses the exact page ID', async t => {
  const value = target(), other = target({ title: 'Another owned page' }), calls = []
  const props = { target: value, compact: true, busy: false, choices: [value, other], choose: id => calls.push(['choose', id]), control: operation => calls.push(['control', operation]), open: () => calls.push(['open']), hide: () => calls.push(['hide']) }
  const mounted = await mount(t, WorkbenchControls, props)
  for (const label of ['暂停电脑任务', '接管电脑任务', '停止电脑任务', '弹出电脑预览', '关闭电脑预览']) await mounted.click(label)
  await mounted.render({ ...props, target: { ...value, state: 'paused' } })
  await mounted.click('继续电脑任务')
  const picker = mounted.dom.window.document.querySelector('select[aria-label="选择预览任务"]')
  assert.ok(picker)
  await act(async () => { picker.value = other.workbenchTabId; picker.dispatchEvent(new mounted.dom.window.Event('change', { bubbles: true })); await turn() })
  assert.deepEqual(calls, [['control', 'pause'], ['control', 'takeover'], ['control', 'stop'], ['open'], ['hide'], ['control', 'resume'], ['choose', other.workbenchTabId]])
})

async function inlineFixture(t, { holdSecondFrame = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const value = target(), late = deferred(), calls = { status: [], preview: [], control: [], humanAct: [], native: [], open: [] }
  let status = { views: [value], pendingRequests: [], environments: [], allowedOrigins: [] }, native = { pendingRequests: [] }
  const api = {
    async status(chat, signal) { calls.status.push({ chat, signal }); return status },
    async preview(view, signal) { calls.preview.push({ view, signal }); return holdSecondFrame && calls.preview.length === 2 ? late.promise : frame(view, view.epoch >= 2 ? 'QkJCQg==' : 'QUFBQQ==') },
    async control(...args) { calls.control.push(args) },
    async humanAct(...args) { calls.humanAct.push(args) },
  }
  const preferences = { status: 'ready', value: { enabled: true, computerUseEnabled: true } }
  const mounted = await mount(t, WorkbenchInline, { sessionId: value.chatSessionId, api, current: () => true, form: { subscribe: () => () => {}, getSnapshot: () => preferences }, open: view => calls.open.push(view), nativeCall: async (op, ...args) => { calls.native.push({ op, args }); return native } })
  return { ...mounted, value, late, calls, setStatus(next) { status = next }, setNative(next) { native = next }, snapshot(extra = {}) { return { views: [value], pendingRequests: [], environments: [], allowedOrigins: [], ...extra } }, async advance(ms) { await act(async () => { t.mock.timers.tick(ms); await turn() }) } }
}

test('closing the inline preview cancels frame reads, discards late pixels and survives polling until restored', async t => {
  const mounted = await inlineFixture(t, { holdSecondFrame: true }), doc = mounted.dom.window.document
  assert.equal(doc.querySelector('img').getAttribute('src'), 'data:image/jpeg;base64,QUFBQQ==')
  await mounted.advance(100)
  assert.equal(mounted.calls.preview.length, 2)
  const pending = mounted.calls.preview[1]
  await mounted.click('关闭电脑预览')
  assert.equal(doc.querySelector('[aria-label="电脑实时预览"]'), null)
  assert.equal(doc.querySelector('img'), null)
  const restore = mounted.button('显示电脑预览')
  assert.ok(restore)
  assert.equal(restore.textContent.trim(), '')
  assert.ok(restore.querySelector('svg[aria-hidden="true"]'))
  assert.equal(pending.signal.aborted, true, 'Hiding must immediately cancel the current frame request')
  await act(async () => { mounted.late.resolve(frame(mounted.value, 'T0xE')); await turn() })
  assert.equal(doc.querySelector('img'), null, 'A response that ignores cancellation cannot reopen the preview')
  const updated = { ...mounted.value, epoch: 2, title: 'Updated while hidden' }
  mounted.setStatus(mounted.snapshot({ views: [updated] }))
  const statuses = mounted.calls.status.length
  await mounted.advance(1200)
  assert.ok(mounted.calls.status.length > statuses, 'Task metadata continues to refresh while the preview is hidden')
  await mounted.advance(1200)
  assert.equal(mounted.calls.preview.length, 2, 'Metadata polling cannot restart hidden frame reads')
  assert.equal(doc.querySelector('[aria-label="电脑实时预览"]'), null)
  assert.ok(mounted.button('显示电脑预览'))
  await mounted.click('显示电脑预览')
  assert.equal(mounted.calls.preview.length, 3)
  assert.equal(mounted.calls.preview.at(-1).view.epoch, 2, 'Restoring uses the latest confirmed task')
  assert.equal(doc.querySelector('img').getAttribute('src'), 'data:image/jpeg;base64,QkJCQg==')
  assert.ok(mounted.button('关闭电脑预览'))
  assert.deepEqual(mounted.calls.control, [])
  assert.deepEqual(mounted.calls.humanAct, [])
  assert.deepEqual(mounted.calls.open, [])
  assert.ok(mounted.calls.native.every(call => call.op === 'pending'))
})

test('hiding the preview leaves new website and native approval requests visible and actionable', async t => {
  const mounted = await inlineFixture(t), doc = mounted.dom.window.document
  await mounted.click('关闭电脑预览')
  const request = { requestId: randomUUID(), requestVersion: 1, createdAt: Date.now(), expiresAt: Date.now() + 60_000, state: 'pending', reason: 'Owned fixture authorization' }
  mounted.setStatus(mounted.snapshot({ pendingRequests: [{ ...request, requestId: randomUUID(), chatSessionId: mounted.value.chatSessionId, browser: 'chrome', origin: 'https://next.fixture.test' }] }))
  mounted.setNative({ pendingRequests: [{ ...request, sessionId: mounted.value.chatSessionId, appId: 'fixture-browser', appName: 'Fixture Browser', preflight: { platform: 'darwin', mode: 'browser', permissions: { screenRecording: false, accessibility: false, postEvents: false } } }] })
  await mounted.advance(1200)
  for (const label of ['网站操作授权', '电脑操作授权']) {
    const approval = doc.querySelector(`[aria-label="${label}"]`)
    assert.ok(approval, `${label} must remain visible when preview pixels are hidden`)
    const allow = [...approval.querySelectorAll('button')].find(button => button.textContent === '允许一次')
    assert.ok(allow)
    assert.equal(allow.disabled, false)
  }
  assert.equal(doc.querySelector('img'), null)
  assert.equal(mounted.calls.preview.length, 1)
  assert.deepEqual(mounted.calls.control, [])
  assert.deepEqual(mounted.calls.humanAct, [])
  assert.ok(mounted.calls.native.every(call => call.op === 'pending'))
})
