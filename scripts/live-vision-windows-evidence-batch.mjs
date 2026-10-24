/** Test-only final evidence reader. One fixed batch, no input, process or Task operations. */
import {createHash} from 'node:crypto'
import {win32} from 'node:path'
export const WINDOWS_FINAL_EVIDENCE_NAMES=Object.freeze(['guest-report.json','node-identity.json','node-binding-initialization.json','identity-initialization.json','runner.stdout.txt','runner.stderr.txt','children-task-1.json','children-task-2.json','children-task-3.json'])
export const WINDOWS_FINAL_EVIDENCE_MAXIMUM=1048576
export const WINDOWS_FINAL_EVIDENCE_BUDGET_MS=30000
const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),q=s=>`'${s.replaceAll("'","''")}'`
const fail=()=>{throw Object.assign(Error('VISION_WINDOWS_EVIDENCE_COLLECTION'),{code:'VISION_WINDOWS_EVIDENCE_COLLECTION'})}
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v)
function scope(value){if(!value||!uuid(value.runId)||typeof value.guestRoot!=='string'||! /^[A-Za-z]:\\/u.test(value.guestRoot)||win32.normalize(value.guestRoot)!==value.guestRoot||win32.basename(value.guestRoot)!=='QiuYaTools-vision-'+value.runId)fail();return value}
/** Script is installed before task registration. It never follows links or unbounded reads. */
export function makeWindowsFinalEvidenceBatch(value){
 const {runId,guestRoot}=scope(value)
 return `[CmdletBinding()]param([Parameter(Mandatory=$true)][string]$ExpectedSHA256)
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$clock=[Diagnostics.Stopwatch]::StartNew();$root=${q(guestRoot)};$runId=${q(runId)};$cap=${WINDOWS_FINAL_EVIDENCE_MAXIMUM};$names=@(${WINDOWS_FINAL_EVIDENCE_NAMES.map(q).join(',')})
function Remaining {if($clock.ElapsedMilliseconds-ge 30000){throw 'Evidence batch original deadline'}}
function Digest([byte[]]$bytes){$h=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($h.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function PlainPath([string]$path){$item=Get-Item -LiteralPath $path;for($i=0;$i-lt 32;$i++){if($item.Attributes-band [IO.FileAttributes]::ReparsePoint){throw 'Evidence reparse path'};if($item.PSIsContainer){$parent=$item.Parent}else{$parent=$item.Directory};if($null-eq $parent){break};$item=$parent};if($i-ge 32){throw 'Evidence ancestor bound'}}
PlainPath $PSCommandPath;if($ExpectedSHA256-cnotmatch '^[a-f0-9]{64}$'-or (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()-cne $ExpectedSHA256){throw 'Evidence source SHA'}
PlainPath $root;$rootPin=Get-Item -LiteralPath $root;if(!$rootPin.PSIsContainer-or $rootPin.FullName-cne $root){throw 'Evidence root binding'}
$rows=@();foreach($name in $names){Remaining;PlainPath $root;$currentRoot=Get-Item -LiteralPath $root;if($currentRoot.CreationTimeUtc.Ticks-ne $rootPin.CreationTimeUtc.Ticks-or $currentRoot.FullName-cne $rootPin.FullName){throw 'Evidence root changed'};$path=Join-Path $root $name;if([IO.Path]::GetFullPath($path)-cne ($root+'\\'+$name)){throw 'Evidence leaf binding'}
 if(!(Test-Path -LiteralPath $path)){$rows+=@{name=$name;available=$false};continue};PlainPath $path;$before=Get-Item -LiteralPath $path;if($before.PSIsContainer-or $before.Length-gt $cap){throw 'Evidence file bound'}
 $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{$buffer=New-Object byte[] ($cap+1);$length=0;while($length-lt $buffer.Length){Remaining;$count=$stream.Read($buffer,$length,$buffer.Length-$length);if($count-eq 0){break};$length+=$count};if($length-gt $cap-or $stream.Length-ne $length){throw 'Evidence bounded read'};$bytes=New-Object byte[] $length;[Array]::Copy($buffer,$bytes,$length);PlainPath $path;$after=Get-Item -LiteralPath $path;if($before.Length-ne $length-or $after.Length-ne $length-or $before.CreationTimeUtc.Ticks-ne $after.CreationTimeUtc.Ticks-or $before.LastWriteTimeUtc.Ticks-ne $after.LastWriteTimeUtc.Ticks){throw 'Evidence changed during read'};$rows+=@{name=$name;available=$true;length=$length;sha256=(Digest $bytes);base64=[Convert]::ToBase64String($bytes)}}finally{$stream.Dispose()}}
Remaining;@{version=1;runId=$runId;guestRoot=$root;sourceSHA256=$ExpectedSHA256;perFileLimit=$cap;rows=$rows;elapsedMs=$clock.ElapsedMilliseconds;inputs=0;signals=0;taskChanges=0}|ConvertTo-Json -Depth 6 -Compress
`
}
/** Validate the whole reply before publishing any individual local evidence. */
export function decodeWindowsFinalEvidence(value,expected){
 scope(expected)
 if(!value||Object.keys(value).sort().join('|')!==['version','runId','guestRoot','sourceSHA256','perFileLimit','rows','elapsedMs','inputs','signals','taskChanges'].sort().join('|')||value.version!==1||value.runId!==expected.runId||value.guestRoot!==expected.guestRoot||value.sourceSHA256!==expected.sourceSHA256||!/^[a-f0-9]{64}$/u.test(expected.sourceSHA256??'')||value.perFileLimit!==WINDOWS_FINAL_EVIDENCE_MAXIMUM||!Number.isFinite(value.elapsedMs)||value.elapsedMs<0||value.elapsedMs>=WINDOWS_FINAL_EVIDENCE_BUDGET_MS||value.inputs!==0||value.signals!==0||value.taskChanges!==0||!Array.isArray(value.rows)||value.rows.length!==WINDOWS_FINAL_EVIDENCE_NAMES.length)fail()
 let total=0
 return value.rows.map((row,index)=>{
  if(!row||row.name!==WINDOWS_FINAL_EVIDENCE_NAMES[index]||typeof row.available!=='boolean')fail()
  if(!row.available){if(Object.keys(row).sort().join('|')!=='available|name')fail();return{name:row.name,available:false}}
  if(Object.keys(row).sort().join('|')!=='available|base64|length|name|sha256'||!Number.isSafeInteger(row.length)||row.length<0||row.length>WINDOWS_FINAL_EVIDENCE_MAXIMUM||!/^[a-f0-9]{64}$/u.test(row.sha256??'')||typeof row.base64!=='string'||row.base64.length>4*Math.ceil(WINDOWS_FINAL_EVIDENCE_MAXIMUM/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(row.base64))fail()
  const bytes=Buffer.from(row.base64,'base64');total+=bytes.length
  if(bytes.length!==row.length||bytes.toString('base64')!==row.base64||digest(bytes)!==row.sha256||total>WINDOWS_FINAL_EVIDENCE_NAMES.length*WINDOWS_FINAL_EVIDENCE_MAXIMUM)fail()
  return{name:row.name,available:true,bytes,sha256:row.sha256}
 })
}
/** Original30s covers command+validation+local persistence. A late result cannot report success. */
export async function collectWindowsFinalEvidence({invoke,expected,publish,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 if(typeof invoke!=='function'||typeof publish!=='function')fail()
 const start=now(),deadline=start+WINDOWS_FINAL_EVIDENCE_BUDGET_MS;let timer,expired=false
 const operation=(async()=>{const reply=await invoke(WINDOWS_FINAL_EVIDENCE_BUDGET_MS);if(expired||now()>=deadline)fail();const rows=decodeWindowsFinalEvidence(reply,expected);for(const row of rows){if(expired||now()>=deadline)fail();if(row.available)await publish(row);if(expired||now()>=deadline)fail()}return{files:rows.map(r=>({name:r.name,available:r.available,...(r.available?{length:r.bytes.length,sha256:r.sha256}:{})})),elapsedMs:now()-start}})();operation.catch(()=>{})
 try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimer(()=>{expired=true;reject(Object.assign(Error('VISION_WINDOWS_EVIDENCE_COLLECTION'),{code:'VISION_WINDOWS_EVIDENCE_COLLECTION'}))},WINDOWS_FINAL_EVIDENCE_BUDGET_MS)})])}finally{clearTimer(timer)}
}
