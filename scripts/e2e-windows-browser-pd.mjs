/** Real installed Edge through CDP in an isolated interactive Windows profile. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
const run = promisify(execFile)
const vm = process.env.QIUYA_PD_VM, host = process.env.QIUYA_PD_HOST_IP, node = process.env.QIUYA_WINDOWS_NODE
if (!/^[a-f0-9-]{36}$/iu.test(vm ?? '') || !/^\d+\.\d+\.\d+\.\d+$/u.test(host ?? '') || !/^[A-Z]:\\.+\\node\.exe$/iu.test(node ?? '')) throw new Error('Set QIUYA_PD_VM, QIUYA_PD_HOST_IP, and QIUYA_WINDOWS_NODE to the authorized guest and its portable Node executable')
const prl = process.env.QIUYA_PRLCTL ?? '/Applications/Parallels Desktop.app/Contents/MacOS/prlctl'
const output = resolve(process.env.QIUYA_WINDOWS_BROWSER_OUTPUT ?? join(tmpdir(), `qiuya-windows-edge-${randomUUID()}`))
await mkdir(output, { recursive: true })
const source = (await build({ stdin: { contents: "export {BrowserSession,BrowserDeviceDriver} from './src/features/computer-use/browser.ts';export {ComputerSessionService} from './src/features/computer-use/session.ts';export {installComputerTools} from './src/features/computer-use/tools.ts'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const key = randomUUID(), files = new Map([['browser.mjs', Buffer.from(source)], ['test.mjs', await readFile('scripts/test-computer-browser.mjs')]])
const server = createServer((request, response) => {
  const parts = request.url?.split('/'), bytes = request.method === 'GET' && parts?.[1] === key && files.get(parts[2])
  if (!bytes) return response.writeHead(404).end()
  response.writeHead(200, { 'Content-Length': bytes.length }); response.end(bytes)
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, host, done) })
const quote = text => `'${text.replaceAll("'", "''")}'`
const ps = async (code, timeout = 30000) => (await run(prl, ['exec', vm, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })).stdout.trim()
let task, guestRoot
try {
  const identity = JSON.parse(await ps(`$u=(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -First 1).UserName;$s=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value;$p=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$s)).ProfileImagePath;@{user=$u;profile=$p}|ConvertTo-Json -Compress`))
  guestRoot = `${identity.profile}\\AppData\\Local\\Temp\\QiuYaTools-browser-${key}`; task = `QiuYaTools-browser-${key}`
  const launch = `$ErrorActionPreference='Stop';$p=Start-Process -FilePath ${quote(node)} -ArgumentList ${quote(`"${guestRoot}\\test.mjs" --browser edge --module "${guestRoot}\\browser.mjs" --artifacts "${guestRoot}\\evidence"`)} -WorkingDirectory ${quote(guestRoot)} -WindowStyle Hidden -RedirectStandardOutput ${quote(`${guestRoot}\\runner.log`)} -RedirectStandardError ${quote(`${guestRoot}\\runner.err`)} -PassThru;$p.WaitForExit();[IO.File]::WriteAllText(${quote(`${guestRoot}\\completed.json`)},('{"exitCode":'+$p.ExitCode+'}'))`
  files.set('start.ps1', Buffer.from(launch))
  await ps(`New-Item -ItemType Directory -Force ${quote(guestRoot)}|Out-Null`)
  for (const name of files.keys()) await ps(`$ErrorActionPreference='Stop';$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(`http://${host}:${server.address().port}/${key}/${name}`)},${quote(`${guestRoot}\\${name}`)})`)
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${guestRoot}\\start.ps1"`
  await ps(`$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(args)};$p=New-ScheduledTaskPrincipal -UserId ${quote(identity.user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(task)}`)
  let completed = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await ps(`if(Test-Path ${quote(`${guestRoot}\\completed.json`)}){'done'}`)) { completed = true; break }
    await new Promise(done => setTimeout(done, 1500))
  }
  for (const name of ['summary.json', 'before.jpg', 'after.jpg', 'runner.log', 'runner.err']) {
    const path = name.startsWith('runner.') ? `${guestRoot}\\${name}` : `${guestRoot}\\evidence\\${name}`
    const bytes = await ps(`if(Test-Path ${quote(path)}){[Convert]::ToBase64String([IO.File]::ReadAllBytes(${quote(path)}))}`)
    if (bytes) await writeFile(join(output, name), Buffer.from(bytes, 'base64'))
  }
  if (!completed) throw new Error('Interactive Edge test did not complete before its deadline')
  const report = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'))
  await writeFile(join(output, 'environment.json'), JSON.stringify({ vm, guestRoot, node, desktopSession: 'InteractiveToken logged-on user; headless browser uses a fresh profile', testedAt: new Date().toISOString() }, null, 2))
  console.log(JSON.stringify({ status: report.status, checks: report.checks?.length, output, guestRoot }, null, 2)); if (report.status !== 'passed') process.exitCode = 1
} catch (error) {
  await writeFile(join(output, 'orchestration-error.json'), JSON.stringify({ error: error.message, guestRoot }, null, 2)); console.error(JSON.stringify({ error: error.message, output, guestRoot }, null, 2)); process.exitCode = 1
} finally {
  if (task) await ps(`Stop-ScheduledTask -TaskName ${quote(task)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {})
  server.closeAllConnections(); await new Promise(done => server.close(done))
}
