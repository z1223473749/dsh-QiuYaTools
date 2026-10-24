/** Test-only listen-only source metadata. Never authorizes, activates, or posts input. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {openSync,closeSync,readFileSync,realpathSync,fstatSync,writeSync,constants} from 'node:fs'
import {basename,dirname,join} from 'node:path'
import{fileURLToPath}from'node:url'
import {trackOriginalNativeObservations} from './harness-native-observation-binding.mjs'
import {createHash,randomUUID} from 'node:crypto'
const sha=b=>createHash('sha256').update(b).digest('hex')
const nativeSHA='0000000000000000000000000000000000000000000000000000000000000000',sessionSHA='0000000000000000000000000000000000000000000000000000000000000000'
const stages=new Set(['binary','spawn','ready','host-identity','observer-parent','own-children','native-pin','target-pin','prepared','trace-start','trace-stop','retire'])
const failures=new Set(['SOURCE_DIAGNOSTIC_FAILED','SOURCE_BINARY_UNSAFE','SOURCE_BINARY_SHA_MISMATCH','SOURCE_INVALID_TARGET','SOURCE_OBSERVER_SPAWN_FAILED','SOURCE_OBSERVER_READY_TIMEOUT','SOURCE_OBSERVER_REQUEST_TIMEOUT','SOURCE_OBSERVER_EARLY_EXIT','SOURCE_OBSERVER_REJECTED','SOURCE_OBSERVER_OUTPUT_LIMIT','SOURCE_OBSERVER_INVALID_JSON','SOURCE_OBSERVER_PIPE_FAILED','SOURCE_OBSERVER_READY_INVALID','SOURCE_HOST_IDENTITY_INVALID','SOURCE_OBSERVER_PARENT_CHANGED','SOURCE_CHILDREN_INVALID','SOURCE_HELPER_NOT_UNIQUE','SOURCE_HELPER_UNSAFE','SOURCE_HELPER_SHA_MISMATCH','SOURCE_TRACE_START_INVALID','SOURCE_TRACE_STOP_INVALID','SOURCE_WIRE_INVALID','SOURCE_SPAWN_TRACKING_LIMIT','SOURCE_WIRE_CANDIDATE_INVALID','SOURCE_WIRE_REQUEST_INVALID','SOURCE_WIRE_RESPONSE_INVALID','SOURCE_WIRE_RECEIPT_LIMIT','SOURCE_WIRE_CLOSED','SOURCE_WIRE_RECEIPT_MISSING','SOURCE_WIRE_RECEIPT_AMBIGUOUS','SOURCE_WIRE_CHILD_RETIRED','SOURCE_NATIVE_IDENTITY_CHANGED'])
const remoteFailures=new Set(['identity-unavailable','identity-changed','pinned-identity-changed','inventory-unavailable','inventory-truncated','own-child-identity-unavailable','parent-changed','invalid-pid','unsupported-observer-operation','tap-create-failed','input-monitoring-not-granted','invalid-trace-command','trace-already-running','target-window-changed'])
const fail=code=>Object.assign(Error(code),{code})
function ownFile(path,limit){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);assert(s.isFile()&&s.nlink===1&&s.size<=limit&&s.uid===process.getuid());const bytes=readFileSync(fd),after=fstatSync(fd);for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])if(after[key]!==s[key])throw fail('SOURCE_OWN_FILE_CHANGED');return bytes}finally{closeSync(fd)}}
function scopeFor(profile,targetId){return {hostPid:process.pid,profileSHA256:sha(Buffer.from(profile)),targetId,observerSHA256:HARNESS_PASSIVE_OBSERVER_SHA256}}
function validScope(scope){return scope&&Number.isSafeInteger(scope.hostPid)&&scope.hostPid>0&&/^[a-f\d]{64}$/u.test(scope.profileSHA256)&&/^mac-window:[1-9]\d*$/u.test(scope.targetId)&&scope.observerSHA256===HARNESS_PASSIVE_OBSERVER_SHA256}
export function sourceProjectionValid(row){
 if(!row||typeof row!=='object'||!['prepare','start','stop','exit','unavailable'].includes(row.phase)||typeof row.utc!=='string'||!/^\d+$/u.test(row.monotonicNs)||!validScope(row.scope))return false
 if(row.phase==='prepare')return stages.has(row.stage)
 if(row.phase==='unavailable')return stages.has(row.stage)&&failures.has(row.code)&&(row.remoteCode===undefined||remoteFailures.has(row.remoteCode))
 if(row.phase!=='stop')return true
 const trace=row.trace;if(trace?.mode!=='listenOnly'||trace.postsInput!==false||trace.maximumEvents!==128||trace.maximumWindowMs!==500||!Array.isArray(trace.events)||trace.events.length>128)return false
 const fields=new Set(['type','observedUTC','observedUptimeSeconds','eventTimestampNanoseconds','sourcePID','sourceUserData','sourceRelation','x','y','button','deltaX','deltaY'])
 for(const event of trace.events){if(Object.keys(event).some(k=>!fields.has(k)))return false;if(['keyDown','keyUp','flagsChanged'].includes(event.type)&&['x','y','button','deltaX','deltaY'].some(k=>k in event))return false}
 return true
}
/** Real pipe lifecycle, separately testable with a non-GUI Node JSONL child. */
export function passiveObserverChannel(child,{timeoutMs=2500}={}){
 let carry='',total=0,sequence=0,retired=false,terminal,readyDone,readyReject,readyTimer
 const pending=new Map(),ready=new Promise((resolve,reject)=>{readyDone=resolve;readyReject=reject})
 // A listener is attached immediately, so an early rejection cannot escape before ready().
 ready.catch(()=>{})
 const rejectAll=error=>{terminal??=error;clearTimeout(readyTimer);readyReject(error);for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error)}pending.clear()}
 const exit=new Promise(resolve=>{
  child.once('error',()=>{rejectAll(fail('SOURCE_OBSERVER_SPAWN_FAILED'));resolve({code:null,signal:null,error:true})})
  child.once('exit',(code,signal)=>{retired=true;rejectAll(fail('SOURCE_OBSERVER_EARLY_EXIT'));resolve({code,signal,error:false})})
 })
 child.stdin.on('error',()=>rejectAll(fail('SOURCE_OBSERVER_PIPE_FAILED')))
 child.stderr.on('data',()=>{}) // Never retain free-form subprocess text.
 child.stdout.on('data',bytes=>{
  total+=bytes.length;carry+=bytes.toString('utf8')
  if(total>256*1024||Buffer.byteLength(carry)>256*1024){rejectAll(fail('SOURCE_OBSERVER_OUTPUT_LIMIT'));child.stdin.end();return}
  let at
  while((at=carry.indexOf('\n'))>=0){
   const line=carry.slice(0,at);carry=carry.slice(at+1)
   let row;try{row=JSON.parse(line)}catch{rejectAll(fail('SOURCE_OBSERVER_INVALID_JSON'));child.stdin.end();return}
   if(row?.event==='ready'){clearTimeout(readyTimer);readyDone(row);continue}
   const entry=pending.get(row?.requestId);if(!entry)continue
   pending.delete(row.requestId);clearTimeout(entry.timer)
   if(row.ok===true)entry.resolve(row.result)
   else{const error=fail('SOURCE_OBSERVER_REJECTED');if(remoteFailures.has(row.error))error.remoteCode=row.error;entry.reject(error)}
  }
 })
 readyTimer=setTimeout(()=>{rejectAll(fail('SOURCE_OBSERVER_READY_TIMEOUT'));child.stdin.end()},timeoutMs)
 return {
  ready:()=>ready,
  request(op,args={}){
   if(terminal||retired||child.stdin.destroyed||child.stdin.writableEnded)return Promise.reject(terminal??fail('SOURCE_OBSERVER_EARLY_EXIT'))
   const requestId=++sequence
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(requestId);const error=fail('SOURCE_OBSERVER_REQUEST_TIMEOUT');rejectAll(error);reject(error);child.stdin.end()},timeoutMs)
    pending.set(requestId,{resolve,reject,timer})
    child.stdin.write(JSON.stringify({requestId,op,...args})+'\n',error=>{if(error)rejectAll(fail('SOURCE_OBSERVER_PIPE_FAILED'))})
   })
  },
  async close(){
   clearTimeout(readyTimer);if(!child.stdin.writableEnded)child.stdin.end()
   let timer
   try{return await Promise.race([exit,new Promise(resolve=>{timer=setTimeout(()=>resolve({naturalExitUnconfirmed:true}),timeoutMs)})])}
   finally{clearTimeout(timer)}
  }
 }
}
/** Compare the two actual identity representations through the same real filesystem canonical path. */
export function nativeObservationPinChecks(binding,native,host){
 let canonicalPathMatches=false
 try{canonicalPathMatches=realpathSync(native.executablePath)===binding.pin.executablePath&&realpathSync(binding.pin.executablePath)===binding.pin.executablePath}catch{}
 return {pidMatches:native?.pid===binding.child.pid,parentPidMatches:native?.parentPid===host.pid,parentUniqueIdMatches:native?.parentUniqueId===host.uniqueId,canonicalPathMatches,childRunning:binding.child.exitCode===null&&binding.child.signalCode===null}
}
export class OwnedMacInputSourceTrace {
 #channel;#pins;#wire;#traceId;#closed=false;#fd;#records=0;#written=0;#scope;#stage='binary';#failure
 constructor(profileRoot){this.profile=realpathSync(profileRoot);assert.equal(basename(this.profile),'qiuya-harness-home');assert.match(basename(dirname(this.profile)),/^qiuya-harness-e2e-[A-Za-z\d_-]+$/u);this.#wire=trackOriginalNativeObservations({expectedSHA256:nativeSHA})}
 get failure(){return this.#failure}
 #record(value){const row={utc:new Date().toISOString(),monotonicNs:String(process.hrtime.bigint()),scope:this.#scope,...value};assert(sourceProjectionValid(row));const bytes=Buffer.from(JSON.stringify(row)+'\n');assert(++this.#records<=20&&this.#written+bytes.length<=128*1024);if(this.#fd===undefined)this.#fd=openSync(join(this.profile,'owned-mac-input-source.jsonl'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);const s=fstatSync(this.#fd);assert(s.isFile()&&s.nlink===1&&s.uid===process.getuid());writeSync(this.#fd,bytes);this.#written+=bytes.length}
 #at(stage){this.#stage=stage;this.#record({phase:'prepare',stage,nativeInputCalls:0,permissionRequests:0})}
 async #guard(work){try{return await work()}catch(error){const code=failures.has(error?.code)?error.code:'SOURCE_DIAGNOSTIC_FAILED';this.#failure={code,stage:this.#stage};this.#record({phase:'unavailable',...this.#failure,...(remoteFailures.has(error?.remoteCode)?{remoteCode:error.remoteCode}:{}),nativeInputCalls:0,signals:0,permitsHumanAttribution:false});await this.close();return false}}
 async prepare(targetId,targetPid){
  if(!/^mac-window:[1-9]\d*$/u.test(targetId)||!Number.isSafeInteger(targetPid)||targetPid<1)throw fail('SOURCE_INVALID_TARGET')
  assert(!this.#channel&&!this.#closed);this.#scope=scopeFor(this.profile,targetId)
  return this.#guard(async()=>{
   this.#at('binary')
   const binary=fileURLToPath(new URL('./harness-passive-input-observer',import.meta.url))
   let bytes;try{bytes=ownFile(binary,2*1024*1024)}catch{throw fail('SOURCE_BINARY_UNSAFE')}
   if(sha(bytes)!==HARNESS_PASSIVE_OBSERVER_SHA256)throw fail('SOURCE_BINARY_SHA_MISMATCH')
   this.#at('spawn');this.#channel=passiveObserverChannel(spawn(binary,[],{stdio:['pipe','pipe','pipe']}))
   this.#at('ready');const ready=await this.#channel.ready()
   if(ready.postsInput!==false||ready.activatesWindows!==false)throw fail('SOURCE_OBSERVER_READY_INVALID')
   this.#at('host-identity');const host=(await this.#channel.request('identity',{pid:process.pid}))?.identity
   if(host?.pid!==process.pid||typeof host.uniqueId!=='string')throw fail('SOURCE_HOST_IDENTITY_INVALID')
   this.#at('observer-parent')
   if(ready.identity?.parentPid!==host.pid||ready.identity?.parentUniqueId!==host.uniqueId)throw fail('SOURCE_OBSERVER_PARENT_CHANGED')
   this.#at('target-pin');const target=(await this.#channel.request('identity',{pid:targetPid}))?.identity
   if(target?.pid!==targetPid||target.parentPid!==host.pid||target.parentUniqueId!==host.uniqueId)throw fail('SOURCE_CHILDREN_INVALID')
   let targetFile;try{targetFile=ownFile(target.executablePath,2*1024*1024)}catch{throw fail('SOURCE_HELPER_UNSAFE')}
   if(sha(targetFile)!==sessionSHA)throw fail('SOURCE_HELPER_SHA_MISMATCH')
   this.#pins={host,observer:ready.identity,target,windowId:Number(targetId.split(':')[1])}
   this.#at('prepared');return true
  })
 }
 async start({frameId,targetId}){return this.#guard(async()=>{
  assert(this.#pins&&!this.#traceId&&!this.#closed)
  if(targetId!==this.#scope.targetId)throw fail('SOURCE_INVALID_TARGET')
  this.#at('native-pin');const binding=this.#wire.select({targetId,frameId})
  const native=(await this.#channel.request('identity',{pid:binding.child.pid}))?.identity
  const nativePinChecks=nativeObservationPinChecks(binding,native,this.#pins.host);this.#record({phase:'prepare',stage:'native-pin',nativePinChecks,nativePID:Number.isSafeInteger(native?.pid)?native.pid:null,spawnedPID:binding.child.pid,originalObservation:binding.receipt,nativeInputCalls:0})
  if(!Object.values(nativePinChecks).every(value=>value===true))throw fail('SOURCE_NATIVE_IDENTITY_CHANGED')
  let nativeFile;try{nativeFile=ownFile(native.executablePath,2*1024*1024)}catch{throw fail('SOURCE_HELPER_UNSAFE')}
  if(sha(nativeFile)!==nativeSHA)throw fail('SOURCE_HELPER_SHA_MISMATCH')
  this.#pins.native=native;this.#pins.originalObservation=binding.receipt
  this.#at('trace-start');this.#traceId=randomUUID()
  const ready=await this.#channel.request('inputTraceStart',{traceId:this.#traceId,action:'move',epoch:1,identity:this.#pins.native,targetIdentity:this.#pins.target,windowId:this.#pins.windowId})
  if(ready.ready!==true||ready.mode!=='listenOnly'||ready.maximumWindowMs!==500)throw fail('SOURCE_TRACE_START_INVALID')
  this.#record({phase:'start',traceId:this.#traceId,pins:this.#pins,ready,scopeDescription:'before original SDK act tool dispatch; epoch1 is observer schema diagnostic label, not native lease proof',nativeInputCalls:0,permissionRequests:0});return true
 })}
 async finish(){return this.#guard(async()=>{
  if(!this.#traceId)return false
  this.#at('trace-stop');const trace=await this.#channel.request('inputTraceStop',{traceId:this.#traceId})
  const row={phase:'stop',traceId:this.#traceId,trace,scopeDescription:'next real SDK model request after original act reply; not exact internal focus-stage boundaries',nativeInputCalls:0}
  if(!sourceProjectionValid({utc:new Date().toISOString(),monotonicNs:'1',scope:this.#scope,...row}))throw fail('SOURCE_TRACE_STOP_INVALID')
  this.#record(row);await this.close();return true
 })}
 async close(){if(this.#closed)return;this.#closed=true;this.#wire?.dispose();if(this.#channel){this.#stage='retire';const result=await this.#channel.close();this.#record({phase:'exit',result,nativeInputCalls:0,signals:0})}if(this.#fd!==undefined){closeSync(this.#fd);this.#fd=undefined}}
}
// Exact previously compiled observer. No native source or production helper change.
export const HARNESS_PASSIVE_OBSERVER_SHA256='0000000000000000000000000000000000000000000000000000000000000000'
function sourceRows(profileRoot,{allowPartial=false}={}){
 const profile=realpathSync(profileRoot);assert.equal(basename(profile),'qiuya-harness-home');assert.match(basename(dirname(profile)),/^qiuya-harness-e2e-[A-Za-z\d_-]+$/u)
 const target=JSON.parse(ownFile(join(profile,'e2e-computer-target.json'),4096));assert.match(target.targetId,/^mac-window:[1-9]\d*$/u)
 let bytes=ownFile(join(profile,'owned-mac-input-source.jsonl'),128*1024);if(allowPartial&&bytes.at(-1)!==10){const last=bytes.lastIndexOf(10);if(last<0)return {rows:[],bytes:Buffer.alloc(0),target};bytes=bytes.subarray(0,last+1)}assert.equal(bytes.at(-1),10)
 const rows=bytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));assert(rows.length>0&&rows.length<=20&&rows.every(sourceProjectionValid))
 for(const row of rows){assert.equal(row.scope.profileSHA256,sha(Buffer.from(profile)));assert.equal(row.scope.targetId,target.targetId);assert.equal(row.scope.hostPid,rows[0].scope.hostPid)}
 return {rows,bytes,target}
}
/** Test runner polls only this finite failure projection; it never retries tools. */
export function ownedMacInputSourceFailure(profileRoot,hostPid){
 try{const {rows}=sourceRows(profileRoot,{allowPartial:true});if(!rows.length)return null;assert.equal(rows[0].scope.hostPid,hostPid);const row=rows.find(r=>r.phase==='unavailable');return row?{code:row.code,stage:row.stage}:null}
 catch(error){if(['ENOENT','SOURCE_OWN_FILE_CHANGED'].includes(error?.code))return null;throw fail('SOURCE_DIAGNOSTIC_FAILED')}
}
export async function preserveOwnedMacInputSource({profileRoot,output,host}){
 const result={status:'unavailable',nativeInputCalls:0,signals:0,permitsHumanAttribution:false}
 if(!host?.retired||host.exitCode!==0||host.signal!==null||host.forced===true||!Number.isInteger(host.pid))return {...result,code:'HOST_NOT_NATURALLY_RETIRED'}
 try{
  assert.equal(realpathSync(output),output);const {rows,bytes,target}=sourceRows(profileRoot)
  assert.equal(rows[0].scope.hostPid,host.pid)
  const starts=rows.filter(r=>r.phase==='start');assert(starts.length<=1)
  if(starts.length){assert.equal(starts[0].pins?.host?.pid,host.pid);assert.equal(starts[0].pins?.windowId,Number(target.targetId.split(':')[1]))}
  const destination=join(output,'owned-mac-input-source.jsonl'),fd=openSync(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeSync(fd,bytes)}finally{closeSync(fd)}
  const stop=rows.find(r=>r.phase==='stop'),exit=rows.find(r=>r.phase==='exit'),failure=rows.find(r=>r.phase==='unavailable')
  return {...result,status:'preserved',relativeFile:basename(destination),sha256:sha(bytes),bytes:bytes.length,records:rows.length,complete:starts.length===1&&!failure&&stop?.trace?.workerRetired===true&&stop.trace.tapInvalidated===true&&stop.trace.failure===null&&exit?.result?.code===0&&exit.result.signal===null,diagnosticFailure:failure?{code:failure.code,stage:failure.stage,...(failure.remoteCode?{remoteCode:failure.remoteCode}:{})}:null,scope:'partial preparation records are not tap/event/input proof; complete trace remains listen-only before original SDK move through first-own-event/fixed500ms'}
 }catch(error){return {...result,code:error?.code==='ENOENT'?'SOURCE_TRACE_OR_TARGET_MISSING':'SOURCE_TRACE_UNCONFIRMED'}}
}
