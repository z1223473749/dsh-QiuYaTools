import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { captureHarnessWorkspaceDom, registerHarnessWorkspace, selectedHarnessWorkspaceSession } from './fixtures/harness-workspace-prerequisite.mjs'

const workspace = { workspaceId: 'workspace-own', path: 'C:\\test-own\\workspace-uuid', title: 'workspace-uuid', sessionIds: [] }
function pageWith(result, observe = () => {}) {
  return { evaluate: (fn, path) => runInNewContext('(' + fn.toString() + ')(path)', {
    path, AbortSignal, crypto: { randomUUID: () => 'rpc-own' }, fetch: async (url, options) => {
      observe(url, JSON.parse(options.body), options)
      return { ok: true, status: 200, json: async () => result }
    },
  }) }
}
test('workspace setup uses the documented public Connection envelope with only the own path', async () => {
  let request
  const value = await registerHarnessWorkspace(pageWith({ type: 'server-response', rpcId: 'rpc-own', result: { ok: true, value: { workspace, created: true } } }, (url, body, options) => { request = { url, body, options } }), workspace.path)
  assert.equal(request.url, '/api/workspace/create')
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(request.body, { type: 'client-request', rpcId: 'rpc-own', method: 'workspace/create', payload: { args: { request: { path: workspace.path } } } })
  assert.equal(request.options.headers['content-type'], 'application/json')
  assert.equal(Object.hasOwn(request.options.headers, 'cookie'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { workspaceId: workspace.workspaceId, path: workspace.path, title: workspace.title, created: true })
})
test('workspace setup refuses unrelated replies, another directory and explicit Host failure', async () => {
  for (const [response, message] of [
    [{ type: 'server-response', rpcId: 'other', result: { ok: true, value: { workspace } } }, /uncorrelated/u],
    [{ type: 'server-response', rpcId: 'rpc-own', result: { ok: true, value: { workspace: { ...workspace, path: 'C:\\other' } } } }, /different directory/u],
    [{ type: 'server-response', rpcId: 'rpc-own', result: { ok: false, error: { code: 'workspace/invalid-path' } } }, /workspace\/invalid-path/u],
  ]) await assert.rejects(registerHarnessWorkspace(pageWith(response), workspace.path), message)
})
test('blank readiness cannot accept another workspace, a stale row or a blocked composer', () => {
  const ready = { workspaceChips: [{ visible: true, text: workspace.title }], rows: [{ key: 'workspace:' + workspace.workspaceId, visible: true }, { key: 'session:session-own', visible: true, selected: 'true', draggable: false }], conversations: [{ visible: true, phase: 'hero', sessionId: 'session-own', composers: [{ visible: true, editable: 'true', textLength: 0 }] }] }
  assert.equal(selectedHarnessWorkspaceSession(ready, workspace), 'session-own')
  for (const mutation of [
    state => { state.workspaceChips[0].text = 'other-workspace' },
    state => { state.rows[1].key = 'session:stale' },
    state => { state.rows[1].draggable = true },
    state => { state.conversations[0].composers[0].editable = 'false' },
    state => { state.conversations[0].composers[0].textLength = 3 },
  ]) { const state = structuredClone(ready); mutation(state); assert.equal(selectedHarnessWorkspaceSession(state, workspace), undefined) }
})
test('DOM diagnostics retain public identity and readiness attributes without editor contents or credentials', () => {
  const dom = new JSDOM('<div data-conversation-content data-conversation-session="session-own" data-content-phase="hero"><div data-composer-input contenteditable="false" aria-label="选择一个工作区开始">private draft</div></div><div data-row-key="session-own" aria-selected="true"></div><button aria-haspopup="menu" aria-label="选择工作区">workspace-uuid</button><input value="credential-secret">', { runScripts: 'outside-only' })
  dom.window.Element.prototype.getClientRects = () => [{ width: 1, height: 1 }]
  const state = dom.window.eval('(' + captureHarnessWorkspaceDom.toString() + ')()')
  assert.equal(state.conversations[0].sessionId, 'session-own')
  assert.equal(state.conversations[0].composers[0].editable, 'false')
  assert.equal(state.conversations[0].composers[0].textLength, 13)
  assert.equal(state.workspaceChips[0].text, workspace.title)
  assert.doesNotMatch(JSON.stringify(state), /private draft|credential-secret/u)
  dom.window.close()
})
