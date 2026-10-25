import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const source = (await build({ stdin: { contents: `export {ComputerEnvironmentManager} from './src/features/computer-use/environment-manager.ts';export {ComputerDriverRouter} from './src/features/computer-use/driver-router.ts';export {ScheduledComputerDriver} from './src/features/computer-use/scheduled-driver.ts';export {ComputerPermissionCoordinator} from './src/features/computer-use/permission-coordinator.ts';export {isComputerTaskForChat} from './src/features/computer-use/task-types.ts';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-task-unit-')), bundle = join(temporary, 'runtime.mjs')
await writeFile(bundle, source); after(() => rm(temporary, { recursive: true, force: true }))
const { ComputerEnvironmentManager, ComputerDriverRouter, ScheduledComputerDriver, ComputerPermissionCoordinator, isComputerTaskForChat } = await import(pathToFileURL(bundle).href)
const target = { id: 'fixture-window', appId: 'fixture.app', title: 'Owned fixture', pid: 100, x: 0, y: 0, width: 100, height: 80, scale: 1 }
const tick = () => new Promise(done => setImmediate(done))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(options = {}) {
  const devices = new Map(), agents = new Map(), roots = new Set()
  let now = 1000, enabled = true
  const manager = new ComputerEnvironmentManager({ now: () => now, enabled: () => enabled, idleMs: 10, ...options,
    createRouter(id, scheduler) {
      const calls = [], listeners = new Set(); let frame = 0
      const device = { calls, subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback) },
        async status() { calls.push(['status']); return { available: true, platform: 'win32' } },
        async applications() { calls.push(['applications']); return [{ appId: target.appId, name: 'Owned fixture', running: true }] },
        async targets() { calls.push(['targets']); return [target] },
        async observe() { return { targetId: target.id, frameId: `${id}-${++frame}`, imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: target.width, height: target.height, elements: 'Owned fixture', geometry: target } },
        async lease(epoch) { calls.push(['lease', epoch]) }, async release(epoch) { calls.push(['release', epoch]) },
        async act(epoch, _targetId, _action, signal) { signal?.throwIfAborted(); calls.push(['act', epoch]); return {} },
        async openPreview(_url, _title, sessionId) { calls.push(['preview', sessionId]); return { opened: true } },
        async closePreview() { calls.push(['closePreview']); return { closed: true } },
        async dispose() { calls.push(['dispose']); if (device.failCleanup) throw Error('Fixture cleanup not confirmed') },
      }
      devices.set(id, device)
      return new ComputerDriverRouter({ local: new ScheduledComputerDriver(device, 'same-task-test-desktop', scheduler) })
    },
  })
  const coordinator = new ComputerPermissionCoordinator({ backend: manager, enabled: () => enabled, lookupAgent: id => agents.get(id), isRootAgent: agent => roots.has(agent), now: () => now })
  const exec = (chat = 'chat-A', operationSessionId, callId = crypto.randomUUID()) => {
    if (!agents.has(chat)) { const agent = { id: chat }; agents.set(chat, agent); roots.add(agent) }
    return { agent: agents.get(chat), operationSessionId, callId, signal: new AbortController().signal }
  }
  const discover = async execution => (await coordinator.discover(execution)).applications[0].candidateId
  return { manager, coordinator, devices, agents, roots, exec, discover, clock: value => { now = value }, enabled: value => { enabled = value }, async dispose() { coordinator.dispose(); await manager.dispose() } }
}

test('additional task creation is metadata-only and ownership resolution never accepts another task or any root ID', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const first = f.manager.createTask('chat-A', '  填写表格  '), second = f.manager.createTask('chat-A'), other = f.manager.createTask('chat-B')
  assert.notEqual(first, second); assert.notEqual(first, other); assert.match(first, /^[a-f0-9-]{36}$/u)
  assert.equal(f.devices.size, 0); assert.deepEqual(f.manager.environments(), [])
  assert.equal(f.manager.resolveTask('chat-A'), 'chat-A'); assert.equal(f.manager.resolveTask('chat-A', first), first)
  for (const id of ['chat-A', 'chat-B', other, 'unknown-task']) assert.throws(() => f.manager.resolveTask('chat-A', id), { code: 'TASK_NOT_FOUND' })
  for (const operation of [() => f.manager.createTask(first), () => f.manager.resolveTask(first), () => f.manager.listTasks(first)]) assert.throws(operation, { code: 'TASK_NOT_FOUND' }, 'An operation ID cannot be reinterpreted as a root chat')
  const tasks = f.manager.listTasks('chat-A')
  assert.deepEqual(tasks, [{ chatSessionId: 'chat-A', taskId: first, taskLabel: '填写表格' }, { chatSessionId: 'chat-A', taskId: second }])
  tasks[0].chatSessionId = 'chat-B'; assert.equal(f.manager.resolveTask('chat-A', first), first, 'Metadata returned to callers is detached')
  for (const label of ['', ' ', 'x\ny', 'x'.repeat(121), 42]) assert.throws(() => f.manager.createTask('chat-A', label), { code: 'INVALID_REQUEST' })
  assert.equal(f.devices.size, 0)
})

test('task ownership predicate accepts legacy roots and only exact operation metadata for added tasks', () => {
  assert.equal(isComputerTaskForChat({ sessionId: 'chat-A' }, 'chat-A'), true)
  assert.equal(isComputerTaskForChat({ sessionId: 'task-1', taskId: 'task-1', chatSessionId: 'chat-A' }, 'chat-A'), true)
  for (const value of [null, undefined, {}, { sessionId: 'chat-B' }, { sessionId: 'task-1', taskId: 'task-2', chatSessionId: 'chat-A' }, { sessionId: 'task-1', taskId: 'task-1', chatSessionId: 'chat-B' }, { sessionId: 'task-1', chatSessionId: 'chat-A' }]) assert.equal(isComputerTaskForChat(value, 'chat-A'), false)
})

test('eight-task chat budget includes the reserved legacy default and global capacity includes unstarted tasks', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const tasks = Array.from({ length: 7 }, () => f.manager.createTask('chat-A'))
  assert.equal(new Set(tasks).size, 7)
  assert.throws(() => f.manager.createTask('chat-A'), { code: 'TASK_LIMIT' }); assert.equal(f.devices.size, 0)
  await f.manager.start('chat-A', target.id, { allowOnce: true })
  assert.equal(f.manager.get('chat-A').state, 'ready', 'The old default task still has its own slot')
  const limited = fixture({ maxEnvironments: 2 }); t.after(() => limited.dispose())
  const a = limited.manager.createTask('chat-A'), b = limited.manager.createTask('chat-B')
  assert.throws(() => limited.manager.createTask('chat-C'), { code: 'TASK_LIMIT' })
  assert.throws(() => limited.manager.start('chat-C', target.id, { allowOnce: true }), { code: 'SESSION_LIMIT' })
  await Promise.all([a, b].map(id => limited.manager.start(id, target.id, { allowOnce: true })))
  assert.equal(limited.manager.list().length, 2, 'Reserved tasks can instantiate at full capacity without double counting')
})

test('one chat retains independent tasks, projected snapshots and FIFO input without sharing single-use observations', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const a = f.manager.createTask('chat-A', '表格'), b = f.manager.createTask('chat-A', '浏览器')
  await Promise.all(['chat-A', a, b].map(id => f.manager.start(id, target.id, { allowOnce: true })))
  assert.equal(f.devices.size, 3)
  assert.equal(f.manager.get('chat-A').taskId, undefined)
  assert.equal(f.manager.get(a).chatSessionId, 'chat-A'); assert.equal(f.manager.get(a).taskId, a); assert.equal(f.manager.get(a).taskLabel, '表格')
  assert.equal(f.manager.workbenchEnvironment(a).snapshot.taskLabel, '表格')
  assert.equal(f.manager.environments().find(row => row.sessionId === b).taskId, b)
  assert.equal(f.manager.list().filter(row => isComputerTaskForChat(row, 'chat-A')).length, 3)
  const fa = await f.manager.observe(a), fb = await f.manager.observe(b), entered = deferred(), complete = deferred(), order = []
  f.devices.get(a).act = async () => { order.push(a); entered.resolve(); await complete.promise; return {} }
  f.devices.get(b).act = async () => { order.push(b); return {} }
  const action = (frameId, actionId) => ({ frameId, actionId, action: { kind: 'click', x: 10, y: 10 } })
  await assert.rejects(async () => f.manager.act(a, action(fb.frameId, 'wrong-task-frame')), { code: 'STALE_OBSERVATION' })
  const first = f.manager.act(a, action(fa.frameId, 'same-action-id')); await entered.promise
  const second = f.manager.act(b, action(fb.frameId, 'same-action-id')); await tick(); assert.deepEqual(order, [a])
  complete.resolve(); await Promise.all([first, second]); assert.deepEqual(order, [a, b])
  await f.manager.pause(a)
  assert.equal(f.manager.get(a).state, 'paused'); assert.equal(f.manager.get(b).state, 'ready'); assert.equal(f.manager.get('chat-A').state, 'ready')
})

test('stopping metadata-only tasks creates no worker and reclaims their slot only after a terminal receipt', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const tasks = Array.from({ length: 7 }, () => f.manager.createTask('chat-A')), stopped = await f.manager.stop(tasks[0])
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.taskId, tasks[0]); assert.equal(stopped.chatSessionId, 'chat-A')
  assert.deepEqual(await f.manager.stop(tasks[0]), f.manager.get(tasks[0]))
  assert.equal(f.devices.size, 0)
  assert.notEqual(f.manager.createTask('chat-A'), tasks[0]); assert.equal(f.manager.listTasks('chat-A').length, 7)
  assert.throws(() => f.manager.resolveTask('chat-A', tasks[0]), { code: 'TASK_NOT_FOUND' })
  assert.equal(f.devices.size, 0)
})

test('sweep preserves live tasks and root-protected pending environments; only confirmed terminal retirement frees task capacity', async t => {
  const f = fixture(); t.after(() => { for (const device of f.devices.values()) device.failCleanup = false; return f.dispose() })
  const tasks = Array.from({ length: 7 }, () => f.manager.createTask('chat-A')), [a, b] = tasks
  await f.manager.start(a, target.id, { allowOnce: true }); await f.manager.authorizationStatus(b)
  f.clock(5000); await f.manager.sweep(['chat-A'])
  assert.equal(f.manager.environments().length, 2); assert.equal(f.manager.get(a).state, 'ready')
  assert.equal(f.devices.get(b).calls.some(row => row[0] === 'dispose'), false)
  await f.manager.stop(a); f.devices.get(a).failCleanup = true
  f.clock(6000)
  await assert.rejects(f.manager.sweep(), /清理未完成/u)
  assert.equal(f.manager.resolveTask('chat-A', a), a); assert.throws(() => f.manager.createTask('chat-A'), { code: 'TASK_LIMIT' })
  f.devices.get(a).failCleanup = false; f.clock(10000); await f.manager.sweep()
  const replacement = f.manager.createTask('chat-A')
  assert.notEqual(replacement, a); assert.throws(() => f.manager.resolveTask('chat-A', a), { code: 'TASK_NOT_FOUND' })
  assert.equal(f.manager.resolveTask('chat-A', b), b, 'An unstarted reserved task is never silently discarded')
})

test('task caller validation is pure and rejects forged, delegated, cross-chat and expired Agent identities', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const a = f.manager.createTask('chat-A'), b = f.manager.createTask('chat-B'), execution = f.exec('chat-A', a)
  f.coordinator.assertCaller(execution); assert.equal(f.devices.size, 0)
  assert.throws(() => f.coordinator.assertCaller(f.exec(a)), { code: 'TASK_NOT_FOUND' }, 'Even a separate registry object cannot turn a known operation ID into a default root')
  assert.throws(() => f.coordinator.assertCaller({ ...execution, operationSessionId: b }), { code: 'TASK_NOT_FOUND' })
  assert.throws(() => f.coordinator.assertCaller({ ...execution, operationSessionId: 'chat-B' }), { code: 'TASK_NOT_FOUND' })
  assert.throws(() => f.coordinator.assertCaller({ ...execution, agent: { id: 'chat-A' } }), { code: 'CALLER_NOT_LIVE' })
  f.roots.delete(execution.agent); assert.throws(() => f.coordinator.assertCaller(execution), { code: 'DELEGATED_CALLER' })
  f.roots.add(execution.agent); f.enabled(false); assert.throws(() => f.coordinator.assertCaller(execution), { code: 'DISABLED' })
  assert.equal(f.devices.size, 0)
})

test('two task approvals in one root chat keep distinct candidates, replay identity, owner decisions and once grants', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const a = f.manager.createTask('chat-A'), b = f.manager.createTask('chat-A'), other = f.manager.createTask('chat-B')
  const ea = f.exec('chat-A', a, 'shared-call-id'), eb = f.exec('chat-A', b, 'shared-call-id')
  const ca = await f.discover(ea), cb = await f.discover(eb)
  assert.throws(() => f.coordinator.requestControl(eb, ca, '错误任务'), { code: 'CANDIDATE_EXPIRED' })
  const wa = f.coordinator.requestControl(ea, ca, '填写表格'), wb = f.coordinator.requestControl(eb, cb, '浏览器查询')
  assert.equal(f.coordinator.requestControl(ea, ca, '填写表格'), wa)
  const cards = f.coordinator.pending('chat-A'); assert.equal(cards.length, 2)
  assert.ok(cards.every(row => row.sessionId === 'chat-A')); assert.deepEqual(new Set(cards.map(row => row.taskId)), new Set([a, b]))
  const cardA = f.coordinator.pending(a)[0], cardB = f.coordinator.pending(b)[0]
  assert.equal((await f.coordinator.pendingWithPreflight('chat-A')).length, 2)
  for (const wrong of ['chat-A', 'chat-B', b, other]) await assert.rejects(f.coordinator.decide(wrong, cardA.requestId, 1, 'once'), { code: 'REQUEST_STALE' })
  await f.coordinator.decide(a, cardA.requestId, 1, 'once'); assert.equal((await wa).sessionId, a)
  assert.equal(f.manager.get(b), undefined); assert.equal(f.coordinator.pending(b).length, 1)
  const denied = assert.rejects(wb, { code: 'APP_DENIED' }); await f.coordinator.decide(b, cardB.requestId, 1, 'deny'); await denied
  assert.deepEqual(f.manager.allowedApps(), [], 'Allow once never spills into another operation')
  const eb2 = f.exec('chat-A', b), discovered = await f.coordinator.discover(eb2)
  assert.equal(discovered.applications[0].granted, false)
})

test('pausing any operation including the default root preserves sibling candidates and pending approvals; whole-chat cancellation is explicit', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const a = f.manager.createTask('chat-A'), b = f.manager.createTask('chat-A'), c = f.manager.createTask('chat-A'), d = f.manager.createTask('chat-A')
  await Promise.all(['chat-A', a].map(id => f.manager.start(id, target.id, { allowOnce: true })))
  const eb = f.exec('chat-A', b), ec = f.exec('chat-A', c), cb = await f.discover(eb), cc = await f.discover(ec)
  const wb = f.coordinator.requestControl(eb, cb, '任务B'), wc = f.coordinator.requestControl(ec, cc, '任务C')
  const ed = f.exec('chat-A', d), cd = await f.discover(ed)
  f.coordinator.cancelSession('chat-A'); await f.manager.pause('chat-A')
  f.coordinator.cancelSession(a); await f.manager.pause(a)
  assert.equal(f.coordinator.pending('chat-A').length, 2)
  const wd = f.coordinator.requestControl(ed, cd, '任务D已发现的候选仍有效')
  assert.equal(f.coordinator.pending('chat-A').length, 3)
  const cardB = f.coordinator.pending(b)[0]
  await f.coordinator.decide(b, cardB.requestId, 1, 'once'); assert.equal((await wb).sessionId, b)
  await assert.rejects(f.coordinator.discover(f.exec('chat-A', a)), { code: 'OWNER_RESUME_REQUIRED' })
  f.coordinator.cancelSession('chat-A'); assert.equal(f.coordinator.pending('chat-A').length, 2)
  const cancelled = [wc, wd].map(waiting => assert.rejects(waiting, { code: 'REQUEST_CANCELLED' })); f.coordinator.cancelChat('chat-A'); await Promise.all(cancelled)
  assert.equal(f.coordinator.pending('chat-A').length, 0)
  assert.equal(f.manager.get(b).state, 'ready'); assert.equal(f.manager.get(a).state, 'paused')
})
