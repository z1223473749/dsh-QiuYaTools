/** Freeze first; only an explicit root-scheduled run may contact PD or compile guest fixtures. */
import assert from 'node:assert/strict'
import {createWindowsOwnedStartupGate,WINDOWS_OWNED_STARTUP_SCOPE} from './startup-credit-policy.mjs'
import { TwoPhasePhysicalRaster, twoPhaseRasterComplete } from './physical-frame-protocol.mjs'
import { waitForPublishedPhysicalFrame, requireNaturalCaptureCompletion } from './physical-frame-publication.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, access, rm, lstat, unlink, rmdir, chmod } from 'node:fs/promises'
import { join, dirname, resolve, relative, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { digest, inputReleased, sameWindowsMultitaskIdentity, windowsMultitaskPendingLauncherConsole, createWindowsMultitaskInitialSetupGate } from './test-windows-multitask-manager.mjs'

const root = fileURLToPath(new URL('../', import.meta.url)), run = promisify(execFile)
const quote = value => "'" + value.replaceAll("'", "''") + "'"
const outputBytes = value => Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : '')
export function windowsMultitaskCommandReceipt(result, { phase, script, failed = false } = {}) {
  assert.match(phase, /^[a-z][a-z0-9-]{0,79}$/u)
  const stdout = outputBytes(result?.stdout), stderr = outputBytes(result?.stderr), code = result?.code
  const diagnosticText = (stdout.toString('utf8') + '\n' + stderr.toString('utf8')).replaceAll('_x000D_', '\r').replaceAll('_x000A_', '\n')
  const compilerDiagnostics = []
  if (phase.startsWith('compile-')) for (const match of diagnosticText.matchAll(/\((\d+)(?:,\s*(\d+))?\)\s*:\s*(error|warning)\s+(CS\d+)\s*:\s*([^\r\n]+)/gu)) {
    compilerDiagnostics.push({ code: match[4], line: Number(match[1]), column: match[2] ? Number(match[2]) : null, severity: match[3], message: match[5].slice(0, 512) })
    if (compilerDiagnostics.length >= 16) break
  }
  return { phase, failed, exitCode: Number.isInteger(code) ? code : failed ? null : 0, errorCode: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : null,
    signal: typeof result?.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/u.test(result.signal) ? result.signal : null, killed: result?.killed === true,
    scriptSHA256: digest(script), scriptBytes: Buffer.byteLength(script), encodedCommandCharacters: Buffer.from(script, 'utf16le').toString('base64').length,
    stdoutBytes: stdout.length, stdoutSHA256: digest(stdout), stderrBytes: stderr.length, stderrSHA256: digest(stderr), compilerDiagnostics }
}
export function windowsMultitaskGuestBuildSteps(guestRoot, architecture, helper) {
  assert.ok(['arm64', 'x64'].includes(architecture))
  const references = 'System,System.Core,System.Drawing,System.Windows.Forms,System.Web.Extensions'
  return [
    { phase: 'runtime-expand', timeout: 90000, script: `$ErrorActionPreference='Stop';Expand-Archive -LiteralPath ${quote(win32.join(guestRoot, `node-${architecture}.zip`))} -DestinationPath ${quote(guestRoot)}` },
    { phase: 'helper-place', timeout: 30000, script: `$ErrorActionPreference='Stop';New-Item -ItemType Directory -Force ${quote(win32.dirname(helper))}|Out-Null;Move-Item -LiteralPath ${quote(win32.join(guestRoot, `helper-${architecture}.exe`))} -Destination ${quote(helper)}` },
    ...['fixture', 'observer'].map(name => ({ phase: `compile-${name}`, timeout: 60000, script: `$ErrorActionPreference='Stop';Add-Type -Path ${quote(win32.join(guestRoot, name + '.cs'))} -OutputAssembly ${quote(win32.join(guestRoot, name + '.exe'))} -OutputType WindowsApplication -ReferencedAssemblies ${references}` })),
  ]
}
export function windowsMultitaskGuestLaunchScript({ node, guestRoot }) {
  const argumentsString = `"${win32.join(guestRoot, 'test-windows-multitask-manager.mjs')}" --guest-config "${win32.join(guestRoot, 'config.json')}"`
  return `$ErrorActionPreference='Stop';$i=[Diagnostics.ProcessStartInfo]::new(${quote(node)},${quote(argumentsString)});$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.RedirectStandardInput=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;$p=[Diagnostics.Process]::Start($i);$p.StandardInput.Close();$pin=$p.SafeHandle;$identity=@{pid=$p.Id;createdAtTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();executablePath=$p.MainModule.FileName;sessionId=$p.SessionId};$out=[IO.File]::Create(${quote(win32.join(guestRoot, 'runner.log'))});$err=[IO.File]::Create(${quote(win32.join(guestRoot, 'runner.err'))});try{$copyOut=$p.StandardOutput.BaseStream.CopyToAsync($out);$copyErr=$p.StandardError.BaseStream.CopyToAsync($err);$p.WaitForExit();$null=$copyOut.GetAwaiter().GetResult();$null=$copyErr.GetAwaiter().GetResult();$exitCode=[int]$p.ExitCode;[IO.File]::WriteAllText(${quote(win32.join(guestRoot, 'runner-exit.json'))},(@{exitCode=$exitCode;pid=$p.Id;identity=$identity;normalWait=$true;killCalls=0;createNoWindow=$true;standardInputRedirected=$true;standardInputClosed=$true;processHandlePinned=$true}|ConvertTo-Json -Depth 4 -Compress))}finally{$out.Dispose();$err.Dispose();$p.Dispose()};exit $exitCode`
}
export function windowsMultitaskGuestExitValid(value) {
  return Boolean(value && Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.normalWait === true && value.killCalls === 0 && value.createNoWindow === true && value.standardInputRedirected === true && value.standardInputClosed === true && value.processHandlePinned === true && Number.isSafeInteger(value.pid) && value.pid > 0 && value.identity?.pid === value.pid && /^\d+$/u.test(value.identity?.createdAtTicks ?? '') && typeof value.identity?.executablePath === 'string' && value.identity.executablePath.length > 0 && Number.isSafeInteger(value.identity?.sessionId) && value.identity.sessionId > 0)
}
export async function finishWindowsMultitaskGuest(runnerExit, { collect, retireTask, postflight }) {
  const exitValid = windowsMultitaskGuestExitValid(runnerExit), errors = exitValid ? [] : [{ stage: 'guest-exit-schema', error: 'Actual integer exit / pinned natural wait evidence is invalid or unknown' }], results = {}
  // Exit validity and business success are distinct. Even a real exit 1 or
  // unknown receipt must retain collection and attempt independent OS audit.
  for (const [stage, work] of [['collect', collect], ['task-retirement', retireTask], ['postflight', postflight]]) {
    try { results[stage] = await work() } catch (error) { errors.push({ stage, error: String(error.message).slice(0, 1000) }) }
  }
  return { exitValid, actualExitCode: Number.isInteger(runnerExit?.exitCode) ? runnerExit.exitCode : null, results, errors }
}
export function windowsMultitaskRetirementWireRequests(expected) {
  assert.ok(Array.isArray(expected) && expected.length <= 2)
  return expected.map((identity, index) => {
    assert.ok(identity && Number.isSafeInteger(identity.pid) && identity.pid > 0 && /^\d{1,20}$/u.test(identity.createdAtTicks) && typeof identity.executablePath === 'string' && identity.executablePath.length > 0 && typeof identity.canonicalExecutablePath === 'string' && identity.canonicalExecutablePath.length > 0 && Number.isSafeInteger(identity.sessionId) && identity.sessionId > 0)
    return JSON.stringify({ requestId: index + 2, op: 'retired', identity })
  })
}
export function windowsMultitaskRetirementWireScript(expected) {
  // Windows PowerShell5 can wrap a top-level ConvertFrom-Json array as one
  // pipeline object and serialize an identity wrapper without pid. Keep each
  // Host-owned request as its original JSONL string through the pipe instead.
  return windowsMultitaskRetirementWireRequests(expected).map(request => `$q=${quote(request)};$last=$null;for($j=0;$j-lt 30;$j++){$p.StandardInput.WriteLine($q);$last=$p.StandardOutput.ReadLine()|ConvertFrom-Json;$samples+=@($last);if(!$last.ok-or !$last.result.exactAlive){break};Start-Sleep -Milliseconds 100};$retirements+=@($last);`).join('')
}
export function windowsMultitaskConsoleRetirement(report, runnerExit, post) {
  const pending = report?.cleanup?.pendingOuterRetirement
  const failed = detail => ({ passed: false, remaining: Array.isArray(pending) ? structuredClone(pending) : [], detail })
  if (!windowsMultitaskGuestExitValid(runnerExit) || !sameWindowsMultitaskIdentity(report?.runnerIdentity, runnerExit.identity) || !Array.isArray(pending) || pending.length > 1 || !pending.every(row => windowsMultitaskPendingLauncherConsole(row, report.runnerIdentity, report.systemConsolePath))) return failed('Invalid exact launcher ownership')
  if (post?.exitCode !== 0 || post.killCalls !== 0 || post.reply?.ok !== true || !inputReleased(post.reply.result) || !post.identity || post.identity.sessionId !== runnerExit.identity.sessionId || sameWindowsMultitaskIdentity(post.identity, runnerExit.identity) || !Array.isArray(post.retirements)) return failed('Independent postflight is incomplete')
  const expected = [report.runnerIdentity, ...pending]
  if (post.retirements.length !== expected.length) return failed('Missing or extra retirement replies')
  const remaining = [], allowed = new Set(['pid-absent', 'pinned-object-signaled', 'pid-reused-different-birth'])
  for (let i = 0; i < expected.length; i++) {
    const row = post.retirements[i], value = row?.result
    if (row?.ok !== true || !sameWindowsMultitaskIdentity(value?.expected, expected[i]) || value.expected.canonicalExecutablePath !== expected[i].canonicalExecutablePath || value.exactAlive !== false || !allowed.has(value.reason)) remaining.push(expected[i])
  }
  return { passed: remaining.length === 0, remaining, resolvedPendingCount: pending.length, runnerNaturallyExited: remaining.every(row => !sameWindowsMultitaskIdentity(row, report.runnerIdentity)), postObserver: post.identity, statement: 'Inner pending launcher console retired after the exact Node natural exit; no process was killed' }
}
export function windowsMultitaskCompletionPassed({ runnerExit, lifecycle, taskReceipt, auditReceipt, report, architecture, captureCount, physicalReceipts, consoleRetirement }) {
  const pending = report?.cleanup?.pendingOuterRetirement
  const innerPassed = report?.status === 'passed' && report.cleanup?.passed === true
  const deferredClosed = report?.status === 'pending-outer-retirement' && report.cleanup?.passed === false && report.cleanup.localPassed === true && Array.isArray(pending) && pending.length === 1 && report.cleanup.remaining?.length === 0 && report.cleanup.errors?.length === 0 && consoleRetirement?.passed === true && consoleRetirement.remaining?.length === 0 && consoleRetirement.resolvedPendingCount === 1 && consoleRetirement.runnerNaturallyExited === true
  return Boolean(windowsMultitaskGuestExitValid(runnerExit) && runnerExit.exitCode === 0 && lifecycle?.errors?.length === 0 && taskReceipt?.state === 'Ready' && taskReceipt.exitCode === 0 && taskReceipt.unregistered === true &&
    auditReceipt?.state === 'Ready' && auditReceipt.exitCode === 0 && auditReceipt.unregistered === true && (innerPassed || deferredClosed) && report.platform === 'win32' && report.architecture === architecture && captureCount === 1 && physicalReceipts?.length === 1 && physicalReceipts[0].passed === true)
}
export function windowsMultitaskRasterPixels(image, crop, scale = 1) {
  assert.ok(image && Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height) && image.data?.length === image.width * image.height * 4)
  assert.ok(Number.isFinite(scale) && scale >= .75 && scale <= 4)
  assert.ok([crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger) && crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0 && crop.x + crop.width <= image.width && crop.y + crop.height <= image.height)
  let body = 0, white = 0, fullyWhite = 0, background = 0, left = Infinity, right = -1, top = Infinity, bottom = -1
  for (let y = crop.y; y < crop.y + crop.height; y++) for (let x = crop.x; x < crop.x + crop.width; x++) {
    const offset = (y * image.width + x) * 4, r = image.data[offset], g = image.data[offset + 1], b = image.data[offset + 2]
    if (r >= 84 && r <= 103 && g >= 121 && g <= 135 && b >= 136 && b <= 158) { body++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y) }
    const alpha = [(r - 37) / (255 - 37), (g - 113) / (255 - 113), (b - 151) / (255 - 151)]
    if (Math.min(...alpha) >= .55 && Math.max(...alpha) <= 1 && Math.max(...alpha) - Math.min(...alpha) <= .14) white++
    if (r > 230 && g > 230 && b > 230) fullyWhite++
    if (r === 37 && g === 113 && b === 151) background++
  }
  const area = scale * scale
  const contour = { width: right - left + 1, height: bottom - top + 1 }, compact = contour.width >= 6 * scale && contour.width <= 22 * scale && contour.height >= 8 * scale && contour.height <= 28 * scale
  return { passed: body >= 15 * area && body <= 200 * area && white >= 10 * area && white <= 220 * area && fullyWhite >= 1 && background >= crop.width * crop.height * .95 && compact,
    body, white, fullyWhite, background, contour, approved: { fill: '#95999e', fillAlpha: .45, strokeAlpha: .96, strokeWidth: 1.25 }, scale, resized: false }
}
export function validateWindowsMultitaskRasterRequest(value, data, architecture) {
  assert.equal(value?.runId, data.id); assert.equal(value.architecture, architecture); assert.equal(value.stage, 'redock-B'); assert.equal(value.helperSHA256, data.architectures[architecture].helperSHA256)
  assert.equal(value.before?.passed, true); assert.ok(Number.isSafeInteger(value.before.epoch) && value.before.epoch > 0); assert.match(value.before.ownerSHA256, /^[a-f0-9]{64}$/u)
  const { crop, screen, target } = value
  for (const rect of [crop, screen, target]) assert.ok(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) && rect.width > 0 && rect.height > 0)
  assert.ok(crop.width <= 540 && crop.height === 100 && crop.x >= target.x && crop.y >= target.y && crop.x + crop.width <= target.x + target.width && crop.y + crop.height <= target.y + target.height)
  assert.ok(crop.x >= screen.x && crop.y >= screen.y && crop.x + crop.width <= screen.x + screen.width && crop.y + crop.height <= screen.y + screen.height)
  assert.equal(value.before.os?.foreground, String(value.before.os?.foreground)); assert.ok(value.before.os?.heldKeys?.includes(1))
  assert.ok(value.before.pointer?.dpi >= 72 && value.before.pointer.dpi <= 384)
  return value
}
export const WINDOWS_MULTITASK_CARRIER_INPUTS = Object.freeze({
  'test-windows-multitask-manager.mjs': 'scripts/test-windows-multitask-manager.mjs',
  'prepare-windows-multitask-acceptance.mjs': 'scripts/prepare-windows-multitask-acceptance.mjs',
  'normal-startup-policy.mjs': 'scripts/normal-startup-policy.mjs',
  'startup-credit-policy.mjs': 'scripts/startup-credit-policy.mjs',
  'physical-frame-protocol.mjs': 'scripts/physical-frame-protocol.mjs',
  'physical-frame-publication.mjs': 'scripts/physical-frame-publication.mjs',
  'fixture.cs': 'tests/fixtures/windows-multitask-fixture.cs',
  'observer.cs': 'tests/fixtures/windows-multitask-observer.cs',
  'png-utils-bundle.cjs': 'node_modules/playwright-core/lib/utilsBundle.js',
})
/** Pure filesystem preflight: every relative import and lossless PNG dependency
 * is present before bundling, archive extraction or any PD/guest operation. */
export async function collectWindowsMultitaskCarrierInputs(carrierRoot = root) {
  const files = new Map(), hashes = {}
  for (const [name, source] of Object.entries(WINDOWS_MULTITASK_CARRIER_INPUTS)) {
    const path = join(carrierRoot, source)
    const stat = await lstat(path)
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Missing ordinary manager carrier input: ${source}`)
    const value = await readFile(path); files.set(name, value); hashes[source] = digest(value)
  }
  const test = 'tests/windows-multitask-runner.test.mjs'
  hashes[test] = digest(await readFile(join(carrierRoot, test)))
  return { files, hashes }
}

export async function prepareWindowsMultitaskAcceptance({ output, candidates, nodeZips, repository = root } = {}) {
  assert.ok(output && candidates && nodeZips, 'Explicit fresh output, two candidate packages and two official Node archives are required')
  const mandatory = await collectWindowsMultitaskCarrierInputs()
  const base = resolve(output); await mkdir(base)
  const { WINDOWS_TEST_NODES } = await import(pathToFileURL(join(repository, 'scripts/prepare-windows-test-runtime.mjs')).href)
  const { build, stop } = await import('esbuild')
  const sources = {}, bytes = new Map(), data = { version: 1, id: randomUUID(), root: repository, base, architectures: {}, preparedAt: new Date().toISOString(), scope: 'Actual default Windows manager/scheduler/native; isolated testhost; no installed Harness owner or external model', sourceHashes: sources, carrierRoot: root, carrierSourceHashes: {} }
  try {
    const built = await build({ absWorkingDir: repository, stdin: { contents: "export{ComputerEnvironmentManager}from'./src/features/computer-use/environment-manager.ts';export{ScheduledComputerDriver}from'./src/features/computer-use/scheduled-driver.ts';export{NativeCompanionDriver}from'./src/features/computer-use/native.ts';export{computerPreviewPage}from'./src/features/computer-use/preview-page.ts'", resolveDir: repository }, bundle: true, write: false, metafile: true, platform: 'node', target: 'node22', format: 'esm' })
    bytes.set('runtime.mjs', built.outputFiles[0].contents)
    for (const name of Object.keys(built.metafile.inputs).filter(name => name !== '<stdin>')) { const path = resolve(repository, name); assert.ok(!relative(repository, path).startsWith('..')); sources[name] = digest(await readFile(path)) }
    Object.assign(data.carrierSourceHashes, mandatory.hashes)
    for (const [name, value] of mandatory.files) bytes.set(name, value)
    for (const architecture of ['arm64', 'x64']) {
      const candidate = resolve(candidates[architecture]), nodeZip = resolve(nodeZips[architecture]), node = WINDOWS_TEST_NODES[architecture], nodeBytes = await readFile(nodeZip)
      assert.equal(digest(nodeBytes), node.sha256, 'Only the already pinned official Node archive is accepted')
      const helper = (await run('tar', ['-xOf', candidate, `package/lib/native/win32-${architecture}/qiuya-windows.exe`], { encoding: 'buffer', timeout: 30000, maxBuffer: 256 * 1024 * 1024 })).stdout
      const machine = helper.readUInt16LE(helper.readUInt32LE(0x3c) + 4); assert.equal(machine, architecture === 'arm64' ? 0xaa64 : 0x8664)
      bytes.set(`helper-${architecture}.exe`, helper); bytes.set(`node-${architecture}.zip`, nodeBytes)
      data.architectures[architecture] = { candidate, candidateSHA256: digest(await readFile(candidate)), helperSHA256: digest(helper), nodeZipSHA256: digest(nodeBytes), nodeFolder: node.file.replace(/\.zip$/u, '') }
    }
    data.fileHashes = Object.fromEntries([...bytes].map(([name, value]) => [name, digest(value)]))
    for (const [name, value] of bytes) await writeFile(join(base, name), value)
    await writeFile(join(base, 'prepare-data.json'), JSON.stringify(data, null, 2))
    const entry = `import{readFile}from'node:fs/promises';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';import{runPreparedWindowsMultitask}from'./prepare-windows-multitask-acceptance.mjs';const base=dirname(fileURLToPath(import.meta.url));await runPreparedWindowsMultitask(JSON.parse(await readFile(join(base,'prepare-data.json'),'utf8')),process.argv.slice(2));\n`
    await writeFile(join(base, 'entry.mjs'), entry); data.entrySHA256 = digest(entry); await writeFile(join(base, 'prepare-data.json'), JSON.stringify(data, null, 2))
    return { status: 'prepared-not-run', base, entry: join(base, 'entry.mjs'), id: data.id, architectures: data.architectures, runtimeSHA256: data.fileHashes['runtime.mjs'], sourceCount: Object.keys(sources).length, pdCommandsExecuted: 0, guiStarted: 0, fixtureCompiled: false, productNativeCompiled: false }
  } finally { await stop() }
}

export async function runPreparedWindowsMultitask(data, args) {
  const arg = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }, architecture = arg('--arch')
  assert.ok(['arm64', 'x64'].includes(architecture), 'Pass --arch arm64 or x64')
  for (const [name, expected] of Object.entries(data.fileHashes)) assert.equal(digest(await readFile(join(data.base, name))), expected, `Frozen input changed: ${name}`)
  assert.equal(digest(await readFile(join(data.base, 'entry.mjs'))), data.entrySHA256)
  for (const [name, expected] of Object.entries(data.sourceHashes)) assert.equal(digest(await readFile(resolve(data.root, name))), expected, `Reviewed production/test source changed: ${name}`)
  for (const [name, expected] of Object.entries(data.carrierSourceHashes)) assert.equal(digest(await readFile(resolve(data.carrierRoot, name))), expected, `Reviewed testcarrier source changed: ${name}`)
  if (args.includes('--plan')) { console.log(JSON.stringify({ status: 'prepared-not-run', architecture, data, pdCommandsExecuted: 0, guiStarted: 0, fixtureCompiled: false, foregroundFixturePermits: args.includes('--fixture-foreground-permits'), productionAutomaticCrossHelperFocusClaim: false }, null, 2)); return }
  assert.ok(args.includes('--run') && args.includes('--root-approved'), 'Root must schedule the exclusive PD slot after the existing long run')
  const vm = arg('--vm'), host = arg('--host'), output = resolve(arg('--out') || '')
  assert.match(vm ?? '', /^[a-f0-9-]{36}$/iu); assert.match(host ?? '', /^\d+\.\d+\.\d+\.\d+$/u); assert.ok(arg('--out'), 'A fresh external evidence directory is required')
  assert.ok(output !== resolve(data.root) && !output.startsWith(resolve(data.root) + '/'), 'Evidence must stay outside the project')
  await mkdir(output)
  const prl = process.env.QIUYA_PRLCTL || '/Applications/Parallels Desktop.app/Contents/MacOS/prlctl', arch = data.architectures[architecture], key = randomUUID(), files = new Map()
  for (const name of ['runtime.mjs', 'test-windows-multitask-manager.mjs', 'normal-startup-policy.mjs', 'startup-credit-policy.mjs', 'physical-frame-protocol.mjs', 'fixture.cs', 'observer.cs', `helper-${architecture}.exe`, `node-${architecture}.zip`]) files.set(name, await readFile(join(data.base, name)))
  const commandReceipts = []
  const ps = async (code, timeout = 30000, phase = 'powershell-read') => {
    let result, failure
    try { result = await run(prl, ['exec', vm, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { timeout, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL' }) }
    catch (error) { result = error; failure = true }
    const receipt = windowsMultitaskCommandReceipt(result, { phase, script: code, failed: failure === true }), stem = `command-${String(commandReceipts.length + 1).padStart(4, '0')}-${phase}`
    commandReceipts.push(receipt)
    // Only a fixed own-source compiler phase may retain bounded original text.
    // Other command outputs remain length/hash projections, never argv/message.
    if (failure && phase.startsWith('compile-')) {
      for (const stream of ['stdout', 'stderr']) { const name = `${stem}-${stream}.txt`; await writeFile(join(output, name), outputBytes(result[stream]).subarray(0, 32768)); receipt[`${stream}Diagnostic`] = name }
    }
    await writeFile(join(output, stem + '.json'), JSON.stringify(receipt, null, 2))
    if (failure) throw Object.assign(new Error(`Windows carrier ${phase} failed; exit=${receipt.exitCode ?? receipt.errorCode ?? 'unknown'}; scriptSHA256=${receipt.scriptSHA256}`), { code: 'WINDOWS_MULTITASK_COMMAND_FAILED', commandReceipt: receipt })
    return result.stdout.trim().replace(/^\uFEFF/u, '')
  }
  let captureCount = 0, originalIdle, idleChanged = false, task, auditTask, guestRoot, server, fatal, report, taskReceipt, auditReceipt, runnerExit, lifecycle, consoleRetirement, testFixturesCompiled = false
  let initialSetupGate, initialSetupPrepared, initialSetupVerified, normalStartupVerified
  const served = new Set(), physicalReceipts = [], acquisitions = [], acquisitionAttempts = [], raster = new TwoPhasePhysicalRaster()
  const rawDirectory = join(output, '.private-raw-' + key), rawFrame = join(rawDirectory, 'physical.png')
  let acquireRequests = 0, finalizeRequests = 0, activeAcquire, activeCaptureCompletion, captureLifecycle, rawCleanup
  const cleanupRaw = async () => {
    const began = String(process.hrtime.bigint()); if (activeCaptureCompletion) await activeCaptureCompletion; await raster.close()
    await unlink(rawFrame).catch(error => { if (error.code !== 'ENOENT') throw error })
    await rmdir(rawDirectory).catch(error => { if (error.code !== 'ENOENT') throw error })
    const retained = await lstat(rawFrame).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    const directoryRetained = await lstat(rawDirectory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    rawCleanup = { rawFrameDeleted: !retained, rawDirectoryDeleted: !directoryRetained, pinnedFDClosed: !raster.pin || raster.pin.closed === true, startedHostNs: began, completedHostNs: String(process.hrtime.bigint()), entireFrameRetained: retained }
    assert.equal(retained, false); assert.equal(directoryRetained, false); return rawCleanup
  }
  try {
    await mkdir(rawDirectory, { mode: 0o700 }); await chmod(rawDirectory, 0o700)
    assert.equal((await lstat(rawDirectory)).mode & 0o777, 0o700)
    server = createServer(async (request, response) => {
      try {
        const path = request.url?.split('/')
        if (path?.[1] !== key) { response.writeHead(404).end(); return }
        if (request.method === 'GET' && files.has(path[2])) { const bytes = files.get(path[2]); served.add(path[2]); response.writeHead(200, { 'Content-Length': bytes.length }); response.end(bytes); return }
        if(request.method==='POST'&&path[2]==='setup'&&path[3]==='owned-startup'){
          assert(!normalStartupVerified,'Normal owned startup cannot replay');let body='';for await(const chunk of request){body+=chunk.toString();assert(Buffer.byteLength(body)<=128*1024)}const value=JSON.parse(body);assert.equal(value.runId,data.id);assert.equal(value.architecture,architecture);assert.equal(value.helperSHA256,arch.helperSHA256);const v=value.expected;assert.equal(v.runId,data.id);
          for(const [identity,path,image]of [[v?.fixture,win32.join(guestRoot,'fixture.exe'),compiled.fixture],[v?.fixtureB,win32.join(guestRoot,'fixture.exe'),compiled.fixture],[v?.nativeA,helper,arch.helperSHA256],[v?.nativeB,helper,arch.helperSHA256]]){assert(identity&&Number.isSafeInteger(identity.pid)&&identity.pid>0&&Number.isSafeInteger(identity.sessionId)&&identity.sessionId>0);assert.match(identity.createdAtTicks??'',/^\d{1,20}$/u);assert.equal(identity.executablePath.toLowerCase(),path.toLowerCase());assert.equal(identity.canonicalExecutablePath.toLowerCase(),path.toLowerCase());assert.equal(identity.imageSHA256,image)}
          assert.equal(v.title,'QiuYaTools multitask chat-A '+data.id);assert.equal(v.titleB,'QiuYaTools multitask chat-B '+data.id);normalStartupVerified=createWindowsOwnedStartupGate(v).finish(value.proof);await writeFile(join(output,'normal-owned-startup-verified.json'),JSON.stringify({expected:v,proof:value.proof,receipt:normalStartupVerified},null,2));response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({accepted:true,runId:data.id,nonce:normalStartupVerified.nonce,physicalCUAVerified:false}));return;
        }
        if(request.method==='POST'&&path[2]==='setup'){
          assert(['ready','verified'].includes(path[3]));let body='';for await(const chunk of request){body+=chunk.toString();assert(Buffer.byteLength(body)<=128*1024)}const value=JSON.parse(body);assert.equal(value.runId,data.id);assert.equal(value.architecture,architecture);assert.equal(value.helperSHA256,arch.helperSHA256)
          if(path[3]==='ready'){
            assert(!initialSetupGate,'Initial setup preparation cannot replay');const v=value.prepared
            for(const [identity,path,image]of [[v?.fixture,win32.join(guestRoot,'fixture.exe'),compiled.fixture],[v?.fixtureB,win32.join(guestRoot,'fixture.exe'),compiled.fixture],[v?.nativeA,helper,arch.helperSHA256],[v?.nativeB,helper,arch.helperSHA256]]){assert(identity&&Number.isSafeInteger(identity.pid)&&identity.pid>0&&Number.isSafeInteger(identity.sessionId)&&identity.sessionId>0);assert.match(identity.createdAtTicks??'',/^\d{1,20}$/u);assert.equal(identity.executablePath.toLowerCase(),path.toLowerCase());assert.equal(identity.canonicalExecutablePath.toLowerCase(),path.toLowerCase());assert.equal(identity.imageSHA256,image)}
            assert.equal(new Set([v.fixture.pid,v.nativeA.pid,v.nativeB.pid]).size,3);assert.equal(v.fixture.sessionId,v.nativeA.sessionId);assert.equal(v.nativeA.sessionId,v.nativeB.sessionId);assert.equal(v.title,'QiuYaTools multitask chat-A '+data.id)
            initialSetupGate=createWindowsMultitaskInitialSetupGate({runId:data.id,fixture:v.fixture,hwnd:v.hwnd,title:v.title,nativeA:v.nativeA,nativeB:v.nativeB});const own=initialSetupGate.prepare(v);initialSetupGate.arm(value.armed);const {PNG}=createRequire(import.meta.url)(join(data.base,'png-utils-bundle.cjs'));const png=PNG.sync.read(own.png);assert.equal(png.width,192);assert.equal(png.height,32)
            initialSetupPrepared=value;await writeFile(join(output,'initial-A-titlebar-own-ROI.png'),own.png);await writeFile(join(output,'initial-titlebar-setup-ready.json'),JSON.stringify(value,null,2));console.log(JSON.stringify({phase:'initial-setup-awaiting-one-root-CUA-click',runId:data.id,output,proof:join(output,'initial-titlebar-setup-ready.json'),ownROI:join(output,'initial-A-titlebar-own-ROI.png'),geometry:v.geometry,onlyInitialMaintenance:true}))
          }else{
            assert(initialSetupGate&&!initialSetupVerified,'Initial setup verification cannot replay');initialSetupVerified=initialSetupGate.finish(value.verified);assert(inputReleased(value.os));assert.equal(value.os.foreground,initialSetupPrepared.prepared.hwnd);await writeFile(join(output,'initial-titlebar-setup-verified.json'),JSON.stringify(value,null,2))
          }
          response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({accepted:true,runId:data.id,nonce:initialSetupPrepared.prepared.nonce}));return
        }
        assert.equal(request.method, 'POST'); assert.equal(path[2], 'raster'); assert.ok(['acquire', 'finalize'].includes(path[3]))
        const receivedNs = String(process.hrtime.bigint())
        let body = ''; for await (const chunk of request) { body += chunk.toString(); assert.ok(Buffer.byteLength(body) <= 128 * 1024) }
        const value = validateWindowsMultitaskRasterRequest(JSON.parse(body), data, architecture)
        if (path[3] === 'acquire') {
          assert.equal(++acquireRequests, 1, 'A second physical capture is forbidden'); raster.claimAcquire(value); captureCount++
          const attempt = { captureId: raster.captureId, requestReceived: receivedNs, phase: 'capture-starting' }; acquisitionAttempts.push(attempt)
          activeAcquire = (async () => {
            const captureStarted = String(process.hrtime.bigint()); attempt.captureStarted = captureStarted; attempt.phase = 'capture-running'
            captureLifecycle = { status: 'pending', startedHostNs: captureStarted, exitCode: null, signal: null, killed: false, naturalExit: false }
            // Start exactly the original one capture. File publication, not CLI retirement, is the observation fence.
            activeCaptureCompletion = run(prl, ['capture', vm, '--file', rawFrame], { timeout: 12000, killSignal: 'SIGKILL', maxBuffer: 32768 }).then(
              () => { captureLifecycle = { ...captureLifecycle, status: 'exited', completedHostNs: String(process.hrtime.bigint()), exitCode: 0, naturalExit: true }; attempt.captureCompleted = captureLifecycle.completedHostNs; attempt.captureLifecycle = captureLifecycle; return captureLifecycle },
              error => { captureLifecycle = { ...captureLifecycle, status: 'failed', completedHostNs: String(process.hrtime.bigint()), exitCode: Number.isInteger(error.code) ? error.code : null, signal: typeof error.signal === 'string' ? error.signal : null, killed: error.killed === true, errorCode: typeof error.code === 'string' ? error.code : error.name, naturalExit: false }; attempt.captureCompleted = captureLifecycle.completedHostNs; attempt.captureLifecycle = captureLifecycle; return captureLifecycle })
            const pin = await waitForPublishedPhysicalFrame(rawFrame, value.screen, { timeoutMs: 12000, captureStartedHostNs: captureStarted, captureOutcome: () => captureLifecycle }); attempt.pinStageNs = pin.pinStageNs; attempt.fileIdentity = pin.identity; attempt.header = pin.header; attempt.publication = pin.publication
            const acquisition = raster.sealPublishedAcquisition(pin, { requestReceived: receivedNs, captureStarted, ...pin.pinStageNs, replyReady: String(process.hrtime.bigint()) })
            attempt.phase = 'acquired-no-full-read'; attempt.replyReady = acquisition.hostStageNs.replyReady; acquisitions.push(acquisition); return acquisition
          })()
          try { const acquisition = await activeAcquire; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(acquisition)) }
          catch (error) { attempt.failure = { failedPhase: attempt.phase, code: typeof error.code === 'string' ? error.code : error.name, completedHostNs: String(process.hrtime.bigint()) }; await cleanupRaw(); throw error }
          return
        }
        assert.equal(++finalizeRequests, 1, 'Only one post-gate finalize is allowed')
        const causalInterval = raster.authorizeFinalize(value), fullReadStarted = String(process.hrtime.bigint()); let full, image
        try {
          assert.ok(activeCaptureCompletion, 'The original capture lifecycle must exist'); requireNaturalCaptureCompletion(await activeCaptureCompletion)
          full = await raster.readFinalFrame(); const fullReadAndSHACompleted = String(process.hrtime.bigint())
          const require = createRequire(import.meta.url), { PNG } = require(join(data.base, 'png-utils-bundle.cjs')); image = PNG.sync.read(full.bytes); const decoded = String(process.hrtime.bigint())
          assert.equal(image.width, value.screen.width); assert.equal(image.height, value.screen.height)
          const crop = { x: value.crop.x - value.screen.x, y: value.crop.y - value.screen.y, width: value.crop.width, height: value.crop.height }, pixels = windowsMultitaskRasterPixels(image, crop, value.before.pointer.dpi / 96), classified = String(process.hrtime.bigint())
          const clipped = new PNG({ width: crop.width, height: crop.height }); PNG.bitblt(image, clipped, crop.x, crop.y, crop.width, crop.height, 0, 0)
          const imageBytes = PNG.sync.write(clipped), cropEncoded = String(process.hrtime.bigint()); await writeFile(join(output, 'B-held-physical-pointer-own-crop.png'), imageBytes)
          const receipt = { ...pixels, runId: data.id, architecture, captured: true, captureCount, physicalDisplay: true, hypervisorFramebuffer: true, captureSource: raster.receipt.captureSource, targetWindowCapture: false, previewCache: false, manuallyComposited: false,
            acquisition: raster.receipt, captureLifecycle, causalInterval, captureId: raster.captureId, finalizeCount: raster.finalizeCount,
            rawFrameSHA256: full.rawFrameSHA256, rawFileBeforeFinalize: full.fileBefore, rawFileAfterFinalize: full.fileAfter, rawPathBeforeFinalize: full.pathBefore, rawPathAfterFinalize: full.pathAfter,
            finalizeHostNs: { requestReceived: receivedNs, fullReadStarted, fullReadAndSHACompleted, decoded, classified, cropEncoded, cropWritten: String(process.hrtime.bigint()) },
            crop: value.crop, target: value.target, screen: value.screen, cropSHA256: digest(imageBytes), entireFrameRetained: false,
            mapping: 'Actual original Parallels primary physical frame; one CLI capture, complete PNG header/IEND observed and stable ordinary FD pinned before original after-held gate. Same client natural exit0 plus unchanged pinned identity precede full read/decode/crop/classification. Virtual origin subtracted; no resize/color normalization.',
            clockMapping: 'Host hrtime and guest QPC remain unmapped; before-held→capture start→complete-file publication/stable pin→acquire reply→after-held is causal evidence; CLI retirement may occur later but must succeed before full read.' }
          raster.finish(); physicalReceipts.push(receipt)
          await cleanupRaw(); receipt.rawCleanup = rawCleanup
          await writeFile(join(output, 'physical-raster.json'), JSON.stringify(receipt, null, 2)); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(receipt))
        } finally { full?.bytes.fill(0); image?.data.fill(0); if (!rawCleanup) await cleanupRaw() }
      } catch (error) { fatal ??= error.message; if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ passed: false, captured: false, captureCount, error: error.message })) }
    })
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, host, done) })
    const before = (await run(prl, ['list', '--info', vm], { timeout: 30000 })).stdout; originalIdle = /Pause idle: (on|off)/u.exec(before)?.[1]; assert.ok(originalIdle)
    await run(prl, ['set', vm, '--pause-idle', 'off'], { timeout: 30000 }); idleChanged = true
    if (/^State: paused$/mu.test(before)) await run(prl, ['resume', vm], { timeout: 30000 })
    const user = JSON.parse(await ps("$ErrorActionPreference='Stop';$u=(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -First 1).UserName;$s=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value;$p=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$s)).ProfileImagePath;@{user=$u;profile=$p}|ConvertTo-Json -Compress"))
    assert.ok(user.user && user.profile); guestRoot = win32.join(user.profile, 'AppData/Local/Temp', 'QiuYaTools-multitask-' + key)
    await writeFile(join(output, 'carrier-binding.json'), JSON.stringify({ runId: data.id, architecture, vm, guestRoot, helperSHA256: arch.helperSHA256, sourceHashes: data.sourceHashes, nativeSourceHashes: data.nativeSourceHashes, nativeBuildReceiptSHA256: data.nativeBuildReceiptSHA256, carrierSourceHashes: data.carrierSourceHashes, frozenFileHashes: data.fileHashes, originRunId: data.originRunId, scope: data.scope, foregroundFixturePermits: args.includes('--fixture-foreground-permits'), productionAutomaticCrossHelperFocusClaim: false }, null, 2))
    await ps(`$ErrorActionPreference='Stop';New-Item -ItemType Directory -Path ${quote(guestRoot)}|Out-Null`)
    const url = name => `http://${host}:${server.address().port}/${key}/${name}`
    async function transfer(name, destination) {
      await ps(`$ErrorActionPreference='Stop';$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(url(name))},${quote(destination)});if((Get-FileHash -LiteralPath ${quote(destination)} -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${quote(digest(files.get(name)))}){throw 'Own transfer integrity mismatch'}`, 60000)
    }
    for (const name of files.keys()) await transfer(name, win32.join(guestRoot, name))
    const helper = win32.join(guestRoot, 'native', `win32-${architecture}`, 'qiuya-windows.exe'), node = win32.join(guestRoot, arch.nodeFolder, 'node.exe')
    for (const step of windowsMultitaskGuestBuildSteps(guestRoot, architecture, helper)) await ps(step.script, step.timeout, step.phase)
    const compiled = JSON.parse(await ps(`@{fixture=(Get-FileHash -LiteralPath ${quote(win32.join(guestRoot, 'fixture.exe'))} -Algorithm SHA256).Hash.ToLowerInvariant();observer=(Get-FileHash -LiteralPath ${quote(win32.join(guestRoot, 'observer.exe'))} -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress`))
    testFixturesCompiled = true
    const guestConfig = { runId: data.id, architecture, guestRoot, output: win32.join(guestRoot, 'evidence'), runtime: win32.join(guestRoot, 'runtime.mjs'), runtimeSHA256: data.fileHashes['runtime.mjs'], helper, helperSHA256: arch.helperSHA256, fixture: win32.join(guestRoot, 'fixture.exe'), fixtureSHA256: compiled.fixture, observer: win32.join(guestRoot, 'observer.exe'), observerSHA256: compiled.observer, rasterURL: url('raster'), setupURL: url('setup'), initialTitlebarSetup: false, normalOwnedStartup:true, foregroundFixturePermits: args.includes('--fixture-foreground-permits') }
    files.set('config.json', Buffer.from(JSON.stringify(guestConfig))); await transfer('config.json', win32.join(guestRoot, 'config.json'))
    const start = windowsMultitaskGuestLaunchScript({ node, guestRoot })
    files.set('start.ps1', Buffer.from(start)); await transfer('start.ps1', win32.join(guestRoot, 'start.ps1'))
    const register = async (name, script) => ps(`$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(`-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}"`)};$p=New-ScheduledTaskPrincipal -UserId ${quote(user.user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${quote(name)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(name)}`)
    task = `QiuYaTools-multitask-${key}`; await register(task, win32.join(guestRoot, 'start.ps1'))
    const ownFile = async name => { const base64 = await ps(`$p=${quote(win32.join(guestRoot, name))};if(Test-Path -LiteralPath $p){[Convert]::ToBase64String([IO.File]::ReadAllBytes($p))}`); return base64 ? Buffer.from(base64, 'base64') : null }
    const deadline = performance.now() + 180000
    let completed
    while (performance.now() < deadline) { completed = await ownFile('runner-exit.json'); if (completed) break; await sleep(400) }
    assert.ok(completed, 'Owned guest did not retire within the finite budget; no task/process termination was issued')
    try { runnerExit = JSON.parse(completed.toString('utf8')) } catch { runnerExit = null }
    const taskState = async name => JSON.parse(await ps(`$t=Get-ScheduledTask -TaskName ${quote(name)};$i=Get-ScheduledTaskInfo -TaskName ${quote(name)};@{state=$t.State.ToString();exitCode=[long]$i.LastTaskResult}|ConvertTo-Json -Compress`))
    lifecycle = await finishWindowsMultitaskGuest(runnerExit, {
    collect: async () => {
      const files = [], errors = []
      for (const name of ['runner-exit.json', 'runner.log', 'runner.err', 'evidence/run-report.json', 'evidence/report.json', 'evidence/delivery-verdict.json', 'evidence/held-samples.json', 'evidence/geometry-settles.json', 'evidence/actions-events.json', 'evidence/production-foreground-ack.json', 'evidence/preview-presentation-samples.json', 'evidence/physical-raster-stages.json','evidence/blue-raster-geometry.json','evidence/normal-owned-startup.json','evidence/normal-owned-startup-attempt.json']) {
        try { const bytes = await ownFile(name); if (bytes) { await mkdir(dirname(join(output, name)), { recursive: true }); await writeFile(join(output, name), bytes); files.push(name) } }
        catch (error) { errors.push({ name, error: String(error.message).slice(0, 1000) }) }
      }
      report = await readFile(join(output, 'evidence/report.json'), 'utf8').then(JSON.parse).catch(() => null)
      await writeFile(join(output, 'evidence-collection.json'), JSON.stringify({ files, errors }, null, 2))
      if (errors.length) throw new Error('One or more own evidence files could not be collected; per-file failures retained')
      return { files, reportStatus: report?.status ?? 'unavailable' }
    },
    retireTask: async () => {
    for (let i = 0; i < 30; i++) { taskReceipt = await taskState(task); if (taskReceipt.state === 'Ready') break; await sleep(100) }
    assert.equal(taskReceipt.state, 'Ready')
    await ps(`Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false`); taskReceipt.unregistered = true
      return taskReceipt
    },
    postflight: async () => {
    // A second independent interactive task audits actual input after guest EOF.
    const pending = Array.isArray(report?.cleanup?.pendingOuterRetirement) ? report.cleanup.pendingOuterRetirement : []
    assert.ok(pending.length <= 1, 'Only one exactly qualified launcher console may be deferred')
    const expected = report?.runnerIdentity ? [report.runnerIdentity, ...pending] : []
    const retirementScript = windowsMultitaskRetirementWireScript(expected)
    const postflight = `$ErrorActionPreference='Stop';$i=[Diagnostics.ProcessStartInfo]::new(${quote(guestConfig.observer)});$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.RedirectStandardInput=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;$p=[Diagnostics.Process]::Start($i);$pin=$p.SafeHandle;$ready=$p.StandardOutput.ReadLine()|ConvertFrom-Json;$p.StandardInput.WriteLine('{"requestId":1,"op":"snapshot"}');$r=$p.StandardOutput.ReadLine()|ConvertFrom-Json;$retirements=@();$samples=@();${retirementScript}$p.StandardInput.Close();if(!$p.WaitForExit(5000)){throw 'Read-only observer did not retire'};$v=@{identity=$ready.identity;reply=$r;retirements=$retirements;retirementSamples=$samples;exitCode=[int]$p.ExitCode;killCalls=0;processHandlePinned=$true};[IO.File]::WriteAllText(${quote(win32.join(guestRoot, 'postflight.json'))},($v|ConvertTo-Json -Depth 16 -Compress));$bad=@($retirements|Where-Object{!$_.ok-or $_.result.exactAlive});if(!$r.ok-or $p.ExitCode-ne 0-or @($r.result.heldKeys).Count-ne 0-or !$r.result.lease.lockFree-or $r.result.lease.journalPresent-or !$r.result.activeDesktopAccessible-or !$r.result.activeDesktopMatches-or $bad.Count-ne 0){exit 1}`
    files.set('postflight.ps1', Buffer.from(postflight)); await transfer('postflight.ps1', win32.join(guestRoot, 'postflight.ps1'))
    auditTask = `QiuYaTools-multitask-postflight-${key}`; await register(auditTask, win32.join(guestRoot, 'postflight.ps1'))
    let post
    // A Ready state is followed by a final own-file read, never an early break
    // based on the read made before that state transition.
    for (let i = 0; i < 80; i++) {
      auditReceipt = await taskState(auditTask)
      if (auditReceipt.state === 'Ready') { post = await ownFile('postflight.json'); if (post) break }
      await sleep(100)
    }
    assert.equal(auditReceipt.state, 'Ready')
    post = await ownFile('postflight.json'); assert.ok(post); await writeFile(join(output, 'postflight.json'), post)
    consoleRetirement = windowsMultitaskConsoleRetirement(report, runnerExit, JSON.parse(post.toString('utf8')))
    await writeFile(join(output, 'outer-retirement.json'), JSON.stringify(consoleRetirement, null, 2))
    assert.equal(auditReceipt.exitCode, 0)
    assert.equal(consoleRetirement.passed, true, 'Exact Node/launcher identities must naturally retire after inner EOF')
    await ps(`Unregister-ScheduledTask -TaskName ${quote(auditTask)} -Confirm:$false`); auditReceipt.unregistered = true
      return auditReceipt
    },
    })
    await writeFile(join(output, 'post-exit-lifecycle.json'), JSON.stringify(lifecycle, null, 2))
    assert.ok(windowsMultitaskCompletionPassed({ runnerExit, lifecycle, taskReceipt, auditReceipt, report, architecture, captureCount, physicalReceipts, consoleRetirement }), 'Complete acceptance requires actual exit0, Task0, passed guest/cleanup, one physical raster, and successful independent postflight')
  } catch (error) { fatal ??= error.message; process.exitCode = 1 }
  finally {
    // Ready tasks can be removed; a running/unknown task is retained as failure.
    for (const [name, receipt] of [[task, taskReceipt], [auditTask, auditReceipt]]) if (name && !receipt?.unregistered) try { const state = await ps(`$t=Get-ScheduledTask -TaskName ${quote(name)} -ErrorAction SilentlyContinue;if($t){$t.State.ToString()}`); if (state === 'Ready') await ps(`Unregister-ScheduledTask -TaskName ${quote(name)} -Confirm:$false`); else if (state) fatal ??= 'An exact owned task did not naturally retire; retained for explicit recovery' } catch (error) { fatal ??= error.message }
    if (idleChanged) try { await run(prl, ['set', vm, '--pause-idle', originalIdle], { timeout: 30000 }); const info = (await run(prl, ['list', '--info', vm], { timeout: 30000 })).stdout; const restored = new RegExp(`Pause idle: ${originalIdle}`).test(info); await writeFile(join(output, 'vm-pause-restored.json'), JSON.stringify({ originalIdle, restored })); if (!restored) fatal ??= 'VM idle preference was not restored' } catch (error) { fatal ??= error.message }
    if (server) { server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done)) }
    if (activeAcquire) try { await activeAcquire } catch (error) { fatal ??= error.message }
    try { if (!rawCleanup) await cleanupRaw() } catch (error) { fatal ??= error.message }
    await writeFile(join(output, 'physical-acquisition-stages.json'), JSON.stringify({ acquisitions, acquisitionAttempts, captureLifecycle, acquireRequests, finalizeRequests, state: raster.state, rawCleanup }, null, 2))
    const passed = !fatal && normalStartupVerified?.verified===true && normalStartupVerified.physicalCUAVerified===false && report?.normalOwnedStartup?.verified===true && report.normalOwnedStartup.physicalCUAVerified===false && twoPhaseRasterComplete(raster, rawCleanup, physicalReceipts) && acquireRequests === 1 && finalizeRequests === 1 && windowsMultitaskCompletionPassed({ runnerExit, lifecycle, taskReceipt, auditReceipt, report, architecture, captureCount, physicalReceipts, consoleRetirement })
    await writeFile(join(output, 'carrier-verdict.json'), JSON.stringify({ passed, fatal: fatal ?? null, runId: data.id, architecture, guestRoot, task, auditTask, runnerExit, lifecycle, taskReceipt, auditReceipt, consoleRetirement, captureCount, acquireRequests, finalizeRequests, captureLifecycle, rawCleanup, captureSource: raster.receipt?.captureSource, normalOwnedStartup: normalStartupVerified??null, strictPhysicalCUAVerified:false, productNativeCompiled: false, testFixturesCompiled, installedHarnessClaim: false, foregroundFixturePermits: args.includes('--fixture-foreground-permits'), productionAutomaticCrossHelperFocusClaim: false, commandReceipts, sourceHashes: data.sourceHashes }, null, 2))
    console.log(JSON.stringify({ passed, output, architecture, fatal: fatal ?? null })); if (!passed) process.exitCode = 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
  if (process.argv.includes('--prepare')) { const config = JSON.parse(await readFile(arg('--input-config'), 'utf8')); console.log(JSON.stringify(await prepareWindowsMultitaskAcceptance({ ...config, output: arg('--out') }), null, 2)) }
}
