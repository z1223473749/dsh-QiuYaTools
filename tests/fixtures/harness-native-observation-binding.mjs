/** Test-only passive original-wire binding. No RPC, input, process signal or stream consumption. */
import {channel} from 'node:diagnostics_channel'
import {openSync,closeSync,fstatSync,readFileSync,realpathSync,constants} from 'node:fs'
import {createHash} from 'node:crypto'

const issue=code=>Object.assign(Error(code),{code})
const fields=new Set(['$.requestId','$.ok','$.op','$.targetId','$.preview','$.result.frameId','$.result.targetId'])
const identifier=value=>typeof value==='string'&&/^[\x21-\x7e]{1,256}$/u.test(value)
/** JSON structural/escape grammar and ASCII protocol metadata only; not a general Unicode JSON validator. */
export function observationMetadataDecoder(onRow,{maxLineBytes=48*1024*1024}={}){
 let bytes=0,stack=[],root='value',token=null,values={},seen=new Set(),broken=false,maximumRetained=0
 const reject=()=>{broken=true;throw issue('SOURCE_WIRE_INVALID')}
 const state=()=>stack.at(-1)
 const path=()=>{const top=state();return !top?'$':top.kind==='object'&&top.path!==null&&top.key!==null?top.path+'.'+top.key:null}
 const consume=()=>{const top=state();if(!top){if(root!=='value')reject();root='done'}else if(top.mode!=='value')reject();else top.mode='comma'}
 const scalar=(value,p)=>{if(fields.has(p)){if(seen.has(p))reject();seen.add(p);values[p]=value}consume()}
 const beginString=()=>{const top=state();if(top?.mode==='firstValue')top.mode='value';const key=top?.kind==='object'&&['key','firstKey'].includes(top.mode),p=key?null:path();if(!key&&((top&&top.mode!=='value')||(!top&&root!=='value')))reject();token={kind:'string',key,p,keep:key||fields.has(p),raw:'"',length:1,escaped:false,unicode:0}}
 const finishString=()=>{const t=token;token=null;let value=null;if(t.keep){try{value=JSON.parse(t.raw)}catch{reject()}}if(t.key){const top=state();top.key=value;top.mode='colon'}else scalar(value,t.p)}
 const finishAtom=()=>{const t=token;token=null;let value;try{value=JSON.parse(t.raw)}catch{reject()}if(value!==null&&!['number','boolean'].includes(typeof value)||!Number.isFinite(typeof value==='number'?value:0))reject();scalar(value,t.p)}
 const close=kind=>{const top=state();if(!top||top.kind!==kind||!['comma',kind==='object'?'firstKey':'firstValue'].includes(top.mode))reject();stack.pop();consume()}
 const step=c=>{
  if(token?.kind==='string'){
   token.length++;if(token.keep){token.raw+=String.fromCharCode(c);maximumRetained=Math.max(maximumRetained,token.raw.length);if(token.raw.length>(token.key?130:1600))reject()}
   if(token.unicode){if(!/[\da-f]/iu.test(String.fromCharCode(c)))reject();token.unicode--;return}
   if(token.escaped){token.escaped=false;if(c===117)token.unicode=4;else if(![34,47,92,98,102,110,114,116].includes(c))reject();return}if(c===92){token.escaped=true;return}if(c===34){finishString();return}if(c<32)reject();return
  }
  if(token?.kind==='atom'){if(c===32||c===9||c===13||c===44||c===93||c===125){finishAtom();step(c);return}token.raw+=String.fromCharCode(c);maximumRetained=Math.max(maximumRetained,token.raw.length);if(token.raw.length>48)reject();return}
  if(c===32||c===9||c===13)return
  const top=state()
  if(c===34){beginString();return}
  if(c===58){if(top?.kind!=='object'||top.mode!=='colon')reject();top.mode='value';return}
  if(c===44){if(!top||top.mode!=='comma')reject();top.mode=top.kind==='object'?'key':'value';return}
  if(c===125){close('object');return}if(c===93){close('array');return}
  if(c===123||c===91){if((top&&top.mode!=='value'&&top.mode!=='firstValue')||(!top&&root!=='value'))reject();if(top?.mode==='firstValue')top.mode='value';const p=path();if(p==='$.result'){if(seen.has(p))reject();seen.add(p)}if(stack.length>=64)reject();stack.push({kind:c===123?'object':'array',mode:c===123?'firstKey':'firstValue',path:c===123?p:null,key:null});return}
  if(top?.mode==='firstValue')top.mode='value'
  if((top&&top.mode!=='value')||(!top&&root!=='value'))reject()
  token={kind:'atom',p:path(),raw:String.fromCharCode(c)}
 }
 return {
  push(chunk){if(broken)throw issue('SOURCE_WIRE_INVALID');for(let i=0;i<chunk.length;i++){const c=typeof chunk==='string'?chunk.charCodeAt(i):chunk[i];if(c===10){if(token?.kind==='atom')finishAtom();if(token||stack.length||root!=='done')reject();const row=values;bytes=0;root='value';values={};seen=new Set();onRow(row)}else{bytes+=typeof chunk==='string'?(c<128?1:c<2048?2:3):1;if(bytes>maxLineBytes)reject();step(c)}}},
  get maximumRetainedBytes(){return maximumRetained},
  get incomplete(){return bytes!==0},
 }
}

function nativeCandidate(child,expectedSHA256){
 if(typeof child.spawnfile!=='string')return null
 let fd
 try{const path=realpathSync(child.spawnfile);fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.uid!==process.getuid()||before.size>2*1024*1024)return null;const hash=createHash('sha256').update(readFileSync(fd)).digest('hex'),after=fstatSync(fd);if(['dev','ino','size','mtimeMs','ctimeMs'].some(k=>after[k]!==before[k])||hash!==expectedSHA256)return null;return {executablePath:path,sha256:hash}}
 catch{return null}finally{if(fd!==undefined)closeSync(fd)}
}
/** Subscribes before discovery; diagnostics_channel emits construction before spawn metadata exists. */
export function trackOriginalNativeObservations({expectedSHA256,inspectCandidate=child=>nativeCandidate(child,expectedSHA256),maximumChildren=16}={}){
 const bus=channel('child_process'),entries=new Set(),waiting=new Map();let failure=null,disposed=false,totalSpawned=0
 const setFailure=code=>{failure??=code}
 const subscriber=message=>{
  const child=message?.process;if(disposed||!child||typeof child.once!=='function')return
  if(++totalSpawned>64){setFailure('SOURCE_SPAWN_TRACKING_LIMIT');return}
  const attach=()=>{
   waiting.delete(child);if(disposed)return
   let pin;try{pin=inspectCandidate(child)}catch{setFailure('SOURCE_WIRE_CANDIDATE_INVALID');return}if(!pin)return
   if(entries.size>=maximumChildren){setFailure('SOURCE_SPAWN_TRACKING_LIMIT');return}
   if(!Number.isInteger(child.pid)||!child.stdin||!child.stdout){setFailure('SOURCE_WIRE_CANDIDATE_INVALID');return}
   const pending=new Map(),receipts=[],entry={child,pin,pending,receipts,original:child.stdin.write,write:null,onData:null,onExit:null,failure:null}
   const failed=code=>{entry.failure??=code}
   const request=observationMetadataDecoder(row=>{if(row['$.op']!=='observe'||row['$.preview']===true)return;const requestId=row['$.requestId'],targetId=row['$.targetId'];if(!Number.isSafeInteger(requestId)||requestId<1||!identifier(targetId)||pending.has(requestId)||pending.size>=16){failed('SOURCE_WIRE_REQUEST_INVALID');return}pending.set(requestId,targetId)})
   const response=observationMetadataDecoder(row=>{const requestId=row['$.requestId'];if(!pending.has(requestId))return;const targetId=pending.get(requestId);pending.delete(requestId);if(receipts.length>=16){failed('SOURCE_WIRE_RECEIPT_LIMIT');return}receipts.push({requestId,targetId,frameId:row['$.result.frameId'],valid:row['$.ok']===true&&identifier(row['$.result.frameId'])&&row['$.result.targetId']===targetId})})
   entry.write=function(...args){try{const chunk=args[0];request.push(typeof chunk==='string'||Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk))}catch{failed('SOURCE_WIRE_INVALID')}return Reflect.apply(entry.original,this,args)}
   entry.onData=chunk=>{try{response.push(chunk)}catch{failed('SOURCE_WIRE_INVALID')}}
   entry.onExit=()=>{entry.exited=true}
   child.stdin.write=entry.write;child.stdout.on('data',entry.onData);child.once('exit',entry.onExit);entries.add(entry)
  }
  waiting.set(child,attach);child.once('spawn',attach)
 }
 bus.subscribe(subscriber)
 return {
  select({targetId,frameId}){
   if(disposed||failure)throw issue(failure??'SOURCE_WIRE_CLOSED')
   if(!identifier(targetId)||!identifier(frameId))throw issue('SOURCE_WIRE_RECEIPT_MISSING')
   const matches=[];for(const entry of entries)for(const receipt of entry.receipts)if(receipt.targetId===targetId&&receipt.frameId===frameId)matches.push({entry,receipt})
   if(matches.length!==1)throw issue(matches.length?'SOURCE_WIRE_RECEIPT_AMBIGUOUS':'SOURCE_WIRE_RECEIPT_MISSING')
   const {entry,receipt}=matches[0];if(entry.failure)throw issue(entry.failure);if(!receipt.valid)throw issue('SOURCE_WIRE_RESPONSE_INVALID');if(entry.exited||entry.child.exitCode!==null||entry.child.signalCode!==null||entry.child.stdin.destroyed||entry.child.stdin.write!==entry.write)throw issue('SOURCE_WIRE_CHILD_RETIRED')
   return {child:entry.child,pin:entry.pin,receipt:{requestId:receipt.requestId,targetId:receipt.targetId,frameId:receipt.frameId}}
  },
  dispose(){if(disposed)return;disposed=true;bus.unsubscribe(subscriber);for(const [child,listener]of waiting)child.off('spawn',listener);waiting.clear();for(const entry of entries){if(entry.child.stdin.write===entry.write)entry.child.stdin.write=entry.original;entry.child.stdout.off('data',entry.onData);entry.child.off('exit',entry.onExit);entry.pending.clear();entry.receipts.length=0}entries.clear()},
 }
}
