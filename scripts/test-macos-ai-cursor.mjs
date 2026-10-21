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
const trace = [], checks = [], observations = [], captures = [], identities = new Map(), controllers = [], cleanup = { passed: false, errors: [], forced: [], processes: [] }
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
    transcript.push(value.result?.imageBase64 ? { ...value, result: { ...value.result, imageBase64: `[${value.result.imageBase64.length} base64 chars]` } } : value)
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
async function capture(label, owner, windowId, composited, probe) {
  const path = join(output, `${label}.png`), value = await observer.ok('capture', { identity: owner, windowId, output: path, composited, probe })
  captures.push({ label, ...value, sha256: hash(await readFile(path)), file: path }); return value
}
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
  let frame = await native.ok('observe', { targetId: currentTarget.id }), point = raster(ready.point, frame)
  const otherPoint = { x: point.x + 70 * frame.width / frame.geometry.width, y: point.y + 25 * frame.height / frame.geometry.height }
  assert.ok(otherPoint.x < frame.width && otherPoint.y < frame.height)
  environment = { helper, helperSha256, architecture: process.arch, temporary, target: currentTarget, fixtureReady: ready, sources: Object.fromEntries(await Promise.all([fixtureSource, observerSource, leaseSource, fileURLToPath(import.meta.url)].map(async path => [path, hash(await readFile(path))]))) }
  await writeFile(join(output, 'environment.json'), JSON.stringify(environment, null, 2))
  phase = 'native-ai-overlay'
  await native.ok('lease', { epoch: 1, actor: 'ai' }); activeEpoch = 1; await guardians(native.identity)
  await act(1, point); const visible = await arrowVisible(1)
  frame = await native.ok('observe', { targetId: currentTarget.id, preview: true }); assert.equal(frame.aiCursor.visible, true)
  assert.ok(Math.hypot(frame.aiCursor.x - point.x, frame.aiCursor.y - point.y) < 3)
  assert.ok(Math.hypot(frame.cursor.x - frame.aiCursor.x, frame.cursor.y - frame.aiCursor.y) < 3, 'Real cursor and AI metadata agree without replacing each other')
  await writeFile(join(output, 'selected-window-frame.jpg'), Buffer.from(frame.imageBase64, 'base64'))
  const pixels = await capture('actual-ai-overlay', alpha.identity, ready.windowId, true, { x: ready.point.x - frame.geometry.x - 2, y: ready.point.y - frame.geometry.y - 2, width: 36, height: 46 })
  assert.ok(pixels.analysis.whitePixels >= 15 && pixels.analysis.greyPixels >= 70, `Actual display arrow fill/white-outline pixels missing: ${JSON.stringify(pixels.analysis)}`)
  pass('MAC-AI-ACTUAL-CGWINDOW-PIXELS-NOACTIVATE', { window: visible.window, analysis: pixels.analysis })
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
  await native.ok('lease', { epoch: 5, actor: 'ai' }); activeEpoch = 5; await native.ok('observe', { targetId: currentTarget.id }); await act(5, point); await arrowVisible(5); await guardians(native.identity)
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
  assert.ok(Math.abs(receipt.dom.cursor.x + 4 - expectedX) < 2 && Math.abs(receipt.dom.cursor.y + 3 - expectedY) < 2, 'Production SVG tip must follow the actual native raster point')
  const wkWindow = (await os('real-native-preview')).windows.find(row => row.pid === secondNative.pid && row.title === 'QiuYaTools · 电脑操控')
  assert.ok(wkWindow && wkWindow.layer > 0)
  const wkPixels = await capture('actual-wk-ai-arrow', secondNative, wkWindow.id, false, { x: receipt.dom.cursor.x, y: receipt.dom.cursor.y + wkWindow.height - receipt.dom.innerHeight, width: receipt.dom.cursor.width, height: receipt.dom.cursor.height })
  assert.ok(wkPixels.analysis.whitePixels >= 8 && wkPixels.analysis.svgGreyPixels >= 20, `Actual WK arrow pixels missing: ${JSON.stringify(wkPixels.analysis)}`)
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
    if (hostChildExit) { const exit = await hostChildExit; cleanup.hostNativeExit = exit; assert.equal(exit.code, 0, 'Host native helper must exit naturally'); assert.equal(exit.signal, null, 'Forced SDK retirement cannot pass natural cleanup') }
  } catch (error) { cleanup.errors.push(error.message) }
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
  if (observer) {
    try { const state = await observer.ok('snapshot', { identities: [] }); assert.ok(empty(state), 'Final actual OS input must be released'); await retire(observer); assert.ok(!same(await fallbackIdentity(observer.child.pid), observer.identity)) }
    catch (error) { cleanup.errors.push(error.message); if (observer.child.exitCode === null && !observer.child.signalCode) { try { if (same(await fallbackIdentity(observer.child.pid), observer.identity)) { cleanup.forced.push(observer.label); observer.child.kill('SIGKILL'); await waitExit(observer, 2000) } } catch (issue) { cleanup.errors.push(issue.message) } } }
  }
  for (const value of controllers) value.close()
  cleanup.passed = cleanup.errors.length === 0 && cleanup.forced.length === 0
  cleanup.scope = 'Exact native/guardian/fixture/observer identities gone after EOF; compiler via normal esbuild.stop; no shared Codex/WebKit process was signalled or claimed uniquely owned'
  let helperUnchanged = false
  try { helperUnchanged = hash(await readFile(helper)) === helperSha256 } catch (error) { cleanup.errors.push(`Helper binding: ${error.message}`); cleanup.passed = false }
  const finalPassed = report?.status === 'passed' && cleanup.passed && helperUnchanged
  if (!cleanup.passed) cleanup.retainedTemporary = temporary
  await writeFile(join(output, 'transcripts.json'), JSON.stringify(controllers.map(value => ({ label: value.label, pid: value.child.pid, transcript: value.transcript, stderr: value.stderr() })), null, 2))
  await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2)); await writeFile(join(output, 'trace.json'), JSON.stringify(trace, null, 2))
  await writeFile(join(output, 'report.json'), JSON.stringify({ ...report, status: finalPassed ? 'passed' : report?.status === 'blocked' ? 'blocked' : 'failed', cleanup, testedAt: new Date().toISOString() }, null, 2))
  await writeFile(join(output, 'delivery-verdict.json'), JSON.stringify({ passed: finalPassed, runnerPassed: report?.status === 'passed', naturalCleanupPassed: cleanup.passed, helperUnchanged }, null, 2))
  if (cleanup.passed) await rm(temporary, { recursive: true, force: true })
  console.log(JSON.stringify({ output, passed: finalPassed, checks: checks.length, cleanup }, null, 2)); if (!finalPassed) process.exitCode = 1
}
