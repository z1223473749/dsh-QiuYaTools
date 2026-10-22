import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { makeWindowsUIStateSource, makeWindowsUIProviderSource, assessWindowsUIStateReport, prepareWindowsUIStateAcceptance, WINDOWS_UI_STATE_CASES, WINDOWS_UI_STATE_IMAGES } from '../scripts/prepare-windows-ui-state-acceptance.mjs'

function report() {
  return { status: 'passed', platform: 'win32', kind: 'official-Harness-Windows-UI-state-supplement', tests: WINDOWS_UI_STATE_CASES.map(name => ({ name, status: 'passed' })), selection: { scope: 'headless-windows-ui-states', fullUIAcceptance: false, nativeUIAcceptance: false }, uiStateOnlyEvidence: { browserHeadless: true, domProtocolOnly: true, nativeCommandCalls: 0, nativeDriverStarted: false, nativeFixtureCompiled: false, hostRetired: true, hostExitCode: 0, hostSignal: null, hostCloseReceipt: { source: 'own-stdin-eof-to-official-sigterm-handler', noProcessKill: true, signalListenerCount: 1 }, browserCloseSucceeded: true }, screenshotEvidence: { missing: [], files: WINDOWS_UI_STATE_IMAGES.map(name => ({ name, bytes: 150, sha256: 'a'.repeat(64) })) }, ownedCleanup: { passed: true }, frontendErrors: [] }
}

test('Windows state supplement requires exact UI cases, six real state-image receipts and normal Host lifecycle', () => {
  assert.equal(assessWindowsUIStateReport(report()).passed, true)
  for (const mutate of [r => r.tests.pop(), r => r.tests.push({ name: 'computer-main-agent-tools-and-image-adapter-pipeline', status: 'passed' }), r => r.tests[2].status = 'failed', r => r.uiStateOnlyEvidence.nativeCommandCalls = 1, r => r.uiStateOnlyEvidence.nativeDriverStarted = true, r => r.uiStateOnlyEvidence.nativeFixtureCompiled = true, r => r.uiStateOnlyEvidence.browserHeadless = false, r => r.uiStateOnlyEvidence.hostRetired = false, r => r.uiStateOnlyEvidence.hostExitCode = 1, r => r.uiStateOnlyEvidence.hostSignal = 'SIGTERM', r => r.uiStateOnlyEvidence.hostCloseReceipt = null, r => r.uiStateOnlyEvidence.hostCloseReceipt.noProcessKill = false, r => r.uiStateOnlyEvidence.hostCloseReceipt.signalListenerCount = 0, r => r.uiStateOnlyEvidence.browserCloseSucceeded = false, r => r.platform = 'darwin', r => r.selection.fullUIAcceptance = true, r => r.selection.nativeUIAcceptance = true, r => r.frontendErrors.push('render'), r => r.ownedCleanup.passed = false]) {
    const value = report(); mutate(value); assert.equal(assessWindowsUIStateReport(value).passed, false)
  }
})

test('missing, duplicate, empty, unknown-digest or uncollected state image cannot pass', () => {
  for (const mutate of [r => r.screenshotEvidence.files.pop(), r => r.screenshotEvidence.files.push(r.screenshotEvidence.files[0]), r => r.screenshotEvidence.files[0].bytes = 0, r => r.screenshotEvidence.files[0].sha256 = 'unverified', r => r.screenshotEvidence.missing.push('session-menu-pin.png')]) {
    const value = report(); mutate(value); assert.equal(assessWindowsUIStateReport(value).passed, false)
  }
})

test('snapshot retains business assertions, adds all state images, denies native and removes Host kill', async () => {
  const original = await readFile(new URL('../scripts/e2e-harness.mjs', import.meta.url), 'utf8')
  const source = makeWindowsUIStateSource(original)
  const cases = JSON.parse(/const featureEvidenceCases = new Set\((\[[^\n]+\])\)/u.exec(source)[1])
  assert.deepEqual(cases, WINDOWS_UI_STATE_CASES)
  assert(source.includes('headless: true'))
  for (const name of WINDOWS_UI_STATE_IMAGES) assert(source.includes(`await screenshot('${name.slice(0, -4)}')`))
  assert(source.includes("assert.equal(await page.getByRole('spinbutton').nth(0).inputValue(), '60')"))
  assert(source.includes("assert.equal(await page.getByRole('spinbutton').nth(1).inputValue(), '4')"))
  assert(source.includes("assert.equal(await page.evaluate(() => window.__e2eClipboard), alpha)"))
  assert(!source.includes("host?.kill('SIGTERM')"))
  assert(!source.includes("else if (host) await Promise.race"))
  const guard = /let forbiddenNativeCommandCalls = 0\nconst nativeCommand = [^\n]+/u.exec(source)[0]
  const invoke = new Function(guard + ';return async()=>{try{await nativeCommand()}catch(error){return {count:forbiddenNativeCommandCalls,message:error.message}}}')()
  assert.deepEqual(await invoke(), { count: 1, message: 'Native commands are excluded from the Windows UI-state supplement' })
  assert.throws(() => makeWindowsUIStateSource('unknown runner'), /boundary/)
})

test('test-only EOF adapter calls existing official lifecycle event, records finite receipt and disposes listener', async () => {
  const source = makeWindowsUIProviderSource(await readFile(new URL('fixtures/harness-e2e-provider.mjs', import.meta.url), 'utf8'))
  assert(source.includes("process.emit('SIGTERM')"))
  assert(!source.includes('process.kill('))
  const start = source.indexOf("  if (process.platform === 'win32') ctx.effect(() => {"), end = source.indexOf('\n  // Test-only, owner-only finite readback.', start)
  assert(start > 0 && end > start)
  const block = source.slice(start, end)
  const processFixture = new EventEmitter(); processFixture.platform = 'win32'; processFixture.env = { DSH_HOME: '/own-temporary/qiuya-harness-home' }
  processFixture.stdin = new EventEmitter(); processFixture.stdin.resume = () => {}; processFixture.stdin.pause = () => {}
  let officialShutdowns = 0, cleanup, receipt
  processFixture.on('SIGTERM', () => officialShutdowns++)
  new Function('process', 'ctx', 'join', 'writeFileSync', block)(processFixture, { effect: setup => { cleanup = setup() } }, (...parts) => parts.join('/'), (filename, text) => { receipt = { filename, ...JSON.parse(text) } })
  assert.equal(officialShutdowns, 0)
  processFixture.stdin.emit('end')
  assert.equal(officialShutdowns, 1)
  assert.equal(receipt.source, 'own-stdin-eof-to-official-sigterm-handler')
  assert.equal(receipt.noProcessKill, true)
  assert.equal(receipt.signalListenerCount, 1)
  cleanup(); assert.equal(processFixture.stdin.listenerCount('end'), 0)
})

test('fresh carrier prepares and plans both packages without PD, browser, account or native execution', async () => {
  const made = await prepareWindowsUIStateAcceptance()
  assert.equal(made.executed, false); assert.equal(made.windowsCommandsExecuted, false); assert.equal(made.guiStarted, false)
  assert.equal(made.snapshotImportSmoke.passed, true)
  const execute = promisify(execFile)
  for (const arch of ['arm64', 'x64']) {
    const plan = JSON.parse((await execute(process.execPath, [made.runner, '--plan', '--arch', arch], { maxBuffer: 2 * 1024 * 1024, timeout: 30000 })).stdout)
    assert.equal(plan.windowsCommandsExecuted, false); assert.equal(plan.guiStarted, false); assert.equal(plan.installLifecycle, false)
  }
  const denied = await execute(process.execPath, [made.runner, '--run', '--arch', 'arm64'], { maxBuffer: 100000, timeout: 30000 }).catch(error => error)
  assert.notEqual(denied.code, 0)
  assert.match(denied.stderr, /Root must schedule/)
})
