param([Parameter(Mandatory=$true)][string]$Helper,[Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force $Output|Out-Null
$children=[Collections.Generic.List[Diagnostics.Process]]::new();$checks=[Collections.Generic.List[object]]::new();$requestId=0
function Start-Native([string]$arguments,[bool]$pipes){$info=[Diagnostics.ProcessStartInfo]::new($Helper,$arguments);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$pipes;$info.RedirectStandardOutput=$pipes;$info.RedirectStandardError=$pipes;if($pipes){$info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)};$p=[Diagnostics.Process]::Start($info);$children.Add($p);return $p}
function Assert([bool]$value,[string]$id){if(!$value){throw $id};$checks.Add(@{id=$id;passed=$true})}
function Call([string]$op,[hashtable]$body=@{}){$script:requestId++;$body.op=$op;$body.requestId=$script:requestId;$native.StandardInput.WriteLine(($body|ConvertTo-Json -Depth 8 -Compress));$native.StandardInput.Flush();while($true){$task=$native.StandardOutput.ReadLineAsync();if(!$task.Wait(15000)){throw 'Native RPC deadline'};$response=$task.Result|ConvertFrom-Json;if($response.event){continue};if($response.requestId -ne $script:requestId -or !$response.ok){throw ('Capture failed '+$response.error.code)};return $response.result}}
try{
 Assert ([Environment]::UserInteractive -and [Diagnostics.Process]::GetCurrentProcess().SessionId -gt 0) 'WIN-CAPTURE-INTERACTIVE'
 $test=Start-Native '--self-test-capture' $true;$line=$test.StandardOutput.ReadLineAsync();if(!$line.Wait(30000)){throw 'Capture fault-injection deadline'};$faults=$line.Result|ConvertFrom-Json;if(!$test.WaitForExit(3000)){throw 'Capture test did not exit'}
 Assert ($test.ExitCode -eq 0 -and $faults.passed -and $faults.checks -eq 16 -and $faults.poolScheduling.passed -eq $true -and $faults.poolDeadline.passed -eq $true) 'WIN-CAPTURE-FAULT-INJECTION-16'
 $faults|ConvertTo-Json -Depth 8|Set-Content (Join-Path $Output 'capture-faults.json') -Encoding UTF8
 $fixture=Start-Native ('--fixture --fixture-animate --fixture-output "'+(Join-Path $Output 'fixture-state.json')+'"') $false
 for($i=0;$i -lt 80 -and !(Test-Path (Join-Path $Output 'fixture-state.json'));$i++){Start-Sleep -Milliseconds 100}
 $native=Start-Native '--computer' $true;$status=Call 'status';$target=Call 'targets'|Where-Object {$_.pid -eq $fixture.Id}|Select-Object -First 1
 Assert ($null -ne $target) 'WIN-CAPTURE-TARGET'
 $hashes=[Collections.Generic.HashSet[string]]::new();$sha=[Security.Cryptography.SHA256]::Create();$workerPid=$null
 for($i=0;$i -lt 20;$i++){$frame=Call 'observe' @{targetId=$target.id;preview=$true};$image=[Convert]::FromBase64String($frame.imageBase64);if($image[0] -ne 255 -or $image[1] -ne 216 -or $frame.elements -ne ''){throw 'Invalid worker frame'};[void]$hashes.Add([Convert]::ToBase64String($sha.ComputeHash($image)));if($i -eq 0){$workers=@(Get-CimInstance Win32_Process|Where-Object {$_.ParentProcessId -eq $native.Id -and $_.CommandLine -like '*--capture-worker*'});Assert ($workers.Count -eq 1) 'WIN-CAPTURE-SINGLE-WORKER';$workerPid=$workers[0].ProcessId};Start-Sleep -Milliseconds 40}
 $workers=@(Get-CimInstance Win32_Process|Where-Object {$_.ParentProcessId -eq $native.Id -and $_.CommandLine -like '*--capture-worker*'})
 Assert ($workers.Count -eq 1 -and $workers[0].ProcessId -eq $workerPid) 'WIN-CAPTURE-STEADY-WORKER-REUSED'
 Assert ($hashes.Count -ge 15) 'WIN-CAPTURE-ACTUAL-ANIMATION'
 [IO.File]::WriteAllBytes((Join-Path $Output 'fixture-observe.jpg'),$image);$sha.Dispose()
 $native.StandardInput.Close();Assert ($native.WaitForExit(3000)) 'WIN-CAPTURE-PARENT-GRACEFUL-EXIT';Start-Sleep -Milliseconds 300
 Assert ($null -eq (Get-Process -Id $workerPid -ErrorAction SilentlyContinue)) 'WIN-CAPTURE-WORKER-EXIT-ON-DISPOSE'
 $report=@{passed=$true;checks=$checks;faultInjection=$faults;actualDesktopCapture=$true;actualOsInput=$false;architecture=$status.architecture;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;uniqueFrames=$hashes.Count;frames=20}
}catch{$report=@{passed=$false;checks=$checks;error=$_.Exception.Message;trace=$_.ScriptStackTrace}}
finally{foreach($child in $children){try{if(!$child.HasExited){if($child.StartInfo.RedirectStandardInput){$child.StandardInput.Close();[void]$child.WaitForExit(1000)};if(!$child.HasExited){$child.Kill()}}}catch{}};$report|ConvertTo-Json -Depth 12|Set-Content (Join-Path $Output 'report.json') -Encoding UTF8}
