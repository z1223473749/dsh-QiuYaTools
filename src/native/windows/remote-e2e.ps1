param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
$children=[Collections.Generic.List[Diagnostics.Process]]::new()
$utf8=[Text.UTF8Encoding]::new($false)
function Start-Child([string]$exe,[string]$arguments,[bool]$capture=$false){
 $info=[Diagnostics.ProcessStartInfo]::new($exe,$arguments);$info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.RedirectStandardInput=$capture;$info.RedirectStandardOutput=$capture;$info.RedirectStandardError=$capture
 if($capture){$info.StandardOutputEncoding=$utf8}
 $process=[Diagnostics.Process]::Start($info);$children.Add($process);return $process
}
try{
 if(![Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw 'Remote agent requires the logged-on desktop'}
 $helper=Join-Path $Root 'qiuya-windows.exe'
 $fixture=Start-Child $helper ('--fixture --fixture-output "'+(Join-Path $Root 'fixture-state.json')+'"')
 $node=Join-Path $Root 'node-v22.23.3-win-arm64\node.exe'
 $env:QIUYA_COMPUTER_TOKEN_FILE=Join-Path $Root 'token.txt'
 $env:QIUYA_COMPUTER_NATIVE_EXECUTABLE=$helper
 $env:QIUYA_COMPUTER_NATIVE_ARGS='["--computer"]'
 $env:QIUYA_COMPUTER_HOST='127.0.0.1'
 $env:QIUYA_TOOLS_NATIVE_DATA_DIR=Join-Path $Root 'native-data'
 $agent=Start-Child $node ('"'+(Join-Path $Root 'scripts\computer-agent.mjs')+'"') $true
 $read=$agent.StandardOutput.ReadLineAsync();if(!$read.Wait(20000)){throw 'Remote agent startup timed out'}
 $line=$read.Result
 if($line -notmatch '^Computer agent listening: (http://127\.0\.0\.1:\d+/v1/computer)$'){throw 'Remote agent failed to report its loopback endpoint'}
 $endpoint=$Matches[1]
 $config=Get-Content (Join-Path $Root 'relay-config.json') -Raw|ConvertFrom-Json
 $config|Add-Member -NotePropertyName endpoint -NotePropertyValue $endpoint
 [IO.File]::WriteAllText((Join-Path $Root 'relay-runtime.json'),($config|ConvertTo-Json -Compress),$utf8)
 $relay=Start-Child $node ('"'+(Join-Path $Root 'remote-relay.mjs')+'" "'+(Join-Path $Root 'relay-runtime.json')+'"')
 $ready=@{endpoint=$endpoint;fixturePid=$fixture.Id;agentPid=$agent.Id;relayPid=$relay.Id;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;node=$node;root=$Root}
 [IO.File]::WriteAllText((Join-Path $Root 'ready.json'),($ready|ConvertTo-Json -Compress),$utf8)
 for($i=0;$i -lt 6000 -and !(Test-Path (Join-Path $Root 'stop'));$i++){
   if($agent.HasExited){throw 'Paired agent unexpectedly exited'}
   Start-Sleep -Milliseconds 100
 }
}catch{[IO.File]::WriteAllText((Join-Path $Root 'startup-error.txt'),$_.Exception.Message,$utf8)}
finally{foreach($child in $children){try{if(!$child.HasExited){if($child.StartInfo.RedirectStandardInput){$child.StandardInput.Close()};$child.Kill()}}catch{}}}
