import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { validateVisionAutoRun, createVisionLocalOwnerFetch, installVisionHostAutoRun, visionOwnPatchState } from '../scripts/live-vision-host-autorun.mjs'
import { visionDigest, writePrivateJSON, readPrivateJSON } from '../scripts/live-vision-external-core.mjs'
import { projectVisionCLIList, runVisionOfficialCLI, pinVisionInstalledBundle, visionUnrelatedManifestSHA } from '../scripts/live-vision-official-cli.mjs'
const sessionIds=[1,2,3].map(()=>`qiuya-vision-${randomUUID()}`),runId=randomUUID(),hash='a'.repeat(64)
const config={testOnlyAutoRun:true,directory:'/private/tmp/own-vision',runId,expiresAt:Date.now()+600000,manifestSHA:hash,testOnlySessionIds:sessionIds,testOnlyPatchEntryId:'qiuya-live-vision-test-'+randomUUID()}
const manifest={version:1,kind:'trusted-local-owner-vision',runId,expiresAt:config.expiresAt,directory:config.directory,sessionIds,patchEntryId:config.testOnlyPatchEntryId,requestLimit:12,deadlineMs:180000,guardSha256:hash,externalConfigSha256:hash,nativeSha256:hash,fixtureSha256:hash,carrierSha256:hash,auditSha256:hash}
const cap={version:1,runId,expiresAt:config.expiresAt,manifestSHA:hash,nonce:'b'.repeat(64),archive:'/private/tmp/own-vision/own.tgz',archiveSha256:hash}
const envelope=(method,payload)=>({method:'POST',body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:method==='qiuya-tools.computer.control'?payload:{args:payload}})})
const call=(fetch,body)=>fetch('/api/qiuya-tools.vision-test',{method:'POST',body:JSON.stringify(body)})
test('autorun requires explicit exact finite config/manifest/cap and three distinct owned SIDs',()=>{
 assert.equal(validateVisionAutoRun(config,manifest,cap),manifest)
 for(const patch of[{testOnlyAutoRun:false},{runId:randomUUID()},{expiresAt:Date.now()-1},{manifestSHA:'bad'},{testOnlySessionIds:[sessionIds[0],sessionIds[0],sessionIds[2]]}])assert.throws(()=>validateVisionAutoRun({...config,...patch},manifest,cap))
 for(const patch of[{requestLimit:13},{deadlineMs:180001},{guardSha256:'bad'},{sessionIds:[...sessionIds].reverse()},{expiresAt:config.expiresAt+1}])assert.throws(()=>validateVisionAutoRun(config,{...manifest,...patch},cap))
 for(const patch of[{manifestSHA:'c'.repeat(64)},{runId:randomUUID()},{archive:'/private/tmp/foreign/own.tgz'}])assert.throws(()=>validateVisionAutoRun(config,manifest,{...cap,...patch}))
 assert.throws(()=>validateVisionAutoRun({...config,testOnlyProbeOnly:true},manifest,cap),{code:'VISION_AUTORUN_MANIFEST'})
 assert.throws(()=>validateVisionAutoRun(config,{...manifest,probeOnly:true},cap),{code:'VISION_AUTORUN_MANIFEST'})
 assert.equal(validateVisionAutoRun({...config,testOnlyProbeOnly:true},{...manifest,probeOnly:true},cap).probeOnly,true)
})
function context(){
 const peer={principal:{kind:'owner'},signal:new AbortController().signal},calls=[],fiber={state:2},entry={options:{id:config.testOnlyPatchEntryId,name:'qiuya-live-vision-test-only'},fiber}
 return {calls,peer,fiber,root:{loader:{*entries(){yield entry}}},agents:{create(){}},sessionController:{prompt(){},cancel(){}},agentDefaultModel:{currentSelection(){}},tools:{},connection:{
  browserPeer:peer,
  createSharedFetchHandler(channel){
   assert.equal(channel,'/api')
   return {async fetch(request,actual){
    assert.equal(actual,peer);const body=await request.json();calls.push({path:new URL(request.url).pathname,body,peer:actual})
    if(body.op==='prepare')return Response.json({ok:true,value:{sessionId:sessionIds[body.task-1],endpoint:'http://127.0.0.1:1234/v1/computer',token:'PRIVATE_PAIR_ONLY',targetId:'window:own'}})
    return Response.json({ok:true})
   }}
  },
  createPeer(){assert.fail('A principal must never be manufactured')},
 }}
}
test('official local adapter reuses the exact owner Peer and rejects cross-SID, route, pair and settings scope',async()=>{
 const ctx=context(),fetch=createVisionLocalOwnerFetch(ctx,sessionIds)
 await call(fetch,{op:'prepare',task:1});await fetch('/api/qiuya-tools.computer.control',envelope('qiuya-tools.computer.control',{op:'connect',sessionId:sessionIds[0],mode:'remote',endpoint:'http://127.0.0.1:1234/v1/computer',token:'PRIVATE_PAIR_ONLY'}))
 await fetch('/api/session/prompt',envelope('session/prompt',{request:{sessionId:sessionIds[0],content:[{type:'text',text:'synthetic own test'}]}}))
 assert.equal(ctx.calls.length,3);assert.ok(ctx.calls.every(x=>x.peer===ctx.peer))
 for(const operation of[
  ()=>call(fetch,{op:'prepare',task:1}),()=>call(fetch,{op:'arm',sessionId:'foreign'}),
  ()=>fetch('/api/session/prompt',envelope('session/prompt',{request:{sessionId:'user-chat'}})),
  ()=>fetch('/api/qiuya-tools.computer.control',envelope('qiuya-tools.computer.control',{op:'start',sessionId:sessionIds[0],targetId:'window:foreign'})),
  ()=>fetch('/api/qiuya-tools.computer.control',envelope('qiuya-tools.computer.control',{op:'connect',sessionId:sessionIds[0],mode:'remote',endpoint:'http://foreign',token:'PRIVATE_PAIR_ONLY'})),
  ()=>fetch('/api/settings/mutate',envelope('settings/mutate',{ns:'models',ops:[]})),
  ()=>fetch('/api/settings/mutate',envelope('settings/mutate',{ns:'qiuya-tools',ops:[{op:'set',path:['otherFeature'],value:true}]})),
  ()=>fetch('/api/pluginManager/installBundle',envelope('pluginManager/installBundle',{})),
 ])await assert.rejects(operation,{code:'VISION_AUTORUN_SCOPE'})
 ctx.connection.browserPeer={principal:{kind:'owner'}};await assert.rejects(call(fetch,{op:'status',sessionId:sessionIds[0]}),{code:'VISION_AUTORUN_OWNER_CHANGED'})
 assert.throws(()=>createVisionLocalOwnerFetch({connection:{browserPeer:{principal:{kind:'guest'}}}},sessionIds),{code:'VISION_AUTORUN_OWNER_REQUIRED'})
 for(const candidate of[undefined,{principal:{kind:'owner'}},{principal:{kind:'owner'},signal:AbortSignal.abort()}])assert.throws(()=>createVisionLocalOwnerFetch({connection:{browserPeer:candidate}},sessionIds),{code:'VISION_AUTORUN_OWNER_REQUIRED'})
})
test('abort blocks new model/input and still admits only own cancellation, stop and local restore',async()=>{
 const ctx=context(),abort=new AbortController(),fetch=createVisionLocalOwnerFetch(ctx,sessionIds,{signal:abort.signal})
 await call(fetch,{op:'prepare',task:1});abort.abort()
 await assert.rejects(fetch('/api/session/prompt',envelope('session/prompt',{request:{sessionId:sessionIds[0]}})),{code:'VISION_AUTORUN_CANCELLED'})
 await assert.rejects(call(fetch,{op:'status',sessionId:sessionIds[0]}),{code:'VISION_AUTORUN_CANCELLED'})
 await fetch('/api/session/cancel',envelope('session/cancel',{request:{sessionId:sessionIds[0]}}))
 await fetch('/api/qiuya-tools.computer.control',envelope('qiuya-tools.computer.control',{op:'stop',sessionId:sessionIds[0]}))
 await fetch('/api/qiuya-tools.computer.control',envelope('qiuya-tools.computer.control',{op:'connect',sessionId:sessionIds[0],mode:'local'}))
 await call(fetch,{op:'finish',sessionId:sessionIds[0]})
 assert.equal(ctx.calls.length,5)
})
async function prepared(t){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'qiuya-host-auto-')));await chmod(directory,0o700);t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(join(directory,'evidence'),{mode:0o700})
 const modulePath=join(directory,'guard.mjs'),archive=join(directory,'own.tgz'),externalCarrierConfig=join(directory,'external-config.json')
 await writeFile(modulePath,'// synthetic offline module, no inference\n');await writeFile(archive,'synthetic offline archive')
 const external={version:1,platform:'win32',rendezvousNonce:'e'.repeat(64),runId,expiresAt:config.expiresAt,directory,native:join(directory,'native.exe'),fixture:join(directory,'fixture.exe'),carrier:join(directory,'carrier.mjs'),nativeSha256:hash,fixtureSha256:hash,carrierSha256:hash,auditSha256:hash};await writePrivateJSON(externalCarrierConfig,external)
 const ownManifest={...manifest,directory,guardSha256:visionDigest(await readFile(modulePath)),externalConfigSha256:visionDigest(JSON.stringify(external))},manifestSHA=visionDigest(JSON.stringify(ownManifest)),cfg={...config,directory,manifestSHA,externalCarrierConfig}
 await writePrivateJSON(join(directory,'autorun-manifest.json'),ownManifest);await writePrivateJSON(join(directory,'autorun-trigger.json'),{...cap,manifestSHA,archive,archiveSha256:visionDigest(await readFile(archive))})
 return{directory,cfg,moduleUrl:pathToFileURL(modulePath).href}
}
test('actual private O_EXCL consumption precedes one shared-run callback and suppresses concurrent activation/reload',async t=>{
 if(process.platform!=='darwin'){t.skip('Host autorun deliberately belongs to the existing Mac owner');return}
 const p=await prepared(t),ctx=context();let runs=0
 const run=async()=>{runs++;assert.equal((await readPrivateJSON(join(p.directory,'evidence/host-autorun-consumed.json'))).consumed,true);return{passed:true,kind:'offline-synthetic-no-inference',restoration:{localMode:true,featureFlags:true}}}
 const a=installVisionHostAutoRun(ctx,p.cfg,{run,moduleUrl:p.moduleUrl}),b=installVisionHostAutoRun(ctx,p.cfg,{run,moduleUrl:p.moduleUrl});await Promise.all([a.done,b.done]);assert.equal(runs,1)
 const activation=await readPrivateJSON(join(p.directory,'evidence/host-activation.json'));assert.equal(activation.existingPeerReused,true);assert.equal(activation.hostPid,process.pid)
 assert.equal((await stat(join(p.directory,'evidence/host-autorun-consumed.json'))).mode&0o777,0o600)
 const result=await readPrivateJSON(join(p.directory,'evidence/host-autorun-result.json'));assert.equal(result.status,'passed');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PAIR_ONLY/u)
 await a.stop();await b.stop();assert.equal(runs,1)
 ctx.root.loader.entries=function*(){};ctx.fiber.state=5
 await Promise.all([a.recordDeactivation({ownedCleanupPassed:true,routesRemoved:true}),b.recordDeactivation({ownedCleanupPassed:true,routesRemoved:true})])
 await new Promise(r=>setTimeout(r,60));await assert.rejects(readFile(join(p.directory,'evidence/host-patch-inactive.json')),{code:'ENOENT'})
 ctx.fiber.state=4
 let inactive;for(let i=0;i<30&&!inactive;i++){try{inactive=await readPrivateJSON(join(p.directory,'evidence/host-patch-inactive.json'))}catch(e){if(e.code!=='ENOENT')throw e;await new Promise(r=>setTimeout(r,10))}}
 assert.equal(inactive.exactPatchInactive,true);assert.equal(inactive.ownFiberDisposed,true);assert.equal(inactive.observedPresent,false)
})
test('patch projection requires a real loader and exact unique entry; another test fiber cannot be hidden',()=>{
 const ctx=context(),value=visionOwnPatchState(ctx.root,config.testOnlyPatchEntryId,ctx.fiber)
 assert.equal(value.sameFiber,true);assert.equal(value.active,true);assert.equal(value.ownFiberDisposed,false)
 assert.throws(()=>visionOwnPatchState({},config.testOnlyPatchEntryId,ctx.fiber),{code:'VISION_AUTORUN_LOADER_REQUIRED'})
 const other={options:{id:'other',name:'qiuya-live-vision-test-only'},fiber:{state:2}};assert.equal(visionOwnPatchState({loader:{*entries(){yield other}}},config.testOnlyPatchEntryId,ctx.fiber).otherTestFiberActive,true)
})
test('loading without explicit config, a changed archive or a public trigger cannot execute the shared runner',async t=>{
 assert.equal(installVisionHostAutoRun({},{}),undefined)
 if(process.platform!=='darwin'){t.skip('Private Mac owner file boundary');return}
 for(const mode of['changed-archive','public-trigger']){
  const p=await prepared(t);if(mode==='changed-archive')await writeFile(join(p.directory,'own.tgz'),'changed');else await chmod(join(p.directory,'autorun-trigger.json'),0o644)
  let calls=0;const controller=installVisionHostAutoRun(context(),p.cfg,{run:async()=>{calls++},moduleUrl:p.moduleUrl});await controller.done;assert.equal(calls,0)
  await assert.rejects(readFile(join(p.directory,'evidence/host-activation.json')),{code:'ENOENT'})
 }
})
test('official CLI inventory projects only the named test bundle and requires dependency/selection agreement',()=>{
 const name='qiuya-live-vision-test-only',rows=[{path:'/private/tmp/profile',dependencies:{[name]:{version:'0.0.0',from:'PRIVATE-DO-NOT-OUTPUT'},unrelated:{version:'PRIVATE-DO-NOT-OUTPUT'}}}],pkg={dependencies:{[name]:'PRIVATE-DO-NOT-OUTPUT'},dsh:{profile:{bundles:[name]}}}
 assert.deepEqual(projectVisionCLIList(rows,pkg),{bundle:name,dependencyPresent:true,bundleSelected:true,version:'0.0.0'})
 assert.doesNotMatch(JSON.stringify(projectVisionCLIList(rows,pkg)),/PRIVATE|unrelated|profile/u)
 assert.throws(()=>projectVisionCLIList(rows,{dependencies:{},dsh:{profile:{bundles:[]}}}),{code:'VISION_CLI_LIST_UNCONFIRMED'})
 for(const scope of['devDependencies','optionalDependencies'])assert.equal(projectVisionCLIList([{path:'/private/tmp/profile',[scope]:{[name]:{version:'0.0.0'}}}],{[scope]:{[name]:'own'},dsh:{profile:{bundles:[name]}}}).dependencyPresent,true)
 assert.equal(visionUnrelatedManifestSHA(pkg),visionUnrelatedManifestSHA({...pkg,dependencies:{},dsh:{profile:{bundles:[]}}}))
})
test('an unknown official add result is issued once and never retried; CLI zero alone cannot prove activation',async t=>{
 if(process.platform!=='darwin'){t.skip('Mac owner CLI test boundary');return}
 const oldExitCode=process.exitCode;t.after(()=>{process.exitCode=oldExitCode})
 for(const unknown of[true,false]){
  const p=await prepared(t),name='qiuya-live-vision-test-only',cli='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',profile=join(p.directory,'profile');await mkdir(profile,{mode:0o700})
  const pkg={dependencies:{},dsh:{profile:{bundles:[]}}};await writeFile(join(profile,'package.json'),JSON.stringify(pkg));await mkdir(join(p.directory,'external'),{mode:0o700})
  await writePrivateJSON(join(p.directory,'plugin-config.json'),p.cfg)
  const external=await readPrivateJSON(p.cfg.externalCarrierConfig);await writePrivateJSON(join(p.directory,'external/carrier-ready.json'),{version:1,platform:'win32',runId:external.runId,rendezvousNonce:external.rendezvousNonce,nativeSha256:external.nativeSha256,fixtureSha256:external.fixtureSha256,auditSha256:external.auditSha256})
  const cap=await readPrivateJSON(join(p.directory,'autorun-trigger.json'));await writePrivateJSON(join(p.directory,'official-cli-install.json'),{executable:cli,args:['plugin','--profile','desktop','add','--save-exact',cap.archive],archiveSha256:cap.archiveSha256})
  let adds=0
  const execute=async(file,args)=>{assert.equal(file,cli);if(args.includes('list'))return{stdout:JSON.stringify([{path:profile,dependencies:adds&&!unknown?{[name]:{version:'0.0.0'}}:{}}]),stderr:''};adds++;if(unknown)throw Object.assign(Error('not emitted'),{code:'ETIMEDOUT',stdout:'DO-NOT-OUTPUT',stderr:'DO-NOT-OUTPUT'});pkg.dependencies[name]='own';await writeFile(join(profile,'package.json'),JSON.stringify(pkg));return{stdout:'',stderr:''}}
  const report=await runVisionOfficialCLI({directory:p.directory,mode:'install',rootApproved:true,execute});assert.equal(adds,1);assert.equal(report.status,'failed');assert.equal(report.actualHostReceipt,false);assert.doesNotMatch(JSON.stringify(report),/DO-NOT-OUTPUT/u)
  await assert.rejects(runVisionOfficialCLI({directory:p.directory,mode:'install',rootApproved:true,execute}));assert.equal(adds,1)
 }
})
test('official install/remove success also requires selected dependency, exact activation and fully retired patch receipts',async t=>{
 if(process.platform!=='darwin'){t.skip('Mac owner CLI test boundary');return}
 const p=await prepared(t),name='qiuya-live-vision-test-only',cli='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',profile=join(p.directory,'profile');await mkdir(profile,{mode:0o700});await mkdir(join(p.directory,'external'),{mode:0o700})
 const pkg={dependencies:{},dsh:{profile:{bundles:[]}}};await writeFile(join(profile,'package.json'),JSON.stringify(pkg));await writePrivateJSON(join(p.directory,'plugin-config.json'),p.cfg)
 const external=await readPrivateJSON(p.cfg.externalCarrierConfig);await writePrivateJSON(join(p.directory,'external/carrier-ready.json'),{version:1,platform:'win32',runId:external.runId,rendezvousNonce:external.rendezvousNonce,nativeSha256:external.nativeSha256,fixtureSha256:external.fixtureSha256,auditSha256:external.auditSha256})
 const cap=await readPrivateJSON(join(p.directory,'autorun-trigger.json'));await writePrivateJSON(join(p.directory,'official-cli-install.json'),{executable:cli,args:['plugin','--profile','desktop','add','--save-exact',cap.archive],archiveSha256:cap.archiveSha256});await writePrivateJSON(join(p.directory,'official-cli-remove.json'),{executable:cli,args:['plugin','--profile','desktop','remove',name]})
 const binding={runId:p.cfg.runId,manifestSHA:p.cfg.manifestSHA,patchEntryId:p.cfg.testOnlyPatchEntryId}
 let adds=0,removes=0
 const execute=async(file,args)=>{
  assert.equal(file,cli)
  if(args.includes('list'))return{stdout:JSON.stringify([{path:profile,dependencies:pkg.dependencies[name]?{[name]:{version:'0.0.0'}}:{}}]),stderr:''}
  if(args.includes('add')){adds++;pkg.dependencies[name]='own';pkg.dsh.profile.bundles=[name];await createInstalledBundle(profile,p.cfg,p.moduleUrl);await writePrivateJSON(join(p.directory,'evidence/host-activation.json'),{...binding,status:'active',exactPatchActive:true,existingPeerReused:true,ownerPeerActive:true})}
  else{removes++;delete pkg.dependencies[name];pkg.dsh.profile.bundles=[];await writePrivateJSON(join(p.directory,'evidence/host-deactivation.json'),{...binding,status:'passed',runnerSettled:true,ownedCleanupPassed:true,routesRemoved:true,runnerRestorationConfirmed:true});await writePrivateJSON(join(p.directory,'evidence/host-patch-inactive.json'),{...binding,status:'passed',exactPatchInactive:true,ownFiberDisposed:true,observedPresent:false})}
  await writeFile(join(profile,'package.json'),JSON.stringify(pkg));return{stdout:'',stderr:''}
 }
 const installed=await runVisionOfficialCLI({directory:p.directory,mode:'install',rootApproved:true,execute});assert.equal(installed.status,'passed');assert.equal(installed.actualHostReceipt,true);assert.equal(adds,1)
 await writePrivateJSON(join(p.directory,'evidence/host-autorun-result.json'),{...binding,status:'failed',result:{passed:false,restoration:{localMode:true,featureFlags:true}}})
 const removed=await runVisionOfficialCLI({directory:p.directory,mode:'remove',rootApproved:true,execute});assert.equal(removed.status,'passed');assert.equal(removed.after.dependencyPresent,false);assert.equal(removed.after.bundleSelected,false);assert.equal(removes,1)
})
async function createInstalledBundle(profile,cfg,moduleUrl){
 const directory=join(profile,'node_modules/qiuya-live-vision-test-only');await mkdir(directory,{recursive:true})
 await writeFile(join(directory,'package.json'),JSON.stringify({name:'qiuya-live-vision-test-only',version:'0.0.0',main:'./guard-plugin.mjs',exports:{'.':'./guard-plugin.mjs'},dsh:{bundle:{patch:'cordis.patch.yml'}}}))
 await writeFile(join(directory,'guard-plugin.mjs'),await readFile(new URL(moduleUrl)))
 await writeFile(join(directory,'cordis.patch.yml'),JSON.stringify([{insert:[{id:cfg.testOnlyPatchEntryId,name:'qiuya-live-vision-test-only',config:cfg}]}]))
 return directory
}
test('startup recovery removes only the pinned fresh dependency and never calls missing runtime evidence a natural/model pass',async t=>{
 if(process.platform!=='darwin'){t.skip('Mac owner CLI test boundary');return}
 const oldExitCode=process.exitCode;t.after(()=>{process.exitCode=oldExitCode})
 const p=await prepared(t),profile=join(p.directory,'profile'),name='qiuya-live-vision-test-only',cli='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';await mkdir(profile,{mode:0o700});const installed=await createInstalledBundle(profile,p.cfg,p.moduleUrl)
 const pkg={dependencies:{[name]:'own','user-existing-plugin':'unchanged'},dsh:{profile:{bundles:['user-existing-plugin',name]}},otherUserField:{value:'unchanged'}};await writeFile(join(profile,'package.json'),JSON.stringify(pkg));await writePrivateJSON(join(p.directory,'plugin-config.json'),p.cfg)
 await writePrivateJSON(join(p.directory,'official-cli-remove.json'),{executable:cli,args:['plugin','--profile','desktop','remove',name]})
 await writePrivateJSON(join(p.directory,'evidence/cli-install-attempt.json'),{runId:p.cfg.runId,manifestSHA:p.cfg.manifestSHA,bundle:name,profileIdentitySha256:visionDigest(profile),before:{dependencyPresent:false,bundleSelected:false}})
 let removes=0
 const execute=async(file,args)=>{assert.equal(file,cli);if(args.includes('list'))return{stdout:JSON.stringify([{path:profile,dependencies:pkg.dependencies[name]?{[name]:{version:'0.0.0'}}:{}}]),stderr:''};removes++;assert.deepEqual(args,['plugin','--profile','desktop','remove',name]);delete pkg.dependencies[name];pkg.dsh.profile.bundles=pkg.dsh.profile.bundles.filter(x=>x!==name);await writeFile(join(profile,'package.json'),JSON.stringify(pkg));return{stdout:'',stderr:''}}
 const ownManifest=await readPrivateJSON(join(p.directory,'autorun-manifest.json'))
 assert.equal((await pinVisionInstalledBundle(profile,p.cfg,ownManifest)).verified,true)
 const patchPath=join(installed,'cordis.patch.yml'),original=await readFile(patchPath);await writeFile(patchPath,JSON.stringify([{insert:[{id:'foreign-patch',name,config:p.cfg}]}]))
 await assert.rejects(runVisionOfficialCLI({directory:p.directory,mode:'recovery-remove',rootApproved:true,execute}),{code:'VISION_CLI_INSTALLED_SOURCE_CHANGED'});assert.equal(removes,0);await writeFile(patchPath,original)
 const result=await runVisionOfficialCLI({directory:p.directory,mode:'recovery-remove',rootApproved:true,execute});assert.equal(removes,1);assert.equal(result.status,'recovered-runtime-unconfirmed');assert.equal(result.dependencyRemovalConfirmed,true);assert.equal(result.actualHostReceipt,false);assert.equal(result.modelAcceptancePassed,false);assert.equal(result.naturalCleanupConfirmed,false)
 assert.deepEqual(pkg.dependencies,{'user-existing-plugin':'unchanged'});assert.deepEqual(pkg.dsh.profile.bundles,['user-existing-plugin']);assert.deepEqual(pkg.otherUserField,{value:'unchanged'})
 await assert.rejects(runVisionOfficialCLI({directory:p.directory,mode:'recovery-remove',rootApproved:true,execute}));assert.equal(removes,1)
})
