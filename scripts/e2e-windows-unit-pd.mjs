/** Execute the complete repository Node test suite inside the authorized Windows guest. */
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, win32 } from 'node:path'
import { tmpdir } from 'node:os'
const run = promisify(execFile), vm = process.env.QIUYA_PD_VM, host = process.env.QIUYA_PD_HOST_IP, node = process.env.QIUYA_WINDOWS_NODE
if (!/^[a-f0-9-]{36}$/iu.test(vm ?? '') || !/^\d+\.\d+\.\d+\.\d+$/u.test(host ?? '') || !/^[A-Z]:\\.+\\node\.exe$/iu.test(node ?? '')) throw new Error('Set QIUYA_PD_VM, QIUYA_PD_HOST_IP and QIUYA_WINDOWS_NODE')
const prl = process.env.QIUYA_PRLCTL ?? '/Applications/Parallels Desktop.app/Contents/MacOS/prlctl'
const output = resolve(process.env.QIUYA_WINDOWS_UNIT_OUTPUT ?? join(tmpdir(), `qiuya-windows-unit-${randomUUID()}`))
await mkdir(output, { recursive: true })
const key = randomUUID(), files = new Map([['payload.tgz', await readFile(resolve(process.env.QIUYA_WINDOWS_UNIT_PAYLOAD ?? '/tmp/qiuya-windows-unit-payload.tgz'))]])
const overlay = process.env.QIUYA_WINDOWS_UNIT_OVERLAY
if (overlay) files.set('overlay.tgz', await readFile(resolve(overlay)))
const selectedTests = process.env.QIUYA_WINDOWS_TEST_FILES?.split(',')
if (selectedTests && !selectedTests.every(name => /^[a-zA-Z0-9_-]+\.test\.mjs$/u.test(name))) throw new Error('QIUYA_WINDOWS_TEST_FILES must contain comma-separated test filenames')
const server = createServer((request, response) => { const parts = request.url?.split('/'), bytes = request.method === 'GET' && parts?.[1] === key && files.get(parts[2]); if (!bytes) return response.writeHead(404).end(); response.writeHead(200, { 'Content-Length': bytes.length }); response.end(bytes) })
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, host, done) })
const quote = text => `'${text.replaceAll("'", "''")}'`
const ps = async (code, timeout = 30000) => (await run(prl, ['exec', vm, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { timeout, killSignal: 'SIGKILL', maxBuffer: 48 * 1024 * 1024 })).stdout.trim()
let guestRoot, task
try {
  const identity = JSON.parse(await ps(`$u=(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -First 1).UserName;$s=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value;$p=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$s)).ProfileImagePath;@{user=$u;profile=$p}|ConvertTo-Json -Compress`))
  guestRoot = process.env.QIUYA_WINDOWS_UNIT_ROOT ? win32.normalize(process.env.QIUYA_WINDOWS_UNIT_ROOT) : win32.join(identity.profile, 'AppData/Local/Temp', `QiuYaTools-unit-${key}`)
  if (!guestRoot.startsWith(win32.join(identity.profile, 'AppData/Local/Temp/QiuYaTools-unit-'))) throw new Error('Only disposable unit-test folders can be reused')
  task = `QiuYaTools-unit-${key}`
  await ps(`New-Item -ItemType Directory -Force ${quote(guestRoot)}|Out-Null;if(Test-Path ${quote(win32.join(guestRoot, 'completed.json'))}){Remove-Item ${quote(win32.join(guestRoot, 'completed.json'))}}`)
  await writeFile(join(output, 'environment.json'), JSON.stringify({ vm, node, guestRoot, status: 'preparing', sourceCommit: process.env.QIUYA_WINDOWS_SOURCE_COMMIT ?? null }, null, 2))
  for (const name of process.env.QIUYA_WINDOWS_UNIT_ROOT ? (overlay ? ['overlay.tgz'] : []) : [...files.keys()]) {
    await ps(`$ErrorActionPreference='Stop';$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(`http://${host}:${server.address().port}/${key}/${name}`)},${quote(win32.join(guestRoot, name))});tar.exe -xzf ${quote(win32.join(guestRoot, name))} -C ${quote(guestRoot)};if($LASTEXITCODE -ne 0){throw 'Unit payload extraction failed'}`, 180000)
  }
  console.error('[qiuya-unit] Windows source and platform dependencies ready')
  files.set('run.mjs', Buffer.from(`
import{spawn}from'node:child_process';import{readdir,writeFile}from'node:fs/promises';import{createWriteStream}from'node:fs';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';
const root=dirname(fileURLToPath(import.meta.url)),selected=${JSON.stringify(selectedTests ?? null)},files=(await readdir(join(root,'tests'))).filter(name=>name.endsWith('.test.mjs')&&(!selected||selected.includes(name))).sort();if(!files.length||(selected&&files.length!==selected.length))throw new Error('Requested Windows test files were not found');
const env={...process.env,PATH:dirname(process.execPath)+';'+join(root,'node_modules','.bin')+';'+process.env.PATH,NODE_DISABLE_COLORS:'1'};delete env.NODE_OPTIONS;delete env.NODE_PATH;
const log=createWriteStream(join(root,'unit.log'));let text='';const child=spawn(process.execPath,['--test','--test-concurrency=1','--test-timeout=120000','--test-reporter=spec',...files.map(name=>join(root,'tests',name))],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>{log.write(chunk);text+=chunk});
const code=await new Promise(done=>{child.once('error',error=>{text+=error.stack;done(1)});child.once('exit',done)});await new Promise(done=>log.end(done));
await writeFile(join(root,'report.json'),JSON.stringify({status:code===0?'passed':'failed',platform:process.platform,architecture:process.arch,node:process.versions.node,exitCode:code,testFiles:files,summary:text.split(/\\r?\\n/u).filter(line=>/^ℹ (tests|pass|fail|skipped|duration)/u.test(line)),failures:text.split(/\\r?\\n/u).filter(line=>line.startsWith('✖')).slice(0,100),testedAt:new Date().toISOString()},null,2));await writeFile(join(root,'completed.json'),JSON.stringify({code}));process.exitCode=code;
`))
  const launch = `$ErrorActionPreference='Stop';$p=Start-Process -FilePath ${quote(node)} -ArgumentList ${quote(`"${win32.join(guestRoot, 'run.mjs')}"`)} -WorkingDirectory ${quote(guestRoot)} -WindowStyle Hidden -RedirectStandardOutput ${quote(win32.join(guestRoot, 'runner.log'))} -RedirectStandardError ${quote(win32.join(guestRoot, 'runner.err'))} -PassThru;$p.WaitForExit()`
  files.set('start.ps1', Buffer.from(launch))
  for (const name of ['run.mjs', 'start.ps1']) await ps(`$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(`http://${host}:${server.address().port}/${key}/${name}`)},${quote(win32.join(guestRoot, name))})`)
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${win32.join(guestRoot, 'start.ps1')}"`
  await ps(`$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(args)};$p=New-ScheduledTaskPrincipal -UserId ${quote(identity.user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(task)}`)
  console.error('[qiuya-unit] actual Windows Node22 complete test suite started')
  let complete = false
  for (let attempt = 0; attempt < 600; attempt++) { if (await ps(`if(Test-Path ${quote(win32.join(guestRoot, 'completed.json'))}){'done'}`)) { complete = true; break }; await new Promise(done => setTimeout(done, 1500)) }
  for (const name of ['report.json', 'unit.log', 'runner.log', 'runner.err']) {
    const bytes = await ps(`if(Test-Path ${quote(win32.join(guestRoot, name))}){$f=[IO.File]::Open(${quote(win32.join(guestRoot, name))},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);$m=[IO.MemoryStream]::new();$f.CopyTo($m);$f.Dispose();[Convert]::ToBase64String($m.ToArray());$m.Dispose()}`)
    if (bytes) await writeFile(join(output, name), Buffer.from(bytes, 'base64'))
  }
  if (!complete) throw new Error('Windows full unit suite exceeded its deadline')
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
  const environment = JSON.parse(await readFile(join(output, 'environment.json'), 'utf8'))
  await writeFile(join(output, 'environment.json'), JSON.stringify({ ...environment, status: report.status, platform: report.platform, architecture: report.architecture, runtimeVersion: report.node, payloadSHA256: createHash('sha256').update(files.get('payload.tgz')).digest('hex'), overlaySHA256: overlay ? createHash('sha256').update(files.get('overlay.tgz')).digest('hex') : null }, null, 2))
  console.log(JSON.stringify({ status: report.status, summary: report.summary, failures: report.failures, output, guestRoot }, null, 2)); if (report.status !== 'passed') process.exitCode = 1
} catch (error) { await writeFile(join(output, 'orchestration-error.json'), JSON.stringify({ error: error.message, guestRoot }, null, 2)); console.error(JSON.stringify({ error: error.message, output, guestRoot }, null, 2)); process.exitCode = 1 }
finally { if (task) await ps(`Stop-ScheduledTask -TaskName ${quote(task)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {}); server.closeAllConnections(); await new Promise(done => server.close(done)) }
