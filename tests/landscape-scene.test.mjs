import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
const source = (await build({ entryPoints: ['src/client/landscape-scene.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' })).outputFiles[0].text
function fixture(t, options = {}) {
  const dom = new JSDOM('<body><main data-slot="main.conversation"><section data-phase="hero"><button>Native action</button></section></main></body>', { pretendToBeVisual: true })
  const win = dom.window, doc = win.document, frames = new Map(), media = []
  let n = 0, hidden = false
  Object.defineProperty(doc, 'hidden', { get: () => hidden })
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 })
  win.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [this.getBoundingClientRect()] }
  win.requestAnimationFrame = cb => { frames.set(++n, cb); return n }; win.cancelAnimationFrame = id => frames.delete(id)
  win.ResizeObserver = class { observe() {} disconnect() {} }
  win.matchMedia = () => { const callbacks = new Set(); const state = { matches: false, addEventListener(_, cb) { callbacks.add(cb) }, removeEventListener(_, cb) { callbacks.delete(cb) }, change(value) { state.matches = value; callbacks.forEach(cb => cb()) } }; media.push(state); return state }
  const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports })
  const stop = module.exports.installLandscapeScene(doc, options)
  t.after(() => { stop(); win.close() })
  return { doc, win, stop, frames, media, frame(time) { const cbs = [...frames.values()]; frames.clear(); cbs.forEach(cb => cb(time)) }, visibility(value) { hidden = value; doc.dispatchEvent(new win.Event('visibilitychange')) } }
}
test('landscape animates decoration only, pauses, and releases stale callbacks', t => {
  const f = fixture(t, { movement: 'pan' })
  const layer = f.doc.querySelector('[data-qyt-landscape-scene]'), art = f.doc.querySelector('[data-qyt-landscape-art]')
  assert.equal(layer.style.pointerEvents, 'none'); assert.equal(layer.getAttribute('inert'), '')
  assert.equal(f.doc.querySelector('button').closest('[data-qyt-landscape-scene]'), null)
  f.frame(1000); const before = art.style.transform; f.frame(1100); assert.notEqual(art.style.transform, before)
  const stale = [...f.frames.values()][0]
  f.visibility(true); assert.equal(f.frames.size, 0); stale(1200); assert.equal(f.frames.size, 0)
  f.visibility(false); assert.equal(f.frames.size, 1)
  f.media[0].change(true); assert.equal(f.doc.querySelector('[data-qyt-landscape-scene]'), null); assert.equal(f.frames.size, 0)
  f.media[0].change(false); assert.ok(f.doc.querySelector('[data-qyt-landscape-scene]'))
  f.stop(); f.stop(); assert.equal(f.frames.size, 0); assert.equal(f.doc.querySelector('[data-qyt-landscape-scene]'), null)
})
test('host replacement moves decoration and static atmosphere allocates no particles', async t => {
  const f = fixture(t, { atmosphere: 'none' })
  const previous = f.doc.querySelector('[data-qyt-landscape-scene]')
  assert.equal(previous.querySelectorAll('i').length, 0)
  const section = f.doc.createElement('section'); section.dataset.phase = 'active'
  f.doc.querySelector('[data-phase]').replaceWith(section)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(previous.isConnected, false)
  assert.equal(section.querySelectorAll('[data-qyt-landscape-scene]').length, 1)
})

test('theme painters share scene suspension, disposal and stale-frame protection', t => {
  let draws = 0, allocations = 0, disposals = 0
  const f = fixture(t, { movement: 'none', createArt(doc) {
    allocations++
    return { element: doc.createElement('canvas'), draw() { draws++ }, dispose() { disposals++ } }
  } })
  f.frame(1000); assert.equal(draws, 1)
  const stale = [...f.frames.values()][0]
  f.media[0].change(true)
  assert.equal(disposals, 1); assert.equal(f.doc.querySelector('canvas'), null)
  stale(1200); assert.equal(draws, 1)
  f.media[0].change(false); f.frame(1400)
  assert.equal(allocations, 2); assert.equal(draws, 2)
  f.stop(); assert.equal(disposals, 2); assert.equal(f.frames.size, 0)
})

test('a failed art renderer leaves the original static background without retry loops', t => {
  let allocations = 0, disposals = 0
  const f = fixture(t, { createArt(doc) {
    allocations++
    return { element: doc.createElement('canvas'), draw() { throw Error('GPU lost') }, dispose() { disposals++ } }
  } })
  f.frame(1000)
  assert.equal(disposals, 1); assert.equal(f.frames.size, 0)
  assert.equal(f.doc.querySelector('[data-qyt-landscape-scene]'), null)
  f.visibility(true); f.visibility(false)
  assert.equal(allocations, 1)
})
