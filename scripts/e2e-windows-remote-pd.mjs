/** Actual Mac RemoteComputerDriver -> owned interactive Windows fixture. */
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { createInterface } from 'node:readline'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { windowsPinnedProcessCommand } from './computer-webview2-soak-evidence.mjs'
import { windowsRemoteDeliveryPassed, windowsRemoteNaturalExitPassed } from './windows-remote-delivery.mjs'
const run = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url))
const vm = process.env.QIUYA_PD_VM, host = process.env.QIUYA_PD_HOST_IP
if (process.platform !== 'darwin' || !vm || !/^[a-f0-9-]{36}$/iu.test(vm) || !host || !/^\d+\.\d+\.\d+\.\d+$/u.test(host)) throw new Error('Set QIUYA_PD_VM and QIUYA_PD_HOST_IP for the authorized Mac and selected test VM')
const prlctl = process.env.QIUYA_PRLCTL || '/Applications/Parallels Desktop.app/Contents/MacOS/prlctl'
const output = resolve(process.env.QIUYA_WINDOWS_REMOTE_OUTPUT || join(tmpdir(), 'qiuya-windows-remote-' + randomUUID()))
await mkdir(output, { recursive: true }); await mkdir(join(output, 'screenshots'), { recursive: true })
for (const name of ['report.json','delivery-verdict.json']) await stat(join(output,name)).then(() => { throw new Error('Use a fresh output directory') }, error => { if (error.code !== 'ENOENT') throw error })
const bundle = join(output, 'computer-agent.mjs')
const buildResult=await build({ stdin: { contents: "export {RemoteComputerDriver,createComputerAgentServer} from './src/features/computer-use/remote.ts'; export {NativeCompanionDriver} from './src/features/computer-use/native.ts'", resolveDir: repo }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile:true })
const sources=[]
for(const name of Object.keys(buildResult.metafile.inputs))if(name!=='<stdin>')sources.push({path:name,sha256:createHash('sha256').update(await readFile(resolve(repo,name))).digest('hex')})
await writeFile(join(output,'build-sources.json'),JSON.stringify(sources,null,2)+'\n')
const { RemoteComputerDriver } = await import(pathToFileURL(bundle).href)
const key = randomUUID(), token = randomBytes(32).toString('hex'), relaySecret = randomBytes(32).toString('hex')
const quote = value => "'" + value.replaceAll("'", "''") + "'", sha = value => createHash('sha256').update(value).digest('hex')
const cleanup={passed:false,errors:[],forced:[],guest:null,task:null,processes:null,transportRestoredForRelease:false}, checks=[], drivers=[], files=new Map(), transport=[]
let guestRoot,taskName,expectedTaskArguments,guestCreated=false,relaySocket,relayAuthenticated=false,nextId=0,bridge,proxy,transfer,allowReconnect=false,businessPassed=false,report={},expectedIdentities=[]
const bounded=error=>({message:String(error.message).split('\n')[0].replace(/ -EncodedCommand .*/u,' [command omitted]').slice(0,500),code:error.code??null})
const check=(id,detail={})=>checks.push({id,passed:true,detail}), delay=ms=>new Promise(done=>setTimeout(done,ms)), pending=new Map()
async function inlinePs(code,timeout=30000){
 const encoded=Buffer.from(code,'utf16le').toString('base64');assert.ok(encoded.length<=2000,'Guest bootstrap exceeds the verified short-command envelope')
 return(await run(prlctl,['exec',vm,'powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{timeout,killSignal:'SIGKILL',maxBuffer:16*1024*1024})).stdout.trim()
}
const transferUrl=name=>'http://'+host+':'+transfer.address().port+'/'+key+'/'+name
async function ps(code,timeout=30000){
 if(Buffer.from(code,'utf16le').toString('base64').length<=2000)return inlinePs(code,timeout)
 assert.ok(guestCreated&&transfer?.listening,'Long commands require the live authenticated owned-file transport')
 const name='command-'+randomUUID()+'.ps1',bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(code)]),path=guestRoot+'\\'+name
 files.set(name,bytes);transport.push({name,sha256:sha(bytes),bytes:bytes.length,method:'sha-verified-owned-file'})
 let transferred=false
 try{
  await inlinePs("$ErrorActionPreference='Stop';$p="+quote(path)+";$c=[Net.WebClient]::new();$c.Proxy=$null;try{$c.DownloadFile("+quote(transferUrl(name))+",$p)}finally{$c.Dispose()};if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne '"+sha(bytes)+"'){throw 'Command SHA mismatch'}")
  transferred=true
  return(await run(prlctl,['exec',vm,'powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path],{timeout,killSignal:'SIGKILL',maxBuffer:16*1024*1024})).stdout.trim()
 }finally{
  files.delete(name)
  if(transferred)try{await inlinePs("$ErrorActionPreference='Stop';Remove-Item -LiteralPath "+quote(path)+" -Force -ErrorAction Stop")}catch(error){cleanup.errors.push({stage:'owned-command-removal',...bounded(error)})}
 }
}
async function guestJson(name){const value=await ps('if(Test-Path -LiteralPath '+quote(guestRoot+'\\'+name)+'){[Convert]::ToBase64String([IO.File]::ReadAllBytes('+quote(guestRoot+'\\'+name)+'))}');return value?JSON.parse(Buffer.from(value,'base64').toString('utf8')):null}
async function checkpointGuest(){
 const sequence=randomUUID()
 await ps('[IO.File]::WriteAllText('+quote(guestRoot+'\\checkpoint-request')+','+quote(sequence)+')')
 const deadline=performance.now()+20000
 while(performance.now()<deadline){
  const value=await guestJson('checkpoint-ack.json')
  if(value?.sequence===sequence){assert.ok(Array.isArray(value.identities));expectedIdentities=value.identities;return}
  await delay(100)
 }
 throw new Error('Exact process checkpoint acknowledgement deadline')
}
async function restoreForRelease(){
 if(relayAuthenticated)return
 assert.ok(guestRoot&&taskName,'Guest was not started')
 allowReconnect=true
 await ps('[IO.File]::WriteAllText('+quote(guestRoot+'\\reconnect')+",'reconnect')")
 for(let i=0;i<100&&!relayAuthenticated;i++)await delay(100)
 assert.ok(relayAuthenticated,'The owned tunnel did not reconnect for release acknowledgement')
 cleanup.transportRestoredForRelease=true
}
async function closeServer(server){if(!server)return;server.closeAllConnections?.();await new Promise(done=>server.close(done))}
try{
 bridge=tcpServer(socket=>{
  if(relaySocket||(!allowReconnect&&nextId>0)){socket.destroy();return}
  relaySocket=socket;const lines=createInterface({input:socket})
  lines.on('line',line=>{
   try{
    const response=JSON.parse(line)
    if(!relayAuthenticated){if(response.hello!==relaySecret){socket.destroy();return};relayAuthenticated=true;allowReconnect=false;return}
    const request=pending.get(response.id);if(request){pending.delete(response.id);clearTimeout(request.timer);request.resolve(response)}
   }catch{socket.destroy()}
  })
  socket.on('close',()=>{
   lines.close();if(relaySocket!==socket)return;relaySocket=undefined;relayAuthenticated=false
   for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Test tunnel disconnected'))};pending.clear()
  })
 })
 await new Promise((done,reject)=>{bridge.once('error',reject);bridge.listen(0,host,done)})
 proxy=httpServer(async(incoming,outgoing)=>{
  try{
   if(!relayAuthenticated||incoming.method!=='POST'||incoming.url!=='/v1/computer'){outgoing.writeHead(503).end();return}
   const parts=[];let bytes=0
   for await(const part of incoming){bytes+=part.length;if(bytes>512*1024)throw new Error('Tunnel request limit');parts.push(part)}
   const id=++nextId,response=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Test tunnel timed out'))},30000);pending.set(id,{resolve,reject,timer})
    relaySocket.write(JSON.stringify({id,method:'POST',headers:{'Content-Type':'application/json',...(incoming.headers.authorization?{Authorization:incoming.headers.authorization}:{}),...(incoming.headers.origin?{Origin:incoming.headers.origin}:{})},body:Buffer.concat(parts).toString('base64')})+'\n')
   })
   const body=Buffer.from(response.body,'base64');outgoing.writeHead(response.status,{'Content-Type':'application/json','Content-Length':body.length});outgoing.end(body)
  }catch{outgoing.writeHead(502).end('{"error":"test tunnel disconnected"}')}
 })
 await new Promise(done=>proxy.listen(0,'127.0.0.1',done))
 const endpoint='http://127.0.0.1:'+proxy.address().port+'/v1/computer'
 for(const[name,path]of[
  ['helper.exe',process.env.QIUYA_WINDOWS_HELPER||join(repo,'lib/native/win32-arm64/qiuya-windows.exe')],['node.zip',process.env.QIUYA_WINDOWS_NODE_ZIP||'/private/tmp/qyt-node-v22.23.3-win-arm64.zip'],['computer-agent.js',bundle],['computer-agent.mjs',join(repo,'scripts/computer-agent.mjs')],['remote-agent.mjs',join(repo,'tests/fixtures/windows-remote-agent.mjs')],['windows-remote-audit.cs',join(repo,'tests/fixtures/windows-remote-audit.cs')],['remote-relay.mjs',join(repo,'src/native/windows/remote-relay.mjs')],['remote-e2e.ps1',join(repo,'src/native/windows/remote-e2e.ps1')]
 ])files.set(name,await readFile(path))
 files.set('token.txt',Buffer.from(token));files.set('package.json',Buffer.from('{"type":"module"}'));files.set('relay-config.json',Buffer.from(JSON.stringify({host,port:bridge.address().port,secret:relaySecret})))
 transfer=httpServer((request,response)=>{const path=request.url?.split('/'),file=request.method==='GET'&&path?.[1]===key&&files.get(path[2]);if(!file){response.writeHead(404).end();return};response.writeHead(200,{'Content-Length':file.length});response.end(file)})
 await new Promise((done,reject)=>{transfer.once('error',reject);transfer.listen(0,host,done)})
 const identity=JSON.parse(await ps("$u=(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -First 1).UserName;$s=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value;$p=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$s)).ProfileImagePath;@{user=$u;profile=$p}|ConvertTo-Json -Compress"))
 guestRoot=identity.profile+'\\AppData\\Local\\Temp\\QiuYaTools-remote-'+key;taskName='QiuYaTools-remote-'+key
 await ps('New-Item -ItemType Directory -Force '+quote(guestRoot)+','+quote(guestRoot+'\\lib')+','+quote(guestRoot+'\\scripts')+'|Out-Null');guestCreated=true
 for(const[name,destination]of[['helper.exe','qiuya-windows.exe'],['node.zip','node.zip'],['computer-agent.js','lib\\computer-agent.js'],['computer-agent.mjs','scripts\\computer-agent.mjs'],['remote-agent.mjs','remote-agent.mjs'],['windows-remote-audit.cs','windows-remote-audit.cs'],['remote-relay.mjs','remote-relay.mjs'],['remote-e2e.ps1','remote-e2e.ps1'],['token.txt','token.txt'],['package.json','package.json'],['relay-config.json','relay-config.json']]){
  const expected=sha(files.get(name))
  await ps("$ErrorActionPreference='Stop';$p="+quote(guestRoot+'\\'+destination)+";$c=[Net.WebClient]::new();$c.Proxy=$null;try{$c.DownloadFile("+quote(transferUrl(name))+",$p)}finally{$c.Dispose()};if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne '"+expected+"'){throw 'Transferred file SHA mismatch'}",90000)
 }
 const expected=sha(files.get('helper.exe'))
 await ps("$ErrorActionPreference='Stop';Expand-Archive -LiteralPath "+quote(guestRoot+'\\node.zip')+' -DestinationPath '+quote(guestRoot),90000)
 const argumentsText='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+guestRoot+'\\remote-e2e.ps1" -Root "'+guestRoot+'"'
 expectedTaskArguments=argumentsText
 await ps("$ErrorActionPreference='Stop';$e=$null;$t=$null;$null=[Management.Automation.Language.Parser]::ParseFile("+quote(guestRoot+'\\remote-e2e.ps1')+",[ref]$t,[ref]$e);if(@($e).Count -gt 0){throw ('Guest runner syntax: '+$e[0].Message)}")
 await ps("$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "+quote(argumentsText)+';$p=New-ScheduledTaskPrincipal -UserId '+quote(identity.user)+" -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName "+quote(taskName)+' -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName '+quote(taskName))
 let ready
 for(let i=0;i<100;i++){ready=await guestJson('ready.json');if(ready)break;const failure=await ps('if(Test-Path -LiteralPath '+quote(guestRoot+'\\startup-error.txt')+'){Get-Content -LiteralPath '+quote(guestRoot+'\\startup-error.txt')+' -Raw}');if(failure)throw new Error(failure);await delay(300)}
 assert.ok(ready);assert.ok(ready.sessionId>0);assert.equal(ready.nodeVersion,'v22.23.3');assert.equal(ready.architecture,'arm64');assert.equal(ready.platform,'win32')
 expectedIdentities=await guestJson('process-checkpoint.json');assert.ok(Array.isArray(expectedIdentities)&&expectedIdentities.length>=4)
 for(let i=0;i<100&&!relayAuthenticated;i++)await delay(100)
 assert.ok(relayAuthenticated);check('REMOTE-WIN-INTERACTIVE-01',{sessionId:ready.sessionId,transport:'Mac loopback HTTP → authenticated private reverse TCP tunnel → Windows loopback agent'})
 const driver = new RemoteComputerDriver({ endpoint, token, clientId: 'mac-windows-e2e', heartbeatMs: 300, timeoutMs: 15000 }); drivers.push(driver)
 const status = await driver.status(); assert.equal(status.available,true); assert.equal(status.platform,'win32'); check('REMOTE-WIN-STATUS-01', status)
 const unauthorized = await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${'x'.repeat(64)}`,'Content-Type':'application/json'},body:JSON.stringify({version:1,requestId:1,clientId:'unauthorized',op:'status',payload:{}})});assert.equal(unauthorized.status,401);check('REMOTE-WIN-AUTH-01')
 const version = await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({version:999,requestId:1,clientId:'invalid-version',op:'status',payload:{}})});assert.equal((await version.json()).error.code,'VERSION_MISMATCH');check('REMOTE-WIN-VERSION-01')
 const origin = await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Origin:'https://untrusted.test'},body:JSON.stringify({version:1,requestId:1,clientId:'origin-test',op:'status',payload:{}})});assert.equal((await origin.json()).error.code,'ORIGIN_DENIED');check('REMOTE-WIN-ORIGIN-01')
 const targets = await driver.targets();const target = targets.find(target=>target.pid===ready.fixturePid&&target.title==='QiuYaTools Windows Test Fixture');assert.ok(target);assert.ok(target.appId.startsWith(driver.deviceId+':'));check('REMOTE-WIN-TARGET-01')
 const frame=await driver.observe(target.id);assert.ok(frame.elements.includes('Fixture click button'));assert.ok(Number.isFinite(frame.cursor?.x)&&Number.isFinite(frame.cursor?.y)&&typeof frame.cursor.visible==='boolean');assert.equal(Buffer.from(frame.imageBase64,'base64').readUInt16BE(),0xffd8);await writeFile(join(output,'screenshots','remote-fixture.jpg'),Buffer.from(frame.imageBase64,'base64'));check('REMOTE-WIN-OBSERVE-01',{width:frame.width,height:frame.height})
 const point=name=>{const line=frame.elements.split('\n').find(line=>line.includes(`name=${name} `));assert.ok(line);const match=/bounds=([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)/u.exec(line);return{x:Number(match[1])+Number(match[3])/2-frame.geometry.x,y:Number(match[2])+Number(match[4])/2-frame.geometry.y}}
 const fixtureState=async()=>{const bytes=await ps(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${quote(`${guestRoot}\\fixture-state.json`)}))`);return JSON.parse(Buffer.from(bytes,'base64').toString('utf8'))}
 await driver.lease(1);await checkpointGuest();await driver.act(1,target.id,{kind:'click',...point('Fixture click button')});assert.equal((await fixtureState()).clicks,1);check('REMOTE-WIN-CLICK-01')
 await driver.act(1,target.id,{kind:'click',...point('Fixture text input')});const text='Mac to Windows 中文🙂';await driver.act(1,target.id,{kind:'type',text});assert.equal((await fixtureState()).text,text);check('REMOTE-WIN-UNICODE-01')
 const competitor=new RemoteComputerDriver({endpoint,token,clientId:'competing-mac-client'});drivers.push(competitor);await assert.rejects(competitor.lease(1),error=>error.code==='DEVICE_BUSY');check('REMOTE-WIN-EXCLUSIVE-01')
 await driver.release(1);await assert.rejects(driver.act(1,target.id,{kind:'key',key:'CTRL+A'}),error=>error.code==='CONTROL_CHANGED');check('REMOTE-WIN-RELEASE-01')
 await driver.lease(2);await checkpointGuest();await driver.act(2,target.id,{kind:'key',key:'CTRL+A'});await driver.act(2,target.id,{kind:'type',text:'resumed'});assert.equal((await fixtureState()).text,'resumed');check('REMOTE-WIN-RESUME-01')
 const previews=[];for(let i=0;i<12;i++){const start=performance.now();const observed=await driver.preview(target.id);assert.equal(observed.elements,'');previews.push(performance.now()-start)};check('REMOTE-WIN-PREVIEW-01',{frames:previews.length,averageRoundTripMs:previews.reduce((a,b)=>a+b,0)/previews.length})
 await driver.release(2)
 await driver.lease(3)
 await checkpointGuest()
 // Deliberately sever the test tunnel, leaving the real agent alive to expire its heartbeat lease.
 const disconnected=[];driver.subscribe(event=>disconnected.push(event));relaySocket.destroy();await new Promise(done=>setTimeout(done,6500));assert.ok(disconnected.some(event=>event.event==='disconnected'));check('REMOTE-WIN-DISCONNECT-01')
 // A local guest-side HTTP probe must find the old client lease expired.
 const probe=`import{readFile}from'node:fs/promises';const token=(await readFile(process.argv[3],'utf8')).trim();const r=await fetch(process.argv[2],{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({version:1,requestId:99,clientId:'mac-windows-e2e',op:'act',payload:{epoch:3,targetId:process.argv[4],action:{kind:'key',key:'CTRL+A'}}})});console.log(JSON.stringify(await r.json()));`
 files.set('lease-probe.mjs',Buffer.from(probe));await ps(`$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(transferUrl('lease-probe.mjs'))},${quote(`${guestRoot}\\lease-probe.mjs`)})`)
 const result=JSON.parse(await ps(`& ${quote(ready.node)} ${quote(`${guestRoot}\\lease-probe.mjs`)} ${quote(ready.endpoint)} ${quote(`${guestRoot}\\token.txt`)} ${quote(target.id)}`));assert.equal(result.error.code,'CONTROL_CHANGED');check('REMOTE-WIN-HEARTBEAT-REVOKE-01')

 businessPassed=true
 report={architecture:status.architecture,sessionId:ready.sessionId,guestRoot,helperSha256:expected,nodeVersion:'v22.23.3',transport:'private reverse tunnel; no guest inbound firewall changes'}
}catch(error){report={...report,error:bounded(error),guestRoot};process.exitCode=1}
finally{
 // The intentional disconnect leaves an uncertain owned epoch on the real Mac
 // driver. Restore only this tunnel, then require its real release ACK; no act
 // or lease is replayed during cleanup.
 if(drivers.length&&!relayAuthenticated)try{await restoreForRelease()}catch(error){cleanup.errors.push({stage:'release-transport',...bounded(error)})}
 for(const driver of drivers)try{await driver.dispose()}catch(error){cleanup.errors.push({stage:'production-driver-dispose',...bounded(error)})}
 relaySocket?.end();relaySocket?.destroy()
 if(guestCreated){
  try{await ps('[IO.File]::WriteAllText('+quote(guestRoot+'\\stop')+",'stop')")}catch(error){cleanup.errors.push({stage:'guest-stop-request',...bounded(error)})}
  try{
   const deadline=performance.now()+60000
   while(performance.now()<deadline){
    cleanup.guest=await guestJson('guest-cleanup.json')
    const value=JSON.parse(await ps("$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName "+quote(taskName)+';$i=Get-ScheduledTaskInfo -TaskName '+quote(taskName)+";@{state=$t.State.ToString();result=[long]$i.LastTaskResult}|ConvertTo-Json -Compress"))
    if(value.state==='Ready'){cleanup.task={...value,unregistered:false,stopRequired:false};break};await delay(200)
   }
   cleanup.guest=await guestJson('guest-cleanup.json')
   cleanup.processBindings=await guestJson('process-binding.json')
   cleanup.bindingPolicySelfTest=await guestJson('binding-policy-selftest.json')
   assert.equal(cleanup.task?.state,'Ready','The owned task did not retire naturally')
  }catch(error){cleanup.errors.push({stage:'natural-task-exit',...bounded(error)})}
  try{
   const latest=await guestJson('process-checkpoint.json');if(latest){assert.ok(Array.isArray(latest),'Owned process checkpoint must be an array');expectedIdentities=latest}
   assert.ok(expectedIdentities.length,'Exact owned process identities were not collected')
   for(let i=0;i<30;i++){
    cleanup.processes=JSON.parse(await ps(windowsPinnedProcessCommand(expectedIdentities)))
    if(windowsRemoteNaturalExitPassed(cleanup.processes,expectedIdentities))break;await delay(200)
   }
   if(!windowsRemoteNaturalExitPassed(cleanup.processes,expectedIdentities)){
    cleanup.forced.push('exact-pinned-process-fallback')
    cleanup.forcedProcessAudit=JSON.parse(await ps(windowsPinnedProcessCommand(expectedIdentities,{terminate:true})))
   }
  }catch(error){cleanup.errors.push({stage:'pinned-process-retirement',...bounded(error)})}
  if(taskName)try{
   if(cleanup.task?.state!=='Ready'){
    // Verify the unique action directory immediately before stopping this
    // task. Never stop another task by process name or wildcard.
    cleanup.forced.push('owned-task-stop');cleanup.task={...(cleanup.task??{}),stopRequired:true}
    await ps("$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName "+quote(taskName)+';if(@($t.Actions).Count -ne 1 -or $t.Actions[0].Execute -ine '+quote('powershell.exe')+' -or $t.Actions[0].Arguments -cne '+quote(expectedTaskArguments)+"){throw 'Task action ownership changed'};Stop-ScheduledTask -TaskName "+quote(taskName))
   }
   await ps("$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName "+quote(taskName)+';if(@($t.Actions).Count -ne 1 -or $t.Actions[0].Execute -ine '+quote('powershell.exe')+' -or $t.Actions[0].Arguments -cne '+quote(expectedTaskArguments)+"){throw 'Task action ownership changed'};Unregister-ScheduledTask -TaskName "+quote(taskName)+" -Confirm:$false;if(Get-ScheduledTask -TaskName "+quote(taskName)+" -ErrorAction SilentlyContinue){throw 'Owned task registration survived'}")
   cleanup.task={...(cleanup.task??{}),unregistered:true}
  }catch(error){cleanup.errors.push({stage:'owned-task-unregister',...bounded(error)})}
  // A failed startup may never reach the wrapper's deletion path. Delete only
  // this runner's private files; this fallback cannot make delivery pass.
  if(cleanup.guest?.secretsDeleted!==true)try{await ps("$ErrorActionPreference='Stop';foreach($n in @('token.txt','relay-config.json','relay-runtime.json')){$p=Join-Path "+quote(guestRoot)+" $n;if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -ErrorAction Stop}}")}
  catch(error){cleanup.errors.push({stage:'private-file-fallback',...bounded(error)})}
 }
 files.delete('token.txt');files.delete('relay-config.json');files.clear()
 for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Runner closed'))};pending.clear()
 relaySocket?.destroy()
 for(const[stage,server]of[['proxy',proxy],['transfer',transfer],['bridge',bridge]])try{await closeServer(server)}catch(error){cleanup.errors.push({stage:stage+'-close',...bounded(error)})}
 cleanup.passed=windowsRemoteDeliveryPassed({businessPassed,cleanup,expectedIdentities})
 const result={...report,passed:cleanup.passed,businessPassed,checks,cleanup,expectedIdentities,transportCommands:transport,output}
 await writeFile(join(output,'report.json'),JSON.stringify(result,null,2)+'\n')
 await writeFile(join(output,'delivery-verdict.json'),JSON.stringify({passed:cleanup.passed,businessPassed,checks:checks.length,naturalExitPassed:windowsRemoteNaturalExitPassed(cleanup.processes,expectedIdentities),forced:cleanup.forced,errors:cleanup.errors},null,2)+'\n')
 console.log(JSON.stringify({passed:cleanup.passed,businessPassed,checks:checks.length,output},null,2));if(!cleanup.passed)process.exitCode=1
}
