import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { Context } from '@deepseek-ai/cordis'
import { SessionManager } from '../node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/manager.js'

const require = createRequire(import.meta.url)
const bundle = await build({ entryPoints: ['src/features/session-windows/index.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22', packages: 'external', jsx: 'automatic' })
const module = { exports: {} }
vm.runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, queueMicrotask,
  require(id) {
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MenuItemButton: () => null }
    return require(id)
  },
})
const { installWindowNavigation, installEarlySessionWindowNavigation } = module.exports

function source(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: next => { value = next; for (const listener of [...listeners]) listener() },
    refresh: () => { for (const listener of [...listeners]) listener() },
    size: () => listeners.size,
  }
}

function fixture(t, { targetId = 'a', catalogReady = true, initial = 'b', onOpen, onRefresh, generation, bind = true, openState = 'open', targetBlank = false, targetArchived = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><head><title>Harness</title></head><body><div id="root"><div data-slot="main"><div data-slot="main.conversation"><div data-conversation-content data-conversation-session="b" data-content-phase="active">Actual body B</div></div></div><div data-rightbar-col><div data-conversation-content data-conversation-session="a" data-content-phase="active">Embedded body A</div></div></div></body></html>', { url: 'https://navigation.test/' })
  const { window } = dom
  let frameId = 0
  const frames = new Map()
  window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId }
  window.cancelAnimationFrame = id => { frames.delete(id) }
  let timerId = 0
  const timers = new Map()
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId }
  window.clearTimeout = id => { timers.delete(id) }
  const messages = []
  window.webkit = { messageHandlers: { qiuyaSession: { postMessage: message => { messages.push(JSON.parse(JSON.stringify(message))) } } } }
  const sessions = source({ phase: catalogReady ? 'ready' : 'pending', byId: {
    a: { id: 'a', displayTitle: 'Title A', blank: targetBlank, retainedBy: { mainView: initial === 'a' ? 1 : 0 } },
    b: { id: 'b', displayTitle: 'Title B', blank: false, retainedBy: { mainView: initial === 'b' ? 1 : 0 } },
  } })
  const workspaces = source({ phase: catalogReady ? 'ready' : 'pending', archivedSessionIds: targetArchived ? ['a'] : [] })
  const current = source({ key: initial })
  const panel = source({ activePanelId: null })
  const mounted = source(initial)
  const lifecycle = source({ sessionId: 'a', openState, removed: false, blank: targetBlank })
  let refreshCalls = 0
  let bound = bind
  let navigation = new AbortController()
  const previousRestore = navigation.signal
  const opens = []
  let aborts = 0
  let panelSelections = 0
  const content = () => window.document.querySelector('[data-slot="main.conversation"] [data-conversation-content]')
  const render = (id, phase = 'active') => {
    content().setAttribute('data-conversation-session', id)
    content().setAttribute('data-content-phase', phase)
    content().textContent = `Actual body ${id.toUpperCase()}`
  }
  const select = (id, { draw = true } = {}) => {
    const list = sessions.getSnapshot()
    sessions.set({ ...list, byId: Object.fromEntries(Object.entries(list.byId).map(([key, row]) => [key, { ...row, retainedBy: { mainView: key === id ? 1 : 0 } }])) })
    current.set({ key: id })
    panel.set({ activePanelId: null })
    mounted.set(id)
    if (draw) render(id)
  }
  if (initial !== undefined) render(initial)
  const services = {
    sessions: {
      list: sessions, binding: id => id === targetId && bound ? { session: lifecycle } : undefined,
      ...(onRefresh ? { refresh: () => { refreshCalls++; return onRefresh({ sessions, workspaces, attempt: refreshCalls }) } } : {}),
    },
    workspaces: { list: workspaces },
    uiSession: { adapter: { current } },
    layout: {
      panelInfo: panel,
      beginNavigation() { aborts++; navigation.abort(); navigation = new AbortController(); return navigation.signal },
      selectPanel(id) { panelSelections++; panel.set({ activePanelId: id }); mounted.set(id === null ? current.getSnapshot().key : undefined) },
    },
    sidebarRight: { mounted },
    uiWorkspace: { openSession(id) { opens.push(id); if (onOpen) onOpen({ id, select, render, lifecycle, current, mounted, sessions, panel }); else select(id) } },
    locale: { getSnapshot: () => ({ active: 'en' }) },
    connection: { ...(generation ? { generation } : {}) },
  }
  const dispose = installWindowNavigation(services, targetId, window)
  t.after(() => { dispose(); dom.window.close() })
  const tick = async () => { await setImmediate() }
  const paint = async () => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
    await tick()
  }
  const settle = async () => { await tick(); await paint(); await paint(); await tick() }
  return {
    window, services, dispose, messages, opens, sessions, workspaces, current, panel, mounted, lifecycle,
    select, render, content, tick, paint, settle, previousRestore,
    setBound: value => { bound = value; sessions.refresh() },
    refreshCalls: () => refreshCalls,
    retryDelays: () => [...timers.values()].map(timer => timer.delay),
    retry: async () => {
      const entry = timers.entries().next().value
      assert.ok(entry, 'a bounded catalog retry should be scheduled')
      timers.delete(entry[0]); entry[1].callback(); await tick()
    },
    state: () => window.document.body.dataset.qytSessionWindowState,
    reason: () => window.document.querySelector('[data-qyt-session-navigation]')?.dataset.reason,
    ready: () => messages.filter(message => message.type === 'ready'),
    unavailable: () => messages.filter(message => message.type === 'unavailable'),
    rootVisible: () => window.getComputedStyle(window.document.querySelector('#root')).visibility !== 'hidden',
    abortedRestorations: () => aborts,
    panelSelections: () => panelSelections,
    pendingFrames: () => frames.size,
    observerSources: [sessions, workspaces, current, panel, mounted, lifecycle, ...(generation ? [generation] : [])],
  }
}

test('the requested title cannot acknowledge or reveal a different conversation body', async t => {
  const f = fixture(t, { onOpen: ({ select }) => { select('a', { draw: false }) } })
  await f.settle()
  assert.equal(f.current.getSnapshot().key, 'a')
  assert.equal(f.mounted.getSnapshot(), 'a')
  assert.equal(f.content().getAttribute('data-conversation-session'), 'b')
  assert.equal(f.window.document.title, 'Harness', 'metadata must not masquerade as successful navigation')
  assert.deepEqual(f.ready(), [])
  assert.equal(f.rootVisible(), false)
  assert.equal(f.state(), 'loading')
  assert.equal(f.reason(), 'conversation-render-pending')
  assert.equal(f.window.document.querySelector('[data-qyt-session-navigation-message]').textContent, 'Opening the requested session…')
  f.render('a')
  await f.tick()
  await f.paint()
  assert.deepEqual(f.ready(), [], 'the first frame alone is not a stable commit')
  await f.paint()
  assert.deepEqual(f.ready(), [{ type: 'ready', sessionId: 'a', title: 'Title A' }])
  assert.equal(f.rootVisible(), true)
  assert.equal(f.window.document.title, 'Title A — QiuYaTools')
  assert.equal(f.window.getComputedStyle(f.window.document.querySelector('[data-qyt-session-navigation]')).display, 'none')
})

test('opening a fixed target cancels the official pending asynchronous blank restoration', async t => {
  const f = fixture(t)
  assert.equal(f.previousRestore.aborted, true)
  assert.equal(f.abortedRestorations(), 1)
  // This is the same guard used by restoreSelection after await connectWorkspace.
  if (!f.previousRestore.aborted) f.select('b')
  await f.settle()
  assert.deepEqual(f.opens, ['a'])
  assert.equal(f.current.getSnapshot().key, 'a')
  assert.equal(f.content().getAttribute('data-conversation-session'), 'a')
  assert.equal(f.ready().length, 1)
})

test('a late saved-session restoration is corrected through source events without polling or a false success frame', async t => {
  const f = fixture(t)
  await f.settle()
  assert.equal(f.ready().length, 1)
  f.select('b')
  assert.equal(f.rootVisible(), false, 'conceal before the next browser paint when selection drifts')
  await f.settle()
  assert.deepEqual(f.opens, ['a', 'a'])
  assert.equal(f.current.getSnapshot().key, 'a')
  assert.equal(f.content().getAttribute('data-conversation-session'), 'a')
  assert.equal(f.rootVisible(), true)
  assert.equal(f.ready().length, 2, 'native state is refreshed only after the same target has been verified again')
})

test('catalog loading does not navigate, and session loading/hero content never receives a ready acknowledgement', async t => {
  const f = fixture(t, { catalogReady: false, openState: 'loading', onOpen: ({ select, render }) => { select('a'); render('a', 'settling') } })
  await f.settle()
  assert.deepEqual(f.opens, [])
  assert.deepEqual(f.ready(), [])
  assert.deepEqual(f.unavailable(), [])
  f.sessions.set({ ...f.sessions.getSnapshot(), phase: 'ready' })
  f.workspaces.set({ ...f.workspaces.getSnapshot(), phase: 'ready' })
  await f.settle()
  assert.deepEqual(f.opens, ['a'])
  assert.equal(f.state(), 'loading')
  assert.equal(f.rootVisible(), false)
  assert.equal(f.ready().length, 0)
  f.lifecycle.set({ ...f.lifecycle.getSnapshot(), openState: 'open' })
  f.render('a', 'hero')
  await f.settle()
  assert.equal(f.ready().length, 0)
  f.render('a', 'active')
  await f.settle()
  assert.equal(f.ready().length, 1)
})

test('a correctly identified embedded sidebar body does not prove the main conversation target', async t => {
  const f = fixture(t, { onOpen: ({ select }) => { select('a', { draw: false }) } })
  assert.equal(f.window.document.querySelector('[data-rightbar-col] [data-conversation-session]').getAttribute('data-conversation-session'), 'a')
  await f.settle()
  assert.equal(f.ready().length, 0)
  assert.equal(f.rootVisible(), false)
})

test('blank, archived, missing and failed targets stay concealed and expose finite diagnostic reasons', async t => {
  for (const [name, options, reason] of [
    ['blank', { targetBlank: true }, 'session-blank'],
    ['archived', { targetArchived: true }, 'session-archived'],
    ['missing', { targetId: 'missing' }, 'session-missing'],
    ['open-failed', { openState: 'error' }, 'session-open-failed'],
  ]) {
    await t.test(name, async t => {
      const f = fixture(t, options)
      await f.settle()
      assert.equal(f.ready().length, 0)
      assert.equal(f.state(), 'unavailable')
      assert.equal(f.reason(), reason)
      assert.equal(f.rootVisible(), false)
      assert.deepEqual(f.unavailable(), [{ type: 'unavailable', sessionId: options.targetId ?? 'a', reason }])
      f.sessions.refresh(); await f.settle()
      assert.equal(f.unavailable().length, 1)
    })
  }
})

test('a no-op upstream navigation does not enter a retry loop or repeatedly write the saved selection', async t => {
  const f = fixture(t, { onOpen: () => {} })
  await f.settle()
  for (let index = 0; index < 20; index++) { f.sessions.refresh(); f.workspaces.refresh(); await f.tick() }
  assert.deepEqual(f.opens, ['a'])
  assert.equal(f.abortedRestorations(), 1)
  assert.equal(f.pendingFrames(), 0)
  assert.equal(f.ready().length, 0)
  assert.equal(f.rootVisible(), false)
})

test('a different global panel is cleared without needlessly reopening the already retained target', async t => {
  const f = fixture(t, { initial: 'a' })
  // Re-check while a global panel replaces the conversation; the target reference stays valid.
  f.panel.set({ activePanelId: 'plugins' })
  f.mounted.set(undefined)
  await f.settle()
  assert.equal(f.panel.getSnapshot().activePanelId, null)
  assert.equal(f.panelSelections(), 1)
  assert.deepEqual(f.opens, [])
  assert.equal(f.ready().length, 1)
})

test('sidebar binding, retained ownership, lifecycle and real body must all agree before success', async t => {
  const f = fixture(t, { initial: 'a', bind: false })
  await f.settle()
  assert.equal(f.ready().length, 0)
  assert.equal(f.reason(), 'session-loading')
  f.setBound(true)
  f.mounted.set('b')
  await f.settle()
  assert.equal(f.ready().length, 0)
  assert.equal(f.reason(), 'sidebar-binding-pending')
  f.mounted.set('a')
  await f.settle()
  assert.equal(f.ready().length, 1)
})

test('two documents keep their own fixed target without changing shared localStorage or listening for storage events', async t => {
  const a = fixture(t, { targetId: 'a' })
  const b = fixture(t, { targetId: 'b', initial: 'b' })
  b.lifecycle.set({ ...b.lifecycle.getSnapshot(), sessionId: 'b' })
  a.window.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'saved' }))
  b.window.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'saved' }))
  await a.settle(); await b.settle()
  assert.equal(a.ready()[0].sessionId, 'a')
  assert.equal(b.ready()[0].sessionId, 'b')
  a.window.dispatchEvent(new a.window.StorageEvent('storage', { key: 'dsh.sessions.current', newValue: '{"sessionId":"b"}' }))
  await a.settle()
  assert.equal(a.current.getSnapshot().key, 'a')
  assert.equal(b.current.getSnapshot().key, 'b')
  assert.deepEqual(a.opens, ['a'])
  assert.deepEqual(b.opens, [])
  assert.equal(a.window.localStorage.getItem('dsh.sessions.current'), '{"sessionId":"saved"}')
  assert.equal(b.window.localStorage.getItem('dsh.sessions.current'), '{"sessionId":"saved"}')
})

test('a scheduled but not committed success cannot acknowledge after disposal and all navigation observers are released', async t => {
  const f = fixture(t)
  await f.tick(); await f.paint()
  assert.equal(f.ready().length, 0)
  f.dispose(); f.dispose()
  await f.paint()
  for (const observed of f.observerSources) assert.equal(observed.size(), 0)
  f.select('b'); await f.settle()
  assert.equal(f.ready().length, 0)
  assert.deepEqual(f.opens, ['a'])
  assert.equal(f.window.document.querySelector('[data-qyt-session-navigation]'), null)
  assert.equal(f.window.document.querySelector('style[data-qyt-session-window]'), null)
  assert.equal(f.window.document.body.dataset.qytSessionWindow, undefined)
})

test('a mismatch during the two-frame verification cancels the pending acknowledgement', async t => {
  const f = fixture(t, { onOpen: ({ select }) => { select('a') } })
  await f.tick(); await f.paint()
  assert.equal(f.ready().length, 0)
  f.render('b')
  await f.tick(); await f.paint()
  assert.equal(f.ready().length, 0)
  assert.equal(f.rootVisible(), false)
  f.render('a')
  await f.settle()
  assert.equal(f.ready().length, 1)
})

function earlyContext(services) {
  const effects = []
  const dependencies = []
  let activate
  let disposed = false
  return {
    dependencies,
    activate: () => activate(),
    ctx: {
      inject(names, callback) {
        dependencies.push([...names])
        activate = () => callback({ ...services, effect: setup => { const stop = setup(); effects.push(stop); return stop } })
        return { dispose() { if (disposed) return; disposed = true; for (const stop of effects.splice(0).reverse()) stop?.() } }
      },
    },
  }
}

test('early navigation is a no-op without the native Host-authorized sentinel, including a query-only page', t => {
  const noAccess = { inject() { throw new Error('No injection expected') } }
  assert.doesNotThrow(() => installEarlySessionWindowNavigation(noAccess, {} )())
  const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'https://navigation.test/?qiuya-session=a' })
  t.after(() => dom.window.close())
  installEarlySessionWindowNavigation(noAccess, dom.window)()
  assert.equal(dom.window.document.querySelector('[data-qyt-session-window-bootstrap]'), null)
})

test('native bootstrap renders a Harness skeleton and starts target retention before configuration or confirmation services exist', t => {
  const dom = new JSDOM('<html><head></head><body><div id="root">Saved conversation B</div></body></html>', { url: 'https://navigation.test/' })
  const win = dom.window
  win.__QIUYA_SESSION_WINDOW__ = 'a'
  const messages = []
  win.webkit = { messageHandlers: { qiuyaSession: { postMessage: message => { messages.push(message) } } } }
  win.localStorage.setItem('dsh.sessions.current', '{"sessionId":"b"}')
  const list = source({ phase: 'pending', byId: {} })
  const opens = []
  let cancelled = 0
  const early = earlyContext({
    sessions: { list },
    layout: { beginNavigation() { cancelled++; return new AbortController().signal } },
    uiWorkspace: { openSession(id) { opens.push(id); list.refresh() } },
  })
  const dispose = installEarlySessionWindowNavigation(early.ctx, win)
  t.after(() => { dispose(); dom.window.close() })
  assert.deepEqual(early.dependencies, [['sessions', 'uiWorkspace', 'layout']])
  const skeleton = win.document.querySelector('[data-qyt-session-window-bootstrap].qyt-window-loading-card')
  assert.equal(skeleton, null)
  assert.ok(win.document.querySelector('[data-qyt-session-window-bootstrap] .qyt-window-loading-brand'))
  assert.equal(win.document.querySelectorAll('[data-qyt-session-window-bootstrap] .qyt-window-loading-skeleton i').length, 4)
  assert.equal(win.getComputedStyle(win.document.querySelector('#root')).visibility, 'hidden')
  early.activate()
  assert.deepEqual(opens, [])
  list.set({ phase: 'pending', byId: { a: { id: 'a', blank: false } } })
  assert.deepEqual(opens, ['a'])
  assert.equal(cancelled, 1)
  assert.equal(list.size(), 0, 'successful target retention releases its one startup subscription')
  assert.equal(messages.length, 0, 'early retention can never acknowledge success without real UI confirmation')
  assert.equal(win.localStorage.getItem('dsh.sessions.current'), '{"sessionId":"b"}')
  dispose(); dispose()
  assert.equal(win.document.querySelector('[data-qyt-session-window-bootstrap]'), null)
})

test('the full guard takes over the early skeleton without leaving a cover in front of a verified session', async t => {
  const f = fixture(t)
  f.dispose()
  f.window.__QIUYA_SESSION_WINDOW__ = 'a'
  const early = earlyContext(f.services)
  const stopEarly = installEarlySessionWindowNavigation(early.ctx, f.window)
  early.activate()
  const stopGuard = installWindowNavigation(f.services, 'a', f.window)
  t.after(() => { stopGuard(); stopEarly() })
  assert.equal(f.window.document.querySelectorAll('[data-qyt-session-window-bootstrap]').length, 0)
  assert.equal(f.window.document.querySelectorAll('[data-qyt-session-navigation]').length, 1)
  await f.settle()
  assert.equal(f.ready().length, 1)
  assert.equal(f.state(), 'ready')
  stopEarly()
  assert.equal(f.state(), 'ready', 'disposing the early owner must preserve the adopted full guard')
  assert.equal(f.rootVisible(), true)
})

test('early bootstrap resolves declared services provided by real Cordis sibling plugin fibers', async t => {
  const dom = new JSDOM('<html><head></head><body><div id="root"></div></body></html>', { url: 'https://navigation.test/' })
  dom.window.__QIUYA_SESSION_WINDOW__ = 'a'
  const root = new Context()
  const opens = []
  const list = source({ phase: 'ready', byId: { a: { id: 'a', blank: false } } })
  const consumer = root.plugin({ name: 'early-navigation-fixture', apply(scope) { scope.effect(() => installEarlySessionWindowNavigation(scope, dom.window)) } })
  await consumer.await()
  assert.deepEqual(opens, [])
  const sessions = root.plugin({ name: 'sessions-fixture', apply(scope) { scope.provide('sessions', { list }) } })
  const workspace = root.plugin({ name: 'workspace-fixture', apply(scope) { scope.provide('uiWorkspace', { openSession(id) { opens.push(id) } }) } })
  const layout = root.plugin({ name: 'layout-fixture', apply(scope) { scope.provide('layout', { beginNavigation() { return new AbortController().signal } }) } })
  await Promise.all([sessions.await(), workspace.await(), layout.await(), consumer.await()])
  assert.deepEqual(opens, ['a'])
  assert.equal(list.size(), 0)
  await consumer.dispose()
  assert.equal(dom.window.document.querySelector('[data-qyt-session-window-bootstrap]'), null)
  await Promise.all([sessions.dispose(), workspace.dispose(), layout.dispose()])
  dom.window.close()
  t.after(() => { dom.window.close() })
})

test('a resolved refresh that leaves the public catalog pending receives only three bounded retries and then fails visibly', async t => {
  const f = fixture(t, {
    catalogReady: false,
    onRefresh: async () => {},
  })
  assert.equal(f.refreshCalls(), 1, 'the first public refresh joins the initial upstream pull')
  await f.tick()
  for (const [index, delay] of [250, 500, 1000].entries()) {
    assert.deepEqual(f.retryDelays(), [delay])
    for (let count = 0; count < 5; count++) f.sessions.refresh()
    await f.tick()
    assert.equal(f.refreshCalls(), index + 1, 'source events cannot bypass the backoff')
    await f.retry()
  }
  assert.equal(f.refreshCalls(), 4, 'one initial pull plus three retries')
  assert.deepEqual(f.retryDelays(), [])
  assert.equal(f.reason(), 'catalog-refresh-failed')
  assert.equal(f.state(), 'unavailable')
  assert.equal(f.rootVisible(), false)
  assert.deepEqual(f.opens, [])
  assert.deepEqual(f.ready(), [])
  assert.deepEqual(f.unavailable(), [{ type: 'unavailable', sessionId: 'a', reason: 'catalog-refresh-failed' }])
  assert.equal(f.window.document.querySelector('[data-qyt-session-navigation-message]').textContent, 'Could not open this session. Return to the main window or retry.')
  f.sessions.refresh(); await f.tick()
  assert.equal(f.refreshCalls(), 4)
  assert.equal(f.unavailable().length, 1)
})

test('catalog recovery uses public readiness, resets its retry budget, and keeps normal target verification', async t => {
  const f = fixture(t, { catalogReady: false, onRefresh: async ({ sessions, workspaces, attempt }) => {
    if (attempt === 2) {
      sessions.set({ ...sessions.getSnapshot(), phase: 'ready' })
      workspaces.set({ ...workspaces.getSnapshot(), phase: 'ready' })
    }
  } })
  await f.tick()
  assert.deepEqual(f.retryDelays(), [250])
  await f.retry(); await f.settle()
  assert.equal(f.refreshCalls(), 2)
  assert.equal(f.state(), 'ready')
  assert.deepEqual(f.opens, ['a'])
  assert.equal(f.ready().length, 1)
  assert.deepEqual(f.retryDelays(), [])
  f.sessions.set({ ...f.sessions.getSnapshot(), phase: 'pending' })
  await f.tick()
  assert.equal(f.refreshCalls(), 3)
  assert.deepEqual(f.retryDelays(), [250], 'a later catalog baseline gets a fresh bounded budget')
  assert.equal(f.rootVisible(), false)
})

test('an unresolved shared refresh cannot be duplicated by source events', async t => {
  let resolve
  const inflight = new Promise(done => { resolve = done })
  const f = fixture(t, {
    catalogReady: false, onRefresh: () => inflight,
  })
  for (let count = 0; count < 10; count++) { f.sessions.refresh(); f.workspaces.refresh(); await f.tick() }
  assert.equal(f.refreshCalls(), 1)
  assert.deepEqual(f.retryDelays(), [])
  assert.equal(f.state(), 'loading')
  f.dispose()
  resolve(); await f.tick()
  assert.deepEqual(f.retryDelays(), [])
  assert.deepEqual(f.messages, [])
})

test('disposal cancels catalog retry timers, and ready catalogs never trigger speculative refreshes', async t => {
  const pending = fixture(t, { catalogReady: false, onRefresh: async () => {} })
  await pending.tick()
  assert.deepEqual(pending.retryDelays(), [250])
  pending.dispose()
  assert.deepEqual(pending.retryDelays(), [])
  await pending.tick()
  assert.equal(pending.refreshCalls(), 1)
  const ready = fixture(t, { onRefresh: async () => { throw new Error('Unexpected refresh') } })
  await ready.settle()
  assert.equal(ready.refreshCalls(), 0)
  assert.equal(ready.ready().length, 1)
})

test('a rejected refresh keeps the target concealed and recovers through the same bounded backoff', async t => {
  const f = fixture(t, { catalogReady: false, onRefresh: async ({ attempt, sessions, workspaces }) => {
    if (attempt === 1) throw new Error('initial transport failure')
    sessions.set({ ...sessions.getSnapshot(), phase: 'ready' })
    workspaces.set({ ...workspaces.getSnapshot(), phase: 'ready' })
  } })
  await f.tick()
  assert.equal(f.state(), 'loading')
  assert.equal(f.reason(), 'catalog-loading')
  assert.equal(f.rootVisible(), false)
  assert.deepEqual(f.ready(), [])
  assert.deepEqual(f.retryDelays(), [250])
  await f.retry(); await f.settle()
  assert.equal(f.refreshCalls(), 2)
  assert.equal(f.state(), 'ready')
  assert.equal(f.ready().length, 1)
  assert.deepEqual(f.unavailable(), [])
  assert.deepEqual(f.retryDelays(), [])
})

test('the real manager receives only one baseline after the first public connection generation is established', async t => {
  const generation = source(undefined)
  const pulls = []
  const manager = new SessionManager({ session: { list: () => new Promise(resolve => { pulls.push(resolve) }) } })
  // Official Session runtime subscribes before the presentation feature.
  const stopGeneration = generation.subscribe(() => { if (generation.getSnapshot()) manager.handleConnected() })
  const f = fixture(t, { catalogReady: false, generation, onRefresh: () => manager.refreshList() })
  const stopManager = manager.subscribe(() => {
    const phase = manager.getListSnapshot().phase
    f.sessions.set({ ...f.sessions.getSnapshot(), phase })
    if (phase === 'ready') f.workspaces.set({ ...f.workspaces.getSnapshot(), phase: 'ready' })
  })
  t.after(async () => { stopGeneration(); stopManager(); await manager.dispose() })
  await f.tick()
  assert.equal(f.refreshCalls(), 0, 'connected lifecycle alone is not an established event generation')
  assert.equal(pulls.length, 0, 'do not race the official initial handleConnected baseline')
  assert.deepEqual(f.retryDelays(), [])
  generation.set({ id: 1, host: { home: '/fixture' } })
  await f.tick()
  assert.equal(f.refreshCalls(), 1)
  assert.equal(pulls.length, 1, 'the presentation refresh must join the official baseline')
  pulls[0]({ ok: true, value: { items: [] } })
  await f.settle()
  assert.equal(f.ready().length, 1)
  assert.deepEqual(f.retryDelays(), [])
})

test('a generation replacement joins its new baseline without waiting for or charging the superseded pull', async t => {
  const generation = source({ id: 1, host: { home: '/fixture' } })
  const completions = []
  const f = fixture(t, { catalogReady: false, generation, onRefresh: () => new Promise(resolve => { completions.push(resolve) }) })
  assert.equal(f.refreshCalls(), 1)
  generation.set({ id: 2, host: { home: '/fixture' } })
  await f.tick()
  assert.equal(f.refreshCalls(), 2, 'join the new generation even while the previous carrier has not settled')
  completions[0]()
  await f.tick()
  assert.deepEqual(f.retryDelays(), [], 'resolved pending from the old generation is a superseded baseline, not a failure')
  completions[1]()
  await f.tick()
  assert.deepEqual(f.retryDelays(), [250], 'only a current-generation failure starts backoff')
  await f.retry()
  assert.equal(f.refreshCalls(), 3)
})

test('losing a generation cancels its retry timer and a replacement gets a fresh budget', async t => {
  const generation = source({ id: 1, host: { home: '/fixture' } })
  const f = fixture(t, { catalogReady: false, generation, onRefresh: async () => {} })
  await f.tick(); await f.retry()
  assert.deepEqual(f.retryDelays(), [500])
  generation.set(undefined)
  await f.tick()
  assert.deepEqual(f.retryDelays(), [])
  f.sessions.refresh(); await f.tick()
  assert.equal(f.refreshCalls(), 2)
  generation.set({ id: 2, host: { home: '/fixture' } })
  await f.tick()
  assert.equal(f.refreshCalls(), 3)
  assert.deepEqual(f.retryDelays(), [250])
  f.dispose()
  assert.equal(generation.size(), 0)
})

test('a superseded generation completion cannot conceal a replacement that has already verified its real body', async t => {
  const generation = source({ id: 1, host: { home: '/fixture' } })
  let rejectOld
  const old = new Promise((resolve, reject) => { rejectOld = reject })
  const f = fixture(t, { catalogReady: false, generation, onRefresh: async ({ attempt, sessions, workspaces }) => {
    if (attempt === 1) return old
    sessions.set({ ...sessions.getSnapshot(), phase: 'ready' })
    workspaces.set({ ...workspaces.getSnapshot(), phase: 'ready' })
  } })
  generation.set({ id: 2, host: { home: '/fixture' } })
  await f.settle()
  assert.equal(f.ready().length, 1)
  rejectOld(new Error('old generation failed'))
  await f.settle()
  assert.equal(f.state(), 'ready')
  assert.equal(f.rootVisible(), true)
  assert.equal(f.ready().length, 1)
  assert.deepEqual(f.retryDelays(), [])
  assert.deepEqual(f.unavailable(), [])
})
