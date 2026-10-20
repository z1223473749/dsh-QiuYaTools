/** Disposable Windows renderer soak. Reuses only the explicit, prepared test runtime's dependencies. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve, win32 } from 'node:path'
import { build } from 'esbuild'
const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url))
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] }
const minutes = Number(arg('--minutes', '30')), faults = Number(arg('--faults', '5'))
const imageMemory = process.argv.includes('--image-memory'), seconds = Number(arg('--seconds', '60'))
assert.ok(!imageMemory || Number.isFinite(seconds) && seconds >= 10 && seconds <= 180)
const imageModes = arg('--image-modes', 'production').split(',')
assert.ok(!imageMemory || imageModes.length > 0 && imageModes.length <= 3 && new Set(imageModes).size === imageModes.length && imageModes.every(mode => ['data-url', 'object-url-revoke', 'bitmap-canvas', 'production'].includes(mode)))
assert.ok(Number.isFinite(minutes) && minutes > 0 && minutes <= 120)
assert.ok(Number.isSafeInteger(faults) && faults >= 0 && faults <= 50)
const vm = process.env.QIUYA_PD_VM, host = process.env.QIUYA_PD_HOST_IP
assert.match(vm || '', /^[a-f0-9-]{36}$/iu, 'Set QIUYA_PD_VM to the authorized test VM')
assert.match(host || '', /^\d+\.\d+\.\d+\.\d+$/u, 'Set QIUYA_PD_HOST_IP to its host-only Mac address')
const runtimeRoot = process.env.QIUYA_WINDOWS_RUNTIME_ROOT
assert.ok(runtimeRoot, 'Set QIUYA_WINDOWS_RUNTIME_ROOT to the prepared QiuYaTools-harness-UUID guest directory')
const output = resolve(arg('--output', 'artifacts/computer-use/windows-renderer-soak'))
await mkdir(output, { recursive: true })
const prlctl = process.env.QIUYA_PRLCTL || '/Applications/Parallels Desktop.app/Contents/MacOS/prlctl'
const quote = value => `'${value.replaceAll("'", "''")}'`
async function ps(code, timeout = 45000) {
  return (await run(prlctl, ['exec', vm, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { timeout, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 })).stdout.trim()
}
const key = randomUUID(), helperPath = resolve(process.env.QIUYA_WINDOWS_HELPER || join(root, 'lib/native/win32-arm64/qiuya-windows.exe'))
const frozenRuntime = arg('--runtime-bundle')
const compiled = frozenRuntime || imageMemory ? undefined : await build({ stdin: { contents: "export {installComputerHost} from './src/features/computer-use/host.ts'; export {NativeCompanionDriver} from './src/features/computer-use/native.ts'", resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'esm' })
const previewBuild = imageMemory ? await build({ entryPoints: [join(root, 'src/features/computer-use/preview-page.ts')], bundle: true, write: false, platform: 'node', format: 'esm' }) : undefined
const previewHtml = previewBuild ? (await import(`data:text/javascript;base64,${Buffer.from(previewBuild.outputFiles[0].text).toString('base64')}`)).computerPreviewPage : undefined
const files = imageMemory ? new Map([['image-memory.mjs', await readFile(join(root, 'scripts/test-preview-image-memory.mjs'))], ['preview.html', Buffer.from(previewHtml)]]) : new Map([
  ['runtime.mjs', frozenRuntime ? await readFile(resolve(frozenRuntime)) : Buffer.from(compiled.outputFiles[0].text)],
  ['soak-computer.mjs', await readFile(join(root, 'scripts/soak-computer.mjs'))],
  ['computer-soak-evidence.mjs', await readFile(join(root, 'scripts/computer-soak-evidence.mjs'))],
  ['windows-soak-fixture.ps1', await readFile(join(root, 'tests/fixtures/windows-soak-fixture.ps1'))],
  ['qiuya-windows.exe', await readFile(helperPath)],
])
const server = createServer((request, response) => {
  const match = new RegExp(`^/${key}/([a-z0-9.-]+)$`, 'u').exec(request.url || '')
  const file = request.method === 'GET' && match && files.get(match[1])
  if (!file) return response.writeHead(404).end()
  response.writeHead(200, { 'Content-Length': file.length }); response.end(file)
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, host, done) })
let guestRoot, task, completed
try {
  const identity = JSON.parse(await ps(`$ErrorActionPreference='Stop';$u=(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -First 1).UserName;if(!$u){throw 'No interactive user'};$s=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value;$p=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$s)).ProfileImagePath;@{user=$u;profile=$p}|ConvertTo-Json -Compress`))
  const prepared = win32.normalize(runtimeRoot), prefix = win32.join(identity.profile, 'AppData/Local/Temp/QiuYaTools-harness-')
  assert.ok(prepared.startsWith(prefix) && /^[a-f0-9-]{36}$/iu.test(prepared.slice(prefix.length)), 'Dependencies must come from an explicitly prepared disposable test runtime')
  guestRoot = win32.join(identity.profile, 'AppData/Local/Temp', `QiuYaTools-renderer-soak-${key}`)
  const node = win32.join(prepared, 'node-v22.23.3-win-arm64/node.exe'), modules = win32.join(prepared, 'qiuya-harness-windows-portable/node_modules')
  const stamp = await ps(`$ErrorActionPreference='Stop';if(!(Test-Path ${quote(node)})-or !(Test-Path ${quote(win32.join(modules, 'playwright/package.json'))})){throw 'Prepared Node or Playwright missing'};[IO.File]::ReadAllText(${quote(win32.join(prepared, 'runtime-input.json'))})`)
  const runtimeInput = JSON.parse(stamp)
  for (const value of Object.values(runtimeInput)) assert.match(value, /^[a-f0-9]{64}$/iu)
  await ps(`$ErrorActionPreference='Stop';New-Item -ItemType Directory ${quote(guestRoot)}|Out-Null;New-Item -ItemType Junction -Path ${quote(win32.join(guestRoot, 'node_modules'))} -Target ${quote(modules)}|Out-Null`)
  const url = name => `http://${host}:${server.address().port}/${key}/${name}`
  async function transfer(name) {
    const hash = createHash('sha256').update(files.get(name)).digest('hex')
    await ps(`$ErrorActionPreference='Stop';$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(url(name))},${quote(win32.join(guestRoot, name))});$c.Dispose();if((Get-FileHash ${quote(win32.join(guestRoot, name))} -Algorithm SHA256).Hash.ToLowerInvariant()-ne ${quote(hash)}){throw 'Transferred test input hash mismatch'}`, 120000)
  }
  for (const name of files.keys()) await transfer(name)
  files.set('launch.mjs', Buffer.from(`
import{readFile,writeFile}from'node:fs/promises';import{dirname,join}from'node:path';import{pathToFileURL,fileURLToPath}from'node:url';
const base=dirname(fileURLToPath(import.meta.url));process.env.PATH=dirname(process.execPath)+';'+process.env.PATH;
try{process.argv=${imageMemory ? `[process.execPath,join(base,'image-memory.mjs'),'--html',join(base,'preview.html'),'--seconds',${JSON.stringify(String(seconds))},'--modes',${JSON.stringify(imageModes.join(','))},'--output',join(base,'evidence')]` : `[process.execPath,join(base,'soak-computer.mjs'),'--runtime',join(base,'runtime.mjs'),'--fixture',join(base,'windows-soak-fixture.ps1'),'--native',join(base,'qiuya-windows.exe'),'--minutes',${JSON.stringify(String(minutes))},'--faults',${JSON.stringify(String(faults))},'--output',join(base,'evidence')]`};await import(pathToFileURL(process.argv[1]).href)}
catch(error){await writeFile(join(base,'startup-error.json'),JSON.stringify({error:error.message,stack:error.stack}));process.exitCode=1}
finally{await writeFile(join(base,'completed.json'),JSON.stringify({exitCode:process.exitCode||0}))}
`))
  await transfer('launch.mjs')
  files.set('start.ps1', Buffer.from(`$ErrorActionPreference='Stop';$p=Start-Process -FilePath ${quote(node)} -ArgumentList ${quote(`"${win32.join(guestRoot, 'launch.mjs')}"`)} -WorkingDirectory ${quote(guestRoot)} -WindowStyle Hidden -RedirectStandardOutput ${quote(win32.join(guestRoot, 'runner.log'))} -RedirectStandardError ${quote(win32.join(guestRoot, 'runner.err'))} -PassThru;@{pid=$p.Id;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress|Set-Content -LiteralPath ${quote(win32.join(guestRoot, 'runner-identity.json'))} -Encoding UTF8;$p.WaitForExit()`))
  await transfer('start.ps1')
  task = `QiuYaTools-renderer-soak-${key}`
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${win32.join(guestRoot, 'start.ps1')}"`
  await ps(`$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(args)};$p=New-ScheduledTaskPrincipal -UserId ${quote(identity.user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes ${Math.ceil(imageMemory ? seconds * imageModes.length / 60 : minutes) + 10}) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(task)}`)
  const environment = { vm, host, guestRoot, task, runtimeRoot: prepared, runtimeInput, node, kind: imageMemory ? 'pure-browser-image-memory-diagnosis' : 'native-renderer-endurance', minutes: imageMemory ? undefined : minutes, faults: imageMemory ? 0 : faults, renderer: 'installed Edge headless shared production preview frontend, not native WebView2', runtimeBundle: imageMemory ? 'current-production-preview-html' : frozenRuntime ? resolve(frozenRuntime) : 'bundled-from-current-source', helperPath: imageMemory ? null : helperPath, imageMemory, nativeOps: imageMemory ? 0 : undefined, secondsPerMode: imageMemory ? seconds : undefined, imageModes: imageMemory ? imageModes : undefined, inputHashes: Object.fromEntries([...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])), startedAt: new Date().toISOString() }
  await writeFile(join(output, 'environment.json'), JSON.stringify(environment, null, 2))
  console.error(JSON.stringify(imageMemory ? { stage: 'interactive-image-memory-diagnosis-started', guestRoot, secondsPerMode: seconds, modes: imageModes, faults: 0, nativeOps: 0, output } : { stage: 'interactive-renderer-soak-started', guestRoot, minutes, faults, output }))
  const deadline = Date.now() + (imageMemory ? seconds * imageModes.length * 1000 : minutes * 60000) + 240000
  let lastProgress
  while (Date.now() < deadline) {
    const state = await ps(`$ErrorActionPreference='Stop';$c=${quote(win32.join(guestRoot, 'completed.json'))};$p=${quote(win32.join(guestRoot, 'evidence/progress.json'))};if(Test-Path $c){@{completed=[IO.File]::ReadAllText($c)}|ConvertTo-Json -Compress}elseif(Test-Path $p){$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{$r=[IO.StreamReader]::new($f);@{progress=$r.ReadToEnd()}|ConvertTo-Json -Compress}finally{$f.Dispose()}}`)
    if (state) {
      const value = JSON.parse(state)
      if (value.completed) { completed = JSON.parse(value.completed); break }
      if (value.progress && value.progress !== lastProgress) {
        try { const progress = JSON.parse(value.progress); await writeFile(join(output, 'progress.json'), JSON.stringify(progress, null, 2)); console.error(JSON.stringify({ stage: 'renderer-progress', elapsedMs: progress.elapsedMs, frames: progress.stats.frames, invalid: progress.stats.invalid })); lastProgress = value.progress } catch { /* Concurrent writer: next sample retries. */ }
      }
    }
    await new Promise(done => setTimeout(done, 10000))
  }
  if (!completed) throw new Error('Windows renderer soak exceeded its bounded deadline')
  for (const folder of ['', 'evidence']) {
    const directory = win32.join(guestRoot, folder)
    const listing = JSON.parse(await ps(`ConvertTo-Json -InputObject @(Get-ChildItem ${quote(directory)} -File -ErrorAction SilentlyContinue|Where-Object Name -match '\\.(json|log|err|jpg|png|html)$'|Select-Object -ExpandProperty Name) -Compress`))
    for (const name of listing) {
      assert.match(name, /^[a-zA-Z0-9_.-]+$/u)
      const bytes = await ps(`$f=[IO.File]::Open(${quote(win32.join(directory, name))},[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));try{$m=[IO.MemoryStream]::new();$f.CopyTo($m);[Convert]::ToBase64String($m.ToArray());$m.Dispose()}finally{$f.Dispose()}`)
      if (bytes) await writeFile(join(output, name), Buffer.from(bytes, 'base64'))
    }
  }
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  console.log(JSON.stringify({ status: report.status, exitCode: completed.exitCode, output, frames: report.frames, elapsedMs: report.elapsedMs, uniqueFps: report.uniqueFps, endToEndFps: report.endToEndFps, latencyP95Ms: report.latencyP95Ms, invalid: report.invalidTimestamps, faults: report.faults?.length, nativeOps: report.nativeOps, arms: report.arms?.map(arm => ({ mode: arm.mode, loaded: arm.loaded, maxBrowserWorkingSetBytes: arm.maxBrowserWorkingSetBytes, maxRendererWorkingSetBytes: arm.maxRendererWorkingSetBytes })) }, null, 2))
  if (report.status !== 'passed' || completed.exitCode !== 0) process.exitCode = 1
} catch (error) {
  await writeFile(join(output, 'orchestration-error.json'), JSON.stringify({ status: 'failed', error: error.message, guestRoot, completed }, null, 2)); console.error(error.message); process.exitCode = 1
} finally {
  if (task) await ps(`Stop-ScheduledTask -TaskName ${quote(task)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {})
  // A scheduler timeout must not leave this test's Node/Edge/fixture alive.
  // Match both PID birth and our UUID launch path before terminating its tree.
  if (guestRoot) await ps(`$f=${quote(win32.join(guestRoot, 'runner-identity.json'))};if(Test-Path $f){$i=Get-Content -LiteralPath $f -Raw|ConvertFrom-Json;$p=Get-Process -Id $i.pid -ErrorAction SilentlyContinue;if($p -and $p.StartTime.ToUniversalTime().Ticks.ToString()-eq $i.startTicks){$c=Get-CimInstance Win32_Process -Filter ('ProcessId='+$i.pid);if($c.CommandLine.Contains(${quote(win32.join(guestRoot, 'launch.mjs'))})){taskkill.exe /PID $i.pid /T /F|Out-Null}}}`).catch(() => {})
  server.closeAllConnections(); await new Promise(done => server.close(done))
}
