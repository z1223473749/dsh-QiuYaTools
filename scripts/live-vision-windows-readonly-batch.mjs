/** Test carrier only. Each fresh read runs once, asynchronously, and must exit naturally. */
import {spawn} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {windowsVisionDesktopCommand} from './live-vision-windows-audit.mjs'
const hash=b=>createHash('sha256').update(b).digest('hex'),fail=code=>{throw Object.assign(Error(code),{code})},SHA=/^[a-f0-9]{64}$/u
export function identityPowerShell(pid){if(!Number.isSafeInteger(pid)||pid<=1)fail('VISION_WINDOWS_BINDING');return `$ErrorActionPreference='Stop';$p=$null;try{$p=[Diagnostics.Process]::GetProcessById(${pid});$null=$p.SafeHandle;$c=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';@{pid=$p.Id;parentPid=[int]$c.ParentProcessId;createdAtTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();executablePath=$p.MainModule.FileName;sessionId=$p.SessionId}|ConvertTo-Json -Compress}catch [ArgumentException]{'null'}finally{if($p){$p.Dispose()}}`}
const q=s=>"'"+s.replaceAll("'","''")+"'"
export function makeFreshIdentityBatch({runId,requestId,fixturePid,nativePid,auditPath,auditSha256,includeDesktop=false,nonce=randomUUID()}){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(runId??'')||!Number.isSafeInteger(requestId)||requestId<1||!SHA.test(auditSha256??'')||typeof auditPath!=='string'||auditPath.includes('\0')||!/^\w:\\/u.test(auditPath)||typeof includeDesktop!=='boolean'||!/^[-a-f0-9]{36}$/u.test(nonce))fail('VISION_WINDOWS_BINDING')
 const fixture=identityPowerShell(fixturePid),native=identityPowerShell(nativePid),desktop=includeDesktop?windowsVisionDesktopCommand(auditPath,auditSha256):null
 const source=`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$fixtureText=& {${fixture}};$nativeText=& {${native}};$fixtureIdentity=$fixtureText|ConvertFrom-Json;$nativeIdentity=$nativeText|ConvertFrom-Json;${desktop?`$desktopText=& {${desktop}};$desktopValue=$desktopText|ConvertFrom-Json;`:'$desktopValue=$null;'}@{version=1;runId=${q(runId)};requestId=${requestId};nonce=${q(nonce)};fixture=$fixtureIdentity;native=$nativeIdentity;desktop=$desktopValue;auditSourceSHA256=${q(auditSha256)}}|ConvertTo-Json -Depth 8 -Compress`
 return{source,sourceSHA256:hash(source),runId,requestId,nonce,includeDesktop,auditSha256,algorithm:{fixtureSHA256:hash(fixture),nativeSHA256:hash(native),desktopSHA256:desktop?hash(desktop):null}}
}
export function validateFreshIdentityBatch(value,spec){if(!value||Object.keys(value).sort().join('|')!==['version','runId','requestId','nonce','fixture','native','desktop','auditSourceSHA256'].sort().join('|')||value.version!==1||value.runId!==spec.runId||value.requestId!==spec.requestId||value.nonce!==spec.nonce||value.auditSourceSHA256!==spec.auditSha256||spec.includeDesktop!==(value.desktop!==null))fail('VISION_WINDOWS_OBSERVATION_PROTOCOL');return value}
/** No timeout signal, process kill, implicit retry, source cache, or cached observation. */
export function createNaturalReadOnlyExecutor({executable='powershell.exe',spawnChild=spawn,budgetMs=30000,maximumBytes=1048576,maximumRecords=512,serialized=true,argumentsFor=source=>['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')]}={}){
 if(!Number.isInteger(budgetMs)||budgetMs<1||budgetMs>30000||!Number.isInteger(maximumBytes)||maximumBytes<1||maximumBytes>1048576||!Number.isInteger(maximumRecords)||maximumRecords<1||maximumRecords>512||typeof serialized!=='boolean')fail('VISION_WINDOWS_BINDING')
 const rows=[],pending=new Set();let poisoned=false,waiting=0,tail=Promise.resolve()
 const assertHealthy=()=>{if(poisoned)fail('VISION_WINDOWS_OBSERVATION_UNKNOWN')}
 function execute(source,{phase='read-only',validate}={}){
  assertHealthy();if(typeof source!=='string'||!source||source.length>65536||rows.length>=maximumRecords)fail('VISION_WINDOWS_OBSERVATION_BOUND')
  const row={requestId:rows.length+1,phase,sourceSHA256:hash(source),queuedAt:Date.now(),issuedAt:null,budgetMs,pid:null,state:'queued',unknown:false,OSSignals:0,OSInput:0};rows.push(row);waiting++
  const runOnce=()=>{waiting--;try{assertHealthy()}catch(error){row.state='unknown-before-issue';row.unknown=true;throw error};row.issuedAt=Date.now();row.state='issued';return new Promise((resolve,reject)=>{
   const started=performance.now();let child,timer,settled=false,length=0,errorLength=0;const parts=[],stderrHash=createHash('sha256')
   const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);row.elapsedMs=performance.now()-started;if(error)reject(error);else resolve(value)}
   const unknown=code=>{poisoned=true;row.state='unknown';row.unknown=true;finish(Object.assign(Error(code),{code}))}
   try{child=spawnChild(executable,argumentsFor(source),{stdio:['ignore','pipe','pipe'],windowsHide:true});row.pid=child.pid??null}catch{row.state='spawn-error';finish(Object.assign(Error('VISION_WINDOWS_OBSERVATION_SPAWN'),{code:'VISION_WINDOWS_OBSERVATION_SPAWN'}));return}
   const closed=new Promise(done=>child.once('close',()=>done()));pending.add(closed);closed.finally(()=>pending.delete(closed))
   child.stdout.on('data',b=>{length+=b.length;if(length>maximumBytes){unknown('VISION_WINDOWS_OBSERVATION_BOUND');return}if(!row.unknown)parts.push(b)})
   child.stderr.on('data',b=>{errorLength+=b.length;stderrHash.update(b)})
   child.once('error',()=>{row.state='spawn-error';finish(Object.assign(Error('VISION_WINDOWS_OBSERVATION_SPAWN'),{code:'VISION_WINDOWS_OBSERVATION_SPAWN'}))})
   child.once('close',(code,signal)=>{
    row.observedExit={code,signal,natural:signal===null,stdoutBytes:length,stderrBytes:errorLength,stderrSHA256:stderrHash.digest('hex')}
    if(settled)return
    if(code!==0||signal!==null){row.state='failed-natural-read';finish(Object.assign(Error('VISION_WINDOWS_OBSERVATION_FAILED'),{code:'VISION_WINDOWS_OBSERVATION_FAILED'}));return}
    try{let value=JSON.parse(Buffer.concat(parts).toString('utf8').replace(/^\uFEFF/u,''));if(validate)value=validate(value);row.state='completed';finish(null,value)}catch{unknown('VISION_WINDOWS_OBSERVATION_PROTOCOL')}
   })
   timer=setTimeout(()=>unknown('VISION_WINDOWS_OBSERVATION_TIMEOUT'),budgetMs)
  })};const work=serialized?tail.then(runOnce):Promise.resolve().then(runOnce);if(serialized)tail=work.then(()=>{},()=>{});return work
 }
 return{execute,assertHealthy,facts:()=>({version:1,kind:'fresh-async-read-only-PowerShell-not-device-input',unknown:poisoned,pending:pending.size+waiting,queued:waiting,serialized,rows:structuredClone(rows),OSSignals:0,OSInput:0,automaticRetries:0,cacheUsed:false}),settled:async()=>{await tail;return Promise.allSettled([...pending])}}
}
