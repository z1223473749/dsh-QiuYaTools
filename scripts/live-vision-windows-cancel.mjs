/** Pre-prepare cancellation only. Never authorizes a fixture, native action or replay. */
import { randomUUID } from 'node:crypto'
import { sameWindowsIdentity } from './live-vision-windows-carrier-core.mjs'
import { windowsVisionDesktopPassed } from './live-vision-windows-audit.mjs'
const fail=()=>{throw Object.assign(Error('VISION_WINDOWS_CANCEL_BINDING'),{code:'VISION_WINDOWS_CANCEL_BINDING'})}
const phases=['owner-settings-read','owner-enable','owner-status'],uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
const fields=['version','runId','rendezvousNonce','cancelId','reason','phase','nativeSha256','fixtureSha256','auditSha256']
export function validateWindowsVisionCancel(value,cfg){
 if(!value||Object.keys(value).sort().join('|')!==[...fields].sort().join('|')||value.version!==1||value.runId!==cfg.runId||value.rendezvousNonce!==cfg.rendezvousNonce||!uuid(value.cancelId)||value.reason!=='owner-failed-before-prepare'||!phases.includes(value.phase)||['nativeSha256','fixtureSha256','auditSha256'].some(k=>value[k]!==cfg[k]))fail()
 return value
}
export function createWindowsVisionCancel(cfg,phase){return validateWindowsVisionCancel(Object.fromEntries(fields.map(key=>[key,key==='version'?1:key==='cancelId'?randomUUID():key==='reason'?'owner-failed-before-prepare':key==='phase'?phase:cfg[key]])),cfg)}
export function windowsVisionCancelDesktopPassed(value,options){return value?.phase==='after-zero-task-shutdown'&&windowsVisionDesktopPassed({...value,phase:'after-owned-native-fixture-exit'},options)}
export function windowsVisionCancelGuestPassed(value,cfg,cancellation,identity){
 try{
  validateWindowsVisionCancel(cancellation,cfg)
  return value?.runId===cfg.runId&&['nativeSha256','fixtureSha256','auditSha256'].every(k=>value[k]===cfg[k])&&sameWindowsIdentity(value.carrierIdentity,identity)&&value.carrierIdentity.sessionId===identity.sessionId&&value.status==='cancelled'&&value.fatal===null&&Array.isArray(value.records)&&value.records.length===0&&Array.isArray(value.initialization)&&value.initialization.length===1&&value.initialization[0].role==='carrier'&&value.initialization[0].passed===true&&value.cancellation?.cancelId===cancellation.cancelId&&value.cancellation.reason===cancellation.reason&&value.cancellation.accepted===true&&windowsVisionCancelDesktopPassed(value.cancellation.desktopAudit,{auditSha256:cfg.auditSha256,sessionId:identity.sessionId})
 }catch{return false}
}
export function validateWindowsVisionCancelAck(value,cfg,cancellation,identity){
 validateWindowsVisionCancel(cancellation,cfg)
 if(!value||value.version!==1||value.runId!==cfg.runId||value.rendezvousNonce!==cfg.rendezvousNonce||value.cancelId!==cancellation.cancelId||value.status!=='cancelled'||value.passed!==true||value.records!==0||value.guestNaturalExit!==true||value.taskUnregistered!==true||value.pauseIdleRestored!==true||value.modelCompleted!==false||['nativeSha256','fixtureSha256','auditSha256'].some(k=>value[k]!==cfg[k])||!windowsVisionCancelDesktopPassed(value.desktopAudit,{auditSha256:cfg.auditSha256,sessionId:identity.sessionId}))fail()
 return value
}
export function windowsVisionTerminal({recordCount,recordsClean,fatal,cleanupErrors=[],cancellationConfirmed=false}){
 if(fatal||cleanupErrors.length||!recordsClean||cancellationConfirmed&&recordCount!==0)return{status:'failed',exitCode:1}
 if(recordCount===3)return{status:'completed',exitCode:0}
 if(recordCount===0&&cancellationConfirmed)return{status:'cancelled',exitCode:0}
 return{status:'cancelled',exitCode:1}
}
