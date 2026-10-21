/** Real macOS NSPanel/WKWebView endurance; no Chrome/Safari surrogate, no input actions. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WKFrameReceiver, macResourceVerdict, wkPreviewInstrumentation } from './computer-wkwebview-soak-evidence.mjs'

const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url))
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] }
const minutes = Number(arg('--minutes', '30')), expectedFaults = Number(arg('--faults', '5'))
assert.equal(process.platform, 'darwin', 'This test requires the owner-unlocked macOS desktop')
assert.ok(Number.isFinite(minutes) && minutes > 0 && minutes <= 120)
assert.ok(Number.isSafeInteger(expectedFaults) && expectedFaults >= 0 && expectedFaults <= 50)
const output = resolve(arg('--output', 'artifacts/computer-use/macos-wkwebview-soak'))
const companion = resolve(arg('--native', join(root, 'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer')))
await mkdir(output, { recursive: true })
if (!process.argv.includes('--worker')) {
  for (const name of ['report.json', 'delivery-verdict.json', 'ownership-checkpoint.json']) {
    const exists = await access(join(output, name)).then(() => true, () => false)
    assert.equal(exists, false, 'Use a fresh evidence directory; historical reports must not be overwritten')
  }
}
const temporary = await mkdtemp(join(tmpdir(), 'qiuya-wk-soak-'))
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function hashFile(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex') }
function observe(executable, request, timeout = 15000) {
  return new Promise((done, reject) => {
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []; let size = 0
    const timer = setTimeout(() => { child.kill(); reject(new Error('Read-only WK observer deadline')) }, timeout)
    child.stderr.resume(); child.stdin.on('error', () => {})
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 ** 2) { child.kill(); reject(new Error('WK observer output bound')) } else chunks.push(chunk) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (code !== 0 || !value.ok) throw new Error(`Read-only WK observer: ${value.error ?? 'failed'}`); done(value.result) } catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
const observerSource = join(root, 'src/native/macos/fixtures/WKSoakObserver.swift')

// A small outer controller verifies the measured Node runner and every recorded
// helper/XPC identity after Node exits. No process-name kill/cleanup is used.
if (!process.argv.includes('--worker')) {
  const observer = join(temporary, 'wk-observer')
  let child, exitCode, verdict
  try {
    await run('/usr/bin/swiftc', ['-parse-as-library', '-swift-version', '5', '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'CoreImage', '-framework', 'CoreMedia', '-module-cache-path', '/private/tmp/qiuya-wk-soak-module-cache', observerSource, '-o', observer], { timeout: 90000 })
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2), '--worker', '--observer', observer], { stdio: 'inherit' })
    exitCode = await new Promise((done, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Owned WK runner exceeded bounded overall deadline')) }, minutes * 60000 + 240000)
      child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('exit', code => { clearTimeout(timer); done(code) })
    })
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
    const ledger = JSON.parse(await readFile(join(output, 'ownership-checkpoint.json'), 'utf8'))
    let after
    const identities = ledger.tracked.filter(item => item.role !== 'controller')
    for (let attempt = 0; attempt < 30; attempt++) { after = await observe(observer, { op: 'check', identities }); if (after.passed) break; await sleep(500) }
    await writeFile(join(output, 'post-run-cleanup-verification.json'), JSON.stringify(after, null, 2))
    verdict = { status: report.status === 'blocked' ? 'blocked' : report.status === 'passed' && exitCode === 0 && report.cleanup?.passed && after.passed ? 'passed' : 'failed',
      runnerStatus: report.status, exitCode, naturalCleanupPassed: after.passed, trackedIdentities: identities.length,
      helperSha256: report.helperSha256, runtimeSha256: report.runtimeSha256, forcedCleanup: false }
  } catch (error) {
    verdict = { status: 'failed', exitCode, error: error.message }; process.exitCode = 1
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      for (let attempt = 0; attempt < 30 && child.exitCode === null && child.signalCode === null; attempt++) await sleep(100)
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); verdict.forcedRunnerTermination = true }
    }
    try {
      const ledger = JSON.parse(await readFile(join(output, 'ownership-checkpoint.json'), 'utf8'))
      const checked = await observe(observer, { op: 'check', identities: ledger.tracked.filter(item => item.role !== 'controller') })
      await writeFile(join(output, 'post-error-cleanup-verification.json'), JSON.stringify(checked, null, 2))
      verdict.postErrorNaturalCleanupPassed = checked.passed
    } catch { verdict.postErrorNaturalCleanupPassed = false }
  }
  finally { await writeFile(join(output, 'delivery-verdict.json'), JSON.stringify(verdict, null, 2)); await rm(temporary, { recursive: true, force: true }) }
  console.log(JSON.stringify({ output, ...verdict }, null, 2)); if (verdict.status !== 'passed') process.exitCode = 1
} else {
  const observer = resolve(arg('--observer')), sessionId = `wk-soak-${randomUUID()}`, reportPath = `/__wk_soak/${randomUUID()}/frames`
  const title = `QiuYaTools WK Soak ${sessionId.slice(-8)}`
  const width = Number(arg('--width', '1280')), height = Number(arg('--height', '720'))
  assert.ok(Number.isSafeInteger(width) && width > 0 && width <= 1600 && Number.isSafeInteger(height) && height > 0 && height <= 1600)
  const receiver = new WKFrameReceiver({ width, height }), routes = new Map(), roots = [], known = new Map()
  const resources = [], generations = [], faults = [], trace = [], nativeArtifacts = []
  let driver, host, fixture, unsubscribe, fatal, report, measurementStart = 0, generation = 0, phase = 'setup', attachmentWrites = 0
  let fixtureReady, fixtureTelemetry, fixtureTickAt, fixtureError = '', fixtureBuffer = '', productionPageSha256
  const mark = (kind, detail = {}) => { trace.push({ atMs: Date.now(), phase, kind, ...detail }); if (trace.length > 4000) trace.shift() }
  const identity = value => ({ pid: value.pid, birthMicros: value.birthMicros, uniqueId: value.uniqueId, path: value.path, role: value.role })
  const key = value => `${value.pid}:${value.birthMicros}:${value.uniqueId}`
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      let bytes = 0; const chunks = []
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 256000) throw new Error('Test HTTP body bound'); chunks.push(chunk) }
      if (path === reportPath && request.method === 'POST') {
        try { receiver.receive(JSON.parse(Buffer.concat(chunks).toString('utf8'))); response.writeHead(200).end('ok') }
        catch (error) { fatal ??= error; response.writeHead(409).end('clock batch rejected') }
        return
      }
      const route = routes.get(path)
      if (!route) { response.writeHead(404).end(); return }
      const result = await route.fetch(new Request(`http://127.0.0.1:${server.address().port}${request.url}`, { method: request.method, ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }))
      let content = Buffer.from(await result.arrayBuffer())
      if (path === '/api/qiuya-tools.computer.preview' && result.ok) {
        productionPageSha256 = createHash('sha256').update(content).digest('hex')
        content = Buffer.from(wkPreviewInstrumentation(content.toString('utf8'), { generation, reportPath }))
        generations.at(-1).instrumentedHtmlSha256 = createHash('sha256').update(content).digest('hex')
      }
      const headers = Object.fromEntries(result.headers); delete headers['content-length']
      response.writeHead(result.status, headers); response.end(content)
    } catch (error) { fatal ??= error; mark('test-http-failure', { method: request.method, message: error.message }); if (!response.headersSent) response.writeHead(500); response.end() }
  })
  async function waitFor(operation, message, timeout = 20000) {
    const until = Date.now() + timeout
    while (Date.now() < until) { if (fatal) throw fatal; const result = await operation(); if (result) return result; await sleep(100) }
    throw new Error(message)
  }
  async function processSnapshot(requireWebKit = true) {
    const value = await observe(observer, { op: 'snapshot', roots, known: [...known.values()], helperPath: companion, requireWebKit })
    for (const row of value.processes) known.set(key(row), identity(row))
    await writeFile(join(output, 'ownership-checkpoint.json'), JSON.stringify({ schemaVersion: 1, tracked: [...known.values()] }, null, 2))
    return value
  }
  async function sample() {
    const value = await processSnapshot()
    const sample = { elapsedMs: measurementStart ? Date.now() - measurementStart : 0, node: process.memoryUsage(), ...value, fixtureTelemetry, fixtureLastTickMsAgo: fixtureTickAt ? Date.now() - fixtureTickAt : null }
    resources.push(sample)
    if (!value.attribution.complete) throw new Error(`Mac WebKit resource attribution incomplete: ${value.attribution.errors.join(',')}`)
    await writeFile(join(output, 'progress.json'), JSON.stringify({ elapsedMs: sample.elapsedMs, statistics: receiver.stats.summary(), resources: sample }, null, 2))
    return value
  }
  async function nativeIdentity(requireWebKit = true) {
    const snapshot = await processSnapshot(requireWebKit)
    const native = snapshot.processes.filter(row => row.role === 'native' && row.parentPid === process.pid && row.path === companion)
    assert.equal(native.length, 1, 'Exactly one live own production companion is required')
    return identity(native[0])
  }
  async function windowEvidence(native, label) {
    const value = await observe(observer, { op: 'window', identities: [native], title, output: join(output, `${label}.jpg`) })
    await writeFile(join(output, `${label}.json`), JSON.stringify(value, null, 2)); return value
  }
  async function hostRpc(op) {
    const route = routes.get('/api/qiuya-tools.computer.control')
    const response = await route.fetch(new Request(`http://127.0.0.1:${server.address().port}/api/qiuya-tools.computer.control`, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'qiuya-tools.computer.control', payload: { op, sessionId } }) }))
    const result = (await response.json()).result
    if (!result?.ok) throw new Error(`Production Host ${op}: ${result?.error?.code ?? 'unknown'}`)
    return result.value
  }
  async function openGeneration() {
    const current = ++generation; receiver.useGeneration(current)
    const artifact = { generation: current, sha256: await hashFile(companion), atMs: Date.now() }; nativeArtifacts.push(artifact)
    assert.equal(artifact.sha256, nativeArtifacts[0].sha256, 'The helper must not change between generations')
    const record = { generation: current, openedAtMs: Date.now() }; generations.push(record)
    await driver.openPreview(`http://127.0.0.1:${server.address().port}/api/qiuya-tools.computer.preview?session=${encodeURIComponent(sessionId)}`, title, sessionId)
    // Pin native/XPC identities even when page startup or the probe fails.
    record.native = await nativeIdentity(false)
    await waitFor(() => receiver.generations.get(current)?.frames >= 6, 'The actual WKWebView did not report six completed clock frames', 30000)
    record.native = await nativeIdentity(); record.window = await windowEvidence(record.native, `native-wk-generation-${current}`)
    record.document = receiver.generations.get(current).document
    assert.equal(record.document.visibility, 'visible')
    return record
  }
  try {
    roots.push({ ...identity(await observe(observer, { op: 'identity', pid: process.pid })), role: 'runner' })
    roots.push({ ...identity(await observe(observer, { op: 'identity', pid: process.ppid })), role: 'controller' })
    await processSnapshot(false)
    const preflight = await observe(observer, { op: 'preflight' }); await writeFile(join(output, 'preflight.json'), JSON.stringify(preflight, null, 2))
    assert.ok(preflight.sessionUnlocked && preflight.sessionOwned && preflight.screenRecording, 'An unlocked owned desktop with capture permission is required')
    const contents = join(temporary, 'QiuYaTools WK Soak Fixture.app', 'Contents')
    await mkdir(join(contents, 'MacOS'), { recursive: true })
    await writeFile(join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.qiuya.tools.wk-soak-fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
    const fixturePath = join(contents, 'MacOS', 'fixture')
    await run('/usr/bin/swiftc', ['-swift-version', '5', '-framework', 'AppKit', '-module-cache-path', '/private/tmp/qiuya-wk-soak-module-cache', join(root, 'src/native/macos/fixtures/SoakFixture.swift'), '-o', fixturePath], { timeout: 90000 })
    fixture = spawn(fixturePath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    fixture.stderr.on('data', chunk => { fixtureError = (fixtureError + chunk.toString()).slice(-2000) })
    fixture.stdin.on('error', () => {})
    fixture.stdout.on('data', chunk => {
      fixtureTickAt = Date.now(); fixtureBuffer += chunk.toString(); if (fixtureBuffer.length > 65536) { fatal ??= new Error('Fixture telemetry bound'); return }
      let end
      while ((end = fixtureBuffer.indexOf('\n')) >= 0) { try { const value = JSON.parse(fixtureBuffer.slice(0, end)); if (value.ready) fixtureReady = value; else fixtureTelemetry = value } catch {} fixtureBuffer = fixtureBuffer.slice(end + 1) }
    })
    await waitFor(() => { if (fixture.exitCode !== null) throw new Error('The owned fixture exited before readiness'); return fixtureReady }, 'Mac soak fixture startup timeout', 15000)
    roots.push({ ...identity(await observe(observer, { op: 'identity', pid: fixture.pid })), role: 'fixture' })
    let runtime = arg('--runtime')
    if (!runtime) {
      runtime = join(temporary, 'runtime.mjs')
      await build({ stdin: { contents: "export {installComputerHost} from './src/features/computer-use/host.ts';export {NativeCompanionDriver} from './src/features/computer-use/native.ts'", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: runtime })
    }
    const runtimeSha256 = await hashFile(resolve(runtime)), { installComputerHost, NativeCompanionDriver } = await import(pathToFileURL(resolve(runtime)).href)
    driver = new NativeCompanionDriver({ executable: companion })
    unsubscribe = driver.subscribe(event => mark('native-event', { event: event.event }))
    const target = (await driver.targets()).find(row => row.pid === fixture.pid)
    assert.ok(target, 'Only this disposable source window may be selected')
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const attachments = { saveImage() { attachmentWrites++; throw new Error('A live preview must not persist images') } }
    host = await installComputerHost({ get: name => name === 'sessions' ? { get: () => ({}) } : name === 'attachments' ? attachments : undefined,
      attachments, webServer: { port: server.address().port }, connection: { browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: url => url,
        fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }, () => true, { driver })
    await host.service.start(sessionId, target.id, { allowOnce: true }); await host.service.pause(sessionId)
    const original = await host.service.preview(sessionId)
    assert.equal(original.width, width); assert.equal(original.height, height)
    await openGeneration()
    // Source/window/decoder warm-up is excluded. The Node-owned accumulator
    // continues across all five restarts; no recovery gap is subtracted.
    measurementStart = Date.now(); receiver.stats.begin(measurementStart); phase = 'capture'
    const until = measurementStart + minutes * 60000
    let nextResource = measurementStart, nextFault = measurementStart + minutes * 60000 / (expectedFaults + 1)
    while (Date.now() < until) {
      if (fatal) throw fatal
      if (Date.now() >= nextResource) { await sample(); nextResource += 30000 }
      if (Date.now() >= nextFault && faults.length < expectedFaults) {
        phase = 'fault'; const old = generations.at(-1), native = await nativeIdentity()
        assert.equal(host.service.get(sessionId).state, 'paused', 'Capture-only testing must not hold an input lease')
        assert.ok(receiver.generations.get(generation).frames > 0)
        const before = await observe(observer, { op: 'identity', pid: native.pid })
        assert.equal(key(before), key(native)); assert.equal(before.path, companion); assert.equal(before.parentPid, process.pid)
        // Kill while the helper and WK page are live. Do not close the view or
        // dispose the driver before fault injection.
        receiver.active = 0; receiver.stats.useGeneration(0)
        const began = Date.now(); mark('controlled-helper-termination', { generation, pid: native.pid, birthMicros: native.birthMicros, uniqueId: native.uniqueId })
        process.kill(native.pid, 'SIGTERM')
        await waitFor(async () => (await observe(observer, { op: 'check', identities: [native] })).passed, 'The terminated owned helper did not exit', 10000)
        await host.service.stop(sessionId); await host.service.start(sessionId, target.id, { allowOnce: true }); await host.service.pause(sessionId)
        const reopened = await openGeneration()
        assert.notEqual(key(reopened.native), key(native), 'Fault recovery must create a new exact native process identity')
        await sample()
        faults.push({ type: 'live-native-helper-termination-explicit-reopen', oldGeneration: old.generation, nextGeneration: generation, atMs: began - measurementStart,
          recoveryMs: Date.now() - began, oldNative: native, oldPageRetired: true, inputReleasedState: host.service.get(sessionId).state })
        nextFault += minutes * 60000 / (expectedFaults + 1); phase = 'capture'
      }
      await sleep(100)
    }
    await sample(); receiver.stats.finish(Date.now()); receiver.active = 0
    const finalWindow = await windowEvidence(await nativeIdentity(), 'native-wk-final')
    const statistics = receiver.stats.summary(), resourceBounds = macResourceVerdict(resources)
    for (const item of generations) item.measuredFrames = receiver.stats.frames.filter(frame => frame[0] === item.generation).length
    const transportFailures = [...receiver.generations.values()].reduce((sum, value) => sum + value.transportFailures, 0)
    report = { status: statistics.endToEndFps >= 10 && statistics.uniqueFps >= 10 && statistics.latencyP95Ms !== null && statistics.latencyP95Ms <= 500 && statistics.invalidTimestamps === 0 && statistics.wrongDimensions === 0 && faults.length === expectedFaults && resourceBounds.passed && attachmentWrites === 0 && transportFailures === 0 ? 'passed' : 'failed',
      kind: 'real-native-macOS-WKWebView-production-canvas-endurance', renderer: 'actual production floating NSPanel WKWebView; no browser surrogate', platform: process.platform, architecture: process.arch,
      minutes, expectedFaults, measurementStartMs: measurementStart, ...statistics, width, height, helperSha256: nativeArtifacts[0].sha256, runtimeSha256, productionPageSha256,
      generations, faults, nativeArtifacts, resources, resourceBounds, attachmentWrites, transportFailures, captureOnlyInputReleased: true, finalWindow,
      frameDefinition: 'Independent source clock pixels decoded only after the production canvas completed draw; unique stamps during the full measurement wall clock; warm-up/retired generations excluded. This is not zero source-frame loss or physical composition latency.',
      instrumentation: 'The loopback test carrier injects the same independent pixel probe used by native WebView2 before the production script, then batches bounded HTTP notifications. Host/capture/preview source/helper are unchanged; this is not an official Harness owner-authentication test.',
      limitations: ['Capture-only animation load; no scroll/drag endurance or in-flight input-stop latency.', 'Source JPEG/canvas backing resolution is asserted independently of the scaled physical NSPanel viewport.', 'Resource totals include the outer Node controller, measured Node, source fixture, metadata/window observers, native helper/guardian and verified WebKit XPC identities. RSS and physical footprint are distinct raw fields.', 'macOS coalition/responsibility SPI is test-only and version-dependent. Missing permission/ambiguous live XPC attribution fails acceptance.'], testedAt: new Date().toISOString() }
    await writeFile(join(output, 'source-bindings.json'), JSON.stringify({ helper: { path: companion, sha256: report.helperSha256 }, runtimeSha256, productionPageSha256,
      files: Object.fromEntries(await Promise.all(['scripts/soak-computer-wkwebview.mjs', 'scripts/computer-wkwebview-soak-evidence.mjs', 'scripts/computer-webview2-soak-evidence.mjs', 'src/native/macos/fixtures/WKSoakObserver.swift', 'src/native/macos/fixtures/SoakFixture.swift'].map(async path => [path, await hashFile(join(root, path))]))) }, null, 2))
  } catch (error) {
    const blocked = !fixture && /preflight|interactive-session|unlocked owned desktop/u.test(error.message)
    report = { status: blocked ? 'blocked' : 'failed', kind: 'real-native-macOS-WKWebView-production-canvas-endurance', reason: error.message, statistics: receiver.stats.summary(), resources, generations, faults, fixtureReady, fixtureTelemetry, fixtureError, testedAt: new Date().toISOString() }; process.exitCode = blocked ? 2 : 1
  }
  finally {
    phase = 'cleanup'; receiver.active = 0; receiver.stats.useGeneration(0)
    const errors = [], forced = []
    try { await processSnapshot(false) } catch (error) { errors.push(`Before-dispose ownership: ${error.message}`) }
    try { await host?.dispose(); if (!host) await driver?.dispose() } catch (error) { errors.push(error.message) }
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      fixture.stdin.end('quit\n')
      for (let attempt = 0; attempt < 50 && fixture.exitCode === null && fixture.signalCode === null; attempt++) await sleep(100)
      if (fixture.exitCode === null && fixture.signalCode === null) { forced.push('owned-fixture'); fixture.kill('SIGTERM') }
    }
    unsubscribe?.(); server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done))
    let checked = { passed: false, results: [] }
    const immediate = [...known.values()].filter(item => !['runner', 'controller'].includes(item.role))
    try { for (let attempt = 0; attempt < 30; attempt++) { checked = await observe(observer, { op: 'check', identities: immediate }); if (checked.passed) break; await sleep(500) } } catch (error) { errors.push(error.message) }
    report.cleanup = { passed: errors.length === 0 && forced.length === 0 && checked.passed, errors, forced, ...checked, runnerDeferredUntilOuterVerification: true }
    report.cleanup.passed = errors.length === 0 && forced.length === 0 && checked.passed
    if (!report.cleanup.passed) report.status = 'failed'
    await writeFile(join(output, 'frame-clock.json'), JSON.stringify(receiver.stats.frames))
    await writeFile(join(output, 'trace.json'), JSON.stringify(trace, null, 2))
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
    await rm(temporary, { recursive: true, force: true })
    if (report.status !== 'passed') process.exitCode = 1
  }
}
