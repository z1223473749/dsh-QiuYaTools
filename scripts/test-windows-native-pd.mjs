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
const endurance = process.env.QIUYA_WINDOWS_TEST_KIND === 'endurance'
const fixture = await readFile(new URL(endurance ? '../src/native/windows/native-endurance.ps1' : '../src/native/windows/native-e2e.ps1', import.meta.url))
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
try {
  const identity = JSON.parse(await powershell(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$user=(Get-Process explorer -IncludeUserName | Where-Object SessionId -gt 0 | Select-Object -First 1).UserName;if(!$user){throw 'No logged-on user'};$sid=([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier]).Value;$qytProfile=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$sid)).ProfileImagePath;@{user=$user;profile=$qytProfile}|ConvertTo-Json -Compress`))
  if (!identity.profile || !identity.user) throw new Error('No interactive Windows profile')
  guestRoot = `${identity.profile}\\AppData\\Local\\Temp\\QiuYaTools-native-${key}`
  taskName = `QiuYaTools-native-test-${key}`
  console.error('[qiuya-phase] interactive identity resolved')
  await powershell(`$ErrorActionPreference='Stop';New-Item -ItemType Directory -Force ${psQuote(guestRoot)}|Out-Null;$client=[Net.WebClient]::new();$client.Proxy=$null;$client.DownloadFile(${psQuote(`http://${host}:${port}/${key}/helper.exe`)},${psQuote(`${guestRoot}\\qiuya-windows.exe`)})`, 90000)
  console.error('[qiuya-phase] helper transferred')
  await powershell(`$ErrorActionPreference='Stop';$client=[Net.WebClient]::new();$client.Proxy=$null;$client.DownloadFile(${psQuote(`http://${host}:${port}/${key}/native-e2e.ps1`)},${psQuote(`${guestRoot}\\native-e2e.ps1`)});if((Get-FileHash ${psQuote(`${guestRoot}\\qiuya-windows.exe`)} -Algorithm SHA256).Hash.ToLowerInvariant() -ne ${psQuote(createHash('sha256').update(helper).digest('hex'))}){throw 'Transfer integrity failure'}`)
  console.error('[qiuya-phase] transfer integrity checked')
  const argumentsText = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${guestRoot}\\native-e2e.ps1" -Helper "${guestRoot}\\qiuya-windows.exe" -Output "${guestRoot}\\evidence"`
  await powershell(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote(argumentsText)};$p=New-ScheduledTaskPrincipal -UserId ${psQuote(identity.user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes ${endurance ? 40 : 5}) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${psQuote(taskName)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${psQuote(taskName)}`)
  console.error('[qiuya-phase] interactive task started')
  const reportPath = `${guestRoot}\\evidence\\report.json`
  let report
  let physicalSent = false
  for (let attempt = 0; attempt < (endurance ? 1400 : 100); attempt++) {
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
  for (const name of ['fixture-observe.jpg', 'fixture-state.json']) {
    const encoded = await powershell(`$path=${psQuote(`${guestRoot}\\evidence\\${name}`)};if(Test-Path $path){[Convert]::ToBase64String([IO.File]::ReadAllBytes($path))}`)
    if (encoded) await writeFile(join(output, name), Buffer.from(encoded, 'base64'))
  }
  await writeFile(join(output, 'environment.json'), JSON.stringify({ vm, host, helperSha256: createHash('sha256').update(helper).digest('hex'), guestRoot, report: 'report.json', nativeDesktopSession: report.sessionId, passed: report.passed }, null, 2) + '\n')
  console.log(JSON.stringify({ output, passed: report.passed, checks: report.checks?.length, error: report.error, architecture: report.architecture, sessionId: report.sessionId }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (taskName) {
    await powershell(`Stop-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${psQuote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {})
  }
  server.closeAllConnections();
  await new Promise(done => server.close(done))
}
