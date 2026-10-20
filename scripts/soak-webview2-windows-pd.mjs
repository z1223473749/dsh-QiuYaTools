/** Disposable native WebView2 endurance in the explicitly selected PD guest. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve, win32 } from 'node:path'
import { build } from 'esbuild'
import { windowsProcessSnapshotCommand, windowsEmergencyCleanupIdentities, windowsPinnedProcessCommand } from './computer-webview2-soak-evidence.mjs'

const root = fileURLToPath(new URL('../', import.meta.url)), run = promisify(execFile)
const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1] }
const minutes = Number(arg('--minutes', '30')), faults = Number(arg('--faults', '5'))
assert.ok(Number.isFinite(minutes) && minutes > 0 && minutes <= 120)
assert.ok(Number.isSafeInteger(faults) && faults >= 0 && faults <= 50)
const arch = process.env.QIUYA_WINDOWS_ARCH || 'arm64'
assert.ok(['arm64', 'x64'].includes(arch))
const vm = process.env.QIUYA_PD_VM, host = process.env.QIUYA_PD_HOST_IP
assert.match(vm || '', /^[a-f0-9-]{36}$/iu); assert.match(host || '', /^\d+\.\d+\.\d+\.\d+$/u)
const preparedRoot = process.env.QIUYA_WINDOWS_RUNTIME_ROOT
assert.ok(preparedRoot, 'Explicit prepared test runtime guest directory is required')
const prlctl = process.env.QIUYA_PRLCTL || '/Applications/Parallels Desktop.app/Contents/MacOS/prlctl'
const output = resolve(arg('--output', 'artifacts/computer-use/windows-webview2-720p-soak'))
await mkdir(output, { recursive: true })
const quote = value => `'${value.replaceAll("'", "''")}'`
async function ps(code, timeout = 45000) {
  const encoded = Buffer.from(code, 'utf16le').toString('base64')
  const invoke = async args => (await run(prlctl, ['exec', vm, 'powershell.exe', '-NoProfile', '-NonInteractive', ...args], { timeout, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 })).stdout.trim()
  const short = source => {
    const value = Buffer.from(source, 'utf16le').toString('base64')
    assert.ok(value.length < 6000, 'PD inline command exceeds its bounded transport budget')
    return invoke(['-EncodedCommand', value])
  }
  if (encoded.length < 6000) return invoke(['-EncodedCommand', encoded])
  assert.ok(guestRoot && server.listening, 'Large commands require the already created disposable guest root and UUID transfer server')
  const name = `command-${randomUUID()}.ps1`, destination = win32.join(guestRoot, name)
  // Windows PowerShell 5 treats a UTF-8 file without BOM as legacy ANSI.
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(code, 'utf8')])
  const sha = createHash('sha256').update(bytes).digest('hex')
  const url = `http://${host}:${server.address().port}/${key}/${name}`
  files.set(name, bytes)
  let answer, failure
  try {
    await short(`$ErrorActionPreference='Stop';$c=[Net.WebClient]::new();$c.Proxy=$null;try{$c.DownloadFile(${quote(url)},${quote(destination)})}finally{$c.Dispose()};if((Get-FileHash -LiteralPath ${quote(destination)} -Algorithm SHA256).Hash.ToLowerInvariant()-ne '${sha}'){throw 'Transferred command SHA mismatch'}`)
    answer = await invoke(['-ExecutionPolicy', 'Bypass', '-File', destination])
  } catch (error) { failure = error }
  finally {
    files.delete(name)
    try { await short(`$ErrorActionPreference='Stop';if(Test-Path -LiteralPath ${quote(destination)}){Remove-Item -LiteralPath ${quote(destination)} -Force -ErrorAction Stop}`) }
    catch (error) { if (failure) failure.commandFileCleanupError = error.message; else failure = error }
  }
  if (failure) throw failure
  return answer
}
const key = randomUUID(), frozenRuntime = arg('--runtime-bundle')
const helperPath = resolve(process.env.QIUYA_WINDOWS_HELPER || join(root, `lib/native/win32-${arch}/qiuya-windows.exe`))
const compiled = frozenRuntime ? null : await build({ stdin: { contents: "export {installComputerHost} from './src/features/computer-use/host.ts'; export {NativeCompanionDriver} from './src/features/computer-use/native.ts'", resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'esm' })
const files = new Map([
  ['runtime.mjs', frozenRuntime ? await readFile(resolve(frozenRuntime)) : Buffer.from(compiled.outputFiles[0].text)],
  ['soak-computer-webview2.mjs', await readFile(join(root, 'scripts/soak-computer-webview2.mjs'))],
  ['computer-webview2-soak-evidence.mjs', await readFile(join(root, 'scripts/computer-webview2-soak-evidence.mjs'))],
  ['computer-soak-evidence.mjs', await readFile(join(root, 'scripts/computer-soak-evidence.mjs'))],
  ['windows-webview2-soak-fixture.ps1', await readFile(join(root, 'tests/fixtures/windows-webview2-soak-fixture.ps1'))],
  ['qiuya-windows.exe', await readFile(helperPath)],
])
const helperSha256 = createHash('sha256').update(files.get('qiuya-windows.exe')).digest('hex')
const expectedHelperSha = arg('--native-sha256')
if (expectedHelperSha) { assert.match(expectedHelperSha, /^[a-f0-9]{64}$/iu); assert.equal(helperSha256, expectedHelperSha.toLowerCase()) }
const server = createServer((request, response) => {
  const match = new RegExp(`^/${key}/([a-z0-9.-]+)$`, 'u').exec(request.url || '')
  const bytes = request.method === 'GET' && match && files.get(match[1])
  if (!bytes) return response.writeHead(404).end()
  response.writeHead(200, { 'Content-Length': bytes.length }); response.end(bytes)
})
let guestRoot, node, task, completed, environment, outerVerdict
try {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, host, done) })
  const identity = JSON.parse(await ps(`$ErrorActionPreference='Stop';$u=(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -First 1).UserName;if(!$u){throw 'No logged-in interactive desktop'};$s=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value;$p=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$s)).ProfileImagePath;@{user=$u;profile=$p}|ConvertTo-Json -Compress`))
  const prepared = win32.normalize(preparedRoot), prefix = win32.join(identity.profile, 'AppData/Local/Temp/QiuYaTools-harness-')
  assert.ok(prepared.startsWith(prefix) && /^[a-f0-9-]{36}$/iu.test(prepared.slice(prefix.length)), 'Reuse only the explicitly prepared disposable test runtime')
  node = win32.join(prepared, `node-v22.23.3-win-${arch}/node.exe`)
  const runtimeInput = JSON.parse(await ps(`$ErrorActionPreference='Stop';if(!(Test-Path ${quote(node)})){throw 'Prepared Node is missing'};[IO.File]::ReadAllText(${quote(win32.join(prepared, 'runtime-input.json'))})`))
  for (const value of Object.values(runtimeInput)) assert.match(value, /^[a-f0-9]{64}$/iu)
  const actualNode = JSON.parse(await ps(`$ErrorActionPreference='Stop';& ${quote(node)} -p 'JSON.stringify({platform:process.platform,architecture:process.arch,version:process.versions.node})';if($LASTEXITCODE-ne 0){throw 'Prepared Node failed'} `))
  assert.equal(actualNode.platform, 'win32'); assert.equal(actualNode.architecture, arch)
  guestRoot = win32.join(identity.profile, 'AppData/Local/Temp', `QiuYaTools-webview2-soak-${key}`)
  await ps(`$ErrorActionPreference='Stop';New-Item -ItemType Directory ${quote(guestRoot)}|Out-Null`)
  async function transfer(name) {
    const hash = createHash('sha256').update(files.get(name)).digest('hex')
    const url = `http://${host}:${server.address().port}/${key}/${name}`
    await ps(`$ErrorActionPreference='Stop';$c=[Net.WebClient]::new();$c.Proxy=$null;try{$c.DownloadFile(${quote(url)},${quote(win32.join(guestRoot, name))})}finally{$c.Dispose()};if((Get-FileHash ${quote(win32.join(guestRoot, name))} -Algorithm SHA256).Hash.ToLowerInvariant()-ne ${quote(hash)}){throw 'Transferred test input SHA mismatch'}`, 120000)
  }
  for (const name of files.keys()) await transfer(name)
  files.set('launch.mjs', Buffer.from(`import{writeFile}from'node:fs/promises';import{dirname,join}from'node:path';import{fileURLToPath,pathToFileURL}from'node:url';const base=dirname(fileURLToPath(import.meta.url));try{process.argv=[process.execPath,join(base,'soak-computer-webview2.mjs'),'--runtime',join(base,'runtime.mjs'),'--native',join(base,'qiuya-windows.exe'),'--fixture',join(base,'windows-webview2-soak-fixture.ps1'),'--minutes',${JSON.stringify(String(minutes))},'--faults',${JSON.stringify(String(faults))},'--output',join(base,'evidence')];await import(pathToFileURL(process.argv[1]).href)}catch(error){await writeFile(join(base,'startup-error.json'),JSON.stringify({error:error.message,code:error.code}));process.exitCode=1}finally{await writeFile(join(base,'completed.json'),JSON.stringify({exitCode:process.exitCode||0}))}`))
  await transfer('launch.mjs')
  files.set('start.ps1', Buffer.from(`$ErrorActionPreference='Stop';$p=Start-Process -FilePath ${quote(node)} -ArgumentList ${quote(`"${win32.join(guestRoot, 'launch.mjs')}"`)} -WorkingDirectory ${quote(guestRoot)} -WindowStyle Hidden -RedirectStandardOutput ${quote(win32.join(guestRoot, 'runner.log'))} -RedirectStandardError ${quote(win32.join(guestRoot, 'runner.err'))} -PassThru;@{pid=$p.Id;createdAtTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress|Set-Content -LiteralPath ${quote(win32.join(guestRoot, 'runner-identity.json'))} -Encoding UTF8;$p.WaitForExit()`))
  await transfer('start.ps1')
  task = `QiuYaTools-webview2-soak-${key}`
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${win32.join(guestRoot, 'start.ps1')}"`
  await ps(`$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(args)};$p=New-ScheduledTaskPrincipal -UserId ${quote(identity.user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes ${Math.ceil(minutes) + 8}) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(task)}`)
  environment = { kind: 'real-native-WebView2-720p-endurance', vm, host, guestRoot, task, runtimeRoot: prepared, runtimeInput, node: actualNode, renderer: 'actual production WinForms WebView2 observed by test-only loopback CDP; no Edge launch', sourcePixels: { width: 1280, height: 720 }, minutes, faults, helperPath, helperSha256, runtimeBundle: frozenRuntime ? resolve(frozenRuntime) : 'bundled-from-current-production-source', inputHashes: Object.fromEntries([...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])), dependencies: 'Windows runner uses Node built-ins only; esbuild runs on the Mac orchestrator', powershellTransport: 'Inline EncodedCommand below 6000 characters; larger commands use this run UUID HTTP files with SHA-verified UTF-8 BOM PS1 and short -File, removed after return', startedAt: new Date().toISOString() }
  await writeFile(join(output, 'environment.json'), JSON.stringify(environment, null, 2))
  console.error(JSON.stringify({ stage: 'interactive-native-WebView2-started', minutes, faults, guestRoot, output }))
  const deadline = Date.now() + minutes * 60000 + 360000
  let lastProgress
  while (Date.now() < deadline) {
    const state = await ps(`$c=${quote(win32.join(guestRoot, 'completed.json'))};$p=${quote(win32.join(guestRoot, 'evidence/progress.json'))};if(Test-Path $c){@{completed=[IO.File]::ReadAllText($c)}|ConvertTo-Json -Compress}elseif(Test-Path $p){$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{$r=[IO.StreamReader]::new($f);@{progress=$r.ReadToEnd()}|ConvertTo-Json -Compress}finally{$f.Dispose()}}`)
    if (state) {
      const value = JSON.parse(state)
      if (value.completed) { completed = JSON.parse(value.completed); break }
      if (value.progress && value.progress !== lastProgress) { try { const p = JSON.parse(value.progress); await writeFile(join(output, 'progress.json'), JSON.stringify(p, null, 2)); console.error(JSON.stringify({ elapsedMs: p.elapsedMs, frames: p.stats.frames, invalid: p.stats.invalidTimestamps })); lastProgress = value.progress } catch {} }
    }
    await new Promise(done => setTimeout(done, 10000))
  }
  if (!completed) throw new Error('Native WebView2 runner exceeded its bounded deadline')
  for (const directory of [guestRoot, win32.join(guestRoot, 'evidence')]) {
    const names = JSON.parse(await ps(`ConvertTo-Json -InputObject @(Get-ChildItem ${quote(directory)} -File -ErrorAction SilentlyContinue|Where-Object Name -match '\\.(json|log|err|jpg|png)$'|Select-Object -ExpandProperty Name) -Compress`))
    for (const name of names) {
      assert.match(name, /^[a-zA-Z0-9_.-]+$/u)
      const encoded = await ps(`$f=[IO.File]::Open(${quote(win32.join(directory, name))},[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite-bor[IO.FileShare]::Delete));try{if($f.Length-gt 20MB){throw 'Evidence file limit exceeded'};$m=[IO.MemoryStream]::new();$f.CopyTo($m);[Convert]::ToBase64String($m.ToArray());$m.Dispose()}finally{$f.Dispose()}`)
      if (encoded) await writeFile(join(output, name), Buffer.from(encoded, 'base64'))
    }
  }
  // completed.json is written just before Node's event loop exits. Give that
  // natural exit a bounded wait, without hiding survivors with taskkill first.
  await new Promise(done => setTimeout(done, 2000))
  const after = JSON.parse(await ps(`$ErrorActionPreference='Stop';$file=${quote(win32.join(guestRoot, 'evidence/cleanup-verification.json'))};$r=Get-Content -LiteralPath ${quote(win32.join(guestRoot, 'runner-identity.json'))} -Raw|ConvertFrom-Json;$items=@($r);if(Test-Path $file){$items+=@((Get-Content -LiteralPath $file -Raw|ConvertFrom-Json).tracked)};$live=@();foreach($i in $items){$p=Get-Process -Id $i.pid -ErrorAction SilentlyContinue;if($p -and $p.StartTime.ToUniversalTime().Ticks.ToString()-eq $i.createdAtTicks){$live+=@{pid=[int]$i.pid;createdAtTicks=$i.createdAtTicks}}};@{passed=($live.Count-eq 0);checked=$items.Count;remaining=$live}|ConvertTo-Json -Depth 5 -Compress`))
  await writeFile(join(output, 'post-run-cleanup-verification.json'), JSON.stringify(after, null, 2))
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  outerVerdict = { status: report.status === 'passed' && completed.exitCode === 0 && after.passed ? 'passed' : 'failed', runnerStatus: report.status, exitCode: completed.exitCode, naturalCleanupPassed: after.passed, helperSha256, runtimeSha256: environment.inputHashes['runtime.mjs'] }
  await writeFile(join(output, 'delivery-verdict.json'), JSON.stringify(outerVerdict, null, 2))
  console.log(JSON.stringify({ ...outerVerdict, output, frames: report.frames, elapsedMs: report.elapsedMs, endToEndFps: report.endToEndFps, latencyP95Ms: report.latencyP95Ms, invalid: report.invalidTimestamps, faults: report.faults?.length }, null, 2))
  if (outerVerdict.status !== 'passed') process.exitCode = 1
} catch (error) {
  await writeFile(join(output, 'orchestration-error.json'), JSON.stringify({ status: 'failed', error: error.message, guestRoot, completed }, null, 2)); console.error(error.message); process.exitCode = 1
} finally {
  const cleanup = { naturallyClean: false, forcedRequired: false, errors: [], remaining: [], before: null, forced: null, after: null }
  if (guestRoot) {
    try {
      // This checkpoint is atomic and starts before any GUI child is spawned.
      // It is available even when a killed Node process cannot execute finally.
      const raw = JSON.parse(await ps(`$ErrorActionPreference='Stop';function Read-OwnedFile($path){if(!(Test-Path -LiteralPath $path)){return $null};$f=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite-bor[IO.FileShare]::Delete));try{if($f.Length-gt 8MB){throw 'Owned checkpoint limit'};$r=[IO.StreamReader]::new($f);$r.ReadToEnd()}finally{$f.Dispose()}};@{runner=(Read-OwnedFile ${quote(win32.join(guestRoot, 'runner-identity.json'))});checkpoint=(Read-OwnedFile ${quote(win32.join(guestRoot, 'evidence/ownership-checkpoint.json'))});cleanup=(Read-OwnedFile ${quote(win32.join(guestRoot, 'evidence/cleanup-verification.json'))})}|ConvertTo-Json -Compress`))
      if (raw.runner) {
        const runner = { ...JSON.parse(raw.runner), expectedExecutablePath: node }, checkpoint = raw.checkpoint ? JSON.parse(raw.checkpoint) : null
        const previous = raw.cleanup ? JSON.parse(raw.cleanup).tracked ?? [] : []
        const companion = win32.join(guestRoot, 'qiuya-windows.exe'), fixture = win32.join(guestRoot, 'windows-webview2-soak-fixture.ps1')
        let marker = `not-a-webview-profile-${key}`, recorded = previous
        if (checkpoint) {
          assert.equal(checkpoint.schemaVersion, 1)
          assert.equal(checkpoint.runner.pid, runner.pid); assert.equal(checkpoint.runner.createdAtTicks, runner.createdAtTicks)
          assert.equal(win32.normalize(checkpoint.companion).toLowerCase(), companion.toLowerCase())
          assert.equal(win32.normalize(checkpoint.fixturePath).toLowerCase(), fixture.toLowerCase())
          const tempPrefix = win32.join(win32.dirname(guestRoot), 'qiuya-webview2-soak-')
          const temporary = win32.normalize(checkpoint.temporaryRoot)
          assert.ok(temporary.toLowerCase().startsWith(tempPrefix.toLowerCase()) && /^[a-f0-9-]{36}-[a-z0-9]{6}$/iu.test(temporary.slice(tempPrefix.length)), 'Only this UUID native profile may be discovered')
          assert.equal(win32.normalize(checkpoint.nativeData), win32.join(temporary, 'native-webview2'))
          marker = checkpoint.nativeData; recorded = [...recorded, ...checkpoint.tracked]
        }
        const rows = JSON.parse(await ps(windowsProcessSnapshotCommand(marker, { fixturePath: fixture })))
        const owned = windowsEmergencyCleanupIdentities(rows, { runner, helperPath: companion }, recorded)
        cleanup.before = JSON.parse(await ps(windowsPinnedProcessCommand(owned)))
        if (!cleanup.before.passed) throw new Error('Pinned natural cleanup verification failed')
        const live = new Set(cleanup.before.results.filter(item => item.state === 'alive').map(item => item.pid))
        cleanup.remaining = owned.filter(item => live.has(item.pid)); cleanup.naturallyClean = cleanup.remaining.length === 0
        if (cleanup.remaining.length) {
          cleanup.forcedRequired = true
          cleanup.forced = JSON.parse(await ps(windowsPinnedProcessCommand(cleanup.remaining, { terminate: true })))
          if (!cleanup.forced.passed) cleanup.errors.push('Pinned emergency retirement failed')
          cleanup.after = JSON.parse(await ps(windowsPinnedProcessCommand(cleanup.remaining)))
          if (!cleanup.after.passed) cleanup.errors.push('Pinned post-retirement verification failed')
          const remaining = new Set(cleanup.after.results.filter(item => item.state === 'alive').map(item => item.pid))
          cleanup.remaining = cleanup.remaining.filter(item => remaining.has(item.pid))
        }
      } else {
        // No recorded runner means the launcher never established a process
        // identity. Do not infer an identity from a PID or command-line substring.
        cleanup.errors.push('Runner exact identity checkpoint was unavailable')
      }
    } catch (error) { cleanup.errors.push(error.message) }
  } else cleanup.naturallyClean = true
  if (task) {
    try { await ps(`$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName ${quote(task)} -ErrorAction SilentlyContinue;if($t){if($t.State -eq 'Running'){Stop-ScheduledTask -TaskName ${quote(task)} -ErrorAction Stop};Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false -ErrorAction Stop}`) }
    catch (error) { cleanup.errors.push(error.message) }
  }
  cleanup.passed = cleanup.errors.length === 0 && cleanup.remaining.length === 0
  await writeFile(join(output, 'outer-cleanup-verdict.json'), JSON.stringify(cleanup, null, 2))
  if (!cleanup.passed || !cleanup.naturallyClean) {
    process.exitCode = 1
    await writeFile(join(output, 'delivery-verdict.json'), JSON.stringify({ ...(outerVerdict ?? {}), status: 'failed', emergencyCleanupRequired: cleanup.forcedRequired, emergencyCleanupPassed: cleanup.passed, naturalCleanupPassed: cleanup.naturallyClean }, null, 2))
  }
  server.closeAllConnections(); if (server.listening) await new Promise(done => server.close(done))
}
