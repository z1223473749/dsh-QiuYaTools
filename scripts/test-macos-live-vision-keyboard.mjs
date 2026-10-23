/** Prepare by default. One real task-2 click/type/Enter only after an explicit root GUI slot. */
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createInterface} from 'node:readline'
import {mkdir,readFile,writeFile,realpath,access} from 'node:fs/promises'
import {join,dirname,resolve,isAbsolute,relative} from 'node:path'
import {homedir} from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {randomUUID,randomBytes,createHash} from 'node:crypto'
import {setTimeout as sleep} from 'node:timers/promises'
import {keyboardBoundaryFixtureSource,KEYBOARD_BOUNDARY_MODES} from './macos-keyboard-boundary-core.mjs'
const root=fileURLToPath(new URL('../',import.meta.url)),ownPath=fileURLToPath(import.meta.url),exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex')
const bounded=async(p,ms,code)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error(code),{code})),ms)})])}finally{clearTimeout(timer)}}
const issue=code=>{throw Object.assign(Error(code),{code})},empty=s=>!!s&&!s.leftButtonDown&&!s.rightButtonDown&&!s.middleButtonDown&&Array.isArray(s.keysDown)&&s.keysDown.length===0
export function keyboardFixtureSource(source){
 const original='"textMatches": self.input.stringValue == self.note]'
 if(source.split(original).length!==2)throw Error('LiveVision task2 snapshot marker changed; review before adapting')
 const result=source.replace(original,'"textMatches": self.input.stringValue == self.note, "pid": getpid(), "windowId": self.window.windowNumber, "bundleId": Bundle.main.bundleIdentifier ?? "", "inputLength": self.input.stringValue.count, "inputUTF16Length": self.input.stringValue.utf16.count, "inputCenter": self.keyboardInputCenter]')
 const marker='    @objc func submit()'
 if(result.split(marker).length!==2)throw Error('LiveVision task2 method marker changed')
 return result.replace(marker,'    var keyboardInputCenter: [String: CGFloat] {\n        let p = window.convertPoint(toScreen: input.convert(NSPoint(x: input.bounds.midX, y: input.bounds.midY), to: nil))\n        return ["x": p.x, "y": (NSScreen.screens.first?.frame.height ?? 0) - p.y]\n    }\n'+marker)
}
export function keyboardActions(note,point){
 if(typeof note!=='string'||!note.startsWith('青山路18号，请轻放，核验码')||!/^青山路18号，请轻放，核验码[A-F0-9]{6}$/u.test(note)||![point?.x,point?.y].every(Number.isFinite))throw Error('Own synthetic note and pinned input point required')
 return [{kind:'click',x:point.x,y:point.y,button:'left'},{kind:'type',text:note},{kind:'key',key:'Enter'}]
}
export function keyboardVerdict({steps,oracle,cleanup,expected='green'}){
 const green=steps.length===3&&steps.every(x=>x.performed===true)&&oracle?.passed===true&&oracle.textMatches===true&&oracle.submitted===true&&cleanup.passed===true
 const typeFailure=steps.find(x=>x.action==='type'&&x.performed===false),focus=typeFailure?.after?.native?.focusAttempt
 const expectedRed=steps.length===2&&steps[0].performed===true&&typeFailure?.error==='FOCUS_CHANGED'&&focus?.inputPosted===true&&focus.keyboardAXError===-25204&&!typeFailure.afterError&&empty(typeFailure.after?.os)&&typeFailure.after.os.foregroundPid===typeFailure.before?.os?.foregroundPid&&cleanup.passed===true&&oracle?.passed!==true
 return {status:green?'passed':expected==='red'&&expectedRed?'expected-red':'failed',functionalPassed:green,expectedRedConfirmed:expectedRed,comparisonAccepted:expected==='red'?expectedRed:green}
}
export async function prepareKeyboardRepro({native,nativeSha256,output=join(homedir(),'QiuYaTools-验收/2026-10-22','Mac-键盘复现-'+randomUUID()),fixtureMode='normal'}={}){
 if(process.platform!=='darwin'||!native||!isAbsolute(native)||!/^[a-f0-9]{64}$/u.test(nativeSha256??''))throw Error('Explicit Mac native path and SHA required')
 if(fixtureMode!=='normal'&&!KEYBOARD_BOUNDARY_MODES.includes(fixtureMode))throw Error('Finite fixture mode required')
 native=await realpath(native);if(sha(await readFile(native))!==nativeSha256)throw Error('Pinned formal native changed')
 output=resolve(output);await mkdir(output,{recursive:false,mode:0o700});output=await realpath(output)
 const app=join(output,'Keyboard Fixture.app'),fixture=join(app,'Contents/MacOS/fixture'),observer=join(output,'independent-observer'),probe=join(output,'read-only-lease-probe'),runtime=join(output,'runtime.mjs'),bundleId='com.qiuya.tools.keyboard-repro.'+randomUUID().replaceAll('-',''),sourceHashes={}
 await mkdir(dirname(fixture),{recursive:true});await mkdir(join(output,'source-snapshot'),{recursive:true})
 const fixturePath='src/native/macos/fixtures/LiveVisionFixture.swift',fixtureOriginal=await readFile(join(root,fixturePath),'utf8'),readOnlyFixture=keyboardFixtureSource(fixtureOriginal),generated=fixtureMode==='normal'?readOnlyFixture:keyboardBoundaryFixtureSource(readOnlyFixture),generatedPath=join(output,'source-snapshot/LiveVisionKeyboardFixture.swift');await writeFile(generatedPath,generated)
 await writeFile(join(app,'Contents/Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
 const compiled=await build({stdin:{contents:"export {NativeCompanionDriver} from './src/features/computer-use/native.ts';export {oracleRPC} from './scripts/live-vision-external-carrier.mjs';export {sameExternalIdentity,sameExternalExecutable,externalIdentityRetired} from './scripts/live-vision-external-core.mjs'",resolveDir:root},absWorkingDir:root,bundle:true,write:false,platform:'node',format:'esm',target:'node22',metafile:true});await writeFile(runtime,compiled.outputFiles[0].contents)
 const sources=new Set([relative(root,ownPath),'scripts/test-macos-keyboard-boundary.mjs','scripts/macos-keyboard-boundary-core.mjs',fixturePath,'src/native/macos/fixtures/AICursorObserver.swift','src/native/macos/fixtures/ProductionCursorProbe.swift',...Object.keys(compiled.metafile.inputs).filter(x=>x!=='<stdin>')])
 for(const path of sources){const bytes=await readFile(join(root,path)),destination=join(output,'source-snapshot',path);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,bytes);sourceHashes[path]=sha(bytes)}
 const common=['-swift-version','5','-target','arm64-apple-macosx13.0','-framework','AppKit','-module-cache-path','/private/tmp/qiuya-live-vision-keyboard-cache']
 for(const[name,args]of[['fixture',[...common,generatedPath,'-o',fixture]],['observer',[...common,'-parse-as-library','-framework','ApplicationServices','-framework','ScreenCaptureKit','-framework','CoreImage','-framework','CoreMedia',join(root,'src/native/macos/fixtures/AICursorObserver.swift'),'-o',observer]],['probe',[...common,'-parse-as-library','-framework','ApplicationServices',join(root,'src/native/macos/fixtures/ProductionCursorProbe.swift'),'-o',probe]]]){try{const r=await exec('/usr/bin/swiftc',args,{timeout:90000});await writeFile(join(output,name+'-build.log'),r.stdout+r.stderr)}catch(e){await writeFile(join(output,name+'-build.log'),String(e.stdout??'')+String(e.stderr??''));throw e}}
 const fixtureSelfTest=(await exec(fixture,['--self-test'],{timeout:15000})).stdout.trim(),probeSelfTest=JSON.parse((await exec(probe,['--self-test',output],{timeout:15000})).stdout);assert.equal(probeSelfTest.actualCGEventPosts,0);assert.equal(probeSelfTest.AppKitWindowsCreated,0)
 const smoke=await exec(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(pathToFileURL(runtime).href)});if(typeof m.oracleRPC!=='function'||typeof m.NativeCompanionDriver!=='function')throw Error('Static closure failed')`],{timeout:15000});if(smoke.stderr)throw Error('Runtime import warning')
 for(const[path,expected]of Object.entries(sourceHashes))if(sha(await readFile(join(root,path)))!==expected)throw Error('Source drifted during preparation')
 const preparation={status:'prepared-not-GUI-run',version:1,native,nativeSha256,output,app,fixture,observer,probe,runtime,bundleId,fixtureMode,fixtureSha256:sha(await readFile(fixture)),observerSha256:sha(await readFile(observer)),probeSha256:sha(await readFile(probe)),runtimeSha256:sha(await readFile(runtime)),generatedFixtureSha256:sha(generated),originalFixtureSha256:sha(fixtureOriginal),sourceHashes,fixtureSelfTest,probeSelfTest,actualGUIWindowsCreated:0,actualInputPosted:0,productionSourceChanged:false,actionPlan:fixtureMode==='normal'?['one click on actual NSTextField center','one type full synthetic Chinese note','one Enter only if both prior actions confirmed']:['one click on actual NSTextField A center',fixtureMode==='sibling-on-down'?'one full synthetic type; first A Down autonomously keys B; no later Down permitted':'one real CMD+Q; original fixture naturally exits; zero retired-recipient Up posts','only after confirmed release/OS-empty, fresh witness fixture may acquire/release a new lease without input'],unknownActionReplay:false,limits:{oneCase:true,wallDeadlineMs:60000}}
 await writeFile(join(output,'preparation.json'),JSON.stringify(preparation,null,2)+'\n');return preparation
}
export async function runKeyboardRepro(prepared,{expected='green',guiGate}={}){
 if(process.platform!=='darwin'||guiGate!=='root-approved'||!['red','green'].includes(expected))throw Error('Explicit root Mac GUI slot and red/green expectation required')
 const cfg=JSON.parse(await readFile(join(resolve(prepared),'preparation.json'),'utf8')),output=cfg.output
 if(KEYBOARD_BOUNDARY_MODES.includes(cfg.fixtureMode))return (await import('./test-macos-keyboard-boundary.mjs')).runKeyboardBoundaryRepro(prepared,{expected,guiGate})
 if(await access(join(output,'report.json')).then(()=>true,()=>false))throw Error('Fresh preparation required; never overwrite a failed run')
 for(const key of['native','fixture','observer','probe','runtime'])if(sha(await readFile(cfg[key]))!==cfg[key+'Sha256'])throw Error('Frozen keyboard artifact changed: '+key)
 for(const[path,hash]of Object.entries(cfg.sourceHashes))if(sha(await readFile(join(root,path)))!==hash)throw Error('Prepared source changed: '+path)
 const {NativeCompanionDriver,oracleRPC,sameExternalIdentity,sameExternalExecutable,externalIdentityRetired}=await import(pathToFileURL(cfg.runtime).href)
 const steps=[],snapshots=[],tracked=[],events=[],nativeKillCalls=[];let observer,probe,fixture,fixtureReady,fixtureIdentity,native,nativeChild,nativeIdentity,fixtureExit,nativeExit,oracle,fatal,leaseStarted=false,phase='preflight';const epoch=1,started=performance.now(),nonce=randomBytes(3).toString('hex').toUpperCase(),note='青山路18号，请轻放，核验码'+nonce
 let seq=0;const pending=new Map(),cleanup={passed:false,errors:[],forced:false,nativeNaturalExit:false,fixtureNaturalExit:false,observerNaturalExit:false,probeNaturalExit:false}
 const track=(identity,role)=>{if(!identity?.pid)issue('KEYBOARD_IDENTITY');tracked.push({...identity,role});return identity},identity=async pid=>(await observer.request('identity',{pid})).identity
 const pinned=async(pin,path)=>{const actual=await identity(pin.pid);if(!sameExternalIdentity(actual,pin)||actual.uniqueId!==pin.uniqueId||path&&!await sameExternalExecutable(actual.executablePath,path))issue('KEYBOARD_IDENTITY_CHANGED');return actual}
 const req=async(endpoint,op,payload)=>endpoint.request(op,payload)
 const fixtureSnapshot=()=>new Promise((done,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(Error('KEYBOARD_FIXTURE_TIMEOUT'),{code:'KEYBOARD_FIXTURE_TIMEOUT'}))},5000);pending.set(id,{done,reject,timer});fixture.stdin.write('snapshot '+id+'\n')})
 async function state(label,withOracle=true){const row={label};try{row.os=await req(observer,'snapshot',{identities:[fixtureIdentity,nativeIdentity].filter(Boolean)});if(native)row.native=await native.status(AbortSignal.timeout(2000));if(withOracle&&fixtureReady){row.oracle=await fixtureSnapshot();if(row.oracle.pid!==fixtureIdentity.pid||row.oracle.windowId!==fixtureReady.windowId||row.oracle.bundleId!==cfg.bundleId)issue('KEYBOARD_ORACLE_IDENTITY')}}finally{snapshots.push(row)}return row}
 const checkOS=row=>{if(!row.os?.sessionExists||row.os.screenLocked||!empty(row.os))issue('KEYBOARD_OS_NOT_IDLE');if(fixtureIdentity&&row.os.foregroundPid!==fixtureIdentity.pid)issue('KEYBOARD_FOREGROUND_CHANGED')}
 const getExit=child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve({code:child.exitCode,signal:child.signalCode}):new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})))
 try{
  observer=oracleRPC(cfg.observer);const oi=track(await bounded(observer.ready,5000,'KEYBOARD_OBSERVER_READY'),'observer');if(oi.pid!==observer.child.pid||!await sameExternalExecutable(oi.executablePath,cfg.observer))issue('KEYBOARD_OBSERVER_IDENTITY')
  probe=oracleRPC(cfg.probe);await bounded(probe.ready,5000,'KEYBOARD_PROBE_READY');track(await identity(probe.child.pid),'probe')
  checkOS(await state('before-fixture',false));const beforeLease=await req(probe,'leaseAudit');if(!beforeLease.leaseFree||beforeLease.journalPresent)issue('KEYBOARD_PREEXISTING_LEASE');snapshots.push({label:'pre-lease',lease:beforeLease})
  fixture=spawn(cfg.fixture,[],{stdio:['pipe','pipe','pipe']});fixtureExit=getExit(fixture);fixture.stderr.resume();fixture.stdin.on('error',()=>{});const lines=createInterface({input:fixture.stdout});let readyResolve,readyReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j});fixture.once('error',readyReject)
  lines.on('line',line=>{try{if(line.length>65536)issue('KEYBOARD_FIXTURE_PROTOCOL');const value=JSON.parse(line);if(value.event==='ready')readyResolve(value);else{const item=pending.get(value.requestId);if(item){pending.delete(value.requestId);clearTimeout(item.timer);item.done(value)}}}catch{readyReject(Error('KEYBOARD_FIXTURE_PROTOCOL'))}})
  fixture.stdin.write(JSON.stringify({task:2,nonce,note,seed:17})+'\n');fixtureReady=await bounded(ready,15000,'KEYBOARD_FIXTURE_READY');fixtureIdentity=track(await identity(fixture.pid),'fixture');if(fixtureReady.pid!==fixtureIdentity.pid||fixtureReady.bundleId!==cfg.bundleId||fixtureIdentity.parentPid!==process.pid||!await sameExternalExecutable(fixtureIdentity.executablePath,cfg.fixture))issue('KEYBOARD_FIXTURE_IDENTITY')
  native=new NativeCompanionDriver({executable:cfg.native});const ns=await native.status();nativeChild=Reflect.get(native,'child');const kill=nativeChild.kill.bind(nativeChild);nativeChild.kill=(...args)=>{nativeKillCalls.push(args[0]??'SIGTERM');return kill(...args)};nativeExit=getExit(nativeChild);nativeIdentity=track(await identity(nativeChild.pid),'native');if(nativeIdentity.parentPid!==process.pid||!await sameExternalExecutable(nativeIdentity.executablePath,cfg.native))issue('KEYBOARD_NATIVE_IDENTITY');native.subscribe(e=>{if(events.length<128)events.push(e)})
  if(!ns.available||!ns.permissions?.screenRecording||!ns.permissions?.accessibility||!ns.permissions?.postEvents)issue('KEYBOARD_NATIVE_PERMISSIONS')
  const target=(await native.targets()).find(t=>t.id==='mac-window:'+fixtureReady.windowId&&t.pid===fixtureIdentity.pid&&t.appId===cfg.bundleId);if(!target)issue('KEYBOARD_TARGET_IDENTITY')
  const initial=await state('before-lease');checkOS(initial);oracle=initial.oracle;await native.lease(epoch,undefined,{actor:'ai'});leaseStarted=true
  for(const child of(await req(observer,'children',{identity:nativeIdentity})).identities)track(child,'native-child')
  let point
  for(const kind of['click','type','key']){
   if(performance.now()-started>60000)issue('KEYBOARD_CASE_DEADLINE');phase=kind;await pinned(fixtureIdentity,cfg.fixture);await pinned(nativeIdentity,cfg.native)
   const before=await state('before-'+kind);checkOS(before);const window=before.os.windows.find(w=>w.id===fixtureReady.windowId&&w.pid===fixtureIdentity.pid&&w.onScreen===true);if(!window)issue('KEYBOARD_OWN_WINDOW_MISSING')
   const frame=await native.observe(target.id);if(frame.targetId!==target.id||!['x','y','width','height'].every(k=>frame.geometry[k]===window[k]))issue('KEYBOARD_FRAME_GEOMETRY')
   await writeFile(join(output,'before-'+kind+'.jpg'),Buffer.from(frame.imageBase64,'base64'),{mode:0o600})
   if(kind==='click'){const p=before.oracle.inputCenter;point={x:(p.x-frame.geometry.x)*frame.width/frame.geometry.width,y:(p.y-frame.geometry.y)*frame.height/frame.geometry.height};if(![point.x,point.y].every(Number.isFinite)||point.x<0||point.y<0||point.x>=frame.width||point.y>=frame.height)issue('KEYBOARD_INPUT_POINT')}
   const action=keyboardActions(note,point).find(a=>a.kind===kind),row={action:kind,requested:1,frame:{frameId:frame.frameId,geometry:frame.geometry,width:frame.width,height:frame.height},before,request:kind==='type'?{kind,textLength:note.length,textSha256:sha(note)}:action};steps.push(row)
   try{const reply=await native.act(epoch,target.id,action);row.performed=reply?.performed===true;if(!row.performed)issue('KEYBOARD_ACTION_UNCONFIRMED')}catch(e){row.performed=false;row.error=typeof e.code==='string'?e.code:'KEYBOARD_ACTION_FAILED'}
   try{row.after=await state('after-'+kind);oracle=row.after.oracle;checkOS(row.after)}catch(e){row.afterError=typeof e.code==='string'?e.code:'KEYBOARD_POST_READ_FAILED'}
   if(!row.performed||row.afterError)break
  }
  if(steps.every(s=>s.performed)&&steps.length===3){await sleep(100);oracle=await fixtureSnapshot()}
  try{await pinned(fixtureIdentity,cfg.fixture);const image=await native.preview(target.id);await writeFile(join(output,'after-sequence.jpg'),Buffer.from(image.imageBase64,'base64'),{mode:0o600})}catch{snapshots.push({label:'final-image-unavailable'})}
 }catch(e){fatal={phase,code:typeof e.code==='string'?e.code:'KEYBOARD_REPRO_FAILED'}}
 finally{
  phase='cleanup'
  if(native){try{if(leaseStarted)await native.release(epoch,AbortSignal.timeout(10000));snapshots.push({label:'after-release',native:await native.status(AbortSignal.timeout(2000))})}catch{cleanup.errors.push('KEYBOARD_RELEASE_UNCONFIRMED')};try{for(const child of(await req(observer,'children',{identity:nativeIdentity})).identities)if(!tracked.some(t=>sameExternalIdentity(t,child)))track(child,'native-child')}catch{cleanup.errors.push('KEYBOARD_CHILDREN_UNCONFIRMED')};try{await bounded(native.dispose(),10000,'KEYBOARD_NATIVE_EXIT');const exit=await bounded(nativeExit,5000,'KEYBOARD_NATIVE_EXIT');cleanup.nativeNaturalExit=exit.code===0&&exit.signal===null;if(!cleanup.nativeNaturalExit)cleanup.errors.push('KEYBOARD_NATIVE_NOT_NATURAL')}catch{cleanup.errors.push('KEYBOARD_NATIVE_EXIT')}
  }
  if(fixture){try{fixture.stdin.end('quit\n');const exit=await bounded(fixtureExit,5000,'KEYBOARD_FIXTURE_EXIT');cleanup.fixtureNaturalExit=exit.code===0&&exit.signal===null;if(!cleanup.fixtureNaturalExit)cleanup.errors.push('KEYBOARD_FIXTURE_NOT_NATURAL')}catch{cleanup.errors.push('KEYBOARD_FIXTURE_EXIT')}}
  if(observer){for(const pin of tracked.filter(x=>!['observer','probe'].includes(x.role))){try{const deadline=performance.now()+5000;let current=await identity(pin.pid);while(!externalIdentityRetired(current,pin)&&performance.now()<deadline){await sleep(25);current=await identity(pin.pid)}if(!externalIdentityRetired(current,pin))cleanup.errors.push('KEYBOARD_OWN_PROCESS_REMAINS')}catch{cleanup.errors.push('KEYBOARD_RETIREMENT_UNCONFIRMED')}}try{const after=await req(observer,'snapshot');snapshots.push({label:'final-os',os:after});if(!empty(after))cleanup.errors.push('KEYBOARD_OS_HELD_AFTER_CLEANUP')}catch{cleanup.errors.push('KEYBOARD_FINAL_OS_UNCONFIRMED')}}
  if(probe){try{const lease=await req(probe,'leaseAudit');snapshots.push({label:'final-lease-journal',lease});if(!lease.leaseFree||lease.journalPresent)cleanup.errors.push('KEYBOARD_LEASE_OR_JOURNAL_REMAINS');probe.child.stdin.end();const exit=await bounded(probe.exits,5000,'KEYBOARD_PROBE_EXIT');cleanup.probeNaturalExit=exit.code===0&&exit.signal===null}catch{cleanup.errors.push('KEYBOARD_PROBE_EXIT')}}
  if(observer){try{observer.child.stdin.end();const exit=await bounded(observer.exits,5000,'KEYBOARD_OBSERVER_EXIT');cleanup.observerNaturalExit=exit.code===0&&exit.signal===null}catch{cleanup.errors.push('KEYBOARD_OBSERVER_EXIT')}}
  for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('KEYBOARD_FIXTURE_CLOSED'))}pending.clear()
  cleanup.forced=nativeKillCalls.length>0;cleanup.nativeKillCalls=nativeKillCalls
  cleanup.passed=cleanup.errors.length===0&&!cleanup.forced&&cleanup.nativeNaturalExit&&cleanup.fixtureNaturalExit&&cleanup.observerNaturalExit&&cleanup.probeNaturalExit
  const verdict=keyboardVerdict({steps,oracle,cleanup,expected}),report={kind:'actual-formal-Mac-native-LiveVision-task2-one-sequence',...verdict,expected,output,nativeSha256:cfg.nativeSha256,fixtureSha256:cfg.fixtureSha256,bundleId:cfg.bundleId,fixtureReady,fixtureIdentity,nativeIdentity,syntheticNoteSha256:sha(note),syntheticNoteLength:note.length,steps,oracle,cleanup,tracked,snapshots,events,fatal:fatal??null,unknownInputReplayed:false,productionSourceChanged:false,modelInference:false,elapsedMs:performance.now()-started}
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,comparisonAccepted:report.comparisonAccepted,output,steps:steps.map(x=>({kind:x.action,performed:x.performed,error:x.error})),cleanupPassed:cleanup.passed,fatal:report.fatal}));if(!report.comparisonAccepted||fatal)process.exitCode=1;return report
 }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const arg=k=>{const i=process.argv.indexOf(k);return i<0?undefined:process.argv[i+1]};if(process.argv.includes('--run'))runKeyboardRepro(arg('--prepared'),{expected:arg('--expect')??'green',guiGate:arg('--gui-gate')}).catch(()=>{process.stderr.write('KEYBOARD_REPRO_FAILED\n');process.exitCode=1});else prepareKeyboardRepro({native:arg('--native'),nativeSha256:arg('--sha256'),output:arg('--output'),fixtureMode:arg('--fixture-mode')??'normal'}).then(v=>console.log(JSON.stringify({status:v.status,output:v.output,nativeSha256:v.nativeSha256,actualInputPosted:0},null,2))).catch(()=>{process.stderr.write('KEYBOARD_PREPARATION_FAILED\n');process.exitCode=1})}
