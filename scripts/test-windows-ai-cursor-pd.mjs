/** Isolated Session-1 native cursor evidence. Never brings the Mac VM UI forward. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PNG } = require(join(dirname(require.resolve('playwright-core')), 'lib/utilsBundle.js'))
const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url))
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const helperPath = resolve(arg('--helper') || ''), output = resolve(arg('--output') || '')
if (!arg('--helper') || !arg('--output')) throw new Error('Pass an exact --helper candidate and a new --output directory')
const vm = process.env.QIUYA_PD_VM, host = process.env.QIUYA_PD_HOST_IP
if (!/^[a-f0-9-]{36}$/iu.test(vm || '') || !/^\d+\.\d+\.\d+\.\d+$/u.test(host || '')) throw new Error('Set the explicitly selected QIUYA_PD_VM and QIUYA_PD_HOST_IP')
const prlctl = '/Applications/Parallels Desktop.app/Contents/MacOS/prlctl'
const helper = await readFile(helperPath), sha = value => createHash('sha256').update(value).digest('hex')
const helperSHA256 = sha(helper), machine = helper.readUInt16LE(helper.readUInt32LE(0x3c) + 4)
assert.ok([0xaa64, 0x8664].includes(machine)); const architecture = machine === 0xaa64 ? 'arm64' : 'x64'
await assert.rejects(() => access(output), error => error.code === 'ENOENT', 'Use a new evidence directory; never overwrite failed runs')
await mkdir(output, { recursive: true })
const key = randomUUID(), files = new Map(), quote = value => "'" + value.replaceAll("'", "''") + "'"
for (const [name, path] of [['fixture.cs', 'tests/fixtures/windows-ai-cursor-fixture.cs'], ['test.ps1', 'tests/fixtures/windows-ai-cursor-e2e.ps1']]) files.set(name, await readFile(join(root, path)))
files.set('helper.exe', helper)
const server = createServer((request, response) => {
  const name = request.url?.startsWith('/' + key + '/') ? request.url.slice(key.length + 2) : null
  const bytes = request.method === 'GET' && name && files.get(name)
  if (!bytes) return response.writeHead(404).end()
  response.writeHead(200, { 'content-length': bytes.length, 'content-type': 'application/octet-stream' }); response.end(bytes)
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, host, done) })
const endpoint = `http://${host}:${server.address().port}/${key}`
async function ps(code, timeout = 30000) {
  const encoded = Buffer.from(code, 'utf16le').toString('base64')
  assert.ok(encoded.length < 2000, `PD bootstrap exceeds tested limit: ${encoded.length}`)
  const result = await run(prlctl, ['exec', vm, 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 })
  return result.stdout.trim()
}
let guestRoot, taskName, report, captureVerdict, runError
async function transfer(name, destination) {
  await ps(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$p=${quote(destination)};$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(`${endpoint}/${name}`)},$p);if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -ne  ${quote(sha(files.get(name)))}){throw 'Owned transfer hash mismatch'}`, 90000)
}
async function ownFile(name) {
  const data = await ps(`$p=${quote(guestRoot + '\\evidence\\' + name)};if(Test-Path -LiteralPath $p){[Convert]::ToBase64String([IO.File]::ReadAllBytes($p))}`)
  return data ? Buffer.from(data, 'base64') : null
}
async function actualRaster(checkpoint) {
  const temporary = join(output, 'private-vm-full-frame.png')
  try {
    await run(prlctl, ['capture', vm, '--file', temporary], { timeout: 15000, killSignal: 'SIGKILL' })
    const image = PNG.sync.read(await readFile(temporary)), screen = checkpoint.screen, crop = checkpoint.crop
    assert.equal(image.width, screen.width, 'VM screenshot and independent physical desktop widths differ; do not silently rescale')
    assert.equal(image.height, screen.height, 'VM screenshot and independent physical desktop heights differ; do not silently rescale')
    const x = crop.x - screen.x, y = crop.y - screen.y
    assert.ok(x >= 0 && y >= 0 && x + crop.width <= image.width && y + crop.height <= image.height)
    assert.ok(crop.x >= checkpoint.target.x && crop.y >= checkpoint.target.y && crop.x + crop.width <= checkpoint.target.x + checkpoint.target.width && crop.y + crop.height <= checkpoint.target.y + checkpoint.target.height)
    const clipped = new PNG({ width: crop.width, height: crop.height })
    PNG.bitblt(image, clipped, x, y, crop.width, crop.height, 0, 0)
    await writeFile(join(output, 'vm-arrow-own-crop.png'), PNG.sync.write(clipped))
    let white = 0, gray = 0, background = 0, changed = 0
    for (let offset = 0; offset < clipped.data.length; offset += 4) {
      const [r, g, b] = clipped.data.subarray(offset, offset + 3)
      if (r > 230 && g > 230 && b > 230) white++
      if (Math.abs(r - g) < 24 && Math.abs(g - b) < 24 && r > 40 && r < 210) gray++
      if (r === 37 && g === 113 && b === 151) background++; else changed++
    }
    const pointX = checkpoint.opaquePoint.x - crop.x, pointY = checkpoint.opaquePoint.y - crop.y
    const offset = (pointY * crop.width + pointX) * 4, opaquePixel = [...clipped.data.subarray(offset, offset + 3)]
    const opaquePointIsArrow = opaquePixel[0] > 40 && opaquePixel[0] < 220 && Math.abs(opaquePixel[0] - opaquePixel[1]) < 24 && Math.abs(opaquePixel[1] - opaquePixel[2]) < 24
    const verdict = { passed: white > 15 && gray > 50 && background > 100 && changed > 100 && opaquePointIsArrow,
      white, gray, background, changed, opaquePointIsArrow, opaquePixel, resolution: { width: image.width, height: image.height }, screen, crop,
      mapping: 'identity physical pixels; virtual desktop origin subtracted, no resize or color normalization', entireFrameRetained: false,
      realCursor: checkpoint.real, aiCursor: checkpoint.ai }
    await writeFile(join(output, 'vm-raster-verdict.json'), JSON.stringify(verdict, null, 2) + '\n')
    return verdict
  } finally { await rm(temporary, { force: true }) }
}
async function baseline() {
  const directory = join(output, 'baseline-52'); await mkdir(directory)
  const original = await readFile(join(root, 'src/native/windows/native-e2e.ps1'), 'utf8')
  const old = `[IO.File]::WriteAllText((Join-Path $Output 'physical-checkpoint.json'),'{"phase":"awaiting-physical-escape"}')`
  assert.equal(original.split(old).length, 2)
  const guarded = original.replace(old, `$state=[QytAiOracle]::DesktopState();$latest=@($events|Where-Object {$_.event -eq  'inputHeld'}|Select-Object -Last 1)[0];$journal=[QytAiOracle]::LeaseState();$expectedWindow=[Convert]::ToInt64(($target.id -split  ':')[1],16)
  if($state.foreground -ne  $expectedWindow -or  @($state.heldKeys).Count -ne  0 -or  !$latest.ownerId -or  $journal.lockFree -or  $journal.journal.OwnerId -ne  $latest.ownerId){throw 'The physical checkpoint is not the exact idle own input owner'}
  [IO.File]::WriteAllText((Join-Path $Output 'physical-checkpoint.json'),(@{phase='awaiting-physical-escape';at=[DateTime]::UtcNow.ToString('o');fixture=[QytAiOracle]::Identity($fixture.Id);computer=[QytAiOracle]::Identity($computer.Id);foreground=$state.foreground;expectedWindow=$expectedWindow;owner=$latest.ownerId;journalOwner=$journal.journal.OwnerId;held=$state.heldKeys}|ConvertTo-Json -Depth 7 -Compress))`)
  const preflight = `Add-Type -AssemblyName System.Drawing,System.Windows.Forms,System.Web.Extensions
Add-Type -Path (Join-Path (Split-Path $Helper) 'fixture.cs') -ReferencedAssemblies System,System.Core,System.Drawing,System.Windows.Forms,System.Web.Extensions
[void][QytAiOracle]::SetThreadDpiAwarenessContext([IntPtr](-4))
$pre=[QytAiOracle]::DesktopState();$lease=[QytAiOracle]::LeaseState();if(!$pre.activeDesktopAccessible -or  $pre.activeDesktop -ne  $pre.threadDesktop -or  @($pre.heldKeys).Count -ne  0 -or  !$lease.lockFree -or  ($lease.journal -and  ($lease.journal.KeyCount -ne  0 -or  $lease.journal.MouseCount -ne  0 -or  $lease.journal.UnicodeCount -ne  0))){throw 'Desktop is not idle and exclusively available for this baseline'}
`
  const fixture = guarded.replace("$ErrorActionPreference = 'Stop'", "$ErrorActionPreference = 'Stop'\n" + preflight)
  await writeFile(join(directory, 'native-e2e-frozen.ps1'), fixture)
  let launcher = await readFile(join(root, 'scripts/test-windows-native-pd.mjs'), 'utf8')
  launcher = launcher.replace(/^const fixture = await readFile\(new URL\(.+$/mu, `const fixture = await readFile(${JSON.stringify(join(directory, 'native-e2e-frozen.ps1'))})`)
  launcher = launcher.replace("const files = new Map([['helper.exe', helper], ['native-e2e.ps1', fixture]])", `const files = new Map([['helper.exe', helper], ['native-e2e.ps1', fixture], ['fixture.cs', await readFile(${JSON.stringify(join(root, 'tests/fixtures/windows-ai-cursor-fixture.cs'))})]])`)
  const marker = "console.error('[qiuya-phase] transfer integrity checked')"
  launcher = launcher.replace(marker, `await powershell(\`$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile('http://\${host}:\${port}/\${key}/fixture.cs','\${guestRoot}\\\\fixture.cs')\`);\n${marker}`)
  launcher = launcher.replace("physicalSent = true", `const proof=JSON.parse(await powershell(\`$ErrorActionPreference='Stop';$r=Get-Content -LiteralPath '\${guestRoot}\\\\evidence\\\\physical-checkpoint.json' -Raw|ConvertFrom-Json;foreach($i in @($r.fixture,$r.computer)){$p=[Diagnostics.Process]::GetProcessById([int]$i.pid);try{$null=$p.SafeHandle;if($p.StartTime.ToUniversalTime().Ticks.ToString() -ne  $i.createdAtTicks -or  $p.MainModule.FileName -ine  $i.expectedExecutablePath -or  $p.SessionId -le  0){throw 'Pinned HID owner changed'}}finally{$p.Dispose()}};$r|ConvertTo-Json -Depth 7 -Compress\`));
        const expected=(guestRoot+'\\\\qiuya-windows.exe').replaceAll('\\\\','/').toLowerCase();
        if(proof.phase!=='awaiting-physical-escape'||proof.foreground!==proof.expectedWindow||proof.owner!==proof.journalOwner||proof.held.length||[proof.computer,proof.fixture].some(item=>item.expectedExecutablePath.replaceAll('\\\\','/').toLowerCase()!==expected)||Date.now()-Date.parse(proof.at)>10000)throw new Error('Pinned own HID checkpoint rejected');
        await writeFile(join(output,'physical-owner-guard.json'),JSON.stringify(proof,null,2));
        physicalSent = true`)
  launcher = launcher.replace('helperSha256, guestRoot,', 'helperSha256, fixtureSha256, guestRoot,')
  await writeFile(join(directory, 'baseline-runner-frozen.mjs'), launcher)
  await run(process.execPath, [join(directory, 'baseline-runner-frozen.mjs')], { cwd: root, timeout: 240000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, QIUYA_WINDOWS_HELPER: helperPath, QIUYA_WINDOWS_TEST_OUTPUT: directory } }).then(value => writeFile(join(directory, 'runner.log'), value.stdout + '\n' + value.stderr), async error => { await writeFile(join(directory, 'runner.log'), String(error.stdout) + '\n' + String(error.stderr)); throw error })
  const result = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8').then(value => value.replace(/^\uFEFF/u, '')))
  assert.equal(result.passed, true); assert.equal(result.checks.length, 52)
  return { passed: true, checks: result.checks.length, originalSourceSHA256: sha(original), frozenSourceSHA256: sha(fixture), launcherSHA256: sha(launcher) }
}
try {
  const user = JSON.parse(await ps(`$ErrorActionPreference='Stop';$u=(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt  0|Select-Object -First 1).UserName;$s=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value;$p=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$s)).ProfileImagePath;@{user=$u;profile=$p}|ConvertTo-Json -Compress`))
  assert.ok(user.user && user.profile)
  guestRoot = user.profile + '\\AppData\\Local\\Temp\\QiuYaTools-ai-cursor-' + key
  await ps(`New-Item -ItemType Directory -Force ${quote(guestRoot)}|Out-Null`)
  await transfer('fixture.cs', guestRoot + '\\fixture.cs'); await transfer('test.ps1', guestRoot + '\\test.ps1')
  const review = await ps(`$ErrorActionPreference='Stop';$e=$null;$t=$null;$null=[Management.Automation.Language.Parser]::ParseFile(${quote(guestRoot + '\\test.ps1')},[ref]$t,[ref]$e);if($e.Count){throw ($e|Out-String)};Add-Type -Path ${quote(guestRoot + '\\fixture.cs')} -ReferencedAssemblies System,System.Core,System.Drawing,System.Windows.Forms,System.Web.Extensions;'Parser and CSharp compile PASS'`)
  await writeFile(join(output, 'script-review.json'), JSON.stringify({ review, helperSHA256, architecture, fixtureSHA256: sha(files.get('fixture.cs')), testSHA256: sha(files.get('test.ps1')), wrapperSHA256: sha(await readFile(fileURLToPath(import.meta.url))), guestRoot }, null, 2))
  if (process.argv.includes('--review-only')) { console.log(review); process.exitCode = 0 }
  else {
    let baselineResult
    if (process.argv.includes('--baseline')) baselineResult = await baseline()
    await transfer('helper.exe', guestRoot + '\\qiuya-windows.exe')
    taskName = 'QiuYaTools-ai-cursor-' + key
    const argumentsText = `-NoProfile -STA -NonInteractive -ExecutionPolicy Bypass -File "${guestRoot}\\test.ps1" -Helper "${guestRoot}\\qiuya-windows.exe" -Output "${guestRoot}\\evidence" -FixtureSource "${guestRoot}\\fixture.cs"`
    files.set('launch.ps1', Buffer.from(`$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(argumentsText)};$p=New-ScheduledTaskPrincipal -UserId ${quote(user.user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 4);Register-ScheduledTask -TaskName ${quote(taskName)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(taskName)}`))
    await transfer('launch.ps1', guestRoot + '\\launch.ps1')
    await ps(`& ${quote(guestRoot + '\\launch.ps1')}`)
    for (let count = 0; count < 150; count++) {
      const raw = await ownFile('report.json')
      if (raw) { report = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/u, '')); await writeFile(join(output, 'report.json'), raw); break }
      const checkpoint = !captureVerdict && await ownFile('raster-checkpoint.json')
      if (checkpoint) {
        const value = JSON.parse(checkpoint.toString('utf8').replace(/^\uFEFF/u, '')); await writeFile(join(output, 'raster-checkpoint.json'), checkpoint)
        captureVerdict = await actualRaster(value)
        files.set('raster-go.json', Buffer.from(JSON.stringify(captureVerdict)))
        await transfer('raster-go.json', guestRoot + '\\evidence\\raster-go.json')
      }
      await new Promise(done => setTimeout(done, 250))
    }
    assert.ok(report, 'Interactive test did not produce a bounded report')
    for (const name of ['shown-native.json', 'fallback-known-pixels.json', 'screen-fallback.png', 'native-observe.jpg', 'native-known-region.png', 'events.json', 'before-desktop.json', 'after-desktop.json', 'failure-windows.json', 'fixture-state.json']) { const bytes = await ownFile(name); if (bytes) await writeFile(join(output, name), bytes) }
    const task = JSON.parse(await ps(`$t=Get-ScheduledTask -TaskName ${quote(taskName)};$i=Get-ScheduledTaskInfo -TaskName ${quote(taskName)};@{state=$t.State.ToString();exitCode=[long]$i.LastTaskResult}|ConvertTo-Json -Compress`))
    await writeFile(join(output, 'environment.json'), JSON.stringify({ vm, host, guestRoot, helperPath, helperSHA256, architecture, baseline: baselineResult, task, raster: captureVerdict, reportPassed: report.passed }, null, 2))
    assert.equal(report.passed, true); assert.equal(task.state, 'Ready'); assert.equal(task.exitCode, 0)
    console.log(JSON.stringify({ passed: true, architecture, baseline: baselineResult?.checks, checks: report.checks.length, output }, null, 2))
  }
} catch (error) { runError = { message: error.message, stdout: error.stdout, stderr: error.stderr }; await writeFile(join(output, 'wrapper-failure.json'), JSON.stringify({ ...runError, guestRoot, helperSHA256, architecture, report }, null, 2)); process.exitCode = 1 }
finally {
  if (taskName) {
    const task = JSON.parse(await ps(`$t=Get-ScheduledTask -TaskName ${quote(taskName)};@{state=$t.State.ToString()}|ConvertTo-Json -Compress`).catch(() => '{"state":"unknown"}'))
    if (task.state === 'Ready') await ps(`Unregister-ScheduledTask -TaskName ${quote(taskName)} -Confirm:$false`)
    else { await writeFile(join(output, 'task -not -naturally-retired.json'), JSON.stringify(task)); process.exitCode = 1 }
  }
  server.closeAllConnections(); await new Promise(done => server.close(done))
}
