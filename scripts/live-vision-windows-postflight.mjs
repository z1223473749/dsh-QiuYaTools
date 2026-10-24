/** Test-only warm postflight. Original Task/evidence scripts execute once, after the final task, in one prepared PS. */
import {createHash,randomUUID} from 'node:crypto'
import {win32} from 'node:path'
import {validateTaskCleanupScope,validateTaskCleanupReceipt} from './live-vision-windows-task-cleanup.mjs'
import {decodeWindowsFinalEvidence,WINDOWS_FINAL_EVIDENCE_BUDGET_MS} from './live-vision-windows-evidence-batch.mjs'
const SHA=/^[a-f0-9]{64}$/u,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const fail=code=>{throw Object.assign(Error(code),{code})},digest=b=>createHash('sha256').update(b).digest('hex')
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('|')!==[...keys].sort().join('|'))fail('VISION_POSTFLIGHT_PROTOCOL')}
export function windowsPostflightConfig({scope,rendezvousNonce,nonce,endpoint,bridgeToken,cleanupSHA256,evidenceSHA256,expiresAt}){
 validateTaskCleanupScope(scope);if(!SHA.test(rendezvousNonce)||!UUID.test(nonce)||!SHA.test(bridgeToken)||!SHA.test(cleanupSHA256)||!SHA.test(evidenceSHA256)||!Number.isSafeInteger(expiresAt))fail('VISION_POSTFLIGHT_SCOPE')
 const u=new URL(endpoint);if(u.protocol!=='http:'||u.hostname!=='10.211.55.2'||!u.port||u.pathname!=='/bridge/postflight'||u.username||u.password||u.hash||u.search)fail('VISION_POSTFLIGHT_SCOPE')
 return{version:1,runId:scope.runId,rendezvousNonce,nonce,endpoint,bridgeToken,root:scope.root,workerPath:win32.join(scope.root,'postflight-worker.ps1'),configPath:win32.join(scope.root,'postflight-config.json'),cleanupPath:win32.join(scope.root,'cleanup-task.ps1'),cleanupSHA256,evidencePath:win32.join(scope.root,'final-evidence.ps1'),evidenceSHA256,expiresAt,scope}
}
function identity(v){exact(v,['pid','birthTicks','path','imageSHA256','sessionId','sid','sourceSHA256','configSHA256']);if(!Number.isSafeInteger(v.pid)||v.pid<=1||!/^\d{18}$/u.test(v.birthTicks)||typeof v.path!=='string'||! /^[A-Za-z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu.test(v.path)||!SHA.test(v.imageSHA256)||!Number.isSafeInteger(v.sessionId)||v.sessionId<0||v.sessionId>65535||!/^S-1-(?:\d+-){1,14}\d+$/u.test(v.sid)||!SHA.test(v.sourceSHA256)||!SHA.test(v.configSHA256))fail('VISION_POSTFLIGHT_IDENTITY');return v}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});promise.catch(()=>{});return{promise,resolve,reject}}
/** Same existing private bearer route. A timeout latches unknown and never reissues the command. */
export function createWindowsPostflightChannel({config,sourceSHA256,configSHA256,id=randomUUID,setTimer=setTimeout,clearTimer=clearTimeout}){
 if(!SHA.test(sourceSHA256)||!SHA.test(configSHA256))fail('VISION_POSTFLIGHT_SCOPE')
 const ready=deferred(),result=deferred();let readyIdentity,issued=false,command,commandTaken=false,accepted=false,unknown=false,closed=false,serial=0,timer,waitReadyTimer,operation,lateResult,readsBeforeBusiness=0
 const envelope=value=>{if(value.version!==1||value.runId!==config.runId||value.rendezvousNonce!==config.rendezvousNonce||value.nonce!==config.nonce)fail('VISION_POSTFLIGHT_SCOPE')}
 const reply=value=>({version:1,runId:config.runId,rendezvousNonce:config.rendezvousNonce,nonce:config.nonce,...value})
 const sameIdentity=value=>{identity(value);if(!readyIdentity||Object.keys(readyIdentity).some(k=>value[k]!==readyIdentity[k]))fail('VISION_POSTFLIGHT_IDENTITY')}
 const reject=error=>{unknown=true;ready.reject(error);result.reject(error);return error}
 return{
  async accept(value){try{
   if(closed)fail('VISION_POSTFLIGHT_CLOSED');envelope(value)
   if(value.op==='ready'){
    exact(value,['version','runId','rendezvousNonce','nonce','op','identity','mainTaskReads','evidenceReads','prepared']);if(readyIdentity||value.mainTaskReads!==0||value.evidenceReads!==0||value.prepared!==true)fail('VISION_POSTFLIGHT_READY')
    const pin=identity(value.identity);if(pin.sourceSHA256!==sourceSHA256||pin.configSHA256!==configSHA256)fail('VISION_POSTFLIGHT_IDENTITY');readyIdentity=structuredClone(pin);readsBeforeBusiness=value.mainTaskReads;clearTimer(waitReadyTimer);ready.resolve(pin);return reply({op:'ready-ack'})
   }
   if(value.op==='pull'){
    exact(value,['version','runId','rendezvousNonce','nonce','op','identity','serial']);sameIdentity(value.identity);if(!Number.isSafeInteger(value.serial)||value.serial!==serial+1)fail('VISION_POSTFLIGHT_SERIAL');serial=value.serial
    if(!command||commandTaken)return reply({op:'wait',serial});commandTaken=true;return reply({...command,serial})
   }
   if(value.op==='result'){
    exact(value,['version','runId','rendezvousNonce','nonce','op','identity','commandNonce','kind','ok','value','elapsedMs']);sameIdentity(value.identity);if(!issued||!commandTaken||accepted||value.commandNonce!==command.commandNonce||value.kind!==operation||typeof value.ok!=='boolean'||!Number.isFinite(value.elapsedMs)||value.elapsedMs<0||value.elapsedMs>=30000)fail('VISION_POSTFLIGHT_RESULT')
    accepted=true;clearTimer(timer)
    if(unknown){lateResult={accepted:true,ok:value.ok,elapsedMs:value.elapsedMs};return reply({op:'late-result-retained',commandNonce:value.commandNonce})}
    if(!value.ok)throw Object.assign(Error('VISION_POSTFLIGHT_GUEST_FAILED'),{code:'VISION_POSTFLIGHT_GUEST_FAILED'})
    if(operation==='finalize'){
     exact(value.value,['taskCleanup','evidence']);validateTaskCleanupReceipt(value.value.taskCleanup,config.scope,config.cleanupSHA256);decodeWindowsFinalEvidence(value.value.evidence,{runId:config.runId,guestRoot:config.root,sourceSHA256:config.evidenceSHA256})
    }else{exact(value.value,['cancelled','mainTaskReads','evidenceReads','OSInput','OSSignals']);if(value.value.cancelled!==true||value.value.mainTaskReads!==0||value.value.evidenceReads!==0||value.value.OSInput!==0||value.value.OSSignals!==0)fail('VISION_POSTFLIGHT_EOF')}
    result.resolve(value.value);return reply({op:'result-ack',commandNonce:value.commandNonce})
   }
   fail('VISION_POSTFLIGHT_OPERATION')
  }catch(error){throw reject(error)}},
  ready(ms=30000){if(!Number.isSafeInteger(ms)||ms<1||ms>30000)fail('VISION_POSTFLIGHT_BUDGET');if(!readyIdentity&&!waitReadyTimer)waitReadyTimer=setTimer(()=>reject(Object.assign(Error('VISION_POSTFLIGHT_READY_TIMEOUT'),{code:'VISION_POSTFLIGHT_READY_TIMEOUT'})),ms);return ready.promise},
  issue(kind='finalize',ms=30000){if(!readyIdentity||issued||unknown||closed||!['finalize','eof'].includes(kind)||!Number.isSafeInteger(ms)||ms<1||ms>30000)fail('VISION_POSTFLIGHT_REPLAY_OR_UNKNOWN');const commandNonce=id();if(!UUID.test(commandNonce))fail('VISION_POSTFLIGHT_NONCE');issued=true;operation=kind;command={op:kind,commandNonce,budgetMs:30000};timer=setTimer(()=>reject(Object.assign(Error('VISION_POSTFLIGHT_TIMEOUT'),{code:'VISION_POSTFLIGHT_TIMEOUT'})),ms);return result.promise},
  facts(){return{version:1,runId:config.runId,ready:!!readyIdentity,identity:readyIdentity?structuredClone(readyIdentity):null,mainTaskReadsBeforeBusiness:readsBeforeBusiness,evidenceReadsBeforeBusiness:0,issued,operation:operation??null,commandTaken,accepted,unknown,lateResult:lateResult??null,closed,OSInput:0,OSSignals:0}},
  close(){closed=true;clearTimer(timer);clearTimer(waitReadyTimer);if(!accepted){const e=Object.assign(Error('VISION_POSTFLIGHT_CLOSED'),{code:'VISION_POSTFLIGHT_CLOSED'});ready.reject(e);result.reject(e)}}
 }
}
/** Natural close/stdio is observed on the actual local spawn object; never signal or respawn it. */
export function trackWindowsPostflightChild(child,{maximumBytes=65536}={}){
 const record={pid:child.pid??null,exit:null,closed:false,stdoutBytes:0,stderrBytes:0,OSSignals:0};let resolveDone;const done=new Promise(resolve=>{resolveDone=resolve})
 child.stdout?.on('data',b=>{record.stdoutBytes+=b.length;if(record.stdoutBytes>maximumBytes)record.outputBound=false});child.stderr?.on('data',b=>{record.stderrBytes+=b.length;if(record.stderrBytes>maximumBytes)record.outputBound=false})
 child.once('spawn',()=>{record.pid=child.pid});child.once('exit',(code,signal)=>{record.exit={code,signal,natural:signal===null}});child.once('close',(code,signal)=>{record.closed=true;record.close={code,signal,natural:code===0&&signal===null};resolveDone(structuredClone(record))});child.once('error',e=>{record.spawnError=String(e.code??'UNKNOWN').slice(0,64);if(child.pid===undefined)resolveDone(structuredClone(record))})
 return{done,facts:()=>structuredClone(record),detach(){child.unref?.();for(const s of[child.stdin,child.stdout,child.stderr])s?.unref?.()}}
}
/** Original30s covers fresh operation, full validation, durable receipt, nine local files and natural worker close. */
export async function finishWindowsPostflight({channel,process:worker,expected,publishTask,publishFile,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 validateTaskCleanupScope(expected.scope);if(!SHA.test(expected.cleanupSHA256)||!SHA.test(expected.evidenceSHA256))fail('VISION_POSTFLIGHT_SCOPE')
 const start=now(),deadline=start+WINDOWS_FINAL_EVIDENCE_BUDGET_MS;let timer,expired=false
 const gate=()=>{if(expired||now()>=deadline)fail('VISION_POSTFLIGHT_TIMEOUT')}
 const work=(async()=>{const value=await channel.issue('finalize',30000);gate();const task=validateTaskCleanupReceipt(value.taskCleanup,expected.scope,expected.cleanupSHA256);const rows=decodeWindowsFinalEvidence(value.evidence,{runId:expected.scope.runId,guestRoot:expected.scope.root,sourceSHA256:expected.evidenceSHA256});await publishTask(task);gate();for(const row of rows){if(row.available)await publishFile(row);gate()}const ended=await worker.done;gate();if(ended.spawnError||ended.outputBound===false||ended.close?.code!==0||ended.close?.signal!==null||ended.exit?.code!==0||ended.exit?.signal!==null||!ended.closed||ended.OSSignals!==0)fail('VISION_POSTFLIGHT_NOT_NATURAL');return{task,files:rows.map(r=>({name:r.name,available:r.available,...(r.available?{bytes:r.bytes.length,sha256:r.sha256}:{})})),guestElapsedMs:value.evidence.elapsedMs,elapsedMs:now()-start,worker:ended}})();work.catch(()=>{})
 try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimer(()=>{expired=true;worker.detach();reject(Object.assign(Error('VISION_POSTFLIGHT_TIMEOUT'),{code:'VISION_POSTFLIGHT_TIMEOUT'}))},30000)})])}finally{clearTimer(timer)}
}
export function makeWindowsPostflightWorker(){return String.raw`param([Parameter(Mandatory=$true)][string]$ExpectedSHA256,[Parameter(Mandatory=$true)][string]$ConfigSHA256)
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Hash-File([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
function Plain([string]$p){$i=Get-Item -LiteralPath $p;while($null-ne $i){if($i.Attributes-band [IO.FileAttributes]::ReparsePoint){throw 'POSTFLIGHT_REPARSE'};if($i.PSIsContainer){$i=$i.Parent}else{$i=$i.Directory}}}
Plain $PSCommandPath;if($ExpectedSHA256-cnotmatch '^[a-f0-9]{64}$'-or (Hash-File $PSCommandPath)-cne $ExpectedSHA256){throw 'POSTFLIGHT_SOURCE'}
$configPath=Join-Path $PSScriptRoot 'postflight-config.json';Plain $configPath;if((Get-Item -LiteralPath $configPath).Length-gt 16384-or $ConfigSHA256-cnotmatch '^[a-f0-9]{64}$'-or (Hash-File $configPath)-cne $ConfigSHA256){throw 'POSTFLIGHT_CONFIG'}
$cfg=[IO.File]::ReadAllText($configPath,[Text.Encoding]::UTF8)|ConvertFrom-Json
if($cfg.version-ne 1-or $cfg.runId-cnotmatch '^[a-f0-9-]{36}$'-or $cfg.rendezvousNonce-cnotmatch '^[a-f0-9]{64}$'-or $cfg.nonce-cnotmatch '^[a-f0-9-]{36}$'-or $cfg.bridgeToken-cnotmatch '^[a-f0-9]{64}$'-or $cfg.endpoint-cnotmatch '^http://10\.211\.55\.2:[0-9]+/bridge/postflight$'-or $cfg.workerPath-cne $PSCommandPath-or $cfg.configPath-cne $configPath-or $cfg.root-cne $PSScriptRoot-or [IO.Path]::GetFileName($cfg.root)-cne ('QiuYaTools-vision-'+$cfg.runId)-or $cfg.cleanupPath-cne (Join-Path $PSScriptRoot 'cleanup-task.ps1')-or $cfg.evidencePath-cne (Join-Path $PSScriptRoot 'final-evidence.ps1')){throw 'POSTFLIGHT_SCOPE'}
foreach($pair in @(@($cfg.cleanupPath,$cfg.cleanupSHA256),@($cfg.evidencePath,$cfg.evidenceSHA256))){Plain $pair[0];if($pair[1]-cnotmatch '^[a-f0-9]{64}$'-or (Hash-File $pair[0])-cne $pair[1]){throw 'POSTFLIGHT_TARGET_SOURCE'}}
# Warm only the public module. Do not read the main Task or any evidence before the unique final command.
Import-Module ScheduledTasks -ErrorAction Stop
$self=[Diagnostics.Process]::GetCurrentProcess();$selfHandle=$self.SafeHandle;$image=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe';Plain $image
if(![string]::Equals($self.MainModule.FileName,$image,[StringComparison]::OrdinalIgnoreCase)){throw 'POSTFLIGHT_IMAGE'}
$identity=@{pid=$PID;birthTicks=$self.StartTime.ToUniversalTime().Ticks.ToString();path=$self.MainModule.FileName;imageSHA256=(Hash-File $image);sessionId=$self.SessionId;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;sourceSHA256=$ExpectedSHA256;configSHA256=$ConfigSHA256}
function Self-Current{if($self.HasExited-or $self.StartTime.ToUniversalTime().Ticks.ToString()-cne $identity.birthTicks-or $self.SessionId-ne $identity.sessionId-or $self.MainModule.FileName-cne $identity.path-or (Hash-File $image)-cne $identity.imageSHA256-or [Security.Principal.WindowsIdentity]::GetCurrent().User.Value-cne $identity.sid-or (Hash-File $PSCommandPath)-cne $ExpectedSHA256-or (Hash-File $configPath)-cne $ConfigSHA256){throw 'POSTFLIGHT_IDENTITY'}}
function Send([hashtable]$v){Self-Current;$v.version=1;$v.runId=$cfg.runId;$v.rendezvousNonce=$cfg.rendezvousNonce;$v.nonce=$cfg.nonce;$v.identity=$identity;$b=[Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Depth 14 -Compress));if($b.Length-gt 13631488){throw 'POSTFLIGHT_BODY'};$w=[Net.HttpWebRequest]::Create($cfg.endpoint);$w.Method='POST';$w.Proxy=$null;$w.AllowAutoRedirect=$false;$w.Timeout=5000;$w.ReadWriteTimeout=5000;$w.Headers['Authorization']='Bearer '+$cfg.bridgeToken;$w.ContentType='application/json';$w.ContentLength=$b.Length;$stream=$w.GetRequestStream();try{$stream.Write($b,0,$b.Length)}finally{$stream.Dispose()};$r=$w.GetResponse();try{if([int]$r.StatusCode-ne 200-or $r.ContentLength-gt 16384){throw 'POSTFLIGHT_HTTP'};$stream=$r.GetResponseStream();$memory=[IO.MemoryStream]::new();try{$buffer=[byte[]]::new(4096);while(($n=$stream.Read($buffer,0,$buffer.Length))-gt 0){if($memory.Length+$n-gt 16384){throw 'POSTFLIGHT_REPLY'};$memory.Write($buffer,0,$n)};$reply=[Text.Encoding]::UTF8.GetString($memory.ToArray())|ConvertFrom-Json}finally{$memory.Dispose();$stream.Dispose()}}finally{$r.Dispose()};Self-Current;if($reply.version-ne 1-or $reply.runId-cne $cfg.runId-or $reply.rendezvousNonce-cne $cfg.rendezvousNonce-or $reply.nonce-cne $cfg.nonce){throw 'POSTFLIGHT_REPLY_SCOPE'};return $reply}
$exit=1;$used=$false;$mainReads=0;$evidenceReads=0
try{$reply=Send @{op='ready';mainTaskReads=0;evidenceReads=0;prepared=$true};if($reply.op-cne 'ready-ack'){throw 'POSTFLIGHT_READY_ACK'};$serial=0
while(!$used){if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-ge $cfg.expiresAt){throw 'POSTFLIGHT_EXPIRED'};$serial++;$command=Send @{op='pull';serial=$serial};if($command.serial-ne $serial){throw 'POSTFLIGHT_SERIAL'};if($command.op-ceq 'wait'){[Threading.Thread]::Sleep(250);continue};if($command.commandNonce-cnotmatch '^[a-f0-9-]{36}$'-or $command.budgetMs-ne 30000-or $command.op-notin @('finalize','eof')){throw 'POSTFLIGHT_COMMAND'};$used=$true;$clock=[Diagnostics.Stopwatch]::StartNew();$ok=$false;$value=$null
try{if($command.op-ceq 'eof'){$value=@{cancelled=$true;mainTaskReads=0;evidenceReads=0;OSInput=0;OSSignals=0}}else{Self-Current;$mainReads++;$taskRaw=(& $cfg.cleanupPath -ExpectedSHA256 $cfg.cleanupSHA256|Out-String);if($taskRaw.Length-gt 65536-or $clock.ElapsedMilliseconds-ge 30000){throw 'POSTFLIGHT_TASK_BOUND'};$task=$taskRaw|ConvertFrom-Json;Self-Current;$evidenceReads++;$evidenceRaw=(& $cfg.evidencePath -ExpectedSHA256 $cfg.evidenceSHA256|Out-String);if($evidenceRaw.Length-gt 13631488-or $clock.ElapsedMilliseconds-ge 30000){throw 'POSTFLIGHT_EVIDENCE_BOUND'};$evidence=$evidenceRaw|ConvertFrom-Json;Self-Current;$value=@{taskCleanup=$task;evidence=$evidence}};$ok=$true}catch{$value=@{code='POSTFLIGHT_EXECUTION_FAILED'}}
$reply=Send @{op='result';commandNonce=$command.commandNonce;kind=$command.op;ok=$ok;value=$value;elapsedMs=$clock.ElapsedMilliseconds};if($reply.commandNonce-cne $command.commandNonce-or $reply.op-notin @('result-ack','late-result-retained')){throw 'POSTFLIGHT_RESULT_ACK'};if($ok-and $reply.op-ceq 'result-ack'){$exit=0}
}}catch{[Console]::Error.WriteLine('POSTFLIGHT_WORKER_FAILED')}finally{$self.Dispose()}
[Console]::Out.WriteLine('POSTFLIGHT_WORKER_FINISHED');exit $exit
`}
export const windowsPostflightSHA256=()=>digest(Buffer.from('\uFEFF'+makeWindowsPostflightWorker()))
