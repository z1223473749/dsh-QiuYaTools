import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

if (process.platform !== 'darwin') throw new Error('This runner requires the macOS companion; use the Windows native E2E on Windows')
const actionCrash = process.argv.includes('--action-crash')
const outArg = process.argv.indexOf('--out')
const output = resolve(outArg < 0 ? 'artifacts/computer-use/macos-lease' : process.argv[outArg + 1])
const executable = fileURLToPath(new URL('../lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer', import.meta.url))
const helpers = [], checks = [], temporary = await mkdtemp(join(tmpdir(), 'qiuya-desktop-lease-'))
let fixture
await mkdir(output, { recursive: true })
const check = id => checks.push({ id, status: 'passed' })
function helper() {
  const process = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map(); let sequence = 0, diagnostic = ''
  process.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-1200) })
  createInterface({ input: process.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line) } catch { return }
    const item = pending.get(value.requestId)
    if (item) { pending.delete(value.requestId); clearTimeout(item.timer); item.resolve(value) }
  })
  process.once('exit', (code, signal) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`Companion exited (${code ?? signal}): ${diagnostic}`)) }; pending.clear() })
  const request = (op, args = {}) => new Promise((resolve, reject) => {
    const requestId = ++sequence
    pending.set(requestId, { resolve, reject, timer: setTimeout(() => { pending.delete(requestId); reject(new Error(`${op} timed out`)) }, 8000) })
    process.stdin.write(JSON.stringify({ requestId, op, ...args }) + '\n')
  })
  const ok = async (op, args) => { const result = await request(op, args); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.result }
  const stop = async () => { if (process.exitCode !== null || process.signalCode) return; process.stdin.end(); await Promise.race([new Promise(done => process.once('exit', done)), delay(2000).then(() => process.kill('SIGKILL'))]) }
  const value = { process, request, ok, stop }; helpers.push(value); return value
}
async function eventually(fn, message) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (await fn()) return; await delay(20) }
  throw new Error(message)
}
try {
  const a = helper(), b = helper(), readonly = helper()
  await readonly.ok('status')
  const processes = (await promisify(execFile)('/bin/ps', ['-axo', 'ppid=,command='])).stdout
  assert.ok(!processes.split('\n').some(line => line.trim().startsWith(`${readonly.process.pid} `) && line.includes('--input-guardian')), 'read-only status must not spawn a guardian')
  check('READONLY-NO-GUARDIAN')
  await a.ok('lease', { epoch: 1 })
  const firstOwner = (await a.ok('status')).inputState.ownerId
  assert.match(firstOwner, /^[a-f0-9]{32}$/)
  const competing = await b.request('lease', { epoch: 1 })
  assert.equal(competing.error?.code, 'DESKTOP_BUSY')
  check('TWO-HELPERS-ONE-DESKTOP-OWNER')
  await a.ok('release', { epoch: 1 }); await b.ok('lease', { epoch: 2 })
  await a.ok('release', { epoch: 1 })
  assert.equal((await b.ok('status')).leaseEpoch, 2)
  check('RELEASE-THEN-TRANSFER-AND-OLD-RELEASE-FENCED')
  b.process.kill('SIGKILL')
  await new Promise(done => b.process.once('exit', done))
  await eventually(async () => (await a.request('lease', { epoch: 2 })).ok, 'The crashed empty lease was not recovered')
  assert.notEqual((await a.ok('status')).inputState.ownerId, firstOwner)
  await a.ok('release', { epoch: 2 })
  check('CRASHED-EMPTY-LEASE-RECOVERED')

  if (actionCrash) {
    const { stdout } = await promisify(execFile)('/usr/bin/swift', ['-e', 'import CoreGraphics; let session = CGSessionCopyCurrentDictionary() as? [String:Any]; print((session?["CGSSessionScreenIsLocked"] as? Bool) == true ? "locked" : "unlocked")'])
    if (stdout.trim() === 'locked') {
      const error = new Error('macOS is locked; real input verification requires the owner to unlock the existing session. No login or lock-screen settings were changed.')
      error.code = 'SESSION_LOCKED'
      throw error
    }
    const status = await a.ok('status')
    assert.ok(status.permissions.screenRecording && status.permissions.accessibility && status.permissions.postEvents, 'Real crash-input proof requires previously granted native capture/input permissions')
    const contents = join(temporary, 'Lease Fixture.app', 'Contents')
    await mkdir(join(contents, 'MacOS'), { recursive: true })
    await writeFile(join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.qiuya.tools.lease-fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
    const binary = join(contents, 'MacOS', 'fixture')
    await promisify(execFile)('/usr/bin/swiftc', ['-swift-version', '5', '-framework', 'AppKit', '-module-cache-path', '/tmp/qiuya-computer-swift-cache', fileURLToPath(new URL('../src/native/macos/fixtures/ComputerFixture.swift', import.meta.url)), '-o', binary])
    fixture = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] }); fixture.stderr.resume()
    await new Promise((done, reject) => { fixture.stdout.once('data', done); fixture.once('error', reject); setTimeout(() => reject(new Error('Fixture start timed out')), 8000).unref() })
    const target = (await a.ok('targets')).targets.find(target => target.pid === fixture.pid)
    assert.ok(target, 'Only the disposable fixture may receive injected input')
    const frame = await a.ok('observe', { targetId: target.id })
    const crash = helper(); await crash.ok('lease', { epoch: 1 }); await crash.ok('observe', { targetId: target.id })
    let dragReply
    const drag = crash.request('act', { epoch: 1, targetId: target.id, action: { kind: 'drag', x: frame.width * .5, y: frame.height * .75, toX: frame.width * .7, toY: frame.height * .75 } }).then(reply => { dragReply = reply }, error => { dragReply = { error: error.message } })
    await eventually(async () => {
      const status = await crash.ok('status')
      if (status.inputState.mouseHeld) return true
      if (dragReply) throw new Error(`The drag completed before a held button was observed: ${JSON.stringify(dragReply)}`)
      return false
    }, 'The real drag never held a mouse button')
    crash.process.kill('SIGKILL'); await new Promise(done => crash.process.once('exit', done)); await drag
    await eventually(async () => (await a.request('lease', { epoch: 3 })).ok, 'The crashed drag journal was not recovered')
    assert.equal((await a.ok('status')).inputState.leftButtonDown, false, 'The independent guardian/new owner must release the OS-held button')
    await a.ok('release', { epoch: 3 })
    check('REAL-DRAG-SIGKILL-JOURNAL-RECOVERY')
  }
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'passed', kind: actionCrash ? 'real-native-process-and-injected-drag-crash' : 'real-native-process-leases-no-input-injection', checks, notRun: actionCrash ? ['held-key-crash'] : ['held-drag-crash', 'held-key-crash'], testedAt: new Date().toISOString() }, null, 2))
  console.log(`Desktop lease ${checks.length}/${checks.length} checks passed; ${output}`)
} catch (error) {
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: error.code === 'SESSION_LOCKED' ? 'blocked' : 'failed', checks, reason: error.message, testedAt: new Date().toISOString() }, null, 2))
  if (error.code === 'SESSION_LOCKED') { console.error(error.message); process.exitCode = 2 }
  else throw error
} finally {
  fixture?.stdin.end('quit\n'); fixture?.kill()
  await Promise.allSettled(helpers.map(helper => helper.stop()))
  await rm(temporary, { recursive: true, force: true })
}
