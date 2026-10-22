param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
$utf8=[Text.UTF8Encoding]::new($false)
$owned=[Collections.Generic.List[object]]::new()
$errors=[Collections.Generic.List[string]]::new()
$children=[Collections.Generic.List[Diagnostics.Process]]::new()
$fixture=$null;$agent=$null;$relay=$null;$agentReceipt=$null;$finalDesktop=$null;$secretsDeleted=$false;$stopped=$false;$checkpointSequence=''
function Save-Json([string]$name,$value){
 $path=Join-Path $Root $name
 [IO.File]::WriteAllText(($path+'.tmp'),(ConvertTo-Json -InputObject $value -Depth 12 -Compress),$utf8)
 Move-Item -LiteralPath ($path+'.tmp') -Destination $path -Force
}
$bindingSamples=[Collections.Generic.List[object]]::new()
$runnerPid=[Diagnostics.Process]::GetCurrentProcess().Id
function Pin-Process([Diagnostics.Process]$process,[string]$role,[string]$expected,[int]$parent=0){
 $null=$process.SafeHandle;$originalBirth=$process.StartTime.ToUniversalTime().Ticks
 if($parent -gt 0){$pinnedParent=@($owned|Where-Object {$_.pid -eq $parent});if($pinnedParent.Count -ne 1 -or $originalBirth -lt [long]$pinnedParent[0].createdAtTicks){throw ('Owned process parent birth is unverified: '+$role)}}
 $clock=[Diagnostics.Stopwatch]::StartNew();$stable=0;$attempts=0;$finalPath=$null;$lastRow=$null
 $prior=@($owned|Where-Object {$_.pid -eq $process.Id})
 $required=if($prior.Count -gt 0){1}else{2}
 try{
  while($clock.ElapsedMilliseconds -le 4000){
   $attempts++;$process.Refresh()
   if($process.HasExited){throw ('Owned process exited before identity readiness: '+$role)}
   $actualBirth=$process.StartTime.ToUniversalTime().Ticks
   $row=Get-CimInstance Win32_Process -Filter ('ProcessId='+$process.Id)
   if(!$row){throw ('Owned CIM identity unavailable: '+$role)}
   $modulePath=$null;$moduleError=0;$session=0
   try{$modulePath=$process.MainModule.FileName;$session=$process.SessionId}
   catch [ComponentModel.Win32Exception]{$moduleError=$_.Exception.NativeErrorCode}
   catch [InvalidOperationException]{$moduleError=10001}
   $cimBirth=$row.CreationDate.ToUniversalTime().Ticks
   $decision=[QytRemoteAudit]::BindingDecision($originalBirth.ToString(),$actualBirth.ToString(),$cimBirth.ToString(),$parent,[int]$row.ParentProcessId,$expected,[string]$row.ExecutablePath,[Diagnostics.Process]::GetCurrentProcess().SessionId,[int]$row.SessionId,$modulePath,$session,$process.HasExited,$moduleError)
   if($bindingSamples.Count -lt 256){[void]$bindingSamples.Add(@{role=$role;attempt=$attempts;elapsedMs=$clock.ElapsedMilliseconds;decision=$decision;birthMatches=($originalBirth -eq $actualBirth);cimBirthMatches=($actualBirth-($actualBirth%10) -eq $cimBirth);parentMatches=($parent -le 0 -or [int]$row.ParentProcessId -eq $parent);cimPathMatches=([string]$row.ExecutablePath -ieq $expected);cimSessionMatches=([int]$row.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId);moduleAvailable=![string]::IsNullOrEmpty($modulePath);moduleMatches=($modulePath -ieq $expected);processSessionMatches=($session -eq [Diagnostics.Process]::GetCurrentProcess().SessionId);moduleErrorCategory=if($moduleError -eq 0){'none'}elseif($moduleError -eq 299){'partial-copy'}elseif($moduleError -eq 10001){'module-not-initialized'}else{'other-rejected'}})}
   if($decision -eq 'reject'){throw ('Owned process identity rejected: '+$role)}
   if($decision -eq 'ready'){$stable++}else{$stable=0}
   if($stable -ge $required){$finalPath=$modulePath;$lastRow=$row;break}
   Start-Sleep -Milliseconds 50
  }
  if(!$finalPath){throw ('Owned process metadata readiness deadline: '+$role)}
  if($role -ne 'runner' -and $role -ne 'console' -and (!$lastRow.CommandLine -or $lastRow.CommandLine.IndexOf($Root,[StringComparison]::OrdinalIgnoreCase) -lt 0)){throw ('Owned process UUID command missing: '+$role)}
  if($prior.Count -gt 0){if($prior[0].createdAtTicks -ne $originalBirth.ToString() -or $prior[0].expectedExecutablePath -ine $finalPath){throw 'Recorded process identity changed'};return}
  [void]$owned.Add(@{pid=$process.Id;createdAtTicks=$originalBirth.ToString();expectedExecutablePath=$finalPath;role=$role;parentPid=[int]$lastRow.ParentProcessId})
 }finally{Save-Json 'process-binding.json' @($bindingSamples.ToArray())}
}
function Checkpoint-Processes {
 foreach($parent in @($owned)){
  $p=$null
  try{
   try{$p=[Diagnostics.Process]::GetProcessById([int]$parent.pid)}catch [ArgumentException]{continue}
   $null=$p.SafeHandle
   if($p.StartTime.ToUniversalTime().Ticks.ToString() -ne $parent.createdAtTicks){continue}
   if($p.MainModule.FileName -ine $parent.expectedExecutablePath){throw 'Recorded parent executable changed'}
   foreach($row in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$p.Id))){
    $child=$null
    try{
     try{$child=[Diagnostics.Process]::GetProcessById([int]$row.ProcessId)}catch [ArgumentException]{continue}
     $null=$child.SafeHandle;$born=$child.StartTime.ToUniversalTime().Ticks
     $live=Get-CimInstance Win32_Process -Filter ('ProcessId='+$child.Id)
     if(!$live -or [int]$live.ParentProcessId -ne $p.Id -or $live.CreationDate.ToUniversalTime().Ticks -ne ($born-($born%10))){continue}
     if($born -lt [long]$parent.createdAtTicks){throw 'Descendant predates its pinned parent'}
     $path=$child.MainModule.FileName;$role=$null
     if($path -ieq $helper -and $parent.role -eq 'agent' -and $live.CommandLine -match '(?:^|\s)--computer(?:\s|$)'){$role='native'}
     elseif($path -ieq $helper -and $parent.role -eq 'native' -and $live.CommandLine -match '(?:^|\s)--input-guardian(?:\s|$)'){$role='guardian'}
     elseif($path -ieq $helper -and $parent.role -eq 'native' -and $live.CommandLine -match '(?:^|\s)--capture-worker(?:\s|$)'){$role='capture'}
     elseif($path -ieq (Join-Path ([Environment]::SystemDirectory) 'conhost.exe')){$role='console'}
     elseif(@($owned|Where-Object {$_.pid -eq $child.Id -and $_.createdAtTicks -eq $born.ToString()}).Count -gt 0){continue}
     else{throw ('Unverified child under pinned '+$parent.role)}
     Pin-Process $child $role $path $p.Id
    }finally{if($child){$child.Dispose()}}
   }
   if($p.HasExited -or $p.StartTime.ToUniversalTime().Ticks.ToString() -ne $parent.createdAtTicks){throw 'Pinned parent exited during descendant checkpoint'}
  }finally{if($p){$p.Dispose()}}
 }
 Save-Json 'process-checkpoint.json' @($owned.ToArray())
}
function Start-Child([string]$exe,[string]$arguments,[string]$role,[bool]$capture=$false){
 $info=[Diagnostics.ProcessStartInfo]::new($exe,$arguments);$info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.RedirectStandardInput=$capture;$info.RedirectStandardOutput=$capture;$info.RedirectStandardError=$capture
 if($capture){$info.StandardOutputEncoding=$utf8}
 $process=[Diagnostics.Process]::Start($info);$children.Add($process)
 Pin-Process $process $role $exe ([Diagnostics.Process]::GetCurrentProcess().Id)
 return $process
}
function Wait-Natural([Diagnostics.Process]$process,[string]$role){
 if(!$process){return}
 if(!$process.WaitForExit(8000)){throw ('Natural exit deadline: '+$role)}
 if($process.ExitCode -ne 0){throw ('Nonzero natural exit: '+$role+' '+$process.ExitCode)}
}
try{
 if(![Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw 'Remote agent requires the logged-on desktop'}
 Add-Type -Path (Join-Path $Root 'windows-remote-audit.cs')
 $policy=[QytRemoteAudit]::BindingSelfTest();Save-Json 'binding-policy-selftest.json' $policy;if(!$policy.passed){throw 'Exact identity binding self-test failed'}
 $before=[QytRemoteAudit]::Snapshot();Save-Json 'desktop-preflight.json' $before
 if(!$before.activeDesktopAccessible -or !$before.activeDesktopMatches -or $before.heldKeyCount -ne 0){throw 'The interactive desktop is unavailable or has held input; no input started'}
 $self=[Diagnostics.Process]::GetCurrentProcess();Pin-Process $self 'runner' $self.MainModule.FileName
 $helper=Join-Path $Root 'qiuya-windows.exe'
 $fixture=Start-Child $helper ('--fixture --fixture-output "'+(Join-Path $Root 'fixture-state.json')+'"') 'fixture'
 $node=Join-Path $Root 'node-v22.23.3-win-arm64\node.exe'
 $env:QIUYA_COMPUTER_TOKEN_FILE=Join-Path $Root 'token.txt'
 $env:QIUYA_COMPUTER_NATIVE_EXECUTABLE=$helper
 $env:QIUYA_COMPUTER_NATIVE_ARGS='["--computer"]'
 $env:QIUYA_COMPUTER_HOST='127.0.0.1'
 $env:QIUYA_TOOLS_NATIVE_DATA_DIR=Join-Path $Root 'native-data'
 $agent=Start-Child $node ('"'+(Join-Path $Root 'remote-agent.mjs')+'"') 'agent' $true
 $read=$agent.StandardOutput.ReadLineAsync();if(!$read.Wait(20000)){throw 'Remote agent startup timed out'}
 if($read.Result -notmatch '^Computer agent listening: (http://127\.0\.0\.1:\d+/v1/computer)$'){throw 'Remote agent failed to report its loopback endpoint'}
 $endpoint=$Matches[1]
 for($i=0;$i -lt 100 -and !(Test-Path -LiteralPath (Join-Path $Root 'agent-started.json'));$i++){if($agent.HasExited){throw 'Agent exited before native startup'};Start-Sleep -Milliseconds 100}
 $started=Get-Content -LiteralPath (Join-Path $Root 'agent-started.json') -Raw|ConvertFrom-Json
 $native=[Diagnostics.Process]::GetProcessById([int]$started.nativePid)
 try{Pin-Process $native 'native' $helper $agent.Id}finally{$native.Dispose()}
 $config=Get-Content (Join-Path $Root 'relay-config.json') -Raw|ConvertFrom-Json
 $config|Add-Member -NotePropertyName endpoint -NotePropertyValue $endpoint
 Save-Json 'relay-runtime.json' $config
 $relay=Start-Child $node ('"'+(Join-Path $Root 'remote-relay.mjs')+'" "'+(Join-Path $Root 'relay-runtime.json')+'"') 'relay'
 Checkpoint-Processes
 Save-Json 'ready.json' @{endpoint=$endpoint;fixturePid=$fixture.Id;agentPid=$agent.Id;relayPid=$relay.Id;sessionId=$self.SessionId;node=$node;root=$Root;nodeVersion=$started.nodeVersion;architecture=$started.architecture;platform=$started.platform}
 for($i=0;$i -lt 6000;$i++){
  if(Test-Path -LiteralPath (Join-Path $Root 'stop')){$stopped=$true;break}
  if($agent.HasExited){throw 'Paired agent unexpectedly exited'}
  if(Test-Path -LiteralPath (Join-Path $Root 'checkpoint-request')){
   $requested=[IO.File]::ReadAllText((Join-Path $Root 'checkpoint-request'))
   if($requested -ne $checkpointSequence){
    if($requested -notmatch '^[a-f0-9-]{36}$'){throw 'Invalid own checkpoint sequence'}
    # Two passes include a newly discovered parent's direct infrastructure.
    Checkpoint-Processes;Checkpoint-Processes;$checkpointSequence=$requested
    Save-Json 'checkpoint-ack.json' @{sequence=$checkpointSequence;identities=@($owned.ToArray())}
   }
  }
  if(Test-Path -LiteralPath (Join-Path $Root 'reconnect')){
   Wait-Natural $relay 'disconnected relay'
   Remove-Item -LiteralPath (Join-Path $Root 'reconnect') -ErrorAction Stop
   $relay=Start-Child $node ('"'+(Join-Path $Root 'remote-relay.mjs')+'" "'+(Join-Path $Root 'relay-runtime.json')+'"') 'relay'
   Checkpoint-Processes;Save-Json 'reconnected.json' @{relayPid=$relay.Id}
  }
  if($i%10 -eq 0){Checkpoint-Processes}
  Start-Sleep -Milliseconds 100
 }
 if(!$stopped){throw 'The remote test stop deadline elapsed'}
}catch{
 $errors.Add($_.Exception.Message)
 [IO.File]::WriteAllText((Join-Path $Root 'startup-error.txt'),$_.Exception.Message,$utf8)
}finally{
 # No Kill/Stop fallback belongs to a successful receipt. Host fallback, when
 # necessary, is separately identity-fenced and always fails delivery.
 try{Checkpoint-Processes}catch{$errors.Add('Final checkpoint: '+$_.Exception.Message)}
 if($agent){try{if(!$agent.HasExited){$agent.StandardInput.WriteLine('quit');$agent.StandardInput.Close()};Wait-Natural $agent 'agent'}catch{$errors.Add($_.Exception.Message)}}
 if($fixture){try{if(!$fixture.HasExited){if(!$fixture.CloseMainWindow()){throw 'Own fixture did not accept WM_CLOSE'}};Wait-Natural $fixture 'fixture'}catch{$errors.Add($_.Exception.Message)}}
 if($relay){try{Wait-Natural $relay 'relay'}catch{$errors.Add($_.Exception.Message)}}
 foreach($row in @($owned)){
  # The runner's own console remains alive until this PowerShell exits. Both
  # retain exact identities and are required to be gone by the outer audit.
  if($row.role -eq 'runner' -or ($row.role -eq 'console' -and $row.parentPid -eq $runnerPid)){continue};$p=$null
  try{
   try{$p=[Diagnostics.Process]::GetProcessById([int]$row.pid)}catch [ArgumentException]{continue}
   $null=$p.SafeHandle
   if($p.StartTime.ToUniversalTime().Ticks.ToString() -ne $row.createdAtTicks){continue}
   if($p.MainModule.FileName -ine $row.expectedExecutablePath){throw 'Pinned child executable changed during retirement'}
   if(!$p.WaitForExit(8000)){throw ('Pinned '+$row.role+' did not retire naturally')}
  }catch{$errors.Add($_.Exception.Message)}finally{if($p){$p.Dispose()}}
 }
 try{$agentReceipt=Get-Content -LiteralPath (Join-Path $Root 'agent-cleanup.json') -Raw|ConvertFrom-Json;if(!$agentReceipt.passed){throw 'Agent cleanup receipt failed'}}catch{$errors.Add('Agent receipt: '+$_.Exception.Message)}
 try{
  foreach($name in @('token.txt','relay-config.json','relay-runtime.json')){ $path=Join-Path $Root $name;if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -ErrorAction Stop};if(Test-Path -LiteralPath $path){throw 'Private config survived deletion'} }
  $secretsDeleted=$true
 }catch{$errors.Add('Secrets: '+$_.Exception.Message)}
 try{$finalDesktop=[QytRemoteAudit]::Snapshot();if(!$finalDesktop.userInteractive -or !$finalDesktop.activeDesktopAccessible -or !$finalDesktop.activeDesktopMatches -or $finalDesktop.heldKeyCount -ne 0 -or !$finalDesktop.leaseScopeExists -or !$finalDesktop.leaseFree -or $finalDesktop.journalPresent){throw 'Desktop/lease/journal release was not confirmed'}}catch{$errors.Add('Desktop release: '+$_.Exception.Message)}
 Save-Json 'process-checkpoint.json' @($owned.ToArray())
 Save-Json 'guest-cleanup.json' @{deferredUntilOuterVerification=@($owned|Where-Object {$_.role -eq 'runner' -or ($_.role -eq 'console' -and $_.parentPid -eq $runnerPid)});passed=($errors.Count -eq 0);errors=@($errors.ToArray());forced=@();agent=$agentReceipt;secretsDeleted=$secretsDeleted;finalDesktop=$finalDesktop}
 foreach($child in $children){$child.Dispose()}
}
if($errors.Count -gt 0){exit 1}
