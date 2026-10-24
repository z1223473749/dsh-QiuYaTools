import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { makeWindowsUIStateSource, makeWindowsUIProviderSource, assessWindowsUIStateReport, makeWindowsUIStateEntry, makeWindowsUIStateRunner, WINDOWS_UI_STATE_CASES, WINDOWS_UI_STATE_IMAGES } from '../scripts/prepare-windows-ui-state-acceptance.mjs'

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
  const start = source.indexOf("  if (process.platform === 'win32') ctx.effect(() => {")
  const close = '\n  })', end = source.indexOf(close, start) + close.length
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

test('shared UI carrier renderers plan self-contained receipts for both architectures and reject source/approval drift before PD', async () => {
  const directory=await mkdtemp(join(tmpdir(),'qyt-ui-carrier-unit-')),execute=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex')
  try {
    const snapshot=join(directory,'snapshot');await mkdir(snapshot)
    const ownInput=Buffer.from('unit-only reviewed source bytes');await writeFile(join(directory,'source.txt'),ownInput);await writeFile(join(snapshot,'source.txt'),ownInput)
    const entry=makeWindowsUIStateEntry(await readFile(new URL('./fixtures/windows-ui-entry-unit-seed.mjs',import.meta.url),'utf8'))
    const runner=makeWindowsUIStateRunner();await writeFile(join(directory,'entry.mjs'),entry);await writeFile(join(directory,'run.mjs'),runner)
    await writeFile(join(directory,'postflight-assets.mjs'),"export async function harnessPostflight(){throw Error('Unit plan must not execute a Host or postflight')}\n")
    await writeFile(join(directory,'windows-ui-state-policy.mjs'),"export function assessWindowsUIStateReport(){throw Error('Unit plan must not execute Windows acceptance')}\n")
    const candidates={}
    for(const architecture of ['arm64','x64']){const path=join(directory,architecture+'-unit.tgz'),bytes=Buffer.from('UNIT RECEIPT ONLY '+architecture);await writeFile(path,bytes);candidates[architecture]={path,sha256:hash(bytes)}}
    const data={id:'unit-only',root:directory,snapshot,sourceHashes:{'source.txt':hash(ownInput)},snapshotHashes:{'source.txt':hash(ownInput)},candidates,entrySHA256:hash(entry),runnerSHA256:hash(runner)}
    await writeFile(join(directory,'prepare-data.json'),JSON.stringify(data))
    for(const architecture of ['arm64','x64']){
      const plan=JSON.parse((await execute(process.execPath,[join(directory,'run.mjs'),'--plan','--arch',architecture],{maxBuffer:2*1024*1024,timeout:30000})).stdout)
      assert.equal(plan.status,'prepared-not-run');assert.equal(plan.windowsCommandsExecuted,false);assert.equal(plan.guiStarted,false);assert.equal(plan.installLifecycle,false);assert.equal(plan.candidateSHA256,candidates[architecture].sha256)
      assert.deepEqual(plan.mode,{QIUYA_WINDOWS_MANUAL_PREVIEW:'0',QIUYA_WINDOWS_DRAG_WINDOW:'0',QIUYA_WINDOWS_FILE_EXCHANGE:'0'})
    }
    const denied=await execute(process.execPath,[join(directory,'run.mjs'),'--run','--arch','arm64'],{maxBuffer:100000,timeout:30000}).catch(error=>error)
    assert.notEqual(denied.code,0);assert.match(denied.stderr,/Root must schedule/)
    const entryDenied=await execute(process.execPath,[join(directory,'entry.mjs'),'--run','--root-approved','--arch','arm64'],{maxBuffer:100000,timeout:30000}).catch(error=>error)
    assert.notEqual(entryDenied.code,0);assert.match(entryDenied.stderr,/installer is excluded/)
    await writeFile(join(directory,'source.txt'),'changed')
    const tampered=await execute(process.execPath,[join(directory,'run.mjs'),'--plan','--arch','x64'],{maxBuffer:100000,timeout:30000}).catch(error=>error)
    assert.notEqual(tampered.code,0);assert.match(tampered.stderr,/Reviewed source changed/)
    assert.throws(()=>makeWindowsUIStateEntry('unknown seed'),/anchor/)
  } finally {await rm(directory,{recursive:true,force:true})}
})
