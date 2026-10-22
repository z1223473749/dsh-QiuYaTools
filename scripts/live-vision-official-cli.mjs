/** One-shot official installed CLI operations, with finite projected receipts. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPrivateJSON, writePrivateJSON, checkPrivateDirectory, visionDigest } from './live-vision-external-core.mjs'
import { validateVisionAutoRun } from './live-vision-host-autorun.mjs'
import { winVisionConfig } from './live-vision-windows-carrier-core.mjs'
import { verifyActivatedVisionFailureBinding } from './live-vision-activated-remove.mjs'
const executeOfficial=promisify(execFile),name='qiuya-live-vision-test-only',cli='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',sleep=ms=>new Promise(r=>setTimeout(r,ms))
const fail=code=>{throw Object.assign(Error(code),{code})}
const scopes=['dependencies','devDependencies','optionalDependencies']
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value
export function visionUnrelatedManifestSHA(value){
 const copy=structuredClone(value)
 for(const scope of scopes)if(copy[scope]){delete copy[scope][name];if(Object.keys(copy[scope]).length===0)delete copy[scope]}
 if(Array.isArray(copy.dsh?.profile?.bundles))copy.dsh.profile.bundles=copy.dsh.profile.bundles.filter(n=>n!==name)
 return visionDigest(JSON.stringify(canonical(copy)))
}
export function projectVisionCLIList(list,manifest){
 if(!Array.isArray(list)||list.length!==1||!isAbsolute(list[0]?.path??'')||!manifest||!Array.isArray(manifest.dsh?.profile?.bundles??[]))fail('VISION_CLI_LIST_UNCONFIRMED')
 const found=scopes.filter(k=>Object.hasOwn(list[0][k]??{},name)),declared=scopes.filter(k=>Object.hasOwn(manifest[k]??{},name)),selected=(manifest.dsh?.profile?.bundles??[]).includes(name)
 if(found.length>1||declared.length>1||JSON.stringify(found)!==JSON.stringify(declared))fail('VISION_CLI_LIST_UNCONFIRMED')
 const dependency=found.length===1
 return {bundle:name,dependencyPresent:dependency,bundleSelected:selected,version:dependency&&typeof list[0][found[0]][name].version==='string'?list[0][found[0]][name].version:null}
}
export async function pinVisionInstalledBundle(profile,cfg,manifest){
 const base=await realpath(join(profile,'node_modules',name)),[pkgBytes,patchBytes,guardBytes]=await Promise.all(['package.json','cordis.patch.yml','guard-plugin.mjs'].map(n=>readFile(join(base,n))))
 if(pkgBytes.length>65536||patchBytes.length>65536||guardBytes.length>1024*1024)fail('VISION_CLI_INSTALLED_SOURCE_CHANGED')
 const pkg=JSON.parse(pkgBytes),patch=JSON.parse(patchBytes),row=patch?.[0]?.insert?.[0]
 if(pkg.name!==name||pkg.version!=='0.0.0'||pkg.main!=='./guard-plugin.mjs'||pkg.exports?.['.']!=='./guard-plugin.mjs'||pkg.scripts!==undefined||pkg.dsh?.bundle?.patch!=='cordis.patch.yml'||visionDigest(guardBytes)!==manifest.guardSha256||patch.length!==1||JSON.stringify(Object.keys(patch[0]).sort())!=='["insert"]'||patch[0].insert.length!==1||JSON.stringify(Object.keys(row??{}).sort())!=='["config","id","name"]'||row?.name!==name||row?.id!==cfg.testOnlyPatchEntryId||JSON.stringify(canonical(row.config))!==JSON.stringify(canonical(cfg)))fail('VISION_CLI_INSTALLED_SOURCE_CHANGED')
 return {verified:true,guardSha256:visionDigest(guardBytes),patchSha256:visionDigest(patchBytes),packageSha256:visionDigest(pkgBytes),patchEntryId:row.id}
}
export async function runVisionOfficialCLI({directory,mode,recoveryBindingPath,rootApproved=false,execute=executeOfficial}={}){
 if(process.platform!=='darwin'||!rootApproved||!['list','install','remove','recovery-remove','activated-failed-remove'].includes(mode))fail('VISION_CLI_EXPLICIT_APPROVAL_REQUIRED')
 directory=resolve(directory);await checkPrivateDirectory(directory);const evidence=join(directory,'evidence');await checkPrivateDirectory(evidence)
 const cfg=await readPrivateJSON(join(directory,'plugin-config.json')),manifest=await readPrivateJSON(join(directory,'autorun-manifest.json'))
 if(cfg.directory!==directory||cfg.testOnlyAutoRun!==true||visionDigest(JSON.stringify(manifest))!==cfg.manifestSHA||manifest.runId!==cfg.runId||manifest.patchEntryId!==cfg.testOnlyPatchEntryId)fail('VISION_CLI_CONFIG')
 const binding={version:1,runId:cfg.runId,manifestSHA:cfg.manifestSHA,patchEntryId:cfg.testOnlyPatchEntryId,bundle:name,executionKind:execute===executeOfficial?'official-installed-cli':'offline-test-double'}
 async function invoke(args){
  try{const result=await execute(cli,args,{timeout:120000,maxBuffer:2*1024*1024});return {ok:true,stdout:result.stdout??'',receipt:{exitCode:0,stdoutBytes:Buffer.byteLength(result.stdout??''),stderrBytes:Buffer.byteLength(result.stderr??''),stdoutSha256:visionDigest(result.stdout??''),stderrSha256:visionDigest(result.stderr??'')}}}
  catch(error){return {ok:false,receipt:{exitCode:Number.isInteger(error.code)?error.code:null,unknownOutcome:!Number.isInteger(error.code),stdoutBytes:Buffer.byteLength(error.stdout??''),stderrBytes:Buffer.byteLength(error.stderr??''),stdoutSha256:visionDigest(error.stdout??''),stderrSha256:visionDigest(error.stderr??'')}}}
 }
 async function inventory(){
  const result=await invoke(['plugin','--profile','desktop','list','--depth','0','--json']);if(!result.ok)fail('VISION_CLI_LIST_UNCONFIRMED')
  let rows;try{rows=JSON.parse(result.stdout)}catch{fail('VISION_CLI_LIST_UNCONFIRMED')}
  if(!Array.isArray(rows)||rows.length!==1||!isAbsolute(rows[0]?.path??''))fail('VISION_CLI_LIST_UNCONFIRMED')
  const profile=await realpath(rows[0].path),bytes=await readFile(join(profile,'package.json'));if(bytes.length>1024*1024)fail('VISION_CLI_LIST_UNCONFIRMED')
  const profileManifest=JSON.parse(bytes)
  return {state:projectVisionCLIList(rows,profileManifest),profile,profileIdentitySha256:visionDigest(profile),unrelatedManifestSha256:visionUnrelatedManifestSHA(profileManifest),cli:result.receipt}
 }
 const before=await inventory()
 if(mode==='list'){const {profile,...projected}=before,value={...binding,status:'read-only',...projected};await writePrivateJSON(join(evidence,'cli-list-'+(before.state.dependencyPresent?'present':'absent')+'.json'),value);return value}
 const operation=mode==='install'?'install':'remove',recovery=mode==='recovery-remove',activatedFailure=mode==='activated-failed-remove'
 let failedRemovalProof
 const command=await readPrivateJSON(join(directory,mode==='install'?'official-cli-install.json':'official-cli-remove.json'))
 if(command.executable!==cli||!Array.isArray(command.args))fail('VISION_CLI_COMMAND')
 if(mode==='install'){
  if(before.state.dependencyPresent||before.state.bundleSelected)fail('VISION_CLI_NOT_FRESH')
  const cap=await readPrivateJSON(join(directory,'autorun-trigger.json'));validateVisionAutoRun(cfg,manifest,cap)
  if(visionDigest(await readFile(cap.archive))!==cap.archiveSha256||command.archiveSha256!==cap.archiveSha256||JSON.stringify(command.args)!==JSON.stringify(['plugin','--profile','desktop','add','--save-exact',cap.archive]))fail('VISION_CLI_COMMAND')
  const external=winVisionConfig(await readPrivateJSON(cfg.externalCarrierConfig))
  if(visionDigest(JSON.stringify(external))!==manifest.externalConfigSha256||external.runId!==cfg.runId)fail('VISION_CLI_CARRIER_NOT_READY')
  if(cfg.testOnlyProbeOnly!==true){const ready=await readPrivateJSON(join(directory,'external/carrier-ready.json'));if(ready.runId!==cfg.runId||ready.rendezvousNonce!==external.rendezvousNonce||ready.platform!=='win32'||ready.nativeSha256!==manifest.nativeSha256||ready.fixtureSha256!==manifest.fixtureSha256||ready.auditSha256!==manifest.auditSha256)fail('VISION_CLI_CARRIER_NOT_READY')}
 }else{
  const ownAttempt=await readPrivateJSON(join(evidence,'cli-install-attempt.json'));if(ownAttempt.runId!==cfg.runId||ownAttempt.manifestSHA!==cfg.manifestSHA||ownAttempt.bundle!==name||ownAttempt.before?.dependencyPresent!==false||ownAttempt.before?.bundleSelected!==false||ownAttempt.profileIdentitySha256!==before.profileIdentitySha256||JSON.stringify(command.args)!==JSON.stringify(['plugin','--profile','desktop','remove',name]))fail('VISION_CLI_NOT_OWNED')
  if(!before.state.dependencyPresent)fail('VISION_CLI_INSTALLED_SOURCE_CHANGED')
  await pinVisionInstalledBundle(before.profile,cfg,manifest)
  if(activatedFailure){if(typeof recoveryBindingPath!=='string')fail('VISION_CLI_ACTIVATED_FAILURE_UNCONFIRMED');failedRemovalProof=await verifyActivatedVisionFailureBinding(directory,recoveryBindingPath)}
  else if(!recovery){const ended=await readPrivateJSON(join(evidence,'host-autorun-result.json'));if(ended.runId!==cfg.runId||ended.manifestSHA!==cfg.manifestSHA||ended.result?.restoration?.localMode!==true||ended.result?.restoration?.featureFlags!==true)fail('VISION_CLI_OWNED_RESTORE_UNCONFIRMED')}
  else{const activation=await readPrivateJSON(join(evidence,'host-activation.json')).catch(e=>{if(e.code!=='ENOENT')throw e;return null});if(activation)fail('VISION_CLI_RECOVERY_REQUIRES_STARTUP_FAILURE')}
 }
 // Persist before issuing the official operation. Unknown results never replay.
 await writePrivateJSON(join(evidence,`cli-${operation}-attempt.json`),{...binding,recovery,activatedFailure,profileIdentitySha256:before.profileIdentitySha256,issuedAt:new Date().toISOString(),before:before.state,unrelatedManifestSha256:before.unrelatedManifestSha256,mayHaveApplied:true,retryAllowed:false})
 const result=await invoke(command.args),report={...binding,status:'failed',recovery,activatedFailure,operation:result.receipt,after:null,actualHostReceipt:false}
 try{
  if(!result.ok)fail('VISION_CLI_OPERATION_UNCONFIRMED')
  const after=await inventory();report.after=after.state
  if(after.profileIdentitySha256!==before.profileIdentitySha256||after.unrelatedManifestSha256!==before.unrelatedManifestSha256)fail('VISION_CLI_UNRELATED_MANIFEST_CHANGED')
  if(mode==='install'&&(!after.state.dependencyPresent||!after.state.bundleSelected)||operation==='remove'&&(after.state.dependencyPresent||after.state.bundleSelected))fail('VISION_CLI_SELECTION_UNCONFIRMED')
  if(recovery){report.status='recovered-runtime-unconfirmed';report.dependencyRemovalConfirmed=true;report.modelAcceptancePassed=false;report.naturalCleanupConfirmed=false;report.error='VISION_CLI_RUNTIME_CLEANUP_UNCONFIRMED';await writePrivateJSON(join(evidence,`cli-${operation}-result.json`),report);process.exitCode=1;return report}
  const filename=mode==='install'?'host-activation.json':'host-patch-inactive.json',deadline=Date.now()+30000;let receipt
  while(Date.now()<deadline){try{receipt=await readPrivateJSON(join(evidence,filename));break}catch(error){if(error.code!=='ENOENT')throw error}await sleep(50)}
  if(!receipt||receipt.runId!==cfg.runId||receipt.manifestSHA!==cfg.manifestSHA||receipt.patchEntryId!==cfg.testOnlyPatchEntryId||mode==='install'&&(receipt.status!=='active'||receipt.exactPatchActive!==true||receipt.existingPeerReused!==true||receipt.ownerPeerActive!==true)||operation==='remove'&&(receipt.status!=='passed'||receipt.exactPatchInactive!==true||receipt.ownFiberDisposed!==true||receipt.observedPresent!==false))fail('VISION_CLI_HOST_STATE_UNCONFIRMED')
  if(operation==='remove'){const closed=await readPrivateJSON(join(evidence,'host-deactivation.json'));if(closed.runId!==cfg.runId||closed.manifestSHA!==cfg.manifestSHA||closed.patchEntryId!==cfg.testOnlyPatchEntryId||closed.runnerSettled!==true||closed.ownedCleanupPassed!==true||closed.routesRemoved!==true||(!activatedFailure&&(closed.status!=='passed'||closed.runnerRestorationConfirmed!==true))||(activatedFailure&&(closed.status!=='failed'||closed.runnerRestorationConfirmed!==false)))fail('VISION_CLI_HOST_CLEANUP_UNCONFIRMED')}
  if(activatedFailure){report.status='removed-restoration-unconfirmed';report.actualHostReceipt=true;report.dependencyRemovalConfirmed=true;report.exactRuntimeRetired=true;report.restoration={...failedRemovalProof.restoration};report.modelAcceptancePassed=false;report.settingsRestorationConfirmed=false;report.error='VISION_CLI_OWNED_RESTORE_UNCONFIRMED';await writePrivateJSON(join(evidence,'cli-activated-failed-remove-result.json'),report);process.exitCode=1;return report}
  report.status='passed';report.actualHostReceipt=true
 }catch(error){report.error=typeof error.code==='string'?error.code:'VISION_CLI_OPERATION_UNCONFIRMED'}
 await writePrivateJSON(join(evidence,`cli-${operation}-result.json`),report);if(report.status!=='passed')process.exitCode=1;return report
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const arg=k=>{const i=process.argv.indexOf(k);return i<0?undefined:process.argv[i+1]};runVisionOfficialCLI({directory:arg('--prepared'),mode:arg('--mode'),recoveryBindingPath:arg('--recovery-binding'),rootApproved:process.argv.includes('--root-approved')}).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(typeof e.code==='string'?e.code:'VISION_CLI_FAILED');process.exitCode=1})}
