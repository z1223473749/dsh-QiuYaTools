import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const source = (await build({
  entryPoints: [fileURLToPath(new URL('../src/client/begonia-scene.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs',
})).outputFiles[0].text

function fixture(t, { missing, context = true, reduced = false, forced = false, phase = 'hero', dpr = 1, rect = [200, 0, 1000, 800] } = {}) {
  const dom = new JSDOM(`<!doctype html><body data-qyt-q-theme="begonia"><main data-slot="main.conversation"><section data-phase="${phase}"><button>Native action</button><article>Reading paper</article></section></main></body>`, { pretendToBeVisual: true })
  const win = dom.window, doc = win.document
  const frames = new Map(), media = new Map(), rectangles = new WeakMap()
  const resizeObservers = [], intersectionObservers = [], mutationObservers = []
  const listeners = { doc: new Map(), win: new Map() }
  const calls = { contexts: 0, clears: [], fills: 0, transforms: [], requests: 0, particles: [] }
  let nextFrame = 0, now = 0, hidden = false, throwDraw = false
  Object.defineProperties(win, { devicePixelRatio: { value: dpr, configurable: true }, innerWidth: { value: 1600 }, innerHeight: { value: 1000 } })
  Object.defineProperty(doc, 'hidden', { get: () => hidden, configurable: true })
  for (const [target, registry] of [[doc, listeners.doc], [win, listeners.win]]) {
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target)
    target.addEventListener = (type, callback, options) => { if (!registry.has(type)) registry.set(type, new Set()); registry.get(type).add(callback); add(type, callback, options) }
    target.removeEventListener = (type, callback, options) => { registry.get(type)?.delete(callback); remove(type, callback, options) }
  }
  win.requestAnimationFrame = callback => { calls.requests++; frames.set(++nextFrame, callback); return nextFrame }
  win.cancelAnimationFrame = id => frames.delete(id)
  win.matchMedia = query => {
    if (!media.has(query)) {
      const listeners = new Set()
      const state = {
        matches: query.includes('reduced-motion') ? reduced : forced,
        addEventListener(_type, callback) { listeners.add(callback) },
        removeEventListener(_type, callback) { listeners.delete(callback) },
        listeners,
        change(value) { state.matches = value; for (const callback of [...listeners]) callback() },
      }
      media.set(query, state)
    }
    return media.get(query)
  }
  win.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this) }
    observe(target) { this.targets.add(target) }
    disconnect() { this.targets.clear() }
  }
  win.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); intersectionObservers.push(this) }
    observe(target) { this.targets.add(target) }
    disconnect() { this.targets.clear() }
    notify(target, isIntersecting) { this.callback([{ target, isIntersecting }]) }
  }
  const NativeMutationObserver = win.MutationObserver
  win.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.observer = new NativeMutationObserver(callback); this.active = false; mutationObservers.push(this) }
    observe(...args) { this.active = true; this.observer.observe(...args) }
    disconnect() { this.active = false; this.observer.disconnect() }
  }
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const [left, top, width, height] = rectangles.get(this) ?? rect
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }
  }
  win.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [this.getBoundingClientRect()] }
  win.HTMLCanvasElement.prototype.getContext = function (kind, options) {
    calls.contexts++
    assert.equal(kind, '2d')
    assert.equal(options.alpha, true)
    if (context === 'throw') throw new Error('Canvas unavailable')
    if (!context) return null
    let position = [0, 0], shape = 'petal', size = 0
    return {
      clearRect(...args) { if (throwDraw) throw new Error('Renderer failed'); calls.clears.push({ now, args }) },
      setTransform(...args) { calls.transforms.push(args) },
      save() {}, restore() {}, translate(x, y) { position = [x, y] }, rotate() {}, scale() {}, beginPath() {},
      moveTo(_x, y) { shape = 'petal'; size = Math.abs(y) }, bezierCurveTo() {},
      arc(x, y, radius) { shape = 'mote'; position = [x, y]; size = radius },
      fill() { calls.fills++; calls.particles.push({ shape, x: position[0], y: position[1], size, alpha: this.globalAlpha }) },
      drawImage() { throw new Error('The static artwork must never be painted by the adapter') },
    }
  }
  if (missing) win[missing] = undefined
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports })
  const stop = module.exports.installBegoniaScene(doc)
  t.after(() => { stop(); win.close() })
  return {
    win, doc, frames, media, rectangles, resizeObservers, intersectionObservers, mutationObservers, listeners, calls, stop,
    host: () => doc.querySelector('[data-phase]'),
    canvas: () => doc.querySelector('canvas[data-qyt-begonia-petals]'),
    frame(time = 1000) { now = time; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)) },
    tick: () => new Promise(resolve => setImmediate(resolve)),
    visibility(value) { hidden = value; doc.dispatchEvent(new win.Event('visibilitychange')) },
    failDrawing() { throwDraw = true },
  }
}

test('missing animation or observation capabilities preserve the static theme', t => {
  for (const missing of ['requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'ResizeObserver', 'MutationObserver']) {
    const f = fixture(t, { missing })
    assert.equal(f.canvas(), null)
    assert.equal(f.calls.contexts, 0)
    assert.equal(f.frames.size, 0)
    assert.equal(f.doc.querySelector('button').textContent, 'Native action')
  }
})

test('reduced motion and forced colors allocate no canvas and can resume', t => {
  for (const setting of ['reduced', 'forced']) {
    const f = fixture(t, { [setting]: true })
    assert.equal(f.canvas(), null)
    assert.equal(f.calls.contexts, 0)
    assert.equal(f.frames.size, 0)
    const state = [...f.media].find(([query]) => query.includes(setting === 'reduced' ? 'reduced-motion' : 'forced-colors'))[1]
    state.change(false)
    assert.ok(f.canvas())
    assert.equal(f.frames.size, 1)
    state.change(true)
    assert.equal(f.canvas(), null)
    assert.equal(f.frames.size, 0)
  }
})

test('canvas failures retain the static DOM without a retry loop', async t => {
  for (const context of [false, 'throw']) {
    const f = fixture(t, { context })
    await f.tick()
    assert.equal(f.calls.contexts, 1)
    assert.equal(f.canvas(), null)
    assert.equal(f.frames.size, 0)
    f.win.dispatchEvent(new f.win.Event('resize'))
    assert.equal(f.calls.contexts, 1)
    assert.equal(f.host().hasAttribute('data-qyt-theme-live'), false)
    assert.equal(f.doc.querySelector('article').textContent, 'Reading paper')
  }
})

test('the transparent layer is inert, behind paper, and never replaces the painting', t => {
  const f = fixture(t)
  const canvas = f.canvas()
  assert.equal(f.host().firstElementChild, canvas)
  assert.equal(canvas.getAttribute('aria-hidden'), 'true')
  assert.ok(canvas.hasAttribute('inert'))
  assert.equal(canvas.style.pointerEvents, 'none')
  assert.equal(canvas.style.position, 'absolute')
  assert.equal(canvas.style.zIndex, '-1')
  assert.equal(f.doc.querySelector('[data-qyt-theme-live], [data-qyt-theme-scene], [data-qyt-ocean-wash]'), null)
  f.frame()
  assert.equal(f.calls.clears.length, 1)
  assert.equal(f.calls.fills, 20, 'only 14 petals and 6 motes are painted')
  assert.equal(f.doc.querySelector('button').parentElement, f.host())
})

test('rendering stays below 30 fps and caps device pixels', t => {
  const f = fixture(t, { dpr: 4, rect: [0, 0, 3000, 1800] })
  for (let index = 0; index <= 120; index++) f.frame(index * 1000 / 120)
  assert.ok(f.calls.clears.length <= 31, `${f.calls.clears.length} draws during one second`)
  assert.ok(f.calls.clears.length >= 20)
  assert.ok(f.canvas().width * f.canvas().height <= 1_202_500)
  assert.equal(f.calls.contexts, 1)
  const small = fixture(t, { dpr: 4, rect: [0, 0, 400, 300] })
  small.frame()
  assert.equal(small.canvas().width, 500)
  assert.equal(small.canvas().height, 375)
})

test('active petals stay in the visible reading margins with contrast and scale down in small previews', t => {
  const reading = fixture(t, { phase: 'active', rect: [200, 0, 1000, 800] })
  reading.frame()
  const particles = reading.calls.particles
  assert.equal(particles.length, 20)
  for (const particle of particles) {
    assert.ok(particle.x < 140 || particle.x > 860, 'animation avoids the central 720px reading paper')
    assert.ok(particle.alpha >= .45, 'active particles are not attenuated before the reading-paper wash')
  }
  const petals = particles.filter(particle => particle.shape === 'petal')
  assert.ok(petals.every(petal => petal.size >= 10), 'full-sized petals have visible silhouettes')
  const preview = fixture(t, { rect: [0, 0, 400, 224] })
  preview.frame()
  assert.ok(preview.calls.particles.filter(particle => particle.shape === 'petal').every(petal => petal.size <= 8.5), 'preview petals remain proportional to the smaller illustration')
})

test('visibility, intersection, and zero-sized containers pause and recover', t => {
  const f = fixture(t)
  f.frame()
  const [stale] = f.frames.values()
  f.visibility(true)
  assert.equal(f.frames.size, 0)
  stale(1050)
  assert.equal(f.frames.size, 0)
  f.visibility(false)
  assert.equal(f.frames.size, 1)
  const observer = f.intersectionObservers[0]
  observer.notify(f.host(), false)
  assert.equal(f.frames.size, 0)
  observer.notify(f.host(), true)
  assert.equal(f.frames.size, 1)
  f.rectangles.set(f.host(), [200, 0, 0, 0])
  f.resizeObservers[0].callback()
  assert.equal(f.frames.size, 0)
  f.rectangles.set(f.host(), [200, 0, 900, 700])
  f.resizeObservers[0].callback()
  assert.equal(f.frames.size, 1)
  f.frame(2000)
  assert.equal(f.canvas().width, 900)
  assert.equal(f.canvas().height, 700)
})

test('without IntersectionObserver viewport scroll still pauses offscreen scenes', t => {
  const f = fixture(t, { missing: 'IntersectionObserver' })
  f.rectangles.set(f.host(), [200, 1500, 1000, 800])
  f.doc.dispatchEvent(new f.win.Event('scroll'))
  assert.equal(f.frames.size, 0)
  f.rectangles.set(f.host(), [200, 0, 1000, 800])
  f.doc.dispatchEvent(new f.win.Event('scroll'))
  assert.equal(f.frames.size, 1)
})

test('host replacement retires the old layer and ignores old host observer callbacks', async t => {
  const f = fixture(t)
  const previous = f.host(), previousCanvas = f.canvas(), staleFrame = [...f.frames.values()][0]
  const next = f.doc.createElement('section')
  next.dataset.phase = 'active'
  next.innerHTML = '<article>New conversation</article>'
  previous.replaceWith(next)
  await f.tick()
  assert.equal(previousCanvas.isConnected, false)
  assert.equal(previousCanvas.width, 1)
  assert.equal(next.firstElementChild, f.canvas())
  assert.notEqual(f.canvas(), previousCanvas)
  assert.equal(f.frames.size, 1)
  staleFrame(1000)
  assert.equal(f.frames.size, 1, 'the old frame cannot overwrite the new frame handle')
  f.intersectionObservers[0].notify(previous, false)
  assert.equal(f.frames.size, 1, 'an old host intersection cannot pause the new host')
  assert.deepEqual([...f.resizeObservers[0].targets], [next])
  assert.deepEqual([...f.intersectionObservers[0].targets], [next])
})

test('hidden host and ancestor changes pause immediately and resume through DOM observation', async t => {
  const f = fixture(t)
  f.host().hidden = true
  await f.tick()
  assert.equal(f.frames.size, 0)
  f.host().hidden = false
  await f.tick()
  assert.equal(f.frames.size, 1)
  f.host().parentElement.style.display = 'none'
  // A real layout engine returns no client rects for display:none ancestors.
  f.host().parentElement.hidden = true
  await f.tick()
  assert.equal(f.frames.size, 0)
  f.host().parentElement.hidden = false
  f.host().parentElement.style.display = ''
  await f.tick()
  assert.equal(f.frames.size, 1)
})

test('context loss and draw errors fall back permanently until the theme is reinstalled', t => {
  for (const event of ['contextlost', 'draw-error']) {
    const f = fixture(t)
    if (event === 'contextlost') f.canvas().dispatchEvent(new f.win.Event('contextlost'))
    else { f.failDrawing(); f.frame() }
    assert.equal(f.canvas(), null)
    assert.equal(f.frames.size, 0)
    f.win.dispatchEvent(new f.win.Event('resize'))
    assert.equal(f.calls.contexts, 1)
    assert.equal(f.doc.querySelector('article').textContent, 'Reading paper')
  }
})

test('disposing removes every resource and stale callbacks cannot resurrect the layer', async t => {
  const f = fixture(t)
  const canvas = f.canvas(), staleFrame = [...f.frames.values()][0]
  const mediaCallbacks = [...f.media.values()].flatMap(state => [...state.listeners])
  f.stop()
  f.stop()
  assert.equal(canvas.width, 1)
  assert.equal(f.canvas(), null)
  assert.equal(f.frames.size, 0)
  assert.equal(f.resizeObservers[0].targets.size, 0)
  assert.equal(f.intersectionObservers[0].targets.size, 0)
  assert.equal(f.mutationObservers[0].active, false)
  assert.ok([...f.media.values()].every(state => state.listeners.size === 0))
  for (const type of ['visibilitychange', 'scroll']) assert.equal(f.listeners.doc.get(type)?.size, 0)
  assert.equal(f.listeners.win.get('resize')?.size, 0)
  staleFrame(1000)
  f.resizeObservers[0].callback()
  f.intersectionObservers[0].notify(f.host(), true)
  f.mutationObservers[0].callback([])
  mediaCallbacks.forEach(callback => callback())
  f.visibility(false)
  f.win.dispatchEvent(new f.win.Event('resize'))
  f.host().append(f.doc.createElement('p'))
  await f.tick()
  assert.equal(f.canvas(), null)
  assert.equal(f.frames.size, 0)
  assert.equal(f.calls.contexts, 1)
})
