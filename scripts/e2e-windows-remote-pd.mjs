import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { createInterface } from 'node:readline'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
const run = promisify(execFile)
const vm = process.env.QIUYA_PD_VM, host = process.env.QIUYA_PD_HOST_IP
if (!vm || !/^[a-f0-9-]{36}$/iu.test(vm) || !host || !/^\d+\.\d+\.\d+\.\d+$/u.test(host)) throw new Error('Set QIUYA_PD_VM and QIUYA_PD_HOST_IP to the selected test VM and host-only address')
const prlctl = process.env.QIUYA_PRLCTL || '/Applications/Parallels Desktop.app/Contents/MacOS/prlctl'
const output = resolve(process.env.QIUYA_WINDOWS_REMOTE_OUTPUT || join(tmpdir(), `qiuya-windows-remote-${randomUUID()}`))
await mkdir(output, { recursive: true })
const bundle = join(output, 'computer-agent.mjs')
await build({ stdin: { contents: "export {RemoteComputerDriver,createComputerAgentServer} from './src/features/computer-use/remote.ts'; export {NativeCompanionDriver} from './src/features/computer-use/native.ts'", resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22' })
const { RemoteComputerDriver } = await import(pathToFileURL(bundle).href)
const key = randomUUID(), token = randomBytes(32).toString('hex'), relaySecret = randomBytes(32).toString('hex')
const quote = value => `'${value.replaceAll("'", "''")}'`
async function ps(code, timeout = 30000) {
 const result = await run(prlctl, ['exec', vm, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })
 return result.stdout.trim()
}
let relaySocket, relayLines, relayAuthenticated = false, nextId = 0
const pending = new Map()
const bridge = tcpServer(socket => {
 if (relaySocket) { socket.destroy(); return }
 relaySocket = socket; relayLines = createInterface({ input: socket })
 relayLines.on('line', line => {
  try {
   const response = JSON.parse(line)
   if (!relayAuthenticated) { if (response.hello !== relaySecret) { socket.destroy(); return }; relayAuthenticated = true; return }
   const request = pending.get(response.id)
   if (request) { pending.delete(response.id); clearTimeout(request.timer); request.resolve(response) }
  } catch { socket.destroy() }
 })
 socket.on('close', () => { relayAuthenticated = false; for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Test tunnel disconnected')) }; pending.clear() })
})
await new Promise((done, reject) => { bridge.once('error', reject); bridge.listen(0, host, done) })
const proxy = httpServer(async (incoming, outgoing) => {
 try {
  if (!relayAuthenticated || incoming.method !== 'POST' || incoming.url !== '/v1/computer') { outgoing.writeHead(503).end(); return }
  const parts = []; let bytes = 0
  for await (const part of incoming) { bytes += part.length; if (bytes > 512 * 1024) throw new Error('Tunnel request limit'); parts.push(part) }
  const id = ++nextId
  const response = await new Promise((resolve, reject) => {
   const timer = setTimeout(() => { pending.delete(id); reject(new Error('Test tunnel timed out')) }, 30000)
   pending.set(id, { resolve, reject, timer })
   relaySocket.write(JSON.stringify({ id, method: 'POST', headers: { 'Content-Type': 'application/json', ...(incoming.headers.authorization ? { Authorization: incoming.headers.authorization } : {}), ...(incoming.headers.origin ? { Origin: incoming.headers.origin } : {}) }, body: Buffer.concat(parts).toString('base64') }) + '\n')
  })
  const body = Buffer.from(response.body, 'base64')
  outgoing.writeHead(response.status, { 'Content-Type': 'application/json', 'Content-Length': body.length }); outgoing.end(body)
 } catch { outgoing.writeHead(502).end('{"error":"test tunnel disconnected"}') }
})
await new Promise(done => proxy.listen(0, '127.0.0.1', done))
const endpoint = `http://127.0.0.1:${proxy.address().port}/v1/computer`
const files = new Map([
 ['helper.exe', await readFile(process.env.QIUYA_WINDOWS_HELPER || new URL('../lib/native/win32-arm64/qiuya-windows.exe', import.meta.url))],
 ['node.zip', await readFile(process.env.QIUYA_WINDOWS_NODE_ZIP || '/private/tmp/qyt-node-v22.23.3-win-arm64.zip')],
 ['computer-agent.js', await readFile(bundle)], ['computer-agent.mjs', await readFile(new URL('./computer-agent.mjs', import.meta.url))],
 ['remote-relay.mjs', await readFile(new URL('../src/native/windows/remote-relay.mjs', import.meta.url))], ['remote-e2e.ps1', await readFile(new URL('../src/native/windows/remote-e2e.ps1', import.meta.url))],
 ['token.txt', Buffer.from(token)], ['package.json', Buffer.from('{"type":"module"}')], ['relay-config.json', Buffer.from(JSON.stringify({ host, port: bridge.address().port, secret: relaySecret }))]
])
const transfer = httpServer((request, response) => {
 const path = request.url?.split('/'); const file = request.method === 'GET' && path?.[1] === key && files.get(path[2])
 if (!file) { response.writeHead(404).end(); return }
 response.writeHead(200, { 'Content-Length': file.length }); response.end(file)
})
await new Promise((done, reject) => { transfer.once('error', reject); transfer.listen(0, host, done) })
const transferUrl = name => `http://${host}:${transfer.address().port}/${key}/${name}`
const checks = [], drivers = []
const check = (id, detail = {}) => checks.push({ id, passed: true, detail })
let guestRoot, taskName
try {
 const identity = JSON.parse(await ps(`$u=(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -First 1).UserName;$s=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value;$p=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$s)).ProfileImagePath;@{user=$u;profile=$p}|ConvertTo-Json -Compress`))
 guestRoot = `${identity.profile}\\AppData\\Local\\Temp\\QiuYaTools-remote-${key}`; taskName = `QiuYaTools-remote-${key}`
 await ps(`New-Item -ItemType Directory -Force ${quote(guestRoot)},${quote(`${guestRoot}\\lib`)},${quote(`${guestRoot}\\scripts`)}|Out-Null`)
 for (const [name, destination] of [['helper.exe','qiuya-windows.exe'],['node.zip','node.zip'],['computer-agent.js','lib\\computer-agent.js'],['computer-agent.mjs','scripts\\computer-agent.mjs'],['remote-relay.mjs','remote-relay.mjs'],['remote-e2e.ps1','remote-e2e.ps1'],['token.txt','token.txt'],['package.json','package.json'],['relay-config.json','relay-config.json']]) {
  await ps(`$ErrorActionPreference='Stop';$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(transferUrl(name))},${quote(`${guestRoot}\\${destination}`)})`, 90000)
 }
 console.error('[qiuya-remote] selected artifacts transferred')
 const expected = createHash('sha256').update(files.get('helper.exe')).digest('hex')
 await ps(`$ErrorActionPreference='Stop';if((Get-FileHash ${quote(`${guestRoot}\\qiuya-windows.exe`)} -Algorithm SHA256).Hash.ToLowerInvariant() -ne ${quote(expected)}){throw 'Helper transfer integrity'};Expand-Archive -Path ${quote(`${guestRoot}\\node.zip`)} -DestinationPath ${quote(guestRoot)} -Force`, 90000)
 const argumentsText = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${guestRoot}\\remote-e2e.ps1" -Root "${guestRoot}"`
 await ps(`$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(argumentsText)};$p=New-ScheduledTaskPrincipal -UserId ${quote(identity.user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${quote(taskName)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(taskName)}`)
 let ready
 for (let i = 0; i < 100; i++) {
  const value = await ps(`if(Test-Path ${quote(`${guestRoot}\\startup-error.txt`)}){throw (Get-Content ${quote(`${guestRoot}\\startup-error.txt`)} -Raw)};if(Test-Path ${quote(`${guestRoot}\\ready.json`)}){[Convert]::ToBase64String([IO.File]::ReadAllBytes(${quote(`${guestRoot}\\ready.json`)}))}`)
  if (value) { ready = JSON.parse(Buffer.from(value, 'base64').toString('utf8')); break }
  await new Promise(done => setTimeout(done, 300))
 }
 assert.ok(ready); assert.equal(ready.sessionId, 1)
 for (let i=0; i<100 && !relayAuthenticated; i++) await new Promise(done=>setTimeout(done,100))
 assert.ok(relayAuthenticated); check('REMOTE-WIN-INTERACTIVE-01', { sessionId: ready.sessionId, transport: 'Mac loopback HTTP → authenticated private reverse TCP tunnel → Windows loopback agent' })
 const driver = new RemoteComputerDriver({ endpoint, token, clientId: 'mac-windows-e2e', heartbeatMs: 300, timeoutMs: 15000 }); drivers.push(driver)
 const status = await driver.status(); assert.equal(status.available,true); assert.equal(status.platform,'win32'); check('REMOTE-WIN-STATUS-01', status)
 const unauthorized = await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${'x'.repeat(64)}`,'Content-Type':'application/json'},body:JSON.stringify({version:1,requestId:1,clientId:'unauthorized',op:'status',payload:{}})});assert.equal(unauthorized.status,401);check('REMOTE-WIN-AUTH-01')
 const version = await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({version:999,requestId:1,clientId:'invalid-version',op:'status',payload:{}})});assert.equal((await version.json()).error.code,'VERSION_MISMATCH');check('REMOTE-WIN-VERSION-01')
 const origin = await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Origin:'https://untrusted.test'},body:JSON.stringify({version:1,requestId:1,clientId:'origin-test',op:'status',payload:{}})});assert.equal((await origin.json()).error.code,'ORIGIN_DENIED');check('REMOTE-WIN-ORIGIN-01')
 const targets = await driver.targets();const target = targets.find(target=>target.pid===ready.fixturePid&&target.title==='QiuYaTools Windows Test Fixture');assert.ok(target);assert.ok(target.appId.startsWith(driver.deviceId+':'));check('REMOTE-WIN-TARGET-01')
 const frame=await driver.observe(target.id);assert.ok(frame.elements.includes('Fixture click button'));assert.ok(Number.isFinite(frame.cursor?.x)&&Number.isFinite(frame.cursor?.y)&&typeof frame.cursor.visible==='boolean');assert.equal(Buffer.from(frame.imageBase64,'base64').readUInt16BE(),0xffd8);await writeFile(join(output,'remote-fixture.jpg'),Buffer.from(frame.imageBase64,'base64'));check('REMOTE-WIN-OBSERVE-01',{width:frame.width,height:frame.height})
 const point=name=>{const line=frame.elements.split('\n').find(line=>line.includes(`name=${name} `));assert.ok(line);const match=/bounds=([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)/u.exec(line);return{x:Number(match[1])+Number(match[3])/2-frame.geometry.x,y:Number(match[2])+Number(match[4])/2-frame.geometry.y}}
 const fixtureState=async()=>{const bytes=await ps(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${quote(`${guestRoot}\\fixture-state.json`)}))`);return JSON.parse(Buffer.from(bytes,'base64').toString('utf8'))}
 await driver.lease(1);await driver.act(1,target.id,{kind:'click',...point('Fixture click button')});assert.equal((await fixtureState()).clicks,1);check('REMOTE-WIN-CLICK-01')
 await driver.act(1,target.id,{kind:'click',...point('Fixture text input')});const text='Mac to Windows 中文🙂';await driver.act(1,target.id,{kind:'type',text});assert.equal((await fixtureState()).text,text);check('REMOTE-WIN-UNICODE-01')
 const competitor=new RemoteComputerDriver({endpoint,token,clientId:'competing-mac-client'});drivers.push(competitor);await assert.rejects(competitor.lease(1),error=>error.code==='DEVICE_BUSY');check('REMOTE-WIN-EXCLUSIVE-01')
 await driver.release(1);await assert.rejects(driver.act(1,target.id,{kind:'key',key:'CTRL+A'}),error=>error.code==='CONTROL_CHANGED');check('REMOTE-WIN-RELEASE-01')
 await driver.lease(2);await driver.act(2,target.id,{kind:'key',key:'CTRL+A'});await driver.act(2,target.id,{kind:'type',text:'resumed'});assert.equal((await fixtureState()).text,'resumed');check('REMOTE-WIN-RESUME-01')
 const previews=[];for(let i=0;i<12;i++){const start=performance.now();const observed=await driver.preview(target.id);assert.equal(observed.elements,'');previews.push(performance.now()-start)};check('REMOTE-WIN-PREVIEW-01',{frames:previews.length,averageRoundTripMs:previews.reduce((a,b)=>a+b,0)/previews.length})
 await driver.release(2)
 await driver.lease(3)
 // Deliberately sever the test tunnel, leaving the real agent alive to expire its heartbeat lease.
 const disconnected=[];driver.subscribe(event=>disconnected.push(event));relaySocket.destroy();await new Promise(done=>setTimeout(done,6500));assert.ok(disconnected.some(event=>event.event==='disconnected'));check('REMOTE-WIN-DISCONNECT-01')
 // A local guest-side HTTP probe must find the old client lease expired.
 const probe=`import{readFile}from'node:fs/promises';const token=(await readFile(process.argv[3],'utf8')).trim();const r=await fetch(process.argv[2],{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({version:1,requestId:99,clientId:'mac-windows-e2e',op:'act',payload:{epoch:3,targetId:process.argv[4],action:{kind:'key',key:'CTRL+A'}}})});console.log(JSON.stringify(await r.json()));`
 files.set('lease-probe.mjs',Buffer.from(probe));await ps(`$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(transferUrl('lease-probe.mjs'))},${quote(`${guestRoot}\\lease-probe.mjs`)})`)
 const result=JSON.parse(await ps(`& ${quote(ready.node)} ${quote(`${guestRoot}\\lease-probe.mjs`)} ${quote(ready.endpoint)} ${quote(`${guestRoot}\\token.txt`)} ${quote(target.id)}`));assert.equal(result.error.code,'CONTROL_CHANGED');check('REMOTE-WIN-HEARTBEAT-REVOKE-01')
 await writeFile(join(output,'report.json'),JSON.stringify({passed:true,checks,architecture:status.architecture,sessionId:ready.sessionId,guestRoot,helperSha256:expected,nodeVersion:'v22.23.3',transport:'private reverse tunnel; no guest inbound firewall changes'},null,2)+'\n')
 console.log(JSON.stringify({passed:true,checks:checks.length,output,guestRoot},null,2))
}catch(error){await writeFile(join(output,'report.json'),JSON.stringify({passed:false,checks,error:error.message,stack:error.stack,guestRoot},null,2)+'\n');console.log(JSON.stringify({passed:false,checks:checks.length,error:error.message,output},null,2));process.exitCode=1}
finally{
 for(const driver of drivers)await driver.dispose().catch(()=>{})
 if(guestRoot)await ps(`[IO.File]::WriteAllText(${quote(`${guestRoot}\\stop`)},'stop')`).catch(()=>{})
 if(taskName)await ps(`Stop-ScheduledTask -TaskName ${quote(taskName)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${quote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(()=>{})
 relaySocket?.destroy();bridge.close();proxy.closeAllConnections();transfer.closeAllConnections();await Promise.all([new Promise(done=>proxy.close(done)),new Promise(done=>transfer.close(done))])
}
