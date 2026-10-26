import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const React = require('react')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://harness.test' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { createRoot } = require('react-dom/client')
const { Simulate } = require('react-dom/test-utils')
const { act } = React
const settingsStyle = document.createElement('style')
settingsStyle.textContent = '.harness-options { overflow-y: auto; }\n' + readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
document.head.append(settingsStyle)

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/index.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', target: 'node22', format: 'cjs', packages: 'external',
  jsx: 'transform', loader: { '.css': 'text' },
  plugins: [{
    name: 'isolate-settings-from-feature-installers',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/features\.ts$/ }, () => ({ path: 'installers', namespace: 'test-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-stub' }, () => ({ contents: 'export function installFeatures() {}' }))
      builder.onResolve({ filter: /^\.\/q-theme\.ts$/ }, () => ({ path: 'theme', namespace: 'theme-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'theme-stub' }, () => ({ contents: 'export function installQTheme() {}' }))
      builder.onResolve({ filter: /^\.\/session-window-support\.ts$/ }, () => ({ path: 'support', namespace: 'support-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'support-stub' }, () => ({ contents: 'export function getSessionWindowSupport(ctx) { return ctx.sessionWindowSupport }' }))
      builder.onResolve({ filter: /computer-use\/panel\.tsx$/ }, () => ({ path: 'computer', namespace: 'computer-stub' }))
      builder.onResolve({ filter: /^react$/, namespace: 'computer-stub' }, () => ({ path: 'react', external: true }))
      builder.onLoad({ filter: /.*/, namespace: 'computer-stub' }, () => ({ contents: `import React from 'react'; export function ComputerPanel({ enabled, onEnabled, disabled }) { return React.createElement('section', { 'data-computer-panel': true }, React.createElement('button', { role: 'switch', 'aria-label': '启用电脑操控', 'aria-checked': enabled, disabled, onClick: () => onEnabled(!enabled) }, '电脑操控')) }` }))
      builder.onResolve({ filter: /^\.\/about\.tsx$/ }, () => ({ path: 'about', namespace: 'about-stub' }))
      builder.onResolve({ filter: /^react$/, namespace: 'about-stub' }, () => ({ path: 'react', external: true }))
      builder.onLoad({ filter: /.*/, namespace: 'about-stub' }, () => ({ contents: `import React from 'react'; export function AboutPanel({ version, ctx }) { return React.createElement('article', { 'data-about-version': version, 'data-about-context': ctx ? 'present' : 'missing' }, 'about-panel') }` }))
      builder.onResolve({ filter: /^\.\/updates\.tsx$/ }, () => ({ path: 'updates', namespace: 'updates-stub' }))
      builder.onResolve({ filter: /^react$/, namespace: 'updates-stub' }, () => ({ path: 'react', external: true }))
      builder.onLoad({ filter: /.*/, namespace: 'updates-stub' }, () => ({ contents: `import React from 'react'; export function UpdatePanel({ version, ctx }) { return React.createElement('article', { 'data-updates-version': version, 'data-updates-context': ctx ? 'present' : 'missing' }, 'updates-panel') }` }))
    },
  }],
})
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, {
  module, exports: module.exports, AbortController,
  require(id) {
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {
      Switch: ({ checked, disabled, label, onChange, className }) => React.createElement('button', {
        type: 'button', role: 'switch', disabled, 'aria-label': label, 'aria-checked': checked,
        className,
        onClick: () => onChange(!checked),
      }),
    }
    return require(id)
  },
})
const { QiuYaToolsSettings } = module.exports

const defaults = {
  enabled: true, pastedTextEnabled: true, sessionWindowsEnabled: true,
  bulkArchiveEnabled: true, planCommentsEnabled: true, conversationCommentsEnabled: true, sidebarToolsEnabled: true, promptSuggestionsEnabled: true, gitEnabled: true, qThemeEnabled: false,
  pasteCharacterThreshold: 1000, pasteLineThreshold: 15,
}
const featureFields = ['pastedTextEnabled', 'sessionWindowsEnabled', 'bulkArchiveEnabled', 'planCommentsEnabled', 'conversationCommentsEnabled', 'sidebarToolsEnabled', 'promptSuggestionsEnabled', 'gitEnabled']

function mount(value = {}, policy = {}, compatibility = { harnessVersion: '0.2.1-rc.2', minimumHarnessVersion: '0.2.1-rc.2', versionSupported: true, status: 'ready' }) {
  let snapshot = {
    status: 'ready', writable: true, value: { ...value }, revision: 1,
    ...policy,
  }
  const listeners = new Set()
  const supportListeners = new Set()
  let supportSnapshot = compatibility
  const sessionWindowSupport = {
    getSnapshot: () => supportSnapshot,
    subscribe(callback) { supportListeners.add(callback); return () => supportListeners.delete(callback) },
  }
  const mutations = []
  let failure = null
  const form = {
    getSnapshot: () => snapshot,
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback) },
    async mutate(operations) {
      mutations.push(structuredClone(operations))
      if (failure) throw failure
      const next = { ...snapshot.value }
      for (const operation of operations) {
        assert.equal(operation.op, 'set')
        assert.equal(operation.path.length, 1)
        next[operation.path[0]] = operation.value
      }
      snapshot = { ...snapshot, value: next, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
      return true
    },
    set() { throw Error('Settings writes must be atomic form.mutate calls') },
  }
  const dialog = document.createElement('div')
  dialog.dataset.shortcutModal = 'settings'
  const options = document.createElement('div')
  options.className = 'harness-options'
  const container = document.createElement('div')
  container.dataset.slot = 'settings.section'
  container.style.display = 'contents'
  options.append(container)
  dialog.append(options)
  document.body.append(dialog)
  const root = createRoot(container)
  act(() => root.render(React.createElement(QiuYaToolsSettings, { form, t: key => key, ctx: { sessionWindowSupport } })))
  return {
    container, options, mutations,
    snapshot: () => snapshot,
    support(next) { act(() => { supportSnapshot = next; for (const listener of supportListeners) listener() }) },
    failWith(error) { failure = error },
    switch(label) { return container.querySelector(`:is([role="switch"], [role="checkbox"])[aria-label="${label}"]`) },
    tab(label) { return [...container.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === label) },
    select(label) { act(() => Simulate.click(this.tab(label))) },
    async toggle(label) { await act(async () => { Simulate.click(this.switch(label)) }) },
    edit(index, value) { act(() => Simulate.change(container.querySelectorAll('input')[index], { target: { value } })) },
    async submit() { await act(async () => { Simulate.submit(container.querySelector('form')) }) },
    dispose() { act(() => root.unmount()); dialog.remove() },
  }
}

test('settings default every feature to on and atomically turn every feature off and on', async () => {
  const f = mount()
  try {
    assert.equal(f.container.querySelectorAll('[role="switch"], [role="checkbox"]').length, 2, 'only the master and active feature controls are mounted')
    assert.ok(f.container.querySelector('.qyt-header-actions').contains(f.switch('enabled')), 'the master is in the fixed header')
    assert.equal(f.container.querySelector('.qyt-master'), null, 'there is no second master card')
    assert.equal(f.container.querySelector('.qyt-save-feedback'), null, 'there is no permanent save-explanation row')
    for (const label of ['pastedTextTab', 'sessionWindowsTab', 'bulkArchiveTab', 'planCommentsTab', 'sidebarToolsTab', 'promptSuggestionsTab']) {
      f.select(label)
      assert.equal(f.container.querySelectorAll('[aria-checked="true"]').length, label === 'planCommentsTab' ? 3 : 2)
    }
    f.select('pastedTextTab')
    assert.equal(f.container.querySelectorAll('input')[0].value, '1000')
    assert.equal(f.container.querySelectorAll('input')[1].value, '15')
    await f.toggle('enabled')
    assert.equal(f.mutations.length, 1)
    assert.equal(f.mutations[0].length, featureFields.length + 1)
    assert.deepEqual(f.mutations[0][0], { op: 'set', path: ['enabled'], value: true })
    for (const field of featureFields) assert.equal(f.snapshot().value[field], false)
    assert.equal(f.container.querySelectorAll('[aria-checked="true"]').length, 0)
    await f.toggle('enabled')
    assert.equal(f.mutations.length, 2)
    for (const field of featureFields) assert.equal(f.snapshot().value[field], true)
    assert.equal(f.container.querySelectorAll('[aria-checked="true"]').length, 2)
  } finally { f.dispose() }
})

test('each feature shows a mixed master when disabled and one master click restores all tools', async () => {
  for (const [field, label] of [
    ['pastedTextEnabled', 'pastedText'], ['sessionWindowsEnabled', 'sessionWindows'],
    ['bulkArchiveEnabled', 'bulkArchive'], ['planCommentsEnabled', 'planComments'], ['conversationCommentsEnabled', 'conversationComments'], ['sidebarToolsEnabled', 'sidebarTools'],
    ['promptSuggestionsEnabled', 'promptSuggestions'],
    ['gitEnabled', 'git'],
  ]) {
    const f = mount({ ...defaults, unrelated: { preserve: true } })
    try {
      f.select(label === 'conversationComments' ? 'planCommentsTab' : `${label}Tab`)
      await f.toggle(label)
      assert.deepEqual(f.mutations, [[
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: [field], value: false },
      ]])
      assert.equal(f.switch('enabled').getAttribute('aria-checked'), 'mixed')
      assert.equal(f.container.querySelectorAll('[aria-checked="true"]').length, ['planComments', 'conversationComments'].includes(label) ? 1 : 0)
      for (const other of featureFields.filter(other => other !== field)) assert.equal(f.snapshot().value[other], true)
      assert.deepEqual(f.snapshot().value.unrelated, { preserve: true })
      await f.toggle('enabled')
      assert.deepEqual(f.mutations[1], [
        { op: 'set', path: ['enabled'], value: true },
        ...featureFields.map(field => ({ op: 'set', path: [field], value: true })),
      ])
      assert.equal(f.switch('enabled').getAttribute('aria-checked'), 'true')
      assert.equal(f.snapshot().value.qThemeEnabled, false, 'the independent theme preference is preserved')
      assert.deepEqual(f.snapshot().value.unrelated, { preserve: true })
    } finally { f.dispose() }
  }
})

test('plan comments and conversation comments share a tab with independent controls and guides', async () => {
  const f = mount({ planCommentsEnabled: false, conversationCommentsEnabled: true })
  try {
    f.select('planCommentsTab')
    assert.equal(f.switch('planComments').getAttribute('aria-checked'), 'false')
    assert.equal(f.switch('conversationComments').getAttribute('aria-checked'), 'true')
    assert.equal([...f.container.querySelectorAll('[role="tab"]')].filter(tab => tab.textContent === 'planCommentsTab').length, 1)
    assert.equal([...f.container.querySelectorAll('[role="tab"]')].some(tab => tab.textContent === 'conversationCommentsTab'), false)
    const guides = [...f.container.querySelectorAll('.qyt-guide')]
    assert.equal(guides.length, 2)
    assert.match(guides[0].textContent, /planCommentsSelection.*planCommentsCard.*planCommentsSubmit/u)
    assert.match(guides[1].textContent, /conversationCommentsSelection.*conversationCommentsMarkers.*conversationCommentsSubmit/u)
    await f.toggle('conversationComments')
    assert.equal(f.snapshot().value.planCommentsEnabled, false)
    assert.equal(f.snapshot().value.conversationCommentsEnabled, false)
    await f.toggle('planComments')
    assert.equal(f.snapshot().value.planCommentsEnabled, true)
    assert.equal(f.snapshot().value.conversationCommentsEnabled, false)
  } finally { f.dispose() }
})

test('a legacy paused profile can be activated through an individual feature switch', async () => {
  const f = mount({ enabled: false })
  try {
    assert.equal(f.container.querySelectorAll('[aria-checked="true"]').length, 0)
    f.select('sessionWindowsTab')
    await f.toggle('sessionWindows')
    assert.deepEqual(f.mutations[0], [
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['sessionWindowsEnabled'], value: true },
    ])
    assert.equal(f.switch('sessionWindows').getAttribute('aria-checked'), 'true')
  } finally { f.dispose() }
})

test('independent windows show the minimum Harness version inside the usage guide', () => {
  const f = mount()
  try {
    f.select('sessionWindowsTab')
    const guide = f.container.querySelector('.qyt-guide')
    assert.match(guide.textContent, /sessionWindowsMinimum\s+0\.2\.1-rc\.2/u)
    assert.match(guide.textContent, /sessionWindowsMenu/u)
    assert.match(guide.textContent, /sessionWindowsDrag/u)
    assert.equal(f.switch('sessionWindows').disabled, false)
    assert.equal(f.mutations.length, 0)
  } finally { f.dispose() }
})

test('old, unknown and pending Harness versions cannot enable windows individually or through the master', async () => {
  for (const compatibility of [
    { status: 'ready', harnessVersion: '0.2.1-rc.1', versionSupported: false },
    { status: 'unavailable', versionSupported: false },
    { status: 'checking', versionSupported: false },
  ]) {
    const f = mount(defaults, {}, { minimumHarnessVersion: '0.2.1-rc.2', ...compatibility })
    try {
      f.select('sessionWindowsTab')
      assert.equal(f.switch('sessionWindows').disabled, true)
      assert.equal(f.switch('sessionWindows').getAttribute('aria-checked'), 'false', 'a saved true flag cannot appear active on an unsupported runtime')
      const expected = compatibility.status === 'ready' ? 'sessionWindowsVersionUnsupported' : compatibility.status === 'checking' ? 'sessionWindowsVersionChecking' : 'sessionWindowsVersionUnknown'
      assert.ok(f.container.querySelector('.qyt-guide').textContent.includes(expected))
      if (compatibility.harnessVersion) assert.ok(f.container.querySelector('.qyt-guide').textContent.includes(compatibility.harnessVersion))
      await f.toggle('sessionWindows')
      assert.equal(f.mutations.length, 0, 'the handler also rejects a synthetic click on the disabled control')
      await f.toggle('enabled')
      assert.equal(f.switch('enabled').getAttribute('aria-checked'), 'false')
      await f.toggle('enabled')
      assert.equal(f.snapshot().value.sessionWindowsEnabled, false)
      for (const field of featureFields.filter(field => field !== 'sessionWindowsEnabled')) assert.equal(f.snapshot().value[field], true)
      assert.ok(f.mutations.flat().filter(operation => operation.path[0] === 'sessionWindowsEnabled').every(operation => operation.value === false))
      assert.equal(f.switch('sessionWindows').disabled, true)
      assert.equal(f.switch('enabled').getAttribute('aria-checked'), 'true', 'the master can still toggle all compatible features')
    } finally { f.dispose() }
  }
})

test('compatibility changes immediately update the window switch without rewriting stored preferences', async () => {
  const f = mount(defaults)
  try {
    f.select('sessionWindowsTab')
    f.support({ status: 'checking', minimumHarnessVersion: '0.2.1-rc.2', versionSupported: false })
    assert.equal(f.switch('sessionWindows').disabled, true)
    assert.equal(f.switch('sessionWindows').getAttribute('aria-checked'), 'false')
    f.support({ status: 'ready', minimumHarnessVersion: '0.2.1-rc.2', harnessVersion: '0.2.2', versionSupported: true })
    assert.equal(f.switch('sessionWindows').disabled, false)
    assert.equal(f.switch('sessionWindows').getAttribute('aria-checked'), 'true')
    assert.equal(f.mutations.length, 0)
    await f.toggle('sessionWindows')
    assert.equal(f.snapshot().value.sessionWindowsEnabled, false)
    await f.toggle('sessionWindows')
    assert.equal(f.snapshot().value.sessionWindowsEnabled, true)
  } finally { f.dispose() }
})

test('prompt suggestions expose their trigger, keyboard behavior and model usage without writing settings', () => {
  const f = mount()
  try {
    f.select('promptSuggestionsTab')
    assert.equal(f.switch('promptSuggestions').getAttribute('aria-checked'), 'true')
    assert.equal(f.container.querySelector('h3').textContent, 'promptSuggestions')
    assert.deepEqual([...f.container.querySelectorAll('.qyt-guide li')].map(item => item.textContent), [
      'promptSuggestionsWhen', 'promptSuggestionsAccept', 'promptSuggestionsModel',
    ])
    assert.equal(f.mutations.length, 0, 'opening the feature guide does not invoke a model or change preferences')
  } finally { f.dispose() }
})

test('threshold edits stay local and both limits save in one atomic namespace mutation', async () => {
  const f = mount(defaults)
  try {
    f.edit(0, '2000')
    f.edit(1, '30')
    assert.equal(f.mutations.length, 0)
    assert.equal(f.snapshot().value.pasteCharacterThreshold, 1000)
    f.select('sessionWindowsTab')
    f.select('aboutTab')
    f.select('updatesTab')
    f.select('qThemeTab')
    assert.equal(f.mutations.length, 0, 'browsing tabs never saves draft settings')
    f.select('pastedTextTab')
    assert.deepEqual([...f.container.querySelectorAll('input')].map(input => input.value), ['2000', '30'])
    await f.submit()
    assert.deepEqual(f.mutations, [[
      { op: 'set', path: ['pasteCharacterThreshold'], value: 2000 },
      { op: 'set', path: ['pasteLineThreshold'], value: 30 },
    ]])
    assert.equal(f.container.querySelectorAll('input')[0].value, '2000')
    assert.equal(f.container.querySelector('button[type="submit"]').disabled, true)
    assert.match(f.container.textContent, /saved/)
  } finally { f.dispose() }
})

test('threshold validation blocks malformed or out-of-range values and accepts the inclusive limits', async () => {
  const f = mount(defaults)
  try {
    for (const value of ['', '0', '-1', '1.5', '1e3', '1000001']) {
      f.edit(0, value)
      await f.submit()
      assert.equal(f.mutations.length, 0, `invalid characters: ${value}`)
      assert.match(f.container.querySelector('[role="alert"]').textContent, /invalidCharacters/)
    }
    f.edit(0, '1')
    for (const value of ['', '0', '-1', '1.5', '100001']) {
      f.edit(1, value)
      await f.submit()
      assert.equal(f.mutations.length, 0, `invalid lines: ${value}`)
      assert.match(f.container.querySelector('[role="alert"]').textContent, /invalidLines/)
    }
    f.edit(1, '1')
    await f.submit()
    assert.equal(f.snapshot().value.pasteCharacterThreshold, 1)
    assert.equal(f.snapshot().value.pasteLineThreshold, 1)
    f.edit(0, '1000000')
    f.edit(1, '100000')
    await f.submit()
    assert.equal(f.snapshot().value.pasteCharacterThreshold, 1_000_000)
    assert.equal(f.snapshot().value.pasteLineThreshold, 100_000)
  } finally { f.dispose() }
})

test('read-only or unavailable settings cannot write, and failures retain threshold edits for retry', async () => {
  for (const policy of [{ writable: false }, { status: 'loading' }, { status: 'unavailable' }]) {
    const f = mount(defaults, policy)
    try {
      assert.equal([...f.container.querySelectorAll('[role="switch"], [role="checkbox"], input, button[type="submit"]')].every(control => control.disabled), true)
      assert.equal([...f.container.querySelectorAll('[role="tab"]')].every(control => !control.disabled), true)
      await f.submit()
      assert.equal(f.mutations.length, 0)
      f.select('aboutTab')
      assert.ok(f.container.querySelector('[data-about-version]'), 'About remains available while settings cannot be written')
      f.select('updatesTab')
      assert.ok(f.container.querySelector('[data-updates-version]'), 'Updates remain available while settings cannot be written')
      f.select('qThemeTab')
      assert.equal(f.switch('qTheme').disabled, true)
      f.select('promptSuggestionsTab')
      assert.equal(f.switch('promptSuggestions').disabled, true)
    } finally { f.dispose() }
  }
  const f = mount(defaults)
  try {
    f.edit(0, '2500')
    f.failWith(Error('connection failed'))
    await f.submit()
    assert.match(f.container.querySelector('[role="alert"]').textContent, /saveError/)
    assert.equal(f.container.querySelectorAll('input')[0].value, '2500')
    assert.equal(f.container.querySelector('button[type="submit"]').disabled, false)
    f.failWith(null)
    await f.submit()
    assert.equal(f.snapshot().value.pasteCharacterThreshold, 2500)
  } finally { f.dispose() }
})

test('eleven icon tabs expose labelled panels and support roving focus and scrolling with arrows, Home and End', () => {
  const f = mount()
  try {
    const tablist = f.container.querySelector('[role="tablist"]')
    assert.equal(tablist.getAttribute('aria-label'), 'features')
    const tabs = [...tablist.querySelectorAll('[role="tab"]')]
    assert.equal(tabs.length, 11)
    assert.deepEqual(tabs.map(tab => tab.textContent), ['computerTab', 'pastedTextTab', 'sessionWindowsTab', 'bulkArchiveTab', 'planCommentsTab', 'sidebarToolsTab', 'promptSuggestionsTab', 'gitTab', 'qThemeTab', 'aboutTab', 'updatesTab'])
    const scrolled = []
    tabs.forEach((tab, index) => { tab.scrollIntoView = options => scrolled.push({ index, options: structuredClone(options) }) })
    assert.equal(tabs.filter(tab => tab.tabIndex === 0).length, 1)
    for (const tab of tabs) {
      assert.ok(tab.querySelector('svg[aria-hidden="true"]'), 'every tab has a decorative corresponding icon')
      const panel = document.getElementById(tab.getAttribute('aria-controls'))
      assert.equal(panel?.getAttribute('aria-labelledby'), tab.id)
      assert.equal(panel?.hidden, tab.getAttribute('aria-selected') !== 'true')
    }
    function key(value, expected) {
      const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
      act(() => document.activeElement.dispatchEvent(event))
      assert.equal(event.defaultPrevented, true)
      assert.equal(document.activeElement, tabs[expected])
      assert.equal(tabs[expected].getAttribute('aria-selected'), 'true')
      assert.equal(tabs.filter(tab => tab.tabIndex === 0).length, 1)
      assert.equal(f.container.querySelectorAll('[role="tabpanel"]:not([hidden])').length, 1)
      assert.deepEqual(scrolled.at(-1), { index: expected, options: { block: 'nearest', inline: 'nearest' } })
    }
    tabs[0].focus()
    key('ArrowLeft', 10)
    assert.equal(f.container.querySelector('[data-updates-context]').dataset.updatesContext, 'present')
    key('ArrowLeft', 9)
    assert.equal(f.container.querySelector('[data-about-context]').dataset.aboutContext, 'present')
    key('ArrowLeft', 8)
    key('ArrowRight', 9)
    key('ArrowRight', 10)
    key('ArrowRight', 0)
    key('ArrowRight', 1)
    key('End', 10)
    key('Home', 0)
    assert.equal(f.mutations.length, 0)
  } finally { f.dispose() }
})

test('About and Updates mount on first visit and keep separate instances while another tab is active', () => {
  const f = mount()
  try {
    assert.equal(f.container.querySelector('[data-about-version]'), null)
    assert.equal(f.container.querySelector('[data-updates-version]'), null)
    f.select('aboutTab')
    const about = f.container.querySelector('[data-about-version]')
    assert.ok(about)
    f.select('planCommentsTab')
    assert.equal(f.container.querySelector('[data-about-version]'), about)
    assert.equal(about.closest('[role="tabpanel"]').hidden, true)
    f.select('aboutTab')
    assert.equal(f.container.querySelector('[data-about-version]'), about)
    assert.equal(about.closest('[role="tabpanel"]').hidden, false)
    f.select('updatesTab')
    const updates = f.container.querySelector('[data-updates-version]')
    assert.ok(updates)
    f.select('qThemeTab')
    assert.equal(f.container.querySelector('[data-updates-version]'), updates)
    assert.equal(updates.closest('[role="tabpanel"]').hidden, true)
    f.select('updatesTab')
    assert.equal(f.container.querySelector('[data-updates-version]'), updates)
    assert.equal(updates.closest('[role="tabpanel"]').hidden, false)
    assert.equal(f.mutations.length, 0)
  } finally { f.dispose() }
})

test('Q Theme defaults off and persists independently from the enhancement tools and their legacy master switch', async () => {
  for (const enabled of [true, false]) {
    const initial = { ...defaults, enabled }
    delete initial.qThemeEnabled
    const f = mount(initial)
    try {
      f.select('qThemeTab')
      assert.equal(f.switch('qTheme').getAttribute('aria-checked'), 'false')
      const preview = f.container.querySelector('[role="img"][aria-label="qThemePreviewDescription"]')
      assert.ok(preview)
      assert.equal(preview.querySelectorAll('input, button, a').length, 0, 'the color preview is decorative, without pretend settings')
      await f.toggle('qTheme')
      assert.deepEqual(f.mutations, [[{ op: 'set', path: ['qThemeEnabled'], value: true }]])
      assert.equal(f.snapshot().value.enabled, enabled, 'enabling appearance never resumes paused tools')
      for (const field of featureFields) assert.equal(f.snapshot().value[field], true)
      assert.equal(f.switch('enabled').getAttribute('aria-checked'), String(enabled))
      await f.toggle('enabled')
      await f.toggle('enabled')
      assert.equal(f.snapshot().value.qThemeEnabled, true, 'the tool master never writes the theme preference')
      for (const operation of f.mutations.slice(1).flat()) assert.notEqual(operation.path[0], 'qThemeEnabled')
      const before = structuredClone(f.snapshot().value)
      await f.toggle('qTheme')
      assert.deepEqual(f.mutations.at(-1), [{ op: 'set', path: ['qThemeEnabled'], value: false }])
      assert.deepEqual(f.snapshot().value, { ...before, qThemeEnabled: false })
    } finally { f.dispose() }
  }
})

test('Q Theme save failures retain the current preference and allow retry without changing tool settings', async () => {
  const f = mount({ ...defaults, enabled: false })
  try {
    f.select('qThemeTab')
    f.failWith(Error('unavailable'))
    await f.toggle('qTheme')
    assert.equal(f.switch('qTheme').getAttribute('aria-checked'), 'false')
    assert.match(f.container.querySelector('[role="alert"]').textContent, /saveError/)
    assert.equal(f.snapshot().value.enabled, false)
    f.failWith(null)
    await f.toggle('qTheme')
    assert.equal(f.switch('qTheme').getAttribute('aria-checked'), 'true')
    assert.equal(f.snapshot().value.enabled, false)
  } finally { f.dispose() }
})

test('scroll containment applies only to our native outlet and keeps header, master and tabs outside the scrolling panel', () => {
  const f = mount()
  const otherDialog = document.createElement('div')
  otherDialog.dataset.shortcutModal = 'settings'
  otherDialog.innerHTML = '<div class="harness-options"><div data-slot="settings.section" style="display: contents"><section>Another settings page</section></div></div>'
  document.body.append(otherDialog)
  try {
    const style = node => dom.window.getComputedStyle(node)
    const section = f.container.querySelector('.qyt-settings')
    const fixed = f.container.querySelector('.qyt-fixed')
    const tabs = f.container.querySelector('[role="tablist"]')
    const panel = f.container.querySelector('[role="tabpanel"]:not([hidden])')
    assert.equal(style(f.options).overflow, 'hidden')
    assert.equal(style(otherDialog.firstElementChild).overflowY, 'auto', 'other native settings retain their original scrolling')
    assert.equal(style(section).overflow, 'hidden')
    assert.equal(style(section).minHeight, '0')
    assert.equal(style(fixed).flexShrink, '0')
    assert.equal(style(tabs).flexShrink, '0')
    assert.equal(style(tabs).display, 'grid', 'feature entries stay in visible rows instead of horizontal scrolling')
    assert.equal(style(tabs).gridTemplateColumns, 'repeat(6, minmax(0, 1fr))', 'the normal settings layout has six equal columns')
    assert.equal(style(tabs.firstElementChild).minWidth, '0', 'long feature labels do not widen their grid column')
    assert.equal(style(panel).overflowY, 'auto')
    assert.equal(style(panel).minHeight, '0')
    assert.ok(fixed.contains(f.container.querySelector('h2')))
    assert.ok(fixed.contains(f.switch('enabled')))
    assert.equal(panel.contains(fixed), false)
    assert.equal(panel.contains(tabs), false)
  } finally { f.dispose(); otherDialog.remove() }
})

test.after(() => dom.window.close())


test('computer control is the first dedicated toolbox tab while long-text remains the default selection', async () => {
  const f = mount({ enabled: false })
  try {
    const tabs = [...f.container.querySelectorAll('[role="tab"]')]
    assert.equal(tabs[0].textContent, 'computerTab')
    assert.ok(tabs[0].querySelector('svg rect'), 'computer uses its monitor glyph')
    assert.equal(f.tab('pastedTextTab').getAttribute('aria-selected'), 'true')
    f.select('computerTab')
    assert.equal(f.switch('启用电脑操控').getAttribute('aria-checked'), 'false')
    await f.toggle('启用电脑操控')
    assert.equal(f.snapshot().value.enabled, true)
    assert.equal(f.snapshot().value.computerUseEnabled, true)
    assert.deepEqual(f.mutations[0], [{ op: 'set', path: ['enabled'], value: true }, { op: 'set', path: ['computerUseEnabled'], value: true }])
  } finally { f.dispose() }
})
