import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/panel.tsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })).outputFiles[0].text
const module = { exports: {} }
new Function('require', 'module', 'exports', source)(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: ({ checked, disabled, label, onChange }) => React.createElement('button', { role: 'switch', 'aria-label': label, 'aria-checked': checked, disabled, onClick: () => onChange(!checked) }) } : require(id), module, module.exports)
const tick = () => new Promise(done => setImmediate(done))
const request = (sessionId, extra = {}) => ({ requestId: `request-${sessionId}`, requestVersion: 1, sessionId, appId: 'fixture.app', appName: '自有应用', reason: '填写任务表格', createdAt: Date.now(), expiresAt: Date.now() + 60000, state: 'pending', ...extra })
async function fixture(t, { native = { platform: 'win32', available: true }, enabled = true, activeSessionId } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1/' })
  const saved = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const calls = [], changes = [], plans = [], listeners = new Set(), status = { sessions: [], allowedApps: [], native, pendingRequests: [], environments: [] }
  const current = { value: activeSessionId }, applications = [{ appId: 'fixture.app', name: '自有应用', running: true }]
  const ctx = { get(name) {
    if (name === 'uiSession') return { adapter: { current: { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => ({ key: current.value }) } } }
    if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: { A: { displayTitle: '自有聊天 A' }, B: { displayTitle: '自有聊天 B' } }, ids: ['A', 'B'] }) } }
    if (name === 'connection') return { rpc: { async call(channel, endpoint, input) {
      assert.equal(channel, '/api'); assert.equal(endpoint, 'qiuya-tools.computer.control'); calls.push(structuredClone(input))
      const planned = plans.findIndex(row => row.op === input.op); if (planned >= 0) return plans.splice(planned, 1)[0].promise
      if (input.op === 'status') return { ok: true, value: structuredClone(status) }
      if (input.op === 'applications') return { ok: true, value: structuredClone(applications) }
      if (input.op === 'allow') { status.allowedApps = input.allowed ? [...status.allowedApps, input.appId] : status.allowedApps.filter(id => id !== input.appId); return { ok: true, value: {} } }
      if (input.op === 'decide') status.pendingRequests = status.pendingRequests.filter(row => row.requestId !== input.requestId)
      assert.ok(['openSettings', 'decide', 'pause', 'resume', 'preview', 'redock', 'stop', 'connect'].includes(input.op), `Unexpected mutation ${input.op}`)
      return { ok: true, value: {} }
    } } }
  } }
  const root = createRoot(dom.window.document.querySelector('#root'))
  const render = async () => act(async () => { root.render(React.createElement(module.exports.ComputerPanel, { ctx, enabled, disabled: false, onEnabled: value => changes.push(value) })); await tick() })
  const button = label => [...dom.window.document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  const click = async label => { const node = button(label); assert.ok(node, `${label} must exist`); await act(async () => { node.click(); await tick() }) }
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] })
  return { dom, status, applications, calls, changes, render, button, click,
    plan(op) { let resolve; const promise = new Promise(done => { resolve = done }); plans.push({ op, promise }); return resolve },
    async switchSession(value) { await act(async () => { current.value = value; for (const listener of listeners) listener(); await tick() }) },
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
  assert.equal(form.querySelector('select').options[0].textContent, '自有应用')
  await act(async () => { form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })); await tick() })
  assert.deepEqual(f.mutations().at(-1), { op: 'allow', appId: 'fixture.app', allowed: true })
  assert.equal(f.dom.window.document.querySelector('form'), null)
  await f.click('撤销 自有应用'); assert.deepEqual(f.mutations().at(-1), { op: 'allow', appId: 'fixture.app', allowed: false })
  assert.match(f.dom.window.document.querySelector('[aria-label="始终允许的应用"]').textContent, /暂无持续授权/u)
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
