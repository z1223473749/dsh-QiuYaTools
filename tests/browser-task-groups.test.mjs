import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createTaskGroups, matchTab } from '../browser-extension/groups.js'
const { outputFiles } = await build({ entryPoints: [new URL('../src/features/computer-use/browser-groups.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' })
const { BrowserTaskGroups, browserGroupTitle, browserTabIdentity } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'))
const identity = { appId: 'com.google.Chrome', title: 'Owned tab', window: { left: 100, top: 50, width: 900, height: 600 } }
const command = { id: 'test', operation: 'task-a', label: '🤖 更新视频教程', tab: identity, expiresAt: 5000 }
function fixture() {
  const calls = [], tabs = new Map([[1, { id: 1, title: 'Owned tab', windowId: 10, groupId: -1, pinned: false }]])
  const groups = new Map(); let next = 20, clock = 1000
  const windows = [{ id: 10, ...identity.window, tabs: [...tabs.values()] }]
  const api = {
    windows: { async getAll() { return structuredClone(windows) } },
    tabs: { async get(id) { if (!tabs.has(id)) throw Error('closed'); return { ...tabs.get(id) } }, async group(input) { calls.push(input); const id = input.groupId ?? next++; if (!groups.has(id)) groups.set(id, { id, windowId: 10, title: '' }); for (const tab of input.tabIds) tabs.get(tab).groupId = id; return id } },
    tabGroups: { async get(id) { if (!groups.has(id)) throw Error('gone'); return { ...groups.get(id) } }, async update(id, value) { Object.assign(groups.get(id), value); return { ...groups.get(id) } } },
  }
  const engine = createTaskGroups(api, () => clock)
  return { api, engine, tabs, groups, calls, windows, time: value => { clock = value } }
}
test('native identity is constrained to supported browsers and bounded geometry; labels remain plain short text', () => {
  assert.equal(browserTabIdentity({ ...identity, appId: 'com.other.app' }), undefined)
  assert.equal(browserTabIdentity({ ...identity, window: { ...identity.window, width: NaN } }), undefined)
  assert.equal(browserGroupTitle('  更新\n教程  '), '🤖 更新 教程')
  assert.equal(Array.from(browserGroupTitle('中'.repeat(100))).length, 30)
})
test('duplicate windows or duplicate matching tab titles never select a tab by order', () => {
  const f = fixture(); f.windows[0].tabs.push({ ...f.tabs.get(1), id: 2 })
  assert.equal(matchTab(f.windows, identity), undefined)
  f.windows[0].tabs.pop(); f.windows.push({ ...f.windows[0], id: 11 })
  assert.equal(matchTab(f.windows, identity), undefined)
})
test('a real group has the task purpose; subsequent tabs reuse that exact task/window group', async () => {
  const f = fixture()
  assert.equal((await f.engine.applyGroup(command)).status, 'grouped')
  assert.equal([...f.groups.values()][0].title, command.label)
  f.windows[0].tabs = [...f.tabs.values()]
  assert.equal((await f.engine.applyGroup({ ...command, id: 'second' })).status, 'grouped')
  assert.equal(f.groups.size, 1); assert.equal(f.calls[1].groupId, f.calls[0].groupId ?? 20)
})
test('user groups and user-renamed task groups are preserved', async () => {
  const f = fixture(); f.tabs.get(1).groupId = 9; f.windows[0].tabs = [...f.tabs.values()]
  assert.equal((await f.engine.applyGroup(command)).status, 'ambiguous'); assert.equal(f.calls.length, 0)
  f.tabs.get(1).groupId = -1
  assert.equal((await f.engine.applyGroup(command)).status, 'grouped')
  f.groups.get(20).title = '用户修改的名称'
  assert.equal((await f.engine.applyGroup(command)).status, 'ambiguous')
  assert.equal(f.groups.get(20).title, '用户修改的名称')
})
test('navigation, closure, pinned tabs and expiry refuse mutation before grouping', async () => {
  for (const change of ['navigation', 'closed', 'pinned', 'expired']) {
    const f = fixture()
    if (change === 'navigation') f.api.tabs.get = async () => ({ ...f.tabs.get(1), title: 'other' })
    if (change === 'closed') f.tabs.delete(1)
    if (change === 'pinned') f.windows[0].tabs[0].pinned = true
    if (change === 'expired') f.time(6000)
    assert.notEqual((await f.engine.applyGroup(command)).status, 'grouped', change)
    assert.equal(f.calls.length, 0, change)
  }
})
test('only children of an active task inherit its group; stop and unrelated new tabs do not', async () => {
  const f = fixture(); await f.engine.applyGroup(command)
  f.tabs.set(2, { id: 2, title: 'child', windowId: 10, groupId: -1 })
  await f.engine.onCreated({ ...f.tabs.get(2), openerTabId: 1 }); assert.equal(f.tabs.get(2).groupId, 20)
  f.tabs.set(3, { id: 3, windowId: 10, groupId: -1 })
  await f.engine.onCreated(f.tabs.get(3)); assert.equal(f.tabs.get(3).groupId, -1)
  f.engine.end(['task-a'])
  await f.engine.onCreated({ ...f.tabs.get(3), openerTabId: 1 }); assert.equal(f.tabs.get(3).groupId, -1)
})
test('a lost group update is unconfirmed and never retried as a new group', async () => {
  const f = fixture(); f.api.tabGroups.update = async () => { throw Error('lost receipt') }
  assert.equal((await f.engine.applyGroup(command)).status, 'unconfirmed'); assert.equal(f.calls.length, 1)
})
test('loopback bridge rejects webpage origins and returns only the authorized operation to its companion', async t => {
  const bridge = new BrowserTaskGroups(0); t.after(() => bridge.dispose())
  while (!bridge.status().port) await new Promise(resolve => setTimeout(resolve, 5))
  const base = 'http://127.0.0.1:' + bridge.status().port, extension = 'gkgmelkfmhlahgjdhhnjbgelgedcfeeb'
  const headers = { 'X-Qiuya-Extension': extension, Origin: 'chrome-extension://' + extension }
  assert.equal((await fetch(base + '/poll', { headers: { ...headers, Origin: 'https://attacker.example' } })).status, 403)
  const suffix = '?client=00000000-0000-0000-0000-000000000001&browser=chrome'
  const poll = fetch(base + '/poll' + suffix, { headers }).then(r => r.json())
  while (!bridge.status().connected) await new Promise(resolve => setTimeout(resolve, 5))
  const pending = bridge.group(identity, 'private-session-id', '更新视频教程')
  const sent = await poll
  assert.equal(sent.label, '🤖 更新视频教程'); assert.notEqual(sent.operation, 'private-session-id'); assert.equal(sent.tab.title, identity.title)
  await fetch(base + '/reply' + suffix, { method: 'POST', headers, body: JSON.stringify({ id: sent.id, status: 'grouped' }) })
  assert.equal((await pending).status, 'grouped')
  const ending = fetch(base + '/poll' + suffix, { headers }).then(r => r.json())
  bridge.end('private-session-id')
  assert.equal((await ending).kind, 'end')
})

test('task stop during a pending browser query prevents late child grouping', async () => {
  const f = fixture(); await f.engine.applyGroup(command)
  f.tabs.set(2, { id: 2, title: 'child', windowId: 10, groupId: -1 })
  const get = f.api.tabGroups.get
  let resume, started
  const pending = new Promise(resolve => { resume = resolve }), querying = new Promise(resolve => { started = resolve })
  f.api.tabGroups.get = async id => { started(); await pending; return get(id) }
  const child = f.engine.onCreated({ ...f.tabs.get(2), openerTabId: 1 })
  await querying
  f.engine.end(['task-a']); resume(); await child
  assert.equal(f.tabs.get(2).groupId, -1)
  assert.equal(f.calls.length, 1)
})
