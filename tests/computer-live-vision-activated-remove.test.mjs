import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateActivatedVisionFailure, captureActivatedVisionFailure } from '../scripts/live-vision-activated-remove.mjs'
import { runVisionOfficialCLI } from '../scripts/live-vision-official-cli.mjs'
import { visionDigest, writePrivateJSON } from '../scripts/live-vision-external-core.mjs'
const hash='a'.repeat(64),name='qiuya-live-vision-test-only',cli='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
function proof(){
 const cfg={runId:randomUUID(),manifestSHA:hash,testOnlyPatchEntryId:'qiuya-live-vision-test-'+randomUUID(),vm:randomUUID(),nativeSha256:hash,fixtureSha256:hash,auditSha256:hash},binding={runId:cfg.runId,manifestSHA:cfg.manifestSHA,patchEntryId:cfg.testOnlyPatchEntryId}
 return{cfg,activation:{...binding,status:'active',exactPatchActive:true,existingPeerReused:true,ownerPeerActive:true},ended:{...binding,status:'failed',result:{passed:false,tasks:[],restoration:{localMode:false,featureFlags:false}}},guard:{status:'failed',tasks:[],delivery:{noOwnedActiveTask:true,localModeRestored:false,originalFeatureFlagsRestored:false},modelDefaultsChanged:false},carrier:{runId:cfg.runId,nativeSha256:hash,fixtureSha256:hash,auditSha256:hash,status:'failed',fatal:'VISION_WINDOWS_DEADLINE',cleanupErrors:['VISION_WINDOWS_RUNNER_FAILED'],records:[],naturalTaskExit:{state:'Ready',result:1,identityMatched:true},pauseIdleRestored:true,accountCredentialsTransferred:false,windowsInboundPortOpened:false},outer:{kind:'bounded-test-environment-resume',vm:cfg.vm,restored:true,childExit:{code:1,signal:null}},stages:['cleanup-own-task','restore-idle'].flatMap((stage,i)=>[{runId:cfg.runId,kind:'stage',stage,phase:'started',sequence:i*2+1},{runId:cfg.runId,kind:'stage',stage,phase:'completed',sequence:i*2+2,startedSequence:i*2+1}])}
}
test('activated failed removal accepts only exact zero-task terminal cancellation and preserves false restoration',()=>{
 const value=proof();assert.deepEqual(validateActivatedVisionFailure(value).restoration,{localMode:false,featureFlags:false})
 for(const mutate of[
  x=>x.activation.runId=randomUUID(),x=>x.activation.exactPatchActive=false,x=>x.ended.result.tasks.push({passed:false}),x=>x.guard.delivery.noOwnedActiveTask=false,
  x=>x.carrier.records.push({task:1}),x=>x.carrier.naturalTaskExit.identityMatched=false,x=>x.carrier.cleanupErrors.push('UNCONFIRMED'),x=>x.outer.childExit.signal='SIGKILL',x=>x.outer.restored=false,
  x=>x.stages[1].runId=randomUUID(),x=>x.stages.splice(0,1),x=>x.ended.result.restoration={localMode:true,featureFlags:true},
 ]){const changed=structuredClone(value);mutate(changed);assert.throws(()=>validateActivatedVisionFailure(changed),{code:'VISION_CLI_ACTIVATED_FAILURE_UNCONFIRMED'})}
})
async function prepared(t){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'qiuya-activated-removal-')));t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(join(directory,'evidence'),{mode:0o700});const profile=join(directory,'profile');await mkdir(profile,{mode:0o700})
 const p=proof(),module=Buffer.from('export const ownSyntheticFixture = true\n'),external={runId:p.cfg.runId,vm:p.cfg.vm},manifest={version:1,runId:p.cfg.runId,patchEntryId:p.cfg.testOnlyPatchEntryId,externalConfigSha256:visionDigest(JSON.stringify(external)),nativeSha256:hash,fixtureSha256:hash,auditSha256:hash,guardSha256:visionDigest(module)}
 const cfg={...p.cfg,directory,expiresAt:1,testOnlyAutoRun:true,externalCarrierConfig:join(directory,'external-config.json')};delete cfg.manifestSHA;cfg.manifestSHA=visionDigest(JSON.stringify(manifest));p.cfg=cfg;for(const field of['activation','ended']){p[field].manifestSHA=cfg.manifestSHA}
 for(const [path,value]of Object.entries({'plugin-config.json':cfg,'autorun-manifest.json':manifest,'external-config.json':external,'evidence/host-activation.json':p.activation,'evidence/host-autorun-result.json':p.ended,'evidence/external-carrier-report.json':p.carrier,'official-cli-remove.json':{executable:cli,args:['plugin','--profile','desktop','remove',name]}}))await writePrivateJSON(join(directory,path),value)
 await writeFile(join(directory,'evidence/report.json'),JSON.stringify(p.guard),{mode:0o644});await writeFile(join(directory,'carrier-resume-audit.json'),JSON.stringify(p.outer),{mode:0o644})
 for(const row of p.stages)await writePrivateJSON(join(directory,`evidence/windows-carrier-stage-${String(row.sequence).padStart(4,'0')}.json`),row)
 await writePrivateJSON(join(directory,'evidence/cli-install-attempt.json'),{runId:cfg.runId,manifestSHA:cfg.manifestSHA,bundle:name,profileIdentitySha256:visionDigest(profile),before:{dependencyPresent:false,bundleSelected:false}})
 const installed=join(profile,'node_modules',name);await mkdir(installed,{recursive:true});await writeFile(join(installed,'package.json'),JSON.stringify({name,version:'0.0.0',main:'./guard-plugin.mjs',exports:{'.':'./guard-plugin.mjs'},dsh:{bundle:{patch:'cordis.patch.yml'}}}));await writeFile(join(installed,'guard-plugin.mjs'),module);await writeFile(join(installed,'cordis.patch.yml'),JSON.stringify([{insert:[{id:cfg.testOnlyPatchEntryId,name,config:cfg}]}]))
 const pkg={dependencies:{[name]:'own','existing-user-plugin':'unchanged'},dsh:{profile:{bundles:['existing-user-plugin',name]}},untouchedUserField:true};await writeFile(join(profile,'package.json'),JSON.stringify(pkg))
 const binding=await captureActivatedVisionFailure(directory),bindingPath=join(directory,'cleanup-binding.json');await writePrivateJSON(bindingPath,binding)
 return{directory,profile,pkg,cfg,bindingPath}
}
test('actual private receipt binding plus one official removal retires only the exact package without claiming restoration',async t=>{
 if(process.platform!=='darwin'){t.skip('Mac official CLI boundary');return}const prior=process.exitCode;t.after(()=>{process.exitCode=prior});const p=await prepared(t),original=await readFile(join(p.directory,'evidence/host-autorun-result.json'));let removals=0
 const execute=async(file,args)=>{assert.equal(file,cli);if(args.includes('list'))return{stdout:JSON.stringify([{path:p.profile,dependencies:p.pkg.dependencies[name]?{[name]:{version:'0.0.0'}}:{}}]),stderr:''};removals++;assert.deepEqual(args,['plugin','--profile','desktop','remove',name]);delete p.pkg.dependencies[name];p.pkg.dsh.profile.bundles=p.pkg.dsh.profile.bundles.filter(x=>x!==name);await writeFile(join(p.profile,'package.json'),JSON.stringify(p.pkg));const b={runId:p.cfg.runId,manifestSHA:p.cfg.manifestSHA,patchEntryId:p.cfg.testOnlyPatchEntryId};await writePrivateJSON(join(p.directory,'evidence/host-deactivation.json'),{...b,status:'failed',runnerSettled:true,ownedCleanupPassed:true,routesRemoved:true,runnerRestorationConfirmed:false});await writePrivateJSON(join(p.directory,'evidence/host-patch-inactive.json'),{...b,status:'passed',exactPatchInactive:true,ownFiberDisposed:true,observedPresent:false});return{stdout:'',stderr:''}}
 const result=await runVisionOfficialCLI({directory:p.directory,mode:'activated-failed-remove',recoveryBindingPath:p.bindingPath,rootApproved:true,execute});assert.equal(result.status,'removed-restoration-unconfirmed');assert.equal(result.actualHostReceipt,true);assert.equal(result.exactRuntimeRetired,true);assert.equal(result.modelAcceptancePassed,false);assert.equal(result.settingsRestorationConfirmed,false);assert.deepEqual(result.restoration,{localMode:false,featureFlags:false});assert.equal(process.exitCode,1);assert.equal(removals,1);assert.deepEqual(await readFile(join(p.directory,'evidence/host-autorun-result.json')),original);assert.deepEqual(p.pkg.dependencies,{'existing-user-plugin':'unchanged'});assert.equal(p.pkg.untouchedUserField,true)
})
test('unknown cleanup remove outcome consumes the shared attempt and cannot be replayed through another removal mode',async t=>{
 if(process.platform!=='darwin'){t.skip('Mac official CLI boundary');return}const prior=process.exitCode;t.after(()=>{process.exitCode=prior});const p=await prepared(t);let removals=0
 const execute=async(file,args)=>{if(args.includes('list'))return{stdout:JSON.stringify([{path:p.profile,dependencies:{[name]:{version:'0.0.0'}}}]),stderr:''};removals++;throw Object.assign(Error('synthetic unknown'),{code:'ETIMEDOUT',stdout:'private',stderr:'private'})}
 const args={directory:p.directory,mode:'activated-failed-remove',recoveryBindingPath:p.bindingPath,rootApproved:true,execute};assert.equal((await runVisionOfficialCLI(args)).status,'failed');await assert.rejects(runVisionOfficialCLI(args));assert.equal(removals,1)
})
