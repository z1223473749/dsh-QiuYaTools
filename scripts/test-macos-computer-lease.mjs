import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdir, readFile, writeFile, mkdtemp, rm, realpath, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'

if (process.platform !== 'darwin') throw new Error('This runner requires the macOS companion')
const actionCrash = process.argv.includes('--action-crash')
const outArg = process.argv.indexOf('--out')
if (outArg >= 0 && !process.argv[outArg + 1]) throw new Error('--out requires a fresh evidence directory')
const output = resolve(outArg < 0 ? 'artifacts/computer-use/macos-lease' : process.argv[outArg + 1])
await mkdir(output, { recursive: true })
for (const name of ['report.json', 'run-report.json', 'delivery-verdict.json']) {
  await stat(join(output, name)).then(() => { throw new Error(`Use a fresh --out directory; ${name} already exists`) }, error => { if (error.code !== 'ENOENT') throw error })
}
const execute = promisify(execFile)
const executable = await realpath(fileURLToPath(new URL('../lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer', import.meta.url)))
const fixtureSource = fileURLToPath(new URL('../src/native/macos/fixtures/ComputerFixture.swift', import.meta.url))
const oracleSource = fileURLToPath(new URL('../src/native/macos/fixtures/LeaseOracle.swift', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-desktop-lease-'))
const oracleBinary = join(temporary, 'lease-oracle')
const fixtureContents = join(temporary, 'Lease Fixture.app', 'Contents')
const fixtureBinary = join(fixtureContents, 'MacOS', 'fixture')
const fixtureBundleId = `com.qiuya.tools.lease-fixture.${randomUUID().replaceAll('-', '')}`
const journalPath = join(homedir(), 'Library/Application Support/QiuYaTools/computer-lease/owned-input.json')
const checks = [], controllers = [], helpers = [], observations = [], requests = [], tracked = new Map()
const cleanup = { passed: false, errors: [], forced: [], naturalRemaining: [], finalRemaining: [] }
let oracle, fixture, functional, dragEvidence, preflight, environment, leaseAcquired = false
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const birth = identity => BigInt(identity.startSeconds) * 1_000_000n + BigInt(identity.startMicroseconds)
const keyOf = identity => `${identity.pid}:${identity.startSeconds}:${identity.startMicroseconds}`
const sameIdentity = (a, b) => a && b && keyOf(a) === keyOf(b) && a.executablePath === b.executablePath
const emptyOs = state => state && state.leftButtonDown === false && state.rightButtonDown === false && state.middleButtonDown === false && Array.isArray(state.keysDown) && state.keysDown.length === 0
const check = id => checks.push({ id, status: 'passed' })
const allowedExecutables = () => [executable, oracleBinary, ...(actionCrash ? [fixtureBinary] : [])].flatMap(path => ['--allowed-executable', path])
async function oneShot(op, args = {}) {
  const result = await execute(oracleBinary, [...allowedExecutables(), '--one-shot', JSON.stringify({ op, ...args })], { timeout: 5000, maxBuffer: 1024 * 1024 })
  const reply = JSON.parse(result.stdout.trim())
  assert.equal(reply.ok, true, `Emergency observer ${op}: ${reply.error}`)
  ;(cleanup.oneShotObservers ??= []).push(reply.observerIdentity)
  return reply.result
}

function endpoint(binary, args, label) {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, QIUYA_TOOLS_PARENT_PID: String(process.pid) } })
  const pending = new Map(), events = [], waiters = [], transcript = []
  let sequence = 0, stderr = ''
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4000) })
  const exited = new Promise(done => {
    child.once('exit', (code, signal) => done({ code, signal }))
    child.once('error', error => done({ error: error.message }))
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let value
    try { value = JSON.parse(line) } catch { return }
    transcript.push(value.result?.imageBase64 ? { ...value, result: { ...value.result, imageBase64: `[${value.result.imageBase64.length} base64 characters omitted]` } } : value)
    const item = pending.get(value.requestId)
    if (item) { pending.delete(value.requestId); clearTimeout(item.timer); item.summary.ok = value.ok; item.summary.error = value.error; item.resolve(value); return }
    const index = waiters.findIndex(waiter => waiter.event === value.event)
    if (index >= 0) { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(value) }
    else events.push(value)
  })
  exited.then(result => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`${label} exited: ${JSON.stringify(result)} ${stderr}`)) }
    pending.clear()
    for (const item of waiters.splice(0)) { clearTimeout(item.timer); item.reject(new Error(`${label} exited before ${item.event}`)) }
  })
  const send = line => new Promise((done, reject) => child.stdin.write(line + '\n', error => error ? reject(error) : done()))
  child.stdin.on('error', () => {}) // Individual send callbacks/exit receipts preserve failures.
  const request = (op, args = {}) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode) { reject(new Error(`${label} is no longer running`)); return }
    const requestId = ++sequence, summary = { label, pid: child.pid, requestId, op, epoch: args.epoch, targetId: args.targetId }
    requests.push(summary)
    const timer = setTimeout(() => { pending.delete(requestId); summary.timeout = true; reject(new Error(`${label} ${op} timed out`)) }, 8000)
    pending.set(requestId, { resolve, reject, timer, summary })
    send(JSON.stringify({ requestId, op, ...args })).catch(error => { const item = pending.get(requestId); if (item) { pending.delete(requestId); clearTimeout(timer); reject(error) } })
  })
  const ok = async (op, args) => { const reply = await request(op, args); assert.equal(reply.ok, true, `${label} ${op}: ${JSON.stringify(reply.error)}`); return reply.result }
  const next = event => new Promise((resolve, reject) => {
    const index = events.findIndex(value => value.event === event)
    if (index >= 0) { resolve(events.splice(index, 1)[0]); return }
    const waiter = { event, resolve, reject }
    waiter.timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error(`${label} ${event} timed out`)) }, 5000)
    waiters.push(waiter)
  })
  const value = { child, exited, request, ok, next, send, label, transcript, identity: null, intentionalCrash: false, stderr: () => stderr, closeLines: () => lines.close() }
  controllers.push(value)
  return value
}
async function waitExit(controller, milliseconds) {
  let timer
  try { return await Promise.race([controller.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${controller.label} did not exit within ${milliseconds}ms`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function observe(label, args = {}) {
  const result = await oracle.ok('snapshot', args)
  observations.push({ label, ...result }); return result
}
async function processIdentity(pid) { return (await oracle.ok('identity', { pid })).identity }
function remember(identity, role, extra = {}) {
  assert.ok(identity?.pid && identity.startSeconds && identity.startMicroseconds && identity.executablePath, 'Exact owned process identity is required')
  tracked.set(keyOf(identity), { ...identity, role, ...extra }); return identity
}
async function helper(label) {
  const value = endpoint(executable, [], label)
  value.identity = remember(await processIdentity(value.child.pid), 'companion')
  assert.equal(value.identity.executablePath, executable)
  helpers.push(value); return value
}
async function discoverGuardians() {
  const text = (await execute('/bin/ps', ['-axo', 'pid=,ppid='])).stdout
  const parentByPid = new Map(), found = []
  for (const value of helpers) if (sameIdentity(await processIdentity(value.child.pid), value.identity)) parentByPid.set(value.child.pid, value)
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line), parent = match && parentByPid.get(Number(match[2]))
    if (!parent) continue
    const identity = await processIdentity(Number(match[1]))
    if (!identity || identity.parentPid !== parent.identity.pid || identity.executablePath !== executable || birth(identity) < birth(parent.identity)) continue
    const command = (await execute('/bin/ps', ['-p', String(identity.pid), '-o', 'command='])).stdout.trim()
    assert.match(command, /(?:^|\s)--input-guardian(?:\s|$)/u, 'Only the companion guardian may be attributed as a native child')
    remember(identity, 'guardian', { parentIdentity: parent.identity }); found.push(identity)
  }
  return found
}
async function eventually(fn, message, milliseconds = 5000) {
  const deadline = performance.now() + milliseconds
  while (performance.now() < deadline) { const value = await fn(); if (value) return value; await delay(10) }
  throw new Error(message)
}
async function journal() {
  try {
    assert.ok((await stat(journalPath)).size <= 16_384, 'Native owned-input journal is unexpectedly large')
    return JSON.parse(await readFile(journalPath, 'utf8'))
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function snapshotFixture() { const pending = fixture.next('snapshot'); await fixture.send('snapshot'); return pending }
async function crashPinned(controller, args = {}) {
  const receipt = await oracle.ok('killOwned', { identity: controller.identity, ...args })
  controller.intentionalCrash = true
  assert.equal(receipt.signalled, true)
  const exit = await waitExit(controller, 5000); assert.equal(exit.signal, 'SIGKILL')
  return { ...receipt, exit }
}

try {
  const compileArguments = ['-swift-version', '5', '-framework', 'AppKit', '-module-cache-path', '/tmp/qiuya-computer-swift-cache']
  await execute('/usr/bin/swiftc', [...compileArguments, oracleSource, '-o', oracleBinary])
  if (actionCrash) {
    await mkdir(join(fixtureContents, 'MacOS'), { recursive: true })
    await writeFile(join(fixtureContents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${fixtureBundleId}</string><key>CFBundleName</key><string>QiuYaTools Lease Fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
    await execute('/usr/bin/swiftc', [...compileArguments, fixtureSource, '-o', fixtureBinary])
  }
  oracle = endpoint(oracleBinary, allowedExecutables(), 'independent-oracle')
  oracle.identity = remember((await oracle.next('ready')).identity, 'oracle')
  environment = { helper: executable, helperSha256: sha256(await readFile(executable)), oracleSourceSha256: sha256(await readFile(oracleSource)), oracleBinarySha256: sha256(await readFile(oracleBinary)), fixtureSourceSha256: sha256(await readFile(fixtureSource)), compileArguments, temporary, fixtureBundleId, architecture: process.arch }
  await writeFile(join(output, 'environment.json'), JSON.stringify(environment, null, 2) + '\n')
  preflight = await observe('before-any-lease')
  assert.equal(preflight.sessionExists, true, 'The existing graphical session must be available')
  if (preflight.screenLocked || preflight.foregroundBundleId === 'com.apple.loginwindow') { const error = new Error('The existing Mac session must be unlocked; no login settings were changed'); error.code = 'SESSION_LOCKED'; throw error }
  assert.ok(emptyOs(preflight), 'Actual OS buttons/keys are already held; no test lease or input was started')
  const existingJournal = await journal()
  assert.ok(!existingJournal || (existingJournal.keys?.length === 0 && existingJournal.mouseButtons?.length === 0), 'A pre-existing held-input journal requires separate recovery; this test will not replay its releases')

  const a = await helper('owner-a'), b = await helper('owner-b'), readonly = await helper('readonly')
  await readonly.ok('status')
  assert.ok(!(await discoverGuardians()).some(identity => identity.parentPid === readonly.identity.pid), 'Read-only status must not spawn a guardian')
  check('READONLY-NO-GUARDIAN')
  await a.ok('lease', { epoch: 1 })
  leaseAcquired = true
  const firstOwner = (await a.ok('status')).inputState.ownerId
  assert.match(firstOwner, /^[a-f0-9]{32}$/u)
  assert.equal((await b.request('lease', { epoch: 1 })).error?.code, 'DESKTOP_BUSY')
  check('TWO-HELPERS-ONE-DESKTOP-OWNER')
  await a.ok('release', { epoch: 1 }); await b.ok('lease', { epoch: 2 })
  await a.ok('release', { epoch: 1 })
  assert.equal((await b.ok('status')).leaseEpoch, 2)
  check('RELEASE-THEN-TRANSFER-AND-OLD-RELEASE-FENCED')
  assert.ok((await discoverGuardians()).some(identity => identity.parentPid === b.identity.pid), 'The empty-lease owner must have a pinned guardian before its controlled crash')
  await crashPinned(b)
  await eventually(async () => {
    const reply = await a.request('lease', { epoch: 2 })
    if (reply.ok) return true
    assert.equal(reply.error?.code, 'DESKTOP_BUSY', `Unexpected empty-lease recovery failure: ${JSON.stringify(reply.error)}`)
  }, 'The crashed empty lease was not recovered')
  assert.notEqual((await a.ok('status')).inputState.ownerId, firstOwner)
  await a.ok('release', { epoch: 2 }); check('CRASHED-EMPTY-LEASE-RECOVERED')

  if (actionCrash) {
    const status = await a.ok('status')
    assert.ok(status.permissions.screenRecording && status.permissions.accessibility && status.permissions.postEvents, 'Previously granted native capture/input permissions are required')
    fixture = endpoint(fixtureBinary, [], 'fixture')
    const ready = await fixture.next('ready')
    fixture.identity = remember(await processIdentity(fixture.child.pid), 'fixture')
    assert.equal(ready.pid, fixture.identity.pid)
    const target = (await a.ok('targets')).targets.find(value => value.pid === fixture.identity.pid && value.appId === fixtureBundleId && value.title === 'QiuYaTools Computer E2E Fixture')
    assert.ok(target, 'Only the exact disposable fixture PID/bundle/window may receive input')
    const windowId = Number(/^mac-window:(\d+)$/u.exec(target.id)?.[1])
    assert.ok(Number.isSafeInteger(windowId) && windowId > 0)
    const frame = await a.ok('observe', { targetId: target.id })
    await writeFile(join(output, 'fixture.jpg'), Buffer.from(frame.imageBase64, 'base64'))
    const fixtureArgs = { fixturePid: fixture.identity.pid, windowId }, before = await observe('before-owned-drag', fixtureArgs)
    assert.ok(emptyOs(before), 'OS input must be empty before the single drag')
    assert.ok(sameIdentity(before.fixtureIdentity, fixture.identity))
    assert.equal(before.foregroundPid, fixture.identity.pid, 'Fixture activation must succeed before the single action; no activation/input retry is allowed')
    assert.ok(before.fixtureWindows.some(window => window.id === windowId && window.ownerPid === fixture.identity.pid && window.onScreen === true))
    const baseline = await snapshotFixture()
    const point = global => ({ x: (global.x - frame.geometry.x) * frame.width / frame.geometry.width, y: (global.y - frame.geometry.y) * frame.height / frame.geometry.height })
    const from = point(ready.points.canvas), to = point({ x: ready.points.canvas.x + 100, y: ready.points.canvas.y })
    for (const p of [from, to]) assert.ok(p.x >= 0 && p.y >= 0 && p.x < frame.width && p.y < frame.height, 'The drag must stay inside the observed fixture')
    dragEvidence = { ready, target, fixtureIdentity: fixture.identity, geometry: frame.geometry, raster: { width: frame.width, height: frame.height }, from, to, before, baseline }
    const crash = await helper('held-drag-owner')
    await crash.ok('lease', { epoch: 1 }); await crash.ok('observe', { targetId: target.id })
    const oldOwner = (await crash.ok('status')).inputState.ownerId
    assert.match(oldOwner, /^[a-f0-9]{32}$/u)
    assert.ok((await discoverGuardians()).some(identity => identity.parentPid === crash.identity.pid), 'The held-drag owner must have a pinned guardian before input')
    let dragReply
    const drag = crash.request('act', { epoch: 1, targetId: target.id, action: { kind: 'drag', ...from, toX: to.x, toY: to.y } }).then(reply => { dragReply = reply; return reply }, error => { dragReply = { processExit: error.message }; return dragReply })
    dragEvidence.held = await eventually(async () => {
      const [native, os, events] = await Promise.all([crash.ok('status'), observe('in-flight-held-probe', fixtureArgs), snapshotFixture()])
      if (dragReply) throw new Error(`The single drag ended before the held crash checkpoint: ${JSON.stringify(dragReply)}`)
      assert.equal(os.foregroundPid, fixture.identity.pid, 'The fixture lost actual foreground; no action was replayed')
      if (native.inputState.mouseHeld && native.inputState.leftButtonDown && os.leftButtonDown && events.counts.mouseDown === baseline.counts.mouseDown + 1 && events.counts.dragged > baseline.counts.dragged && events.counts.mouseUp === baseline.counts.mouseUp) return { native, os, events }
    }, 'The single drag never reached independent OS-held and fixture down/dragged evidence', 2000)
    dragEvidence.journalBeforeCrash = await journal()
    assert.equal(dragEvidence.journalBeforeCrash?.ownerId, oldOwner)
    assert.deepEqual(dragEvidence.journalBeforeCrash.mouseButtons, [0])
    assert.equal(dragEvidence.journalBeforeCrash.targetPid, fixture.identity.pid)
    dragEvidence.crash = await crashPinned(crash, { requireLeftHeld: true, ...fixtureArgs })
    dragEvidence.dragExit = await drag
    assert.equal(dragEvidence.crash.leftImmediatelyBeforeSignal, true)
    await eventually(async () => {
      const reply = await a.request('lease', { epoch: 3 })
      if (reply.ok) return true
      assert.equal(reply.error?.code, 'DESKTOP_BUSY', `Unexpected held recovery failure: ${JSON.stringify(reply.error)}`)
    }, 'The crashed drag journal was not recovered')
    dragEvidence.recoveredNative = await a.ok('status')
    const newOwner = dragEvidence.recoveredNative.inputState.ownerId
    assert.match(newOwner, /^[a-f0-9]{32}$/u); assert.notEqual(newOwner, oldOwner)
    dragEvidence.after = await eventually(async () => { const value = await observe('after-crash-recovery', fixtureArgs); return emptyOs(value) && value }, 'Actual OS input was not released after crash recovery')
    dragEvidence.afterFixture = await eventually(async () => { const value = await snapshotFixture(); return value.counts.mouseUp === baseline.counts.mouseUp + 1 && value }, 'Fixture did not receive the single crash-recovery mouse-up')
    assert.equal(dragEvidence.afterFixture.counts.mouseDown, baseline.counts.mouseDown + 1)
    assert.ok(dragEvidence.afterFixture.counts.dragged > baseline.counts.dragged)
    assert.equal(dragEvidence.recoveredNative.inputState.leftButtonDown, false)
    assert.equal((await journal())?.ownerId, newOwner)
    await a.ok('release', { epoch: 3 }); check('REAL-DRAG-SIGKILL-JOURNAL-RECOVERY')
  }
  functional = { status: 'passed', kind: actionCrash ? 'real-native-process-and-independent-OS-held-drag-crash' : 'real-native-process-leases-no-input-injection' }
} catch (error) {
  functional = { status: error.code === 'SESSION_LOCKED' ? 'blocked' : 'failed', reason: error.message, stack: error.stack }
} finally {
  functional = { ...functional, checks, preflight, dragEvidence, notRun: actionCrash ? ['held-key-crash', 'physical-HID-input'] : ['held-drag-crash', 'held-key-crash', 'physical-HID-input'], testedAt: new Date().toISOString() }
  await writeFile(join(output, 'run-report.json'), JSON.stringify(functional, null, 2) + '\n')
  if (oracle) {
    try { await discoverGuardians() } catch (error) { cleanup.errors.push(`Ownership checkpoint: ${error.message}`) }
    for (const controller of controllers.filter(value => value !== oracle)) {
      if (controller.intentionalCrash) continue
      try {
        assert.equal(controller.child.exitCode, null, `${controller.label} exited before natural EOF cleanup`)
        assert.equal(controller.child.signalCode, null, `${controller.label} was signalled before natural EOF cleanup`)
        controller.child.stdin.end(controller === fixture ? 'quit\n' : undefined)
        assert.deepEqual(await waitExit(controller, 5000), { code: 0, signal: null })
      } catch (error) { cleanup.errors.push(`Natural ${controller.label} cleanup: ${error.message}`) }
    }
    const remaining = async () => {
      const alive = []
      for (const identity of tracked.values()) {
        if (identity.role === 'oracle') continue
        try {
          let current
          try { current = await processIdentity(identity.pid) }
          catch (error) { cleanup.errors.push(`Primary observer cleanup query: ${error.message}`); current = (await oneShot('identity', { pid: identity.pid })).identity }
          if (sameIdentity(current, identity)) alive.push(identity)
        }
        catch (error) { alive.push({ ...identity, identityError: error.message }) }
      }
      return alive
    }
    try { await eventually(async () => { cleanup.naturalRemaining = await remaining(); return cleanup.naturalRemaining.length === 0 }, 'Exact owned processes survived natural EOF cleanup') }
    catch (error) { cleanup.errors.push(error.message) }
    for (const identity of cleanup.naturalRemaining) {
      try { cleanup.forced.push(await oracle.ok('killOwned', { identity })) }
      catch (error) {
        cleanup.errors.push(`Pinned fallback: ${error.message}`)
        try { cleanup.forced.push(await oneShot('killOwned', { identity })) }
        catch (fallback) { cleanup.errors.push(`Independent pinned fallback: ${fallback.message}`) }
      }
    }
    if (cleanup.forced.length) cleanup.errors.push('Forced retirement was required; this run cannot pass')
    try {
      await eventually(async () => { cleanup.finalRemaining = await remaining(); return cleanup.finalRemaining.length === 0 }, 'Owned processes survived pinned fallback')
      cleanup.finalOs = await observe('after-all-native-processes-exited')
      assert.ok(emptyOs(cleanup.finalOs), 'Actual OS buttons/keys remain held after cleanup')
      if (leaseAcquired) assert.equal(await journal(), null, 'The test journal was not removed after natural release/recovery')
    } catch (error) { cleanup.errors.push(error.message) }
    try { oracle.child.stdin.end(); assert.deepEqual(await waitExit(oracle, 5000), { code: 0, signal: null }) }
    catch (error) {
      cleanup.errors.push(`Oracle natural cleanup: ${error.message}`)
      if (oracle.identity && oracle.child.exitCode === null && !oracle.child.signalCode) {
        try { cleanup.forced.push(await oneShot('killOwned', { identity: oracle.identity })); await waitExit(oracle, 5000) }
        catch (fallback) { cleanup.errors.push(`Oracle pinned retirement: ${fallback.message}`) }
      }
    }
  } else { cleanup.errors.push('The independent observer never became available; natural process cleanup was not proven') }
  cleanup.tracked = [...tracked.values()]
  cleanup.passed = cleanup.errors.length === 0 && cleanup.forced.length === 0
  for (const controller of controllers) {
    controller.closeLines()
    await writeFile(join(output, `${controller.label}.jsonl`), controller.transcript.map(value => JSON.stringify(value)).join('\n') + '\n')
    if (controller.stderr()) await writeFile(join(output, `${controller.label}.stderr.log`), controller.stderr())
  }
  await writeFile(join(output, 'request-summary.json'), JSON.stringify(requests, null, 2) + '\n')
  await writeFile(join(output, 'oracle-observations.json'), JSON.stringify(observations, null, 2) + '\n')
  const passed = functional.status === 'passed' && cleanup.passed
  await writeFile(join(output, 'delivery-verdict.json'), JSON.stringify({ passed, functionalStatus: functional.status, cleanup, environment, rawRunReport: 'run-report.json', testedAt: new Date().toISOString() }, null, 2) + '\n')
  await writeFile(join(output, 'report.json'), JSON.stringify({ ...functional, status: passed ? 'passed' : functional.status === 'blocked' ? 'blocked' : 'failed', cleanup }, null, 2) + '\n')
  if (cleanup.passed) await rm(temporary, { recursive: true, force: true })
  console.log(JSON.stringify({ output, functionalStatus: functional.status, deliveryPassed: passed, checks: checks.length, cleanupPassed: cleanup.passed, reason: functional.reason, cleanupErrors: cleanup.errors }, null, 2))
  if (!passed) process.exitCode = functional.status === 'blocked' ? 2 : 1
}
