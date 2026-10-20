import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

if (process.platform !== 'darwin') { console.log(JSON.stringify({ status: 'skipped', reason: 'platform' })); process.exit(0) }
const helper = fileURLToPath(new URL('../lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'qiuya-computer-e2e-'))
const evidenceFlag = process.argv.indexOf('--evidence-dir')
const evidenceDirectory = evidenceFlag < 0 ? undefined : process.argv[evidenceFlag + 1]
if (evidenceFlag >= 0 && !evidenceDirectory) throw new Error('--evidence-dir requires a directory')
async function report(result) {
  if (evidenceDirectory) {
    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(join(evidenceDirectory, 'report.json'), JSON.stringify({ ...result, testedAt: new Date().toISOString(), architecture: process.arch }, null, 2) + '\n')
  }
  console.log(JSON.stringify(result, null, 2))
}
const native = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, QIUYA_TOOLS_PARENT_PID: String(process.pid) } })
native.stderr.resume()
const pending = new Map(); let nextId = 0; let fixture; let fixtureLines
const nativeLines = createInterface({ input: native.stdout })
let previewLoaded = false, previewPaused = false, previewPauseError, currentEpoch = 2
const previewServer = createServer(async (incoming, response) => {
  if (incoming.url === '/pause') {
    try { await ok('release', { epoch: currentEpoch }); previewPaused = true; response.writeHead(200); response.end('paused') }
    catch (error) { previewPauseError = error; response.writeHead(500); response.end('failed') }
    return
  }
  previewLoaded = true
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.end('<!doctype html><style>body{margin:0;background:#123;color:white;font:16px system-ui}button{position:absolute;left:16px;top:16px;width:108px;height:36px}</style><button onclick="fetch(\'/pause\')">Pause fixture</button><p style="padding:90px 20px">Disposable QiuYaTools floating-preview fixture</p>')
})
nativeLines.on('line', line => {
  let value; try { value = JSON.parse(line) } catch { return }
  if (value.event === 'humanInput' && value.reason === 'preview-pointer') { previewPaused = true; return }
  const job = pending.get(value.requestId)
  if (job) { clearTimeout(job.timer); pending.delete(value.requestId); job.resolve(value) }
})
function request(op, payload = {}) {
  const requestId = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Native ${op} timed out`)) }, 15_000)
    pending.set(requestId, { resolve, reject, timer })
    native.stdin.write(JSON.stringify({ requestId, op, ...payload }) + '\n')
  })
}
async function ok(op, payload) {
  const response = await request(op, payload)
  assert.equal(response.ok, true, `${op}: ${JSON.stringify(response.error)}`)
  return response.result
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' }); child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
})
try {
  const status = await ok('status')
  const badURL = await request('openPreview', { url: 'https://example.com/', sessionId: 'fixture', title: 'fixture' })
  assert.equal(badURL.ok, false); assert.equal(badURL.error.code, 'INVALID_PREVIEW_URL')
  await ok('lease', { epoch: 1 }); await ok('release', { epoch: 1 })
  const staleLease = await request('lease', { epoch: 1 })
  assert.equal(staleLease.ok, false); assert.equal(staleLease.error.code, 'STALE_EPOCH')
  if (!status.permissions.screenRecording || !status.permissions.accessibility || !status.permissions.postEvents) {
    const result = { status: 'permission-required', permissions: status.permissions,
      verified: ['native-process-start', 'status-preflight', 'non-loopback-preview-rejection', 'lease-revocation'],
      notRun: ['screen-capture', 'AX-observation', 'real-mouse-keyboard-fixture', 'mid-drag-revocation'],
      next: 'Grant Screen Recording and Accessibility to QiuYaTools Computer in macOS System Settings, restart the helper, and rerun. This script never grants or requests permissions.' }
    await report(result)
    if (process.argv.includes('--require-permissions')) process.exitCode = 2
  } else {
    const contents = join(directory, 'QiuYaTools Computer Fixture.app', 'Contents')
    await mkdir(join(contents, 'MacOS'), { recursive: true })
    await writeFile(join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.qiuya.tools.computer-use.fixture</string><key>CFBundleName</key><string>QiuYaTools Computer Fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
    const executable = join(contents, 'MacOS', 'fixture')
    await run('/usr/bin/swiftc', ['-swift-version', '5', '-framework', 'AppKit', '-module-cache-path', '/tmp/qiuya-computer-swift-cache', fileURLToPath(new URL('../src/native/macos/fixtures/ComputerFixture.swift', import.meta.url)), '-o', executable])
    fixture = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] }); fixture.stderr.resume()
    fixtureLines = createInterface({ input: fixture.stdout })
    const states = []; const waiting = []
    fixtureLines.on('line', line => {
      let state; try { state = JSON.parse(line) } catch { return }
      const resolve = waiting.shift(); if (resolve) resolve(state); else states.push(state)
    })
    const nextState = () => new Promise((resolve, reject) => {
      if (states.length) { resolve(states.shift()); return }
      const timer = setTimeout(() => reject(new Error('Fixture timed out')), 5000)
      waiting.push(state => { clearTimeout(timer); resolve(state) })
    })
    const ready = await nextState()
    async function snapshot() { fixture.stdin.write('snapshot\n'); return nextState() }
    const { targets } = await ok('targets')
    const target = targets.find(target => target.pid === fixture.pid && target.title.includes('E2E Fixture'))
    assert.ok(target, 'Only the disposable fixture window may be controlled')
    const frame = await ok('observe', { targetId: target.id })
    assert.ok(frame.width > 0 && frame.height > 0 && frame.imageBase64.length > 100)
    const jpeg = Buffer.from(frame.imageBase64, 'base64'); assert.equal(jpeg.readUInt16BE(0), 0xffd8)
    assert.equal(frame.geometry.scale, target.scale, 'Geometry scale denotes the display backing scale even when the raster is downscaled')
    if (evidenceDirectory) { await mkdir(evidenceDirectory, { recursive: true }); await writeFile(join(evidenceDirectory, 'fixture.jpg'), jpeg) }
    assert.ok(frame.elements.includes('Fixture'), 'The AX tree should belong to the fixture')
    const point = name => ({ x: (ready.points[name].x - frame.geometry.x) * frame.width / frame.geometry.width,
      y: (ready.points[name].y - frame.geometry.y) * frame.height / frame.geometry.height })
    const act = action => ok('act', { epoch: 2, targetId: target.id, action })
    await ok('lease', { epoch: 2 })
    await new Promise(resolve => previewServer.listen(0, '127.0.0.1', resolve))
    await ok('openPreview', { url: `http://127.0.0.1:${previewServer.address().port}/`, title: 'QiuYa E2E Preview', sessionId: 'fixture' })
    for (let attempt = 0; attempt < 40 && !previewLoaded; attempt++) await delay(50)
    assert.ok(previewLoaded, 'The native floating WKWebView must load the same-origin preview page')
    await delay(300)
    await act({ kind: 'click', ...point('button') }); await delay(100)
    const clicked = await snapshot()
    assert.equal(clicked.counts.clicks, 1, `Native click must activate the fixture button: ${JSON.stringify(clicked.counts)}`)
    await act({ kind: 'click', ...point('text') })
    await act({ kind: 'type', text: 'QiuYa 测试 ✓' }); await delay(100)
    assert.equal((await snapshot()).text, 'QiuYa 测试 ✓', 'Unicode typing must reach the fixture text field')
    await act({ kind: 'key', key: 'CMD+A' }); await act({ kind: 'type', text: 'replaced' }); await delay(100)
    assert.equal((await snapshot()).text, 'replaced', 'Native shortcut must select the fixture text')
    await act({ kind: 'scroll', ...point('canvas'), deltaY: -80, deltaX: 0 }); await delay(100)
    assert.ok((await snapshot()).counts.scrolls > 0, 'Native scroll must reach the fixture')
    const beforeDrag = await snapshot()
    const canvas = point('canvas')
    const dragging = request('act', { epoch: 2, targetId: target.id, action: { kind: 'drag', ...canvas, toX: canvas.x + 100, toY: canvas.y + 30 } })
    await delay(200); await ok('release', { epoch: 2 })
    const interrupted = await dragging
    assert.equal(interrupted.ok, false); assert.equal(interrupted.error.code, 'STALE_EPOCH')
    await delay(250)
    const afterRelease = await snapshot()
    assert.ok(afterRelease.counts.dragged > 0, 'The fixture must receive actual drag events before revocation')
    // NSButton's tracking loop consumes its mouse-up before local monitors. Test
    // the drag's event deltas rather than assuming lifetime counters are equal.
    assert.equal(afterRelease.counts.mouseDown - beforeDrag.counts.mouseDown, 1, 'The drag must press the mouse once')
    assert.equal(afterRelease.counts.mouseUp - beforeDrag.counts.mouseUp, 1, `Revocation must release the drag's held mouse button: ${JSON.stringify(afterRelease.counts)}`)
    const stale = await request('act', { epoch: 2, targetId: target.id, action: { kind: 'click', ...point('button') } })
    assert.equal(stale.ok, false); assert.equal(stale.error.code, 'STALE_EPOCH')
    assert.deepEqual((await snapshot()).counts, afterRelease.counts, 'Stale action must inject no events')
    currentEpoch = 3; previewPaused = false
    await ok('lease', { epoch: 3 }); await ok('observe', { targetId: target.id, preview: true })
    const humanDrag = request('act', { epoch: 3, targetId: target.id, action: { kind: 'drag', ...canvas, toX: canvas.x + 100, toY: canvas.y + 30 } })
    await delay(200); fixture.stdin.write(`preview-click ${native.pid}\n`)
    assert.equal((await nextState()).event, 'preview-clicked')
    const humanInterrupted = await humanDrag
    assert.equal(humanInterrupted.ok, false); assert.equal(humanInterrupted.error.code, 'STALE_EPOCH')
    assert.ok(previewPaused && !previewPauseError, 'A real click on the floating preview must revoke control during an in-flight drag')
    await delay(150)
    const releasedStatus = await ok('status')
    assert.equal(releasedStatus.inputState.mouseHeld, false)
    assert.equal(releasedStatus.inputState.leftButtonDown, false, 'Human override must leave no system-held mouse button')
    await report({ status: 'passed', permissions: status.permissions, target: { id: target.id, pid: target.pid },
      screenshot: { width: frame.width, height: frame.height, bytes: jpeg.length }, counts: afterRelease.counts,
      verified: ['SCK-window-capture', 'AX-fixture-tree', 'real-click-under-floating-preview', 'Unicode-text', 'keyboard-shortcut', 'real-scroll', 'floating-WKWebView-loaded', 'real-preview-human-override-during-drag', 'mid-drag-revocation', 'held-button-release', 'stale-action-zero-events'] })
  }
} finally {
  fixture?.stdin.end('quit\n'); fixtureLines?.close(); fixture?.kill()
  native.stdin.end(); nativeLines.close()
  await Promise.race([new Promise(resolve => native.once('exit', resolve)), delay(2000).then(() => native.kill())])
  for (const job of pending.values()) clearTimeout(job.timer)
  previewServer.closeAllConnections(); await new Promise(resolve => previewServer.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
