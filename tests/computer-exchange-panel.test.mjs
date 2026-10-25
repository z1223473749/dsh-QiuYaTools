import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, realpath, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { File } from 'node:buffer'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'

const require = createRequire(import.meta.url), base = fileURLToPath(new URL('../', import.meta.url))
const panelSource = (await build({ entryPoints: [join(base, 'src/features/computer-use/environment-panel.tsx')], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })).outputFiles[0].text
const module = { exports: {} }; new Function('require', 'module', 'exports', panelSource)(require, module, module.exports)
const { ComputerEnvironmentPanel } = module.exports, { Simulate } = require('react-dom/test-utils')
const remoteStatus = sessionId => ({ native: { mode: 'remote', available: true }, environments: [{ environmentId: `environment-${sessionId}`, sessionId, mode: 'remote' }] })
const selectMode = async (dom, value) => act(async () => Simulate.change(dom.window.document.querySelector(`input[type=radio][value=${value}]`), { target: { checked: true } }))
const source = (await build({ entryPoints: [join(base, 'src/features/computer-use/exchange.ts')], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { ComputerExchange } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

test('current-chat environment selects a real local file, uploads only basename/bytes and downloads exact remote bytes; other drafts hide exchange', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'qyt-exchange-panel-'))), shared = join(directory, 'exchange')
  await mkdir(shared); const store = await ComputerExchange.create(shared)
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1/' })
  const saved = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL, originalTimeout = globalThis.setTimeout
  const downloaded = [], clicks = [], requests = []
  URL.createObjectURL = blob => { downloaded.push(blob); return 'blob:qiuya-fixture' }; URL.revokeObjectURL = () => {}
  globalThis.setTimeout = (callback, milliseconds, ...args) => { const timer = originalTimeout(callback, milliseconds === 30000 ? 1 : milliseconds, ...args); if (milliseconds === 30000) timer.unref(); return timer }
  dom.window.HTMLAnchorElement.prototype.click = function() { clicks.push({ name: this.download, href: this.href }) }
  const call = async (op, extra = {}) => {
    const input = { op, ...extra, sessionId: 'A' }; requests.push(input)
    assert.equal(op, 'exchange'); return store.run('session-A', input.request)
  }
  const root = createRoot(dom.window.document.querySelector('#root'))
  const button = text => [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === text)
  const waitFor = async predicate => { const until = Date.now() + 5000; while (!predicate()) { if (Date.now() > until) throw new Error('UI fixture timed out'); await act(() => new Promise(done => originalTimeout(done, 5))) } }
  try {
    await act(async () => root.render(React.createElement(ComputerEnvironmentPanel, { sessionId: 'A', enabled: true, status: remoteStatus('A'), call, async onChanged() {} })))
    await selectMode(dom, 'local')
    assert.equal(dom.window.document.body.textContent.includes('手动文件交换'), false, 'a local draft must not advertise the remote exchange')
    assert.deepEqual(requests, [], 'rendering or selecting a draft does not connect or read files')
    await selectMode(dom, 'remote')
    await waitFor(() => button('检查并刷新交换目录'))
    await act(async () => button('检查并刷新交换目录').click())
    await waitFor(() => dom.window.document.querySelector('input[type=file]'))
    const bytes = Buffer.concat([Buffer.from('中文🙂\r\n'), Buffer.alloc(260000, 0x71)]), file = new File([bytes], '手选文件.bin')
    Object.defineProperty(file, 'webkitRelativePath', { value: '/private/DO-NOT-SHARE/local-file' })
    const input = dom.window.document.querySelector('input[type=file]'); Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
    await waitFor(() => dom.window.document.body.textContent.includes('文件已上传至远端专用交换目录。'))
    assert.deepEqual(await readFile(join(shared, file.name)), bytes)
    assert.equal(JSON.stringify(requests).includes('DO-NOT-SHARE'), false)
    assert.ok(requests.every(value => JSON.stringify(value).length < 256000))
    assert.ok(requests.every(value => value.sessionId === 'A' && value.expectedEnvironmentId === 'environment-A'), 'every exchange operation stays bound to its current-chat identity')
    await act(async () => button('下载').click())
    await waitFor(() => clicks.length === 1)
    assert.equal(clicks[0].name, file.name); assert.deepEqual(Buffer.from(await downloaded[0].arrayBuffer()), bytes)
    await selectMode(dom, 'browser')
    assert.equal(dom.window.document.body.textContent.includes('手动文件交换'), false)
  } finally {
    await act(async () => root.unmount()); await store.close(); dom.window.close(); await rm(directory, { recursive: true, force: true })
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; globalThis.setTimeout = originalTimeout
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
  }
})

for (const change of ['environment', 'chat', 'remote connection identity']) test(`switching ${change} during a real asynchronous digest sends no old file metadata to the new device`, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1/' })
  const saved = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const subtle = crypto.subtle, ownDigest = Object.getOwnPropertyDescriptor(subtle, 'digest'), realDigest = subtle.digest
  let release, entered = false
  const barrier = new Promise(done => { release = done })
  Object.defineProperty(subtle, 'digest', { configurable: true, value: async (...args) => { const result = await realDigest.apply(subtle, args); entered = true; await barrier; return result } })
  const requests = []
  const callFor = sessionId => async (op, extra = {}) => {
    const input = { op, ...extra, sessionId }; requests.push(input)
    assert.equal(op, 'exchange'); return { enabled: true, files: [], maxBytes: 8388608, chunkBytes: 131072 }
  }
  const root = createRoot(dom.window.document.querySelector('#root'))
  const waitFor = async predicate => { const until = Date.now() + 5000; while (!predicate()) { if (Date.now() > until) throw new Error('UI digest fixture timed out'); await act(() => new Promise(done => setTimeout(done, 5))) } }
  try {
    await act(async () => root.render(React.createElement(ComputerEnvironmentPanel, { sessionId: 'A', enabled: true, status: remoteStatus('A'), call: callFor('A'), async onChanged() {} })))
    const refresh = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === '检查并刷新交换目录')
    await act(async () => refresh.click())
    const input = dom.window.document.querySelector('input[type=file]')
    Object.defineProperty(input, 'files', { value: [new File(['private bytes'], 'private-old-device-name.txt')] })
    await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
    await waitFor(() => entered)
    if (change === 'environment') {
      await selectMode(dom, 'browser')
      assert.equal(dom.window.document.body.textContent.includes('手动文件交换'), false)
    } else if (change === 'chat') {
      await act(async () => root.render(React.createElement(ComputerEnvironmentPanel, { sessionId: 'B', enabled: true, status: remoteStatus('B'), call: callFor('B'), async onChanged() {} })))
      assert.ok(dom.window.document.querySelector('input[type=radio][value=remote]:checked'))
    } else {
      const status = remoteStatus('A'); status.environments[0].environmentId = 'replacement-remote-A'
      await act(async () => root.render(React.createElement(ComputerEnvironmentPanel, { sessionId: 'A', enabled: true, status, call: callFor('A'), async onChanged() {} })))
      assert.ok(dom.window.document.querySelector('input[type=radio][value=remote]:checked'))
      assert.equal(dom.window.document.querySelector('input[type=file]'), null, 'a replacement connection cannot inherit the old approved file listing')
    }
    await act(async () => { release(); await new Promise(done => setTimeout(done, 20)) })
    assert.deepEqual(requests.filter(input => input.op === 'exchange').map(input => input.request.action), ['status', 'list'])
    assert.equal(JSON.stringify(requests).includes('private-old-device-name.txt'), false)
    assert.ok(requests.every(input => input.sessionId === 'A'), 'no pending digest or cleanup is routed to the new chat')
  } finally {
    release(); await act(async () => root.unmount()); dom.window.close()
    if (ownDigest) Object.defineProperty(subtle, 'digest', ownDigest); else delete subtle.digest
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
  }
})
