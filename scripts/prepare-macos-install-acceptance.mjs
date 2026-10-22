/** Official-manager acceptance in a new DSH_HOME; never opens an application UI. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const MAC_INSTALL_CASES = Object.freeze([
  'previous-version-clean-install-and-real-host-start',
  'candidate-upgrade-restart-and-settings-preserved',
  'broken-package-install-fails-and-current-version-still-starts',
  'explicit-rollback-restart-and-settings-preserved',
  'candidate-reinstall-after-rollback',
])

const shutdownAttempts = new WeakMap()
/** Only the passed ChildProcess receives one normal SIGTERM. Never escalates. */
export async function stopMacInstallHost(child, { timeoutMs = 5000 } = {}) {
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000)
  const before = { code: child.exitCode ?? null, signal: child.signalCode ?? null }
  let attempt = shutdownAttempts.get(child)
  if (!attempt) {
    attempt = { stdinEnded: false, signalSent: false, signalAccepted: false }
    shutdownAttempts.set(child, attempt)
    if (before.code === null && before.signal === null) {
      child.stdin.end(); attempt.stdinEnded = true
      attempt.signalSent = true; attempt.signalAccepted = child.kill('SIGTERM')
    }
  }
  let timedOut = false
  if (child.exitCode === null && child.signalCode === null) await new Promise(done => {
    const finish = () => { clearTimeout(timer); child.off('exit', finish); done() }
    const timer = setTimeout(() => { timedOut = true; finish() }, timeoutMs)
    child.once('exit', finish)
    if (child.exitCode !== null || child.signalCode !== null) finish()
  })
  const code = child.exitCode ?? null, signal = child.signalCode ?? null
  return { pid: child.pid, passed: !timedOut && code === 0 && signal === null, before, ...attempt, timeoutMs, timedOut, exitCode: code, exitSignal: signal, forced: false, signalKind: attempt.signalSent ? 'SIGTERM' : null, boundary: 'One normal SIGTERM to this owned ChildProcess, bounded read-only wait, no SIGKILL or process-name cleanup' }
}

export function makeMacInstallSource(source) {
  const once = (before, after) => { assert.equal(source.split(before).length, 2, 'Unique install snapshot anchor changed: ' + before.slice(0, 80)); source = source.replace(before, after) }
  once("import { waitForHarnessHostUrl } from './harness-host-readiness.mjs'", "import { waitForHarnessHostUrl } from './harness-host-readiness.mjs'\nimport { stopMacInstallHost } from './install-policy.mjs'")
  once('let host\n', 'let host\nconst hostExitReceipts = []\n')
  const start = source.indexOf('async function stop() {'), end = source.indexOf('async function loaded() {', start)
  assert(start > 0 && end > start)
  source = source.slice(0, start) + `async function stop() {
  if (!host) return
  const receipt = await stopMacInstallHost(host, { timeoutMs: 5000 })
  hostExitReceipts.push(receipt)
  await writeFile(join(output, 'owned-host-exits.json'), JSON.stringify({ receipts: hostExitReceipts, noEscalation: true }, null, 2))
  if (!receipt.passed) throw new Error('Owned install Host did not complete its normal SIGTERM shutdown with exit0')
  host = undefined
}
` + source.slice(end)
  once('checks, candidateSha256: originalHashes[1]', 'checks, hostExitReceipts, candidateSha256: originalHashes[1]')
  once('} finally { await stop(); await rm(temporary, { recursive: true, force: true }) }', `} finally {
  let cleanupError
  try { await stop() } catch (error) { cleanupError = redact(error.message) }
  const hostRetired = !host || host.exitCode !== null || host.signalCode !== null
  const cleanup = { passed: !cleanupError && hostRetired, hostRetired, hostExitReceipts, noEscalation: true, temporaryRemoved: false, error: cleanupError ?? null }
  if (hostRetired) { await rm(temporary, { recursive: true, force: true }); cleanup.temporaryRemoved = true }
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  report.cleanup = cleanup
  if (!cleanup.passed) { report.status = 'failed'; process.exitCode = 1 }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
}`)
  return source
}

export function assessMacInstallReport(report) {
  const checks = report?.checks ?? [], exits = report?.hostExitReceipts ?? []
  const exactChecks = checks.length === MAC_INSTALL_CASES.length && MAC_INSTALL_CASES.every((name, index) => checks[index]?.name === name && checks[index].status === 'passed')
  const normalExits = exits.length === 5 && exits.every(row => row.passed === true && row.stdinEnded === true && row.signalSent === true && row.signalAccepted === true && row.signalKind === 'SIGTERM' && row.exitCode === 0 && row.exitSignal === null && row.timedOut === false && row.forced === false)
  const cleanup = report?.cleanup
  return { passed: Boolean(report?.status === 'passed' && report?.platform === 'darwin' && report?.isolation === true && exactChecks && normalExits && cleanup?.passed === true && cleanup.hostRetired === true && cleanup.noEscalation === true && cleanup.temporaryRemoved === true && cleanup.error === null), exactChecks, normalExits, temporaryRemoved: cleanup?.temporaryRemoved === true }
}

export async function prepareMacInstallAcceptance({ repository = fileURLToPath(new URL('../', import.meta.url)) } = {}) {
  assert.equal(process.platform, 'darwin')
  const hash = b => createHash('sha256').update(b).digest('hex'), run = promisify(execFile)
  const id = randomUUID(), base = join(repository, 'artifacts/harness-e2e/macos-install-prepared-' + id)
  const candidate = await realpath('/Users/qiuya/QiuYaTools-验收/2026-10-22/安装包/Mac-键盘修复-66ae-验证包/dsh-qiuya-tools-darwin-universal.tgz')
  const previous = join(repository, 'artifacts/harness-e2e/windows-feature-evidence-prepared-7da13ea6-3146-4a71-83cb-c6158247d8d0/packages/dsh-qiuya-tools-0.5.2.tgz')
  const candidateSHA256 = hash(await readFile(candidate)), previousSHA256 = hash(await readFile(previous))
  assert.equal(candidateSHA256, '9b828d9bac4b08291bbdcef151096fcc2903b8fbbc87ae03a4f6ba26b3c5e6f3')
  assert.equal(previousSHA256, 'c30441ec6cf75ec12963ad3e1b46911fbebe10d10259773ed93576b86c0fc0a7')
  const helper = (await run('/usr/bin/tar', ['-xOf', candidate, 'package/lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout
  assert.equal(hash(helper), '66ae37d056385e3053724a07a982993c9f8356481666b2d8ee59f65d1356e502')
  await mkdir(base, { recursive: false })
  const originals = ['scripts/test-harness-install.mjs', 'scripts/harness-host-readiness.mjs', 'scripts/prepare-macos-install-acceptance.mjs', 'tests/macos-install-acceptance.test.mjs']
  const sourceHashes = {}, snapshotHashes = {}, cliHashes = {}
  for (const name of originals) sourceHashes[name] = hash(await readFile(join(repository, name)))
  const source = makeMacInstallSource(await readFile(join(repository, 'scripts/test-harness-install.mjs'), 'utf8'))
  for (const [name, bytes] of [['test-harness-install.mjs', Buffer.from(source)], ['harness-host-readiness.mjs', await readFile(join(repository, 'scripts/harness-host-readiness.mjs'))], ['install-policy.mjs', await readFile(fileURLToPath(import.meta.url))]]) {
    await writeFile(join(base, name), bytes); snapshotHashes[name] = hash(bytes)
  }
  const cli = ['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh']
  for (const file of [cli[0], '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar']) cliHashes[file] = hash(await readFile(file))
  const data = { id, repository, candidate, candidateSHA256, previous, previousSHA256, helperSHA256: hash(helper), cli, cliHashes, sourceHashes, snapshotHashes, output: join(base, 'actual'), scope: 'Official isolated Mac CLI plugin-manager install lifecycle only; no GUI, account, external model or desktop input', checks: MAC_INSTALL_CASES }
  const entry = `import assert from 'node:assert/strict';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {createHash} from 'node:crypto';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';import {assessMacInstallReport} from './install-policy.mjs';
const base=dirname(fileURLToPath(import.meta.url)),data=JSON.parse(await readFile(join(base,'prepare-data.json'),'utf8')),hash=b=>createHash('sha256').update(b).digest('hex');async function verify(){assert.equal(hash(await readFile(fileURLToPath(import.meta.url))),data.entrySHA256);for(const[file,digest]of Object.entries(data.sourceHashes))assert.equal(hash(await readFile(join(data.repository,file))),digest,'Bound source changed: '+file);for(const[file,digest]of Object.entries(data.snapshotHashes))assert.equal(hash(await readFile(join(base,file))),digest,'Frozen source changed: '+file);for(const[file,digest]of Object.entries(data.cliHashes))assert.equal(hash(await readFile(file)),digest,'Official CLI changed');assert.equal(hash(await readFile(data.candidate)),data.candidateSHA256);assert.equal(hash(await readFile(data.previous)),data.previousSHA256)}
await verify();if(process.argv.includes('--plan')){console.log(JSON.stringify({...data,actualExecution:false,guiStarted:false,nativeInput:false,userProfileChanged:false},null,2));process.exit(0)}assert.ok(process.argv.includes('--run')&&process.argv.includes('--root-approved'),'Root must authorize this isolated CLI scope');assert.equal(process.platform,'darwin');await mkdir(data.output,{recursive:false});let exit,failure,report,stable=false,stdout='',stderr='';try{exit=await new Promise((done,reject)=>{const child=spawn(process.execPath,[join(base,'test-harness-install.mjs'),'--package',data.candidate,'--old-package',data.previous,'--output',data.output,'--cli-json',JSON.stringify(data.cli)],{cwd:data.repository,stdio:['ignore','pipe','pipe']});child.stdout.on('data',bytes=>{stdout=(stdout+bytes).slice(-1024*1024)});child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-1024*1024)});child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}))});assert.deepEqual(exit,{code:0,signal:null});report=JSON.parse(await readFile(join(data.output,'report.json'),'utf8'));await verify();stable=true}catch(error){failure=error.message}finally{await writeFile(join(data.output,'carrier-stdout.log'),stdout);await writeFile(join(data.output,'carrier-stderr.log'),stderr);const behavior=assessMacInstallReport(report),verdict={passed:!failure&&stable&&behavior.passed,behavior,exit,failure:failure??null,sourceStable:stable,guiStarted:false,nativeInput:false,userProfileChanged:false,scope:data.scope,candidateSHA256:data.candidateSHA256};await writeFile(join(data.output,'carrier-verdict.json'),JSON.stringify(verdict,null,2));console.log(JSON.stringify(verdict,null,2));if(!verdict.passed)process.exitCode=1}
`
  await writeFile(join(base, 'entry.mjs'), entry); data.entrySHA256 = hash(Buffer.from(entry))
  await writeFile(join(base, 'prepare-data.json'), JSON.stringify(data, null, 2))
  await run(process.execPath, [join(base, 'entry.mjs'), '--plan'], { cwd: repository, maxBuffer: 2 * 1024 * 1024 })
  return { base, entry: join(base, 'entry.mjs'), output: data.output, candidateSHA256, helperSHA256: data.helperSHA256, checks: MAC_INSTALL_CASES, executed: false, guiStarted: false, nativeInput: false }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) console.log(JSON.stringify(await prepareMacInstallAcceptance(), null, 2))
