/** Explicit removal of a failed, activated, zero-task test bundle. Never asserts restoration. */
import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { checkPrivateDirectory, readPrivateJSON, visionDigest } from './live-vision-external-core.mjs'
const fail=()=>{throw Object.assign(Error('VISION_CLI_ACTIVATED_FAILURE_UNCONFIRMED'),{code:'VISION_CLI_ACTIVATED_FAILURE_UNCONFIRMED'})}
const fixedFiles=['plugin-config.json','autorun-manifest.json','evidence/host-activation.json','evidence/host-autorun-result.json','evidence/report.json','evidence/external-carrier-report.json','carrier-resume-audit.json']
const permitted=path=>fixedFiles.includes(path)||/^evidence\/windows-carrier-stage-\d{4}\.json$/u.test(path)
// Legacy report/wrapper leaves are 0644 in a verified 0700 own directory. Read
// them with NOFOLLOW, no group/other write and stable owner/mtime/size; freeze
// their exact digest into the new private binding without rewriting originals.
async function readOwnReceipt(path){
 await checkPrivateDirectory(dirname(path));const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{const before=await handle.stat();if(!before.isFile()||before.uid!==process.getuid()||(before.mode&0o022)!==0||before.size>65536)fail();const bytes=await handle.readFile(),after=await handle.stat();if(before.size!==bytes.length||after.size!==before.size||after.mtimeMs!==before.mtimeMs)fail();return{value:JSON.parse(bytes),sha256:visionDigest(bytes)}}finally{await handle.close()}
}
export function validateActivatedVisionFailure({cfg,activation,ended,guard,carrier,outer,stages}){
 const bound=value=>value?.runId===cfg.runId&&value.manifestSHA===cfg.manifestSHA&&value.patchEntryId===cfg.testOnlyPatchEntryId
 if(!bound(activation)||activation.status!=='active'||activation.exactPatchActive!==true||activation.existingPeerReused!==true||activation.ownerPeerActive!==true||!bound(ended)||ended.status!=='failed'||ended.result?.passed!==false||!Array.isArray(ended.result?.tasks)||ended.result.tasks.length!==0)fail()
 const flags=ended.result.restoration
 if(typeof flags?.localMode!=='boolean'||typeof flags.featureFlags!=='boolean'||flags.localMode&&flags.featureFlags||guard?.status!=='failed'||!Array.isArray(guard.tasks)||guard.tasks.length!==0||guard.delivery?.noOwnedActiveTask!==true||guard.delivery.localModeRestored!==flags.localMode||guard.delivery.originalFeatureFlagsRestored!==flags.featureFlags||guard.modelDefaultsChanged!==false)fail()
 if(carrier?.runId!==cfg.runId||['nativeSha256','fixtureSha256','auditSha256'].some(k=>carrier[k]!==cfg[k])||!Array.isArray(carrier.records)||carrier.records.length!==0||carrier.status!=='failed'||carrier.fatal!=='VISION_WINDOWS_DEADLINE'||JSON.stringify(carrier.cleanupErrors)!=='["VISION_WINDOWS_RUNNER_FAILED"]'||carrier.naturalTaskExit?.state!=='Ready'||carrier.naturalTaskExit?.result!==1||carrier.naturalTaskExit?.identityMatched!==true||carrier.pauseIdleRestored!==true||carrier.accountCredentialsTransferred!==false||carrier.windowsInboundPortOpened!==false)fail()
 if(outer?.kind!=='bounded-test-environment-resume'||outer.vm!==cfg.vm||outer.restored!==true||outer.childExit?.code!==1||outer.childExit?.signal!==null)fail()
 for(const stage of['cleanup-own-task','restore-idle']){const end=stages.filter(x=>x.runId===cfg.runId&&x.kind==='stage'&&x.stage===stage&&x.phase==='completed');if(end.length!==1||!stages.some(x=>x.runId===cfg.runId&&x.kind==='stage'&&x.stage===stage&&x.phase==='started'&&x.sequence===end[0].startedSequence))fail()}
 return{restoration:{...flags},zeroModelTasks:true,noOwnedActiveTask:true,zeroWindowsRecords:true,carrierNaturalExitCode:1,taskNaturalReady:true,idleRestored:true}
}
export async function captureActivatedVisionFailure(directory){
 directory=resolve(directory);await checkPrivateDirectory(directory);const names=(await readdir(join(directory,'evidence'))).filter(x=>/^windows-carrier-stage-\d{4}\.json$/u.test(x)).sort();if(names.length>2048)fail()
 const values={},receipts={};for(const path of[...fixedFiles,...names.map(n=>'evidence/'+n)]){const result=await readOwnReceipt(join(directory,path));values[path]=result.value;receipts[path]=result.sha256}
 const cfg=values['plugin-config.json'],manifest=values['autorun-manifest.json'];if(cfg.directory!==directory||manifest.runId!==cfg.runId||visionDigest(JSON.stringify(manifest))!==cfg.manifestSHA)fail()
 const proof=validateActivatedVisionFailure({cfg:{...cfg,vm:values['carrier-resume-audit.json'].vm,...Object.fromEntries(['nativeSha256','fixtureSha256','auditSha256'].map(k=>[k,manifest[k]]))},activation:values['evidence/host-activation.json'],ended:values['evidence/host-autorun-result.json'],guard:values['evidence/report.json'],carrier:values['evidence/external-carrier-report.json'],outer:values['carrier-resume-audit.json'],stages:names.map(n=>values['evidence/'+n])})
 // The wrapper VM must match the already frozen external carrier configuration.
 const external=await readPrivateJSON(cfg.externalCarrierConfig);if(external.vm!==values['carrier-resume-audit.json'].vm||external.runId!==cfg.runId||visionDigest(JSON.stringify(external))!==manifest.externalConfigSha256)fail()
 return{version:1,kind:'activated-failed-zero-task-removal',directory,runId:cfg.runId,manifestSHA:cfg.manifestSHA,patchEntryId:cfg.testOnlyPatchEntryId,receipts,proof,modelAcceptancePassed:false,settingsRestorationConfirmed:false}
}
export async function verifyActivatedVisionFailureBinding(directory,path){
 const binding=await readPrivateJSON(resolve(path));if(binding.directory!==resolve(directory)||binding.kind!=='activated-failed-zero-task-removal'||!binding.receipts||Object.keys(binding.receipts).some(p=>!permitted(p)))fail()
 const current=await captureActivatedVisionFailure(directory)
 if(JSON.stringify(current)!==JSON.stringify(binding))fail()
 return current.proof
}
