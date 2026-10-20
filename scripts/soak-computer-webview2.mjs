/** Windows-only: real native WebView2, production capture/Host/canvas, no Edge launcher. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebViewClockAccumulator, createWebViewOwnershipTracker, installWebViewClockProbe, sameWindowsProcessIdentity, windowsProcessSnapshotCommand, windowsPinnedProcessCommand } from './computer-webview2-soak-evidence.mjs'

const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url))
const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1] }
const minutes = Number(arg('--minutes', '30')), expectedFaults = Number(arg('--faults', '5'))
assert.equal(process.platform, 'win32', 'This runner needs an interactive Windows desktop')
assert.ok(Number.isFinite(minutes) && minutes > 0 && minutes <= 120)
assert.ok(Number.isSafeInteger(expectedFaults) && expectedFaults >= 0 && expectedFaults <= 50)
const output = resolve(arg('--output', 'artifacts/computer-use/windows-webview2-720p-soak'))
const companion = resolve(arg('--native', join(root, `lib/native/win32-${process.arch}/qiuya-windows.exe`)))
const runtime = resolve(arg('--runtime'))
const fixturePath = resolve(arg('--fixture', join(root, 'tests/fixtures/windows-webview2-soak-fixture.ps1')))
await mkdir(output, { recursive: true })
const temporary = await mkdtemp(join(tmpdir(), `qiuya-webview2-soak-${randomUUID()}-`))
const nativeData = join(temporary, 'native-webview2'), sessionId = `soak-${randomUUID()}`
const originalEnvironment = { arguments: process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, data: process.env.QIUYA_TOOLS_NATIVE_DATA_DIR }
process.env.QIUYA_TOOLS_NATIVE_DATA_DIR = nativeData
const { installComputerHost, NativeCompanionDriver } = await import(pathToFileURL(runtime).href)
const stats = new WebViewClockAccumulator(), track = createWebViewOwnershipTracker()
const routes = new Map(), resources = [], faults = [], generations = [], trace = [], identities = new Map(), nativeArtifacts = []
const server = createServer(async (request, response) => {
  try {
    const route = routes.get(new URL(request.url, 'http://127.0.0.1').pathname)
    if (!route) return response.writeHead(404).end()
    const chunks = []; let size = 0
    for await (const chunk of request) { size += chunk.length; if (size > 256000) throw new Error('Test RPC body limit exceeded'); chunks.push(chunk) }
    const result = await route.fetch(new Request(`http://127.0.0.1${request.url}`, { method: request.method, ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }))
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()))
  } catch { response.writeHead(500).end() }
})
let fixture, fixtureReady, fixtureTelemetry, fixtureBuffer = '', fixtureError = '', fixtureTickAt = 0
const oraclePending = new Map(); let oracleSequence = 0
let driver, host, page, unsubscribe, fatal, phase = 'setup', generation = 0, measurementStart = 0, report, attachmentWrites = 0
const mark = (kind, detail = {}) => { trace.push({ atMs: Date.now(), elapsedMs: measurementStart ? Date.now() - measurementStart : null, phase, kind, ...detail }); if (trace.length > 4000) trace.shift() }
const snapshot = () => { const value = host?.service.get(sessionId); return value ? { state: value.state, epoch: value.epoch } : null }
const quote = value => `'${value.replaceAll("'", "''")}'`
async function powershell(code) {
  const encoded = Buffer.from(code, 'utf16le').toString('base64')
  assert.ok(encoded.length < 30000, 'Direct Windows command exceeds its bounded command-line budget')
  return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
}
async function snapshotRows() {
  // Command lines are inspected only to match this UUID's WebView2 directory;
  // they and unrelated executable paths are never included in evidence.
  return JSON.parse(await powershell(windowsProcessSnapshotCommand(nativeData, { fixturePath })))
}
async function ownedProcesses() {
  const rows = await snapshotRows(), owned = track(rows, process.pid, companion)
  for (const item of owned) {
    const row = rows.find(row => row.pid === item.pid)
    identities.set(`${item.pid}:${item.createdAtTicks}`, { pid: item.pid, createdAtTicks: item.createdAtTicks, name: item.name, expectedExecutablePath: row.executablePath })
  }
  const runner = [...identities.values()].find(item => item.pid === process.pid)
  if (!runner?.expectedExecutablePath) throw new Error('Owned runner executable identity was unavailable')
  // An atomic early ledger survives a killed Node runner before finally executes.
  const ledger = { schemaVersion: 1, runner, companion, fixturePath, nativeData, temporaryRoot: temporary, tracked: [...identities.values()] }
  const checkpoint = join(output, 'ownership-checkpoint.next.json')
  await writeFile(checkpoint, JSON.stringify(ledger)); await rename(checkpoint, join(output, 'ownership-checkpoint.json'))
  return { rows, owned }
}
async function waitFor(operation, description, timeout = 20000, allowFatal = false) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (fatal && !allowFatal) throw fatal; const result = await operation(); if (result) return result; await new Promise(done => setTimeout(done, 100)) }
  throw new Error(description)
}
async function recordNative() {
  const hash = createHash('sha256'); for await (const bytes of createReadStream(companion)) hash.update(bytes)
  nativeArtifacts.push({ atMs: Date.now(), sha256: hash.digest('hex') })
}
async function terminateOwnedNative(identity) {
  // Pin the process handle before checking its birth/path; Kill then uses that
  // same Process object, rather than sending a signal to an unchecked reused PID.
  await powershell(`$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById(${identity.pid});try{$null=$p.SafeHandle;if($p.StartTime.ToUniversalTime().Ticks.ToString()-ne ${quote(identity.createdAtTicks)} -or $p.MainModule.FileName -ine ${quote(companion)}){throw 'Owned native identity changed before controlled termination'};$p.Kill();if(!$p.WaitForExit(5000)){throw 'Owned native parent did not exit'}}finally{$p.Dispose()}`)
}
function readOwnedWindow(identity) {
  const requestId = `window-${++oracleSequence}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { oraclePending.delete(requestId); reject(new Error('Owned window oracle deadline')) }, 5000)
    oraclePending.set(requestId, { resolve, reject, timer })
    fixture.stdin.write(`oracle|${requestId}|${identity.pid}|${identity.createdAtTicks}|${Buffer.from(companion).toString('base64')}\n`, error => {
      if (error) { clearTimeout(timer); oraclePending.delete(requestId); reject(new Error('Owned window oracle unavailable')) }
    })
  })
}
async function preserveInvalidImage(connection) {
  const invalid = await connection?.evaluate('window.__qytWebViewClockProbe?.firstInvalidImage')
  if (invalid) await writeFile(join(output, `first-invalid-generation-${generation}.jpg`), Buffer.from(invalid.split(',')[1], 'base64'))
}
async function freeCdpPort() {
  const socket = createServer(); await new Promise((done, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', done) })
  const port = socket.address().port; await new Promise(done => socket.close(done)); return port
}
async function jsonAt(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1500) })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`CDP readiness HTTP ${response.status}`) }
  const parts = []; let size = 0
  for await (const chunk of response.body) { size += chunk.length; if (size > 262144) throw new Error('CDP metadata limit exceeded'); parts.push(chunk) }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}
class PageCDP {
  constructor(socket, onFrame, onLost) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.closed = false; this.closing = false
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 16 * 1024 * 1024) throw new Error('CDP message bound exceeded')
        const value = JSON.parse(event.data)
        if (value.id !== undefined) {
          const pending = this.pending.get(value.id); if (!pending) return
          this.pending.delete(value.id); clearTimeout(pending.timer)
          value.error ? pending.reject(new Error(`CDP command failed: ${pending.method}`)) : pending.resolve(value.result)
        } else if (value.method === 'Runtime.bindingCalled' && value.params?.name === '__qytSoakFrame') {
          if (value.params.payload.length > 2048) throw new Error('CDP clock message limit exceeded')
          onFrame(JSON.parse(value.params.payload))
        }
      } catch (error) { onLost(error) }
    })
    const lost = () => {
      this.closed = true
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Owned native WebView2 CDP closed')) }
      this.pending.clear(); if (!this.closing) onLost(new Error('Owned native WebView2 CDP closed unexpectedly'))
    }
    socket.addEventListener('close', lost); socket.addEventListener('error', lost)
  }
  static async connect(url, onFrame, onLost) {
    const socket = new WebSocket(url)
    await new Promise((done, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('Native WebView2 CDP connection timeout')) }, 10000)
      socket.addEventListener('open', () => { clearTimeout(timeout); done() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Native WebView2 CDP connection failed')) }, { once: true })
    })
    return new PageCDP(socket, onFrame, onLost)
  }
  command(method, params = {}) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Native WebView2 CDP is closed'))
    if (this.pending.size >= 32) return Promise.reject(new Error('CDP pending command bound exceeded'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP deadline: ${method}`)) }, 15000)
      this.pending.set(id, { resolve, reject, timer, method })
      try { this.socket.send(JSON.stringify({ id, method, params })) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  async evaluate(expression) {
    const reply = await this.command('Runtime.evaluate', { expression, returnByValue: true })
    if (reply.exceptionDetails) throw new Error('Owned WebView2 probe evaluation failed')
    return reply.result?.value
  }
  async close() {
    this.closing = true
    if (this.closed) return
    this.socket.close()
    await waitFor(() => this.closed, 'Native WebView2 CDP detach timeout', 3000, true)
  }
}
async function hostRpc(op) {
  const route = routes.get('/api/qiuya-tools.computer.control')
  const response = await route.fetch(new Request(`http://127.0.0.1:${server.address().port}/api/qiuya-tools.computer.control`, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'qiuya-tools.computer.control', payload: { op, sessionId } }) }))
  const result = (await response.json()).result
  if (!result?.ok) throw new Error(`Production Host ${op} failed: ${result?.error?.code ?? 'unknown'}`)
  return result.value
}
async function openNativeGeneration(port) {
  const current = ++generation; stats.useGeneration(current)
  await hostRpc('preview')
  const origin = `http://127.0.0.1:${server.address().port}`
  let target
  await waitFor(async () => {
    try {
      const targets = await jsonAt(`http://127.0.0.1:${port}/json/list`)
      target = targets.find(value => { try { const url = new URL(value.url); return value.type === 'page' && url.origin === origin && url.pathname === '/api/qiuya-tools.computer.preview' && url.searchParams.get('session') === sessionId } catch { return false } })
      return target
    } catch { return false }
  }, 'This owned native WebView2 page did not expose its test CDP endpoint', 30000)
  const socketUrl = new URL(target.webSocketDebuggerUrl)
  assert.equal(socketUrl.protocol, 'ws:'); assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(socketUrl.hostname)); assert.equal(Number(socketUrl.port), port)
  const { rows, owned } = await ownedProcesses()
  const listeners = JSON.parse(await powershell(`$ErrorActionPreference='Stop';ConvertTo-Json -InputObject @(Get-NetTCPConnection -State Listen -LocalPort ${port}|ForEach-Object{@{pid=[int]$_.OwningProcess;address=$_.LocalAddress}}) -Compress`))
  assert.ok(listeners.length && listeners.every(item => ['127.0.0.1', '::1'].includes(item.address)), 'Test debugger must listen on loopback only')
  const listener = rows.find(item => listeners.some(value => value.pid === item.pid) && item.ownedWebView === true && item.name.toLowerCase() === 'msedgewebview2.exe')
  assert.ok(listener, 'The debugger must belong to this UUID native WebView2 data directory')
  const native = owned.find(item => item.parentPid === process.pid && item.name.toLowerCase() === 'qiuya-windows.exe')
  assert.ok(native, 'Production native companion identity is required')
  const window = await readOwnedWindow(native)
  assert.ok(window.ok && window.exactHelperIdentity && window.visible && !window.iconic && window.topmost, 'The actual native floating Form must be visible and topmost')
  assert.equal(owned.some(item => item.name.toLowerCase() === 'msedge.exe'), false, 'This mode must not launch Edge as a surrogate')
  const record = { generation: current, port, native: { pid: native.pid, createdAtTicks: native.createdAtTicks, cimCreatedAtTicks: native.cimCreatedAtTicks, identityPrecision: native.identityPrecision, sha256: nativeArtifacts.at(-1).sha256 }, webviewBrowser: { pid: listener.pid, createdAtTicks: listener.createdAtTicks, identityPrecision: listener.identityPrecision }, window: { stage: 'first-read-after-open-ACK-before-CDP-attachment', ...window }, cdpTargetId: target.id, attachedAtMs: Date.now(), frames: 0 }
  generations.push(record)
  const connection = await PageCDP.connect(socketUrl.href, event => {
    try { assert.equal(event.generation, current); if (stats.accept(current, event)) record.frames++ }
    catch (error) { fatal ??= error }
  }, error => { mark('cdp-disconnected', { generation: current }); if (phase === 'capture' && current === generation) fatal ??= error })
  page = connection
  await connection.command('Runtime.enable')
  await connection.command('Runtime.addBinding', { name: '__qytSoakFrame' })
  const installed = await connection.evaluate(`(${installWebViewClockProbe.toString()})(${JSON.stringify({ bindingName: '__qytSoakFrame', generation: current })})`)
  assert.equal(installed.installed, true)
  record.document = await connection.evaluate('({visibility:document.visibilityState,width:innerWidth,height:innerHeight,devicePixelRatio})')
  assert.equal(record.document.visibility, 'visible')
  record.version = await jsonAt(`http://127.0.0.1:${port}/json/version`).then(value => ({ browser: value.Browser, protocol: value['Protocol-Version'] }))
  mark('native-preview-attached', { generation: current, pid: native.pid, snapshot: snapshot() })
  return record
}
async function sample() {
  const { owned } = await ownedProcesses()
  const window = await readOwnedWindow(generations.at(-1).native)
  assert.ok(window.ok && window.visible && !window.iconic && window.topmost, 'Owned native preview lost its visible/topmost state')
  const row = { elapsedMs: Date.now() - measurementStart, fixtureExitCode: fixture.exitCode, fixtureLastTickMsAgo: fixtureTickAt ? Date.now() - fixtureTickAt : null, fixtureTelemetry, window, node: process.memoryUsage(), processes: owned }
  resources.push(row)
  await writeFile(join(output, 'progress.json'), JSON.stringify({ measurementStartMs: measurementStart, elapsedMs: row.elapsedMs, stats: stats.summary(), resources: row }, null, 2))
}
try {
  // Persist the UUID ownership boundary before starting any native GUI child.
  await ownedProcesses()
  fixture = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', fixturePath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  fixture.stderr.on('data', chunk => { fixtureError = (fixtureError + chunk.toString()).slice(-2000) })
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('720p fixture startup timeout')), 90000)
    fixture.once('error', error => { clearTimeout(timer); reject(error) })
    fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`720p fixture exited before ready (${code})`)) })
    fixture.stdout.on('data', chunk => {
      fixtureTickAt = Date.now(); fixtureBuffer += chunk.toString()
      let end
      while ((end = fixtureBuffer.indexOf('\n')) >= 0) {
        try {
          const value = JSON.parse(fixtureBuffer.slice(0, end))
          if (value.oracle) { const pending = oraclePending.get(value.oracle); if (pending) { oraclePending.delete(value.oracle); clearTimeout(pending.timer); pending.resolve(value) } }
          else { fixtureTelemetry = value; if (fixtureTelemetry.ready) { fixtureReady = fixtureTelemetry; clearTimeout(timer); done() } }
        } catch {}
        fixtureBuffer = fixtureBuffer.slice(end + 1)
      }
      if (fixtureBuffer.length > 4096) fixtureBuffer = ''
    })
  })
  assert.equal(fixtureReady.width, 1280); assert.equal(fixtureReady.height, 720)
  assert.ok(fixtureReady.sessionId > 0 && fixtureReady.preventsIdleDisplaySleep)
  await ownedProcesses()
  await recordNative()
  let port = await freeCdpPort()
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`
  driver = new NativeCompanionDriver({ executable: companion, args: ['--computer'] })
  unsubscribe = driver.subscribe(event => mark('native-event', { event: event.event, snapshot: snapshot() }))
  const target = (await driver.targets()).find(item => item.pid === fixture.pid)
  assert.ok(target, 'Only this runner\'s source fixture may be observed')
  const initial = await driver.observe(target.id)
  assert.equal(initial.width, 1280); assert.equal(initial.height, 720)
  await writeFile(join(output, 'source-initial.jpg'), Buffer.from(initial.imageBase64, 'base64'))
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const attachments = { saveImage() { attachmentWrites++; throw new Error('Continuous native preview must not write attachments') } }
  host = await installComputerHost({ get: name => name === 'sessions' ? { get: () => ({}) } : name === 'attachments' ? attachments : undefined, attachments, webServer: { port: server.address().port }, connection: { browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: url => url, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }, () => true, { driver })
  await host.service.start(sessionId, target.id, { allowOnce: true }); await host.service.pause(sessionId)
  await openNativeGeneration(port)
  await waitFor(() => stats.frames.length > 5, 'Native WebView2 did not draw valid 720p clock frames', 30000)
  measurementStart = Date.now(); stats.begin(measurementStart); for (const item of generations) item.frames = 0; phase = 'capture'
  const until = measurementStart + minutes * 60000
  let nextResource = measurementStart, nextFault = measurementStart + minutes * 60000 / (expectedFaults + 1)
  while (Date.now() < until) {
    if (fatal) throw fatal
    assert.equal(fixture.exitCode, null, 'Owned animation source exited during measurement')
    if (Date.now() >= nextResource) { await sample(); nextResource += 30000 }
    if (Date.now() >= nextFault && faults.length < expectedFaults) {
      phase = 'fault-pause'; mark('fault-pause', { snapshot: snapshot() }); await host.service.pause(sessionId)
      // Flush the old page's already completed binding notifications before
      // terminating its actual host. The Node accumulator survives the page.
      await page.evaluate('Date.now()')
      await preserveInvalidImage(page)
      const old = generations.at(-1), { owned } = await ownedProcesses()
      const retiring = owned.filter(item => ['qiuya-windows.exe', 'msedgewebview2.exe'].includes(item.name.toLowerCase()))
      assert.ok(retiring.some(item => item.pid === old.native.pid && item.createdAtTicks === old.native.createdAtTicks))
      phase = 'fault-kill'; mark('controlled-companion-termination', { generation: old.generation, pid: old.native.pid })
      await terminateOwnedNative(old.native)
      await page.close(); page = null; stats.useGeneration(0)
      await waitFor(async () => {
        const { rows } = await ownedProcesses()
        return retiring.every(item => !rows.some(row => sameWindowsProcessIdentity(row, item)))
      }, 'Old native/WebView2 generation did not retire after its parent was terminated', 15000)
      old.retiredAtMs = Date.now(); old.retirementConfirmed = true
      phase = 'fault-restart'; await host.service.stop(sessionId)
      port = await freeCdpPort(); process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`
      await host.service.start(sessionId, target.id, { allowOnce: true }); await host.service.pause(sessionId)
      assert.equal(host.service.get(sessionId).state, 'paused')
      await recordNative(); await openNativeGeneration(port)
      faults.push({ type: 'native-parent-kill-preview-destroyed-explicit-reopen-CDP-reconnect', generation: old.generation, pid: old.native.pid, at: Date.now() - measurementStart, oldGenerationRetired: true, inputReleasedState: 'paused' })
      mark('fault-recovered', { generation, snapshot: snapshot() }); phase = 'capture'
      nextFault += minutes * 60000 / (expectedFaults + 1)
    }
    await new Promise(done => setTimeout(done, 100))
  }
  stats.finish(Date.now()); phase = 'final-evidence'
  await sample()
  await preserveInvalidImage(page)
  const screenshot = await page.command('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(output, 'native-webview2-page.png'), Buffer.from(screenshot.data, 'base64'))
  const measured = stats.summary(), limits = { nodeRssBytes: 512 * 1024 ** 2, ownedTreeRssBytes: 1536 * 1024 ** 2, directNativeWorkers: 1, nativeTreeProcesses: 4 }
  const resourceBounds = { limits, maxNodeRssBytes: Math.max(...resources.map(row => row.node.rss)), maxOwnedTreeRssBytes: Math.max(...resources.map(row => row.processes.reduce((sum, item) => sum + item.workingSetBytes, 0))), maxDirectNativeWorkers: Math.max(...resources.map(row => row.processes.filter(item => item.parentPid === process.pid && item.name.toLowerCase() === 'qiuya-windows.exe').length)), maxNativeTreeProcesses: Math.max(...resources.map(row => row.processes.filter(item => item.name.toLowerCase() === 'qiuya-windows.exe').length)) }
  const resourcesBounded = resourceBounds.maxNodeRssBytes <= limits.nodeRssBytes && resourceBounds.maxOwnedTreeRssBytes <= limits.ownedTreeRssBytes && resourceBounds.maxDirectNativeWorkers <= limits.directNativeWorkers && resourceBounds.maxNativeTreeProcesses <= limits.nativeTreeProcesses
  report = { status: measured.uniqueFps >= 10 && measured.endToEndFps >= 10 && measured.latencyP95Ms !== null && measured.latencyP95Ms <= 500 && measured.invalidTimestamps === 0 && measured.wrongDimensions === 0 && faults.length === expectedFaults && generations.length === expectedFaults + 1 && generations.every(item => item.frames > 0) && attachmentWrites === 0 && resourcesBounded ? 'passed' : 'failed', kind: 'real-native-WebView2-production-preview-720p-endurance', renderer: 'Actual WinForms WebView2 in the production qiuya-windows.exe; CDP observes this native window, no Edge browser surrogate', platform: process.platform, architecture: process.arch, minutes, ...measured, fixtureReady, sourcePixels: { width: 1280, height: 720 }, resourcesBounded, resourceBounds, resources, faults, generations, nativeArtifacts, attachmentWrites, captureOnlyInputReleased: true,
    attachmentEvidence: 'Host attachment service spy, not an actual SDK database write counter',
    frameDefinition: 'Unique 32-bit source epoch-ms clock decoded independently from production canvas pixels after completed draw. Repeated stamps are excluded. Invalid means >10s old/future; zero invalid does not mean zero dropped source frames. Recovery gaps remain in wall-clock FPS.',
    resourceAttribution: 'Same-snapshot PID+birth and descendant birth ordering; exact UUID helper path, UUID WebView2 data-directory membership and retained PID+birth identities keep orphan workers in scope. Sampling PowerShell/conhost remain included; snapshots do not observe every instantaneous peak.',
    limitations: ['720p is the source/captured JPEG/canvas backing size. The actual 600x420 native floating Form may display it scaled; this does not claim a 1280x720 physical viewport.', 'Source animation/capture/display endurance only; no scroll/drag input workload or held-input stop-latency claim.', 'The production Host and preview are bundled from the recorded source with a test-only owner carrier. Actual Harness SDK authentication/package integration has separate E2E evidence.', 'The debugger is enabled only for this disposable test process/data directory; no production flags, registry, user profile or firewall are changed.'], testedAt: new Date().toISOString() }
} catch (error) {
  stats.finish(Date.now())
  phase = 'failed'; mark('failure', { code: error.code ?? 'test-failed' })
  report = { status: 'failed', kind: 'real-native-WebView2-production-preview-720p-endurance', reason: error.message, ...stats.summary(), fixtureReady, fixtureTelemetry, fixtureExitCode: fixture?.exitCode, fixtureLastTickMsAgo: fixtureTickAt ? Date.now() - fixtureTickAt : null, fixtureError, faults, generations, resources, nativeArtifacts, attachmentWrites }
  process.exitCode = 1
} finally {
  phase = 'cleanup'; const errors = []
  // Include a helper/WebView started during setup even if CDP never became ready.
  try { await ownedProcesses() } catch (error) { errors.push(error.message) }
  const tracked = [...identities.values()].filter(item => item.pid !== process.pid)
  for (const operation of [() => page?.close(), () => host ? host.dispose() : driver?.dispose()]) { try { await operation() } catch (error) { errors.push(error.message) } }
  if (fixture) {
    fixture.stdin.on('error', () => {}); fixture.stdin.end('quit\n')
    try { await waitFor(() => fixture.exitCode !== null || fixture.signalCode !== null, 'Source fixture did not exit on EOF', 5000, true) }
    catch (error) {
      errors.push(error.message)
      const identity = tracked.find(item => item.pid === fixture.pid)
      if (!identity?.expectedExecutablePath) errors.push('Fixture cleanup exact identity was unavailable; no PID-based termination attempted')
      else {
        try {
          const forced = JSON.parse(await powershell(windowsPinnedProcessCommand([identity], { terminate: true })))
          await writeFile(join(output, 'fixture-forced-cleanup.json'), JSON.stringify(forced, null, 2))
          if (!forced.passed) errors.push('Pinned fixture fallback cleanup failed')
        } catch (failure) { errors.push(failure.message) }
      }
    }
    fixture.stdout.destroy(); fixture.stderr.destroy(); fixture.stdin.destroy()
  }
  for (const pending of oraclePending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Owned fixture oracle closed')) }
  oraclePending.clear()
  unsubscribe?.()
  // Capture any disposable release/guardian child created by shutdown as well.
  try { await ownedProcesses(); for (const item of identities.values()) if (item.pid !== process.pid && !tracked.some(row => row.pid === item.pid && row.createdAtTicks === item.createdAtTicks)) tracked.push(item) } catch (error) { errors.push(error.message) }
  let remaining = [], retirementVerified = false
  try {
    await waitFor(async () => { const rows = await snapshotRows(); remaining = tracked.filter(item => rows.some(row => sameWindowsProcessIdentity(row, item))); return !remaining.length }, 'Owned WebView2/native/source process identities remained after cleanup', 15000, true)
    retirementVerified = true
  } catch (error) { errors.push(error.message) }
  const naturallyRemaining = [...remaining]
  if (remaining.length) {
    // Cleanup failure still fails the run. Retire only previously verified
    // PID+birth identities so a failed probe cannot leave orphan WebViews.
    try {
      const forced = JSON.parse(await powershell(windowsPinnedProcessCommand(remaining, { terminate: true })))
      await writeFile(join(output, 'remaining-forced-cleanup.json'), JSON.stringify(forced, null, 2))
      if (!forced.passed) errors.push('Pinned owned-process fallback cleanup failed')
    } catch (error) { errors.push(error.message) }
    try { const rows = await snapshotRows(); remaining = tracked.filter(item => rows.some(row => sameWindowsProcessIdentity(row, item))); retirementVerified = !remaining.length } catch (error) { errors.push(error.message) }
  }
  server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done))
  if (originalEnvironment.arguments === undefined) delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS; else process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = originalEnvironment.arguments
  if (originalEnvironment.data === undefined) delete process.env.QIUYA_TOOLS_NATIVE_DATA_DIR; else process.env.QIUYA_TOOLS_NATIVE_DATA_DIR = originalEnvironment.data
  // Leave a failed, still-owned profile for diagnosis rather than guessing away
  // an active WebView2 data directory or hiding a cleanup failure.
  if (retirementVerified && !remaining.length) await rm(temporary, { recursive: true, force: true }).catch(error => errors.push(error.code ?? 'temporary-cleanup-failed'))
  if (errors.length) { report.status = 'failed'; report.cleanupFailures = errors; process.exitCode = 1 }
  report.cleanup = { passed: !errors.length, trackedIdentities: tracked.length, retirementVerified, naturallyRemaining, remaining }
  await writeFile(join(output, 'cleanup-verification.json'), JSON.stringify({ tracked, naturallyRemaining, remaining, retirementVerified, passed: !errors.length }, null, 2))
  await writeFile(join(output, 'frame-clock.json'), JSON.stringify({ columns: ['generation', 'sourceStamp32', 'renderCompletedEpochMs', 'latencyMs'], measurementStartMs: measurementStart, measurementEndMs: stats.end, frames: stats.frames }))
  await writeFile(join(output, 'fault-trace.json'), JSON.stringify({ events: trace }, null, 2))
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, frames: report.frames, elapsedMs: report.elapsedMs, endToEndFps: report.endToEndFps, latencyP95Ms: report.latencyP95Ms, invalid: report.invalidTimestamps, faults: faults.length, cleanup: report.cleanup }, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
}
