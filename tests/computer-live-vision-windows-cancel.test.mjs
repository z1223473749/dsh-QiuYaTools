import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWindowsVisionCancel, validateWindowsVisionCancel, windowsVisionCancelGuestPassed, validateWindowsVisionCancelAck, windowsVisionTerminal } from '../scripts/live-vision-windows-cancel.mjs'
import { readPrivateJSON, writePrivateJSON } from '../scripts/live-vision-external-core.mjs'
const hash='a'.repeat(64),cfg={runId:randomUUID(),rendezvousNonce:'b'.repeat(64),nativeSha256:hash,fixtureSha256:hash,auditSha256:hash},identity={pid:42,createdAtTicks:'639282542717808148',executablePath:'C:\\own\\node.exe',sessionId:1}
const audit={phase:'after-zero-task-shutdown',auditSourceSha256:hash,sessionId:1,userInteractive:true,activeDesktopAccessible:true,activeDesktopMatches:true,heldKeyCount:0,leaseScopeExists:true,leaseFree:true,journalPresent:false}
test('pre-prepare cancellation binds exact run, nonce, sources and finite original phase and cannot carry action fields',()=>{
 const value=createWindowsVisionCancel(cfg,'owner-enable');assert.equal(validateWindowsVisionCancel(value,cfg),value)
 for(const changed of[{runId:randomUUID()},{rendezvousNonce:'c'.repeat(64)},{nativeSha256:'d'.repeat(64)},{phase:'owner-prepare'},{reason:'retry-task'},{targetId:'foreign'},{cancelId:'bad'}])assert.throws(()=>validateWindowsVisionCancel({...value,...changed},cfg),{code:'VISION_WINDOWS_CANCEL_BINDING'})
})
test('cancelled guest proof requires zero fixture/native initializations and exact independent release audit',()=>{
 const cancellation=createWindowsVisionCancel(cfg,'owner-status'),value={...cfg,carrierIdentity:identity,status:'cancelled',fatal:null,records:[],initialization:[{role:'carrier',passed:true}],cancellation:{cancelId:cancellation.cancelId,reason:cancellation.reason,accepted:true,desktopAudit:audit}}
 assert.equal(windowsVisionCancelGuestPassed(value,cfg,cancellation,identity),true)
 for(const change of[x=>x.records.push({task:1}),x=>x.initialization.push({role:'native',passed:true}),x=>x.initialization[0].passed=false,x=>x.carrierIdentity.createdAtTicks='639282542717808149',x=>x.status='completed',x=>x.cancellation.desktopAudit.heldKeyCount=1,x=>x.cancellation.desktopAudit.sessionId=2,x=>x.cancellation.desktopAudit.leaseFree=false,x=>x.cancellation.desktopAudit.journalPresent=true,x=>x.cancellation.desktopAudit.phase='after-owned-native-fixture-exit',x=>x.cancellation.cancelId=randomUUID()]){const bad=structuredClone(value);change(bad);assert.equal(windowsVisionCancelGuestPassed(bad,cfg,cancellation,identity),false)}
})
test('owner cancellation ACK cannot pass without natural guest, precise task removal, idle restoration and independent OS audit',()=>{
 const cancellation=createWindowsVisionCancel(cfg,'owner-enable'),ack={version:1,...cfg,cancelId:cancellation.cancelId,status:'cancelled',passed:true,records:0,guestNaturalExit:true,taskUnregistered:true,pauseIdleRestored:true,modelCompleted:false,desktopAudit:audit}
 assert.equal(validateWindowsVisionCancelAck(ack,cfg,cancellation,identity),ack)
 for(const changed of[{guestNaturalExit:false},{taskUnregistered:false},{pauseIdleRestored:false},{modelCompleted:true},{records:1},{cancelId:randomUUID()},{rendezvousNonce:'e'.repeat(64)}])assert.throws(()=>validateWindowsVisionCancelAck({...ack,...changed},cfg,cancellation,identity),{code:'VISION_WINDOWS_CANCEL_BINDING'})
})
test('normal cancellation exits zero separately from three completed business cases; unbound or incomplete shutdown stays failed',()=>{
 assert.deepEqual(windowsVisionTerminal({recordCount:0,recordsClean:true,cancellationConfirmed:true}),{status:'cancelled',exitCode:0})
 assert.deepEqual(windowsVisionTerminal({recordCount:3,recordsClean:true}),{status:'completed',exitCode:0})
 for(const recordCount of[0,1,2])assert.equal(windowsVisionTerminal({recordCount,recordsClean:true}).exitCode,1)
 for(const changed of[{fatal:'unknown'},{cleanupErrors:['unconfirmed']},{recordsClean:false},{recordCount:1}])assert.equal(windowsVisionTerminal({recordCount:0,recordsClean:true,cancellationConfirmed:true,...changed}).exitCode,1)
})
test('private cancellation request is one-shot and its uncertain response cannot authorize rewriting it',async()=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'qiuya-cancel-private-')))
 try{const path=join(directory,'carrier-cancel.json'),request=createWindowsVisionCancel(cfg,'owner-status');await writePrivateJSON(path,request);assert.deepEqual(await readPrivateJSON(path),request);await assert.rejects(writePrivateJSON(path,createWindowsVisionCancel(cfg,'owner-status')),{code:'VISION_EXTERNAL_REPLAY'});assert.equal((await readPrivateJSON(path)).cancelId,request.cancelId)}finally{await rm(directory,{recursive:true,force:true})}
})
