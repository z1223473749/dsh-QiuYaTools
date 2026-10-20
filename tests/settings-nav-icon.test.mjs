import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="black"/></svg>').toString('base64')
const compiled = await build({ entryPoints: ['src/client/settings-nav-icon.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22', plugins: [{
  name: 'deterministic-monochrome-icon',
  setup(builder) {
    builder.onResolve({ filter: /brand-assets\.ts$/ }, () => ({ path: 'brand-asset-fixture', namespace: 'test-brand' }))
    builder.onLoad({ filter: /.*/, namespace: 'test-brand' }, () => ({ contents: `export const MONO_ICON_DATA_URL = ${JSON.stringify(dataUrl)}` }))
  },
}] })
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, queueMicrotask })
const { installSettingsNavIcon } = module.exports

function fixture(t, { declared = true, entries } = {}) {
  const dom = new JSDOM('<!doctype html><html><head><style>button{color:rgb(20,20,20)}body[data-dark] button{color:rgb(240,240,240)}</style></head><body></body></html>')
  const doc = dom.window.document
  let ownLabel = 'QiuYaTools'
  let ledger = entries ?? [
    { options: { id: 'general', order: 0, label: '通用设置' } },
    { options: { id: 'qiuya-tools', order: 50, label: () => ownLabel } },
    { options: { id: 'models', order: 10, label: '模型' } },
  ]
  const sectionListeners = new Set()
  const localeListeners = new Set()
  const injections = new Set()
  const ctx = {
    slots: {
      entries(key) { assert.equal(key, 'settings.section'); return ledger },
      subscribe(key, listener) { assert.equal(key, 'settings.section'); sectionListeners.add(listener); return () => sectionListeners.delete(listener) },
      inject(key, callback) {
        assert.equal(key, 'settings.section')
        const entry = { callback, stop: declared ? callback() : undefined }
        injections.add(entry)
        return () => { entry.stop?.(); entry.stop = undefined; injections.delete(entry) }
      },
    },
    locale: { subscribe(listener) { localeListeners.add(listener); return () => localeListeners.delete(listener) } },
  }
  const dispose = installSettingsNavIcon(ctx, dom.window)
  t.after(() => { dispose(); dom.window.close() })
  const render = ({ nativeDisplay } = {}) => {
    doc.querySelector('[data-shortcut-modal="settings"]')?.remove()
    const panel = doc.createElement('div')
    panel.setAttribute('role', 'dialog'); panel.dataset.shortcutModal = 'settings'
    const nav = doc.createElement('nav')
    const rows = [...ledger].sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
    for (const entry of rows) {
      const button = doc.createElement('button')
      button.type = 'button'
      // Fixture identity is deliberately outside the production selector.
      button.dataset.fixtureSection = entry.options.id
      button.innerHTML = '<svg class="native-nav-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 1h14v14H1z"/></svg><span></span>'
      button.lastElementChild.textContent = typeof entry.options.label === 'function' ? entry.options.label() : entry.options.label
      if (entry.options.id === 'qiuya-tools' && nativeDisplay) button.querySelector('svg').style.setProperty('display', nativeDisplay, 'important')
      nav.append(button)
    }
    const content = doc.createElement('section')
    content.innerHTML = '<svg data-content-icon></svg><button><svg></svg><span>QiuYaTools</span></button>'
    panel.append(nav, content)
    doc.body.append(panel)
    return panel
  }
  return {
    doc, window: dom.window, render, dispose,
    tick: async () => { await setImmediate() },
    button: id => doc.querySelector(`[data-fixture-section="${id}"]`),
    icons: () => doc.querySelectorAll('[data-qyt-settings-nav-icon]'),
    setLedger(next) { ledger = next; for (const listener of sectionListeners) listener() },
    locale(label) {
      ownLabel = label
      const button = doc.querySelector('[data-fixture-section="qiuya-tools"]')
      if (button) button.querySelector('span:not([data-qyt-settings-nav-icon])').textContent = label
      for (const listener of localeListeners) listener()
    },
    declare() { declared = true; for (const entry of injections) entry.stop ??= entry.callback() },
    collapse() { declared = false; for (const entry of injections) { entry.stop?.(); entry.stop = undefined } },
    listenerCounts: () => [sectionListeners.size, localeListeners.size, injections.size],
  }
}

test('only the registered QiuYaTools navigation glyph becomes the monochrome currentColor mask', async t => {
  const f = fixture(t)
  f.render(); await f.tick()
  assert.equal(f.icons().length, 1)
  const button = f.button('qiuya-tools')
  const icon = f.icons()[0]
  assert.equal(icon.parentElement, button)
  assert.equal(button.dataset.qytSettingsNavButton, 'true')
  assert.equal(icon.getAttribute('aria-hidden'), 'true')
  assert.match(icon.style.maskImage, /data:image\/svg\+xml;base64/u)
  assert.match(icon.style.webkitMaskImage, /data:image\/svg\+xml;base64/u)
  assert.equal(icon.style.backgroundColor.toLowerCase(), 'currentcolor')
  assert.equal(icon.style.width, '18px')
  assert.equal(icon.dataset.qytBrandIcon, 'true', 'navigation and account menus share one branded glyph')
  assert.equal(button.querySelector('svg').style.display, 'none')
  assert.equal(button.textContent, 'QiuYaTools')
  assert.equal(f.button('general').querySelector('svg').style.display, '')
  assert.equal(f.button('models').querySelector('svg').style.display, '')
  assert.equal(f.doc.querySelector('[data-content-icon]').style.display, '')
})

test('a second plugin with the same text and a non-settings dialog keep their original glyphs', async t => {
  const f = fixture(t, { entries: [
    { options: { id: 'another-plugin', order: 0, label: 'QiuYaTools' } },
    { options: { id: 'qiuya-tools', order: 50, label: 'QiuYaTools' } },
  ] })
  f.render()
  const other = f.doc.createElement('div')
  other.setAttribute('role', 'dialog')
  other.innerHTML = '<nav><button><svg></svg><span>QiuYaTools</span></button></nav>'
  f.doc.body.append(other)
  await f.tick()
  assert.equal(f.icons().length, 1)
  assert.equal(f.button('another-plugin').querySelector('svg').style.display, '')
  assert.equal(other.querySelector('svg').style.display, '')
})

test('ambiguous or out-of-date navigation structure is left untouched until the own section is proven', async t => {
  const f = fixture(t)
  f.render()
  const nav = f.doc.querySelector('nav')
  const extra = f.doc.createElement('button')
  extra.textContent = 'extra'; nav.append(extra)
  await f.tick()
  assert.equal(f.icons().length, 0)
  extra.remove(); await f.tick()
  assert.equal(f.icons().length, 1)
  f.setLedger([{ options: { id: 'other', label: 'QiuYaTools' } }]); await f.tick()
  assert.equal(f.icons().length, 0)
  assert.equal(f.button('qiuya-tools').querySelector('svg').style.display, '')
})

test('closing and reopening settings restores detached icons and adds one icon to the new navigation', async t => {
  const f = fixture(t)
  const old = f.render(); await f.tick()
  const native = f.button('qiuya-tools').querySelector('svg')
  old.remove(); await f.tick()
  assert.equal(native.style.display, '')
  assert.equal(old.querySelector('[data-qyt-settings-nav-icon]'), null)
  f.render(); await f.tick()
  assert.equal(f.icons().length, 1)
})

test('replacing the native glyph during a redraw restores the old node and decorates the replacement once', async t => {
  const f = fixture(t)
  f.render(); await f.tick()
  const old = f.button('qiuya-tools').querySelector('svg')
  const next = old.cloneNode(true)
  next.removeAttribute('style')
  old.replaceWith(next)
  await f.tick()
  assert.equal(old.style.display, '')
  assert.equal(next.style.display, 'none')
  assert.equal(f.icons().length, 1)
})

test('locale and theme changes keep the navigation identity and inherit the active text color', async t => {
  const f = fixture(t)
  f.render(); await f.tick()
  f.locale('秋雅工具'); await f.tick()
  assert.equal(f.icons().length, 1)
  const mask = f.icons()[0].style.maskImage
  const light = f.window.getComputedStyle(f.button('qiuya-tools')).color
  f.doc.body.dataset.dark = 'true'
  const dark = f.window.getComputedStyle(f.button('qiuya-tools')).color
  assert.notEqual(light, dark)
  assert.equal(f.icons()[0].style.backgroundColor.toLowerCase(), 'currentcolor')
  assert.equal(f.icons()[0].style.maskImage, mask)
})

test('unloading restores the exact original display priority without overwriting other live SVG styles', async t => {
  const f = fixture(t)
  f.render({ nativeDisplay: 'inline-flex' }); await f.tick()
  const button = f.button('qiuya-tools')
  const native = button.querySelector('svg')
  native.style.setProperty('fill', 'red')
  f.dispose(); f.dispose(); await f.tick()
  assert.equal(f.icons().length, 0)
  assert.equal(native.style.display, 'inline-flex')
  assert.equal(native.style.getPropertyPriority('display'), 'important')
  assert.equal(native.style.fill, 'red')
  assert.equal(button.hasAttribute('data-qyt-settings-nav-button'), false)
  assert.deepEqual(f.listenerCounts(), [0, 0, 0])
})

test('late section declarations and declaration replacement clean up their entire adapter lifetime', async t => {
  const f = fixture(t, { declared: false })
  f.render(); await f.tick()
  assert.equal(f.icons().length, 0)
  f.declare(); await f.tick()
  assert.equal(f.icons().length, 1)
  f.collapse(); await f.tick()
  assert.equal(f.icons().length, 0)
  assert.deepEqual(f.listenerCounts(), [0, 0, 1])
  f.declare(); await f.tick()
  assert.equal(f.icons().length, 1)
})

test('a browser-less client smoke harness installs no observers or slot effects', () => {
  assert.doesNotThrow(() => installSettingsNavIcon({ slots: { inject() { throw new Error('No browser surface') } } }, {})())
})
