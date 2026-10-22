/** Explicit Session-1 test carrier. Never receives account/model credentials. */
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { NativeCompanionDriver, createComputerAgentServer } from '../src/features/computer-use/remote.ts'
import { exactWindowsTarget, validateWindowsIdentity, sameWindowsIdentity, projectWindowsOracle, windowsVisionAction, winVisionBinding, winVisionRequest, winVisionGuestConfig, windowsPath, winVisionFail as fail } from './live-vision-windows-carrier-core.mjs'
import { windowsVisionPinCommand, windowsVisionDesktopCommand, windowsVisionDesktopPassed } from './live-vision-windows-audit.mjs'
import { validateWindowsVisionCancel, windowsVisionTerminal, windowsVisionCancelDesktopPassed } from './live-vision-windows-cancel.mjs'
import { windowsVisionChildrenCommand, windowsVisionChildrenPassed } from './live-vision-windows-children.mjs'
const sha=b=>createHash('sha256').update(b).digest('hex'),sleep=ms=>new Promise(r=>setTimeout(r,ms)),quote=s=>`'${s.replaceAll("'","''")}'`
const bounded=async(p,ms,code)=>{let t;try{return await Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Object.assign(Error(code),{code})),ms)})])}finally{clearTimeout(t)}}
const ps=code=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',timeout:30000,maxBuffer:1048576}).replace(/^\uFEFF/u,''))
function identity(pid){return ps(`$ErrorActionPreference='Stop';$p=$null;try{$p=[Diagnostics.Process]::GetProcessById(${pid});$null=$p.SafeHandle;$c=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';@{pid=$p.Id;parentPid=[int]$c.ParentProcessId;createdAtTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();executablePath=$p.MainModule.FileName;sessionId=$p.SessionId}|ConvertTo-Json -Compress}catch [ArgumentException]{'null'}finally{if($p){$p.Dispose()}}`)}
const ownExit=child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve({code:child.exitCode,signal:child.signalCode}):new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})))
function track(child){const row={killCalls:[]};const kill=child.kill.bind(child);child.kill=(...a)=>{row.killCalls.push(a[0]??'SIGTERM');return kill(...a)};row.exits=ownExit(child);return row}
export async function runWindowsVisionGuest(configPath){
 if(process.platform!=='win32')fail('VISION_WINDOWS_REQUIRED')
 const cfg=winVisionGuestConfig(JSON.parse(await readFile(configPath,'utf8'))),reportPath=join(cfg.guestRoot,'guest-report.json'),records=[],initialization=[];let active,stopping=false,fatal,me,cancellation,cancelDesktopAudit
 for(const[path,hash]of[[cfg.native,cfg.nativeSha256],[cfg.fixture,cfg.fixtureSha256],[cfg.auditPath,cfg.auditSha256]])if(sha(await readFile(path))!==hash)fail('VISION_WINDOWS_SOURCE_CHANGED')
 async function initialize(role,pid,path,parentPid=0,parentBirth=''){
  const receipt=ps(windowsVisionPinCommand({pid,path,parentPid,parentBirth,sessionId:cfg.expectedSessionId,auditPath:cfg.auditPath,auditSha256:cfg.auditSha256}))
  initialization.push({role,pid,task:active?.request.task??null,...receipt})
  await writeFile(join(cfg.guestRoot,'identity-initialization.json'),JSON.stringify({auditSourceSha256:cfg.auditSha256,records:initialization},null,2))
  if(receipt.passed!==true)fail('VISION_WINDOWS_IDENTITY_INITIALIZATION')
  return validateWindowsIdentity(receipt.identity,{path,...(parentPid?{parentPid}:{}),sessionId:cfg.expectedSessionId})
 }
 me=await initialize('carrier',process.pid,process.execPath)
 const bridge=new URL(cfg.bridgeUrl);if(bridge.protocol!=='http:'||bridge.hostname!=='10.211.55.2'||!bridge.port||!/^[a-f0-9]{64}$/u.test(cfg.bridgeToken))fail('VISION_WINDOWS_BRIDGE_CONFIG')
 const binding=r=>Object.fromEntries(['version','runId','rendezvousNonce','requestId','sessionId','task'].map(k=>[k,r[k]]))
 const fetchBridge=async(path,options={})=>{const r=await fetch(bridge.href+path,{...options,headers:{...options.headers,Authorization:'Bearer '+cfg.bridgeToken},signal:AbortSignal.timeout(25000),redirect:'error'});if(!r.ok&&r.status!==204)fail('VISION_WINDOWS_BRIDGE_FAILED');return r}
 const terminal=()=>windowsVisionTerminal({recordCount:records.length,recordsClean:records.every(r=>r.cleanup?.passed===true),fatal,cancellationConfirmed:!!cancellation&&windowsVisionCancelDesktopPassed(cancelDesktopAudit,{auditSha256:cfg.auditSha256,sessionId:me.sessionId})})
 const save=()=>writeFile(reportPath,JSON.stringify({version:1,runId:cfg.runId,nativeSha256:cfg.nativeSha256,fixtureSha256:cfg.fixtureSha256,auditSha256:cfg.auditSha256,carrierIdentity:me,initialization,status:terminal().status,records:records.map(r=>({task:r.request.task,requestId:r.request.requestId,sessionId:r.request.sessionId,fixtureIdentity:r.fixtureIdentity,nativeIdentity:r.nativeIdentity,windowId:r.ready?.windowId,cleanup:r.cleanup??null})),...(cancellation?{cancellation:{cancelId:cancellation.cancelId,reason:cancellation.reason,accepted:true,desktopAudit:cancelDesktopAudit??null}}:{}),fatal:fatal??null},null,2))
 async function check(record){
  if(!sameWindowsIdentity(identity(record.fixture.pid),record.fixtureIdentity)||!sameWindowsIdentity(identity(record.nativeChild.pid),record.nativeIdentity))fail('VISION_WINDOWS_IDENTITY_CHANGED')
  const response=await fetch(record.ready.stateEndpoint,{signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)fail('VISION_WINDOWS_ORACLE')
  const state=await response.json();projectWindowsOracle(state,record.fixtureIdentity,record.ready.windowId,record.request.task)
  if(state.foregroundWindowId!==record.ready.windowId)fail('VISION_WINDOWS_FOREGROUND_CHANGED')
  const current=exactWindowsTarget((await record.driver.targets()).find(t=>t.id===record.target.id),record.fixtureIdentity,record.ready.windowId)
  if(['appId','pid','x','y','width','height','scale'].some(k=>current[k]!==record.target[k]))fail('VISION_WINDOWS_TARGET_CHANGED')
  return current
 }
 async function snapshot(record){
  await check(record)
  const response=await fetch(record.ready.stateEndpoint,{signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)fail('VISION_WINDOWS_ORACLE')
  const raw=await response.json(),oracle=projectWindowsOracle(raw,record.fixtureIdentity,record.ready.windowId,record.request.task)
  if(raw.foregroundWindowId!==record.ready.windowId)fail('VISION_WINDOWS_FOREGROUND_CHANGED')
  let preauthorization
  if(record.request.testOnlyNaturalEntry===true&&Object.values(record.nativeCalls).every(value=>value===0)){
   const desktopAudit={...ps(windowsVisionDesktopCommand(cfg.auditPath,cfg.auditSha256)),auditSourceSha256:cfg.auditSha256}
   preauthorization={phase:'before-owner-once',nativeCalls:{...record.nativeCalls},desktopAudit}
  }
  return {...binding(record.request),fixtureAlive:true,fixtureIdentity:record.fixtureIdentity,windowId:record.ready.windowId,oracle,...(preauthorization?{preauthorization}:{})}
 }
 async function retire(record){
  if(record.cleanup)return record.cleanup
  const errors=[]
  let descendants=[],childAudit
  if(record.nativeIdentity)try{childAudit=ps(windowsVisionChildrenCommand(record.nativeIdentity,cfg.native));if(!windowsVisionChildrenPassed(childAudit,record.nativeIdentity,cfg.native))errors.push('VISION_WINDOWS_CHILDREN_UNCONFIRMED');else descendants=childAudit.candidates.map(({pid,parentPid,createdAtTicks,executablePath,sessionId})=>({pid,parentPid,createdAtTicks,executablePath,sessionId}))}catch{childAudit={version:1,scope:'one-live-native-direct-child-snapshot',passed:false,failure:{stage:'receipt-unavailable',code:'CHILD_AUDIT_UNAVAILABLE'}};errors.push('VISION_WINDOWS_CHILDREN_UNCONFIRMED')}
  if(childAudit)try{await writeFile(join(cfg.guestRoot,`children-task-${record.request.task}.json`),JSON.stringify(childAudit,null,2))}catch{errors.push('VISION_DIAGNOSTIC_WRITE_FAILED')}
  try{await record.agent?.revoke()}catch{errors.push('VISION_PAIR_REVOKE_FAILED')}
  try{await record.agent?.close()}catch{errors.push('VISION_PAIR_CLOSE_FAILED')}
  try{await bounded(record.driver?.dispose(),10000,'VISION_NATIVE_CLEANUP_FAILED')}catch{errors.push('VISION_NATIVE_CLEANUP_FAILED')}
  let nativeExit,fixtureExit
  try{nativeExit=await bounded(record.nativeTrack.exits,5000,'VISION_NATIVE_CLEANUP_FAILED')}catch{errors.push('VISION_NATIVE_CLEANUP_FAILED')}
  try{record.fixture.stdin.end();fixtureExit=await bounded(record.fixtureTrack.exits,5000,'VISION_FIXTURE_CLEANUP_FAILED')}catch{errors.push('VISION_FIXTURE_CLEANUP_FAILED')}
  const nativeNaturalExit=nativeExit?.code===0&&nativeExit.signal===null&&record.nativeTrack?.killCalls.length===0,fixtureNaturalExit=fixtureExit?.code===0&&fixtureExit.signal===null&&record.fixtureTrack?.killCalls.length===0
  if(!nativeNaturalExit)errors.push('VISION_NATIVE_NOT_NATURAL');if(!fixtureNaturalExit)errors.push('VISION_FIXTURE_NOT_NATURAL')
  for(const pin of [record.nativeIdentity,record.fixtureIdentity,...descendants].filter(Boolean)){try{const deadline=performance.now()+5000;let current=identity(pin.pid);while(sameWindowsIdentity(current,pin)&&performance.now()<deadline){await sleep(50);current=identity(pin.pid)}if(sameWindowsIdentity(current,pin))errors.push('VISION_WINDOWS_REMAINS')}catch{errors.push('VISION_WINDOWS_IDENTITY_UNCONFIRMED')}}
  let desktopAudit
  try{desktopAudit={...ps(windowsVisionDesktopCommand(cfg.auditPath,cfg.auditSha256)),phase:'after-owned-native-fixture-exit',auditSourceSha256:cfg.auditSha256};if(!windowsVisionDesktopPassed(desktopAudit,{sessionId:me.sessionId,auditSha256:cfg.auditSha256}))errors.push('VISION_WINDOWS_DESKTOP_RELEASE_UNCONFIRMED')}catch{errors.push('VISION_WINDOWS_DESKTOP_AUDIT_FAILED')}
  record.cleanup={passed:errors.length===0,errors,nativeNaturalExit,fixtureNaturalExit,forced:!!record.nativeTrack?.killCalls.length||!!record.fixtureTrack?.killCalls.length,descendants,childAudit:childAudit??null,desktopAudit:desktopAudit??null,expectedSessionId:me.sessionId,auditSha256:cfg.auditSha256}
  await save();return record.cleanup
 }
 async function prepare(request){
  winVisionRequest(request,cfg,records.length+1)
  if(active||request.task!==records.length+1||request.runId!==cfg.runId||request.rendezvousNonce!==cfg.rendezvousNonce)fail('VISION_WINDOWS_BINDING')
  if(request.testOnlyNaturalEntry!==undefined&&(request.testOnlyNaturalEntry!==true||request.task!==1))fail('VISION_WINDOWS_BINDING')
  const record={request,nativeCalls:{observe:0,preview:0,lease:0,act:0}};active=record;records.push(record)
  record.fixture=spawn(cfg.fixture,[],{stdio:['pipe','pipe','pipe'],windowsHide:false});record.fixtureTrack=track(record.fixture);record.fixture.stderr.resume();record.fixture.stdin.on('error',()=>{})
  let readyResolve,readyReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j}),lines=createInterface({input:record.fixture.stdout})
  lines.on('line',line=>{try{if(line.length>65536)throw Error();const value=JSON.parse(line);if(value.event==='ready')readyResolve(value)}catch{readyReject(Error('VISION_WINDOWS_FIXTURE_PROTOCOL'))}})
  record.fixture.once('error',readyReject);record.fixture.stdin.write(JSON.stringify({task:request.task,nonce:request.nonce,note:request.note,seed:request.seed})+'\n')
  record.ready=await bounded(ready,15000,'VISION_WINDOWS_FIXTURE_READY')
  record.fixtureIdentity=await initialize('fixture',record.fixture.pid,cfg.fixture,process.pid,me.createdAtTicks)
  if(record.ready.pid!==record.fixture.pid||record.ready.createdAtTicks!==record.fixtureIdentity.createdAtTicks||record.ready.task!==request.task||!/^\d+$/u.test(record.ready.windowId))fail('VISION_WINDOWS_FIXTURE_IDENTITY')
  const state=new URL(record.ready.stateEndpoint);if(state.protocol!=='http:'||state.hostname!=='127.0.0.1'||!state.port||state.pathname!=='/state'||state.username||state.password||state.search||state.hash)fail('VISION_WINDOWS_ORACLE_ENDPOINT')
  record.driver=new NativeCompanionDriver({executable:cfg.native});const nativeStatus=await record.driver.status()
  record.nativeChild=Reflect.get(record.driver,'child');if(!record.nativeChild?.pid)fail('VISION_WINDOWS_NATIVE_IDENTITY');record.nativeTrack=track(record.nativeChild)
  record.nativeIdentity=await initialize('native',record.nativeChild.pid,cfg.native,process.pid,me.createdAtTicks)
  if(nativeStatus.available!==true||nativeStatus.platform!=='win32'||nativeStatus.permissions?.screen!==true||nativeStatus.permissions?.accessibility!==true)fail('VISION_WINDOWS_NATIVE_PERMISSION')
  record.target=exactWindowsTarget((await record.driver.targets()).find(t=>t.pid===record.fixture.pid&&t.id.split(':')[1]&&BigInt('0x'+t.id.split(':')[1])===BigInt(record.ready.windowId)),record.fixtureIdentity,record.ready.windowId)
  const fixed={status:async s=>{await check(record);return record.driver.status(s)},targets:async()=>[await check(record)],observe:async(t,s)=>{if(t!==record.target.id)fail('VISION_TARGET_CHANGED');await check(record);record.nativeCalls.observe++;const value=await record.driver.observe(t,s);await check(record);return value},preview:async(t,s)=>{if(t!==record.target.id)fail('VISION_TARGET_CHANGED');await check(record);record.nativeCalls.preview++;const value=await record.driver.preview(t,s);await check(record);return value},lease:async(e,s,o)=>{await check(record);record.nativeCalls.lease++;return record.driver.lease(e,s,o)},release:(e,s)=>record.driver.release(e,s),act:async(e,t,a,s)=>{if(t!==record.target.id)fail('VISION_TARGET_CHANGED');windowsVisionAction(record.request.task,a);await check(record);record.nativeCalls.act++;return record.driver.act(e,t,a,s)},openPreview:async()=>fail('VISION_PREVIEW_NOT_EXPOSED'),closePreview:async()=>{},subscribe:l=>record.driver.subscribe(l)}
  record.token=randomBytes(32).toString('hex');record.agent=await createComputerAgentServer(fixed,{token:record.token,host:'127.0.0.1',port:0})
  await snapshot(record);await save()
  return {...binding(request),target:record.target,windowId:record.ready.windowId,guestRoot:cfg.guestRoot,fixtureIdentity:record.fixtureIdentity,nativeIdentity:record.nativeIdentity,nativeSha256:cfg.nativeSha256,fixtureSha256:cfg.fixtureSha256,auditSha256:cfg.auditSha256,token:record.token,nativeStatus}
 }
 async function command(job){
  const p=job.payload;let result
  try{
   if(p.kind==='prepare')result={ok:true,value:await prepare(p.request)}
   else if(p.kind==='shutdown'){
    if(p.cancellation){validateWindowsVisionCancel(p.cancellation,cfg);if(active||records.length!==0)fail('VISION_CANCEL_NOT_IDLE');cancellation=p.cancellation}
    stopping=true;result={ok:true}
   }
   else{
    if(!active)fail('VISION_WINDOWS_TASK_REQUIRED');winVisionBinding(p.binding,active.request)
    if(p.kind==='status')result={ok:true,value:await snapshot(active)}
    else if(p.kind==='stop'){const cleanup=await retire(active);active=undefined;result={ok:true,value:cleanup}}
    else if(p.kind==='rpc'){
     if(typeof p.body!=='string'||Buffer.byteLength(p.body)>512*1024||p.authorization!=='Bearer '+active.token)fail('VISION_WINDOWS_PAIR_AUTH')
     const r=await fetch(active.agent.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:p.authorization},body:p.body,signal:AbortSignal.timeout(25000),redirect:'error'}),body=await r.text();if(Buffer.byteLength(body)>48*1024*1024)fail('VISION_WINDOWS_REPLY_LIMIT')
     result={ok:true,status:r.status,body}
    }else fail('VISION_WINDOWS_COMMAND')
   }
  }catch(e){result={ok:false,error:typeof e.code==='string'&&/^[A-Z_]+$/u.test(e.code)?e.code:'VISION_WINDOWS_GUEST_FAILED'}}
  await fetchBridge('/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:job.id,result})})
 }
 const pending=new Set()
 try{
  await fetchBridge('/hello',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,runId:cfg.runId,rendezvousNonce:cfg.rendezvousNonce,carrierIdentity:me,guestRoot:cfg.guestRoot,nativeSha256:cfg.nativeSha256,fixtureSha256:cfg.fixtureSha256})})
  while(!stopping&&Date.now()<cfg.expiresAt){if(pending.size>=8){await Promise.race(pending);continue}const r=await fetchBridge('/next');if(r.status===204){await sleep(20);continue}const job=await r.json(),work=command(job);pending.add(work);work.finally(()=>pending.delete(work)).catch(()=>{});work.catch(()=>{fatal??='VISION_WINDOWS_BRIDGE_UNCERTAIN';stopping=true})}
  await bounded(Promise.allSettled([...pending]),10000,'VISION_WINDOWS_PENDING_CLEANUP')
 }catch(e){fatal=typeof e.code==='string'?e.code:'VISION_WINDOWS_BRIDGE_FAILED'}
 finally{if(active){try{await retire(active)}catch{fatal??='VISION_WINDOWS_CLEANUP_FAILED'}}if(cancellation)try{cancelDesktopAudit={...ps(windowsVisionDesktopCommand(cfg.auditPath,cfg.auditSha256)),phase:'after-zero-task-shutdown',auditSourceSha256:cfg.auditSha256};if(!windowsVisionCancelDesktopPassed(cancelDesktopAudit,{auditSha256:cfg.auditSha256,sessionId:me.sessionId}))fatal??='VISION_WINDOWS_CANCEL_AUDIT_FAILED'}catch{fatal??='VISION_WINDOWS_CANCEL_AUDIT_FAILED'}await save()}
 const ended=terminal(),completed=ended.status==='completed';if(ended.exitCode!==0)process.exitCode=1
 console.log(JSON.stringify({kind:'windows-test-only-paired-carrier',completed,cancelled:ended.status==='cancelled'&&ended.exitCode===0,tasks:records.length,fatal:fatal??null}))
}
if(process.argv.includes('--config')){const p=process.argv[process.argv.indexOf('--config')+1];runWindowsVisionGuest(resolve(p)).catch(()=>{process.stderr.write('VISION_WINDOWS_GUEST_FAILED\n');process.exitCode=1})}
