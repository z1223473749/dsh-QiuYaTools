import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = new URL('../', import.meta.url)
const source = (await build({
  entryPoints: [new URL('src/client/q-theme.ts', root).pathname],
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
  const dom = new JSDOM('<!doctype html><html data-platform="darwin"><head><style data-native-theme>body{--dsw-alias-bg-base:#fff;--dsw-alias-state-error-primary:#d31d34;--dsw-alias-state-success-primary:#198251;--dsw-alias-state-warn-primary:#9b640a;--dsw-alias-code-diff-added:#d4f4dd;--dsw-alias-markdown-code-block:#f8f8f8}body[data-ds-dark-theme]{--dsw-alias-markdown-code-block:#191919}.shiki span{color:#7851a9}</style></head><body style="--host-layer: preserved; color: rgb(11, 22, 33)"><div id="root"><div data-slot="sidebar"><aside>Sidebar</aside></div><main data-slot="main.conversation"><section>Conversation</section></main><div data-composer-card>Composer</div><pre class="shiki"><span>highlighted</span></pre></div></body></html>')
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
  assert.equal(f.token('--qyt-q-base'), '#f7fbfc')
  for (const [name, value] of [
    ['--dsw-alias-state-error-primary', '#d31d34'], ['--dsw-alias-state-success-primary', '#198251'],
    ['--dsw-alias-state-warn-primary', '#9b640a'], ['--dsw-alias-code-diff-added', '#d4f4dd'],
  ]) assert.equal(f.token(name), value)
  f.doc.body.setAttribute('data-ds-dark-theme', '')
  assert.equal(f.token('--qyt-q-base'), '#10232d')
  assert.equal(f.token('--dsw-alias-markdown-code-block'), '#191919')
  assert.equal(f.dom.window.getComputedStyle(f.doc.querySelector('.shiki span')).color, 'rgb(120, 81, 169)')
  assert.equal(f.styles()[0], style, 'a native scheme change only changes CSS matching')
  f.doc.body.removeAttribute('data-ds-dark-theme')
  assert.equal(f.token('--qyt-q-base'), '#f7fbfc')
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
  assert.equal(main.token('--qyt-q-base'), '#f7fbfc')
  assert.equal(window.token('--qyt-q-base'), '#10232d')
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
  assert.ok(contrast('#13788f', '#ffffff') >= 4.5, 'native send button keeps its fixed white icon readable')
})

test('stylesheet is a reversible token/semantic-surface layer without destructive content resets', () => {
  assert.doesNotMatch(css, /!important|\b(?:filter|font-family|font-size|line-height|position|z-index|animation)\s*:/u)
  assert.doesNotMatch(css, /--(?:shiki|dsw-alias-(?:state-(?:error|success|warn)|code-diff|file-diff|markdown-code))/u)
  assert.match(css, /body\[data-qyt-q-theme="ocean"\]\[data-ds-dark-theme\]/u)
  assert.match(css, /@media \(forced-colors: active\)/u)
  assert.match(css, /\[data-composer-card\]/u)
  assert.match(css, /\[data-slot="sidebar"\]/u)
})
