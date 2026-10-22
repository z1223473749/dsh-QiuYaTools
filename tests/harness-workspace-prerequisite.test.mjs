import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { EventEmitter } from 'node:events'
import { captureHarnessWorkspaceDom, registerHarnessWorkspace, selectedHarnessWorkspaceSession, waitForHarnessNewBlankSession, navigateHarnessPage, sanitizeHarnessDiagnostic } from './fixtures/harness-workspace-prerequisite.mjs'

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

const blankSnapshot = id => ({ conversations: [{ sessionId: id, phase: 'hero', visible: true, composers: [{ editable: 'true', visible: true, textLength: 0 }] }], rows: [{ key: 'session:' + id, selected: 'true', draggable: false, visible: true }] })
test('new-session readiness ignores a stable old empty composer until the clicked new identity arrives', async () => {
  let clock = 0, clicks = 1, reads = 0
  const before = blankSnapshot('session-old')
  const id = await waitForHarnessNewBlankSession(() => { reads++; return blankSnapshot(clock < 1800 ? 'session-old' : 'session-new') }, before, { now: () => clock, sleep: async milliseconds => { clock += milliseconds } })
  assert.equal(id, 'session-new')
  assert.equal(clock, 2600, 'The old empty hero must not be accepted at 750 ms')
  assert.equal(clicks, 1, 'The observation helper does not repeat the click or type a prompt')
  assert.equal(reads, 27)
})
test('new-session readiness rejects known sidebar identities, mismatched selection and restored drafts', async () => {
  let clock = 0
  const before = blankSnapshot('session-old'); before.rows.push({ key: 'session:known-other', selected: 'false', visible: true, draggable: true })
  const id = await waitForHarnessNewBlankSession(() => {
    if (clock < 1000) return blankSnapshot('known-other')
    const snapshot = blankSnapshot('session-new')
    if (clock < 2000) snapshot.rows[0].key = 'session:session-old'
    else if (clock < 3000) snapshot.conversations[0].composers[0].textLength = 4
    return snapshot
  }, before, { now: () => clock, sleep: async milliseconds => { clock += milliseconds } })
  assert.equal(id, 'session-new')
  assert.equal(clock, 3800)
})
test('a changing new identity restarts stability while keeping the original 15-second deadline', async () => {
  let clock = 0
  const before = blankSnapshot('session-old')
  const id = await waitForHarnessNewBlankSession(() => blankSnapshot(clock < 500 ? 'session-new-1' : 'session-new-2'), before, { now: () => clock, sleep: async milliseconds => { clock += milliseconds } })
  assert.equal(id, 'session-new-2')
  assert.equal(clock, 1300)
  clock = 0
  await assert.rejects(waitForHarnessNewBlankSession(() => blankSnapshot('session-changing-' + clock), before, { now: () => clock, sleep: async milliseconds => { clock += milliseconds } }), /within 15000 ms; no input was sent/u)
  assert.equal(clock, 15000)
})
test('a late DOM read cannot turn an over-budget new-session handoff into success', async () => {
  let clock = 0
  await assert.rejects(waitForHarnessNewBlankSession(() => { const snapshot = blankSnapshot('session-new'); clock += 8000; return snapshot }, blankSnapshot('session-old'), { now: () => clock, sleep: async milliseconds => { clock += milliseconds } }), /within 15000 ms/u)
  assert.equal(clock, 16100)
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
  assert.equal(sanitizeHarnessDiagnostic('Failed "http://127.0.0.1:1234/?token=private-token#secret" and /api/test?token=relative-secret&next=1'), 'Failed "http://127.0.0.1:1234/" and /api/test?token=<redacted>&next=1')
  assert.equal(sanitizeHarnessDiagnostic('ordinary error'), 'ordinary error')
  dom.window.close()
})

test('first navigation waits for DOMContentLoaded and records only bounded same-origin resource paths', async () => {
  const page = new EventEmitter(), url = 'http://127.0.0.1:1234/?token=private-token', request = (url, type) => ({ url: () => url, resourceType: () => type, failure: () => null })
  let options, evidence
  page.evaluate = async () => ({ readyState: 'interactive' })
  page.goto = async (actual, selected) => {
    assert.equal(actual, url, 'Authentication is preserved for the actual navigation')
    options = selected
    const doc = request(url, 'document'); page.emit('request', doc); page.emit('requestfinished', doc)
    for (let index = 0; index < 70; index++) page.emit('request', request('http://127.0.0.1:1234/asset-' + index + '?token=resource-private#hash', 'image'))
    page.emit('request', request('https://foreign.example/private?secret=value', 'script'))
  }
  await navigateHarnessPage(page, url, value => { evidence = value })
  assert.deepEqual(options, { waitUntil: 'domcontentloaded' }, 'The existing page timeout is retained')
  assert.equal(evidence.document.readyState, 'interactive')
  assert.equal(evidence.pendingSameOrigin.length, 64)
  assert.equal(evidence.completedSameOrigin[0].path, '/')
  assert.doesNotMatch(JSON.stringify(evidence), /private-token|resource-private|foreign\.example|#hash/u)
  for (const event of ['request', 'requestfinished', 'requestfailed']) assert.equal(page.listenerCount(event), 0)
})
test('a failed first navigation preserves failure and read-only state while redacting its URL', async () => {
  const page = new EventEmitter(), failure = new Error('Timeout at "http://127.0.0.1:1234/?token=private-token#hash"')
  let evidence
  page.evaluate = async () => ({ readyState: 'complete' })
  page.goto = async () => { throw failure }
  await assert.rejects(navigateHarnessPage(page, 'http://127.0.0.1:1234/?token=private-token', value => { evidence = value }), error => error === failure)
  assert.equal(evidence.document.readyState, 'complete')
  assert.equal(evidence.error, 'Timeout at "http://127.0.0.1:1234/"')
  for (const event of ['request', 'requestfinished', 'requestfailed']) assert.equal(page.listenerCount(event), 0)
})
