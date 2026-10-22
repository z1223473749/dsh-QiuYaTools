/** Root-scheduled cancellation smoke. No Host/CLI/VM command, fixture, input or model dispatch. */
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { readPrivateJSON, writePrivateJSON, visionDigest } from './live-vision-external-core.mjs'
import { winVisionConfig } from './live-vision-windows-carrier-core.mjs'
import { createWindowsVisionCancel, validateWindowsVisionCancelAck } from './live-vision-windows-cancel.mjs'
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),fail=code=>{throw Object.assign(Error(code),{code})}
async function wait(path,timeout){const deadline=Date.now()+timeout;while(Date.now()<deadline){try{return await readPrivateJSON(path)}catch(e){if(e.code!=='ENOENT')throw e}await sleep(50)}fail('VISION_WINDOWS_CANCEL_SMOKE_TIMEOUT')}
export async function runWindowsVisionCancelSmoke(configPath,{rootApproved=false}={}){
 if(!rootApproved)fail('VISION_WINDOWS_CANCEL_SMOKE_APPROVAL')
 const cfg=winVisionConfig(await readPrivateJSON(resolve(configPath)));if(cfg.probeOnly===true)fail('VISION_WINDOWS_PROBE_NO_CARRIER')
 for(const key of['native','fixture','carrier'])if(visionDigest(await readFile(cfg[key]))!==cfg[key+'Sha256'])fail('VISION_WINDOWS_SOURCE_CHANGED')
 const ready=await wait(join(cfg.directory,'external/carrier-ready.json'),30000)
 if(ready.runId!==cfg.runId||ready.rendezvousNonce!==cfg.rendezvousNonce||ready.platform!=='win32'||['nativeSha256','fixtureSha256','auditSha256'].some(k=>ready[k]!==cfg[k]))fail('VISION_WINDOWS_CANCEL_BINDING')
 const cancellation=createWindowsVisionCancel(cfg,'owner-status');await writePrivateJSON(join(cfg.directory,'external/carrier-cancel.json'),cancellation)
 const ack=validateWindowsVisionCancelAck(await wait(join(cfg.directory,'external/carrier-cancelled.json'),30000),cfg,cancellation,ready.carrierIdentity),carrier=await readPrivateJSON(join(cfg.directory,'evidence/external-carrier-report.json'))
 if(carrier.status!=='cancelled'||carrier.records?.length!==0||carrier.cleanupErrors?.length!==0||carrier.fatal!==null||carrier.naturalTaskExit?.state!=='Ready'||carrier.naturalTaskExit?.result!==0||carrier.taskUnregistered!==true||carrier.pauseIdleRestored!==true||carrier.cancellation?.cancelId!==cancellation.cancelId||carrier.cancellation.confirmed!==true)fail('VISION_WINDOWS_CANCEL_SMOKE_FAILED')
 const result={version:1,runId:cfg.runId,status:'passed',scope:'zero-task-normal-cancellation-only',nativeSha256:cfg.nativeSha256,fixtureSha256:cfg.fixtureSha256,auditSha256:cfg.auditSha256,cancelId:cancellation.cancelId,guestNaturalExit:ack.guestNaturalExit,taskReadyResult:0,taskUnregistered:ack.taskUnregistered,pauseIdleRestored:ack.pauseIdleRestored,businessCompleted:false,HostRequests:0,modelRequests:0,fixturePreparations:0,inputRequests:0,launchingCarrierExitNeedsOuterReceipt:true};await writePrivateJSON(join(cfg.directory,'evidence/cancel-smoke-report.json'),result);return result
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const i=process.argv.indexOf('--config');runWindowsVisionCancelSmoke(process.argv[i+1],{rootApproved:process.argv.includes('--root-approved')}).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e.code??'VISION_WINDOWS_CANCEL_SMOKE_FAILED');process.exitCode=1})}
