import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const run = promisify(execFile)
const vm = process.env.QIUYA_PD_VM
const host = process.env.QIUYA_PD_HOST_IP
if (!vm || !/^[a-f0-9-]{36}$/iu.test(vm) || !host || !/^\d+\.\d+\.\d+\.\d+$/u.test(host)) throw new Error('Set QIUYA_PD_VM and QIUYA_PD_HOST_IP to the selected test VM and its host-only Mac address')
const prlctl = process.env.QIUYA_PRLCTL || '/Applications/Parallels Desktop.app/Contents/MacOS/prlctl'
const helperPath = resolve(process.env.QIUYA_WINDOWS_HELPER || fileURLToPath(new URL('../lib/native/win32-arm64/qiuya-windows.exe', import.meta.url)))
const helper = await readFile(helperPath)
const kind = process.env.QIUYA_WINDOWS_TEST_KIND
const endurance = kind === 'endurance', inputEndurance = kind === 'input'
const inputSeconds = Number(process.env.QIUYA_WINDOWS_INPUT_SECONDS || '120'), inputRecoveries = Number(process.env.QIUYA_WINDOWS_INPUT_RECOVERIES || '5')
if (inputEndurance && (!Number.isSafeInteger(inputSeconds) || inputSeconds < 30 || inputSeconds > 600 || !Number.isSafeInteger(inputRecoveries) || inputRecoveries < 1 || inputRecoveries > 10)) throw new Error('Input short test requires 30–600 seconds and 1–10 recoveries')
const fixture = await readFile(new URL(inputEndurance ? '../src/native/windows/native-input-endurance.ps1' : endurance ? '../src/native/windows/native-endurance.ps1' : process.env.QIUYA_WINDOWS_TEST_KIND === 'capture' ? '../src/native/windows/capture-e2e.ps1' : process.env.QIUYA_WINDOWS_TEST_KIND === 'pause' ? '../src/native/windows/pause-latency-e2e.ps1' : '../src/native/windows/native-e2e.ps1', import.meta.url))
const helperSha256 = createHash('sha256').update(helper).digest('hex')
const fixtureSha256 = createHash('sha256').update(fixture).digest('hex')
const key = randomUUID()
const output = resolve(process.env.QIUYA_WINDOWS_TEST_OUTPUT || join(tmpdir(), `qiuya-windows-native-${key}`))
await mkdir(output, { recursive: true })
const files = new Map([['helper.exe', helper], ['native-e2e.ps1', fixture]])
const server = createServer((request, response) => {
  const match = new RegExp(`^/${key}/([a-z0-9.-]+)$`, 'u').exec(request.url || '')
  const file = request.method === 'GET' && match && files.get(match[1])
  if (!file) { response.writeHead(404).end(); return }
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.length }); response.end(file)
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, host, done) })
const port = server.address().port
const psQuote = value => `'${value.replaceAll("'", "''")}'`
async function powershell(code, timeout = 30000) {
  const encoded = Buffer.from(code, 'utf16le').toString('base64')
  const pending = run(prlctl, ['exec', vm, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })
  pending.child.stdout.on('data', chunk => { for (const line of String(chunk).split(/\r?\n/u)) if (line.startsWith('[qiuya-phase]')) console.error(line) })
  const result = await pending
  return result.stdout.trim()
}
let taskName
let guestRoot
let report
let post
let naturalTaskExit
let inputRunError
const inputWrapperCleanup = { passed: false, stopRequired: false, stopped: false, unregistered: false, errors: [] }
const boundedError = error => ({ code: error.code ?? null, message: String(error.message).split('\n')[0].replace(/ -EncodedCommand .*/u, ' [command omitted]').slice(0, 500), stdout: String(error.stdout ?? '').slice(0, 2000), stderr: String(error.stderr ?? '').slice(0, 2000) })
try {
  const identity = JSON.parse(await powershell(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$user=(Get-Process explorer -IncludeUserName | Where-Object SessionId -gt 0 | Select-Object -First 1).UserName;if(!$user){throw 'No logged-on user'};$sid=([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier]).Value;$qytProfile=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$sid)).ProfileImagePath;@{user=$user;profile=$qytProfile}|ConvertTo-Json -Compress`))
  if (!identity.profile || !identity.user) throw new Error('No interactive Windows profile')
  guestRoot = `${identity.profile}\\AppData\\Local\\Temp\\QiuYaTools-native-${key}`
  taskName = `QiuYaTools-native-test-${key}`
  console.error('[qiuya-phase] interactive identity resolved')
  await powershell(`$ErrorActionPreference='Stop';New-Item -ItemType Directory -Force ${psQuote(guestRoot)}|Out-Null;$client=[Net.WebClient]::new();$client.Proxy=$null;$client.DownloadFile(${psQuote(`http://${host}:${port}/${key}/helper.exe`)},${psQuote(`${guestRoot}\\qiuya-windows.exe`)})`, 90000)
  console.error('[qiuya-phase] helper transferred')
  await powershell(`$ErrorActionPreference='Stop';$client=[Net.WebClient]::new();$client.Proxy=$null;$client.DownloadFile(${psQuote(`http://${host}:${port}/${key}/native-e2e.ps1`)},${psQuote(`${guestRoot}\\native-e2e.ps1`)});if((Get-FileHash ${psQuote(`${guestRoot}\\qiuya-windows.exe`)} -Algorithm SHA256).Hash.ToLowerInvariant() -ne ${psQuote(helperSha256)}){throw 'Transfer integrity failure'}`)
  if (inputEndurance) await powershell(`$ErrorActionPreference='Stop';if((Get-FileHash -LiteralPath ${psQuote(`${guestRoot}\\native-e2e.ps1`)} -Algorithm SHA256).Hash.ToLowerInvariant() -ne ${psQuote(fixtureSha256)}){throw 'Input script transfer integrity failure'}`)
  console.error('[qiuya-phase] transfer integrity checked')
  const inputArguments = inputEndurance ? ` -Seconds ${inputSeconds} -Recoveries ${inputRecoveries}` : ''
  const argumentsText = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${guestRoot}\\native-e2e.ps1" -Helper "${guestRoot}\\qiuya-windows.exe" -Output "${guestRoot}\\evidence"${inputArguments}`
  await powershell(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote(argumentsText)};$p=New-ScheduledTaskPrincipal -UserId ${psQuote(identity.user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes ${endurance ? 40 : inputEndurance ? Math.ceil(inputSeconds / 60) + 3 : 5}) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${psQuote(taskName)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${psQuote(taskName)}`)
  console.error('[qiuya-phase] interactive task started')
  const reportPath = `${guestRoot}\\evidence\\report.json`
  let physicalSent = false
  for (let attempt = 0; attempt < (endurance ? 1400 : inputEndurance ? Math.ceil((inputSeconds + 120) / 1.5) : 100); attempt++) {
    const response = await powershell(`$path=${psQuote(reportPath)}; if (Test-Path $path) {[Convert]::ToBase64String([IO.File]::ReadAllBytes($path))} elseif (Test-Path ${psQuote(`${guestRoot}\\evidence\\physical-checkpoint.json`)}) {'PHYSICAL_CHECKPOINT'}`)
    if (response === 'PHYSICAL_CHECKPOINT') {
      if (!physicalSent) {
        physicalSent = true
        await powershell(`[IO.File]::WriteAllText(${psQuote(`${guestRoot}\\evidence\\physical-go`)},'go')`)
        await new Promise(done => setTimeout(done, 100))
        await run(prlctl, ['send-key-event', vm, '--scancode', '1'], { timeout: 10000, killSignal: 'SIGKILL' })
      }
      await new Promise(done => setTimeout(done, 500)); continue
    }
    if (response) { const bytes = Buffer.from(response, 'base64'); await writeFile(join(output, 'report.json'), bytes); report = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')); break }
    await new Promise(done => setTimeout(done, 1500))
  }
  if (!report) throw new Error('Windows interactive native test did not produce a report before its deadline')
  if (inputEndurance) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const exit = JSON.parse(await powershell(`$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName ${psQuote(taskName)};$i=Get-ScheduledTaskInfo -TaskName ${psQuote(taskName)};@{state=$t.State.ToString();lastTaskResult=[long]$i.LastTaskResult}|ConvertTo-Json -Compress`))
      if (exit.state === 'Ready' && exit.lastTaskResult === 0) { naturalTaskExit = exit; break }
      await new Promise(done => setTimeout(done, 200))
    }
    if (!naturalTaskExit) throw new Error('Input-test runner did not exit naturally with task result 0 after its report')
    post = JSON.parse(await powershell(`$ErrorActionPreference='Stop';$r=Get-Content -LiteralPath ${psQuote(reportPath)} -Raw|ConvertFrom-Json;$items=@($r.cleanup.tracked|Where-Object{$null -ne $_});$live=@();foreach($i in $items){$p=$null;try{$p=[Diagnostics.Process]::GetProcessById([int]$i.pid);$null=$p.SafeHandle;if($p.StartTime.ToUniversalTime().Ticks.ToString()-eq $i.createdAtTicks){$live+=@{pid=$i.pid;createdAtTicks=$i.createdAtTicks}}}catch [ArgumentException]{}finally{if($p){$p.Dispose()}}};@{passed=($live.Count-eq 0);remaining=$live;checked=$items.Count}|ConvertTo-Json -Depth 5 -Compress`))
    await writeFile(join(output, 'post-run-cleanup-verification.json'), JSON.stringify(post, null, 2))
  }
  for (const name of ['fixture-observe.jpg', 'fixture-state.json', 'fixture-state.json.heartbeat.json', 'failure-diagnostics.json']) {
    const encoded = await powershell(`$path=${psQuote(`${guestRoot}\\evidence\\${name}`)};if(Test-Path $path){[Convert]::ToBase64String([IO.File]::ReadAllBytes($path))}`)
    if (encoded) await writeFile(join(output, name), Buffer.from(encoded, 'base64'))
  }
  if (!inputEndurance) {
    await writeFile(join(output, 'environment.json'), JSON.stringify({ vm, host, helperSha256, guestRoot, report: 'report.json', nativeDesktopSession: report.sessionId, passed: report.passed }, null, 2) + '\n')
    console.log(JSON.stringify({ output, passed: report.passed, checks: report.checks?.length, error: report.error, architecture: report.architecture, sessionId: report.sessionId }, null, 2))
    if (!report.passed) process.exitCode = 1
  }
} catch (error) {
  if (!inputEndurance) throw error
  inputRunError = boundedError(error)
  process.exitCode = 1
} finally {
  if (taskName) {
    if (!inputEndurance) {
      await powershell(`Stop-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${psQuote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {})
    } else {
      try {
        const task = JSON.parse(await powershell(`$ErrorActionPreference='Stop';$t=@(Get-ScheduledTask -ErrorAction Stop|Where-Object{$_.TaskName -eq ${psQuote(taskName)} -and $_.TaskPath -eq '\\'});if($t.Count -gt 1){throw 'Owned task identity is ambiguous'};@{exists=($t.Count -eq 1);state=if($t.Count){$t[0].State.ToString()}else{$null}}|ConvertTo-Json -Compress`))
        inputWrapperCleanup.taskBeforeRemoval = task
        if (task.exists) {
          if (task.state !== 'Ready') {
            inputWrapperCleanup.stopRequired = true
            await powershell(`$ErrorActionPreference='Stop';Stop-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction Stop`)
            inputWrapperCleanup.stopped = true
          }
          await powershell(`$ErrorActionPreference='Stop';Unregister-ScheduledTask -TaskName ${psQuote(taskName)} -Confirm:$false -ErrorAction Stop`)
          inputWrapperCleanup.unregistered = true
        }
        inputWrapperCleanup.passed = Boolean(naturalTaskExit && task.exists && task.state === 'Ready' && inputWrapperCleanup.unregistered && !inputWrapperCleanup.stopRequired)
      } catch (error) { inputWrapperCleanup.errors.push(boundedError(error)) }
    }
  }
  server.closeAllConnections();
  await new Promise(done => server.close(done))
  if (inputEndurance) {
    const delivery = {
      passed: Boolean(report?.passed === true && post?.passed === true && naturalTaskExit && inputWrapperCleanup.passed && !inputRunError),
      runnerPassed: report?.passed === true,
      postPassed: post?.passed === true,
      naturalTaskExit: naturalTaskExit ?? null,
      wrapperCleanup: inputWrapperCleanup,
      error: inputRunError ?? null,
      rawReportPreserved: true,
    }
    await writeFile(join(output, 'delivery-verdict.json'), JSON.stringify(delivery, null, 2) + '\n')
    await writeFile(join(output, 'environment.json'), JSON.stringify({ vm, host, helperSha256, inputScriptSha256: fixtureSha256, inputSeconds, inputRecoveries, guestRoot, report: 'report.json', delivery: 'delivery-verdict.json', nativeDesktopSession: report?.sessionId, passed: delivery.passed }, null, 2) + '\n')
    console.log(JSON.stringify({ output, runnerPassed: delivery.runnerPassed, postPassed: delivery.postPassed, deliveryPassed: delivery.passed, error: report?.error ?? inputRunError, architecture: report?.architecture, sessionId: report?.sessionId }, null, 2))
    if (!delivery.passed) process.exitCode = 1
  }
}
