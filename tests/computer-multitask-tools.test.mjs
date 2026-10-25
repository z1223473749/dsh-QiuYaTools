/** Real public ToolRuntime + real ComputerSessionService; devices and identity registry are isolated fixtures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
const built = await build({ stdin: { contents: "export * from './src/features/computer-use/tools.ts';export * from './src/features/computer-use/session.ts';export {ComputerError} from './src/features/computer-use/contract.ts'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' })
const { installComputerTools, ComputerSessionService, ComputerError } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].contents).toString('base64'))
const gate = () => { let resolve; return { promise: new Promise(r => resolve = r), resolve } }
async function fixture(t, { withTasks = true, withEntry = true } = {}) {
  const root = new Context(), plugins = [], agents = new Map(), taskRows = new Map(), owners = new Map(), operations = new Map(), services = new Map(), candidates = new Map(), calls = [], recordings = [], selections = [], saves = [], controller = new AbortController()
  const hooks = { save: undefined, observe: undefined, act: undefined, entry: undefined }, state = { enabled: true }, a = { id: 'own-chat-a' }, b = { id: 'own-chat-b' }
  agents.set(a.id, a); agents.set(b.id, b)
  const assertCaller = exec => { exec.signal.throwIfAborted(); if (!exec.agent || agents.get(exec.agent.id) !== exec.agent) throw new ComputerError('CALLER_NOT_LIVE', '/private/identity-never-expose'); if (exec.agent.child) throw new ComputerError('DELEGATED_CALLER', '/private/child-never-expose') }
  const tasks = {
    createTask(chat, label) { calls.push(['create', chat, label]); const rows = taskRows.get(chat) ?? []; if (rows.length >= 7) throw new ComputerError('TASK_LIMIT', '/private/limit-never-expose'); const taskId = randomUUID(); owners.set(taskId, chat); operations.set(taskId, 'operation:' + taskId); rows.push({ chatSessionId: chat, taskId, ...(label === undefined ? {} : { taskLabel: label }) }); taskRows.set(chat, rows); return taskId },
    resolveTask(chat, taskId) { if (taskId === undefined || taskId === chat) return chat; if (owners.get(taskId) !== chat || !operations.has(taskId)) throw new ComputerError('TASK_NOT_FOUND', 'C:\\private\\task-never-expose'); return operations.get(taskId) },
    listTasks(chat) { calls.push(['list', chat]); return [{ chatSessionId: chat, taskId: chat, taskLabel: '默认任务' }, ...(taskRows.get(chat) ?? [])] },
  }
  function service(id) {
    if (services.has(id)) return services.get(id)
    let seq = 0, lease = 0
    const target = { id: 'window:' + id, appId: 'fixture.app', title: 'isolated own fixture', pid: 100, x: 0, y: 0, width: 10, height: 10, scale: 1 }
    const driver = {
      async status() { calls.push(['device-status', id]); return { available: true } }, async targets() { calls.push(['device-targets', id]); return [target] },
      async lease(epoch) { lease = epoch; calls.push(['lease', id]) }, async release(epoch) { if (epoch === lease) lease = 0; calls.push(['release', id]) },
      async observe(targetId, signal) { calls.push(['capture', id]); await hooks.observe?.(id); signal.throwIfAborted(); return { targetId, frameId: 'frame:' + id + ':' + ++seq, imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 10, height: 10, elements: 'own button', geometry: target } },
      async act(epoch, targetId, action, signal) { signal.throwIfAborted(); assert.equal(epoch, lease); assert.equal(targetId, target.id); calls.push(['dispatch', id, action]); await hooks.act?.(id); return { applied: true } },
    }
    const actual = new ComputerSessionService(driver); services.set(id, actual); return actual
  }
  const facade = {
    get(id) { calls.push(['get', id]); return services.get(id)?.get(id) },
    async observe(id, signal) { return service(id).observe(id, signal) },
    async permittedTargets(id, signal) { return service(id).permittedTargets(id, signal) },
    async selectTarget(id, targetId, signal) { calls.push(['select', id]); return service(id).selectTarget(id, targetId, signal) },
    async act(id, request, signal) { return service(id).act(id, request, signal) },
    async pause(id) { calls.push(['pause', id]); return service(id).pause(id) },
  }
  const entry = {
    assertCaller,
    async discover(exec, filter) { assertCaller(exec); calls.push(['discover', exec, filter]); await hooks.entry?.(); assertCaller(exec); const id = randomUUID(); candidates.set(id, exec.operationSessionId); return { applications: [{ candidateId: id, appName: 'Own fixture' }] } },
    async requestControl(exec, candidateId, reason) { assertCaller(exec); calls.push(['request', exec, candidateId, reason]); if (candidates.get(candidateId) !== exec.operationSessionId) throw new ComputerError('CANDIDATE_EXPIRED', '/private/candidate'); const actual = service(exec.operationSessionId); return actual.start(exec.operationSessionId, 'window:' + exec.operationSessionId, { allowOnce: true, signal: exec.signal }) },
  }
  for (const plugin of [child => child.provide('systemPrompt', { tools() { return () => {} } }), ToolRuntime, child => child.provide('attachments', { async saveImage(input) { saves.push(input); await hooks.save?.(); return { attachmentId: 'own-image-' + saves.length, mediaType: 'image/jpeg', bytes: input.data.length, width: 10, height: 10 } } })]) { const installed = root.plugin(plugin); await installed.await(); plugins.push(installed) }
  let remove, injection
  const installed = root.plugin(child => { injection = child.inject(['tools', 'attachments'], ctx => { remove = installComputerTools(ctx, facade, { enabled: () => state.enabled, ...(withTasks ? { tasks } : {}), ...(withEntry ? { entry } : {}), onSelected(exec) { selections.push(exec) }, recorder: { async observed(...args) { recordings.push(['observe', ...args]); return { run: 'default-only' } }, async issuing(...args) { recordings.push(['issued', ...args]); return async result => { recordings.push(['completed', result]); return { run: 'default-only' } } } } }) }) })
  await installed.await(); await injection.await(); plugins.push(installed)
  const runtime = root.get('tools'), call = (name, args = {}, agent = a, signal = controller.signal, callId = randomUUID()) => runtime.execute({ name: 'qiuya_computer_' + name, arguments: args, agent, signal, callId })
  t.after(async () => { remove(); for (const plugin of plugins.reverse()) await plugin.dispose(); for (const actual of services.values()) await actual.dispose(); await root.fiber.dispose() })
  async function create(label, agent = a) { const result = await call('task', { op: 'create', ...(label === undefined ? {} : { label }) }, agent); assert.equal(result.isError, false, result.error?.message); return result.value.taskId }
  async function authorize(taskId, agent = a) { const args = taskId === undefined ? {} : { taskId }, discovered = await call('discover', args, agent); assert.equal(discovered.isError, false, discovered.error?.message); const result = await call('request_control', { ...args, candidateId: discovered.value.applications[0].candidateId, reason: 'Own task fixture' }, agent); assert.equal(result.isError, false, result.error?.message); return result }
  return { root, runtime, call, create, authorize, tasks, entry, facade, agents, a, b, calls, hooks, services, owners, operations, taskRows, recordings, selections, saves, state, controller, remove }
}
const ok = result => { assert.equal(result.isError, false, result.error?.message); return result.value }
const failed = (result, code) => { assert.equal(result.isError, true); assert.match(result.error.message, new RegExp('^\\[' + code + '\\]')); assert(!result.error.message.includes('/private/')); assert(!result.error.message.includes('C:\\private')); return result }

test('actual ToolRuntime publishes one explicit create/list schema only when tasks and Coordinator are installed', async t => {
  const f = await fixture(t), schemas = f.runtime.schemas(), task = schemas.find(row => row.name === 'qiuya_computer_task')
  assert(task); assert.equal(schemas.length, 9); assert.deepEqual(task.parameters.properties.op.enum, ['create', 'list']); assert.equal(task.parameters.additionalProperties, false); assert.equal('chatSessionId' in task.parameters.properties, false)
  for (const schema of schemas.filter(row => row.name !== 'qiuya_computer_task')) { assert.equal(schema.parameters.properties.taskId.type, 'string'); assert.match(schema.parameters.properties.taskId.description, /default task.*last-selected/iu) }
})
for (const missing of ['tasks', 'entry']) test('missing ' + missing + ' preserves legacy tools and does not advertise a task allocator', async t => { const f = await fixture(t, { withTasks: missing !== 'tasks', withEntry: missing !== 'entry' }); assert.equal(f.runtime.schemas().some(s => s.name === 'qiuya_computer_task'), false); const value = ok(await f.call('status')); assert.equal(value.sessionId, f.a.id) })
test('create/list only reserve and project current-chat task identities, without driver, capture, lease, attachment or selection', async t => {
  const f = await fixture(t), taskId = await f.create('  第一份文档  '), rows = ok(await f.call('task', { op: 'list' })).tasks
  assert.match(taskId, /^[a-f0-9-]{36}$/u); assert.equal(rows.length, 2); assert.deepEqual(rows[1], { chatSessionId: f.a.id, taskId, taskLabel: '第一份文档' }); assert.equal(f.services.size, 0); assert.equal(f.saves.length + f.recordings.length + f.selections.length, 0); assert.deepEqual(f.calls.map(v => v[0]), ['create', 'list'])
})
test('Host-created Unicode task labels remain listable at the same 120-code-point boundary', async t => {
  const f = await fixture(t), label = '🐳'.repeat(120), taskId = f.tasks.createTask(f.a.id, label)
  const tasks = ok(await f.call('task', { op: 'list' })).tasks
  assert.equal(tasks.find(row => row.taskId === taskId)?.taskLabel, label)
  assert.equal(tasks.length, 2); assert.equal(f.services.size + f.saves.length, 0)
  const created = ok(await f.call('task', { op: 'create', label }))
  assert.equal(created.taskLabel, label)
  assert.equal(ok(await f.call('task', { op: 'list' })).tasks.length, 3)
  f.taskRows.get(f.a.id)[0].taskLabel = '🐳'.repeat(121)
  failed(await f.call('task', { op: 'list' }), 'INVALID_TASK_LABEL')
})
for (const mode of ['missing-agent', 'forged-agent', 'child-agent', 'disabled', 'aborted']) test('create/list ' + mode + ' are rejected before allocation or listing', async t => {
  const f = await fixture(t); let agent = f.a, signal = f.controller.signal
  if (mode === 'missing-agent') agent = undefined
  if (mode === 'forged-agent') agent = { id: f.a.id }
  if (mode === 'child-agent') { agent = { id: 'own-child', child: true }; f.agents.set(agent.id, agent) }
  if (mode === 'disabled') f.state.enabled = false
  if (mode === 'aborted') { const controller = new AbortController(); controller.abort(); signal = controller.signal }
  for (const op of ['create', 'list']) { const result = mode === 'missing-agent' ? await f.runtime.execute({ name: 'qiuya_computer_task', arguments: { op }, callId: randomUUID(), signal }) : await f.call('task', { op }, agent, signal); assert.equal(result.isError, true); assert.equal(f.services.size, 0) }
  assert.equal(f.calls.length, 0)
})
test('task names and forged extra chat or operation-session fields are rejected without mutation', async t => {
  const f = await fixture(t)
  for (const args of [{ op: 'list', label: 'not allowed' }, { op: 'create', label: ' ' }, { op: 'create', label: '\nprivate' }, { op: 'create', label: 'x'.repeat(121) }, { op: 'create', chatSessionId: f.b.id }, { op: 'create', operationSessionId: f.b.id }, { op: 'unknown' }]) assert.equal((await f.call('task', args)).isError, true)
  assert.equal(f.calls.length, 0)
})
test('current chat reaches the original eight-total task cap and finite TASK_LIMIT hides backend diagnostics', async t => { const f = await fixture(t); for (let i = 0; i < 7; i++) await f.create(); failed(await f.call('task', { op: 'create' }), 'TASK_LIMIT'); assert.equal(ok(await f.call('task', { op: 'list' })).tasks.length, 8); assert.equal(f.services.size, 0) })
test('discovery and permission requests carry trusted operationSessionId while preserving the actual Agent object', async t => {
  const f = await fixture(t), taskId = await f.create('Task A'); await f.authorize(taskId)
  const discover = f.calls.find(row => row[0] === 'discover'), request = f.calls.find(row => row[0] === 'request')
  assert.equal(discover[1].agent, f.a); assert.equal(request[1].agent, f.a); assert.equal(discover[1].operationSessionId, f.tasks.resolveTask(f.a.id, taskId)); assert.equal(request[1].operationSessionId, discover[1].operationSessionId); assert.equal('taskId' in discover[2], false); assert.equal(f.recordings.length + f.selections.length, 0)
})
test('candidate discovered for one task cannot authorize another task, and has no later implicit retry', async t => {
  const f = await fixture(t), taskA = await f.create(), taskB = await f.create(), discovered = ok(await f.call('discover', { taskId: taskA }))
  failed(await f.call('request_control', { taskId: taskB, candidateId: discovered.applications[0].candidateId, reason: 'wrong task' }), 'CANDIDATE_EXPIRED'); assert.equal(f.services.size, 0); assert.equal(f.calls.filter(v => v[0] === 'request').length, 1)
})
test('omitted task always resolves root after two independent tasks; none share a mutable selected task', async t => {
  const f = await fixture(t), taskA = await f.create(), taskB = await f.create(); await f.authorize(taskA); await f.authorize(taskB)
  assert.equal(ok(await f.call('status')).sessionId, f.a.id); assert.equal('taskId' in ok(await f.call('status')), false)
  assert.equal(ok(await f.call('status', { taskId: taskA })).taskId, taskA); assert.equal(ok(await f.call('status', { taskId: taskB })).taskId, taskB); assert.equal(ok(await f.call('status')).sessionId, f.a.id)
})
test('actual session services bind image, target and single-use frame to the explicitly named task and reject cross-task input', async t => {
  const f = await fixture(t), taskA = await f.create(), taskB = await f.create(); await f.authorize(taskA); await f.authorize(taskB)
  const imageA = ok(await f.call('observe', { taskId: taskA })), imageB = ok(await f.call('observe', { taskId: taskB }))
  assert.equal(imageA.taskId, taskA); assert.equal(imageB.taskId, taskB); assert.notEqual(imageA.frameId, imageB.frameId); assert.notEqual(imageA.targetId, imageB.targetId); assert.equal(f.saves.length, 2)
  failed(await f.call('act', { taskId: taskB, frameId: imageA.frameId, action: { kind: 'click', x: 1, y: 1 } }), 'STALE_OBSERVATION'); assert.equal(f.calls.filter(v => v[0] === 'dispatch').length, 0)
  ok(await f.call('act', { taskId: taskA, frameId: imageA.frameId, action: { kind: 'click', x: 1, y: 1 } })); ok(await f.call('act', { taskId: taskB, frameId: imageB.frameId, action: { kind: 'type', text: '第二任务中文' } }))
  assert.deepEqual(f.calls.filter(v => v[0] === 'dispatch').map(v => v[1]), [f.tasks.resolveTask(f.a.id, taskA), f.tasks.resolveTask(f.a.id, taskB)]); assert.equal(f.recordings.length + f.selections.length, 0)
})
test('observe renderer preserves explicit taskId and genuine SDK image reference without exposing raw screenshot bytes', async t => { const f = await fixture(t), taskId = await f.create(); await f.authorize(taskId); const result = await f.call('observe', { taskId }); assert.equal(result.isError, false); assert(result.content.some(v => v.type === 'image' && v.attachment.attachmentId === result.value.image.attachmentId)); assert(result.content.some(v => v.type === 'text' && JSON.parse(v.text).taskId === taskId)); assert.equal('imageBase64' in result.value, false) })
test('default task retains existing H1 observed/issued/acknowledged recording and onSelected callbacks', async t => { const f = await fixture(t); await f.authorize(); const image = ok(await f.call('observe')); const action = ok(await f.call('act', { frameId: image.frameId, action: { kind: 'move', x: 1, y: 1 } })); assert.deepEqual(f.recordings.map(v => v[0]), ['observe', 'issued', 'completed']); assert.equal(f.selections.length, 3); assert.deepEqual(action.acceptance, { run: 'default-only' }); assert.equal('taskId' in image, false) })
test('targets/select/pause use only the named task and never alter another task or default session', async t => { const f = await fixture(t), taskA = await f.create(), taskB = await f.create(); await f.authorize(taskA); await f.authorize(taskB); const targetA = ok(await f.call('targets', { taskId: taskA })).targets[0]; const selected = ok(await f.call('select', { taskId: taskA, targetId: targetA.id })); assert.equal(selected.taskId, taskA); const paused = ok(await f.call('pause', { taskId: taskA })); assert.equal(paused.taskId, taskA); assert.equal(ok(await f.call('status', { taskId: taskB })).state, 'ready'); assert.equal(ok(await f.call('status')).state, 'idle') })
test('foreign task identifiers are rejected across every tool before any provider, device or attachment access', async t => { const f = await fixture(t), taskId = await f.create('foreign', f.b), start = f.calls.length; for (const [name,args] of [['status',{}],['targets',{}],['observe',{}],['select',{targetId:'x'}],['pause',{}],['act',{frameId:'x',action:{kind:'move',x:1,y:1}}],['discover',{}],['request_control',{candidateId:'x',reason:'own'}]]) failed(await f.call(name,{...args,taskId}),'TASK_NOT_FOUND'); assert.equal(f.calls.length,start); assert.equal(f.services.size+f.saves.length,0) })
for (const phase of ['observe', 'save']) test('task identity or Agent drift while ' + phase + ' awaits rejects late output and never records it under default', async t => { const f = await fixture(t), taskId = await f.create(); await f.authorize(taskId); const entered = gate(), release = gate(); f.hooks[phase] = async () => { entered.resolve(); await release.promise }; const pending = f.call('observe', { taskId }); await entered.promise; if (phase === 'observe') f.operations.set(taskId, 'different-own-operation'); else f.agents.set(f.a.id, { id: f.a.id }); release.resolve(); const result = await pending; failed(result, phase === 'observe' ? 'TASK_NOT_FOUND' : 'CALLER_NOT_LIVE'); assert.equal(result.content.some(v => v.type === 'image'), false); assert.equal(f.recordings.length+f.selections.length,0); assert.equal(f.calls.filter(v=>v[0]==='capture').length,1) })
test('task identity drift after an actual acknowledged input reports finite failure without replay or default recording', async t => { const f = await fixture(t),taskId=await f.create();await f.authorize(taskId);const frame=ok(await f.call('observe',{taskId})),entered=gate(),release=gate();f.hooks.act=async()=>{entered.resolve();await release.promise};const pending=f.call('act',{taskId,frameId:frame.frameId,action:{kind:'click',x:1,y:1}});await entered.promise;f.operations.set(taskId,'different-own-operation');release.resolve();failed(await pending,'TASK_NOT_FOUND');assert.equal(f.calls.filter(v=>v[0]==='dispatch').length,1);assert.equal(f.recordings.length+f.selections.length,0) })
