param([Parameter(Mandatory=$true)][ValidateSet('pin','tree','retired','listener')][string]$Operation,[int]$TargetProcessId,[string]$ExpectedBirthTicks,[string]$ExpectedExecutable,[int]$ExpectedParentId,[string]$ProfileMarker,[string]$PinsFile,[string]$PinsSHA256,[int]$Port,[Parameter(Mandatory=$true)][string]$HelperAssemblySHA256)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($HelperAssemblySHA256 -notmatch '^[a-f0-9]{64}$'){throw 'Compiled own helper SHA required'}
$qytAssembly=Join-Path $PSScriptRoot 'windows-owned-process-helper.dll';$qytAssemblyInfo=Get-Item -LiteralPath $qytAssembly;if(($qytAssemblyInfo.Attributes-band [IO.FileAttributes]::ReparsePoint)-or $qytAssemblyInfo.Length-lt 1-or $qytAssemblyInfo.Length-gt 1048576){throw 'Compiled own helper file identity'}
if((Get-FileHash -LiteralPath $qytAssembly -Algorithm SHA256).Hash.ToLowerInvariant()-cne $HelperAssemblySHA256){throw 'Compiled own helper SHA changed'}
[void][Reflection.Assembly]::LoadFile($qytAssembly)
function Read-ExactProcess([int]$qytId) {
 if($qytId -le 1){throw 'Invalid own process id'}
 $qytProcess=$null;$qytSafe=$null;$qytRef=$false
 try {
  try{$qytProcess=[Diagnostics.Process]::GetProcessById($qytId)}catch [ArgumentException]{return @{pid=$qytId;retired=$true;reason='process-absent'}}
  $qytSafe=$qytProcess.SafeHandle;if($null-eq $qytSafe){$qytFreshProcess=$null;try{try{$qytFreshProcess=[Diagnostics.Process]::GetProcessById($qytId)}catch [ArgumentException]{return @{pid=$qytId;retired=$true;reason='process-absent'}};throw 'Own process null handle remains present or unknown'}finally{if($qytFreshProcess){$qytFreshProcess.Dispose()}}};$qytSafe.DangerousAddRef([ref]$qytRef)
  $qytWait=[QytH2ProcessWait]::WaitForSingleObject($qytSafe.DangerousGetHandle(),0)
  if($qytWait -eq 0){return @{pid=$qytId;retired=$true;reason='same-handle-signaled'}}
  if($qytWait -ne 258){throw 'Own process handle wait unknown'}
  try{$qytBirth=$qytProcess.StartTime.ToUniversalTime().Ticks.ToString();$qytPath=$qytProcess.MainModule.FileName}
  catch{if([QytH2ProcessWait]::WaitForSingleObject($qytSafe.DangerousGetHandle(),0) -eq 0){return @{pid=$qytId;retired=$true;reason='same-handle-signaled-after-query'}};throw}
  $qytWait=[QytH2ProcessWait]::WaitForSingleObject($qytSafe.DangerousGetHandle(),0)
  if($qytWait -eq 0){return @{pid=$qytId;retired=$true;reason='same-handle-signaled-after-identity'}}
  if($qytWait -ne 258){throw 'Own process final handle wait unknown'}
  return @{pid=$qytId;retired=$false;birthTicks=$qytBirth;timebase='DateTimeUtcTicks';executable=$qytPath}
 }finally{if($qytRef){$qytSafe.DangerousRelease()};if($qytProcess){$qytProcess.Dispose()}}
}
function New-OwnTreeSnapshotIndex($qytPairs,$qytPins){
 $qytIndex=@{}
 foreach($qytPair in $qytPairs){
  $qytIndexPID=[int]$qytPair.ProcessId
  if($qytIndex.ContainsKey($qytIndexPID)){$qytIndex[$qytIndexPID].unique=$false;continue}
  $qytSnapshotBirth=$null
  if($qytPair.CreationDate-is [DateTime]-and $qytPair.CreationDate.Ticks-gt 0-and $qytPair.CreationDate.Ticks-lt [DateTime]::MaxValue.Ticks){try{$qytUtcBirth=$qytPair.CreationDate.ToUniversalTime().Ticks;if($qytUtcBirth-gt 0-and $qytUtcBirth-lt [DateTime]::MaxValue.Ticks){$qytSnapshotBirth=$qytUtcBirth}}catch{}}
  $qytIndex[$qytIndexPID]=@{unique=$true;birth=$qytSnapshotBirth}
 }
 foreach($qytRootPin in $qytPins){
  $qytRootSnapshot=$qytIndex[[int]$qytRootPin.pid]
  if($null-eq $qytRootSnapshot-or !$qytRootSnapshot.unique-or $null-eq $qytRootSnapshot.birth){throw 'Own tree root is not current'}
  $qytPinnedTicks=[long]$qytRootPin.birthTicks;$qytCimTicks=[long]$qytRootSnapshot.birth
  if(($qytPinnedTicks-($qytPinnedTicks%10))-ne ($qytCimTicks-($qytCimTicks%10))){throw 'Own tree root is not current'}
 }
 return $qytIndex
}
function Test-OwnSnapshotParentEdge($qytIndex,$qytPair){
 $qytChildSnapshot=$qytIndex[[int]$qytPair.ProcessId];$qytParentSnapshot=$qytIndex[[int]$qytPair.ParentProcessId]
 # A missing, duplicate or unparseable timestamp cannot prove a negative edge.
 if($null-eq $qytChildSnapshot-or $null-eq $qytParentSnapshot-or !$qytChildSnapshot.unique-or !$qytParentSnapshot.unique-or $null-eq $qytChildSnapshot.birth-or $null-eq $qytParentSnapshot.birth){return $true}
 $qytChildTicks=[long]$qytChildSnapshot.birth;$qytParentTicks=[long]$qytParentSnapshot.birth
 return (($qytChildTicks-($qytChildTicks%10))-ge ($qytParentTicks-($qytParentTicks%10)))
}
function Read-Pins {
 if(!$PinsFile -or $PinsSHA256 -notmatch '^[a-f0-9]{64}$'){throw 'Own pins binding required'}
 if((Get-FileHash -LiteralPath $PinsFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $PinsSHA256){throw 'Own pins changed'}
 $qytParsedPins=[IO.File]::ReadAllText($PinsFile)|ConvertFrom-Json
 $qytPins=@($qytParsedPins)
 if($qytPins.Count -lt 1 -or $qytPins.Count -gt 128){throw 'Own pin bound'}
 foreach($qytPin in $qytPins){if($qytPin.timebase -cne 'DateTimeUtcTicks' -or [string]$qytPin.birthTicks -notmatch '^[0-9]{18}$' -or [int]$qytPin.pid -le 1){throw 'Own pin identity invalid'}}
 return ,$qytPins
}
if($Operation -ceq 'pin'){
 $qytFirst=Read-ExactProcess $TargetProcessId;if($qytFirst.retired){throw 'Own process exited before identity pin'}
 $qytCim=Get-CimInstance Win32_Process -Filter ('ProcessId='+$TargetProcessId)
 if(!$qytCim -or [int]$qytCim.ParentProcessId -ne $ExpectedParentId -or ![string]::Equals($qytFirst.executable,$ExpectedExecutable,[StringComparison]::OrdinalIgnoreCase) -or !$ProfileMarker -or !$qytCim.CommandLine.Contains($ProfileMarker)){throw 'Own process parent/path/profile mismatch'}
 $qytSecond=Read-ExactProcess $TargetProcessId;if($qytSecond.retired -or $qytSecond.birthTicks -cne $qytFirst.birthTicks -or ![string]::Equals($qytSecond.executable,$qytFirst.executable,[StringComparison]::OrdinalIgnoreCase)){throw 'Own process changed during identity pin'}
 $qytBytes=[Text.Encoding]::UTF8.GetBytes([string]$qytCim.CommandLine);$qytSHA=[Security.Cryptography.SHA256]::Create();try{$qytCommandHash=([BitConverter]::ToString($qytSHA.ComputeHash($qytBytes))).Replace('-','').ToLowerInvariant()}finally{$qytSHA.Dispose()}
 $qytFirst.parent=[int]$qytCim.ParentProcessId;$qytFirst.commandSHA256=$qytCommandHash;$qytFirst.profileBound=$true;$qytFirst|ConvertTo-Json -Depth 5 -Compress;exit 0
}
if($Operation -ceq 'retired'){
 $qytPins=Read-Pins;$qytRows=@();foreach($qytPin in $qytPins){$qytCurrent=Read-ExactProcess ([int]$qytPin.pid);$qytRetired=$qytCurrent.retired -or $qytCurrent.birthTicks -cne [string]$qytPin.birthTicks;$qytRows+=@{pid=[int]$qytPin.pid;birthTicks=[string]$qytPin.birthTicks;retired=[bool]$qytRetired;reason=$(if($qytCurrent.retired){$qytCurrent.reason}elseif($qytRetired){'different-birth-reuse'}else{'exact-original-alive'})}};@{rows=$qytRows;passed=(@($qytRows|Where-Object{!$_.retired}).Count -eq 0);timebase='DateTimeUtcTicks'}|ConvertTo-Json -Depth 6 -Compress;exit 0
}
if($Operation -ceq 'tree'){
 $qytPins=Read-Pins;foreach($qytPin in $qytPins){$qytCurrent=Read-ExactProcess ([int]$qytPin.pid);if($qytCurrent.retired -or $qytCurrent.birthTicks -cne [string]$qytPin.birthTicks){throw 'Own tree root is not current'}}
 $qytPairs=@(Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,CreationDate);$qytSnapshotIndex=New-OwnTreeSnapshotIndex $qytPairs $qytPins;$qytExcludedEdges=@{};$qytIDs=[Collections.Generic.HashSet[int]]::new();foreach($qytPin in $qytPins){[void]$qytIDs.Add([int]$qytPin.pid)}
 for($qytDepth=0;$qytDepth -lt 16;$qytDepth++){$qytCount=$qytIDs.Count;foreach($qytPair in $qytPairs){if($qytIDs.Contains([int]$qytPair.ParentProcessId)){if(!(Test-OwnSnapshotParentEdge $qytSnapshotIndex $qytPair)){$qytEdgeKey=([int]$qytPair.ParentProcessId).ToString()+':'+([int]$qytPair.ProcessId);if(!$qytExcludedEdges.ContainsKey($qytEdgeKey)){$qytExcludedEdges[$qytEdgeKey]=$true;if($qytExcludedEdges.Count-le 16){[Console]::Error.WriteLine('own-reader-impossible-parent-edge='+(@{childPID=[int]$qytPair.ProcessId;parentPID=[int]$qytPair.ParentProcessId;childSnapshotBirthTicks=[string]$qytSnapshotIndex[[int]$qytPair.ProcessId].birth;parentSnapshotBirthTicks=[string]$qytSnapshotIndex[[int]$qytPair.ParentProcessId].birth;reason='child-before-parent-snapshot';source='same-fresh-CIM-UTC-not-live-identity';ownershipGranted=$false;retiredClaim=$false}|ConvertTo-Json -Compress))}};continue};[void]$qytIDs.Add([int]$qytPair.ProcessId)}};if($qytIDs.Count -gt 128){throw 'Own tree exceeds bound'};if($qytCount -eq $qytIDs.Count){break};if($qytDepth -eq 15){throw 'Own tree depth unknown'}}
 $qytRows=@();foreach($qytId in $qytIDs){$qytCurrent=Read-ExactProcess $qytId;if(!$qytCurrent.retired){$qytPair=@($qytPairs|Where-Object{[int]$_.ProcessId-eq $qytId});if($qytPair.Count-ne 1-or !$qytPair[0].CreationDate-or $qytPair[0].CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture)-cne ([DateTime]::new([long]$qytCurrent.birthTicks,[DateTimeKind]::Utc)).ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture)){throw 'Own subtree process changed during enumeration'};$qytCurrent.parentPid=[int]$qytPair[0].ParentProcessId;$qytCurrent.parentSnapshotBirthTicks=$null;$qytCurrent.parentSnapshotBirthSource='CIM-CreationDate-microseconds-not-live-handle';$qytParent=@($qytPairs|Where-Object{[int]$_.ProcessId-eq $qytCurrent.parentPid});if($qytParent.Count-eq 1-and $qytParent[0].CreationDate){$qytCurrent.parentSnapshotBirthTicks=$qytParent[0].CreationDate.ToUniversalTime().Ticks.ToString()};$qytRows+=$qytCurrent}};foreach($qytPin in $qytPins){$qytAfter=Read-ExactProcess ([int]$qytPin.pid);if($qytAfter.retired -or $qytAfter.birthTicks -cne [string]$qytPin.birthTicks){throw 'Own tree root changed during enumeration'}};@{rows=$qytRows;timebase='DateTimeUtcTicks'}|ConvertTo-Json -Depth 6 -Compress;exit 0
}
if($Operation -ceq 'listener'){
 if($Port -le 0 -or $Port -gt 65535 -or $ExpectedBirthTicks -notmatch '^[0-9]{18}$'){throw 'Own listener identity required'}
 $qytCurrent=Read-ExactProcess $TargetProcessId;if($qytCurrent.retired -or $qytCurrent.birthTicks -cne $ExpectedBirthTicks){throw 'Own listener process changed'}
 if([QytH2ProcessWait]::ListenerCount($TargetProcessId,$Port) -ne 1){throw 'Own exact loopback listener unavailable'}
 $qytAfter=Read-ExactProcess $TargetProcessId;if($qytAfter.retired -or $qytAfter.birthTicks -cne $ExpectedBirthTicks){throw 'Own listener process changed during read'}
 @{pid=$TargetProcessId;birthTicks=$ExpectedBirthTicks;port=$Port;loopback=$true;passed=$true}|ConvertTo-Json -Compress
}
