import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAC_EXCHANGE_CANDIDATE, MAC_EXCHANGE_SHA256, MAC_EXCHANGE_CASES, MAC_EXCHANGE_IMAGES, assertMacExchangeExtraction, makeMacFileExchangeSource, assessMacFileExchangeReport } from '../scripts/prepare-macos-file-exchange-acceptance.mjs'
import { acceptanceFixtureHash, macAcceptancePolicyFixture } from './fixtures/macos-acceptance-policy.mjs'

const approvedArgs = ['-xOf', MAC_EXCHANGE_CANDIDATE, 'package/lib/computer-agent.js']
test('the command whitelist accepts only one exact read-only member in the reviewed Mac package', () => {
  assert.doesNotThrow(() => assertMacExchangeExtraction('tar', approvedArgs, MAC_EXCHANGE_CANDIDATE))
  for (const [command, args, candidate] of [
    ['osascript', approvedArgs, MAC_EXCHANGE_CANDIDATE], ['/usr/bin/tar', approvedArgs, MAC_EXCHANGE_CANDIDATE], ['tar', ['-xvf', ...approvedArgs.slice(1)], MAC_EXCHANGE_CANDIDATE], ['tar', [...approvedArgs, 'package/README.md'], MAC_EXCHANGE_CANDIDATE], ['tar', [approvedArgs[0], approvedArgs[1], 'package/lib/other.js'], MAC_EXCHANGE_CANDIDATE], ['tar', approvedArgs, '/tmp/other.tgz'], ['tar', ['-xOf', '/tmp/other.tgz', approvedArgs[2]], MAC_EXCHANGE_CANDIDATE],
  ]) assert.throws(() => assertMacExchangeExtraction(command, args, candidate))
})

test('real tar extraction reads a digest-pinned synthetic archive; unapproved reads and changed bytes fail', async t => {
  const fixture = await macAcceptancePolicyFixture(t, 'file-exchange')
  const { readMacExchangeBundle } = fixture.policy
  const args = ['-xOf', fixture.candidate, 'package/lib/computer-agent.js']
  const source = await readMacExchangeBundle('tar', args, fixture.candidate)
  assert.equal(source, fixture.bundle)
  assert(source.includes('createComputerAgentServer'))
  assert(source.includes('EXCHANGE_EXISTS'))
  await assert.rejects(() => readMacExchangeBundle('osascript', args, fixture.candidate))
  await assert.rejects(() => readMacExchangeBundle('tar', [...args, 'package/README.md'], fixture.candidate))
  await writeFile(fixture.candidate, Buffer.concat([fixture.candidateBytes, Buffer.from('changed after pinning')]))
  await assert.rejects(() => readMacExchangeBundle('tar', args, fixture.candidate), /changed before read-only extraction/)
})

function evidence() {
  return { candidateSHA256: MAC_EXCHANGE_SHA256, size: 8 * 1024 * 1024, sha256: 'a'.repeat(64), uploadedActualBytes: 8 * 1024 * 1024, uploadedActualSHA256: 'a'.repeat(64), downloadedActualBytes: 8 * 1024 * 1024, downloadedActualSHA256: 'a'.repeat(64), afterDuplicateActualBytes: 8 * 1024 * 1024, afterDuplicateActualSHA256: 'a'.repeat(64), uploadedBytesVerified: true, browserDownloadVerified: true, duplicateRejectedWithoutOverwrite: true, serverClosed: true, calls: { status: 2, targets: 0, observe: 0, lease: 0, release: 0, act: 0, preview: 0 } }
}
function report() {
  return { status: 'passed', platform: 'darwin', kind: 'official-Harness-Mac-file-exchange-supplement', candidateSHA256: MAC_EXCHANGE_SHA256, selection: { scope: 'headless-file-exchange-only', fullUIAcceptance: false, nativeUIAcceptance: false }, tests: MAC_EXCHANGE_CASES.map(name => ({ name, status: 'passed' })), fileOnlyEvidence: { browserHeadless: true, domProtocolOnly: true, allowedNativeReads: 1, forbiddenNativeCommands: 0, nativeDriverStarted: false, nativeFixtureCompiled: false, hostRetired: true, hostExitCode: 0, hostSignal: null, browserCloseSucceeded: true }, screenshotEvidence: { files: MAC_EXCHANGE_IMAGES.map(name => ({ name, bytes: 200, sha256: 'b'.repeat(64) })), missing: [] }, ownedCleanup: { passed: true }, frontendErrors: [] }
}
test('file-only success needs real byte/digest projections at upload, download and duplicate-rejection boundaries', () => {
  assert.equal(assessMacFileExchangeReport(report(), evidence()).passed, true)
  for (const mutate of [e => e.uploadedActualBytes--, e => e.downloadedActualSHA256 = 'c'.repeat(64), e => e.afterDuplicateActualSHA256 = 'c'.repeat(64), e => e.size = 1024, e => e.browserDownloadVerified = false, e => e.duplicateRejectedWithoutOverwrite = false, e => e.serverClosed = false, e => e.calls.observe++, e => e.calls.lease++, e => e.calls.act++, e => e.calls.release++, e => e.calls.preview++, e => e.candidateSHA256 = 'd'.repeat(64)]) {
    const value = evidence(); mutate(value); assert.equal(assessMacFileExchangeReport(report(), value).passed, false)
  }
})

test('native claims, missing status images, incomplete selection or abnormal Host exit cannot pass', () => {
  for (const mutate of [r => r.tests.pop(), r => r.fileOnlyEvidence.allowedNativeReads = 2, r => r.fileOnlyEvidence.forbiddenNativeCommands++, r => r.fileOnlyEvidence.nativeDriverStarted = true, r => r.fileOnlyEvidence.nativeFixtureCompiled = true, r => r.fileOnlyEvidence.browserHeadless = false, r => r.fileOnlyEvidence.hostExitCode = 1, r => r.fileOnlyEvidence.hostSignal = 'SIGTERM', r => r.fileOnlyEvidence.hostRetired = false, r => r.fileOnlyEvidence.browserCloseSucceeded = false, r => r.screenshotEvidence.files.pop(), r => r.screenshotEvidence.missing.push('file-exchange-uploaded.png'), r => r.selection.nativeUIAcceptance = true, r => r.platform = 'win32']) {
    const value = report(); mutate(value); assert.equal(assessMacFileExchangeReport(value, evidence()).passed, false)
  }
})

test('frozen file supplement keeps actual Host/browser/FS assertions and adds actual read hashes plus scoped images', async () => {
  const source = makeMacFileExchangeSource(await readFile(new URL('../scripts/e2e-harness.mjs', import.meta.url), 'utf8'), { repository: '/repo', providerSource: '/snapshot/provider.mjs', policySource: '/snapshot/file-policy.mjs' })
  assert.deepEqual(JSON.parse(/const featureEvidenceCases = new Set\((\[[^\n]+\])\)/u.exec(source)[1]), MAC_EXCHANGE_CASES)
  assert(source.includes('headless: true')); assert(!source.includes("else if (host) await Promise.race"))
  for (const name of MAC_EXCHANGE_IMAGES) assert(source.includes(`screenshot('${name.slice(0, -4)}', pane)`))
  for (const name of ['uploadedActual', 'downloadedActual', 'afterDuplicateActual']) assert(source.includes(`createHash('sha256').update(${name}).digest('hex')`))
  assert(source.includes('await download.saveAs(saved)'))
  for (const name of ['uploadedActual', 'downloadedActual', 'afterDuplicateActual']) assert(source.includes(`assert.deepEqual(${name}, bytes)`))
  assert(source.includes('await server.close(); evidence.serverClosed = true'))
  assert(source.includes('await readMacExchangeBundle(command, args, candidate)'))
})

test('synthetic file supplement prepares a closed source graph and guarded plan without actual acceptance execution', async t => {
  const fixture = await macAcceptancePolicyFixture(t, 'file-exchange')
  const made = await fixture.prepare()
  assert.equal(made.executed, false); assert.equal(made.guiStarted, false); assert.equal(made.pdCommandsExecuted, 0)
  assert.equal(made.snapshotImportSmoke.passed, true)
  const plan = await fixture.plan(made.entry)
  assert.equal(plan.actualExecution, false); assert.equal(plan.guiStarted, false); assert.equal(plan.nativeInput, false)
  assert.equal(plan.candidate, fixture.candidate); assert.equal(plan.candidateSHA256, fixture.candidateSHA256); assert.deepEqual(plan.selectedCases, MAC_EXCHANGE_CASES)
  assert.equal(plan.policySHA256, acceptanceFixtureHash(await readFile(join(made.base, 'file-policy.mjs'))))
  assert(plan.snapshotImportSmoke.inputs.length > 0)
  await assert.rejects(lstat(fixture.marker), { code: 'ENOENT' })
  const frozen = join(made.base, 'snapshot/scripts/e2e-harness.mjs'), original = await readFile(frozen)
  await writeFile(frozen, Buffer.concat([original, Buffer.from('\n// changed frozen source')]))
  await assert.rejects(fixture.plan(made.entry), error => error.stderr.includes('Frozen source changed: scripts/e2e-harness.mjs'))
  await writeFile(frozen, original)
  await writeFile(fixture.candidate, Buffer.concat([fixture.candidateBytes, Buffer.from('changed candidate')]))
  await assert.rejects(fixture.plan(made.entry), error => error.stderr.includes('AssertionError'))
  await assert.rejects(lstat(fixture.marker), { code: 'ENOENT' })
})
