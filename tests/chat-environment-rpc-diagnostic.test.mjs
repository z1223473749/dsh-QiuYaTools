import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatEnvironmentRPCDiagnostic } from '../scripts/chat-environment-rpc-diagnostic.mjs'
const switching = { ok: false, error: { code: 'COMPUTER_FAILED', message: '正在切换操作环境，请稍候。' } }
function fixture() { let time = 0; const log = createChatEnvironmentRPCDiagnostic({ knownSession: id => ['a', 'b'].includes(id), now: () => ++time }); return { log, begin(key, op, sessionId = 'a', taskId, surface = 'chat') { log.begin(key, { rpcId: key, payload: { op, sessionId, ...(taskId === undefined ? {} : { taskId }), mode: 'browser', token: 'PRIVATE_NOT_RECORDED', endpoint: 'https://private.invalid' } }, surface) } } }
test('only a correlated same-operation readonly pending poll during a real owner connect is expected', () => {
  const f = fixture(); f.begin('connect', 'connect'); f.begin('pending', 'pending')
  const result = f.log.finish('pending', switching)
  assert.equal(result.expected, true); assert.equal(result.error.op, 'pending'); assert.equal(result.error.sessionId, 'a'); assert.equal(result.error.ownerConnect.rpcId, 'connect'); assert.equal(result.error.ownerConnect.outcome, 'in-flight')
  f.log.finish('connect', { ok: true }); assert.equal(f.log.snapshot().ownerConnections[0].outcome, 'succeeded')
  assert.ok(!JSON.stringify(f.log.snapshot()).includes('PRIVATE_')); assert.ok(!JSON.stringify(f.log.snapshot()).includes('private.invalid'))
})
test('connect failures, mutating calls, status, other codes/messages/chat/task/surface and non-overlapping polls remain errors', () => {
  for (const variant of ['connect', 'act', 'status', 'code', 'message', 'chat', 'task', 'surface', 'after', 'before', 'none', 'unknown-chat', 'failed-transport']) {
    const f = fixture()
    if (variant === 'before') { f.begin('pending', 'pending'); assert.equal(f.log.finish('pending', switching).expected, false); f.begin('connect', 'connect'); continue }
    if (variant !== 'none') { f.begin('connect', 'connect'); if (variant === 'after') f.log.finish('connect', { ok: true }); if (variant === 'failed-transport') f.log.failed('connect') }
    f.begin('bad', ['connect', 'act', 'status'].includes(variant) ? variant : 'pending', variant === 'chat' ? 'b' : variant === 'unknown-chat' ? 'unknown' : 'a', variant === 'task' ? 'other-task' : undefined, variant === 'surface' ? 'settings' : 'chat')
    const reply = variant === 'code' ? { ok: false, error: { ...switching.error, code: 'BROWSER_TIMEOUT' } } : variant === 'message' ? { ok: false, error: { ...switching.error, message: '正在切换操作环境，请稍候。extra' } } : switching
    assert.equal(f.log.finish('bad', reply).expected, false, variant)
  }
})
test('task identity must exactly match, including default root vs a child task', () => {
  const f = fixture(); f.begin('connect', 'connect', 'a', 'task1'); f.begin('root', 'pending'); f.begin('other', 'pending', 'a', 'task2'); f.begin('same', 'pending', 'a', 'task1')
  assert.equal(f.log.finish('root', switching).expected, false); assert.equal(f.log.finish('other', switching).expected, false); assert.equal(f.log.finish('same', switching).expected, true)
})

import { ownedBrowserRenderingPlan, assertNoWorkbenchPreviewTimeouts, createRPCResponseCollector, workbenchRPCMetadata } from '../scripts/chat-environment-rpc-diagnostic.mjs'
import { readFile } from 'node:fs/promises'
test('owned-browser scheduling A/B defaults to unchanged args and only enables the three requested flags explicitly', () => {
  assert.deepEqual(ownedBrowserRenderingPlan([]), { stableOwnedRendering: false, rawOwnedCDP: false, preserveOwnedCDPCompression: false, browserArguments: [] })
  const enabled = ownedBrowserRenderingPlan(['--package', 'fixture.tgz', '--stable-owned-rendering', '--raw-owned-cdp'])
  assert.deepEqual(enabled, { stableOwnedRendering: true, rawOwnedCDP: true, preserveOwnedCDPCompression: false, browserArguments: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] })
  assert.deepEqual(ownedBrowserRenderingPlan(['--raw-owned-cdp']).browserArguments, [])
  assert.equal(ownedBrowserRenderingPlan(['--preserve-owned-cdp-compression']).preserveOwnedCDPCompression, true)
  assert.throws(() => ownedBrowserRenderingPlan(['--raw-owned-cdp', '--preserve-owned-cdp-compression']))
  assert.throws(() => ownedBrowserRenderingPlan(['--stable-owned-rendering', '--stable-owned-rendering']))
  assert.throws(() => ownedBrowserRenderingPlan(['--raw-owned-cdp', '--raw-owned-cdp']))
})
test('a single observed BROWSER_TIMEOUT fails realtime acceptance even after a later good frame; CONTROL_CHANGED stays explicit', () => {
  assert.deepEqual(assertNoWorkbenchPreviewTimeouts([{ op: 'preview', code: 'CONTROL_CHANGED' }]), { observedBrowserTimeouts: 0, transientControlChanged: 1 })
  for (const errors of [[{ op: 'preview', code: 'BROWSER_TIMEOUT' }], [{ op: 'status', code: 'BROWSER_TIMEOUT' }], [{ op: 'preview', code: 'BROWSER_TIMEOUT' }, { op: 'preview', code: 'CONTROL_CHANGED' }]]) assert.throws(() => assertNoWorkbenchPreviewTimeouts(errors), /not a successful realtime acceptance/u)
  for (const code of ['BROWSER_CDP_FAILED', 'BROWSER_CLEANUP_FAILED', 'COMPUTER_FAILED', 'NOT_READY', undefined]) assert.throws(() => assertNoWorkbenchPreviewTimeouts([{ op: 'preview', code }]), /unexpected error responses/u)
})
test('installed runner keeps exact deny-proxy isolation, zero extra owned-page controller and exact candidate checks in both transport modes', async () => {
  const source = await readFile(new URL('../scripts/test-computer-chat-environment.mjs', import.meta.url), 'utf8')
  assert.match(source, /if \(!ownedRendering\.rawOwnedCDP\) \{\s*cdpMetadataProxy = await createCDPMetadataProxy/u)
  assert.ok(source.includes("await context.route('**/*', async route =>"), 'The separate Harness UI browser retains its original interception')
  assert.ok(source.includes('ownedFixtureProxy = await createOwnedFixtureProxy({ fixtureOrigin, fixturePath })'))
  assert.ok(source.includes('`--proxy-server=${ownedFixtureProxy.endpoint}`'))
  assert.ok(source.includes("'--proxy-bypass-list=<-loopback>'"))
  assert.ok(!source.includes('connectOverCDP') && !source.includes('ownedBrowserControl'), 'The operated browser must have only installed product controllers')
  assert.ok(source.includes('assert.equal(sha256(await readFile(candidate)), candidateSha256)'))
  assert.equal((source.match(/assertNoWorkbenchPreviewTimeouts\(workbenchErrors\)/gu) ?? []).length, 4)
  assert.ok(source.includes("...ownedRendering.browserArguments"))
  assert.ok(source.includes("for (let round = 1; round <= 6; round++)"))
  assert.ok(source.includes("computerRpc('frame', sessions[0], { taskId: a.taskId })"))
  assert.ok(source.includes("computerRpc('frame', sessions[0], { taskId: b.taskId })"))
  assert.ok(source.includes('inspectOwnedFixtureFrame(observation, { targetId: task.targetId, variant: task.variant }, jpegjs.decode)'))
  assert.ok(source.includes('inspectOwnedFixtureFrame({ targetId: receipt.targetId'))
  assert.ok(source.includes('assert.equal(url.pathname, ownedBrowserSocketPath)'))
  assert.ok(source.includes("assert.equal(child.exitCode, 0"))
  assert.ok(source.indexOf('rpcObservationClosing = true') < source.indexOf('await bounded(Promise.resolve(browser?.close())'))
  assert.ok(source.indexOf('await rpcResponses.drain(') < source.indexOf('await bounded(Promise.resolve(browser?.close())'))
  assert.ok(source.includes('teardownHeldRPCs.push({ route, done })'))
  assert.ok(source.includes("assert.deepEqual(rpcTransportFailures, []"))
  assert.ok(source.includes('target.origin === ownerOrigin'))
  assert.ok(source.includes("url.pathname === '/api/qiuya-tools.workbench'"))
  assert.ok(source.includes("url.pathname === '/api/qiuya-tools.computer.control'"))
  assert.ok(source.includes('route.fetch({ maxRetries: 0, maxRedirects: 0, timeout })'))
  assert.ok(source.indexOf('const reply = await upstream.json()') < source.indexOf('await route.fulfill({ response: upstream })'))
  assert.ok(source.includes("request.failure()?.errorText !== 'net::ERR_ABORTED'"))
  assert.ok(!source.includes("page.on('response'"), 'Renderer-aborted response bodies cannot be the source of Host acceptance receipts')
})
test('response drain waits for a delayed body before evaluating a real timeout, without saving the body', async () => {
  const collector = createRPCResponseCollector(), errors = []
  let release; const body = new Promise(done => { release = done })
  collector.collect({ channel: 'workbench', op: 'preview' }, async () => { await body; errors.push({ op: 'preview', code: 'BROWSER_TIMEOUT' }) })
  assert.equal(collector.snapshot().pending, 1)
  const drained = collector.drain(100); release(); await drained
  assert.equal(collector.snapshot().decoded, 1); assert.equal(collector.snapshot().pending, 0)
  assert.throws(() => assertNoWorkbenchPreviewTimeouts(errors))
  assert.equal(collector.snapshot().savedResponseBodies, false)
})
test('body-read failures and never-finished callbacks cannot become a green zero-timeout receipt', async () => {
  const collector = createRPCResponseCollector()
  collector.collect({ channel: 'workbench', op: 'preview' }, async () => { throw Error('PRIVATE_RESPONSE_BODY_OR_TOKEN') })
  await assert.rejects(collector.drain(100), /unconfirmed/u)
  assert.equal(JSON.stringify(collector.snapshot()).includes('PRIVATE'), false)
  const stuck = createRPCResponseCollector(); let finish
  stuck.collect({ channel: 'computer', op: 'frame' }, () => new Promise(done => { finish = done }))
  await assert.rejects(stuck.drain(10), /original budget/u)
  finish(); await assert.rejects(stuck.drain(100), /unconfirmed/u)
})

test('workbench evidence projects only exact own identities, original control outcome and request/receipt times', () => {
  const envelope = { rpcId: 'own-rpc', payload: { op: 'control', chatSessionId: 'own-chat', environmentId: 'own-environment', workbenchTabId: 'own-view', operation: 'stop', token: 'PRIVATE_TOKEN', endpoint: 'https://private.invalid', action: { text: 'PRIVATE_DRAFT' } } }
  const failed = workbenchRPCMetadata(envelope, 10, 25, { ok: false, error: { code: 'VIEW_CHANGED', message: 'PRIVATE_BODY' }, value: { imageBase64: 'PRIVATE_IMAGE' } }, 'own-task')
  assert.deepEqual(failed, { issuedAtMs: 10, rpcId: 'own-rpc', chatSessionId: 'own-chat', environmentId: 'own-environment', workbenchTabId: 'own-view', taskId: 'own-task', op: 'control', operation: 'stop', receivedAtMs: 25, ok: false, code: 'VIEW_CHANGED' })
  const success = workbenchRPCMetadata(envelope, 30, 38, { ok: true, value: { completed: true, secret: 'PRIVATE_RESPONSE' } })
  assert.equal(success.ok, true); assert.equal(success.code, undefined); assert.equal(success.operation, 'stop')
  assert.equal(JSON.stringify([failed, success]).includes('PRIVATE'), false); assert.equal(JSON.stringify(failed).includes('private.invalid'), false)
  const invalid = workbenchRPCMetadata({ rpcId: 'https://private.invalid', payload: { op: 'PRIVATE_OP', operation: 'PRIVATE_CONTROL', environmentId: 'unsafe\nidentity' } }, 1)
  assert.deepEqual(invalid, { issuedAtMs: 1 })
})
