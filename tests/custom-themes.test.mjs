import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
const source = (await build({ stdin: { contents: "export * from './src/custom-themes.ts';export * from './src/shared.ts';export * from './src/client/q-theme.ts'", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'text' } })).outputFiles[0].text
const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports }); const api = module.exports
const sample = { id: 'custom:sample', name: '我的风景', image: 'data:image/webp;base64,UklGRg==', width: 800, height: 600, accent: '#bc353c', motion: 'static', movement: 'pan', atmosphere: 'glow', intensity: .35, speed: .45, x: 50, y: 62, zoom: 1.2, mask: .9 }
test('custom theme selection requires a saved valid record and bounds persisted data', () => {
  assert.equal(api.isCustomTheme(sample), true)
  assert.equal(api.getQThemeId({ qThemeId: sample.id, qCustomThemes: [sample] }), sample.id)
  assert.equal(api.getThemeMotion({ qCustomThemes: [sample] }, sample.id), 'static')
  assert.equal(api.getQThemeId({ qThemeId: sample.id, qCustomThemes: [] }), 'moonfrost')
  for (const change of [{ id: 'custom:x"]{}' }, { image: 'https://example.com/x.jpg' }, { image: 'data:image/svg+xml;base64,AAAA' }, { image: sample.image + 'A'.repeat(360000) }, { accent: '#abc;}' }, { zoom: NaN }, { mask: .1 }, { x: Infinity }, { name: ' ' }, { width: 2000 }]) {
    assert.equal(api.isCustomTheme({ ...sample, ...change }), false, JSON.stringify(change).slice(0, 120))
    assert.equal(api.getCustomThemes({ qCustomThemes: [{ ...sample, ...change }] }).length, 0)
  }
  assert.equal(api.getCustomThemes({ qCustomThemes: [sample, sample] }).length, 1)
  assert.equal(api.getCustomThemes({ qCustomThemes: Array.from({ length: 20 }, (_, i) => ({ ...sample, id: 'custom:t' + i })) }).length, 8)
})
test('editing a selected custom theme refreshes art and palette without changing its ID', () => {
  const dom = new JSDOM('<body><main data-slot="main.conversation"><section data-phase="hero"></section></main></body>')
  let value = { qThemeEnabled: true, qThemeId: sample.id, qCustomThemes: [sample] }; const listeners = new Set()
  const form = { getSnapshot: () => ({ status: 'ready', value }), subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb) } }
  const stop = api.installQTheme({}, form, dom.window.document)
  const style = dom.window.document.querySelector('style[data-qyt-q-theme]')
  assert.equal(dom.window.document.body.dataset.qytQTheme, sample.id)
  assert.ok(style.textContent.includes('50% 62%'))
  value = { ...value, qCustomThemes: [{ ...sample, image: 'data:image/png;base64,AAAA', accent: '#116d83', x: 25 }] }
  listeners.forEach(cb => cb())
  assert.equal(dom.window.document.querySelector('style[data-qyt-q-theme]'), style)
  assert.ok(style.textContent.includes('data:image/png;base64,AAAA'))
  assert.ok(style.textContent.includes('25% 62%'))
  assert.ok(style.textContent.includes('#116d83'))
  value = { ...value, qCustomThemes: [] }; listeners.forEach(cb => cb())
  assert.equal(dom.window.document.body.dataset.qytQTheme, 'moonfrost')
  stop(); assert.equal(listeners.size, 0); dom.window.close()
})

test('all motion/atmosphere choices persist, old themes remain valid, and effect colors are safe', () => {
  for (const movement of api.THEME_MOVEMENTS) for (const atmosphere of api.THEME_ATMOSPHERES) {
    const theme = { ...sample, movement, atmosphere, atmosphereColor: '#81d5ff', speed: 5 }
    assert.equal(api.isCustomTheme(theme), true)
    assert.deepEqual(JSON.parse(JSON.stringify(api.getCustomThemes({ qCustomThemes: [theme] })))[0], theme)
  }
  for (const invalid of [{ speed: 5.05 }, { atmosphereColor: 'red' }, { atmosphereColor: '#abc;}' }, { atmosphereColor: null }, { movement: 'invalid' }, { atmosphere: 'invalid' }]) {
    assert.equal(api.isCustomTheme({ ...sample, ...invalid }), false)
  }
  assert.equal(api.isCustomTheme(sample), true, 'preexisting themes need no color migration')
})

test('video covers can be saved after the first minute, with bounded sidebar zoom and a safe cover color', () => {
  const video = { assetId: '83ab205a-4810-4c36-910c-0ca5a7f7e5ae', sound: false, sidebar: 'cover', x: 74, y: 62, frame: 65.25 }
  assert.equal(api.isCustomTheme({ ...sample, video }), true)
  assert.equal(api.isCustomTheme({ ...sample, video: { ...video, zoom: 1.65, coverAccent: '#905eb3' } }), true)
  for (const change of [{ frame: -1 }, { frame: Infinity }, { zoom: .9 }, { zoom: 2.1 }, { coverAccent: '#abc;}' }]) {
    assert.equal(api.isCustomTheme({ ...sample, video: { ...video, ...change } }), false)
  }
})
