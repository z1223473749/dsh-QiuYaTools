param([Parameter(Mandatory=$true)][string]$HelperAssemblySHA256,[Parameter(Mandatory=$true)][string]$SourceSHA256,[Parameter(Mandatory=$true)][string]$ReaderNonce,[Parameter(Mandatory=$true)][int]$OwnerProcessId,[Parameter(Mandatory=$true)][string]$OwnerExecutable,[Parameter(Mandatory=$true)][string]$OwnerMarker)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
if($HelperAssemblySHA256-notmatch '^[a-f0-9]{64}$'-or $SourceSHA256-notmatch '^[a-f0-9]{64}$'-or $ReaderNonce-notmatch '^[a-f0-9-]{36}$'-or $OwnerProcessId-le 1){throw 'Own reader startup identity'}
$qytSource=Get-Item -LiteralPath $PSCommandPath;if(($qytSource.Attributes-band [IO.FileAttributes]::ReparsePoint)-or (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()-cne $SourceSHA256){throw 'Own reader source changed'}
$qytAssembly=Join-Path $PSScriptRoot 'windows-owned-process-helper.dll';$qytAssemblyInfo=Get-Item -LiteralPath $qytAssembly;if(($qytAssemblyInfo.Attributes-band [IO.FileAttributes]::ReparsePoint)-or $qytAssemblyInfo.Length-ne 4096-or (Get-FileHash -LiteralPath $qytAssembly -Algorithm SHA256).Hash.ToLowerInvariant()-cne $HelperAssemblySHA256){throw 'Own reader assembly changed'}
[void][Reflection.Assembly]::LoadFile($qytAssembly)
function Read-ExactProcess([int]$qytId) {
 if($qytId -le 1){throw 'Invalid own process id'}
 $qytProcess=$null;$qytSafe=$null;$qytRef=$false
 try {
  try{$qytProcess=[Diagnostics.Process]::GetProcessById($qytId)}catch [ArgumentException]{return @{pid=$qytId;retired=$true;reason='process-absent'}}
  $qytSafe=$qytProcess.SafeHandle;$qytSafe.DangerousAddRef([ref]$qytRef)
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
function Read-Pins {
 if(!$PinsFile -or $PinsSHA256 -notmatch '^[a-f0-9]{64}$'){throw 'Own pins binding required'}
 if((Get-FileHash -LiteralPath $PinsFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $PinsSHA256){throw 'Own pins changed'}
 $qytParsedPins=[IO.File]::ReadAllText($PinsFile)|ConvertFrom-Json
 $qytPins=@($qytParsedPins)
 if($qytPins.Count -lt 1 -or $qytPins.Count -gt 128){throw 'Own pin bound'}
 foreach($qytPin in $qytPins){if($qytPin.timebase -cne 'DateTimeUtcTicks' -or [string]$qytPin.birthTicks -notmatch '^[0-9]{18}$' -or [int]$qytPin.pid -le 1){throw 'Own pin identity invalid'}}
 return ,$qytPins
}

function Invoke-ExactRead {
 param([string]$Operation,[int]$TargetProcessId,[string]$ExpectedBirthTicks,[string]$ExpectedExecutable,[int]$ExpectedParentId,[string]$ProfileMarker,[string]$PinsFile,[string]$PinsSHA256,[int]$Port)
if($Operation -ceq 'pin'){
 $qytFirst=Read-ExactProcess $TargetProcessId;if($qytFirst.retired){throw 'Own process exited before identity pin'}
 $qytCim=Get-CimInstance Win32_Process -Filter ('ProcessId='+$TargetProcessId)
 if(!$qytCim -or [int]$qytCim.ParentProcessId -ne $ExpectedParentId -or ![string]::Equals($qytFirst.executable,$ExpectedExecutable,[StringComparison]::OrdinalIgnoreCase) -or !$ProfileMarker -or !$qytCim.CommandLine.Contains($ProfileMarker)){throw 'Own process parent/path/profile mismatch'}
 $qytSecond=Read-ExactProcess $TargetProcessId;if($qytSecond.retired -or $qytSecond.birthTicks -cne $qytFirst.birthTicks -or ![string]::Equals($qytSecond.executable,$qytFirst.executable,[StringComparison]::OrdinalIgnoreCase)){throw 'Own process changed during identity pin'}
 $qytBytes=[Text.Encoding]::UTF8.GetBytes([string]$qytCim.CommandLine);$qytSHA=[Security.Cryptography.SHA256]::Create();try{$qytCommandHash=([BitConverter]::ToString($qytSHA.ComputeHash($qytBytes))).Replace('-','').ToLowerInvariant()}finally{$qytSHA.Dispose()}
 $qytFirst.parent=[int]$qytCim.ParentProcessId;$qytFirst.commandSHA256=$qytCommandHash;$qytFirst.profileBound=$true;$qytFirst|ConvertTo-Json -Depth 5 -Compress;return
}
if($Operation -ceq 'retired'){
 $qytPins=Read-Pins;$qytRows=@();foreach($qytPin in $qytPins){$qytCurrent=Read-ExactProcess ([int]$qytPin.pid);$qytRetired=$qytCurrent.retired -or $qytCurrent.birthTicks -cne [string]$qytPin.birthTicks;$qytRows+=@{pid=[int]$qytPin.pid;birthTicks=[string]$qytPin.birthTicks;retired=[bool]$qytRetired;reason=$(if($qytCurrent.retired){$qytCurrent.reason}elseif($qytRetired){'different-birth-reuse'}else{'exact-original-alive'})}};@{rows=$qytRows;passed=(@($qytRows|Where-Object{!$_.retired}).Count -eq 0);timebase='DateTimeUtcTicks'}|ConvertTo-Json -Depth 6 -Compress;return
}
if($Operation -ceq 'tree'){
 $qytPins=Read-Pins;foreach($qytPin in $qytPins){$qytCurrent=Read-ExactProcess ([int]$qytPin.pid);if($qytCurrent.retired -or $qytCurrent.birthTicks -cne [string]$qytPin.birthTicks){throw 'Own tree root is not current'}}
 $qytPairs=@(Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,CreationDate);$qytIDs=[Collections.Generic.HashSet[int]]::new();foreach($qytPin in $qytPins){[void]$qytIDs.Add([int]$qytPin.pid)}
 for($qytDepth=0;$qytDepth -lt 16;$qytDepth++){$qytCount=$qytIDs.Count;foreach($qytPair in $qytPairs){if($qytIDs.Contains([int]$qytPair.ParentProcessId)){[void]$qytIDs.Add([int]$qytPair.ProcessId)}};if($qytIDs.Count -gt 128){throw 'Own tree exceeds bound'};if($qytCount -eq $qytIDs.Count){break};if($qytDepth -eq 15){throw 'Own tree depth unknown'}}
 $qytRows=@();foreach($qytId in $qytIDs){$qytCurrent=Read-ExactProcess $qytId;if(!$qytCurrent.retired){$qytPair=@($qytPairs|Where-Object{[int]$_.ProcessId-eq $qytId});if($qytPair.Count-ne 1-or !$qytPair[0].CreationDate-or $qytPair[0].CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture)-cne ([DateTime]::new([long]$qytCurrent.birthTicks,[DateTimeKind]::Utc)).ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture)){throw 'Own subtree process changed during enumeration'};$qytRows+=$qytCurrent}};foreach($qytPin in $qytPins){$qytAfter=Read-ExactProcess ([int]$qytPin.pid);if($qytAfter.retired -or $qytAfter.birthTicks -cne [string]$qytPin.birthTicks){throw 'Own tree root changed during enumeration'}};@{rows=$qytRows;timebase='DateTimeUtcTicks'}|ConvertTo-Json -Depth 6 -Compress;return
}
if($Operation -ceq 'listener'){
 if($Port -le 0 -or $Port -gt 65535 -or $ExpectedBirthTicks -notmatch '^[0-9]{18}$'){throw 'Own listener identity required'}
 $qytCurrent=Read-ExactProcess $TargetProcessId;if($qytCurrent.retired -or $qytCurrent.birthTicks -cne $ExpectedBirthTicks){throw 'Own listener process changed'}
 if([QytH2ProcessWait]::ListenerCount($TargetProcessId,$Port) -ne 1){throw 'Own exact loopback listener unavailable'}
 $qytAfter=Read-ExactProcess $TargetProcessId;if($qytAfter.retired -or $qytAfter.birthTicks -cne $ExpectedBirthTicks){throw 'Own listener process changed during read'}
 @{pid=$TargetProcessId;birthTicks=$ExpectedBirthTicks;port=$Port;loopback=$true;passed=$true}|ConvertTo-Json -Compress
}

}
function Write-OwnProtocol($value){$text=$value|ConvertTo-Json -Depth 12 -Compress;if([Text.Encoding]::UTF8.GetByteCount($text)-gt 65536){throw 'Own reader output bound'};[Console]::Out.WriteLine($text);[Console]::Out.Flush()}
function Assert-OwnRootFile([string]$path){$full=[IO.Path]::GetFullPath($path);$root=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')+'\';if(!$full.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Own reader foreign file'};$walk=$full;while($walk-and $walk.Length-ge $root.Length-1){$item=Get-Item -LiteralPath $walk;if($item.Attributes-band [IO.FileAttributes]::ReparsePoint){throw 'Own reader reparse path'};if([string]::Equals($walk,$root.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)){break};$walk=[IO.Path]::GetDirectoryName($walk)}}
$qytOwner=Read-ExactProcess $OwnerProcessId;if($qytOwner.retired-or ![string]::Equals($qytOwner.executable,$OwnerExecutable,[StringComparison]::OrdinalIgnoreCase)){throw 'Own reader owner path mismatch'}
$qytOwnerCim=Get-CimInstance Win32_Process -Filter ('ProcessId='+$OwnerProcessId);$qytSelfCim=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID);if(!$qytOwnerCim-or !$qytSelfCim-or [int]$qytSelfCim.ParentProcessId-ne $OwnerProcessId-or !$qytOwnerCim.CommandLine.Contains($OwnerMarker)){throw 'Own reader exact parent/marker mismatch'}
$qytOwnerAfter=Read-ExactProcess $OwnerProcessId;if($qytOwnerAfter.retired-or $qytOwnerAfter.birthTicks-cne $qytOwner.birthTicks){throw 'Own reader owner changed during startup'}
$qytSelf=Read-ExactProcess $PID;if($qytSelf.retired){throw 'Own reader self retired'}
Write-OwnProtocol @{type='ready';version=1;nonce=$ReaderNonce;sourceSHA256=$SourceSHA256;helperSHA256=$HelperAssemblySHA256;identity=@{pid=$PID;parent=$OwnerProcessId;birthTicks=$qytSelf.birthTicks;executable=$qytSelf.executable;timebase='DateTimeUtcTicks'}}
$qytSequence=0
while($null-ne ($qytLine=[Console]::In.ReadLine())){
 if([Text.Encoding]::UTF8.GetByteCount($qytLine)-gt 16384){throw 'Own reader input bound'}
 $qytRequest=$qytLine|ConvertFrom-Json;$qytFields=@($qytRequest.PSObject.Properties.Name|Sort-Object);if(($qytFields-join ',')-cne 'arguments,nonce,operation,requestId,version'-or ($qytRequest.version-isnot [int]-and $qytRequest.version-isnot [long])-or $qytRequest.version-ne 1-or $qytRequest.nonce-isnot [string]-or $qytRequest.operation-isnot [string]-or $qytRequest.nonce-cne $ReaderNonce-or ($qytRequest.requestId-isnot [int]-and $qytRequest.requestId-isnot [long])-or $qytRequest.requestId-ne $qytSequence+1){throw 'Own reader exact protocol request'};$qytSequence++
 $qytCurrentOwner=Read-ExactProcess $OwnerProcessId;if($qytCurrentOwner.retired-or $qytCurrentOwner.birthTicks-cne $qytOwner.birthTicks){throw 'Own reader original owner retired'}
 $qytAllowed=switch -CaseSensitive ($qytRequest.operation){'pin'{@('ExpectedExecutable','ExpectedParentId','ProfileMarker','TargetProcessId')};'tree'{@('PinsFile','PinsSHA256')};'retired'{@('PinsFile','PinsSHA256')};'listener'{@('ExpectedBirthTicks','Port','TargetProcessId')};default{throw 'Own reader operation rejected'}}
 $qytActual=@($qytRequest.arguments.PSObject.Properties.Name|Sort-Object);if(($qytActual-join ',')-cne (($qytAllowed|Sort-Object)-join ',')){throw 'Own reader operation fields rejected'}
 $qytArguments=@{Operation=[string]$qytRequest.operation};foreach($qytName in $qytAllowed){$qytValue=$qytRequest.arguments.$qytName;if($qytValue-isnot [string]-or $qytValue.Length-lt 1-or $qytValue.Length-gt 4096){throw 'Own reader argument type rejected'};$qytArguments[$qytName]=$qytValue}
 if($qytArguments.ContainsKey('TargetProcessId')-and $qytArguments.TargetProcessId-notmatch '^[1-9][0-9]{0,9}$'){throw 'Own reader PID format'}
 if($qytRequest.operation-ceq 'pin'){
  $qytExpectedParent=if([int]$qytArguments.TargetProcessId-eq $OwnerProcessId){[int]$qytOwnerCim.ParentProcessId}else{$OwnerProcessId};if([int]$qytArguments.ExpectedParentId-ne $qytExpectedParent){throw 'Own reader foreign pin parent'}
  $qytMarker=[IO.Path]::GetFullPath($qytArguments.ProfileMarker);$qytRoot=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')+'\';if(!$qytMarker.StartsWith($qytRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Own reader foreign profile marker'}
 }
 if($qytArguments.ContainsKey('PinsFile')){Assert-OwnRootFile $qytArguments.PinsFile}
 $qytClock=[Diagnostics.Stopwatch]::StartNew();$qytError=$null;$qytResult=$null
 try{$qytJSON=Invoke-ExactRead @qytArguments;$qytResult=$qytJSON|ConvertFrom-Json;if($null-eq $qytResult){throw 'Own reader no result'}}
 catch{$qytError=switch -Regex ($_.Exception.Message){'root is not current|root changed'{'OWN_TREE_ROOT_NOT_CURRENT';break};'subtree process changed'{'OWN_SUBTREE_CHANGED';break};'parent/path/profile'{'OWN_PROCESS_SCOPE_MISMATCH';break};'listener'{'OWN_LISTENER_UNAVAILABLE';break};'pin|pins'{'OWN_PINS_INVALID';break};default{'OWN_READ_FAILED'}};[Console]::Error.WriteLine('own-reader-operation='+$qytRequest.operation+';code='+$qytError)}
 Write-OwnProtocol @{type='result';version=1;nonce=$ReaderNonce;requestId=$qytSequence;operation=[string]$qytRequest.operation;ok=($null-eq $qytError);result=$qytResult;errorCode=$qytError;elapsedMs=$qytClock.ElapsedMilliseconds}
}
exit 0
