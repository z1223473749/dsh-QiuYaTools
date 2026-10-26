import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/permission-coordinator.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { ComputerPermissionCoordinator } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const turn = () => new Promise(resolve => setImmediate(resolve))
function fixture(options = {}) {
  const agents = new Map(), roots = [], calls = [], grants = new Set(), sessions = new Map(), generations = new Map()
  let now = 1000, enabled = true, policy = true, beforeStart, beforeGrant
  const applications = [{ appId: 'C:\\private\\secret-user\\Excel.exe', name: 'Microsoft Excel', running: true }, { appId: 'fixture.other', name: 'Other', running: true }]
  const targets = applications.map((app, i) => ({ id: `target-${i}`, appId: app.appId, title: `private title ${i}`, pid: i + 1, x: 0, y: 0, width: 100, height: 100, scale: 1 }))
  const backend = {
    get: id => sessions.get(id), allowedApps: () => [...grants],
    async setAppAllowed(appId, allowed) { calls.push(['grant', appId, allowed]); await beforeGrant?.(); if (allowed) grants.add(appId); else grants.delete(appId) },
    async applicationsFor(id, signal) { calls.push(['apps', id]); signal?.throwIfAborted(); return applications },
    async targetsFor(id, signal) { calls.push(['targets', id]); signal?.throwIfAborted(); return targets },
    authorizationGeneration: id => generations.get(id) ?? 0,
    async authorizationStatus(id) { calls.push(['status', id]); return { available: true, permissions: { screenRecording: true, accessibility: true }, capabilities: { capture: true }, secret: 'not-for-model' } },
    async authorizationStart(id, targetId, input) {
      calls.push(['start', id, targetId, input.allowOnce]); await beforeStart?.(); input.signal.throwIfAborted()
      assert.equal(input.expectedGeneration, generations.get(id) ?? 0)
      assert.deepEqual(input.expectedTarget, Object.fromEntries(['id', 'appId', 'pid'].map(key => [key, targets.find(item => item.id === targetId)[key]])))
      const session = { sessionId: id, state: 'ready', target: targets.find(item => item.id === targetId), epoch: (sessions.get(id)?.epoch ?? 0) + 1, updatedAt: now }
      sessions.set(id, session); return session
    },
  }
  function exec(id = 'chat-a', callId = crypto.randomUUID()) {
    if (!agents.has(id)) { const agent = { id }; agents.set(id, agent); roots.push(agent) }
    return { callId, agent: agents.get(id), signal: new AbortController().signal }
  }
  const coordinator = new ComputerPermissionCoordinator({ backend, lookupAgent: id => agents.get(id), isRootAgent: agent => roots.includes(agent), enabled: () => enabled, canRequest: () => policy, now: () => now, ...options })
  const discover = async (execution = exec()) => { const value = await coordinator.discover(execution); return { execution, value, candidateId: value.applications[0].candidateId } }
  return { coordinator, backend, agents, roots, calls, grants, sessions, generations, applications, targets, exec, discover,
    clock: value => { now = value }, enabled: value => { enabled = value }, policy: value => { policy = value }, beforeStart: value => { beforeStart = value }, beforeGrant: value => { beforeGrant = value }, dispose: () => coordinator.dispose() }
}

test('discovery reveals application labels and opaque expiring IDs only, with no start/lease/window metadata', async () => {
  const f = fixture()
  try {
    const { value } = await f.discover(), serialized = JSON.stringify(value)
    assert.equal(value.applications[0].appName, 'Microsoft Excel'); assert.equal(value.applications[0].granted, false)
    for (const secret of ['secret-user', 'private title', 'not-for-model', 'C:', 'target-0', 'appId', 'imageBase64']) assert.equal(serialized.includes(secret), false, secret)
    assert.equal(f.calls.some(row => ['targets', 'grant', 'start', 'lease'].includes(row[0])), false)
  } finally { f.dispose() }
})

test('owner once starts only the requesting chat and never persists an application grant', async () => {
  const f = fixture()
  try {
    const { execution, candidateId } = await f.discover(), waiting = f.coordinator.requestControl(execution, candidateId, '填写测试表格')
    assert.equal(f.calls.some(row => row[0] === 'start'), false)
    const [card] = f.coordinator.pending(); assert.equal(card.sessionId, 'chat-a'); assert.equal(card.requestVersion, 1)
    await assert.rejects(f.coordinator.decide('chat-b', card.requestId, 1, 'once'), { code: 'REQUEST_STALE' })
    const decision = await f.coordinator.decide('chat-a', card.requestId, 1, 'once'), session = await waiting
    assert.equal(decision.state, 'approved'); assert.equal(session.sessionId, 'chat-a'); assert.deepEqual([...f.grants], [])
    assert.deepEqual(f.calls.find(row => row[0] === 'start'), ['start', 'chat-a', 'target-0', true])
    assert.equal(f.coordinator.pending().length, 0)
  } finally { f.dispose() }
})

test('always grant persists only after owner decision and future discovery can start without a second prompt', async () => {
  const f = fixture()
  try {
    let item = await f.discover(), waiting = f.coordinator.requestControl(item.execution, item.candidateId, '按用户要求编辑表格')
    const [card] = f.coordinator.pending(); assert.equal(f.grants.size, 0)
    await f.coordinator.decide('chat-a', card.requestId, 1, 'always'); await waiting
    assert.equal(f.grants.has(f.applications[0].appId), true)
    item = await f.discover(f.exec('chat-b')); assert.equal(item.value.applications[0].granted, true)
    f.policy(false)
    assert.equal((await f.coordinator.requestControl(item.execution, item.candidateId, '继续编辑')).sessionId, 'chat-b')
    assert.equal(f.coordinator.pending().length, 0)
  } finally { f.dispose() }
})

test('deny and owner cancellation reject model waiters and perform no start or grant', async () => {
  const f = fixture()
  try {
    let item = await f.discover(), waiting = f.coordinator.requestControl(item.execution, item.candidateId, '操作应用')
    let [card] = f.coordinator.pending(); const rejected = assert.rejects(waiting, { code: 'APP_DENIED' })
    assert.equal((await f.coordinator.decide('chat-a', card.requestId, 1, 'deny')).state, 'denied'); await rejected
    item = await f.discover(); waiting = f.coordinator.requestControl(item.execution, item.candidateId, '操作应用'); [card] = f.coordinator.pending()
    const cancelled = assert.rejects(waiting, { code: 'REQUEST_CANCELLED' }); f.coordinator.cancelRequest('chat-a', card.requestId, 1); await cancelled
    assert.equal(f.calls.some(row => ['grant', 'start'].includes(row[0])), false)
  } finally { f.dispose() }
})

test('live exact root Agent identity is mandatory, including after a request was displayed', async () => {
  const f = fixture()
  try {
    const item = await f.discover(), cloned = { ...item.execution, agent: { id: 'chat-a' } }
    await assert.rejects(f.coordinator.discover(cloned), { code: 'CALLER_NOT_LIVE' })
    const child = f.exec('child'); f.roots.splice(f.roots.indexOf(child.agent), 1)
    await assert.rejects(f.coordinator.discover(child), { code: 'DELEGATED_CALLER' })
    const waiting = f.coordinator.requestControl(item.execution, item.candidateId, '操作应用'), [card] = f.coordinator.pending()
    const rejected = assert.rejects(waiting, { code: 'CALLER_NOT_LIVE' }); f.agents.set('chat-a', { id: 'chat-a' })
    await assert.rejects(f.coordinator.decide('chat-a', card.requestId, 1, 'always'), { code: 'REQUEST_STALE' }); await rejected
    assert.equal(f.grants.size, 0)
  } finally { f.dispose() }
})

test('generation changes, pause, takeover, disable and abort fence late owner answers without input', async () => {
  for (const variant of ['generation', 'paused', 'humanControl', 'disabled', 'abort']) {
    const f = fixture()
    try {
      const abort = new AbortController(), item = await f.discover({ ...f.exec(), signal: abort.signal })
      const waiting = f.coordinator.requestControl(item.execution, item.candidateId, '操作应用'), [card] = f.coordinator.pending(), rejected = assert.rejects(waiting)
      if (variant === 'generation') f.generations.set('chat-a', 1)
      else if (variant === 'disabled') f.enabled(false)
      else if (variant === 'abort') abort.abort()
      else f.sessions.set('chat-a', { sessionId: 'chat-a', state: variant })
      await assert.rejects(f.coordinator.decide('chat-a', card.requestId, 1, 'once')); await rejected
      assert.equal(f.calls.some(row => ['grant', 'start'].includes(row[0])), false, variant)
    } finally { f.dispose() }
  }
})

test('candidates cannot cross chat, survive expiry, or implicitly resume a human-controlled session', async () => {
  const f = fixture()
  try {
    const item = await f.discover()
    assert.throws(() => f.coordinator.requestControl(f.exec('chat-b'), item.candidateId, '操作应用'), { code: 'CANDIDATE_EXPIRED' })
    f.clock(100_000)
    assert.throws(() => f.coordinator.requestControl(item.execution, item.candidateId, '操作应用'), { code: 'CANDIDATE_EXPIRED' })
    const fresh = await f.discover(); f.sessions.set('chat-a', { state: 'humanControl' })
    assert.throws(() => f.coordinator.requestControl(fresh.execution, fresh.candidateId, '操作应用'), { code: 'OWNER_RESUME_REQUIRED' })
  } finally { f.dispose() }
})

test('tool call and owner decision replay return the same result with no second start; conflicting replay is rejected', async () => {
  const f = fixture()
  try {
    const item = await f.discover(), a = f.coordinator.requestControl(item.execution, item.candidateId, '操作应用'), b = f.coordinator.requestControl(item.execution, item.candidateId, '操作应用')
    assert.equal(a, b); const [card] = f.coordinator.pending()
    assert.throws(() => f.coordinator.requestControl(item.execution, 'another-candidate', '操作应用'), { code: 'CALL_REPLAY_MISMATCH' })
    const first = await f.coordinator.decide('chat-a', card.requestId, 1, 'once'); await Promise.all([a, b])
    assert.deepEqual(await f.coordinator.decide('chat-a', card.requestId, 1, 'once'), first)
    await assert.rejects(f.coordinator.decide('chat-a', card.requestId, 1, 'always'), { code: 'REQUEST_STALE' })
    assert.equal(f.calls.filter(row => row[0] === 'start').length, 1)
  } finally { f.dispose() }
})

test('stop while owner grant is being persisted cannot start after its late completion', async () => {
  const f = fixture(); let resume
  try {
    f.beforeGrant(() => new Promise(resolve => { resume = resolve }))
    const item = await f.discover(), waiting = f.coordinator.requestControl(item.execution, item.candidateId, '操作应用'), [card] = f.coordinator.pending()
    const rejected = assert.rejects(waiting), deciding = f.coordinator.decide('chat-a', card.requestId, 1, 'always')
    await turn(); f.generations.set('chat-a', 1); f.coordinator.cancelSession('chat-a'); resume()
    await assert.rejects(deciding); await rejected
    assert.equal(f.calls.some(row => row[0] === 'start'), false)
  } finally { f.dispose() }
})

test('request expiry, per-chat pending and bounded outstanding calls fail closed', async () => {
  const f = fixture({ requestTtlMs: 10 })
  try {
    const item = await f.discover(), waiting = f.coordinator.requestControl(item.execution, item.candidateId, '操作应用')
    assert.throws(() => f.coordinator.requestControl({ ...item.execution, callId: 'new-call' }, item.candidateId, '操作应用'), { code: 'REQUEST_PENDING' })
    const rejected = assert.rejects(waiting, { code: 'REQUEST_EXPIRED' }); f.clock(1011); assert.deepEqual(f.coordinator.pending(), []); await rejected
    f.policy(false); const next = await f.discover()
    assert.throws(() => f.coordinator.requestControl(next.execution, next.candidateId, '操作应用'), { code: 'APPROVAL_DISABLED' })
  } finally { f.dispose() }
})

test('installed application launch occurs only after approval in the same existing environment', async () => {
  const f = fixture()
  try {
    f.applications[0].running = false; f.applications[0].launchable = true
    const saved = f.targets.shift()
    f.backend.launchApplicationFor = async (id, appId) => { f.calls.push(['launch', id, appId]); f.targets.unshift(saved) }
    const item = await f.discover(f.exec('remote-chat')), waiting = f.coordinator.requestControl(item.execution, item.candidateId, '打开应用'), [card] = f.coordinator.pending()
    assert.equal(f.calls.some(row => row[0] === 'launch'), false)
    await f.coordinator.decide('remote-chat', card.requestId, 1, 'once'); await waiting
    assert.deepEqual(f.calls.find(row => row[0] === 'launch'), ['launch', 'remote-chat', f.applications[0].appId])
    assert.equal(f.calls.some(row => row[0] === 'connect'), false)
  } finally { f.dispose() }
})

test('dispose rejects pending waiters and stale decisions cannot resurrect a coordinator', async () => {
  const f = fixture(), item = await f.discover(), waiting = f.coordinator.requestControl(item.execution, item.candidateId, '操作应用'), [card] = f.coordinator.pending()
  const rejected = assert.rejects(waiting); f.dispose(); await rejected
  await assert.rejects(f.coordinator.decide('chat-a', card.requestId, 1, 'once'), { code: 'REQUEST_STALE' })
  await assert.rejects(f.coordinator.discover(item.execution), { code: 'DISABLED' })
})

test('query and browser filters are applied before candidate bounds in a catalog larger than 300 apps', async () => {
  const f = fixture()
  try {
    f.applications.unshift(...Array.from({ length: 350 }, (_, i) => ({ appId: `a-${i}`, name: `A app ${i}`, running: false })))
    f.applications.push({ appId: 'com.google.Chrome', name: 'Google Chrome', running: true })
    const exec = f.exec(), value = await f.coordinator.discover(exec, { query: 'Chrome', kind: 'browser' })
    assert.deepEqual(value.applications.map(item => item.appName), ['Google Chrome'])
    assert.equal(value.truncated, false); assert.equal(JSON.stringify(value).includes('com.google.Chrome'), false)
    const applicationOnly = await f.coordinator.discover(exec, { query: 'Chrome', kind: 'application' })
    assert.equal(applicationOnly.applications.length, 0)
    const limited = await f.coordinator.discover(exec); assert.equal(limited.applications.length, 64); assert.equal(limited.truncated, true)
    await assert.rejects(f.coordinator.discover(exec, { query: '\0' }), { code: 'INVALID_REQUEST' })
    await assert.rejects(f.coordinator.discover(exec, { kind: 'raw-window' }), { code: 'INVALID_REQUEST' })
  } finally { f.dispose() }
})

test('missing OS permissions preserves the request without consuming its grant; fresh owner retry can succeed', async () => {
  const f = fixture(); let permitted = false
  try {
    f.backend.authorizationStatus = async () => ({ available: true, platform: 'darwin', permissions: { screenRecording: permitted, accessibility: true, postEvents: true } })
    const item = await f.discover(), waiting = f.coordinator.requestControl(item.execution, item.candidateId, '操作应用'), [card] = f.coordinator.pending()
    await assert.rejects(f.coordinator.decide('chat-a', card.requestId, 1, 'always'), { code: 'SYSTEM_PERMISSION_REQUIRED' })
    assert.equal(f.coordinator.pending().length, 1); assert.equal(f.grants.size, 0); assert.equal(f.calls.some(row => row[0] === 'start'), false)
    permitted = true
    const [updated] = await f.coordinator.pendingWithPreflight('chat-a'); assert.equal(updated.preflight.permissions.screenRecording, true)
    await f.coordinator.decide('chat-a', card.requestId, 1, 'once'); await waiting
  } finally { f.dispose() }
})

test('a failed pending permission read preserves its device identity, retires old grants and never exposes driver error details', async () => {
  const f = fixture()
  try {
    f.backend.authorizationStatus = async () => ({ available: true, platform: 'darwin', mode: 'remote', permissions: { screenRecording: true, accessibility: true, postEvents: true } })
    const item = await f.discover(); void f.coordinator.requestControl(item.execution, item.candidateId, '操作应用')
    f.backend.authorizationStatus = async () => { throw new Error('/Users/private/helper endpoint=https://private/?token=credential') }
    const [card] = await f.coordinator.pendingWithPreflight('chat-a')
    assert.equal(card.preflight.platform, 'darwin'); assert.equal(card.preflight.mode, 'remote'); assert.equal(card.preflight.available, false)
    assert.deepEqual(card.preflight.permissions, {}); assert.deepEqual(card.preflight.capabilities, {})
    assert.match(card.preflight.message, /无法检查系统权限/u)
    assert.doesNotMatch(JSON.stringify(card.preflight), /Users|endpoint|token|credential/u)
    assert.equal(f.grants.size, 0); assert.equal(f.calls.some(row => row[0] === 'start'), false)
  } finally { f.dispose() }
})

test('a disconnected executor is not reported as missing OS permission and its pending request can recover without a new grant', async () => {
  const f = fixture(); let connected = true
  try {
    f.backend.authorizationStatus = async () => ({ available: connected, platform: 'darwin', mode: 'local', permissions: connected ? { screenRecording: true, accessibility: true, postEvents: true } : undefined, message: 'private local driver diagnostic' })
    const item = await f.discover(), waiting = f.coordinator.requestControl(item.execution, item.candidateId, '操作应用'), [card] = f.coordinator.pending()
    connected = false
    await assert.rejects(f.coordinator.decide('chat-a', card.requestId, 1, 'always'), { code: 'NATIVE_UNAVAILABLE' })
    assert.equal(f.coordinator.pending().length, 1); assert.equal(f.grants.size, 0); assert.equal(f.calls.some(row => row[0] === 'start'), false)
    const [failed] = await f.coordinator.pendingWithPreflight('chat-a')
    assert.equal(failed.preflight.available, false); assert.match(failed.preflight.message, /无法检查/u)
    assert.doesNotMatch(JSON.stringify(failed.preflight), /private local/u)
    connected = true
    await f.coordinator.decide('chat-a', card.requestId, 1, 'once'); await waiting
    assert.equal(f.grants.size, 0); assert.equal(f.coordinator.pending().length, 0)
  } finally { f.dispose() }
})

test('approval policy changed to never before owner confirmation cannot create a new grant', async () => {
  const f = fixture()
  try {
    const item = await f.discover(), waiting = f.coordinator.requestControl(item.execution, item.candidateId, '操作应用'), [card] = f.coordinator.pending()
    const rejected = assert.rejects(waiting, { code: 'APPROVAL_DISABLED' }); f.policy(false)
    await assert.rejects(f.coordinator.decide('chat-a', card.requestId, 1, 'always'), { code: 'APPROVAL_DISABLED' }); await rejected
    assert.equal(f.grants.size, 0); assert.equal(f.calls.some(row => row[0] === 'start'), false)
  } finally { f.dispose() }
})

test('launch is never replayed while the first application window appears asynchronously', async () => {
  const f = fixture()
  try {
    f.applications[0].launchable = true; const target = f.targets.shift(); let enumerations = 0
    f.backend.targetsFor = async id => { f.calls.push(['targets', id]); if (++enumerations === 4) f.targets.unshift(target); return f.targets }
    f.backend.launchApplicationFor = async id => { f.calls.push(['launch', id]) }
    const item = await f.discover(), waiting = f.coordinator.requestControl(item.execution, item.candidateId, '打开应用'), [card] = f.coordinator.pending()
    await f.coordinator.decide('chat-a', card.requestId, 1, 'once'); await waiting
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, 1)
    assert.equal(f.calls.filter(row => row[0] === 'start').length, 1)
  } finally { f.dispose() }
})

test('pending preflight is scoped to each chat environment and never uses unrelated local Mac permissions', async () => {
  const f = fixture()
  try {
    f.backend.authorizationStatus = async id => ({ available: true, platform: id === 'local' ? 'darwin' : 'win32', mode: id === 'local' ? 'local' : 'remote', permissions: { accessibility: id !== 'local' } })
    for (const id of ['local', 'remote']) { const item = await f.discover(f.exec(id)); void f.coordinator.requestControl(item.execution, item.candidateId, '操作应用') }
    const cards = await f.coordinator.pendingWithPreflight()
    assert.equal(cards.find(item => item.sessionId === 'local').preflight.permissions.accessibility, false)
    const remote = cards.find(item => item.sessionId === 'remote'); assert.equal(remote.preflight.mode, 'remote'); assert.equal(remote.preflight.permissions.accessibility, true)
    const result = await f.coordinator.decide('remote', remote.requestId, 1, 'once'); assert.equal(result.session.sessionId, 'remote')
  } finally { f.dispose() }
})

test('the current chat can reuse its active once grant while another chat still requires owner approval', async () => {
  const f = fixture()
  try {
    let item = await f.discover(), waiting = f.coordinator.requestControl(item.execution, item.candidateId, 'task'), [card] = f.coordinator.pending()
    await f.coordinator.decide('chat-a', card.requestId, 1, 'once'); await waiting
    item = await f.discover(); assert.equal(item.value.applications[0].granted, true)
    await f.coordinator.requestControl(item.execution, item.candidateId, 'continue'); assert.equal(f.coordinator.pending().length, 0)
    const other = await f.discover(f.exec('chat-b')); assert.equal(other.value.applications[0].granted, false)
    void f.coordinator.requestControl(other.execution, other.candidateId, 'other task'); assert.equal(f.coordinator.pending('chat-b').length, 1)
    assert.equal(f.grants.size, 0)
  } finally { f.dispose() }
})

test('unapproved discovery does not leak paths or pairing data from driver failures', async () => {
  const f = fixture()
  try {
    f.backend.applicationsFor = async () => { throw new Error('ENOENT /Users/private/person/helper endpoint=https://private/?token=credential') }
    const error = await f.coordinator.discover(f.exec()).then(() => null, value => value)
    assert.equal(error.code, 'DISCOVERY_UNAVAILABLE')
    assert.equal(/Users|person|endpoint|token|credential|helper/.test(error.message), false)
  } finally { f.dispose() }
})
