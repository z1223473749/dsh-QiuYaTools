import { chromium } from 'playwright'
import { build } from 'esbuild'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url))
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] }
const minutes = Number(arg('--minutes', '30')), expectedFaults = Number(arg('--faults', '5'))
if (!Number.isSafeInteger(expectedFaults) || expectedFaults < 0 || expectedFaults > 50) throw new Error('--faults must be in [0,50]')
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120) throw new Error('--minutes must be in (0,120]')
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('This runner requires a macOS or Windows interactive desktop')
const windows = process.platform === 'win32'
const output = resolve(arg('--output', `artifacts/computer-use/${windows ? 'windows' : 'macos'}-soak`))
await mkdir(output, { recursive: true })
const temp = await mkdtemp(join(tmpdir(), 'qiuya-soak-'))
const runtime = arg('--runtime')
const compiled = runtime ? undefined : await build({ stdin: { contents: "export {installComputerHost} from './src/features/computer-use/host.ts'; export {NativeCompanionDriver} from './src/features/computer-use/native.ts'", resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'esm' })
const { installComputerHost, NativeCompanionDriver } = await import(runtime ? pathToFileURL(resolve(runtime)).href : `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
let executable, fixtureArgs = []
if (windows) {
  executable = 'powershell.exe'
  fixtureArgs = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', resolve(arg('--fixture', join(root, 'tests/fixtures/windows-soak-fixture.ps1')))]
} else {
  const contents = join(temp, 'QiuYaTools Soak Fixture.app', 'Contents')
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await writeFile(join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.qiuya.tools.soak-fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
  executable = join(contents, 'MacOS', 'fixture')
  await run('/usr/bin/swiftc', ['-swift-version', '5', '-framework', 'AppKit', '-module-cache-path', '/tmp/qiuya-computer-swift-cache', join(root, 'src/native/macos/fixtures/SoakFixture.swift'), '-o', executable])
}
let fixture, browser, host, driver, fixtureTickAt, fixtureTelemetry, fixtureReady, fixtureError = ''
const routes = new Map(), resources = [], pauses = [], faults = [], nativeArtifacts = [], started = Date.now()
const companion = resolve(arg('--native', windows ? join(root, `lib/native/win32-${process.arch}/qiuya-windows.exe`) : join(root, 'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer')))
let attachmentWrites = 0
async function ownedProcesses() {
  if (!windows) {
    const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='])
    return stdout.split('\n').filter(line => line.includes('qiuya-computer') || new RegExp(`^\\s*${process.pid}\\s`).test(line)).map(line => line.trim())
  }
  // A controlled parent termination can orphan a capture/guardian child. Its
  // exact executable belongs to this UUID fixture directory, so retain it even
  // when it is no longer discoverable from the live Node descendant graph.
  const helper = `'${companion.replaceAll("'", "''")}'`
  const code = `$ErrorActionPreference='Stop';$all=@(Get-CimInstance Win32_Process);$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${process.pid});do{$changed=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId)-and $ids.Add([int]$p.ProcessId)){$changed=$true}}}while($changed);$result=@(foreach($p in $all){if($ids.Contains([int]$p.ProcessId)-or $p.ExecutablePath -eq ${helper}){$live=Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue;if($live){@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;name=$p.Name;workingSetBytes=[long]$live.WorkingSet64;cpuSeconds=$live.CPU}}}});ConvertTo-Json -InputObject $result -Compress`
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true })
  return JSON.parse(stdout.trim())
}
async function recordNativeArtifact() { nativeArtifacts.push({ atMs: Date.now(), sha256: createHash('sha256').update(await readFile(companion)).digest('hex') }) }
const server = createServer(async (req, res) => {
  try {
    const route = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (!route) { res.writeHead(404).end(); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const response = await route.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }))
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
  } catch { res.writeHead(500).end() }
})
try {
  fixture = spawn(executable, fixtureArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: windows })
  fixture.stderr.on('data', chunk => { fixtureError = (fixtureError + chunk.toString()).slice(-2000) })
  let fixtureBuffer = ''
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture startup timeout')), windows ? 90000 : 10000)
    timer.unref()
    fixture.once('error', error => { clearTimeout(timer); reject(error) })
    fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited before ready (${code})`)) })
    fixture.stdout.on('data', chunk => {
      fixtureTickAt = Date.now(); fixtureBuffer += chunk.toString()
      let end
      while ((end = fixtureBuffer.indexOf('\n')) >= 0) {
        try {
          fixtureTelemetry = JSON.parse(fixtureBuffer.slice(0, end))
          if (fixtureTelemetry.ready === true) { fixtureReady = fixtureTelemetry; clearTimeout(timer); done() }
        } catch {}
        fixtureBuffer = fixtureBuffer.slice(end + 1)
      }
    })
  })
  if (windows) { assert.ok(fixtureReady.sessionId > 0, 'Fixture must run in an interactive Windows session'); assert.equal(fixtureReady.preventsIdleDisplaySleep, true) }
  await recordNativeArtifact()
  driver = new NativeCompanionDriver({ executable: companion, ...(windows ? { args: ['--computer'] } : {}) })
  const targets = await driver.targets(), target = targets.find(t => t.pid === fixture.pid)
  assert.ok(target, 'Only the disposable endurance fixture may be selected')
  const attachments = { saveImage() { attachmentWrites++; throw new Error('Preview must not persist attachments') } }
  host = await installComputerHost({ get: name => name === 'sessions' ? { get: () => ({}) } : name === 'attachments' ? attachments : undefined, attachments, webServer: { port: 1 }, connection: { browserPeer: { principal: { kind: 'owner' } }, authenticatedUrl: url => url, fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } } }, () => true, { driver })
  await host.service.start('soak', target.id, { allowOnce: true })
  // Capture remains available while paused. A capture-only endurance runner
  // must not reserve the desktop input lock for thirty minutes.
  await host.service.pause('soak')
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  browser = await chromium.launch(windows ? { channel: 'msedge', headless: true } : { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  const page = await browser.newPage()
  await page.addInitScript(() => {
    window.__soak = { frames: 0, invalid: 0, lastStamp: -1, latencies: [], first: 0, last: 0, maxFrameGapMs: 0 }
    document.addEventListener('load', event => {
      const img = event.target
      if (!(img instanceof HTMLImageElement) || !img.naturalWidth) return
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
      const context = canvas.getContext('2d'); context.drawImage(img, 0, 0)
      const scale = img.naturalWidth / 640
      let stamp = 0
      for (let bit = 0; bit < 32; bit++) { const p = context.getImageData(Math.round((28 + bit * 16) * scale), Math.round(32 * scale), 1, 1).data; if (p[0] + p[1] + p[2] > 384) stamp += 2 ** bit }
      const elapsed = ((Date.now() % 2 ** 32) - stamp + 2 ** 32) % 2 ** 32
      if (elapsed > 10000) { window.__soak.invalid++; if (!window.__soak.firstInvalidImage) window.__soak.firstInvalidImage = img.src; return }
      if (stamp === window.__soak.lastStamp) return
      const stats = window.__soak; stats.lastStamp = stamp; stats.frames++; const now = Date.now(); if (stats.last) stats.maxFrameGapMs = Math.max(stats.maxFrameGapMs, now - stats.last); stats.last = now; if (!stats.first) stats.first = stats.last
      stats.latencies.push(elapsed); if (stats.latencies.length > 100000) stats.latencies.shift()
    }, true)
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/api/qiuya-tools.computer.preview?session=soak`)
  await page.waitForFunction(() => window.__soak.frames > 5, { timeout: 20000 })
  const measurementStart = await page.evaluate(() => {
    // Warm-up proves decoding works; it must not inflate the measured FPS.
    // Keep any invalid frames from warm-up visible to the zero-invalid gate.
    const stats = window.__soak
    stats.warmupFrames = stats.frames; stats.frames = 0; stats.latencies = []
    stats.first = 0; stats.last = 0; stats.maxFrameGapMs = 0
    return Date.now()
  }), until = measurementStart + minutes * 60000
  let nextResource = measurementStart, nextFault = measurementStart + minutes * 60000 / (expectedFaults + 1)
  while (Date.now() < until) {
    if (Date.now() >= nextResource) {
      const processes = await ownedProcesses()
      resources.push({ elapsedMs: Date.now() - measurementStart, fixtureExitCode: fixture.exitCode, fixtureLastTickMsAgo: fixtureTickAt ? Date.now() - fixtureTickAt : null, fixtureTelemetry, node: process.memoryUsage(), processes })
      await writeFile(join(output, 'progress.json'), JSON.stringify({ elapsedMs: Date.now() - measurementStart, stats: await page.evaluate(() => ({ ...window.__soak, latencies: undefined, firstInvalidImage: undefined })), resources: resources.at(-1) }, null, 2))
      nextResource += 30000
    }
    if (Date.now() >= nextFault && faults.length < expectedFaults) {
      const before = Date.now(); await host.service.pause('soak'); pauses.push(Date.now() - before)
      // Simulate a terminated companion, then explicitly start a new owner lease.
      let companionPid
      if (windows) companionPid = (await ownedProcesses()).find(item => item.parentPid === process.pid && item.name.toLowerCase() === 'qiuya-windows.exe')?.pid
      else {
        const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,comm='])
        const line = stdout.split('\n').find(line => line.includes('qiuya-computer') && Number(line.trim().split(/\s+/u)[1]) === process.pid)
        companionPid = line && Number(line.trim().split(/\s+/u)[0])
      }
      if (!companionPid) throw new Error('Owned companion PID was not found')
      process.kill(companionPid, 'SIGTERM')
      await new Promise(done => setTimeout(done, 1200))
      await host.service.stop('soak'); await host.service.start('soak', target.id, { allowOnce: true })
      await host.service.pause('soak'); await recordNativeArtifact()
      const state = host.service.get('soak')
      assert.equal(state.state, 'paused', 'Restart must release its temporary input lease')
      faults.push({ type: 'companion-termination-explicit-restart', pid: companionPid, at: Date.now() - measurementStart, inputReleasedState: state.state })
      nextFault += minutes * 60000 / (expectedFaults + 1)
    }
    await new Promise(done => setTimeout(done, 250))
  }
  // Include post-restart ownership/memory even in a 30-second smoke run, whose
  // only periodic sample would otherwise precede its first controlled fault.
  resources.push({ elapsedMs: Date.now() - measurementStart, fixtureExitCode: fixture.exitCode, fixtureLastTickMsAgo: fixtureTickAt ? Date.now() - fixtureTickAt : null, fixtureTelemetry, node: process.memoryUsage(), processes: await ownedProcesses() })
  const stats = await page.evaluate(() => window.__soak)
  if (stats.firstInvalidImage) await writeFile(join(output, 'first-invalid-frame.jpg'), Buffer.from(stats.firstInvalidImage.split(',')[1], 'base64'))
  stats.latencies.sort((a, b) => a - b)
  const fps = (stats.frames - 1) / ((stats.last - stats.first) / 1000), latencyP95 = stats.latencies[Math.floor(stats.latencies.length * 0.95)]
  await page.screenshot({ path: join(output, 'preview.png') })
  const endToEndFps = stats.frames / ((Date.now() - measurementStart) / 1000)
  const resourceBounds = windows ? {
    limits: { nodeRssBytes: 512 * 1024 ** 2, ownedTreeRssBytes: 1536 * 1024 ** 2, directNativeWorkers: 1, nativeTreeProcesses: 4 },
    maxNodeRssBytes: Math.max(...resources.map(sample => sample.node.rss)),
    maxOwnedTreeRssBytes: Math.max(...resources.map(sample => sample.processes.reduce((sum, item) => sum + item.workingSetBytes, 0))),
    maxDirectNativeWorkers: Math.max(...resources.map(sample => sample.processes.filter(item => item.parentPid === process.pid && item.name.toLowerCase() === 'qiuya-windows.exe').length)),
    maxNativeTreeProcesses: Math.max(...resources.map(sample => sample.processes.filter(item => item.name.toLowerCase() === 'qiuya-windows.exe').length)),
  } : undefined
  const resourcesBounded = !resourceBounds || resourceBounds.maxNodeRssBytes <= resourceBounds.limits.nodeRssBytes && resourceBounds.maxOwnedTreeRssBytes <= resourceBounds.limits.ownedTreeRssBytes && resourceBounds.maxDirectNativeWorkers <= resourceBounds.limits.directNativeWorkers && resourceBounds.maxNativeTreeProcesses <= resourceBounds.limits.nativeTreeProcesses
  const result = { status: fps >= 10 && endToEndFps >= 10 && latencyP95 <= 500 && stats.invalid === 0 && faults.length === expectedFaults && attachmentWrites === 0 && resourcesBounded ? 'passed' : 'failed', kind: 'native-capture-through-real-Chromium-preview', renderer: windows ? 'installed Microsoft Edge headless; shared production preview frontend (not native WebView2 renderer)' : 'installed Google Chrome headless; shared production preview frontend', platform: process.platform, architecture: process.arch, fixtureReady, minutes, elapsedMs: Date.now() - measurementStart, frames: stats.frames, uniqueFps: fps, endToEndFps, maxFrameGapMs: stats.maxFrameGapMs, latencyP95Ms: latencyP95, invalidTimestamps: stats.invalid, idlePauseAckMs: pauses, faults, resources, resourceBounds, resourcesBounded, nativeArtifacts, captureOnlyInputReleased: true, attachmentWrites, attachmentEvidence: 'Host attachment service spy; no Agent tools or attachment renderer in this capture-only run', limitations: ['This capture endurance test does not claim in-flight input-stop latency or scroll/drag endurance; native E2E covers correctness separately.', ...(windows ? ['Edge exercises the shared preview frontend; native WebView2 floating-window controls are covered separately.'] : [])], testedAt: new Date().toISOString() }
  result.warmupFramesExcluded = stats.warmupFrames
  result.frameDefinition = 'Unique source clock timestamps decoded after image load and canvas draw; repeated stamps are excluded. Invalid means a decoded clock is more than 10 seconds behind or in the future. Max gap includes planned companion outage; this does not claim zero dropped source frames or physical display composition latency.'
  await writeFile(join(output, 'report.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result, resources: `${resources.length} samples` }, null, 2))
  if (result.status !== 'passed') process.exitCode = 1
} catch (error) { await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'failed', elapsedMs: Date.now() - started, reason: error.message, fixtureReady, fixtureExitCode: fixture?.exitCode, fixtureSignalCode: fixture?.signalCode, fixtureLastTickMsAgo: fixtureTickAt ? Date.now() - fixtureTickAt : null, fixtureError, resources }, null, 2)); console.error(error.message); process.exitCode = 1 }
finally {
  const cleanup = await Promise.allSettled([host ? host.dispose() : driver?.dispose(), browser?.close()])
  if (fixture) {
    fixture.stdin.on('error', () => {}); fixture.stdin.end('quit\n')
    if (fixture.exitCode === null && fixture.signalCode === null) await Promise.race([new Promise(done => fixture.once('exit', done)), new Promise(done => setTimeout(done, 3000))])
    if (fixture.exitCode === null && fixture.signalCode === null) {
      if (windows) await run('taskkill.exe', ['/PID', String(fixture.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }).catch(() => {})
      else fixture.kill()
    }
    fixture.stdout.destroy(); fixture.stderr.destroy(); fixture.stdin.destroy()
  }
  server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done)); await rm(temp, { recursive: true, force: true })
  if (cleanup.some(result => result.status === 'rejected')) {
    const failed = cleanup.filter(result => result.status === 'rejected').map(result => String(result.reason))
    await writeFile(join(output, 'cleanup-error.json'), JSON.stringify({ failed }, null, 2))
    const reportPath = join(output, 'report.json'), report = JSON.parse(await readFile(reportPath, 'utf8'))
    await writeFile(reportPath, JSON.stringify({ ...report, status: 'failed', cleanupFailures: failed }, null, 2)); process.exitCode = 1
  }
}
