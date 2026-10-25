/** Prepare an immutable Windows UI-only supplement. Preparation never contacts PD. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'

export const WINDOWS_UI_STATE_CASES = Object.freeze([
  'account-menu-settings-and-all-feature-tabs',
  'settings-persist-thresholds-and-theme',
  'real-local-model-session',
  'prompt-suggestion-tab-and-escape',
  'session-menus-copy-unread-and-pin',
])
export const WINDOWS_UI_STATE_IMAGES = Object.freeze([
  'thresholds-saved.png', 'prompt-suggestion.png', 'prompt-accepted.png',
  'session-menu-copy.png', 'session-menu-unread.png', 'session-menu-pin.png',
])

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Unique UI supplement anchor changed: ' + before.slice(0, 90))
  return source.replace(before, after)
}

export function makeWindowsUIStateSource(source) {
  source = source.replace(/^const featureEvidenceOnly = .*$/mu, 'const featureEvidenceOnly = true')
    .replace(/^const pastedTextOnly = .*$/mu, 'const pastedTextOnly = false')
    .replace(/^const featureEvidenceCases = .*$/mu, `const featureEvidenceCases = new Set(${JSON.stringify(WINDOWS_UI_STATE_CASES)})`)
  const start = source.indexOf('const nativeCommand = '), end = source.indexOf('async function ownMacTarget(', start)
  assert.ok(start > 0 && end > start, 'Expected native command boundary')
  source = source.slice(0, start) + "let forbiddenNativeCommandCalls = 0\nconst nativeCommand = async () => { forbiddenNativeCommandCalls++; throw new Error('Native commands are excluded from the Windows UI-state supplement') }\n" + source.slice(end)
  source = replaceOnce(source, "headless: !process.argv.includes('--headed')", 'headless: true')
  for (const [before, after] of [
    ["assert.equal(await page.getByRole('spinbutton').nth(1).inputValue(), '4')", "assert.equal(await page.getByRole('spinbutton').nth(1).inputValue(), '4'); await screenshot('thresholds-saved')"],
    ["assert.equal(await ghost.innerText(), '继续检查本地测试结果。')", "assert.equal(await ghost.innerText(), '继续检查本地测试结果。'); await screenshot('prompt-suggestion')"],
    ["await editor().press('Tab'); assert.equal(await editor().innerText(), '继续检查本地测试结果。')\n    await screenshot('prompt-accepted')", "await editor().press('Tab'); assert.equal(await editor().innerText(), '继续检查本地测试结果。'); await screenshot('prompt-accepted')"],
    ["await menu(alpha); await page.getByRole('menuitem', { name: '复制会话标题', exact: true }).click()", "await menu(alpha); await screenshot('session-menu-copy'); await page.getByRole('menuitem', { name: '复制会话标题', exact: true }).click()"],
    ["await row(alpha).locator('[data-qyt-manual-unread=\"true\"]').waitFor()", "await row(alpha).locator('[data-qyt-manual-unread=\"true\"]').waitFor(); await screenshot('session-menu-unread')"],
    ["await menu(alpha); await page.getByRole('menuitem', { name: '取消置顶', exact: false }).waitFor(); await screenshot('session-menu-pin'); await page.keyboard.press('Escape')", "await menu(alpha); await page.getByRole('menuitem', { name: '取消置顶', exact: false }).waitFor(); await screenshot('session-menu-pin'); await page.keyboard.press('Escape')"],
  ]) source = replaceOnce(source, before, after)
  source = replaceOnce(source, "'official-Harness-feature-evidence-subset'", "'official-Harness-Windows-UI-state-supplement'")
  source = replaceOnce(source, "scope: pastedTextOnly ? 'strict-pasted-text-evidence' : 'strict-feature-evidence'", "scope: 'headless-windows-ui-states'")
  source = replaceOnce(source, 'selectedCases: [...featureEvidenceCases], fullUIAcceptance: false', 'selectedCases: [...featureEvidenceCases], fullUIAcceptance: false, nativeUIAcceptance: false')
  source = replaceOnce(source, "{ name: 'host-shutdown', run: () => { host?.stdin.end(); host?.kill('SIGTERM') } }", "{ name: 'host-shutdown', run: () => { host?.stdin.end() } }")
  source = replaceOnce(source, "else if (host) await Promise.race([new Promise(resolve => host.once('exit', resolve)), sleep(3000).then(() => host.kill('SIGKILL'))])", `else if (host) await new Promise(resolve => {
    if (host.exitCode !== null || host.signalCode !== null) return resolve()
    const timer = setTimeout(() => { errors.push('Owned UI-only Host did not retire after its normal SIGTERM shutdown'); resolve() }, 5000)
    host.once('exit', () => { clearTimeout(timer); resolve() })
  })`)
  source = replaceOnce(source, "model: 'deterministic local fixture, no real account credentials'", "uiStateOnlyEvidence: { browserHeadless: true, domProtocolOnly: true, nativeCommandCalls: forbiddenNativeCommandCalls, nativeDriverStarted: Boolean(driver), nativeFixtureCompiled: Boolean(macTargetFixture), hostRetired: Boolean(host && (host.exitCode !== null || host.signalCode !== null)), hostExitCode: host?.exitCode ?? null, hostSignal: host?.signalCode ?? null, hostCloseReceipt: await readFile(join(profileHome, 'e2e-ui-normal-close.json'), 'utf8').then(JSON.parse).catch(() => null), browserCloseSucceeded: Boolean(browser && !ownedCleanupErrors.some(row => row.stage === 'browser-close')) }, model: 'deterministic local fixture, no real account credentials'")
  return source
}

export function makeWindowsUIProviderSource(source) {
  // The shared provider now carries the passive Mac evidence imports too.
  // Bind that exact reviewed import; writeFileSync is already available.
  const fsImport = "import { appendFileSync, readFileSync, realpathSync, writeFileSync, constants } from 'node:fs'"
  assert.equal(source.split(fsImport).length, 2, 'Unique UI supplement provider import changed')
  const anchor = "  if (process.env.QIUYA_HARNESS_E2E !== '1' || !process.env.DSH_HOME?.includes('qiuya-harness-')) throw new Error('The E2E provider requires a dedicated temporary DSH_HOME')"
  return replaceOnce(source, anchor, anchor + `
  // Frozen UI-only test adapter. stdin EOF invokes the already registered
  // official runProfile SIGTERM lifecycle event, without Windows process.kill.
  if (process.platform === 'win32') ctx.effect(() => {
    const closeOwnUIHost = () => {
      const signalListenerCount = process.listenerCount('SIGTERM')
      if (signalListenerCount < 1) throw new Error('Official Host shutdown listener is absent')
      writeFileSync(join(process.env.DSH_HOME, 'e2e-ui-normal-close.json'), JSON.stringify({ source: 'own-stdin-eof-to-official-sigterm-handler', noProcessKill: true, signalListenerCount }))
      process.emit('SIGTERM')
    }
    process.stdin.once('end', closeOwnUIHost); process.stdin.resume()
    return () => { process.stdin.off('end', closeOwnUIHost); process.stdin.pause() }
  })`)
}

export function assessWindowsUIStateReport(report) {
  const rows = report?.tests ?? [], proof = report?.uiStateOnlyEvidence
  const exactSelection = rows.length === WINDOWS_UI_STATE_CASES.length && WINDOWS_UI_STATE_CASES.every((name, index) => rows[index]?.name === name && rows[index].status === 'passed')
  const noNativeExecution = proof?.browserHeadless === true && proof?.domProtocolOnly === true && proof?.nativeCommandCalls === 0 && proof?.nativeDriverStarted === false && proof?.nativeFixtureCompiled === false
  const close = proof?.hostCloseReceipt
  const retired = proof?.hostRetired === true && proof?.hostExitCode === 0 && proof?.hostSignal === null && proof?.browserCloseSucceeded === true && close?.source === 'own-stdin-eof-to-official-sigterm-handler' && close?.noProcessKill === true && Number.isSafeInteger(close?.signalListenerCount) && close.signalListenerCount >= 1
  const files = report?.screenshotEvidence?.files ?? []
  const requiredImages = WINDOWS_UI_STATE_IMAGES.every(name => files.filter(file => file.name === name && Number.isSafeInteger(file.bytes) && file.bytes > 0 && /^[a-f0-9]{64}$/u.test(file.sha256)).length === 1)
  const noImageGap = Array.isArray(report?.screenshotEvidence?.missing) && report.screenshotEvidence.missing.length === 0
  return { passed: Boolean(report?.status === 'passed' && report?.platform === 'win32' && report?.kind === 'official-Harness-Windows-UI-state-supplement' && report?.selection?.scope === 'headless-windows-ui-states' && report.selection.fullUIAcceptance === false && report.selection.nativeUIAcceptance === false && exactSelection && noNativeExecution && retired && requiredImages && noImageGap && report?.ownedCleanup?.passed === true && Array.isArray(report?.frontendErrors) && report.frontendErrors.length === 0), exactSelection, noNativeExecution, retired, requiredImages, noImageGap }
}

export function makeWindowsUIStateEntry(entry) {
  entry = replaceOnce(entry, "import { harnessPostflight } from './postflight-assets.mjs'", "import { harnessPostflight } from './postflight-assets.mjs'\nimport { assessWindowsUIStateReport } from './windows-ui-state-policy.mjs'")
  entry = replaceOnce(entry, "assert.notEqual(planning, executing, 'Pass exactly one of --plan or --run')", "assert.notEqual(planning, executing, 'Pass exactly one of --plan or --run')\nif (executing) assert.ok(process.argv.includes('--root-approved') && process.argv.includes('--no-install'), 'Root must schedule this UI-only scope; installer is excluded')")
  entry = replaceOnce(entry, "for (const [name, hash] of Object.entries(data.snapshotHashes))", "for (const [name, expected] of Object.entries(data.sourceHashes)) if (expected !== null) assert.equal(digest(await readFile(join(data.root, name))), expected, 'Reviewed source changed: ' + name)\nfor (const [name, hash] of Object.entries(data.snapshotHashes))")
  entry = entry.replace("QIUYA_WINDOWS_MANUAL_PREVIEW: '1'", "QIUYA_WINDOWS_MANUAL_PREVIEW: '0'").replace("QIUYA_WINDOWS_DRAG_WINDOW: '1'", "QIUYA_WINDOWS_DRAG_WINDOW: '0'").replace("QIUYA_WINDOWS_FILE_EXCHANGE: '1'", "QIUYA_WINDOWS_FILE_EXCHANGE: '0'")
  entry = replaceOnce(entry, "current strict feature-evidence subset; full-suite results preserved in1160", 'headless Windows UI-state supplement; native input excluded, full-suite results preserved in1160')
  entry = replaceOnce(entry, "try { await import(pathToFileURL(join(data.snapshot, 'scripts/e2e-windows-harness-pd.mjs')).href) }", "try { await import(pathToFileURL(join(data.snapshot, 'scripts/e2e-windows-harness-pd.mjs')).href); const report = JSON.parse(await readFile(join(output, 'evidence/report.json'), 'utf8')); const verdict = assessWindowsUIStateReport(report); await writeFile(join(output, 'ui-state-verdict.json'), JSON.stringify(verdict, null, 2)); assert.equal(verdict.passed, true, 'UI-only state evidence or natural retirement was incomplete') }")
  return entry
}

export function makeWindowsUIStateRunner() {
  return `import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
const base=dirname(fileURLToPath(import.meta.url)),data=JSON.parse(await readFile(join(base,'prepare-data.json'),'utf8')),arg=n=>{const i=process.argv.indexOf(n);return i<0?undefined:process.argv[i+1]},arch=arg('--arch');assert.ok(['arm64','x64'].includes(arch));assert.equal(createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),data.runnerSHA256,'Frozen runner changed');const candidate=data.candidates[arch],execute=promisify(execFile),prl='/Applications/Parallels Desktop.app/Contents/MacOS/prlctl',vm='ffba3614-b0e4-4b38-b185-b9a4b7ba5aec',planning=process.argv.includes('--plan'),args=[join(base,'entry.mjs'),planning?'--plan':'--run','--no-install','--arch',arch,'--package',candidate.path,'--expected-sha256',candidate.sha256,'--output',join(base,'runs',arch),'--screenshots-dir','/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Windows-'+arch+'-UI三状态-'+data.id];
if(planning){const planned=await execute(process.execPath,args,{cwd:data.root,maxBuffer:2e6});console.log(planned.stdout);process.exit(0)}assert.ok(process.argv.includes('--run')&&process.argv.includes('--root-approved'),'Root must schedule the PD slot');await execute(process.execPath,args.map(value=>value==='--run'?'--plan':value),{cwd:data.root,maxBuffer:2e6});args.push('--root-approved');let originalIdle,code=1,idleChanged=false;try{const before=(await execute(prl,['list','--info',vm],{timeout:30000})).stdout;originalIdle=/Pause idle: (on|off)/u.exec(before)?.[1];assert.ok(originalIdle,'Original PD idle state must be known');await execute(prl,['set',vm,'--pause-idle','off'],{timeout:30000});idleChanged=true;if(/^State: paused$/mu.test(before))await execute(prl,['resume',vm],{timeout:30000});code=await new Promise((done,reject)=>{const child=spawn(process.execPath,args,{cwd:data.root,stdio:'inherit'});child.once('error',reject);child.once('exit',(value,signal)=>done(signal?1:value??1))})}finally{if(idleChanged){await execute(prl,['set',vm,'--pause-idle',originalIdle],{timeout:30000});const after=(await execute(prl,['list','--info',vm],{timeout:30000})).stdout;const restored=new RegExp('Pause idle: '+originalIdle).test(after);await writeFile(join(base,'vm-pause-restored-'+arch+'.json'),JSON.stringify({restored,originalIdle,childExitCode:code}));if(!restored)code=1}}process.exitCode=code;
`
}

export async function prepareWindowsUIStateAcceptance({ repository = fileURLToPath(new URL('../', import.meta.url)), seed = join(repository, 'artifacts/harness-e2e/windows-feature-evidence-prepared-7da13ea6-3146-4a71-83cb-c6158247d8d0') } = {}) {
  const hash = data => createHash('sha256').update(data).digest('hex'), run = promisify(execFile)
  const seedData = JSON.parse(await readFile(join(seed, 'prepare-data.json'), 'utf8'))
  assert.equal(seedData.entrySHA256, '13c21e5c153449baa66bddad506ae0b8fa9380196ce4d0b3eb1fa2d48f1b7311', 'Only the reviewed natural-retirement seed is accepted')
  assert.equal(hash(await readFile(join(seed, 'entry.mjs'))), seedData.entrySHA256)
  const id = randomUUID(), base = join(repository, 'artifacts/harness-e2e/windows-ui-states-prepared-' + id), snapshot = join(base, 'snapshot')
  await mkdir(base, { recursive: false })
  const sourceHashes = {}, snapshotHashes = {}, supportHashes = {}
  for (const [file, expected] of Object.entries(seedData.snapshotHashes)) {
    const original = await readFile(join(seedData.snapshot, file))
    assert.equal(hash(original), expected, 'Seed frozen input changed: ' + file)
    const liveHash = seedData.sourceHashes[file]
    if (liveHash !== null) assert.equal(hash(await readFile(join(repository, file))), liveHash, 'Reviewed source changed: ' + file)
    const bytes = file === 'scripts/e2e-harness.mjs' ? Buffer.from(makeWindowsUIStateSource(original.toString('utf8'))) : file === 'tests/fixtures/harness-e2e-provider.mjs' ? Buffer.from(makeWindowsUIProviderSource(original.toString('utf8'))) : original
    await mkdir(dirname(join(snapshot, file)), { recursive: true }); await writeFile(join(snapshot, file), bytes)
    sourceHashes[file] = liveHash; snapshotHashes[file] = hash(bytes)
  }
  for (const file of Object.keys(seedData.supportHashes)) {
    const bytes = await readFile(join(seed, file)); assert.equal(hash(bytes), seedData.supportHashes[file], 'Seed support changed: ' + file)
    await mkdir(dirname(join(base, file)), { recursive: true }); await writeFile(join(base, file), bytes); supportHashes[file] = hash(bytes)
  }
  for (const file of ['scripts/prepare-windows-ui-state-acceptance.mjs', 'tests/windows-ui-state-acceptance.test.mjs']) sourceHashes[file] = hash(await readFile(join(repository, file)))
  const policy = await readFile(fileURLToPath(import.meta.url)); await writeFile(join(base, 'windows-ui-state-policy.mjs'), policy)
  supportHashes['windows-ui-state-policy.mjs'] = hash(policy)
  const data = { ...seedData, id, output: base, snapshot, sourceCommit: (await run('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(), sourceHashes, snapshotHashes, supportHashes, seed: { path: seed, entrySHA256: seedData.entrySHA256 }, previous: join(base, 'packages/dsh-qiuya-tools-0.5.2.tgz'), selectedCases: WINDOWS_UI_STATE_CASES, requiredImages: WINDOWS_UI_STATE_IMAGES, scope: 'Three Windows UI states plus their two public prerequisites; headless browser protocol, no native input or real external model', snapshotOnlyInstrumentation: [...seedData.snapshotOnlyInstrumentation, { file: 'scripts/e2e-harness.mjs', reason: 'Five exact UI-only cases; six state screenshots after unchanged business assertions; forced headless plus nativeCommand tripwire; no process kill, stdin EOF lifecycle and actual Host exit receipt; separate subset report. Shipping code and native thresholds unchanged.' }, { file: 'tests/fixtures/harness-e2e-provider.mjs', reason: 'Dedicated disposable Host only: stdin EOF emits the official already registered runProfile SIGTERM event, records finite receipt, no OS kill or new network/product shutdown API.' }] }
  for (const arch of ['arm64', 'x64']) {
    data.manifests[arch] = { ...seedData.manifests[arch], manifestPath: join(base, 'runtimes', arch, 'manifest.json') }
    assert.equal(hash(await readFile(data.candidates[arch].path)), data.candidates[arch].sha256)
  }
  const closure = await build({ entryPoints: [join(snapshot, 'scripts/e2e-harness.mjs')], absWorkingDir: base, bundle: true, packages: 'external', write: false, platform: 'node', format: 'esm', metafile: true })
  data.snapshotImportSmoke = { passed: true, executed: false, inputs: Object.keys(closure.metafile.inputs), windowsCommandsExecuted: false, guiStarted: false }
  const entry = makeWindowsUIStateEntry(await readFile(join(seed, 'entry.mjs'), 'utf8'))
  data.entrySHA256 = hash(Buffer.from(entry)); await writeFile(join(base, 'entry.mjs'), entry)
  const runner = makeWindowsUIStateRunner()
  await writeFile(join(base, 'run.mjs'), runner); data.runnerSHA256 = hash(Buffer.from(runner))
  await writeFile(join(base, 'prepare-data.json'), JSON.stringify(data, null, 2) + '\n')
  for (const arch of ['arm64', 'x64']) await run(process.execPath, [join(base, 'run.mjs'), '--plan', '--arch', arch], { cwd: repository, maxBuffer: 2 * 1024 * 1024 })
  return { entry: join(base, 'entry.mjs'), runner: join(base, 'run.mjs'), base, id, sourceCount: Object.keys(sourceHashes).length, selectedCases: WINDOWS_UI_STATE_CASES, requiredImages: WINDOWS_UI_STATE_IMAGES, snapshotImportSmoke: data.snapshotImportSmoke, executed: false, windowsCommandsExecuted: false, guiStarted: false }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) console.log(JSON.stringify(await prepareWindowsUIStateAcceptance(), null, 2))
