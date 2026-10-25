import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const source = (await build({
  stdin: {
    contents: "export {installComputerHost} from './src/features/computer-use/host.ts'; export {ComputerDriverRouter} from './src/features/computer-use/driver-router.ts'; export {ScheduledComputerDriver} from './src/features/computer-use/scheduled-driver.ts'",
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
})).outputFiles[0].text
const { installComputerHost, ComputerDriverRouter, ScheduledComputerDriver } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const endpoint = '/api/qiuya-tools.computer.control'
const target = { id: 'isolated-window', appId: 'synthetic.app', title: 'Isolated test application', pid: 42, x: 0, y: 0, width: 160, height: 100, scale: 1 }
const geometry = { x: target.x, y: target.y, width: target.width, height: target.height, scale: target.scale }

async function fixture() {
  const routes = new Map(), devices = new Map(), effects = [], factories = [], agents = new Map()
  const chats = new Map(['chat-a', 'chat-b'].map(id => [id, { id }]))
  function rootAgent(id) {
    if (!agents.has(id)) agents.set(id, { id, session: { id } })
    return agents.get(id)
  }
  for (const id of chats.keys()) rootAgent(id)
  function device(id) {
    let frame = 0
    const listeners = new Set(), calls = []
    const record = (op, detail) => { const row = { id, op, ...(detail === undefined ? {} : { detail }) }; calls.push(row); effects.push(row) }
    return {
      calls,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      async status() { record('status'); return { available: true, platform: 'win32', permissions: { screen: true, accessibility: true } } },
      async applications() { record('applications'); return [{ appId: target.appId, name: 'Isolated test application', running: true }] },
      async targets() { record('targets'); return [{ ...target }] },
      async observe(targetId) {
        record('observe', targetId)
        return { targetId, frameId: `${id}:${++frame}`, imageBase64: '/9j/2Q==', mediaType: 'image/jpeg', width: 160, height: 100, elements: 'Synthetic application only', geometry: { ...geometry } }
      },
      async lease(epoch, signal, options) { signal?.throwIfAborted(); record('lease', { epoch, actor: options?.actor }) },
      async release(epoch) { record('release', epoch) },
      async act(epoch, targetId, action, signal) { signal?.throwIfAborted(); record('act', { epoch, targetId, action }); return {} },
      async openPreview(_url, _title, sessionId) { record('openPreview', sessionId); return { opened: true } },
      async closePreview() { record('closePreview'); return { closed: true } },
      async dispose() { record('dispose') },
    }
  }
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: id => chats.get(id) }
      if (name === 'agents') return { get: id => agents.get(id), roots: () => [...agents.values()] }
      if (name === 'approval') return { config: { policy: 'ask' } }
    },
    webServer: { port: 19457 },
    connection: {
      browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: value => value,
      fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path) } } },
    },
  }
  const host = await installComputerHost(ctx, () => true, {
    environments: {
      createRouter(id, scheduler) {
        factories.push(id)
        const local = device(id); devices.set(id, local)
        return new ComputerDriverRouter({ local: new ScheduledComputerDriver(local, 'shared-synthetic-desktop', scheduler) })
      },
    },
  })
  async function call(op, { sessionId = 'chat-a', ...extra } = {}) {
    const request = new Request(`http://127.0.0.1:19457${endpoint}`, {
      method: 'POST', body: JSON.stringify({ type: 'client-request', method: 'qiuya-tools.computer.control', rpcId: crypto.randomUUID(), payload: { op, sessionId, ...extra } }),
    })
    const response = await routes.get(endpoint).fetch(request)
    assert.equal(response.status, 200)
    const envelope = await response.json()
    assert.equal(envelope.type, 'server-response')
    return envelope.result
  }
  async function ok(op, extra) {
    const result = await call(op, extra)
    assert.equal(result.ok, true, `${op}: ${result.error?.code ?? ''} ${result.error?.message ?? ''}`)
    return result.value
  }
  async function task(sessionId = 'chat-a', label) {
    const result = await ok('createTask', { sessionId, ...(label === undefined ? {} : { label }) })
    assert.equal(typeof result?.taskId, 'string')
    assert.ok(result.taskId.length > 0)
    assert.notEqual(result.taskId, sessionId)
    return result.taskId
  }
  return { host, routes, factories, devices, effects, rootAgent, call, ok, task,
    internal: (chat, taskId) => host.manager.resolveTask(chat, taskId),
    async dispose() { await host.dispose(); assert.equal(routes.size, 0) },
  }
}

test('Host creates and lists current-chat task identities without creating a native router', async t => {
  const f = await fixture(); t.after(() => f.dispose())
  const before = await f.ok('status')
  assert.deepEqual(before.tasks, f.host.manager.listTasks('chat-a'))
  const a = await f.task('chat-a', '检查浏览器'), b = await f.task('chat-a', '整理表格')
  assert.notEqual(a, b)
  const status = await f.ok('status')
  assert.deepEqual(status.tasks, f.host.manager.listTasks('chat-a'))
  const ids = status.tasks.map(row => row.taskId)
  assert.ok(ids.includes(a)); assert.ok(ids.includes(b))
  for (const row of status.tasks) {
    assert.equal(row.chatSessionId, 'chat-a')
    assert.equal(Object.hasOwn(row, 'sessionId'), false, 'Public task identity must not expose its internal operation session')
  }
  assert.equal(status.tasks.find(row => row.taskId === a).taskLabel, '检查浏览器')
  assert.equal(status.tasks.find(row => row.taskId === b).taskLabel, '整理表格')
  assert.deepEqual((await f.ok('status', { sessionId: 'chat-b' })).tasks, f.host.manager.listTasks('chat-b'))
  assert.equal((await f.call('createTask', { sessionId: 'missing-chat' })).ok, false)
  assert.deepEqual(f.factories, [], 'Creating/listing task metadata must not instantiate a router or helper')
  assert.deepEqual(f.effects, [], 'Metadata-only calls must not query, capture or control the desktop')
})

test('Host keeps two tasks ready in one chat and isolates frame, pause, takeover, input and stop', async t => {
  const f = await fixture(); t.after(() => f.dispose())
  const a = await f.task(), b = await f.task()
  await f.ok('start', { taskId: a, targetId: target.id })
  await f.ok('start', { taskId: b, targetId: target.id })
  const ia = f.internal('chat-a', a), ib = f.internal('chat-a', b)
  assert.notEqual(ia, ib)
  assert.equal(f.host.service.get(ia).state, 'ready'); assert.equal(f.host.service.get(ib).state, 'ready')
  const sibling = f.host.service.get(ib), siblingEffects = structuredClone(f.devices.get(ib).calls)
  const assertSiblingUnchanged = () => {
    assert.deepEqual(f.host.service.get(ib), sibling)
    assert.deepEqual(f.devices.get(ib).calls, siblingEffects)
  }
  const frame = await f.ok('frame', { taskId: a })
  assert.equal(frame.targetId, target.id); assertSiblingUnchanged()
  await f.ok('pause', { taskId: a })
  assert.equal(f.host.service.get(ia).state, 'paused'); assertSiblingUnchanged()
  await f.ok('takeover', { taskId: a })
  assert.equal(f.host.service.get(ia).state, 'humanControl'); assertSiblingUnchanged()
  const humanFrame = await f.ok('frame', { taskId: a })
  await f.ok('act', { taskId: a, request: { actionId: 'human-a', frameId: humanFrame.frameId, action: { kind: 'click', x: 10, y: 10 } } })
  assert.equal(f.devices.get(ia).calls.filter(row => row.op === 'act').length, 1); assertSiblingUnchanged()
  await f.ok('stop', { taskId: a })
  assert.equal(f.host.service.get(ia).state, 'stopped'); assertSiblingUnchanged()
  assert.equal((await f.ok('frame', { taskId: b })).targetId, target.id, 'The sibling task still has a usable frame after the other task stops')
})

test('Host rejects unknown and foreign task identities before dispatching any driver effect', async t => {
  const f = await fixture(); t.after(() => f.dispose())
  const own = await f.task('chat-a'), foreign = await f.task('chat-b')
  await f.ok('start', { taskId: own, targetId: target.id })
  await f.ok('start', { sessionId: 'chat-b', taskId: foreign, targetId: target.id })
  const snapshots = f.host.service.list(), effects = structuredClone(f.effects), factories = [...f.factories]
  const controls = [
    ['status', {}], ['pending', {}], ['targets', {}], ['applications', {}],
    ['start', { targetId: target.id }], ['pause', {}], ['stop', {}], ['takeover', {}], ['resume', {}], ['frame', {}],
    ['act', { request: { actionId: 'foreign', frameId: 'foreign', action: { kind: 'click', x: 10, y: 10 } } }],
    ['connect', { mode: 'local' }], ['preview', {}], ['redock', {}], ['exchange', { request: { op: 'status' } }],
    ['decide', { requestId: 'foreign-request', requestVersion: 1, decision: 'once' }],
    ['cancelRequest', { requestId: 'foreign-request', requestVersion: 1 }],
  ]
  for (const taskId of [foreign, 'unregistered-opaque-task']) for (const [op, extra] of controls) {
    const result = await f.call(op, { taskId, ...extra })
    assert.equal(result.ok, false, `${op} accepted another task identity`)
    assert.equal(result.error.code, 'TASK_NOT_FOUND', `${op} reached its operation before validating task ownership`)
  }
  assert.deepEqual(f.factories, factories)
  assert.deepEqual(f.effects, effects, 'An unauthorized task must be rejected before native queries, file exchange or input')
  assert.deepEqual(f.host.service.list(), snapshots, 'Foreign controls must not change either task state or epoch')
})

test('Host routes two pending application approvals by task while preserving the real root Agent identity', async t => {
  const f = await fixture(); t.after(() => f.dispose())
  const a = await f.task(), b = await f.task()
  const ia = f.internal('chat-a', a), ib = f.internal('chat-a', b)
  const agent = f.rootAgent('chat-a')
  const execution = operationSessionId => ({ agent, operationSessionId, callId: crypto.randomUUID(), signal: new AbortController().signal })
  const catalogA = await f.host.entry.discover(execution(ia), { query: 'Isolated' })
  const catalogB = await f.host.entry.discover(execution(ib), { query: 'Isolated' })
  const waitA = f.host.entry.requestControl(execution(ia), catalogA.applications[0].candidateId, '操作当前任务的测试应用')
  const waitB = f.host.entry.requestControl(execution(ib), catalogB.applications[0].candidateId, '操作另一个任务的测试应用')
  const resultA = waitA.then(value => ({ value }), error => ({ error }))
  const resultB = waitB.then(value => ({ value }), error => ({ error }))
  const all = f.host.entry.pending()
  assert.equal(all.length, 2)
  const cardA = all.find(row => row.taskId === a), cardB = all.find(row => row.taskId === b)
  assert.ok(cardA); assert.ok(cardB)
  assert.equal(cardA.sessionId, agent.id); assert.equal(cardB.sessionId, agent.id)
  assert.notEqual(cardA.requestId, cardB.requestId)
  const pendingA = await f.ok('pending', { taskId: a }), pendingB = await f.ok('pending', { taskId: b })
  assert.deepEqual(pendingA.pendingRequests.map(row => row.requestId), [cardA.requestId])
  assert.deepEqual(pendingB.pendingRequests.map(row => row.requestId), [cardB.requestId])
  assert.equal(f.effects.some(row => ['lease', 'act'].includes(row.op)), false, 'Waiting approvals cannot acquire physical input')

  const before = structuredClone(f.effects)
  assert.equal((await f.call('decide', { taskId: b, requestId: cardA.requestId, requestVersion: 1, decision: 'once' })).ok, false)
  assert.equal((await f.call('cancelRequest', { taskId: b, requestId: cardA.requestId, requestVersion: 1 })).ok, false)
  assert.deepEqual(f.effects, before, 'A valid sibling task identity still cannot approve or cancel another task request')
  assert.equal(f.host.entry.pending().length, 2)

  await f.ok('cancelRequest', { taskId: a, requestId: cardA.requestId, requestVersion: 1 })
  assert.equal((await resultA).error?.code, 'REQUEST_CANCELLED')
  assert.deepEqual(f.host.entry.pending().map(row => row.requestId), [cardB.requestId])
  await f.ok('decide', { taskId: b, requestId: cardB.requestId, requestVersion: 1, decision: 'once' })
  assert.ok((await resultB).value)
  assert.equal(f.host.service.get(ia), undefined, 'The cancelled task never starts a control session')
  assert.equal(f.host.service.get(ib).state, 'ready')
  assert.equal(f.host.entry.pending().length, 0)
})
