import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stopMacInstallHost, makeMacInstallSource, assessMacInstallReport, MAC_INSTALL_CASES } from '../scripts/prepare-macos-install-acceptance.mjs'
import { acceptanceFixtureHash, macAcceptancePolicyFixture } from './fixtures/macos-acceptance-policy.mjs'

test('normal owned Mac child uses one SIGTERM and produces actual exit0 without escalation', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('READY');setInterval(()=>{},1000)"], { stdio: ['pipe', 'pipe', 'pipe'] })
  await once(child.stdout, 'data')
  const result = await stopMacInstallHost(child)
  assert.equal(result.passed, true); assert.equal(result.exitCode, 0); assert.equal(result.exitSignal, null)
  assert.equal(result.stdinEnded, true); assert.equal(result.signalSent, true); assert.equal(result.signalAccepted, true); assert.equal(result.signalKind, 'SIGTERM'); assert.equal(result.forced, false)
})

test('hung shutdown returns failure, retains live identity and never sends a second or stronger signal', async () => {
  const child = new EventEmitter(); child.pid = 123; child.exitCode = null; child.signalCode = null
  let ended = 0; const signals = []
  child.stdin = { end() { ended++ } }; child.kill = signal => { signals.push(signal); return true }
  const first = await stopMacInstallHost(child, { timeoutMs: 5 }), second = await stopMacInstallHost(child, { timeoutMs: 5 })
  assert.equal(first.passed, false); assert.equal(first.timedOut, true); assert.equal(second.passed, false)
  assert.deepEqual(signals, ['SIGTERM']); assert.equal(ended, 1); assert.equal(child.exitCode, null)
})

test('an externally terminated child is never mislabelled normal exit or signalled again', async () => {
  const child = new EventEmitter(); child.pid = 124; child.exitCode = null; child.signalCode = 'SIGKILL'; child.kill = () => { throw Error('Must not signal') }
  const result = await stopMacInstallHost(child)
  assert.equal(result.passed, false); assert.equal(result.signalSent, false); assert.equal(result.exitSignal, 'SIGKILL')
})

function report() {
  const exits = Array.from({ length: 5 }, (_, index) => ({ pid: 400 + index, passed: true, stdinEnded: true, signalSent: true, signalAccepted: true, signalKind: 'SIGTERM', exitCode: 0, exitSignal: null, timedOut: false, forced: false }))
  return { status: 'passed', platform: 'darwin', isolation: true, checks: MAC_INSTALL_CASES.map(name => ({ name, status: 'passed' })), hostExitReceipts: exits, cleanup: { passed: true, hostRetired: true, noEscalation: true, temporaryRemoved: true, error: null } }
}
test('install verdict requires exactly five lifecycle cases and all five observed normal exits', () => {
  assert.equal(assessMacInstallReport(report()).passed, true)
  for (const mutate of [r => r.checks.pop(), r => r.checks[1].status = 'failed', r => r.hostExitReceipts.pop(), r => r.hostExitReceipts[0].exitCode = 1, r => r.hostExitReceipts[0].exitSignal = 'SIGTERM', r => r.hostExitReceipts[0].timedOut = true, r => r.hostExitReceipts[0].forced = true, r => r.hostExitReceipts[0].signalAccepted = false, r => r.cleanup.temporaryRemoved = false, r => r.cleanup.hostRetired = false, r => r.cleanup.error = 'timed out', r => r.platform = 'win32', r => r.isolation = false]) {
    const value = report(); mutate(value); assert.equal(assessMacInstallReport(value).passed, false)
  }
})

test('frozen install source preserves package/settings assertions and removes hidden SIGKILL fallback', async () => {
  const source = makeMacInstallSource(await readFile(new URL('../scripts/test-harness-install.mjs', import.meta.url), 'utf8'))
  assert(!source.includes("child.kill('SIGKILL')"))
  assert(source.includes('const receipt = await stopMacInstallHost(host, { timeoutMs: 5000 })'))
  assert(source.includes("assert.equal(await readFile(patch, 'utf8'), saved)"))
  assert(source.includes('if (hostRetired) { await rm(temporary'))
  assert(source.includes("report.status = 'failed'"))
  assert.throws(() => makeMacInstallSource('unknown runner'), /anchor/)
})

test('synthetic Mac lifecycle prepares and guards all package/runtime pins without official CLI or GUI startup', async t => {
  const fixture = await macAcceptancePolicyFixture(t, 'install')
  const made = await fixture.prepare()
  assert.equal(made.executed, false); assert.equal(made.guiStarted, false); assert.equal(made.nativeInput, false)
  const plan = await fixture.plan(made.entry)
  assert.equal(plan.actualExecution, false); assert.equal(plan.guiStarted, false); assert.equal(plan.userProfileChanged, false)
  assert.equal(plan.candidate, fixture.candidate); assert.equal(plan.previous, fixture.previous)
  assert.equal(plan.candidateSHA256, fixture.candidateSHA256); assert.equal(plan.previousSHA256, fixture.previousSHA256)
  assert.equal(plan.helperSHA256, fixture.helperSHA256)
  assert.deepEqual(plan.checks, MAC_INSTALL_CASES)
  assert.deepEqual(Object.keys(plan.cliHashes), fixture.runtimes)
  for (const path of fixture.runtimes) assert.equal(plan.cliHashes[path], acceptanceFixtureHash(await readFile(path)))
  await assert.rejects(lstat(fixture.marker), { code: 'ENOENT' })
  await assert.rejects(lstat(made.output), { code: 'ENOENT' })
  const runtime = fixture.runtimes[0], original = await readFile(runtime)
  await writeFile(runtime, 'changed runtime')
  await assert.rejects(fixture.plan(made.entry), error => error.stderr.includes('Official CLI changed'))
  await writeFile(runtime, original)
  const frozen = join(made.base, 'test-harness-install.mjs'), frozenOriginal = await readFile(frozen)
  await writeFile(frozen, Buffer.concat([frozenOriginal, Buffer.from('\n// changed frozen source')]))
  await assert.rejects(fixture.plan(made.entry), error => error.stderr.includes('Frozen source changed: test-harness-install.mjs'))
  await writeFile(frozen, frozenOriginal)
  await writeFile(fixture.previous, Buffer.concat([fixture.previousBytes, Buffer.from('changed previous')]))
  await assert.rejects(fixture.plan(made.entry), error => error.stderr.includes('AssertionError'))
  await writeFile(fixture.previous, fixture.previousBytes)
  await writeFile(fixture.candidate, Buffer.concat([fixture.candidateBytes, Buffer.from('changed candidate')]))
  await assert.rejects(fixture.plan(made.entry), error => error.stderr.includes('AssertionError'))
  await assert.rejects(lstat(fixture.marker), { code: 'ENOENT' })
  await assert.rejects(lstat(made.output), { code: 'ENOENT' })
})
