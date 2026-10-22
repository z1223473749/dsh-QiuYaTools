import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID,createHash}from'node:crypto'
import {mkdtemp,readFile,rm}from'node:fs/promises'
import {tmpdir}from'node:os'
import {join}from'node:path'
import {prepareWindowsVisionCarrier}from'../scripts/prepare-live-vision-windows-carrier.mjs'
import{winVisionConfig,winVisionGuestConfig,winVisionRequest,winVisionBinding,exactWindowsTarget,projectWindowsOracle,windowsVisionAction,windowsPath,sameWindowsIdentity,WindowsVisionQueue}from'../scripts/live-vision-windows-carrier-core.mjs'
const cfg={runId:randomUUID(),rendezvousNonce:'a'.repeat(64)},sid='qiuya-vision-'+randomUUID(),request={version:1,...cfg,requestId:randomUUID(),sessionId:sid,task:1,nonce:'ABC123',note:'青山路18号',seed:5}
const identity={pid:42,createdAtTicks:'639282542717808148',executablePath:'C:\\test\\fixture.exe'},target={id:'window:ff:42:'+identity.createdAtTicks,pid:42,appId:'win-app:fixed',x:0,y:0,width:800,height:600,scale:1}
test('frozen host and guest config reject expired, foreign-origin and escaped own-root capabilities',()=>{
 const now=1000,base={version:1,platform:'win32',...cfg,directory:'/private/tmp/vision',native:'/private/tmp/native',fixture:'/private/tmp/fixture',carrier:'/private/tmp/carrier',nativeSha256:'b'.repeat(64),fixtureSha256:'c'.repeat(64),carrierSha256:'d'.repeat(64),auditSha256:'f'.repeat(64),expiresAt:now+10000}
 assert.equal(winVisionConfig(base,now),base)
 for(const changed of[{expiresAt:now},{expiresAt:now+20*60000+1},{native:'relative/path'},{platform:'darwin'}])assert.throws(()=>winVisionConfig({...base,...changed},now))
 const root='C:\\Users\\own\\AppData\\Local\\Temp\\QiuYaTools-vision-'+cfg.runId,guest={...base,guestRoot:root,native:root+'\\native.exe',fixture:root+'\\fixture.exe',auditPath:root+'\\windows-remote-audit.cs',expectedSessionId:1,bridgeUrl:'http://10.211.55.2:1234/bridge',bridgeToken:'e'.repeat(64)}
 assert.equal(winVisionGuestConfig(guest,now),guest)
 for(const changed of[{native:root+'\\..\\other\\native.exe'},{fixture:'C:\\other\\fixture.exe'},{bridgeUrl:'http://10.211.55.2:1234/bridge?cap=other'},{bridgeUrl:'http://192.168.1.1:1234/bridge'},{bridgeToken:'bad'},{expiresAt:now}])assert.throws(()=>winVisionGuestConfig({...guest,...changed},now))
})
test('Windows requests bind own session/task/run and reject replayed binding or leaked extra oracle fields',()=>{
 assert.equal(winVisionRequest(request,cfg,1),request)
 for(const bad of [{...request,sessionId:sid+'x'},{...request,task:2},{...request,seed:65536},{...request,note:'x'.repeat(151)},{...request,nonce:'wrong'}])assert.throws(()=>winVisionRequest(bad,cfg,1))
 assert.throws(()=>winVisionBinding({...request,requestId:randomUUID()},request))
 const raw={...identity,windowId:'255',oracle:{task:1,passed:true,correctClicks:1,wrongClicks:0,mouseDown:1,mouseUp:1,dragged:0,submitted:false,textMatches:false,nonce:'DO-NOT-PUBLISH',note:'PRIVATE'}}
 const projected=projectWindowsOracle(raw,identity,'255',1);assert.equal(projected.nonce,undefined);assert.equal(projected.note,undefined)
 assert.throws(()=>projectWindowsOracle({...raw,createdAtTicks:'639282542717808149'},identity,'255',1))
 assert.throws(()=>projectWindowsOracle({...raw,oracle:{...raw.oracle,dragged:false}},identity,'255',1))
})
test('real window target binds hex HWND, exact PID, birth and app identity without Mac alias',()=>{
 assert.equal(exactWindowsTarget(target,identity,'255'),target)
 for(const bad of [{...target,id:target.id.replace('ff:','fe:')},{...target,id:target.id.replace(':42:',':43:')},{...target,pid:43},{...target,id:'mac-window:255'},{...target,id:target.id+'x'}])assert.throws(()=>exactWindowsTarget(bad,identity,'255'))
 assert.equal(windowsPath('C:\\test\\fixture.exe'),windowsPath('c:/test/fixture.exe'));assert.throws(()=>windowsPath('\\\\server\\share\\fixture.exe'))
 assert.equal(sameWindowsIdentity(identity,{...identity,executablePath:'c:/test/fixture.exe'}),true);assert.equal(sameWindowsIdentity(identity,{...identity,createdAtTicks:'639282542717808149'}),false)
})
test('business carrier forbids desktop-switch hotkeys, right-clicks and task-crossing input independently of model guard',()=>{
 for(const [task,action]of[[1,{kind:'type',text:'unrelated'}],[2,{kind:'key',key:'ALT+TAB'}],[2,{kind:'key',key:'WIN+A'}],[3,{kind:'click',x:2,y:3}],[2,{kind:'type',text:'x'.repeat(151)}],[1,{kind:'click',button:'right'}]])assert.throws(()=>windowsVisionAction(task,action),{code:'VISION_WINDOWS_ACTION'})
 assert.equal(windowsVisionAction(2,{kind:'key',key:'Enter'}).key,'Enter');assert.equal(windowsVisionAction(3,{kind:'drag',x:1,y:2,toX:5,toY:6}).kind,'drag')
})
test('reverse bridge delivers each command once and rejects unknown/late reply instead of replaying input',async()=>{
 const q=new WindowsVisionQueue(),first=q.request({kind:'rpc',action:'drag'}),job=q.take();assert.equal(job.payload.action,'drag');assert.equal(q.take(),null)
 assert.equal(q.reply({id:randomUUID(),result:{ok:true}}),false);assert.equal(q.reply({id:job.id,result:{ok:true}}),true);assert.deepEqual(await first,{ok:true});assert.equal(q.reply({id:job.id,result:{ok:true}}),false);q.close()
})
test('uncertain issued bridge action times out once; late reply cannot revive it; shutdown rejects queued work',async()=>{
 const q=new WindowsVisionQueue({timeoutMs:10}),work=q.request({kind:'rpc'}),job=q.take();await assert.rejects(work,e=>e.code==='VISION_WINDOWS_BRIDGE_TIMEOUT'&&e.issued===true);assert.equal(q.take(),null);assert.equal(q.reply({id:job.id,result:{ok:true}}),false)
 const queued=q.request({kind:'prepare'});q.close();await assert.rejects(queued,{code:'VISION_WINDOWS_BRIDGE_CLOSED'});assert.throws(()=>q.request({kind:'rpc'}),{code:'VISION_WINDOWS_BRIDGE_CLOSED'})
})
test('preparation freezes every static import and actually imports carrier, guest and cancellation smoke before any PD work',async()=>{
 const scratch=await mkdtemp(join(tmpdir(),'qiuya-win-carrier-preparation-'))
 try{
  const result=await prepareWindowsVisionCarrier({output:join(scratch,'frozen')})
  assert.equal(result.actualWindowsExecution,false);assert.equal(result.sourceClosureComplete,true);assert.equal(result.nonBuiltinImportsBundled,true)
  assert.equal(result.importSmoke.length,3);assert.ok(result.importSmoke.every(x=>x.actualImport&&x.status==='passed'))
  for(const key of['scripts/live-vision-external-core.mjs','scripts/live-vision-windows-carrier-core.mjs','src/features/computer-use/native.ts','src/features/computer-use/remote.ts'])assert.equal(typeof result.sourceHashes[key],'string')
  for(const[path,hash]of Object.entries(result.sourceHashes))assert.equal(createHash('sha256').update(await readFile(join(result.directory,'source-snapshot',path))).digest('hex'),hash)
  await assert.rejects(prepareWindowsVisionCarrier({output:result.directory}),{code:'EEXIST'})
 }finally{await rm(scratch,{recursive:true,force:true})}
})
