/** Actual Windows default manager; isolated testhost, never an installed Harness owner. */
import assert from 'node:assert/strict'
import {createWindowsOwnedStartupGate,WINDOWS_OWNED_STARTUP_SCOPE} from './startup-credit-policy.mjs'
import { acquisitionCausalInterval } from './physical-frame-protocol.mjs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

export const digest = value => createHash('sha256').update(value).digest('hex')
export const sameWindowsMultitaskIdentity = (a, b) => Boolean(a && b && a.pid === b.pid && String(a.createdAtTicks) === String(b.createdAtTicks) && a.executablePath?.toLowerCase() === b.executablePath?.toLowerCase() && a.sessionId === b.sessionId)
export const inputReleased = value => Boolean(value?.userInteractive === true && value.sessionId > 0 && value.activeDesktopAccessible === true && value.activeDesktopMatches === true && Array.isArray(value.heldKeys) && value.heldKeys.length === 0 && value.lease?.lockFree === true && value.lease.journalPresent === false)
// Passive diagnostics only: the production transport remains the sole RPC
// consumer. In particular, inputHeld is an ACK, never proof of an OS Down.
const nativeDiagnosticCodes = new Set('native-failed invalid-request unknown-operation invalid-target target-unavailable target-changed capture-busy geometry-changed capture-unavailable invalid-epoch input-cleanup-failed human-monitor-unavailable human-input-pending stale-epoch invalid-actor foreground-changed input-denied input-busy observation-required foreground-denied invalid-action invalid-coordinate invalid-button invalid-key desktop-unavailable desktop-busy desktop-lease-required input-journal-failed input-journal-invalid guardian-unavailable invalid-input-state preview-failed preview-overlap preview-not-ready preview-close-failed preview-cache-full preview-data-path-too-long window-presentation-failed webview2-runtime-missing invalid-url capture-disposed capture-worker-stuck capture-timeout capture-protocol capture-worker-exited capture-limit APPLICATION_NOT_LISTED APPLICATION_CHANGED APPLICATION_LAUNCH_FAILED INVALID_PERMISSION_KIND session-window-failed'.split(' '))
const finiteDecimal = value => typeof value === 'string' && /^\d{1,20}$/u.test(value)
const finiteGuid = value => typeof value === 'string' && /^[a-f0-9]{32}$/iu.test(value)
const finiteDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
export function windowsMultitaskForegroundIdentity(value) {
  if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.parentPid) || value.parentPid <= 0 || !Number.isSafeInteger(value.sessionId) || value.sessionId <= 0 || !finiteDecimal(value.createdAtTicks) || !finiteDecimal(value.parentCreatedAtTicks) || !finiteGuid(value.instanceId) || !finiteDigest(value.imageSHA256) || !finiteDigest(value.desktopSHA256) || typeof value.executablePath !== 'string' || value.executablePath.length > 32768 || !value.executablePath || /[\x00-\x1f\x7f]/u.test(value.executablePath) || !['arm64', 'x64'].includes(value.architecture)) return
  return { pid: value.pid, createdAtTicks: value.createdAtTicks, parentPid: value.parentPid, parentCreatedAtTicks: value.parentCreatedAtTicks, sessionId: value.sessionId, imageSHA256: value.imageSHA256, desktopSHA256: value.desktopSHA256, architecture: value.architecture, pathSHA256: digest(value.executablePath.toLowerCase()), instanceSHA256: digest(value.instanceId) }
}
export function windowsMultitaskForegroundMetadata(value) {
  if (value?.event !== undefined || value?.ok !== true || !Number.isSafeInteger(value.requestId) || value.requestId < 0 || !value.result || typeof value.result !== 'object') return
  const v = value.result
  if (typeof v.attempted === 'boolean' && typeof v.allowed === 'boolean' && Number.isSafeInteger(v.error) && v.error >= 0 && v.error <= 2147483647 && finiteGuid(v.ticketId) && finiteGuid(v.releaseTokenId) && finiteDecimal(v.physicalSequence)) {
    const donor = windowsMultitaskForegroundIdentity(v.donor), recipient = windowsMultitaskForegroundIdentity(v.recipient)
    if (donor && recipient) return { kind: 'foregroundGrant', requestId: value.requestId, attempted: v.attempted, allowed: v.allowed, error: v.error, donor, recipient, ticketSHA256: digest(v.ticketId), releaseSHA256: digest(v.releaseTokenId), physicalSequence: v.physicalSequence }
  }
  if (v.ticket && typeof v.ticket === 'object') {
    const t = v.ticket, identity = windowsMultitaskForegroundIdentity(t.identity)
    if (identity && finiteGuid(t.ticketId) && Number.isSafeInteger(t.epoch) && t.epoch > 0 && Number.isSafeInteger(t.logicalEpoch) && t.logicalEpoch >= 0 && Number.isSafeInteger(t.surfaceGeneration) && t.surfaceGeneration > 0 && finiteDecimal(t.physicalSequence) && t.physicalSequence === v.physicalSequence && finiteDecimal(t.expiresAtQpc) && finiteDigest(t.geometrySHA256) && finiteDigest(t.actionSHA256)) return { kind: 'foregroundPrepare', requestId: value.requestId, identity, ticketSHA256: digest(t.ticketId), epoch: t.epoch, logicalEpoch: t.logicalEpoch, surfaceGeneration: t.surfaceGeneration, physicalSequence: t.physicalSequence, expiresAtQpc: t.expiresAtQpc }
  }
  if (v.foregroundRelease && typeof v.foregroundRelease === 'object') {
    const t = v.foregroundRelease, identity = windowsMultitaskForegroundIdentity(t.identity)
    if (identity && finiteGuid(t.tokenId) && Number.isSafeInteger(t.epoch) && t.epoch > 0 && finiteDecimal(t.physicalSequence) && finiteDecimal(t.expiresAtQpc)) return { kind: 'foregroundRelease', requestId: value.requestId, identity, releaseSHA256: digest(t.tokenId), epoch: t.epoch, physicalSequence: t.physicalSequence, expiresAtQpc: t.expiresAtQpc }
  }
}
// Finite diagnostics for the existing cleanup alive reply; no new request or wait.
const observerReadPhases = new Set(['pin-lookup', 'certificate', 'handle-reference', 'same-handle-wait', 'terminal'])
const observerReadExceptions = new Set(['InvalidOperationException', 'ObjectDisposedException', 'ArgumentException', 'ArgumentNullException', 'OverflowException', 'FormatException', 'KeyNotFoundException', 'Win32Exception', 'UnauthorizedAccessException', 'IOException', 'SecurityException', 'OutOfMemoryException'])
export function windowsMultitaskObserverReadReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.operation !== 'cleanup-alive' || !observerReadPhases.has(value.phase) || typeof value.sameOriginalHandle !== 'boolean' || value.certificateSHA256 !== null && !finiteDigest(value.certificateSHA256) || value.actualSameHandleWait !== null && (!Number.isInteger(value.actualSameHandleWait) || value.actualSameHandleWait < 0 || value.actualSameHandleWait > 0xffffffff) || value.nativeError !== null && (!Number.isInteger(value.nativeError) || value.nativeError < 0 || value.nativeError > 65535)) return
  if (value.exceptionType === null) {
    if (value.hresult !== null || value.phase !== 'terminal' || !value.sameOriginalHandle || ![0, 258].includes(value.actualSameHandleWait) || !finiteDigest(value.certificateSHA256) || value.nativeError !== null) return
  } else if (!observerReadExceptions.has(value.exceptionType) || !Number.isInteger(value.hresult) || value.hresult < -2147483648 || value.hresult > 2147483647) return
  if (value.actualSameHandleWait !== null && !value.sameOriginalHandle || value.sameOriginalHandle && value.actualSameHandleWait === null || value.nativeError !== null && value.actualSameHandleWait !== 0xffffffff) return
  return { operation: 'cleanup-alive', phase: value.phase, exceptionType: value.exceptionType, hresult: value.hresult, actualSameHandleWait: value.actualSameHandleWait, sameOriginalHandle: value.sameOriginalHandle, certificateSHA256: value.certificateSHA256, nativeError: value.nativeError }
}
export function createWindowsMultitaskObserverReadAudit({ maxRecords = 512, clock = () => process.hrtime.bigint() } = {}) {
  assert.ok(Number.isSafeInteger(maxRecords) && maxRecords >= 1 && maxRecords <= 1024)
  const records = [], counts = { replies: 0, invalid: 0, omitted: 0 }; let firstFailure = null
  return {
    record(requestId, value) {
      counts.replies++
      const read = windowsMultitaskObserverReadReceipt(value)
      if (!Number.isSafeInteger(requestId) || requestId < 1 || !read) { counts.invalid++; return }
      const row = { requestId, receivedNs: String(clock()), ...read }
      if (read.exceptionType !== null && firstFailure === null) firstFailure = row
      if (records.length < maxRecords) records.push(row); else counts.omitted++
      return read
    },
    snapshot() { return structuredClone({ records, counts, firstFailure }) },
  }
}
// Passive finite failure diagnostics. Never turns a failed RPC into a success.
const observerFailureOperations = new Set(['setupPrepare', 'setupArm', 'setupState', 'setupFinish', 'identity', 'retired', 'alive', 'descendants', 'windows', 'snapshot', 'arm', 'latest', 'finish', 'unknown'])
const observerFailureContexts = new Set(['dispatch', 'descendants-child', 'descendants-parent', 'snapshot-native', 'snapshot-fixture'])
const observerFailurePhases = new Set(['dispatch', 'tree-snapshot', 'tree-first', 'tree-next', 'tree-bound', 'tree-terminal', 'identity-open', 'identity-initial-wait', 'identity-birth', 'identity-image', 'identity-canonical', 'identity-existing-pin', 'identity-existing-current-wait', 'identity-pin-bound', 'identity-image-sha', 'identity-new-final-wait', 'identity-terminal'])
export function windowsMultitaskObserverFailureReceipt(value, expectedOperation) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !observerFailureOperations.has(value.operation) || value.operation !== expectedOperation || !observerFailureContexts.has(value.context) || !observerFailurePhases.has(value.phase) || !observerReadExceptions.has(value.exceptionType) || !Number.isInteger(value.hresult) || value.hresult < -2147483648 || value.hresult > 2147483647 || value.subjectPid !== null && (!Number.isSafeInteger(value.subjectPid) || value.subjectPid <= 0) || value.actualWait !== null && (!Number.isInteger(value.actualWait) || value.actualWait < 0 || value.actualWait > 0xffffffff) || value.nativeError !== null && (!Number.isInteger(value.nativeError) || value.nativeError < 0 || value.nativeError > 65535)) return
  return {operation:value.operation,context:value.context,phase:value.phase,subjectPid:value.subjectPid,exceptionType:value.exceptionType,hresult:value.hresult,actualWait:value.actualWait,nativeError:value.nativeError}
}
export function createWindowsMultitaskObserverFailureAudit({maxRecords=16}={}) {
  assert(Number.isSafeInteger(maxRecords)&&maxRecords>=1&&maxRecords<=64)
  const records=[],counts={failures:0,invalid:0,omitted:0}
  return {record(requestId,op,value){counts.failures++;const fact=windowsMultitaskObserverFailureReceipt(value,op);if(!Number.isSafeInteger(requestId)||requestId<1||!fact){counts.invalid++;return}if(records.length<maxRecords)records.push({requestId,...fact});else counts.omitted++;return fact},snapshot(){return structuredClone({records,counts})}}
}
/** Test-only initial Root CUA maintenance, before any session start/arm/action. */
export function createWindowsMultitaskInitialSetupGate({ runId, fixture, hwnd, title, nativeA, nativeB }) {
  assert.match(runId, /^[a-f0-9-]{36}$/u)
  const expected=structuredClone({fixture,hwnd:String(hwnd),title,nativeA,nativeB});let prepared,armed,finished=false
  const exact=(value,key)=>assert.deepEqual(value[key],expected[key],`Initial setup ${key} changed`)
  const nonce=value=>{assert.equal(value?.runId,runId);assert.match(value?.nonce??'',/^[a-f0-9-]{36}$/u);if(prepared)assert.equal(value.nonce,prepared.nonce)}
  return {
    prepare(value){assert(!prepared,'Initial setup cannot be prepared again');nonce(value);for(const key of Object.keys(expected))exact(value,key);assert.equal(value.initialMaintenanceOnly,true);assert.equal(value.unarmed,true);assert.deepEqual(value.heldKeys,[]);assert.equal(value.leaseFree,true);assert.equal(value.journalAbsent,true);assert.equal(value.setupBudgetMs,30000);assert(Number.isSafeInteger(value.preparedAtMs));
      const g=value.geometry,p=g?.point,r=g?.windowRect,s=g?.screen;assert.equal(g?.coordinateSpace,'physical-primary-desktop-pixels');assert.equal(g?.desktop,'Default');assert.equal(g?.visible,true);assert.equal(g?.enabled,true);assert.equal(g?.hitTest,2);assert.equal(g?.hitRoot,expected.hwnd);assert.equal(g?.hitPid,fixture.pid);assert(Number.isInteger(g?.dpi)&&g.dpi>=96&&g.dpi<=768);assert.equal(s?.left,0);assert.equal(s?.top,0);assert.equal(s?.monitors,1);for(const n of[p?.x,p?.y,r?.left,r?.top,r?.right,r?.bottom,s?.width,s?.height])assert(Number.isSafeInteger(n));assert(p.x>r.left&&p.x<r.right&&p.y>r.top&&p.y<r.bottom&&p.x>=0&&p.y>=0&&p.x<s.width&&p.y<s.height)
      const roi=value.physicalROI;assert.equal(roi?.source,'GDI-CopyFromScreen-own-titlebar-region');assert.equal(roi?.width,192);assert.equal(roi?.height,32);assert.equal(roi?.left,p.x-96);assert.equal(roi?.top,p.y-16);assert(roi.left>=r.left&&roi.top>=r.top&&roi.left+192<=r.right&&roi.top+32<=r.bottom);assert(typeof roi.pngBase64==='string'&&roi.pngBase64.length<=40000);const png=Buffer.from(roi.pngBase64,'base64');assert.equal(png.toString('base64'),roi.pngBase64);assert.equal(digest(png),roi.sha256);assert(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));assert.equal(png.readUInt32BE(16),192);assert.equal(png.readUInt32BE(20),32);prepared=structuredClone(value);return {png,proof:structuredClone(value)}
    },
    arm(value){assert(prepared&&!armed&&!finished,'Initial setup arm cannot replay');nonce(value);assert.equal(value.armed,true);assert.equal(value.hookAvailable,true);assert.deepEqual(value.geometry,prepared.geometry);assert(Number.isSafeInteger(value.atMs)&&value.atMs>=prepared.preparedAtMs);armed=structuredClone(value);return structuredClone(value)},
    finish(value){assert(prepared&&armed&&!finished,'Initial setup finish cannot replay');nonce(value);assert.equal(value.verified,true);assert.equal(value.initialMaintenanceOnly,true);assert.equal(value.unarmed,true);assert.equal(value.hookNaturallyRetired,true);assert.equal(value.hwnd,expected.hwnd);assert.equal(value.foreground,expected.hwnd);assert.deepEqual(value.fixture,fixture);assert.deepEqual(value.heldKeys,[]);assert.equal(value.leaseFree,true);assert.equal(value.journalAbsent,true);assert(Number.isSafeInteger(value.atMs)&&value.atMs>=armed.atMs&&value.atMs-prepared.preparedAtMs<=30000);assert.equal(value.edges?.length,2);let previous=armed.atMs
      for(let i=0;i<2;i++){const e=value.edges[i];assert.equal(e.kind,i===0?'down':'up');assert.equal(e.nonce,prepared.nonce);assert.equal(e.x,prepared.geometry.point.x);assert.equal(e.y,prepared.geometry.point.y);assert.equal(e.flags,0);assert(Number.isSafeInteger(e.atMs)&&e.atMs>=previous&&e.atMs<=value.atMs);previous=e.atMs}finished=true;return structuredClone(value)
    },
    snapshot(){return structuredClone({runId,expected,prepared,armed,finished,initialMaintenanceOnly:true,modelInputs:0})}
  }
}

/** Test-only live action anchor. It does not dispatch, authorize, extend a ticket,
 * synthesize a sample, or accept a completed operation as present input proof. */
export function createWindowsMultitaskLiveActionGate({ worker, child, identity, logicalEpoch, targetId, actionId, frameId, action, current, clock = () => performance.now() }) {
  assert.ok(worker && child && typeof current === 'function' && Number.isSafeInteger(logicalEpoch) && logicalEpoch > 0)
  assert.ok(typeof targetId === 'string' && targetId.length > 0 && targetId.length <= 256 && typeof actionId === 'string' && typeof frameId === 'string')
  const certificate = structuredClone(identity), actionDigest = digest(JSON.stringify(action)), budgetMs = 1800
  assert.ok(sameWindowsMultitaskIdentity(identity, certificate) && finiteDigest(identity.imageSHA256))
  let issuedAtMs, startedAtMs, nativeEpoch, completedAtMs, settled = false, failure = null, starts = 0, resolveStart, rejectStart
  const started = new Promise((yes, no) => { resolveStart = yes; rejectStart = no }); started.catch(() => {})
  const fail = code => { if (failure === null) failure = code; const error = Object.assign(new Error('Original live action anchor rejected: ' + failure), { code: failure }); rejectStart(error); return error }
  const binding = () => {
    const value = current()
    if (!value || value.worker !== worker || value.child !== child || !sameWindowsMultitaskIdentity(value.identity, certificate) || value.identity.canonicalExecutablePath?.toLowerCase() !== certificate.canonicalExecutablePath?.toLowerCase() || value.identity.imageSHA256 !== certificate.imageSHA256 || value.logicalEpoch !== logicalEpoch || value.targetId !== targetId || value.actionId !== actionId || value.actionPhase !== 'executing' || value.state !== 'running' || !Number.isSafeInteger(value.physical?.epoch) || value.physical.epoch <= 0 || value.physical.logicalEpoch !== logicalEpoch) throw fail('ACTION_BINDING_CHANGED')
    return value
  }
  const assertCurrent = () => {
    if (failure !== null) throw fail(failure)
    if (issuedAtMs === undefined || startedAtMs === undefined || settled) throw fail(settled ? 'ACTION_ALREADY_SETTLED' : 'ACTION_NOT_STARTED')
    const now = clock(); if (!Number.isFinite(now) || now < startedAtMs || now > startedAtMs + budgetMs) throw fail('ACTION_SAMPLE_DEADLINE')
    const value = binding(); if (value.physical.epoch !== nativeEpoch) throw fail('ACTION_EPOCH_CHANGED')
    return { startedAtMs, deadlineMs: startedAtMs + budgetMs, remainingMs: startedAtMs + budgetMs - now, nativeEpoch }
  }
  return {
    started,
    issue() { if (failure !== null) throw fail(failure); if (issuedAtMs !== undefined || settled) throw fail('ACTION_REISSUE_FORBIDDEN'); issuedAtMs = clock(); if (!Number.isFinite(issuedAtMs)) throw fail('ACTION_CLOCK_UNKNOWN') },
    onEvent(event) {
      if (event?.event !== 'action' || event.phase !== 'started') return
      try {
        if (issuedAtMs === undefined || settled) throw fail('ACTION_LATE_OR_UNISSUED_EVENT')
        if (++starts !== 1) throw fail('ACTION_DUPLICATE_START')
        const value = binding(), now = clock()
        if (!Number.isFinite(now) || now < issuedAtMs || event.epoch !== value.physical.epoch || event.targetId !== targetId || digest(JSON.stringify(event.action)) !== actionDigest) throw fail('ACTION_START_MISMATCH')
        nativeEpoch = event.epoch; startedAtMs = now
        resolveStart({ startedAtMs, deadlineMs: startedAtMs + budgetMs, nativeEpoch })
      } catch (error) { if (failure === null) fail('ACTION_START_UNKNOWN') }
    },
    settle(error) { if (settled) return; settled = true; completedAtMs = clock(); if (startedAtMs === undefined) rejectStart(error ?? fail('ACTION_SETTLED_WITHOUT_START')) },
    assertCurrent,
    snapshot() { return { actionId, frameId, targetSHA256: digest(targetId), certificateSHA256: digest(JSON.stringify(certificate)), actionSHA256: actionDigest, logicalEpoch, nativeEpoch: nativeEpoch ?? null, budgetMs, issuedAtMs: issuedAtMs ?? null, startedAtMs: startedAtMs ?? null, deadlineMs: startedAtMs === undefined ? null : startedAtMs + budgetMs, completedAtMs: completedAtMs ?? null, settled, starts, failure, stageReceiptIsOSDownProof: false } },
  }
}
export function windowsMultitaskRetirementBudget(identity, nativeIdentities, known) {
  let current = identity
  for (let depth = 0; depth < 16; depth++) {
    if (typeof current?.canonicalExecutablePath !== 'string' || current.executablePath?.toLowerCase() !== current.canonicalExecutablePath.toLowerCase() || !current.canonicalExecutablePath.toLowerCase().endsWith('\\msedgewebview2.exe') || !Number.isSafeInteger(current.parentPid) || !finiteDecimal(current.parentCreatedAtTicks)) return 6000
    if (nativeIdentities.some(value => value.pid === current.parentPid && value.createdAtTicks === current.parentCreatedAtTicks && value.sessionId === current.sessionId && typeof value.canonicalExecutablePath === 'string' && value.canonicalExecutablePath.toLowerCase() === value.executablePath?.toLowerCase())) return 15000
    current = known.find(value => value.pid === current.parentPid && value.createdAtTicks === current.parentCreatedAtTicks && value.sessionId === current.sessionId)
  }
  return 6000
}
export async function windowsMultitaskWaitNaturalRetirement(identity, readAlive, { budgetMs = 6000, disposedAtMs, clock = () => performance.now(), wait = sleep } = {}) {
  assert.ok([6000, 15000].includes(budgetMs))
  const waitStart = clock(), disposalEnd = disposedAtMs ?? waitStart, start = budgetMs === 15000 ? disposalEnd : waitStart, samples = []
  assert.ok(Number.isFinite(disposalEnd) && disposalEnd <= waitStart)
  const receipt = (passed, failure) => ({ passed, identity, budgetMs, ...(failure ? { failure } : {}), budgetStartsAt: budgetMs === 15000 ? 'manager-dispose-end' : 'per-process-wait', elapsedMs: clock() - waitStart, elapsedFromDisposeMs: clock() - disposalEnd, samples, processSignals: 0 })
  while (clock() - start < budgetMs) {
    if (samples.length >= 2048) throw Object.assign(new Error('Exact retirement sample bound exceeded'), { retirement: receipt(false) })
    const began = clock(); let value
    try { value = await readAlive(identity) }
    catch (error) {
      samples.push({ readStartedFromDisposeMs: began - disposalEnd, readCompletedFromDisposeMs: clock() - disposalEnd, alive: null, readFailed: true })
      throw Object.assign(new Error('Exact owned process retirement read failed'), { cause: error, retirement: receipt(false, { stage: 'alive-read', code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : 'READ_FAILED', ...(windowsMultitaskObserverReadReceipt(error?.observerRead) ? { read: windowsMultitaskObserverReadReceipt(error.observerRead) } : {}) }) })
    }
    samples.push({ readStartedFromDisposeMs: began - disposalEnd, readCompletedFromDisposeMs: clock() - disposalEnd, alive: typeof value?.alive === 'boolean' ? value.alive : null })
    if (value?.alive === false && clock() - start <= budgetMs) return receipt(true)
    if (value?.alive !== true) throw Object.assign(new Error('Exact owned process retirement is unknown or outside its time bound'), { retirement: receipt(false) })
    try { await wait(8) }
    catch (error) { throw Object.assign(new Error('Exact owned process retirement polling failed'), { cause: error, retirement: receipt(false, { stage: 'poll-wait', code: 'WAIT_FAILED' }) }) }
  }
  throw Object.assign(new Error('An exact owned process remained'), { retirement: receipt(false) })
}
export function windowsMultitaskPreviewPresentation(rows, identity, requestedTitle) {
  const title = requestedTitle.slice(0, 200) + ' — QiuYaTools'
  const matching = Array.isArray(rows) ? rows.filter(row => row.pid === identity.pid && row.title === title && row.visible === true && row.enabled === true && Number.isSafeInteger(row.width) && row.width >= 320 && Number.isSafeInteger(row.height) && row.height >= 220 && /^\d+$/u.test(row.hwnd ?? '')) : []
  return { passed: matching.length === 1, expectedTitle: title, matching, windows: rows }
}
export function windowsMultitaskProductionGrantVerdict(diagnostics, helperSHA256) {
  const a = diagnostics.find(row => row.sessionId === 'chat-A'), b = diagnostics.find(row => row.sessionId === 'chat-B')
  const grants = a?.records?.filter(row => row.kind === 'foregroundGrant') ?? []
  const bGrants = b?.records?.filter(row => row.kind === 'foregroundGrant') ?? []
  if (!a || !b || grants.length !== 1 || bGrants.length !== 0 || !finiteDigest(helperSHA256)) return { passed: false, aGrantCount: grants.length, bGrantCount: bGrants.length }
  const grant = grants[0], release = a.records.find(row => row.kind === 'foregroundRelease' && row.releaseSHA256 === grant.releaseSHA256), prepared = b.records.find(row => row.kind === 'foregroundPrepare' && row.ticketSHA256 === grant.ticketSHA256)
  const exact = (transport, os) => transport?.pid === os?.pid && transport.createdAtTicks === os.createdAtTicks && transport.sessionId === os.sessionId && transport.pathSHA256 === digest(os.executablePath.toLowerCase()) && transport.imageSHA256 === helperSHA256
  const clocks = [grant.receivedNs, release?.receivedNs, prepared?.receivedNs].every(finiteDecimal)
  const bDown = b.records.find(row => row.kind === 'inputHeld' && row.mouseButtons?.includes('left') && finiteDecimal(row.receivedNs) && clocks && BigInt(row.receivedNs) > BigInt(grant.receivedNs))
  const passed = grant.attempted === true && grant.allowed === true && grant.error === 0 && exact(grant.donor, a.identity) && exact(grant.recipient, b.identity) && release && prepared && exact(release.identity, a.identity) && exact(prepared.identity, b.identity) && release.physicalSequence === grant.physicalSequence && grant.donor.parentPid === grant.recipient.parentPid && grant.donor.parentCreatedAtTicks === grant.recipient.parentCreatedAtTicks && grant.donor.instanceSHA256 !== grant.recipient.instanceSHA256 && grant.donor.architecture === grant.recipient.architecture && clocks && BigInt(release.receivedNs) < BigInt(grant.receivedNs) && BigInt(prepared.receivedNs) < BigInt(grant.receivedNs) && Boolean(bDown)
  return { passed: Boolean(passed), aGrantCount: grants.length, bGrantCount: bGrants.length, grant, release: release ?? null, prepared: prepared ?? null, firstBHeldAfterGrantNs: bDown?.receivedNs ?? null, statement: 'Passive ACK linkage plus independent fixture/OS Down gates; ASFW is permission, never activation proof' }
}
// This is only a pending classification. The still-running Node cannot prove
// its launcher console has retired; an independent outer observer must do so.
export function windowsMultitaskPendingLauncherConsole(value, runner, systemConsolePath) {
  if (!value || !runner || typeof systemConsolePath !== 'string' || !/^[a-z]:\\(?:[^\x00-\x1f\x7f]+\\)*conhost\.exe$/iu.test(systemConsolePath) || typeof value.canonicalExecutablePath !== 'string' || value.canonicalExecutablePath.toLowerCase() !== systemConsolePath.toLowerCase() || value.executablePath?.toLowerCase() !== systemConsolePath.toLowerCase() || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid === runner.pid || value.parentPid !== runner.pid || value.parentCreatedAtTicks !== runner.createdAtTicks || value.sessionId !== runner.sessionId || !finiteDecimal(value.createdAtTicks) || !finiteDecimal(runner.createdAtTicks)) return false
  const delta = BigInt(value.createdAtTicks) - BigInt(runner.createdAtTicks)
  return delta >= 0n && delta <= 20_000_000n
}
export function windowsMultitaskNativeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  if (value.event === undefined && value.ok === false && Number.isSafeInteger(value.requestId) && value.requestId >= 0) return {
    kind: 'failureReply', requestId: value.requestId,
    code: nativeDiagnosticCodes.has(value.error?.code) ? value.error.code : 'unknown-code',
  }
  const foreground = windowsMultitaskForegroundMetadata(value); if (foreground) return foreground
  if (value.event === 'journalIoFailure') {
    if (!Number.isInteger(value.ioPhase) || value.ioPhase < 1 || value.ioPhase > 7 || !Number.isInteger(value.exceptionKind) || value.exceptionKind < 1 || value.exceptionKind > 3 || !Number.isInteger(value.hresult) || value.hresult < -2147483648 || value.hresult > 2147483647 || !Number.isInteger(value.nativeError) || value.nativeError < 0 || value.nativeError > 65535 || !Number.isSafeInteger(value.ticks) || value.ticks < 0 || !Number.isSafeInteger(value.thread) || value.thread <= 0) return
    const decodedNativeError = (value.hresult >>> 16) === 0x8007 ? value.hresult & 0xffff : 0
    const priorWin32 = Number.isInteger(value.priorHresult) && (value.priorHresult >>> 16) === 0x8007 ? value.priorHresult & 0xffff : 0
    if (value.nativeError !== decodedNativeError || !Number.isInteger(value.priorPhase) || value.priorPhase < 0 || value.priorPhase > 7 || !Number.isInteger(value.priorKind) || value.priorKind < 0 || value.priorKind > 3 || !Number.isInteger(value.priorHresult) || value.priorHresult < -2147483648 || value.priorHresult > 2147483647 || value.priorNativeError !== priorWin32 || typeof value.overridesPrior !== 'boolean' || (value.priorPhase === 0) !== (value.priorKind === 0) || value.overridesPrior !== (value.priorPhase > 0 && value.priorKind > 0) || value.priorPhase === 0 && (value.priorKind !== 0 || value.priorHresult !== 0 || value.priorNativeError !== 0)) return
    return { kind: 'journalIoFailure', ioPhase: value.ioPhase, exceptionKind: value.exceptionKind, hresult: value.hresult, nativeError: value.nativeError, priorPhase: value.priorPhase, priorKind: value.priorKind, priorHresult: value.priorHresult, priorNativeError: value.priorNativeError, overridesPrior: value.overridesPrior, ticks: value.ticks, thread: value.thread }
  }
  if (value.event !== 'inputHeld' || !Array.isArray(value.keys) || value.keys.length > 256 || !value.keys.every(key => Number.isSafeInteger(key) && key >= 0 && key <= 255) ||
      !Array.isArray(value.unicodeUnits) || value.unicodeUnits.length > 1024 || !value.unicodeUnits.every(unit => Number.isSafeInteger(unit) && unit >= 0 && unit <= 65535) ||
      !Array.isArray(value.mouseButtons) || value.mouseButtons.length > 3 || !value.mouseButtons.every(button => ['left', 'right', 'middle'].includes(button)) ||
      value.ownerId !== null && (typeof value.ownerId !== 'string' || !/^[a-f0-9]{32}$/iu.test(value.ownerId))) return
  return { kind: 'inputHeld', keyCount: value.keys.length, unicodeUnitCount: value.unicodeUnits.length, mouseButtons: [...value.mouseButtons], ownerSHA256: value.ownerId === null ? null : digest(value.ownerId) }
}
export function createWindowsMultitaskNativeAudit({ maxLineBytes = 65536, maxRecords = 256, clock = () => process.hrtime.bigint() } = {}) {
  assert.ok(Number.isSafeInteger(maxLineBytes) && maxLineBytes >= 256 && maxLineBytes <= 65536)
  assert.ok(Number.isSafeInteger(maxRecords) && maxRecords > 0 && maxRecords <= 256)
  const records = [], counts = { lines: 0, oversizedLines: 0, invalidLines: 0, metadataRecords: 0, omittedRecords: 0, diagnosticErrors: 0 }
  let chunks = [], lineBytes = 0, oversized = false, ended = false, firstFailure = null, firstJournalIoFailure = null, retainedBytes = 0, maxRetainedBytes = 0
  const append = part => {
    lineBytes += part.length
    if (lineBytes > maxLineBytes) { oversized = true; chunks = []; retainedBytes = 0 }
    else if (!oversized && part.length) { chunks.push(Buffer.from(part)); retainedBytes += part.length; maxRetainedBytes = Math.max(maxRetainedBytes, retainedBytes) }
  }
  const finishLine = () => {
    counts.lines++
    if (oversized) counts.oversizedLines++
    else if (lineBytes) try {
      const metadata = windowsMultitaskNativeMetadata(JSON.parse(Buffer.concat(chunks, lineBytes).toString('utf8')))
      if (metadata) {
        counts.metadataRecords++
        const record = { ordinal: counts.metadataRecords, receivedNs: String(clock()), ...metadata }
        if (metadata.kind === 'failureReply') firstFailure ??= record
        if (metadata.kind === 'journalIoFailure') firstJournalIoFailure ??= record
        if (records.length < maxRecords) records.push(record)
        else counts.omittedRecords++
      }
    } catch { counts.invalidLines++ }
    chunks = []; lineBytes = 0; oversized = false; retainedBytes = 0
  }
  return {
    push(chunk) {
      if (ended) return
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        let start = 0, end
        while ((end = bytes.indexOf(10, start)) >= 0) { append(bytes.subarray(start, end)); finishLine(); start = end + 1 }
        append(bytes.subarray(start))
      } catch { counts.diagnosticErrors++; chunks = []; retainedBytes = 0; oversized = true }
    },
    finish() { ended = true; chunks = []; retainedBytes = 0 },
    snapshot() { return { maxLineBytes, maxRecords, counts: { ...counts }, records: structuredClone(records), firstFailure: structuredClone(firstFailure), firstJournalIoFailure: structuredClone(firstJournalIoFailure), incompleteTailBytes: lineBytes, retainedBytes, maxRetainedBytes, ended, inputHeldIsOsDownProof: false } },
  }
}
export function windowsMultitaskFixtureReceipt(state, identity) {
  assert.ok(sameWindowsMultitaskIdentity(state, identity), 'Final fixture snapshot must match its exact own process identity')
  assert.ok(state.counts && ['downs', 'ups', 'drags', 'clicks'].every(key => Number.isSafeInteger(state.counts[key]) && state.counts[key] >= 0))
  assert.ok(Array.isArray(state.events) && state.events.length <= 128 && state.events.every(row => ['down', 'up', 'drag'].includes(row.kind) && /^\d+$/u.test(row.ticks) && Number.isSafeInteger(row.x) && Number.isSafeInteger(row.y)))
  assert.ok(Number.isSafeInteger(state.frequency) && state.frequency > 0)
  return structuredClone(state)
}
export function windowsMultitaskHeldVerdict(native, os, binding) {
  const cursor = native?.aiCursor, state = native?.testOnlyTransportHeld, physical = native?.testOnlyScheduledPhysical
  const pointers = (os?.windows ?? []).filter(row => row.pid === binding.native.pid && row.title === '' && row.visible === true && row.enabled === false && (row.exStyle & 0x080800a8) === 0x080800a8 && row.width > 0 && row.width <= 184 && row.height > 0 && row.height <= 232)
  const owned = Number.isSafeInteger(physical?.epoch) && physical.epoch > 0 && state?.mouseButtons?.includes('left') && typeof state.ownerId === 'string' && /^[a-f0-9]{32}$/iu.test(state.ownerId) && os?.lease?.journal?.ownerId === state.ownerId
  const exact = os?.nativeAlive === true && os?.fixtureAlive === true && os?.sessionId === binding.native.sessionId && os.sessionId === binding.fixture.sessionId && os.foreground === String(binding.hwnd) && os.activeDesktopAccessible === true && os.activeDesktopMatches === true && os.heldKeys?.includes(1) && os.lease?.lockFree === false && os.lease.journalPresent === true
  const visible = cursor?.visible === true && cursor.actor === 'ai' && cursor.targetId === binding.targetId && pointers.length === 1
  return { passed: Boolean(owned && exact && visible), owned: Boolean(owned), exact: Boolean(exact), visible: Boolean(visible), epoch: physical?.epoch ?? null, logicalEpoch: physical?.logicalEpoch ?? null, ownerSHA256: state?.ownerId ? digest(state.ownerId) : null, pointer: pointers.length === 1 ? pointers[0] : null }
}
export function windowsMultitaskFifoVerdict(beforeA, afterA, beforeB, afterB) {
  const once = (before, after) => after?.counts?.downs - before?.counts?.downs === 1 && after?.counts?.ups - before?.counts?.ups === 1 && after?.counts?.drags - before?.counts?.drags >= 2
  const aUp = afterA?.events?.filter(row => row.kind === 'up').at(-1), bDown = afterB?.events?.filter(row => row.kind === 'down').at(-1)
  return { passed: Boolean(once(beforeA, afterA) && once(beforeB, afterB) && aUp && bDown && afterA.frequency === afterB.frequency && /^\d+$/u.test(aUp.ticks) && /^\d+$/u.test(bDown.ticks) && BigInt(aUp.ticks) <= BigInt(bDown.ticks)), aUp: aUp?.ticks ?? null, bDown: bDown?.ticks ?? null }
}
export function windowsMultitaskForegroundPermitPassed(receipt, { caller, callee, callerWindow, reason }) {
  return Boolean(receipt?.attempted === true && receipt.allowed === true && receipt.error === 0 && receipt.reason === reason && receipt.extraInputEvents === 0 && receipt.focusChangesRequested === 0 &&
    sameWindowsMultitaskIdentity(receipt.caller, caller) && sameWindowsMultitaskIdentity(receipt.callee, callee) && receipt.caller.sessionId === receipt.callee.sessionId &&
    receipt.callerWindow === String(callerWindow) && receipt.foregroundBefore === String(callerWindow) && receipt.foregroundAfter === String(callerWindow) && Array.isArray(receipt.heldKeys) && receipt.heldKeys.length === 0)
}
export function windowsMultitaskBlueRasterGeometry(fixture, previewWindows, pointerWindows) {
  const fields=['x','y','width','height'], valid=r=>r&&fields.every(key=>Number.isSafeInteger(r[key]))&&r.width>0&&r.height>0
  assert.ok(valid(fixture?.client)&&valid(fixture?.bounds),'Fixed fixture blue geometry is missing')
  const {client,bounds,point}=fixture
  assert.equal(client.width,540);assert.equal(client.height,360)
  assert.ok(point&&point.x===client.x+80&&point.y===client.y+180,'Original fixture drag origin changed')
  const crop={x:client.x,y:client.y+140,width:client.width,height:100}
  const contains=(a,b)=>b.x>=a.x&&b.y>=a.y&&b.x+b.width<=a.x+a.width&&b.y+b.height<=a.y+a.height
  const intersects=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y
  assert.ok(contains(client,crop)&&contains(bounds,crop),'Original full-width crop must stay inside the constant blue fixture client')
  assert.ok(Array.isArray(previewWindows)&&previewWindows.length===1&&previewWindows.every(valid),'One exact production preview rectangle is required before the drag')
  assert.ok(previewWindows.every(window=>!intersects(crop,window)),'Fixed blue fixture raster intersects the own preview window; stop before original redock drag')
  const pointers=(pointerWindows??[]).filter(row=>row.title===''&&row.enabled===false&&(row.exStyle&0x080800a8)===0x080800a8&&row.width>0&&row.width<=184&&row.height>0&&row.height<=232)
  assert.equal(pointers.length,1,'One independently enumerated own pointer geometry is required before the drag')
  const pointer=pointers[0],scale=pointer.dpi/96
  assert.ok(Number.isFinite(scale)&&scale>=.75&&scale<=4)
  assert.equal(pointer.width,Math.ceil(46*scale));assert.equal(pointer.height,Math.ceil(58*scale))
  const trajectory={x:Math.floor(point.x-18*scale),y:Math.floor(point.y-16*scale),width:Math.ceil(360+46*scale),height:Math.ceil(58*scale)}
  assert.ok(contains(crop,trajectory),'Original full-width blue crop does not contain the entire original 360px pointer-frame trajectory at the actual DPI')
  return {passed:true,crop,client,bounds,previewWindows:structuredClone(previewWindows),pointer:{width:pointer.width,height:pointer.height,dpi:pointer.dpi},trajectory,from:{x:point.x,y:point.y},to:{x:point.x+360,y:point.y},constantBackground:[37,113,151],inputReplay:false,imagePixelsRead:false,pixelMaskApplied:false,fullOriginalCropPreserved:true}
}
export function windowsMultitaskPhysicalFailure(causalInterval, interval, raster) {
  if(causalInterval?.passed!==true)return {category:'physical-causal-interval',message:'Physical acquisition causal interval failed; original owner/epoch/held/capture-order gate was not satisfied'}
  if(raster?.passed!==true)return {category:'physical-pointer-pixel-oracle',message:'Actual physical pointer pixel oracle rejected the frame after the original same-owner causal interval passed',pixel:{body:raster?.body??null,white:raster?.white??null,fullyWhite:raster?.fullyWhite??null,background:raster?.background??null,contour:raster?.contour??null,scale:raster?.scale??null},causalIntervalPassed:true}
  if(interval?.passed!==true)return {category:'physical-capture-binding',message:'Physical raster metadata did not bind to the original same-owner B-held interval despite a successful pixel oracle'}
  return null
}
export function windowsMultitaskCaptureInterval(before, after, raster) {
  const clocks = /^\d+$/u.test(before?.os?.ticks ?? '') && /^\d+$/u.test(after?.os?.beforeTicks ?? '') && before.os.frequency === after.os.frequency && BigInt(before.os.ticks) < BigInt(after.os.beforeTicks)
  return { passed: Boolean(clocks && before?.passed === true && after?.passed === true && before.epoch === after.epoch && before.logicalEpoch === after.logicalEpoch && before.ownerSHA256 === after.ownerSHA256 && before.ownerSHA256 && raster?.passed === true && raster.captured === true && raster.captureCount === 1 && raster.physicalDisplay === true && raster.resized === false), before, after, raster }
}
export function windowsMultitaskCleanupVerdict(cleanup) {
  return Boolean(cleanup && (cleanup.pendingOuterRetirement === undefined || Array.isArray(cleanup.pendingOuterRetirement) && cleanup.pendingOuterRetirement.length === 0) && Array.isArray(cleanup.errors) && cleanup.errors.length === 0 && Array.isArray(cleanup.exits) && cleanup.exits.length >= 5 && cleanup.exits.every(row => row.code === 0 && row.signal === null && Array.isArray(row.killCalls) && row.killCalls.length === 0) && Array.isArray(cleanup.remaining) && cleanup.remaining.length === 0 && cleanup.observerEofAttempted === true && inputReleased(cleanup.finalInput) && cleanup.helperUnchanged === true)
}

export async function boundedWindowsMultitask(operation, ms, label) {
  let timer
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms) })]) }
  finally { clearTimeout(timer) }
}
function track(child, role) {
  const killCalls = [], original = child.kill.bind(child)
  child.kill = (...args) => { killCalls.push(args[0] ?? 'SIGTERM'); return original(...args) }
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve({ code: child.exitCode, signal: child.signalCode }) : new Promise(done => { child.once('exit', (code, signal) => done({ code, signal })); child.once('error', error => done({ code: null, signal: null, error: error.message })) })
  return { child, role, killCalls, exited }
}
function endpoint(path, args, role) {
  const child = spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: role === 'observer' }), tracking = track(child, role), pending = new Map(), buffered = [], subscribers = new Set()
  const readAudit = createWindowsMultitaskObserverReadAudit(), failureAudit = createWindowsMultitaskObserverFailureAudit()
  let serial = 0, stderr = ''
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000) }); child.stdin.on('error', () => {})
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    try {
      assert.ok(line.length < 4 * 1024 * 1024)
      const value = JSON.parse(line), waiter = pending.get(value.requestId)
      if (waiter) {
        pending.delete(value.requestId)
        const read = role === 'observer' && waiter.op === 'alive' ? readAudit.record(value.requestId, value.read) : undefined
        if (value.ok) waiter.resolve(value.result)
        else if (role === 'observer' && waiter.op === 'alive') waiter.reject(Object.assign(new Error('observer cleanup alive read failed'), { code: 'OBSERVER_READ_FAILED', ...(read ? { observerRead: read } : {}) }))
        else { const failure=role==='observer'?failureAudit.record(value.requestId,waiter.op,value.failure):undefined; waiter.reject(Object.assign(new Error(`${role}/${waiter.op}: ${value.error}`),failure?{observerFailure:failure}:{})) }
      }
      else { buffered.push(value); for (const callback of subscribers) callback() }
    } catch (error) { for (const job of pending.values()) job.reject(error); pending.clear() }
  })
  tracking.exited.then(() => { for (const job of pending.values()) job.reject(new Error(`${role} retired before reply`)); pending.clear() })
  return { ...tracking, stderr: () => stderr, readFacts: () => readAudit.snapshot(), failureFacts: () => failureAudit.snapshot(), close: () => lines.close(),
    async ready() { return boundedWindowsMultitask(new Promise(done => { const read = () => { const index = buffered.findIndex(row => row.event === 'ready'); if (index >= 0) { subscribers.delete(read); done(buffered.splice(index, 1)[0]) } }; subscribers.add(read); read() }), 15000, `${role} ready`) },
    async request(op, extra = {}, budgetMs = 10000) {
      const requestId = ++serial
      try { return await boundedWindowsMultitask(new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject, op }); child.stdin.write(JSON.stringify({ requestId, op, ...extra }) + '\n', error => { if (error) reject(error) }) }), Math.max(1,Math.min(10000,budgetMs)), `${role}/${op}`) }
      finally { pending.delete(requestId) }
    },
  }
}

/** Test-only geometry oracle: public GetWindowRect metadata, one real JPEG.
 * Original8s deadline is shared by metadata, capture and post-capture guards.
 * It never changes the production driver, action sequence or held predicate. */
export async function waitWindowsMultitaskSettledFrame(binding,ports,{clock=()=>performance.now(),wait=sleep,onSample=()=>{}}={}) {
 const began=clock(),deadline=began+8000,fields=['x','y','width','height'];let signature,since=began,count=0,samples=0,captures=0
 const sameIdentity=(a,b)=>sameWindowsMultitaskIdentity(a,b)&&typeof a.canonicalExecutablePath==='string'&&typeof b.canonicalExecutablePath==='string'&&a.canonicalExecutablePath.toLowerCase()===a.executablePath.toLowerCase()&&b.canonicalExecutablePath.toLowerCase()===b.executablePath.toLowerCase()&&a.canonicalExecutablePath.toLowerCase()===b.canonicalExecutablePath.toLowerCase()
 const timed=async(stage,work)=>{
  const left=deadline-clock();assert(left>0,'Fixture original8000ms geometry deadline expired before '+stage)
  const controller=new AbortController();let timer
  try{const result=await Promise.race([work({signal:controller.signal,remainingMs:Math.max(1,Math.floor(left))}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Fixture original8000ms geometry deadline expired at '+stage))},left)})]);assert(clock()<deadline,'Fixture original8000ms geometry deadline expired after '+stage);return result}
  finally{clearTimeout(timer)}
 }
 const sample=async()=>{
  const beforeIdentity=await timed('identity-before',ports.identity);assert(sameIdentity(beforeIdentity,binding.identity),'Exact fixture canonical identity changed')
  const before=await timed('fixture-before',ports.fixture),windows=await timed('GetWindowRect',ports.windows),targets=await timed('targets',ports.targets),after=await timed('fixture-after',ports.fixture)
  const afterIdentity=await timed('identity-after',ports.identity);assert(sameIdentity(afterIdentity,binding.identity),'Exact fixture canonical identity changed')
  assert(Array.isArray(windows)&&Array.isArray(targets))
  const exact=windows.filter(row=>row.pid===binding.identity.pid&&String(row.hwnd)===String(binding.hwnd)),selected=targets.filter(row=>row.id===binding.targetId)
  assert.equal(exact.length,1,'Pinned HWND must be present exactly once');assert.equal(selected.length,1,'Pinned target must be present exactly once')
  const win=exact[0],target=selected[0];assert.equal(target.pid,binding.identity.pid);assert(target.id.startsWith('window:'+BigInt(binding.hwnd).toString(16)+':'),'Target must bind exact pinned HWND')
  for(const value of [before,after])assert(sameWindowsMultitaskIdentity(value,binding.identity)&&String(value.hwnd)===String(binding.hwnd)&&value.title===binding.title,'Fixture snapshot identity/window/title changed')
  assert.equal(win.title,binding.title);assert.equal(target.title,binding.title)
  assert(Number.isFinite(win.dpi)&&win.dpi>0&&target.scale===win.dpi/96,'Actual window DPI must match target scale')
  const equal=fields.every(key=>Number.isSafeInteger(win[key])&&before.bounds[key]===win[key]&&target[key]===win[key]&&after.bounds[key]===win[key])&&win.width>0&&win.height>0&&before.visible===true&&after.visible===true&&win.visible===true&&win.enabled===true&&JSON.stringify(before.client)===JSON.stringify(after.client)&&JSON.stringify(before.point)===JSON.stringify(after.point)
  const geometry={...Object.fromEntries(fields.map(key=>[key,win[key]])),scale:target.scale},key=JSON.stringify([geometry,before.point,before.client])
  await onSample({elapsedMs:clock()-began,exact:equal,geometry,source:'own-GetWindowRect+fixture+production-targets',screenshotCalls:captures});return {equal,key,geometry,after}
 }
 while(clock()<deadline){
  assert(++samples<=1024,'Geometry sample bound exceeded')
  const value=await sample()
  if(!value.equal||value.key!==signature){signature=value.key;since=clock();count=value.equal?1:0}else count++
  if(value.equal&&count>=3&&clock()-since>=200){
   captures++;const frame=await timed('single-real-JPEG',ports.capture)
   assert.equal(frame.targetId,binding.targetId);assert.equal(frame.mediaType,'image/jpeg');assert.equal(Buffer.from(frame.imageBase64,'base64').readUInt16BE(0),0xffd8)
   assert.equal(frame.width,value.geometry.width);assert.equal(frame.height,value.geometry.height)
   for(const key of [...fields,'scale'])assert.equal(frame.geometry[key],value.geometry[key],'Real frame geometry differs from stable own HWND')
   const post=await sample();assert(post.equal&&post.key===value.key,'Exact fixture changed across the real JPEG capture');assert(clock()<deadline,'Fixture original8000ms geometry deadline expired after capture guards')
   return {frame,settled:post.after,metadataSamples:samples+1,screenshotCalls:captures,elapsedMs:clock()-began,budgetMs:8000}
  }
  await timed('poll-wait',()=>wait(Math.min(8,Math.max(1,deadline-clock()))))
 }
 throw new Error('Fixture geometry did not settle without input inside original8000ms')
}

export async function runWindowsMultitaskManager(config) {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, config.architecture)
  const output = resolve(config.output)
  assert.equal(await access(join(output, 'report.json')).then(() => true, () => false), false, 'Evidence is never overwritten')
  await mkdir(output, { recursive: true })
  for (const [path, expected] of [[config.runtime, config.runtimeSHA256], [config.helper, config.helperSHA256], [config.fixture, config.fixtureSHA256], [config.observer, config.observerSHA256]]) assert.equal(digest(await readFile(path)), expected, 'Frozen Windows runtime differs')
  process.env.QIUYA_TOOLS_NATIVE_DATA_DIR = join(config.guestRoot, 'isolated-webview2')
  const checks = [], fixtures = new Map(), bindings = new Map(), actions = [], events = [], heldSamples = [], geometrySettles = [], observers = [], known = new Map(), frames = new Map(), foregroundSetup = [], foregroundReceipts = [], fixtureFinalStates = [], previewPresentationSamples = [], physicalRasterStages = []
  const liveActionGates = new Map(), liveActionReceipts = []
  const cleanup = { errors: [], exits: [], remaining: [], pendingOuterRetirement: [], naturalRetirement: [], observerEofAttempted: false }, pass = (id, detail = {}) => checks.push({ id, passed: true, ...detail })
  let observer, manager, server, report, runnerIdentity, systemConsolePath, managerDisposedAtMs, phase = 'preflight', runtime, normalStartupReceipt
  const remember = value => { assert.ok(value?.pid && /^\d+$/u.test(value.createdAtTicks) && value.executablePath && value.sessionId > 0); known.set(`${value.pid}:${value.createdAtTicks}`, value); return value }
  const until = async (read, label, ms = 3000) => {
    const deadline = performance.now() + ms
    while (performance.now() < deadline) { const value = await read(); if (value) return value; await sleep(8) }
    throw new Error(label)
  }
  const os = () => observer.request('snapshot')
  // Windows intentionally does not publish leaseEpoch/inputState in status.
  // Observe the unmodified scheduler physical record and actual inputHeld
  // transport acknowledgement, then corroborate both with the independent OS.
  const status = async id => {
    const value = bindings.get(id), native = await value.native.status(), physical = Reflect.get(value.scheduled, 'physical'), held = Reflect.get(value.native, 'held')
    return { ...native, testOnlyScheduledPhysical: physical ? { epoch: physical.epoch, logicalEpoch: physical.logicalEpoch } : null, testOnlyTransportHeld: structuredClone(held) }
  }
  const fixtureState = id => fixtures.get(id).request('snapshot')
  const input = (id, frame, action) => {
    const actionId = randomUUID(), record = { sessionId: id, actionId, frameId: frame.frameId, action, requestedNs: String(process.hrtime.bigint()) }; actions.push(record)
    const binding = bindings.get(id), logicalEpoch = manager.get(id).epoch
    const gate = createWindowsMultitaskLiveActionGate({ worker: binding.native, child: binding.child, identity: binding.identity, logicalEpoch, targetId: frame.targetId, actionId, frameId: frame.frameId, action,
      current: () => { const state = manager.get(id); return { worker: bindings.get(id)?.native, child: Reflect.get(binding.native, 'child'), identity: binding.identity, logicalEpoch: state?.epoch, targetId: state?.target?.id, actionId: state?.lastAction?.actionId, actionPhase: state?.lastAction?.phase, state: state?.state, physical: Reflect.get(binding.scheduled, 'physical') } },
    })
    const remove = binding.native.subscribe(event => gate.onEvent(event)); liveActionGates.set(id, gate); liveActionReceipts.push(gate)
    gate.issue()
    let result
    try { result = manager.act(id, { actionId, frameId: frame.frameId, action }) }
    catch (error) { gate.settle(error); remove(); throw error }
    result.then(value => { record.completedNs = String(process.hrtime.bigint()); record.result = value; gate.settle(); remove() }, error => { record.failed = error.message; gate.settle(error); remove() })
    return result
  }
  const capture = async (id, preview = false, signal) => {
    const value = await manager[preview ? 'preview' : 'observe'](id,signal)
    assert.equal(value.targetId, fixtures.get(id).target.id); assert.equal(Buffer.from(value.imageBase64, 'base64').readUInt16BE(0), 0xffd8)
    return value
  }
  const settle = async id => {
    const samples=[],f=fixtures.get(id);geometrySettles.push({sessionId:id,samples})
    const value=await waitWindowsMultitaskSettledFrame({identity:f.identity,hwnd:f.ready.hwnd,title:f.ready.title,targetId:f.target.id},{
      identity:({remainingMs})=>observer.request('identity',{pid:f.child.pid},remainingMs),
      fixture:({remainingMs})=>f.request('snapshot',{},remainingMs),
      windows:({remainingMs})=>observer.request('windows',{pid:f.child.pid},remainingMs),
      targets:({signal})=>manager.targetsFor(id,signal),
      capture:({signal})=>capture(id,false,signal),
    },{onSample:value=>samples.push(value)})
    f.settled=value.settled;return value.frame
  }
  const point = (id, frame, offset = 0) => { const p = fixtures.get(id).settled.point; return { x: (p.x + offset - frame.geometry.x) * frame.width / frame.geometry.width, y: (p.y - frame.geometry.y) * frame.height / frame.geometry.height } }
  const arm = async id => { const value = await observer.request('arm', { binding: { native: bindings.get(id).identity, fixture: fixtures.get(id).identity, hwnd: fixtures.get(id).ready.hwnd } }); activeSampleStage = id; return value }
  const held = async (id, stage, expected) => {
    const actionGate = liveActionGates.get(id); assert.ok(actionGate, 'An original issued action is required before joint sampling')
    await actionGate.started
    const label = `Original ${stage} action exposed no joint own OS-held / AI-pointer interval`
    while (actionGate.assertCurrent().remainingMs > 0) {
      const native = await status(id); actionGate.assertCurrent()
      const sample = await observer.request('snapshot'); const anchor = actionGate.assertCurrent()
      const binding = { native: bindings.get(id).identity, fixture: fixtures.get(id).identity, hwnd: fixtures.get(id).ready.hwnd, targetId: fixtures.get(id).target.id }
      const verdict = windowsMultitaskHeldVerdict(native, sample, binding)
      heldSamples.push({ stage, sessionId: id, native, os: sample, verdict, liveActionAnchor: { actionId: actionGate.snapshot().actionId, nativeEpoch: anchor.nativeEpoch, startedAtMs: anchor.startedAtMs, deadlineMs: anchor.deadlineMs } })
      if (expected && (verdict.epoch !== expected.epoch || verdict.logicalEpoch !== expected.logicalEpoch || verdict.ownerSHA256 !== expected.ownerSHA256)) throw new Error('The original held ownership changed; no later action may satisfy this gate')
      if (verdict.passed) return { ...verdict, os: sample }
      await sleep(8)
    }
    throw new Error(label)
  }
  let activeSampleStage
  const finishSamples = async stage => { const receipt = await observer.request('finish'); observers.push({ stage, ...receipt }); activeSampleStage = undefined }
  try {
    observer = endpoint(config.observer, [], 'observer'); const ready = await observer.ready(); observer.identity = remember(ready.identity); systemConsolePath = ready.systemConsolePath
    runnerIdentity = remember(await observer.request('identity', { pid: process.pid })); const preflight = await os()
    assert.ok(inputReleased(preflight), 'The isolated interactive desktop must have empty actual input, no journal, and a free lease')
    assert.ok(preflight.screen.width >= 1200 && preflight.screen.height >= 600, 'Two unchanged fixture clients require an adequate real desktop')
    runtime = await import(pathToFileURL(config.runtime).href)
    manager = new runtime.ComputerEnvironmentManager({ directory: join(config.guestRoot, 'profile'), enabled: () => true })
    for (const [index, id] of ['chat-A', 'chat-B'].entries()) {
      const x = preflight.screen.x + (index ? preflight.screen.width - 580 : 20), y = preflight.screen.y + 20
      const fixture = endpoint(config.fixture, ['--label', id, '--run-id', config.runId, '--x', String(x), '--y', String(y)], id); fixtures.set(id, fixture)
      fixture.ready = (await fixture.ready()).state; fixture.identity = remember(await observer.request('identity', { pid: fixture.child.pid }))
      assert.ok(sameWindowsMultitaskIdentity(fixture.identity, fixture.ready), 'Fixture bootstrap did not match its live OS identity')
      fixture.target = (await manager.targetsFor(id)).find(row => row.pid === fixture.identity.pid && row.title === fixture.ready.title && row.id.startsWith(`window:${BigInt(fixture.ready.hwnd).toString(16)}:`))
      assert.ok(fixture.target, 'Only the exact self-owned fixture target may be authorized')
      const entry = Reflect.get(manager, 'entries').get(id), scheduled = Reflect.get(entry.driver, 'local'), native = scheduled?.inner
      assert.ok(scheduled instanceof runtime.ScheduledComputerDriver && native instanceof runtime.NativeCompanionDriver && scheduled.surface === 'local-desktop', 'Default production manager/router/scheduler/native chain required')
      const child = Reflect.get(native, 'child'), tracking = track(child, `native-${id}`), identity = remember(await observer.request('identity', { pid: child.pid }))
      assert.equal(identity.executablePath.toLowerCase(), config.helper.toLowerCase()); assert.equal(identity.sessionId, runnerIdentity.sessionId)
      const nativeAudit = createWindowsMultitaskNativeAudit(), nativeChunk = chunk => nativeAudit.push(chunk)
      child.stdout.on('data', nativeChunk); child.stdout.once('end', () => nativeAudit.finish())
      bindings.set(id, { scheduled, native, identity, nativeAudit, nativeChunk, ...tracking }); native.subscribe(value => events.push({ sessionId: id, ...value }))
    }
    assert.equal(bindings.get('chat-A').scheduled.scheduler, bindings.get('chat-B').scheduled.scheduler)
    if (config.foregroundFixturePermits === true) {
      for (const [caller, callee] of [['chat-A', 'chat-B'], ['chat-B', 'chat-A']]) foregroundSetup.push({ caller, callee, receipt: await fixtures.get(caller).request('permitForeground', { identity: bindings.get(callee).identity }) })
      assert.ok(windowsMultitaskForegroundPermitPassed(foregroundSetup.find(row => row.caller === 'chat-B').receipt, { caller: fixtures.get('chat-B').identity, callee: bindings.get('chat-A').identity, callerWindow: fixtures.get('chat-B').ready.hwnd, reason: 'setup' }), 'Controlled fixture setup requires the actual foreground B app to permit only the exact A helper')
    }
    server = createServer(async (request, response) => {
      try {
        assert.equal(request.headers.host, `127.0.0.1:${server.address().port}`)
        const url = new URL(request.url, `http://${request.headers.host}`)
        if (request.method === 'GET' && url.pathname === '/api/qiuya-tools.computer.preview' && fixtures.has(url.searchParams.get('session'))) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(runtime.computerPreviewPage); return }
        assert.equal(request.method, 'POST'); assert.equal(url.pathname, '/api/qiuya-tools.computer.control'); assert.equal(request.headers.origin, `http://${request.headers.host}`)
        let body = ''; for await (const chunk of request) { body += chunk.toString(); assert.ok(Buffer.byteLength(body) <= 8192) }
        const { rpcId, payload } = JSON.parse(body), id = payload?.sessionId; assert.ok(fixtures.has(id)); let value
        if (payload.op === 'status') value = { sessions: manager.list(), environments: manager.environments() }
        else if (payload.op === 'frame') { value = await manager.preview(id); frames.set(id, (frames.get(id) ?? 0) + 1) }
        else if (payload.op === 'pause') value = await manager.pause(id)
        else throw new Error('The isolated preview testhost permits only status/frame/pause for its two own fixture chats')
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }))
      } catch { if (!response.headersSent) response.writeHead(400); response.end() }
    })
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const previewURL = id => `http://127.0.0.1:${server.address().port}/api/qiuya-tools.computer.preview?session=${encodeURIComponent(id)}`
    // Separate functional scope: exact foreground owned B grants A once, then A activates once before all original business. No physical CUA claim.
    assert.equal(config.initialTitlebarSetup,false);assert.equal(config.normalOwnedStartup,true);assert.equal(config.foregroundFixturePermits,false);
    const setupStarted=performance.now(),setupA=fixtures.get('chat-A'),startupExpected={runId:config.runId,fixture:setupA.identity,hwnd:setupA.ready.hwnd,title:setupA.ready.title,fixtureB:fixtures.get('chat-B').identity,hwndB:fixtures.get('chat-B').ready.hwnd,titleB:fixtures.get('chat-B').ready.title,nativeA:bindings.get('chat-A').identity,nativeB:bindings.get('chat-B').identity},startupGate=createWindowsOwnedStartupGate(startupExpected),startupNonce=randomUUID();
    const startupRead=async()=>{
      assert.equal(manager.list().length,0);assert.equal(actions.length,0);assert.equal(liveActionReceipts.length,0);assert.equal(activeSampleStage,undefined);
      const native=[];for(const id of bindings.keys()){const state=await status(id),identity=await observer.request('identity',{pid:bindings.get(id).identity.pid});native.push({sessionId:id,identity,physicalSequence:state.foregroundPhysicalSequence,scheduledPhysical:state.testOnlyScheduledPhysical,transportHeld:state.testOnlyTransportHeld})}
      return {sessionStarts:manager.list().length,businessActions:actions.length,fixture:await fixtureState('chat-A'),independentIdentity:await observer.request('identity',{pid:setupA.identity.pid}),windows:await observer.request('windows',{pid:setupA.identity.pid}),peerFixture:await fixtureState('chat-B'),peerIndependentIdentity:await observer.request('identity',{pid:fixtures.get('chat-B').identity.pid}),peerWindows:await observer.request('windows',{pid:fixtures.get('chat-B').identity.pid}),native,os:await os()};
    };
    const beforeStartup=await startupRead();assert(inputReleased(beforeStartup.os),'Normal startup requires empty OS input and a free lease');
    await writeFile(join(output,'normal-owned-startup-attempt.json'),JSON.stringify({scope:WINDOWS_OWNED_STARTUP_SCOPE,expected:startupExpected,before:beforeStartup},null,2));
    assert.equal(beforeStartup.os.foreground,startupExpected.hwndB,'Initial credit donor must independently be own foreground B');
    assert(performance.now()-setupStarted<30000,'Initial credit budget expired before grant');
    const credit=await fixtures.get('chat-B').request('grantInitialOwnedForeground',{runId:config.runId,nonce:startupNonce,identity:startupExpected.fixture,hwnd:startupExpected.hwnd});
    const afterGrant=await startupRead();
    await writeFile(join(output,'normal-owned-startup-attempt.json'),JSON.stringify({scope:WINDOWS_OWNED_STARTUP_SCOPE,expected:startupExpected,before:beforeStartup,credit,afterGrant},null,2));
    assert.equal(credit.allowed,true,'Exact foreground B must successfully grant A once');assert.equal(afterGrant.os.foreground,startupExpected.hwndB);assert(inputReleased(afterGrant.os));
    assert(performance.now()-setupStarted<30000,'Initial credit budget expired before activation');
    const activation=await setupA.request('normalOwnedStartupActivate',{runId:config.runId,nonce:startupNonce});
    const startupProof={scope:WINDOWS_OWNED_STARTUP_SCOPE,runId:config.runId,nonce:startupNonce,physicalCUAVerified:false,syntheticInputEvents:0,businessActions:0,sessionStarts:0,activationAttempts:1,budgetMs:30000,elapsedMs:performance.now()-setupStarted,before:beforeStartup,afterGrant,credit,creditAttempts:1,after:await startupRead(),activation};
    startupProof.elapsedMs=performance.now()-setupStarted;await writeFile(join(output,'normal-owned-startup-attempt.json'),JSON.stringify({expected:startupExpected,proof:startupProof},null,2));normalStartupReceipt=startupGate.finish(startupProof);
    await writeFile(join(output,'normal-owned-startup.json'),JSON.stringify({expected:startupExpected,proof:startupProof,receipt:normalStartupReceipt},null,2));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);try{const response=await fetch(config.setupURL+'/owned-startup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId:config.runId,architecture:config.architecture,helperSHA256:config.helperSHA256,expected:startupExpected,proof:startupProof}),signal:controller.signal});assert.equal(response.status,200);const ack=await response.json();assert.equal(ack.accepted,true);assert.equal(ack.runId,config.runId);assert.equal(ack.nonce,startupNonce);assert.equal(ack.physicalCUAVerified,false)}finally{clearTimeout(timer)}
    await Promise.all([...fixtures].map(([id, value]) => manager.start(id, value.target.id, { allowOnce: true })))
    assert.equal(manager.list().length, 2); assert.ok(manager.list().every(row => row.state === 'ready'))
    for (const id of bindings.keys()) assert.equal((await status(id)).testOnlyScheduledPhysical, null)
    pass('TWO-DEFAULT-READY-CHATS-WITHOUT-PHYSICAL-LEASE')
    let [aFrame, bFrame] = await Promise.all([settle('chat-A'), settle('chat-B')]); await Promise.all([capture('chat-A', true), capture('chat-B', true)])
    pass('INDEPENDENT-PARALLEL-REAL-OBSERVATION')
    phase = 'fifo'
    const beforeA = await fixtureState('chat-A'), beforeB = await fixtureState('chat-B')
    await arm('chat-A')
    const a = point('chat-A', aFrame), first = input('chat-A', aFrame, { kind: 'drag', ...a, toX: point('chat-A', aFrame, 360).x, toY: a.y })
    const aGate = await held('chat-A', 'FIFO-A'); let firstDone = false; first.finally(() => { firstDone = true }).catch(() => {})
    const b = point('chat-B', bFrame), second = input('chat-B', bFrame, { kind: 'drag', ...b, toX: point('chat-B', bFrame, 360).x, toY: b.y })
    const bAfterA = first.then(async () => { await finishSamples('FIFO-A'); await arm('chat-B'); return held('chat-B', 'FIFO-B') })
    bAfterA.catch(() => {})
    const [bQueued, queuedPreview, queuedOS] = await Promise.all([status('chat-B'), capture('chat-B', true), os()])
    assert.equal(bQueued.testOnlyScheduledPhysical, null); assert.ok(!firstDone && queuedOS.heldKeys.includes(1)); assert.equal(queuedOS.foreground, fixtures.get('chat-A').ready.hwnd)
    pass('QUEUED-B-PREVIEWS-WHILE-A-OWNS-REAL-DESKTOP', { aGate, queuedFrameId: queuedPreview.frameId })
    const [, , bGate] = await Promise.all([first, second, bAfterA]); await finishSamples('FIFO-B')
    const afterA = await fixtureState('chat-A'), afterB = await fixtureState('chat-B'), fifo = windowsMultitaskFifoVerdict(beforeA, afterA, beforeB, afterB)
    assert.ok(fifo.passed); pass('FIXTURE-A-UP-PRECEDES-B-DOWN-EXACTLY-ONCE', { fifo, bGate, beforeA, afterA, beforeB, afterB })
    if (config.foregroundFixturePermits === true) {
      const permits = afterA.foregroundPermits.filter(row => windowsMultitaskForegroundPermitPassed(row, { caller: fixtures.get('chat-A').identity, callee: bindings.get('chat-B').identity, callerWindow: fixtures.get('chat-A').ready.hwnd, reason: 'mouse-up' }))
      assert.equal(permits.length, 1, 'The original A mouse-up must have exactly one confirmed same-session, exact-B foreground permit with no input held')
      pass('CONTROLLED-FIXTURE-GRANTS-ONLY-EXACT-B-FOREGROUND-PERMISSION', { foregroundSetup, permits, productionAutomaticFocusSolved: false })
    }
    if (config.foregroundFixturePermits !== true) {
      const proof = windowsMultitaskProductionGrantVerdict([...bindings].map(([sessionId, value]) => ({ sessionId, identity: value.identity, ...value.nativeAudit.snapshot() })), config.helperSHA256)
      await writeFile(join(output, 'production-foreground-ack.json'), JSON.stringify(proof, null, 2)); assert.equal(proof.passed, true, 'One exact production helper grant must link A release to B fresh ticket before its native Down ACK'); pass('ONE-EXACT-PRODUCTION-HELPER-GRANT-BETWEEN-RELEASE-AND-B-DOWN', proof)
    }
    for (const id of bindings.keys()) { const state = await status(id); assert.equal(state.testOnlyScheduledPhysical, null); assert.equal(state.testOnlyTransportHeld.mouseButtons.length, 0); assert.equal(state.aiCursor.visible, false); assert.equal(manager.get(id).state, 'ready') }
    assert.ok(inputReleased(await os())); pass('PER-ACTION-RELEASE-HIDES-POINTER-WITH-BOTH-CHATS-READY')
    phase = 'cross-chat-redock'
    const aEpoch = manager.get('chat-A').epoch, bEpoch = manager.get('chat-B').epoch
    await manager.openPreview('chat-A', previewURL('chat-A'), 'QiuYaTools · 电脑操控')
    await until(() => (frames.get('chat-A') ?? 0) >= 2, 'A real WebView2 preview did not fetch two frames', 20000)
    const presentationStart = performance.now()
    const presentation = await until(async () => {
      const identity = bindings.get('chat-A').identity, alive = await observer.request('alive', { identity }), rows = await observer.request('windows', { pid: identity.pid })
      const verdict = windowsMultitaskPreviewPresentation(rows, identity, 'QiuYaTools · 电脑操控')
      const sample = { stage: 'A-first-popout', identity, elapsedMs: performance.now() - presentationStart, exactNativeAlive: alive.alive === true, ...verdict }
      if (previewPresentationSamples.length < 64) previewPresentationSamples.push(sample)
      else previewPresentationSamples[63] = sample
      return sample.exactNativeAlive && verdict.passed ? sample : false
    }, 'The exact A helper did not publish one visible preview with its production title', 5000)
    const previewWindows = presentation.windows; assert.equal(manager.get('chat-B').epoch, bEpoch)
    pass('A-REAL-WEBVIEW2-POPOUT-PRESERVES-B', { previewWindows, bEpoch })
    bFrame = await settle('chat-B'); const from = point('chat-B', bFrame), beforeRedock = await fixtureState('chat-B')
    const blueGeometry=windowsMultitaskBlueRasterGeometry(fixtures.get('chat-B').settled,presentation.matching,await observer.request('windows',{pid:bindings.get('chat-B').identity.pid}))
    await writeFile(join(output,'blue-raster-geometry.json'),JSON.stringify(blueGeometry,null,2))
    await arm('chat-B')
    const ongoing = input('chat-B', bFrame, { kind: 'drag', ...from, toX: point('chat-B', bFrame, 360).x, toY: from.y })
    const beforeCapture = await held('chat-B', 'redock-B'), closedBefore = events.filter(row => row.event === 'previewClosed').length
    assert.ok(config.rasterURL && config.runId, 'A single independently captured physical-display raster is required')
    const client = fixtures.get('chat-B').settled.client
    const acquireSentNs = String(process.hrtime.bigint())
    const physical = fetch(config.rasterURL + '/acquire', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: config.runId, architecture: process.arch, stage: 'redock-B', helperSHA256: config.helperSHA256, before: beforeCapture, screen: beforeCapture.os.screen, crop: { x: client.x, y: client.y + 140, width: client.width, height: 100 }, target: fixtures.get('chat-B').settled.bounds }), signal: AbortSignal.timeout(12000) }).then(async response => { assert.ok(response.ok); const receipt = await response.json(); physicalRasterStages.push({ stage: 'physical-acquire-replied-no-full-read', guestNodeSentNs: acquireSentNs, guestNodeReceivedNs: String(process.hrtime.bigint()), receipt }); return receipt })
    physical.catch(() => {})
    await manager.redock('chat-A')
    const afterRedock = await held('chat-B', 'after-A-redock', beforeCapture)
    assert.equal(manager.get('chat-A').epoch, aEpoch); assert.equal(manager.get('chat-A').state, 'ready'); assert.equal(manager.get('chat-B').epoch, bEpoch)
    assert.equal(manager.environments().find(row => row.sessionId === 'chat-A').previewDetached, false); assert.equal(events.filter(row => row.event === 'previewClosed').length, closedBefore)
    const acquisition = await physical, afterCapture = await held('chat-B', 'after-physical-raster', beforeCapture)
    const causalInterval = acquisitionCausalInterval(beforeCapture, afterCapture, acquisition)
    physicalRasterStages.push({ stage: 'original-after-held-gate-before-finalize', guestNodeReceivedNs: String(process.hrtime.bigint()), causalInterval })
    assert.ok(causalInterval.passed, 'The original physical capture acquisition must precede the unchanged same-owner after-held gate')
    const finalizeSentNs = String(process.hrtime.bigint())
    const finalized = await fetch(config.rasterURL + '/finalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: config.runId, architecture: process.arch, stage: 'redock-B', helperSHA256: config.helperSHA256, before: beforeCapture, after: afterCapture, captureId: acquisition.captureId, screen: beforeCapture.os.screen, crop: { x: client.x, y: client.y + 140, width: client.width, height: 100 }, target: fixtures.get('chat-B').settled.bounds }), signal: AbortSignal.timeout(12000) })
    assert.ok(finalized.ok); const raster = await finalized.json(), interval = windowsMultitaskCaptureInterval(beforeCapture, afterCapture, raster)
    physicalRasterStages.push({ stage: 'finalize-after-original-held-gate', guestNodeSentNs: finalizeSentNs, guestNodeReceivedNs: String(process.hrtime.bigint()), receipt: raster })
    const physicalFailure=windowsMultitaskPhysicalFailure(causalInterval,interval,raster)
    if(physicalFailure)throw Object.assign(new Error(physicalFailure.message),{physicalFailure})
    await ongoing; await finishSamples('redock-B')
    const afterBRedock = await fixtureState('chat-B')
    assert.equal(afterBRedock.counts.downs - beforeRedock.counts.downs, 1); assert.equal(afterBRedock.counts.ups - beforeRedock.counts.ups, 1); assert.ok(afterBRedock.counts.drags - beforeRedock.counts.drags >= 2)
    pass('A-REDOCK-DOES-NOT-CANCEL-B-REAL-HELD-DRAG', { aEpoch, bEpoch, afterRedock, beforeRedock, afterBRedock })
    pass('B-PHYSICAL-POINTER-PIXELS-BETWEEN-SAME-OWNER-OS-HELD-READBACKS', { interval })
    phase = 'ordinary-close'
    frames.set('chat-A', 0); await manager.openPreview('chat-A', previewURL('chat-A'), 'QiuYaTools · 电脑操控')
    await until(() => (frames.get('chat-A') ?? 0) >= 2, 'A reopened WebView2 preview did not fetch frames', 20000)
    await bindings.get('chat-A').native.closePreview(); await until(() => manager.get('chat-A').state === 'paused', 'Ordinary A close did not pause A')
    assert.equal(manager.get('chat-B').state, 'ready'); assert.equal(manager.get('chat-B').epoch, bEpoch)
    bFrame = await settle('chat-B'); const beforeClick = await fixtureState('chat-B')
    await input('chat-B', bFrame, { kind: 'click', ...point('chat-B', bFrame) })
    const afterClick = await fixtureState('chat-B'); assert.equal(afterClick.counts.clicks - beforeClick.counts.clicks, 1)
    pass('ORDINARY-A-CLOSE-PAUSES-ONLY-A-AND-B-CAN-STILL-CLICK')
    await Promise.all(['chat-A', 'chat-B'].map(id => manager.stop(id))); assert.ok(manager.list().every(row => row.state === 'stopped')); assert.ok(inputReleased(await os()))
    pass('STOP-BOTH-RETURNS-REAL-INPUT')
    report = { status: 'passed', checks }
  } catch (error) { report = { status: 'failed', phase, reason: error.message, physicalFailure:error.physicalFailure??null, checks }; process.exitCode = 1 }
  finally {
    try { await writeFile(join(output, 'run-report.json'), JSON.stringify(report, null, 2)) } catch (error) { cleanup.errors.push(error.message) }
    if (observer) {
      try { const receipt = await observer.request('finish'); if (activeSampleStage) observers.push({ stage: phase + '-failure-drain', ...receipt }); activeSampleStage = undefined } catch (error) { cleanup.errors.push(error.message) }
      try { for (const row of await observer.request('descendants', { pid: process.pid })) remember(row) } catch (error) { cleanup.errors.push(error.message) }
    }
    try { await boundedWindowsMultitask(manager?.dispose(), 12000, 'manager disposal') } catch (error) { cleanup.errors.push(error.message) }
    managerDisposedAtMs = performance.now(); cleanup.managerDisposeEndedNs = String(process.hrtime.bigint())
    for (const value of bindings.values()) try { const exit = await boundedWindowsMultitask(value.exited, 6000, value.role); cleanup.exits.push({ role: value.role, identity: value.identity, ...exit, killCalls: value.killCalls }) } catch (error) { cleanup.errors.push(error.message) }
    for (const value of fixtures.values()) {
      try {
        if (value.child.exitCode === null && value.child.signalCode === null) {
          const state = windowsMultitaskFixtureReceipt(await value.request('snapshot'), value.identity)
          fixtureFinalStates.push({ sessionId: value.role, identity: value.identity, state })
          foregroundReceipts.push({ sessionId: value.role, identity: value.identity, permits: state.foregroundPermits })
        } else fixtureFinalStates.push({ sessionId: value.role, identity: value.identity, unavailable: 'fixture-retired-before-final-snapshot' })
      } catch (error) { fixtureFinalStates.push({ sessionId: value.role, identity: value.identity, unavailable: String(error.message).slice(0, 1000) }); cleanup.errors.push(error.message) }
      try { value.child.stdin.end(); const exit = await boundedWindowsMultitask(value.exited, 6000, value.role); cleanup.exits.push({ role: value.role, identity: value.identity, ...exit, killCalls: value.killCalls }) } catch (error) { cleanup.errors.push(error.message) }
    }
    if (server) { server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done)) }
    if (observer) {
      const deferLauncherConsole = identity => {
        if (!windowsMultitaskPendingLauncherConsole(identity, runnerIdentity, systemConsolePath)) return false
        if (cleanup.pendingOuterRetirement.some(row => sameWindowsMultitaskIdentity(row, identity))) return true
        if (cleanup.pendingOuterRetirement.length) return false
        cleanup.pendingOuterRetirement.push(identity); return true
      }
      for (const identity of known.values()) if (identity.pid !== process.pid && identity.pid !== observer.child.pid && !deferLauncherConsole(identity)) try {
        const budgetMs = windowsMultitaskRetirementBudget(identity, [...bindings.values()].map(value => value.identity), [...known.values()])
        cleanup.naturalRetirement.push(await windowsMultitaskWaitNaturalRetirement(identity, identity => observer.request('alive', { identity }), { budgetMs, disposedAtMs: managerDisposedAtMs }))
      } catch (error) { cleanup.remaining.push(identity); cleanup.errors.push(error.message); if (error.retirement) cleanup.naturalRetirement.push(error.retirement) }
      try {
        const remaining = await observer.request('descendants', { pid: process.pid })
        for (const row of remaining) if (row.pid !== observer.child.pid && !deferLauncherConsole(row)) { cleanup.remaining.push(row); cleanup.errors.push('A late owned descendant remains') }
      } catch (error) { cleanup.errors.push(error.message) }
      try { cleanup.finalInput = await os(); assert.ok(inputReleased(cleanup.finalInput), 'Final OS input/lease/journal did not release') } catch (error) { cleanup.errors.push(error.message) }
      cleanup.observerReadFacts = observer.readFacts()
      cleanup.observerFailureFacts = observer.failureFacts()
      cleanup.observerEofAttempted = true
      try { observer.child.stdin.end(); const exit = await boundedWindowsMultitask(observer.exited, 5000, 'observer EOF'); cleanup.exits.push({ role: observer.role, identity: observer.identity, ...exit, killCalls: observer.killCalls }) } catch (error) { cleanup.errors.push(error.message) }
    }
    try { cleanup.helperUnchanged = digest(await readFile(config.helper)) === config.helperSHA256 } catch (error) { cleanup.errors.push(error.message) }
    const nativeDiagnostics = [...bindings].map(([sessionId, value]) => { value.child.stdout.off('data', value.nativeChunk); value.nativeAudit.finish(); return { sessionId, identity: value.identity, ...value.nativeAudit.snapshot() } })
    for (const value of [...fixtures.values(), observer].filter(Boolean)) value.close()
    cleanup.localPassed = windowsMultitaskCleanupVerdict({ ...cleanup, pendingOuterRetirement: [] })
    cleanup.passed = windowsMultitaskCleanupVerdict(cleanup)
    const pendingOuter = report?.status === 'passed' && cleanup.localPassed && cleanup.pendingOuterRetirement.length > 0
    const passed = report?.status === 'passed' && cleanup.passed
    await writeFile(join(output, 'physical-raster-stages.json'), JSON.stringify(physicalRasterStages, null, 2))
    await writeFile(join(output, 'preview-presentation-samples.json'), JSON.stringify(previewPresentationSamples, null, 2))
    await writeFile(join(output, 'held-samples.json'), JSON.stringify({ heldSamples, observers }, null, 2)); await writeFile(join(output, 'geometry-settles.json'), JSON.stringify(geometrySettles, null, 2))
    await writeFile(join(output, 'actions-events.json'), JSON.stringify({ actions, events, nativeDiagnostics, fixtureFinalStates, liveActionReceipts: liveActionReceipts.map(value => value.snapshot()) }, null, 2))
    await writeFile(join(output, 'report.json'), JSON.stringify({ ...report, status: passed ? 'passed' : pendingOuter ? 'pending-outer-retirement' : 'failed', runnerIdentity, systemConsolePath, platform: process.platform, architecture: process.arch, helperSHA256: config.helperSHA256, cleanup,
      evidenceLayer: 'Production default ComputerEnvironmentManager → default shared ScheduledComputerDriver → actual packaged NativeCompanionDriver; isolated loopback testhost with production preview HTML.',
      normalOwnedStartup:normalStartupReceipt??null, foregroundEvidence: { mode: 'owned-initial-foreground-credit-then-unassisted-production-handoff', productionAutomaticCrossHelperFocusSolved: false, setup: foregroundSetup, receipts: foregroundReceipts },
      authenticationBoundary: 'No installed Harness, existing owner principal, account, or production authentication is used or emulated.',
      limitations: ['Separate functional scope: one same-run foreground B-to-A fixture credit and one normal A activation before business. No physical CUA/titlebar or automatic first-focus claim. Strict physical-CUA acceptance remains unverified.', 'Does not prove installed Harness dual inline chat previews.', ...(config.foregroundFixturePermits === true ? ['Exact AllowSetForegroundWindow permits come from the controlled foreground test fixture; production automatic cross-helper activation remains unproven.'] : []), 'No external model, browser/remote concurrency, endurance, or unchanged 52+29 baseline rerun claim.'], testedAt: new Date().toISOString() }, null, 2))
    await writeFile(join(output, 'delivery-verdict.json'), JSON.stringify({ passed, runnerPassed: report?.status === 'passed', naturalCleanupPassed: cleanup.passed, productionHelperUnchanged: cleanup.helperUnchanged }, null, 2))
    console.log(JSON.stringify({ passed, pendingOuterRetirement: pendingOuter, output, checks: checks.length, cleanupPassed: cleanup.passed })); if (!passed && !pendingOuter) process.exitCode = 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--guest-config')) {
  const path = process.argv[process.argv.indexOf('--guest-config') + 1]
  runWindowsMultitaskManager(JSON.parse(await readFile(path, 'utf8'))).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
}
