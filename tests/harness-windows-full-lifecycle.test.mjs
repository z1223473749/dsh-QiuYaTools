import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { openSync, fstatSync, ftruncateSync, writeSync, closeSync, constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const provider = await readFile(new URL('./fixtures/harness-e2e-provider.mjs', import.meta.url), 'utf8')
const runner = await readFile(new URL('../scripts/e2e-harness.mjs', import.meta.url), 'utf8')
const bridgeBody = provider.slice(provider.indexOf('export function installOwnedWindowsFullEOFBridge(ctx) {'), provider.indexOf('export function apply(ctx) {')).replace('export ', '')
const instantiate = (process, clock = performance) => new Function('process', 'performance', 'resolve', 'basename', 'dirname', 'join', 'openSync', 'fstatSync', 'ftruncateSync', 'writeSync', 'closeSync', 'constants', bridgeBody + ';return installOwnedWindowsFullEOFBridge')(process, clock, resolve, basename, dirname, join, openSync, fstatSync, ftruncateSync, writeSync, closeSync, constants)
async function scope() {
  const temporary = await mkdtemp('/private/tmp/qiuya-harness-e2e-'), profile = join(temporary, 'qiuya-harness-home'); await mkdir(profile)
  const process = new EventEmitter(); process.platform = 'win32'; process.pid = 424242
  process.env = { QIUYA_HARNESS_E2E: '1', QIUYA_HARNESS_WINDOWS_FULL: '1', QIUYA_HARNESS_WINDOWS_RUN_ID: randomUUID(), QIUYA_HARNESS_WINDOWS_CANDIDATE_SHA256: 'a'.repeat(64), QIUYA_HARNESS_WINDOWS_PROFILE: profile, DSH_HOME: profile }
  process.stdin = new EventEmitter(); process.stdin.resume = () => {}; process.stdin.pause = () => {}
  let cleanup, official = 0; process.on('SIGTERM', () => official++)
  const ctx = { effect(operation) { cleanup = operation(); return cleanup } }
  return { process, profile, ctx, get cleanup() { return cleanup }, get official() { return official }, path: join(profile, 'e2e-windows-normal-close.json') }
}
test('full-suite Windows EOF binds exact profile/run/candidate and invokes the existing official shutdown once', async () => {
  const s = await scope(); instantiate(s.process)(s.ctx)
  const before = JSON.parse(await readFile(s.path)); assert.equal(before.officialHandlerInvoked, false); assert.equal(before.fixtureEffectDisposed, false)
  s.process.stdin.emit('end'); s.process.stdin.emit('end'); assert.equal(s.official, 1)
  s.cleanup()
  const receipt = JSON.parse(await readFile(s.path)); assert.equal(receipt.runId, s.process.env.QIUYA_HARNESS_WINDOWS_RUN_ID); assert.equal(receipt.candidateSHA256, 'a'.repeat(64)); assert.equal(receipt.hostPID, 424242); assert.equal(receipt.eofCount, 1); assert.equal(receipt.signalListenerCount, 1); assert.equal(receipt.officialHandlerInvoked, true); assert.equal(receipt.fixtureEffectDisposed, true); assert.equal(receipt.osSignalsSent, 0); assert.equal(s.process.stdin.listenerCount('end'), 0)
})
test('full-suite EOF diagnostics retain exact monotonic disposal and original Host exit boundaries without rewriting the3s verdict', async () => {
  const s = await scope(); let now = 100
  instantiate(s.process, { now: () => now })(s.ctx)
  now = 120; s.process.stdin.emit('end')
  now = 155; s.cleanup()
  const disposed = JSON.parse(await readFile(s.path)); assert.equal(disposed.fixtureDisposedAfterEOFMs, 35); assert.equal(disposed.originalProcessExit, null)
  now = 5120; s.process.emit('exit', 0)
  const exited = JSON.parse(await readFile(s.path)); assert.deepEqual(exited.originalProcessExit, { code: 0, afterEOFMs: 5000 }); assert.equal(exited.fixtureDisposedAfterEOFMs, 35); assert.equal(exited.fixtureEffectDisposed, true); assert.equal(exited.osSignalsSent, 0)
  assert.equal(s.process.listenerCount('exit'), 0)
})
for (const key of ['QIUYA_HARNESS_E2E', 'QIUYA_HARNESS_WINDOWS_RUN_ID', 'QIUYA_HARNESS_WINDOWS_CANDIDATE_SHA256', 'QIUYA_HARNESS_WINDOWS_PROFILE', 'DSH_HOME']) test('full-suite EOF refuses mismatched ' + key + ' before writing a receipt', async () => {
  const s = await scope(); s.process.env[key] = 'unowned'; assert.throws(() => instantiate(s.process)(s.ctx), /exact own temporary profile/); await assert.rejects(readFile(s.path), { code: 'ENOENT' }); assert.equal(s.official, 0)
})
test('full-suite bridge cannot overwrite a preexisting receipt and does not invent an official shutdown handler', async () => {
  const s = await scope(); await writeFile(s.path, 'must remain'); assert.throws(() => instantiate(s.process)(s.ctx), { code: 'EEXIST' }); assert.equal(await readFile(s.path, 'utf8'), 'must remain')
  const missing = await scope(); missing.process.removeAllListeners('SIGTERM'); instantiate(missing.process)(missing.ctx); assert.throws(() => missing.process.stdin.emit('end'), /official Host shutdown handler/); missing.cleanup(); const receipt = JSON.parse(await readFile(missing.path)); assert.equal(receipt.officialHandlerInvoked, false); assert.equal(receipt.signalListenerCount, 0)
})
test('Mac and UI-only providers never install the full Windows EOF bridge', async () => {
  for (const change of [s => { s.process.platform = 'darwin' }, s => { delete s.process.env.QIUYA_HARNESS_WINDOWS_FULL }]) {
    const s = await scope(); change(s); instantiate(s.process)(s.ctx); assert.equal(s.cleanup, undefined); await assert.rejects(readFile(s.path), { code: 'ENOENT' })
  }
})
const retirementStart = runner.indexOf('  if (windowsFullRunId && host) {'), retirementEnd = runner.indexOf('\n  else if (host && macPreviewRetirement)', retirementStart)
assert(retirementStart > 0 && retirementEnd > retirementStart)
const retirementBody = runner.slice(retirementStart, retirementEnd)
async function verdict({ exitCode = 0, signal = null, receiptChange, timedOut = false, windowsClosed = true } = {}) {
  const s = await scope(), output = await mkdtemp('/private/tmp/qyt-full-retirement-'), host = new EventEmitter(), errors = [], timers = []
  host.pid = 424242; host.exitCode = timedOut ? null : exitCode; host.signalCode = signal; host.kill = () => { throw Error('No kill is permitted') }
  const receipt = { runId: s.process.env.QIUYA_HARNESS_WINDOWS_RUN_ID, candidateSHA256: 'a'.repeat(64), hostPID: host.pid, source: 'own-stdin-eof-to-official-sigterm-handler', osSignalsSent: 0, eofCount: 1, officialHandlerInvoked: true, fixtureEffectDisposed: true, signalListenerCount: 1 }; receiptChange?.(receipt); await writeFile(s.path, JSON.stringify(receipt))
  const run = new Function('windowsFullRunId', 'host', 'readFile', 'writeFile', 'join', 'profileHome', 'output', 'candidateSHA256', 'errors', 'setTimeout', 'clearTimeout', 'windowsSessionWindowRetirement', 'windowsWindowRetirementObserver', 'return (async()=>{let windowsHostRetirement;\n' + retirementBody + '\nreturn windowsHostRetirement})()')
  const result = await run(receipt.runId, host, readFile, writeFile, join, s.profile, output, 'a'.repeat(64), errors, (fn, ms) => { timers.push(ms); queueMicrotask(fn); return 1 }, () => {}, { passed: windowsClosed }, undefined)
  return { result, errors, timers }
}
test('Windows full acceptance accepts only original Host natural exit0 with its exact disposed bridge receipt', async () => {
  const valid = await verdict(); assert.equal(valid.result.natural, true); assert.deepEqual(valid.errors, [])
  for (const changes of [{ windowsClosed: false }, { exitCode: 1 }, { signal: 'SIGTERM' }, { receiptChange: r => { r.candidateSHA256 = 'b'.repeat(64) } }, { receiptChange: r => { r.hostPID++ } }, { receiptChange: r => { r.eofCount = 2 } }, { receiptChange: r => { r.fixtureEffectDisposed = false } }, { receiptChange: r => { r.officialHandlerInvoked = false } }, { receiptChange: r => { r.signalListenerCount = 0 } }, { receiptChange: r => { r.osSignalsSent++ } }]) {
    const rejected = await verdict(changes); assert.equal(rejected.result.natural, false); assert.equal(rejected.errors.length, 1)
  }
})
test('Windows full acceptance preserves the original3000ms bound and marks unknown instead of signaling', async () => {
  const rejected = await verdict({ timedOut: true }); assert.deepEqual(rejected.timers, [3000]); assert.equal(rejected.result.natural, false); assert.equal(rejected.result.waitTimedOut, true); assert.equal(rejected.result.osSignalsSent, 0); assert.equal(rejected.errors.length, 1)
})
test('file exchange uses only its own visible chat default task and keeps the exact byte oracles', () => {
  assert(runner.includes('async function openOwnComputerEnvironment(sessionId)'))
  assert(runner.includes('`[data-qyt-computer-environment=${JSON.stringify(sessionId)}]:visible`'))
  assert(runner.includes('`[data-qyt-environment-session=${JSON.stringify(sessionId)}]`'))
  assert(runner.includes(".getByRole('radio', { name: /远端电脑/u }).check()"))
  assert(!runner.includes("page.locator('.qyt-computer-advanced > summary')"))
  assert(runner.includes('Buffer.alloc(8 * 1024 * 1024)'))
  assert.equal(runner.split('assert.deepEqual(await readFile(join(directory, name)), bytes)').length, 3)
  assert(runner.includes('assert.deepEqual(await readFile(saved), bytes)')); assert(runner.includes("await pane.getByText(/已存在同名文件/u).waitFor()"))
})
