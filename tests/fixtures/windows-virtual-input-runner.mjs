import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID,createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {NativeCompanionDriver} from '../../src/features/computer-use/native.ts'
import {ComputerSessionService} from '../../src/features/computer-use/session.ts'
import {ComputerPermissionCoordinator} from '../../src/features/computer-use/permission-coordinator.ts'
const base=dirname(fileURLToPath(import.meta.url)),out=join(base,'evidence'),token=randomUUID(),ready=join(out,'ready.json')
await mkdir(out,{recursive:true})
for(const name of ['ready.json','owner-decision.json','pending-physical-card.json'])await unlink(join(out,name)).catch(e=>{if(e.code!=='ENOENT')throw e})
const callback=process.env.QYT_ACCEPTANCE_CALLBACK
const report={platform:process.platform,architecture:process.arch,startedAt:new Date().toISOString(),checks:[],nativeSHA256:createHash('sha256').update(await readFile(join(base,'qiuya-windows.exe'))).digest('hex'),physicalInputApproved:false,passed:false}
const checkpoint=async(stage,extra={})=>{console.log(stage);await writeFile(join(out,'progress.json'),JSON.stringify({stage,...extra}));if(callback)await fetch(callback+'/progress',{method:'POST',body:JSON.stringify({stage,...extra}),signal:AbortSignal.timeout(5000)}).catch(()=>{})}
const fixture=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',join(base,'windows-virtual-input-fixture.ps1'),'-Ready',ready,'-Token',token],{windowsHide:true,stdio:['ignore','ignore','pipe']})
let stderr='';fixture.stderr.on('data',b=>stderr+=b)
const native=new NativeCompanionDriver({executable:join(base,'qiuya-windows.exe'),args:['--computer'],timeoutMs:20000})
let service,coordinator,oracle,target,action=0
const calls=[]
try{
 assert.equal(process.platform,'win32')
 let info
 for(let i=0;i<200;i++){try{info=JSON.parse(await readFile(ready,'utf8'));break}catch{}if(fixture.exitCode!==null)throw Error(stderr);await delay(100)}
 assert(info,'fixture startup timed out: '+stderr)
 oracle=async(op='state')=>{const r=await fetch(`http://127.0.0.1:${info.port}/${token}/${op}`,{signal:AbortSignal.timeout(5000)});assert(r.ok);return r.json()}
 const status=await native.status();assert(status.available);assert(status.capabilities?.virtualInput)
 target=(await native.targets()).find(t=>t.pid===info.pid&&t.id.split(':')[1]===BigInt(info.hwnd).toString(16));assert(target,'exact fixture target unavailable')
 const driver={status:s=>native.status(s),targets:s=>native.targets(s),observe:(id,s)=>native.observe(id,s),preview:(id,s)=>native.preview(id,s),lease:(...a)=>native.lease(...a),release:(...a)=>native.release(...a),openPreview:async()=>{},closePreview:async()=>{},act:async(epoch,id,a,s,authority)=>{assert.equal(id,target.id);calls.push({action:a,physical:authority?.physicalInputApproved===true});return native.act(epoch,id,a,s,authority)},subscribe:fn=>native.subscribe(fn)}
 service=new ComputerSessionService(driver);await service.setAppAllowed(target.appId,true);await service.start('windows-live',target.id)
 const agent={id:'windows-live'},controller=new AbortController(),exec=()=>({callId:randomUUID(),agent,signal:controller.signal})
 coordinator=new ComputerPermissionCoordinator({backend:{get:id=>service.get(id),allowedApps:()=>service.allowedApps(),setAppAllowed:(...a)=>service.setAppAllowed(...a),authorizationGeneration:()=>0,authorizationStatus:(_,s)=>native.status(s),targetsFor:(_id,s)=>native.targets(s),authorizationStart:async()=>{throw Error('not used')},approvePhysicalInput:(...a)=>service.approvePhysicalInput(...a)},enabled:()=>true,lookupAgent:()=>agent,isRootAgent:a=>a===agent})
 const point=async(name)=>{const state=await oracle(),p=state[name],t=(await native.targets()).find(t=>t.id===target.id);return {x:p.x-t.x,y:p.y-t.y}}
 const act=async(a)=>{const frame=await service.observe('windows-live');return service.act('windows-live',{actionId:'live-'+ ++action,frameId:frame.frameId,action:a})}
 await oracle('sentinel');await delay(300)
 const before=await oracle();assert(before.hooksAvailable&&before.focusRead);assert(!before.fixtureHasForeground&&!before.fixtureHasFocus)
 await checkpoint('background-virtual-operations')
 report.steps=[];for(let i=0;i<5;i++){await act({kind:'click',...await point('button')});report.steps.push({action:'button-'+i,state:await oracle()});console.log('button-'+i+' foreground='+report.steps.at(-1).state.foreground)}
 console.log('field-click');await act({kind:'click',...await point('field')});report.steps.push({action:'field-click',state:await oracle()});console.log('type');await act({kind:'type',text:'virtual-input-live-verified'});report.steps.push({action:'type',state:await oracle()})
 const after=await oracle();report.background={before,after,calls:structuredClone(calls)};assert.equal(after.clicks,5);assert.equal(after.text,'virtual-input-live-verified');assert.deepEqual(after.cursor,before.cursor);assert.equal(after.foreground,before.foreground);assert.equal(after.focus,before.focus);assert.equal(after.activations,before.activations);assert.equal(after.focusEvents,before.focusEvents);for(const step of report.steps){assert.equal(step.state.foreground,before.foreground);assert.equal(step.state.focus,before.focus)}assert.equal(after.clipboardSequence,before.clipboardSequence);assert.equal(after.injectedMouse,before.injectedMouse);assert.equal(after.injectedKeys,before.injectedKeys);assert(!after.fixtureHasForeground&&!after.fixtureHasFocus)
 report.checks.push({name:'real-background-click-and-text-without-global-input',passed:true,before,after})
 await checkpoint('normal-user-input-interleaving',{instructions:'Type in the foreground Normal User Input Sentinel while virtual button actions continue.'})
 const count=after.clicks
 for(let i=0;i<60;i++){await act({kind:'click',...await point('button')});await delay(500)}
 const interleaved=await oracle();assert.equal(interleaved.clicks,count+60);assert.equal(interleaved.sentinel,'normal-user-input-verified');assert.equal(interleaved.activations,before.activations);assert.equal(interleaved.focusEvents,before.focusEvents);assert(!interleaved.fixtureHasForeground&&!interleaved.fixtureHasFocus);assert.equal(service.get('windows-live').state,'ready')
 report.checks.push({name:'virtual-input-does-not-steal-user-focus',passed:true,userText:interleaved.sentinel,virtualClicks:60,foreground:interleaved.foreground,focus:interleaved.focus})
 if(process.argv.includes('--background-only')){report.approvedPath='not-run-background-only'}else{
 const p=await point('pad'),drag={kind:'drag',...p,toX:p.x+40,toY:p.y+15},quiet=await oracle()
 await assert.rejects(act(drag),{code:'VIRTUAL_INPUT_UNSUPPORTED'});assert.equal(calls.at(-1).physical,false)
 const wait=coordinator.requestPhysicalInput(exec(),'专用测试窗口不支持虚拟拖动，申请仅本次真实拖动。');wait.catch(()=>{});await delay(10);const [card]=coordinator.pending();assert.equal(card.scope,'physicalInput');assert.equal(calls.filter(c=>c.physical).length,0)
 await writeFile(join(out,'pending-physical-card.json'),JSON.stringify(card,null,2));await checkpoint('awaiting-separate-owner-approval',{request:card,drag,fixture:info,oracleState:quiet})
 // A decision file is an external operator input. The runner never approves itself.
 let decision
 for(let i=0;i<900;i++){try{const value=JSON.parse(await readFile(join(out,'owner-decision.json'),'utf8'));if(value.requestId===card.requestId){decision=value;break}}catch{}await delay(200)}
 assert(decision&&decision.requestId===card.requestId&&['once','deny'].includes(decision.decision),'No separate owner decision received')
 report.permissionDecision=decision
 if(decision.decision==='deny'){
   await coordinator.decide('windows-live',card.requestId,1,'deny');await assert.rejects(wait,{code:'PHYSICAL_INPUT_DENIED'});const denied=await oracle();assert.equal(denied.drags,quiet.drags);assert.equal(calls.filter(c=>c.physical).length,0);report.checks.push({name:'separate-owner-denial-blocks-physical-input',passed:true});report.approvedPath='not-run-owner-denied'
 }else{
   await coordinator.decide('windows-live',card.requestId,1,'once');await wait;report.physicalInputApproved=true
   await act(drag);await delay(100);const applied=await oracle();assert.equal(applied.drags,quiet.drags+1);assert.equal(calls.filter(c=>c.physical).length,1)
   await assert.rejects(act(drag),{code:'VIRTUAL_INPUT_UNSUPPORTED'});assert.equal(calls.at(-1).physical,false);assert.equal(calls.filter(c=>c.physical).length,1)
   report.checks.push({name:'separate-owner-approval-permits-exactly-one-real-action',passed:true,drags:applied.drags-quiet.drags,physicalCalls:1});report.approvedPath='passed'
   const deniedWait=coordinator.requestPhysicalInput(exec(),'独立拒绝场景：验证拒绝后不能再使用真实鼠标。');deniedWait.catch(()=>{});await delay(10);const [denyCard]=coordinator.pending();await writeFile(join(out,'pending-physical-card.json'),JSON.stringify(denyCard,null,2));await checkpoint('awaiting-owner-denial',{request:denyCard});
   let denyDecision;for(let i=0;i<600;i++){try{const value=JSON.parse(await readFile(join(out,'owner-decision.json'),'utf8'));if(value.requestId===denyCard.requestId){denyDecision=value;break}}catch{}await delay(200)}assert.equal(denyDecision?.decision,'deny');await coordinator.decide('windows-live',denyCard.requestId,1,'deny');await assert.rejects(deniedWait,{code:'PHYSICAL_INPUT_DENIED'});assert.equal(calls.filter(c=>c.physical).length,1);report.checks.push({name:'separate-owner-denial-blocks-additional-real-input',passed:true});
 }
 }
 report.calls=calls;report.passed=true;await checkpoint('completed',{passed:true})
}catch(e){report.error={code:e.code??null,message:e.message,stack:e.stack};process.exitCode=1;await checkpoint('failed',{error:report.error}).catch(()=>{})}
finally{report.calls=calls;coordinator?.dispose();await service?.dispose().catch(()=>{});await native.dispose().catch(e=>{report.cleanupError=String(e);report.passed=false;process.exitCode=1});if(oracle)await oracle('close').catch(()=>{});if(fixture.exitCode===null)fixture.kill();report.finishedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));if(callback)await fetch(callback+'/report',{method:'POST',body:JSON.stringify(report),signal:AbortSignal.timeout(5000)}).catch(()=>{});console.log(JSON.stringify({passed:report.passed,error:report.error,report:join(out,'report.json')}))}
