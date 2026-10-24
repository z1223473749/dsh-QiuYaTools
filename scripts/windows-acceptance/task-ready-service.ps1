param([Parameter(Mandatory=$true)][string]$ConfigPath,[Parameter(Mandatory=$true)][string]$ConfigSHA256,[Parameter(Mandatory=$true)][string]$SourceSHA256)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Exact-Hash([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
function No-Reparse([string]$p){$v=Get-Item -LiteralPath $p -ErrorAction Stop;while($null-ne $v){if($v.Attributes-band [IO.FileAttributes]::ReparsePoint){throw 'OWN_REPARSE'};if($v-is [IO.DirectoryInfo]){$v=$v.Parent}else{$v=$v.Directory}}}
if($SourceSHA256-notmatch '^[a-f0-9]{64}$'-or $ConfigSHA256-notmatch '^[a-f0-9]{64}$'){throw 'OWN_HASH_FORMAT'}
No-Reparse $PSCommandPath;No-Reparse $ConfigPath
if((Exact-Hash $PSCommandPath)-cne $SourceSHA256-or (Exact-Hash $ConfigPath)-cne $ConfigSHA256){throw 'OWN_SOURCE_CHANGED'}
if((Get-Item -LiteralPath $ConfigPath).Length-gt 16384){throw 'OWN_CONFIG_BOUND'}
$qytConfig=[IO.File]::ReadAllText($ConfigPath,[Text.Encoding]::UTF8)|ConvertFrom-Json
if($qytConfig.version-ne 1-or $qytConfig.runId-notmatch '^[a-f0-9-]{36}$'-or $qytConfig.guestId-notmatch '^[a-f0-9-]{36}$'-or $qytConfig.nonce-notmatch '^[a-f0-9-]{36}$'-or $qytConfig.candidateSHA256-notmatch '^[a-f0-9]{64}$'-or $qytConfig.endpoint-notmatch '^http://[0-9.]+:[0-9]+/[a-f0-9-]{36}/task-ready$'-or $qytConfig.mainTask-notmatch '^QiuYaTools-h2-owned-[a-f0-9-]{36}$'-or $qytConfig.readerTask-notmatch '^QiuYaTools-h2-ready-[a-f0-9-]{36}$'){throw 'OWN_CONFIG_SCOPE'}
if([IO.Path]::GetDirectoryName($ConfigPath)-cne $PSScriptRoot-or $qytConfig.launcher-cne (Join-Path $PSScriptRoot 'launch.ps1')-or $qytConfig.sourcePath-cne $PSCommandPath){throw 'OWN_PATH_SCOPE'}
No-Reparse (Join-Path $PSScriptRoot 'own-root.json')
$qytOwnMarker=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'own-root.json'),[Text.Encoding]::UTF8)|ConvertFrom-Json
if($qytOwnMarker.runId-cne $qytConfig.runId-or $qytOwnMarker.guestId-cne $qytConfig.guestId-or $qytOwnMarker.candidateSHA256-cne $qytConfig.candidateSHA256){throw 'OWN_ROOT_SCOPE'}
$qytSID=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$qytSelf=[Diagnostics.Process]::GetCurrentProcess();$qytSession=$qytSelf.SessionId
if($qytSID-cne $qytConfig.sid-or $qytSession-ne $qytConfig.sessionId-or $qytSession-le 0){throw 'OWN_PRINCIPAL_SESSION'}
$qytAssembly=Join-Path $PSScriptRoot 'windows-owned-process-helper.dll';No-Reparse $qytAssembly
if((Exact-Hash $qytAssembly)-cne $qytConfig.helperSHA256){throw 'OWN_HELPER_CHANGED'}
[void][Reflection.Assembly]::LoadFile($qytAssembly)
function Read-OwnCertificate([int]$qytID,[int]$qytParent,[string]$qytCommand){
 $qytProcess=$null;$qytHandle=$null;$qytRef=$false
 try{$qytProcess=[Diagnostics.Process]::GetProcessById($qytID);$qytHandle=$qytProcess.SafeHandle;$qytHandle.DangerousAddRef([ref]$qytRef)
 if([QytH2ProcessWait]::WaitForSingleObject($qytHandle.DangerousGetHandle(),0)-ne 258){throw 'OWN_PROCESS_NOT_ACTIVE'}
 $qytBirth=$qytProcess.StartTime.ToUniversalTime().Ticks.ToString();$qytPath=$qytProcess.MainModule.FileName
 if($qytProcess.SessionId-ne $qytConfig.sessionId){throw 'OWN_TREE_SESSION'}
 $qytBytes=[Text.Encoding]::UTF8.GetBytes($qytCommand);$qytHasher=[Security.Cryptography.SHA256]::Create();try{$qytCommandSHA=([BitConverter]::ToString($qytHasher.ComputeHash($qytBytes))).Replace('-','').ToLowerInvariant()}finally{$qytHasher.Dispose()}
 $qytFileSHA=Exact-Hash $qytPath
 if([QytH2ProcessWait]::WaitForSingleObject($qytHandle.DangerousGetHandle(),0)-ne 258){throw 'OWN_PROCESS_RETIRED_DURING_PIN'}
 return @{pid=$qytID;birthTicks=$qytBirth;timebase='DateTimeUtcTicks';executable=$qytPath;parent=$qytParent;commandSHA256=$qytCommandSHA;sessionId=[int]$qytConfig.sessionId;sid=$qytSID;executableSHA256=$qytFileSHA}
 }finally{if($qytRef){$qytHandle.DangerousRelease()};if($qytProcess){$qytProcess.Dispose()}}
}
function Read-OwnTree {
 $qytRows=@(Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine);$qytIDs=[Collections.Generic.HashSet[int]]::new();[void]$qytIDs.Add($PID)
 for($qytDepth=0;$qytDepth-lt 16;$qytDepth++){$qytCount=$qytIDs.Count;foreach($qytRow in $qytRows){if($qytIDs.Contains([int]$qytRow.ParentProcessId)){[void]$qytIDs.Add([int]$qytRow.ProcessId)}};if($qytIDs.Count-gt 128){throw 'OWN_TREE_BOUND'};if($qytIDs.Count-eq $qytCount){break};if($qytDepth-eq 15){throw 'OWN_TREE_DEPTH'}}
 $qytPins=@();foreach($qytID in $qytIDs){$qytRow=@($qytRows|Where-Object{[int]$_.ProcessId-eq $qytID});if($qytRow.Count-ne 1){throw 'OWN_TREE_IDENTITY'};$qytPin=Read-OwnCertificate $qytID ([int]$qytRow[0].ParentProcessId) ([string]$qytRow[0].CommandLine);if(!$qytRow[0].CreationDate-or $qytRow[0].CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture)-cne ([DateTime]::new([long]$qytPin.birthTicks,[DateTimeKind]::Utc)).ToString('yyyyMMddHHmmssffffff',[Globalization.CultureInfo]::InvariantCulture)){throw 'OWN_TREE_BIRTH'};$qytPins+=,$qytPin};return ,$qytPins
}
function Send-Own([hashtable]$qytValue){
 $qytValue.version=1;$qytValue.runId=$qytConfig.runId;$qytValue.guestId=$qytConfig.guestId;$qytValue.candidateSHA256=$qytConfig.candidateSHA256;$qytValue.nonce=$qytConfig.nonce
 $qytBody=[Text.Encoding]::UTF8.GetBytes(($qytValue|ConvertTo-Json -Depth 10 -Compress));if($qytBody.Length-gt 16384){throw 'OWN_HTTP_BODY_BOUND'}
 $qytRequest=[Net.HttpWebRequest]::Create($qytConfig.endpoint);$qytRequest.Method='POST';$qytRequest.Proxy=$null;$qytRequest.AllowAutoRedirect=$false;$qytRequest.Timeout=4000;$qytRequest.ReadWriteTimeout=4000;$qytRequest.ContentType='application/json';$qytRequest.ContentLength=$qytBody.Length
 $qytStream=$qytRequest.GetRequestStream();try{$qytStream.Write($qytBody,0,$qytBody.Length)}finally{$qytStream.Dispose()}
 $qytResponse=$qytRequest.GetResponse();try{if([int]$qytResponse.StatusCode-ne 200){throw 'OWN_HTTP_STATUS'};$qytStream=$qytResponse.GetResponseStream();$qytMemory=[IO.MemoryStream]::new();try{$qytBuffer=[byte[]]::new(4096);while(($qytRead=$qytStream.Read($qytBuffer,0,$qytBuffer.Length))-gt 0){if($qytMemory.Length+$qytRead-gt 16384){throw 'OWN_HTTP_REPLY_BOUND'};$qytMemory.Write($qytBuffer,0,$qytRead)};$qytReply=[Text.Encoding]::UTF8.GetString($qytMemory.ToArray())|ConvertFrom-Json}finally{$qytMemory.Dispose();$qytStream.Dispose()}}finally{$qytResponse.Dispose()}
 if($qytReply.version-ne 1-or $qytReply.runId-cne $qytConfig.runId-or $qytReply.guestId-cne $qytConfig.guestId-or $qytReply.candidateSHA256-cne $qytConfig.candidateSHA256-or $qytReply.nonce-cne $qytConfig.nonce){throw 'OWN_HTTP_REPLY_SCOPE'};return $qytReply
}
$qytScheduler=New-Object -ComObject Schedule.Service;$qytScheduler.Connect();$qytFolder=$qytScheduler.GetFolder('\')
function Read-ExactTask([string]$qytName,[string]$qytPath,[string]$qytArgs,[string]$qytSHA){
 $qytTask=$qytFolder.GetTask($qytName);$qytDefinition=$qytTask.Definition;$qytActions=$qytDefinition.Actions
 if($qytActions.Count-ne 1-or $qytActions.Item(1).Path-cne 'powershell.exe'-or $qytActions.Item(1).Arguments-cne $qytArgs){throw 'OWN_TASK_ACTION'}
 $qytPrincipal=$qytDefinition.Principal;$qytActualSID=if($qytPrincipal.UserId-like 'S-1-*'){$qytPrincipal.UserId}else{([Security.Principal.NTAccount]::new($qytPrincipal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value}
 if($qytActualSID-cne $qytConfig.sid-or [int]$qytPrincipal.LogonType-ne 3-or [int]$qytPrincipal.RunLevel-ne 0-or $qytDefinition.Triggers.Count-ne 0){throw 'OWN_TASK_PRINCIPAL'}
 No-Reparse $qytPath;if((Exact-Hash $qytPath)-cne $qytSHA){throw 'OWN_TASK_SOURCE_CHANGED'}
 $qytState=switch([int]$qytTask.State){3{'Ready'}4{'Running'}2{'Queued'}1{'Disabled'}default{'Unknown'}}
 return @{task=$qytName;state=$qytState;result=[long]$qytTask.LastTaskResult;started=($qytTask.LastRunTime.Year-ge 2020);actionExact=$true;principalExact=$true;scriptExact=$true;unregistered=$false;signals=0}
}
$qytSelfArgs='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$PSCommandPath+'" -ConfigPath "'+$ConfigPath+'" -ConfigSHA256 '+$ConfigSHA256+' -SourceSHA256 '+$SourceSHA256
$qytMainArgs='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$qytConfig.launcher+'"'
$qytExitCode=1;$qytMainReads=0;$qytIssued=$false;$qytLife=[Diagnostics.Stopwatch]::StartNew();$qytEOF=$false
try{
 $qytOwnTask=Read-ExactTask $qytConfig.readerTask $PSCommandPath $qytSelfArgs $SourceSHA256
 if($qytOwnTask.state-cne 'Running'-or !$qytOwnTask.started){throw 'OWN_READER_TASK_NOT_RUNNING'}
 $qytInitialPins=Read-OwnTree;$qytIdentity=@($qytInitialPins|Where-Object{$_.pid-eq $PID});if($qytIdentity.Count-ne 1){throw 'OWN_SELF_PIN'}
 if(![string]::Equals($qytIdentity[0].executable,(Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'),[StringComparison]::OrdinalIgnoreCase)){throw 'OWN_SELF_EXECUTABLE'}
 $qytAck=Send-Own @{op='ready';identity=$qytIdentity[0];mainTaskReads=0;connected=$true;selfTaskExact=$true};if($qytAck.op-cne 'ready-ack'){throw 'OWN_READY_ACK'}
 $qytSerial=0;while(!$qytEOF){if($qytLife.ElapsedMilliseconds-ge 900000){throw 'OWN_READER_LIFETIME'};$qytSerial++;$qytCommand=Send-Own @{op='pull';serial=$qytSerial};if($qytCommand.serial-ne $qytSerial){throw 'OWN_PULL_SERIAL'};if($qytCommand.op-ceq 'wait'){continue};if($qytCommand.commandNonce-notmatch '^[a-f0-9-]{36}$'){throw 'OWN_COMMAND_NONCE'}
 if($qytCommand.op-ceq 'query'){
 if($qytIssued-or $qytCommand.terminalBudgetMs-ne 5000-or @([int]0,[int]1)-notcontains [int]$qytCommand.expectedResult){throw 'OWN_QUERY_REPLAY_OR_BUDGET'};$qytIssued=$true;$qytClock=[Diagnostics.Stopwatch]::StartNew()
 do{$qytMainReads++;$qytReceipt=Read-ExactTask $qytConfig.mainTask $qytConfig.launcher $qytMainArgs $qytConfig.launcherSHA256;if($qytClock.ElapsedMilliseconds-ge 5000){throw 'OWN_TASK_READY5S'};if($qytReceipt.state-ceq 'Ready'){break};[Threading.Thread]::Sleep(25)}while($true)
 if(!$qytReceipt.started-or $qytReceipt.result-ne $qytCommand.expectedResult){throw 'OWN_TASK_RESULT'}
 $qytAck=Send-Own @{op='result';kind='query';commandNonce=$qytCommand.commandNonce;receipt=$qytReceipt;terminalElapsedMs=$qytClock.ElapsedMilliseconds};if(@('result-ack','late-result-retained')-notcontains [string]$qytAck.op-or $qytAck.commandNonce-cne $qytCommand.commandNonce){throw 'OWN_QUERY_ACK'}
 }elseif($qytCommand.op-ceq 'eof'){
 $qytPins=Read-OwnTree;$qytAck=Send-Own @{op='result';kind='eof';commandNonce=$qytCommand.commandNonce;eofAccepted=$true;code=0;pins=$qytPins};if(@('result-ack','late-result-retained')-notcontains [string]$qytAck.op-or $qytAck.commandNonce-cne $qytCommand.commandNonce){throw 'OWN_EOF_ACK'};$qytEOF=$true;$qytExitCode=0
 }else{throw 'OWN_COMMAND_KIND'}
 }
}catch{[Console]::Error.WriteLine('OWN_READER_FAILED');$qytExitCode=1}
finally{if($qytSelf){$qytSelf.Dispose()};if($qytFolder){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($qytFolder)};if($qytScheduler){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($qytScheduler)}}
exit $qytExitCode
