param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Node)
$ErrorActionPreference='Stop';$children=[Collections.Generic.List[Diagnostics.Process]]::new();$utf8=[Text.UTF8Encoding]::new($false)
function Start-Child([string]$file,[string]$arguments,[bool]$pipes=$false){$i=[Diagnostics.ProcessStartInfo]::new($file,$arguments);$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.RedirectStandardInput=$pipes;$i.RedirectStandardOutput=$pipes;$i.RedirectStandardError=$pipes;if($pipes){$i.StandardOutputEncoding=$utf8};$p=[Diagnostics.Process]::Start($i);$children.Add($p);return $p}
try{
 if(![Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw 'Use the regular logged-on Windows test user'}
 $env:QIUYA_COMPUTER_TOKEN_FILE=Join-Path $Root 'token.txt';$env:QIUYA_COMPUTER_NATIVE_EXECUTABLE=Join-Path $Root 'qiuya-windows.exe';$env:QIUYA_COMPUTER_NATIVE_ARGS='["--computer"]';$env:QIUYA_COMPUTER_HOST='127.0.0.1';$env:QIUYA_COMPUTER_EXCHANGE_DIR=Join-Path $Root 'exchange'
 New-Item -ItemType Directory -Force $env:QIUYA_COMPUTER_EXCHANGE_DIR|Out-Null
 $agent=Start-Child $Node ('"'+(Join-Path $Root 'exchange-agent.mjs')+'" "'+$Root+'"') $true
 $line=$agent.StandardOutput.ReadLineAsync();if(!$line.Wait(20000)){throw 'Exchange agent startup deadline'}
 if($line.Result -notmatch '^Computer agent listening: (http://127\.0\.0\.1:\d+/v1/computer)$'){throw 'Exchange agent did not report loopback endpoint'};$endpoint=$Matches[1]
 $config=Get-Content (Join-Path $Root 'relay-config.json') -Raw|ConvertFrom-Json;$config|Add-Member -NotePropertyName endpoint -NotePropertyValue $endpoint
 [IO.File]::WriteAllText((Join-Path $Root 'relay-runtime.json'),($config|ConvertTo-Json -Compress),$utf8)
 $relay=Start-Child $Node ('"'+(Join-Path $Root 'remote-relay.mjs')+'" "'+(Join-Path $Root 'relay-runtime.json')+'"')
 [IO.File]::WriteAllText((Join-Path $Root 'ready.json'),(@{endpoint=$endpoint;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;root=$Root;exchange=$env:QIUYA_COMPUTER_EXCHANGE_DIR;nativeOperations=0}|ConvertTo-Json -Compress),$utf8)
 $rotated=$false
 for($n=0;$n -lt 3000 -and !(Test-Path (Join-Path $Root 'stop'));$n++){if($agent.HasExited){throw 'Exchange agent exited early'};if(!$rotated -and (Test-Path (Join-Path $Root 'rotate-go'))){$rotated=$true;$agent.StandardInput.WriteLine('rotate');$agent.StandardInput.Flush()};Start-Sleep -Milliseconds 100}
}catch{[IO.File]::WriteAllText((Join-Path $Root 'startup-error.txt'),$_.Exception.Message,$utf8)}
finally{if($agent -and !$agent.HasExited){try{$agent.StandardInput.WriteLine('stop');$agent.StandardInput.Close();[void]$agent.WaitForExit(5000)}catch{}};foreach($child in $children){try{if(!$child.HasExited){$child.Kill()}}catch{}}}
