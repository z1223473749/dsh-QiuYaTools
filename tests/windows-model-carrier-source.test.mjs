import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile,mkdtemp,rm,mkdir,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
import {makePreheatedWindowsModelCarrier} from '../scripts/live-vision-windows-model-carrier-source.mjs'
import {prepareWindowsPreheatedModelCarrier} from '../scripts/prepare-windows-preheated-model-carrier.mjs'
const repository=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/u,''),raw=await readFile(join(repository,'scripts/live-vision-windows-carrier.mjs'),'utf8'),generated=makePreheatedWindowsModelCarrier(raw),hash=b=>createHash('sha256').update(b).digest('hex')
test('shared relay is unchanged and checked output equals the reviewed preparation source',()=>{assert.equal(hash(generated),'ffc195488869c9c982c389b367296b5b62768d6bb85a71c56c164ac5014df417');assert(!raw.includes('prepare-postflight-worker'));assert(generated.includes('prepare-postflight-worker'));assert(generated.includes('prepared-warm-postflight'));assert(!generated.includes('/private/tmp/'));assert(!generated.includes('/Users/qiuya/'))})
test('missing, duplicate or already-applied anchors cannot generate a partially adapted carrier',()=>{assert.throws(()=>makePreheatedWindowsModelCarrier(raw.replace('projectVisionNativeRejection','changedDiagnostic')),/SOURCE_DRIFT/);assert.throws(()=>makePreheatedWindowsModelCarrier(raw+'\n'+raw),/SOURCE_DRIFT/);assert.throws(()=>makePreheatedWindowsModelCarrier(generated),/SOURCE_DRIFT/)})
test('actual guards/input/Task arguments and result gates remain, no final cold PS call is introduced',()=>{for(const text of ['new WindowsVisionQueue({timeoutMs:30000})','validateWindowsIdentity','exactWindowsTarget','windowsVisionDesktopPassed','naturalTaskExit?.result===0&&taskUnregistered&&restored','windowsVisionTerminal','mainTaskIssued=true','cleanupSHA256:preparedTaskCleanup.sha256','evidenceSHA256:preparedEvidenceBatch.sourceSHA256'])assert(generated.includes(text),text);const begin=generated.indexOf('  if(postflightWorker&&postflightChannel)try{'),end=generated.indexOf('\n  queue.close();',begin),final=generated.slice(begin,end);assert(begin>0&&end>begin);assert(final.includes('finishWindowsPostflight'));assert(!final.includes('command('));assert(!final.includes('psFile('));assert(!final.includes('shortPS('));assert(generated.indexOf("stage('prepare-postflight-worker'")<generated.indexOf("stage('register-and-start-own-task'"));assert(generated.includes('ensureWindowsPauseIdle({vm,desired:oldIdle,command'))})
test('public preparation actually builds/imports the complete same runtime closure without Host/PD/capabilities',async t=>{
 const temp=await realpath(await mkdtemp(join(tmpdir(),'qiuya-public-windows-carrier-')));t.after(()=>rm(temp,{recursive:true,force:true}))
 const output=join(temp,'prepared'),before=hash(await readFile(join(repository,'scripts/live-vision-windows-carrier.mjs')))
 // The guest includes the current product transport closure. Compare its
 // actual bytes to an independent build of that source, rather than pinning
 // a historic bundle digest that changes with every legitimate native fix.
 const currentGuest=await build({entryPoints:[join(repository,'scripts/live-vision-windows-guest.mjs')],absWorkingDir:repository,bundle:true,write:false,platform:'node',format:'esm',target:'node22',logLevel:'silent'})
 const expectedGuest=Buffer.from(currentGuest.outputFiles[0].contents),r=await prepareWindowsPreheatedModelCarrier({repository,output})
 assert.equal(r.carrierSHA256,'e8a2017790dfea5aa2a5e719f13b93b024d6871a15b5959cc3667d0b3fc489b3')
 const preparedGuest=await readFile(join(output,'bundle','windows-guest.mjs')),manifest=JSON.parse(await readFile(join(output,'bundle','windows-carrier-manifest.json'),'utf8'))
 assert.deepEqual(preparedGuest,expectedGuest,'Prepared guest must equal the complete independently built current source closure')
 assert.equal(r.guestSHA256,hash(expectedGuest));assert.equal(hash(preparedGuest),r.guestSHA256);assert.equal(manifest.guestSha256,r.guestSHA256)
 assert.equal(r.sourceClosureComplete,true)
 const runtimeSources=['src/features/computer-use/application-icon.ts','src/features/computer-use/contract.ts','src/features/computer-use/exchange.ts','src/features/computer-use/foreground-handoff.ts','src/features/computer-use/macos-launch.ts','src/features/computer-use/native-retirement.ts','src/features/computer-use/native.ts','src/features/computer-use/remote.ts']
 assert.deepEqual(Object.keys(r.sourceBindings).filter(name=>name.startsWith('src/')).sort(),runtimeSources)
 for(const name of runtimeSources){const source=await readFile(join(repository,name));assert.equal(r.sourceBindings[name].changed,false);assert.equal(r.sourceBindings[name].originalSHA256,hash(source));assert.equal(r.sourceBindings[name].generatedSHA256,hash(source))}
 assert.equal(r.rootCapabilityCreated,false);assert.equal(r.guardArchiveCreated,false)
 for(const k of ['actualWindows','actualPD','actualHost','actualGUI','actualModel','actualOSInput'])assert.equal(r[k],0)
 assert.equal(r.importSmoke.length,3);assert(r.importSmoke.every(v=>v.status==='passed'&&v.actualImport&&v.windowsExecution===false))
 assert.equal(r.sourceBindings['scripts/live-vision-windows-carrier.mjs'].originalSHA256,before);assert.equal(r.sourceBindings['scripts/live-vision-windows-carrier.mjs'].generatedSHA256,hash(generated));assert.equal(hash(await readFile(join(repository,'scripts/live-vision-windows-carrier.mjs'))),before)
 assert.deepEqual(r.limits,{requestLimit:12,stepLimit:12,taskMs:180000,ownerDeliveryMs:30000,postflightMs:30000,ownerNaturalExitMs:15000,perEvidenceBytes:1048576,evidenceFiles:9})
 await assert.rejects(prepareWindowsPreheatedModelCarrier({repository,output}),{code:'ERR_ASSERTION'})
})
test('preparation rejects a project output before creating it',async()=>{await assert.rejects(prepareWindowsPreheatedModelCarrier({repository,output:join(repository,'must-not-exist-windows-carrier')}),/outside project/)})
