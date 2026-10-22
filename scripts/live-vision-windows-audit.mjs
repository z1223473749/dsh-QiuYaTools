/** Test-only PowerShell producers. Reuse the independently tested C# policy. */
const quote=value=>`'${String(value).replaceAll("'","''")}'`
export function windowsVisionAuditPrelude(path,sha256){
 if(!/^[a-f0-9]{64}$/u.test(sha256))throw Error('VISION_WINDOWS_AUDIT_SHA')
 return `$auditPath=${quote(path)};if((Get-FileHash -LiteralPath $auditPath -Algorithm SHA256).Hash.ToLowerInvariant()-cne '${sha256}'){throw 'Own audit source changed'};Add-Type -Path $auditPath;`
}
// One Process/SafeHandle is retained throughout the four-second initialization
// sample. Only missing loader metadata may wait; foreign nonempty data rejects.
export const windowsVisionPinFunction=String.raw`
function Get-VisionReadyIdentity([Diagnostics.Process]$process,[string]$expected,[int]$parent,[int]$session,[string]$parentBirth=''){
 $samples=[Collections.Generic.List[object]]::new();$result=$null;$failure=$null
 try{
  $null=$process.SafeHandle;$originalBirth=$process.StartTime.ToUniversalTime().Ticks
  if($parentBirth -and $originalBirth-lt [long]$parentBirth){throw 'Child predates pinned parent'}
  $clock=[Diagnostics.Stopwatch]::StartNew();$stable=0;$attempts=0
  while($clock.ElapsedMilliseconds-le 4000){
   $attempts++;$process.Refresh();if($process.HasExited){throw 'Child exited before identity readiness'}
   $actualBirth=$process.StartTime.ToUniversalTime().Ticks;$row=Get-CimInstance Win32_Process -Filter ('ProcessId='+$process.Id)
   if(!$row){throw 'Own CIM identity unavailable'}
   $modulePath=$null;$moduleError=0;$processSession=0
   try{$modulePath=$process.MainModule.FileName;$processSession=$process.SessionId}
   catch [ComponentModel.Win32Exception]{$moduleError=$_.Exception.NativeErrorCode}
   catch [InvalidOperationException]{$moduleError=10001}
   $cimBirth=$row.CreationDate.ToUniversalTime().Ticks
   $decision=[QytRemoteAudit]::BindingDecision($originalBirth.ToString(),$actualBirth.ToString(),$cimBirth.ToString(),$parent,[int]$row.ParentProcessId,$expected,[string]$row.ExecutablePath,$session,[int]$row.SessionId,$modulePath,$processSession,$process.HasExited,$moduleError)
   if($samples.Count-lt 128){[void]$samples.Add(@{attempt=$attempts;elapsedMs=$clock.ElapsedMilliseconds;decision=$decision;birthMatches=($originalBirth-eq $actualBirth);cimBirthMatches=($actualBirth-($actualBirth%10)-eq $cimBirth);parentMatches=($parent-le 0-or [int]$row.ParentProcessId-eq $parent);cimPathMatches=([string]$row.ExecutablePath-ieq $expected);cimSessionMatches=([int]$row.SessionId-eq $session);moduleAvailable=![string]::IsNullOrEmpty($modulePath);moduleMatches=($modulePath-ieq $expected);processSessionMatches=($processSession-eq $session);moduleErrorCategory=if($moduleError-eq 0){'none'}elseif($moduleError-eq 299){'partial-copy'}elseif($moduleError-eq 10001){'module-not-initialized'}else{'other-rejected'}})}
   if($decision-eq 'reject'){throw 'Own identity rejected'}
   if($decision-eq 'ready'){$stable++}else{$stable=0}
   if($stable-ge 2){$result=@{pid=$process.Id;parentPid=[int]$row.ParentProcessId;createdAtTicks=$originalBirth.ToString();executablePath=$modulePath;sessionId=$processSession};break}
   Start-Sleep -Milliseconds 50
  }
  if(!$result){throw 'Own metadata readiness deadline'}
 }catch{$failure='VISION_WINDOWS_IDENTITY_INITIALIZATION'}
 return @{passed=($null-ne $result-and $null-eq $failure);identity=$result;samples=@($samples.ToArray());error=$failure;maximumInitializationMs=4000}
}
`
export function windowsVisionPinCommand({pid,path,parentPid=0,parentBirth='',sessionId,auditPath,auditSha256}){
 if(!Number.isSafeInteger(pid)||pid<=1||!Number.isSafeInteger(parentPid)||parentPid<0||!Number.isSafeInteger(sessionId)||sessionId<=0||parentBirth&&!/^\d{17,20}$/u.test(parentBirth))throw Error('VISION_WINDOWS_PIN_ARGUMENT')
 return `$ErrorActionPreference='Stop';${windowsVisionAuditPrelude(auditPath,auditSha256)}${windowsVisionPinFunction};$p=$null;try{$p=[Diagnostics.Process]::GetProcessById(${pid});Get-VisionReadyIdentity $p ${quote(path)} ${parentPid} ${sessionId} ${quote(parentBirth)}|ConvertTo-Json -Depth 8 -Compress}finally{if($p){$p.Dispose()}}`
}
export function windowsVisionDesktopCommand(path,sha256){return `$ErrorActionPreference='Stop';${windowsVisionAuditPrelude(path,sha256)}[QytRemoteAudit]::Snapshot()|ConvertTo-Json -Depth 5 -Compress`}
export function windowsVisionDesktopPassed(value,{sessionId,auditSha256}={}){
 return !!value&&value.phase==='after-owned-native-fixture-exit'&&value.auditSourceSha256===auditSha256&&/^[a-f0-9]{64}$/u.test(auditSha256??'')&&Number.isSafeInteger(sessionId)&&sessionId>0&&value.sessionId===sessionId&&value.userInteractive===true&&value.activeDesktopAccessible===true&&value.activeDesktopMatches===true&&value.heldKeyCount===0&&value.leaseScopeExists===true&&value.leaseFree===true&&value.journalPresent===false
}
