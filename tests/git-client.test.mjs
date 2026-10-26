import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import React, { act, useSyncExternalStore } from 'react'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const boot = new JSDOM(''), original = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.assign(globalThis, { window: boot.window, document: boot.window.document })
const { createRoot } = await import('react-dom/client')
boot.window.close()
for (const [key, descriptor] of original) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
const { Simulate } = require('react-dom/test-utils')
const primitives = {
  MenuSurface: React.forwardRef(function Surface({ compact, ...props }, ref) { return React.createElement('div', { ...props, ref }) }),
  useAnchoredPosition: () => ({ left: 12, top: 12 }), useDismissOnOutsidePointer() {},
  useCodeHighlighter: () => () => undefined, languageForPath: () => undefined,
}
async function moduleAt(path) { const source = (await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external' })).outputFiles[0].text; const module = { exports: {} }; new Function('require', 'module', 'exports', source)(name => name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(name), module, module.exports); return module.exports }
const apiModule = await moduleAt('../src/features/git/client-api.ts'), client = await moduleAt('../src/features/git/client.tsx'), contract = await moduleAt('../src/features/git/contract.ts'), resources = await moduleAt('../src/features/git/resources.ts')
const { createGitClientAPI, GitClientStore } = apiModule
const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const file = (path = 'src/example.go') => ({ path, status: 'modified', added: 10, deleted: 11, staged: false, unstaged: true, binary: false })
function snapshot(sessionId = 'A', fields = {}) { return { sessionId, available: true, repoName: `project-${sessionId}`, repoRoot: `/repo/${sessionId}`, branch: 'main', head: 'a'.repeat(40), locked: false, bindingMismatch: false, mode: 'current', scope: 'working', revision: `${sessionId}-working`, added: 10, deleted: 11, fileCount: 1, files: [file()], remotes: [{ name: 'origin', url: 'git@github.com:owner/project.git' }], ahead: 0, behind: 0, defaultTarget: 'origin/main', ...fields } }
function connectionFor(handler) { const calls = []; return { calls, connection: { rpc: { async call(channel, endpoint, input, signal) { assert.equal(channel, '/api'); assert.equal(endpoint, contract.GIT_ENDPOINT); calls.push({ input: structuredClone(input), signal }); return handler(input, signal) } } } } }

test('Git client rejects a foreign-session snapshot and inconsistent file totals', async () => {
  const f = connectionFor(async () => ({ ok: true, value: snapshot('B') })), api = createGitClientAPI(() => f.connection)
  await assert.rejects(api.status('A', new AbortController().signal), /会话/u)
  assert.throws(() => apiModule.readGitSnapshot(snapshot('A', { fileCount: 4 }), 'A'), /不一致/u)
})
test('a replaced connection or generation cannot publish a late Git response for the same Session id', async () => {
  const held = deferred(), first = connectionFor(() => held.promise), replacement = connectionFor(async () => ({ ok: true, value: snapshot('A') }))
  let current = first.connection
  const api = createGitClientAPI(() => current), pending = api.status('A', new AbortController().signal)
  current = replacement.connection; held.resolve({ ok: true, value: snapshot('A') })
  await assert.rejects(pending, error => error.code === 'CONNECTION_CHANGED')
  let generation = { id: 1 }; const delayed = deferred()
  current = { generation: { getSnapshot: () => generation }, rpc: { call: () => delayed.promise } }
  const retry = api.status('A', new AbortController().signal); generation = { id: 2 }; delayed.resolve({ ok: true, value: snapshot('A') })
  await assert.rejects(retry, error => error.code === 'CONNECTION_CHANGED')
})
test('every Git, PR and credential mutation carries one stable request id and unconfirmed writes are never reported complete', async () => {
  const f = connectionFor(async () => ({ ok: true, value: { completed: false, message: 'not confirmed' } })), api = createGitClientAPI(() => f.connection)
  await assert.rejects(api.perform({ op: 'push', sessionId: 'A' }, new AbortController().signal), /not confirmed/u)
  assert.match(f.calls[0].input.requestId, /^[a-f0-9-]{36}$/u); assert.equal(f.calls.length, 1)
  await api.call({ op: 'credentialSet', sessionId: 'A', token: 'sample', requestId: 'fixed-request' }, new AbortController().signal)
  assert.equal(f.calls.at(-1).input.requestId, 'fixed-request')
})
test('PR links must belong to the selected public provider and cannot carry URL credentials', async () => {
  const row = { provider: 'github', number: 1, title: 'A', body: '', url: 'https://unrelated.test/x', state: 'open', sourceBranch: 'feature', targetBranch: 'main', checkStatus: 'unknown' }
  const f = connectionFor(async () => ({ ok: true, value: [row] })), api = createGitClientAPI(() => f.connection)
  await assert.rejects(api.pullRequests({ op: 'prList', sessionId: 'A' }, new AbortController().signal), /PR/u)
  row.url = 'https://secret@github.com/owner/repo/pull/1'; await assert.rejects(api.pullRequests({ op: 'prList', sessionId: 'A' }, new AbortController().signal), /PR/u)
})
test('one retained comparison shares its request and stale reads cannot replace a newer snapshot', async () => {
  const late = deferred(); let n = 0
  const f = connectionFor(async input => { n++; if (n === 1) return late.promise; return { ok: true, value: snapshot(input.sessionId, { revision: 'newer' }) } }), store = new GitClientStore(createGitClientAPI(() => f.connection), 60_000)
  const a = store.retain('A'), b = store.retain('A'); assert.equal(f.calls.length, 1)
  await store.refresh('A'); late.resolve({ ok: true, value: snapshot('A', { revision: 'older' }) }); await turn()
  assert.equal(store.snapshot('A').snapshot.revision, 'newer'); assert.equal(f.calls[0].signal.aborted, true)
  a(); b(); store.dispose()
})
test('Git mutation from a staged view uses its cached working revision and serializes double clicks', async () => {
  const held = deferred()
  const f = connectionFor(async input => input.op === 'status' ? { ok: true, value: snapshot('A', { scope: input.scope, revision: input.scope === 'working' ? 'reviewed-working' : 'reviewed-staged' }) } : held.promise), store = new GitClientStore(createGitClientAPI(() => f.connection), 60_000)
  await store.refresh('A'); await store.refresh('A', 'staged')
  const pending = store.perform({ op: 'stage', sessionId: 'A', scope: 'staged', expectedRevision: 'reviewed-staged', paths: ['src/example.go'] })
  await assert.rejects(store.perform({ op: 'stage', sessionId: 'A' }), /正在执行/u)
  assert.equal(f.calls.at(-1).input.expectedRevision, 'reviewed-working'); assert.equal(f.calls.at(-1).input.scope, 'working')
  held.resolve({ ok: true, value: { completed: true, message: 'done' } }); await pending
  assert.equal(f.calls.filter(row => row.input.op === 'stage').length, 1); store.dispose()
})
test('Git read disposal aborts all retained requests and ignores an uncooperative late transport', async () => {
  const held = deferred(), f = connectionFor(() => held.promise), store = new GitClientStore(createGitClientAPI(() => f.connection), 60_000)
  store.retain('A'); const state = store.snapshot('A'); store.dispose(); held.resolve({ ok: true, value: snapshot('A') }); await turn()
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(state.snapshot, undefined)
})
test('inactive Git snapshot caches are bounded while active Sessions remain retained', async () => {
  const f = connectionFor(async input => ({ ok: true, value: snapshot(input.sessionId) })), store = new GitClientStore(createGitClientAPI(() => f.connection), 60_000)
  const release = store.retain('active'); await turn()
  for (let index = 0; index < 100; index++) await store.refresh(`session-${index}`)
  assert.equal(store.snapshot('session-0').snapshot, undefined); assert.equal(store.snapshot('active').snapshot.repoName, 'project-active')
  release(); store.dispose()
})
test('Git resource addresses carry exact sessions and reject foreign query vocabulary', async () => {
  const address = contract.gitAddress('A', 'src/含 空格.go'); assert.deepEqual(contract.parseGitAddress(address), { sessionId: 'A', path: 'src/含 空格.go' })
  assert.equal(contract.parseGitAddress('dsh-resource://qiuya-git/A?file=x&unknown=y'), undefined)
  const provider = resources.createGitResourceProvider(), read = provider.open(address, { signal: new AbortController().signal })
  assert.deepEqual((await read.next()).value, { ok: true, value: { sessionId: 'A', path: 'src/含 空格.go' } }); await read.return()
})

async function fixture(t, { strict = false, handler, options = {} } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1/', pretendToBeVisual: true }), globals = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const states = new Map(), opened = [], blocks = new Map(), preferences = { status: 'ready', value: { enabled: true, gitEnabled: true } }, listeners = new Set()
  const stateFor = id => { if (!states.has(id)) states.set(id, { session: { blank: true, awaitingFirstTurn: false, running: false, removed: false, subagent: null, openState: 'open' }, input: { phase: 'plain' }, listeners: new Set() }); return states.get(id) }
  const defaults = async input => {
    if (input.op === 'status') return { ok: true, value: snapshot(input.sessionId, { scope: input.scope ?? 'working', ...(input.target ? { target: input.target } : {}) }) }
    if (input.op === 'branches') return { ok: true, value: [{ name: 'main', ref: 'refs/heads/main', current: true, remote: false, checkedOut: true }, { name: 'origin/dev', ref: 'refs/remotes/origin/dev', current: false, remote: true }] }
    if (input.op === 'diff') return { ok: true, value: { sessionId: input.sessionId, revision: `${input.sessionId}-working`, file: file(input.path), scope: input.scope, ...(input.target ? { target: input.target } : {}), oldText: 'before\n', newText: 'after\n', patch: '@@ -1 +1 @@\n-before\n+after\n', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }], tooLarge: false } }
    return { ok: true, value: { completed: true, message: 'done' } }
  }
  const f = connectionFor((input, signal) => handler?.(input, signal, defaults) ?? defaults(input)), api = createGitClientAPI(() => f.connection), store = new GitClientStore(api, 60_000)
  const face = { api, store, options, form: { getSnapshot: () => preferences, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }, ctx: { locale: { getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => {} }, conversation: { blocks: { storeFor(id) { return { getSnapshot: () => blocks.get(id) } }, set(id, value) { if (value) blocks.set(id, value); else blocks.delete(id) } } } }, open(sessionId, path) { store.requestOpen(sessionId, path); opened.push({ sessionId, ...(path ? { path } : {}) }) } }
  const root = createRoot(dom.window.document.querySelector('#root'))
  function Seat({ id, seat, detail = false }) {
    const state = stateFor(id), useSession = select => useSyncExternalStore(fn => { state.listeners.add(fn); return () => state.listeners.delete(fn) }, () => select(state.session)), useInput = select => useSyncExternalStore(fn => { state.listeners.add(fn); return () => state.listeners.delete(fn) }, () => select(state.input))
    const common = { ...face, sessionId: id, useSession, useInput }
    return React.createElement('div', { 'data-seat': seat }, detail ? React.createElement(client.GitDetails, { ...common, useTabInfo: () => ({ tab: { navigation: { address: contract.gitAddress(id, 'src/example.go') }, actions: { bindCommands: () => () => {} } } }) }) : [React.createElement(client.GitBranchSelector, { ...common, key: 'branch' }), React.createElement(client.GitStats, { ...common, key: 'stats' })])
  }
  const render = async (seats = { one: 'A', two: 'B' }, detail = false) => act(async () => { const body = React.createElement(React.Fragment, {}, ...Object.entries(seats).map(([seat, id]) => React.createElement(Seat, { key: seat, id, seat, detail }))); root.render(strict ? React.createElement(React.StrictMode, {}, body) : body); await turn() })
  const click = async node => { assert.ok(node); await act(async () => { node.click(); await turn() }) }
  const hover = async node => act(async () => { Simulate.mouseEnter(node.closest?.('[data-qyt-git-stats]') ?? node); await turn() })
  const change = async (node, value) => act(async () => { Simulate.change(node, { target: { value } }); await turn() })
  const update = async (id, session, input) => act(async () => { const state = stateFor(id); if (session) state.session = { ...state.session, ...session }; if (input) state.input = { ...state.input, ...input }; for (const notify of state.listeners) notify(); await turn() })
  t.after(async () => { await act(async () => { root.unmount(); await turn() }); store.dispose(); dom.window.close(); for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] })
  return { dom, face, store, calls: f.calls, opened, blocks, render, click, hover, change, update, stateFor, doc: dom.window.document }
}

test('hover lists repository name and per-file counts, and clicking opens the exact file directly', async t => {
  const f = await fixture(t); await f.render()
  const trigger = f.doc.querySelector('[data-qyt-git-stats="A"] button'); await f.hover(trigger)
  const popup = f.doc.querySelector('[data-qyt-git-hover="A"]'); assert.ok(popup); assert.match(popup.textContent, /project-A/u); assert.match(popup.textContent, /src\/example.go/u); assert.match(popup.textContent, /\+10/u); assert.match(popup.textContent, /-11/u)
  await f.click(popup.querySelector('button')); assert.deepEqual(f.opened, [{ sessionId: 'A', path: 'src/example.go' }])
  await f.click(f.doc.querySelector('[data-qyt-git-stats="B"] button')); assert.deepEqual(f.opened.at(-1), { sessionId: 'B' })
  assert.equal(f.calls.filter(row => row.input.op === 'status' && row.input.sessionId === 'A').length, 1, 'branch picker and stats share the same snapshot read')
})
test('hover remains open while moving from the trigger into the file list and Escape closes it', async t => {
  const f = await fixture(t); await f.render({ one: 'A' }); const seat = f.doc.querySelector('[data-qyt-git-stats="A"]')
  await f.hover(seat); const popup = f.doc.querySelector('[data-qyt-git-hover="A"]')
  await act(async () => { Simulate.mouseLeave(seat); Simulate.mouseEnter(popup); await new Promise(resolve => setTimeout(resolve, 180)) })
  assert.ok(f.doc.querySelector('[data-qyt-git-hover="A"]'))
  await act(async () => { f.doc.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await turn() })
  assert.equal(f.doc.querySelector('[data-qyt-git-hover="A"]'), null)
})
test('branch choice locks on first accepted turn and remains locked after the agent becomes idle', async t => {
  const f = await fixture(t); await f.render({ one: 'A' }); const button = () => f.doc.querySelector('[data-qyt-git-branch="A"] button')
  assert.equal(button().disabled, false); await f.update('A', undefined, { phase: 'submitting' }); assert.equal(button().disabled, true)
  await f.update('A', { blank: false, running: true }, { phase: 'plain' }); assert.equal(button().disabled, true)
  await f.update('A', { running: false }); assert.equal(button().disabled, true); assert.equal(f.calls.some(row => ['selectBranch', 'createBranch'].includes(row.input.op)), false)
})
test('the compact branch menu progressively reveals environment, branch list and custom creation', async t => {
  const f = await fixture(t, { options: { worktreeAvailable: true } }); await f.render({ one: 'A' }); await f.click(f.doc.querySelector('[data-qyt-git-branch="A"] button'))
  const menu = () => f.doc.querySelector('.qyt-git-branch-popover'), find = text => [...menu().querySelectorAll('button')].find(node => node.textContent.endsWith(text))
  assert.equal(menu().dataset.view, 'environment'); assert.match(menu().textContent, /配置本地环境/u); assert.equal(menu().querySelector('input,form,[role="listbox"]'), null)
  assert.equal(f.calls.filter(row => row.input.op === 'branches').length, 0)
  const toggle = menu().querySelector('[role="switch"]'); assert.equal(toggle.getAttribute('aria-checked'), 'false'); assert.equal(toggle.getAttribute('aria-label'), '新建工作树')
  await f.click(toggle); assert.equal(toggle.getAttribute('aria-checked'), 'true'); await f.click(toggle); assert.equal(toggle.getAttribute('aria-checked'), 'false')
  await f.click(menu().querySelector('[aria-label="选择分支"]'))
  assert.equal(menu().dataset.view, 'branches'); assert.ok(menu().querySelector('input[type="search"]')); assert.ok(menu().querySelector('[role="listbox"]')); assert.equal(menu().querySelector('form'), null)
  assert.match(menu().textContent, /本地分支/u); assert.match(menu().textContent, /远程分支/u); assert.equal(f.calls.filter(row => row.input.op === 'branches').length, 1)
  await f.click(find('新建分支…')); assert.equal(menu().dataset.view, 'create'); assert.equal(menu().querySelector('input[type="search"],[role="listbox"]'), null); assert.ok(menu().querySelector('form'))
  await f.change(menu().querySelector('form input'), 'feature/custom-name'); await f.change(menu().querySelector('form select'), 'refs/remotes/origin/dev')
  await f.click(menu().querySelector('[aria-label="返回分支列表"]')); assert.equal(menu().dataset.view, 'branches')
  await f.click(menu().querySelector('[aria-label="返回本地环境"]')); assert.equal(menu().dataset.view, 'environment'); assert.equal(menu().querySelector('form,input'), null)
  assert.equal(f.calls.some(row => ['selectBranch', 'createBranch', 'createWorktree'].includes(row.input.op)), false)
  await f.click(menu().querySelector('[aria-label="选择分支"]')); await f.click(find('新建分支…'))
  assert.equal(menu().querySelector('form input').value, 'feature/custom-name')
  await act(async () => { Simulate.submit(menu().querySelector('form')); await turn() })
  const commands = f.calls.filter(row => row.input.op === 'createBranch'); assert.equal(commands.length, 1); assert.equal(commands[0].input.branch, 'feature/custom-name'); assert.equal(commands[0].input.base, 'refs/remotes/origin/dev')
})
test('unavailable Git keeps a disabled branch entry with its precise reason and never opens or issues commands', async t => {
  let reason = '当前目录不是 Git 仓库。'
  const f = await fixture(t, { handler(input, _signal, fallback) { return input.op === 'status' && reason !== undefined ? { ok: true, value: snapshot(input.sessionId, { available: false, reason, repoName: '', repoRoot: '', branch: null, head: null, revision: '', added: 0, deleted: 0, fileCount: 0, files: [], remotes: [] }) } : fallback(input) } })
  await f.render({ one: 'A' })
  for (const [message, label] of [['当前目录不是 Git 仓库。', '未检测到 Git 仓库'], ['未找到 Git，请先在宿主安装 Git。', 'Git 不可用'], ['会话工作目录不存在或无法读取。', 'Git 不可用']]) {
    reason = message; await act(async () => { await f.store.refresh('A'); await turn() })
    const button = f.doc.querySelector('[data-qyt-git-branch="A"] button')
    assert.ok(button); assert.equal(button.disabled, true); assert.equal(button.textContent, label); assert.equal(button.title, reason)
    const before = f.calls.length; await f.click(button)
    assert.equal(f.calls.length, before, 'clicking the unavailable entry cannot dispatch branch reads or writes')
    assert.equal(f.doc.querySelector('.qyt-git-branch-popover'), null); assert.equal(f.doc.querySelector('[data-qyt-git-stats="A"]'), null)
  }
  assert.deepEqual(f.calls.filter(row => row.input.op !== 'status'), [])
  reason = undefined; await act(async () => { await f.store.refresh('A'); await turn() })
  const restored = f.doc.querySelector('[data-qyt-git-branch="A"] button')
  assert.equal(restored.disabled, false); assert.equal(restored.textContent, 'main'); assert.ok(f.doc.querySelector('[data-qyt-git-stats="A"]'))
  await f.click(restored); assert.equal(f.doc.querySelector('.qyt-git-branch-popover').dataset.view, 'environment'); assert.equal(f.calls.at(-1).input.op, 'status')
  await f.click(f.doc.querySelector('[aria-label="选择分支"]')); assert.equal(f.calls.at(-1).input.op, 'branches')
})
test('a stale read for a replaced Session cannot populate the new Session hover', async t => {
  const pending = deferred(); const f = await fixture(t, { handler(input, _signal, fallback) { return input.op === 'status' && input.sessionId === 'A' ? pending.promise : fallback(input) } })
  await f.render({ one: 'A' }); await f.render({ one: 'B' }); await act(async () => { pending.resolve({ ok: true, value: snapshot('A') }); await turn() })
  assert.equal(f.doc.querySelector('[data-qyt-git-stats="A"]'), null); await f.hover(f.doc.querySelector('[data-qyt-git-stats="B"]'))
  assert.match(f.doc.querySelector('[data-qyt-git-hover="B"]').textContent, /project-B/u); assert.equal(f.doc.body.textContent.includes('project-A'), false)
})
test('remote selection in worktree mode uses the remote commit as base and a local branch name', async t => {
  const preflight = [], opened = []; const f = await fixture(t, { options: { worktreeAvailable: true, async preflightWorktree(id) { preflight.push(id) }, async openWorktree(id, receipt, ownership) { opened.push({ id, receipt, ownership }) } }, handler(input, _signal, fallback) { return input.op === 'createWorktree' ? { ok: true, value: { completed: true, message: 'prepared', branch: input.branch, worktreePath: '/worktrees/dev' } } : fallback(input) } })
  await f.render({ one: 'A' }); await f.click(f.doc.querySelector('[data-qyt-git-branch="A"] button'))
  await f.click(f.doc.querySelector('[role="switch"]')); await f.click(f.doc.querySelector('[aria-label="选择分支"]'))
  await f.click([...f.doc.querySelectorAll('[role="option"]')].find(node => node.textContent.includes('origin/dev')))
  const request = f.calls.find(row => row.input.op === 'createWorktree').input; assert.equal(request.branch, 'dev'); assert.equal(request.base, 'refs/remotes/origin/dev'); assert.deepEqual(preflight, ['A']); assert.equal(opened.length, 1); assert.ok(opened[0].ownership.sourceBlock); assert.equal(f.blocks.has('A'), false)
})
test('worktree preflight failure never creates a worktree or removes another composer owner block', async t => {
  const f = await fixture(t, { options: { worktreeAvailable: true, async preflightWorktree() { throw Error('Draft changed') } } }); await f.render({ one: 'A' }); await f.click(f.doc.querySelector('[data-qyt-git-branch="A"] button')); await f.click(f.doc.querySelector('[role="switch"]')); await f.click(f.doc.querySelector('[aria-label="选择分支"]')); await f.click([...f.doc.querySelectorAll('[role="option"]')].find(node => node.textContent.includes('origin/dev')))
  assert.equal(f.calls.some(row => row.input.op === 'createWorktree'), false); assert.match(f.doc.body.textContent, /Draft changed/u)
  const other = { reason: 'Other feature' }; f.blocks.set('A', other)
  await f.click(f.doc.querySelector('[aria-label="返回本地环境"]')); await f.click(f.doc.querySelector('[role="switch"]')); await f.click(f.doc.querySelector('[aria-label="选择分支"]')); await f.click([...f.doc.querySelectorAll('[role="option"]')].find(node => node.textContent.includes('origin/dev')))
  assert.equal(f.blocks.get('A'), other); assert.equal(f.calls.some(row => row.input.op === 'selectBranch'), false)
})
test('a prepared worktree can be opened again from the main menu without creating another worktree', async t => {
  const opened = [], preflight = []; const f = await fixture(t, { options: { worktreeAvailable: true, async preflightWorktree(id) { preflight.push(id) }, async openWorktree(id, receipt, ownership) { opened.push({ id, receipt, ownership }); if (opened.length === 1) throw Error('Navigation failed') } }, handler(input, _signal, fallback) { return input.op === 'createWorktree' ? { ok: true, value: { completed: true, message: 'prepared', branch: input.branch, worktreePath: '/worktrees/dev' } } : fallback(input) } })
  await f.render({ one: 'A' }); await f.click(f.doc.querySelector('[data-qyt-git-branch="A"] button')); await f.click(f.doc.querySelector('[role="switch"]')); await f.click(f.doc.querySelector('[aria-label="选择分支"]')); await f.click([...f.doc.querySelectorAll('[role="option"]')].find(node => node.textContent.includes('origin/dev')))
  assert.equal(opened.length, 1); assert.equal(f.blocks.has('A'), false)
  if (!f.doc.querySelector('.qyt-git-branch-popover')) await f.click(f.doc.querySelector('[data-qyt-git-branch="A"] button'))
  const menu = f.doc.querySelector('.qyt-git-branch-popover'); assert.equal(menu.dataset.view, 'environment'); assert.match(menu.textContent, /Navigation failed/u); assert.equal(menu.querySelector('[role="switch"]').disabled, true)
  await f.click([...menu.querySelectorAll('button')].find(node => node.textContent === '打开已创建的工作树'))
  assert.equal(opened.length, 2); assert.equal(opened[0].receipt, opened[1].receipt); assert.ok(opened[1].ownership.sourceBlock); assert.deepEqual(preflight, ['A', 'A']); assert.equal(f.blocks.has('A'), false); assert.equal(f.calls.filter(row => row.input.op === 'createWorktree').length, 1); assert.equal(f.doc.querySelector('.qyt-git-branch-popover'), null)
})
test('closing a branch submenu aborts its read and a late list cannot populate another session', async t => {
  const held = deferred(); const f = await fixture(t, { handler(input, _signal, fallback) { return input.op === 'branches' && input.sessionId === 'A' ? held.promise : fallback(input) } })
  await f.render({ one: 'A' }); await f.click(f.doc.querySelector('[data-qyt-git-branch="A"] button')); await f.click(f.doc.querySelector('[aria-label="选择分支"]'))
  const read = f.calls.find(row => row.input.op === 'branches'); await f.render({ one: 'B' }); assert.equal(read.signal.aborted, true)
  await act(async () => { held.resolve({ ok: true, value: [{ name: 'stale-A', ref: 'refs/heads/stale-A', current: false, remote: false }] }); await turn() })
  await f.click(f.doc.querySelector('[data-qyt-git-branch="B"] button')); assert.equal(f.doc.querySelector('.qyt-git-branch-popover').dataset.view, 'environment'); assert.equal(f.doc.body.textContent.includes('stale-A'), false)
})
test('StrictMode effect replay restores read lifetimes, and details renders both sides without sharing Session data', async t => {
  const f = await fixture(t, { strict: true }); await f.render({ one: 'A' }, true)
  const pane = f.doc.querySelector('[data-qyt-git-details="A"]'); assert.ok(pane); assert.match(pane.textContent, /before/u); assert.match(pane.textContent, /after/u)
  assert.equal(pane.querySelector('.qyt-git-diff-table').dataset.layout, 'split')
  await f.click([...pane.querySelectorAll('button')].find(node => node.textContent === '左右对照')); assert.equal(pane.querySelector('.qyt-git-diff-table').dataset.layout, 'unified')
  await f.render({ one: 'B' }, true); assert.equal(f.doc.querySelector('[data-qyt-git-details="A"]'), null); assert.match(f.doc.querySelector('[data-qyt-git-details="B"]').textContent, /project-B/u)
})
test('the hero shows the actual branch while the locked binding mismatch is explained', async t => {
  const f = await fixture(t, { handler(input, _signal, fallback) { return input.op === 'status' ? { ok: true, value: snapshot(input.sessionId, { locked: true, boundBranch: 'feature/original', branch: 'other', bindingMismatch: true }) } : fallback(input) } })
  await f.render({ one: 'A' }); const trigger = f.doc.querySelector('[data-qyt-git-branch="A"] button'); assert.match(trigger.textContent, /other/u); assert.equal(trigger.disabled, true); assert.match(trigger.title, /feature\/original/u); assert.match(trigger.title, /实际分支：other/u); assert.ok(trigger.querySelector('.qyt-git-warning'))
  await f.render({ one: 'A' }, true); const pane = f.doc.querySelector('[data-qyt-git-details="A"]'); assert.match(pane.textContent, /会话分支：feature\/original；实际分支：other/u); assert.ok([...pane.querySelectorAll('button')].find(node => node.textContent === '恢复绑定分支'))
})
test('binary changes display a bounded explanation instead of fabricated textual lines', async t => {
  const f = await fixture(t, { async handler(input, _signal, fallback) { const result = await fallback(input); if (input.op === 'diff') result.value = { ...result.value, file: { ...result.value.file, binary: true, added: null, deleted: null }, oldText: null, newText: null, patch: '', hunks: [], message: '二进制文件已更改。' }; return result } })
  await f.render({ one: 'A' }, true); assert.match(f.doc.querySelector('.qyt-git-file-diff').textContent, /二进制文件已更改/u); assert.equal(f.doc.querySelector('.qyt-git-diff-table'), null)
})
for (const [name, fields, patch, expected] of [
  ['rename', { status: 'renamed', oldPath: 'src/old.go' }, 'rename from src/old.go\nrename to src/example.go\n', /文件已重命名/u],
  ['submodule', { kind: 'submodule' }, '-Subproject commit aaa\n+Subproject commit bbb\n', /子模块版本/u],
  ['empty untracked file', { status: 'untracked' }, '', /新增空文件/u],
]) test(`a ${name} has an explicit explanation even without text hunks`, async t => {
  const f = await fixture(t, { async handler(input, _signal, fallback) { const result = await fallback(input); if (input.op === 'diff') result.value = { ...result.value, file: { ...result.value.file, ...fields }, oldText: '', newText: '', hunks: [], patch }; return result } })
  await f.render({ one: 'A' }, true)
  assert.match(f.doc.querySelector('.qyt-git-file-diff').textContent, expected)
  if (patch) assert.equal(f.doc.querySelector('.qyt-git-metadata').textContent, patch)
})
test('recent commits are read only when expanded and never carry a mutation id', async t => {
  const f = await fixture(t, { handler(input, _signal, fallback) { return input.op === 'log' ? { ok: true, value: [{ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: 'Existing change', author: 'Qiu', at: 1_000_000 }] } : fallback(input) } })
  await f.render({ one: 'A' }, true); assert.equal(f.calls.some(row => row.input.op === 'log'), false)
  await act(async () => { const details = f.doc.querySelector('.qyt-git-history'); details.open = true; details.dispatchEvent(new f.dom.window.Event('toggle')); await turn() })
  assert.match(f.doc.querySelector('.qyt-git-history').textContent, /Existing change/u); const request = f.calls.find(row => row.input.op === 'log').input; assert.equal(request.requestId, undefined)
})
test('clicking the summary again resets an existing staged comparison to working changes', async t => {
  const f = await fixture(t); await f.render({ one: 'A' }, true); const scope = () => f.doc.querySelector('select[aria-label="对比范围"]')
  await f.change(scope(), 'staged'); assert.equal(scope().value, 'staged')
  await act(async () => { f.face.open('A', 'src/example.go'); await turn() }); assert.equal(scope().value, 'working')
})
test('restoring a bound branch from staged details uses the working revision', async t => {
  const f = await fixture(t, { handler(input, _signal, fallback) { return input.op === 'status' ? { ok: true, value: snapshot(input.sessionId, { scope: input.scope, locked: true, boundBranch: 'main', branch: 'other', bindingMismatch: true, revision: `${input.scope}-reviewed` }) } : fallback(input) } })
  await f.render({ one: 'A' }, true); await f.change(f.doc.querySelector('select[aria-label="对比范围"]'), 'staged')
  await f.click([...f.doc.querySelectorAll('button')].find(node => node.textContent === '恢复绑定分支'))
  const request = f.calls.find(row => row.input.op === 'restoreBinding').input; assert.equal(request.expectedRevision, 'working-reviewed'); assert.equal(request.scope, 'working')
})
test('a partially staged file is unstaged from staged details instead of staging unseen working edits', async t => {
  const f = await fixture(t, { handler(input, _signal, fallback) { return input.op === 'status' ? { ok: true, value: snapshot(input.sessionId, { scope: input.scope, files: [{ ...file(), staged: true, unstaged: true }] }) } : fallback(input) } })
  await f.render({ one: 'A' }, true); await f.change(f.doc.querySelector('select[aria-label="对比范围"]'), 'staged')
  await f.click(f.doc.querySelector('.qyt-git-file-diff button[title="取消暂存"]'))
  assert.equal(f.calls.filter(row => row.input.op === 'unstage').length, 1); assert.equal(f.calls.some(row => row.input.op === 'stage'), false)
})

for (const provider of ['github', 'gitlab', 'gitee']) test(`${provider} PR form submits an explicitly selected draft and preserves update capabilities`, async t => {
  const f = await fixture(t, { handler(input, _signal, fallback) {
    if (input.op === 'status') return { ok: true, value: snapshot(input.sessionId, { scope: input.scope, branch: 'feature', upstream: 'origin/feature', remotes: [{ name: 'origin', url: `git@${provider}.com:owner/project.git` }] }) }
    if (input.op === 'credentialStatus') return { ok: true, value: { provider, hostname: `${provider}.com`, configured: true, writable: true } }
    if (input.op === 'prCreate' || input.op === 'prUpdate') return { ok: true, value: { provider, number: 7, title: input.title, body: input.body, url: `https://${provider}.com/owner/project/${provider === 'gitlab' ? '-/merge_requests' : 'pulls'}/7`, state: 'open', sourceBranch: 'feature', targetBranch: 'main', draft: true, checkStatus: 'unknown' } }
    return fallback(input)
  } })
  await f.render({ one: 'A' }, true)
  await f.click([...f.doc.querySelectorAll('button')].find(node => node.textContent === 'PR / MR'))
  const panel = f.doc.querySelector('.qyt-git-pr'), field = label => [...panel.querySelectorAll('label')].find(node => node.firstChild?.textContent === label)?.querySelector('input,textarea')
  await f.change(field('标题'), 'Review this change')
  const draft = panel.querySelector('input[type="checkbox"]')
  assert.ok(draft, `${provider} exposes a draft choice before creation`)
  await act(async () => { Simulate.change(draft, { target: { checked: true } }); await turn() })
  assert.equal(panel.querySelector('button[type="submit"]').disabled, false)
  await act(async () => { panel.querySelector('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })); await turn() })
  const created = f.calls.filter(row => row.input.op === 'prCreate')
  assert.equal(created.length, 1); assert.equal(created[0].input.provider, provider); assert.equal(created[0].input.draft, true); assert.equal(created[0].input.sourceBranch, 'feature'); assert.equal(created[0].input.targetBranch, 'main'); assert.match(created[0].input.requestId, /^[a-f0-9-]{36}$/u)
  assert.equal(panel.querySelector('input[type="checkbox"]'), null, 'editing does not expose an unsupported draft-state mutation')
  await f.change(field('标题'), 'Updated title')
  await act(async () => { panel.querySelector('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })); await turn() })
  const updated = f.calls.find(row => row.input.op === 'prUpdate').input
  assert.equal(updated.number, 7); assert.equal(updated.title, 'Updated title'); assert.equal(updated.draft, undefined)
  if (provider === 'gitee') { assert.equal(field('目标分支').disabled, true); assert.equal(updated.targetBranch, undefined) }
})

test('Git layout styles are marker-scoped and preserve existing slot outlets', async () => {
  const source = await readFile(new URL('../src/features/git/styles.ts', import.meta.url), 'utf8')
  assert.match(source, /\[data-composer-dock\]:has\(\[data-qyt-git-stats\]\)/u); assert.match(source, /conversation\.hero\.options/u)
  assert.doesNotMatch(await readFile(new URL('../src/features/git/client.tsx', import.meta.url), 'utf8'), /appendChild|insertBefore|replaceChild/u)
})
