param([Parameter(Mandatory=$true)][string]$Helper,[Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force $Output | Out-Null
$children=[Collections.Generic.List[Diagnostics.Process]]::new()
$script:requestId=0
$results=[Collections.Generic.List[object]]::new()
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class QiuYaEnduranceDesktop {
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder text,uint size,out uint needed);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 public static string Name(){var h=OpenInputDesktop(0,false,1);if(h==IntPtr.Zero)return "unavailable:"+Marshal.GetLastWin32Error();try{uint n;var s=new StringBuilder(256);return GetUserObjectInformation(h,2,s,512,out n)?s.ToString():"unavailable:"+Marshal.GetLastWin32Error();}finally{CloseDesktop(h);}}
}
'@
function Start-Native([string]$arguments,[bool]$pipes) {
 $info=[Diagnostics.ProcessStartInfo]::new($Helper,$arguments);$info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.RedirectStandardInput=$pipes;$info.RedirectStandardOutput=$pipes;$info.RedirectStandardError=$pipes
 if($pipes){$info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)}
 $child=[Diagnostics.Process]::Start($info);$children.Add($child);return $child
}
function Call([string]$op,[hashtable]$body=@{}) {
 $script:requestId++;$body.requestId=$script:requestId;$body.op=$op
 $native.StandardInput.WriteLine(($body|ConvertTo-Json -Depth 8 -Compress));$native.StandardInput.Flush()
 while($true){$read=$native.StandardOutput.ReadLineAsync();if(!$read.Wait(20000)){throw 'Capture timed out'};$answer=$read.Result|ConvertFrom-Json;if($answer.event){continue};if($answer.requestId -ne $script:requestId){throw 'Capture correlation failure'};if(!$answer.ok){throw ('Native capture error '+$answer.error.code)};return $answer.result}
}
try {
 if(![Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw 'Endurance requires the interactive desktop'}
 $fixture=Start-Native ('--fixture --fixture-animate --fixture-output "'+(Join-Path $Output 'fixture-state.json')+'"') $false
 for($i=0;$i -lt 80 -and !(Test-Path (Join-Path $Output 'fixture-state.json'));$i++){Start-Sleep -Milliseconds 100}
 $native=Start-Native '--computer' $true
 $status=Call 'status';$targets=Call 'targets';$target=$targets|Where-Object {$_.pid -eq $fixture.Id -and $_.title -eq 'QiuYaTools Windows Test Fixture'}|Select-Object -First 1
 if(!$target){throw 'Endurance fixture is unavailable'}
 $duration=1800;$watch=[Diagnostics.Stopwatch]::StartNew();$frames=0;$nextSample=0;$firstPrivate=$null;$firstWorking=$null;$maxPrivate=0L;$maxWorking=0L;$maxLatency=0.0;$totalLatency=0.0;$lastHash='';$lastChanged=0.0;$differentFrames=0;$sha=[Security.Cryptography.SHA256]::Create();$lastImage=$null
 while($watch.Elapsed.TotalSeconds -lt $duration){
  $latency=[Diagnostics.Stopwatch]::StartNew();$frame=Call 'observe' @{targetId=$target.id;preview=$true};$latency.Stop()
  if($frame.elements -ne '' -or $frame.width -le 0 -or $frame.imageBase64.Length -lt 4000){throw 'Invalid preview-only frame'}
  $lastImage=[Convert]::FromBase64String($frame.imageBase64);$hash=[Convert]::ToBase64String($sha.ComputeHash($lastImage));if($hash -ne $lastHash){$differentFrames++;$lastChanged=$watch.Elapsed.TotalSeconds;$lastHash=$hash};if($watch.Elapsed.TotalSeconds-$lastChanged -gt 5){throw 'Preview image stopped updating despite the animated fixture'}
  $frames++;$totalLatency+=$latency.Elapsed.TotalMilliseconds;$maxLatency=[Math]::Max($maxLatency,$latency.Elapsed.TotalMilliseconds)
  if($watch.Elapsed.TotalSeconds -ge $nextSample){
   $native.Refresh();$private=$native.PrivateMemorySize64;$working=$native.WorkingSet64;$capturePrivate=0L;$captureWorking=0L
   $captureWorkers=@(Get-CimInstance Win32_Process -Filter ('ParentProcessId = '+$native.Id)|Where-Object {$_.CommandLine -like '*--capture-worker*'})
   if($captureWorkers.Count -ne 1){throw 'The capture broker must own exactly one steady worker'}
   foreach($worker in $captureWorkers){$process=Get-Process -Id $worker.ProcessId;$capturePrivate+=$process.PrivateMemorySize64;$captureWorking+=$process.WorkingSet64}
   $private+=$capturePrivate;$working+=$captureWorking;$maxPrivate=[Math]::Max($maxPrivate,$private);$maxWorking=[Math]::Max($maxWorking,$working)
   if($watch.Elapsed.TotalSeconds -ge 60 -and $null -eq $firstPrivate){$firstPrivate=$private;$firstWorking=$working}
   $sample=@{seconds=[Math]::Round($watch.Elapsed.TotalSeconds,1);frames=$frames;uniqueFrames=$differentFrames;nativePrivateBytes=$private;nativeWorkingSetBytes=$working;captureWorkerCount=$captureWorkers.Count;captureWorkerPid=$captureWorkers[0].ProcessId;captureWorkerPrivateBytes=$capturePrivate;captureWorkerWorkingSetBytes=$captureWorking;runnerWorkingSetBytes=[Diagnostics.Process]::GetCurrentProcess().WorkingSet64;averageFrameRoundTripMs=$totalLatency/$frames}
   $results.Add($sample);$sample|ConvertTo-Json -Compress|Set-Content (Join-Path $Output 'progress.json') -Encoding UTF8;$nextSample+=60
  }
  Start-Sleep -Milliseconds 50
 }
 $growth=if($null -ne $firstPrivate){$maxPrivate-$firstPrivate}else{0}
 $passed=$differentFrames/$watch.Elapsed.TotalSeconds -ge 10 -and $growth -le 134217728
 $report=@{passed=$passed;durationSeconds=$watch.Elapsed.TotalSeconds;frames=$frames;uniqueFrames=$differentFrames;uniqueFramesPerSecond=$differentFrames/$watch.Elapsed.TotalSeconds;inputLease=$false;framesPerSecond=$frames/$watch.Elapsed.TotalSeconds;averageRoundTripMs=$totalLatency/$frames;maxRoundTripMs=$maxLatency;nativePrivateGrowthFromWarmupBytes=$growth;peakNativePrivateBytes=$maxPrivate;peakNativeWorkingSetBytes=$maxWorking;architecture=$status.architecture;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;frameImagesPersisted=1;samples=$results;checks=@(@{id='WIN-CAPTURE-ENDURANCE-30MIN';passed=$passed;detail='33ms animated native preview-only capture; at least ten unique JPEG frames per second; not a source-to-renderer latency benchmark'})}
}catch{
 $failure=$_.Exception.Message;$trace=$_.ScriptStackTrace
 $diagnostics=@{utc=(Get-Date).ToUniversalTime().ToString('o');elapsedSeconds=if($watch){$watch.Elapsed.TotalSeconds}else{0};sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;fixtureAlive=$false;nativeAlive=$false}
 $diagnostics.inputDesktop=[QiuYaEnduranceDesktop]::Name();$foreground=[QiuYaEnduranceDesktop]::GetForegroundWindow();[uint32]$foregroundPid=0;[void][QiuYaEnduranceDesktop]::GetWindowThreadProcessId($foreground,[ref]$foregroundPid);$diagnostics.foregroundPid=$foregroundPid;$diagnostics.foregroundHandle=$foreground.ToInt64()
 if(Test-Path (Join-Path $Output 'fixture-state.json.heartbeat.json')){try{$diagnostics.fixtureHeartbeat=Get-Content (Join-Path $Output 'fixture-state.json.heartbeat.json') -Raw|ConvertFrom-Json}catch{}}
 foreach($entry in @(@{name='fixture';process=$fixture},@{name='native';process=$native})){
  try{if($entry.process){$entry.process.Refresh();$diagnostics[$entry.name+'Alive']=!$entry.process.HasExited;if(!$entry.process.HasExited){$diagnostics[$entry.name+'Pid']=$entry.process.Id;$diagnostics[$entry.name+'Responding']=$entry.process.Responding;$diagnostics[$entry.name+'WindowTitle']=$entry.process.MainWindowTitle;$diagnostics[$entry.name+'WindowHandle']=$entry.process.MainWindowHandle.ToInt64()}}}catch{}
 }
 $diagnostics|ConvertTo-Json -Depth 4|Set-Content (Join-Path $Output 'failure-diagnostics.json') -Encoding UTF8
 $report=@{passed=$false;error=$failure;trace=$trace;failureDiagnostics=$diagnostics;samples=$results;checks=@()}
}
finally{if($lastImage){[IO.File]::WriteAllBytes((Join-Path $Output 'fixture-observe.jpg'),$lastImage)};if($sha){$sha.Dispose()};foreach($child in $children){try{if(!$child.HasExited){if($child.StartInfo.RedirectStandardInput){$child.StandardInput.Close();[void]$child.WaitForExit(2000)};if(!$child.HasExited){$child.Kill()}}}catch{}};$report|ConvertTo-Json -Depth 12|Set-Content (Join-Path $Output 'report.json') -Encoding UTF8}
