/** Finite owner RPC evidence. Never persists a whole settings response or model payload. */
import { createHash } from 'node:crypto'
import { VISION_DIAGNOSTIC_CODES, VISION_DIAGNOSTIC_PHASES } from './live-vision-guard-core.mjs'
const fields=['enabled','computerUseEnabled'],digest=value=>createHash('sha256').update(typeof value==='string'?value:'').digest('hex')
export function visionOwnerSettingsSnapshot(value){
 const matches=Array.isArray(value?.namespaces)?value.namespaces.filter(x=>x?.ns==='qiuya-tools'):value?.ns==='qiuya-tools'?[value]:[],row=matches.length===1?matches[0]:null
 return{namespace:'qiuya-tools',namespaceMatchCount:matches.length,present:row!==null,writable:typeof value?.writable==='boolean'?value.writable:null,namespaceWritable:typeof row?.writable==='boolean'?row.writable:null,
  revision:Number.isSafeInteger(row?.revision)?row.revision:null,revisionPresent:Object.hasOwn(row??{},'revision'),revisionNull:row?.revision===null,revisionKind:row?.revision===undefined?'missing':Number.isSafeInteger(row.revision)?'integer':['number','string'].includes(typeof row.revision)?typeof row.revision:'other',applies:row?.applies==='live'?'live':'unknown',
  fields:fields.map(key=>({key,own:Object.hasOwn(row?.user??{},key),raw:typeof row?.user?.[key]==='boolean'?row.user[key]:null,present:Object.hasOwn(row?.value??{},key),effectiveBoolean:typeof row?.value?.[key]==='boolean',effective:typeof row?.value?.[key]==='boolean'?row.value[key]:null}))}
}
export function visionOwnerConnectionSnapshot(value){
 const sessions=Array.isArray(value?.sessions)?value.sessions:null
 return{enabled:typeof value?.enabled==='boolean'?value.enabled:null,nativeMode:['local','remote','browser'].includes(value?.native?.mode)?value.native.mode:null,nativePresent:value?.native!==null&&value?.native!==undefined,
  sessionsKnown:sessions!==null,hasActiveSession:sessions===null?null:sessions.some(row=>!['stopped','faulted','disconnected'].includes(row.state)),switching:typeof value?.switching==='boolean'?value.switching:null}
}
export function projectVisionOwnerRPC({method,phase,response,value,error,requestRpcId}){
 const code=error?.code??value?.result?.error?.code
 const safe=VISION_DIAGNOSTIC_CODES.includes(code)?code:null
 return{method:['settings/describe','settings/mutate','session/prompt','session/cancel','qiuya-tools.computer.control'].includes(method)?method:'unknown',phase:VISION_DIAGNOSTIC_PHASES.includes(phase)?phase:'unknown',httpStatus:Number.isSafeInteger(response?.status)?response.status:null,httpOK:typeof response?.ok==='boolean'?response.ok:null,
  rpcIdMatches:typeof requestRpcId==='string'&&typeof value?.rpcId==='string'?requestRpcId===value.rpcId:null,remoteOK:typeof value?.result?.ok==='boolean'?value.result.ok:null,errorCode:safe,unknownCodeSHA:typeof code==='string'&&!safe?digest(code):null,errorMessageSHA:typeof(error?.message??value?.result?.error?.message)==='string'?digest(error?.message??value.result.error.message):null,
  ...(value?.result?.ok===true&&method?.startsWith('settings/')?{settings:visionOwnerSettingsSnapshot(value.result.value)}:{}),
  ...(value?.result?.ok===true&&method==='qiuya-tools.computer.control'?{connection:visionOwnerConnectionSnapshot(value.result.value)}:{})}
}
