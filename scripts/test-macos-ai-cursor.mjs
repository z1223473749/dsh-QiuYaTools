/** Real Mac AppKit/CG/SCK pointer and native WK redock checks. No production edits. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, stop as stopEsbuild } from 'esbuild'

assert.equal(process.platform, 'darwin')
const root = fileURLToPath(new URL('../', import.meta.url)), arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] }
const output = resolve(arg('--out', 'artifacts/computer-use/macos-ai-cursor')), helper = await realpath(resolve(arg('--native', join(root, 'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'))))
await mkdir(output, { recursive: true })
for (const name of ['report.json', 'run-report.json', 'delivery-verdict.json']) assert.equal(await access(join(output, name)).then(() => true, () => false), false, 'Use a fresh evidence directory')
const execute = promisify(execFile), temporary = await mkdtemp(join(tmpdir(), 'qiuya-ai-pointer-')), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fixtureSource = join(root, 'src/native/macos/fixtures/AICursorFixture.swift'), observerSource = join(root, 'src/native/macos/fixtures/AICursorObserver.swift'), leaseSource = join(root, 'src/native/macos/fixtures/LeaseOracle.swift')
const observerBinary = join(temporary, 'cursor-observer'), leaseBinary = join(temporary, 'lease-oracle'), fixturePaths = []
const trace = [], checks = [], observations = [], captures = [], geometrySettles = [], captureInputAudits = [], identities = new Map(), controllers = [], cleanup = { passed: false, errors: [], forced: [], processes: [] }
const key = value => `${value.pid}:${value.startSeconds}:${value.startMicroseconds}`
const same = (a, b) => a && b && key(a) === key(b) && a.executablePath === b.executablePath
const remember = (value, role) => { assert.ok(value?.pid && value.startSeconds && value.startMicroseconds && value.executablePath); identities.set(key(value), { ...value, role }); return value }
const empty = value => value && !value.leftButtonDown && !value.rightButtonDown && !value.middleButtonDown && value.keysDown?.length === 0
let observer, alpha, beta, native, host, driver, secondNative, server, report, fatal, phase = 'setup', activeEpoch
let runnerIdentity, currentTarget, helperSha256, environment, pageReceipt, pagehidePauses = 0
let hostChild, hostChildExit
const nativeEvents = [], pageEvents = [], frameReceipts = new Map(), routes = new Map()
const pass = (id, evidence = {}) => checks.push({ id, passed: true, ...evidence })
function endpoint(executable, args, label) {
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, QIUYA_TOOLS_PARENT_PID: String(process.pid) } })
  const pending = new Map(), events = [], waiting = [], transcript = []; let id = 0, stderr = ''
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-6000) }); child.stdin.on('error', () => {})
  const exited = new Promise(done => { child.once('exit', (code, signal) => done({ code, signal })); child.once('error', error => done({ error: error.message })) })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let value; try { value = JSON.parse(line) } catch { fatal ??= new Error(`${label} returned malformed JSON`); return }
    const recorded = value.result ? { ...value, result: { ...value.result } } : value
    if (recorded.result?.imageBase64) recorded.result.imageBase64 = `[${recorded.result.imageBase64.length} base64 chars]`
    if (recorded.result?.targets) recorded.result.targets = recorded.result.targets.filter(target => [alpha?.identity.pid, beta?.identity.pid, native?.identity.pid, secondNative?.pid].includes(target.pid))
    transcript.push(recorded)
    const job = pending.get(value.requestId)
    if (job) { pending.delete(value.requestId); clearTimeout(job.timer); job.resolve(value) }
    else { const index = waiting.findIndex(job => job.event === value.event); if (index >= 0) { const job = waiting.splice(index, 1)[0]; clearTimeout(job.timer); job.resolve(value) } else events.push(value) }
  })
  exited.then(value => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error(`${label} exited ${JSON.stringify(value)} ${stderr}`)) }; pending.clear() })
  const request = (op, payload = {}) => new Promise((resolve, reject) => {
    const requestId = ++id, record = { phase, label, requestId, op, epoch: payload.epoch, actor: payload.actor, targetId: payload.targetId, action: payload.action }
    trace.push(record)
    if (child.exitCode !== null || child.signalCode) { reject(new Error(`${label} already exited`)); return }
    const timer = setTimeout(() => { pending.delete(requestId); record.timeout = true; reject(new Error(`${label} ${op} timeout`)) }, 12000)
    pending.set(requestId, { resolve: value => { record.ok = value.ok; record.error = value.error; resolve(value) }, reject, timer })
    child.stdin.write(JSON.stringify({ requestId, op, ...payload }) + '\n', error => { if (error) { clearTimeout(timer); pending.delete(requestId); reject(error) } })
  })
  const next = event => new Promise((resolve, reject) => {
    const index = events.findIndex(value => value.event === event); if (index >= 0) { resolve(events.splice(index, 1)[0]); return }
    const job = { event, resolve }; job.timer = setTimeout(() => { waiting.splice(waiting.indexOf(job), 1); reject(new Error(`${label} ${event} timeout`)) }, 8000); waiting.push(job)
  })
  const value = { child, label, exited, request, next, transcript, events, stderr: () => stderr, close: () => { lines.close(); for (const job of waiting) clearTimeout(job.timer) } }
  value.ok = async (op, payload) => { const reply = await request(op, payload); assert.equal(reply.ok, true, `${label} ${op}: ${JSON.stringify(reply.error)}`); return reply.result }
  controllers.push(value); return value
}
async function until(read, message, milliseconds = 2500) {
  const deadline = performance.now() + milliseconds
  while (performance.now() < deadline) { if (fatal && phase !== 'cleanup') throw fatal; const value = await read(); if (value) return value; await sleep(25) }
  throw new Error(message)
}
async function os(label, extra = {}, owners = [alpha?.identity, native?.identity ?? secondNative, beta?.identity].filter(Boolean)) {
  const value = await observer.ok('snapshot', { identities: owners, ...extra }); observations.push({ label, ...value }); return value
}
async function identify(pid, role) { return remember((await observer.ok('identity', { pid })).identity, role) }
async function guardians(owner) {
  const found = (await observer.ok('children', { identity: owner })).identities
  for (const row of found) remember(row, 'native-child')
  return found
}
async function snapshotFixture(fixture = alpha) { return fixture.ok('snapshot') }
async function fallbackIdentity(pid) {
  const result = await execute(leaseBinary, ['--one-shot', JSON.stringify({ op: 'identity', pid })], { timeout: 5000, maxBuffer: 1024 * 1024 })
  const reply = JSON.parse(result.stdout.trim()); assert.equal(reply.ok, true, 'Independent cleanup identity query must succeed'); return reply.result.identity
}
async function waitExit(value, ms = 5000) {
  let timer; try { return await Promise.race([value.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${value.label} did not naturally exit`)), ms) })]) } finally { clearTimeout(timer) }
}
async function retire(value) {
  if (!value) return
  if (value.child.exitCode === null && !value.child.signalCode) value.child.stdin.end()
  const exit = await waitExit(value); assert.equal(exit.code, 0, `${value.label} must exit normally`); assert.equal(exit.signal, null)
}
async function retireObserverAfterAudit(value) {
  if (!value) return
  // An external held key invalidates the run, but is not evidence that this
  // input-free observer cannot exit. Always send EOF independently of audit.
  try {
    const state = await value.ok('snapshot', { identities: [] })
    cleanup.finalInputAudit = { passed: empty(state), state }
    assert.ok(empty(state), 'Final actual OS input must be released')
  } catch (error) { cleanup.finalInputAudit ??= { passed: false }; cleanup.errors.push(error.message) }
  let natural = false
  cleanup.observerEofAttempted = true
  try {
    await retire(value); natural = true; cleanup.observerNaturalExit = true
    await until(async () => !same(await fallbackIdentity(value.child.pid), value.identity), 'Exact observer identity remained after natural EOF', 5000)
  } catch (error) {
    cleanup.errors.push(error.message)
    if (!natural && value.child.exitCode === null && !value.child.signalCode) {
      try { if (same(await fallbackIdentity(value.child.pid), value.identity)) { cleanup.forced.push(value.label); value.child.kill('SIGKILL'); await waitExit(value, 2000) } }
      catch (issue) { cleanup.errors.push(issue.message) }
    }
  }
}
const nativeArrow = state => state.windows.filter(window => window.pid === (native?.identity ?? secondNative)?.pid && window.title === 'QiuYaTools AI pointer' && window.onScreen === true)
async function arrowVisible(epoch) {
  return until(async () => {
    const status = await native.ok('status'), snapshot = await os('arrow-visible')
    if (!status.aiCursor?.visible) return false
    assert.equal(status.aiCursor.epoch, epoch); assert.equal(status.aiCursor.actor, 'ai'); assert.equal(snapshot.foregroundPid, alpha.identity.pid)
    const windows = nativeArrow(snapshot); assert.equal(windows.length, 1); assert.ok(windows[0].layer > 0 && windows[0].width <= 50 && windows[0].height <= 58)
    assert.ok(Math.hypot(status.aiCursor.x - snapshot.cursor.x, status.aiCursor.y - snapshot.cursor.y) < 2)
    return { status, snapshot, window: windows[0] }
  }, 'The actual AI overlay and independent window/cursor metadata did not agree')
}
async function arrowGone(label) {
  return until(async () => { const value = await os(label); return nativeArrow(value).length === 0 ? value : false }, 'AI overlay window remained after revocation/focus change')
}
async function act(epoch, point, kind = 'move') { return native.ok('act', { epoch, targetId: currentTarget.id, action: { kind, ...point } }) }
function raster(global, frame) { return { x: (global.x - frame.geometry.x) * frame.width / frame.geometry.width, y: (global.y - frame.geometry.y) * frame.height / frame.geometry.height } }
async function settledTargetAfterShow(fixture, expectedTarget, stage = 'after-show') {
  const windowId = Number(expectedTarget.id.match(/^mac-window:(\d+)$/u)?.[1])
  assert.ok(Number.isSafeInteger(windowId) && windowId > 0 && expectedTarget.pid === fixture.identity.pid)
  const start = performance.now(), deadline = start + 8000, evidence = { stage, targetId: expectedTarget.id, owner: fixture.identity, timeoutMs: 8000, minimumStableMs: 200, minimumSamples: 3, samples: [] }
  geometrySettles.push(evidence)
  let signature, stableAt, count = 0
  const reset = () => { signature = undefined; stableAt = undefined; count = 0 }
  const read = async operation => {
    const left = deadline - performance.now(); assert.ok(left > 0, 'Restored exact fixture geometry did not settle before the read-only deadline')
    let timer
    try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Restored exact fixture geometry read exceeded its deadline')), left) })]) }
    finally { clearTimeout(timer) }
  }
  const matches = (a, b, fields = ['x', 'y', 'width', 'height']) => !!a && !!b && fields.every(field => Number.isFinite(a[field]) && a[field] === b[field]) && a.width > 0 && a.height > 0
  while (performance.now() < deadline) {
    const identity = (await read(() => observer.ok('identity', { pid: fixture.identity.pid }))).identity
    assert.ok(same(identity, fixture.identity) && identity.uniqueId === fixture.identity.uniqueId, 'Restored fixture PID/birth/executable identity changed')
    const before = await read(() => os(`${stage}-geometry-before`, {}, [fixture.identity]))
    const ownWindow = before.windows.find(row => row.id === windowId && row.pid === fixture.identity.pid)
    const sample = { atMs: performance.now() - start, window: ownWindow ?? null }; evidence.samples.push(sample)
    if (!ownWindow || ownWindow.onScreen !== true || ownWindow.alpha !== 1 || before.foregroundPid !== fixture.identity.pid) { reset(); await sleep(25); continue }
    const target = (await read(() => native.ok('targets'))).targets.find(row => row.id === expectedTarget.id)
    if (target) assert.ok(target.pid === expectedTarget.pid && target.appId === expectedTarget.appId, 'Restored native target identity changed')
    sample.targetGeometry = target ? { x: target.x, y: target.y, width: target.width, height: target.height, scale: target.scale } : null
    if (!matches(ownWindow, target) || !Number.isFinite(target.scale) || target.scale <= 0) { reset(); await sleep(25); continue }
    const reply = await read(() => native.request('observe', { targetId: expectedTarget.id }))
    if (!reply.ok) {
      sample.observationError = reply.error?.code
      assert.ok(['CAPTURE_CHANGED', 'GEOMETRY_CHANGED', 'TARGET_GONE', 'TARGETS_UNAVAILABLE', 'INVALID_TARGET'].includes(reply.error?.code), `Restored fixture read failed: ${JSON.stringify(reply.error)}`)
      reset(); await sleep(25); continue
    }
    const frame = reply.result, after = await read(() => os(`${stage}-geometry-after`, {}, [fixture.identity])), afterWindow = after.windows.find(row => row.id === windowId && row.pid === fixture.identity.pid)
    const state = await read(() => snapshotFixture(fixture)), confirmed = (await read(() => observer.ok('identity', { pid: fixture.identity.pid }))).identity
    assert.ok(same(confirmed, fixture.identity) && confirmed.uniqueId === fixture.identity.uniqueId, 'Fixture identity changed during the fresh observation')
    assert.ok(state.pid === expectedTarget.pid && state.windowId === windowId && state.bundleId === expectedTarget.appId, 'Fixture snapshot changed its exact window identity')
    sample.frame = { targetId: frame.targetId, frameId: frame.frameId, width: frame.width, height: frame.height, geometry: frame.geometry }; sample.afterWindow = afterWindow ?? null; sample.fixturePoint = state.point
    if (frame.targetId !== expectedTarget.id || !matches(ownWindow, frame.geometry) || !matches(target, frame.geometry, ['x', 'y', 'width', 'height', 'scale']) || !matches(ownWindow, afterWindow) || afterWindow?.onScreen !== true || afterWindow?.alpha !== 1 || after.foregroundPid !== fixture.identity.pid || state.visible !== true) { reset(); await sleep(25); continue }
    assert.ok(Number.isSafeInteger(frame.width) && frame.width > 0 && Number.isSafeInteger(frame.height) && frame.height > 0 && Number.isFinite(state.point?.x) && Number.isFinite(state.point?.y))
    const next = JSON.stringify([...['x', 'y', 'width', 'height', 'scale'].map(field => frame.geometry[field]), frame.width, frame.height, state.point.x, state.point.y])
    if (signature !== next) { signature = next; stableAt = performance.now(); count = 1 } else count++
    sample.agreeingSamples = count; sample.stableMs = performance.now() - stableAt
    if (count >= evidence.minimumSamples && sample.stableMs >= evidence.minimumStableMs) {
      const point = raster(state.point, frame)
      assert.ok(point.x >= 0 && point.y >= 0 && point.x < frame.width && point.y < frame.height, 'Fresh fixture point must lie inside the exact settled raster')
      evidence.passed = true; evidence.elapsedMs = performance.now() - start; evidence.stableMs = sample.stableMs; evidence.agreeingSamples = count; evidence.point = point
      return { frame, target, point }
    }
    await sleep(25)
  }
  throw new Error('Restored exact fixture CG/native observation geometry did not become continuously stable; no post-show action was sent')
}
async function capture(label, owner, windowId, composited, probe, includeRealCursor = false) {
  const path = join(output, `${label}.png`), value = await observer.ok('capture', { identity: owner, windowId, output: path, composited, probe, includeRealCursor })
  captures.push({ label, ...value, sha256: hash(await readFile(path)), file: path }); return value
}
async function auditFirstCapture(label, epoch, eventStart) {
  const record = { label, independentOS: null, native: null, events: [] }
  captureInputAudits.push(record)
  const independentOS = await os(label); record.independentOS = independentOS
  const status = await native.ok('status')
  const events = native.transcript.slice(eventStart).filter(value => ['humanInput', 'inputCleanupFailed'].includes(value.event)).map(value => ({ event: value.event, ...(value.epoch === undefined ? {} : { epoch: value.epoch }), ...(['escape', 'preview-pointer'].includes(value.reason) ? { reason: value.reason } : {}) }))
  record.native = { leaseEpoch: status.leaseEpoch, leaseActor: status.leaseActor, inputState: status.inputState, aiCursor: status.aiCursor }; record.events = events
  assert.ok(empty(independentOS), 'External held input was observed around the first cursor capture; this run is invalid and input will not be retried')
  assert.equal(events.length, 0, 'Native humanInput/cleanup failure invalidated the first capture; no input retry is permitted')
  assert.equal(status.leaseEpoch, epoch, 'First capture must retain the exact physical input lease')
  assert.equal(status.leaseActor, 'ai'); assert.equal(status.aiCursor?.visible, true)
  assert.equal(independentOS.foregroundPid, alpha.identity.pid)
  return record
}
async function firstAuditedCapture(label, owner, windowId, probe, epoch, eventStart, includeRealCursor = false) {
  await auditFirstCapture(`${label}-before`, epoch, eventStart)
  try { return await capture(label, owner, windowId, true, probe, includeRealCursor) }
  finally { await auditFirstCapture(`${label}-after`, epoch, eventStart) }
}
function assertSmallArrow(value, label) {
  const a = value.analysis.approvedSmallArrow
  assert.ok(a && a.backgroundSpread <= 8 && a.backgroundRGB.every(channel => channel >= 0 && channel <= 25), `${label}: the independent flat near-black fixture background was not verified: ${JSON.stringify(a)}`)
  assert.ok(a && a.outlineArea >= 4 && a.outlineArea <= 90, `${label}: small white outline missing or oversized: ${JSON.stringify(a)}`)
  assert.ok(a.softGreyHaloArea >= 4, `${label}: soft grey halo missing: ${JSON.stringify(a)}`)
  assert.equal(a.brightAreaOutsideGlyph, 0, `${label}: a bright long tail or oversized contour extends outside the approved 18×20 glyph`)
  assert.equal(a.bodySamples.length, 3)
  for (const sample of a.bodySamples) {
    assert.ok(sample.pixels > 0 && sample.rgb.length === 3 && Math.min(...sample.rgb) >= 35 && Math.max(...sample.rgb) <= 140 && Math.max(...sample.rgb) - Math.min(...sample.rgb) < 30,
      `${label}: interior must be translucent neutral grey over the black fixture: ${JSON.stringify(sample)}`)
  }
}
function glyphProbe(tipX, tipY) { return { x: tipX - 18, y: tipY - 18, width: 48, height: 50, tipX, tipY } }
async function hostRpc(op) {
  const result = await routes.get('/api/qiuya-tools.computer.control').fetch(new Request(`http://127.0.0.1:${server.address().port}/api/qiuya-tools.computer.control`, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'qiuya-tools.computer.control', payload: { op, sessionId: 'native-ai-pointer' } }) }))
  const reply = (await result.json()).result; assert.equal(reply.ok, true, `Real Host ${op}: ${JSON.stringify(reply.error)}`); return reply.value
}
function domProbe() {
  let frameId, scheduled = false
  document.addEventListener('qiuya-preview-frame', event => {
    frameId = event.detail.frameId
    if (scheduled) return; scheduled = true
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scheduled = false
      const canvas = document.getElementById('screen'), cursor = document.getElementById('cursor'), r = canvas.getBoundingClientRect(), c = cursor.getBoundingClientRect()
      const value = { frameId, innerWidth, innerHeight, canvas: { x: r.x, y: r.y, width: r.width, height: r.height, pixelWidth: canvas.width, pixelHeight: canvas.height }, cursor: { x: c.x, y: c.y, width: c.width, height: c.height, visible: getComputedStyle(cursor).display !== 'none' } }
      fetch('/__cursor-dom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }).catch(() => {})
    }))
  })
}

try {
  helperSha256 = hash(await readFile(helper)); if (arg('--expect-sha256')) assert.equal(helperSha256, arg('--expect-sha256'), 'Explicit helper SHA must match before GUI/input')
  const compile = ['-swift-version', '5', '-framework', 'AppKit', '-module-cache-path', '/private/tmp/qiuya-ai-pointer-test-cache']
  await execute('/usr/bin/swiftc', [...compile, '-parse-as-library', '-framework', 'ScreenCaptureKit', '-framework', 'CoreImage', '-framework', 'CoreMedia', observerSource, '-o', observerBinary], { timeout: 90000 })
  await execute('/usr/bin/swiftc', [...compile, leaseSource, '-o', leaseBinary], { timeout: 60000 })
  for (const role of ['Primary', 'Secondary']) {
    const contents = join(temporary, `${role} AI Cursor Fixture.app`, 'Contents'), path = join(contents, 'MacOS/fixture')
    await mkdir(join(contents, 'MacOS'), { recursive: true }); fixturePaths.push(path)
    await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.qiuya.tools.ai-cursor.${randomUUID().replaceAll('-', '')}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
    if (role === 'Primary') await execute('/usr/bin/swiftc', [...compile, fixtureSource, '-o', path], { timeout: 60000 }); else await copyFile(fixturePaths[0], path)
  }
  observer = endpoint(observerBinary, [], 'independent-cursor-observer'); observer.identity = remember((await observer.next('ready')).identity, 'observer')
  runnerIdentity = await identify(process.pid, 'runner')
  const baseline = await os('before-any-fixture-or-input', {}, [])
  assert.ok(baseline.sessionExists && !baseline.screenLocked && baseline.screenRecording && empty(baseline), 'An unlocked recording-enabled desktop with no held input is required; no permissions are requested')
  alpha = endpoint(fixturePaths[0], [], 'primary-fixture'); const ready = (await alpha.next('ready')).state; alpha.identity = await identify(alpha.child.pid, 'fixture')
  assert.equal(ready.pid, alpha.identity.pid); await until(async () => (await os('fixture-front', {}, [alpha.identity])).foregroundPid === alpha.identity.pid, 'Primary fixture did not become foreground; activation/input is not retried')
  native = endpoint(helper, [], 'native-pointer'); native.identity = await identify(native.child.pid, 'native')
  const status = await native.ok('status'); assert.ok(status.permissions.screenRecording && status.permissions.accessibility && status.permissions.postEvents, 'The existing inherited permissions are required')
  const invalidActor = await native.request('lease', { epoch: 0, actor: 'Human' })
  assert.equal(invalidActor.ok, false); assert.equal(invalidActor.error.code, 'INVALID_ACTOR'); assert.equal((await native.ok('status')).leaseEpoch, null)
  pass('MAC-LEASE-ACTOR-WIRE-REJECTS-UNKNOWN-SOURCE')
  currentTarget = (await native.ok('targets')).targets.find(row => row.pid === alpha.identity.pid && row.appId === ready.bundleId && row.id === `mac-window:${ready.windowId}`)
  assert.ok(currentTarget, 'Input is restricted to the exact disposable fixture process/bundle/window')
  const initial = await settledTargetAfterShow(alpha, currentTarget, 'initial-setup')
  currentTarget = initial.target
  let frame = initial.frame, point = initial.point
  const firstDesktopPoint = { x: frame.geometry.x + point.x * frame.geometry.width / frame.width, y: frame.geometry.y + point.y * frame.geometry.height / frame.height }
  let otherPoint = { x: point.x + 70 * frame.width / frame.geometry.width, y: point.y + 25 * frame.height / frame.geometry.height }
  assert.ok(otherPoint.x < frame.width && otherPoint.y < frame.height)
  environment = { helper, helperSha256, architecture: process.arch, temporary, target: currentTarget, fixtureReady: ready, firstAction: { frameId: frame.frameId, width: frame.width, height: frame.height, geometry: frame.geometry, point, desktopPoint: firstDesktopPoint }, sources: Object.fromEntries(await Promise.all([fixtureSource, observerSource, leaseSource, fileURLToPath(import.meta.url)].map(async path => [path, hash(await readFile(path))]))) }
  await writeFile(join(output, 'environment.json'), JSON.stringify(environment, null, 2))
  phase = 'native-ai-overlay'
  const firstCaptureEventStart = native.transcript.length
  await native.ok('lease', { epoch: 1, actor: 'ai' }); activeEpoch = 1; await guardians(native.identity)
  await act(1, point); const visible = await arrowVisible(1)
  frame = await native.ok('observe', { targetId: currentTarget.id, preview: true }); assert.equal(frame.aiCursor.visible, true)
  assert.ok(Math.hypot(frame.aiCursor.x - point.x, frame.aiCursor.y - point.y) < 3)
  assert.ok(Math.hypot(frame.cursor.x - frame.aiCursor.x, frame.cursor.y - frame.aiCursor.y) < 3, 'Real cursor and AI metadata agree without replacing each other')
  await writeFile(join(output, 'selected-window-frame.jpg'), Buffer.from(frame.imageBase64, 'base64'))
  const pointerProbe = glyphProbe(firstDesktopPoint.x - frame.geometry.x, firstDesktopPoint.y - frame.geometry.y)
  const pixels = await firstAuditedCapture('actual-ai-overlay-without-real-cursor', alpha.identity, ready.windowId, pointerProbe, 1, firstCaptureEventStart)
  assertSmallArrow(pixels, 'Actual AI overlay excluding the separate real OS cursor')
  // Keep the real user-visible composition as a separate artifact. It is not
  // a claim that the OS cursor is replaced or that two superposed cursors match
  // the approved isolated glyph; that visual boundary requires review.
  const composition = await firstAuditedCapture('actual-ai-overlay-with-real-cursor', alpha.identity, ready.windowId, pointerProbe, 1, firstCaptureEventStart, true)
  const afterComposition = await os('paired-real-os-cursor-composition')
  assert.ok(Math.hypot(afterComposition.cursor.x - firstDesktopPoint.x, afterComposition.cursor.y - firstDesktopPoint.y) < 2, 'The paired composition must retain the same actual cursor position')
  assert.equal(composition.includesRealOSCursor, true)
  pass('MAC-AI-ACTUAL-CGWINDOW-PIXELS-NOACTIVATE', { window: visible.window, analysis: pixels.analysis, realCursorComposition: composition,
    visualBoundary: 'The isolated glyph is verified; the screenshot including the real OS cursor is retained for actual user-visible overlap review.' })
  const beforeClick = await snapshotFixture(); await act(1, point, 'click'); const clicked = await snapshotFixture(), afterClick = await os('click-through')
  assert.equal(clicked.counts.clicks - beforeClick.counts.clicks, 1); assert.equal(clicked.counts.downs - beforeClick.counts.downs, 1); assert.equal(clicked.counts.ups - beforeClick.counts.ups, 1)
  assert.equal(afterClick.foregroundPid, alpha.identity.pid); assert.ok(empty(afterClick)); await arrowVisible(1)
  pass('MAC-AI-OVERLAY-CLICKTHROUGH-ACTUAL-FIXTURE-EVENTS', { before: beforeClick.counts, after: clicked.counts })
  const beforeDrag = await snapshotFixture(), motion = [], dragDestination = { x: point.x + 110 * frame.width / frame.geometry.width, y: point.y }
  assert.ok(dragDestination.x < frame.width)
  let dragDone = false
  const dragging = native.request('act', { epoch: 1, targetId: currentTarget.id, action: { kind: 'drag', ...point, toX: dragDestination.x, toY: dragDestination.y } })
  void dragging.then(() => { dragDone = true }, () => { dragDone = true })
  for (let count = 0; count < 50 && !dragDone; count++) {
    const state = await native.ok('status'), actual = await os('during-drag')
    if (state.aiCursor.visible && actual.leftButtonDown) motion.push({ aiCursor: state.aiCursor, cursor: actual.cursor, windows: nativeArrow(actual) })
    await sleep(8)
  }
  const dragResult = await dragging; assert.equal(dragResult.ok, true, JSON.stringify(dragResult.error))
  const afterDrag = await snapshotFixture(), uniqueMotion = new Set(motion.map(value => `${Math.round(value.aiCursor.x)}:${Math.round(value.aiCursor.y)}`))
  assert.ok(uniqueMotion.size >= 2 && motion.some(value => value.aiCursor.phase === 'pressed'), 'Actual OS-held drag must expose multiple live AI positions, not just its endpoint')
  assert.equal(afterDrag.counts.downs - beforeDrag.counts.downs, 1); assert.equal(afterDrag.counts.ups - beforeDrag.counts.ups, 1); assert.ok(afterDrag.counts.drags - beforeDrag.counts.drags >= 2)
  assert.ok(empty(await os('drag-released'))); pass('MAC-AI-DRAG-LIVE-POSITIONS-AND-REAL-OS-HELD-RELEASE', { motion, before: beforeDrag.counts, after: afterDrag.counts })
  phase = 'human-and-old-epoch'
  await native.ok('release', { epoch: 1 }); activeEpoch = undefined; await arrowGone('pause-hides-panel')
  await native.ok('lease', { epoch: 2, actor: 'human' }); activeEpoch = 2; await act(2, otherPoint)
  assert.equal((await native.ok('status')).leaseActor, 'human'); assert.equal((await native.ok('status')).aiCursor.visible, false); await arrowGone('human-has-no-ai-panel')
  pass('MAC-HUMAN-LEASE-HIDES-AI')
  await native.ok('release', { epoch: 2 }); await native.ok('lease', { epoch: 3, actor: 'ai' }); activeEpoch = 3; await act(3, point); await arrowVisible(3)
  await native.ok('release', { epoch: 2 }); const beforeStale = await snapshotFixture(), stale = await native.request('act', { epoch: 2, targetId: currentTarget.id, action: { kind: 'click', ...point } })
  assert.equal(stale.ok, false); assert.equal(stale.error.code, 'STALE_EPOCH'); assert.deepEqual((await snapshotFixture()).counts, beforeStale.counts); await arrowVisible(3)
  pass('MAC-OLD-EPOCH-CANNOT-INJECT-OR-HIDE-NEW-AI')
  phase = 'focus-and-visibility'
  beta = endpoint(fixturePaths[1], ['--secondary'], 'secondary-fixture'); await beta.next('ready'); beta.identity = await identify(beta.child.pid, 'fixture')
  await beta.ok('activate'); await until(async () => (await os('secondary-foreground')).foregroundPid === beta.identity.pid, 'Secondary fixture activation failed; no activation/input retry')
  await arrowGone('target-lost-focus'); pass('MAC-FOCUS-LOSS-HIDES-AI')
  await native.ok('release', { epoch: 3 }); await alpha.ok('activate'); await until(async () => (await os('restore-primary')).foregroundPid === alpha.identity.pid, 'Primary fixture activation failed')
  await native.ok('lease', { epoch: 4, actor: 'ai' }); activeEpoch = 4; await native.ok('observe', { targetId: currentTarget.id }); await act(4, point); await arrowVisible(4)
  await alpha.ok('hide'); await arrowGone('target-left-screen'); pass('MAC-TARGET-OFFSCREEN-HIDES-AI')
  await native.ok('release', { epoch: 4 }); activeEpoch = undefined; await alpha.ok('show'); await alpha.ok('activate'); await until(async () => (await os('show-primary')).foregroundPid === alpha.identity.pid, 'Restored fixture did not become foreground')
  const settled = await settledTargetAfterShow(alpha, currentTarget)
  frame = settled.frame; currentTarget = settled.target; point = settled.point
  otherPoint = { x: point.x + 70 * frame.width / frame.geometry.width, y: point.y + 25 * frame.height / frame.geometry.height }
  assert.ok(otherPoint.x < frame.width && otherPoint.y < frame.height)
  await native.ok('lease', { epoch: 5, actor: 'ai' }); activeEpoch = 5; await act(5, point); await arrowVisible(5); await guardians(native.identity)
  await retire(native); activeEpoch = undefined; const firstNative = native.identity; native = undefined
  await until(async () => !(await fallbackIdentity(firstNative.pid)), 'Native EOF did not retire the helper')
  const disconnected = await os('native-eof', {}, [alpha.identity, beta.identity]); assert.ok(empty(disconnected)); pass('MAC-DISCONNECT-RETIRES-OVERLAY-AND-OWNED-INPUT')

  phase = 'real-host-and-wk-preview'
  const runtime = join(temporary, 'host-runtime.mjs')
  await build({ stdin: { contents: "export {installComputerHost} from './src/features/computer-use/host.ts';export {NativeCompanionDriver} from './src/features/computer-use/native.ts'", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: runtime })
  environment.hostRuntimeSha256 = hash(await readFile(runtime))
  environment.hostSources = Object.fromEntries(await Promise.all(['host.ts', 'session.ts', 'native.ts', 'preview-page.ts', 'contract.ts'].map(async name => [name, hash(await readFile(join(root, 'src/features/computer-use', name)))])))
  await writeFile(join(output, 'environment.json'), JSON.stringify(environment, null, 2))
  for (const value of (await observer.ok('allChildren', { identity: runnerIdentity })).identities) if (!identities.has(key(value))) remember(value, 'build-service')
  await stopEsbuild()
  const { installComputerHost, NativeCompanionDriver } = await import(pathToFileURL(runtime).href)
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname, chunks = []; let bytes = 0
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 256000) throw new Error('Bounded test request exceeded'); chunks.push(chunk) }
      if (pathname === '/__cursor-dom') { pageReceipt = JSON.parse(Buffer.concat(chunks)); pageEvents.push(pageReceipt); if (pageEvents.length > 300) pageEvents.shift(); response.writeHead(200).end('ok'); return }
      const route = routes.get(pathname); if (!route) { response.writeHead(404).end(); return }
      const input = request.method === 'POST' ? JSON.parse(Buffer.concat(chunks)) : undefined
      if (input?.payload?.op === 'pause') pagehidePauses++
      const result = await route.fetch(new Request(`http://127.0.0.1:${server.address().port}${request.url}`, { method: request.method, ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }))
      let body = Buffer.from(await result.arrayBuffer())
      if (input?.payload?.op === 'frame') { const f = JSON.parse(body).result?.value; if (f?.frameId) { frameReceipts.set(f.frameId, { frameId: f.frameId, width: f.width, height: f.height, aiCursor: f.aiCursor }); if (frameReceipts.size > 200) frameReceipts.delete(frameReceipts.keys().next().value) } }
      if (pathname === '/api/qiuya-tools.computer.preview' && result.ok) body = Buffer.from(body.toString().replace('</html>', `<script>(${domProbe.toString()})();</script></html>`))
      const headers = Object.fromEntries(result.headers); delete headers['content-length']; response.writeHead(result.status, headers).end(body)
    } catch (error) { if (phase !== 'cleanup') fatal ??= error; if (!response.headersSent) response.writeHead(500); response.end('test carrier failed') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  driver = new NativeCompanionDriver({ executable: helper }); driver.subscribe(value => nativeEvents.push(value))
  host = await installComputerHost({ get: name => name === 'sessions' ? { get: () => ({}) } : undefined, webServer: { port: server.address().port }, connection: { browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: value => value, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }, () => true, { driver })
  await host.service.start('native-ai-pointer', currentTarget.id, { allowOnce: true })
  const found = (await observer.ok('findHelper', { identity: runnerIdentity, helperPath: helper })).identities
  assert.equal(found.length, 1); secondNative = remember(found[0], 'native'); await guardians(secondNative)
  // Test-only passive observation of the real Node ChildProcess. No spawn or
  // driver behavior is replaced; this detects a forced SDK retirement too.
  hostChild = Reflect.get(driver, 'child'); assert.equal(hostChild?.pid, secondNative.pid, 'SDK child must match independent native identity')
  hostChildExit = hostChild.exitCode !== null || hostChild.signalCode ? Promise.resolve({ code: hostChild.exitCode, signal: hostChild.signalCode }) : new Promise(done => hostChild.once('exit', (code, signal) => done({ code, signal })))
  await hostRpc('preview')
  await until(() => pageReceipt?.canvas.pixelWidth > 1, 'Real native WK preview did not paint the production canvas', 20000)
  const observed = await host.service.observe('native-ai-pointer')
  await host.service.act('native-ai-pointer', { actionId: randomUUID(), frameId: observed.frameId, action: { kind: 'move', ...point } })
  const receipt = await until(() => { const f = frameReceipts.get(pageReceipt?.frameId); return f?.aiCursor?.visible && pageReceipt.cursor.visible ? { dom: pageReceipt, frame: f } : false }, 'Real WK SVG arrow did not reflect the independently returned native aiCursor', 12000)
  const expectedX = receipt.dom.canvas.x + receipt.frame.aiCursor.x * receipt.dom.canvas.width / receipt.frame.width, expectedY = receipt.dom.canvas.y + receipt.frame.aiCursor.y * receipt.dom.canvas.height / receipt.frame.height
  assert.ok(Math.abs(receipt.dom.cursor.x + 2 - expectedX) < 2 && Math.abs(receipt.dom.cursor.y + 3 - expectedY) < 2, 'Production SVG hotspot (2,3) must follow the actual native raster point')
  const wkWindow = (await os('real-native-preview')).windows.find(row => row.pid === secondNative.pid && row.title === 'QiuYaTools · 电脑操控')
  assert.ok(wkWindow && wkWindow.layer > 0)
  assert.equal(receipt.dom.cursor.width, 18); assert.equal(receipt.dom.cursor.height, 20)
  const wkPixels = await capture('actual-wk-ai-arrow', secondNative, wkWindow.id, false,
    glyphProbe(receipt.dom.cursor.x + 2, receipt.dom.cursor.y + 3 + wkWindow.height - receipt.dom.innerHeight))
  assertSmallArrow(wkPixels, 'Actual WK SVG arrow')
  pass('MAC-REAL-WK-PREVIEW-AI-RASTER-AND-PIXELS', { receipt, analysis: wkPixels.analysis })
  const beforeRedock = host.service.get('native-ai-pointer'), pausesBefore = pagehidePauses, closesBefore = nativeEvents.filter(event => event.event === 'previewClosed').length
  await hostRpc('redock'); await sleep(600)
  const afterRedock = host.service.get('native-ai-pointer'); assert.equal(afterRedock.state, 'ready'); assert.equal(afterRedock.epoch, beforeRedock.epoch)
  assert.equal(pagehidePauses, pausesBefore); assert.equal(nativeEvents.filter(event => event.event === 'previewClosed').length, closesBefore)
  const continuation = await host.service.observe('native-ai-pointer'); await host.service.act('native-ai-pointer', { actionId: randomUUID(), frameId: continuation.frameId, action: { kind: 'move', ...otherPoint } })
  assert.equal((await driver.status()).leaseEpoch, beforeRedock.epoch); pass('MAC-PRESERVE-CLOSE-KEEPS-REAL-SESSION-AND-SUBSEQUENT-INPUT')
  pageReceipt = undefined; await hostRpc('preview'); await until(() => pageReceipt?.canvas.pixelWidth > 1, 'Reopened preview did not load')
  await driver.closePreview(); await until(() => host.service.get('native-ai-pointer').state === 'paused', 'Ordinary native close did not pause its Host session')
  assert.ok(nativeEvents.some(event => event.event === 'previewClosed' && event.sessionId === 'native-ai-pointer'))
  assert.equal((await driver.status()).leaseEpoch, null); pass('MAC-ORDINARY-CLOSE-PAUSES-EXACT-SESSION')
  await host.service.stop('native-ai-pointer'); const stopped = await os('host-stopped'); assert.ok(empty(stopped)); assert.equal(nativeArrow(stopped).length, 0)
  pass('MAC-HOST-STOP-HIDES-OVERLAY-AND-RELEASES-INPUT')
  report = { status: 'passed', checks, helperSha256, environment, nativeEvents, pagehidePauses, frameReceipts: [...frameReceipts.values()], pageEvents, captures,
    scope: 'Actual AppKit/CG/SCK native AI overlay and production Host explicit options.driver legacy service/native WK preview through a loopback test carrier',
    notRun: ['Default environment manager/ScheduledComputerDriver two-chat held-drag FIFO and A-redock-does-not-affect-B integration', 'Default scheduler per-action physical release hides its overlay; legacy idle visibility does not prove production idle visibility'],
    limitations: ['CGWindowID plus source-bound NSPanel class; no fabricated cross-process ObjC class reflection.', 'Input is actual CGEvent injection from the production helper, not physical human HID.', 'WK page gets read-only DOM geometry instrumentation; this is not installed Harness owner authentication or default multi-environment manager acceptance.', 'No resource/30-minute leak claim. Shared responsibility WebKit XPC ownership remains a separate unresolved acceptance boundary.'] }
} catch (error) { report = { status: /unlocked|existing inherited permissions/u.test(error.message) ? 'blocked' : 'failed', phase, reason: error.message, stack: error.stack, checks, helperSha256, environment, captures, nativeEvents, pagehidePauses, pageEvents }; process.exitCode = 1 }
finally {
  phase = 'cleanup'
  try { await writeFile(join(output, 'run-report.json'), JSON.stringify(report, null, 2)) } catch (error) { cleanup.errors.push(`Raw report: ${error.message}`) }
  try { if (native?.child.exitCode === null && !native.child.signalCode) { if (activeEpoch !== undefined) await native.ok('release', { epoch: activeEpoch }); await guardians(native.identity) } } catch (error) { cleanup.errors.push(error.message) }
  try {
    if (secondNative) await guardians(secondNative)
    await host?.dispose(); if (!host) await driver?.dispose()
  } catch (error) { cleanup.errors.push(error.message) }
  if (hostChildExit) {
    try { const exit = await waitExit({ exited: hostChildExit, label: 'Host native helper' }, 6000); cleanup.hostNativeExit = exit; assert.equal(exit.code, 0, 'Host native helper must exit naturally'); assert.equal(exit.signal, null, 'Forced SDK retirement cannot pass natural cleanup') }
    catch (error) { cleanup.errors.push(error.message) }
  }
  try { await stopEsbuild() } catch (error) { cleanup.errors.push(error.message) }
  for (const value of [native, beta, alpha]) {
    if (!value) continue
    try { await retire(value) } catch (error) {
      cleanup.errors.push(error.message)
      try { if (value.child.exitCode === null && !value.child.signalCode && same(await fallbackIdentity(value.child.pid), value.identity)) { cleanup.forced.push(value.label); value.child.kill('SIGKILL'); await waitExit(value, 2000) } } catch (issue) { cleanup.errors.push(issue.message) }
    }
  }
  if (server) { server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done)) }
  const selected = [...identities.values()].filter(value => !['runner', 'observer'].includes(value.role))
  for (const value of selected) {
    try { await until(async () => !same(await fallbackIdentity(value.pid), value), `Exact ${value.role} process remained: ${value.pid}`, 5000); cleanup.processes.push({ identity: value, state: 'naturally-exited' }) }
    catch (error) { cleanup.errors.push(error.message); cleanup.processes.push({ identity: value, state: 'unverified-or-alive' }) }
  }
  await retireObserverAfterAudit(observer)
  for (const value of controllers) value.close()
  cleanup.passed = cleanup.errors.length === 0 && cleanup.forced.length === 0
  cleanup.scope = 'Exact native/guardian/fixture/observer identities gone after EOF; compiler via normal esbuild.stop; no shared Codex/WebKit process was signalled or claimed uniquely owned'
  let helperUnchanged = false
  try { helperUnchanged = hash(await readFile(helper)) === helperSha256 } catch (error) { cleanup.errors.push(`Helper binding: ${error.message}`); cleanup.passed = false }
  const finalPassed = report?.status === 'passed' && cleanup.passed && helperUnchanged
  if (!cleanup.passed) cleanup.retainedTemporary = temporary
  await writeFile(join(output, 'transcripts.json'), JSON.stringify(controllers.map(value => ({ label: value.label, pid: value.child.pid, transcript: value.transcript, stderr: value.stderr() })), null, 2))
  await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2)); await writeFile(join(output, 'trace.json'), JSON.stringify(trace, null, 2))
  await writeFile(join(output, 'geometry-settles.json'), JSON.stringify(geometrySettles, null, 2))
  await writeFile(join(output, 'capture-input-audits.json'), JSON.stringify(captureInputAudits, null, 2))
  await writeFile(join(output, 'report.json'), JSON.stringify({ ...report, status: finalPassed ? 'passed' : report?.status === 'blocked' ? 'blocked' : 'failed', cleanup, testedAt: new Date().toISOString() }, null, 2))
  await writeFile(join(output, 'delivery-verdict.json'), JSON.stringify({ passed: finalPassed, runnerPassed: report?.status === 'passed', naturalCleanupPassed: cleanup.passed, helperUnchanged }, null, 2))
  if (cleanup.passed) await rm(temporary, { recursive: true, force: true })
  console.log(JSON.stringify({ output, passed: finalPassed, checks: checks.length, cleanup }, null, 2)); if (!finalPassed) process.exitCode = 1
}
