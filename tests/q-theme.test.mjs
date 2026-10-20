import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = new URL('../', import.meta.url)
const source = (await build({
  entryPoints: [fileURLToPath(new URL('src/client/q-theme.ts', root))],
  bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'text' },
})).outputFiles[0].text
const css = await readFile(new URL('src/client/q-theme.css', root), 'utf8')

function moduleFor(document) {
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, document })
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

function fixture(t, { enabled = false, marker, dark = false, sharedForm } = {}) {
  const dom = new JSDOM('<!doctype html><html data-platform="darwin"><head><style data-native-theme>body{--dsw-alias-bg-base:#fff;--dsw-alias-state-error-primary:#d31d34;--dsw-alias-state-success-primary:#198251;--dsw-alias-state-warn-primary:#9b640a;--dsw-alias-code-diff-added:#d4f4dd;--dsw-alias-markdown-code-block:#f8f8f8}body[data-ds-dark-theme]{--dsw-alias-markdown-code-block:#191919}.shiki span{color:#7851a9}</style></head><body style="--host-layer: preserved; color: rgb(11, 22, 33)"><div id="root"><div data-slot="sidebar"><aside>Sidebar</aside></div><main data-slot="main.conversation"><section data-phase="active"><div data-conversation-scroll>Conversation</div></section></main><div data-composer-card>Composer</div><pre class="shiki"><span>highlighted</span></pre></div></body></html>')
  t.after(() => dom.window.close())
  const doc = dom.window.document
  if (marker !== undefined) doc.body.setAttribute('data-qyt-q-theme', marker)
  if (dark) doc.body.setAttribute('data-ds-dark-theme', '')
  const form = sharedForm ?? formFixture({ qThemeEnabled: enabled })
  const plugin = moduleFor(doc)
  const cleanups = []
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup() })
  return {
    doc, dom, ...form, plugin,
    install() { const cleanup = plugin.installQTheme({}, form.form); cleanups.push(cleanup); return cleanup },
    styles: () => [...doc.querySelectorAll('style[data-qyt-q-theme="ocean"]')],
    token: name => dom.window.getComputedStyle(doc.body).getPropertyValue(name).trim(),
  }
}

test('stays off until an accepted explicit setting and ignores the legacy feature master switch', t => {
  const f = fixture(t)
  const original = f.doc.body.outerHTML
  f.install()
  assert.equal(f.listeners.size, 1)
  assert.equal(f.styles().length, 0)
  assert.equal(f.doc.body.outerHTML, original)
  f.update({ enabled: true, pastedTextEnabled: true })
  assert.equal(f.styles().length, 0, 'old profiles do not acquire a theme during upgrade')
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

test('both palettes keep small primary/secondary/muted text readable on base, raised and selected surfaces', t => {
  for (const dark of [false, true]) {
    const f = fixture(t, { enabled: true, dark })
    f.install()
    for (const ink of ['--qyt-q-ink', '--qyt-q-secondary', '--qyt-q-muted']) {
      for (const surface of ['--qyt-q-base', '--qyt-q-surface', '--qyt-q-raised', '--qyt-q-sidebar', '--qyt-q-selected']) {
        assert.ok(contrast(f.token(ink), f.token(surface)) >= 4.5, `${dark ? 'dark' : 'light'} ${ink} on ${surface}`)
      }
    }
  }
  assert.ok(contrast('#116d83', '#ffffff') >= 4.5, 'native send button keeps its fixed white icon readable')
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

test('theme illustration is embedded and withdrawn with the theme without external image requests', t => {
  const f = fixture(t, { enabled: true })
  const cleanup = f.install()
  const installed = f.styles()[0].textContent
  assert.ok(!installed.includes('__QYT_OCEAN_SCENE__'), 'the actual packaged image replaces the build placeholder')
  const urls = [...installed.matchAll(/url\("([^"]+)"\)/gu)].map(match => match[1])
  assert.equal(urls.length, 1)
  assert.ok(urls.every(url => url.startsWith('data:image/webp;base64,')), 'no remote image request or unresolvable asset path')
  cleanup()
  assert.equal(f.styles().length, 0)
})

test('the approved illustrated sidebar keeps its own art opacity and selected-row treatment', t => {
  const f = fixture(t, { enabled: true })
  f.install()
  assert.equal(f.token('--qyt-q-chrome'), 'rgba(229, 239, 234, .95)')
  assert.equal(f.token('--qyt-q-sidebar-wash'), 'rgba(229, 239, 234, .80)')
  assert.equal(f.token('--qyt-q-sidebar'), '#e5efea')
  const rules = allRules(f.styles()[0].sheet.cssRules)
  const sidebar = rules.find(rule => rule.selectorText === 'body[data-qyt-q-theme="ocean"] [data-slot="sidebar"] > :first-child')
  assert.ok(sidebar)
  assert.equal(sidebar.style.getPropertyValue('background-size'), '100% 100%, auto 310px')
  assert.ok(sidebar.style.getPropertyValue('background-image').includes('var(--qyt-ocean-art)'))
  const selected = rules.find(rule => rule.selectorText?.includes('[data-row-key^="session:"][aria-selected="true"]'))
  assert.equal(selected.style.getPropertyValue('box-shadow'), 'inset 3px 0 var(--qyt-q-sea)')
})

test('the translucent reading paper keeps text readable over any background image color', t => {
  for (const dark of [false, true]) {
    const f = fixture(t, { enabled: true, dark })
    f.install()
    const match = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([.\d]+)\)$/u.exec(f.token('--qyt-q-paper'))
    assert.ok(match)
    const [r, g, b, alpha] = match.slice(1).map(Number)
    // Luminance is monotonic in each channel. Black/white extremes bound
    // every possible pixel in the illustration, including future artwork.
    for (const backdrop of [0, 255]) {
      const surface = '#' + [r, g, b].map(channel => Math.round(channel * alpha + backdrop * (1 - alpha)).toString(16).padStart(2, '0')).join('')
      for (const ink of ['--qyt-q-ink', '--qyt-q-secondary', '--qyt-q-muted']) {
        assert.ok(contrast(f.token(ink), surface) >= 4.5, `${dark ? 'dark' : 'light'} ${ink} on composited paper`)
      }
    }
  }
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
  assert.doesNotMatch(css, /!important|(?:^|[;{])\s*(?:filter|font-family|font-size|line-height|animation)\s*:/u)
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  try {
    const sheet = dom.window.document.createElement('style'); sheet.textContent = css; dom.window.document.head.append(sheet)
    for (const rule of allRules(sheet.sheet.cssRules)) {
      if (!rule.style) continue
      if (rule.style.getPropertyValue('position') || rule.style.getPropertyValue('z-index') || rule.style.getPropertyValue('backdrop-filter') || rule.style.getPropertyValue('-webkit-backdrop-filter')) {
        const seat = 'body[data-qyt-q-theme="ocean"] [data-slot="main.conversation"] > [data-phase="active"] > [data-conversation-content] > [data-conversation-scroll] > [data-composer-seat]'
        const dock = '[data-slot="conversation.input.dock"] > [data-testid="todo-panel"]'
        const todo = `${seat} ${dock}`
        assert.ok([`${seat}::before`, `${seat}:has(${dock} > div > button[aria-expanded="true"])`, todo, `${todo} > div > ul`].includes(rule.selectorText), 'positioning is confined to the canvas decoration and the native task dock')
      }
    }
  } finally { dom.window.close() }
  assert.doesNotMatch(css, /--(?:shiki|dsw-alias-(?:state-(?:error|success|warn)|code-diff|file-diff|markdown-code))/u)
  assert.match(css, /body\[data-qyt-q-theme="ocean"\]\[data-ds-dark-theme\]/u)
  assert.match(css, /@media \(forced-colors: active\)/u)
  assert.match(css, /\[data-composer-card\]/u)
  assert.match(css, /\[data-slot="sidebar"\]/u)
  assert.doesNotMatch(css, /body\[data-qyt-q-theme="ocean"\]\s+\[role="tab"\]/u)
})
