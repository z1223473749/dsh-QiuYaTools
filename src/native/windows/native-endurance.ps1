param([Parameter(Mandatory=$true)][string]$Helper,[Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force $Output | Out-Null
$children=[Collections.Generic.List[Diagnostics.Process]]::new()
$script:requestId=0
$results=[Collections.Generic.List[object]]::new()
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
 $fixture=Start-Native ('--fixture --fixture-output "'+(Join-Path $Output 'fixture-state.json')+'"') $false
 for($i=0;$i -lt 80 -and !(Test-Path (Join-Path $Output 'fixture-state.json'));$i++){Start-Sleep -Milliseconds 100}
 $native=Start-Native '--computer' $true
 $status=Call 'status';$targets=Call 'targets';$target=$targets|Where-Object {$_.pid -eq $fixture.Id -and $_.title -eq 'QiuYaTools Windows Test Fixture'}|Select-Object -First 1
 if(!$target){throw 'Endurance fixture is unavailable'}
 $duration=1800;$watch=[Diagnostics.Stopwatch]::StartNew();$frames=0;$nextSample=0;$firstPrivate=$null;$firstWorking=$null;$maxPrivate=0L;$maxWorking=0L;$maxLatency=0.0;$totalLatency=0.0
 while($watch.Elapsed.TotalSeconds -lt $duration){
  $latency=[Diagnostics.Stopwatch]::StartNew();$frame=Call 'observe' @{targetId=$target.id;preview=$true};$latency.Stop()
  if($frame.elements -ne '' -or $frame.width -le 0 -or $frame.imageBase64.Length -lt 4000){throw 'Invalid preview-only frame'}
  $frames++;$totalLatency+=$latency.Elapsed.TotalMilliseconds;$maxLatency=[Math]::Max($maxLatency,$latency.Elapsed.TotalMilliseconds)
  if($watch.Elapsed.TotalSeconds -ge $nextSample){
   $native.Refresh();$maxPrivate=[Math]::Max($maxPrivate,$native.PrivateMemorySize64);$maxWorking=[Math]::Max($maxWorking,$native.WorkingSet64)
   if($watch.Elapsed.TotalSeconds -ge 60 -and $null -eq $firstPrivate){$firstPrivate=$native.PrivateMemorySize64;$firstWorking=$native.WorkingSet64}
   $sample=@{seconds=[Math]::Round($watch.Elapsed.TotalSeconds,1);frames=$frames;nativePrivateBytes=$native.PrivateMemorySize64;nativeWorkingSetBytes=$native.WorkingSet64;runnerWorkingSetBytes=[Diagnostics.Process]::GetCurrentProcess().WorkingSet64;averageFrameRoundTripMs=$totalLatency/$frames}
   $results.Add($sample);$sample|ConvertTo-Json -Compress|Set-Content (Join-Path $Output 'progress.json') -Encoding UTF8;$nextSample+=60
  }
  Start-Sleep -Milliseconds 50
 }
 $growth=if($null -ne $firstPrivate){$maxPrivate-$firstPrivate}else{0}
 $passed=$frames -ge 1000 -and $growth -le 134217728
 $report=@{passed=$passed;durationSeconds=$watch.Elapsed.TotalSeconds;frames=$frames;framesPerSecond=$frames/$watch.Elapsed.TotalSeconds;averageRoundTripMs=$totalLatency/$frames;maxRoundTripMs=$maxLatency;nativePrivateGrowthFromWarmupBytes=$growth;peakNativePrivateBytes=$maxPrivate;peakNativeWorkingSetBytes=$maxWorking;architecture=$status.architecture;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;frameImagesPersisted=0;samples=$results;checks=@(@{id='WIN-CAPTURE-ENDURANCE-30MIN';passed=$passed;detail='Native preview-only capture via PowerShell transport; not a video encoder/rendering benchmark'})}
}catch{$report=@{passed=$false;error=$_.Exception.Message;trace=$_.ScriptStackTrace;samples=$results;checks=@()}}
finally{foreach($child in $children){try{if(!$child.HasExited){if($child.StartInfo.RedirectStandardInput){$child.StandardInput.Close();[void]$child.WaitForExit(2000)};if(!$child.HasExited){$child.Kill()}}}catch{}};$report|ConvertTo-Json -Depth 12|Set-Content (Join-Path $Output 'report.json') -Encoding UTF8}
