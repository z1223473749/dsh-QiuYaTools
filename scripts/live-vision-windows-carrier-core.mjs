/** Test-only transport/identity boundaries. No process launch, input or network here. */
import { isAbsolute, resolve, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'
export const winVisionFail=code=>{throw Object.assign(Error(code),{code})}
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v)
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v)
export function winVisionConfig(v,now=Date.now()){
 if(!v||v.version!==1||v.platform!=='win32'||!uuid(v.runId)||!sha(v.rendezvousNonce)||!['directory','native','fixture','carrier'].every(k=>typeof v[k]==='string'&&isAbsolute(v[k])&&resolve(v[k])===v[k])||!['nativeSha256','fixtureSha256','carrierSha256','auditSha256'].every(k=>sha(v[k]))||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=now||v.expiresAt>now+20*60_000)winVisionFail('VISION_WINDOWS_CONFIG')
 return v
}
export function winVisionRequest(v,cfg,task){
 if(!v||v.version!==1||v.runId!==cfg.runId||v.rendezvousNonce!==cfg.rendezvousNonce||v.task!==task||![1,2,3].includes(task)||!uuid(v.requestId)||typeof v.sessionId!=='string'||!v.sessionId.startsWith('qiuya-vision-')||!uuid(v.sessionId.slice(13))||!/^[A-F0-9]{6}$/u.test(v.nonce)||typeof v.note!=='string'||v.note.length>150||!Number.isSafeInteger(v.seed)||v.seed<0||v.seed>65535)winVisionFail('VISION_WINDOWS_BINDING')
 return v
}
export function winVisionBinding(v,request){
 if(!v||['version','runId','rendezvousNonce','requestId','sessionId','task'].some(k=>v[k]!==request[k]))winVisionFail('VISION_WINDOWS_BINDING')
 return v
}
export function windowsPath(path){
 if(typeof path!=='string'||path.length>600||!/^[a-z]:[\\/]/iu.test(path)||/[\x00-\x1f]/u.test(path))winVisionFail('VISION_WINDOWS_PATH')
 return win32.normalize(path).toLowerCase()
}
export function winVisionGuestConfig(v,now=Date.now()){
 if(!v||v.version!==1||!uuid(v.runId)||!sha(v.rendezvousNonce)||!sha(v.bridgeToken)||!sha(v.nativeSha256)||!sha(v.fixtureSha256)||!sha(v.auditSha256)||!Number.isSafeInteger(v.expectedSessionId)||v.expectedSessionId<=0||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=now||v.expiresAt>now+20*60000)winVisionFail('VISION_WINDOWS_GUEST_CONFIG')
 const root=windowsPath(v.guestRoot)
 if(win32.basename(root)!=='qiuyatools-vision-'+v.runId||windowsPath(v.native)!==windowsPath(win32.join(root,'native.exe'))||windowsPath(v.fixture)!==windowsPath(win32.join(root,'fixture.exe'))||windowsPath(v.auditPath)!==windowsPath(win32.join(root,'windows-remote-audit.cs')))winVisionFail('VISION_WINDOWS_GUEST_CONFIG')
 let bridge;try{bridge=new URL(v.bridgeUrl)}catch{winVisionFail('VISION_WINDOWS_GUEST_CONFIG')}
 if(bridge.protocol!=='http:'||bridge.hostname!=='10.211.55.2'||!bridge.port||bridge.pathname!=='/bridge'||bridge.username||bridge.password||bridge.search||bridge.hash)winVisionFail('VISION_WINDOWS_GUEST_CONFIG')
 return v
}
export function sameWindowsIdentity(a,b){return !!a&&!!b&&a.pid===b.pid&&a.createdAtTicks===b.createdAtTicks&&windowsPath(a.executablePath)===windowsPath(b.executablePath)}
export function validateWindowsIdentity(value,{path,parentPid,sessionId}={}){
 if(!value||!Number.isSafeInteger(value.pid)||value.pid<=1||typeof value.createdAtTicks!=='string'||!/^\d{17,20}$/u.test(value.createdAtTicks)||!Number.isSafeInteger(value.parentPid)||value.parentPid<=1||!Number.isSafeInteger(value.sessionId)||value.sessionId<=0)winVisionFail('VISION_WINDOWS_IDENTITY')
 windowsPath(value.executablePath)
 if(path&&windowsPath(value.executablePath)!==windowsPath(path)||parentPid!==undefined&&value.parentPid!==parentPid||sessionId!==undefined&&value.sessionId!==sessionId)winVisionFail('VISION_WINDOWS_IDENTITY')
 return value
}
export function exactWindowsTarget(target,fixture,windowId){
 const p=target?.id?.split(':')
 if(!p||p.length!==4||p[0]!=='window'||!/^[a-f0-9]+$/u.test(p[1])||!/^\d+$/u.test(String(windowId))||BigInt('0x'+p[1])!==BigInt(windowId)||p[2]!==String(fixture.pid)||p[3]!==fixture.createdAtTicks||target.pid!==fixture.pid||typeof target.appId!=='string'||!target.appId||![target.x,target.y,target.width,target.height,target.scale].every(Number.isFinite)||target.width<=0||target.height<=0)winVisionFail('VISION_WINDOWS_TARGET')
 return target
}
export function projectWindowsOracle(raw,fixture,windowId,task){
 if(!raw||raw.pid!==fixture.pid||raw.createdAtTicks!==fixture.createdAtTicks||raw.windowId!==windowId)winVisionFail('VISION_WINDOWS_ORACLE_IDENTITY')
 const o=raw.oracle
 if(!o||o.task!==task||!['passed','submitted','textMatches'].every(k=>typeof o[k]==='boolean')||!['correctClicks','wrongClicks','mouseDown','mouseUp','dragged'].every(k=>Number.isSafeInteger(o[k])&&o[k]>=0&&o[k]<=10000))winVisionFail('VISION_WINDOWS_ORACLE')
 return Object.fromEntries(['task','passed','correctClicks','wrongClicks','mouseDown','mouseUp','dragged','submitted','textMatches'].map(k=>[k,o[k]]))
}
export function windowsVisionAction(task,a){
 const allowed=task===1?['move','click']:task===2?['move','click','type','key']:task===3?['move','drag']:[]
 if(!a||!allowed.includes(a.kind)||a.button!==undefined&&a.button!=='left'||a.kind==='key'&&!['ENTER','RETURN','BACKSPACE','DELETE','CTRL+A','LEFT','RIGHT'].includes(String(a.key).toUpperCase())||a.kind==='type'&&(typeof a.text!=='string'||a.text.length>150))winVisionFail('VISION_WINDOWS_ACTION')
 return a
}
/** Every queued command is delivered once; a lost/late reply never causes replay. */
export class WindowsVisionQueue {
 constructor({limit=32,timeoutMs=30000,id=randomUUID}={}){this.limit=limit;this.timeoutMs=timeoutMs;this.id=id;this.pending=new Map();this.waiting=[];this.closed=false}
 request(payload){
  if(this.closed)winVisionFail('VISION_WINDOWS_BRIDGE_CLOSED')
  if(this.pending.size>=this.limit)winVisionFail('VISION_WINDOWS_BRIDGE_LIMIT')
  const id=this.id();if(!uuid(id)||this.pending.has(id))winVisionFail('VISION_WINDOWS_BRIDGE_ID')
  return new Promise((done,reject)=>{const job={id,payload,issued:false,done,reject,timer:setTimeout(()=>{this.pending.delete(id);this.waiting=this.waiting.filter(x=>x!==id);reject(Object.assign(Error('VISION_WINDOWS_BRIDGE_TIMEOUT'),{code:'VISION_WINDOWS_BRIDGE_TIMEOUT',issued:job.issued}))},this.timeoutMs)};this.pending.set(id,job);this.waiting.push(id)})
 }
 take(){while(this.waiting.length){const id=this.waiting.shift(),job=this.pending.get(id);if(job&&!job.issued){job.issued=true;return {id,payload:job.payload}}}return null}
 reply(value){const job=this.pending.get(value?.id);if(!job||!job.issued)return false;this.pending.delete(job.id);clearTimeout(job.timer);job.done(value.result);return true}
 close(){this.closed=true;for(const job of this.pending.values()){clearTimeout(job.timer);job.reject(Object.assign(Error('VISION_WINDOWS_BRIDGE_CLOSED'),{code:'VISION_WINDOWS_BRIDGE_CLOSED'}))}this.pending.clear();this.waiting=[]}
}
