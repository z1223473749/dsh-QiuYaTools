import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: ['src/features/sidebar-tools/index.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external' })
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, {
  module, exports: module.exports, AbortController, URL, queueMicrotask,
  require(name) { return name === '@deepseek-ai/dsh-client-ui-primitives' ? { MenuItemButton: () => null } : require(name) },
})
const { createSidebarToolsActions, installSidebarTools } = module.exports
const modelBuild = await build({ entryPoints: ['src/features/sidebar-tools/model.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' })
const modelModule = { exports: {} }
vm.runInNewContext(modelBuild.outputFiles[0].text, { module: modelModule, exports: modelModule.exports, URL })
const { SidebarUnreadStore, SIDEBAR_UNREAD_KEY, parseUnread, copySidebarText } = modelModule.exports
const menuBuild = await build({ entryPoints: ['src/features/sidebar-tools/workspace-menu.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' })
const menuModule = { exports: {} }
vm.runInNewContext(menuBuild.outputFiles[0].text, { module: menuModule, exports: menuModule.exports, queueMicrotask })
const { installWorkspaceMenuTools } = menuModule.exports
const nativeMenuBuild = await build({ entryPoints: ['src/features/sidebar-tools/native-menu.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' })
const nativeMenuModule = { exports: {} }
vm.runInNewContext(nativeMenuBuild.outputFiles[0].text, { module: nativeMenuModule, exports: nativeMenuModule.exports, queueMicrotask })
const { installNativeSidebarContextMenu, nativeSidebarMenuTrigger } = nativeMenuModule.exports

/** Test the owning published Menu implementation, without loading unrelated markdown/highlighter exports. */
const primitiveSource = await readFile('node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js', 'utf8')
function publishedDeclarations(text, names) {
  const parsed = ts.createSourceFile('published.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const declarations = new Map()
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) { if (statement.name) declarations.set(statement.name.text, statement) }
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement)
  }
  const included = new Set()
  const visit = name => {
    const statement = declarations.get(name)
    if (!statement || included.has(statement)) return
    included.add(statement)
    const dependencies = node => { if (ts.isIdentifier(node)) visit(node.text); ts.forEachChild(node, dependencies) }
    ts.forEachChild(statement, dependencies)
  }
  names.forEach(visit)
  const imports = parsed.statements.filter(ts.isImportDeclaration).map(statement => {
    const path = statement.moduleSpecifier.text
    if (path === 'react' || path === 'react-dom' || path === 'react/jsx-runtime') return statement.getText(parsed)
    if (path.endsWith('.css') && statement.importClause?.name) return `const ${statement.importClause.name.text} = new Proxy({}, { get: (_target, key) => String(key) });`
    return ''
  }).join('\n')
  return `${imports}\nconst clsx = (...args) => args.filter(Boolean).join(' ');\n${parsed.statements.filter(statement => included.has(statement)).map(statement => statement.getText(parsed)).join('\n')}\nexport { ${names.join(',')} };`
}
const realMenuBuild = await build({ stdin: { contents: publishedDeclarations(primitiveSource, ['Menu', 'MenuItemButton']), resolveDir: process.cwd() }, bundle: true, packages: 'external', write: false, format: 'cjs', platform: 'node' })

function owningSessionProjection(items) {
  return readFile('node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js', 'utf8').then(text => {
    const parsed = ts.createSourceFile('published-client.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    let method, displayTitle
    const find = node => {
      if (ts.isMethodDeclaration(node) && node.name.getText(parsed) === 'projectList') method = node.getText(parsed)
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'displayTitleOf') displayTitle = node.getText(parsed)
      ts.forEachChild(node, find)
    }
    find(parsed)
    assert.ok(method); assert.ok(displayTitle)
    const project = vm.runInNewContext(`${displayTitle}\n({${method}}).projectList`, { workspaceTitleOf: path => path.split('/').filter(Boolean).at(-1) ?? '' })
    let snapshot
    project.call({ list: { getSnapshot: () => ({ byId: {} }), set(value) { snapshot = value } }, manager: { getListSnapshot: () => ({ items, phase: 'ready', projectionsBySession: {} }) }, scopes: new Map(), retentionSnapshot: () => ({ retainedBy: {} }) })
    return snapshot
  })
}

function source(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    update(next) { snapshot = next; for (const listener of listeners) listener() },
    listeners,
  }
}
function memoryStorage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}
function fixture(t, href = 'https://harness.test/?token=fixture-private#private-fragment') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: href, pretendToBeVisual: true })
  t.after(() => dom.window.close())
  const sessions = source({ phase: 'ready', ids: ['one', 'two', 'blank'], byId: {
    one: { id: 'one', displayTitle: '第一条会话', cwd: '/fixture/one', blank: false },
    two: { id: 'two', displayTitle: '第二条会话', blank: false },
    blank: { id: 'blank', displayTitle: '新会话', blank: true },
    fallback: { id: 'fallback', displayTitle: 'retained only', cwd: '/must/not/open' },
  } })
  const workspaces = source({ phase: 'ready', items: [
    { workspaceId: 'work-one', path: '/fixture/one', title: '重名工作区' },
    { workspaceId: 'work-two', path: '/fixture/two', title: '重名工作区' },
  ], archivedSessionIds: [] })
  const current = source({ key: 'one' })
  const opened = [], paths = [], moves = [], copies = [], requests = []
  const directory = { apps: ['finder'], async launch() { return new Response('{}', { status: 200 }) } }
  dom.window.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    if (url === 'open-in-app/apps') return Response.json({ apps: directory.apps })
    assert.equal(url, 'open-in-app/open')
    const request = JSON.parse(init.body)
    paths.push({ request, signal: init.signal })
    return directory.launch(request)
  }
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { async writeText(text) { copies.push(text) } } })
  const services = {
    sessions: { list: sessions },
    workspaces: { list: workspaces, async insertBefore(...args) { moves.push(args) } },
    uiSession: { adapter: { current } },
    uiWorkspace: { openSession(id) { opened.push(id) } },
    remote: { session: { async openWorkspacePath() { throw new Error('Session file-preview RPC must not open workspace directories') } } },
  }
  let storage
  try { storage = dom.window.localStorage } catch { storage = memoryStorage() }
  const unread = new SidebarUnreadStore(storage)
  const actions = createSidebarToolsActions(services, dom.window, unread)
  t.after(() => { actions.dispose(); unread.dispose() })
  return { dom, services, sessions, workspaces, current, actions, unread, opened, paths, moves, copies, directory, requests }
}

test('manual unread markers validate, persist, synchronize, and clear only on a later revisit', () => {
  const storage = memoryStorage()
  const unread = new SidebarUnreadStore(storage)
  const original = unread.getSnapshot()
  let updates = 0
  const off = unread.subscribe(() => updates++)
  unread.select('one')
  unread.set('one', true)
  assert.notEqual(unread.getSnapshot(), original)
  assert.equal(unread.getSnapshot().has('one'), true)
  unread.select('one')
  assert.equal(unread.getSnapshot().has('one'), true, 'marking the active session is not immediately cleared')
  unread.select('two'); unread.select('one')
  assert.equal(unread.getSnapshot().has('one'), false)
  unread.set('two', true)
  assert.equal(new SidebarUnreadStore(storage).getSnapshot().has('two'), true)
  unread.acceptStorage('["other-window","bad id",null]')
  assert.deepEqual([...unread.getSnapshot()], ['other-window'])
  const before = updates
  off(); unread.dispose(); unread.set('three', true); unread.acceptStorage('[]')
  assert.equal(updates, before)
  assert.equal(unread.getSnapshot().has('other-window'), true)
})

test('unread storage failures and corrupt data do not break menu actions', () => {
  assert.equal(parseUnread('invalid json').size, 0)
  assert.equal(parseUnread('{"ids":["one"]}').size, 0)
  assert.deepEqual([...parseUnread('["one","one","bad id",12,"two"]')], ['one', 'two'])
  const unread = new SidebarUnreadStore({ getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } })
  unread.set('one', true)
  unread.set('two', true)
  assert.deepEqual([...unread.getSnapshot()], ['one', 'two'])
  unread.dispose()
})

test('session actions use current catalog ids and Host paths without retaining or inventing sessions', async t => {
  const f = fixture(t)
  await f.actions.perform('title', 'one')
  await f.actions.perform('copy-directory', 'one')
  await f.actions.perform('open-directory', 'one')
  assert.deepEqual(f.copies.slice(0, 2), ['第一条会话', '/fixture/one'])
  assert.equal(f.copies.length, 2)
  assert.deepEqual(f.paths[0].request, { app: 'finder', path: '/fixture/one' })
  assert.equal(f.paths[0].signal.aborted, false)
  for (const id of ['missing', 'blank', 'fallback', 'bad id']) {
    assert.equal(f.actions.available(id), false)
    await assert.rejects(() => f.actions.perform('open-directory', id))
  }
  await assert.rejects(() => f.actions.perform('open-directory', 'two'), /目录/)
  f.sessions.update({ ...f.sessions.getSnapshot(), phase: 'pending' })
  await assert.rejects(() => f.actions.perform('title', 'one'))
  assert.equal(f.paths.length, 1)
})

test('workspace actions preserve exact identity, use native durable ordering, and abort on teardown', async t => {
  const f = fixture(t)
  await f.actions.copyPath('work-two')
  await f.actions.openDirectory('work-two')
  await f.actions.moveToTop('work-two')
  await f.actions.moveToTop('work-one')
  assert.deepEqual(f.copies, ['/fixture/two'])
  assert.deepEqual(f.paths[0].request, { app: 'finder', path: '/fixture/two' })
  assert.deepEqual(f.moves, [['work-two', 'work-one']])
  f.workspaces.update({ ...f.workspaces.getSnapshot(), items: [] })
  await assert.rejects(() => f.actions.openDirectory('work-two'))
  f.actions.dispose()
  assert.equal(f.paths[0].signal.aborted, true)
  await assert.rejects(() => f.actions.perform('title', 'one'))
  assert.equal(f.paths.length, 1)
})

test('native directory launcher refusals are useful finite failures, never raw Host output', async t => {
  const f = fixture(t)
  f.directory.launch = async () => new Response('private host failure', { status: 502 })
  await assert.rejects(() => f.actions.openDirectory('work-one'), error => /文件管理器启动失败/.test(error.message) && !error.message.includes('private'))
})

test('directory menus follow the native Finder HTTP carrier in dsh-app and never call the file-preview Session RPC', async t => {
  const f = fixture(t, 'dsh-app://app/?auth=private')
  f.directory.apps = ['vscode', 'finder', 'terminal']
  await f.actions.perform('open-directory', 'one')
  await f.actions.openDirectory('work-two')
  assert.deepEqual(f.requests.map(request => request.url), ['open-in-app/apps', 'open-in-app/open', 'open-in-app/open'])
  assert.equal(f.requests[0].init.headers.accept, 'application/json')
  for (const request of f.requests) assert.equal(request.init.credentials, 'same-origin')
  for (const request of f.requests.slice(1)) {
    assert.equal(request.init.method, 'POST')
    assert.equal(request.init.headers['content-type'], 'application/json')
    assert.equal(request.init.body.includes('auth'), false)
    assert.equal(request.init.signal.aborted, false)
  }
  assert.deepEqual(f.paths.map(item => item.request), [{ app: 'finder', path: '/fixture/one' }, { app: 'finder', path: '/fixture/two' }])
})

test('directory menu reports missing managers, expired connections and missing paths without launching an editor', async t => {
  const absent = fixture(t)
  absent.directory.apps = ['vscode', 'terminal']
  await assert.rejects(() => absent.actions.openDirectory('work-one'), /没有可用的文件管理器/)
  assert.equal(absent.paths.length, 0)
  const expired = fixture(t)
  expired.dom.window.fetch = async () => new Response('secret response body', { status: 403 })
  await assert.rejects(() => expired.actions.openDirectory('work-one'), error => /连接已失效/.test(error.message) && !error.message.includes('secret'))
  const missing = fixture(t)
  missing.directory.launch = async () => new Response('private directory path', { status: 404 })
  await assert.rejects(() => missing.actions.openDirectory('work-one'), /目录不存在或无权访问/)
})

test('actual rc.2 Menu and MenuItemButton run unread, title copy, directory copy and Finder open against the owning Session projection', async t => {
  const f = fixture(t, 'dsh-app://app/')
  const actualSnapshot = await owningSessionProjection([{ sessionId: 'one', title: '真实投影标题', cwd: '/fixture/one', agentAvailable: false, running: false, blank: false, updatedAt: 123 }])
  assert.equal(actualSnapshot.byId.one.displayTitle, '真实投影标题')
  assert.equal(actualSnapshot.byId.one.cwd, '/fixture/one')
  f.sessions.update(actualSnapshot)
  const React = require('react')
  const globals = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']
  const before = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const browser = f.dom.window
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : typeof browser[key] === 'function' && !['Node', 'Element', 'HTMLElement'].includes(key) ? browser[key].bind(browser) : browser[key] })
  const domGlobals = { window: browser, document: browser.document, Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), setTimeout, clearTimeout, queueMicrotask }
  const realPrimitives = { exports: {} }
  vm.runInNewContext(realMenuBuild.outputFiles[0].text, { ...domGlobals, module: realPrimitives, exports: realPrimitives.exports, require })
  const integrated = { exports: {} }
  vm.runInNewContext(compiled.outputFiles[0].text, { ...domGlobals, module: integrated, exports: integrated.exports, AbortController, require(name) { return name === '@deepseek-ai/dsh-client-ui-primitives' ? realPrimitives.exports : require(name) } })
  const entries = new Map()
  const scope = { ...f.services, slots: { inject(_name, register) { return register() }, register(options, component) { entries.set(options.id, { options, component }); return () => entries.delete(options.id) } }, effect(callback) { this.cleanup = callback() } }
  const dispose = integrated.exports.installSidebarTools({ inject(_deps, callback) { callback(scope); return { dispose() { scope.cleanup() } } } }, browser)
  const container = browser.document.createElement('div'); browser.document.body.append(container)
  const { createRoot } = require('react-dom/client')
  const root = createRoot(container)
  function HostMenu() {
    const state = React.useState(true)
    return React.createElement(realPrimitives.exports.Menu, { open: state[0], onClose: () => state[1](false), portal: true, anchor: React.createElement('button', { 'data-native-trigger': '', onClick: () => state[1](true) }, '原生菜单') }, [...entries.values()].filter(entry => entry.options.name === 'sidebar.workspaces.session.menu.item').map(entry => React.createElement(entry.component, { ...entry.options.inject(), key: entry.options.id, sessionId: 'one', displayTitle: '真实投影标题', useMenuOpenState: () => state })))
  }
  try {
    await React.act(async () => { root.render(React.createElement(HostMenu)) })
    const buttonFor = label => [...browser.document.querySelectorAll('button[role="menuitem"]')].find(button => button.textContent === label)
    const select = async label => {
      if (!browser.document.querySelector('[role="menu"]')) await React.act(async () => browser.document.querySelector('[data-native-trigger]').click())
      const button = buttonFor(label)
      assert.ok(button, label); assert.equal(button.disabled, false, label)
      await React.act(async () => { button.focus(); button.click(); await setImmediate() })
      assert.equal(browser.document.querySelector('[role="menu"]'), null, `${label} completes and closes the actual Menu`)
    }
    await select('标记为未读')
    assert.equal(entries.get('qiuya-tools/sidebar/unread').options.inject().actions.unread.getSnapshot().has('one'), true)
    await select('复制会话标题')
    await select('复制会话工作目录')
    await select('打开会话工作目录')
    assert.deepEqual(f.copies, ['真实投影标题', '/fixture/one'])
    assert.deepEqual(f.paths[0].request, { app: 'finder', path: '/fixture/one' })
  } finally {
    await React.act(async () => root.unmount())
    dispose()
    for (const key of globals) { const descriptor = before.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})

test('clipboard fallback restores the original text selection and focus without touching drafts', async t => {
  const dom = new JSDOM('<!doctype html><html><body><textarea id="draft">保留草稿</textarea><p id="text">选择的文字</p></body></html>', { url: 'https://harness.test' })
  t.after(() => dom.window.close())
  const doc = dom.window.document
  const draft = doc.querySelector('#draft')
  draft.focus()
  const range = doc.createRange(); range.selectNodeContents(doc.querySelector('#text'))
  doc.getSelection().removeAllRanges()
  doc.getSelection().addRange(range)
  let copied
  doc.execCommand = command => { assert.equal(command, 'copy'); copied = doc.activeElement.value; return true }
  await copySidebarText('复制的内容', dom.window)
  assert.equal(copied, '复制的内容')
  assert.equal(draft.value, '保留草稿')
  assert.equal(doc.activeElement, draft)
  assert.equal(doc.getSelection().toString(), '选择的文字')
  assert.equal(doc.querySelectorAll('textarea').length, 1)
})

function workspaceFixture(t) {
  const f = fixture(t)
  const doc = f.dom.window.document
  doc.body.innerHTML = '<div data-slot="sidebar.workspaces"><div data-row-key="workspace:work-two" role="treeitem"><span id="workspace-label">重名工作区</span><span class="native_rowActions"><span><button type="button" id="menu" aria-label="工作区操作">…</button></span><button type="button" id="new">+</button></span></div><div data-row-key="workspace:" role="treeitem"><button id="ungrouped">…</button><button>+</button></div><div data-row-key="session:one" role="treeitem"><span id="session-label">会话标题</span><span class="native_rowActions"><span><button type="button" id="session-menu" aria-label="会话操作">…</button></span><button id="session-pin">置顶</button></span></div></div>'
  let panel
  let nativeClicks = 0
  const trigger = doc.querySelector('#menu')
  trigger.addEventListener('click', () => {
    nativeClicks++
    if (panel?.isConnected) { panel.remove(); panel = undefined; trigger.closest('[data-row-key]').classList.remove('native_menuOpen'); return }
    trigger.closest('[data-row-key]').classList.add('native_menuOpen')
    panel = doc.createElement('div'); panel.setAttribute('role', 'menu')
    panel.innerHTML = '<div role="presentation"><div class="native-wrap"><button class="native-button" role="menuitem"><span><svg></svg></span><span>重命名</span></button></div></div>'
    doc.body.append(panel)
  })
  const dispose = installWorkspaceMenuTools({ workspaces: f.workspaces, copyPath: f.actions.copyPath, openDirectory: f.actions.openDirectory, moveToTop: f.actions.moveToTop }, f.dom.window)
  t.after(dispose)
  return { ...f, doc, trigger, dispose, tick: () => setImmediate(), nativeClicks: () => nativeClicks }
}

test('workspace enhancement adds native menu rows without consuming contextmenu, new-session clicks or native actions', async t => {
  const f = workspaceFixture(t)
  const rightClick = new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  f.doc.querySelector('[data-row-key]').dispatchEvent(rightClick)
  assert.equal(rightClick.defaultPrevented, false)
  assert.equal(f.doc.querySelector('[data-qyt-workspace-tools]'), null)
  f.doc.querySelector('#new').click(); await f.tick()
  assert.equal(f.doc.querySelector('[data-qyt-workspace-tools]'), null)
  f.trigger.click(); await f.tick()
  assert.equal(f.doc.querySelectorAll('[data-qyt-workspace-action]').length, 3)
  assert.equal(f.doc.querySelector('[data-qyt-workspace-tools]').closest('[role="presentation"]') !== null, true)
  assert.equal(f.doc.querySelector('.native-button').textContent, '重命名')
  f.doc.querySelector('[data-qyt-workspace-action="copy"]').click(); await f.tick()
  assert.deepEqual(f.copies, ['/fixture/two'])
  assert.equal(f.nativeClicks(), 2, 'the native trigger closes its own owner state')
  assert.equal(f.doc.querySelector('[role="menu"]'), null)
  f.trigger.click(); await f.tick()
  assert.equal(f.doc.querySelectorAll('[data-qyt-workspace-tools]').length, 1)
  f.dispose()
  assert.equal(f.doc.querySelector('[data-qyt-workspace-tools]'), null)
  assert.notEqual(f.doc.querySelector('.native-button'), null)
})

test('workspace failures stay inside the menu, allow retry, and unrelated menus are never augmented', async t => {
  const f = workspaceFixture(t)
  f.doc.body.insertAdjacentHTML('beforeend', '<div role="menu" id="unrelated"><button role="menuitem">其他菜单</button></div>')
  f.directory.launch = async () => new Response('{}', { status: 502 })
  f.trigger.click(); await f.tick()
  assert.equal(f.doc.querySelector('#unrelated [data-qyt-workspace-tools]'), null)
  const button = f.doc.querySelector('[data-qyt-workspace-action="folder"]')
  button.click(); await f.tick()
  assert.match(button.textContent, /失败，请重试/)
  assert.equal(button.disabled, false)
  assert.equal(button.isConnected, true)
  f.directory.launch = async () => new Response('{}', { status: 200 })
  button.click(); await f.tick()
  assert.equal(button.isConnected, false)
})

test('keyboard menu actions restore focus to the actual native trigger after asynchronous completion', async t => {
  const f = workspaceFixture(t)
  let finish
  f.directory.launch = () => new Promise(resolve => { finish = () => resolve(new Response('{}', { status: 200 })) })
  f.trigger.click(); await f.tick()
  const button = f.doc.querySelector('[data-qyt-workspace-action="folder"]')
  button.focus(); button.click(); await f.tick()
  assert.equal(f.doc.activeElement, button)
  assert.equal(button.disabled, true)
  // Chromium may blur a disabled focused button before the Host completes.
  // This remains focus lost by our action, so it still returns to its owner.
  f.doc.body.tabIndex = -1; f.doc.body.focus()
  assert.equal(f.doc.activeElement, f.doc.body)
  finish({ ok: true }); await f.tick()
  assert.equal(f.doc.querySelector('[role="menu"]'), null)
  assert.equal(f.doc.activeElement, f.trigger)
  assert.equal(f.nativeClicks(), 2)
})

test('asynchronous workspace completion never steals focus or alters text from a composer selected while waiting', async t => {
  const f = workspaceFixture(t)
  f.doc.body.insertAdjacentHTML('beforeend', '<textarea id="draft">正在编辑的草稿</textarea>')
  const draft = f.doc.querySelector('#draft')
  let finish
  f.directory.launch = () => new Promise(resolve => { finish = () => resolve(new Response('{}', { status: 200 })) })
  f.trigger.click(); await f.tick()
  const button = f.doc.querySelector('[data-qyt-workspace-action="folder"]')
  button.focus(); button.click(); await f.tick()
  draft.focus(); draft.setSelectionRange(2, 5)
  finish({ ok: true }); await f.tick()
  assert.equal(f.doc.querySelector('[role="menu"]'), null)
  assert.equal(f.doc.activeElement, draft)
  assert.equal(draft.value, '正在编辑的草稿')
  assert.equal(draft.selectionStart, 2)
  assert.equal(draft.selectionEnd, 5)
})

test('feature unload cleans pending focus tracking and a later result neither closes native UI nor moves focus', async t => {
  const f = workspaceFixture(t)
  f.doc.body.insertAdjacentHTML('beforeend', '<textarea id="draft">保留</textarea>')
  const draft = f.doc.querySelector('#draft')
  const focusWatches = new Set()
  const add = f.doc.addEventListener.bind(f.doc)
  const remove = f.doc.removeEventListener.bind(f.doc)
  f.doc.addEventListener = (name, listener, options) => { if (name === 'focusin') focusWatches.add(listener); add(name, listener, options) }
  f.doc.removeEventListener = (name, listener, options) => { if (name === 'focusin') focusWatches.delete(listener); remove(name, listener, options) }
  let finish
  f.directory.launch = () => new Promise(resolve => { finish = () => resolve(new Response('{}', { status: 200 })) })
  f.trigger.click(); await f.tick()
  const button = f.doc.querySelector('[data-qyt-workspace-action="folder"]')
  button.focus(); button.click(); await f.tick()
  assert.equal(focusWatches.size, 1)
  f.dispose()
  assert.equal(focusWatches.size, 0)
  draft.focus()
  finish({ ok: true }); await f.tick()
  assert.equal(f.doc.activeElement, draft)
  assert.equal(f.nativeClicks(), 1)
  assert.notEqual(f.doc.querySelector('[role="menu"]'), null)
  assert.equal(focusWatches.size, 0)
})

test('right-click fallback independently opens the precise native session/workspace trigger and workspace tools', async t => {
  const f = workspaceFixture(t)
  let sessionMenus = 0
  f.doc.querySelector('#session-menu').addEventListener('click', () => sessionMenus++)
  const off = installNativeSidebarContextMenu(f.dom.window, key => key === 'session:one' || key === 'workspace:work-two')
  t.after(off)
  const rightClick = id => {
    const event = new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    f.doc.querySelector(id).dispatchEvent(event)
    return event
  }
  assert.equal(rightClick('#session-label').defaultPrevented, true)
  assert.equal(sessionMenus, 1)
  assert.equal(f.nativeClicks(), 0)
  assert.equal(rightClick('#workspace-label').defaultPrevented, true)
  await f.tick()
  assert.equal(f.nativeClicks(), 1)
  assert.equal(f.doc.querySelectorAll('[data-qyt-workspace-action]').length, 3)
  assert.equal(rightClick('#workspace-label').defaultPrevented, true)
  await f.tick()
  assert.equal(f.nativeClicks(), 1, 'right-clicking an open menu never toggles it shut or creates another')
  assert.equal(f.doc.querySelectorAll('[data-qyt-workspace-tools]').length, 1)
})

test('right-click fallback respects bulk capture ownership and any already-prevented default', t => {
  const f = workspaceFixture(t)
  const off = installNativeSidebarContextMenu(f.dom.window, () => true)
  t.after(off)
  const event = () => new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  const prevented = event(); prevented.preventDefault()
  f.doc.querySelector('#workspace-label').dispatchEvent(prevented)
  assert.equal(f.nativeClicks(), 0)
  let bulkCalls = 0
  const bulk = e => { bulkCalls++; e.preventDefault(); e.stopImmediatePropagation() }
  f.doc.addEventListener('contextmenu', bulk, true)
  const captured = event()
  f.doc.querySelector('#workspace-label').dispatchEvent(captured)
  f.doc.removeEventListener('contextmenu', bulk, true)
  assert.equal(bulkCalls, 1)
  assert.equal(f.nativeClicks(), 0, 'document bubble is not reached after bulk selection handled capture')
})

test('fallback ignores buttons, links, inputs, editable content, unknown rows and outside sidebar; disposal removes it', t => {
  const f = workspaceFixture(t)
  const row = f.doc.querySelector('[data-row-key="workspace:work-two"]')
  row.insertAdjacentHTML('beforeend', '<a id="link" href="#">link</a><input id="input"><span id="editable" contenteditable="true">draft</span><span role="button" id="action">action</span>')
  f.doc.body.insertAdjacentHTML('beforeend', '<div data-row-key="session:one" role="treeitem" id="outside"><span class="native_rowActions"><span><button aria-label="outside">…</button></span></span></div>')
  const off = installNativeSidebarContextMenu(f.dom.window, key => key !== 'workspace:')
  const rightClick = element => {
    const event = new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    return event
  }
  for (const id of ['menu', 'new', 'link', 'input', 'editable', 'action', 'ungrouped', 'outside']) assert.equal(rightClick(f.doc.getElementById(id)).defaultPrevented, false, id)
  assert.equal(f.nativeClicks(), 0)
  off(); off()
  assert.equal(rightClick(f.doc.querySelector('#workspace-label')).defaultPrevented, false)
  assert.equal(f.nativeClicks(), 0)
})

test('trigger discovery never chooses a leading decoration, collapse control, hover action or direct destructive button', t => {
  const f = workspaceFixture(t)
  const row = f.doc.querySelector('[data-row-key="workspace:work-two"]')
  row.insertAdjacentHTML('afterbegin', '<button id="decoration" aria-label="decorate">custom</button>')
  assert.equal(nativeSidebarMenuTrigger(row), f.trigger)
  f.trigger.parentElement.remove()
  assert.equal(nativeSidebarMenuTrigger(row), undefined, 'new-session button is not an ellipsis wrapper')
  const badRow = f.doc.createElement('div')
  badRow.innerHTML = '<span class="native_rowActions"><button aria-label="delete">Delete</button></span>'
  assert.equal(nativeSidebarMenuTrigger(badRow), undefined)
})

test('desktop feature lifecycle offers useful copies without unsupported session links and removes subscriptions', async t => {
  const f = fixture(t, 'dsh-app://app/?auth=private')
  const registered = new Map()
  const slots = {
    inject(_name, register) { return register() },
    register(options, component) { registered.set(options.id, { options, component }); return () => registered.delete(options.id) },
  }
  const scope = { ...f.services, slots, effect(callback) { this.cleanup = callback() } }
  const ctx = { inject(dependencies, callback) { assert.equal(dependencies.includes('uiSession'), true); callback(scope); return { dispose() { scope.cleanup() } } } }
  const dispose = installSidebarTools(ctx, f.dom.window)
  assert.equal(registered.size, 5)
  for (const id of registered.keys()) assert.equal(id.startsWith('qiuya-tools/'), true)
  for (const { options } of registered.values()) assert.equal(['sidebar.workspaces.session.menu.item', 'sidebar.session.row.leading'].includes(options.name), true)
  assert.equal(registered.has('pin'), false)
  assert.equal([...registered.keys()].some(id => id.endsWith('/link')), false)
  assert.equal('installSessionLinkNavigation' in module.exports, false)
  assert.equal('sessionNavigationLink' in modelModule.exports, false)
  await f.actions.perform('title', 'one')
  await f.actions.perform('copy-directory', 'one')
  assert.deepEqual(f.copies, ['第一条会话', '/fixture/one'])
  const unread = [...registered.values()].find(item => item.options.id.endsWith('/unread')).options.inject().actions.unread
  unread.set('one', true)
  f.current.update({ key: 'one' })
  assert.equal(unread.getSnapshot().has('one'), true)
  f.current.update({ key: 'two' }); f.current.update({ key: 'one' })
  assert.equal(unread.getSnapshot().has('one'), false)
  dispose(); dispose()
  assert.equal(registered.size, 0)
  assert.equal(f.current.listeners.size, 0)
  assert.equal(f.sessions.listeners.size, 0)
  assert.equal(f.workspaces.listeners.size, 0)
})
