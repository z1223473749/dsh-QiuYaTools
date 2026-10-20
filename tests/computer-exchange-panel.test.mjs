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
const panelSource = (await build({ entryPoints: [join(base, 'src/features/computer-use/panel.tsx')], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })).outputFiles[0].text
const module = { exports: {} }; new Function('require', 'module', 'exports', panelSource)(require, module, module.exports)
const { ComputerPanel } = module.exports
const source = (await build({ entryPoints: [join(base, 'src/features/computer-use/exchange.ts')], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { ComputerExchange } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

test('owner panel selects a real local file, uploads only basename/bytes and downloads exact remote bytes; other modes hide exchange', async () => {
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
  const ctx = { get(name) {
    if (name === 'sessions') return { list: { getSnapshot: () => ({ ids: [], byId: {} }) } }
    if (name === 'connection') return { rpc: { async call(_channel, _endpoint, input) {
      requests.push(input)
      if (input.op === 'status') return { ok: true, value: { sessions: [], allowedApps: [], native: { mode: 'remote' } } }
      if (input.op === 'exchange') return { ok: true, value: await store.run('owner', input.request) }
      throw new Error('Unexpected UI operation')
    } } }
  } }
  const root = createRoot(dom.window.document.querySelector('#root'))
  const button = text => [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === text)
  const waitFor = async predicate => { const until = Date.now() + 5000; while (!predicate()) { if (Date.now() > until) throw new Error('UI fixture timed out'); await act(() => new Promise(done => originalTimeout(done, 5))) } }
  try {
    await act(async () => root.render(React.createElement(ComputerPanel, { ctx, enabled: true, onEnabled() {}, disabled: false })))
    const select = dom.window.document.querySelector('select')
    assert.equal(dom.window.document.body.textContent.includes('手动文件交换'), false, 'local selection must not advertise exchange')
    await act(async () => { select.value = 'remote'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
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
    assert.equal(requests.find(value => value.op === 'status').sessionId, undefined, 'file area must work before a chat is selected')
    await act(async () => button('下载').click())
    await waitFor(() => clicks.length === 1)
    assert.equal(clicks[0].name, file.name); assert.deepEqual(Buffer.from(await downloaded[0].arrayBuffer()), bytes)
    await act(async () => { select.value = 'browser'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
    assert.equal(dom.window.document.body.textContent.includes('手动文件交换'), false)
  } finally {
    await act(async () => root.unmount()); await store.close(); dom.window.close(); await rm(directory, { recursive: true, force: true })
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; globalThis.setTimeout = originalTimeout
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
  }
})
