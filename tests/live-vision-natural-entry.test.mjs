/** Pure Node regression only: no build, Host, PD, model, GUI, sockets or input. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { VisionPolicy, VISION_TOOLS, NATURAL_VISION_TOOLS, naturalVisionPrompt, visionApprovalReadback, visionPreauthorizationPassed, withVisionFailureEvidence, persistVisionFinalImage } from '../scripts/live-vision-guard-core.mjs'
import { createVisionLocalOwnerFetch, validateVisionAutoRun } from '../scripts/live-vision-host-autorun.mjs'
import { transformWindowsVisionGuard, prepareLiveVisionWindows, assertVisionSerializedPatchConfig } from '../scripts/prepare-live-vision-windows.mjs'
import { visionBundlePatch } from '../scripts/prepare-live-vision.mjs'

const ids = [1, 2, 3].map(() => `qiuya-vision-${randomUUID()}`), hash = 'a'.repeat(64), target = { id: 'window:owned', pid: 42, appId: 'own-fixture' }
const authorizedAppId = 'remote:owned:own-fixture', selection = { provider: 'offline-synthetic', model: 'offline-no-inference' }
const preauthorization = { phase: 'before-owner-once', nativeCalls: { observe: 0, preview: 0, lease: 0, act: 0 }, desktopAudit: { sessionId: 1, auditSourceSha256: hash, userInteractive: true, activeDesktopAccessible: true, activeDesktopMatches: true, heldKeyCount: 0, leaseScopeExists: true, leaseFree: true, journalPresent: false } }
const proof = { sessionId: ids[0], appId: authorizedAppId, requestId: randomUUID(), requestVersion: 1, decision: 'once', state: 'pending', allowedAppsUnchanged: true, preauthorization: { ...preauthorization, passed: true } }
const ready = { sessionId: ids[0], state: 'ready', target: { ...target, appId: authorizedAppId } }
const policy = (extra = {}) => new VisionPolicy({ sessionId: ids[0], task: 1, target, selection, now: () => 1000, testOnlyNaturalEntry: true, ...extra })
const exec = (name, args = {}) => ({ agent: { id: ids[0] }, name, arguments: args })
const request = (extra = {}) => ({ sessionId: ids[0], ...selection, tools: NATURAL_VISION_TOOLS.map(name => ({ name })), messages: [], ...extra })

function serializableNaturalConfig(patchId = randomUUID()) {
  return { native: '/private/tmp/owned/native.exe', directory: '/private/tmp/owned', externalCarrierConfig: '/private/tmp/owned/external-config.json', testOnlyAutoRun: true, runId: randomUUID(), expiresAt: Date.now() + 600000, manifestSHA: hash, testOnlySessionIds: [...ids], testOnlyPatchEntryId: `qiuya-live-vision-test-${patchId}`, testOnlyNaturalEntry: true, testOnlyOwnerOnce: true }
}

test('real bundle serializer preserves both natural flags through the exact package JSON roundtrip', () => {
  const patchId = randomUUID(), config = serializableNaturalConfig(patchId)
  const patch = visionBundlePatch(config, patchId), serialized = JSON.stringify(patch, null, 2) + '\n'
  const parsed = assertVisionSerializedPatchConfig(config, serialized)
  assert.deepEqual(parsed[0].insert[0].config, config)
  assert.equal(parsed[0].insert[0].id, config.testOnlyPatchEntryId)
  assert.equal(parsed[0].insert[0].config.testOnlyNaturalEntry, true)
  assert.equal(parsed[0].insert[0].config.testOnlyOwnerOnce, true)
  const legacy = { native: config.native, directory: config.directory }
  assert.deepEqual(JSON.parse(JSON.stringify(visionBundlePatch(legacy, patchId)))[0].insert[0].config, legacy)
  const autoLegacy = { ...config }; delete autoLegacy.testOnlyNaturalEntry; delete autoLegacy.testOnlyOwnerOnce
  assert.deepEqual(assertVisionSerializedPatchConfig(autoLegacy, JSON.stringify(visionBundlePatch(autoLegacy, patchId)))[0].insert[0].config, autoLegacy)
  const probe = { ...autoLegacy, testOnlyProbeOnly: true }
  assert.deepEqual(assertVisionSerializedPatchConfig(probe, JSON.stringify(visionBundlePatch(probe, patchId)))[0].insert[0].config, probe)
})

test('real bundle serializer rejects unknown fields and every incomplete natural opt-in before package serialization', () => {
  const patchId = randomUUID(), config = serializableNaturalConfig(patchId)
  for (const field of ['testOnlyNaturalEntry', 'testOnlyOwnerOnce', 'testOnlyAutoRun', 'manifestSHA']) {
    const partial = { ...config }; delete partial[field]
    assert.throws(() => visionBundlePatch(partial, patchId), /Partial|both test-only/u)
  }
  for (const patch of [{ unknownFutureField: true }, { testOnlyOwnerOnce: false }, { testOnlyNaturalEntry: 'true' }, { testOnlyProbeOnly: true }]) assert.throws(() => visionBundlePatch({ ...config, ...patch }, patchId), /Unknown|explicitly true|both test-only/u)
  assert.throws(() => visionBundlePatch({ native: config.native, directory: config.directory, testOnlyOwnerOnce: true }, patchId), /Partial/u)
})

test('Windows package assertion detects the actual serializer drop, any unknown field, and type changes while ignoring key order', async () => {
  const patchId = randomUUID(), config = serializableNaturalConfig(patchId)
  const actual = visionBundlePatch(config, patchId)
  for (const field of ['testOnlyNaturalEntry', 'testOnlyOwnerOnce']) {
    const dropped = structuredClone(actual); delete dropped[0].insert[0].config[field]
    assert.throws(() => assertVisionSerializedPatchConfig(config, JSON.stringify(dropped)), /complete prepared configuration/u)
  }
  const unknown = structuredClone(actual); unknown[0].insert[0].config.unknownFutureField = true
  assert.throws(() => assertVisionSerializedPatchConfig(config, JSON.stringify(unknown)), /complete prepared configuration/u)
  const changed = structuredClone(actual); changed[0].insert[0].config.testOnlyOwnerOnce = 'true'
  assert.throws(() => assertVisionSerializedPatchConfig(config, JSON.stringify(changed)), /complete prepared configuration/u)
  const reordered = structuredClone(actual); reordered[0].insert[0].config = Object.fromEntries(Object.entries(config).reverse())
  assert.deepEqual(assertVisionSerializedPatchConfig(config, JSON.stringify(reordered))[0].insert[0].config, config)
  assert.throws(() => assertVisionSerializedPatchConfig({ ...config, externalCarrierConfig: undefined }, JSON.stringify(actual)), /complete prepared configuration/u)
  const source = await readFile(new URL('../scripts/prepare-live-vision-windows.mjs', import.meta.url), 'utf8')
  assert.ok(source.indexOf('assertVisionSerializedPatchConfig(config,serializedPatch)') < source.indexOf("await cp(plugin,join(packageDir,'guard-plugin.mjs')"))
  assert.match(source, /writeFile\(join\(packageDir,'cordis\.patch\.yml'\),serializedPatch\)/u)
})

test('approval policy readback only reads this exact root session and never modifies global or session policy', () => {
  const session = {}, reads = [], approval = { config: { policy: 'never' }, overrideOf(value) { reads.push(value); return 'ask' } }
  assert.deepEqual(visionApprovalReadback(approval, session), { explicitNever: false, effectivePresent: true, allowedNewRequests: true, source: 'session-override' })
  assert.deepEqual(reads, [session]); assert.equal(approval.config.policy, 'never')
  assert.deepEqual(visionApprovalReadback({ config: { policy: 'never' } }, session), { explicitNever: true, effectivePresent: true, allowedNewRequests: false, source: 'configured-default' })
  assert.deepEqual(visionApprovalReadback(undefined, session), { explicitNever: false, effectivePresent: false, allowedNewRequests: true, source: 'absent-default' })
  assert.equal(visionApprovalReadback({ config: { policy: 'future-non-never-policy' } }, session).allowedNewRequests, true)
  assert.throws(() => visionApprovalReadback({ overrideOf() { throw Error('read failed') } }, session), /read failed/u)
})

test('only explicit task 1 has six production tool names; legacy and budgets retain their exact boundaries', () => {
  const natural = policy(), legacy = policy({ testOnlyNaturalEntry: false })
  assert.deepEqual(legacy.toolNames, VISION_TOOLS); assert.equal(natural.toolNames.length, 6)
  assert.equal(natural.toolNames.includes('qiuya_computer_decide'), false)
  for (const task of [2, 3]) assert.throws(() => policy({ task }), { code: 'VISION_POLICY_CONFIGURATION' })
  for (const extra of [{ maxRequests: 13 }, { deadlineMs: 180001 }]) assert.throws(() => policy(extra), { code: 'VISION_POLICY_CONFIGURATION' })
  natural.arm(); legacy.arm()
  assert.equal(legacy.toolGuard(exec('qiuya_computer_discover')), 'VISION_TOOL_NOT_ALLOWED')
  assert.equal(natural.toolGuard(exec('qiuya_computer_discover')), undefined)
  for (const name of ['qiuya_computer_act', 'qiuya_computer_observe', 'qiuya_computer_pause']) assert.equal(natural.toolGuard(exec(name)), 'VISION_NATURAL_NOT_APPROVED')
  assert.throws(() => natural.admitRequest(request({ messages: [{ content: [{ type: 'image', attachment: { attachmentId: 'unexpected' } }] }] })), { code: 'VISION_NATURAL_PREAUTH_IMAGE' })
  assert.throws(() => natural.admitRequest(request({ tools: [{ name: 'shell' }] })), { code: 'VISION_EXTRA_TOOL_SCHEMA' })
  for (let i = 0; i < 12; i++) natural.admitRequest(request())
  assert.throws(() => natural.admitRequest(request()), { code: 'VISION_REQUEST_LIMIT' })
  const timed = policy({ now: () => clock }); let clock = 1000; timed.arm(); clock += 180000
  assert.throws(() => timed.assertActive(), { code: 'VISION_DEADLINE' })
})

test('candidate must be real ungranted discovery; only separate once confirmation can release model actions', () => {
  const p = policy(); p.arm()
  assert.throws(() => p.recordDiscovery({ applications: [{ candidateId: 'own', granted: true, expiresAt: 2000 }] }), { code: 'VISION_NATURAL_DISCOVERY' })
  assert.throws(() => p.requestEntry({ candidateId: 'manufactured' }), { code: 'VISION_NATURAL_REQUEST' })
  p.recordDiscovery({ applications: [{ candidateId: 'own', granted: false, expiresAt: 2000 }] })
  p.requestEntry({ candidateId: 'own' })
  assert.throws(() => p.requestEntry({ candidateId: 'own' }), { code: 'VISION_NATURAL_REQUEST' })
  assert.throws(() => p.recordEntryReady(ready, authorizedAppId), { code: 'VISION_NATURAL_APPROVAL' })
  for (const patch of [{ decision: 'always' }, { preauthorization: { passed: false } }, { allowedAppsUnchanged: false }]) assert.throws(() => p.recordOwnerOnce({ ...proof, ...patch }), { code: 'VISION_NATURAL_APPROVAL' })
  p.recordOwnerOnce(proof)
  assert.throws(() => p.recordEntryReady(ready, authorizedAppId), { code: 'VISION_NATURAL_APPROVAL' })
  assert.throws(() => p.confirmOwnerOnce({ ...proof, requestId: 'foreign', state: 'approved' }), { code: 'VISION_NATURAL_APPROVAL' })
  p.confirmOwnerOnce({ ...proof, state: 'approved' })
  assert.throws(() => p.recordEntryReady({ ...ready, target: { ...ready.target, pid: 43 } }, authorizedAppId), { code: 'VISION_NATURAL_APPROVAL' })
  p.recordEntryReady(ready, authorizedAppId)
  assert.equal(p.toolGuard(exec('qiuya_computer_act', { action: { kind: 'click' } })), undefined)
  const result = p.summary({ businessPassed: true, nonceRead: true, syntheticNonce: 'ABCDEF' })
  assert.equal(result.passed, false, 'approval and oracle alone cannot prove model images or activity')
  assert.equal(result.naturalEntry.ownerOnce.driver, 'independent-trusted-test-driver-public-owner-rpc')
  assert.equal(result.naturalEntry.ownerOnce.humanClickProven, false)
})

test('preauthorization needs fresh zero driver dispatch counters and the independent desktop audit', () => {
  assert.equal(visionPreauthorizationPassed(preauthorization, { sessionId: 1, auditSha256: hash }), true)
  for (const key of ['observe', 'preview', 'lease', 'act']) assert.equal(visionPreauthorizationPassed({ ...preauthorization, nativeCalls: { ...preauthorization.nativeCalls, [key]: 1 } }, { sessionId: 1, auditSha256: hash }), false)
  for (const patch of [{ leaseFree: false }, { heldKeyCount: 1 }, { journalPresent: true }, { activeDesktopMatches: false }, { leaseScopeExists: false }, { sessionId: 2 }, { auditSourceSha256: 'b'.repeat(64) }]) assert.equal(visionPreauthorizationPassed({ ...preauthorization, desktopAudit: { ...preauthorization.desktopAudit, ...patch } }, { sessionId: 1, auditSha256: hash }), false)
})

test('natural prompt contains the actual safe application name and no targets, answer, coordinates or tool order', () => {
  const prompt = naturalVisionPrompt('fixture')
  assert.match(prompt, /fixture/u)
  assert.doesNotMatch(prompt, /qiuya_computer_|candidateId|targetId|frameId|ABCDEF|\{.*\}|x:|y:|先.*再/u)
  for (const name of ['C:\\secret\\app.exe', '/secret/app', '', '<secret>']) assert.throws(() => naturalVisionPrompt(name))
})

const envelope = (method, payload) => ({ method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: method === 'qiuya-tools.computer.control' ? payload : { args: payload } }) })
const call = (fetch, input) => fetch('/api/qiuya-tools.vision-test', { method: 'POST', body: JSON.stringify(input) })
const computer = (fetch, input) => fetch('/api/qiuya-tools.computer.control', envelope('qiuya-tools.computer.control', input))
function fakeOwner({ changedApps = false, unknownDecide = false } = {}) {
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal }, calls = []
  const card = { requestId: proof.requestId, requestVersion: 1, sessionId: ids[0], appId: authorizedAppId, state: 'pending', expiresAt: Date.now() + 60000 }
  const ctx = { connection: { browserPeer: peer, createSharedFetchHandler(channel) {
    assert.equal(channel, '/api')
    return { async fetch(request, actualPeer) {
      assert.equal(actualPeer, peer); const body = await request.json(); calls.push(body)
      if (body.op) {
        let value = {}
        if (body.op === 'prepare') value = { sessionId: ids[body.task - 1], endpoint: 'http://127.0.0.1:1234/v1/computer', token: 'private-pair', targetId: target.id, authorizedAppId, testOnlyNaturalEntry: body.task === 1 }
        if (body.op === 'status') value = { entryRequested: true, preauthorization: proof.preauthorization }
        return Response.json({ ok: true, value })
      }
      const op = body.payload.op
      if (op === 'decide' && unknownDecide) throw Error('unknown once outcome')
      const value = op === 'pending' ? { pendingRequests: [card] } : op === 'decide' ? { requestId: card.requestId, state: 'approved', decision: 'once', session: ready } : { allowedApps: changedApps && calls.length > 2 ? ['foreign-change'] : [] }
      return Response.json({ rpcId: body.rpcId, result: { ok: true, value } })
    } }
  } } }
  return { ctx, peer, calls, card }
}
async function pendingOnce(fetch) {
  await computer(fetch, { op: 'status' }); await call(fetch, { op: 'prepare', task: 1 })
  await call(fetch, { op: 'status', sessionId: ids[0] }); await computer(fetch, { op: 'pending', sessionId: ids[0] })
}

test('owner adapter permits one exact separately prepared once and never start/always/cross-SID or a retry', async () => {
  const f = fakeOwner(), fetch = createVisionLocalOwnerFetch(f.ctx, ids, { testOnlyNaturalEntry: true, testOnlyOwnerOnce: true })
  await pendingOnce(fetch)
  for (const payload of [{ op: 'start', sessionId: ids[0], targetId: target.id }, { op: 'decide', sessionId: ids[0], requestId: proof.requestId, requestVersion: 1, decision: 'once' }, { op: 'pending', sessionId: ids[1] }, { op: 'allow', appId: authorizedAppId, allowed: true }, { op: 'resume', sessionId: ids[0] }]) await assert.rejects(computer(fetch, payload), { code: 'VISION_AUTORUN_SCOPE' })
  await assert.rejects(call(fetch, { op: 'natural-once', sessionId: ids[0], proof: { ...proof, appId: 'foreign' } }), { code: 'VISION_AUTORUN_SCOPE' })
  await call(fetch, { op: 'natural-once', sessionId: ids[0], proof })
  for (const patch of [{ decision: 'always' }, { requestId: 'foreign' }, { requestVersion: 2 }]) await assert.rejects(computer(fetch, { op: 'decide', sessionId: ids[0], requestId: proof.requestId, requestVersion: 1, decision: 'once', ...patch }), { code: 'VISION_AUTORUN_SCOPE' })
  await computer(fetch, { op: 'decide', sessionId: ids[0], requestId: proof.requestId, requestVersion: 1, decision: 'once' })
  await call(fetch, { op: 'natural-once', sessionId: ids[0], proof: { ...proof, state: 'approved' } })
  await assert.rejects(computer(fetch, { op: 'decide', sessionId: ids[0], requestId: proof.requestId, requestVersion: 1, decision: 'once' }), { code: 'VISION_AUTORUN_SCOPE' })
  assert.equal(f.calls.filter(row => row.payload?.op === 'decide').length, 1)
  f.ctx.connection.browserPeer = { ...f.peer }; await assert.rejects(computer(fetch, { op: 'status' }), { code: 'VISION_AUTORUN_OWNER_CHANGED' })
})

test('unknown once dispatch, changed allowlist and absent explicit switches fail closed without replay', async () => {
  assert.throws(() => createVisionLocalOwnerFetch(fakeOwner().ctx, ids, { testOnlyNaturalEntry: true }), { code: 'VISION_NATURAL_CONFIGURATION' })
  const f = fakeOwner({ unknownDecide: true }), fetch = createVisionLocalOwnerFetch(f.ctx, ids, { testOnlyNaturalEntry: true, testOnlyOwnerOnce: true })
  await pendingOnce(fetch); await call(fetch, { op: 'natural-once', sessionId: ids[0], proof })
  const payload = { op: 'decide', sessionId: ids[0], requestId: proof.requestId, requestVersion: 1, decision: 'once' }
  await assert.rejects(computer(fetch, payload), /unknown once/u); await assert.rejects(computer(fetch, payload), { code: 'VISION_AUTORUN_SCOPE' })
  assert.equal(f.calls.filter(row => row.payload?.op === 'decide').length, 1)
  const changed = fakeOwner({ changedApps: true }), changedFetch = createVisionLocalOwnerFetch(changed.ctx, ids, { testOnlyNaturalEntry: true, testOnlyOwnerOnce: true })
  await pendingOnce(changedFetch); await assert.rejects(computer(changedFetch, { op: 'status' }), { code: 'VISION_NATURAL_ALLOWLIST' })
})

test('one-shot manifest binds the natural first SID, separate once driver and unchanged three-task limits', () => {
  const runId = randomUUID(), directory = '/private/tmp/pure-natural-not-run', expiresAt = Date.now() + 600000
  const config = { testOnlyAutoRun: true, testOnlyNaturalEntry: true, testOnlyOwnerOnce: true, directory, runId, expiresAt, manifestSHA: hash, testOnlySessionIds: ids, testOnlyPatchEntryId: `qiuya-live-vision-test-${randomUUID()}` }
  const manifest = { version: 1, kind: 'trusted-local-owner-vision', runId, directory, expiresAt, sessionIds: ids, patchEntryId: config.testOnlyPatchEntryId, requestLimit: 12, deadlineMs: 180000, guardSha256: hash, externalConfigSha256: hash, nativeSha256: hash, fixtureSha256: hash, carrierSha256: hash, auditSha256: hash, naturalEntry: true, testOnlyOwnerOnce: true, naturalEntryTaskIds: [1], ownerOnceDriver: 'independent-trusted-test-driver-public-owner-rpc' }
  const cap = { version: 1, runId, expiresAt, manifestSHA: hash, nonce: hash, archiveSha256: hash, archive: directory + '/own.tgz' }
  assert.equal(validateVisionAutoRun(config, manifest, cap), manifest)
  for (const patch of [{ naturalEntry: false }, { testOnlyOwnerOnce: false }, { naturalEntryTaskIds: [1, 2] }, { ownerOnceDriver: 'model' }, { requestLimit: 13 }]) assert.throws(() => validateVisionAutoRun(config, { ...manifest, ...patch }, cap))
  assert.throws(() => validateVisionAutoRun({ ...config, testOnlyProbeOnly: true }, { ...manifest, probeOnly: true }, cap))
})

test('checked Windows source transform stays exact; prepare rejects incomplete opt-in before creating directories', async () => {
  const plugin = await readFile(new URL('../scripts/live-vision-guard-plugin.mjs', import.meta.url), 'utf8'), core = await readFile(new URL('../scripts/live-vision-guard-core.mjs', import.meta.url), 'utf8')
  const result = transformWindowsVisionGuard(plugin, core)
  assert.equal(result.maxRequests, 12); assert.equal(result.deadlineMs, 180000)
  assert.match(result.plugin, /record\.testOnlyNaturalEntry/u)
  assert.match(result.plugin, /createWindowsVisionAdapter/u)
  assert.doesNotMatch(result.plugin, /record\.fixture = spawn/u)
  assert.throws(() => transformWindowsVisionGuard(plugin.replace('    if (record.external && current) {', '    if (record.external&&current) {'), core), /exactly once/u)
  if (process.platform === 'darwin') await assert.rejects(prepareLiveVisionWindows({ directory: '/private/tmp/MUST-NOT-BE-CREATED-natural-unit', native: '/private/tmp/not-read.exe', fixture: '/private/tmp/not-read-fixture.exe', expectedNativeSha256: hash, testOnlyNaturalEntry: true, testOnlyAutoRun: true }), /test-only-once/u)
})

test('new diagnostic snapshot retains real public STALE_OBSERVATION without rewriting or disclosing its message', async () => {
  const error = Object.assign(Error('[STALE_OBSERVATION] PRIVATE_PATH_AND_TEXT'), { code: 'STALE_OBSERVATION' }), reports = []
  await assert.rejects(withVisionFailureEvidence(async () => { throw error }, async () => ({ available: true }), row => reports.push(row)), actual => actual === error)
  assert.equal(reports[0].code, 'STALE_OBSERVATION'); assert.doesNotMatch(JSON.stringify(reports), /PRIVATE/u)
})

test('the actual owner runner skips natural start, dispatches one separate once, restores, and retains legacy tasks 2/3', async () => {
  // Load the exact JS function without compiling/bundling its unrelated TS imports.
  const source = await readFile(new URL('../scripts/live-vision-guard-plugin.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function runVisionAcceptanceWithFetch(')
  assert.ok(start > 0)
  const coreURL = new URL('../scripts/live-vision-guard-core.mjs', import.meta.url).href
  const { runVisionAcceptanceWithFetch } = await import('data:text/javascript;base64,' + Buffer.from(`import {projectVisionFailure} from ${JSON.stringify(coreURL)};\n${source.slice(start)}`).toString('base64'))
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal }, calls = [], sessions = new Map()
  let mode = 'local', approved = false, confirmed = false
  const row = { ns: 'qiuya-tools', revision: 7, user: { enabled: true, computerUseEnabled: true }, value: { enabled: true, computerUseEnabled: true } }
  const ctx = { connection: { browserPeer: peer, createSharedFetchHandler() { return { async fetch(request, actualPeer) {
    assert.equal(actualPeer, peer); const body = await request.json(); calls.push(body)
    if (body.op) {
      let value
      if (body.op === 'prepare') value = { sessionId: ids[body.task - 1], targetId: target.id, authorizedAppId, testOnlyNaturalEntry: body.task === 1, endpoint: 'http://127.0.0.1:1234/v1/computer', token: 'private-pair', prompt: body.task === 1 ? naturalVisionPrompt('fixture') : `offline legacy task ${body.task}` }
      else if (body.op === 'status') value = { sessionId: body.sessionId, state: body.sessionId === ids[0] && !confirmed ? 'running' : 'idle', requests: 1, entryRequested: body.sessionId === ids[0], preauthorization: proof.preauthorization, fatal: null }
      else if (body.op === 'natural-once') { if (body.proof.state === 'approved') { assert.equal(approved, true); confirmed = true }; value = { recorded: true } }
      else if (body.op === 'finish') value = { passed: true, cleanup: { passed: true }, requests: 1, businessPassed: true, visualNonceRead: true, ...(body.sessionId === ids[0] ? { naturalEntry: { passed: confirmed, ownerOnce: { driver: 'independent-trusted-test-driver-public-owner-rpc', humanClickProven: false } } } : {}) }
      else value = { passed: true }
      return Response.json({ ok: true, value })
    }
    let value = {}
    if (body.method === 'settings/describe') value = { writable: true, namespaces: [row] }
    else if (body.method === 'settings/mutate') assert.fail('initial true settings are not written')
    else if (body.method === 'qiuya-tools.computer.control') {
      const input = body.payload
      if (input.op === 'status') value = { enabled: true, switching: false, native: { mode }, sessions: [...sessions.values()], allowedApps: [] }
      else if (input.op === 'connect') mode = input.mode
      else if (input.op === 'start') { assert.notEqual(input.sessionId, ids[0]); sessions.set(input.sessionId, { sessionId: input.sessionId, state: 'ready' }) }
      else if (input.op === 'stop') sessions.set(input.sessionId, { sessionId: input.sessionId, state: 'stopped' })
      else if (input.op === 'pending') value = { pendingRequests: [{ ...proof, expiresAt: Date.now() + 60000 }] }
      else if (input.op === 'decide') { assert.equal(confirmed, false); approved = true; sessions.set(ids[0], ready); value = { requestId: proof.requestId, state: 'approved', decision: 'once', session: ready } }
      else assert.fail('unexpected computer operation: ' + input.op)
    } else assert.ok(['session/prompt', 'session/cancel'].includes(body.method))
    return Response.json({ rpcId: body.rpcId, result: { ok: true, value } })
  } } } } }
  const fetch = createVisionLocalOwnerFetch(ctx, ids, { testOnlyNaturalEntry: true, testOnlyOwnerOnce: true })
  const result = await runVisionAcceptanceWithFetch(fetch, () => {}, { testOnlyNaturalEntry: true, testOnlyOwnerOnce: true })
  assert.equal(result.passed, true, JSON.stringify(result))
  assert.equal(result.ownerOnceDriver, '独立测试驱动模拟owner允许一次'); assert.equal(result.humanClickProven, false)
  assert.deepEqual(result.naturalEntryTaskIds, [1]); assert.equal(result.tasks.length, 3)
  assert.equal(calls.filter(item => item.payload?.op === 'decide').length, 1)
  assert.deepEqual(calls.filter(item => item.payload?.op === 'start').map(item => item.payload.sessionId), ids.slice(1))
  assert.equal(calls.filter(item => item.method === 'session/prompt').length, 3)
  assert.match(calls.find(item => item.method === 'session/prompt').payload.args.request.content[0].text, /^请在本次验收应用/u)
  assert.equal(result.restoration.localMode, true); assert.equal(result.restoration.featureFlags, true)
  assert.ok([...sessions.values()].every(item => item.state === 'stopped'))
})

// The final evidence path also runs after timeouts, cancellation and denied grants.
test('natural final evidence never captures or writes before approval', async () => {
  let captures = 0, writes = 0
  const capture = async () => { captures++; return { imageBase64: 'owned-image' } }, write = async () => { writes++ }
  for (const approved of [undefined, false, null, 'true']) {
    assert.deepEqual(await persistVisionFinalImage({ testOnlyNaturalEntry: true, approved }, capture, write), { finalImageUnavailable: true, finalImageSkipped: 'natural-entry-not-approved' })
  }
  assert.equal(captures, 0); assert.equal(writes, 0)
  assert.deepEqual(await persistVisionFinalImage({ testOnlyNaturalEntry: true, approved: true }, capture, write), {})
  assert.equal(captures, 1); assert.equal(writes, 1)
  assert.deepEqual(await persistVisionFinalImage({ testOnlyNaturalEntry: false }, capture, write), {})
  assert.equal(captures, 2); assert.equal(writes, 2)
  assert.deepEqual(await persistVisionFinalImage({ testOnlyNaturalEntry: true, approved: true }, async () => { throw Error('private-path') }, write), { finalImageUnavailable: true })
  assert.equal(writes, 2)
  const source = await readFile(new URL('../scripts/live-vision-guard-plugin.mjs', import.meta.url), 'utf8')
  assert.match(source, /Object\.assign\(result, await persistVisionFinalImage\(/u)
})
