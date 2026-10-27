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
const nativeTimers = { setTimeout, clearTimeout }
let updateTimers = nativeTimers
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
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
  setTimeout: (...args) => updateTimers.setTimeout(...args), clearTimeout: timer => updateTimers.clearTimeout(timer),
  require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? {
  Switch: ({ checked, disabled, label, onChange }) => React.createElement('button', { type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, disabled, onClick: () => onChange(!checked) }),
} : require(name) })
const { UpdatePanel } = module.exports

const CHANNEL = '/api'
const CHECK = 'qiuya-tools.updates.check'
const INSTALL = 'qiuya-tools.updates.install'
const PROGRESS = 'qiuya-tools.updates.progress'
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
function fakeClock() {
  let now = 0, next = 0
  const timers = new Map()
  return {
    timers,
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { callback, at: now + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    advance(milliseconds) {
      now += milliseconds
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && timers.delete(id)) timer.callback()
      }
    },
  }
}

function mount(handler, usePublicGet = false, automatic, clock) {
  const previousTimers = updateTimers
  updateTimers = clock ?? nativeTimers
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
  let disposed = false
  act(() => root.render(React.createElement(UpdatePanel, { version: '0.2.3', ctx, automatic })))
  return {
    container, calls, lookedUp,
    button(label) { return [...container.querySelectorAll('button')].find(button => button.textContent === label) },
    async click(label) { await act(async () => { Simulate.click(this.button(label)) }) },
    async advance(milliseconds) { assert.ok(clock); await act(async () => { clock.advance(milliseconds); await Promise.resolve() }) },
    dispose() { if (disposed) return; disposed = true; act(() => root.unmount()); container.remove(); updateTimers = previousTimers },
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
    assert.match(f.container.textContent, /每次启动时检查，运行期间每天检查一次/)
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
    assert.equal(f.button('准备下载…').disabled, true)
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

test('real download snapshots drive the button, byte counts and accessible progress before verification and installation', async () => {
  const clock = fakeClock(), installation = deferred()
  const snapshots = [
    { stage: 'checking', downloadedBytes: 0, totalBytes: null, percentage: null },
    { stage: 'downloading', downloadedBytes: 428, totalBytes: 1000, percentage: 42.8 },
    { stage: 'verifying', downloadedBytes: 1000, totalBytes: 1000, percentage: 100 },
    { stage: 'installing', downloadedBytes: 1000, totalBytes: 1000, percentage: 100 },
  ]
  const f = mount(({ endpoint, payload }) => {
    if (endpoint === CHECK) return Promise.resolve({ ok: true, value: available })
    if (endpoint === INSTALL) return installation.promise
    assert.equal(endpoint, PROGRESS)
    assert.deepEqual(structuredClone(payload), { version: '0.3.0' })
    return Promise.resolve({ ok: true, value: { progress: { version: '0.3.0', ...snapshots.shift() } } })
  }, false, undefined, clock)
  try {
    await f.click('检查更新'); await f.click('更新至 v0.3.0')
    assert.equal(f.button('准备下载…').disabled, true)
    assert.equal(f.calls.length, 2, 'installation starts before polling')
    assert.equal(f.container.querySelector('[role="progressbar"]'), null)
    await f.advance(300)
    assert.ok(f.button('准备下载…'))
    await f.advance(300)
    assert.equal(f.button('正在下载 42%').disabled, true)
    assert.equal(f.container.querySelector('.qyt-about-install-fill').style.width, '42%')
    const bar = f.container.querySelector('[role="progressbar"]')
    assert.equal(bar.getAttribute('aria-valuenow'), '42')
    assert.equal(bar.getAttribute('aria-valuemin'), '0')
    assert.equal(bar.getAttribute('aria-valuemax'), '100')
    assert.match(bar.getAttribute('aria-valuetext'), /428 B \/ 1000 B/)
    assert.equal(bar.closest('button'), null, 'the progressbar has its own role outside the action button')
    assert.match(f.container.querySelector('.qyt-about-download-bytes').textContent, /428 B \/ 1000 B/)
    assert.equal(f.container.querySelector('[aria-label="插件更新"]').getAttribute('aria-busy'), 'true')
    await f.advance(300)
    assert.ok(f.button('正在校验…'))
    assert.match(f.container.querySelector('[role="status"]').textContent, /下载完成，正在校验/)
    assert.equal(f.container.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '100')
    await f.advance(300)
    assert.ok(f.button('正在安装…'))
    assert.match(f.container.querySelector('[role="status"]').textContent, /正在安装更新/)
    assert.equal(f.container.querySelector('.qyt-about-update-message').getAttribute('data-state'), 'busy', '100% download is not installation completion')
    await act(async () => { installation.resolve({ ok: true, value: { status: 'restart-required', currentVersion: '0.2.3', version: '0.3.0' } }) })
    assert.match(f.container.querySelector('[role="status"]').textContent, /v0\.3\.0 已安装.*重新打开 Harness/)
    assert.equal(f.container.querySelector('[role="progressbar"]'), null)
    assert.equal(clock.timers.size, 0)
  } finally { f.dispose() }
})

test('progress polling stays serial and a late response cannot replace the completed installation', async () => {
  const clock = fakeClock(), installation = deferred(), first = deferred(), last = deferred()
  let polls = 0
  const f = mount(({ endpoint }) => endpoint === CHECK ? Promise.resolve({ ok: true, value: available })
    : endpoint === INSTALL ? installation.promise : (++polls === 1 ? first.promise : last.promise), false, undefined, clock)
  try {
    await f.click('检查更新'); await f.click('更新至 v0.3.0')
    await f.advance(300); await f.advance(1500)
    assert.equal(polls, 1, 'a slow response cannot start overlapping progress requests')
    await act(async () => { first.resolve({ ok: true, value: { progress: { version: '0.3.0', stage: 'downloading', downloadedBytes: 40, totalBytes: 100, percentage: 40 } } }) })
    assert.ok(f.button('正在下载 40%'))
    await f.advance(300)
    assert.equal(polls, 2)
    await act(async () => { installation.resolve({ ok: true, value: { status: 'restart-required', currentVersion: '0.2.3', version: '0.3.0' } }) })
    await act(async () => { last.resolve({ ok: true, value: { progress: { version: '0.3.0', stage: 'downloading', downloadedBytes: 99, totalBytes: 100, percentage: 99 } } }) })
    await f.advance(3000)
    assert.equal(polls, 2)
    assert.equal(clock.timers.size, 0)
    assert.equal(f.container.querySelector('[role="progressbar"]'), null)
    assert.match(f.container.querySelector('[role="status"]').textContent, /已安装.*重新打开 Harness/)
  } finally { f.dispose() }
})

test('a retry starts without stale progress and ignores a response from the failed attempt', async () => {
  const clock = fakeClock(), firstInstall = deferred(), secondInstall = deferred(), oldProgress = deferred()
  let installs = 0, polls = 0
  const f = mount(({ endpoint }) => {
    if (endpoint === CHECK) return Promise.resolve({ ok: true, value: available })
    if (endpoint === INSTALL) return ++installs === 1 ? firstInstall.promise : secondInstall.promise
    return ++polls === 1 ? oldProgress.promise : Promise.resolve({ ok: true, value: { progress: { version: '0.3.0', stage: 'downloading', downloadedBytes: 70, totalBytes: 1000, percentage: 7 } } })
  }, false, undefined, clock)
  try {
    await f.click('检查更新'); await f.click('更新至 v0.3.0'); await f.advance(300)
    await act(async () => { firstInstall.resolve({ ok: true, value: { status: 'failed', currentVersion: '0.2.3', problem: { code: 'download-failed', message: '下载未完成，请重试。' } } }) })
    assert.match(f.container.querySelector('[role="alert"]').textContent, /下载未完成/)
    await f.click('更新至 v0.3.0')
    assert.ok(f.button('准备下载…'))
    assert.equal(f.container.querySelector('[role="alert"]'), null)
    assert.equal(f.container.querySelector('[role="progressbar"]'), null)
    await act(async () => { oldProgress.resolve({ ok: true, value: { progress: { version: '0.3.0', stage: 'downloading', downloadedBytes: 990, totalBytes: 1000, percentage: 99 } } }) })
    assert.ok(f.button('准备下载…'), 'the previous attempt cannot move the new button to 99%')
    assert.equal(clock.timers.size, 1, 'the previous attempt cannot schedule another poll')
    await f.advance(300)
    assert.ok(f.button('正在下载 7%'))
    await act(async () => { secondInstall.resolve({ ok: true, value: { status: 'installed', currentVersion: '0.2.3', version: '0.3.0' } }) })
    assert.match(f.container.querySelector('[role="status"]').textContent, /已更新至 v0\.3\.0/)
  } finally { f.dispose() }
})

test('failed or mismatched progress queries do not interrupt installation or invent a percentage', async () => {
  const clock = fakeClock(), installation = deferred()
  const secret = 'private progress transport details'
  let polls = 0
  const f = mount(({ endpoint }) => {
    if (endpoint === CHECK) return Promise.resolve({ ok: true, value: available })
    if (endpoint === INSTALL) return installation.promise
    polls++
    if (polls === 1) return Promise.reject(Error(secret))
    if (polls === 2) return Promise.resolve({ ok: true, value: { progress: { version: '9.9.9', stage: 'downloading', downloadedBytes: 100, totalBytes: 100, percentage: 100 } } })
    if (polls === 3) return Promise.resolve({ ok: true, value: { progress: null } })
    if (polls === 4) return Promise.resolve({ ok: true, value: { progress: { version: '0.3.0', stage: 'downloading', downloadedBytes: 512, totalBytes: null, percentage: null } } })
    return Promise.resolve({ ok: true, value: { progress: { version: '0.3.0', stage: 'downloading', downloadedBytes: 1000, totalBytes: 4000, percentage: 25 } } })
  }, false, undefined, clock)
  try {
    await f.click('检查更新'); await f.click('更新至 v0.3.0')
    for (let index = 0; index < 3; index++) {
      await f.advance(300)
      assert.ok(f.button('准备下载…'))
      assert.equal(f.container.querySelector('[role="progressbar"]'), null)
    }
    assert.equal(f.container.querySelector('[role="alert"]'), null)
    assert.equal(f.container.textContent.includes(secret), false)
    await f.advance(300)
    assert.ok(f.button('正在下载…'))
    assert.equal(f.container.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), null)
    assert.match(f.container.querySelector('.qyt-about-download-bytes').textContent, /512 B/)
    await f.advance(300)
    assert.ok(f.button('正在下载 25%'))
    assert.equal(f.calls.filter(call => call.endpoint === INSTALL).length, 1)
    await act(async () => { installation.resolve({ ok: true, value: { status: 'installed', currentVersion: '0.2.3', version: '0.3.0' } }) })
    assert.match(f.container.textContent, /已更新至 v0\.3\.0/)
  } finally { f.dispose() }
})

test('unmounting cancels scheduled polls and late in-flight replies cannot restart polling', async () => {
  for (const inFlight of [false, true]) {
    const clock = fakeClock(), installation = deferred(), query = deferred()
    let polls = 0
    const f = mount(({ endpoint }) => endpoint === CHECK ? Promise.resolve({ ok: true, value: available })
      : endpoint === INSTALL ? installation.promise : (polls++, query.promise), false, undefined, clock)
    try {
      await f.click('检查更新'); await f.click('更新至 v0.3.0')
      if (inFlight) await f.advance(300)
      f.dispose()
      assert.equal(clock.timers.size, 0)
      await act(async () => {
        query.resolve({ ok: true, value: { progress: { version: '0.3.0', stage: 'downloading', downloadedBytes: 42, totalBytes: 100, percentage: 42 } } })
        installation.resolve({ ok: true, value: { status: 'restart-required', currentVersion: '0.2.3', version: '0.3.0' } })
      })
      await f.advance(3000)
      assert.equal(polls, inFlight ? 1 : 0)
      assert.equal(clock.timers.size, 0)
    } finally { f.dispose() }
  }
})

test.after(() => dom.window.close())
