/** Actual Windows RemoteComputerDriver -> Mac fixture. The local file gate permits one input sequence. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { mkdir, readFile, writeFile, stat, realpath } from 'node:fs/promises'
import { join, resolve, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { windowsPinnedProcessCommand } from './computer-webview2-soak-evidence.mjs'
import { reverseRemoteDeliveryPassed } from './reverse-remote-delivery.mjs'
import {pinReverseExecutable,verifyReverseProcessExecutable} from './reverse-executable-pin.mjs'
import {reverseOwnedDirectoryAclCommand,assertReverseOwnedDirectoryAclProof} from './reverse-owned-directory-acl.mjs'
import {createReverseCheckpointCoordinator,reverseClientReportEntry} from './reverse-checkpoint-coordinator.mjs'

const run = promisify(execFile), vm = process.env.QIUYA_PD_VM, host = process.env.QIUYA_PD_HOST_IP
if (process.platform !== 'darwin') throw new Error('The reverse runner requires the authorized Mac host')
if (!vm || !/^[a-f0-9-]{36}$/iu.test(vm) || !host || !/^\d+\.\d+\.\d+\.\d+$/u.test(host)) throw new Error('Set QIUYA_PD_VM and QIUYA_PD_HOST_IP for the authorized test VM')
if (!process.env.QIUYA_WINDOWS_NODE_ROOT) throw new Error('Set QIUYA_WINDOWS_NODE_ROOT to the verified guest Node runtime')
const prlctl = process.env.QIUYA_PRLCTL || '/Applications/Parallels Desktop.app/Contents/MacOS/prlctl'
const output = resolve(process.env.QIUYA_REVERSE_REMOTE_OUTPUT || join(tmpdir(), `qiuya-windows-to-macos-${randomUUID()}`))
await mkdir(output, { recursive: true })
for (const name of ['report.json', 'client-report.json', 'delivery-verdict.json']) await stat(join(output, name)).then(() => { throw new Error(`Use a fresh output directory: ${name} exists`) }, error => { if (error.code !== 'ENOENT') throw error })
const key = randomUUID(), token = randomBytes(32).toString('hex'), gate = join(output, 'begin-input')
const repo = fileURLToPath(new URL('../', import.meta.url)), bundle = join(output, 'remote.mjs')
const helper = await realpath(join(repo, 'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'))
const helperExecutablePin = await pinReverseExecutable(helper, createHash('sha256').update(await readFile(helper)).digest('hex'))
const fixtureSource = join(repo, 'src/native/macos/fixtures/ComputerFixture.swift'), oracleSource = join(repo, 'src/native/macos/fixtures/LeaseOracle.swift'), leaseAuditSource = join(repo, 'src/native/macos/fixtures/ReverseLeaseAudit.swift')
const fixtureContents = join(output, 'QiuYaTools Reverse Fixture.app', 'Contents'), executable = join(fixtureContents, 'MacOS', 'fixture'), oracleBinary = join(output, 'reverse-oracle'), leaseAuditBinary = join(output, 'reverse-lease-audit')
const fixtureBundleId = `com.qiuya.tools.reverse-remote.fixture.${key.replaceAll('-', '')}`
const guestBase = process.env.QIUYA_WINDOWS_NODE_ROOT
assert.match(guestBase, /^[a-z]:\\/iu, 'Verified guest Node root must be an absolute Windows directory')
const guestRoot = `${win32.dirname(guestBase)}\\QiuYaTools-reverse-${key}`
const nodeArch = process.env.QIUYA_WINDOWS_NODE_ARCH || 'arm64'
if (!['arm64', 'x64'].includes(nodeArch)) throw new Error('Guest Node architecture must be arm64 or x64')
const node = `${guestBase}\\node-v22.23.3-win-${nodeArch}\\node.exe`, quote = value => `'${value.replaceAll("'", "''")}'`
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const birthKey = value => `${value.pid}:${value.startSeconds}:${value.startMicroseconds}`
const sameIdentity = (a, b) => a && b && birthKey(a) === birthKey(b) && a.executablePath === b.executablePath
const emptyOs = value => value.leftButtonDown === false && value.rightButtonDown === false && value.middleButtonDown === false && Array.isArray(value.keysDown) && value.keysDown.length === 0
const cleanup = { passed: false, errors: [], forced: [], trackedMac: [], remainingMac: [], windowsTask: null, guestTokenConfigDeleted: false, inMemoryConfigRemoved: false }
const files = new Map(), transport = [], macIdentities = new Map(), oracleInvocations = []
const trackedWindows = [], executableProofs = []
let server, serverListening = false, base, task, guestCreated = false, fixture, fixtureExit, fixtureLines, driver, nativeChild, nativeExit, agent, clientReport, naturalTaskExit, setupError, preflight, environment, guestIdentityRecorded = false, snapshot
const bounded = error => ({ code: error.code ?? null, message: String(error.message).split('\n')[0].replace(/ -EncodedCommand .*/u, ' [command omitted]').slice(0, 500), stdout: String(error.stdout ?? '').slice(0, 2500), stderr: String(error.stderr ?? '').slice(0, 2500), ...(error.reverseExecutableFact ? {executableFact:error.reverseExecutableFact} : {}) })
async function wait(promise, milliseconds, reason) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), milliseconds) })]) } finally { clearTimeout(timer) } }
async function eventually(fn, reason, milliseconds = 5000) { const deadline = performance.now() + milliseconds; while (performance.now() < deadline) { if (await fn()) return; await delay(20) } throw new Error(reason) }
async function oracle(op, args = {}) {
  const result = await run(oracleBinary, [ ...[helper, executable, oracleBinary].flatMap(path => ['--allowed-executable', path]), '--one-shot', JSON.stringify({ op, ...args }) ], { timeout: 8000, maxBuffer: 1024 * 1024 })
  const value = JSON.parse(result.stdout.trim()); assert.equal(value.ok, true, `Independent ${op}: ${value.error}`)
  oracleInvocations.push({ op, identity: value.observerIdentity, exitedNaturally: true })
  return value.result
}
async function identity(pid) { return (await oracle('identity', { pid })).identity }
function remember(value, role) { assert.ok(value?.pid && value.startSeconds && value.startMicroseconds && value.executablePath, 'Exact Mac process identity is required'); macIdentities.set(birthKey(value), { ...value, role }); return value }
async function checkpointNative() {
  if (!driver) return
  // Test-only observation of this driver instance's transport child; never mutate it.
  if (!nativeChild && driver.child) {
    nativeChild = driver.child
    nativeExit = new Promise(done => { nativeChild.once('exit', (code, signal) => done({ code, signal })); nativeChild.once('error', error => done({ error: error.message })) })
    const own = remember(await identity(nativeChild.pid), 'native')
    executableProofs.push(await verifyReverseProcessExecutable(own,helperExecutablePin,{pid:nativeChild.pid,parentPid:process.pid,phase:'native-image-pin'}))
    const confirmed=await identity(nativeChild.pid);assert.ok(sameIdentity(confirmed,own),'Native PID/birth/path changed during executable proof');assert.equal(confirmed.parentPid,process.pid)
    executableProofs.push(await verifyReverseProcessExecutable(confirmed,helperExecutablePin,{pid:nativeChild.pid,parentPid:process.pid,phase:'native-image-recheck'}))
  }
  const parent = [...macIdentities.values()].find(value => value.role === 'native')
  if (!parent || !sameIdentity(await identity(parent.pid), parent)) return
  const rows = (await run('/bin/ps', ['-axo', 'pid=,ppid='])).stdout
  for (const line of rows.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line)
    if (!match || Number(match[2]) !== parent.pid) continue
    const child = await identity(Number(match[1]))
    if (!child || child.parentPid !== parent.pid) continue
    if (await realpath(child.executablePath) !== helperExecutablePin.canonical) continue
    executableProofs.push(await verifyReverseProcessExecutable(child,helperExecutablePin,{pid:child.pid,parentPid:parent.pid,phase:'guardian-image-pin'}))
    const childBorn = BigInt(child.startSeconds) * 1_000_000n + BigInt(child.startMicroseconds), parentBorn = BigInt(parent.startSeconds) * 1_000_000n + BigInt(parent.startMicroseconds)
    assert.ok(childBorn >= parentBorn)
    assert.match((await run('/bin/ps', ['-p', String(child.pid), '-o', 'command='])).stdout, /(?:^|\s)--input-guardian(?:\s|$)/u)
    remember(child, 'guardian')
  }
}
async function inlinePs(code, timeout = 30000) {
  const encoded = Buffer.from(code, 'utf16le').toString('base64')
  assert.ok(encoded.length <= 2000, 'Guest bootstrap exceeds the verified short-command envelope')
  return (await run(prlctl, ['exec', vm, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout, killSignal: 'SIGKILL', maxBuffer: 24 * 1024 * 1024 })).stdout.trim()
}
async function ps(code, timeout = 30000) {
  const encoded = Buffer.from(code, 'utf16le').toString('base64')
  if (encoded.length <= 2000) return inlinePs(code, timeout)
  assert.ok(guestCreated && serverListening && base, 'Long guest commands require the owned UUID directory and live file server')
  const name = `command-${randomUUID()}.ps1`, bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(code)]), path = guestRoot + '\\' + name
  files.set(name, bytes); transport.push({ name, sha256: sha(bytes), bytes: bytes.length, method: 'sha-verified-owned-file' })
  let transferred = false
  try {
    await inlinePs(`$ErrorActionPreference='Stop';$p=${quote(path)};$c=[Net.WebClient]::new();$c.Proxy=$null;try{$c.DownloadFile(${quote(base + '/' + name)},$p)}finally{$c.Dispose()};if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne '${sha(bytes)}'){throw 'Command SHA mismatch'}`)
    transferred = true
    return (await run(prlctl, ['exec', vm, 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path], { timeout, killSignal: 'SIGKILL', maxBuffer: 24 * 1024 * 1024 })).stdout.trim()
  } finally {
    files.delete(name)
    try { if (transferred) await inlinePs(`$ErrorActionPreference='Stop';Remove-Item -LiteralPath ${quote(path)} -Force -ErrorAction Stop`) }
    catch (error) { cleanup.errors.push(`Owned command-file removal: ${JSON.stringify(bounded(error))}`) }
  }
}
const checkpointScript = Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(`param([Parameter(Mandatory=$true)][string]$ExpectedSHA256)
$ErrorActionPreference='Stop';if(((Get-Item -LiteralPath $PSCommandPath).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSHA256){throw 'Owned checkpoint source SHA changed'};
$ErrorActionPreference='Stop';$i=Get-Content -LiteralPath ${quote(guestRoot + '\\client-identity.json')} -Raw|ConvertFrom-Json;$p=[Diagnostics.Process]::GetProcessById([int]$i.pid);try{$null=$p.SafeHandle;$born=$p.StartTime.ToUniversalTime().Ticks;$path=$p.MainModule.FileName;if($path -ine ${quote(node)} -or $p.SessionId -le 0){throw 'Client process path/session changed'};$r=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.Id);if(!$r -or $r.CommandLine.IndexOf(${quote(guestRoot + '\\client.mjs')},[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'Client command ownership changed'};$owned=@(@{pid=$p.Id;createdAtTicks=$born.ToString();expectedExecutablePath=$path;role='client'});$console=Join-Path ([Environment]::SystemDirectory) 'conhost.exe';foreach($c in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$p.Id))){$child=$null;try{$child=[Diagnostics.Process]::GetProcessById([int]$c.ProcessId);$null=$child.SafeHandle;$childBorn=$child.StartTime.ToUniversalTime().Ticks;$live=Get-CimInstance Win32_Process -Filter ('ProcessId='+$child.Id);if(!$live -or [int]$live.ParentProcessId -ne $p.Id -or $live.CreationDate.ToUniversalTime().Ticks -ne ($childBorn-($childBorn%10))){continue};if($childBorn -lt $born -or $child.MainModule.FileName -ine $console){throw 'Unexpected direct client child'};$owned+=@{pid=$child.Id;createdAtTicks=$childBorn.ToString();expectedExecutablePath=$console;role='console'}}finally{if($child){$child.Dispose()}}};if($p.HasExited -or $p.StartTime.ToUniversalTime().Ticks -ne $born){throw 'Client exited during ownership checkpoint'};@{identity=$i;owned=$owned}|ConvertTo-Json -Depth 6 -Compress}finally{$p.Dispose()}`)])
async function checkpointGuest() {
  const value = JSON.parse((await run(prlctl,['exec',vm,'powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',guestRoot+'\\checkpoint.ps1','-ExpectedSHA256',sha(checkpointScript)],{timeout:30000,killSignal:'SIGKILL',maxBuffer:1024*1024})).stdout.trim())
  assert.equal(value.identity.platform, 'win32'); assert.equal(value.identity.architecture, nodeArch)
  assert.equal(value.identity.scriptSha256, sha(Buffer.from(client)))
  assert.ok(value.owned.some(row => row.role === 'client'))
  for (const row of value.owned) {
    const recorded = trackedWindows.find(item => item.pid === row.pid)
    if (recorded) assert.deepEqual(recorded, row, 'The owned client identity changed between checkpoints')
    else trackedWindows.push(row)
  }
  await writeFile(join(output, 'windows-process-checkpoint.json'), JSON.stringify(value, null, 2) + '\n')
  guestIdentityRecorded = true
}
let reportResolve,reportReceived=false
const clientReportArrival=new Promise(resolve=>{reportResolve=resolve})
const checkpointCoordinator=createReverseCheckpointCoordinator(checkpointGuest,stage=>{
  console.log(JSON.stringify({stage:stage==='client-started'?'client-identity-pinned':'capture-only-passed-waiting-for-input-gate',gate}))
})

const client = String.raw`import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';import { fileURLToPath } from 'node:url';import { createHash } from 'node:crypto';
import { RemoteComputerDriver } from './remote.mjs';
const dir=dirname(fileURLToPath(import.meta.url)),checks=[],cleanupErrors=[];let driver,config,report;
const check=id=>checks.push({id,passed:true}),delay=ms=>new Promise(done=>setTimeout(done,ms));
const save=async(name,value)=>{await writeFile(join(dir,name+'.tmp'),JSON.stringify(value,null,2));await rename(join(dir,name+'.tmp'),join(dir,name))};
const state=async()=>{const response=await fetch(config.fixtureBase+'/state');assert.equal(response.status,200);return response.json()};
try{
 await save('client-identity.json',{pid:process.pid,platform:process.platform,architecture:process.arch,scriptSha256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')});
 config=JSON.parse(await readFile(join(dir,'config.json'),'utf8'));
 assert.equal(process.platform,'win32');assert.equal(process.arch,config.expectedArchitecture);
 assert.equal((await fetch(config.fixtureBase+'/checkpoint',{method:'POST',body:JSON.stringify({stage:'client-started'})})).status,200);
 let pinned=false;for(let index=0;index<100;index++){if(await(await fetch(config.fixtureBase+'/identity-ready')).text()==='go'){pinned=true;break}await delay(300)}assert.ok(pinned,'Client identity was not independently pinned before remote operations');
 driver=new RemoteComputerDriver({endpoint:config.endpoint,token:config.token,clientId:'windows-to-macos-fixture',allowInsecurePrivateNetwork:true,heartbeatMs:300});
 const status=await driver.status();assert.equal(status.platform,'darwin');assert.equal(status.available,true);check('REVERSE-WIN-CLIENT-MAC-STATUS');
 const expectedAppId=driver.deviceId+':'+config.fixtureBundleId;
 const target=(await driver.targets()).find(value=>value.pid===config.fixturePid&&value.appId===expectedAppId&&value.title==='QiuYaTools Computer E2E Fixture');assert.ok(target);check('REVERSE-MAC-TARGET');
 let frame=await driver.observe(target.id);assert.ok(frame.elements.includes('Fixture'));assert.equal(Buffer.from(frame.imageBase64,'base64').readUInt16BE(),0xffd8);await writeFile(join(dir,'reverse-fixture.jpg'),Buffer.from(frame.imageBase64,'base64'));check('REVERSE-CAPTURE-AX');
 assert.equal((await fetch(config.fixtureBase+'/checkpoint',{method:'POST',body:JSON.stringify({stage:'capture-only-passed',platform:process.platform,architecture:process.arch,checks})})).status,200);
 let go=false;for(let index=0;index<1800;index++){if(await(await fetch(config.fixtureBase+'/begin')).text()==='go'){go=true;break}await delay(300)}assert.ok(go,'Explicit Mac input gate was not opened');
 frame=await driver.observe(target.id);const point=name=>({x:(config.points[name].x-frame.geometry.x)*frame.width/frame.geometry.width,y:(config.points[name].y-frame.geometry.y)*frame.height/frame.geometry.height});
 const before=await state();assert.equal(before.text,'','The disposable field changed during setup; no input was started');await driver.lease(1);
 await driver.act(1,target.id,{kind:'click',...point('button')});await delay(100);assert.equal((await state()).counts.clicks,before.counts.clicks+1);check('REVERSE-ACTUAL-MAC-CLICK');
 await driver.act(1,target.id,{kind:'click',...point('text')});await driver.act(1,target.id,{kind:'type',text:'Windows to Mac 中文🙂'});await delay(150);assert.equal((await state()).text,'Windows to Mac 中文🙂');check('REVERSE-ACTUAL-MAC-UNICODE');
 await driver.act(1,target.id,{kind:'key',key:'CMD+A'});await driver.act(1,target.id,{kind:'type',text:'replaced'});assert.equal((await state()).text,'replaced');check('REVERSE-MAC-SHORTCUT');
 await driver.release(1);await assert.rejects(driver.act(1,target.id,{kind:'key',key:'Enter'}),error=>error.code==='CONTROL_CHANGED');check('REVERSE-RELEASE-FENCE');
 await driver.lease(2);await driver.act(2,target.id,{kind:'type',text:' resumed'});assert.equal((await state()).text,'replaced resumed');check('REVERSE-RESUME');
 await driver.release(2);assert.equal((await driver.preview(target.id)).elements,'');check('REVERSE-PREVIEW');
 report={passed:true,checks,platform:process.platform,architecture:process.arch,remotePlatform:status.platform,privateTestEndpoint:true};
}catch(error){report={passed:false,checks,error:error.message,stack:error.stack}}
finally{
 try{await save('client-run-report.json',report)}catch(error){cleanupErrors.push('Raw report persistence: '+error.message)}
 if(driver)try{await driver.dispose()}catch(error){cleanupErrors.push('Remote driver disposal: '+error.message)}
 try{await unlink(join(dir,'config.json'))}catch(error){if(error.code!=='ENOENT')cleanupErrors.push('Private config deletion: '+error.message)}
 report={...report,passed:report.passed&&cleanupErrors.length===0,cleanup:{passed:cleanupErrors.length===0,errors:cleanupErrors}};
 await save('report.json',report);if(!report.passed)process.exitCode=1;
}
`

try {
  environment = { vm, guestRoot, clientNode: node, expectedArchitecture: nodeArch, runnerSourceSha256: sha(await readFile(fileURLToPath(import.meta.url))), nativeHelperSha256: sha(await readFile(helper)), fixtureSourceSha256: sha(await readFile(fixtureSource)), oracleSourceSha256: sha(await readFile(oracleSource)), leaseAuditSourceSha256: sha(await readFile(leaseAuditSource)), pinnedWindowsOracleSourceSha256: sha(await readFile(join(repo, 'scripts/computer-webview2-soak-evidence.mjs'))), inputGate: gate, pairedPrivateNetwork: true }
  await run('/usr/bin/swiftc', ['-swift-version', '5', '-framework', 'AppKit', '-module-cache-path', '/private/tmp/qiuya-remote-swift-cache', oracleSource, '-o', oracleBinary], { timeout: 60000 })
  await run('/usr/bin/swiftc', ['-swift-version', '5', '-module-cache-path', '/private/tmp/qiuya-remote-swift-cache', leaseAuditSource, '-o', leaseAuditBinary], { timeout: 60000 })
  preflight = await oracle('snapshot')
  assert.equal(preflight.sessionExists, true, 'The Mac graphical session is unavailable')
  if (preflight.screenLocked || preflight.foregroundBundleId === 'com.apple.loginwindow') { const error = new Error('The owner must unlock the existing Mac session'); error.code = 'SESSION_LOCKED'; throw error }
  assert.ok(emptyOs(preflight), 'Existing OS-held input prevents this test; no action was replayed')
  const result = await build({ stdin: { contents: "export{RemoteComputerDriver,createComputerAgentServer}from'./src/features/computer-use/remote.ts';export{NativeCompanionDriver}from'./src/features/computer-use/native.ts'", resolveDir: repo }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, metafile: true })
  const sources = []
  for (const path of Object.keys(result.metafile.inputs).sort()) if (path !== '<stdin>') { const bytes = await readFile(resolve(repo, path)); sources.push({ path, sha256: sha(bytes), bytes: bytes.length }) }
  const { NativeCompanionDriver, createComputerAgentServer } = await import(pathToFileURL(bundle).href)
  await mkdir(join(fixtureContents, 'MacOS'), { recursive: true })
  await writeFile(join(fixtureContents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${fixtureBundleId}</string><key>CFBundleName</key><string>QiuYaTools Reverse Fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
  await run('/usr/bin/swiftc', ['-swift-version', '5', '-framework', 'AppKit', '-module-cache-path', '/private/tmp/qiuya-remote-swift-cache', fixtureSource, '-o', executable], { timeout: 60000 })
  fixture = spawn(executable, ['--defer-activation'], { stdio: ['pipe', 'pipe', 'pipe'] }); fixture.stderr.resume(); fixture.stdin.on('error', () => {})
  fixtureExit = new Promise(done => { fixture.once('exit', (code, signal) => done({ code, signal })); fixture.once('error', error => done({ error: error.message })) })
  const queued = [], waiting = [], transcript = []
  fixtureLines = createInterface({ input: fixture.stdout })
  fixtureLines.on('line', line => { let value; try { value = JSON.parse(line) } catch { return }; transcript.push(value); const job = waiting.shift(); if (job) { clearTimeout(job.timer); job.resolve(value) } else queued.push(value) })
  const next = () => new Promise((resolve, reject) => { if (queued.length) { resolve(queued.shift()); return }; const job = { resolve, reject }; job.timer = setTimeout(() => { const index = waiting.indexOf(job); if (index >= 0) waiting.splice(index, 1); reject(new Error('Mac fixture JSONL timed out')) }, 5000); waiting.push(job) })
  const ready = await next(), fixtureIdentity = remember(await identity(fixture.pid), 'fixture')
  assert.equal(ready.pid, fixtureIdentity.pid)
  let queue = Promise.resolve()
  snapshot = () => { const work = queue.then(async () => { const pending = next(); fixture.stdin.write('snapshot\n'); return pending }); queue = work.catch(() => {}); return work }
  cleanup.fixtureTranscript = transcript
  driver = new NativeCompanionDriver({ executable: helper })
  const nativeStatus = await driver.status(); await checkpointNative()
  assert.ok(nativeStatus.permissions.screenRecording && nativeStatus.permissions.accessibility && nativeStatus.permissions.postEvents, 'Previously granted native capture/input permissions are required')
  agent = await createComputerAgentServer(driver, { token, host, port: 0 })
  server = createServer(async (request, response) => {
    try {
      const parts = request.url.split('/')
      if (parts.length !== 3 || parts[1] !== key) { response.writeHead(404).end(); return }
      if (parts[2] === 'state' && request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await snapshot())); return }
      if (parts[2] === 'begin' && request.method === 'GET') { response.end(guestIdentityRecorded ? await stat(gate).then(value => value.isFile() ? 'go' : 'wait', () => 'wait') : 'wait'); return }
      if (parts[2] === 'identity-ready' && request.method === 'GET') { response.end(guestIdentityRecorded ? 'go' : 'wait'); return }
      if (parts[2] === 'checkpoint' && request.method === 'POST') { let body = ''; for await (const bytes of request) { body += bytes; if (body.length > 65536) throw new Error('Checkpoint limit') }; const value = JSON.parse(body); assert.ok(['client-started', 'capture-only-passed'].includes(value.stage)); await writeFile(join(output, value.stage === 'client-started' ? 'client-start-checkpoint.json' : 'capture-checkpoint.json'), body); void checkpointCoordinator.notify(value.stage).catch(()=>{}); response.end('ok'); return }
      if(parts[2]==='client-report'&&request.method==='POST'){
        assert.equal(reportReceived,false,'Original report callback is single-use');let body='';for await(const bytes of request){body+=bytes;if(Buffer.byteLength(body)>65536)throw new Error('Owned report bound')}
        const value=JSON.parse(body);assert.equal(typeof value.passed,'boolean');assert.ok(Array.isArray(value.checks)&&value.checks.length<=9);reportReceived=true
        await writeFile(join(output,'client-report.json'),body,{mode:0o600});reportResolve(value);response.end('ok');return
      }
      const bytes = request.method === 'GET' && files.get(parts[2])
      if (!bytes) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'Content-Length': bytes.length }); response.end(bytes)
    } catch { response.writeHead(500).end('Owned fixture unavailable') }
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, host, done) }); serverListening = true
  base = `http://${host}:${server.address().port}/${key}`
  files.set('remote.mjs', await readFile(bundle)); files.set('client.mjs', Buffer.from(client))
  files.set('checkpoint.ps1',checkpointScript);files.set('client-entry.mjs',Buffer.from(reverseClientReportEntry()))
  files.set('config.json', Buffer.from(JSON.stringify({ endpoint: agent.endpoint, token, fixturePid: fixture.pid, fixtureBundleId, points: ready.points, fixtureBase: base, expectedArchitecture: nodeArch })))
  environment = { ...environment, fixtureBinarySha256: sha(await readFile(executable)), oracleBinarySha256: sha(await readFile(oracleBinary)), leaseAuditBinarySha256: sha(await readFile(leaseAuditBinary)), bundleSha256: sha(await readFile(bundle)), clientSourceSha256: sha(Buffer.from(client)), bundleInputs: sources, fixtureIdentity, transfers: [] }
  await ps(`$ErrorActionPreference='Stop';New-Item -ItemType Directory -Force ${quote(guestRoot)}|Out-Null`); guestCreated = true
  for (const [name, bytes] of [...files]) {
    const path = guestRoot + '\\' + name
    await ps(`$ErrorActionPreference='Stop';$c=[Net.WebClient]::new();$c.Proxy=$null;try{$c.DownloadFile(${quote(base + '/' + name)},${quote(path)})}finally{$c.Dispose()};if((Get-FileHash -LiteralPath ${quote(path)} -Algorithm SHA256).Hash -ne '${sha(bytes)}'){throw 'Transfer SHA mismatch'}`)
    environment.transfers.push({ name, sha256: sha(bytes), bytes: bytes.length })
  }
  environment.clientNodeSha256 = await ps(`$ErrorActionPreference='Stop';(Get-FileHash -LiteralPath ${quote(node)} -Algorithm SHA256).Hash.ToLowerInvariant()`)
  const principal = JSON.parse(await ps(`$ErrorActionPreference='Stop';$u=(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -First 1).UserName;if(!$u){throw 'No interactive Windows user'};$sid=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value;@{user=$u;sid=$sid}|ConvertTo-Json -Compress`))
  const directoryAcl = JSON.parse(await ps(reverseOwnedDirectoryAclCommand({directory:guestRoot,sid:principal.sid})))
  assertReverseOwnedDirectoryAclProof({sid:principal.sid},directoryAcl)
  await writeFile(join(output,'guest-directory-acl-proof.json'),JSON.stringify(directoryAcl,null,2)+'\n',{mode:0o600})
  task = `QiuYaTools-reverse-${key}`
  await ps(`$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute ${quote(node)} -Argument ${quote('"'+guestRoot+'\\client-entry.mjs" "'+guestRoot+'\\client.mjs"')};$p=New-ScheduledTaskPrincipal -UserId ${quote(principal.sid)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 12);Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(task)}`)
  console.log(JSON.stringify({ stage: 'setup-complete', output, gate, guestRoot }))
  const reportDeadline = performance.now() + 11 * 60_000
  clientReport=await wait(clientReportArrival,Math.max(1,reportDeadline-performance.now()),'Reverse remote client did not produce a report before its deadline')
  await checkpointCoordinator.settled()
  assert.ok(clientReport, 'Reverse remote client did not produce a report before its deadline')
  for (let index = 0; index < 30; index++) {
    const result = JSON.parse(await ps(`$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName ${quote(task)};$i=Get-ScheduledTaskInfo -TaskName ${quote(task)};@{state=$t.State.ToString();result=[long]$i.LastTaskResult}|ConvertTo-Json -Compress`))
    if (result.state === 'Ready' && result.result === 0) { naturalTaskExit = result; break }
    await delay(200)
  }
  assert.ok(naturalTaskExit, 'Client task did not exit naturally with result 0')
  for (const name of ['reverse-fixture.jpg', 'client-identity.json', 'client-run-report.json']) {
    const value = await ps(`$p=${quote(guestRoot + '\\' + name)};if(Test-Path -LiteralPath $p){[Convert]::ToBase64String([IO.File]::ReadAllBytes($p))}`)
    if (value) await writeFile(join(output, name), Buffer.from(value, 'base64'))
  }
} catch (error) {
  setupError = { ...bounded(error), code: error.code ?? null }
  await writeFile(join(output, 'orchestration-error.json'), JSON.stringify(setupError, null, 2) + '\n')
} finally {
  files.get('config.json')?.fill(0); files.delete('config.json'); cleanup.inMemoryConfigRemoved = !files.has('config.json')
  if (agent) {
    try { await agent.revoke(); const response = await fetch(agent.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 401); await response.body?.cancel(); cleanup.oldTokenRejected = true }
    catch (error) { cleanup.errors.push(`Pair revocation: ${error.message}`) }
  }
  if (task) {
    try {
      const state = await ps(`$ErrorActionPreference='Stop';(Get-ScheduledTask -TaskName ${quote(task)}).State.ToString()`)
      cleanup.windowsTask = { naturalTaskExit: naturalTaskExit ?? null, stateBeforeRemoval: state, stopRequired: state !== 'Ready' }
      if (state !== 'Ready') { await ps(`$ErrorActionPreference='Stop';Stop-ScheduledTask -TaskName ${quote(task)} -ErrorAction Stop`); cleanup.errors.push('The owned Windows task required forced Stop; natural exit was not proven') }
      await ps(`$ErrorActionPreference='Stop';Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false -ErrorAction Stop`)
      cleanup.windowsTask.unregistered = true
    } catch (error) { cleanup.errors.push(`Windows task cleanup: ${JSON.stringify(bounded(error))}`) }
  }
  if (guestCreated) {
    if (trackedWindows.length) {
      const inspect = async () => {
        const result = JSON.parse(await ps(windowsPinnedProcessCommand(trackedWindows)))
        cleanup.windowsExitAudit = result
        assert.equal(result.passed, true, 'Pinned Windows identity inspection failed')
        return !result.results.some(row => row.state === 'alive')
      }
      try { await eventually(inspect, 'Exact client/console identities did not exit naturally') }
      catch (error) {
        cleanup.errors.push(`Windows natural cleanup: ${error.message}`)
        try { cleanup.windowsForced = JSON.parse(await ps(windowsPinnedProcessCommand(trackedWindows, { terminate: true }))); assert.equal(cleanup.windowsForced.passed, true); assert.ok(await inspect()) }
        catch (fallback) { cleanup.errors.push(`Pinned Windows retirement: ${fallback.message}`) }
      }
    } else if (task) { cleanup.errors.push('Windows client ownership was not checkpointed; complete cleanup was not proven') }
    try {
      await ps(`$ErrorActionPreference='Stop';$p=${quote(guestRoot + '\\config.json')};if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Force -ErrorAction Stop};if(Test-Path -LiteralPath $p){throw 'Private token config survived removal'}`)
      cleanup.guestTokenConfigDeleted = true
    } catch (error) { cleanup.errors.push(`Private guest config: ${JSON.stringify(bounded(error))}`) }
  }
  try { if (driver) await checkpointNative() } catch (error) { cleanup.errors.push(`Final Mac ownership checkpoint: ${error.message}`) }
  if (agent) {
    try { await agent.close() } catch (error) { cleanup.errors.push(`Agent close: ${error.message}`) }
  }
  if (driver) {
    try { await driver.dispose(); assert.ok(nativeExit, 'Native child exit was not independently observed'); cleanup.nativeExit = await wait(nativeExit, 5000, 'Native companion did not exit'); assert.deepEqual(cleanup.nativeExit, { code: 0, signal: null }) }
    catch (error) { cleanup.errors.push(`Native natural disposal: ${error.message}`) }
  }
  if (fixture) {
    try { assert.equal(fixture.exitCode, null, 'Fixture exited before natural cleanup'); assert.equal(fixture.signalCode, null); fixture.stdin.end('quit\n'); cleanup.fixtureExit = await wait(fixtureExit, 5000, 'Fixture did not exit naturally'); assert.deepEqual(cleanup.fixtureExit, { code: 0, signal: null }) }
    catch (error) { cleanup.errors.push(`Fixture natural cleanup: ${error.message}`) }
  }
  const remaining = async () => {
    const alive = [], audit = []
    for (const value of macIdentities.values()) {
      try {
        const current = await identity(value.pid)
        if (current && birthKey(current) === birthKey(value) && current.executablePath !== value.executablePath) throw new Error('A same-birth Mac process changed executable before natural exit')
        const state = sameIdentity(current, value) ? 'alive' : current ? 'reused-pid-skipped' : 'already-exited'
        audit.push({ ...value, state }); if (state === 'alive') alive.push(value)
      } catch (error) { audit.push({ ...value, state: 'unverified', error: error.message }); alive.push({ ...value, identityError: error.message }) }
    }
    cleanup.macExitAudit = audit; cleanup.remainingMac = alive; return alive
  }
  if (macIdentities.size) {
    try { await eventually(async () => (await remaining()).length === 0, 'Exact Mac helper/guardian/fixture identities remained after natural cleanup') }
    catch (error) { cleanup.errors.push(error.message) }
    cleanup.naturalRemainingMac = [...cleanup.remainingMac]
    cleanup.naturalMacExitAudit = [...(cleanup.macExitAudit ?? [])]
    for (const value of cleanup.remainingMac) { try { cleanup.forced.push(await oracle('killOwned', { identity: value })) } catch (error) { cleanup.errors.push(`Pinned Mac retirement: ${error.message}`) } }
    if (cleanup.forced.length) cleanup.errors.push('Forced Mac retirement was required; delivery cannot pass')
    try {
      await eventually(async () => (await remaining()).length === 0, 'Exact Mac identities survived pinned fallback')
      cleanup.postExitOsObservations = []
      await eventually(async () => {
        cleanup.finalOs = await oracle('snapshot'); cleanup.postExitOsObservations.push(cleanup.finalOs)
        return emptyOs(cleanup.finalOs)
      }, 'OS input did not return to empty during read-only post-exit observation; no input was replayed')
    }
    catch (error) { cleanup.errors.push(error.message) }
  }
  if (macIdentities.size) try {
    const result = await run(leaseAuditBinary, [], { timeout: 5000, maxBuffer: 65536 })
    cleanup.desktopLease = JSON.parse(result.stdout.trim()); assert.equal(cleanup.desktopLease.passed, true, 'Mac physical lease/journal did not return to empty')
  } catch (error) { cleanup.errors.push(`Mac physical lease cleanup: ${error.message}`) }
  fixtureLines?.close()
  if (server) { server.closeAllConnections(); if (serverListening) await new Promise(done => server.close(done)); serverListening = false }
  cleanup.trackedMac = [...macIdentities.values()]
  cleanup.trackedWindows = [...trackedWindows]
  cleanup.passed = reverseRemoteDeliveryPassed({ clientReport, setupError, cleanup })
  const passed = clientReport?.passed === true && !setupError && cleanup.passed
  const report = { passed, status: passed ? 'passed' : setupError?.code === 'SESSION_LOCKED' ? 'blocked' : 'failed', checks: clientReport?.checks ?? [], clientPassed: clientReport?.passed === true, orchestrationError: setupError, preflight, executableProofs, cleanup, testedAt: new Date().toISOString() }
  await writeFile(join(output, 'environment.json'), JSON.stringify(environment ?? { vm, guestRoot, clientNode: node, setupIncomplete: true }, null, 2) + '\n')
  await writeFile(join(output, 'ps-command-transport.json'), JSON.stringify(transport, null, 2) + '\n')
  await writeFile(join(output, 'oracle-invocations.json'), JSON.stringify(oracleInvocations, null, 2) + '\n')
  await writeFile(join(output, 'delivery-verdict.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ output, passed, checks: report.checks.length, clientPassed: report.clientPassed, cleanupPassed: cleanup.passed, error: setupError?.message, cleanupErrors: cleanup.errors }))
  if (!passed) process.exitCode = report.status === 'blocked' ? 2 : 1
}
