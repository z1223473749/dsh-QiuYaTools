/** Real default per-chat manager + native scheduling; no mock or legacy driver. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { build, stop as stopEsbuild } from 'esbuild'

assert.equal(process.platform, 'darwin')
const root = fileURLToPath(new URL('../', import.meta.url)), arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] }
const output = resolve(arg('--out', 'artifacts/computer-use/macos-default-manager')), helper = await realpath(resolve(arg('--native', join(root, 'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'))))
assert.ok(helper.endsWith('/Contents/MacOS/qiuya-computer'), 'Use the actual formal app-bundle helper so default-path resolution can preserve its identity')
await mkdir(output, { recursive: true }); for (const name of ['report.json', 'run-report.json', 'delivery-verdict.json']) assert.equal(await access(join(output, name)).then(() => true, () => false), false, 'Use a fresh evidence directory')
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-multitask-')), execute = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const observerBinary = join(temporary, 'observer'), leaseBinary = join(temporary, 'lease-oracle'), runtime = join(temporary, 'runtime.mjs')
const fixtureSource = join(root, 'src/native/macos/fixtures/AICursorFixture.swift'), observerSource = join(root, 'src/native/macos/fixtures/AICursorObserver.swift'), leaseSource = join(root, 'src/native/macos/fixtures/LeaseOracle.swift')
const fixtures = new Map(), bindings = new Map(), known = new Map(), controllers = [], checks = [], trace = [], observations = [], geometrySettles = [], frames = [], events = [], routes = new Map(), pageFrames = new Map()
const cleanup = { passed: false, errors: [], forced: [], exits: [], processes: [] }
let observer, host, manager, server, report, environment, helperSha256, runnerIdentity, fatal, phase = 'setup'
const key = value => `${value.pid}:${value.startSeconds}:${value.startMicroseconds}`
const same = (a, b) => a && b && key(a) === key(b) && a.executablePath === b.executablePath
const remember = (value, role) => { assert.ok(value?.pid && value.startSeconds && value.startMicroseconds && value.executablePath); known.set(key(value), { ...value, role }); return value }
const pass = (id, detail = {}) => checks.push({ id, passed: true, ...detail })
const empty = state => state && !state.leftButtonDown && !state.rightButtonDown && !state.middleButtonDown && state.keysDown?.length === 0
function endpoint(path, args, label) {
  const child = spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'] }), pending = new Map(), waiting = [], buffered = [], transcript = []
  let id = 0, stderr = ''; child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-5000) }); child.stdin.on('error', () => {})
  const exited = new Promise(done => { child.once('exit', (code, signal) => done({ code, signal })); child.once('error', error => done({ error: error.message })) })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let value; try { value = JSON.parse(line) } catch { fatal ??= new Error(`${label} malformed JSON`); return }
    transcript.push(value)
    const job = pending.get(value.requestId)
    if (job) { pending.delete(value.requestId); clearTimeout(job.timer); job.resolve(value); return }
    const index = waiting.findIndex(job => job.event === value.event)
    if (index >= 0) { const job = waiting.splice(index, 1)[0]; clearTimeout(job.timer); job.resolve(value) } else buffered.push(value)
  })
  exited.then(exit => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error(`${label} exited: ${JSON.stringify(exit)} ${stderr}`)) }; pending.clear() })
  const request = (op, payload = {}) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode) { reject(new Error(`${label} no longer running`)); return }
    const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${label} ${op} timeout`)) }, 12000)
    pending.set(requestId, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ requestId, op, ...payload }) + '\n', error => { if (error) { clearTimeout(timer); pending.delete(requestId); reject(error) } })
  })
  const value = { child, label, exited, request, transcript, stderr: () => stderr,
    ok: async (op, payload) => { const reply = await request(op, payload); assert.equal(reply.ok, true, `${label} ${op}: ${JSON.stringify(reply.error)}`); return reply.result },
    next: event => new Promise((resolve, reject) => { const index = buffered.findIndex(value => value.event === event); if (index >= 0) { resolve(buffered.splice(index, 1)[0]); return }; const job = { event, resolve }; job.timer = setTimeout(() => { waiting.splice(waiting.indexOf(job), 1); reject(new Error(`${label} ${event} timeout`)) }, 10000); waiting.push(job) }),
    close: () => { lines.close(); for (const job of waiting) clearTimeout(job.timer) } }
  controllers.push(value); return value
}
async function until(read, message, ms = 3000) {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) { if (fatal && phase !== 'cleanup') throw fatal; const value = await read(); if (value) return value; await sleep(8) }
  throw new Error(message)
}
async function os(label) {
  const value = await observer.ok('snapshot', { identities: [...fixtures.values()].map(value => value.identity).concat([...bindings.values()].map(value => value.identity)) })
  observations.push({ label, ...value }); return value
}
async function identify(pid, role) { return remember((await observer.ok('identity', { pid })).identity, role) }
async function fallbackIdentity(pid) {
  const receipt = JSON.parse((await execute(leaseBinary, ['--one-shot', JSON.stringify({ op: 'identity', pid })], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.trim())
  assert.equal(receipt.ok, true); return receipt.result.identity
}
async function waitExit(value, ms = 5000) {
  let timer; try { return await Promise.race([value.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${value.label} exit timeout`)), ms) })]) } finally { clearTimeout(timer) }
}
async function retireObserverAfterAudit(value) {
  if (!value) return
  try {
    const state = await value.ok('snapshot', { identities: [] }); cleanup.finalInputAudit = { passed: empty(state), state }
    assert.ok(empty(state), 'Final actual OS input must be released')
  } catch (error) { cleanup.finalInputAudit ??= { passed: false }; cleanup.errors.push(error.message) }
  // A failed held-input audit invalidates the run, but must not bypass EOF.
  let natural = false; cleanup.observerEofAttempted = true
  try {
    value.child.stdin.end(); const exit = await waitExit(value); assert.equal(exit.code, 0); assert.equal(exit.signal, null)
    natural = true; cleanup.observerNaturalExit = true; cleanup.exits.push({ observer: true, ...exit })
    await until(async () => !same(await fallbackIdentity(value.child.pid), value.identity), 'Exact observer remained after natural EOF', 5000)
  } catch (error) {
    cleanup.errors.push(error.message)
    if (!natural && value.child.exitCode === null && !value.child.signalCode) {
      try { if (same(await fallbackIdentity(value.child.pid), value.identity)) { cleanup.forced.push(value.label); value.child.kill('SIGKILL'); await waitExit(value, 2000) } }
      catch (issue) { cleanup.errors.push(issue.message) }
    }
  }
}
async function fixtureState(id) { return fixtures.get(id).ok('snapshot') }
function point(fixture, frame, offset = 0) { const p = fixture.settledPoint; assert.ok(p, 'Every actual input requires a freshly settled fixture point'); return { x: (p.x + offset - frame.geometry.x) * frame.width / frame.geometry.width, y: (p.y - frame.geometry.y) * frame.height / frame.geometry.height } }
async function capture(sessionId, preview = false) {
  const value = await manager[preview ? 'preview' : 'observe'](sessionId)
  frames.push({ sessionId, preview, targetId: value.targetId, frameId: value.frameId, width: value.width, height: value.height, geometry: value.geometry, aiCursor: value.aiCursor })
  assert.equal(value.targetId, fixtures.get(sessionId).target.id); assert.equal(Buffer.from(value.imageBase64, 'base64').readUInt16BE(0), 0xffd8)
  return value
}
async function settledCapture(sessionId, stage) {
  const fixture = fixtures.get(sessionId), expectedTarget = fixture.target, windowId = Number(expectedTarget.id.match(/^mac-window:(\d+)$/u)?.[1])
  assert.ok(Number.isSafeInteger(windowId) && windowId > 0 && expectedTarget.pid === fixture.identity.pid)
  const start = performance.now(), deadline = start + 8000, evidence = { sessionId, stage, targetId: expectedTarget.id, owner: fixture.identity, timeoutMs: 8000, minimumStableMs: 200, minimumSamples: 3, samples: [] }
  geometrySettles.push(evidence)
  let signature, stableAt, count = 0
  const reset = () => { signature = undefined; stableAt = undefined; count = 0 }
  const read = async operation => {
    const left = deadline - performance.now(); assert.ok(left > 0, 'Exact fixture geometry did not settle before its read-only deadline')
    let timer
    try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Exact fixture geometry read exceeded its deadline')), left) })]) }
    finally { clearTimeout(timer) }
  }
  const matches = (a, b, fields = ['x', 'y', 'width', 'height']) => !!a && !!b && fields.every(field => Number.isFinite(a[field]) && a[field] === b[field]) && a.width > 0 && a.height > 0
  while (performance.now() < deadline) {
    const identity = (await read(() => observer.ok('identity', { pid: fixture.identity.pid }))).identity
    assert.ok(same(identity, fixture.identity) && identity.uniqueId === fixture.identity.uniqueId, 'Exact fixture PID/birth/executable identity changed')
    const before = await read(() => os(`${sessionId}-${stage}-geometry-before`)), ownWindow = before.windows.find(row => row.id === windowId && row.pid === fixture.identity.pid)
    const sample = { atMs: performance.now() - start, window: ownWindow ?? null }; evidence.samples.push(sample)
    // The queued chat may be in the background. Require its exact real visible
    // window, never activation or input to make this read-only gate pass.
    if (!ownWindow || ownWindow.onScreen !== true || ownWindow.alpha !== 1) { reset(); await sleep(25); continue }
    const target = (await read(() => manager.targetsFor(sessionId))).find(row => row.id === expectedTarget.id)
    if (target) assert.ok(target.pid === expectedTarget.pid && target.appId === expectedTarget.appId, 'Native target identity changed')
    sample.targetGeometry = target ? { x: target.x, y: target.y, width: target.width, height: target.height, scale: target.scale } : null
    if (!matches(ownWindow, target) || !Number.isFinite(target.scale) || target.scale <= 0) { reset(); await sleep(25); continue }
    let frame
    try { frame = await read(() => capture(sessionId)) }
    catch (error) {
      sample.observationError = error.code ?? 'UNKNOWN'
      assert.ok(['CAPTURE_CHANGED', 'GEOMETRY_CHANGED', 'TARGET_GONE', 'TARGETS_UNAVAILABLE', 'INVALID_TARGET'].includes(error.code), `Fixture read failed: ${error.code ?? 'UNKNOWN'}`)
      reset(); await sleep(25); continue
    }
    const after = await read(() => os(`${sessionId}-${stage}-geometry-after`)), afterWindow = after.windows.find(row => row.id === windowId && row.pid === fixture.identity.pid)
    const state = await read(() => fixtureState(sessionId)), confirmed = (await read(() => observer.ok('identity', { pid: fixture.identity.pid }))).identity
    assert.ok(same(confirmed, fixture.identity) && confirmed.uniqueId === fixture.identity.uniqueId, 'Fixture identity changed during the fresh observation')
    assert.ok(state.pid === expectedTarget.pid && state.windowId === windowId && state.bundleId === expectedTarget.appId, 'Fixture snapshot changed its exact window identity')
    sample.frame = { targetId: frame.targetId, frameId: frame.frameId, width: frame.width, height: frame.height, geometry: frame.geometry }; sample.afterWindow = afterWindow ?? null; sample.fixturePoint = state.point
    if (frame.targetId !== expectedTarget.id || !matches(ownWindow, frame.geometry) || !matches(target, frame.geometry, ['x', 'y', 'width', 'height', 'scale']) || !matches(ownWindow, afterWindow) || afterWindow?.onScreen !== true || afterWindow?.alpha !== 1 || state.visible !== true) { reset(); await sleep(25); continue }
    assert.ok(Number.isSafeInteger(frame.width) && frame.width > 0 && Number.isSafeInteger(frame.height) && frame.height > 0 && Number.isFinite(state.point?.x) && Number.isFinite(state.point?.y))
    const next = JSON.stringify([...['x', 'y', 'width', 'height', 'scale'].map(field => frame.geometry[field]), frame.width, frame.height, state.point.x, state.point.y])
    if (signature !== next) { signature = next; stableAt = performance.now(); count = 1 } else count++
    sample.agreeingSamples = count; sample.stableMs = performance.now() - stableAt
    if (count >= evidence.minimumSamples && sample.stableMs >= evidence.minimumStableMs) {
      fixture.settledPoint = state.point
      const freshPoint = point(fixture, frame)
      assert.ok(freshPoint.x >= 0 && freshPoint.y >= 0 && freshPoint.x < frame.width && freshPoint.y < frame.height, 'Fresh fixture point must lie within the settled raster')
      evidence.passed = true; evidence.elapsedMs = performance.now() - start; evidence.stableMs = sample.stableMs; evidence.agreeingSamples = count; evidence.point = freshPoint
      return frame
    }
    await sleep(25)
  }
  throw new Error('Exact fixture CG/native observation geometry did not become continuously stable; no action was sent')
}
async function pin(sessionId, NativeCompanionDriver, ScheduledComputerDriver) {
  const entries = Reflect.get(manager, 'entries'), entry = entries?.get(sessionId), scheduled = entry && Reflect.get(entry.driver, 'local'), native = scheduled?.inner
  assert.ok(scheduled instanceof ScheduledComputerDriver && native instanceof NativeCompanionDriver, 'Actual default manager must use its production scheduler/native chain')
  assert.equal(scheduled.surface, 'local-desktop')
  const child = Reflect.get(native, 'child'); assert.ok(child?.pid)
  const identity = await identify(child.pid, 'native'); assert.equal(identity.executablePath, helper); assert.equal(identity.parentPid, process.pid)
  const exited = child.exitCode !== null || child.signalCode ? Promise.resolve({ code: child.exitCode, signal: child.signalCode }) : new Promise(done => child.once('exit', (code, signal) => done({ code, signal })))
  const binding = { native, scheduled, child, identity, exited, label: `native-${sessionId}` }; bindings.set(sessionId, binding)
  native.subscribe(value => events.push({ sessionId, ...value }))
  return binding
}
async function guardians() {
  for (const value of bindings.values()) for (const child of (await observer.ok('children', { identity: value.identity })).identities) remember(child, 'guardian')
}
function act(sessionId, frame, action) {
  const actionId = randomUUID(), record = { sessionId, actionId, frameId: frame.frameId, action, requestedNs: String(process.hrtime.bigint()) }; trace.push(record)
  const promise = manager.act(sessionId, { actionId, frameId: frame.frameId, action })
  void promise.then(result => { record.completedNs = String(process.hrtime.bigint()); record.result = result }, error => { record.failed = error.message })
  return promise
}
async function rpc(op, sessionId) {
  const response = await routes.get('/api/qiuya-tools.computer.control').fetch(new Request(`http://127.0.0.1:${server.address().port}/api/qiuya-tools.computer.control`, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'qiuya-tools.computer.control', payload: { op, sessionId } }) }))
  const result = (await response.json()).result; assert.equal(result.ok, true, `${op}/${sessionId}: ${JSON.stringify(result.error)}`); return result.value
}
async function held(sessionId) {
  const binding = bindings.get(sessionId)
  return until(async () => {
    const state = await binding.native.status()
    if (state.inputState?.leftButtonDown && state.aiCursor?.visible) { const actual = await os(`${sessionId}-held`); if (!actual.leftButtonDown) return false; assert.equal(actual.foregroundPid, fixtures.get(sessionId).identity.pid); assert.ok(actual.windows.some(row => row.pid === binding.identity.pid && row.title === 'QiuYaTools AI pointer' && row.onScreen)); return { state, actual } }
    return false
  }, 'The single actual drag did not expose an OS-held/live-overlay interval', 1800)
}

try {
  helperSha256 = hash(await readFile(helper)); if (arg('--expect-sha256')) assert.equal(helperSha256, arg('--expect-sha256'), 'Helper must be pinned before any GUI/input')
  const compile = ['-swift-version', '5', '-framework', 'AppKit', '-module-cache-path', '/private/tmp/qiuya-multitask-module-cache']
  await execute('/usr/bin/swiftc', [...compile, '-parse-as-library', '-framework', 'ScreenCaptureKit', '-framework', 'CoreImage', '-framework', 'CoreMedia', observerSource, '-o', observerBinary], { timeout: 90000 })
  await execute('/usr/bin/swiftc', [...compile, leaseSource, '-o', leaseBinary], { timeout: 60000 })
  observer = endpoint(observerBinary, [], 'independent-observer'); observer.identity = remember((await observer.next('ready')).identity, 'observer')
  runnerIdentity = await identify(process.pid, 'runner')
  const preflight = await os('before-fixtures'); assert.ok(preflight.sessionExists && !preflight.screenLocked && preflight.screenRecording && empty(preflight), 'Requires unlocked inherited capture permission and no actual held input')
  for (const [index, id] of ['chat-A', 'chat-B'].entries()) {
    const contents = join(temporary, `${id} Fixture.app/Contents`), path = join(contents, 'MacOS/fixture')
    await mkdir(dirname(path), { recursive: true }); await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.qiuya.tools.multitask.${randomUUID().replaceAll('-', '')}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
    if (!index) await execute('/usr/bin/swiftc', [...compile, fixtureSource, '-o', path], { timeout: 60000 }); else await copyFile(fixtures.get('chat-A').path, path)
    const fixture = endpoint(path, index ? ['--secondary'] : [], id); fixture.path = path; fixture.ready = (await fixture.next('ready')).state; fixture.identity = await identify(fixture.child.pid, 'fixture'); fixtures.set(id, fixture)
  }
  await until(async () => (await os('initial-focus')).foregroundPid === fixtures.get('chat-A').identity.pid, 'Primary fixture activation failed; no retry/input replay')
  const built = await build({ stdin: { contents: "export {installComputerHost} from './src/features/computer-use/host.ts';export {NativeCompanionDriver} from './src/features/computer-use/native.ts';export {ScheduledComputerDriver} from './src/features/computer-use/scheduled-driver.ts'", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: runtime })
  for (const value of (await observer.ok('allChildren', { identity: runnerIdentity })).identities) if (!known.has(key(value))) remember(value, 'build-service')
  await stopEsbuild()
  // No createRouter/driver seam is used. A temporary path alias makes the
  // unmodified bundled defaultPath find the original unchanged formal app.
  const alias = join(temporary, 'QiuYaTools Computer.app'); await symlink(dirname(dirname(dirname(helper))), alias, 'dir')
  const { installComputerHost, NativeCompanionDriver, ScheduledComputerDriver } = await import(pathToFileURL(runtime).href)
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname, route = routes.get(path), chunks = []; let length = 0
      for await (const chunk of request) { length += chunk.length; if (length > 256000) throw new Error('Test request bound'); chunks.push(chunk) }
      if (!route) { response.writeHead(404).end(); return }
      const input = request.method === 'POST' ? JSON.parse(Buffer.concat(chunks)) : undefined
      const result = await route.fetch(new Request(`http://127.0.0.1:${server.address().port}${request.url}`, { method: request.method, ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) })), bytes = Buffer.from(await result.arrayBuffer())
      if (input?.payload?.op === 'frame' && JSON.parse(bytes).result?.ok) pageFrames.set(input.payload.sessionId, (pageFrames.get(input.payload.sessionId) ?? 0) + 1)
      response.writeHead(result.status, Object.fromEntries(result.headers)).end(bytes)
    } catch (error) { if (phase !== 'cleanup') fatal ??= error; if (!response.headersSent) response.writeHead(500); response.end('test carrier failed') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  host = await installComputerHost({ get: name => name === 'sessions' ? { get: id => fixtures.has(id) ? {} : undefined } : undefined, webServer: { port: server.address().port }, connection: { browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: value => value, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }, () => true)
  manager = host.manager; assert.ok(manager && host.service === manager, 'This test must exercise the actual default manager, not options.driver legacy')
  for (const id of fixtures.keys()) {
    const fixture = fixtures.get(id), target = (await manager.targetsFor(id)).find(row => row.pid === fixture.identity.pid && row.appId === fixture.ready.bundleId && row.id === `mac-window:${fixture.ready.windowId}`)
    assert.ok(target, 'Exact owner-approved disposable app/window required'); fixture.target = target
    await pin(id, NativeCompanionDriver, ScheduledComputerDriver)
  }
  await Promise.all([...fixtures].map(([id, value]) => manager.start(id, value.target.id, { allowOnce: true })))
  const initial = manager.list(); assert.equal(initial.length, 2); assert.ok(initial.every(value => value.state === 'ready'))
  for (const value of bindings.values()) assert.equal((await value.native.status()).leaseEpoch, null, 'Logical ready must not retain a desktop-wide physical lease')
  assert.equal(Reflect.get(bindings.get('chat-A').scheduled, 'scheduler'), Reflect.get(bindings.get('chat-B').scheduled, 'scheduler'))
  pass('DEFAULT-MANAGER-TWO-READY-CHATS-NO-OS-LEASE', { initial })
  let [frameA, frameB] = await Promise.all([settledCapture('chat-A', 'before-first-drag'), settledCapture('chat-B', 'before-queued-drag')]); pass('DEFAULT-MANAGER-PARALLEL-REAL-OBSERVE', { targets: [frameA.targetId, frameB.targetId] })
  environment = { helper, helperSha256, alias, runtimeSha256: hash(await readFile(runtime)), architecture: process.arch, temporary, sourceFiles: Object.fromEntries(await Promise.all([fileURLToPath(import.meta.url), fixtureSource, observerSource, leaseSource, ...['host.ts', 'environment-manager.ts', 'scheduled-driver.ts', 'driver-router.ts', 'session.ts', 'native.ts'].map(name => join(root, 'src/features/computer-use', name))].map(async path => [path, hash(await readFile(path))]))), nativeIdentities: [...bindings].map(([id, value]) => ({ sessionId: id, identity: value.identity })) }
  await writeFile(join(output, 'environment.json'), JSON.stringify(environment, null, 2))
  phase = 'actual-fifo'
  const beforeA = await fixtureState('chat-A'), beforeB = await fixtureState('chat-B'), a = point(fixtures.get('chat-A'), frameA), b = point(fixtures.get('chat-B'), frameB)
  const first = act('chat-A', frameA, { kind: 'drag', ...a, toX: a.x + 100 * frameA.width / frameA.geometry.width, toY: a.y }); let firstDone = false; void first.then(() => { firstDone = true }, () => { firstDone = true })
  const gateA = await held('chat-A')
  const second = act('chat-B', frameB, { kind: 'drag', ...b, toX: b.x + 45 * frameB.width / frameB.geometry.width, toY: b.y })
  const [bNativeWhileQueued, bPreviewWhileQueued, realWhileQueued] = await Promise.all([bindings.get('chat-B').native.status(), capture('chat-B', true), os('B-preview-while-A-held')])
  assert.equal(bNativeWhileQueued.leaseEpoch, null, 'Queued B must not acquire native ownership over A')
  assert.ok(!firstDone && realWhileQueued.leftButtonDown, 'Actual A-held interval expired before concurrent-preview evidence; no input retry is permitted')
  assert.equal(realWhileQueued.foregroundPid, fixtures.get('chat-A').identity.pid)
  pass('FIFO-B-PREVIEW-CONTINUES-WHILE-A-OWNS-DESKTOP', { gateA, bFrameId: bPreviewWhileQueued.frameId, bNativeWhileQueued })
  await Promise.all([first, second]); await guardians()
  const afterA = await fixtureState('chat-A'), afterB = await fixtureState('chat-B')
  for (const [before, after] of [[beforeA, afterA], [beforeB, afterB]]) { assert.equal(after.counts.downs - before.counts.downs, 1); assert.equal(after.counts.ups - before.counts.ups, 1); assert.ok(after.counts.drags - before.counts.drags >= 2) }
  const aUp = afterA.events.filter(value => value.kind === 'ups').at(-1), bDown = afterB.events.filter(value => value.kind === 'downs').at(-1)
  assert.ok(BigInt(aUp.atNs) <= BigInt(bDown.atNs), 'Actual fixture A up must precede fixture B down')
  pass('FIFO-REAL-APPKIT-DOWNS-DRAGS-UPS-OWN-APP-ORDER', { beforeA, beforeB, afterA, afterB })
  for (const [id, value] of bindings) { const state = await value.native.status(); assert.equal(state.leaseEpoch, null); assert.equal(state.aiCursor.visible, false); assert.equal(manager.get(id).state, 'ready') }
  assert.ok(empty(await os('after-fifo'))); pass('PER-ACTION-RELEASE-HIDES-AI-OVERLAY-WHILE-CHATS-STAY-READY')
  phase = 'cross-chat-redock'
  const bEpoch = manager.get('chat-B').epoch, aEpoch = manager.get('chat-A').epoch
  await rpc('preview', 'chat-A'); await until(() => (pageFrames.get('chat-A') ?? 0) >= 2, 'Actual A WK preview did not paint/request frames', 20000)
  assert.equal(manager.environments().find(value => value.sessionId === 'chat-A').previewDetached, true)
  const previewWindow = (await os('A-native-preview')).windows.find(value => value.pid === bindings.get('chat-A').identity.pid && value.title === 'QiuYaTools · 电脑操控')
  assert.ok(previewWindow?.onScreen); assert.equal(manager.get('chat-B').epoch, bEpoch)
  pass('A-REAL-NATIVE-POPOUT-DOES-NOT-CHANGE-B', { previewWindow, bEpoch })
  frameB = await settledCapture('chat-B', 'before-redock-drag'); const repeat = point(fixtures.get('chat-B'), frameB)
  const bBeforeRedock = await fixtureState('chat-B'), ongoing = act('chat-B', frameB, { kind: 'drag', ...repeat, toX: repeat.x - 40 * frameB.width / frameB.geometry.width, toY: repeat.y })
  const gateB = await held('chat-B'), closesBefore = events.filter(value => value.event === 'previewClosed').length
  await rpc('redock', 'chat-A')
  assert.equal(manager.get('chat-B').epoch, bEpoch); assert.ok(['running', 'ready'].includes(manager.get('chat-B').state)); assert.equal(manager.get('chat-A').epoch, aEpoch); assert.equal(manager.get('chat-A').state, 'ready')
  assert.equal(manager.environments().find(value => value.sessionId === 'chat-A').previewDetached, false); assert.equal(events.filter(value => value.event === 'previewClosed').length, closesBefore)
  await ongoing; const bAfterRedock = await fixtureState('chat-B'); assert.equal(bAfterRedock.counts.downs - bBeforeRedock.counts.downs, 1); assert.equal(bAfterRedock.counts.ups - bBeforeRedock.counts.ups, 1); assert.ok(bAfterRedock.counts.drags - bBeforeRedock.counts.drags >= 2)
  pass('A-REDOCK-DURING-B-ACTUAL-HELD-DRAG-PRESERVES-B-EPOCH-AND-EVENTS', { gateB, bEpoch, aEpoch, before: bBeforeRedock, after: bAfterRedock })
  pageFrames.set('chat-A', 0); await rpc('preview', 'chat-A'); await until(() => (pageFrames.get('chat-A') ?? 0) >= 2, 'Reopened A native preview did not load', 20000)
  await bindings.get('chat-A').native.closePreview(); await until(() => manager.get('chat-A').state === 'paused', 'Ordinary close did not pause A')
  assert.equal(manager.get('chat-B').state, 'ready'); assert.equal(manager.get('chat-B').epoch, bEpoch)
  frameB = await settledCapture('chat-B', 'before-final-click'); const beforeClick = await fixtureState('chat-B'); await act('chat-B', frameB, { kind: 'click', ...point(fixtures.get('chat-B'), frameB) }); const afterClick = await fixtureState('chat-B')
  assert.equal(afterClick.counts.clicks - beforeClick.counts.clicks, 1); pass('CLOSE-A-PAUSES-ONLY-A-B-CAN-STILL-CLICK-OWN-APP')
  await Promise.all(['chat-A', 'chat-B'].map(id => manager.stop(id))); assert.ok(manager.list().every(value => value.state === 'stopped'))
  assert.ok(empty(await os('all-stopped'))); pass('DEFAULT-MANAGER-STOP-BOTH-RELEASES-REAL-INPUT')
  report = { status: 'passed', checks, environment, frames, trace, events, observations,
    scope: 'Actual production default ComputerEnvironmentManager, default ScheduledComputerDriver and NativeCompanionDriver per chat; actual self-owned AppKit apps and native WK popout',
    inputDefinition: 'Production fixed 24-step approximately 0.4-second in-flight native drags; no input replay, synthetic delay, modified driver or mocked action',
    carrier: 'Loopback owner test services + temporary app path alias to unchanged formal helper; no options.driver/createRouter override; not installed Harness visual/chat-inline acceptance',
    limitations: ['No 30-minute mixed scroll/drag endurance or resource cap claim.', 'Shared Codex-responsibility WK XPC attribution remains unresolved and no shared process is signalled or called uniquely owned.', 'AI overlay is required during actual in-flight input and must disappear at each physical release; logical ready does not imply idle overlay visibility.'] }
} catch (error) { report = { status: 'failed', phase, reason: error.message, stack: error.stack, checks, environment, helperSha256, frames, trace, events }; process.exitCode = 1 }
finally {
  phase = 'cleanup'; try { await writeFile(join(output, 'run-report.json'), JSON.stringify(report, null, 2)) } catch (error) { cleanup.errors.push(error.message) }
  try { if (bindings.size) await guardians() } catch (error) { cleanup.errors.push(error.message) }
  try { await host?.dispose() } catch (error) { cleanup.errors.push(error.message) }
  await Promise.all([...bindings].map(async ([id, value]) => {
    try { const exit = await waitExit(value, 6000); cleanup.exits.push({ sessionId: id, ...exit }); assert.equal(exit.code, 0, 'Native helper must naturally exit'); assert.equal(exit.signal, null, 'Forced SDK retirement cannot pass') }
    catch (error) { cleanup.errors.push(error.message) }
  }))
  try { await stopEsbuild() } catch (error) { cleanup.errors.push(error.message) }
  for (const value of fixtures.values()) {
    try { value.child.stdin.end(); const exit = await waitExit(value); assert.equal(exit.code, 0); assert.equal(exit.signal, null); cleanup.exits.push({ fixture: value.label, ...exit }) }
    catch (error) { cleanup.errors.push(error.message); try { if (value.child.exitCode === null && !value.child.signalCode && same(await fallbackIdentity(value.child.pid), value.identity)) { cleanup.forced.push(value.label); value.child.kill('SIGKILL'); await waitExit(value, 2000) } } catch (issue) { cleanup.errors.push(issue.message) } }
  }
  if (server) { server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done)) }
  for (const value of [...known.values()].filter(value => !['runner', 'observer'].includes(value.role))) {
    try { await until(async () => !same(await fallbackIdentity(value.pid), value), `Exact ${value.role} remains: ${value.pid}`, 5000); cleanup.processes.push({ identity: value, state: 'gone' }) }
    catch (error) { cleanup.errors.push(error.message); cleanup.processes.push({ identity: value, state: 'unverified-or-alive' }) }
  }
  await retireObserverAfterAudit(observer)
  for (const value of controllers) value.close()
  let helperUnchanged = false; try { helperUnchanged = hash(await readFile(helper)) === helperSha256 } catch (error) { cleanup.errors.push(error.message) }
  cleanup.passed = !cleanup.errors.length && !cleanup.forced.length; if (!cleanup.passed) cleanup.retainedTemporary = temporary
  const passed = report?.status === 'passed' && cleanup.passed && helperUnchanged
  await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2)); await writeFile(join(output, 'transcripts.json'), JSON.stringify(controllers.map(value => ({ label: value.label, transcript: value.transcript, stderr: value.stderr() })), null, 2))
  await writeFile(join(output, 'geometry-settles.json'), JSON.stringify(geometrySettles, null, 2))
  await writeFile(join(output, 'report.json'), JSON.stringify({ ...report, status: passed ? 'passed' : 'failed', cleanup, testedAt: new Date().toISOString() }, null, 2)); await writeFile(join(output, 'delivery-verdict.json'), JSON.stringify({ passed, runnerPassed: report?.status === 'passed', naturalCleanupPassed: cleanup.passed, helperUnchanged }, null, 2))
  if (cleanup.passed) await rm(temporary, { recursive: true, force: true })
  console.log(JSON.stringify({ output, passed, checks: checks.length, cleanup }, null, 2)); if (!passed) process.exitCode = 1
}
