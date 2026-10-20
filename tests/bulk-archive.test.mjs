import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const bundle = await build({
  stdin: {
    contents: "export * from './src/features/bulk-archive/dom.ts'; export * from './src/features/bulk-archive/model.ts'; export * from './src/features/bulk-archive/locales.ts'; export * from './src/features/bulk-archive/index.ts'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22',
})
const module = { exports: {} }
const runtime = { module, exports: module.exports, queueMicrotask }
vm.runInNewContext(bundle.outputFiles[0].text, runtime)
const { sidebarArchiveTargets, SidebarSelection, installSidebarBulkArchive, installBulkArchive, bulkArchiveZh } = module.exports
const flush = async () => { await setImmediate() }
const ids = members => Array.from(members, member => member.id)

function catalog() {
  return {
    sessions: ['a', 'b', 'c', 'hidden', 'archived', 'blank', 'agent', 'ungrouped'].map(id => ({
      id, title: 'Same title', blank: id === 'blank', ...(id === 'agent' ? { origin: 'subagent' } : {}),
    })),
    workspaces: [
      { workspaceId: 'one', sessionIds: ['a', 'b', 'hidden', 'archived', 'blank', 'agent', 'a'] },
      { workspaceId: 'two', sessionIds: ['c'] },
    ],
    archivedSessionIds: ['archived'],
  }
}

function fixture(t, archiveImplementation) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  const { document: doc } = dom.window
  doc.body.innerHTML = `<div data-slot="sidebar"><div data-slot="sidebar.workspaces">
    <div data-row-key="workspace:one" role="treeitem"><span>Same workspace title</span><button>Actions</button><button>New</button></div>
    <div data-row-key="session:a" role="treeitem"><span>Same title</span><button>Actions</button></div>
    <div data-row-key="session:b" role="treeitem"><span>Same title</span><button>Actions</button></div>
    <div data-row-key="workspace:two" role="treeitem"><span>Same workspace title</span><button>Actions</button><button>New</button></div>
    <div data-row-key="session:c" role="treeitem"><span>Same title</span><button>Actions</button></div>
    <div data-row-key="session:blank" role="treeitem">New session</div>
    <div data-row-key="session:archived" role="treeitem">Archived</div>
  </div></div><div data-row-key="session:ungrouped">Outside sidebar</div><input />`
  let targets = sidebarArchiveTargets(catalog())
  let refresh
  let unsubscribeCount = 0
  const calls = []
  let nativeOpens = 0
  for (const row of doc.querySelectorAll('[data-row-key]')) {
    const trigger = row.querySelector('button')
    trigger?.addEventListener('click', event => {
      event.stopPropagation()
      const previous = doc.querySelector('[data-native-menu]')
      if (previous) { previous.remove(); return }
      nativeOpens++
      const panel = doc.createElement('div')
      panel.setAttribute('role', 'menu')
      panel.dataset.nativeMenu = row.dataset.rowKey
      for (const label of ['Rename', 'Delete']) {
        const button = doc.createElement('button')
        button.type = 'button'
        button.className = 'native-menu-row'
        button.setAttribute('role', 'menuitem')
        button.textContent = label
        panel.append(button)
      }
      doc.body.append(panel)
    })
  }
  const dispose = installSidebarBulkArchive({
    targets: () => targets,
    archive: async id => { calls.push(id); await archiveImplementation?.(id) },
    subscribe: listener => { refresh = listener; return () => { unsubscribeCount++ } },
    t: (key, params) => bulkArchiveZh[key].replace(/\{(\w+)\}/g, (_, key) => String(params?.[key])),
  }, doc)
  t.after(() => { dispose(); dom.window.close() })
  const row = id => doc.querySelector(`[data-row-key="session:${id}"]`)
  const mouse = (element, name, options = {}) => element.dispatchEvent(new dom.window.MouseEvent(name, { bubbles: true, cancelable: true, ...options }))
  const choose = id => mouse(row(id), 'click', { ctrlKey: true })
  const range = id => mouse(row(id), 'click', { shiftKey: true })
  const menu = id => mouse(row(id), 'contextmenu')
  const marked = () => Array.from(doc.querySelectorAll('[data-qyt-bulk-selected]'), element => element.dataset.rowKey)
  return {
    dom, doc, dispose, calls, row, mouse, choose, range, menu, marked,
    nativeOpens: () => nativeOpens,
    run: () => doc.querySelector('.qyt-bulk-archive-menu [role="menuitem"]:not(:disabled)').click(),
    refresh: () => refresh(),
    unsubscribeCount: () => unsubscribeCount,
    replaceTargets: value => { targets = value; refresh() },
    workspace: async id => {
      doc.querySelector(`[data-row-key="workspace:${id}"] button`).click()
      await flush()
      return doc.querySelector('[data-qyt-workspace-archive] button')
    },
  }
}

test('archive targets use host ids, deduplicate members, exclude archived/blank/subagents, and separate ungrouped', () => {
  const targets = sidebarArchiveTargets(catalog())
  assert.deepEqual(ids(targets.get('workspace:one')), ['a', 'b', 'hidden'])
  assert.deepEqual(ids(targets.get('workspace:two')), ['c'])
  assert.deepEqual(ids(targets.get('workspace:')), ['ungrouped'])
  assert.deepEqual(ids(targets.get('session:a')), ['a'])
  for (const id of ['blank', 'archived', 'agent']) assert.equal(targets.has(`session:${id}`), false)
})

test('Shift range crosses workspace boundaries, reverses, extends, and shrinks from the original anchor', t => {
  const f = fixture(t)
  f.row('a').click(); f.range('c')
  assert.deepEqual(f.marked(), ['session:a', 'session:b', 'session:c'])
  f.range('b')
  assert.deepEqual(f.marked(), ['session:a', 'session:b'])
  f.row('c').click(); f.range('a')
  assert.deepEqual(f.marked(), ['session:a', 'session:b', 'session:c'])
  assert.deepEqual(f.calls, [])
})

test('Command/Ctrl toggles identities and Shift uses the latest individual-selection anchor', t => {
  const f = fixture(t)
  f.mouse(f.row('a'), 'click', { metaKey: true }); f.choose('c')
  assert.deepEqual(f.marked(), ['session:a', 'session:c'])
  f.choose('c')
  assert.deepEqual(f.marked(), ['session:a'])
  f.range('b')
  assert.deepEqual(f.marked(), ['session:b', 'session:c'])
})

test('missing/removed range anchors select only the clicked row', t => {
  const f = fixture(t)
  f.range('c')
  assert.deepEqual(f.marked(), ['session:c'])
  f.row('c').remove(); f.range('a')
  assert.deepEqual(f.marked(), ['session:a'])
})

test('only sidebar session rows participate; original clicks, buttons, blank rows and archived rows keep their behavior', t => {
  const f = fixture(t)
  let opened = 0
  f.row('a').addEventListener('click', () => { opened++ })
  f.choose('a'); f.choose('b')
  assert.equal(opened, 0)
  f.row('a').click()
  assert.equal(opened, 1)
  assert.deepEqual(f.marked(), [])
  f.choose('blank'); f.choose('archived')
  assert.deepEqual(f.marked(), [])
  f.choose('a')
  f.doc.querySelector('[data-row-key="session:ungrouped"]').dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }))
  assert.deepEqual(f.marked(), [])
  f.row('a').querySelector('button').click()
  assert.equal(f.nativeOpens(), 1)
  assert.equal(f.doc.querySelector('[data-qyt-workspace-archive]'), null)
})

test('single-session and unselected-session right clicks open the original menu without opening the session', t => {
  const f = fixture(t)
  let opened = 0
  f.row('a').addEventListener('click', () => { opened++ })
  f.menu('a')
  assert.equal(f.nativeOpens(), 1)
  assert.equal(opened, 0)
  f.doc.querySelector('[data-native-menu]').remove()
  f.choose('b'); f.choose('c'); f.menu('a')
  assert.deepEqual(f.marked(), [])
  assert.equal(f.nativeOpens(), 2)
  assert.equal(opened, 0)
})

test('the multi-selection menu disables single-session actions and archives exact selected ids, including duplicate titles', async t => {
  const f = fixture(t)
  f.choose('a'); f.choose('c'); f.menu('c')
  const items = f.doc.querySelectorAll('.qyt-bulk-archive-menu [role="menuitem"]')
  assert.equal(items.length, 5)
  assert.deepEqual(Array.from(items, item => item.disabled), [true, true, true, false, false])
  f.run(); await flush()
  assert.deepEqual(f.calls, ['a', 'c'])
  assert.deepEqual(f.marked(), [])
  assert.equal(f.doc.querySelector('.qyt-bulk-archive'), null, 'successful archives must not create a result toast')
  assert.equal(f.doc.querySelector('[role="status"]'), null)
})

test('selection creates no floating action bar and right-click exposes archive and cancel', t => {
  const f = fixture(t)
  f.choose('a'); f.choose('b')
  assert.deepEqual(f.marked(), ['session:a', 'session:b'])
  assert.equal(f.doc.querySelector('.qyt-bulk-archive'), null, 'selection must not create a floating control or status panel')
  assert.doesNotMatch(f.doc.body.textContent, /已选择|批量归档|取消选择/)
  f.menu('b')
  const buttons = f.doc.querySelectorAll('.qyt-bulk-archive-menu button:not(:disabled)')
  assert.equal(buttons.length, 2)
  assert.match(buttons[0].textContent, /批量归档.*2/)
  assert.equal(buttons[1].textContent, '取消选择')
  buttons[1].click()
  assert.deepEqual(f.marked(), [])
  assert.equal(f.doc.querySelector('.qyt-bulk-archive'), null)
  f.choose('a'); f.choose('b'); f.menu('b')
  f.doc.activeElement.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape', cancelable: true }))
  assert.deepEqual(f.marked(), [], 'Escape also cancels selection while a menu action has focus')
  assert.equal(f.doc.querySelector('.qyt-bulk-archive'), null)
})

test('a single selected row keeps native actions and adds cancellation in its right-click menu', async t => {
  const f = fixture(t)
  f.choose('a'); f.menu('a'); await flush()
  const panel = f.doc.querySelector('[data-native-menu]')
  assert.ok(panel)
  assert.deepEqual(Array.from(panel.querySelectorAll('[role="menuitem"]'), button => button.textContent), ['Rename', 'Delete', '取消选择'])
  panel.querySelector('[data-qyt-selection-clear] button').click()
  assert.deepEqual(f.marked(), [])
  assert.equal(f.doc.querySelector('[data-native-menu]'), null)
  assert.equal(f.doc.querySelector('.qyt-bulk-archive'), null)
  f.choose('b'); f.menu('b'); await flush()
  f.doc.querySelector('[data-native-menu] button').dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }))
  assert.deepEqual(f.marked(), [])
  assert.equal(f.doc.querySelector('[data-native-menu]'), null)
})

test('workspace action augments only its native menu and includes hidden members without crossing workspace boundaries', async t => {
  const f = fixture(t)
  const button = await f.workspace('one')
  assert.ok(button)
  assert.equal(button.className, 'native-menu-row')
  assert.equal(button.textContent, '工作区归档')
  assert.equal(f.doc.querySelectorAll('[data-native-menu] [role="menuitem"]').length, 3)
  button.click(); await flush()
  assert.deepEqual(f.calls, ['a', 'b', 'hidden'])
  assert.equal(f.doc.querySelector('[data-native-menu]'), null)
  assert.equal(f.doc.querySelector('.qyt-bulk-archive'), null, 'workspace archives must not create a result toast')
  assert.equal(f.doc.querySelector('[role="status"]'), null)
})

test('workspace archive skips members moved to another workspace while a queue is running', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture(t, id => id === 'a' ? gate : undefined)
  const button = await f.workspace('one')
  button.click(); await flush()
  assert.deepEqual(f.calls, ['a'])
  const next = catalog()
  next.workspaces[0].sessionIds = ['a', 'hidden']
  next.workspaces[1].sessionIds.push('b')
  f.replaceTargets(sidebarArchiveTargets(next))
  release(); await flush()
  assert.deepEqual(f.calls, ['a', 'hidden'])
  assert.equal(f.doc.querySelector('.qyt-bulk-archive'), null)
  f.menu('b'); await flush()
  const details = f.doc.querySelector('[data-qyt-archive-failures]')
  assert.match(details.textContent, /2 条，1 条未归档/)
  assert.match(details.textContent, /已移出此工作区/)
})

test('partial failures preserve failed ids and reasons for retry, while other sessions continue', async t => {
  let fail = true
  const f = fixture(t, id => { if (['b', 'c'].includes(id) && fail) throw new Error('running session refused') })
  f.choose('a'); f.choose('b'); f.choose('c'); f.menu('b'); f.run(); await flush()
  assert.deepEqual(f.calls, ['a', 'b', 'c'])
  assert.deepEqual(f.marked(), ['session:b', 'session:c'])
  assert.equal(f.doc.querySelector('.qyt-bulk-archive'), null, 'failures must not create a toast')
  f.menu('b')
  const details = f.doc.querySelector('[data-qyt-archive-failures]')
  assert.match(details.textContent, /1 条，2 条未归档/)
  assert.match(details.textContent, /running session refused/)
  fail = false
  f.run(); await flush()
  assert.deepEqual(f.calls, ['a', 'b', 'c', 'b', 'c'])
  assert.deepEqual(f.marked(), [])
})

test('an in-flight batch rejects duplicate submission and disabling stops subsequent queued archives', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture(t, () => gate)
  f.choose('a'); f.choose('b'); f.menu('b')
  const action = f.doc.querySelector('.qyt-bulk-archive-menu [role="menuitem"]:not(:disabled)')
  action.click()
  assert.deepEqual(f.calls, ['a'])
  action.click()
  assert.deepEqual(f.calls, ['a'])
  f.dispose(); release(); await flush()
  assert.deepEqual(f.calls, ['a'])
  assert.equal(f.doc.querySelector('.qyt-bulk-archive'), null)
  assert.equal(f.unsubscribeCount(), 1)
})

test('selection, in-flight progress, and completed archives never create floating status or action bars', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture(t, () => gate)
  f.choose('a'); f.choose('b')
  assert.equal(f.doc.querySelector('.qyt-bulk-archive'), null)
  f.menu('b'); f.run()
  assert.deepEqual(f.calls, ['a'])
  assert.equal(f.doc.querySelector('.qyt-bulk-archive'), null, 'progress must stay out of floating UI')
  assert.equal(f.doc.querySelector('[role="status"]'), null)
  release(); await flush()
  assert.deepEqual(f.calls, ['a', 'b'])
  assert.deepEqual(f.marked(), [])
  assert.equal(f.doc.querySelector('.qyt-bulk-archive'), null, 'completion must stay out of floating UI')
  assert.equal(f.doc.querySelector('[role="status"]'), null)
  assert.doesNotMatch(f.doc.body.textContent, /已选择|正在归档|已归档|关闭/)
})

test('catalog changes prune stale identities and dismiss a menu with stale targets', t => {
  const f = fixture(t)
  f.choose('a'); f.choose('b'); f.menu('b')
  const next = catalog()
  next.archivedSessionIds.push('a')
  f.replaceTargets(sidebarArchiveTargets(next))
  assert.deepEqual(f.marked(), ['session:b'])
  assert.equal(f.doc.querySelector('.qyt-bulk-archive-menu'), null)
})

test('new row DOM regains selection and unloading removes marks, styles, menus, subscriptions and interception', async t => {
  const f = fixture(t)
  f.choose('a'); f.choose('b')
  const replacement = f.row('a').cloneNode(true)
  replacement.removeAttribute('data-qyt-bulk-selected')
  f.row('a').replaceWith(replacement)
  await flush()
  assert.equal(replacement.getAttribute('data-qyt-bulk-selected'), 'true')
  const workspaceItem = await f.workspace('two')
  assert.ok(workspaceItem)
  f.dispose(); f.dispose()
  assert.equal(f.doc.querySelector('[data-qyt-workspace-archive]'), null)
  assert.equal(f.doc.querySelector('style[data-qyt-feature="bulk-archive"]'), null)
  assert.deepEqual(f.marked(), [])
  let clicks = 0
  replacement.addEventListener('click', () => { clicks++ })
  f.choose('a')
  assert.equal(clicks, 1)
  assert.equal(f.unsubscribeCount(), 1)
})

test('selection blocks native dragging and modifier double-click rename; Escape clears without editing an input', t => {
  const f = fixture(t)
  f.choose('a')
  const drag = new f.dom.window.Event('dragstart', { bubbles: true, cancelable: true })
  f.row('b').dispatchEvent(drag)
  assert.equal(drag.defaultPrevented, true)
  assert.equal(f.mouse(f.row('a'), 'dblclick', { shiftKey: true }), false)
  f.doc.querySelector('input').dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
  assert.deepEqual(f.marked(), ['session:a'])
  f.doc.body.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
  assert.deepEqual(f.marked(), [])
})

test('public installer reads the official catalog face and writes only through uiWorkspace.archiveSession', async t => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div data-slot="sidebar"><div data-slot="sidebar.workspaces"><div data-row-key="session:a">A</div><div data-row-key="session:b">B</div></div></div></body></html>')
  runtime.document = dom.window.document
  let subscribed = 0
  let released = 0
  let registered
  const calls = []
  const subscribe = () => { subscribed++; return () => { released++ } }
  const base = catalog()
  const ctx = {
    sessions: { list: { subscribe, getSnapshot: () => ({ ids: base.sessions.map(item => item.id), byId: Object.fromEntries(base.sessions.map(item => [item.id, { ...item, displayTitle: item.title }])) }) } },
    workspaces: { list: { subscribe, getSnapshot: () => ({ items: base.workspaces, archivedSessionIds: base.archivedSessionIds }) } },
    uiWorkspace: { archiveSession: async (...args) => { calls.push(args) } },
    locale: {
      subscribe,
      register: (namespace, dicts) => { registered = { namespace, dicts }; return () => { released++ } },
      bind: () => (key, params) => bulkArchiveZh[key].replace(/\{(\w+)\}/g, (_, key) => String(params?.[key])),
    },
  }
  const dispose = installBulkArchive(ctx)
  t.after(() => { dispose(); dom.window.close(); delete runtime.document })
  assert.equal(registered.namespace, 'qiuyaTools.bulkArchive')
  assert.deepEqual(Object.keys(registered.dicts.zh), Object.keys(registered.dicts.en))
  assert.equal(subscribed, 3)
  for (const id of ['a', 'b']) dom.window.document.querySelector(`[data-row-key="session:${id}"]`).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }))
  dom.window.document.querySelector('[data-row-key="session:b"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  dom.window.document.querySelector('.qyt-bulk-archive-menu [role="menuitem"]:not(:disabled)').click()
  await flush()
  assert.deepEqual(calls, [['a'], ['b']], 'archive must have no stopActivity option or direct remote mutation')
  dispose(); dispose()
  assert.equal(released, 4)
})

test('selection reconciliation updates titles by id without inventing membership', () => {
  const selection = new SidebarSelection()
  selection.toggle({ id: 'a', title: 'Old' })
  selection.toggle({ id: 'stale', title: 'Removed' })
  selection.reconcile(new Map([['session:a', [{ id: 'a', title: 'New' }]]]))
  assert.deepEqual(ids(selection.selected.values()), ['a'])
  assert.equal(selection.selected.get('a').title, 'New')
})
