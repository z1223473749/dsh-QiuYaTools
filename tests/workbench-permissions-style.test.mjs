import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const runtime = await mkdtemp(join(tmpdir(), 'qiuya-site-permissions-dom-'))
const compiled = await build({
  stdin: { contents: "export { SitePermissions } from './src/features/workbench/Views.tsx'; export { computerVisualStyles } from './src/features/computer-use/visual-style.ts'; export { workbenchStyles } from './src/features/workbench/styles.ts'", resolveDir: sourceRoot },
  bundle: true, write: false, platform: 'node', format: 'esm', external: ['react'],
})
await symlink(join(sourceRoot, 'node_modules'), join(runtime, 'node_modules'), 'dir')
await writeFile(join(runtime, 'ui.mjs'), compiled.outputFiles[0].text)
const ui = await import(pathToFileURL(join(runtime, 'ui.mjs')).href)
const toolboxStyles = await readFile(join(sourceRoot, 'src/client/styles.css'), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
test.after(() => rm(runtime, { recursive: true, force: true }))

async function mount(api) {
  // This is the actual component, mounted outside ComputerPanel just as in Settings.
  const dom = new JSDOM('<!doctype html><section class="qyt-settings"><div id="root"></div></section>', { url: 'https://permissions.test/' })
  const original = new Map()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  const style = dom.window.document.createElement('style')
  style.textContent = toolboxStyles + ui.computerVisualStyles + ui.workbenchStyles
  dom.window.document.head.append(style)
  const root = createRoot(dom.window.document.getElementById('root'))
  await act(async () => { root.render(React.createElement(ui.SitePermissions, { api })); await tick() })
  return {
    document: dom.window.document,
    computed: element => dom.window.getComputedStyle(element),
    async cleanup() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete globalThis[name]
      }
    },
  }
}

function assertCardStyle(m) {
  const card = m.document.querySelector('#root > section')
  assert.ok(card, 'Permission card renders in its actual sibling position')
  const style = m.computed(card)
  assert.equal(style.borderRadius, '12px')
  assert.equal(style.padding, '16px')
  assert.equal(style.marginTop, '12px')
  assert.equal(m.computed(card.querySelector('.qyt-computer-card-heading')).display, 'flex')
  assert.equal(m.computed(card.querySelector('.qyt-feature-icon')).width, '30px')
  assert.equal(m.computed(card.querySelector('.qyt-computer-caption')).fontSize, '11px')
  for (const button of card.querySelectorAll('button')) {
    const buttonStyle = m.computed(button)
    assert.equal(buttonStyle.borderRadius, '8px')
    assert.equal(buttonStyle.padding, '7px 11px')
    assert.equal(buttonStyle.fontSize, '12px')
  }
  assert.equal(card.getAttribute('aria-label'), '始终允许的网站')
  return card
}

test('empty website permissions inherit the same card and button styles as sibling toolbox cards', async () => {
  let reads = 0
  const m = await mount({ async permissions() { reads++; return [] } })
  try {
    const card = assertCardStyle(m)
    assert.match(card.textContent, /直接在聊天里提出浏览器任务即可/)
    assert.equal(card.querySelectorAll('button').length, 1)
    assert.equal(reads, 1)
  } finally { await m.cleanup() }
})

test('styled granted rows retain explicit revoke and refresh behavior without new computer actions', async () => {
  let origins = ['https://allowed.test'], reads = 0
  const revoked = []
  const m = await mount({
    async permissions() { reads++; return [...origins] },
    async revoke(origin, signal) { assert.equal(signal.aborted, false); revoked.push(origin); origins = [] },
  })
  try {
    const card = assertCardStyle(m)
    assert.equal(card.querySelector('.qyt-computer-permission-row span').textContent, 'https://allowed.test')
    const revoke = [...card.querySelectorAll('button')].find(button => button.textContent === '撤销')
    await act(async () => { revoke.click(); await tick(); await tick() })
    assert.deepEqual(revoked, ['https://allowed.test'])
    assert.equal(card.querySelector('.qyt-computer-permission-row'), null)
    assert.equal(reads, 2)
    await act(async () => { [...card.querySelectorAll('button')].find(button => button.textContent === '刷新许可').click(); await tick() })
    assert.equal(reads, 3)
    assertCardStyle(m)
  } finally { await m.cleanup() }
})

test('failed website permission read keeps a styled accessible card and recovers only on explicit refresh', async () => {
  let reads = 0
  const m = await mount({ async permissions() { reads++; if (reads === 1) throw Error('Synthetic read failure'); return [] } })
  try {
    const card = assertCardStyle(m)
    assert.equal(card.querySelector('[role="alert"]').textContent, '网站许可暂不可用，请刷新。')
    assert.equal(reads, 1)
    await act(async () => { card.querySelector('button').click(); await tick() })
    assert.equal(reads, 2)
    assert.equal(card.querySelector('[role="alert"]'), null)
    assertCardStyle(m)
  } finally { await m.cleanup() }
})
