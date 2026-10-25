import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'

// ReactDOM detects native input support at import time. Give that detection a
// real DOM so focus does not activate its legacy IE attachEvent polyfill.
const detectionDom = new JSDOM(''), detectionSaved = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.assign(globalThis, { window: detectionDom.window, document: detectionDom.window.document })
const { createRoot } = await import('react-dom/client')
detectionDom.window.close()
for (const [key, descriptor] of detectionSaved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]

const require = createRequire(import.meta.url)
const { Simulate } = require('react-dom/test-utils')
const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/panel.tsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })).outputFiles[0].text
const module = { exports: {} }
new Function('require', 'module', 'exports', source)(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: ({ checked, disabled, label, onChange }) => React.createElement('button', { role: 'switch', 'aria-label': label, 'aria-checked': checked, disabled, onClick: () => onChange(!checked) }) } : require(id), module, module.exports)
const tick = () => new Promise(done => setImmediate(done))
const request = (sessionId, extra = {}) => ({ requestId: `request-${sessionId}`, requestVersion: 1, sessionId, appId: 'fixture.app', appName: '自有应用', reason: '填写任务表格', createdAt: Date.now(), expiresAt: Date.now() + 60000, state: 'pending', ...extra })
async function fixture(t, { native = { platform: 'win32', available: true }, enabled = true, activeSessionId, delayedEnabled = false } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1/' })
  const saved = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const calls = [], changes = [], plans = [], listeners = new Set(), settingsWrites = [], status = { sessions: [], allowedApps: [], native, pendingRequests: [], environments: [] }
  const current = { value: activeSessionId }, applications = [{ appId: 'fixture.app', name: '自有应用', running: true }]
  const ctx = { get(name) {
    if (name === 'uiSession') return { adapter: { current: { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => ({ key: current.value }) } } }
    if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: { A: { displayTitle: '自有聊天 A' }, B: { displayTitle: '自有聊天 B' } }, ids: ['A', 'B'] }) } }
    if (name === 'connection') return { rpc: { async call(channel, endpoint, input) {
      assert.equal(channel, '/api'); assert.equal(endpoint, 'qiuya-tools.computer.control'); calls.push(structuredClone(input))
      const planned = plans.findIndex(row => row.op === input.op); if (planned >= 0) return plans.splice(planned, 1)[0].promise
      if (input.op === 'status') return { ok: true, value: structuredClone(status) }
      if (input.op === 'applications') return { ok: true, value: structuredClone(applications) }
      if (input.op === 'exchange') return { ok: true, value: { enabled: true, files: [], maxBytes: 8388608, chunkBytes: 131072 } }
      if (input.op === 'connect') status.environments = [...status.environments.filter(row => row.sessionId !== input.sessionId), { sessionId: input.sessionId, mode: input.mode }]
      if (input.op === 'allow') { status.allowedApps = input.allowed ? [...status.allowedApps, input.appId] : status.allowedApps.filter(id => id !== input.appId); return { ok: true, value: {} } }
      if (input.op === 'decide') status.pendingRequests = status.pendingRequests.filter(row => row.requestId !== input.requestId)
      assert.ok(['openSettings', 'decide', 'pause', 'resume', 'preview', 'redock', 'stop', 'connect'].includes(input.op), `Unexpected mutation ${input.op}`)
      return { ok: true, value: {} }
    } } }
  } }
  const root = createRoot(dom.window.document.querySelector('#root'))
  function SettingsHost() {
    const [persisted, setPersisted] = React.useState(enabled)
    return React.createElement(module.exports.ComputerPanel, { ctx, enabled: persisted, disabled: false, onEnabled(value) {
      changes.push(value)
      if (delayedEnabled) { let resolve; const saved = new Promise(done => { resolve = done }); settingsWrites.push(resolve); void saved.then(() => setPersisted(value)) }
    } })
  }
  const render = async () => act(async () => { root.render(React.createElement(SettingsHost)); await tick() })
  const button = label => [...dom.window.document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  const click = async label => { const node = button(label); assert.ok(node, `${label} must exist`); await act(async () => { node.click(); await tick() }) }
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] })
  return { dom, status, applications, calls, changes, render, button, click,
    plan(op) { let resolve; const promise = new Promise(done => { resolve = done }); plans.push({ op, promise }); return resolve },
    async switchSession(value) { await act(async () => { current.value = value; for (const listener of listeners) listener(); await tick() }) },
    async persistEnabled() { assert.ok(settingsWrites.length); await act(async () => { settingsWrites.shift()(); await tick() }) },
    async environment(value) { const select = [...dom.window.document.querySelectorAll('select')].find(node => [...node.options].some(option => option.value === 'remote')); await act(async () => { Simulate.change(select, { target: { value } }); await tick() }) },
    async edit(label, value) { const field = [...dom.window.document.querySelectorAll('label')].find(node => node.firstChild?.textContent === label)?.querySelector('input,textarea'); assert.ok(field, `${label} must exist`); await act(async () => { Simulate.change(field, { target: { value } }); await tick() }) },
    mutations: () => calls.filter(row => !['status', 'applications'].includes(row.op)) }
}

test('computer toolbox opens with global switch and automatic task guidance; advanced environments are collapsed without chat or target setup', async t => {
  const f = await fixture(t); await f.render()
  assert.equal(f.button('启用电脑操控').getAttribute('aria-checked'), 'true')
  assert.match(f.dom.window.document.body.textContent, /模型会自动请求所需应用/u)
  assert.equal(f.dom.window.document.querySelector('details').open, false)
  assert.equal(f.dom.window.document.querySelector('select[aria-label="关联聊天"],select[aria-label="控制目标"]'), null)
  assert.equal(f.button('连接当前聊天的环境').disabled, true)
  assert.equal(f.calls.filter(row => row.op === 'applications').length, 1, 'display names load without opening the add form'); assert.equal(f.dom.window.document.querySelector('form'), null)
  assert.equal(f.calls[0].sessionId, undefined, 'owner overview works without selecting a chat')
  await f.click('启用电脑操控'); assert.deepEqual(f.changes, [false]); assert.deepEqual(f.mutations(), [])
})

test('system permission shortcuts never grant themselves, and Windows shows no fictitious macOS settings', async t => {
  const f = await fixture(t, { native: { platform: 'darwin', permissions: { screenRecording: false, accessibility: false, postEvents: false, inputMonitoring: false } } }); await f.render()
  for (const [name, kind] of [['屏幕录制', 'screenRecording'], ['辅助功能', 'accessibility'], ['输入监控', 'inputMonitoring']]) {
    await f.click(`前往开启${name}`); assert.deepEqual(f.mutations().at(-1), { op: 'openSettings', kind })
  }
  assert.equal(f.dom.window.document.querySelector('[aria-label="系统权限"]').textContent.includes('未允许'), true)
  f.status.native = { platform: 'win32', available: false, permissions: { screenRecording: false, accessibility: false }, message: '当前桌面受限，请返回交互桌面。' }
  await f.click('重新检查')
  assert.equal(f.dom.window.document.querySelector('[aria-label="系统权限引导"]'), null)
  assert.match(f.dom.window.document.querySelector('[aria-label="系统权限"]').textContent, /当前桌面受限/u)
  assert.equal(f.mutations().length, 3)
})

test('manual persistent app list adds and revokes by application identity', async t => {
  const f = await fixture(t); await f.render(); await f.click('添加应用')
  const form = f.dom.window.document.querySelector('form'); assert.ok(form)
  assert.equal(form.querySelector('select'), null)
  assert.equal(f.button('添加应用').disabled, true, 'an open picker cannot start a second load that would reopen after Cancel')
  assert.equal(f.dom.window.document.activeElement, form.querySelector('[aria-label="搜索应用"]'), 'search gains focus after the pending discovery finishes')
  assert.equal(form.querySelector('[role="option"]').textContent, '自有应用运行中')
  assert.equal(f.button('始终允许').disabled, true, 'opening the list never preselects an app to authorize')
  await f.click('自有应用运行中')
  await act(async () => { form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })); await tick() })
  assert.deepEqual(f.mutations().at(-1), { op: 'allow', appId: 'fixture.app', allowed: true })
  assert.equal(f.dom.window.document.querySelector('form'), null)
  await f.click('撤销 自有应用'); assert.deepEqual(f.mutations().at(-1), { op: 'allow', appId: 'fixture.app', allowed: false })
  assert.match(f.dom.window.document.querySelector('[aria-label="始终允许的应用"]').textContent, /暂无持续授权/u)
})

test('application picker searches names and identities, clears hidden selection, and grants only after explicit confirmation', async t => {
  const f = await fixture(t)
  f.applications.push({ appId: 'org.mozilla.firefox', name: 'Firefox', running: false }, { appId: 'com.example.editor', name: '工具箱编辑器', running: false })
  await f.render(); await f.click('添加应用')
  const field = f.dom.window.document.querySelector('[role="combobox"][aria-label="搜索应用"]')
  const search = async value => act(async () => { Simulate.change(field, { target: { value } }); await tick() })
  await search('ＦＩＲＥＦＯＸ')
  assert.deepEqual([...f.dom.window.document.querySelectorAll('[role="option"]')].map(node => node.textContent), ['Firefox'])
  await act(async () => { Simulate.keyDown(field, { key: 'Enter', preventDefault() {} }); await tick() })
  assert.equal(f.button('始终允许').disabled, false); assert.deepEqual(f.mutations(), [], 'Enter in search selects without granting')
  await search('com.example')
  assert.equal(f.button('始终允许').disabled, true, 'a previous hidden selection must not remain authorizable')
  assert.equal(f.dom.window.document.querySelector('[role="option"]').textContent, '工具箱编辑器')
  await f.click('工具箱编辑器'); await f.click('始终允许')
  assert.deepEqual(f.mutations(), [{ op: 'allow', appId: 'com.example.editor', allowed: true }])
})

test('adding an application during automatic catalog discovery shares the in-flight read instead of racing the native catalog', async t => {
  const f = await fixture(t), finish = f.plan('applications')
  await f.render(); await f.click('添加应用')
  assert.equal(f.calls.filter(row => row.op === 'applications').length, 1)
  assert.equal(f.dom.window.document.querySelector('form'), null)
  await act(async () => { finish({ ok: true, value: structuredClone(f.applications) }); await tick() })
  assert.ok(f.dom.window.document.querySelector('form'))
  assert.equal(f.dom.window.document.querySelectorAll('[role="option"]').length, 1)
  assert.deepEqual(f.mutations(), [])
})

test('a late current-chat initialization cannot discard the owner application-picker read', async t => {
  const f = await fixture(t), finish = f.plan('applications')
  await f.render(); await f.click('添加应用'); await f.switchSession('A')
  await act(async () => { finish({ ok: true, value: structuredClone(f.applications) }); await tick() })
  assert.ok(f.dom.window.document.querySelector('form'), 'this is an owner-wide picker, independent of the current chat seat')
  assert.equal(f.calls.filter(row => row.op === 'applications').length, 1)
  assert.deepEqual(f.mutations(), [])
})

test('application picker handles keyboard navigation, no matches, clear and cancel without granting', async t => {
  const f = await fixture(t); f.applications.push({ appId: 'fixture.second', name: '第二个应用', running: false })
  await f.render(); await f.click('添加应用')
  const field = f.dom.window.document.querySelector('[aria-label="搜索应用"]')
  const key = async value => act(async () => { Simulate.keyDown(field, { key: value, preventDefault() {} }); await tick() })
  await key('ArrowDown'); await key('Enter')
  assert.equal(f.dom.window.document.querySelector('[aria-selected="true"][role="option"]').textContent, '第二个应用✓')
  assert.equal(f.dom.window.document.getElementById(field.getAttribute('aria-activedescendant')).getAttribute('aria-selected'), 'true')
  await act(async () => { Simulate.change(field, { target: { value: '不存在' } }); await tick() })
  assert.match(f.dom.window.document.querySelector('form').textContent, /未找到匹配的应用/u)
  assert.equal(field.hasAttribute('aria-activedescendant'), false); await key('Enter'); assert.deepEqual(f.mutations(), [])
  await f.click('清除搜索'); assert.equal(field.value, ''); assert.equal(f.dom.window.document.querySelectorAll('[role="option"]').length, 2)
  await key('Escape'); assert.equal(f.dom.window.document.querySelector('form'), null); assert.deepEqual(f.mutations(), [])
})

test('application icons display a valid embedded PNG, with fallback for missing or failed images', async t => {
  const f = await fixture(t), iconDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWr8AAAAASUVORK5CYII='
  f.applications[0].iconDataUrl = iconDataUrl
  f.applications.push({ appId: 'missing', name: '无图标', running: false, iconDataUrl: 'https://invalid.example/icon.png' })
  await f.render(); await f.click('添加应用')
  const options = f.dom.window.document.querySelectorAll('[role="option"]'), image = options[0].querySelector('img')
  assert.equal(image.src, iconDataUrl); assert.equal(options[1].querySelector('img'), null); assert.ok(options[1].querySelector('.qyt-application-icon svg'))
  await act(async () => { Simulate.error(image); await tick() })
  assert.equal(options[0].querySelector('img'), null); assert.ok(options[0].querySelector('.qyt-application-icon svg'))
  assert.deepEqual(f.mutations(), [])
})

test('IME candidate keys stay with the input method and cannot select, cancel or grant an application', async t => {
  const f = await fixture(t); await f.render(); await f.click('添加应用')
  const field = f.dom.window.document.querySelector('[aria-label="搜索应用"]'), form = field.closest('form')
  await act(async () => { Simulate.compositionStart(field); await tick() })
  for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp']) await act(async () => { Simulate.keyDown(field, { key, nativeEvent: { isComposing: true } }); await tick() })
  assert.ok(f.dom.window.document.querySelector('form')); assert.equal(form.querySelector('[role="option"][aria-selected="true"]'), null)
  await act(async () => { form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })); Simulate.compositionEnd(field); Simulate.keyDown(field, { key: 'Enter', keyCode: 229 }); await tick() })
  assert.equal(f.button('始终允许').disabled, true); assert.deepEqual(f.mutations(), [])
})

test('global pending approvals use their own device preflight and exact request identity, independent from the local Mac', async t => {
  const f = await fixture(t, { native: { platform: 'darwin', permissions: { screenRecording: false, accessibility: false } } })
  f.status.pendingRequests = [request('A', { preflight: { platform: 'win32', mode: 'remote', available: true } })]
  await f.render()
  assert.equal(f.button('允许一次').disabled, false)
  await f.click('允许一次')
  assert.deepEqual(f.mutations(), [{ op: 'decide', sessionId: 'A', requestId: 'request-A', requestVersion: 1, decision: 'once' }])
})

test('task overview routes controls to each original chat and exposes stable Chinese state semantics', async t => {
  const f = await fixture(t); f.status.sessions = [{ sessionId: 'B', state: 'paused', epoch: 2, updatedAt: 1 }]; await f.render()
  const task = f.dom.window.document.querySelector('[data-qyt-computer-session="B"]')
  assert.equal(task.dataset.state, 'paused'); assert.match(task.textContent, /自有聊天 B.*已暂停/u)
  for (const [label, op] of [['继续', 'resume'], ['弹出预览', 'preview'], ['收回聊天', 'redock'], ['停止', 'stop']]) { await f.click(label); assert.deepEqual(f.mutations().at(-1), { op, sessionId: 'B' }) }
})


test('persistent application approval remains revocable while the global control switch is off', async t => {
  const f = await fixture(t, { enabled: false }); f.status.allowedApps = ['fixture.app']; await f.render()
  assert.equal(f.button('添加应用').disabled, true)
  assert.equal(f.button('撤销 fixture.app').disabled, false)
  await f.click('撤销 fixture.app'); assert.deepEqual(f.mutations(), [{ op: 'allow', appId: 'fixture.app', allowed: false }])
})


test('remote Mac request explains permissions on the independent computer and never opens this Mac Settings', async t => {
  const f = await fixture(t); f.status.pendingRequests = [request('A', { preflight: { platform: 'darwin', mode: 'remote', permissions: { screenRecording: false, accessibility: false } } })]
  await f.render(); assert.equal(f.button('允许一次').disabled, true); assert.equal(f.button('拒绝').disabled, false)
  assert.match(f.dom.window.document.body.textContent, /请在独立电脑上开启以下权限/u)
  assert.equal(f.button('前往开启屏幕录制'), undefined); await f.click('刷新权限')
  assert.deepEqual(f.mutations(), [])
})


test('late controls from the previous current-chat seat cannot unlock a new pending owner action', async t => {
  const f = await fixture(t, { activeSessionId: 'A' }); f.status.sessions = [{ sessionId: 'B', state: 'running', epoch: 2, updatedAt: 1 }]; await f.render()
  const old = f.plan('pause'); await f.click('暂停')
  await f.switchSession('B'); const fresh = f.plan('stop'); await f.click('停止')
  assert.equal(f.button('停止').disabled, true)
  const before = f.calls.length
  await act(async () => { old({ ok: true, value: {} }); await tick() })
  assert.equal(f.button('停止').disabled, true); assert.equal(f.calls.length, before)
  await act(async () => { fresh({ ok: true, value: {} }); await tick() })
  assert.equal(f.button('停止').disabled, false)
  assert.deepEqual(f.mutations(), [{ op: 'pause', sessionId: 'B' }, { op: 'stop', sessionId: 'B' }])
})


test('disabled owner overview follows the real Host contract and explains the prerequisite instead of pretending to check permissions', async t => {
  const f = await fixture(t, { enabled: false, native: null }); await f.render()
  const permissions = f.dom.window.document.querySelector('[aria-label="系统权限"]')
  assert.match(permissions.textContent, /启用电脑操控后，可检查并设置系统权限。/u)
  assert.equal(f.button('重新检查').disabled, true)
  assert.equal(permissions.textContent.includes('正在检查'), false)
  assert.equal(permissions.querySelector('[aria-label="系统权限引导"]'), null)
  assert.deepEqual(f.mutations(), []); assert.equal(f.calls.some(row => row.op === 'applications'), false)
})

test('delayed enabled persistence preserves the selected remote draft and never dispatches an unintended local connection', async t => {
  const f = await fixture(t, { enabled: false, activeSessionId: 'A', delayedEnabled: true }); await f.render()
  await f.click('启用电脑操控')
  await f.environment('remote'); await f.edit('配对地址', 'https://fixture-a.invalid/v1/computer'); await f.edit('配对密钥', 'fixture-pair-a')
  assert.equal(f.button('连接当前聊天的环境').disabled, true, 'the feature must wait for actual persisted enablement')
  await f.persistEnabled(); await f.click('连接当前聊天的环境')
  const connections = f.calls.filter(row => row.op === 'connect')
  assert.equal(connections.length, 1)
  assert.equal(connections[0].mode, 'remote', 'a settings readback must not turn a prepared remote request into a local connection')
  assert.equal(connections[0].sessionId, 'A'); assert.equal(connections[0].endpoint, 'https://fixture-a.invalid/v1/computer'); assert.equal(connections[0].token, 'fixture-pair-a')
  assert.ok(f.button('检查并刷新交换目录'))
  await f.click('检查并刷新交换目录')
  assert.deepEqual(f.calls.filter(row => row.op === 'exchange').map(row => [row.sessionId, row.request.action]), [['A', 'status'], ['A', 'list']])
})

test('a real current-chat change invalidates remote credentials without replacing the chosen environment by local', async t => {
  const f = await fixture(t, { activeSessionId: 'A' }); await f.render()
  await f.environment('remote'); await f.edit('配对地址', 'https://fixture-a.invalid/v1/computer'); await f.edit('配对密钥', 'fixture-pair-a')
  await f.switchSession('B'); await f.click('连接当前聊天的环境')
  assert.deepEqual(f.calls.filter(row => row.op === 'connect'), [], 'switching chats must not make the old Connect button issue a default local request')
  const selected = [...f.dom.window.document.querySelectorAll('select')].find(node => [...node.options].some(option => option.value === 'remote'))
  assert.equal(selected.value, 'remote'); assert.equal(f.dom.window.document.querySelector('input[type=password]').value, '')
  assert.equal(f.button('连接当前聊天的环境').disabled, true)
  await f.edit('配对地址', 'https://fixture-b.invalid/v1/computer'); await f.edit('配对密钥', 'fixture-pair-b'); await f.click('连接当前聊天的环境')
  const connected = f.calls.filter(row => row.op === 'connect'); assert.equal(connected.length, 1)
  assert.equal(connected[0].sessionId, 'B'); assert.equal(connected[0].mode, 'remote'); assert.equal(connected[0].endpoint, 'https://fixture-b.invalid/v1/computer'); assert.equal(connected[0].token, 'fixture-pair-b')
})

test('a same-chat seat notification and late status response preserve the remote draft without dispatching a connection', async t => {
  const f = await fixture(t, { activeSessionId: 'A' }); await f.render()
  await f.environment('remote'); await f.edit('配对地址', 'https://fixture-a.invalid/v1/computer'); await f.edit('配对密钥', 'fixture-pair-a')
  const response = f.plan('status'); await f.click('重新检查'); await f.switchSession('A')
  await act(async () => { response({ ok: true, value: structuredClone(f.status) }); await tick() })
  assert.equal(f.calls.filter(row => row.op === 'connect').length, 0)
  await f.click('连接当前聊天的环境')
  assert.equal(f.calls.filter(row => row.op === 'connect').at(-1).mode, 'remote')
  assert.equal(f.calls.filter(row => row.op === 'connect').at(-1).token, 'fixture-pair-a')
})

test('a scoped file exchange never falls back to another chat or the legacy remote connection', async t => {
  const f = await fixture(t, { activeSessionId: 'B', native: { platform: 'win32', available: true, mode: 'remote' } })
  f.status.environments = [{ sessionId: 'A', mode: 'remote' }]; await f.render(); await f.environment('remote')
  assert.equal(!!f.button('检查并刷新交换目录'), false, 'global remote metadata does not authorize the selected chat file area')
  assert.deepEqual(f.calls.filter(row => row.op === 'exchange'), [])
  await f.edit('配对地址', 'https://fixture-b.invalid/v1/computer'); await f.edit('配对密钥', 'fixture-pair-b'); await f.click('连接当前聊天的环境')
  await f.click('检查并刷新交换目录')
  assert.deepEqual(f.calls.filter(row => row.op === 'exchange').map(row => row.sessionId), ['B', 'B'])
})

test('the disabled panel hides exchange even when historical selected-chat remote metadata remains', async t => {
  const f = await fixture(t, { activeSessionId: 'A', enabled: false, native: { platform: 'win32', mode: 'remote' } })
  f.status.environments = [{ sessionId: 'A', mode: 'remote' }]; await f.render(); await f.environment('remote')
  assert.equal(!!f.button('检查并刷新交换目录'), false)
  assert.deepEqual(f.calls.filter(row => row.op === 'exchange'), [])
})

test('changing chats clears browser origin and CDP drafts before a new environment can be connected', async t => {
  const f = await fixture(t, { activeSessionId: 'A' }); await f.render(); await f.environment('browser')
  await f.edit('允许的网站来源（每行一个）', 'https://fixture-a.invalid'); await f.edit('起始页面', 'https://fixture-a.invalid/page'); await f.edit('本机调试地址（可选）', 'http://127.0.0.1:9222')
  await f.switchSession('B'); await f.environment('browser'); await f.click('连接当前聊天的环境')
  assert.deepEqual(f.calls.filter(row => row.op === 'connect'), [], 'old browser origins/CDP cannot be silently inherited by a different chat')
  assert.equal(f.dom.window.document.querySelector('textarea').value, '')
})

for (const order of ['enabled-first', 'seat-first']) test(`late initial current-chat notification and enabled persistence cannot connect a draft to the wrong mode (${order})`, async t => {
  const f = await fixture(t, { enabled: false, delayedEnabled: true }); await f.render(); await f.click('启用电脑操控')
  await f.environment('remote'); await f.edit('配对地址', 'https://unbound-fixture.invalid/v1/computer'); await f.edit('配对密钥', 'fixture-unbound-pair')
  if (order === 'enabled-first') { await f.persistEnabled(); await f.switchSession('A') } else { await f.switchSession('A'); await f.persistEnabled() }
  await f.click('连接当前聊天的环境')
  assert.deepEqual(f.calls.filter(row => row.op === 'connect'), [], 'unbound credentials are invalidated instead of becoming a default Local request')
  const select = [...f.dom.window.document.querySelectorAll('select')].find(node => [...node.options].some(option => option.value === 'remote'))
  assert.equal(select.value, 'remote'); assert.equal(f.dom.window.document.querySelector('input[type=password]').value, '')
  assert.equal(f.button('连接当前聊天的环境').disabled, true)
})

test('macOS browser approval and full settings view never invent native TCC prerequisites', async t => {
  const f = await fixture(t, { native: { platform: 'darwin', mode: 'browser', available: true, permissions: {} } })
  f.status.pendingRequests = [request('A', { preflight: { platform: 'darwin', mode: 'browser', available: true, permissions: {} } })]
  await f.render(); assert.equal(f.button('允许一次').disabled, false); assert.equal(f.button('始终允许').disabled, false)
  assert.equal(f.dom.window.document.querySelector('[aria-label="系统权限引导"]'), null)
  await f.click('允许一次'); assert.deepEqual(f.mutations(), [{ op: 'decide', sessionId: 'A', requestId: 'request-A', requestVersion: 1, decision: 'once' }])
})

test('browser overview cannot unlock a remote macOS native request with missing TCC permissions', async t => {
  const f = await fixture(t, { native: { platform: 'darwin', mode: 'browser', available: true, permissions: {} } })
  f.status.pendingRequests = [request('B', { preflight: { platform: 'darwin', mode: 'remote', available: true, permissions: {} } })]
  await f.render(); assert.equal(f.button('允许一次').disabled, true); assert.equal(f.button('始终允许').disabled, true)
  assert.match(f.dom.window.document.body.textContent, /请在独立电脑上开启以下权限/u)
  assert.equal(f.button('前往开启辅助功能'), undefined)
  await f.click('允许一次'); assert.deepEqual(f.mutations(), [])
})
