/** Test-only passive evidence. No process launch, signal, input, capture, model or personal profile access. */
import {constants} from 'node:fs'
import {open,lstat,realpath} from 'node:fs/promises'
import {join,basename,dirname,resolve} from 'node:path'
import {createHash} from 'node:crypto'
const sha=b=>createHash('sha256').update(b).digest('hex'),id=v=>typeof v==='string'&&/^[A-Za-z\d_.:-]{1,512}$/u.test(v),hex=v=>typeof v==='string'&&/^[a-f\d]{64}$/u.test(v)
const allowed=new Set(['sequence','utcMs','monotonicNs','phase','rpcId','op','sessionId','actionIdSHA256','frameIdSHA256','kind','textLength','recentFrames','ok','errorCode','elapsedMs','width','height','statusReplies'])
const ops=new Set(['status','frame','act','pause','takeover','resume','stop','preview','redock']),phases=new Set(['request-read','response-built','first-owned-frame-response','owned-status-hook-heartbeat'])
function admitted(row,sid){if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!allowed.has(k))||row.sessionId!==sid||!Number.isInteger(row.sequence)||row.sequence<1||row.sequence>512||!Number.isFinite(row.utcMs)||!/^\d{1,30}$/u.test(row.monotonicNs)||!phases.has(row.phase))return false
 if(row.phase==='owned-status-hook-heartbeat')return Number.isInteger(row.statusReplies)&&row.statusReplies>0
 if(!id(row.rpcId)||!ops.has(row.op))return false
 for(const k of ['actionIdSHA256','frameIdSHA256'])if(row[k]!==undefined&&row[k]!==null&&!hex(row[k]))return false
 if(row.kind!==undefined&&!['type','key','click','drag','move','scroll','other'].includes(row.kind))return false
 if(row.textLength!==undefined&&row.textLength!==null&&(!Number.isInteger(row.textLength)||row.textLength<0||row.textLength>1000000))return false
 if(row.recentFrames!==undefined&&(!Array.isArray(row.recentFrames)||row.recentFrames.length>8||row.recentFrames.some(v=>!v||Object.keys(v).some(k=>!['frameIdSHA256','utcMs'].includes(k))||!hex(v.frameIdSHA256)||!Number.isFinite(v.utcMs))))return false
 if(row.ok!==undefined&&row.ok!==null&&typeof row.ok!=='boolean')return false
 if(row.errorCode!==undefined&&row.errorCode!==null&&!(typeof row.errorCode==='string'&&/^[A-Za-z_]{1,64}$/u.test(row.errorCode)))return false
 for(const k of ['elapsedMs','width','height','statusReplies'])if(row[k]!==undefined&&(!Number.isFinite(row[k])||row[k]<0))return false
 return true}
async function ownRead(path,cap){const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>cap||typeof process.getuid==='function'&&before.uid!==process.getuid())throw Error('UNSAFE_SOURCE')
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{const initial=await handle.stat();for(const key of['dev','ino','size','mtimeMs','ctimeMs'])if(before[key]!==initial[key])throw Error('SOURCE_CHANGED');const bytes=await handle.readFile();if(bytes.length>cap)throw Error('SOURCE_LIMIT');const after=await handle.stat(),leaf=await lstat(path);for(const value of[after,leaf]){if(!value.isFile()||value.isSymbolicLink()||value.nlink!==1)throw Error('SOURCE_CHANGED');for(const key of['dev','ino','size','mtimeMs','ctimeMs'])if(initial[key]!==value[key])throw Error('SOURCE_CHANGED')}return bytes}finally{await handle.close()}}
export function stoppedPreviewLabels(native){return [...(Array.isArray(native?.labels)?native.labels:[]),...(Array.isArray(native?.accessibility)?native.accessibility:[]),...(Array.isArray(native?.recognizedText)?native.recognizedText:[])].filter(v=>typeof v==='string')}
export function stoppedPreviewAcknowledged(native){return stoppedPreviewLabels(native).join('\n').includes('已停止')}
export async function waitPreviewControlSharedBudget(predicate,message,deadline,{now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms))}={}){
 if(!Number.isFinite(deadline)||deadline<=now())throw Error(message)
 while(now()<deadline){const value=await predicate();if(now()>deadline)throw Error(message);if(value)return value;const remaining=deadline-now();if(remaining>0)await sleep(Math.min(100,remaining))}
 throw Error(message)
}
export async function preserveOwnedPreviewTrace({profileRoot,output,host}){
 let installation
 const unavailable=code=>({status:'unavailable',code,noRPCInferencePermitted:false,inputEventsPosted:0,signalsSent:0,...installation?{installation}:{}})
 if(!Number.isInteger(host?.pid)||host.pid<=1||host?.retired!==true||host.exitCode!==0||host.signal!==null||host.forced===true)return unavailable('HOST_NOT_NORMALLY_RETIRED')
 try{
  if(resolve(profileRoot)!==profileRoot||basename(profileRoot)!=='qiuya-harness-home'||!/^qiuya-harness-e2e-[A-Za-z\d_-]+$/u.test(basename(dirname(profileRoot)))||await realpath(profileRoot)!==profileRoot||await realpath(output)!==output)throw Error('SCOPE_INVALID')
  const scopeStat=await lstat(profileRoot);if(!scopeStat.isDirectory()||scopeStat.isSymbolicLink()||typeof process.getuid==='function'&&scopeStat.uid!==process.getuid())throw Error('SCOPE_INVALID')
  const target=JSON.parse((await ownRead(join(profileRoot,'e2e-computer-target.json'),4096)).toString('utf8'));if(!id(target.sessionId))throw Error('SCOPE_INVALID')
  try {
   const receipt=await ownRead(join(profileRoot,'owned-preview-rpc-installed.json'),2048),value=JSON.parse(receipt.toString('utf8'))
   if(Object.keys(value).sort().join(',')!=='inputEventsPosted,networkRequests,pid,profileSHA256,threadId,version'||value.version!==1||value.pid!==host.pid||!Number.isInteger(value.threadId)||value.threadId<0||value.profileSHA256!==sha(profileRoot)||value.inputEventsPosted!==0||value.networkRequests!==0)throw Error('INSTALL_SCOPE_INVALID')
   const relativeFile='owned-preview-rpc-installed.json',file=await open(join(output,relativeFile),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
   try{await file.writeFile(receipt);await file.sync()}finally{await file.close()}
   installation={status:'preserved',relativeFile,bytes:receipt.length,sha256:sha(receipt),hostPID:host.pid,threadId:value.threadId,provesRPCReceipt:false}
  }catch(error){installation={status:'unavailable',code:error?.code==='ENOENT'?'INSTALL_RECEIPT_MISSING':'INSTALL_RECEIPT_UNCONFIRMED',provesRPCReceipt:false}}
  const bytes=await ownRead(join(profileRoot,'owned-preview-rpc-diagnostic.jsonl'),1024*1024),text=bytes.toString('utf8');if(Buffer.byteLength(text)!==bytes.length||!text.endsWith('\n'))throw Error('TRACE_INVALID')
  const lines=text.trimEnd().split('\n');if(lines.length<1||lines.length>512)throw Error('TRACE_LIMIT')
  const rows=lines.map(line=>JSON.parse(line));if(rows.some(row=>!admitted(row,target.sessionId))||rows.some((r,i)=>i&&r.sequence<=rows[i-1].sequence))throw Error('TRACE_INVALID')
  const destination=join(output,'owned-preview-rpc-diagnostic.jsonl'),file=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
  try{await file.writeFile(bytes);await file.sync()}finally{await file.close()}
  const copied=await ownRead(destination,1024*1024);if(!copied.equals(bytes))throw Error('COPY_UNCONFIRMED')
  return {status:'preserved',installation,relativeFile:'owned-preview-rpc-diagnostic.jsonl',bytes:bytes.length,sha256:sha(bytes),rows:rows.length,scope:{profileRootSHA256:sha(profileRoot),sessionId:target.sessionId,hostPID:host.pid,hostRetired:true,hostExitCode:0,hostSignal:null},closedHostBeforeRead:true,noFollow:true,linkCount:1,sourceStable:true,noRPCInferencePermitted:false,inputEventsPosted:0,signalsSent:0}
 }catch(error){return unavailable(['SCOPE_INVALID','UNSAFE_SOURCE','SOURCE_CHANGED','SOURCE_LIMIT','TRACE_INVALID','TRACE_LIMIT','COPY_UNCONFIRMED'].includes(error?.message)?error.message:error?.code==='ENOENT'?'TRACE_OR_SCOPE_MISSING':error?.code==='EEXIST'?'OUTPUT_EXISTS':'TRACE_UNAVAILABLE')}
}
