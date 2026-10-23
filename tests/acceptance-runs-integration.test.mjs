import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm, realpath, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const temp = await realpath(await mkdtemp(join(tmpdir(), 'qiuya-h1-real-bridge-unit-')))
after(() => rm(temp, { recursive: true, force: true }))
const path = join(temp, 'runtime.mjs')
await writeFile(path, (await build({ stdin: { contents: `export * from './src/features/acceptance-runs/integration.ts';export * from './src/features/computer-use/environment-manager.ts';export * from './src/features/computer-use/driver-router.ts';export * from './src/features/computer-use/tools.ts';export * from './src/features/acceptance-runs/storage.ts';export * from './src/features/acceptance-runs/contract.ts';export * from './src/features/acceptance-runs/service.ts'`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].contents)
const { createComputerRunBridge, installComputerAcceptanceRuns, ComputerEnvironmentManager, ComputerDriverRouter, installComputerTools, AcceptanceRunStore, AcceptanceRunService, RunError } = await import(pathToFileURL(path).href)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+c1FYAAAAASUVORK5CYII=', 'base64')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const input = key => ({ title: '独立隔离任务', checks: [{ checkId: 'check-one', title: '指定结果', expected: '真实证据独立确认', required: true, minimumEvidence: 1, verifierId: null }], budget: { maxAttempts: 8, maxActions: 8, maxEvidence: 8, deadlineMs: 60000 }, idempotencyKey: key ?? randomUUID(), previousRunId: null })
const target = { id: 'unit-window', appId: 'unit.app', title: 'Unit fixture', pid: 100, x: 2, y: 3, width: 100, height: 80, scale: 2 }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function fixture(t, { start = true } = {}) {
  const profile = await realpath(await mkdtemp(join(temp, 'profile-'))), current = { agent: { id: 'chat-one' }, roots: [], enabled: true, readHook: undefined, actHook: undefined }, definitions = new Map(), calls = [], files = new Map(), locals = new Map()
  current.roots = [current.agent]
  const attachments = {
    async saveImage(value) { calls.push(['saveImage', value.data.byteLength]); const ref = { attachmentId: digest(png), mediaType: 'image/png', bytes: png.length, width: 1, height: 1, originalDimensions: { width: 100, height: 80 } }; files.set(ref.attachmentId, { ref, data: png }); return ref },
    async readImage(ref, signal) { calls.push(['readImage', ref]); signal.throwIfAborted(); await current.readHook?.(); const result = files.get(ref.attachmentId); if (!result) throw Error('missing unit image'); return result },
  }
  const manager = new ComputerEnvironmentManager({ enabled: () => current.enabled, createRouter(id) {
    calls.push(['createRouter', id]); let frame = 0
    const device = { async status() { calls.push(['status']); return { available: true } }, async targets() { return [target] }, async observe() { calls.push(['observe']); return { targetId: target.id, frameId: 'frame-' + (++frame), imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 100, height: 80, elements: 'fixture controls', geometry: { x: 2, y: 3, width: 100, height: 80, scale: 2 } } }, async lease() { calls.push(['lease']) }, async release() { calls.push(['release']) }, async act(epoch) { calls.push(['input', epoch]); await current.actHook?.(); return { performed: true } }, async openPreview() {}, async closePreview() {}, async dispose() {} }
    locals.set(id, device); return new ComputerDriverRouter({ local: device })
  } })
  const agents = { get(id) { return current.agent?.id === id ? current.agent : undefined }, roots() { return current.roots } }
  const bridge = createComputerRunBridge({ agents, attachments, manager, profileDirectory: profile, enabled: () => current.enabled, version: 'unit-1' })
  const ctx = { tools: { register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name) } }, attachments }
  const unregister = installComputerTools(ctx, manager, { recorder: bridge.computer })
  t.after(async () => { unregister(); bridge.dispose(); await manager.dispose() })
  const controller = new AbortController(), exec = { callId: 'call-1', rootCallId: 'root-call-1', agent: current.agent, signal: controller.signal }, scope = { chatSessionId: 'chat-one', signal: new AbortController().signal, assertCurrent() {} }
  if (start) await manager.start(exec.agent.id, target.id, { allowOnce: true })
  let record
  const apply = async promise => { const result = await promise; record = result.record; return result }
  const mutation = () => ({ runId: record.runId, expectedRevision: record.revision, idempotencyKey: randomUUID() })
  const begin = async key => { const result = await bridge.service.begin(exec, input(key)); return apply(bridge.onBegin(exec, result)) }
  const attempt = () => apply(bridge.service.checkpoint(exec, { ...mutation(), phase: 'start', checkId: 'check-one' }))
  const observe = async () => { const result = await definitions.get('qiuya_computer_observe').execute({}, exec); if (result.acceptance) record = (await bridge.service.get(exec, result.acceptance.runId)).record; return result }
  const act = async frameId => { const result = await definitions.get('qiuya_computer_act').execute({ frameId, actionId: 'action-' + randomUUID(), action: { kind: 'move', x: 10, y: 20 } }, exec); if (result.acceptance) record = (await bridge.service.get(exec, result.acceptance.runId)).record; return result }
  return { bridge, manager, agents, attachments, definitions, current, calls, files, exec, controller, scope, profile, apply, mutation, begin, attempt, observe, act, get record() { return record } }
}
test('existing runtime generation getter performs zero activity and never revives retired snapshots', async t => {
  const f = await fixture(t, { start: false }), before = f.calls.length
  assert.equal(f.manager.runEnvironment('missing'), undefined); assert.equal(f.calls.length, before)
  await f.manager.start('chat-one', target.id, { allowOnce: true })
  const identity = f.manager.runEnvironment('chat-one'); assert.match(identity.environmentId, /^[a-f0-9-]{36}$/); assert.notEqual(identity.environmentId, 'chat-one')
  assert.deepEqual(f.manager.runEnvironment('chat-one'), identity)
  await f.manager.stop('chat-one'); assert.equal(f.manager.runEnvironment('chat-one'), undefined); assert.ok(f.manager.get('chat-one'))
})
test('actual owner reconnect rotates environment generation and cannot reuse old run', async t => {
  const f = await fixture(t); await f.begin(); const first = f.record
  await f.manager.connect('chat-one', { mode: 'local' }); await f.manager.start('chat-one', target.id, { allowOnce: true })
  assert.notEqual(f.manager.runEnvironment('chat-one').environmentId, first.binding.environmentId)
  const old = await f.bridge.service.get(f.exec, first.runId); assert.equal(old.readOnly, true); assert.equal(old.state, 'inconclusive')
})
test('authority requires exact live root Agent, not an id-matching object or delegate', async t => {
  const f = await fixture(t)
  await assert.rejects(f.bridge.service.begin({ ...f.exec, agent: { id: 'chat-one' } }, input()), { code: 'CALLER_NOT_LIVE' })
  f.current.roots = []
  await assert.rejects(f.bridge.service.begin(f.exec, input()), { code: 'CALLER_NOT_LIVE' })
  assert.equal(f.calls.filter(c => c[0] === 'input').length, 0)
})
test('tools remain unchanged when no run is active; one image save and one dispatch', async t => {
  const f = await fixture(t), frame = await f.observe(), result = await f.act(frame.frameId)
  assert.equal(frame.acceptance, undefined); assert.equal(result.acceptance, undefined)
  assert.equal(f.calls.filter(c => c[0] === 'saveImage').length, 1); assert.equal(f.calls.filter(c => c[0] === 'input').length, 1)
})
test('single actual observation reuses original normalized SDK attachment and original geometry', async t => {
  const f = await fixture(t); await f.begin(); await f.attempt(); const frame = await f.observe(), e = f.record.evidence[0]
  assert.equal(f.calls.filter(c => c[0] === 'observe').length, 1); assert.equal(f.calls.filter(c => c[0] === 'saveImage').length, 1)
  assert.equal(e.attachmentId, frame.image.attachmentId); assert.equal(e.sha256, digest(png)); assert.equal(e.width, 1); assert.equal(e.geometry.width, 100); assert.equal(e.geometry.scale, 2)
  assert.equal(frame.acceptance.evidenceId, e.evidenceId); assert.equal(f.record.state, 'running')
})
test('Agent replacement during normalized attachment read refuses evidence commit', async t => {
  const f = await fixture(t); await f.begin(); await f.attempt(); const id = f.record.runId, revision = f.record.revision
  f.current.readHook = () => { f.current.agent = { id: 'chat-one' }; f.current.roots = [f.current.agent] }
  await assert.rejects(f.observe()); f.current.readHook = undefined
  const view = await f.bridge.reader.get(f.scope, id); assert.equal(view.record.revision, revision); assert.equal(view.record.evidence.length, 0); assert.equal(view.state, 'inconclusive')
})
test('issued receipt is durably committed before the real input seam, then matching ACK', async t => {
  const f = await fixture(t); await f.begin(); await f.attempt(); const frame = await f.observe()
  f.current.actHook = async () => { const view = await f.bridge.service.get(f.exec, f.record.runId); assert.equal(view.record.actions.length, 1); assert.equal(view.record.actions[0].phase, 'issued') }
  const result = await f.act(frame.frameId); assert.equal(result.acceptance.phase, 'acknowledged'); assert.deepEqual(f.record.actions.map(a => a.phase), ['issued', 'acknowledged'])
  assert.equal(f.record.actions[0].rootCallId, 'root-call-1'); assert.equal(JSON.stringify(f.record.actions).includes('"x"'), false)
})
test('a repeated recorded action id is blocked before any second input', async t => {
  const f = await fixture(t); await f.begin(); await f.attempt(); const a = await f.observe(), actionId = 'unique-action'
  await f.definitions.get('qiuya_computer_act').execute({ actionId, frameId: a.frameId, action: { kind: 'move', x: 1, y: 1 } }, f.exec)
  const b = await f.observe()
  await assert.rejects(f.definitions.get('qiuya_computer_act').execute({ actionId, frameId: b.frameId, action: { kind: 'move', x: 1, y: 1 } }, f.exec))
  assert.equal(f.calls.filter(c => c[0] === 'input').length, 1)
})
test('stale frame rejects input and persists unknown rather than fabricated acknowledged', async t => {
  const f = await fixture(t); await f.begin(); await f.attempt(); const old = await f.observe(); await f.observe()
  await assert.rejects(f.act(old.frameId))
  const view = await f.bridge.reader.get(f.scope, f.record.runId); assert.deepEqual(view.record.actions.map(a => a.phase), ['issued', 'unknown']); assert.equal(view.state, 'inconclusive'); assert.equal(f.calls.filter(c => c[0] === 'input').length, 0)
})
test('aborted SDK exec cannot write ACK through a fabricated replacement signal', async t => {
  const f = await fixture(t); await f.begin(); await f.attempt(); const frame = await f.observe()
  f.current.actHook = () => { f.controller.abort() }
  await assert.rejects(f.act(frame.frameId))
  const view = await f.bridge.reader.get(f.scope, f.record.runId); assert.equal(view.record.actions[0].phase, 'issued'); assert.equal(view.record.actions.length, 1); assert.equal(view.state, 'inconclusive'); assert.equal(view.replayPermitted, false)
})
test('pause/epoch drift projects old owner history readonly and never changes old stored facts', async t => {
  const f = await fixture(t); await f.begin(); const id = f.record.runId, head = join(f.profile, 'qiuya-tools-runs/v1', 'run-' + id + '.json'), before = await readFile(head)
  await f.manager.pause('chat-one')
  const view = await f.bridge.reader.get(f.scope, id), rows = await f.bridge.reader.list(f.scope), exported = await f.bridge.reader.export(f.scope, id)
  assert.equal(view.record.state, 'running'); assert.equal(view.state, 'inconclusive'); assert.equal(view.recovery, 'historical'); assert.equal(rows[0].state, 'inconclusive'); assert.equal(exported.state, 'inconclusive'); assert.deepEqual(await readFile(head), before)
})
test('model passed proposal has no default business verifier and finishes inconclusive', async t => {
  const f = await fixture(t); await f.begin(); await f.attempt(); await f.observe()
  await f.apply(f.bridge.service.checkpoint(f.exec, { ...f.mutation(), phase: 'verify', checkId: 'check-one', attemptId: f.record.attempts[0].attemptId, evidenceIds: [f.record.evidence[0].evidenceId], assessment: { proposal: 'passed', summaryCode: 'EXPECTATION_MET' } }))
  await f.apply(f.bridge.service.finish(f.exec, f.mutation()))
  assert.equal(f.record.state, 'inconclusive'); assert.equal(f.record.attempts[0].verificationCode, 'VERIFIER_UNAVAILABLE')
})
test('multiple active records cannot silently attach evidence or dispatch input to a guessed run', async t => {
  const f = await fixture(t); await f.begin(); await f.attempt(); await f.begin()
  await assert.rejects(f.observe()); await assert.rejects(f.act('unknown')); assert.equal(f.calls.filter(c => c[0] === 'input').length, 0)
})
async function ownerFixture(t) {
  const f = await fixture(t), requests = [], state = { peer: { principal: { kind: 'owner' } }, queryHook: undefined, disposed: 0 }
  const connection = { get browserPeer() { return state.peer }, fetch: { register(route) { requests.push(route); return async () => { state.disposed++ } } } }
  const query = { async observeSession(id, options) { assert.equal(options.projectionMode, 'none'); return state.queryHook ? state.queryHook(id, options) : { header: { id }, get events() { throw Error('must not materialize personal chat') }, [Symbol.dispose]() { state.disposed++ } } } }
  const definitions = new Map(), services = { profileContext: { dir: f.profile }, agents: f.agents, attachments: f.attachments, sessionQuery: query, connection }
  const ctx = { get(name) { return services[name] }, tools: { register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name) } } }
  const installed = installComputerAcceptanceRuns(ctx, f.manager, { enabled: () => true, version: 'unit-1' }); t.after(() => installed.dispose())
  const request = (op = 'list', signal) => requests[0].fetch(new Request('http://unit.local/api/qiuya', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'qiuya-tools.runs.read', payload: { op, chatSessionId: 'chat-one' } }), signal }))
  return { ...f, requests, state, query, installed, request, services, definitions }
}
test('owner scope reads only exact public Session header, no live Agent or chat event materialization', async t => {
  const f = await ownerFixture(t); f.current.agent = undefined; f.current.roots = []
  const response = await f.request(); const value = await response.json(); assert.equal(value.result.ok, true); assert.deepEqual(value.result.value, []); assert.equal(f.state.disposed, 1)
})
test('owner peer replacement during public session await rejects history even if both principals say owner', async t => {
  const f = await ownerFixture(t)
  f.state.queryHook = async id => { f.state.peer = { principal: { kind: 'owner' } }; return { header: { id }, [Symbol.dispose]() { f.state.disposed++ } } }
  const response = await f.request(), value = await response.json(); assert.equal(value.result.ok, false); assert.equal(value.result.error.code, 'OWNER_CHANGED'); assert.equal(f.state.disposed, 1)
})
test('cancelled session observation is disposed even if provider resolves its lease late', async t => {
  const f = await ownerFixture(t), entered = deferred(), lease = deferred(), abort = new AbortController()
  f.state.queryHook = async () => { entered.resolve(); return lease.promise }
  const response = f.request('list', abort.signal); await entered.promise; abort.abort(); const value = await (await response).json(); assert.equal(value.result.ok, false)
  lease.resolve({ header: { id: 'chat-one' }, [Symbol.dispose]() { f.state.disposed++ } }); await new Promise(done => setImmediate(done)); assert.equal(f.state.disposed, 1)
})
test('new current frame during image read invalidates the old evidence without an extra capture by recorder', async t => {
  const f = await fixture(t); await f.begin(); await f.attempt(); let changed = false
  f.current.readHook = async () => { if (!changed) { changed = true; await f.manager.observe('chat-one') } }
  await assert.rejects(f.observe()); f.current.readHook = undefined
  const view = await f.bridge.reader.get(f.scope, f.record.runId); assert.equal(view.record.evidence.length, 0); assert.equal(f.calls.filter(c => c[0] === 'saveImage').length, 1); assert.equal(f.calls.filter(c => c[0] === 'observe').length, 2)
})
test('no open checkpoint blocks recording and AI dispatch instead of guessing a business check', async t => {
  const f = await fixture(t); await f.begin()
  await assert.rejects(f.observe()); await assert.rejects(f.act('frame-1')); assert.equal(f.calls.filter(c => c[0] === 'input').length, 0); assert.equal(f.record.evidence.length, 0)
})
test('frame not committed in this current attempt refuses dispatch before issued receipt', async t => {
  const f = await fixture(t); const prior = await f.observe(); await f.begin(); await f.attempt()
  await assert.rejects(f.act(prior.frameId)); const view = await f.bridge.reader.get(f.scope, f.record.runId); assert.equal(view.record.actions.length, 0); assert.equal(f.calls.filter(c => c[0] === 'input').length, 0)
})
test('aborted issued action prevents later inputs from silently escaping its interrupted record', async t => {
  const f = await fixture(t); await f.begin(); await f.attempt(); const frame = await f.observe(); f.current.actHook = () => f.controller.abort()
  await assert.rejects(f.act(frame.frameId)); f.current.actHook = undefined
  const freshExec = { ...f.exec, signal: new AbortController().signal }
  await assert.rejects(f.definitions.get('qiuya_computer_observe').execute({}, freshExec)); assert.equal(f.calls.filter(c => c[0] === 'input').length, 1)
  const view = await f.bridge.reader.get(f.scope, f.record.runId); assert.equal(view.state, 'inconclusive'); assert.equal(view.readOnly, true)
})
test('owner export rechecks actual generation after its last evidence await', async t => {
  const f = await fixture(t); await f.begin(); await f.attempt(); await f.observe(); let reads = 0
  f.current.readHook = async () => { if (++reads === 2) await f.manager.pause('chat-one') }
  const exported = await f.bridge.reader.export(f.scope, f.record.runId); assert.equal(exported.state, 'inconclusive'); assert.equal(exported.recovery, 'historical'); assert.equal(exported.replayPermitted, false)
})
test('owner principal replacement on the same browser peer invalidates the pending scope', async t => {
  const f = await ownerFixture(t)
  f.state.queryHook = async id => { f.state.peer.principal = { kind: 'owner' }; return { header: { id }, [Symbol.dispose]() { f.state.disposed++ } } }
  const result = await (await f.request()).json(); assert.equal(result.result.ok, false); assert.equal(result.result.error.code, 'OWNER_CHANGED'); assert.equal(f.state.disposed, 1)
})
test('native image renderer exposes committed receipt IDs to the model while preserving its single image block', async t => {
  const f = await fixture(t); await f.begin(); await f.attempt(); const frame = await f.observe(), rendered = f.definitions.get('qiuya_computer_observe').output.render({}, frame)
  assert.equal(rendered.length, 2); assert.equal(rendered[1].type, 'image'); assert.equal(rendered[1].attachment.attachmentId, frame.image.attachmentId)
  assert.deepEqual(JSON.parse(rendered[0].text).acceptance, frame.acceptance)
})
test('body streaming cannot transfer an old request to a replacement owner before resolving scope', async t => {
  const f = await ownerFixture(t), reading = deferred(); let stream, queries = 0
  f.state.queryHook = async id => { queries++; return { header: { id }, [Symbol.dispose]() {} } }
  const body = new ReadableStream({ start(controller) { stream = controller }, pull() { reading.resolve() } })
  const pending = f.requests[0].fetch(new Request('http://unit.local/api/qiuya', { method: 'POST', body, duplex: 'half' }))
  await reading.promise; f.state.peer = { principal: { kind: 'owner' } }
  stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'client-request', rpcId: 'rpc-old', method: 'qiuya-tools.runs.read', payload: { op: 'list', chatSessionId: 'chat-one' } }))); stream.close()
  const value = await (await pending).json(); assert.equal(value.result.ok, false); assert.equal(value.result.error.code, 'OWNER_CHANGED'); assert.equal(queries, 0)
})

function loseDurableReceipt(t,phase){const original=AcceptanceRunStore.prototype.compareAndSwap;let injected=false;AcceptanceRunStore.prototype.compareAndSwap=async function(value,...rest){const saved=await original.call(this,value,...rest);if(!injected&&value.actions.at(-1)?.phase===phase){injected=true;throw new RunError('STORE_COMMIT_UNCONFIRMED')}return saved};t.after(()=>{AcceptanceRunStore.prototype.compareAndSwap=original});return()=>injected;}
test('durable issued write with lost response stays historical for model and owner and dispatches zero input',async t=>{const f=await fixture(t);await f.begin();await f.attempt();const frame=await f.observe(),old=f.record.runId,hit=loseDurableReceipt(t,'issued');await assert.rejects(f.act(frame.frameId));assert(hit());assert.equal(f.calls.filter(c=>c[0]==='input').length,0);const freshExec={...f.exec,signal:new AbortController().signal},model=await f.bridge.service.get(freshExec,old),owner=await f.bridge.reader.get(f.scope,old);assert.deepEqual(model.record.actions.map(a=>a.phase),['issued']);for(const v of[model,owner]){assert.equal(v.state,'inconclusive');assert.equal(v.readOnly,true)}await assert.rejects(f.bridge.service.checkpoint(freshExec,{runId:old,expectedRevision:model.record.revision,idempotencyKey:randomUUID(),phase:'verify',checkId:'check-one',attemptId:model.record.attempts[0].attemptId,evidenceIds:[model.record.evidence[0].evidenceId],assessment:{proposal:'passed',summaryCode:'EXPECTATION_MET'}}),{code:'HISTORY_READ_ONLY'});await assert.rejects(f.bridge.service.finish(freshExec,{runId:old,expectedRevision:model.record.revision,idempotencyKey:randomUUID()}),{code:'HISTORY_READ_ONLY'});await assert.rejects(f.observe());});
test('durable actual input ACK lost response preserves both facts, blocks repeat and allows only explicit linked successor',async t=>{const f=await fixture(t);await f.begin();await f.attempt();const frame=await f.observe(),old=f.record.runId,hit=loseDurableReceipt(t,'acknowledged');await assert.rejects(f.act(frame.frameId));assert(hit());assert.equal(f.calls.filter(c=>c[0]==='input').length,1);const view=await f.bridge.service.get(f.exec,old);assert.deepEqual(view.record.actions.map(a=>a.phase),['issued','acknowledged']);assert.equal(view.state,'inconclusive');assert.equal(view.readOnly,true);await assert.rejects(f.observe());const begun=await f.bridge.service.begin(f.exec,{...input(),previousRunId:old});await f.apply(f.bridge.onBegin(f.exec,begun));await f.attempt();const next=await f.observe();await f.act(next.frameId);assert.equal(f.calls.filter(c=>c[0]==='input').length,2);const historical=await f.bridge.reader.get(f.scope,old);assert.deepEqual(historical.record,view.record);assert.equal(historical.state,'inconclusive');assert.equal(historical.readOnly,true);});
test('unlinked successor cannot silently erase an interrupted record',async t=>{const f=await fixture(t);await f.begin();await f.attempt();const frame=await f.observe();loseDurableReceipt(t,'issued');await assert.rejects(f.act(frame.frameId));await f.begin();await f.attempt();await assert.rejects(f.observe());assert.equal(f.calls.filter(c=>c[0]==='input').length,0);});
test('an exact issued callback arriving after Host disposal never writes a fabricated ACK',async t=>{const f=await fixture(t);await f.begin();await f.attempt();const frame=await f.observe(),request={actionId:'late-own-action',frameId:frame.frameId,action:{kind:'move',x:1,y:1}},done=await f.bridge.computer.issuing(f.exec,request),environment=f.manager.runEnvironment('chat-one');f.bridge.dispose();await assert.rejects(done({actionId:request.actionId,targetId:target.id,epoch:environment.epoch,result:{performed:true}}));const actual=JSON.parse(await readFile(join(f.profile,'qiuya-tools-runs/v1','run-'+f.record.runId+'.json'),'utf8')).record;assert.deepEqual(actual.actions.map(a=>a.phase),['issued']);assert.equal(f.calls.filter(c=>c[0]==='input').length,0);});

for(const phase of['issued','acknowledged'])test('separate Node abruptly exits after durable '+phase+' head rename; restart preserves facts and rejects late ACK',async t=>{const f=await fixture(t);await f.begin();const binding=f.record.binding,profile=await realpath(await mkdtemp(join(temp,'crash-'+phase+'-'))),manifest=join(temp,'crash-'+randomUUID()+'.json'),childPath=join(temp,'crash-child-'+randomUUID()+'.mjs');const child=`import{AcceptanceRunService,AcceptanceRunStore}from ${JSON.stringify(pathToFileURL(path).href)};import{writeFile}from'node:fs/promises';import{randomUUID}from'node:crypto';const binding=${JSON.stringify(binding)},agent={id:binding.agentId},exec={callId:'crash-call',agent,signal:new AbortController().signal};let armed=false;const store=new AcceptanceRunStore({profileDirectory:${JSON.stringify(profile)},fault(phase){if(armed&&phase==='afterRename')process.exit(77)}}),authority={resolve:()=>({...binding,agentHandle:agent}),current:()=>true},core=AcceptanceRunService.create({store,authority,evidence:{inspect:async()=>{throw Error('unused')}}});let r=(await core.service.begin(exec,${JSON.stringify(input())})).record;const next=()=>({runId:r.runId,expectedRevision:r.revision,idempotencyKey:randomUUID()});r=(await core.recorder.setState(exec,{...next(),state:'running'})).record;const receipt={receiptId:randomUUID(),callId:exec.callId,rootCallId:null,actionId:'crash-own-action',kind:'move',targetId:binding.targetIds[0],frameId:'own-crash-frame',environmentId:binding.environmentId,epoch:binding.epoch,phase:'issued',at:Date.now(),errorCode:null};if(${JSON.stringify(phase)}==='acknowledged')r=(await core.recorder.recordAction(exec,{...next(),receipt})).record;await writeFile(${JSON.stringify(manifest)},JSON.stringify({runId:r.runId,receipt}));armed=true;await core.recorder.recordAction(exec,{...next(),receipt:{...receipt,receiptId:randomUUID(),phase:${JSON.stringify(phase)}}});throw Error('crash hook did not exit');`;await writeFile(childPath,child);await assert.rejects(promisify(execFile)(process.execPath,[childPath],{timeout:10000}),error=>error.code===77&&!error.signal);const own=JSON.parse(await readFile(manifest,'utf8')),agent={id:binding.agentId},exec={callId:'fresh-read',agent,signal:new AbortController().signal},core=AcceptanceRunService.create({store:new AcceptanceRunStore({profileDirectory:profile}),authority:{resolve:()=>({...binding,agentHandle:agent}),current:()=>true},evidence:{inspect:async()=>{throw Error('unused')}}}),view=await core.service.get(exec,own.runId);assert.deepEqual(view.record.actions.map(a=>a.phase),phase==='issued'?['issued']:['issued','acknowledged']);assert.equal(view.state,'inconclusive');assert.equal(view.readOnly,true);await assert.rejects(core.recorder.recordAction(exec,{runId:own.runId,expectedRevision:view.record.revision,idempotencyKey:randomUUID(),receipt:{...own.receipt,receiptId:randomUUID(),phase:'acknowledged'}}),{code:'HISTORY_READ_ONLY'});const again=await core.service.get(exec,own.runId);assert.deepEqual(again.record,view.record);});
