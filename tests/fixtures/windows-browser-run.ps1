param([Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$Output,[ValidateSet('all','chrome','edge')][string]$Browser='all')
$ErrorActionPreference='Stop'
if((Get-FileHash -LiteralPath $Node -Algorithm SHA256).Hash.ToLowerInvariant()-cne 'b5a3165ec6f24c0b1fe2a10fed58e03f6c1d7d141beb3b225ff030ceac6c5eb5'){throw 'Cached official Node22 ARM64 SHA mismatch'}
if(Test-Path -LiteralPath $Output){throw 'Evidence output must be fresh'}
[void][IO.Directory]::CreateDirectory($Output)
$profiles=Join-Path (Split-Path $Output) 'profiles';[void][IO.Directory]::CreateDirectory($profiles)
$me=[Diagnostics.Process]::GetCurrentProcess();$null=$me.SafeHandle;$runner=@{pid=$me.Id;createdAtTicks=$me.StartTime.ToUniversalTime().Ticks.ToString();executable=$me.MainModule.FileName;sessionId=$me.SessionId;script=$PSCommandPath};$me.Dispose()
$selected=if($Browser-ceq 'all'){@('chrome','edge')}else{@($Browser)}
$rows=[Collections.Generic.List[object]]::new();$owned=[Collections.Generic.List[Diagnostics.Process]]::new();$errorText=$null
try{
 foreach($name in $selected){
  $row=@{browser=$name;status='not-run';passed=$false;checks=0;actualBrowser=$false;reason=$null;identity=$null;nodeExitCode=$null;naturalNodeExit=$false}
  $browserOutput=Join-Path $Output $name
  try{
   $suffix=if($name-ceq 'chrome'){'Google\Chrome\Application\chrome.exe'}else{'Microsoft\Edge\Application\msedge.exe'}
   $exe=@(@($env:PROGRAMFILES,${env:PROGRAMFILES(X86)},$env:LOCALAPPDATA)|Where-Object{$_}|ForEach-Object{Join-Path $_ $suffix}|Where-Object{Test-Path -LiteralPath $_ -PathType Leaf}|Select-Object -First 1)
   if($exe.Count-ne 1){$row.reason='Required installed browser missing: '+$name;continue}
   $row.browserExecutable=$exe[0];$row.browserVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe[0]).FileVersion
   $info=[Diagnostics.ProcessStartInfo]::new($Node)
   $info.Arguments='"'+(Join-Path $PSScriptRoot 'guest.mjs')+'" --browser '+$name+' --executable "'+$exe[0]+'" --output "'+$browserOutput+'"'
   $info.WorkingDirectory=$PSScriptRoot;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
   $info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
   $info.EnvironmentVariables['TEMP']=$profiles;$info.EnvironmentVariables['TMP']=$profiles
   $p=[Diagnostics.Process]::Start($info);$owned.Add($p);$null=$p.SafeHandle
   $row.status='failed';$row.actualBrowser=$true
   $row.identity=@{pid=$p.Id;createdAtTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=$p.MainModule.FileName;sessionId=$p.SessionId}
   if($row.identity.executable-ine $Node-or $row.identity.sessionId-ne $runner.sessionId){throw 'Owned Node path/session mismatch'}
   $stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync()
   if(!$p.WaitForExit(180000)){throw ('Headless test fixed deadline: '+$name)}
   $row.nodeExitCode=$p.ExitCode;$row.naturalNodeExit=$p.HasExited
   if(!$stdout.Wait(3000)-or !$stderr.Wait(3000)){throw 'Node report pipes did not complete'}
   [IO.File]::WriteAllText((Join-Path $Output ($name+'.stdout.txt')),$stdout.Result,[Text.UTF8Encoding]::new($false))
   [IO.File]::WriteAllText((Join-Path $Output ($name+'.stderr.txt')),$stderr.Result,[Text.UTF8Encoding]::new($false))
   $summary=Get-Content -LiteralPath (Join-Path $browserOutput 'summary.json') -Raw -Encoding UTF8|ConvertFrom-Json
   $closure=Get-Content -LiteralPath (Join-Path $browserOutput 'natural-closure.json') -Raw -Encoding UTF8|ConvertFrom-Json
   $row.checks=@($summary.checks).Count
   $row.passed=[bool]($p.ExitCode-eq 0-and $summary.status-ceq 'passed'-and $row.checks-eq 10-and $closure.passed-eq $true-and $closure.browser-ceq $name-and $closure.postflight.passed-eq $true)
   $row.status=if($row.passed){'passed'}else{'failed'}
   if(!$row.passed){$row.reason='Browser behavior or natural cleanup failed: '+$name}
  }catch{$row.reason=$_.Exception.Message}
  finally{
   [void][IO.Directory]::CreateDirectory($browserOutput)
   $row|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $browserOutput 'launch-report.json') -Encoding UTF8
   $rows.Add($row)
  }
 }
}catch{$errorText=$_.Exception.Message}
finally{
 # No process signals or task stop: a deadline failure must remain a failure.
 # These Process objects hold the original SafeHandle throughout the run.
 $left=@($owned|Where-Object{try{!$_.HasExited}catch{$true}}|ForEach-Object{$_.Id})
 $passed=($rows.Count-eq $selected.Count-and @($rows|Where-Object{$_.status-cne 'passed'-or !$_.passed}).Count-eq 0-and $left.Count-eq 0-and !$errorText)
 @{passed=[bool]$passed;selectedBrowsers=@($selected);kind='installed-Windows-private-headless-CDP-and-registered-tools';actualBrowser=[bool](@($rows|Where-Object{$_.actualBrowser}).Count-gt 0);actualOsDesktopInput=$false;realModelInference=$false;runner=$runner;checks=$rows.ToArray();cleanup=@{forcedNodeTermination=$false;processSignalSent=$false;remainingNodeProcesses=$left};error=$errorText}|ConvertTo-Json -Depth 12|Set-Content -LiteralPath (Join-Path $Output 'report.json') -Encoding UTF8
 foreach($p in $owned){$p.Dispose()}
}
if(!$passed){exit 1}
