param(
 [Parameter(Mandatory=$true)][string]$Helper,
 [Parameter(Mandatory=$true)][string]$Output,
 [ValidateRange(30,600)][int]$Seconds=120,
 [ValidateRange(1,10)][int]$Recoveries=5
)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class QytInputOracle {
 delegate bool Child(IntPtr h,IntPtr p);
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]public static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr h,Child callback,IntPtr p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder name,int maximum);
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr SendMessageTimeout(IntPtr h,uint message,IntPtr w,IntPtr l,uint flags,uint timeout,out UIntPtr result);
 [DllImport("kernel32.dll")]static extern void SetLastError(uint error);
 public static readonly List<object> ViewportReads=new List<object>();
 static int viewportSequence;
 public static int Owner(IntPtr h){uint pid;GetWindowThreadProcessId(h,out pid);return (int)pid;}
 public static bool Up(){foreach(int key in new[]{1,2,4,16,17,18,91,92})if((GetAsyncKeyState(key)&0x8000)!=0)return false;return true;}
 public static IntPtr ScrollControl(IntPtr root,int pid){
  if(Owner(root)!=pid)throw new Exception("Fixture window identity changed");
  var found=new List<IntPtr>();EnumChildWindows(root,delegate(IntPtr h,IntPtr ignored){var name=new StringBuilder(256);GetClassName(h,name,256);if(Owner(h)==pid&&name.ToString().IndexOf("LISTBOX",StringComparison.OrdinalIgnoreCase)>=0)found.Add(h);return true;},IntPtr.Zero);
  if(found.Count!=1)throw new Exception("Own fixture ListBox handle is ambiguous");return found[0];
 }
 public static int TopIndex(IntPtr list,IntPtr root,int pid){
  var read=++viewportSequence;var watch=System.Diagnostics.Stopwatch.StartNew();var attempt=0;
  while(watch.Elapsed.TotalMilliseconds<2000){
   attempt++;var foregroundBefore=GetForegroundWindow();var rootPidBefore=Owner(root);var listPidBefore=Owner(list);
   var validBefore=rootPidBefore==pid&&listPidBefore==pid&&GetAncestor(list,2)==root&&IsWindowVisible(root)&&IsWindowVisible(list)&&!IsIconic(root)&&foregroundBefore==root;
   if(!validBefore){ViewportReads.Add(new{read,attempt,apiAttempted=false,elapsedMs=watch.Elapsed.TotalMilliseconds,reason="identity-visibility-or-foreground-changed",root=root.ToInt64().ToString("x"),list=list.ToInt64().ToString("x"),pid,rootPidBefore,listPidBefore,foregroundBefore=foregroundBefore.ToInt64().ToString("x")});throw new Exception("Own visible foreground ListBox identity changed; no query or input replayed");}
   var remaining=2000-watch.Elapsed.TotalMilliseconds;if(remaining<1)break;
   var timeout=(uint)Math.Min(300,Math.Floor(remaining));var started=watch.Elapsed.TotalMilliseconds;
   // This API may fail without setting LastError. Clear it first and preserve 0 as a generic failure.
   // https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw
   SetLastError(0);UIntPtr value;var returned=SendMessageTimeout(list,0x018e,IntPtr.Zero,IntPtr.Zero,2,timeout,out value);var error=Marshal.GetLastWin32Error();
   var finished=watch.Elapsed.TotalMilliseconds;var foregroundAfter=GetForegroundWindow();var rootPidAfter=Owner(root);var listPidAfter=Owner(list);
   var validAfter=rootPidAfter==pid&&listPidAfter==pid&&GetAncestor(list,2)==root&&IsWindowVisible(root)&&IsWindowVisible(list)&&!IsIconic(root)&&foregroundAfter==root;
   ViewportReads.Add(new{read,attempt,apiAttempted=true,startedMs=started,elapsedMs=finished-started,totalElapsedMs=finished,timeoutMs=timeout,apiReturn=returned.ToInt64().ToString(),resultRaw=value.ToUInt64().ToString(),lastWin32Error=error,success=returned!=IntPtr.Zero,identityBefore=validBefore,identityAfter=validAfter,root=root.ToInt64().ToString("x"),list=list.ToInt64().ToString("x"),pid,rootPidBefore,listPidBefore,rootPidAfter,listPidAfter,foregroundBefore=foregroundBefore.ToInt64().ToString("x"),foregroundAfter=foregroundAfter.ToInt64().ToString("x")});
   if(!validAfter)throw new Exception("Own visible foreground ListBox identity changed during read-only query; no input replayed");
   if(returned!=IntPtr.Zero){if(finished>2000)throw new Exception("Read-only LB_GETTOPINDEX query exceeded its 2000ms budget");return checked((int)value.ToUInt64());}
   var delay=Math.Min(20,2000-watch.Elapsed.TotalMilliseconds);if(delay>=1)System.Threading.Thread.Sleep((int)delay);
  }
  throw new Exception("Read-only LB_GETTOPINDEX query failed within its 2000ms budget; inspect viewportOracle attempts");
 }
}
'@
New-Item -ItemType Directory -Force $Output|Out-Null
$env:QIUYA_TOOLS_NATIVE_DATA_DIR=Join-Path $Output 'native-data'
$children=[Collections.Generic.List[Diagnostics.Process]]::new()
$events=[Collections.Generic.List[object]]::new()
$samples=[Collections.Generic.List[object]]::new()
$interruptions=[Collections.Generic.List[object]]::new()
$known=@{};$script:sequence=0;$script:latestHeld=$null;$script:heldChecks=0;$activeEpoch=0;$epoch=1;$completed=0;$wheelActions=0;$cleanupErrors=[Collections.Generic.List[string]]::new()
$runner=[Diagnostics.Process]::GetCurrentProcess();$runnerBorn=$runner.StartTime.ToUniversalTime().Ticks
function Start-Native([string]$Arguments,[bool]$Pipes=$true){
 $info=[Diagnostics.ProcessStartInfo]::new($Helper,$Arguments);$info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.RedirectStandardInput=$Pipes;$info.RedirectStandardOutput=$Pipes;$info.RedirectStandardError=$Pipes
 if($Pipes){$info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)}
 $info.EnvironmentVariables['QIUYA_TOOLS_PARENT_PID']=[string]$runner.Id
 $p=[Diagnostics.Process]::Start($info);$null=$p.SafeHandle;$children.Add($p)
 if($Pipes){$null=$p.StandardError.ReadToEndAsync()};return $p
}
function Send([string]$Op,[hashtable]$Body=@{}){
 $script:sequence++;$id='input-load-'+$script:sequence;$Body.requestId=$id;$Body.op=$Op
 $native.StandardInput.WriteLine(($Body|ConvertTo-Json -Depth 10 -Compress));$native.StandardInput.Flush();return $id
}
function Line([int]$Timeout=15000){
 $read=$native.StandardOutput.ReadLineAsync();if(!$read.Wait($Timeout)){throw 'Native input response deadline'}
 if(!$read.Result){throw 'Native input pipe ended'};$value=$read.Result|ConvertFrom-Json
 if($value.event){$events.Add($value);if($value.event-eq 'inputHeld'){$script:latestHeld=$value};if($value.event-eq 'humanInput'){throw 'Unplanned human input interrupted the owned input test'}}
 return $value
}
function Reply([string]$Id){while($true){$value=Line;if($value.event){continue};if($value.requestId-ne $Id){throw 'Native input correlation failure'};return $value}}
function Call([string]$Op,[hashtable]$Body=@{}){$id=Send $Op $Body;$value=Reply $id;if(!$value.ok){throw ('Native '+$Op+' failed '+$value.error.code)};return $value.result}
function State([scriptblock]$Predicate,[string]$Reason){
 $deadline=[Diagnostics.Stopwatch]::StartNew()
 while($deadline.ElapsedMilliseconds-lt 2000){
  if($fixture.HasExited){throw 'Own fixture exited during input'}
  try{$value=Get-Content -LiteralPath (Join-Path $Output 'fixture-state.json') -Raw -Encoding UTF8|ConvertFrom-Json;if (& $Predicate $value){return $value}}catch{}
  Start-Sleep -Milliseconds 10
 }
 throw ('Fixture event readback deadline: '+$Reason)
}
function Point($Frame,[string]$Name){
 $line=$Frame.elements-split "`n"|Where-Object{$_-match ('name='+[regex]::Escape($Name)+' ')}|Select-Object -First 1
 if($line-notmatch 'bounds=([-0-9.]+),([-0-9.]+),([-0-9.]+),([-0-9.]+)'){throw ('Fixture UIA control unavailable: '+$Name)}
 return @{x=[double]$Matches[1]+[double]$Matches[3]/2-$Frame.geometry.x;y=[double]$Matches[2]+[double]$Matches[4]/2-$Frame.geometry.y}
}
function Own-Foreground{
 if($fixture.HasExited-or ![QytInputOracle]::IsWindowVisible($root)-or [QytInputOracle]::IsIconic($root)-or [QytInputOracle]::GetForegroundWindow()-ne $root-or [QytInputOracle]::Owner($root)-ne $fixture.Id){throw 'Owned visible fixture lost foreground; no input replayed'}
}
function Empty-Held{
 if(![QytInputOracle]::Up()){throw 'An actual OS mouse button or modifier remained held'}
 if($null -eq $script:latestHeld){throw 'Native inputHeld evidence is missing'}
 foreach($name in @('keys','mouseButtons','unicodeUnits')){
  $field=$script:latestHeld.PSObject.Properties[$name]
  if($null -eq $field -or $null -eq $field.Value -or $field.Value -isnot [Array]){throw ('Native inputHeld field is missing or is not an array: '+$name)}
  if($field.Value.Count -ne 0){throw ('Native held-input journal remained nonempty: '+$name)}
 }
 $script:heldChecks++
}
function Owned-Native{
 $rows=@();$path=[IO.Path]::GetFullPath($Helper)
 foreach($row in @(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath-ieq $path})){
  $p=$null
  try{
   $p=[Diagnostics.Process]::GetProcessById([int]$row.ProcessId);$null=$p.SafeHandle;$born=$p.StartTime.ToUniversalTime().Ticks
   if($born-lt $runnerBorn-or ($born-($born%10))-ne $row.CreationDate.ToUniversalTime().Ticks-or $p.MainModule.FileName-ine $path){continue}
   $role=if($row.CommandLine-match '--input-guardian'){'guardian'}elseif($row.CommandLine-match '--capture-worker'){'capture'}elseif($row.CommandLine-match '--computer'){'computer'}elseif($row.CommandLine-match '--fixture'){'fixture'}else{'other'}
   $item=@{pid=[int]$row.ProcessId;createdAtTicks=$born.ToString();expectedExecutablePath=$path;role=$role;workingSetBytes=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;handleCount=$p.HandleCount;threadCount=$p.Threads.Count}
   $known[([string]$item.pid+':'+$item.createdAtTicks)]=$item;$rows+=$item
  }catch [ArgumentException]{}catch [InvalidOperationException]{}finally{if($p){$p.Dispose()}}
 }
 return $rows
}
function Resource{
 $owned=@(Owned-Native);$guardians=@($owned|Where-Object role -eq 'guardian');$captures=@($owned|Where-Object role -eq 'capture')
 if($guardians.Count-gt 1-or $captures.Count-ne 1-or @($owned|Where-Object role -eq 'computer').Count-ne 1-or @($owned|Where-Object role -eq 'fixture').Count-ne 1){throw 'Owned native process roles grew or disappeared during steady input'}
 $sample=@{elapsedMs=$watch.ElapsedMilliseconds;completedDrags=$completed;wheelActions=$wheelActions;processes=$owned;actualInputsReleased=[QytInputOracle]::Up();foreground=[QytInputOracle]::GetForegroundWindow().ToInt64().ToString('x')};$samples.Add($sample)
 $sample|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $Output 'progress.json') -Encoding UTF8
}
try{
 if(![Environment]::UserInteractive-or $runner.SessionId-eq 0){throw 'Input endurance requires the owned interactive desktop'}
 $fixture=Start-Native ('--fixture --fixture-output "'+(Join-Path $Output 'fixture-state.json')+'"') $false
 for($i=0;$i-lt 80-and !(Test-Path (Join-Path $Output 'fixture-state.json'));$i++){Start-Sleep -Milliseconds 100}
 $native=Start-Native '--computer';$status=Call 'status'
 $target=Call 'targets'|Where-Object{$_.pid-eq $fixture.Id-and $_.title-eq 'QiuYaTools Windows Test Fixture'}|Select-Object -First 1
 if(!$target){throw 'Own native input fixture is unavailable'}
 $frame=Call 'observe' @{targetId=$target.id};$scroll=Point $frame 'Fixture scroll area';$drag=Point $frame 'Fixture drag pad'
 [IO.File]::WriteAllBytes((Join-Path $Output 'fixture-observe.jpg'),[Convert]::FromBase64String($frame.imageBase64))
 $fixture.Refresh();$root=$fixture.MainWindowHandle;$list=[QytInputOracle]::ScrollControl($root,$fixture.Id)
 $initial=State {param($s)$s.pid-eq $fixture.Id} 'initial fixture identity'
 [void](Call 'lease' @{epoch=$epoch});$activeEpoch=$epoch
 [void](Call 'act' @{epoch=$epoch;targetId=$target.id;action=@{kind='click';x=$scroll.x;y=$scroll.y}})
 Own-Foreground;Empty-Held
 $watch=[Diagnostics.Stopwatch]::StartNew();$nextSample=0;$nextRecovery=$Seconds*1000.0/($Recoveries+1)
 while($watch.Elapsed.TotalSeconds-lt $Seconds){
  Own-Foreground
  $before=State {param($s)$s.pid-eq $fixture.Id} 'before input';$top=[QytInputOracle]::TopIndex($list,$root,$fixture.Id)
  [void](Call 'act' @{epoch=$epoch;targetId=$target.id;action=@{kind='scroll';x=$scroll.x;y=$scroll.y;deltaY=120;deltaX=0}})
  $down=State {param($s)$s.wheelTotal-eq ($before.wheelTotal-120)} 'wheel down event';$downTop=[QytInputOracle]::TopIndex($list,$root,$fixture.Id)
  if($downTop-le $top){throw 'Wheel receipt arrived but actual ListBox viewport did not move down'};$wheelActions++
  [void](Call 'act' @{epoch=$epoch;targetId=$target.id;action=@{kind='scroll';x=$scroll.x;y=$scroll.y;deltaY=-120;deltaX=0}})
  $up=State {param($s)$s.wheelTotal-eq $before.wheelTotal} 'wheel up event'
  if([QytInputOracle]::TopIndex($list,$root,$fixture.Id)-ne $top){throw 'Actual ListBox viewport did not return after wheel up'};$wheelActions++
  $dragId=Send 'act' @{epoch=$epoch;targetId=$target.id;action=@{kind='drag';x=($drag.x-40);y=$drag.y;toX=($drag.x+40);toY=$drag.y}}
  $downWatch=[Diagnostics.Stopwatch]::StartNew();while(([QytInputOracle]::GetAsyncKeyState(1)-band 0x8000)-eq 0-and $downWatch.ElapsedMilliseconds-lt 1000){Start-Sleep -Milliseconds 1}
  if(([QytInputOracle]::GetAsyncKeyState(1)-band 0x8000)-eq 0){throw 'Synthetic drag never became an actual OS held mouse button'}
  $reply=Reply $dragId;if(!$reply.ok){throw ('Repeated native drag failed '+$reply.error.code)}
  $after=State {param($s)$s.drags-eq ($before.drags+1)} 'completed drag MouseDown/MouseUp';Empty-Held;Own-Foreground;$completed++
  if($interruptions.Count-gt 0-and $interruptions[$interruptions.Count-1].newEpoch-eq $epoch-and $interruptions[$interruptions.Count-1].resumedByCompletedCycle-eq 0){
   $newOwner=[string]$script:latestHeld.ownerId;$interruption=$interruptions[$interruptions.Count-1]
   if($newOwner-notmatch '^[a-f0-9]{32}$'-or $newOwner-eq $interruption.oldOwnerId){throw 'New input epoch did not record a distinct actual journal owner'}
   $interruption.newOwnerId=$newOwner;$interruption.resumedByCompletedCycle=$completed
  }
  if($watch.ElapsedMilliseconds-ge $nextSample){Resource;$nextSample+=10000}
  if($interruptions.Count-lt $Recoveries-and $watch.ElapsedMilliseconds-ge $nextRecovery){
   $guardianBefore=@(Owned-Native|Where-Object role -eq 'guardian');if($guardianBefore.Count-ne 1){throw 'Expected exactly one persistent companion guardian before recovery'}
   $beforeCancel=$after.drags;$id=Send 'act' @{epoch=$epoch;targetId=$target.id;action=@{kind='drag';x=($drag.x-180);y=$drag.y;toX=($drag.x+180);toY=$drag.y}}
   $downWatch.Restart();while(([QytInputOracle]::GetAsyncKeyState(1)-band 0x8000)-eq 0-and $downWatch.ElapsedMilliseconds-lt 1000){Start-Sleep -Milliseconds 1}
   if(([QytInputOracle]::GetAsyncKeyState(1)-band 0x8000)-eq 0){throw 'Interruption drag never became OS-held'}
   $oldOwner=[string]$script:latestHeld.ownerId;if($oldOwner-notmatch '^[a-f0-9]{32}$'){throw 'Held drag did not identify its journal owner'}
   $releaseWatch=[Diagnostics.Stopwatch]::StartNew();$releaseId=Send 'release' @{epoch=$epoch}
   while(([QytInputOracle]::GetAsyncKeyState(1)-band 0x8000)-ne 0-and $releaseWatch.ElapsedMilliseconds-lt 2000){Start-Sleep -Milliseconds 1}
   $actualUpMs=$releaseWatch.Elapsed.TotalMilliseconds;if(([QytInputOracle]::GetAsyncKeyState(1)-band 0x8000)-ne 0){throw 'Interruption did not release actual OS mouse state'}
   $responses=@{};while($responses.Count-lt 2){$answer=Line;if($answer.event){continue};if($answer.requestId-ne $id-and $answer.requestId-ne $releaseId){throw 'Interruption reply correlation failure'};$responses[$answer.requestId]=$answer}
   if(!$responses[$releaseId].ok-or $responses[$id].ok-or $responses[$id].error.code-ne 'stale-epoch'){throw 'In-flight drag was not cancelled by lease release'};$activeEpoch=0
   $staleId=Send 'act' @{epoch=$epoch;targetId=$target.id;action=@{kind='move';x=$drag.x;y=$drag.y}};$stale=Reply $staleId
   if($stale.ok-or $stale.error.code-ne 'stale-epoch'){throw 'Released epoch accepted another input'};Empty-Held
   # The guardian belongs to the companion lifetime, not each epoch. Release clears
   # the journal/desktop lock; Dispose closes its stdin. Verify reuse here, and
   # require the same exact guardian to exit naturally with the helper in finally.
   $guardianReleased=@(Owned-Native|Where-Object role -eq 'guardian')
   if($guardianReleased.Count-ne 1-or $guardianReleased[0].pid-ne $guardianBefore[0].pid-or $guardianReleased[0].createdAtTicks-ne $guardianBefore[0].createdAtTicks){throw 'Persistent guardian identity changed or grew after epoch release'}
   $epoch++;[void](Call 'lease' @{epoch=$epoch});$activeEpoch=$epoch
   $guardianAcquired=@(Owned-Native|Where-Object role -eq 'guardian')
   if($guardianAcquired.Count-ne 1-or $guardianAcquired[0].pid-ne $guardianBefore[0].pid-or $guardianAcquired[0].createdAtTicks-ne $guardianBefore[0].createdAtTicks){throw 'Persistent guardian identity changed or grew after new epoch acquisition'}
   $fresh=Call 'observe' @{targetId=$target.id;preview=$true};if($fresh.geometry.x-ne $frame.geometry.x-or $fresh.geometry.y-ne $frame.geometry.y-or $fresh.width-ne $frame.width-or $fresh.height-ne $frame.height){throw 'Fixture geometry changed; coordinates were not replayed'}
   $interruptions.Add(@{index=$interruptions.Count+1;elapsedMs=$watch.ElapsedMilliseconds;releasedEpoch=$epoch-1;newEpoch=$epoch;actualHeldBeforeRelease=$true;requestToObservedOsUpMs=$actualUpMs;cancelledDrag=$true;oldEpochRejected=$true;resumedByCompletedCycle=0;oldOwnerId=$oldOwner;newOwnerId=$null;guardianBefore=$guardianBefore[0];guardianAfterRelease=$guardianReleased[0];guardianAfterAcquire=$guardianAcquired[0];sourceDragCounterBefore=$beforeCancel;sourceDragCounterAfter=(State {param($s)$s.pid-eq $fixture.Id} 'after interruption').drags})
   $nextRecovery+=$Seconds*1000.0/($Recoveries+1)
  }
 }
 $watch.Stop();Resource;[void](Call 'release' @{epoch=$epoch});$activeEpoch=0;Empty-Held
 $final=State {param($s)$s.pid-eq $fixture.Id} 'final fixture'
 $checks=@(
  @{id='WIN-INPUT-DURATION';passed=($watch.ElapsedMilliseconds -ge [long]$Seconds*1000);actualMs=$watch.ElapsedMilliseconds;requestedMs=[long]$Seconds*1000},
  @{id='WIN-INPUT-WHEEL-DRAG-READBACK';passed=($completed -gt 0 -and $wheelActions -eq 2*$completed);completedDrags=$completed;wheelEvents=$wheelActions},
  @{id='WIN-INPUT-EPOCH-RECOVERY';passed=($interruptions.Count -eq $Recoveries -and @($interruptions|Where-Object{$_.resumedByCompletedCycle -le 0}).Count -eq 0);actual=$interruptions.Count;requested=$Recoveries},
  @{id='WIN-INPUT-HELD-STATE';passed=($script:heldChecks -gt 0 -and [QytInputOracle]::Up());validatedEmptySnapshots=$script:heldChecks}
 )
 $report=@{passed=(@($checks|Where-Object{-not $_.passed}).Count -eq 0);kind='native-scroll-drag-repeated-input-short-test';durationSeconds=$watch.Elapsed.TotalSeconds;requestedSeconds=$Seconds;completedNormalDrags=$completed;verifiedWheelEvents=$wheelActions;recoveries=$interruptions;sourceInitial=$initial;sourceFinal=$final;samples=$samples;platform='win32';architecture=$status.architecture;sessionId=$runner.SessionId;runnerIdentity=@{pid=$runner.Id;createdAtTicks=$runnerBorn.ToString()};resourceScope='Exact UUID helper PE roles only; memory/handle trends are descriptive, not a proof of no slow leaks or a renderer benchmark.';inputSource='Production native SendInput; own WinForms events and independent OS state/foreground/viewport readback. No physical HID claim.';scope='Independent native input short test, not 30-minute mixed renderer endurance or a repeated P95 latency benchmark.';events=$events.Count;checks=$checks}
}catch{$report=@{passed=$false;kind='native-scroll-drag-repeated-input-short-test';error=$_.Exception.Message;trace=$_.ScriptStackTrace;completedNormalDrags=$completed;verifiedWheelEvents=$wheelActions;recoveries=$interruptions;samples=$samples;checks=@(@{id='WIN-INPUT-EXECUTION';passed=$false;error=$_.Exception.Message})}}
finally{
 if($activeEpoch-gt 0-and $native-and !$native.HasExited){try{[void](Call 'release' @{epoch=$activeEpoch});$activeEpoch=0}catch{$cleanupErrors.Add($_.Exception.Message)}}
 try{$null=Owned-Native}catch{$cleanupErrors.Add($_.Exception.Message)}
 if($fixture-and !$fixture.HasExited){try{if(!$fixture.CloseMainWindow()){$cleanupErrors.Add('Own fixture did not accept WM_CLOSE')}}catch{$cleanupErrors.Add($_.Exception.Message)}}
 foreach($child in $children){try{if(!$child.HasExited-and $child.StartInfo.RedirectStandardInput){$child.StandardInput.Close()};if(!$child.WaitForExit(5000)){$cleanupErrors.Add('Owned process required forced retirement');$child.Kill();[void]$child.WaitForExit(2000)}}catch{$cleanupErrors.Add($_.Exception.Message)}}
 $remaining=@();$naturalWait=[Diagnostics.Stopwatch]::StartNew()
 do {
  $remaining=@();foreach($item in @($known.Values)){$p=$null;try{$p=[Diagnostics.Process]::GetProcessById($item.pid);$null=$p.SafeHandle;if($p.StartTime.ToUniversalTime().Ticks.ToString()-eq $item.createdAtTicks){$remaining+=$item}}catch [ArgumentException]{}catch [InvalidOperationException]{}finally{if($p){$p.Dispose()}}}
  if($remaining.Count-gt 0){Start-Sleep -Milliseconds 50}
 } while($remaining.Count-gt 0-and $naturalWait.ElapsedMilliseconds-lt 5000)
 $naturallyRemaining=@($remaining)
 if($remaining.Count-gt 0){
  $cleanupErrors.Add('Owned exact native identities survived natural input-test cleanup')
  foreach($item in $remaining){$p=$null;try{$p=[Diagnostics.Process]::GetProcessById($item.pid);$null=$p.SafeHandle;if($p.StartTime.ToUniversalTime().Ticks.ToString()-eq $item.createdAtTicks-and $p.MainModule.FileName-ieq $item.expectedExecutablePath){$p.Kill();if(!$p.WaitForExit(2000)){$cleanupErrors.Add('Pinned native fallback did not exit')}}}catch [ArgumentException]{}catch{$cleanupErrors.Add($_.Exception.Message)}finally{if($p){$p.Dispose()}}}
 }
 if(![QytInputOracle]::Up()){$cleanupErrors.Add('Actual mouse/modifier state was still held after cleanup')}
 if($cleanupErrors.Count-gt 0){$report.passed=$false};$report.cleanup=@{passed=($cleanupErrors.Count-eq 0);errors=@($cleanupErrors);tracked=@($known.Values);naturallyRemaining=$naturallyRemaining;remainingBeforeFallback=$remaining;forcedRetirementFailsRun=$true}
 $report.checks=@($report.checks|Where-Object{$null -ne $_})+@(@{id='WIN-INPUT-NATURAL-CLEANUP';passed=$report.cleanup.passed})
 $report.viewportOracle=@{readOnly=$true;budgetPerReadMs=2000;maximumSingleAttemptMs=300;firstSuccessfulValueReturnedWithoutExpectationFilter=$true;attempts=@([QytInputOracle]::ViewportReads)}
 $report|ConvertTo-Json -Depth 20|Set-Content -LiteralPath (Join-Path $Output 'report.json') -Encoding UTF8
}
