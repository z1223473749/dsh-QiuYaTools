import assert from 'node:assert/strict'
import test from 'node:test'
import fsPromises from 'node:fs/promises'
import { constants } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createWindowsCarrierDiagnostics } from '../scripts/live-vision-windows-diagnostics.mjs'
import { readPrivateJSON, writePrivateJSON } from '../scripts/live-vision-external-core.mjs'

async function directory(t) {
 const path=await fsPromises.realpath(await fsPromises.mkdtemp(join(tmpdir(),'qiuya-diagnostic-storage-')))
 t.after(()=>fsPromises.rm(path,{recursive:true,force:true}));return path
}
function delaySync(t) {
 const original=fsPromises.open,entered=Promise.withResolvers(),gate=Promise.withResolvers(),writes=[]
 let syncCalls=0
 t.mock.method(fsPromises,'open',async(...args)=>{
  const handle=await original(...args)
  if(typeof args[1]==='number'&&(args[1]&constants.O_WRONLY)){
   writes.push({path:args[0],flags:args[1],mode:args[2]})
   const sync=handle.sync.bind(handle)
   t.mock.method(handle,'sync',async()=>{syncCalls++;entered.resolve('sync-entered');await gate.promise;return sync()})
  }
  return handle
 })
 syncBuiltinESMExports()
 t.after(()=>{gate.resolve();t.mock.restoreAll();syncBuiltinESMExports()})
 return{entered:entered.promise,release:()=>gate.resolve(),writes,syncCalls:()=>syncCalls}
}

test('observational stage and command receipts finish atomically without a FileHandle.sync barrier',async t=>{
 const path=await directory(t),barrier=delaySync(t),diagnostics=createWindowsCarrierDiagnostics({runId:randomUUID(),evidence:path})
 let issued=0
 const pending=diagnostics.stage('restore-idle',()=>diagnostics.command('pd-restore-idle',async()=>{
  issued++
  const names=(await fsPromises.readdir(path)).filter(name=>!name.startsWith('.')).sort()
  assert.equal(names.length,2)
  for(const name of names)assert.equal((await readPrivateJSON(join(path,name))).phase,'started')
  return{stdout:'',stderr:''}
 }))
 try{
  const outcome=await Promise.race([pending.then(()=> 'command-completed'),barrier.entered])
  t.diagnostic(`syncGateOutcome=${outcome}; commandsIssuedBeforeRelease=${issued}; syncCalls=${barrier.syncCalls()}`)
  if(outcome==='sync-entered')assert.equal(issued,0)
  assert.equal(outcome,'command-completed','observational fsync must not block the original command')
  assert.equal(issued,1);assert.equal(barrier.syncCalls(),0)
  const names=(await fsPromises.readdir(path)).sort()
  assert.deepEqual(names,[1,2,3,4].map(n=>`windows-carrier-stage-${String(n).padStart(4,'0')}.json`))
  const rows=await Promise.all(names.map(name=>readPrivateJSON(join(path,name))))
  assert.deepEqual(rows.map(row=>[row.kind,row.phase]),[['stage','started'],['command','started'],['command','completed'],['stage','completed']])
  for(const name of names)assert.equal((await fsPromises.stat(join(path,name))).mode&0o777,0o600)
  for(const write of barrier.writes){assert.equal(write.mode,0o600);assert.equal(write.flags&constants.O_EXCL,constants.O_EXCL);assert.equal(write.flags&constants.O_NOFOLLOW,constants.O_NOFOLLOW)}
 }finally{barrier.release();await pending.catch(()=>{})}
})

test('generic protocol receipt publication still waits for its actual FileHandle.sync',async t=>{
 const path=await directory(t),barrier=delaySync(t),leaf=join(path,'original-authorization-issued.json'),value={issued:true,noAutomaticReplay:true}
 let settled=false
 const pending=writePrivateJSON(leaf,value).then(()=>{settled=true})
 try{
  assert.equal(await Promise.race([pending.then(()=> 'published'),barrier.entered]),'sync-entered')
  assert.equal(settled,false);assert.equal(barrier.syncCalls(),1)
  await assert.rejects(fsPromises.readFile(leaf),{code:'ENOENT'})
  barrier.release();await pending
  assert.deepEqual(await readPrivateJSON(leaf),value)
 }finally{barrier.release();await pending.catch(()=>{})}
})

test('a partial diagnostic temporary file stays unpublished and blocks command issue until complete',async t=>{
 const path=await directory(t),original=fsPromises.open,entered=Promise.withResolvers(),gate=Promise.withResolvers()
 let intercepted=false,issued=0
 t.mock.method(fsPromises,'open',async(...args)=>{
  const handle=await original(...args)
  if(!intercepted&&typeof args[1]==='number'&&(args[1]&constants.O_WRONLY)){
   intercepted=true
   const write=handle.writeFile.bind(handle)
   t.mock.method(handle,'writeFile',async bytes=>{await handle.write(bytes.subarray(0,5));entered.resolve();await gate.promise;return write(bytes.subarray(5))})
  }
  return handle
 });syncBuiltinESMExports()
 t.after(()=>{gate.resolve();t.mock.restoreAll();syncBuiltinESMExports()})
 const pending=createWindowsCarrierDiagnostics({runId:randomUUID(),evidence:path}).command('pd-restore-idle',async()=>{issued++;return{stdout:'',stderr:''}})
 try{
  await entered.promise
  assert.equal(issued,0)
  await assert.rejects(fsPromises.readFile(join(path,'windows-carrier-stage-0001.json')),{code:'ENOENT'})
  gate.resolve();await pending
  assert.equal(issued,1)
  assert.equal((await readPrivateJSON(join(path,'windows-carrier-stage-0001.json'))).phase,'started')
  assert.equal((await readPrivateJSON(join(path,'windows-carrier-stage-0002.json'))).phase,'completed')
 }finally{gate.resolve();await pending.catch(()=>{})}
})

test('actual diagnostic storage failure prevents the command from being issued',async t=>{
 const path=await directory(t)
 t.mock.method(fsPromises,'open',async()=>{throw Object.assign(Error('synthetic storage failure'),{code:'EIO'})});syncBuiltinESMExports()
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()})
 let issued=0
 await assert.rejects(createWindowsCarrierDiagnostics({runId:randomUUID(),evidence:path}).command('pd-restore-idle',async()=>{issued++;return{stdout:'',stderr:''}}),{code:'EIO'})
 assert.equal(issued,0);assert.deepEqual(await fsPromises.readdir(path),[])
})

test('completion publication failure rejects after exactly one command and leaves no completed receipt',async t=>{
 const path=await directory(t),original=fsPromises.link
 t.mock.method(fsPromises,'link',async(from,to)=>{if(basename(to)==='windows-carrier-stage-0002.json')throw Object.assign(Error('synthetic publication failure'),{code:'EIO'});return original(from,to)});syncBuiltinESMExports()
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()})
 let issued=0
 await assert.rejects(createWindowsCarrierDiagnostics({runId:randomUUID(),evidence:path}).command('pd-restore-idle',async()=>{issued++;return{stdout:'',stderr:''}}),{code:'EIO'})
 assert.equal(issued,1)
 const names=(await fsPromises.readdir(path)).sort(),rows=await Promise.all(names.map(name=>readPrivateJSON(join(path,name))))
 assert.deepEqual(names,['windows-carrier-stage-0001.json','windows-carrier-stage-0003.json'])
 assert.deepEqual(rows.map(row=>row.phase),['started','failed'])
})

test('diagnostic atomic publication cannot replace an existing leaf or follow its symlink',async t=>{
 const path=await directory(t),target=join(path,'preserved.json'),leaf=join(path,'windows-carrier-stage-0001.json')
 await fsPromises.writeFile(target,'preserved',{mode:0o600});await fsPromises.symlink(target,leaf)
 let issued=0
 await assert.rejects(createWindowsCarrierDiagnostics({runId:randomUUID(),evidence:path}).command('pd-restore-idle',async()=>{issued++}),{code:'VISION_EXTERNAL_REPLAY'})
 assert.equal(issued,0);assert.equal(await fsPromises.readFile(target,'utf8'),'preserved');assert.equal((await fsPromises.lstat(leaf)).isSymbolicLink(),true)
 assert.deepEqual((await fsPromises.readdir(path)).sort(),['preserved.json','windows-carrier-stage-0001.json'])
})

test('diagnostic private-parent and 65536-byte bounds still prevent command issue',async t=>{
 const path=await directory(t);let issued=0
 await fsPromises.chmod(path,0o755)
 await assert.rejects(createWindowsCarrierDiagnostics({runId:randomUUID(),evidence:path}).command('pd-restore-idle',async()=>{issued++}),{code:'VISION_EXTERNAL_FILE_BOUNDARY'})
 await fsPromises.chmod(path,0o700)
 await assert.rejects(createWindowsCarrierDiagnostics({runId:'x'.repeat(65536),evidence:path}).command('pd-restore-idle',async()=>{issued++}),{code:'VISION_EXTERNAL_FILE_BOUNDARY'})
 assert.equal(issued,0);assert.deepEqual(await fsPromises.readdir(path),[])
})

test('diagnostic 2048-receipt cap still rejects before a further command',async()=>{
 let issued=0,writes=0
 const diagnostics=createWindowsCarrierDiagnostics({runId:randomUUID(),evidence:'/unused',writeReceipt:async()=>{writes++}})
 for(let n=0;n<1024;n++)await diagnostics.command('pd-restore-idle',async()=>{issued++;return{stdout:'',stderr:''}})
 await assert.rejects(diagnostics.command('pd-restore-idle',async()=>{issued++}),{code:'VISION_WINDOWS_DIAGNOSTIC_LIMIT'})
 assert.equal(issued,1024);assert.equal(writes,2048)
})
