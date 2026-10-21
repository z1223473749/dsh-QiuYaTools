import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const source = (await build({ stdin: { contents: "export {installComputerHost} from './src/features/computer-use/host.ts'; export {installComputerTools} from './src/features/computer-use/tools.ts'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { installComputerHost, installComputerTools } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
async function fixture({ mode = 'local', policy = 'ask', profile = false } = {}) {
  const routes = new Map(), tools = new Map(), effects = [], agents = new Map(), roots = [], dir = profile ? await mkdtemp(join(tmpdir(), 'qyt-permission-')) : undefined
  let enabled = true, principal = 'owner'
  function agent(id) { if (!agents.has(id)) { const value = { id, session: { id } }; agents.set(id, value); roots.push(value) } return agents.get(id) }
  const driver = {
    mode,
    async status() { return { available: true, platform: mode === 'local' ? 'darwin' : 'win32', mode, permissions: { screenRecording: true, accessibility: true, postEvents: true } } },
    async applications() { return [{ appId: `${mode}:fixture`, name: 'Fixture App', running: true }] },
    async targets() { return [{ id: 'own-window', appId: `${mode}:fixture`, title: 'Owner private title', pid: 1, x: 0, y: 0, width: 100, height: 100, scale: 1 }] },
    async lease(epoch) { effects.push(['lease', mode, epoch]) }, async release(epoch) { effects.push(['release', mode, epoch]) },
    async observe() { return { targetId: 'own-window', frameId: 'one', imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 100, height: 100, elements: 'Fixture button', geometry: { x: 0, y: 0, width: 100, height: 100, scale: 1 } } },
    async act() { effects.push(['act', mode]); return {} }, async openPreview() {}, async closePreview() {}, async dispose() {}, subscribe() { return () => {} },
    async openSystemSettings(kind) { effects.push(['settings', kind]); return { opened: true } },
  }
  const approval = { config: { policy }, overrideOf(session) { return session.override } }
  const ctx = {
    get(name) { return name === 'agents' ? { get: id => agents.get(id), roots: () => roots } : name === 'sessions' ? { get: id => agents.get(id)?.session } : name === 'profileContext' ? { dir } : name === 'approval' ? approval : undefined },
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } }, attachments: { async saveImage({ data }) { effects.push(['image', [...data]]); return { attachmentId: 'image', mediaType: 'image/jpeg', bytes: data.length, width: 100, height: 100 } } },
    webServer: { port: 12345 }, connection: { get browserPeer() { return { principal: { kind: principal } } }, authenticatedUrl: value => value, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } },
  }
  const host = await installComputerHost(ctx, () => enabled, { environments: { createRouter: () => driver } })
  const disposeTools = installComputerTools(ctx, host.service, { enabled: () => enabled, entry: host.entry })
  const exec = (id = 'a', callId = crypto.randomUUID()) => ({ agent: agent(id), callId, signal: new AbortController().signal })
  async function call(op, extra = {}) {
    const response = await routes.get('/api/qiuya-tools.computer.control').fetch(new Request('http://127.0.0.1/api/qiuya-tools.computer.control', { method: 'POST', body: JSON.stringify({ type: 'client-request', method: 'qiuya-tools.computer.control', rpcId: crypto.randomUUID(), payload: { op, ...extra } }) }))
    return response.status === 403 ? { status: 403 } : (await response.json()).result
  }
  return { host, tools, effects, agents, roots, driver, approval, dir, exec, call, attachments: ctx.attachments, enabled: value => { enabled = value }, principal: value => { principal = value },
    async dispose() { disposeTools(); await host.dispose(); if (dir) await rm(dir, { recursive: true, force: true }) } }
}

test('model discovery/request -> owner-only decision -> actual service observation needs no preselected chat or target', async () => {
  const f = await fixture({ mode: 'remote' })
  try {
    assert.equal(f.tools.size, 8)
    const exec = f.exec(), discover = f.tools.get('qiuya_computer_discover'), request = f.tools.get('qiuya_computer_request_control')
    const catalog = await discover.execute({ query: 'Fixture' }, exec)
    assert.equal(catalog.applications[0].appName, 'Fixture App'); assert.equal(JSON.stringify(catalog).includes('Owner private title'), false)
    assert.deepEqual(f.effects, [])
    const waiting = request.execute({ candidateId: catalog.applications[0].candidateId, reason: '完成用户表格任务' }, { ...exec, callId: 'request-one' })
    const status = (await f.call('status', { sessionId: 'a' })).value, [card] = status.pendingRequests
    assert.equal(card.sessionId, 'a'); assert.equal(card.preflight.mode, 'remote'); assert.equal(status.sessions.length, 0)
    assert.equal((await f.call('decide', { sessionId: 'other', requestId: card.requestId, requestVersion: 1, decision: 'once' })).ok, false)
    f.principal('guest')
    assert.equal((await f.call('decide', { sessionId: 'a', requestId: card.requestId, requestVersion: 1, decision: 'once' })).status, 403)
    f.principal('owner')
    const response = await f.call('decide', { sessionId: 'a', requestId: card.requestId, requestVersion: 1, decision: 'once' })
    assert.equal(response.ok, true); assert.equal((await waiting).sessionId, 'a')
    assert.equal(f.effects.filter(row => row[0] === 'lease').length, 1)
    assert.equal(f.effects.find(row => row[0] === 'lease')[1], 'remote')
    const observation = await f.tools.get('qiuya_computer_observe').execute({}, f.exec())
    assert.equal(observation.image.attachmentId, 'image'); assert.deepEqual(f.effects.find(row => row[0] === 'image')[1], [255, 216, 255, 217])
    assert.equal(f.host.manager.environments().find(item => item.sessionId === 'a').mode, 'remote')
  } finally { await f.dispose() }
})

test('model tool schema cannot smuggle another session, raw application, grant decision or launch endpoint', async () => {
  const f = await fixture()
  try {
    const exec = f.exec(), discovery = f.tools.get('qiuya_computer_discover'), request = f.tools.get('qiuya_computer_request_control')
    for (const extra of [{ sessionId: 'b' }, { appId: 'fixture' }, { allowOnce: true }, { token: 'secret' }, { decision: 'always' }]) {
      await assert.rejects(discovery.execute(extra, exec))
      await assert.rejects(request.execute({ candidateId: 'one', reason: 'task', ...extra }, exec))
    }
    assert.equal(f.host.entry.pending().length, 0); assert.deepEqual(f.effects, [])
  } finally { await f.dispose() }
})

test('public effective approval override is respected and a later never policy fences owner grant', async () => {
  const f = await fixture({ policy: 'never' })
  try {
    const exec = f.exec(), catalog = await f.tools.get('qiuya_computer_discover').execute({}, exec), args = { candidateId: catalog.applications[0].candidateId, reason: 'task' }
    await assert.rejects(f.tools.get('qiuya_computer_request_control').execute(args, exec), { code: 'APPROVAL_DISABLED' })
    exec.agent.session.override = 'ask'
    const waiting = f.tools.get('qiuya_computer_request_control').execute(args, { ...exec, callId: 'override-ask' }), [card] = f.host.entry.pending()
    assert.equal(card.sessionId, 'a')
    exec.agent.session.override = 'never'; const rejected = assert.rejects(waiting, { code: 'APPROVAL_DISABLED' })
    const response = await f.call('decide', { sessionId: 'a', requestId: card.requestId, requestVersion: 1, decision: 'always' })
    assert.equal(response.ok, false); assert.equal(response.error.code, 'APPROVAL_DISABLED'); await rejected
    assert.deepEqual(f.effects, [])
  } finally { await f.dispose() }
})

test('owner pause/cancel/disabled feature invalidates pending requests and late decisions', async () => {
  const f = await fixture()
  try {
    const exec = f.exec(), catalog = await f.tools.get('qiuya_computer_discover').execute({}, exec)
    const waiting = f.tools.get('qiuya_computer_request_control').execute({ candidateId: catalog.applications[0].candidateId, reason: 'task' }, exec), [card] = f.host.entry.pending()
    const rejected = assert.rejects(waiting)
    await f.call('pause', { sessionId: 'a' }); await rejected
    assert.equal((await f.call('decide', { sessionId: 'a', requestId: card.requestId, requestVersion: 1, decision: 'once' })).ok, false)
    assert.equal(f.effects.some(row => row[0] === 'lease'), false)
  } finally { await f.dispose() }
})

test('owner can revoke persistent application access while the feature is disabled', async () => {
  const f = await fixture({ profile: true })
  try {
    await f.host.service.setAppAllowed('local:fixture', true)
    assert.deepEqual(f.host.service.allowedApps(), ['local:fixture'])
    f.enabled(false)
    assert.equal((await f.call('allow', { appId: 'local:fixture', allowed: false })).ok, true)
    assert.deepEqual(f.host.service.allowedApps(), [])
    assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'qiuya-computer', 'permissions.json'), 'utf8')), [])
  } finally { await f.dispose() }
})

test('owner OS permission controls accept only fixed kinds and cannot be invoked through model tools', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.call('openSettings', { kind: 'accessibility' })).ok, true)
    assert.deepEqual(f.effects[0], ['settings', 'accessibility'])
    for (const kind of ['http://secret', 'privacy-any', 'screenRecording;command', '']) assert.equal((await f.call('openSettings', { kind })).ok, false)
    assert.equal([...f.tools.keys()].some(name => /settings|grant|allow|launch/.test(name)), false)
  } finally { await f.dispose() }
})


test('approval pins app/PID through the actual Manager and session second enumeration, rejecting reused target IDs before any lease', async () => {
  for (const changed of [{ appId: 'local:other' }, { pid: 2 }]) {
    const f = await fixture()
    try {
      let enumeration = 0
      const target = { id: 'own-window', appId: 'local:fixture', title: 'Own fixture', pid: 1, x: 0, y: 0, width: 100, height: 100, scale: 1 }
      f.driver.targets = async () => [{ ...target, ...(++enumeration >= 2 ? changed : {}) }]
      const exec = f.exec(), catalog = await f.tools.get('qiuya_computer_discover').execute({}, exec)
      const waiting = f.tools.get('qiuya_computer_request_control').execute({ candidateId: catalog.applications[0].candidateId, reason: 'task' }, exec), [card] = f.host.entry.pending()
      const rejected = assert.rejects(waiting, { code: 'TARGET_CHANGED' })
      const decision = await f.call('decide', { sessionId: 'a', requestId: card.requestId, requestVersion: 1, decision: 'once' })
      assert.equal(decision.ok, false); assert.equal(decision.error.code, 'TARGET_CHANGED'); await rejected
      assert.ok(enumeration >= 2); assert.equal(f.effects.some(row => ['lease', 'act'].includes(row[0])), false)
      assert.equal(f.host.service.allowedApps().length, 0)
    } finally { await f.dispose() }
  }
})


test('actual public SDK runtime preserves exact live Agent identity for new discover/request schemas and message-only failure codes', async () => {
  const f = await fixture(), root = new Context()
  const system = root.plugin(child => child.provide('systemPrompt', { tools() { return () => {} } })); await system.await()
  const runtimePlugin = root.plugin(ToolRuntime); await runtimePlugin.await()
  const images = root.plugin(child => child.provide('attachments', f.attachments)); await images.await()
  let injection, unregister
  const layer = root.plugin(child => { injection = child.inject(['tools', 'attachments'], injected => { unregister = installComputerTools(injected, f.host.service, { entry: f.host.entry }) }) })
  await layer.await(); await injection.await()
  try {
    const runtime = root.get('tools'), execution = f.exec()
    assert.equal(runtime.schemas().filter(tool => tool.name.startsWith('qiuya_computer_')).length, 8)
    const discovered = await runtime.execute({ ...execution, name: 'qiuya_computer_discover', arguments: { query: 'Fixture', kind: 'application' } })
    assert.equal(discovered.isError, false); const candidateId = discovered.value.applications[0].candidateId
    const waiting = runtime.execute({ ...execution, callId: 'sdk-owned-request', name: 'qiuya_computer_request_control', arguments: { candidateId, reason: 'task' } })
    for (let attempt = 0; attempt < 50 && !f.host.entry.pending().length; attempt++) await new Promise(resolve => setImmediate(resolve))
    const [card] = f.host.entry.pending(); assert.ok(card, 'SDK must route its actual Agent into the coordinator')
    assert.equal((await f.call('decide', { sessionId: 'a', requestId: card.requestId, requestVersion: 1, decision: 'once' })).ok, true)
    const granted = await waiting; assert.equal(granted.isError, false); assert.equal(granted.value.sessionId, 'a')
    const rejected = await runtime.execute({ ...execution, callId: 'sdk-bad-request', name: 'qiuya_computer_request_control', arguments: { candidateId: 'expired', reason: 'task' } })
    assert.equal(rejected.isError, true); assert.match(rejected.content.find(block => block.type === 'text').text, /\[CANDIDATE_EXPIRED\]/u)
  } finally { unregister?.(); await layer.dispose(); await images.dispose(); await runtimePlugin.dispose(); await system.dispose(); await f.dispose() }
})

test('owner chat status polling stays inert until discovery; global settings still preflight the local device', async () => {
  const f = await fixture()
  try {
    for (let index = 0; index < 20; index++) {
      const result = await f.call('status', { sessionId: 'ordinary-chat-' + index })
      assert.equal(result.ok, true); assert.equal(result.value.native, null)
    }
    assert.deepEqual(f.host.manager.environments(), []); assert.deepEqual(f.effects, [])
    assert.equal((await f.call('status')).value.native.available, true)
    assert.equal(f.host.manager.environments().length, 1)
  } finally { await f.dispose() }
})
