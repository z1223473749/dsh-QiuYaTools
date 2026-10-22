import test from 'node:test'
import assert from 'node:assert/strict'
import { windowsRemoteDeliveryPassed, windowsRemoteDesktopReleased, windowsRemoteNaturalExitPassed, windowsRemoteDeferredRetirementCovered } from '../scripts/windows-remote-delivery.mjs'
const expected=[{pid:42,createdAtTicks:'639281324193729179',expectedExecutablePath:'C:\\own-uuid\\helper.exe'}]
const desktop={userInteractive:true,sessionId:1,activeDesktopAccessible:true,activeDesktopMatches:true,heldKeyCount:0,leaseScopeExists:true,leaseFree:true,journalPresent:false}
const audit={passed:true,terminate:false,results:[{pid:42,state:'already-exited'}],errors:[]}
const allRoles=['runner','fixture','agent','native','relay','guardian','capture']
const complete=()=>({businessPassed:true,expectedIdentities:allRoles.map((role,index)=>({...expected[0],pid:42+index,role})),cleanup:{errors:[],forced:[],bindingPolicySelfTest:{passed:true,checks:11},guest:{passed:true,errors:[],forced:[],deferredUntilOuterVerification:[{...expected[0],role:'runner'}],agent:{passed:true,nativeExit:{code:0,signal:null},oldTokenRejected:true},secretsDeleted:true,finalDesktop:desktop},task:{state:'Ready',result:0,unregistered:true,stopRequired:false},processes:{...audit,results:allRoles.map((_,index)=>({pid:42+index,state:'already-exited'}))}}})
test('Mac to Windows delivery requires natural retirement of every exact identity, not a successful process-inspection ACK',()=>{
 assert.equal(windowsRemoteNaturalExitPassed(audit,expected),true)
 for(const state of ['alive','terminated','unknown'])assert.equal(windowsRemoteNaturalExitPassed({...audit,results:[{pid:42,state}]},expected),false)
 assert.equal(windowsRemoteNaturalExitPassed({...audit,results:[]},expected),false)
 assert.equal(windowsRemoteNaturalExitPassed({...audit,terminate:true},expected),false)
 assert.equal(windowsRemoteNaturalExitPassed(audit,[{...expected[0],createdAtTicks:639281324193729179}]),false)
 assert.equal(windowsRemoteNaturalExitPassed(audit,[...expected,...expected]),false)
 assert.equal(windowsRemoteNaturalExitPassed(audit,[null]),false)
 assert.equal(windowsRemoteNaturalExitPassed({...audit,results:[null]},expected),false)
})
test('runner console retirement is deferred only to the exact outer audit, and a still-live console never passes',()=>{
 const value=complete(),console={...expected[0],pid:99,parentPid:42,role:'console'}
 value.expectedIdentities.push(console);value.cleanup.guest.deferredUntilOuterVerification.push(console);value.cleanup.processes.results.push({pid:99,state:'already-exited'})
 assert.equal(windowsRemoteDeliveryPassed(value),true)
 assert.equal(windowsRemoteDeferredRetirementCovered(value.cleanup.guest.deferredUntilOuterVerification,value.expectedIdentities),true)
 value.cleanup.processes.results.at(-1).state='alive';assert.equal(windowsRemoteDeliveryPassed(value),false)
 value.cleanup.processes.results.at(-1).state='already-exited';value.cleanup.guest.deferredUntilOuterVerification.pop();assert.equal(windowsRemoteDeliveryPassed(value),false)
 assert.equal(windowsRemoteDeferredRetirementCovered([{...console,parentPid:1}],value.expectedIdentities),false)
})
test('Windows desktop release refuses a foreign or inaccessible desktop, OS-held input and absent lease evidence',()=>{
 assert.equal(windowsRemoteDesktopReleased(desktop),true)
 for(const change of [{sessionId:0},{activeDesktopAccessible:false},{activeDesktopMatches:false},{heldKeyCount:1},{leaseScopeExists:false},{leaseFree:false},{journalPresent:true}])assert.equal(windowsRemoteDesktopReleased({...desktop,...change}),false)
})
test('Fifteen remote business passes cannot override forced cleanup, private config survival, task Stop or native failure',()=>{
 assert.equal(windowsRemoteDeliveryPassed(complete()),true)
 for(const change of [v=>v.businessPassed=false,v=>v.cleanup.forced.push('task'),v=>v.cleanup.errors.push('dispose failed'),v=>v.cleanup.guest.forced.push('native'),v=>v.cleanup.guest.agent.oldTokenRejected=false,v=>v.cleanup.guest.agent.nativeExit.code=1,v=>v.cleanup.guest.secretsDeleted=false,v=>v.cleanup.task.stopRequired=true,v=>v.cleanup.task.unregistered=false,v=>v.cleanup.task.result=1,v=>v.cleanup.processes={...audit,results:[{pid:42,state:'alive'}]}]){const v=complete();change(v);assert.equal(windowsRemoteDeliveryPassed(v),false)}
 const missingGuardian=complete();missingGuardian.expectedIdentities=missingGuardian.expectedIdentities.filter(row=>row.role!=='guardian');missingGuardian.cleanup.processes.results=missingGuardian.cleanup.processes.results.filter(row=>row.pid!==47);assert.equal(windowsRemoteDeliveryPassed(missingGuardian),false)
 const malformed=complete();malformed.cleanup.errors='';assert.equal(windowsRemoteDeliveryPassed(malformed),false)
 for(const identities of [null,{},'not-an-array',[null]]){const value=complete();value.expectedIdentities=identities;assert.equal(windowsRemoteDeliveryPassed(value),false)}
})
