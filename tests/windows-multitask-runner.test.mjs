import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sameWindowsMultitaskIdentity, inputReleased, windowsMultitaskHeldVerdict, windowsMultitaskFifoVerdict, windowsMultitaskCaptureInterval, windowsMultitaskCleanupVerdict, boundedWindowsMultitask, windowsMultitaskForegroundPermitPassed, windowsMultitaskNativeMetadata, createWindowsMultitaskNativeAudit, windowsMultitaskFixtureReceipt } from '../scripts/test-windows-multitask-manager.mjs'
import { validateWindowsMultitaskRasterRequest, windowsMultitaskRasterPixels, windowsMultitaskCommandReceipt, windowsMultitaskGuestBuildSteps, windowsMultitaskGuestLaunchScript, windowsMultitaskGuestExitValid, finishWindowsMultitaskGuest, windowsMultitaskCompletionPassed } from '../scripts/prepare-windows-multitask-acceptance.mjs'

const identity = { pid: 55, createdAtTicks: '639282542717808149', executablePath: 'C:\\own\\helper.exe', sessionId: 1 }
const fixture = { ...identity, pid: 66, executablePath: 'C:\\own\\fixture.exe' }, ownerId = 'c'.repeat(32), targetId = 'window:123:66:639282542717808149'
const binding = { native: identity, fixture, hwnd: '291', targetId }
function held() {
  return {
    native: { aiCursor: { visible: true, actor: 'ai', targetId }, testOnlyScheduledPhysical: { epoch: 3, logicalEpoch: 17 }, testOnlyTransportHeld: { mouseButtons: ['left'], keys: [], ownerId } },
    os: { nativeAlive: true, fixtureAlive: true, sessionId: 1, foreground: '291', userInteractive: true, activeDesktopAccessible: true, activeDesktopMatches: true, heldKeys: [1], lease: { lockFree: false, journalPresent: true, journal: { ownerId } }, windows: [{ pid: 55, hwnd: '99', title: '', visible: true, enabled: false, exStyle: 0x080800a8, width: 46, height: 58, dpi: 96 }] },
  }
}
test('held acceptance needs this transport owner, real OS hold, exact target and one published pointer together', () => {
  const f = held(); assert.equal(windowsMultitaskHeldVerdict(f.native, f.os, binding).passed, true)
  for (const mutate of [
    s => { s.native.testOnlyTransportHeld.mouseButtons = [] }, s => { s.native.testOnlyTransportHeld.ownerId = 'd'.repeat(32) },
    s => { s.native.testOnlyScheduledPhysical = null }, s => { s.native.aiCursor.targetId = 'foreign' }, s => { s.native.aiCursor.visible = false },
    s => { s.os.heldKeys = [] }, s => { s.os.foreground = '292' }, s => { s.os.sessionId = 2 }, s => { s.os.nativeAlive = false },
    s => { s.os.fixtureAlive = false }, s => { s.os.windows[0].pid = 56 }, s => { s.os.windows[0].enabled = true }, s => { s.os.windows.push(s.os.windows[0]) },
    s => { s.os.lease.journalPresent = false }, s => { s.os.lease.lockFree = true }, s => { s.os.activeDesktopMatches = false },
  ]) { const f = held(); mutate(f); assert.equal(windowsMultitaskHeldVerdict(f.native, f.os, binding).passed, false) }
})
test('FIFO evidence uses independent fixture down/up clocks and exactly one original drag per target', () => {
  const before = { counts: { downs: 0, ups: 0, drags: 0 } }
  const afterA = { counts: { downs: 1, ups: 1, drags: 20 }, frequency: 10000000, events: [{ kind: 'up', ticks: '9999999999999999' }] }
  const afterB = { counts: { downs: 1, ups: 1, drags: 20 }, frequency: 10000000, events: [{ kind: 'down', ticks: '10000000000000000' }] }
  assert.equal(windowsMultitaskFifoVerdict(before, afterA, before, afterB).passed, true)
  for (const mutate of [b => { b.events[0].ticks = '9999999999999998' }, b => { b.counts.downs = 2 }, b => { b.counts.ups = 0 }, b => { b.counts.drags = 0 }, b => { b.frequency++ }, b => { b.events = [] }]) {
    const b = structuredClone(afterB); mutate(b); assert.equal(windowsMultitaskFifoVerdict(before, afterA, before, b).passed, false)
  }
})
test('physical raster cannot pass metadata alone, a different lease, a replay, or resized capture', () => {
  const s = held(), gate = { ...windowsMultitaskHeldVerdict(s.native, s.os, binding), os: { ticks: '100', frequency: 10000000 } }, after = { ...gate, os: { beforeTicks: '200', ticks: '201', frequency: 10000000 } }, raster = { passed: true, captured: true, captureCount: 1, physicalDisplay: true, resized: false }
  assert.equal(windowsMultitaskCaptureInterval(gate, after, raster).passed, true)
  assert.equal(windowsMultitaskCaptureInterval(gate, gate, raster).passed, false, 'A stale or identical OS sample is not an after-capture readback')
  for (const bad of [{ ...after, passed: false }, { ...after, epoch: 4 }, { ...after, logicalEpoch: 18 }, { ...after, ownerSHA256: 'f'.repeat(64) }]) assert.equal(windowsMultitaskCaptureInterval(gate, bad, raster).passed, false)
  for (const bad of [{ ...raster, captured: false }, { ...raster, physicalDisplay: false }, { ...raster, resized: true }, { ...raster, captureCount: 2 }]) assert.equal(windowsMultitaskCaptureInterval(gate, after, bad).passed, false)
})
test('cleanup retains failed EOF, unknown remaining owners, forced exits and independently held input as failures', () => {
  const finalInput = { userInteractive: true, sessionId: 1, activeDesktopAccessible: true, activeDesktopMatches: true, heldKeys: [], lease: { lockFree: true, journalPresent: false } }
  const clean = { errors: [], exits: Array.from({ length: 5 }, (_, i) => ({ role: String(i), code: 0, signal: null, killCalls: [] })), remaining: [], observerEofAttempted: true, finalInput, helperUnchanged: true }
  assert.equal(windowsMultitaskCleanupVerdict(clean), true); assert.equal(inputReleased(finalInput), true)
  for (const mutate of [c => c.errors.push('audit failed'), c => c.exits.pop(), c => { c.exits[0].code = 1 }, c => { c.exits[0].signal = 'SIGKILL' }, c => c.exits[0].killCalls.push('SIGKILL'), c => c.remaining.push(identity), c => { c.observerEofAttempted = false }, c => c.finalInput.heldKeys.push(1), c => { c.finalInput.lease.journalPresent = true }, c => { c.finalInput.lease.lockFree = false }, c => { c.helperUnchanged = false }]) {
    const c = structuredClone(clean); mutate(c); assert.equal(windowsMultitaskCleanupVerdict(c), false)
  }
})
test('identity includes birth, image and interactive session, while retirement waits are bounded', async () => {
  assert.equal(sameWindowsMultitaskIdentity(identity, { ...identity, executablePath: identity.executablePath.toUpperCase() }), true)
  for (const change of [{ pid: 56 }, { createdAtTicks: '639282542717808150' }, { executablePath: 'C:\\other.exe' }, { sessionId: 2 }]) assert.equal(sameWindowsMultitaskIdentity(identity, { ...identity, ...change }), false)
  await assert.rejects(boundedWindowsMultitask(new Promise(() => {}), 5, 'EOF'), /EOF timeout/u)
})
test('raster requests are one fixed own held stage with a fully contained physical crop', () => {
  const request = { runId: 'own', architecture: 'x64', stage: 'redock-B', helperSHA256: 'a'.repeat(64), before: { passed: true, epoch: 3, ownerSHA256: 'b'.repeat(64), pointer: { dpi: 96 }, os: { foreground: '291', heldKeys: [1] } }, screen: { x: 0, y: 0, width: 1280, height: 800 }, target: { x: 680, y: 100, width: 560, height: 400 }, crop: { x: 688, y: 270, width: 540, height: 100 } }
  const data = { id: 'own', architectures: { x64: { helperSHA256: 'a'.repeat(64) } } }
  assert.equal(validateWindowsMultitaskRasterRequest(request, data, 'x64'), request)
  for (const mutate of [r => { r.runId = 'foreign' }, r => { r.stage = 'retry-B' }, r => { r.architecture = 'arm64' }, r => { r.helperSHA256 = 'c'.repeat(64) }, r => { r.before.os.heldKeys = [] }, r => { r.crop.width = 600 }, r => { r.crop.x = -1 }, r => { r.before.pointer.dpi = 0 }]) {
    const r = structuredClone(request); mutate(r); assert.throws(() => validateWindowsMultitaskRasterRequest(r, data, 'x64'))
  }
})
test('pixel oracle rejects empty blue, black/white system cursor alone and dispersed approved-color noise', () => {
  const image = { width: 100, height: 100, data: Buffer.alloc(40000) }, crop = { x: 0, y: 0, width: 100, height: 100 }
  for (let i = 0; i < image.data.length; i += 4) { image.data[i] = 37; image.data[i + 1] = 113; image.data[i + 2] = 151; image.data[i + 3] = 255 }
  assert.equal(windowsMultitaskRasterPixels(image, crop).passed, false)
  const set = (x, y, color) => image.data.set([...color, 255], (y * image.width + x) * 4)
  for (let y = 30; y < 40; y++) for (let x = 30; x < 38; x++) set(x, y, [255,255,255])
  assert.equal(windowsMultitaskRasterPixels(image, crop).passed, false)
  for (let y = 41; y < 51; y++) for (let x = 30; x < 38; x++) set(x, y, [90,128,148])
  assert.equal(windowsMultitaskRasterPixels(image, crop).passed, true)
  set(80, 80, [90,128,148]); assert.equal(windowsMultitaskRasterPixels(image, crop).passed, false)
  assert.throws(() => windowsMultitaskRasterPixels(image, { ...crop, x: -1 }))
})
test('new carrier keeps installed owner authentication outside its evidence boundary and never mutates production source', async () => {
  const runner = await readFile(new URL('../scripts/test-windows-multitask-manager.mjs', import.meta.url), 'utf8')
  assert.match(runner, /new runtime\.ComputerEnvironmentManager\(\{ directory:/u)
  assert.doesNotMatch(runner, /browserPeer:|principal:|createRouter\s*:/u)
  assert.match(runner, /testOnlyTransportHeld/u)
  assert.match(runner, /await manager\.redock\('chat-A'\)/u)
  assert.match(runner, /Original \$\{stage\} action/u)
  const observer = await readFile(new URL('fixtures/windows-multitask-observer.cs', import.meta.url), 'utf8')
  assert.doesNotMatch(observer, /extern\s+.*\b(SendInput|SetForegroundWindow|TerminateProcess)\s*\(/u)
})
test('failed command evidence preserves finite compiler positions and stream hashes without the EncodedCommand or error message', () => {
  const result = { code: 1, signal: null, killed: false, message: 'Command failed: powershell -EncodedCommand SHOULD_NEVER_BE_LOGGED', stdout: '', stderr: 'C:\\own\\fixture.cs(42,7): error CS1002: ; expected\r\n' }
  const receipt = windowsMultitaskCommandReceipt(result, { phase: 'compile-fixture', script: 'Add-Type own-fixture', failed: true })
  assert.equal(receipt.exitCode, 1); assert.equal(receipt.failed, true); assert.equal(receipt.stderrBytes, Buffer.byteLength(result.stderr))
  assert.deepEqual(receipt.compilerDiagnostics, [{ code: 'CS1002', line: 42, column: 7, severity: 'error', message: '; expected' }])
  assert.match(receipt.stderrSHA256, /^[a-f0-9]{64}$/u); assert.match(receipt.scriptSHA256, /^[a-f0-9]{64}$/u)
  assert.doesNotMatch(JSON.stringify(receipt), /SHOULD_NEVER_BE_LOGGED|EncodedCommand|Add-Type own-fixture/u)
  const unavailable = windowsMultitaskCommandReceipt({ ...result, code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true }, { phase: 'runtime-expand', script: 'own-script', failed: true })
  assert.equal(unavailable.exitCode, null); assert.equal(unavailable.errorCode, 'ETIMEDOUT'); assert.equal(unavailable.signal, 'SIGTERM'); assert.equal(unavailable.killed, true); assert.deepEqual(unavailable.compilerDiagnostics, [])
  const many = windowsMultitaskCommandReceipt({ stderr: Array.from({ length: 30 }, (_, i) => `own.cs(${i + 1},1): error CS0001: ${'x'.repeat(1000)}\n`).join(''), code: 1 }, { phase: 'compile-observer', script: 'fixed', failed: true })
  assert.equal(many.compilerDiagnostics.length, 16); assert.ok(many.compilerDiagnostics.every(row => row.message.length <= 512))
})
test('guest preparation separates archive, helper placement and each compiler into finite independently identified steps', () => {
  const root = 'C:\\Users\\qiuya\\AppData\\Local\\Temp\\QiuYaTools-multitask-6eef41fd-5250-4703-9177-d320d8446e15', helper = root + '\\native\\win32-arm64\\qiuya-windows.exe'
  const steps = windowsMultitaskGuestBuildSteps(root, 'arm64', helper)
  assert.deepEqual(steps.map(row => row.phase), ['runtime-expand', 'helper-place', 'compile-fixture', 'compile-observer'])
  for (const row of steps) {
    assert.ok(row.timeout <= 90000)
    assert.ok(Buffer.from(row.script, 'utf16le').toString('base64').length < 2000)
    assert.doesNotMatch(row.script, /Start-Process|--computer|--guest-config|SendInput|SetForegroundWindow/u)
  }
  assert.ok(steps.filter(row => row.script.includes('Add-Type')).every(row => (row.script.match(/Add-Type/gu) ?? []).length === 1))
  assert.ok(steps.filter(row => row.script.includes('Add-Type')).every(row => row.script.includes('-OutputType WindowsApplication')))
})
test('guest launcher pins a no-console process and null exit never stands in for success', () => {
  const script = windowsMultitaskGuestLaunchScript({ node: 'C:\\own\\node.exe', guestRoot: 'C:\\own' })
  assert.match(script, /\$i\.CreateNoWindow=\$true/u); assert.match(script, /\$pin=\$p\.SafeHandle/u); assert.match(script, /\$exitCode=\[int\]\$p\.ExitCode/u)
  assert.match(script, /\$i\.RedirectStandardInput=\$true/u)
  assert.match(script, /\$p=\[Diagnostics\.Process\]::Start\(\$i\);\$p\.StandardInput\.Close\(\);\$pin=/u)
  assert.match(script, /standardInputRedirected=\$true;standardInputClosed=\$true/u)
  assert.doesNotMatch(script, /Start-Process|\.Kill\(|Stop-Process/u)
  const receipt = { exitCode: 1, normalWait: true, killCalls: 0, createNoWindow: true, standardInputRedirected: true, standardInputClosed: true, processHandlePinned: true, pid: identity.pid, identity }
  assert.equal(windowsMultitaskGuestExitValid(receipt), true, 'A real failed exit is valid lifecycle evidence and remains a failed task result')
  for (const change of [{ exitCode: null }, { exitCode: '0' }, { normalWait: false }, { killCalls: 1 }, { processHandlePinned: false }, { createNoWindow: false }, { standardInputRedirected: false }, { standardInputClosed: false }, { pid: 56 }]) assert.equal(windowsMultitaskGuestExitValid({ ...receipt, ...change }), false)
})
test('controlled fixture foreground permit needs exact caller and callee identities, unchanged own foreground and no held input', () => {
  const expected = { caller: fixture, callee: identity, callerWindow: '291', reason: 'mouse-up' }
  const receipt = { attempted: true, allowed: true, error: 0, reason: 'mouse-up', extraInputEvents: 0, focusChangesRequested: 0, caller: fixture, callee: identity, callerWindow: '291', foregroundBefore: '291', foregroundAfter: '291', heldKeys: [] }
  assert.equal(windowsMultitaskForegroundPermitPassed(receipt, expected), true)
  for (const change of [{ allowed: false }, { attempted: false }, { error: 5 }, { reason: 'retry' }, { extraInputEvents: 1 }, { focusChangesRequested: 1 }, { foregroundBefore: '292' }, { foregroundAfter: '292' }, { heldKeys: [1] }, { callee: { ...identity, pid: 56 } }, { callee: { ...identity, createdAtTicks: '639282542717808150' } }, { callee: { ...identity, sessionId: 2 } }]) assert.equal(windowsMultitaskForegroundPermitPassed({ ...receipt, ...change }, expected), false)
})
test('GUI-subsystem test processes use redirected pipes and only the fixture can request a precise foreground permit', async () => {
  const fixtureSource = await readFile(new URL('fixtures/windows-multitask-fixture.cs', import.meta.url), 'utf8'), observerSource = await readFile(new URL('fixtures/windows-multitask-observer.cs', import.meta.url), 'utf8')
  for (const source of [fixtureSource, observerSource]) { assert.match(source, /Console\.OpenStandardInput\(\)/u); assert.match(source, /Console\.OpenStandardOutput\(\)/u); assert.doesNotMatch(source, /Console\.OutputEncoding\s*=/u) }
  assert.match(fixtureSource, /AllowSetForegroundWindow\(\(uint\)pid\)/u)
  assert.doesNotMatch(fixtureSource, /ASFW_ANY|0xffffffff|SendInput|\bSetForegroundWindow\(/iu)
  assert.doesNotMatch(observerSource, /extern\s+.*\bAllowSetForegroundWindow\s*\(/u)
})
test('actual failed exit still collects evidence, naturally retires its task and independently audits input before remaining failed', async () => {
  const runnerExit = { exitCode: 1, normalWait: true, killCalls: 0, createNoWindow: true, standardInputRedirected: true, standardInputClosed: true, processHandlePinned: true, pid: identity.pid, identity }, order = []
  const taskReceipt = { state: 'Ready', exitCode: 1, unregistered: true }, auditReceipt = { state: 'Ready', exitCode: 0, unregistered: true }, report = { status: 'failed', phase: 'fifo', reason: 'foreground-denied', cleanup: { passed: true }, platform: 'win32', architecture: 'arm64' }
  const lifecycle = await finishWindowsMultitaskGuest(runnerExit, {
    collect: async () => { order.push('collect-report-held-samples-actions'); return { report, files: ['report.json', 'held-samples.json', 'actions-events.json'] } },
    retireTask: async () => { order.push('wait-Ready-unregister'); return taskReceipt },
    postflight: async () => { order.push('independent-OS-postflight-Ready-unregister'); return auditReceipt },
  })
  assert.deepEqual(order, ['collect-report-held-samples-actions', 'wait-Ready-unregister', 'independent-OS-postflight-Ready-unregister'])
  assert.equal(lifecycle.exitValid, true); assert.equal(lifecycle.actualExitCode, 1); assert.deepEqual(lifecycle.errors, [])
  assert.equal(lifecycle.results.collect.report.reason, 'foreground-denied'); assert.equal(lifecycle.results['task-retirement'].exitCode, 1)
  const all = { runnerExit, lifecycle, taskReceipt, auditReceipt, report, architecture: 'arm64', captureCount: 1, physicalReceipts: [{ passed: true }] }
  assert.equal(windowsMultitaskCompletionPassed(all), false)
  const valid = { ...all, runnerExit: { ...runnerExit, exitCode: 0 }, taskReceipt: { ...taskReceipt, exitCode: 0 }, report: { ...report, status: 'passed' } }
  assert.equal(windowsMultitaskCompletionPassed(valid), true)
  for (const change of [{ captureCount: 0 }, { physicalReceipts: [{ passed: false }] }, { report: { ...valid.report, cleanup: { passed: false } } }, { runnerExit: { ...runnerExit, exitCode: null } }, { auditReceipt: { ...auditReceipt, exitCode: 1 } }]) assert.equal(windowsMultitaskCompletionPassed({ ...valid, ...change }), false)
})
test('unknown exit and a failed evidence collection retain failure while later task and independent audit stages still execute', async () => {
  const order = [], lifecycle = await finishWindowsMultitaskGuest({ exitCode: null }, {
    collect: async () => { order.push('collection'); throw new Error('owned held-samples unavailable') },
    retireTask: async () => { order.push('task-retirement'); throw new Error('task not Ready') },
    postflight: async () => { order.push('postflight'); return { state: 'Ready', exitCode: 0, unregistered: true } },
  })
  assert.deepEqual(order, ['collection', 'task-retirement', 'postflight']); assert.equal(lifecycle.exitValid, false); assert.equal(lifecycle.actualExitCode, null)
  assert.deepEqual(lifecycle.errors.map(row => row.stage), ['guest-exit-schema', 'collect', 'task-retirement']); assert.equal(lifecycle.results.postflight.exitCode, 0)
})
test('passive native metadata retains only finite failure codes and input counts, never error text or Unicode units', () => {
  const failure = { requestId: 71, ok: false, error: { code: 'input-journal-failed', message: 'PRIVATE_ERROR_TEXT' }, result: { imageBase64: 'PRIVATE_IMAGE' } }
  assert.deepEqual(windowsMultitaskNativeMetadata(failure), { kind: 'failureReply', requestId: 71, code: 'input-journal-failed' })
  assert.deepEqual(windowsMultitaskNativeMetadata({ ...failure, error: { code: 'PRIVATE_UNLISTED_CODE' } }), { kind: 'failureReply', requestId: 71, code: 'unknown-code' })
  for (const value of [null, [], { ...failure, requestId: '71' }, { ...failure, requestId: Number.MAX_SAFE_INTEGER + 1 }, { ...failure, requestId: -1 }, { ...failure, event: 'other' }]) assert.equal(windowsMultitaskNativeMetadata(value), undefined)
  const event = { event: 'inputHeld', ownerId, keys: [13, 16], unicodeUnits: [20013, 25991], mouseButtons: ['left'], payload: 'PRIVATE_PAYLOAD' }
  const metadata = windowsMultitaskNativeMetadata(event)
  assert.deepEqual(metadata, { kind: 'inputHeld', keyCount: 2, unicodeUnitCount: 2, mouseButtons: ['left'], ownerSHA256: 'cd93782b7fb95559de14f738b65988af85d41dc1565f7c7d1ed2d035665b519c' })
  assert.equal(windowsMultitaskNativeMetadata({ ...event, ownerId: null }).ownerSHA256, null, 'The real native clear ACK has ownerId null')
  for (const change of [{ ownerId: 'PRIVATE_OWNER' }, { keys: Array(257).fill(1) }, { keys: [256] }, { unicodeUnits: Array(1025).fill(1) }, { unicodeUnits: [-1] }, { mouseButtons: ['PRIVATE_BUTTON'] }]) assert.equal(windowsMultitaskNativeMetadata({ ...event, ...change }), undefined)
  assert.doesNotMatch(JSON.stringify([metadata, windowsMultitaskNativeMetadata(failure)]), /PRIVATE_|20013|25991|"keys"|"unicodeUnits"|"ownerId"/u)
})
test('native diagnostic framing handles split CRLF and oversize image frames without retaining private payloads or losing the next failure', () => {
  const audit = createWindowsMultitaskNativeAudit({ maxLineBytes: 256, clock: () => 123n })
  const line = JSON.stringify({ requestId: 1, ok: false, error: { code: 'foreground-denied', message: 'PRIVATE_ERROR' } }) + '\r\n'
  for (const character of line) audit.push(character)
  audit.push(JSON.stringify({ requestId: 2, ok: true, result: { imageBase64: 'PRIVATE_IMAGE'.repeat(300) } }) + '\n' + '{malformed}\n' + line)
  audit.push('x'.repeat(500)); audit.push('y'.repeat(500)); audit.push('\n' + line)
  audit.push('{"requestId":99,"ok":false'); audit.finish(); audit.push(line)
  const receipt = audit.snapshot()
  assert.deepEqual(receipt.records.map(row => row.requestId), [1, 1, 1]); assert.equal(receipt.counts.oversizedLines, 2); assert.equal(receipt.counts.invalidLines, 1)
  assert.equal(receipt.firstFailure.requestId, 1); assert.equal(receipt.incompleteTailBytes, 26); assert.equal(receipt.ended, true); assert.equal(receipt.inputHeldIsOsDownProof, false)
  assert.equal(receipt.retainedBytes, 0); assert.ok(receipt.maxRetainedBytes <= 256)
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_|imageBase64|malformed/u)
})
test('native diagnostic records and memory are bounded while the first failure survives later overflow', () => {
  const audit = createWindowsMultitaskNativeAudit({ maxRecords: 2, clock: () => 999n }), held = { event: 'inputHeld', ownerId: null, keys: [], unicodeUnits: [], mouseButtons: [] }
  audit.push(JSON.stringify(held) + '\n' + JSON.stringify(held) + '\n')
  for (let id = 5; id < 305; id++) audit.push(JSON.stringify({ requestId: id, ok: false, error: { code: 'input-journal-failed', message: 'PRIVATE' } }) + '\n')
  const receipt = audit.snapshot(); assert.equal(receipt.records.length, 2); assert.equal(receipt.counts.metadataRecords, 302); assert.equal(receipt.counts.omittedRecords, 300)
  assert.equal(receipt.firstFailure.requestId, 5); assert.equal(receipt.firstFailure.code, 'input-journal-failed')
  receipt.firstFailure.code = 'mutated'; receipt.records[0].mouseButtons.push('foreign')
  assert.equal(audit.snapshot().firstFailure.code, 'input-journal-failed'); assert.deepEqual(audit.snapshot().records[0].mouseButtons, [])
})
test('final owned fixture counts and events remain available even when the action failed before a confirmed Down', () => {
  const state = { ...fixture, frequency: 10000000, counts: { downs: 0, ups: 1, drags: 0, clicks: 1 }, events: [{ kind: 'up', ticks: '123', x: 80, y: 180 }], foregroundPermits: [], bounds: { x: 20, y: 100, width: 540, height: 360 } }
  const receipt = windowsMultitaskFixtureReceipt(state, fixture)
  assert.deepEqual(receipt.counts, state.counts); assert.deepEqual(receipt.events, state.events)
  receipt.counts.ups++; assert.equal(state.counts.ups, 1)
  assert.throws(() => windowsMultitaskFixtureReceipt({ ...state, pid: 99 }, fixture), /own process/u)
  assert.throws(() => windowsMultitaskFixtureReceipt({ ...state, events: Array(129).fill(state.events[0]) }, fixture))
  assert.throws(() => windowsMultitaskFixtureReceipt({ ...state, counts: { ...state.counts, downs: -1 } }, fixture))
  assert.equal(windowsMultitaskFifoVerdict(state, state, state, state).passed, false, 'A finally Up without a confirmed Down cannot pass FIFO')
})
