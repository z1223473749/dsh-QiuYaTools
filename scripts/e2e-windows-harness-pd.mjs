/** Public Harness CLI + installed Edge in a disposable interactive Windows profile. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, win32, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitizeHarnessDiagnostic } from '../tests/fixtures/harness-workspace-prerequisite.mjs'
import { windowsHarnessScreenshotPlan, verifyCollectedHarnessImages } from './harness-settings-acceptance.mjs'
import { loadWindowsTestRuntime } from './prepare-windows-test-runtime.mjs'
const run = promisify(execFile)
const vm = process.env.QIUYA_PD_VM, host = process.env.QIUYA_PD_HOST_IP
if (!vm || !/^[a-f0-9-]{36}$/iu.test(vm) || !host || !/^\d+\.\d+\.\d+\.\d+$/u.test(host)) throw new Error('Set QIUYA_PD_VM and QIUYA_PD_HOST_IP for the authorized disposable VM')
const prlctl = process.env.QIUYA_PRLCTL || '/Applications/Parallels Desktop.app/Contents/MacOS/prlctl'
const architecture = process.env.QIUYA_WINDOWS_ARCH || 'arm64'
if (!['arm64', 'x64'].includes(architecture)) throw new Error('QIUYA_WINDOWS_ARCH must be arm64 or x64')
const windowStateDiagnostic = process.env.QIUYA_WINDOWS_PREVIEW_WINDOW_DIAGNOSTIC === '1'
const output = resolve(process.env.QIUYA_WINDOWS_HARNESS_OUTPUT || join(tmpdir(), `qiuya-windows-harness-${randomUUID()}`))
await mkdir(output, { recursive: true })
const requestedScreenshotsDirectory = process.env.QIUYA_WINDOWS_SCREENSHOTS_DIR
const key = randomUUID(), candidate = resolve(process.env.QIUYA_WINDOWS_CANDIDATE || `artifacts/candidates/dsh-qiuya-tools-win32-${architecture}.tgz`)
const runtime = await loadWindowsTestRuntime({ architecture, portablePath: process.env.QIUYA_WINDOWS_PORTABLE_TGZ, nodeZipPath: process.env.QIUYA_WINDOWS_NODE_ZIP, manifestPath: process.env.QIUYA_WINDOWS_RUNTIME_MANIFEST })
// The read-only observer must use the exact packaged binary, even while another
// agent builds diagnostic helpers into lib/native on the shared host checkout.
const observerHelper = (await run('tar', ['-xOf', candidate, `package/lib/native/win32-${architecture}/qiuya-windows.exe`], { encoding: 'buffer', timeout: 60000, maxBuffer: 256 * 1024 * 1024 })).stdout
const files = new Map([
  ['portable.tgz', runtime.portable],
  ['node.zip', runtime.nodeZip],
  ['candidate.tgz', await readFile(candidate)], ['helper.exe', observerHelper],
  ['e2e-harness.mjs', await readFile('scripts/e2e-harness.mjs')],
  ['harness-settings-acceptance.mjs', await readFile('scripts/harness-settings-acceptance.mjs')],
  ['harness-e2e-provider.mjs', await readFile('tests/fixtures/harness-e2e-provider.mjs')],
  ['harness-workspace-prerequisite.mjs', await readFile('tests/fixtures/harness-workspace-prerequisite.mjs')],
  ['harness-preview-windows.ps1', await readFile('tests/fixtures/harness-preview-windows.ps1')],
  ['harness-owned-windows.ps1', await readFile('tests/fixtures/harness-owned-windows.ps1')],
  ['harness-activate-windows.ps1', await readFile('tests/fixtures/harness-activate-windows.ps1')],
  ['harness-window-state-windows.ps1', await readFile('tests/fixtures/harness-window-state-windows.ps1')],
  ['harness-window-timeline-windows.ps1', await readFile('tests/fixtures/harness-window-timeline-windows.ps1')],
  ['native.ts', await readFile('src/features/computer-use/native.ts')], ['contract.ts', await readFile('src/features/computer-use/contract.ts')],
])
const oldPackage = process.env.QIUYA_WINDOWS_PREVIOUS_PACKAGE
if (windowStateDiagnostic && oldPackage) throw new Error('Window-state diagnostics stop before acceptance and cannot run the installer lifecycle')
if (oldPackage) { files.set('previous.tgz', await readFile(resolve(oldPackage))); files.set('test-harness-install.mjs', await readFile('scripts/test-harness-install.mjs')) }
const quote = value => `'${value.replaceAll("'", "''")}'`
async function ps(code, timeout = 45000) {
  return (await run(prlctl, ['exec', vm, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { timeout, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 })).stdout.trim()
}
const server = createServer((request, response) => {
  const parts = request.url?.split('/'), file = request.method === 'GET' && parts?.[1] === key && files.get(parts[2])
  if (!file) return response.writeHead(404).end()
  response.writeHead(200, { 'Content-Length': file.length }); response.end(file)
})
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, host, done) })
const url = name => `http://${host}:${server.address().port}/${key}/${name}`
const download = (name, destination, timeout) => ps(`$ErrorActionPreference='Stop';$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(url(name))},${quote(destination)})`, timeout)
let guestRoot, task, screenshotPlan
try {
  const identity = JSON.parse(await ps(`$u=(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -First 1).UserName;$s=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value;$p=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$s)).ProfileImagePath;@{user=$u;profile=$p}|ConvertTo-Json -Compress`))
  const reuse = process.env.QIUYA_WINDOWS_HARNESS_ROOT
  guestRoot = reuse ? win32.normalize(reuse) : win32.join(identity.profile, 'AppData/Local/Temp', `QiuYaTools-harness-${key}`)
  assert.ok(guestRoot.startsWith(win32.join(identity.profile, 'AppData/Local/Temp/QiuYaTools-harness-')) && /^[a-f0-9-]{36}$/iu.test(guestRoot.slice(-36)), 'Reuse only this runner’s disposable guest directory')
  if (reuse) {
    const stamp = await ps(`if(Test-Path ${quote(win32.join(guestRoot, 'runtime-input.json'))}){[IO.File]::ReadAllText(${quote(win32.join(guestRoot, 'runtime-input.json'))})}`)
    assert.ok(stamp, 'This older guest directory has no runtime integrity stamp; omit QIUYA_WINDOWS_HARNESS_ROOT to prepare a fresh directory')
    assert.deepEqual(JSON.parse(stamp), { portableSHA256: runtime.portableSha256, nodeArchiveSHA256: runtime.nodeSha256 }, 'The reusable guest runtime differs from the supplied manifest; prepare a fresh directory')
  }
  screenshotPlan = windowsHarnessScreenshotPlan(output, requestedScreenshotsDirectory, guestRoot)
  await mkdir(screenshotPlan.hostDirectory, { recursive: true })
  task = `QiuYaTools-harness-${key}`
  await ps(`New-Item -ItemType Directory -Force ${quote(guestRoot)}|Out-Null;if(Test-Path ${quote(win32.join(guestRoot, 'completed.json'))}){Remove-Item ${quote(win32.join(guestRoot, 'completed.json'))}}`)
  for (const folder of ['evidence', 'install-evidence', ...(screenshotPlan.external ? ['screenshots'] : [])]) await ps(`if(Test-Path ${quote(win32.join(guestRoot, folder))}){Remove-Item -LiteralPath ${quote(win32.join(guestRoot, folder))} -Recurse -Force}`)
  await writeFile(join(output, 'orchestration-state.json'), JSON.stringify({ guestRoot, stage: 'preparing', candidate }, null, 2))
  for (const name of reuse ? ['candidate.tgz', 'helper.exe'] : ['portable.tgz', 'node.zip', 'candidate.tgz', 'helper.exe']) await download(name, win32.join(guestRoot, name), 120000)
  console.error('[qiuya-harness] official runtime and candidate transferred')
  if (!reuse) await ps(`$ErrorActionPreference='Stop';tar.exe -xzf ${quote(win32.join(guestRoot, 'portable.tgz'))} -C ${quote(guestRoot)};if($LASTEXITCODE -ne 0){throw 'Portable extraction failed'};Expand-Archive -Path ${quote(win32.join(guestRoot, 'node.zip'))} -DestinationPath ${quote(guestRoot)} -Force`, 180000)
  if (!reuse) {
    files.set('runtime-input.json', Buffer.from(JSON.stringify({ portableSHA256: runtime.portableSha256, nodeArchiveSHA256: runtime.nodeSha256 })))
    await download('runtime-input.json', win32.join(guestRoot, 'runtime-input.json'))
  }
  const portable = win32.join(guestRoot, runtime.folder), node = win32.join(guestRoot, runtime.node.file.replace(/\.zip$/u, ''), 'node.exe')
  for (const [name, destination] of [['e2e-harness.mjs', 'scripts/e2e-harness.mjs'], ['harness-settings-acceptance.mjs', 'scripts/harness-settings-acceptance.mjs'], ['harness-e2e-provider.mjs', 'tests/fixtures/harness-e2e-provider.mjs'], ['harness-workspace-prerequisite.mjs', 'tests/fixtures/harness-workspace-prerequisite.mjs'], ['harness-preview-windows.ps1', 'tests/fixtures/harness-preview-windows.ps1'], ['harness-owned-windows.ps1', 'tests/fixtures/harness-owned-windows.ps1'], ['harness-activate-windows.ps1', 'tests/fixtures/harness-activate-windows.ps1'], ['harness-window-state-windows.ps1', 'tests/fixtures/harness-window-state-windows.ps1'], ['harness-window-timeline-windows.ps1', 'tests/fixtures/harness-window-timeline-windows.ps1'], ['native.ts', 'src/features/computer-use/native.ts'], ['contract.ts', 'src/features/computer-use/contract.ts']]) await download(name, win32.join(portable, destination))
  if (oldPackage) for (const name of ['previous.tgz', 'test-harness-install.mjs']) await download(name, win32.join(guestRoot, name), 120000)
  const config = { screenshotArgs: screenshotPlan.argv, root: guestRoot, portable, node, architecture, windowStateDiagnostic, candidate: win32.join(guestRoot, 'candidate.tgz'), helper: win32.join(guestRoot, 'helper.exe'), installLifecycle: !!oldPackage, manualPreview: process.env.QIUYA_WINDOWS_MANUAL_PREVIEW === '1', dragWindow: process.env.QIUYA_WINDOWS_DRAG_WINDOW === '1', fileExchange: process.env.QIUYA_WINDOWS_FILE_EXCHANGE === '1', inputFaults: process.env.QIUYA_WINDOWS_INPUT_FAULTS_JSON }
  files.set('config.json', Buffer.from(JSON.stringify(config)))
  files.set('launch.mjs', Buffer.from(`
import{readFile,writeFile}from'node:fs/promises';import{dirname,join}from'node:path';import{pathToFileURL,fileURLToPath}from'node:url';
const base=dirname(fileURLToPath(import.meta.url)),c=JSON.parse(await readFile(join(base,'config.json'),'utf8'));
process.env.PATH=dirname(c.node)+';'+join(c.portable,'node_modules','.bin')+';'+process.env.PATH;
process.env.PNPM_HOME=join(base,'pnpm-home');process.env.npm_config_cache=join(base,'npm-cache');process.env.npm_config_userconfig=join(base,'isolated.npmrc');await writeFile(process.env.npm_config_userconfig,'registry=https://registry.npmjs.org\\n');
const cli=JSON.stringify([c.node,join(c.portable,'node_modules','@deepseek-ai','dsh','lib','bin.js')]);const redact=${sanitizeHarnessDiagnostic.toString()};
try{
if(process.platform!=='win32'||process.arch!==c.architecture)throw new Error('The actual Windows Host Node architecture does not match the selected candidate');
process.argv=[c.node,join(c.portable,'scripts','e2e-harness.mjs'),'--package',c.candidate,'--output',join(base,'evidence'),'--browser','msedge','--cli-json',cli,'--native',c.helper,'--keep-profile',...c.screenshotArgs,...(c.manualPreview?['--manual-preview-e2e']:[]),...(c.dragWindow?['--drag-window-e2e']:[]),...(c.fileExchange?['--file-exchange-e2e']:[]),...(c.windowStateDiagnostic?['--preview-window-state-diagnostic']:[]),...(c.inputFaults?['--input-faults-json',c.inputFaults]:[])];
await import(pathToFileURL(process.argv[1]).href);
if(c.installLifecycle){process.argv=[c.node,join(base,'test-harness-install.mjs'),'--old-package',join(base,'previous.tgz'),'--package',c.candidate,'--output',join(base,'install-evidence'),'--cli-json',cli];await import(pathToFileURL(process.argv[1]).href)}
}catch(error){await writeFile(join(base,'startup-error.json'),JSON.stringify({error:redact(error.message),stack:redact(error.stack)}));process.exitCode=1}
finally{await writeFile(join(base,'completed.json'),JSON.stringify({exitCode:process.exitCode||0}))}
`))
  for (const name of ['config.json', 'launch.mjs']) await download(name, win32.join(guestRoot, name))
  const launcher = `$ErrorActionPreference='Stop';$p=Start-Process -FilePath ${quote(node)} -ArgumentList ${quote(`"${win32.join(guestRoot, 'launch.mjs')}"`)} -WorkingDirectory ${quote(portable)} -WindowStyle Hidden -RedirectStandardOutput ${quote(win32.join(guestRoot, 'runner.log'))} -RedirectStandardError ${quote(win32.join(guestRoot, 'runner.err'))} -PassThru;$p.WaitForExit()`
  files.set('start.ps1', Buffer.from(launcher)); await download('start.ps1', win32.join(guestRoot, 'start.ps1'))
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${win32.join(guestRoot, 'start.ps1')}"`
  await ps(`$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(args)};$p=New-ScheduledTaskPrincipal -UserId ${quote(identity.user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(task)}`)
  console.error('[qiuya-harness] real Windows Host + Edge interactive task started')
  let completed = false
  for (let attempt = 0; attempt < 600; attempt++) { if (await ps(`if(Test-Path ${quote(win32.join(guestRoot, 'completed.json'))}){'done'}`)) { completed = true; break }; await new Promise(done => setTimeout(done, 1500)) }
  if (!completed) throw new Error('Windows installed Harness test timed out')
  for (const folder of ['', 'evidence', ...(oldPackage ? ['install-evidence'] : []), ...(screenshotPlan.external ? ['screenshots'] : [])]) {
    const path = win32.join(guestRoot, folder)
    const names = JSON.parse(await ps(`@((Get-ChildItem ${quote(path)} -File -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Name)|Where-Object {$_ -match '\\.(json|jsonl|log|err|jpg|png)$'})|ConvertTo-Json -Compress`))
    const destination = screenshotPlan.external && folder === 'screenshots' ? screenshotPlan.hostDirectory : join(output, folder); await mkdir(destination, { recursive: true })
    for (const name of (Array.isArray(names) ? names : names ? [names] : [])) {
      assert.match(name, /^[a-zA-Z0-9_.-]+$/u)
      if (folder === 'screenshots') assert.match(name, /\.(?:jpg|png)$/u)
      const content = await ps(`$f=[IO.File]::Open(${quote(win32.join(path, name))},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);$m=[IO.MemoryStream]::new();$f.CopyTo($m);$f.Dispose();[Convert]::ToBase64String($m.ToArray());$m.Dispose()`)
      if (content) await writeFile(join(destination, name), Buffer.from(content, 'base64'))
    }
  }
  const report = JSON.parse(await readFile(join(output, 'evidence/report.json'), 'utf8'))
  assert.equal(report.architecture, architecture, 'The UI report must come from the requested Windows Host Node architecture')
  const collection = await verifyCollectedHarnessImages(output, screenshotPlan.hostDirectory, report.screenshotEvidence)
  await writeFile(join(output, 'screenshots-collection.json'), JSON.stringify({ ...collection, guestDirectory: screenshotPlan.guestDirectory }, null, 2) + '\n')
  const install = oldPackage ? JSON.parse(await readFile(join(output, 'install-evidence/report.json'), 'utf8')) : undefined
  const testSourceHashes = Object.fromEntries(['e2e-harness.mjs', 'harness-settings-acceptance.mjs', 'harness-e2e-provider.mjs', 'harness-workspace-prerequisite.mjs', 'harness-preview-windows.ps1', 'harness-owned-windows.ps1', 'harness-activate-windows.ps1', 'harness-window-state-windows.ps1', 'harness-window-timeline-windows.ps1', 'native.ts', 'contract.ts'].map(name => [name, createHash('sha256').update(files.get(name)).digest('hex')]))
  await writeFile(join(output, 'environment.json'), JSON.stringify({ vm, guestRoot, output, node, architecture, candidateSha256: createHash('sha256').update(files.get('candidate.tgz')).digest('hex'), helperSha256: createHash('sha256').update(files.get('helper.exe')).digest('hex'), officialRuntime: '@deepseek-ai/dsh@0.2.1-rc.2; Node v22.23.3; installed Microsoft Edge', runtimePreparation: runtime.preparation, runtimePortableSha256: runtime.portableSha256, nodeArchiveSha256: runtime.nodeSha256, runtimeLockSha256: runtime.lockSha256, testSourceHashes, screenshotDirectory: relative(output, screenshotPlan.hostDirectory).split(sep).join('/') || '.', userProfileIsolated: true }, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, tests: report.tests.map(({ name, status }) => ({ name, status })), installStatus: install?.status, output, guestRoot }, null, 2)); if (!(report.status === 'passed' || windowStateDiagnostic && report.status === 'diagnostic') || install?.status === 'failed') process.exitCode = 1
} catch (error) {
  await writeFile(join(output, 'orchestration-error.json'), JSON.stringify({ error: sanitizeHarnessDiagnostic(error.message), stack: sanitizeHarnessDiagnostic(error.stack), guestRoot }, null, 2)); console.error(JSON.stringify({ error: sanitizeHarnessDiagnostic(error.message), output, guestRoot }, null, 2)); process.exitCode = 1
} finally {
  if (task) await ps(`Stop-ScheduledTask -TaskName ${quote(task)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {})
  server.closeAllConnections(); await new Promise(done => server.close(done))
}
