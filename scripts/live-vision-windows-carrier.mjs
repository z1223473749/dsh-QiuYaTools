/** Mac-side test-only reverse relay. Windows initiates all cross-VM connections. */
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPrivateJSON, writePrivateJSON, removePrivateJSON, externalFile } from './live-vision-external-core.mjs'
import { WindowsVisionQueue, winVisionConfig, winVisionRequest, winVisionBinding, validateWindowsIdentity, exactWindowsTarget, windowsPath, winVisionFail as fail } from './live-vision-windows-carrier-core.mjs'
import { windowsVisionAuditPrelude, windowsVisionPinFunction, windowsVisionDesktopPassed } from './live-vision-windows-audit.mjs'
import { createWindowsCarrierDiagnostics, projectWindowsCarrierError } from './live-vision-windows-diagnostics.mjs'
import { validateWindowsVisionCancel, windowsVisionCancelGuestPassed, windowsVisionTerminal } from './live-vision-windows-cancel.mjs'
const exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex'),sleep=ms=>new Promise(r=>setTimeout(r,ms)),quote=s=>`'${s.replaceAll("'","''")}'`
const auth=(value,token)=>{const a=Buffer.from(value??''),b=Buffer.from('Bearer '+token);return a.length===b.length&&timingSafeEqual(a,b)}
const readBody=async(req,max=512*1024)=>{let n=0;const parts=[];for await(const part of req){n+=part.length;if(n>max)fail('VISION_WINDOWS_BODY_LIMIT');parts.push(part)}return Buffer.concat(parts).toString('utf8')}
const json=(res,value,status=200)=>{const data=JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}).end(data)}
export const windowsVisionPrincipalQuery=`$ErrorActionPreference='Stop';$explorer=Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -First 1;$u=$explorer.UserName;if(!$u-or $explorer.SessionId-le 0){throw 'No interactive user'};$sid=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value;$p=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$sid)).ProfileImagePath;@{user=$u;sid=$sid;profile=$p;sessionId=$explorer.SessionId}|ConvertTo-Json -Compress`
export async function runWindowsVisionCarrier(configPath){
 if(process.platform!=='darwin')fail('VISION_MAC_REQUIRED')
 const cfg=winVisionConfig(await readPrivateJSON(resolve(configPath))),evidence=join(cfg.directory,'evidence'),bundleDir=dirname(cfg.carrier)
 if(cfg.probeOnly===true)fail('VISION_WINDOWS_PROBE_NO_CARRIER')
 const vm=cfg.vm,host=cfg.host??'10.211.55.2',guestIp='10.211.55.3',prl='/Applications/Parallels Desktop.app/Contents/MacOS/prlctl'
 if(!/^[a-f0-9-]{36}$/u.test(vm??'')||host!=='10.211.55.2')fail('VISION_WINDOWS_VM_CONFIG')
 const nodeGuestPath=cfg.nodeGuestPath,nodeSha256=cfg.nodeSha256
 windowsPath(nodeGuestPath);if(!/^[a-f0-9]{64}$/u.test(nodeSha256??''))fail('VISION_WINDOWS_NODE_CONFIG')
 await mkdir(evidence,{recursive:true,mode:0o700})
 const diagnostics=createWindowsCarrierDiagnostics({runId:cfg.runId,evidence})
 const manifest=await diagnostics.stage('verify-frozen-inputs',async()=>{
  const value=JSON.parse(await readFile(join(bundleDir,'windows-carrier-manifest.json'),'utf8'))
  if(value.auditSha256!==cfg.auditSha256)fail('VISION_WINDOWS_AUDIT_SOURCE_CHANGED')
  for(const [path,expected]of[[cfg.native,cfg.nativeSha256],[cfg.fixture,cfg.fixtureSha256],[cfg.carrier,cfg.carrierSha256],[join(bundleDir,'windows-guest.mjs'),value.guestSha256],[join(bundleDir,'windows-remote-audit.cs'),cfg.auditSha256]])if(sha(await readFile(path))!==expected)fail('VISION_WINDOWS_SOURCE_CHANGED')
  return value
 })
 const bridgeToken=randomBytes(32).toString('hex'),fileKey=randomBytes(24).toString('hex'),queue=new WindowsVisionQueue({timeoutMs:30000}),files=new Map(),records=[],cleanupErrors=[]
 let active,hello,stopping=false,fatal,failureDiagnostic,guestRoot,taskName,taskArguments,principal,oldIdle,restored=false,naturalTaskExit,cancellation,guestFinalReport,taskUnregistered=false
 const command=(kind,args,options)=>diagnostics.command(kind,()=>exec(prl,args,options))
 const binding=r=>Object.fromEntries(['version','runId','rendezvousNonce','requestId','sessionId','task'].map(k=>[k,r[k]]))
 const cancellationClean=()=>!!cancellation&&windowsVisionCancelGuestPassed(guestFinalReport,cfg,cancellation,hello?.carrierIdentity)&&naturalTaskExit?.result===0&&taskUnregistered&&restored&&cleanupErrors.length===0&&!fatal
 const taskScope='QiuYaTools-vision-'+cfg.runId,outputReport=()=>({runId:cfg.runId,nativeSha256:cfg.nativeSha256,fixtureSha256:cfg.fixtureSha256,auditSha256:cfg.auditSha256,status:windowsVisionTerminal({recordCount:records.length,recordsClean:records.every(r=>r.cleanup?.passed===true),fatal,cleanupErrors,cancellationConfirmed:cancellationClean()}).status,records:records.map(r=>({task:r.request.task,requestId:r.request.requestId,sessionId:r.request.sessionId,fixtureIdentity:r.ready?.fixtureIdentity,nativeIdentity:r.ready?.nativeIdentity,windowId:r.ready?.windowId,cleanup:r.cleanup??null})),cleanupErrors,fatal:fatal??null,failureDiagnostic:failureDiagnostic??null,naturalTaskExit:naturalTaskExit??null,pauseIdleRestored:restored,taskUnregistered,...(cancellation?{cancellation:{cancelId:cancellation.cancelId,reason:cancellation.reason,confirmed:cancellationClean()}}:{}),accountCredentialsTransferred:false,windowsInboundPortOpened:false})
 const cancel=()=>{stopping=true};process.once('SIGINT',cancel);process.once('SIGTERM',cancel)
 const hostServer=createServer(async(req,res)=>{
  try{
   if(req.socket.remoteAddress!==guestIp)return json(res,{error:'DENIED'},403)
   const file=req.method==='GET'&&req.url?.startsWith('/'+fileKey+'/')&&files.get(req.url.slice(fileKey.length+2));if(file){res.writeHead(200,{'Content-Length':file.length}).end(file);return}
   if(!req.url?.startsWith('/bridge/')||!auth(req.headers.authorization,bridgeToken))return json(res,{error:'DENIED'},403)
   if(req.url==='/bridge/hello'&&req.method==='POST'){
    if(hello)fail('VISION_WINDOWS_HELLO_REPLAY');const value=JSON.parse(await readBody(req));if(value.version!==1||value.runId!==cfg.runId||value.rendezvousNonce!==cfg.rendezvousNonce||value.guestRoot!==guestRoot||value.nativeSha256!==cfg.nativeSha256||value.fixtureSha256!==cfg.fixtureSha256)fail('VISION_WINDOWS_HELLO_BINDING')
    validateWindowsIdentity(value.carrierIdentity,{path:nodeGuestPath});hello=value;return json(res,{ok:true})
   }
   if(!hello)fail('VISION_WINDOWS_HELLO_REQUIRED')
   if(req.url==='/bridge/next'&&req.method==='GET'){
    const until=Date.now()+15000;let command;while(Date.now()<until&&!(command=queue.take()))await sleep(25)
    if(!command){res.writeHead(204).end();return}return json(res,command)
   }
   if(req.url==='/bridge/reply'&&req.method==='POST'){const value=JSON.parse(await readBody(req,50*1024*1024));return json(res,{accepted:queue.reply(value)})}
   return json(res,{error:'NOT_FOUND'},404)
  }catch{if(!res.headersSent)json(res,{error:'VISION_WINDOWS_BRIDGE_REJECTED'},400);else res.destroy()}
 })
 const loopback=createServer(async(req,res)=>{
  try{
   const record=active;if(!record?.ready)return json(res,{error:'NO_ACTIVE_TASK'},409)
   if(req.url==='/test/status'&&req.method==='GET'){
    if(!auth(req.headers.authorization,record.controlToken))return json(res,{error:'DENIED'},403)
    const result=await queue.request({kind:'status',binding:binding(record.request)});if(!result.ok)fail('VISION_WINDOWS_STATUS_FAILED');winVisionBinding(result.value,record.request);return json(res,result.value)
   }
   if(req.url==='/v1/computer'&&req.method==='POST'){
    if(!auth(req.headers.authorization,record.ready.token))return json(res,{error:'DENIED'},403)
    const body=await readBody(req),request=JSON.parse(body);if(request.version!==1||!Number.isSafeInteger(request.requestId)||typeof request.clientId!=='string')fail('VISION_WINDOWS_AGENT_REQUEST')
    const result=await queue.request({kind:'rpc',binding:binding(record.request),authorization:req.headers.authorization,body});if(!result.ok)fail('VISION_WINDOWS_RPC_FAILED')
    if(typeof result.body!=='string'||Buffer.byteLength(result.body)>48*1024*1024||!Number.isSafeInteger(result.status))fail('VISION_WINDOWS_RPC_REPLY')
    if(request.op==='observe'){
     const value=JSON.parse(result.body)
     if(value.ok===true&&value.result?.targetId===record.ready.target.id&&value.result.mediaType==='image/jpeg'&&typeof value.result.imageBase64==='string'&&value.result.imageBase64.length<8*1024*1024){record.images=(record.images??0)+1;if(record.images<=128)await writeFile(join(evidence,`windows-task-${record.request.task}-observation-${record.images}.jpg`),Buffer.from(value.result.imageBase64,'base64'),{mode:0o600})}
    }
    res.writeHead(result.status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(result.body)}).end(result.body);return
   }
   return json(res,{error:'NOT_FOUND'},404)
  }catch{if(!res.headersSent)json(res,{version:1,ok:false,error:{code:'VISION_WINDOWS_TRANSPORT_FAILED',message:'Windows验收通道未确认完成。'}},503);else res.destroy()}
 })
 let hostListening=false,loopListening=false
 const shortPS=async(code,timeout=30000)=>{
  const encoded=Buffer.from(code,'utf16le').toString('base64');if(encoded.length>=2000)fail('VISION_WINDOWS_PS_ENVELOPE')
  return(await command('windows-short-powershell',['exec',vm,'powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{timeout,killSignal:'SIGKILL',maxBuffer:4*1024*1024})).stdout.trim()
 }
 async function psFile(code,timeout=30000){
  const name='command-'+randomBytes(12).toString('hex')+'.ps1',bytes=Buffer.from('\uFEFF'+code),digest=sha(bytes);files.set(name,bytes)
  const destination=win32.join(guestRoot,name)
  try{await shortPS(`$ErrorActionPreference='Stop';$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(`http://${host}:${hostServer.address().port}/${fileKey}/${name}`)},${quote(destination)});if((Get-FileHash -LiteralPath ${quote(destination)} -Algorithm SHA256).Hash.ToLowerInvariant()-cne '${digest}'){throw 'Own command SHA mismatch'}`);return(await command('windows-file-powershell',['exec',vm,'powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',destination],{timeout,killSignal:'SIGKILL',maxBuffer:6*1024*1024})).stdout.trim()}
  finally{files.delete(name);try{await shortPS(`$ErrorActionPreference='Stop';$p=${quote(destination)};if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()-cne '${digest}'){throw 'Own command changed'};Remove-Item -LiteralPath $p -Force`)}catch{cleanupErrors.push('VISION_WINDOWS_COMMAND_CLEANUP')}}
 }
 async function taskState(){return JSON.parse(await psFile(`$ErrorActionPreference='Stop';$items=@(Get-ScheduledTask -TaskPath '\\'|Where-Object{$_.TaskName-ceq ${quote(taskName)}});if($items.Count-ne 1){throw 'Own task missing or ambiguous'};$t=$items[0];$a=@($t.Actions);if($a.Count-ne 1-or $a[0].Execute-ine 'powershell.exe'-or $a[0].Arguments-cne ${quote(taskArguments)}){throw 'Own task action changed'};$u=$t.Principal.UserId;if($u-notmatch '^S-1-'){$u=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value};if($u-cne ${quote(principal.sid)}){throw 'Own principal changed'};$i=Get-ScheduledTaskInfo -TaskName ${quote(taskName)};@{state=$t.State.ToString();result=[long]$i.LastTaskResult;identityMatched=$true}|ConvertTo-Json -Compress`))}
 async function retire(record){
  if(record.cleanup)return
  let result;try{result=await queue.request({kind:'stop',binding:binding(record.request)})}catch{result={ok:false}}
  record.cleanup=result.ok?result.value:{passed:false,errors:['VISION_WINDOWS_CLEANUP_UNCONFIRMED'],nativeNaturalExit:false,fixtureNaturalExit:false,forced:false}
  if(!windowsVisionDesktopPassed(record.cleanup?.desktopAudit,{auditSha256:cfg.auditSha256,sessionId:record.ready?.nativeIdentity.sessionId})||record.cleanup?.auditSha256!==cfg.auditSha256||record.cleanup?.expectedSessionId!==record.ready?.nativeIdentity.sessionId){record.cleanup={...record.cleanup,passed:false,errors:[...(Array.isArray(record.cleanup?.errors)?record.cleanup.errors:[]),'VISION_WINDOWS_DESKTOP_RECEIPT_INVALID']}}
  for(const kind of['ready','request','stop'])await removePrivateJSON(externalFile(cfg,record.request.task,kind))
  await writePrivateJSON(externalFile(cfg,record.request.task,'cleanup'),{...binding(record.request),cleanup:record.cleanup})
 }
 async function readCancellation(){
  let value;try{value=await readPrivateJSON(join(cfg.directory,'external/carrier-cancel.json'))}catch(error){if(error.code==='ENOENT')return false;throw error}
  validateWindowsVisionCancel(value,cfg);if(active||records.length!==0)fail('VISION_CANCEL_NOT_IDLE');cancellation=value;stopping=true;return true
 }
 try{
  const info=await diagnostics.stage('read-idle-setting',async()=>{const result=(await command('pd-read-idle',['list','--info',vm],{timeout:30000})).stdout.match(/Pause idle: (on|off)/u);if(!result)fail('VISION_WINDOWS_IDLE_SETTING');return result});oldIdle=info[1];await diagnostics.stage('disable-idle',()=>command('pd-disable-idle',['set',vm,'--pause-idle','off'],{timeout:30000}))
  await diagnostics.stage('listen-private-bridge',()=>new Promise((r,j)=>{hostServer.once('error',j);hostServer.listen(0,host,r)}));hostListening=true
  await diagnostics.stage('listen-loopback',()=>new Promise((r,j)=>{loopback.once('error',j);loopback.listen(0,'127.0.0.1',r)}));loopListening=true
  principal=await diagnostics.stage('query-interactive-principal',async()=>JSON.parse(await shortPS(windowsVisionPrincipalQuery)))
  guestRoot=await diagnostics.stage('resolve-own-guest-root',async()=>win32.join(principal.profile,'AppData','Local','Temp',taskScope));taskName=taskScope
  await diagnostics.stage('create-guest-root',()=>shortPS(`$ErrorActionPreference='Stop';if(Test-Path -LiteralPath ${quote(guestRoot)}){throw 'Fresh own root exists'};[void][IO.Directory]::CreateDirectory(${quote(guestRoot)});if((Get-FileHash -LiteralPath ${quote(nodeGuestPath)} -Algorithm SHA256).Hash.ToLowerInvariant()-cne '${nodeSha256}'){throw 'Node SHA mismatch'}`))
  const guestConfig={version:1,runId:cfg.runId,rendezvousNonce:cfg.rendezvousNonce,guestRoot,expiresAt:cfg.expiresAt,bridgeUrl:`http://${host}:${hostServer.address().port}/bridge`,bridgeToken,native:win32.join(guestRoot,'native.exe'),fixture:win32.join(guestRoot,'fixture.exe'),nativeSha256:cfg.nativeSha256,fixtureSha256:cfg.fixtureSha256,auditPath:win32.join(guestRoot,'windows-remote-audit.cs'),auditSha256:cfg.auditSha256,expectedSessionId:principal.sessionId}
  await diagnostics.stage('prepare-guest-files',async()=>{files.set('native.exe',await readFile(cfg.native));files.set('fixture.exe',await readFile(cfg.fixture));files.set('guest.mjs',await readFile(join(bundleDir,'windows-guest.mjs')));files.set('windows-remote-audit.cs',await readFile(join(bundleDir,'windows-remote-audit.cs')));files.set('config.json',Buffer.from(JSON.stringify(guestConfig)))})
  const nodeArguments=`"${win32.join(guestRoot,'guest.mjs')}" --config "${win32.join(guestRoot,'config.json')}"`
  const runner=`$ErrorActionPreference='Stop';${windowsVisionAuditPrelude(guestConfig.auditPath,cfg.auditSha256)}${windowsVisionPinFunction};$info=[Diagnostics.ProcessStartInfo]::new(${quote(nodeGuestPath)});$info.Arguments=${quote(nodeArguments)};$info.WorkingDirectory=${quote(guestRoot)};$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$p=[Diagnostics.Process]::Start($info);$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();$binding=Get-VisionReadyIdentity $p ${quote(nodeGuestPath)} $PID ${principal.sessionId};$binding|ConvertTo-Json -Depth 8 -Compress|Set-Content -LiteralPath ${quote(win32.join(guestRoot,'node-binding-initialization.json'))} -Encoding UTF8;if(!$binding.passed){throw 'Own Node identity initialization failed'};$binding.identity|ConvertTo-Json -Compress|Set-Content -LiteralPath ${quote(win32.join(guestRoot,'node-identity.json'))} -Encoding UTF8;if(!$p.WaitForExit(21*60*1000)){throw 'Windows test carrier did not finish naturally'};[void]$o.Wait(3000);[void]$e.Wait(3000);[IO.File]::WriteAllText(${quote(win32.join(guestRoot,'runner.stdout.txt'))},$o.Result);[IO.File]::WriteAllText(${quote(win32.join(guestRoot,'runner.stderr.txt'))},$e.Result);$code=$p.ExitCode;$p.Dispose();exit $code`
  files.set('runner.ps1',Buffer.from('\uFEFF'+runner))
  for(const[name,bytes]of[...files])await diagnostics.stage('transfer-'+({'native.exe':'native','fixture.exe':'fixture','guest.mjs':'guest','windows-remote-audit.cs':'audit','config.json':'config','runner.ps1':'runner'}[name]??'unknown'),()=>shortPS(`$ErrorActionPreference='Stop';$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(`http://${host}:${hostServer.address().port}/${fileKey}/${name}`)},${quote(win32.join(guestRoot,name))});if((Get-FileHash -LiteralPath ${quote(win32.join(guestRoot,name))} -Algorithm SHA256).Hash.ToLowerInvariant()-cne '${sha(bytes)}'){throw 'Transfer integrity failed'}`,90000))
  taskArguments=`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${win32.join(guestRoot,'runner.ps1')}"`
  await diagnostics.stage('register-and-start-own-task',()=>psFile(`$ErrorActionPreference='Stop';if(@(Get-ScheduledTask -TaskPath '\\'|Where-Object{$_.TaskName-ceq ${quote(taskName)}}).Count){throw 'Fresh own task exists'};$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(taskArguments)};$p=New-ScheduledTaskPrincipal -UserId ${quote(principal.user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 22) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${quote(taskName)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(taskName)}`))
  await diagnostics.stage('await-guest-hello',async()=>{const helloDeadline=Date.now()+30000;while(!hello&&Date.now()<helloDeadline)await sleep(50);if(!hello)fail('VISION_WINDOWS_HELLO_TIMEOUT')})
  const pinned=await diagnostics.stage('pin-node-identity',async()=>JSON.parse(await psFile(`$ErrorActionPreference='Stop';$receipt=${quote(win32.join(guestRoot,'node-identity.json'))};$clock=[Diagnostics.Stopwatch]::StartNew();while(!(Test-Path -LiteralPath $receipt)-and $clock.ElapsedMilliseconds-lt 4000){Start-Sleep -Milliseconds 50};$r=Get-Content -LiteralPath $receipt -Raw|ConvertFrom-Json;$p=[Diagnostics.Process]::GetProcessById([int]$r.pid);try{$null=$p.SafeHandle;if($p.StartTime.ToUniversalTime().Ticks.ToString()-cne $r.createdAtTicks-or $p.MainModule.FileName-ine ${quote(nodeGuestPath)}-or $p.SessionId-ne $r.sessionId-or $p.SessionId-ne ${principal.sessionId}){throw 'Node process identity changed'};$c=Get-CimInstance Win32_Process -Filter ('ProcessId='+$r.pid);if(!$c-or $c.CreationDate.ToUniversalTime().Ticks-ne ([long]$r.createdAtTicks-([long]$r.createdAtTicks%10))-or [int]$c.ParentProcessId-ne $r.parentPid-or $c.ExecutablePath-ine ${quote(nodeGuestPath)}-or [int]$c.SessionId-ne $r.sessionId){throw 'Node independent CIM identity changed'};$parent=[Diagnostics.Process]::GetProcessById([int]$c.ParentProcessId);try{$null=$parent.SafeHandle;$pc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$parent.Id);if($parent.ProcessName-ine 'powershell'-or $parent.SessionId-ne $p.SessionId-or !$pc.CommandLine.EndsWith(${quote(taskArguments)},[StringComparison]::Ordinal)){throw 'Node runner command/session changed'};@{pid=$p.Id;parentPid=$parent.Id;createdAtTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();executablePath=$p.MainModule.FileName;sessionId=$p.SessionId;runnerPid=$parent.Id;runnerCreatedAtTicks=$parent.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}finally{$parent.Dispose()}}finally{$p.Dispose()}`)))
  await diagnostics.stage('verify-node-binding',async()=>{if(['pid','parentPid','createdAtTicks','sessionId'].some(k=>pinned[k]!==hello.carrierIdentity[k])||windowsPath(pinned.executablePath)!==windowsPath(hello.carrierIdentity.executablePath))fail('VISION_WINDOWS_NODE_BINDING')})
  const running=await diagnostics.stage('verify-own-task-running',async()=>{const state=await taskState();if(state.state!=='Running')fail('VISION_WINDOWS_RUNNER_STATE');return state})
  await writePrivateJSON(join(evidence,'windows-node-binding.json'),{...pinned,taskName,principalSid:principal.sid,taskIdentityMatched:running.identityMatched,sourceGuestSha256:manifest.guestSha256})
  await diagnostics.stage('publish-carrier-ready',()=>writePrivateJSON(join(cfg.directory,'external','carrier-ready.json'),{version:1,platform:'win32',runId:cfg.runId,rendezvousNonce:cfg.rendezvousNonce,guestRoot,carrierIdentity:hello.carrierIdentity,nativeSha256:cfg.nativeSha256,fixtureSha256:cfg.fixtureSha256,auditSha256:cfg.auditSha256}))
  for(let task=1;task<=3&&!stopping&&Date.now()<cfg.expiresAt;task++){
   let request;await diagnostics.stage('await-task-request',async()=>{while(!request&&!stopping&&Date.now()<cfg.expiresAt){if(await readCancellation())break;try{request=await readPrivateJSON(externalFile(cfg,task,'request'))}catch(e){if(e.code!=='ENOENT')throw e}if(!request)await sleep(50)}if(!request&&!cancellation)fail('VISION_WINDOWS_DEADLINE');if(request)winVisionRequest(request,cfg,task)})
   if(cancellation)break
   const record={request,controlToken:randomBytes(32).toString('hex')};active=record;records.push(record)
   const result=await diagnostics.stage('prepare-business-fixture',async()=>{const value=await queue.request({kind:'prepare',request});if(!value.ok)fail(value.error??'VISION_WINDOWS_PREPARE_FAILED');return value});record.ready=result.value
   await diagnostics.stage('verify-business-ready',async()=>{
    winVisionBinding(record.ready,request)
    validateWindowsIdentity(record.ready.fixtureIdentity,{path:guestConfig.fixture,parentPid:hello.carrierIdentity.pid,sessionId:hello.carrierIdentity.sessionId});validateWindowsIdentity(record.ready.nativeIdentity,{path:guestConfig.native,parentPid:hello.carrierIdentity.pid,sessionId:hello.carrierIdentity.sessionId});exactWindowsTarget(record.ready.target,record.ready.fixtureIdentity,record.ready.windowId)
    if(record.ready.guestRoot!==guestRoot||record.ready.nativeSha256!==cfg.nativeSha256||record.ready.fixtureSha256!==cfg.fixtureSha256||record.ready.auditSha256!==cfg.auditSha256||!/^[a-f0-9]{64}$/u.test(record.ready.token))fail('VISION_WINDOWS_READY_BINDING')
   })
   const origin=`http://127.0.0.1:${loopback.address().port}`;await diagnostics.stage('publish-task-ready',()=>writePrivateJSON(externalFile(cfg,task,'ready'),{...record.ready,endpoint:origin+'/v1/computer',controlEndpoint:origin+'/test/status',controlToken:record.controlToken}))
   const deadline=Math.min(cfg.expiresAt,Date.now()+240000);let stop
   await diagnostics.stage('await-task-stop',async()=>{while(!stop&&!stopping&&Date.now()<deadline){try{stop=await readPrivateJSON(externalFile(cfg,task,'stop'))}catch(e){if(e.code!=='ENOENT')throw e}if(!stop)await sleep(100)}if(stop)winVisionBinding(stop,request);else fatal='VISION_WINDOWS_TASK_DEADLINE'})
   await diagnostics.stage('retire-business-fixture',()=>retire(record));active=undefined;if(fatal||!record.cleanup.passed)break
  }
 }catch(e){failureDiagnostic=diagnostics.failure(e);fatal=failureDiagnostic.error.code??'VISION_WINDOWS_CARRIER_FAILED'}
 finally{
  if(active)try{await diagnostics.stage('cleanup-active-business',()=>retire(active))}catch{cleanupErrors.push('VISION_WINDOWS_CLEANUP_FAILED')}
  if(hello)try{const shutdown=await diagnostics.stage('shutdown-own-guest',()=>queue.request({kind:'shutdown',...(cancellation?{cancellation}: {})}));if(!shutdown.ok)cleanupErrors.push('VISION_WINDOWS_SHUTDOWN_FAILED')}catch{cleanupErrors.push('VISION_WINDOWS_SHUTDOWN_FAILED')}
  if(taskArguments)try{await diagnostics.stage('cleanup-own-task',async()=>{for(let n=0;n<30;n++){const state=await taskState();if(state.state==='Ready'){naturalTaskExit=state;break}await sleep(200)}if(!naturalTaskExit)cleanupErrors.push('VISION_WINDOWS_RUNNER_NOT_NATURAL');else if(naturalTaskExit.result!==0)cleanupErrors.push('VISION_WINDOWS_RUNNER_FAILED');if(naturalTaskExit){await psFile(`$ErrorActionPreference='Stop';Unregister-ScheduledTask -TaskName ${quote(taskName)} -TaskPath '\\' -Confirm:$false;if(@(Get-ScheduledTask -TaskPath '\\'|Where-Object{$_.TaskName-ceq ${quote(taskName)}}).Count){throw 'Own task still registered'}`);taskUnregistered=true}})}catch{cleanupErrors.push('VISION_WINDOWS_TASK_CLEANUP')}
  if(guestRoot)for(const name of['guest-report.json','node-identity.json','node-binding-initialization.json','identity-initialization.json','runner.stdout.txt','runner.stderr.txt'])try{const packed=await shortPS(`$ErrorActionPreference='Stop';$p=${quote(win32.join(guestRoot,name))};if(Test-Path -LiteralPath $p){$f=Get-Item -LiteralPath $p;if($f.Length-gt 1MB){throw 'Own evidence limit'};$b=[IO.File]::ReadAllBytes($p);@{length=$b.Length;sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant();base64=[Convert]::ToBase64String($b)}|ConvertTo-Json -Compress}`);if(packed){const value=JSON.parse(packed),bytes=Buffer.from(value.base64,'base64');if(bytes.length!==value.length||bytes.length>1048576||sha(bytes)!==value.sha256)fail('VISION_WINDOWS_EVIDENCE_CHANGED');await writeFile(join(evidence,'windows-'+name),bytes,{mode:0o600});if(name==='guest-report.json')guestFinalReport=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u,''))}}catch{cleanupErrors.push('VISION_WINDOWS_EVIDENCE_COLLECTION')}
  queue.close();if(loopListening){loopback.closeAllConnections();await new Promise(r=>loopback.close(r))}if(hostListening){hostServer.closeAllConnections();await new Promise(r=>hostServer.close(r))}
  if(oldIdle)try{await diagnostics.stage('restore-idle',async()=>{await command('pd-restore-idle',['set',vm,'--pause-idle',oldIdle],{timeout:30000});restored=(await command('pd-verify-idle',['list','--info',vm],{timeout:30000})).stdout.includes('Pause idle: '+oldIdle);if(!restored)cleanupErrors.push('VISION_WINDOWS_IDLE_RESTORE')})}catch{cleanupErrors.push('VISION_WINDOWS_IDLE_RESTORE')}
  for(const path of[join(cfg.directory,'external','carrier-ready.json'),...[1,2,3].flatMap(task=>['request','ready','stop'].map(kind=>externalFile(cfg,task,kind)))])try{await removePrivateJSON(path)}catch{cleanupErrors.push('VISION_WINDOWS_PRIVATE_CLEANUP')}
  if(cancellation&&!cancellationClean())cleanupErrors.push('VISION_WINDOWS_CANCEL_UNCONFIRMED')
  process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);await writePrivateJSON(join(evidence,'external-carrier-report.json'),outputReport())
  if(cancellation&&cancellationClean())await writePrivateJSON(join(cfg.directory,'external/carrier-cancelled.json'),{version:1,runId:cfg.runId,rendezvousNonce:cfg.rendezvousNonce,cancelId:cancellation.cancelId,nativeSha256:cfg.nativeSha256,fixtureSha256:cfg.fixtureSha256,auditSha256:cfg.auditSha256,status:'cancelled',passed:true,records:0,guestNaturalExit:true,taskUnregistered:true,pauseIdleRestored:true,modelCompleted:false,desktopAudit:guestFinalReport.cancellation.desktopAudit})
 }
 const report=outputReport();if(windowsVisionTerminal({recordCount:records.length,recordsClean:records.every(r=>r.cleanup?.passed===true),fatal,cleanupErrors,cancellationConfirmed:cancellationClean()}).exitCode!==0)process.exitCode=1;console.log(JSON.stringify({kind:'real-Windows-test-only-reverse-paired-carrier',status:report.status,tasks:records.length,cleanupErrors,fatal:fatal??null}));return report
}
if(process.argv.includes('--config'))runWindowsVisionCarrier(resolve(process.argv[process.argv.indexOf('--config')+1])).catch(error=>{process.stderr.write(JSON.stringify({stage:'carrier-bootstrap-or-final-report',error:projectWindowsCarrierError(error)})+'\n');process.exitCode=1})
