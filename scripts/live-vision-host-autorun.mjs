/** Explicit, one-use trusted local carrier for the existing visual test loop. */
import { readFile, lstat } from 'node:fs/promises'
import { join, isAbsolute, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPrivateJSON, writePrivateJSON, checkPrivateDirectory, visionDigest } from './live-vision-external-core.mjs'
import { projectVisionOwnerRPC } from './live-vision-owner-evidence.mjs'
const fail=code=>{throw Object.assign(Error(code),{code})},sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v)
const sid=v=>typeof v==='string'&&v.startsWith('qiuya-vision-')&&uuid(v.slice(13))
const fields=['enabled','computerUseEnabled']
export function visionOwnPatchState(root,patchId,fiber){
 if(typeof root?.loader?.entries!=='function'||!fiber)fail('VISION_AUTORUN_LOADER_REQUIRED')
 const entries=[...root.loader.entries()],own=entries.filter(e=>e.options?.id===patchId)
 if(own.length>1||own.some(e=>e.options.name!=='qiuya-live-vision-test-only'))fail('VISION_AUTORUN_PATCH_CHANGED')
 return {present:own.length===1,sameFiber:own[0]?.fiber===fiber,active:own[0]?.fiber?.state===2,ownFiberDisposed:fiber.state===4,otherTestFiberActive:entries.some(e=>e.options?.name==='qiuya-live-vision-test-only'&&e.options.id!==patchId&&e.fiber?.state===2)}
}
export function validateVisionAutoRun(config,manifest,cap,now=Date.now()){
 if(config.testOnlyAutoRun!==true||!uuid(config.runId)||!sha(config.manifestSHA)||!Number.isSafeInteger(config.expiresAt)||config.expiresAt<=now||config.expiresAt>now+20*60000||!isAbsolute(config.directory)||resolve(config.directory)!==config.directory||!Array.isArray(config.testOnlySessionIds)||config.testOnlySessionIds.length!==3||new Set(config.testOnlySessionIds).size!==3||!config.testOnlySessionIds.every(sid))fail('VISION_AUTORUN_CONFIG')
 if(!manifest||manifest.version!==1||manifest.kind!=='trusted-local-owner-vision'||manifest.runId!==config.runId||manifest.expiresAt!==config.expiresAt||manifest.directory!==config.directory||manifest.patchEntryId!==config.testOnlyPatchEntryId||!/^qiuya-live-vision-test-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(manifest.patchEntryId)||manifest.requestLimit!==12||manifest.deadlineMs!==180000||JSON.stringify(manifest.sessionIds)!==JSON.stringify(config.testOnlySessionIds)||!['guardSha256','externalConfigSha256','nativeSha256','fixtureSha256','carrierSha256','auditSha256'].every(k=>sha(manifest[k])))fail('VISION_AUTORUN_MANIFEST')
 if(config.testOnlyProbeOnly!==undefined&&config.testOnlyProbeOnly!==true||manifest.probeOnly!==undefined&&manifest.probeOnly!==true||(config.testOnlyProbeOnly===true)!==(manifest.probeOnly===true))fail('VISION_AUTORUN_MANIFEST')
 for(const [key,field]of[['testOnlyNaturalEntry','naturalEntry'],['testOnlyOwnerOnce','testOnlyOwnerOnce']])if(config[key]!==undefined&&config[key]!==true||manifest[field]!==undefined&&manifest[field]!==true||(config[key]===true)!==(manifest[field]===true))fail('VISION_AUTORUN_MANIFEST')
 if((config.testOnlyNaturalEntry===true)!==(config.testOnlyOwnerOnce===true)||config.testOnlyNaturalEntry===true&&config.testOnlyProbeOnly===true)fail('VISION_AUTORUN_MANIFEST')
 if(config.testOnlyNaturalEntry===true&&(JSON.stringify(manifest.naturalEntryTaskIds)!=='[1]'||manifest.ownerOnceDriver!=='independent-trusted-test-driver-public-owner-rpc'))fail('VISION_AUTORUN_MANIFEST')
 if(!cap||cap.version!==1||cap.runId!==config.runId||cap.expiresAt!==config.expiresAt||cap.manifestSHA!==config.manifestSHA||!sha(cap.nonce)||!sha(cap.archiveSha256)||!isAbsolute(cap.archive)||dirname(cap.archive)!==config.directory)fail('VISION_AUTORUN_CAPABILITY')
 return manifest
}
/** No network or principal creation. Dispatch only as the same live owner Peer. */
export function createVisionLocalOwnerFetch(ctx,sessionIds,{signal,probeOnly=false,onDiagnostic,testOnlyNaturalEntry=false,testOnlyOwnerOnce=false}={}){
 if(testOnlyNaturalEntry!==testOnlyOwnerOnce||testOnlyNaturalEntry&&probeOnly)fail('VISION_NATURAL_CONFIGURATION')
 const peer=ctx.connection?.browserPeer
 if(peer?.principal?.kind!=='owner'||peer.signal?.aborted!==false||typeof ctx.connection.createSharedFetchHandler!=='function')fail('VISION_AUTORUN_OWNER_REQUIRED')
 const handler=ctx.connection.createSharedFetchHandler('/api');if(typeof handler?.fetch!=='function')fail('VISION_AUTORUN_ADAPTER_REQUIRED')
 const own=new Set(sessionIds),pairs=new Map();let nextTask=1,naturalCard,naturalStatus,oncePrepared=false,onceDispatched=false,onceReply,allowedApps
 const naturalId=testOnlyNaturalEntry?sessionIds[0]:null
 const appSnapshot=value=>Array.isArray(value)&&value.every(x=>typeof x==='string')?JSON.stringify([...value].sort()):null
 return async(path,options={})=>{
  if(ctx.connection.browserPeer!==peer||peer.principal.kind!=='owner'||peer.signal.aborted!==false)fail('VISION_AUTORUN_OWNER_CHANGED')
  if(options.method!=='POST'||typeof options.body!=='string'||Buffer.byteLength(options.body)>64000)fail('VISION_AUTORUN_SCOPE')
  const body=JSON.parse(options.body);let payload,kind,method,task
  if(path==='/api/qiuya-tools.vision-test'){
   payload=body;kind=body.op
   if(kind==='prepare'){task=body.task;if(task!==nextTask||![1,2,3].includes(task))fail('VISION_AUTORUN_SCOPE')}
   else if(['arm','status','finish','cancel','natural-once'].includes(kind)){if(!own.has(body.sessionId)||!pairs.has(body.sessionId))fail('VISION_AUTORUN_SCOPE')
    if(kind==='natural-once'){
     const p=body.proof,pair=pairs.get(naturalId)
     if(body.sessionId!==naturalId||!testOnlyOwnerOnce||!naturalCard||p?.sessionId!==naturalId||p?.appId!==pair?.authorizedAppId||p?.requestId!==naturalCard.requestId||p?.requestVersion!==1||p?.decision!=='once'||p?.allowedAppsUnchanged!==true)fail('VISION_AUTORUN_SCOPE')
     if(p.state==='pending'){if(oncePrepared||onceDispatched||naturalStatus?.entryRequested!==true||naturalStatus?.preauthorization?.passed!==true||JSON.stringify(p.preauthorization)!==JSON.stringify(naturalStatus.preauthorization))fail('VISION_AUTORUN_SCOPE');oncePrepared=true}
     else if(p.state==='approved'){if(!onceDispatched||onceReply?.state!=='approved'||onceReply.requestId!==p.requestId||onceReply.decision!=='once')fail('VISION_AUTORUN_SCOPE')}
     else fail('VISION_AUTORUN_SCOPE')
    }
   }
   else if(kind==='cancel-run'){if(nextTask!==1||pairs.size!==0||!['owner-settings-read','owner-enable','owner-status'].includes(body.phase))fail('VISION_AUTORUN_SCOPE')}
   else if(!['failure','delivery'].includes(kind))fail('VISION_AUTORUN_SCOPE')
  }else{
   method=path.slice('/api/'.length)
   if(!['settings/describe','settings/mutate','session/prompt','session/cancel','qiuya-tools.computer.control'].includes(method)||path!=='/api/'+method||body.type!=='client-request'||body.method!==method||typeof body.rpcId!=='string')fail('VISION_AUTORUN_SCOPE')
   payload=method==='qiuya-tools.computer.control'?body.payload:body.payload?.args
   if(method==='settings/mutate'){
    if(payload?.ns!=='qiuya-tools'||!Array.isArray(payload.ops)||payload.ops.length>2||payload.ops.some(o=>!['set','unset'].includes(o.op)||o.path?.length!==1||!fields.includes(o.path[0])||o.op==='set'&&typeof o.value!=='boolean'))fail('VISION_AUTORUN_SCOPE')
   }else if(method==='session/prompt'||method==='session/cancel'){
    if(!own.has(payload?.request?.sessionId)||!pairs.has(payload.request.sessionId))fail('VISION_AUTORUN_SCOPE')
   }else if(method==='qiuya-tools.computer.control'){
    if(!['status','connect','start','stop',...(testOnlyNaturalEntry?['pending','decide']:[])].includes(payload?.op)||payload.op!=='status'&&(!own.has(payload.sessionId)||!pairs.has(payload.sessionId))||payload.sessionId!==undefined&&!own.has(payload.sessionId))fail('VISION_AUTORUN_SCOPE')
    const pair=pairs.get(payload.sessionId)
    if(payload.op==='start'&&payload.targetId!==pair?.targetId||payload.op==='connect'&&payload.mode!=='local'&&(payload.mode!=='remote'||payload.endpoint!==pair?.endpoint||payload.token!==pair?.token))fail('VISION_AUTORUN_SCOPE')
    if(payload.op==='start'&&payload.sessionId===naturalId)fail('VISION_AUTORUN_SCOPE')
    if(['pending','decide'].includes(payload.op)&&payload.sessionId!==naturalId)fail('VISION_AUTORUN_SCOPE')
    if(payload.op==='decide'){
     if(!testOnlyOwnerOnce||!oncePrepared||onceDispatched||payload.decision!=='once'||payload.requestVersion!==1||payload.requestId!==naturalCard?.requestId||naturalCard.expiresAt<=Date.now())fail('VISION_AUTORUN_SCOPE')
     onceDispatched=true
    }
   }
  }
  if(probeOnly&&(kind&&kind!=='failure'||method&& !['settings/describe','qiuya-tools.computer.control'].includes(method)||method==='qiuya-tools.computer.control'&&payload?.op!=='status'))fail('VISION_AUTORUN_SCOPE')
  if(signal?.aborted&&(kind==='prepare'||kind==='arm'||kind==='status'||kind==='natural-once'||method==='session/prompt'||method==='qiuya-tools.computer.control'&&(payload.op==='decide'||payload.op==='start'||payload.op==='connect'&&payload.mode==='remote')))fail('VISION_AUTORUN_CANCELLED')
  if(method)await onDiagnostic?.({phase:'started',rpc:projectVisionOwnerRPC({method,phase:options.visionPhase})})
  let response
  try{response=await handler.fetch(new Request('http://127.0.0.1'+path,{method:options.method,headers:options.headers,body:options.body,redirect:'error'}),peer)}
  catch(error){if(method)try{await onDiagnostic?.({phase:'failed',rpc:projectVisionOwnerRPC({method,phase:options.visionPhase,error})})}catch{};throw error}
  if(method){let value;try{value=await response.clone().json()}catch{};await onDiagnostic?.({phase:'answered',rpc:projectVisionOwnerRPC({method,phase:options.visionPhase,response,value,requestRpcId:body.rpcId})})}
  if(testOnlyNaturalEntry&&method==='qiuya-tools.computer.control'){
   const reply=await response.clone().json(),value=reply?.result?.value
   if(!response.ok||reply?.rpcId!==body.rpcId||reply?.result?.ok!==true)fail('VISION_NATURAL_OWNER_RPC')
   if(payload.op==='status'){
    const current=appSnapshot(value?.allowedApps);if(current===null)fail('VISION_NATURAL_ALLOWLIST')
    if(allowedApps===undefined)allowedApps=current;else if(allowedApps!==current)fail('VISION_NATURAL_ALLOWLIST')
   }
   if(payload.op==='pending'){
    if(!Array.isArray(value?.pendingRequests)||value.pendingRequests.length>1)fail('VISION_NATURAL_APPROVAL')
    const card=value.pendingRequests[0]
    if(card){if(card.sessionId!==naturalId||card.appId!==pairs.get(naturalId)?.authorizedAppId||card.requestVersion!==1||card.state!=='pending'||typeof card.requestId!=='string'||!card.requestId||card.expiresAt<=Date.now()||naturalCard&&naturalCard.requestId!==card.requestId)fail('VISION_NATURAL_APPROVAL');naturalCard=card}
   }
   if(payload.op==='decide'){
    if(value?.requestId!==naturalCard.requestId||value?.decision!=='once'||value?.state!=='approved'||value.session?.sessionId!==naturalId||value.session?.target?.id!==pairs.get(naturalId)?.targetId||value.session?.target?.appId!==pairs.get(naturalId)?.authorizedAppId)fail('VISION_NATURAL_APPROVAL')
    onceReply=value
   }
  }
  if(testOnlyNaturalEntry&&kind==='status'&&body.sessionId===naturalId){const reply=await response.clone().json();if(reply?.ok===true)naturalStatus=reply.value}
  if(kind==='prepare'){
   const value=await response.clone().json()
   if(response.ok&&value.ok){const ready=value.value;if(ready?.sessionId!==sessionIds[task-1]||typeof ready.endpoint!=='string'||typeof ready.token!=='string'||typeof ready.targetId!=='string'||testOnlyNaturalEntry&&task===1&&(ready.testOnlyNaturalEntry!==true||typeof ready.authorizedAppId!=='string'||!ready.authorizedAppId))fail('VISION_AUTORUN_SCOPE');pairs.set(ready.sessionId,{endpoint:ready.endpoint,token:ready.token,targetId:ready.targetId,authorizedAppId:ready.authorizedAppId});nextTask++}
  }
  return response
 }
}
export function installVisionHostAutoRun(ctx,config,{run,moduleUrl}={}){
 if(config?.testOnlyAutoRun!==true)return undefined
 const abort=new AbortController();let terminal=false,authority,lastResult;const root=ctx.root,fiber=ctx.fiber
 const execution=(async()=>{
  // Return apply() to Cordis before any configuration transaction is requested.
  await new Promise(done=>setTimeout(done,0))
  const directory=resolve(config.directory),evidence=join(directory,'evidence');let bound=false,consumed=false,privateReady=false
  try{
   await checkPrivateDirectory(directory);await checkPrivateDirectory(evidence);privateReady=true
   const trigger=join(directory,'autorun-trigger.json'),triggerInfo=await lstat(trigger)
   if((triggerInfo.mode&0o777)!==0o600)fail('VISION_AUTORUN_CAPABILITY')
   const manifest=await readPrivateJSON(join(directory,'autorun-manifest.json')),cap=await readPrivateJSON(trigger)
   validateVisionAutoRun(config,manifest,cap)
   if(visionDigest(Buffer.from(JSON.stringify(manifest)))!==config.manifestSHA)fail('VISION_AUTORUN_MANIFEST')
   const external=await readPrivateJSON(config.externalCarrierConfig)
   if(visionDigest(Buffer.from(JSON.stringify(external)))!==manifest.externalConfigSha256||external.runId!==config.runId||external.expiresAt!==config.expiresAt||external.directory!==directory||['nativeSha256','fixtureSha256','carrierSha256','auditSha256'].some(k=>external[k]!==manifest[k]))fail('VISION_AUTORUN_MANIFEST')
   const modulePath=fileURLToPath(moduleUrl),info=await lstat(modulePath)
   if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024||visionDigest(await readFile(modulePath))!==manifest.guardSha256||visionDigest(await readFile(cap.archive))!==cap.archiveSha256)fail('VISION_AUTORUN_SOURCE')
   if(!['agents','sessionController','agentDefaultModel','tools'].every(k=>ctx[k])||typeof ctx.agents.create!=='function'||typeof ctx.sessionController.prompt!=='function'||typeof ctx.sessionController.cancel!=='function'||typeof ctx.agentDefaultModel.currentSelection!=='function')fail('VISION_AUTORUN_SDK')
   let evidenceSequence=0,originalSaved=false
   const evidenceBinding={version:1,runId:config.runId,manifestSHA:config.manifestSHA,hostPid:process.pid,patchEntryId:manifest.patchEntryId}
   const transport=createVisionLocalOwnerFetch(ctx,config.testOnlySessionIds,{signal:abort.signal,probeOnly:config.testOnlyProbeOnly===true,testOnlyNaturalEntry:config.testOnlyNaturalEntry===true,testOnlyOwnerOnce:config.testOnlyOwnerOnce===true,onDiagnostic:async receipt=>{
    if(++evidenceSequence>2048)fail('VISION_DIAGNOSTIC_WRITE_FAILED')
    await writePrivateJSON(join(evidence,`owner-rpc-${String(evidenceSequence).padStart(4,'0')}.json`),{...evidenceBinding,...receipt})
    if(!originalSaved&&receipt.rpc.method==='settings/describe'&&receipt.rpc.remoteOK===true&&receipt.rpc.rpcIdMatches===true&&receipt.rpc.settings?.present){await writePrivateJSON(join(evidence,'owner-settings-original.json'),{...evidenceBinding,snapshot:receipt.rpc.settings});originalSaved=true}
   }});bound=true
   const readyDeadline=Date.now()+10000;let patch
   do{patch=visionOwnPatchState(root,manifest.patchEntryId,fiber);if(patch.present&&patch.sameFiber&&patch.active&&!patch.otherTestFiberActive)break;if(abort.signal.aborted||Date.now()>=readyDeadline)fail('VISION_AUTORUN_PATCH_NOT_ACTIVE');await new Promise(r=>setTimeout(r,25))}while(true)
   const binding={version:1,runId:config.runId,manifestSHA:config.manifestSHA,hostPid:process.pid,patchEntryId:manifest.patchEntryId,sessionIds:config.testOnlySessionIds}
   // This O_EXCL/link-backed private receipt precedes every side effect. A
   // crash, HMR reload or unknown result leaves it consumed and cannot replay.
   if(abort.signal.aborted||Date.now()>=config.expiresAt)fail('VISION_AUTORUN_CANCELLED')
   await writePrivateJSON(join(evidence,'host-autorun-consumed.json'),{...binding,consumed:true});consumed=true;authority=binding
   await writePrivateJSON(join(evidence,'host-activation.json'),{...binding,status:'active',probeOnly:config.testOnlyProbeOnly===true,testOnlyNaturalEntry:config.testOnlyNaturalEntry===true,testOnlyOwnerOnce:config.testOnlyOwnerOnce===true,officialLocalOwnerAdapter:true,existingPeerReused:true,ownerPeerPresent:true,ownerPeerActive:true,sdkAvailable:true,exactPatchActive:patch.active&&patch.sameFiber,requestLimit:12,deadlineMs:180000,credentialsRead:false})
   const result=await run(transport,()=>{},{probeOnly:config.testOnlyProbeOnly===true,testOnlyNaturalEntry:config.testOnlyNaturalEntry===true,testOnlyOwnerOnce:config.testOnlyOwnerOnce===true});lastResult=result
   await writePrivateJSON(join(evidence,'host-autorun-result.json'),{...binding,status:result?.probePassed===true?'probe-passed':result?.passed===true?'passed':'failed',result})
   terminal=true
  }catch(error){
   if(privateReady&&uuid(config.runId)&&sha(config.manifestSHA))try{await writePrivateJSON(join(evidence,consumed?'host-autorun-failed.json':'host-activation-failed.json'),{version:1,runId:config.runId,manifestSHA:config.manifestSHA,status:'failed',consumed,ownerAdapterBound:bound,error:typeof error.code==='string'&&/^[A-Z_]+$/u.test(error.code)?error.code:'VISION_AUTORUN_FAILED',retryAllowed:false})}catch{}
   terminal=true
  }
 })()
 return {done:execution,async stop(){if(!terminal)abort.abort();await execution},async recordDeactivation({ownedCleanupPassed,routesRemoved}){
  if(!authority)return
  const runnerRestorationConfirmed=lastResult?.restoration?.localMode===true&&lastResult?.restoration?.featureFlags===true
  await writePrivateJSON(join(config.directory,'evidence/host-deactivation.json'),{...authority,status:ownedCleanupPassed&&routesRemoved&&runnerRestorationConfirmed?'passed':'failed',runnerSettled:terminal,ownedCleanupPassed:ownedCleanupPassed===true,routesRemoved:routesRemoved===true,runnerRestorationConfirmed})
  // Do not await our own Fiber becoming inactive from inside its disposer.
  // The captured application root supplies a bounded read-only SDK observer.
  void (async()=>{let passed=false,error,patch;try{const deadline=Date.now()+15000;do{await new Promise(r=>setTimeout(r,25));patch=visionOwnPatchState(root,authority.patchEntryId,fiber);if(!patch.present&&patch.ownFiberDisposed&&!patch.otherTestFiberActive){passed=true;break}}while(Date.now()<deadline);if(!passed)error='VISION_AUTORUN_PATCH_STILL_ACTIVE'}catch{error='VISION_AUTORUN_PATCH_STATE_UNCONFIRMED'}try{await writePrivateJSON(join(config.directory,'evidence/host-patch-inactive.json'),{...authority,status:passed?'passed':'failed',exactPatchInactive:passed,observedPresent:patch?.present??null,ownFiberDisposed:patch?.ownFiberDisposed??false,error:error??null,readOnly:true})}catch{}})()
 }}
}
