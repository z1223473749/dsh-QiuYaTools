import {boundedFile} from './macos-acceptance-files.mjs';
/** Generic full12 policy. Explicit deltas: entry preflight, observer bundle deployment and failed-profile retention. */
import assert from'node:assert/strict';import{readFile,realpath,readlink,lstat}from'node:fs/promises';import{join}from'node:path';import{pathToFileURL}from'node:url';import{createHash}from'node:crypto';
const MAC_EXCHANGE_CASES=Object.freeze(['account-menu-settings-and-all-feature-tabs','settings-persist-thresholds-and-theme','real-local-model-session','packaged-file-exchange-real-host-upload-download-and-no-overwrite']);
export const MAC_FULL_HARNESS_CASES = Object.freeze([
  'account-menu-settings-and-all-feature-tabs', 'settings-persist-thresholds-and-theme', 'real-local-model-session',
  'prompt-suggestion-tab-and-escape', 'paste-browser-event-to-official-txt-upload', 'session-menus-copy-unread-and-pin',
  'native-independent-window-and-reuse', 'trusted-browser-drag-to-native-window', 'computer-main-agent-tools-and-image-adapter-pipeline',
  'batch-archive-real-sessions', 'plan-review-comment-and-draft-preservation', 'packaged-file-exchange-real-host-upload-download-and-no-overwrite',
])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function bindReadonlyOracleHost(source,hostSHA256){
  assert.match(hostSHA256,/^[a-f\d]{64}$/u);assert.equal([...source.matchAll(/private let hostSHA = "[a-f\d]{64}"/gu)].length,1,'Exactly one readonly oracle Host hash template is required')
  return source.replace(/private let hostSHA = "[a-f\d]{64}"/u,'private let hostSHA = "'+hostSHA256+'"')
}
const RUN_PREREQUISITES = Object.freeze(['Mac manually unlocked and desktop input slot exclusively assigned by root', 'Current candidate keyboard positive and independent boundary coverage accepted first', 'Approved AI pointer visual accepted first', 'Root has checked no concurrent Mac or PD desktop input'])

export function assertMacFullHarnessGate(argv) {
  assert.equal(argv.filter(value => value === '--run').length, 1, 'Execution requires exactly one --run')
  assert(!argv.includes('--plan'), 'Plan and execution cannot be combined')
  const index = argv.indexOf('--gui-gate')
  assert(index >= 0 && argv.filter(value => value === '--gui-gate').length === 1 && argv[index + 1] === 'root-approved' && argv.filter(value => value === '--root-approved').length === 1, 'Complete native acceptance requires --gui-gate root-approved --root-approved')
}

export function makeMacFullHarnessSource(original, { repository, snapshot, policySource }) {
  let source = original
  const once = (before, after) => { assert.equal(source.split(before).length, 2, 'Unique full-suite snapshot anchor changed: ' + before.slice(0, 80)); source = source.replace(before, after) }
  once('assertHarnessMacEntryPrepared({ prepared: false, headlessSubset: false })', 'assertHarnessMacEntryPrepared({ prepared: true, headlessSubset: false })')
  // Keep root relative to this frozen script. All dynamic TS/Swift reads below
  // therefore resolve inside snapshot, never to mutable live fixtures.
  source = source.replace(/^const featureEvidenceOnly = .*$/mu, 'const featureEvidenceOnly = false').replace(/^const pastedTextOnly = .*$/mu, 'const pastedTextOnly = false')
  once("    let log = ''; let exited = false", "    await writeFile(join(output, 'owned-host-profile.json'), JSON.stringify({ profileHome, hostPid: host.pid, runnerPid: process.pid, ownTemporary: temporary, noCredentials: true }, null, 2))\n    let log = ''; let exited = false")
  for (const [before, after] of [
    ["assert.equal(await page.getByRole('spinbutton').nth(1).inputValue(), '4')", "assert.equal(await page.getByRole('spinbutton').nth(1).inputValue(), '4'); await screenshot('thresholds-saved')"],
    ["assert.equal(await ghost.innerText(), '继续检查本地测试结果。')", "assert.equal(await ghost.innerText(), '继续检查本地测试结果。'); await screenshot('prompt-suggestion')"],
    ["await editor().press('Tab'); assert.equal(await editor().innerText(), '继续检查本地测试结果。')", "await editor().press('Tab'); assert.equal(await editor().innerText(), '继续检查本地测试结果。'); await screenshot('prompt-accepted')"],
    ["await menu(alpha); await page.getByRole('menuitem', { name: '复制会话标题', exact: true }).click()", "await menu(alpha); await screenshot('session-menu-copy'); await page.getByRole('menuitem', { name: '复制会话标题', exact: true }).click()"],
    ["await row(alpha).locator('[data-qyt-manual-unread=\"true\"]').waitFor()", "await row(alpha).locator('[data-qyt-manual-unread=\"true\"]').waitFor(); await screenshot('session-menu-unread')"],
    ["await menu(alpha); await page.getByRole('menuitem', { name: '取消置顶', exact: false }).waitFor(); await page.keyboard.press('Escape')", "await menu(alpha); await page.getByRole('menuitem', { name: '取消置顶', exact: false }).waitFor(); await screenshot('session-menu-pin'); await page.keyboard.press('Escape')"],
  ]) once(before, after)
  // Reuse exactly the already exercised file-case body, without importing its
  // headless-only selection or native-command restriction into this full suite.
  const fileVersion = makeMacFileExchangeSource(original, { repository, providerSource: join(snapshot, 'tests/fixtures/harness-e2e-provider.mjs'), policySource })
  const marker = "  if (process.argv.includes('--file-exchange-e2e')) await test('packaged-file-exchange-real-host-upload-download-and-no-overwrite'"
  const a = source.indexOf(marker), b = source.indexOf('  assert.equal(errors.length, 0,', a)
  const c = fileVersion.indexOf(marker), d = fileVersion.indexOf('  assert.equal(errors.length, 0,', c)
  assert(a > 0 && b > a && c > 0 && d > c)
  source = source.slice(0, a) + fileVersion.slice(c, d) + source.slice(b)
  const uploadAnchor = "      await screenshot('file-exchange-uploaded', pane)"
  assert.equal(source.split(uploadAnchor).length, 2, 'Unique final uploaded screenshot anchor changed')
  source = source.replace(uploadAnchor, "      evidence.uploadedHandleProof = await readFinalOwnUploadedFile({ directory: await realpath(directory), name, expectedBytes: bytes.length, expectedSHA256: sha256 }); evidence.uploadedReadyUI = true\n" + uploadAnchor)
  const start = source.indexOf('  let forcedHostTermination = false\n'), end = source.indexOf('  if (macPreviewRetirement) {', start)
  assert(start > 0 && end > start)
  source = source.slice(0, start) + `  let forcedHostTermination = false, hostExitWaitTimedOut = false
  if (host) await new Promise(resolve => {
    if (host.exitCode !== null || host.signalCode !== null) return resolve()
    const timer = setTimeout(() => { hostExitWaitTimedOut = true; errors.push('Owned full-suite Host did not finish its normal SIGTERM shutdown within3000ms; no escalation was sent'); resolve() }, 3000)
    host.once('exit', () => { clearTimeout(timer); resolve() })
  })
` + source.slice(end)
  once('last, failure, forcedHostTermination, source:', 'last, failure, forcedHostTermination, hostExitWaitTimedOut, source:')
  once("if (!process.argv.includes('--keep-profile')) await rm(temporary, { recursive: true, force: true })", "if (!process.argv.includes('--keep-profile') && report.status === 'passed' && !errors.length && !ownedCleanupErrors.length && (!host || host.exitCode !== null || host.signalCode !== null)) await rm(temporary, { recursive: true, force: true })")
  once("'official-Harness-isolated-profile-real-browser'", "'official-Harness-Mac-complete-12'")
  once("{ scope: 'complete-configured-suite' }", "{ scope: 'complete-configured-suite', fullUIAcceptance: true, nativeUIAcceptance: true }")
  once("model: 'deterministic local fixture, no real account credentials'", "fullAcceptanceEvidence: { manualPreview: process.argv.includes('--manual-preview-e2e'), dragWindow: process.argv.includes('--drag-window-e2e'), fileExchange: process.argv.includes('--file-exchange-e2e'), hostPid: host?.pid ?? null, hostRetired: Boolean(host && (host.exitCode !== null || host.signalCode !== null)), hostExitCode: host?.exitCode ?? null, hostSignal: host?.signalCode ?? null, hostExitWaitTimedOut, forcedHostTermination, hostShutdown: 'owned Host normal SIGTERM, no Host SIGKILL fallback', browserCloseSucceeded: Boolean(browser && !ownedCleanupErrors.some(row => row.stage === 'browser-close')) }, model: 'deterministic local fixture, no real account credentials'")
  return source
}

export function assessMacFullHarnessReport(report, candidateSHA256) {
  assert.match(candidateSHA256??'',/^[a-f0-9]{64}$/u)
  const rows = report?.tests ?? [], proof = report?.fullAcceptanceEvidence
  const exactSelection = rows.length === 12 && MAC_FULL_HARNESS_CASES.every((name, index) => rows[index]?.name === name && rows[index].status === 'passed')
  const completeFlags = proof?.manualPreview === true && proof?.dragWindow === true && proof?.fileExchange === true
  const normalHostExit = proof?.hostRetired === true && proof?.hostExitCode === 0 && proof?.hostSignal === null && proof?.hostExitWaitTimedOut === false && proof?.forcedHostTermination === false && proof?.browserCloseSucceeded === true
  return { passed: Boolean(report?.status === 'passed' && report?.platform === 'darwin' && report?.kind === 'official-Harness-Mac-complete-12' && report?.selection?.scope === 'complete-configured-suite' && report.selection.fullUIAcceptance === true && report.selection.nativeUIAcceptance === true && report.candidateSHA256 === candidateSHA256 && exactSelection && completeFlags && normalHostExit && report?.ownedCleanup?.passed === true && report.frontendErrors?.length === 0), exactSelection, completeFlags, normalHostExit }
}

export function makeMacFileExchangeSource(source, { repository, providerSource, policySource }) {
  const once = (before, after) => { assert.equal(source.split(before).length, 2, 'Unique file supplement anchor changed: ' + before.slice(0, 80)); source = source.replace(before, after) }
  once('assertHarnessMacEntryPrepared({ prepared: false, headlessSubset: false })', 'assertHarnessMacEntryPrepared({ prepared: false, headlessSubset: true })')
  once("const root = fileURLToPath(new URL('../', import.meta.url))", 'const root = ' + JSON.stringify(repository))
  once("import { spawn } from 'node:child_process'", "import { spawn } from 'node:child_process'\nimport { readMacExchangeBundle } from " + JSON.stringify(pathToFileURL(policySource).href))
  source = source.replace(/^const featureEvidenceOnly = .*$/mu, 'const featureEvidenceOnly = true').replace(/^const pastedTextOnly = .*$/mu, 'const pastedTextOnly = false').replace(/^const featureEvidenceCases = .*$/mu, 'const featureEvidenceCases = new Set(' + JSON.stringify(MAC_EXCHANGE_CASES) + ')')
  const start = source.indexOf('const nativeCommand = '), end = source.indexOf('async function ownMacTarget(', start)
  assert(start > 0 && end > start)
  source = source.slice(0, start) + `let allowedNativeReads = 0, forbiddenNativeCommands = 0
const nativeCommand = async (command, args) => {
  try { const result = await readMacExchangeBundle(command, args, candidate); allowedNativeReads++; return result }
  catch (error) { forbiddenNativeCommands++; throw error }
}
` + source.slice(end)
  once("entryPoints: [join(root, 'tests/fixtures/harness-e2e-provider.mjs')]", 'entryPoints: [' + JSON.stringify(providerSource) + ']')
  once("headless: !process.argv.includes('--headed')", 'headless: true')
  once("'official-Harness-feature-evidence-subset'", "'official-Harness-Mac-file-exchange-supplement'")
  once("scope: pastedTextOnly ? 'strict-pasted-text-evidence' : 'strict-feature-evidence'", "scope: 'headless-file-exchange-only'")
  once('selectedCases: [...featureEvidenceCases], fullUIAcceptance: false', 'selectedCases: [...featureEvidenceCases], fullUIAcceptance: false, nativeUIAcceptance: false')
  once("else if (host) await Promise.race([new Promise(resolve => host.once('exit', resolve)), sleep(3000).then(() => host.kill('SIGKILL'))])", `else if (host) await new Promise(resolve => {
    if (host.exitCode !== null || host.signalCode !== null) return resolve()
    const timer = setTimeout(() => { errors.push('Owned file-only Host did not retire after its normal SIGTERM shutdown'); resolve() }, 5000)
    host.once('exit', () => { clearTimeout(timer); resolve() })
  })`)
  once("model: 'deterministic local fixture, no real account credentials'", "fileOnlyEvidence: { browserHeadless: true, domProtocolOnly: true, allowedNativeReads, forbiddenNativeCommands, nativeDriverStarted: Boolean(driver), nativeFixtureCompiled: Boolean(macTargetFixture), hostPid: host?.pid ?? null, hostRetired: Boolean(host && (host.exitCode !== null || host.signalCode !== null)), hostExitCode: host?.exitCode ?? null, hostSignal: host?.signalCode ?? null, browserCloseSucceeded: Boolean(browser && !ownedCleanupErrors.some(row => row.stage === 'browser-close')) }, model: 'deterministic local fixture, no real account credentials'")
  once('assert.deepEqual(await readFile(join(directory, name)), bytes)\n      const fileRow', "const uploadedActual = await readFile(join(directory, name)); assert.deepEqual(uploadedActual, bytes)\n      Object.assign(evidence, { uploadedActualBytes: uploadedActual.length, uploadedActualSHA256: createHash('sha256').update(uploadedActual).digest('hex') })\n      await screenshot('file-exchange-uploaded', pane)\n      const fileRow")
  once('assert.deepEqual(await readFile(saved), bytes)', "const downloadedActual = await readFile(saved); assert.deepEqual(downloadedActual, bytes)\n      Object.assign(evidence, { downloadedActualBytes: downloadedActual.length, downloadedActualSHA256: createHash('sha256').update(downloadedActual).digest('hex') })")
  once("await pane.getByText('文件已交给本机浏览器下载。', { exact: true }).waitFor()", "await pane.getByText('文件已交给本机浏览器下载。', { exact: true }).waitFor()\n      await screenshot('file-exchange-downloaded', pane)")
  once('assert.deepEqual(await readFile(join(directory, name)), bytes)', "const afterDuplicateActual = await readFile(join(directory, name)); assert.deepEqual(afterDuplicateActual, bytes)\n      Object.assign(evidence, { afterDuplicateActualBytes: afterDuplicateActual.length, afterDuplicateActualSHA256: createHash('sha256').update(afterDuplicateActual).digest('hex') })")
  once("await screenshot('file-exchange-ui')", "await screenshot('file-exchange-ui', pane)")
  once("      await server.close()\n      await writeFile(join(output, 'file-exchange-ui-evidence.json'), JSON.stringify(evidence, null, 2))", "      try { await server.close(); evidence.serverClosed = true }\n      finally { await writeFile(join(output, 'file-exchange-ui-evidence.json'), JSON.stringify(evidence, null, 2)) }")
  return source
}


export async function verifyMacFullHarnessBinding(data, base, entry) {
  assert.equal(await realpath(data.candidate),data.candidate);assert.match(data.candidateSHA256,/^[a-f0-9]{64}$/u)
  assert.equal(hash(await boundedFile(data.candidate,64*1024*1024,{singleLink:true})), data.candidateSHA256, 'Candidate changed')
  assert.equal(hash(await boundedFile(entry,1024*1024,{singleLink:true})), data.entrySHA256, 'Frozen entry changed')
  for (const [name, digest] of Object.entries(data.sourceHashes)) assert.equal(hash(await boundedFile(await realpath(join(data.repository, name)),4*1024*1024)), digest, 'Bound source changed: ' + name)
  for (const [name, digest] of Object.entries(data.snapshotHashes)) assert.equal(hash(await boundedFile(join(base, 'snapshot', name),4*1024*1024,{singleLink:true})), digest, 'Frozen dependency changed: ' + name)
  for (const [name, digest] of Object.entries(data.supportHashes)) assert.equal(hash(await boundedFile(join(base, name),4*1024*1024,{singleLink:true})), digest, 'Frozen support changed: ' + name)
  for(const[link,target]of Object.entries(data.runtimeLinks??{})){assert((await lstat(link)).isSymbolicLink());assert.equal(await readlink(link),target);assert.equal(await realpath(link),target)}
  for (const [name, digest] of Object.entries(data.runtimeHashes)) assert.equal(hash(await boundedFile(await realpath(name),512*1024*1024)), digest, 'Bound runtime changed: ' + name)
}
