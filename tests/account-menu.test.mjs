import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { defineStore } from '@deepseek-ai/dsh-client-store'

const compiled = await build({ entryPoints: ['src/client/account-menu.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22' })
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, queueMicrotask })
const { installAccountMenuEntry, settingsSectionOpener, openComputerSettings, consumeComputerSettingsNavigation, subscribeComputerSettingsNavigation } = module.exports

function settingsStore() {
  const handle = defineStore({ init: () => ({ open: false, activeId: undefined }), actions: {
    openSection: (draft, id) => { draft.activeId = id; draft.open = true },
  } })
  const instance = handle.create()
  // This is the exact stable store seat installed by SettingsRoot.
  return { instance, seat: { ...handle, create: () => instance } }
}

function fixture(t, { declared = true, settings = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div data-slot="settings.launcher"><button type="button" data-signed-out="false" aria-haspopup="menu" aria-expanded="false">Account</button></div></body></html>', { url: 'https://harness.test/' })
  const doc = dom.window.document
  const trigger = doc.querySelector('button')
  const copies = {
    zh: { settings: '设置', contactUs: '意见反馈', signOut: '退出登录', signIn: '登录' },
    en: { settings: 'Settings', contactUs: 'Feedback', signOut: 'Sign out', signIn: 'Sign in' },
  }
  let language = 'zh'
  let ownLabel = 'QiuYaTools'
  let activeMenu
  let triggerClicks = 0
  const nativeActions = []
  const store = settingsStore()
  let seats = settings ? [{ store: store.seat }] : []
  const localeListeners = new Set()
  const settingsListeners = new Set()
  const injections = new Set()
  const ctx = {
    slots: {
      entriesOfSlot(key) { assert.equal(key, 'sidebar.settings'); return seats },
      subscribe(key, listener) { assert.equal(key, 'sidebar.settings'); settingsListeners.add(listener); return () => settingsListeners.delete(listener) },
      inject(key, callback) {
        assert.equal(key, 'settings.launcher')
        const entry = { callback, stop: declared ? callback() : undefined }
        injections.add(entry)
        return () => { entry.stop?.(); entry.stop = undefined; injections.delete(entry) }
      },
    },
    locale: {
      bind(namespace) { assert.equal(namespace, 'settings.account'); return key => copies[language][key] },
      subscribe(listener) { localeListeners.add(listener); return () => localeListeners.delete(listener) },
    },
  }
  const tick = async () => { await setImmediate() }
  const addMenu = ({ signedIn = true, nativeAccount = true } = {}) => {
    activeMenu?.remove()
    trigger.dataset.signedOut = String(!signedIn)
    trigger.setAttribute('aria-expanded', 'true')
    const menu = doc.createElement('div')
    menu.setAttribute('role', 'menu')
    const rows = nativeAccount ? ['settings', 'contactUs', signedIn ? 'signOut' : 'signIn'] : ['settings', 'unrelated']
    for (const key of rows) {
      const wrap = doc.createElement('div')
      wrap.className = 'native-item-wrap'
      const button = doc.createElement('button')
      button.type = 'button'; button.setAttribute('role', 'menuitem'); button.className = 'native-item'
      const icon = doc.createElement('span')
      icon.className = 'native-item-icon'; icon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v12H2z"/></svg>'
      const label = doc.createElement('span')
      label.className = 'native-item-label'; label.textContent = copies[language][key] ?? key
      label.dataset.copyKey = key
      button.append(icon, label)
      if (key === 'settings') {
        const shortcut = doc.createElement('span')
        shortcut.setAttribute('aria-hidden', 'true'); shortcut.textContent = '⌘ ,'
        button.append(shortcut); button.setAttribute('aria-keyshortcuts', 'Meta+,')
      }
      button.addEventListener('click', () => nativeActions.push(key))
      wrap.append(button); menu.append(wrap)
    }
    doc.body.append(menu)
    activeMenu = menu
    return menu
  }
  trigger.addEventListener('click', () => {
    triggerClicks++
    trigger.setAttribute('aria-expanded', 'false')
    activeMenu?.remove()
  })
  const dispose = installAccountMenuEntry(ctx, () => ownLabel, dom.window)
  t.after(() => { dispose(); dom.window.close() })
  return {
    doc, trigger, ctx, store, nativeActions, addMenu, tick, dispose,
    entry: () => doc.querySelector('[data-qyt-account-menu-entry]'),
    triggerClicks: () => triggerClicks,
    replaceSettings(next) { seats = next; for (const listener of settingsListeners) listener() },
    locale(next, label = ownLabel) {
      language = next; ownLabel = label
      for (const span of doc.querySelectorAll('[data-copy-key]')) span.textContent = copies[language][span.dataset.copyKey] ?? span.dataset.copyKey
      for (const listener of localeListeners) listener()
    },
    declare() { declared = true; for (const entry of injections) entry.stop ??= entry.callback() },
    collapse() { declared = false; for (const entry of injections) { entry.stop?.(); entry.stop = undefined } },
    listenerCounts: () => [localeListeners.size, settingsListeners.size, injections.size],
  }
}

test('the account row opens exactly the plugin section and closes only its owning account menu', async t => {
  const f = fixture(t)
  const menu = f.addMenu()
  await f.tick()
  const entry = f.entry()
  assert.ok(entry)
  assert.equal(entry.textContent, 'QiuYaTools')
  assert.equal(entry.getAttribute('role'), 'menuitem')
  assert.equal(entry.getAttribute('aria-keyshortcuts'), null)
  assert.equal(entry.className, 'native-item')
  assert.ok(entry.querySelector('[data-qyt-brand-icon]'), 'the account entry uses the selected brand silhouette')
  assert.equal(entry.querySelector('svg'), null, 'the brand glyph replaces the placeholder settings gear')
  assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map(row => row.textContent), ['设置⌘ ,', 'QiuYaTools', '意见反馈', '退出登录'])
  assert.equal(f.store.instance.getSnapshot().open, false)
  entry.click()
  await f.tick()
  assert.equal(f.store.instance.getSnapshot().activeId, 'qiuya-tools')
  assert.equal(f.store.instance.getSnapshot().open, true)
  assert.equal(f.triggerClicks(), 1)
  assert.deepEqual(f.nativeActions, [], 'do not activate Settings, sign-out, feedback, or any underlying action')
  assert.equal(f.entry(), null)
})

test('the signed-out account menu receives the same shortcut and repeated openings never duplicate it', async t => {
  const f = fixture(t)
  f.addMenu({ signedIn: false }); await f.tick()
  assert.ok(f.entry())
  for (let index = 0; index < 4; index++) {
    f.addMenu({ signedIn: false }); await f.tick()
    assert.equal(f.doc.querySelectorAll('[data-qyt-account-menu-entry]').length, 1)
    assert.equal(f.doc.querySelectorAll('[role="menuitem"]').length, 4)
  }
})

test('an unrelated menu cannot gain the account shortcut even while the launcher is expanded', async t => {
  const f = fixture(t)
  f.addMenu({ nativeAccount: false }); await f.tick()
  assert.equal(f.entry(), null)
  f.addMenu(); f.trigger.setAttribute('aria-expanded', 'false'); await f.tick()
  assert.equal(f.entry(), null)
})

test('locale updates preserve one row and use the live account labels to identify later menus', async t => {
  const f = fixture(t)
  f.addMenu(); await f.tick()
  f.locale('en', 'QiuYaTools'); await f.tick()
  assert.equal(f.doc.querySelectorAll('[data-qyt-account-menu-entry]').length, 1)
  f.addMenu(); await f.tick()
  assert.ok(f.entry())
  assert.equal(f.doc.querySelectorAll('[role="menuitem"]')[0].textContent, 'Settings⌘ ,')
})

test('an absent or unrelated settings store disables navigation until the real shell is available', async t => {
  const f = fixture(t, { settings: false })
  f.addMenu(); await f.tick()
  assert.equal(f.entry().disabled, true)
  f.entry().click()
  assert.equal(f.triggerClicks(), 0)
  const unrelated = defineStore({ init: () => ({}), actions: { openSection() { throw new Error('Do not navigate through an unrelated instance') } } })
  f.replaceSettings([{ store: unrelated }]); await f.tick()
  assert.equal(f.entry().disabled, true)
  f.replaceSettings([{ store: f.store.seat }]); await f.tick()
  assert.equal(f.entry().disabled, false)
  f.entry().click()
  assert.equal(f.store.instance.getSnapshot().activeId, 'qiuya-tools')
})

test('the launcher declaration can arrive late, collapse and return without leaked rows or subscriptions', async t => {
  const f = fixture(t, { declared: false })
  f.addMenu(); await f.tick()
  assert.equal(f.entry(), null)
  f.declare(); await f.tick()
  assert.ok(f.entry())
  f.collapse(); await f.tick()
  assert.equal(f.entry(), null)
  assert.deepEqual(f.listenerCounts(), [0, 0, 1])
  f.declare(); await f.tick()
  assert.ok(f.entry())
  f.dispose(); f.dispose()
  assert.equal(f.entry(), null)
  assert.deepEqual(f.listenerCounts(), [0, 0, 0])
})

test('unloading removes only the added row and cancels queued menu work', async t => {
  const f = fixture(t)
  const menu = f.addMenu(); await f.tick()
  const retained = f.entry()
  f.locale('en')
  f.dispose()
  await f.tick()
  assert.equal(f.entry(), null)
  assert.equal(menu.querySelectorAll('[role="menuitem"]').length, 3)
  retained.click()
  assert.equal(f.triggerClicks(), 0)
  assert.equal(f.store.instance.getSnapshot().open, false)
  menu.querySelector('button').click()
  assert.deepEqual(f.nativeActions, ['settings'], 'the built-in menu still owns its original actions')
})

test('a browser-less client harness needs neither a document nor a slot declaration', () => {
  assert.doesNotThrow(() => installAccountMenuEntry({}, () => 'QiuYaTools', {})())
  assert.equal(settingsSectionOpener({ entriesOfSlot: () => [] }), undefined)
})


test('chat computer settings navigation opens only the public plugin section and consumes its tab request exactly once', t => {
  const f = fixture(t); let notifications = 0
  const dispose = subscribeComputerSettingsNavigation(f.ctx, () => { notifications++ })
  assert.equal(consumeComputerSettingsNavigation(f.ctx), false)
  assert.equal(openComputerSettings(f.ctx), true)
  assert.equal(f.store.instance.getSnapshot().activeId, 'qiuya-tools')
  assert.equal(f.store.instance.getSnapshot().open, true)
  assert.equal(notifications, 1)
  assert.equal(consumeComputerSettingsNavigation(f.ctx), true)
  assert.equal(consumeComputerSettingsNavigation(f.ctx), false)
  assert.deepEqual(f.nativeActions, [])
  dispose(); assert.equal(openComputerSettings(f.ctx), true); assert.equal(notifications, 1)
  assert.equal(consumeComputerSettingsNavigation(f.ctx), true)
})

test('unavailable settings bridge neither opens another store nor leaves a queued computer-tab request', t => {
  const f = fixture(t, { settings: false })
  assert.equal(openComputerSettings(f.ctx), false)
  assert.equal(consumeComputerSettingsNavigation(f.ctx), false)
  assert.equal(f.store.instance.getSnapshot().open, false)
  assert.equal(openComputerSettings({}), false)
})
