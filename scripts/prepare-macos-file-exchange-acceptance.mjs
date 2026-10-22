/** Headless file-only supplement for the exact current Mac candidate. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'

export const MAC_EXCHANGE_CANDIDATE = '/Users/qiuya/QiuYaTools-验收/2026-10-22/安装包/Mac-键盘修复-66ae-验证包/dsh-qiuya-tools-darwin-universal.tgz'
export const MAC_EXCHANGE_SHA256 = '9b828d9bac4b08291bbdcef151096fcc2903b8fbbc87ae03a4f6ba26b3c5e6f3'
export const MAC_EXCHANGE_CASES = Object.freeze(['account-menu-settings-and-all-feature-tabs', 'settings-persist-thresholds-and-theme', 'real-local-model-session', 'packaged-file-exchange-real-host-upload-download-and-no-overwrite'])
export const MAC_EXCHANGE_IMAGES = Object.freeze(['file-exchange-uploaded.png', 'file-exchange-downloaded.png', 'file-exchange-ui.png'])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function assertMacExchangeExtraction(command, args, candidate) {
  assert.equal(candidate, MAC_EXCHANGE_CANDIDATE, 'Only the exact reviewed Mac candidate is readable')
  assert.equal(command, 'tar', 'Only the file-case tar command is allowed')
  assert.deepEqual(args, ['-xOf', MAC_EXCHANGE_CANDIDATE, 'package/lib/computer-agent.js'], 'Only the packaged file server member is readable')
}
export async function readMacExchangeBundle(command, args, candidate) {
  assertMacExchangeExtraction(command, args, candidate)
  assert.equal(await realpath(candidate), MAC_EXCHANGE_CANDIDATE)
  assert.equal(hash(await readFile(candidate)), MAC_EXCHANGE_SHA256, 'Mac package changed before read-only extraction')
  const result = await promisify(execFile)('/usr/bin/tar', args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })
  assert.equal(hash(await readFile(candidate)), MAC_EXCHANGE_SHA256, 'Mac package changed during read-only extraction')
  return result.stdout
}

export function makeMacFileExchangeSource(source, { repository, providerSource, policySource }) {
  const once = (before, after) => { assert.equal(source.split(before).length, 2, 'Unique file supplement anchor changed: ' + before.slice(0, 80)); source = source.replace(before, after) }
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

export function assessMacFileExchangeReport(report, evidence) {
  const rows = report?.tests ?? [], proof = report?.fileOnlyEvidence, files = report?.screenshotEvidence?.files ?? []
  const exactSelection = rows.length === MAC_EXCHANGE_CASES.length && MAC_EXCHANGE_CASES.every((name, index) => rows[index]?.name === name && rows[index].status === 'passed')
  const controlledReads = proof?.browserHeadless === true && proof?.domProtocolOnly === true && proof?.allowedNativeReads === 1 && proof?.forbiddenNativeCommands === 0 && proof?.nativeDriverStarted === false && proof?.nativeFixtureCompiled === false
  const normalExit = proof?.hostRetired === true && proof?.hostExitCode === 0 && proof?.hostSignal === null && proof?.browserCloseSucceeded === true
  const fileBytes = evidence?.size === 8 * 1024 * 1024 && /^[a-f0-9]{64}$/u.test(evidence?.sha256 ?? '') && ['uploaded', 'downloaded', 'afterDuplicate'].every(prefix => evidence?.[prefix + 'ActualBytes'] === evidence.size && evidence[prefix + 'ActualSHA256'] === evidence.sha256)
  const fileBusiness = evidence?.uploadedBytesVerified === true && evidence?.browserDownloadVerified === true && evidence?.duplicateRejectedWithoutOverwrite === true && evidence?.serverClosed === true && evidence?.calls?.status > 0 && ['observe', 'lease', 'release', 'act', 'preview'].every(name => evidence?.calls?.[name] === 0)
  const images = MAC_EXCHANGE_IMAGES.every(name => files.filter(file => file.name === name && file.bytes > 0 && /^[a-f0-9]{64}$/u.test(file.sha256)).length === 1) && report?.screenshotEvidence?.missing?.length === 0
  return { passed: Boolean(report?.status === 'passed' && report?.platform === 'darwin' && report?.kind === 'official-Harness-Mac-file-exchange-supplement' && report?.selection?.scope === 'headless-file-exchange-only' && report.selection.fullUIAcceptance === false && report.selection.nativeUIAcceptance === false && evidence?.candidateSHA256 === report.candidateSHA256 && report.candidateSHA256 === MAC_EXCHANGE_SHA256 && exactSelection && controlledReads && normalExit && fileBytes && fileBusiness && images && report?.ownedCleanup?.passed === true && report.frontendErrors?.length === 0), exactSelection, controlledReads, normalExit, fileBytes, fileBusiness, images }
}

export async function prepareMacFileExchangeAcceptance({ repository = fileURLToPath(new URL('../', import.meta.url)) } = {}) {
  assert.equal(process.platform, 'darwin')
  const id = randomUUID(), base = join(repository, 'artifacts/harness-e2e/macos-file-exchange-prepared-' + id), snapshot = join(base, 'snapshot')
  const candidate = await realpath(MAC_EXCHANGE_CANDIDATE); assert.equal(hash(await readFile(candidate)), MAC_EXCHANGE_SHA256)
  await mkdir(snapshot, { recursive: true })
  const graph = await build({ entryPoints: [join(repository, 'scripts/e2e-harness.mjs')], absWorkingDir: repository, bundle: true, packages: 'external', write: false, platform: 'node', format: 'esm', metafile: true })
  const sourceHashes = {}, snapshotHashes = {}, policySource = join(base, 'file-policy.mjs')
  const policy = await readFile(fileURLToPath(import.meta.url)); await writeFile(policySource, policy)
  for (const name of Object.keys(graph.metafile.inputs)) {
    assert(!name.startsWith('..') && !name.startsWith('/'))
    const original = await readFile(join(repository, name)), bytes = name === 'scripts/e2e-harness.mjs' ? Buffer.from(makeMacFileExchangeSource(original.toString('utf8'), { repository, providerSource: join(snapshot, 'tests/fixtures/harness-e2e-provider.mjs'), policySource })) : original
    await mkdir(dirname(join(snapshot, name)), { recursive: true }); await writeFile(join(snapshot, name), bytes)
    sourceHashes[name] = hash(original); snapshotHashes[name] = hash(bytes)
  }
  for (const name of ['scripts/prepare-macos-file-exchange-acceptance.mjs', 'tests/macos-file-exchange-acceptance.test.mjs', 'package.json', 'package-lock.json']) sourceHashes[name] = hash(await readFile(join(repository, name)))
  const closure = await build({ entryPoints: [join(snapshot, 'scripts/e2e-harness.mjs')], absWorkingDir: base, bundle: true, packages: 'external', write: false, platform: 'node', format: 'esm', metafile: true })
  const data = { id, repository, candidate, candidateSHA256: MAC_EXCHANGE_SHA256, sourceHashes, snapshotHashes, policySHA256: hash(policy), output: '/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Mac-文件交换-8MiB-' + id, screenshots: '/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Mac-文件交换-8MiB-' + id, selectedCases: MAC_EXCHANGE_CASES, requiredImages: MAC_EXCHANGE_IMAGES, scope: 'Actual packaged file-server + Host + browser upload/download only; status/targets stub, no native capture/input/lease or external model inference', snapshotImportSmoke: { passed: true, inputs: Object.keys(closure.metafile.inputs), executed: false, guiStarted: false, pdCommandsExecuted: 0 } }
  const entry = `import assert from 'node:assert/strict';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';import {assessMacFileExchangeReport,MAC_EXCHANGE_IMAGES} from './file-policy.mjs';
const base=dirname(fileURLToPath(import.meta.url)),data=JSON.parse(await readFile(join(base,'prepare-data.json'),'utf8')),hash=b=>createHash('sha256').update(b).digest('hex');async function verify(){assert.equal(hash(await readFile(fileURLToPath(import.meta.url))),data.entrySHA256);assert.equal(hash(await readFile(data.candidate)),data.candidateSHA256);for(const[name,digest]of Object.entries(data.sourceHashes))assert.equal(hash(await readFile(join(data.repository,name))),digest,'Bound source changed: '+name);for(const[name,digest]of Object.entries(data.snapshotHashes))assert.equal(hash(await readFile(join(base,'snapshot',name))),digest,'Frozen source changed: '+name);assert.equal(hash(await readFile(join(base,'file-policy.mjs'))),data.policySHA256)}
await verify();if(process.argv.includes('--plan')){console.log(JSON.stringify({...data,actualExecution:false,guiStarted:false,pdCommandsExecuted:0,nativeInput:false},null,2));process.exit(0)}assert.ok(process.argv.includes('--run')&&process.argv.includes('--root-approved'),'Root must authorize isolated headless file exchange');await mkdir(data.output,{recursive:false});await mkdir(data.screenshots,{recursive:false});await writeFile(join(data.output,'carrier-binding.json'),JSON.stringify(data,null,2));let stdout='',stderr='',exit,failure,stable=false,report,evidence;try{exit=await new Promise((done,reject)=>{const child=spawn(process.execPath,[join(base,'snapshot/scripts/e2e-harness.mjs'),'--package',data.candidate,'--output',data.output,'--screenshots-dir',data.screenshots,'--browser','chrome','--feature-evidence-only','--file-exchange-e2e'],{cwd:data.repository,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>{stdout=(stdout+b).slice(-2*1024*1024)});child.stderr.on('data',b=>{stderr=(stderr+b).slice(-2*1024*1024)});child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}))});report=JSON.parse(await readFile(join(data.output,'report.json'),'utf8'));evidence=JSON.parse(await readFile(join(data.output,'file-exchange-ui-evidence.json'),'utf8'));assert.deepEqual(exit,{code:0,signal:null});for(const name of MAC_EXCHANGE_IMAGES){const row=report.screenshotEvidence.files.find(file=>file.name===name);assert(row);const bytes=await readFile(join(data.screenshots,name));assert.equal(bytes.length,row.bytes);assert.equal(hash(bytes),row.sha256)}await verify();stable=true}catch(error){failure=error.message}finally{await writeFile(join(data.output,'carrier-stdout.log'),stdout);await writeFile(join(data.output,'carrier-stderr.log'),stderr);const behavior=assessMacFileExchangeReport(report,evidence),verdict={passed:!failure&&stable&&behavior.passed,behavior,exit,failure:failure??null,sourceStable:stable,output:data.output,screenshots:data.screenshots,scope:data.scope,pdCommandsExecuted:0,nativeInput:false,fullNativeRemoteAcceptance:false};await writeFile(join(data.output,'carrier-verdict.json'),JSON.stringify(verdict,null,2));console.log(JSON.stringify(verdict,null,2));if(!verdict.passed)process.exitCode=1}
`
  await writeFile(join(base, 'entry.mjs'), entry); data.entrySHA256 = hash(Buffer.from(entry))
  await writeFile(join(base, 'prepare-data.json'), JSON.stringify(data, null, 2))
  await promisify(execFile)(process.execPath, [join(base, 'entry.mjs'), '--plan'], { cwd: repository, maxBuffer: 2 * 1024 * 1024 })
  return { base, entry: join(base, 'entry.mjs'), output: data.output, screenshots: data.screenshots, candidateSHA256: MAC_EXCHANGE_SHA256, selectedCases: MAC_EXCHANGE_CASES, requiredImages: MAC_EXCHANGE_IMAGES, snapshotImportSmoke: data.snapshotImportSmoke, executed: false, guiStarted: false, pdCommandsExecuted: 0 }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) console.log(JSON.stringify(await prepareMacFileExchangeAcceptance(), null, 2))
