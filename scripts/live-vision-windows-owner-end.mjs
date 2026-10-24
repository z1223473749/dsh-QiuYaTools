/** Test-only final owner receipt. It stops future fixture waits; it never grants input or business success. */
import {randomUUID,createHash} from 'node:crypto'
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,SHA=/^[a-f0-9]{64}$/u
const fields=['version','runId','rendezvousNonce','ownerEndId','reason','nativeSha256','fixtureSha256','auditSha256','manifestSHA','ownerResultDigest','modelCompleted']
const fail=()=>{throw Object.assign(Error('VISION_WINDOWS_BINDING'),{code:'VISION_WINDOWS_BINDING'})},digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function validateTerminalOwner(host,{runId,manifestSHA,sessionIds}={}){
 if(!host||host.version!==1||host.runId!==runId||!UUID.test(runId??'')||host.manifestSHA!==manifestSHA||!SHA.test(manifestSHA??'')||!Number.isSafeInteger(host.hostPid)||host.hostPid<2||!['passed','failed'].includes(host.status)||!host.result||typeof host.result!=='object'||typeof host.result.passed!=='boolean'||(host.status==='passed')!==host.result.passed||!Array.isArray(host.sessionIds)||host.sessionIds.length!==3||new Set(host.sessionIds).size!==3||host.sessionIds.some(v=>typeof v!=='string'||!/^qiuya-vision-[a-f0-9-]{36}$/u.test(v)))fail()
 if(sessionIds&&JSON.stringify(host.sessionIds)!==JSON.stringify(sessionIds))fail()
 return host
}
export function createWindowsOwnerEnd(cfg,host,manifestSHA,sessionIds){
 validateTerminalOwner(host,{runId:cfg.runId,manifestSHA,sessionIds});if(host.status!=='failed')fail()
 const value={version:1,runId:cfg.runId,rendezvousNonce:cfg.rendezvousNonce,ownerEndId:randomUUID(),reason:'known-owner-run-ended',nativeSha256:cfg.nativeSha256,fixtureSha256:cfg.fixtureSha256,auditSha256:cfg.auditSha256,manifestSHA,ownerResultDigest:digest(host),modelCompleted:false}
 return validateWindowsOwnerEnd(value,cfg,host)
}
export function validateWindowsOwnerEnd(value,cfg,host){
 if(!value||Object.keys(value).sort().join('|')!==[...fields].sort().join('|')||value.version!==1||value.runId!==cfg.runId||value.rendezvousNonce!==cfg.rendezvousNonce||!UUID.test(value.ownerEndId??'')||value.reason!=='known-owner-run-ended'||value.modelCompleted!==false||['nativeSha256','fixtureSha256','auditSha256'].some(k=>value[k]!==cfg[k]||!SHA.test(value[k]??'')))fail()
 validateTerminalOwner(host,{runId:cfg.runId,manifestSHA:value.manifestSHA});if(host.status!=='failed'||value.ownerResultDigest!==digest(host))fail();return value
}
/** Shared single30s boundary includes the immutable message publication and natural child exit. */
export async function waitAfterTerminalOwner({cfg,host,manifestSHA,sessionIds,exits,exitState,publish,budgetMs=30000}){
 if(!Number.isInteger(budgetMs)||budgetMs<=0||budgetMs>30000||typeof publish!=='function')fail()
 validateTerminalOwner(host,{runId:cfg.runId,manifestSHA,sessionIds});let timer
 const operation=(async()=>{if(host.status==='failed'&&!exitState?.settled)await publish(createWindowsOwnerEnd(cfg,host,manifestSHA,sessionIds));return await exits})()
 operation.catch(()=>{})
 try{return await Promise.race([operation,new Promise((_,no)=>timer=setTimeout(()=>no(Object.assign(Error('VISION_WINDOWS_CARRIER_NATURAL_EXIT_UNCONFIRMED'),{code:'VISION_WINDOWS_CARRIER_NATURAL_EXIT_UNCONFIRMED'})),budgetMs))])}finally{clearTimeout(timer)}
}
/** Uses the original wait's deadline and cadence; never prepares or replays a task. */
export async function waitWindowsOwnerBoundary({readEnd,readValue,stopping,deadline,interval,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 if(![50,100].includes(interval)||!Number.isFinite(deadline))fail()
 while(!stopping()&&now()<deadline){const end=await readEnd();if(end)return{ownerEnd:end};const value=await readValue();if(value)return{value};if(stopping())break;const left=deadline-now();if(left<=0)break;await sleep(Math.min(interval,left))}
 return{stopped:stopping(),deadlineReached:now()>=deadline}
}
