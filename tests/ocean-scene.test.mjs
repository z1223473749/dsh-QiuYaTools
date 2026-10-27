import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const source = (await build({
  entryPoints: [fileURLToPath(new URL('../src/client/ocean-scene.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs',
})).outputFiles[0].text

function graphics({ initializationError = 0, firstDrawError = 0 } = {}) {
  const live = new Set()
  const calls = { contexts: 0, draws: 0, allocations: 0 }
  const constants = new Map()
  let pendingError = initializationError
  const gl = new Proxy({
    canvas: null,
    NO_ERROR: 0,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    getParameter: () => 4096,
    getError() { const error = pendingError; pendingError = 0; return error },
    isContextLost: () => false,
    getExtension: () => null,
    drawArrays() { calls.draws++; if (calls.draws === 1) pendingError = firstDrawError },
  }, {
    get(target, name) {
      if (name in target) return target[name]
      if (typeof name === 'string' && name.startsWith('create')) return () => { const resource = {}; live.add(resource); calls.allocations++; return resource }
      if (typeof name === 'string' && name.startsWith('delete')) return resource => live.delete(resource)
      if (typeof name === 'string' && /^[A-Z_0-9]+$/u.test(name)) {
        if (!constants.has(name)) constants.set(name, constants.size + 1)
        return constants.get(name)
      }
      return () => {}
    },
  })
  return { gl, live, calls }
}

function fixture(t, { reduced = false, forced = false, context = true, raf = true, missing, initializationError = 0, firstDrawError = 0 } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body data-qyt-q-theme="ocean"><main data-slot="main.conversation"><section data-phase="hero"><button>Native action</button></section></main></body></html>', { pretendToBeVisual: true })
  const win = dom.window
  const doc = win.document
  const gpu = graphics({ initializationError, firstDrawError })
  const frames = new Map()
  const images = []
  const media = new Map()
  const resizeObservers = new Set()
  let frameId = 0
  let destroyed = false
  win.requestAnimationFrame = raf ? callback => { frames.set(++frameId, callback); return frameId } : undefined
  win.cancelAnimationFrame = id => frames.delete(id)
  win.matchMedia = query => {
    if (!media.has(query)) {
      const listeners = new Set()
      const state = {
        media: query, matches: query.includes('reduced-motion') ? reduced : query.includes('forced-colors') ? forced : false,
        addEventListener(_type, callback) { listeners.add(callback) },
        removeEventListener(_type, callback) { listeners.delete(callback) },
        addListener(callback) { listeners.add(callback) },
        removeListener(callback) { listeners.delete(callback) },
        listeners,
        change(value) { state.matches = value; for (const callback of [...listeners]) callback({ matches: value, media: query }) },
      }
      media.set(query, state)
    }
    return media.get(query)
  }
  win.ResizeObserver = class {
    constructor(callback) { this.callback = callback; resizeObservers.add(this) }
    observe() {}
    unobserve() {}
    disconnect() { resizeObservers.delete(this) }
  }
  win.Path2D = class { constructor(path) { this.path = path } }
  const maskContext = { fillRect() {}, fill() {}, createLinearGradient: () => ({ addColorStop() {} }) }
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 280, top: 0, right: 1280, bottom: 900, width: 1000, height: 900, x: 280, y: 0, toJSON() { return {} } }
  }
  win.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] }
  win.HTMLCanvasElement.prototype.getContext = function (kind) {
    if (kind === '2d') return maskContext
    if (!kind.includes('webgl')) return null
    gpu.calls.contexts++
    gpu.gl.canvas = this
    return context ? gpu.gl : null
  }
  win.Image = class extends win.EventTarget {
    onload = null
    onerror = null
    naturalWidth = 1600
    naturalHeight = 900
    width = 1600
    height = 900
    complete = false
    set src(value) { this.url = value; if (value) images.push(this) }
    get src() { return this.url }
    load() {
      this.complete = true
      const event = new win.Event('load')
      this.onload?.(event)
      this.dispatchEvent(event)
    }
  }
  if (missing) win[missing] = undefined
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, window: win, document: doc,
    Image: win.Image, MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
    performance: win.performance, requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
  })
  const stop = module.exports.installOceanScene(doc)
  const cleanup = () => { if (destroyed) return; destroyed = true; stop(); stop() }
  t.after(() => { cleanup(); win.close() })
  return {
    dom, win, doc, gpu, frames, images, media, resizeObservers, stop, cleanup,
    host: () => doc.querySelector('[data-phase]'),
    canvas: () => doc.querySelector('canvas[data-qyt-ocean-scene]'),
    async tick() { await new Promise(resolve => setImmediate(resolve)) },
    frame(time = 1000) {
      const current = [...frames]
      frames.clear()
      for (const [, callback] of current) callback(time)
    },
    async ready() {
      await this.tick()
      for (const image of [...images]) image.load()
      await this.tick()
      this.frame()
      await this.tick()
    },
  }
}

test('missing animation capability leaves the native DOM and static illustration alone', t => {
  const f = fixture(t, { raf: false })
  assert.equal(f.canvas(), null)
  assert.equal(f.gpu.calls.contexts, 0)
  assert.equal(f.frames.size, 0)
  assert.equal(f.host().hasAttribute('data-qyt-ocean-live'), false)
  assert.equal(f.doc.querySelector('button').textContent, 'Native action')
})

test('missing media or layout APIs safely retain the static illustration', t => {
  for (const missing of ['matchMedia', 'ResizeObserver', 'MutationObserver']) {
    const f = fixture(t, { missing })
    assert.equal(f.canvas(), null)
    assert.equal(f.gpu.calls.contexts, 0)
    assert.equal(f.frames.size, 0)
  }
})

test('reduced motion and forced colors avoid allocating a graphics context', async t => {
  for (const options of [{ reduced: true }, { forced: true }]) {
    const f = fixture(t, options)
    await f.tick()
    assert.equal(f.gpu.calls.contexts, 0)
    assert.equal(f.frames.size, 0)
    assert.equal(f.host().hasAttribute('data-qyt-ocean-live'), false)
  }
})

test('unavailable WebGL keeps the static fallback and has no animation loop', async t => {
  const f = fixture(t, { context: false })
  await f.ready()
  assert.ok(f.gpu.calls.contexts > 0, 'the fallback is exercised after attempting WebGL')
  assert.equal(f.gpu.calls.allocations, 0)
  assert.equal(f.host().hasAttribute('data-qyt-ocean-live'), false)
  assert.equal(f.frames.size, 0)
})

test('WebGL errors without JavaScript exceptions never replace the static illustration', async t => {
  for (const options of [{ initializationError: 1281 }, { firstDrawError: 1282 }]) {
    const f = fixture(t, options)
    await f.ready()
    assert.ok(f.gpu.calls.allocations > 0, 'the failure occurs after a real initialization attempt')
    if (options.firstDrawError) assert.equal(f.gpu.calls.draws, 1, 'a failed first frame must be checked before declaring the scene ready')
    assert.equal(f.host().hasAttribute('data-qyt-ocean-live'), false)
    assert.equal(f.canvas(), null)
    assert.equal(f.gpu.live.size, 0)
    assert.equal(f.frames.size, 0)
    const contexts = f.gpu.calls.contexts
    f.doc.body.append(f.doc.createElement('div'))
    await f.tick()
    f.frame(5000)
    assert.equal(f.gpu.calls.contexts, contexts, 'a GPU failure cannot create a retry loop')
  }
})

test('destroy before image load cancels work and ignores an image arriving late', async t => {
  const f = fixture(t)
  await f.tick()
  const pendingImages = [...f.images]
  f.cleanup()
  const draws = f.gpu.calls.draws
  for (const image of pendingImages) image.load()
  f.frame(2000)
  await f.tick()
  assert.equal(f.canvas(), null)
  assert.equal(f.doc.querySelector('[data-qyt-ocean-wash]'), null)
  assert.equal(f.host().hasAttribute('data-qyt-ocean-live'), false)
  assert.equal(f.frames.size, 0)
  assert.equal(f.gpu.calls.draws, draws)
  assert.equal(f.gpu.live.size, 0)
  assert.equal(f.resizeObservers.size, 0)
  assert.ok([...f.media.values()].every(state => state.listeners.size === 0))
})

test('destroy after rendering releases every graphics allocation and registered observer', async t => {
  const f = fixture(t)
  await f.ready()
  assert.ok(f.gpu.calls.draws > 0)
  assert.ok(f.gpu.live.size > 0)
  const staleFrames = [...f.frames.values()]
  f.cleanup()
  const draws = f.gpu.calls.draws
  for (const callback of staleFrames) callback(5000)
  f.doc.body.append(f.doc.createElement('div'))
  await f.tick()
  assert.equal(f.gpu.live.size, 0)
  assert.equal(f.frames.size, 0)
  assert.equal(f.resizeObservers.size, 0)
  assert.equal(f.canvas(), null)
  assert.equal(f.gpu.calls.draws, draws)
  assert.ok([...f.media.values()].every(state => state.listeners.size === 0))
})

test('changing a motion preference withdraws live graphics and can resume with one scene', async t => {
  const f = fixture(t)
  await f.ready()
  const reduced = f.media.get('(prefers-reduced-motion: reduce)')
  reduced.change(true)
  assert.equal(f.host().hasAttribute('data-qyt-ocean-live'), false)
  assert.equal(f.frames.size, 0)
  assert.equal(f.gpu.live.size, 0)
  reduced.change(false)
  f.frame(3000)
  assert.equal(f.host().hasAttribute('data-qyt-ocean-live'), true)
  assert.equal(f.doc.querySelectorAll('canvas[data-qyt-ocean-scene]').length, 1)
  const forced = f.media.get('(forced-colors: active)')
  forced.change(true)
  assert.equal(f.host().hasAttribute('data-qyt-ocean-live'), false)
  assert.equal(f.frames.size, 0)
  assert.equal(f.gpu.live.size, 0)
})

test('a hidden document pauses rendering and resumes without starting another context', async t => {
  const f = fixture(t)
  await f.ready()
  const contexts = f.gpu.calls.contexts
  const draws = f.gpu.calls.draws
  Object.defineProperty(f.doc, 'hidden', { configurable: true, value: true })
  f.doc.dispatchEvent(new f.win.Event('visibilitychange'))
  f.frame(3000)
  assert.equal(f.frames.size, 0)
  assert.equal(f.gpu.calls.draws, draws)
  Object.defineProperty(f.doc, 'hidden', { configurable: true, value: false })
  f.doc.dispatchEvent(new f.win.Event('visibilitychange'))
  f.frame(4000)
  assert.ok(f.gpu.calls.draws > draws)
  assert.equal(f.gpu.calls.contexts, contexts)
})

test('context loss withdraws the live marker and returns to the static fallback', async t => {
  const f = fixture(t)
  await f.ready()
  const canvas = f.canvas()
  assert.ok(canvas, 'a capable browser installs a decorative canvas')
  assert.equal(f.host().hasAttribute('data-qyt-ocean-live'), true)
  canvas.dispatchEvent(new f.win.Event('webglcontextlost', { cancelable: true }))
  const draws = f.gpu.calls.draws
  f.frame(3000)
  await f.tick()
  assert.equal(f.host().hasAttribute('data-qyt-ocean-live'), false)
  assert.equal(f.frames.size, 0)
  assert.equal(f.gpu.calls.draws, draws)
  f.cleanup()
  assert.equal(f.canvas(), null)
})
