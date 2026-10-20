import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/features/pasted-text/index.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', target: 'node22', format: 'cjs', packages: 'external',
})
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, {
  module, exports: module.exports, require, File, crypto: webcrypto, WeakMap,
})
const pasted = module.exports
const options = addFiles => ({ readThresholds: () => undefined, addFiles })
const large = '中文'.repeat(500)

test('pasted text uses inclusive Unicode-character and logical-line thresholds', () => {
  for (const [text, expected] of [
    ['', false], [' \t\r\n'.repeat(500), false],
    ['x'.repeat(999), false], ['x'.repeat(1000), true],
    ['中'.repeat(999), false], ['中'.repeat(1000), true],
    ['😀'.repeat(999), false], ['😀'.repeat(1000), true],
    [Array(14).fill('a').join('\n'), false], [Array(15).fill('a').join('\n'), true],
    [Array(14).fill('a').join('\r\n'), false], [Array(15).fill('a').join('\r\n'), true],
    [Array(15).fill('a').join('\r'), true],
  ]) assert.equal(pasted.shouldAttachPastedText(text), expected, JSON.stringify(text.slice(0, 40)))
  assert.equal(pasted.shouldAttachPastedText('😀😀', { characters: 3, lines: 2 }), false)
  assert.equal(pasted.shouldAttachPastedText('😀😀😀', { characters: 3, lines: 2 }), true)
  assert.equal(pasted.shouldAttachPastedText('a\r\nb', { characters: 100, lines: 2 }), true)
  assert.equal(pasted.shouldAttachPastedText('a', { characters: 100, lines: 1 }), true)
})

test('pasted text bounds reject malformed values independently and preserve valid values', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, '10', null]) {
    const limits = pasted.normalizePastedTextThresholds({ characters: value, lines: 20 })
    assert.equal(limits.characters, 1000)
    assert.equal(limits.lines, 20)
  }
  assert.equal(pasted.normalizePastedTextThresholds({ characters: 1_000_000 }).characters, 1_000_000)
  assert.equal(pasted.normalizePastedTextThresholds({ characters: 1_000_001 }).characters, 1000)
  assert.equal(pasted.normalizePastedTextThresholds({ lines: 100_000 }).lines, 100_000)
  assert.equal(pasted.normalizePastedTextThresholds({ lines: 100_001 }).lines, 15)
})

test('pasted TXT preserves bytes and creates one unique browser file per accepted paste', async () => {
  const text = '中文😀\r\n  {"log": "test"}\r\n\r\n\t' + large
  const first = pasted.createPastedTextFile(text)
  const second = pasted.createPastedTextFile(text, 'Pasted text')
  assert.match(first.name, /^粘贴文本-\d{8}-\d{6}-[a-f0-9]{8}\.txt$/)
  assert.match(second.name, /^Pasted text-\d{8}-\d{6}-[a-f0-9]{8}\.txt$/)
  assert.notEqual(first.name, second.name)
  assert.equal(first.type, 'text/plain')
  assert.equal(first.size, Buffer.byteLength(text, 'utf8'))
  assert.equal(await first.text(), text)
  assert.equal('path' in first, false)
})

test('pasted text requires synchronous composer acceptance and reads thresholds per paste', () => {
  const received = []
  let characters = 1000
  const intake = {
    readThresholds: () => ({ characters, lines: 100 }),
    addFiles: files => { received.push(files); return null },
  }
  assert.equal(pasted.acceptPastedTextFile('short', intake), false)
  assert.equal(received.length, 0)
  characters = 5
  assert.equal(pasted.acceptPastedTextFile('short', intake), true)
  assert.equal(received.length, 1)
  assert.equal(received[0].length, 1)
  assert.equal(pasted.acceptPastedTextFile(large, options(() => 'unavailable')), false)
  assert.equal(pasted.acceptPastedTextFile(large, options(() => { throw Error('failed') })), false)
  assert.equal(pasted.acceptPastedTextFile(large, options(() => Promise.resolve(null))), false)
  assert.equal(pasted.acceptPastedTextFile(large, {
    ...intake, readThresholds: () => { throw Error('config-unavailable') },
  }), false)
})

function composerFixture() {
  class Element {
    constructor(type, parent = null) { this.type = type; this.parent = parent; this.attributes = {} }
    closest(selector) {
      const target = selector === '[data-composer-input]' ? 'editor'
        : selector === '[data-composer-card]' ? 'card' : undefined
      for (let current = this; current; current = current.parent) if (current.type === target) return current
      return null
    }
    getAttribute(name) { return this.attributes[name] ?? null }
  }
  class HTMLElement extends Element {}
  const listeners = new Set()
  const card = new HTMLElement('card')
  const page = { Element, HTMLElement }
  card.ownerDocument = { defaultView: page }
  page.addEventListener = (type, listener, capture) => {
    assert.equal(type, 'paste'); assert.equal(capture, true); listeners.add(listener)
  }
  page.removeEventListener = (type, listener, capture) => {
    assert.equal(type, 'paste'); assert.equal(capture, true); listeners.delete(listener)
  }
  const editor = new HTMLElement('editor', card)
  editor.attributes.contenteditable = 'true'
  const dispatch = (text = large, patch = {}) => {
    const event = {
      target: editor, cancelable: true, defaultPrevented: false, immediateStopped: false,
      clipboardData: { items: [], files: [], getData: type => { assert.equal(type, 'text/plain'); return text } },
      preventDefault() { this.defaultPrevented = true },
      stopImmediatePropagation() { this.immediateStopped = true },
      ...patch,
    }
    for (const listener of listeners) { listener(event); if (event.immediateStopped) break }
    return event
  }
  return { Element, HTMLElement, card, editor, listeners, dispatch }
}

test('pasted text capture only consumes successful large-text pastes in its own editable composer', () => {
  const f = composerFixture()
  const files = []
  const dispose = pasted.installPastedTextCapture(f.card, options(batch => { files.push(batch); return null }))
  const accepted = f.dispatch()
  assert.equal(accepted.defaultPrevented, true)
  assert.equal(accepted.immediateStopped, true)
  assert.equal(files.length, 1)
  const child = new f.HTMLElement('child', f.editor)
  assert.equal(f.dispatch(large, { target: child }).defaultPrevented, true)
  assert.equal(files.length, 2)
  for (const patch of [
    { target: new f.HTMLElement('other', f.card) },
    { target: new f.HTMLElement('editor', new f.HTMLElement('card', f.card)) },
    { clipboardData: null }, { cancelable: false }, { defaultPrevented: true },
    { clipboardData: { items: [{ kind: 'file' }], files: [], getData: () => large } },
    { clipboardData: { items: [], files: [new File(['x'], 'a.txt')], getData: () => large } },
  ]) f.dispatch(large, patch)
  assert.equal(files.length, 2, 'unrelated, nested, canceled, and file pastes stay on the official path')
  assert.equal(f.dispatch('short').defaultPrevented, false)
  f.editor.attributes.contenteditable = 'false'
  assert.equal(f.dispatch().defaultPrevented, false)
  f.editor.attributes.contenteditable = 'true'
  f.editor.attributes['aria-disabled'] = 'true'
  assert.equal(f.dispatch().defaultPrevented, false)
  assert.equal(files.length, 2)
  dispose(); dispose()
  assert.equal(f.listeners.size, 0)
  assert.equal(f.dispatch().defaultPrevented, false)
})

test('pasted text rejection leaves normal paste available and replacing a listener cannot double-attach', () => {
  const f = composerFixture()
  let count = 0
  const old = pasted.installPastedTextCapture(f.card, options(() => { count++; return null }))
  const replacement = pasted.installPastedTextCapture(f.card, options(() => { count++; return 'unavailable' }))
  assert.equal(f.listeners.size, 1)
  old()
  assert.equal(f.listeners.size, 1, 'an old disposer cannot remove a newer owner')
  assert.equal(f.dispatch().defaultPrevented, false)
  assert.equal(count, 1)
  replacement()
  assert.equal(f.listeners.size, 0)
})

test('pasted text adapts the current composer receiver without modifying registry entries', () => {
  const seen = []
  const files = [new File([large], 'a.txt')]
  let current = batch => { seen.push(['first', batch]); return null }
  const entry = { inject: id => { assert.equal(id, 'session-1'); return { addFiles: current } } }
  const entries = [{}, { inject: () => { throw Error('unavailable') } }, entry]
  assert.equal(pasted.composerAddFiles(entries, 'session-1')(files), null)
  current = batch => { seen.push(['second', batch]); return 'refused' }
  assert.equal(pasted.composerAddFiles(entries, 'session-1')(files), 'refused')
  assert.deepEqual(seen.map(value => value[0]), ['first', 'second'])
  assert.equal(pasted.composerAddFiles([{ inject: () => ({ addFiles: undefined }) }], 'session-1'), undefined)
  assert.equal(entries[2], entry)
})

test('pasted text installs into an additive slot and returns the declaration lifecycle disposer', () => {
  let registered
  let disposed = false
  const dispose = pasted.installPastedText({
    ctx: { slots: {
      inject(name, callback) { assert.equal(name, 'conversation.input.overlay'); return callback() },
      register(options, component) {
        registered = { options, component }
        return () => { disposed = true }
      },
    } },
    readThresholds: () => undefined,
  })
  assert.equal(registered.options.name, 'conversation.input.overlay')
  assert.equal(registered.options.id, 'qiuya-tools-pasted-text')
  assert.equal(typeof registered.component, 'function')
  dispose()
  assert.equal(disposed, true)
})

test('pasted text uses native DOM capture before the official editor and restores it on unload', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<div data-composer-card><div data-composer-input contenteditable="true"><p>draft</p></div><input /></div>')
  const { document, Event } = dom.window
  const card = document.querySelector('[data-composer-card]')
  const editor = document.querySelector('[data-composer-input]')
  const received = []
  let officialPastes = 0
  editor.addEventListener('paste', () => { officialPastes++ })
  const send = (target, text, items = []) => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items, files: [], getData: () => text } })
    target.dispatchEvent(event)
    return event
  }
  const dispose = pasted.installPastedTextCapture(card, options(files => { received.push(files); return null }))
  try {
    assert.equal(send(editor.firstElementChild, large).defaultPrevented, true)
    assert.equal(officialPastes, 0, 'one accepted file suppresses Lexical text insertion')
    assert.equal(editor.textContent, 'draft', 'the existing draft and selection surface stay in place')
    assert.equal(received.length, 1)
    assert.equal(await received[0][0].text(), large)
    send(editor, 'short')
    send(editor, large, [{ kind: 'file' }])
    send(card.querySelector('input'), large)
    assert.equal(officialPastes, 2)
    assert.equal(received.length, 1)
    dispose()
    assert.equal(send(editor, large).defaultPrevented, false)
    assert.equal(officialPastes, 3)
  } finally {
    dispose()
    dom.window.close()
  }
})

test('the installed paste bridge preserves null acceptance and intercepts before React root capture and native editor insertion', async () => {
  const { JSDOM } = await import('jsdom')
  const React = require('react')
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://harness.test/' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = require('react-dom/client')
  const { act } = React
  const featureModule = { exports: {} }
  vm.runInNewContext(compiled.outputFiles[0].text, {
    module: featureModule, exports: featureModule.exports, require, File, crypto: webcrypto, WeakMap,
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  })
  let Bridge
  let acceptance = 'accept'
  let attempts = 0
  let captureCalls = 0
  let bubbleCalls = 0
  let insertions = 0
  const received = []
  const root = createRoot(dom.window.document.querySelector('#root'))
  const dispose = featureModule.exports.installPastedText({
    ctx: { slots: {
      inject(name, callback) { assert.equal(name, 'conversation.input.overlay'); return callback() },
      register(_options, component) { Bridge = component; return () => { act(() => root.unmount()) } },
      entriesOfSlot(name) {
        assert.equal(name, 'conversation.composer.bar')
        return [{ inject(sessionId) {
          assert.equal(sessionId, 'session-one')
          return { addFiles(files) {
            attempts++
            if (acceptance === 'throw') throw Error('intake failed')
            if (acceptance === 'reject') return 'intake refused'
            received.push(files)
            return null
          } }
        } }]
      },
    } },
    readThresholds: () => undefined,
  })
  act(() => root.render(React.createElement('main', {
    onPasteCapture: () => { captureCalls++ },
    onPaste: () => { bubbleCalls++ },
  }, React.createElement('div', { 'data-composer-card': '' },
    React.createElement(Bridge, { sessionId: 'session-one', useSession: selector => selector({ subagent: null }) }),
    React.createElement('div', { 'data-composer-input': '', contentEditable: true, suppressContentEditableWarning: true }, 'existing draft'),
  ))))
  const editor = dom.window.document.querySelector('[data-composer-input]')
  editor.addEventListener('paste', event => {
    insertions++
    editor.textContent += event.clipboardData.getData('text/plain')
    event.preventDefault()
  })
  const send = () => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items: [], files: [], getData: () => large } })
    act(() => editor.dispatchEvent(event))
    return event
  }
  try {
    send()
    assert.equal(attempts, 1)
    assert.equal(received.length, 1, 'the complete installed adapter must create exactly one attachment')
    assert.equal(await received[0][0].text(), large)
    assert.equal(captureCalls, 0, 'window capture must precede React delegated capture')
    assert.equal(bubbleCalls, 0)
    assert.equal(insertions, 0, 'the official editor must never receive an accepted attachment paste')
    assert.equal(editor.textContent, 'existing draft', 'existing draft content must be preserved verbatim')
    for (const failure of ['reject', 'throw']) {
      acceptance = failure
      const before = editor.textContent
      send()
      assert.equal(editor.textContent, before + large, `${failure} must fall back to exactly one text insertion`)
    }
    assert.equal(received.length, 1)
    assert.equal(attempts, 3)
    assert.equal(captureCalls, 2)
    assert.equal(bubbleCalls, 2)
    assert.equal(insertions, 2)
  } finally {
    dispose()
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
