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
  entryPoints: [new URL('../src/client/about.tsx', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', target: 'node22', format: 'cjs', packages: 'external',
  jsx: 'transform', loader: { '.css': 'text' },
  plugins: [{ name: 'inline-brand-fixture', setup(builder) {
    builder.onResolve({ filter: /brand-assets\.ts$/ }, () => ({ path: 'brand', namespace: 'brand-stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'brand-stub' }, () => ({ contents: 'export const COLOR_ICON_DATA_URL = "data:image/webp;base64,fixture"' }))
  } }],
})
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require })
const { AboutPanel } = module.exports

function mount(handler, usePublicGet = false) {
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
  act(() => root.render(React.createElement(AboutPanel, { version: '0.2.3', ctx })))
  return {
    container, calls, lookedUp,
    button(label) { return [...container.querySelectorAll('button')].find(button => button.textContent === label) },
    async click(label) { await act(async () => { Simulate.click(this.button(label)) }) },
    dispose() { act(() => root.unmount()); container.remove() },
  }
}

test('About presents the chosen brand art, keeps every public entry and hides decorative details from accessibility', () => {
  const f = mount(() => Promise.reject(new Error('No request expected')))
  try {
    const image = f.container.querySelector('.qyt-about-hero img')
    assert.equal(image.getAttribute('width'), '108')
    assert.equal(image.getAttribute('height'), '108')
    assert.equal(image.alt, '白发少年坐在鲸鱼上')
    assert.match(f.container.querySelector('.qyt-about-title').textContent, /QiuYaTools/)
    for (const selector of ['.qyt-about-sky', '.qyt-about-halo', '.qyt-about-sea']) {
      assert.equal(f.container.querySelector(selector).getAttribute('aria-hidden'), 'true')
    }
    const projectLinks = [...f.container.querySelectorAll('nav[aria-label="项目与反馈"] a')]
    assert.equal(projectLinks.length, 2)
    assert.equal(new URL(projectLinks[0].href).hostname, 'github.com')
    assert.equal(new URL(projectLinks[1].href).pathname.endsWith('/issues'), true)
    assert.equal([...f.container.querySelectorAll('button')].some(button => button.textContent.includes('检查更新')), false)
    assert.doesNotMatch(f.container.textContent, /版本与更新/)
    const website = f.container.querySelector('a[href="https://www.qiuya.cc"]')
    assert.ok(website)
    assert.match(website.textContent, /www\.qiuya\.cc/)
    for (const link of [...projectLinks, website]) {
      assert.equal(link.target, '_blank')
      assert.equal(link.rel, 'noopener noreferrer')
    }
    assert.doesNotMatch(f.container.querySelector('footer').textContent, /AI|图标/)
    assert.equal(f.calls.length, 0)
  } finally { f.dispose() }
})

test.after(() => dom.window.close())
