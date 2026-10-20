param([Parameter(Mandatory=$true)][string]$Helper,[Parameter(Mandatory=$true)][string]$Output)
$env:QIUYA_WINDOWS_INPUT_TRACE='1'
$ErrorActionPreference='Stop';New-Item -ItemType Directory -Force $Output|Out-Null
$children=[Collections.Generic.List[Diagnostics.Process]]::new();$script:sequence=0;$samples=[Collections.Generic.List[object]]::new()
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class PauseState{[DllImport("user32.dll")]public static extern short GetAsyncKeyState(int k);[DllImport("user32.dll")]static extern bool GetCursorPos(out P p);struct P{public int X,Y;}public static string Cursor(){P p;GetCursorPos(out p);return p.X+","+p.Y;}}'
Add-Type -TypeDefinition 'using System;using System.Diagnostics;using System.Threading;using System.Runtime.InteropServices;public static class PauseObserver{[DllImport("user32.dll")]static extern short GetAsyncKeyState(int k);static Stopwatch clock;static ManualResetEventSlim trigger,done;static double elapsed;public static long StartTicks,UpTicks;public static void Arm(){clock=new Stopwatch();trigger=new ManualResetEventSlim(false);done=new ManualResetEventSlim(false);var ready=new ManualResetEventSlim(false);var thread=new Thread(()=>{ready.Set();trigger.Wait();while((GetAsyncKeyState(1)&0x8000)!=0&&clock.ElapsedMilliseconds<2500)Thread.Sleep(1);UpTicks=Stopwatch.GetTimestamp();elapsed=clock.Elapsed.TotalMilliseconds;done.Set();});thread.IsBackground=true;thread.Start();if(!ready.Wait(1000))throw new Exception("Observer startup deadline");ready.Dispose();}public static void Start(){StartTicks=Stopwatch.GetTimestamp();clock.Start();trigger.Set();}public static double Wait(){if(!done.Wait(3000))throw new Exception("Observer deadline");var value=elapsed;trigger.Dispose();done.Dispose();return value;}}'
function Start-Native([string]$arguments,[bool]$pipes){$info=[Diagnostics.ProcessStartInfo]::new($Helper,$arguments);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$pipes;$info.RedirectStandardOutput=$pipes;$info.RedirectStandardError=$pipes;if($pipes){$info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)};$p=[Diagnostics.Process]::Start($info);$children.Add($p);return $p}
function Send([string]$op,[hashtable]$body=@{}){$script:sequence++;$body.op=$op;$body.requestId=$script:sequence;$native.StandardInput.WriteLine(($body|ConvertTo-Json -Depth 8 -Compress));$native.StandardInput.Flush();return $script:sequence}
function Read-Line{$line=$native.StandardOutput.ReadLineAsync();if(!$line.Wait(10000)){throw 'Native response deadline'};if(!$line.Result){throw 'Native pipe ended'};return $line.Result|ConvertFrom-Json}
function Call([string]$op,[hashtable]$body=@{}){$id=Send $op $body;while($true){$reply=Read-Line;if($reply.event){continue};if($reply.requestId -ne $id -or !$reply.ok){throw ('Native '+$op+' failed '+$reply.error.code)};return $reply.result}}
try{
 if(![Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw 'Actual interactive desktop required'}
 $fixture=Start-Native ('--fixture --fixture-output "'+(Join-Path $Output 'fixture-state.json')+'"') $false
 for($i=0;$i -lt 80 -and !(Test-Path (Join-Path $Output 'fixture-state.json'));$i++){Start-Sleep -Milliseconds 100}
 $native=Start-Native '--computer' $true;$status=Call 'status';$target=Call 'targets'|Where-Object {$_.pid -eq $fixture.Id}|Select-Object -First 1;if(!$target){throw 'Own fixture target unavailable'}
 $frame=Call 'observe' @{targetId=$target.id};$line=$frame.elements -split "`n"|Where-Object {$_ -match 'name=Fixture drag pad '}|Select-Object -First 1
 if($line -notmatch 'bounds=([-0-9.]+),([-0-9.]+),([-0-9.]+),([-0-9.]+)'){throw 'Own drag pad unavailable'}
 $x=[double]$Matches[1]-$frame.geometry.x;$y=[double]$Matches[2]-$frame.geometry.y;$width=[double]$Matches[3];$height=[double]$Matches[4]
 for($epoch=1;$epoch -le 30;$epoch++){
  [void](Call 'lease' @{epoch=$epoch});$action=Send 'act' @{epoch=$epoch;targetId=$target.id;action=@{kind='drag';x=($x+20);y=($y+$height/2);toX=($x+$width-20);toY=($y+$height/2)}}
  $held=$false
  while(!$held){$event=Read-Line;if($event.event -eq 'inputHeld' -and @($event.mouseButtons)-contains 'left'){$held=$true}elseif(!$event.event){throw 'Drag ended before held packet'}}
  $downWatch=[Diagnostics.Stopwatch]::StartNew();while($downWatch.ElapsedMilliseconds -lt 1000 -and (([PauseState]::GetAsyncKeyState(1)-band 0x8000)-eq 0)){Start-Sleep -Milliseconds 1}
  if(([PauseState]::GetAsyncKeyState(1)-band 0x8000)-eq 0){throw 'The OS never reported an actually held button'}
  [PauseObserver]::Arm();$clock=[Diagnostics.Stopwatch]::StartNew();[PauseObserver]::Start();$release=Send 'release' @{epoch=$epoch}
  $releasedMs=[PauseObserver]::Wait();if(([PauseState]::GetAsyncKeyState(1)-band 0x8000)-ne 0){throw 'Actual OS mouse release exceeded the observer deadline'};$replies=@{}
  while($replies.Count -lt 2){$reply=Read-Line;if($reply.event){continue};if($reply.requestId -ne $action -and $reply.requestId -ne $release){throw 'Unexpected response correlation'};$replies[[string]$reply.requestId]=$reply}
  if(!$replies[[string]$release].ok -or $replies[[string]$action].ok -or $replies[[string]$action].error.code -ne 'stale-epoch'){throw 'Release did not acknowledge and cancel the in-flight drag'}
  $ackMs=$clock.Elapsed.TotalMilliseconds;$cursor=[PauseState]::Cursor();$old=Send 'act' @{epoch=$epoch;targetId=$target.id;action=@{kind='move';x=$x;y=$y}}
  while($true){$reply=Read-Line;if($reply.event){continue};if($reply.requestId -ne $old -or $reply.ok -or $reply.error.code -ne 'stale-epoch'){throw 'Old epoch was not rejected after release'};break}
  Start-Sleep -Milliseconds 100;$stable=([PauseState]::Cursor()-eq $cursor) -and (([PauseState]::GetAsyncKeyState(1)-band 0x8000)-eq 0);if(!$stable){throw 'Pointer moved or became held again after the release acknowledgement'}
  $samples.Add(@{epoch=$epoch;actuallyHeldBeforeRequest=$true;requestToActualOsMouseUpMs=$releasedMs;requestTicks=[PauseObserver]::StartTicks;actualOsUpTicks=[PauseObserver]::UpTicks;requestToBothRepliesMs=$ackMs;dragCancelled=$true;releaseAcknowledged=$true;oldEpochRejected=$true;cursorStableFor100msAfterAck=$stable})
 }
 $ordered=@($samples|ForEach-Object {$_.requestToActualOsMouseUpMs}|Sort-Object);$p95=$ordered[[int][Math]::Ceiling($ordered.Count*0.95)-1];$passed=$samples.Count -eq 30 -and $p95 -le 500
 $finalStatus=Call 'status'
 $report=@{nativeInputTiming=$finalStatus.inputTiming;passed=$passed;checks=@(@{id='WIN-HELD-DRAG-RELEASE-P95';passed=$passed;samples=$samples.Count;p95Ms=$p95;targetMs=500});samples=$samples;architecture=$status.architecture;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;clock='same guest Stopwatch on an independent C# observer thread';measurement='Native stdin RPC request to independent GetAsyncKeyState(VK_LBUTTON)==up; not idle ACK or frontend latency';inputSource='Native synthetic drag, verified actually held OS button; no physical HID claim'}
}catch{$report=@{passed=$false;checks=@();samples=$samples;error=$_.Exception.Message;trace=$_.ScriptStackTrace}}
finally{foreach($child in $children){try{if(!$child.HasExited){if($child.StartInfo.RedirectStandardInput){$child.StandardInput.Close();[void]$child.WaitForExit(2000)};if(!$child.HasExited){$child.Kill()}}}catch{}};$report|ConvertTo-Json -Depth 12|Set-Content (Join-Path $Output 'report.json') -Encoding UTF8}
