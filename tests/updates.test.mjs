import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const React = require('react')
const { act } = React
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://harness.test' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { createRoot } = require('react-dom/client')
const { Simulate } = require('react-dom/test-utils')
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/updates.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', target: 'node22', format: 'cjs', packages: 'external',
  jsx: 'transform', loader: { '.css': 'text' },
  plugins: [{ name: 'inline-brand-fixture', setup(builder) {
    builder.onResolve({ filter: /brand-assets\.ts$/ }, () => ({ path: 'brand', namespace: 'brand-stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'brand-stub' }, () => ({ contents: 'export const COLOR_ICON_DATA_URL = "data:image/webp;base64,fixture"' }))
  } }],
})
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? {
  Switch: ({ checked, disabled, label, onChange }) => React.createElement('button', { type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, disabled, onClick: () => onChange(!checked) }),
} : require(name) })
const { UpdatePanel } = module.exports

const CHANNEL = '/api'
const CHECK = 'qiuya-tools.updates.check'
const INSTALL = 'qiuya-tools.updates.install'
const available = {
  status: 'available', currentVersion: '0.2.3', canInstall: true,
  release: {
    version: '0.3.0', tag: 'v0.3.0', url: 'https://github.com/example/tools/releases/tag/v0.3.0',
    title: 'A useful release', notes: 'Several useful improvements.', publishedAt: '2026-10-20T00:00:00Z',
  },
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function mount(handler, usePublicGet = false, automatic) {
  const calls = []
  const lookedUp = []
  const connection = { rpc: { call(channel, endpoint, payload) {
    calls.push({ channel, endpoint, payload: structuredClone(payload) })
    return handler({ channel, endpoint, payload })
  } } }
  const ctx = usePublicGet ? { get(name) { lookedUp.push(name); assert.equal(name, 'connection'); return connection } } : { connection }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(React.createElement(UpdatePanel, { version: '0.2.3', ctx, automatic })))
  return {
    container, calls, lookedUp,
    button(label) { return [...container.querySelectorAll('button')].find(button => button.textContent === label) },
    async click(label) { await act(async () => { Simulate.click(this.button(label)) }) },
    dispose() { act(() => root.unmount()); container.remove() },
  }
}

test('the automatic update preference uses the existing form action and preserves manual checks while disabled', async () => {
  const changes = []
  const f = mount(() => Promise.resolve({ ok: true, value: available }), false, { enabled: false, disabled: false, onChange: value => changes.push(value) })
  try {
    const control = f.container.querySelector('[role="switch"][aria-label="自动检查更新"]')
    assert.equal(control.getAttribute('aria-checked'), 'false')
    await act(async () => { Simulate.click(control) })
    assert.deepEqual(changes, [true])
    assert.equal(f.calls.length, 0, 'changing the preference delegates persistence instead of installing or directly fetching')
    await f.click('检查更新'); assert.equal(f.calls[0].payload.force, true)
  } finally { f.dispose() }
})

test('Update panel shows the running version, waits for a user request and deduplicates repeated checks', async () => {
  const pending = deferred()
  const f = mount(() => pending.promise)
  try {
    assert.match(f.container.textContent, /当前 v0\.2\.3/)
    assert.equal(f.calls.length, 0, 'opening Updates does not initiate a network request')
    const button = f.button('检查更新')
    act(() => { Simulate.click(button); Simulate.click(button) })
    assert.deepEqual(f.calls, [{ channel: CHANNEL, endpoint: CHECK, payload: { force: true } }])
    assert.equal(f.button('正在检查…').disabled, true)
    await act(async () => { pending.resolve({ ok: true, value: available }) })
    assert.match(f.container.textContent, /发现新版本 v0\.3\.0/)
    assert.ok(f.button('更新至 v0.3.0'))
  } finally { f.dispose() }
})

test('installation sends only the checked version, deduplicates clicks and clearly requires restart', async () => {
  const pending = deferred()
  const f = mount(({ endpoint }) => endpoint === CHECK ? Promise.resolve({ ok: true, value: available }) : pending.promise)
  try {
    await f.click('检查更新')
    const button = f.button('更新至 v0.3.0')
    act(() => { Simulate.click(button); Simulate.click(button) })
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.calls[1], { channel: CHANNEL, endpoint: INSTALL, payload: { version: '0.3.0' } })
    assert.equal(Object.keys(f.calls[1].payload).length, 1, 'the client cannot choose download URLs, paths or package names')
    assert.equal(f.button('正在更新…').disabled, true)
    await act(async () => { pending.resolve({ ok: true, value: { status: 'restart-required', currentVersion: '0.2.3', version: '0.3.0' } }) })
    assert.match(f.container.textContent, /v0\.3\.0 已安装.*重新打开 Harness 后生效/)
    assert.equal(f.button('更新至 v0.3.0'), undefined)
    assert.equal(f.button('检查更新').disabled, true)
  } finally { f.dispose() }
})

test('an already installed pendingVersion remains visible without offering a second install', async () => {
  const f = mount(() => Promise.resolve({ ok: true, value: { ...available, pendingVersion: '0.3.0' } }))
  try {
    await f.click('检查更新')
    assert.match(f.container.textContent, /v0\.3\.0 已安装.*重新打开 Harness 后生效/)
    assert.equal(f.button('更新至 v0.3.0'), undefined)
    assert.equal(f.button('检查更新').disabled, true)
    assert.equal(f.calls.length, 1)
  } finally { f.dispose() }
})

test('transport failures and rejected RPC responses never expose raw check errors', async () => {
  const secret = 'Bearer private-token /Users/private/profile?secret=example'
  for (const handler of [
    () => Promise.reject(new Error(secret)),
    () => Promise.resolve({ ok: false, error: { message: secret } }),
  ]) {
    const f = mount(handler)
    try {
      await f.click('检查更新')
      assert.match(f.container.querySelector('[role="alert"]').textContent, /更新服务暂时无法连接/)
      assert.equal(f.container.textContent.includes(secret), false)
      assert.equal(f.container.textContent.includes('private-token'), false)
      assert.equal(f.button('检查更新').disabled, false)
    } finally { f.dispose() }
  }
})

test('failed install transport preserves the checked release for retry without exposing raw errors', async () => {
  const secret = 'network failed: https://private.invalid/?token=hidden'
  let fail = true
  const f = mount(({ endpoint }) => {
    if (endpoint === CHECK) return Promise.resolve({ ok: true, value: available })
    return fail ? Promise.reject(new Error(secret)) : Promise.resolve({ ok: true, value: { status: 'installed', currentVersion: '0.2.3', version: '0.3.0' } })
  })
  try {
    await f.click('检查更新')
    await f.click('更新至 v0.3.0')
    assert.match(f.container.querySelector('[role="alert"]').textContent, /未能取得更新结果/)
    assert.equal(f.container.textContent.includes(secret), false)
    assert.equal(f.button('更新至 v0.3.0').disabled, false)
    fail = false
    await f.click('更新至 v0.3.0')
    assert.match(f.container.textContent, /已更新至 v0\.3\.0/)
    assert.equal(f.button('更新至 v0.3.0'), undefined)
  } finally { f.dispose() }
})

test('Update panel resolves the declared connection service through the public Cordis context', async () => {
  const f = mount(() => Promise.resolve({ ok: true, value: { status: 'no-release', currentVersion: '0.2.3', canInstall: false } }), true)
  try {
    await f.click('检查更新')
    assert.deepEqual(f.lookedUp, ['connection'])
    assert.match(f.container.textContent, /GitHub 暂无正式发布版本/)
    assert.equal(f.button('检查更新').disabled, false)
  } finally { f.dispose() }
})

test.after(() => dom.window.close())
