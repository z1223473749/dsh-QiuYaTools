import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const source = (await build({ entryPoints: [new URL('../src/features/session-windows/index.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'browser', format: 'cjs', packages: 'external' })).outputFiles[0].text

function fixture() {
  const dom = new JSDOM('<body><div role="tree"><div data-row-key="session:A" draggable="true"></div><div data-row-key="session:B"></div></div><main></main></body>', { url: 'https://local.invalid/' })
  class DragEvent extends dom.window.Event {
    constructor(type, options) {
      super(type, options)
      for (const [key, value] of Object.entries(options)) if (!['bubbles', 'cancelable'].includes(key)) Object.defineProperty(this, key, { value })
    }
  }
  dom.window.DragEvent = DragEvent
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, window: dom.window, document: dom.window.document, setTimeout, clearTimeout, require: id => id === 'react-dom' ? { flushSync: callback => callback() } : id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(id) })
  const calls = []
  let available = true
  const off = module.exports.installSessionWindowDrag(dom.window, {
    canOpen: () => available,
    prepare: id => calls.push(['prepare', id]),
    cancel: id => calls.push(['cancel', id]),
    open: id => calls.push(['open', id]),
  })
  const event = (type, overrides = {}) => new DragEvent(type, { bubbles: true, cancelable: true, screenX: 100, screenY: 100, clientX: 10, clientY: 10, dataTransfer: { dropEffect: 'none' }, ...overrides })
  return { dom, calls, off, event, row: dom.window.document.querySelector('[data-row-key="session:A"]'), main: dom.window.document.querySelector('main'), unavailable: () => { available = false } }
}

test('drag preparation starts with the exact row and a successful detach commits it once', () => {
  const h = fixture()
  try {
    h.row.dispatchEvent(h.event('dragstart'))
    assert.deepEqual(h.calls, [['prepare', 'A']])
    h.main.dispatchEvent(h.event('drop'))
    h.row.dispatchEvent(h.event('dragend'))
    assert.deepEqual(h.calls, [['prepare', 'A'], ['open', 'A']])
    h.off()
    assert.deepEqual(h.calls, [['prepare', 'A'], ['open', 'A']])
  } finally { h.off(); h.dom.window.close() }
})

test('Escape, an internal drop, lost availability, and teardown cancel preparation without opening', () => {
  for (const scenario of ['escape', 'internal', 'unavailable', 'teardown']) {
    const h = fixture()
    try {
      h.row.dispatchEvent(h.event('dragstart'))
      if (scenario === 'escape') h.dom.window.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
      if (scenario === 'internal') h.row.dispatchEvent(h.event('drop'))
      if (scenario === 'unavailable') h.unavailable()
      if (scenario === 'teardown') h.off()
      else h.row.dispatchEvent(h.event('dragend', { screenX: 2000, clientX: 2000 }))
      assert.deepEqual(h.calls, [['prepare', 'A'], ['cancel', 'A']], scenario)
    } finally { h.off(); h.dom.window.close() }
  }
})

test('an external drop opens the prepared target and multi-selection never preloads', () => {
  const h = fixture()
  try {
    h.row.dispatchEvent(h.event('dragstart'))
    h.row.dispatchEvent(h.event('dragend', { screenX: 2000, clientX: 2000 }))
    assert.deepEqual(h.calls, [['prepare', 'A'], ['open', 'A']])
    h.row.setAttribute('data-qyt-bulk-selected', 'true')
    h.row.dispatchEvent(h.event('dragstart'))
    h.off()
    assert.deepEqual(h.calls, [['prepare', 'A'], ['open', 'A']])
  } finally { h.off(); h.dom.window.close() }
})
