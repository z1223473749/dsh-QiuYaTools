import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'

const detectionDom = new JSDOM(''), detectionSaved = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.assign(globalThis, { window: detectionDom.window, document: detectionDom.window.document })
const { createRoot } = await import('react-dom/client')
detectionDom.window.close()
for (const [key, descriptor] of detectionSaved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
const require = createRequire(import.meta.url), { Simulate } = require('react-dom/test-utils')
const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/environment-panel.tsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })).outputFiles[0].text
const module = { exports: {} }
new Function('require', 'module', 'exports', source)(require, module, module.exports)
const tick = () => new Promise(done => setImmediate(done))
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const available = { available: true, platform: 'win32' }
const remoteStatus = sessionId => ({ native: { ...available, mode: 'remote' }, environments: [{ environmentId: `environment-${sessionId}`, sessionId, mode: 'remote' }] })

async function fixture(t, initial = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1/' })
  const saved = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(dom.window.document.querySelector('#root')), calls = [], plans = [], changes = [], closes = []
  let props = { sessionId: 'A', enabled: true, status: { native: available, environments: [] }, ...initial }, unmounted = false
  const render = async (next = {}) => act(async () => {
    props = { ...props, ...next }; const owner = props.sessionId
    root.render(React.createElement(module.exports.ComputerEnvironmentPanel, { ...props,
      async call(op, extra = {}, signal) {
        calls.push({ op, sessionId: owner, ...extra, signal })
        const index = plans.findIndex(row => row.op === op && (row.action === undefined || extra.request?.action === row.action))
        if (index >= 0) return plans.splice(index, 1)[0].promise
        if (op === 'connect') return { available: true }
        assert.equal(op, 'exchange')
        return { enabled: true, files: [], maxBytes: 8388608, chunkBytes: 131072 }
      },
      async onChanged() { changes.push(owner); await props.changed?.() },
      onClose() { closes.push(owner) },
    })); await tick()
  })
  const button = text => [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === text)
  const click = async text => { const target = button(text); assert.ok(target, `Missing button: ${text}`); await act(async () => { target.click(); await tick() }) }
  const field = name => [...dom.window.document.querySelectorAll('label')].find(node => node.firstChild?.textContent === name)?.querySelector('input,textarea,select')
  const edit = async (name, value) => { const input = field(name); assert.ok(input, `Missing field: ${name}`); await act(async () => { Simulate.change(input, { target: { value } }); await tick() }) }
  const mode = async value => { const radio = dom.window.document.querySelector(`input[type=radio][value=${value}]`); assert.ok(radio); await act(async () => { Simulate.change(radio, { target: { checked: true } }); await tick() }) }
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => { root.unmount(); await tick() }) } }
  t.after(async () => { await unmount(); dom.window.close(); for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] })
  return { dom, calls, changes, closes, render, button, click, field, edit, mode, unmount,
    selected: () => dom.window.document.querySelector('input[type=radio]:checked')?.value,
    plan(op, action) { const value = deferred(); plans.push({ op, action, promise: value.promise }); return value },
    async settle(value, result) { await act(async () => { value.resolve(result); await tick() }) },
    async upload() {
      const input = dom.window.document.querySelector('input[type=file]'); assert.ok(input)
      const file = { name: 'fixture.txt', size: 4, async arrayBuffer() { return new Uint8Array([65, 66, 67, 68]).buffer } }
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      await act(async () => { Simulate.change(input); await tick() })
      for (let attempt = 0; attempt < 100 && !calls.some(row => row.request?.action === 'begin'); attempt++) await act(async () => { await tick() })
      assert.ok(calls.some(row => row.request?.action === 'begin'), 'upload must reach the planned begin call')
    },
  }
}

test('chat environment initializes from its own connection without querying or inheriting another chat', async t => {
  const f = await fixture(t, { status: { ...remoteStatus('B'), environments: [{ sessionId: 'B', mode: 'remote' }] } }); await f.render()
  assert.equal(f.selected(), 'local'); assert.equal(f.button('检查并刷新交换目录'), undefined); assert.deepEqual(f.calls, [])
  await f.render({ status: remoteStatus('A') })
  assert.equal(f.selected(), 'remote'); assert.ok(f.button('检查并刷新交换目录')); assert.deepEqual(f.calls, [])
})

test('late status updates and repeated same-chat renders preserve the owner remote draft', async t => {
  const f = await fixture(t); await f.render(); await f.mode('remote'); await f.edit('配对地址', 'https://fixture-a.invalid/v1/computer'); await f.edit('配对密钥', 'fixture-pair-a')
  await f.render({ status: { native: available, environments: [{ sessionId: 'A', mode: 'browser' }] } })
  await f.render({ sessionId: 'A', status: { native: available, environments: [] } })
  assert.equal(f.selected(), 'remote'); assert.equal(f.field('配对密钥').value, 'fixture-pair-a'); assert.deepEqual(f.calls, [])
  await f.click('使用此环境')
  assert.deepEqual(f.calls.map(({ signal, ...row }) => row), [{ op: 'connect', sessionId: 'A', mode: 'remote', endpoint: 'https://fixture-a.invalid/v1/computer', token: 'fixture-pair-a', allowPrivateNetwork: false }])
  assert.deepEqual(f.changes, ['A']); assert.deepEqual(f.closes, ['A'])
})

test('a different chat clears pairing and browser drafts even when a host reuses the component instance', async t => {
  const f = await fixture(t); await f.render(); await f.mode('remote'); await f.edit('配对地址', 'https://fixture-a.invalid'); await f.edit('配对密钥', 'fixture-pair-a')
  await f.render({ sessionId: 'B' }); await f.mode('remote')
  assert.equal(f.field('配对地址').value, ''); assert.equal(f.field('配对密钥').value, ''); assert.equal(f.button('使用此环境').disabled, true)
  await f.mode('browser'); await f.edit('允许的网站来源（每行一个）', 'https://fixture-b.invalid'); await f.edit('起始页面', 'https://fixture-b.invalid/start'); await f.edit('本机调试地址（可选）', 'http://127.0.0.1:9222')
  await f.render({ sessionId: 'C' }); await f.mode('browser')
  assert.equal(f.field('允许的网站来源（每行一个）').value, ''); assert.equal(f.field('起始页面').value, ''); assert.equal(f.field('本机调试地址（可选）').value, '')
  assert.equal(f.button('使用此环境').disabled, true); assert.deepEqual(f.calls, [])
})

test('browser submission forwards only its approved origins and optional browser fields to the current chat', async t => {
  const f = await fixture(t); await f.render(); await f.mode('browser')
  await f.edit('浏览器', 'edge'); await f.edit('允许的网站来源（每行一个）', ' https://fixture-a.invalid\nhttps://fixture-b.invalid, '); await f.edit('起始页面', 'https://fixture-a.invalid/start'); await f.edit('本机调试地址（可选）', 'http://127.0.0.1:9222')
  await f.click('使用此环境')
  assert.deepEqual(f.calls.map(({ signal, ...row }) => row), [{ op: 'connect', sessionId: 'A', mode: 'browser', browser: 'edge', allowedOrigins: ['https://fixture-a.invalid', 'https://fixture-b.invalid'], initialUrl: 'https://fixture-a.invalid/start', cdpEndpoint: 'http://127.0.0.1:9222' }])
})

test('an unavailable connection displays its reason without claiming success or closing the menu', async t => {
  const f = await fixture(t); await f.render(); const pending = f.plan('connect'); await f.click('使用此环境')
  await f.settle(pending, { available: false, message: '当前桌面无法访问，请检查连接。' })
  assert.equal(f.dom.window.document.querySelector('[role=alert]').textContent, '当前桌面无法访问，请检查连接。')
  assert.deepEqual(f.changes, []); assert.deepEqual(f.closes, []); assert.equal(f.button('使用此环境').disabled, false)
})

test('successful connection waits for current-chat readback before closing and blocks duplicate submissions', async t => {
  const readback = deferred(), f = await fixture(t, { changed: () => readback.promise }); await f.render(); await f.click('使用此环境')
  assert.deepEqual(f.changes, ['A']); assert.deepEqual(f.closes, []); assert.equal(f.button('正在连接…').matches(':disabled'), true)
  await act(async () => { f.dom.window.document.querySelector('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })); await tick() })
  assert.equal(f.calls.length, 1)
  await f.settle(readback); assert.deepEqual(f.closes, ['A'])
})

test('disabling clears pairing secrets, aborts a pending request and ignores its late success', async t => {
  const f = await fixture(t); await f.render(); await f.mode('remote'); await f.edit('配对地址', 'https://fixture-a.invalid'); await f.edit('配对密钥', 'fixture-pair-a')
  const pending = f.plan('connect'); await f.click('使用此环境'); await f.render({ enabled: false })
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.field('配对密钥').value, ''); assert.equal(f.field('配对地址').value, '')
  await f.settle(pending, available); assert.deepEqual(f.changes, []); assert.deepEqual(f.closes, [])
  await f.render({ enabled: true }); assert.equal(f.selected(), 'remote'); assert.equal(f.button('使用此环境').disabled, true)
})

test('a disabled owner control and an unmounted panel cannot close or refresh from a late request', async t => {
  const f = await fixture(t); await f.render(); const pending = f.plan('connect'); await f.click('使用此环境'); await f.render({ disabled: true })
  await f.settle(pending, available); assert.deepEqual(f.changes, []); assert.deepEqual(f.closes, [])
  await f.render({ disabled: false }); const later = f.plan('connect'); await f.click('使用此环境'); await f.unmount(); await f.settle(later, available)
  assert.equal(f.calls.at(-1).signal.aborted, true); assert.deepEqual(f.changes, []); assert.deepEqual(f.closes, [])
})

test('a late previous-chat connection cannot close or unlock the current chat request', async t => {
  const f = await fixture(t); await f.render(); const a = f.plan('connect'); await f.click('使用此环境')
  await f.render({ sessionId: 'B' }); const b = f.plan('connect'); await f.click('使用此环境'); await f.settle(a, available)
  assert.equal(f.button('正在连接…').matches(':disabled'), true); assert.deepEqual(f.changes, []); assert.deepEqual(f.closes, [])
  await f.settle(b, available); assert.deepEqual(f.changes, ['B']); assert.deepEqual(f.closes, ['B'])
})

test('file exchange is visible only for the selected chat actual remote environment and uses its bound call', async t => {
  const f = await fixture(t, { status: remoteStatus('B') }); await f.render(); await f.mode('remote'); assert.equal(f.button('检查并刷新交换目录'), undefined)
  await f.render({ status: remoteStatus('A') }); await f.click('检查并刷新交换目录')
  assert.deepEqual(f.calls.map(row => [row.sessionId, row.expectedEnvironmentId, row.request.action]), [['A', 'environment-A', 'status'], ['A', 'environment-A', 'list']])
  await f.mode('browser'); assert.equal(f.button('检查并刷新交换目录'), undefined)
  await f.mode('remote'); await f.render({ enabled: false }); assert.equal(f.button('检查并刷新交换目录'), undefined)
  await f.render({ enabled: true, status: { ...remoteStatus('A'), environments: [{ environmentId: 'environment-A', sessionId: 'A', mode: 'remote', switching: true }] } }); assert.equal(f.button('检查并刷新交换目录'), undefined)
})

test('changing the draft environment cancels a late upload on its captured connection without sending chunks or commit', async t => {
  const f = await fixture(t, { status: remoteStatus('A') }); await f.render(); await f.click('检查并刷新交换目录')
  const begun = f.plan('exchange', 'begin'); await f.upload(); await f.mode('browser'); await f.settle(begun, { id: 'old-upload' })
  assert.deepEqual(f.calls.filter(row => row.request?.id).map(row => [row.sessionId, row.request.action, row.request.id]), [['A', 'abort', 'old-upload']])
  assert.equal(f.calls.some(row => ['chunk', 'commit'].includes(row.request?.action)), false)
})

test('a previous-chat upload cannot continue or clean up through the new chat connection', async t => {
  const f = await fixture(t, { status: remoteStatus('A') }); await f.render(); await f.click('检查并刷新交换目录')
  const begun = f.plan('exchange', 'begin'); await f.upload(); await f.render({ sessionId: 'B', status: remoteStatus('B') }); await f.settle(begun, { id: 'old-upload' })
  assert.equal(f.calls.some(row => row.sessionId === 'B'), false)
  assert.equal(f.calls.some(row => ['chunk', 'commit'].includes(row.request?.action)), false)
  await f.click('检查并刷新交换目录'); assert.deepEqual(f.calls.filter(row => row.sessionId === 'B').map(row => row.request.action), ['status', 'list'])
})

test('reconnecting the same chat fences old upload cleanup before replacing its remote backend', async t => {
  const f = await fixture(t, { status: remoteStatus('A') }); await f.render(); await f.click('检查并刷新交换目录')
  const begun = f.plan('exchange', 'begin'); await f.upload(); await f.mode('local'); const connecting = f.plan('connect'); await f.click('使用此环境'); await f.settle(begun, { id: 'old-upload' })
  assert.equal(f.calls.some(row => row.request?.id === 'old-upload'), false, 'old cleanup must not be routed into a replacement backend')
  await f.settle(connecting, available)
})

test('a closed file panel ignores late status instead of requesting a directory listing', async t => {
  const f = await fixture(t, { status: remoteStatus('A') }); await f.render(); const pending = f.plan('exchange', 'status'); await f.click('检查并刷新交换目录')
  await f.mode('local'); await f.settle(pending, { enabled: true })
  assert.deepEqual(f.calls.map(row => row.request.action), ['status'])
})

test('a scoped remote without a connection identity cannot expose file controls or issue an unfenced request', async t => {
  const f = await fixture(t); await f.render({ status: { native: { ...available, mode: 'remote' }, environments: [{ sessionId: 'A', mode: 'remote' }] } })
  assert.equal(f.selected(), 'remote'); assert.equal(f.button('检查并刷新交换目录'), undefined); assert.deepEqual(f.calls, [])
  await f.render({ status: remoteStatus('A') }); await f.click('检查并刷新交换目录')
  assert.ok(f.calls.every(row => row.expectedEnvironmentId === 'environment-A'))
})

test('another window reconnecting the same chat replaces its file area and fences late upload results and cleanup', async t => {
  const f = await fixture(t, { status: remoteStatus('A') }); await f.render(); await f.click('检查并刷新交换目录')
  const begun = f.plan('exchange', 'begin'); await f.upload()
  const replacement = remoteStatus('A'); replacement.environments[0].environmentId = 'replacement-remote-A'
  await f.render({ status: replacement })
  assert.equal(f.dom.window.document.querySelector('input[type=file]'), null, 'listing permission belongs to its old remote identity')
  await f.settle(begun, { id: 'old-upload' })
  assert.equal(f.calls.some(row => row.request?.id === 'old-upload'), false, 'even best-effort cleanup cannot reach the replacement driver')
  assert.ok(f.calls.every(row => row.expectedEnvironmentId === 'environment-A'))
  await f.click('检查并刷新交换目录')
  assert.deepEqual(f.calls.filter(row => row.expectedEnvironmentId === 'replacement-remote-A').map(row => [row.sessionId, row.request.action]), [['A', 'status'], ['A', 'list']])
})

test('a late file status cannot read the replacement remote directory when its connection identity changes', async t => {
  const f = await fixture(t, { status: remoteStatus('A') }); await f.render()
  const pending = f.plan('exchange', 'status'); await f.click('检查并刷新交换目录')
  const replacement = remoteStatus('A'); replacement.environments[0].environmentId = 'replacement-remote-A'
  await f.render({ status: replacement }); await f.settle(pending, { enabled: true })
  assert.deepEqual(f.calls.map(row => [row.expectedEnvironmentId, row.request.action]), [['environment-A', 'status']])
  assert.equal(f.dom.window.document.querySelector('input[type=file]'), null)
})
