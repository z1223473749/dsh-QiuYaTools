import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { wordPreviewFixture, spreadsheetPreviewFixture } from './fixtures/composer-attachment-files.mjs'
import { zipSync, strToU8 } from 'fflate'

const require = createRequire(import.meta.url)
const React = require('react')
const { act } = React
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://attachments.test' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
dom.window.File = File
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
const { createRoot } = require('react-dom/client')
const compiled = await build({
  stdin: { contents: "export * from './src/features/composer-attachments/drop.ts'; export * from './src/features/composer-attachments/preview.ts'; export * from './src/features/composer-attachments/index.tsx'; export {createPastedTextFile} from './src/features/pasted-text/index.tsx'", resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
})
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require, File, WeakMap, TextDecoder, Uint8Array, crypto, HTMLElement, document, window, DOMParser: dom.window.DOMParser, btoa })
const feature = module.exports
const tick = () => new Promise(resolve => setImmediate(resolve))
after(() => dom.window.close())

function transfer(files = [], items = files.map(file => ({ kind: 'file', getAsFile: () => file })), types = ['Files']) {
  return { files, items, types, dropEffect: 'none' }
}
function drag(target, type, data, extra = {}) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, Object.fromEntries(Object.entries({ dataTransfer: data, ...extra }).map(([key, value]) => [key, { value }])))
  target.dispatchEvent(event)
  return event
}
function card() {
  const element = document.createElement('div')
  element.setAttribute('data-composer-card', '')
  element.innerHTML = '<div data-composer-input contenteditable="true"><p>已有草稿😀</p></div><button>Send</button>'
  document.body.append(element)
  return element
}

test('mixed native Windows/macOS file payloads preserve exact bytes, names and metadata without host path identity', async () => {
  for (const nativePath of ['C:\\Users\\Test\\桌面\\a.txt', '/Users/test/Desktop/a.txt']) {
    const source = new File(['中文\r\n😀\0'], 'a.txt', { type: 'text/plain', lastModified: 12345 })
    Object.defineProperty(source, 'path', { value: nativePath })
    const result = feature.attachmentFile(source)
    assert.notEqual(result, source)
    assert.equal(result.path, undefined)
    assert.equal(result.name, source.name)
    assert.equal(result.type, source.type)
    assert.equal(result.lastModified, source.lastModified)
    assert.deepEqual(await result.arrayBuffer(), await source.arrayBuffer())
  }
  assert.equal(feature.attachmentFile(new File(['png'], '图.PNG')).type, 'image/png')
  assert.equal(feature.attachmentFile(new File(['x'], 'file.unknown')).type, '')
})

test('drag/drop snapshots both source collection shapes without duplicating a batch or rejecting any extension/empty files', async () => {
  const files = ['image.png', '正文.txt', 'table.xlsx', 'document.pdf', 'archive.zip', 'no-extension', 'empty.txt'].map(name => new File([name === 'empty.txt' ? '' : name], name))
  for (const data of [transfer(files), transfer([], files.map(file => ({ kind: 'file', getAsFile: () => file })), []), transfer(files, [], [])]) {
    const element = card(), added = [], errors = [], hovers = []
    let official = 0
    element.addEventListener('drop', () => official++)
    const dispose = feature.installComposerFileDrop(element, { canAccept: () => true, addFiles: files => added.push(files), onHover: value => hovers.push(value), onError: value => errors.push(value) })
    try {
      assert.equal(drag(element.firstChild, 'dragover', data).defaultPrevented, true)
      assert.equal(data.dropEffect, 'copy')
      assert.equal(drag(element.firstChild.firstChild, 'drop', data).defaultPrevented, true)
      assert.equal(official, 0)
      assert.equal(added.length, 1)
      assert.deepEqual(Array.from(added[0], file => file.name), files.map(file => file.name))
      assert.deepEqual(await Promise.all(added[0].map(file => file.text())), await Promise.all(files.map(file => file.text())))
      assert.equal(added[0].at(-1).size, 0)
      assert.equal(element.firstChild.textContent, '已有草稿😀')
      assert.deepEqual(errors, [])
      assert.equal(hovers.at(-1), false)
    } finally { dispose(); element.remove() }
  }
})

test('capture respects card/session scope, rejects directory/locked/unreadable payloads, and leaves text drags alone', () => {
  const element = card(), other = card(), errors = [], added = []
  let enabled = true
  const dispose = feature.installComposerFileDrop(element, { canAccept: () => enabled, addFiles: files => added.push(files), onHover() {}, onError: reason => errors.push(reason) })
  const file = new File(['ok'], 'a.txt')
  try {
    assert.equal(drag(other.firstChild, 'drop', transfer([file])).defaultPrevented, false)
    assert.equal(drag(element.firstChild, 'drop', transfer([], [{ kind: 'string' }], ['text/plain'])).defaultPrevented, false)
    const nested = card(); element.append(nested)
    assert.equal(drag(nested.firstChild, 'drop', transfer([file])).defaultPrevented, false)
    enabled = false
    const data = transfer([file]); drag(element, 'dragover', data); assert.equal(data.dropEffect, 'none')
    drag(element, 'drop', data)
    enabled = true
    drag(element, 'drop', transfer([file], [{ kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: true }) }]))
    drag(element, 'drop', transfer())
    assert.deepEqual(errors, ['blocked', 'directory', 'unavailable'])
    assert.equal(added.length, 0)
    dispose()
    assert.equal(drag(element, 'drop', transfer([file])).defaultPrevented, false)
  } finally { dispose(); element.remove(); other.remove() }
})

test('reinstall/unload cannot double-add or let an old disposer remove the new owner', () => {
  const element = card(), data = transfer([new File(['x'], 'a')])
  let added = 0
  const options = { canAccept: () => true, addFiles: () => added++, onHover() {}, onError() {} }
  const old = feature.installComposerFileDrop(element, options)
  const current = feature.installComposerFileDrop(element, options)
  old(); drag(element, 'drop', data); assert.equal(added, 1)
  current(); drag(element, 'drop', data); assert.equal(added, 1)
  element.remove()
})

test('file picker and file paste share the attachment path, preserve bytes and cannot insert native path chips', async () => {
  const element = card(), added = [], errors = []
  const input = document.createElement('input'); input.type = 'file'; element.append(input)
  const native = new File(['原始文档'], '反馈.docx')
  Object.defineProperty(native, 'path', { value: 'C:\\Users\\Test\\反馈.docx' })
  Object.defineProperty(input, 'files', { value: [native] })
  let originalEvents = 0
  input.addEventListener('change', () => originalEvents++)
  element.firstChild.addEventListener('paste', () => originalEvents++)
  const dispose = feature.installComposerFileDrop(element, { canAccept: () => true, addFiles: files => added.push(files), onHover() {}, onError: reason => errors.push(reason) })
  try {
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: transfer([native]) })
    element.firstChild.dispatchEvent(paste)
    assert.equal(originalEvents, 0)
    assert.equal(added.length, 2)
    for (const batch of added) { assert.equal(batch[0].path, undefined); assert.equal(await batch[0].text(), '原始文档') }
    assert.equal(element.firstChild.textContent, '已有草稿😀')
    assert.deepEqual(errors, [])
    dispose()
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    assert.equal(originalEvents, 1)
  } finally { dispose(); element.remove() }
})

test('valid Word and Excel files show actual paragraphs and first worksheet values, with corrupt/bounded fallback', async () => {
  const word = await feature.readFilePreview(new File([wordPreviewFixture()], '反馈.docx'))
  assert.equal(word.kind, 'document')
  assert.equal(word.blocks[0].text, '功能反馈与改进建议')
  assert.equal(word.blocks[0].bold, true)
  assert.equal(word.blocks[0].center, true)
  assert.match(word.blocks.map(block => block.text).join('\n'), /Word、Excel、PDF/)
  const sheet = await feature.readFilePreview(new File([spreadsheetPreviewFixture()], '回执.xlsx'))
  assert.equal(sheet.kind, 'table')
  assert.deepEqual(Array.from(sheet.rows[0]), ['项目', '负责人', '数量', '状态'])
  assert.equal(sheet.rows[1][0], '图片预览')
  assert.equal(sheet.rows[7][2], '48')
  const excessive = zipSync({ 'word/document.xml': new Uint8Array(5 * 1024 * 1024) })
  const forged = excessive.slice(), central = new DataView(forged.buffer)
  for (let offset = 0; offset < forged.length - 46; offset++) if (central.getUint32(offset, true) === 0x02014b50) { central.setUint32(offset + 24, 16, true); break }
  for (const bytes of [new Uint8Array([0, 1, 2]), excessive, forged, zipSync({ 'word/document.xml': strToU8('<!DOCTYPE x><x/>') })]) {
    assert.equal((await feature.readFilePreview(new File([bytes], 'invalid.docx'))).kind, 'file')
  }
})

test('text, long-paste TXT and quoted CSV/TSV previews read a bounded prefix and render content without changing original bytes', async () => {
  const text = '<script>alert("not HTML")</script>\r\n中文😀\n' + 'x'.repeat(20000)
  const file = feature.createPastedTextFile(text)
  const preview = await feature.readFilePreview(file)
  assert.equal(preview.kind, 'text')
  assert.match(preview.text, /<script>/)
  assert.match(preview.text, /中文😀/)
  assert.ok(preview.text.length < 1000)
  assert.equal(await file.text(), text)
  let sliceArgs
  await feature.readFilePreview({ name: 'huge.log', type: '', slice(start, end) { sliceArgs = [start, end]; return new Blob(['log']) } })
  assert.deepEqual(sliceArgs, [0, 16 * 1024])
  assert.deepEqual(JSON.parse(JSON.stringify(await feature.readFilePreview(new File(['name,value\r\n"a,b","line1\nline2"\r\n"a""b",3'], 'table.csv')))), { kind: 'table', rows: [['name', 'value'], ['a,b', 'line1\nline2'], ['a"b', '3']] })
  assert.equal((await feature.readFilePreview(new File(['a\tb\n1\t2'], 'table.tsv'))).rows[1][1], '2')
  assert.equal((await feature.readFilePreview(new File([new Uint8Array([255, 254, 45, 78, 135, 101])], 'win.txt'))).text, '中文')
  for (const file of [new File(['\0binary'], 'fake.txt'), new File(['zip'], 'a.xlsx'), new File(['bytes'], 'a.unknown')]) assert.equal((await feature.readFilePreview(file)).kind, 'file')
})

test('attachment rail follows official upload/retry/remove state and text preview stays inert; stale reads cannot replace another session', async () => {
  const root = createRoot(document.getElementById('root'))
  const removed = [], retried = [], added = []
  let resolveOld
  const slowFile = { name: 'old.txt', type: 'text/plain', size: 3, slice: () => ({ arrayBuffer: () => new Promise(resolve => { resolveOld = resolve }) }) }
  const pasted = feature.createPastedTextFile('<img src=x onerror=alert(1)>\n正文预览\n'.repeat(20))
  let props = {
    sessionId: 'one', attachments: [{ id: 'old', kind: 'file', file: slowFile }], uploads: {}, canAcceptDrop: true,
    onAddFiles: files => added.push(files), onRemoveAttachment: id => removed.push(id), onRetryFile: id => retried.push(id), t: key => key,
  }
  const render = async () => { await act(async () => { root.render(React.createElement('div', { 'data-composer-card': '' }, React.createElement(feature.ComposerAttachments, props), React.createElement('div', { 'data-composer-input': '', contentEditable: true, suppressContentEditableWarning: true }, 'draft'))); await tick() }) }
  try {
    await render()
    props = { ...props, sessionId: 'two', attachments: [{ id: 'new', kind: 'file', file: pasted }], uploads: { new: { status: 'error', message: 'Test upload failure' } } }
    await render()
    await act(async () => { resolveOld(new TextEncoder().encode('WRONG SESSION').buffer); await tick() })
    assert.match(document.querySelector('.qyt-attachment-text').textContent, /正文预览/)
    assert.doesNotMatch(document.querySelector('.qyt-attachment-text').textContent, /WRONG SESSION/)
    assert.equal(document.querySelector('.qyt-attachment-text img'), null)
    act(() => document.querySelector('.qyt-attachment-retry button').click())
    assert.deepEqual(retried, ['new'])
    act(() => document.querySelector('.qyt-attachment-remove').click())
    assert.deepEqual(removed, ['new'])
    props = { ...props, uploads: { new: { status: 'uploading', loaded: 50, total: 100 } } }; await render()
    assert.match(document.querySelector('.qyt-attachment-state').textContent, /50%/)
    props = { ...props, uploads: { new: { status: 'ready' } } }; await render()
    assert.equal(document.querySelector('.qyt-attachment-card').dataset.status, 'ready')
    await act(async () => { drag(document.querySelector('[data-composer-input]'), 'drop', transfer([new File(['new'], 'from-app.txt')])); await tick() })
    assert.equal(added.length, 1)
    assert.equal(document.querySelector('[data-composer-input]').textContent, 'draft')
    act(() => document.querySelector('.qyt-attachment-open').click())
    assert.equal(document.querySelector('dialog').open, true)
    act(() => document.querySelector('dialog button').click())
    assert.equal(document.querySelector('dialog'), null)
    props = { ...props, attachments: [] }; await render()
    assert.equal(document.querySelector('.qyt-attachment-rail'), null)
  } finally { await act(async () => root.unmount()) }
})
