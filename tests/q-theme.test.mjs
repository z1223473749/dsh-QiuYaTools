import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = new URL('../', import.meta.url)
const buildOptions = {
  entryPoints: [fileURLToPath(new URL('src/client/q-theme.ts', root))],
  bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'text' },
}
const [source, motionMockSource] = (await Promise.all([
  build(buildOptions),
  build({ ...buildOptions, plugins: [{
    name: 'observe-theme-motion-lifecycle',
    setup(build) {
      build.onLoad({ filter: /[/\\]ocean-scene\.ts$/ }, () => ({
        contents: 'export function installOceanScene(doc) { return globalThis.__scene.install(doc) }', loader: 'js',
      }))
      build.onLoad({ filter: /[/\\]begonia-scene\.ts$/ }, () => ({
        contents: 'export function installBegoniaScene(doc) { return globalThis.__begoniaScene.install(doc) }', loader: 'js',
      }))
    },
  }] }),
])).map(result => result.outputFiles[0].text)
const [commonCss, oceanPalette, begoniaPalette] = await Promise.all(['src/client/q-theme.css', 'src/client/themes/ocean.css', 'src/client/themes/begonia.css'].map(path => readFile(new URL(path, root), 'utf8')))
const css = oceanPalette + '\n' + commonCss
const body = 'body[data-qyt-q-theme]'
const sceneLayers = ':is(canvas[data-qyt-ocean-scene], canvas[data-qyt-theme-scene], [data-qyt-ocean-wash], [data-qyt-theme-wash])'
const readyLayers = ':is(canvas[data-qyt-ocean-scene][data-ready="true"], canvas[data-qyt-theme-scene][data-ready="true"], [data-qyt-ocean-wash], [data-qyt-theme-wash])'
const liveMarker = ':is([data-qyt-ocean-live], [data-qyt-theme-live])'
const dockLayer = ':is([data-qyt-ocean-dock], [data-qyt-theme-dock])'
const washLayer = ':is([data-qyt-ocean-wash], [data-qyt-theme-wash])'
const dockFrames = ':is(canvas[data-qyt-ocean-dock-frame], canvas[data-qyt-theme-dock-frame], [data-qyt-ocean-wash], [data-qyt-theme-wash])'

function moduleFor(document, scene, begoniaScene) {
  const module = { exports: {} }
  vm.runInNewContext(scene || begoniaScene ? motionMockSource : source, { module, exports: module.exports, document, __scene: scene, __begoniaScene: begoniaScene })
  return module.exports
}

function formFixture(value = { qThemeEnabled: false }, status = 'ready') {
  let snapshot = { status, value, writable: true }
  const listeners = new Set()
  return {
    form: { getSnapshot: () => snapshot, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) } },
    update(next, nextStatus = 'ready') { snapshot = { ...snapshot, value: next, status: nextStatus }; for (const listener of [...listeners]) listener() },
    listeners,
  }
}

function fixture(t, { enabled = false, marker, dark = false, sharedForm, scene, begoniaScene } = {}) {
  const dom = new JSDOM('<!doctype html><html data-platform="darwin"><head><style data-native-theme>body{--dsw-alias-bg-base:#fff;--dsw-alias-state-error-primary:#d31d34;--dsw-alias-state-success-primary:#198251;--dsw-alias-state-warn-primary:#9b640a;--dsw-alias-code-diff-added:#d4f4dd;--dsw-alias-markdown-code-block:#f8f8f8}body[data-ds-dark-theme]{--dsw-alias-markdown-code-block:#191919}.shiki span{color:#7851a9}</style></head><body style="--host-layer: preserved; color: rgb(11, 22, 33)"><div id="root"><div data-slot="sidebar"><aside>Sidebar</aside></div><main data-slot="main.conversation"><section data-phase="active"><div data-conversation-scroll>Conversation</div></section></main><div data-composer-card>Composer</div><pre class="shiki"><span>highlighted</span></pre></div></body></html>')
  t.after(() => dom.window.close())
  const doc = dom.window.document
  if (marker !== undefined) doc.body.setAttribute('data-qyt-q-theme', marker)
  if (dark) doc.body.setAttribute('data-ds-dark-theme', '')
  const form = sharedForm ?? formFixture({ qThemeEnabled: enabled })
  const plugin = moduleFor(doc, scene, begoniaScene)
  const cleanups = []
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup() })
  return {
    doc, dom, ...form, plugin,
    install() { const cleanup = plugin.installQTheme({}, form.form); cleanups.push(cleanup); return cleanup },
    styles: () => [...doc.querySelectorAll('style[data-qyt-q-theme]')],
    token: name => dom.window.getComputedStyle(doc.body).getPropertyValue(name).trim(),
  }
}

function motionFixture(themeId = 'ocean') {
  return {
    installs: 0, cleanups: 0, active: 0,
    install(doc) {
      assert.ok(doc.querySelector(`style[data-qyt-q-theme="${themeId}"]`), 'theme styles exist before motion installation')
      assert.equal(doc.body.getAttribute('data-qyt-q-theme'), themeId)
      this.installs++; this.active++
      let stopped = false
      return () => { if (!stopped) { stopped = true; this.cleanups++; this.active-- } }
    },
  }
}

test('an explicit preview document shares the framework without replacing or stopping the main document scene', t => {
  const scene = motionFixture()
  const f = fixture(t, { enabled: true, scene })
  const preview = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  t.after(() => preview.window.close())
  const stopMain = f.install()
  const mainStyle = f.styles()[0]
  const stopPreview = f.plugin.installQTheme({}, f.form, preview.window.document)
  t.after(stopPreview)
  assert.equal(scene.active, 2)
  assert.equal(preview.window.document.body.getAttribute('data-qyt-q-theme'), 'ocean')
  assert.equal(preview.window.document.querySelectorAll('style[data-qyt-q-theme]').length, 1)
  assert.equal(f.styles()[0], mainStyle)
  stopPreview()
  assert.equal(scene.active, 1, 'closing the preview preserves the main scene')
  assert.equal(preview.window.document.querySelectorAll('style[data-qyt-q-theme]').length, 0)
  assert.equal(f.styles()[0], mainStyle)
  stopMain()
  assert.equal(scene.active, 0)
})

test('the Ocean static preference enables its palette without installing the motion runtime', t => {
  const scene = motionFixture()
  const sharedForm = formFixture({ qThemeEnabled: true, qThemeSettings: { ocean: { motion: 'static' } } })
  const f = fixture(t, { sharedForm, scene })
  const cleanup = f.install()
  assert.equal(f.styles().length, 1)
  assert.equal(f.doc.body.getAttribute('data-qyt-q-theme'), 'ocean')
  assert.equal(f.token('--qyt-q-base'), '#fafaf8')
  assert.equal(scene.installs, 0)
  cleanup()
  assert.equal(scene.cleanups, 0)
})

test('changing Ocean motion stops and resumes only animation while preserving the shared theme', t => {
  const scene = motionFixture()
  const f = fixture(t, { enabled: true, scene })
  const first = f.install(), second = f.install()
  const style = f.styles()[0]
  assert.equal(scene.installs, 1, 'shared theme consumers install one scene')
  f.update({ qThemeEnabled: true, qThemeSettings: { ocean: { motion: 'static' } } })
  assert.equal(scene.active, 0)
  assert.equal(scene.cleanups, 1)
  assert.equal(f.styles()[0], style)
  assert.equal(f.doc.body.getAttribute('data-qyt-q-theme'), 'ocean')
  assert.equal(f.token('--qyt-q-base'), '#fafaf8')
  f.update({ qThemeEnabled: true, qThemeSettings: { ocean: { motion: 'static' } } })
  assert.equal(scene.cleanups, 1, 'repeated static updates do not dispose twice')
  f.update({ qThemeEnabled: true, qThemeSettings: { ocean: { motion: 'dynamic' } } })
  assert.equal(scene.installs, 2)
  assert.equal(scene.active, 1)
  assert.equal(f.styles()[0], style)
  first()
  assert.equal(scene.active, 1, 'one owner cannot stop another consumer\'s scene')
  second()
  assert.equal(scene.active, 0)
  assert.equal(scene.cleanups, 2)
  assert.equal(f.styles().length, 0)
})

test('legacy Ocean preferences and an explicit dynamic preference start motion by default', t => {
  for (const qThemeSettings of [undefined, {}, { ocean: {} }, { ocean: { motion: 'dynamic' } }]) {
    const scene = motionFixture()
    const sharedForm = formFixture({ qThemeEnabled: true, ...(qThemeSettings === undefined ? {} : { qThemeSettings }) })
    const f = fixture(t, { sharedForm, scene })
    const cleanup = f.install()
    assert.equal(scene.installs, 1)
    assert.equal(scene.active, 1)
    cleanup()
    assert.equal(scene.active, 0)
  }
})

test('ready preferences without a theme flag inherit the enabled dynamic default', t => {
  for (const preferences of [{}, { enabled: false }, { qThemeSettings: {} }, { qThemeSettings: { ocean: {} } }]) {
    const scene = motionFixture()
    const f = fixture(t, { sharedForm: formFixture(preferences), scene })
    const cleanup = f.install()
    assert.equal(f.styles().length, 1)
    assert.equal(f.doc.body.getAttribute('data-qyt-q-theme'), 'ocean')
    assert.equal(scene.installs, 1)
    assert.equal(scene.active, 1, 'missing appearance fields do not inherit the legacy tool master')
    cleanup()
    assert.equal(scene.active, 0)
  }
})

test('the enabled theme default retains a saved static preference', t => {
  const scene = motionFixture()
  const f = fixture(t, { sharedForm: formFixture({ qThemeSettings: { ocean: { motion: 'static' } } }), scene })
  f.install()
  assert.equal(f.styles().length, 1)
  assert.equal(f.doc.body.getAttribute('data-qyt-q-theme'), 'ocean')
  assert.equal(scene.installs, 0, 'default enablement never replaces a saved motion choice')
})

test('loading and unavailable preferences never install the enabled default before an accepted ready snapshot', t => {
  for (const status of ['loading', 'unavailable']) {
    const scene = motionFixture()
    const f = fixture(t, { sharedForm: formFixture({}, status), scene })
    f.install()
    assert.equal(f.styles().length, 0)
    assert.equal(scene.installs, 0)
    f.update({})
    assert.equal(f.styles().length, 1)
    assert.equal(scene.active, 1)
    f.update({}, status)
    assert.equal(f.styles().length, 0)
    assert.equal(scene.active, 0)
    f.update({ qThemeEnabled: false })
    assert.equal(f.styles().length, 0)
    assert.equal(scene.installs, 1, 'an explicit false remains authoritative after reconnecting')
  }
})

test('an explicitly disabled theme stays off across tool updates and can be enabled independently', t => {
  const f = fixture(t)
  const original = f.doc.body.outerHTML
  f.install()
  assert.equal(f.listeners.size, 1)
  assert.equal(f.styles().length, 0)
  assert.equal(f.doc.body.outerHTML, original)
  f.update({ enabled: true, pastedTextEnabled: true, qThemeEnabled: false })
  assert.equal(f.styles().length, 0, 'an accepted explicit false is preserved across tool updates')
  f.update({ enabled: false, pastedTextEnabled: false, sessionWindowsEnabled: false, bulkArchiveEnabled: false, planCommentsEnabled: false, qThemeEnabled: true })
  assert.equal(f.styles().length, 1, 'theme preference is independent from all tool switches')
  assert.equal(f.doc.body.getAttribute('data-qyt-q-theme'), 'ocean')
  f.update({ qThemeEnabled: true }, 'unavailable')
  assert.equal(f.styles().length, 0)
  f.update({ qThemeEnabled: true }, 'loading')
  assert.equal(f.styles().length, 0)
  f.update({ qThemeEnabled: true })
  assert.equal(f.styles().length, 1)
})

test('follows native light/dark changes without writing preference, inline styles or syntax/semantic palettes', t => {
  const f = fixture(t, { enabled: true })
  const inline = f.doc.body.getAttribute('style')
  const native = f.doc.querySelector('[data-native-theme]').textContent
  f.install()
  const style = f.styles()[0]
  assert.equal(f.token('--qyt-q-base'), '#fafaf8')
  for (const [name, value] of [
    ['--dsw-alias-state-error-primary', '#d31d34'], ['--dsw-alias-state-success-primary', '#198251'],
    ['--dsw-alias-state-warn-primary', '#9b640a'], ['--dsw-alias-code-diff-added', '#d4f4dd'],
  ]) assert.equal(f.token(name), value)
  f.doc.body.setAttribute('data-ds-dark-theme', '')
  assert.equal(f.token('--qyt-q-base'), '#1b1e22')
  assert.equal(f.token('--dsw-alias-markdown-code-block'), '#191919')
  assert.equal(f.dom.window.getComputedStyle(f.doc.querySelector('.shiki span')).color, 'rgb(120, 81, 169)')
  assert.equal(f.styles()[0], style, 'a native scheme change only changes CSS matching')
  f.doc.body.removeAttribute('data-ds-dark-theme')
  assert.equal(f.token('--qyt-q-base'), '#fafaf8')
  assert.equal(f.token('--dsw-alias-markdown-code-block'), '#f8f8f8')
  assert.equal(f.doc.body.getAttribute('style'), inline)
  assert.equal(f.doc.querySelector('[data-native-theme]').textContent, native)
})

test('turning off and unloading restore original markers/styles and stop watching', t => {
  const f = fixture(t, { enabled: true, marker: 'existing-value', dark: true })
  const original = f.doc.body.outerHTML
  const nativeStyle = f.doc.querySelector('[data-native-theme]')
  const cleanup = f.install()
  f.update({ qThemeEnabled: false })
  assert.equal(f.styles().length, 0)
  assert.equal(f.doc.body.outerHTML, original)
  f.update({ qThemeEnabled: true })
  assert.equal(f.styles().length, 1)
  cleanup(); cleanup()
  assert.equal(f.styles().length, 0)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.doc.body.outerHTML, original)
  assert.equal(f.doc.querySelector('[data-native-theme]'), nativeStyle)
  f.update({ qThemeEnabled: true })
  assert.equal(f.styles().length, 0)
})

test('multiple consumers share one layer and cleanup cannot remove a later owner', t => {
  const f = fixture(t, { enabled: true })
  const first = f.install()
  const second = f.install()
  assert.equal(f.styles().length, 1)
  first()
  assert.equal(f.styles().length, 1)
  assert.equal(f.doc.body.getAttribute('data-qyt-q-theme'), 'ocean')
  second()
  assert.equal(f.styles().length, 0)
  assert.equal(f.doc.body.hasAttribute('data-qyt-q-theme'), false)
})

test('accepted profile changes update separate client documents together', t => {
  const sharedForm = formFixture()
  const main = fixture(t, { sharedForm })
  const window = fixture(t, { sharedForm, dark: true })
  main.install(); window.install()
  sharedForm.update({ qThemeEnabled: true })
  assert.equal(main.styles().length, 1)
  assert.equal(window.styles().length, 1)
  assert.equal(main.token('--qyt-q-base'), '#fafaf8')
  assert.equal(window.token('--qyt-q-base'), '#1b1e22')
  sharedForm.update({ qThemeEnabled: false })
  assert.equal(main.styles().length, 0)
  assert.equal(window.styles().length, 0)
})

test('documentless loader and simplified plugin smoke environments are safe no-ops', () => {
  for (const document of [undefined, { head: {}, createElement() { throw new Error('must not create styles without a body') } }]) {
    const plugin = moduleFor(document)
    const form = formFixture({ qThemeEnabled: true })
    const cleanup = plugin.installQTheme({}, form.form)
    cleanup()
    assert.equal(form.listeners.size, 0)
  }
})

function luminance(hex) {
  const rgb = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
}

function contrast(a, b) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y)
  return (high + .05) / (low + .05)
}

const readingInk = ['--qyt-q-ink', '--qyt-q-secondary', '--qyt-q-muted']

function forEachThemeAppearance(t, check) {
  for (const themeId of ['ocean', 'begonia']) {
    for (const dark of [false, true]) {
      const f = fixture(t, { dark, sharedForm: formFixture({
        qThemeEnabled: true, qThemeId: themeId,
        qThemeSettings: { ocean: { motion: 'static' }, begonia: { motion: 'static' } },
      }) })
      f.install()
      check(f, `${themeId} ${dark ? 'dark' : 'light'}`)
    }
  }
}

test('both themes keep small text readable on base, raised, sidebar and selected surfaces in both schemes', t => {
  forEachThemeAppearance(t, (f, label) => {
    for (const ink of readingInk) {
      for (const surface of ['--qyt-q-base', '--qyt-q-surface', '--qyt-q-raised', '--qyt-q-sidebar', '--qyt-q-selected']) {
        assert.ok(contrast(f.token(ink), f.token(surface)) >= 4.5, `${label} ${ink} on ${surface}`)
      }
    }
    assert.ok(contrast(f.token('--qyt-q-tab-ink'), f.token('--qyt-q-tab-fill')) >= 4.5, `${label} native tab label`)
  })
  for (const fill of ['#116d83', '#bc353c', '#b32c3a']) {
    assert.ok(contrast(fill, '#ffffff') >= 4.5, `${fill} send button keeps its fixed white icon readable`)
  }
})

test('reading ink and major surfaces remain neutral while sea color is reserved for accents', t => {
  for (const dark of [false, true]) {
    const f = fixture(t, { enabled: true, dark })
    f.install()
    for (const name of ['--qyt-q-ink', '--qyt-q-secondary', '--qyt-q-muted', '--qyt-q-base', '--qyt-q-surface', '--qyt-q-raised']) {
      const value = f.token(name)
      const channels = [1, 3, 5].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16))
      assert.ok(Math.max(...channels) - Math.min(...channels) <= 18, `${name} should not tint reading surfaces or all text blue`)
    }
    assert.ok(contrast(f.token('--qyt-q-tab-ink'), f.token('--qyt-q-tab-fill')) >= 4.5)
  }
})

function allRules(rules) {
  return [...rules].flatMap(rule => rule.cssRules ? allRules(rule.cssRules) : [rule])
}

test('both themes embed their own illustration and withdraw it without external image requests', t => {
  const illustrations = []
  for (const qThemeId of ['ocean', 'begonia']) {
    const f = fixture(t, { sharedForm: formFixture({ qThemeEnabled: true, qThemeId }) })
    const cleanup = f.install()
    const installed = f.styles()[0].textContent
    assert.ok(!installed.includes('__QYT_THEME_SCENE__'), 'the actual packaged image replaces the build placeholder')
    const urls = [...installed.matchAll(/url\("([^"]+)"\)/gu)].map(match => match[1])
    assert.equal(urls.length, 1)
    assert.ok(urls.every(url => /^data:image\/(?:webp|jpeg);base64,/u.test(url)), 'no remote image request or unresolvable asset path')
    illustrations.push(urls[0])
    cleanup()
    assert.equal(f.styles().length, 0)
  }
  assert.notEqual(illustrations[0], illustrations[1], 'themes do not accidentally reuse the same illustration')
})

test('the approved illustrated sidebar keeps its own art opacity and selected-row treatment', t => {
  const f = fixture(t, { enabled: true })
  f.install()
  assert.equal(f.token('--qyt-q-chrome'), 'rgba(229, 239, 234, .95)')
  assert.equal(f.token('--qyt-q-sidebar-wash'), 'rgba(229, 239, 234, .80)')
  assert.equal(f.token('--qyt-q-sidebar'), '#e5efea')
  const rules = allRules(f.styles()[0].sheet.cssRules)
  const sidebar = rules.find(rule => rule.selectorText === `${body} [data-slot="sidebar"] > :first-child`)
  assert.ok(sidebar)
  assert.equal(sidebar.style.getPropertyValue('background-size'), '100% 100%, auto 310px')
  assert.ok(sidebar.style.getPropertyValue('background-image').includes('var(--qyt-theme-art)'))
  const selected = rules.find(rule => rule.selectorText?.includes('[data-row-key^="session:"][aria-selected="true"]'))
  assert.equal(selected.style.getPropertyValue('box-shadow'), 'inset 3px 0 var(--qyt-q-accent)')
})

test('both themes keep reading ink legible over the darkest and lightest possible illustration pixels', t => {
  forEachThemeAppearance(t, (f, label) => {
    const match = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([.\d]+)\)$/u.exec(f.token('--qyt-q-paper'))
    assert.ok(match, `${label} defines translucent reading paper`)
    const [r, g, b, alpha] = match.slice(1).map(Number)
    assert.ok(alpha > 0 && alpha < 1)
    // Per-channel luminance is monotonic. Black/white bound every image pixel.
    for (const backdrop of [0, 255]) {
      const surface = '#' + [r, g, b].map(channel => Math.round(channel * alpha + backdrop * (1 - alpha)).toString(16).padStart(2, '0')).join('')
      for (const ink of readingInk) {
        assert.ok(contrast(f.token(ink), surface) >= 4.5, `${label} ${ink} on composited paper over ${backdrop}`)
      }
    }
  })
})

test('native conversation tabs get one light pill treatment and lose their underline without affecting plugin tabs', t => {
  const f = fixture(t, { enabled: true })
  const native = f.doc.querySelector('[data-native-theme]')
  native.textContent += '.native-tab{padding:0 0 9px;border-radius:0;background:transparent}.native-tab::after{content:"";height:2px;background:#3964fe}.plugin-tab{border-radius:17px;padding:3px 4px;background:rgb(245,245,245)}'
  const root = f.doc.getElementById('root')
  const header = f.doc.createElement('div')
  header.setAttribute('data-slot', 'conversation.session.header')
  header.innerHTML = '<div data-conversation-tabs role="tablist"><button class="native-tab" role="tab" aria-selected="true">对话</button><button class="native-tab" role="tab" aria-selected="false">轨迹</button><button class="native-tab" role="tab" aria-selected="false">上下文</button><button class="native-tab" role="tab" aria-selected="false">编队</button></div>'
  root.append(header)
  const plugin = f.doc.createElement('div')
  plugin.innerHTML = '<section class="qyt-settings"><div role="tablist"><button class="plugin-tab" role="tab" aria-selected="true">Q 主题</button></div></section><div data-conversation-tabs role="tablist"><button class="plugin-tab" role="tab" aria-selected="true">Different surface</button></div>'
  root.append(plugin)
  const pluginButtons = [...plugin.querySelectorAll('button')]
  const original = pluginButtons.map(button => ({ radius: f.dom.window.getComputedStyle(button).borderRadius, padding: f.dom.window.getComputedStyle(button).padding }))
  f.install()
  const active = header.querySelector('[aria-selected="true"]')
  const computed = f.dom.window.getComputedStyle(active)
  assert.equal(computed.borderRadius, '9px')
  assert.equal(computed.padding, '5px 12px')
  const rules = allRules(f.styles()[0].sheet.cssRules)
  const tabRules = rules.filter(rule => rule.selectorText?.includes('button[role="tab"]'))
  assert.ok(tabRules.length >= 5)
  for (const rule of tabRules) {
    assert.match(rule.selectorText, /\[data-slot="conversation\.session\.header"\] > \[data-conversation-tabs\]\[role="tablist"\] > button\[role="tab"\]/u)
    const selector = rule.selectorText.replace(/::after/gu, '')
    for (const element of f.doc.querySelectorAll(selector)) assert.ok(header.contains(element), 'theme tab styling stays inside the native Session header')
  }
  const underline = tabRules.find(rule => rule.selectorText.endsWith('::after'))
  assert.equal(underline.style.getPropertyValue('content'), 'none')
  assert.equal(underline.style.getPropertyValue('display'), 'none')
  for (const [index, button] of pluginButtons.entries()) {
    const style = f.dom.window.getComputedStyle(button)
    assert.equal(style.borderRadius, original[index].radius)
    assert.equal(style.padding, original[index].padding)
  }
})

test('stylesheet is a reversible token/semantic-surface layer without destructive content resets', () => {
  assert.doesNotMatch(css + begoniaPalette, /!important|(?:^|[;{])\s*(?:filter|font-family|font-size|line-height|animation)\s*:/u)
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  try {
    const sheet = dom.window.document.createElement('style'); sheet.textContent = css; dom.window.document.head.append(sheet)
    for (const rule of allRules(sheet.sheet.cssRules)) {
      if (!rule.style) continue
      if (rule.style.getPropertyValue('position') || rule.style.getPropertyValue('z-index') || rule.style.getPropertyValue('backdrop-filter') || rule.style.getPropertyValue('-webkit-backdrop-filter')) {
        const phase = `${body} [data-slot="main.conversation"] > [data-phase]`
        const illustration = `${phase} > ${sceneLayers}`
        const seat = `${body} [data-slot="main.conversation"] > [data-phase="active"] > [data-conversation-content] > [data-conversation-scroll] > [data-composer-seat]`
        const dock = '[data-slot="conversation.input.dock"] > [data-testid="todo-panel"]'
        const todo = `${seat} ${dock}`
        const mirror = `${body} [data-composer-seat] > ${dockLayer} > ${dockFrames}`
        assert.ok([phase, illustration, `${seat}::before`, `${seat} > ${dockLayer}`, mirror, `${seat}:has(${dock} > div > button[aria-expanded="true"])`, todo, `${todo} > div > ul`].includes(rule.selectorText), 'positioning is confined to the illustration stacking context, its decorative layers and the native task dock')
      }
    }
  } finally { dom.window.close() }
  assert.doesNotMatch(css + begoniaPalette, /--(?:shiki|dsw-alias-(?:state-(?:error|success|warn)|code-diff|file-diff|markdown-code))/u)
  assert.match(css, /body\[data-qyt-q-theme="ocean"\]\[data-ds-dark-theme\]/u)
  assert.match(css, /@media \(forced-colors: active\)/u)
  assert.match(css, /\[data-composer-card\]/u)
  assert.match(css, /\[data-slot="sidebar"\]/u)
  assert.doesNotMatch(commonCss, /body\[data-qyt-q-theme\]\s+\[role="tab"\]/u)
})

test('live illustration layers stay behind native content and preserve the static fallback until ready', t => {
  const f = fixture(t, { enabled: true })
  f.install()
  const rules = allRules(f.styles()[0].sheet.cssRules)
  const phase = `${body} [data-slot="main.conversation"] > [data-phase]`
  const decoration = rules.find(rule => rule.selectorText === `${phase} > ${sceneLayers}`)
  assert.ok(decoration)
  for (const [property, value] of [['position', 'absolute'], ['z-index', '-1'], ['pointer-events', 'none'], ['visibility', 'hidden']]) {
    assert.equal(decoration.style.getPropertyValue(property), value)
  }
  const baseline = rules.find(rule => rule.selectorText === phase)
  assert.equal(baseline.style.getPropertyValue('isolation'), 'isolate')
  assert.equal(baseline.style.getPropertyValue('background-image'), 'var(--qyt-q-canvas-image)')
  const live = rules.find(rule => rule.selectorText === `${phase}${liveMarker}`)
  assert.equal(live.style.getPropertyValue('background-image'), 'none')
  const ready = rules.find(rule => rule.selectorText === `${phase}${liveMarker} > ${readyLayers}`)
  assert.equal(ready.style.getPropertyValue('visibility'), 'visible')
  const wash = rules.find(rule => rule.selectorText === `${phase} > ${washLayer}`)
  const dockWash = rules.find(rule => rule.selectorText.endsWith(`${dockLayer} > ${washLayer}`))
  for (const property of ['background-image', 'background-attachment', 'background-position', 'background-size']) {
    assert.equal(dockWash.style.getPropertyValue(property), wash.style.getPropertyValue(property), 'both pieces of the same frame use the same viewport wash')
  }
  assert.equal(wash.style.getPropertyValue('background-attachment'), 'fixed')
  assert.ok(!rules.some(rule => rule.selectorText?.includes('[data-qyt-ocean-live]') && rule.selectorText?.includes('[data-composer-seat]') && rule.style?.getPropertyValue('background-image') === 'none'), 'live mode must not turn the composer backdrop into an opaque plain panel')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u)
})


test('missing and unknown theme ids retain Ocean and its saved static choice', t => {
  for (const qThemeId of [undefined, null, '', 'future-theme', '__proto__', 42]) {
    const ocean = motionFixture('ocean'), begonia = motionFixture('begonia')
    const f = fixture(t, { scene: ocean, begoniaScene: begonia, sharedForm: formFixture({
      qThemeEnabled: true, qThemeId,
      qThemeSettings: { ocean: { motion: 'static' }, begonia: { motion: 'dynamic' } },
    }) })
    f.install()
    assert.equal(f.doc.body.getAttribute('data-qyt-q-theme'), 'ocean')
    assert.equal(f.styles().length, 1)
    assert.equal(f.token('--qyt-q-base'), '#fafaf8')
    assert.equal(ocean.installs, 0)
    assert.equal(begonia.installs, 0)
  }
})

test('theme switching reuses one presentation layer and each theme retains its own motion preference', t => {
  const ocean = motionFixture('ocean'), begonia = motionFixture('begonia')
  const initial = { qThemeEnabled: true, qThemeId: 'ocean', qThemeSettings: { ocean: { motion: 'static' }, begonia: { motion: 'dynamic' } } }
  const f = fixture(t, { scene: ocean, begoniaScene: begonia, sharedForm: formFixture(initial) })
  const cleanup = f.install()
  const style = f.styles()[0]
  assert.equal(ocean.active, 0)
  f.update({ ...initial, qThemeId: 'begonia' })
  assert.equal(f.doc.body.getAttribute('data-qyt-q-theme'), 'begonia')
  assert.equal(style.dataset.qytQTheme, 'begonia')
  assert.equal(f.styles()[0], style)
  assert.equal(f.token('--qyt-q-base'), '#fffaf5')
  assert.equal(begonia.active, 1)
  assert.equal(ocean.installs, 0)
  const updated = { ...initial, qThemeId: 'begonia', qThemeSettings: { ocean: { motion: 'dynamic' }, begonia: { motion: 'dynamic' } } }
  f.update(updated)
  assert.equal(begonia.installs, 1, 'editing the inactive theme never restarts selected motion')
  f.update({ ...updated, qThemeSettings: { ocean: { motion: 'dynamic' }, begonia: { motion: 'static' } } })
  assert.equal(begonia.active, 0)
  assert.equal(begonia.cleanups, 1)
  f.update({ ...updated, qThemeId: 'ocean', qThemeSettings: { ocean: { motion: 'dynamic' }, begonia: { motion: 'static' } } })
  assert.equal(ocean.active, 1)
  assert.equal(ocean.installs, 1)
  assert.equal(f.token('--qyt-q-base'), '#fafaf8')
  f.update({ ...updated, qThemeId: 'begonia', qThemeSettings: { ocean: { motion: 'dynamic' }, begonia: { motion: 'static' } } })
  assert.equal(ocean.active, 0)
  assert.equal(ocean.cleanups, 1)
  assert.equal(begonia.installs, 1, 'returning to static Begonia preserves its independent choice')
  assert.equal(f.styles()[0], style)
  assert.equal(f.styles().length, 1)
  cleanup()
  assert.equal(f.styles().length, 0)
})

test('multiple consumers switch adapters once and the final owner restores the original marker', t => {
  const ocean = motionFixture('ocean'), begonia = motionFixture('begonia')
  const f = fixture(t, { enabled: true, marker: 'existing-owner', scene: ocean, begoniaScene: begonia })
  const original = f.doc.body.outerHTML
  const first = f.install(), second = f.install()
  const style = f.styles()[0]
  assert.equal(ocean.installs, 1)
  f.update({ qThemeEnabled: true, qThemeId: 'begonia' })
  assert.equal(ocean.cleanups, 1)
  assert.equal(begonia.installs, 1)
  assert.equal(begonia.active, 1)
  assert.equal(f.styles()[0], style)
  f.update({ qThemeEnabled: true, qThemeId: 'ocean' })
  assert.equal(begonia.cleanups, 1)
  assert.equal(ocean.installs, 2)
  first()
  assert.equal(ocean.active, 1)
  assert.equal(f.styles().length, 1)
  second()
  assert.equal(ocean.active, 0)
  assert.equal(ocean.cleanups, 2)
  assert.equal(f.styles().length, 0)
  assert.equal(f.doc.body.outerHTML, original)
  assert.equal(f.listeners.size, 0)
})

test('theme changes preserve native semantic colors, syntax highlighting and inline styles', t => {
  const f = fixture(t, { enabled: true })
  const inline = f.doc.body.getAttribute('style')
  const cleanup = f.install()
  const style = f.styles()[0]
  for (const qThemeId of ['begonia', 'ocean', 'begonia']) {
    f.update({ qThemeEnabled: true, qThemeId, qThemeSettings: { [qThemeId]: { motion: 'static' } } })
    for (const dark of [false, true]) {
      f.doc.body.toggleAttribute('data-ds-dark-theme', dark)
      for (const [name, value] of [
        ['--dsw-alias-state-error-primary', '#d31d34'], ['--dsw-alias-state-success-primary', '#198251'],
        ['--dsw-alias-state-warn-primary', '#9b640a'], ['--dsw-alias-code-diff-added', '#d4f4dd'],
      ]) assert.equal(f.token(name), value)
      assert.equal(f.token('--dsw-alias-markdown-code-block'), dark ? '#191919' : '#f8f8f8')
      assert.equal(f.dom.window.getComputedStyle(f.doc.querySelector('.shiki span')).color, 'rgb(120, 81, 169)')
      assert.equal(f.doc.body.getAttribute('style'), inline)
      assert.equal(f.styles()[0], style)
    }
  }
  f.doc.body.setAttribute('data-qyt-q-theme', 'later-owner')
  cleanup()
  assert.equal(f.doc.body.getAttribute('data-qyt-q-theme'), 'later-owner', 'cleanup preserves a subsequent external owner')
})

test('a failing motion adapter retains static artwork and retries only after an explicit mode change', t => {
  for (const qThemeId of ['ocean', 'begonia']) {
    let attempts = 0
    const broken = { install() { attempts++; throw new Error('unsupported renderer') } }
    const value = { qThemeEnabled: true, qThemeId }
    const f = fixture(t, { scene: broken, begoniaScene: broken, sharedForm: formFixture(value) })
    assert.doesNotThrow(() => f.install())
    assert.equal(attempts, 1)
    assert.equal(f.styles().length, 1)
    assert.equal(f.doc.body.getAttribute('data-qyt-q-theme'), qThemeId)
    assert.ok(f.token('--qyt-theme-art').startsWith('url("data:image/'), 'static illustration survives failed motion')
    f.update(value)
    assert.equal(attempts, 1, 'ordinary snapshots cannot create a renderer retry loop')
    f.update({ ...value, qThemeSettings: { [qThemeId]: { motion: 'static' } } })
    f.update({ ...value, qThemeSettings: { [qThemeId]: { motion: 'dynamic' } } })
    assert.equal(attempts, 2)
    f.update({ ...value, qThemeEnabled: false })
    assert.equal(f.styles().length, 0)
    assert.equal(f.doc.body.hasAttribute('data-qyt-q-theme'), false)
  }
})


test('a throwing adapter disposer cannot interrupt theme switching, static mode or final restoration', t => {
  let installs = 0, cleanups = 0
  const brokenCleanup = { install() { installs++; return () => { cleanups++; throw new Error('lost rendering context') } } }
  const f = fixture(t, { enabled: true, marker: 'previous-theme', scene: brokenCleanup, begoniaScene: brokenCleanup })
  const original = f.doc.body.outerHTML
  const cleanup = f.install()
  const style = f.styles()[0]
  assert.doesNotThrow(() => f.update({ qThemeEnabled: true, qThemeId: 'begonia' }))
  assert.equal(cleanups, 1)
  assert.equal(installs, 2)
  assert.equal(f.doc.body.getAttribute('data-qyt-q-theme'), 'begonia')
  assert.equal(f.styles()[0], style)
  assert.doesNotThrow(() => f.update({ qThemeEnabled: true, qThemeId: 'begonia', qThemeSettings: { begonia: { motion: 'static' } } }))
  assert.equal(cleanups, 2)
  assert.equal(installs, 2)
  assert.equal(f.token('--qyt-q-base'), '#fffaf5')
  f.update({ qThemeEnabled: true, qThemeId: 'ocean' })
  assert.equal(installs, 3)
  assert.doesNotThrow(cleanup)
  assert.equal(cleanups, 3)
  assert.equal(f.styles().length, 0)
  assert.equal(f.doc.body.outerHTML, original)
  assert.equal(f.listeners.size, 0)
  cleanup()
  assert.equal(cleanups, 3, 'disposed adapters are never called again')
})
