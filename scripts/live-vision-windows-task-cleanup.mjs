/** Static own-task cleanup is prepared before the model tasks. No process stop/signal API. */
import{win32}from'node:path';
const fail=()=>{throw Object.assign(Error('VISION_WINDOWS_TASK_SCOPE'),{code:'VISION_WINDOWS_TASK_SCOPE'})},q=s=>`'${s.replaceAll("'","''")}'`;
export function validateTaskCleanupScope(scope){
 const v=scope;if(!v||!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u.test(v.runId)||v.taskName!=='QiuYaTools-vision-'+v.runId||typeof v.root!=='string'||win32.normalize(v.root)!==v.root||win32.basename(v.root)!==v.taskName||!/^[a-z]:\\/iu.test(v.root)||/[\x00-\x1f]/u.test(v.root)||typeof v.sid!=='string'||!/^S-1-(?:\d+-){1,14}\d+$/u.test(v.sid))fail();
 const expected=`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${win32.join(v.root,'runner.ps1')}"`;
 if(v.arguments!==expected)fail();return v;
}
export function taskCleanupScript(scope){
 const s=validateTaskCleanupScope(scope),path=win32.join(s.root,'cleanup-task.ps1');return `param([Parameter(Mandatory=$true)][string]$ExpectedSHA256)
$ErrorActionPreference='Stop'
if($ExpectedSHA256-notmatch '^[a-f0-9]{64}$'){throw 'Own cleanup source digest invalid'}
$source=Get-Item -LiteralPath $PSCommandPath;$rootItem=Get-Item -LiteralPath ${q(s.root)}
if($source.FullName-ine ${q(path)}-or $source.PSIsContainer-or ($source.Attributes-band [IO.FileAttributes]::ReparsePoint)-or !$rootItem.PSIsContainer-or ($rootItem.Attributes-band [IO.FileAttributes]::ReparsePoint)-or (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()-cne $ExpectedSHA256){throw 'Own cleanup source changed'}
function Get-ExactOwnTask {
 $items=@(Get-ScheduledTask -TaskPath '\\'|Where-Object{$_.TaskName-ceq ${q(s.taskName)}})
 if($items.Count-ne 1){throw 'Own task missing or ambiguous'}
 $t=$items[0];$actions=@($t.Actions)
 if($t.TaskPath-cne '\\'-or $t.TaskName-cne ${q(s.taskName)}-or $actions.Count-ne 1-or $actions[0].Execute-ine 'powershell.exe'-or $actions[0].Arguments-cne ${q(s.arguments)}){throw 'Own task action changed'}
 $sid=[string]$t.Principal.UserId;if($sid-notmatch '^S-1-'){$sid=([Security.Principal.NTAccount]::new($sid)).Translate([Security.Principal.SecurityIdentifier]).Value}
 $logon=[string]$t.Principal.LogonType;$level=[string]$t.Principal.RunLevel
 if($sid-cne ${q(s.sid)}-or $logon-notin @('Interactive','InteractiveToken','3')-or $level-notin @('Limited','0')){throw 'Own task principal changed'}
 return $t
}
$cleanupClock=[Diagnostics.Stopwatch]::StartNew();$firstReadMs=$null;$readyInfoMs=$null;$beforeUnregisterMs=$null;$unregisteredMs=$null
$ready=$null;$info=$null
for($attempt=0;$attempt-lt 30;$attempt++){
 $t=Get-ExactOwnTask;if($null-eq $firstReadMs){$firstReadMs=$cleanupClock.ElapsedMilliseconds};$state=$t.State.ToString()
 if($state-ceq 'Ready'){$ready=$t;$info=Get-ScheduledTaskInfo -TaskPath '\\' -TaskName ${q(s.taskName)};$readyInfoMs=$cleanupClock.ElapsedMilliseconds;break}
 if($state-cne 'Running'){throw 'Own task terminal state unknown'}
 Start-Sleep -Milliseconds 200
}
if(!$ready){throw 'Own task did not finish naturally'}
$result=[long]$info.LastTaskResult;$lastRun=$info.LastRunTime.ToUniversalTime().Ticks.ToString()
$ready=Get-ExactOwnTask;$current=Get-ScheduledTaskInfo -TaskPath '\\' -TaskName ${q(s.taskName)}
if($ready.State.ToString()-cne 'Ready'-or [long]$current.LastTaskResult-ne $result-or $current.LastRunTime.ToUniversalTime().Ticks.ToString()-cne $lastRun){throw 'Own task changed before unregister'}
$beforeUnregisterMs=$cleanupClock.ElapsedMilliseconds
Unregister-ScheduledTask -InputObject $ready -Confirm:$false -ErrorAction Stop
$unregisteredMs=$cleanupClock.ElapsedMilliseconds
if(@(Get-ScheduledTask -TaskPath '\\'|Where-Object{$_.TaskName-ceq ${q(s.taskName)}}).Count-ne 0){throw 'Own task still registered'}
@{state='Ready';result=$result;identityMatched=$true;unregistered=$true;runId=${q(s.runId)};taskName=${q(s.taskName)};actionCount=1;principalSid=${q(s.sid)};sourceSHA256=$ExpectedSHA256;lastRunTicks=$lastRun;forceCalls=0;timings=@{firstExactReadMs=$firstReadMs;readyInfoMs=$readyInfoMs;beforeUnregisterMs=$beforeUnregisterMs;unregisteredMs=$unregisteredMs;finalMs=$cleanupClock.ElapsedMilliseconds}}|ConvertTo-Json -Compress
`;
}
export function validateTaskCleanupReceipt(value,scope,sourceSHA256){
 const s=validateTaskCleanupScope(scope);if(!value||value.state!=='Ready'||!Number.isSafeInteger(value.result)||value.result<0||value.identityMatched!==true||value.unregistered!==true||value.runId!==s.runId||value.taskName!==s.taskName||value.actionCount!==1||value.principalSid!==s.sid||value.sourceSHA256!==sourceSHA256||!/^\d{17,20}$/u.test(value.lastRunTicks??'')||value.forceCalls!==0)fail();return value;
}
