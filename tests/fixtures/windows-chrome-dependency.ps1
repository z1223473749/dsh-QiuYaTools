param([Parameter(Mandatory=$true)][string]$OwnRoot,[Parameter(Mandatory=$true)][string]$Msi,[Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256,[Parameter(Mandatory=$true)][ValidatePattern('^S-1-5-21-[0-9-]+$')][string]$InteractiveSid)
$ErrorActionPreference='Stop'
$OwnRoot=[IO.Path]::GetFullPath($OwnRoot);$Msi=[IO.Path]::GetFullPath($Msi)
if($OwnRoot-notmatch '^C:\\Users\\[^\\]+\\AppData\\Local\\Temp\\QiuYaTools-chrome-dependency-[a-f0-9-]{36}$'-or $Msi-cne (Join-Path $OwnRoot 'Chrome.msi')){throw 'Own MSI scope invalid'}
foreach($path in @($OwnRoot,$Msi,$PSCommandPath)){if((Get-Item -LiteralPath $path -Force).Attributes-band [IO.FileAttributes]::ReparsePoint){throw 'Owned input must not be a reparse point'}}
if([IO.Path]::GetFullPath($PSCommandPath)-cne (Join-Path $OwnRoot 'install.ps1')){throw 'Installer script path changed'}
$output=Join-Path $OwnRoot 'evidence';if(Test-Path -LiteralPath $output){throw 'Evidence must be fresh'};[void][IO.Directory]::CreateDirectory($output)
$errors=[Collections.Generic.List[string]]::new();$installer=$null;$installed=$false;$installClock=$null;$installDeadlineMs=240000
$report=[ordered]@{passed=$false;kind='windows-official-chrome-dependency-install';architecture='ARM64';source=$null;preflight=$null;defaults=$null;installer=$null;postflight=$null;googleUpdate=$null;cleanup=@{processSignalsSent=$false;taskStopsSent=$false};errors=@()}
function Hash-Text([string]$Text){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function Google-Signature([string]$Path){
 $s=Get-AuthenticodeSignature -LiteralPath $Path
 if($s.Status-ne 'Valid'-or !$s.SignerCertificate){throw 'Valid Authenticode signature required'}
 $name=$s.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)
 if($name-cne 'Google LLC'){throw 'Expected Google LLC signer'}
 return @{status=$s.Status.ToString();publisher=$name;thumbprint=$s.SignerCertificate.Thumbprint}
}
function Read-Defaults{
 $base=[Microsoft.Win32.Registry]::Users.OpenSubKey($InteractiveSid,$false);if(!$base){throw 'Interactive registry hive is not loaded'};$base.Dispose()
 $paths=[ordered]@{http='Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice';https='Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice';'.htm'='Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.htm\UserChoice';'.html'='Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.html\UserChoice'}
 $rows=@();foreach($name in $paths.Keys){$key=$null;try{
  $key=[Microsoft.Win32.Registry]::Users.OpenSubKey(($InteractiveSid+'\'+$paths[$name]),$false)
  if(!$key){$rows+=[ordered]@{association=$name;exists=$false;progId=$null;hashSha256=$null};continue}
  $prog=$key.GetValue('ProgId',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$hash=$key.GetValue('Hash',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if($prog-isnot [string]-or [string]::IsNullOrWhiteSpace($prog)-or $hash-isnot [string]){throw 'Existing UserChoice is incomplete'}
  $rows+=[ordered]@{association=$name;exists=$true;progId=$prog;hashSha256=(Hash-Text $hash)}
 }finally{if($key){$key.Dispose()}}};return ,$rows
}
function Read-GoogleUpdate{
 $services=@(Get-CimInstance Win32_Service|Where-Object{$_.Name-match '^Google'-or $_.DisplayName-match '^Google'}|Sort-Object Name|ForEach-Object{@{name=$_.Name;displayName=$_.DisplayName;state=$_.State;startMode=$_.StartMode;pathSha256=(Hash-Text $_.PathName)}})
 $tasks=@(Get-ScheduledTask|Where-Object{$_.TaskName-match '^Google'-or $_.TaskPath-match '^\\Google'}|Sort-Object TaskPath,TaskName|ForEach-Object{@{name=$_.TaskName;path=$_.TaskPath;state=$_.State.ToString();actionSha256=(Hash-Text ($_.Actions|ConvertTo-Json -Depth 8 -Compress))}})
 return @{services=$services;tasks=$tasks}
}
function Read-ChromeRegistrations{
 $found=@()
 foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)){
  $base=$null;try{$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,$view)
   foreach($keyName in @('Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe','Software\Microsoft\Windows\CurrentVersion\Uninstall')){
    $key=$null;try{$key=$base.OpenSubKey($keyName,$false);if(!$key){continue}
     if($keyName.EndsWith('chrome.exe')){$found+=@{scope='machine';view=$view.ToString();kind='app-path'};continue}
     $names=@($key.GetSubKeyNames());if($names.Count-gt 4096){throw 'Installed program registry exceeds bound'}
     foreach($childName in $names){$child=$null;try{$child=$key.OpenSubKey($childName,$false);if($child-and [string]$child.GetValue('DisplayName')-match '^Google Chrome(?:\s|$)'){$found+=@{scope='machine';view=$view.ToString();kind='uninstall'}}}finally{if($child){$child.Dispose()}}}
    }finally{if($key){$key.Dispose()}}
   }
  }finally{if($base){$base.Dispose()}}
 }
 $base=$null;try{$base=[Microsoft.Win32.Registry]::Users.OpenSubKey($InteractiveSid,$false);if(!$base){throw 'Interactive registry hive unavailable'}
  foreach($keyName in @('Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe','Software\Microsoft\Windows\CurrentVersion\Uninstall')){
   $key=$null;try{$key=$base.OpenSubKey($keyName,$false);if(!$key){continue};if($keyName.EndsWith('chrome.exe')){$found+=@{scope='interactive-user';kind='app-path'};continue}
    $names=@($key.GetSubKeyNames());if($names.Count-gt 4096){throw 'User installed program registry exceeds bound'}
    foreach($childName in $names){$child=$null;try{$child=$key.OpenSubKey($childName,$false);if($child-and [string]$child.GetValue('DisplayName')-match '^Google Chrome(?:\s|$)'){$found+=@{scope='interactive-user';kind='uninstall'}}}finally{if($child){$child.Dispose()}}}
   }finally{if($key){$key.Dispose()}}
  }
 }finally{if($base){$base.Dispose()}};return $found
}
function Read-PeMachine([string]$Path){$stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$r=[IO.BinaryReader]::new($stream);try{
 if($r.ReadUInt16()-ne 0x5a4d){throw 'Executable MZ header invalid'};[void]$stream.Seek(0x3c,[IO.SeekOrigin]::Begin);$offset=$r.ReadUInt32();if($offset-lt 64-or $offset-gt 1048576-or $offset+6-gt $stream.Length){throw 'Executable PE offset invalid'};[void]$stream.Seek($offset,[IO.SeekOrigin]::Begin);if($r.ReadUInt32()-ne 0x4550){throw 'Executable PE signature invalid'};return $r.ReadUInt16()
}finally{$r.Dispose();$stream.Dispose()}}
$before=$null;$updatesBefore=$null
try{
 $arch=(Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
 if($arch-cne 'ARM64'){throw 'This immutable package only targets Windows ARM64'}
 $owners=@(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|ForEach-Object{([Security.Principal.NTAccount]::new($_.UserName)).Translate([Security.Principal.SecurityIdentifier]).Value}|Sort-Object -Unique)
 if($owners.Count-ne 1-or $owners[0]-cne $InteractiveSid){throw 'Interactive SID changed or ambiguous'}
 $profile=(Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$InteractiveSid) -Name ProfileImagePath).ProfileImagePath
 if($OwnRoot-notlike ($profile+'\AppData\Local\Temp\QiuYaTools-chrome-dependency-*')){throw 'Own scope does not belong to bound interactive user'}
 $paths=@(@($env:PROGRAMFILES,$env:ProgramW6432,${env:PROGRAMFILES(X86)})|Where-Object{$_}|ForEach-Object{Join-Path $_ 'Google\Chrome\Application\chrome.exe'});$paths+=Join-Path $profile 'AppData\Local\Google\Chrome\Application\chrome.exe';$paths=@($paths|Sort-Object -Unique)
 $existing=@($paths|Where-Object{Test-Path -LiteralPath $_});$registered=@(Read-ChromeRegistrations)
 if($existing.Count-or $registered.Count){throw 'Chrome already exists; this carrier must not replace an existing install'}
 $expectedExe=Join-Path $env:PROGRAMFILES 'Google\Chrome\Application\chrome.exe';$newApplicationDirectory=Split-Path $expectedExe
 if(Test-Path -LiteralPath $newApplicationDirectory){throw 'Chrome application directory predates this installation'}
 $before=Read-Defaults;$updatesBefore=Read-GoogleUpdate
 $report.preflight=@{windowsARM64=$true;interactiveUserVerified=$true;interactiveSid=$InteractiveSid;chromeAbsent=$true;checkedCandidatePaths=$paths;registryScanCompleted=$true;existingChromePaths=$existing;registeredChrome=$registered;newApplicationDirectoryAbsent=$true}
 $signature=Google-Signature $Msi;$hash=(Get-FileHash -LiteralPath $Msi -Algorithm SHA256).Hash.ToLowerInvariant()
 if($hash-cne $ExpectedSha256){throw 'Official MSI SHA mismatch'}
 $report.source=@{sha256=$hash;bytes=(Get-Item -LiteralPath $Msi).Length;signatureStatus=$signature.status;publisher=$signature.publisher;certificateThumbprint=$signature.thumbprint}
 # Repeat the hash immediately before launch; never replace Windows defaults or
 # launch Chrome against an existing user profile. Installation may add updater
 # services/tasks, which are observed and retained rather than broadly removed.
 if((Get-FileHash -LiteralPath $Msi -Algorithm SHA256).Hash.ToLowerInvariant()-cne $ExpectedSha256){throw 'MSI changed before execution'}
 $psi=[Diagnostics.ProcessStartInfo]::new((Join-Path $env:WINDIR 'System32\msiexec.exe'));$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.Arguments='/i "'+$Msi+'" /qn /norestart /L*v "'+(Join-Path $output 'install.log')+'"'
 $self=[Diagnostics.Process]::GetCurrentProcess()
 try{$runnerIdentity=@{pid=$self.Id;createdAtTicks=$self.StartTime.ToUniversalTime().Ticks.ToString();executable=$self.MainModule.FileName;sessionId=[int]$self.SessionId}}finally{$self.Dispose()}
 $report.installer=@{started=$false;naturalExit=$false;exitCode=$null;identity=$null;identityReadError=$null;identityPathMatched=$false;identitySessionMatched=$false;expectedExecutable=(Join-Path $env:WINDIR 'System32\msiexec.exe');expectedSessionId=$runnerIdentity.sessionId;runnerIdentity=$runnerIdentity;identityReceiptWritten=$false}
 $installClock=[Diagnostics.Stopwatch]::StartNew()
 $installer=[Diagnostics.Process]::Start($psi);$report.installer.started=$true;$report.installer.spawnedPid=$installer.Id
 try{
  $null=$installer.SafeHandle
  $report.installer.identity=@{pid=$installer.Id;createdAtTicks=$installer.StartTime.ToUniversalTime().Ticks.ToString();executable=$installer.MainModule.FileName;sessionId=[int]$installer.SessionId}
  $report.installer.identityPathMatched=[string]::Equals($report.installer.identity.executable,$report.installer.expectedExecutable,[StringComparison]::OrdinalIgnoreCase)
  $report.installer.identitySessionMatched=($report.installer.identity.sessionId-eq $report.installer.expectedSessionId)
 }catch{$report.installer.identityReadError=$_.Exception.Message;throw}
 finally{
  # Persist the original child identity BEFORE asserting its path/session.
  # An assertion failure must not erase proof that this MSI was already started.
  $report.installer.identityReceiptWritten=$true
  try{$report.installer|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $output 'installer-start-receipt.json') -Encoding UTF8}catch{$report.installer.identityReceiptWritten=$false;throw}
 }
 if(!$report.installer.identityPathMatched-or !$report.installer.identitySessionMatched){throw 'Owned MSI process path/session mismatch'}
 $remaining=[Math]::Max(0,$installDeadlineMs-[int]$installClock.ElapsedMilliseconds)
 if(!$installer.WaitForExit($remaining)){throw 'Owned MSI did not naturally finish within the install deadline'}
 $report.installer.naturalExit=$true;$report.installer.exitCode=$installer.ExitCode
 if($installer.ExitCode-ne 0){throw ('MSI installation did not complete: '+$installer.ExitCode)};$installed=$true
 if(!(Test-Path -LiteralPath $expectedExe -PathType Leaf)){throw 'Fresh Chrome executable missing'}
 if((Get-Item -LiteralPath $expectedExe).Attributes-band [IO.FileAttributes]::ReparsePoint){throw 'Fresh Chrome executable is a reparse point'}
 $exeSignature=Google-Signature $expectedExe;$machine=Read-PeMachine $expectedExe
 if($machine-ne 0xaa64){throw 'Fresh Chrome executable is not native ARM64'}
 $version=[Diagnostics.FileVersionInfo]::GetVersionInfo($expectedExe).FileVersion;if([string]::IsNullOrWhiteSpace($version)){throw 'Fresh Chrome version missing'}
 $report.postflight=@{newChrome=$true;exe=@{path=$expectedExe;sha256=(Get-FileHash -LiteralPath $expectedExe -Algorithm SHA256).Hash.ToLowerInvariant();machine=[int]$machine;version=$version;signatureStatus=$exeSignature.status;publisher=$exeSignature.publisher;certificateThumbprint=$exeSignature.thumbprint}}
}catch{$errors.Add($_.Exception.Message)}
finally{
 if($before){try{$after=Read-Defaults;$same=(($before|ConvertTo-Json -Depth 5 -Compress)-ceq ($after|ConvertTo-Json -Depth 5 -Compress));$report.defaults=@{before=$before;after=$after;unchanged=[bool]$same};if(!$same){$errors.Add('Actual interactive-user default browser associations changed')}}catch{$errors.Add('Default association postflight failed: '+$_.Exception.Message)}}
 if($updatesBefore){try{$report.googleUpdate=@{readSucceeded=$true;before=$updatesBefore;after=(Read-GoogleUpdate);mutationsPerformed=$false}}catch{$errors.Add('Google updater observation failed: '+$_.Exception.Message)}}
 if($installer){try{
  # Always wait on the SAME spawned Process/SafeHandle, including when the first
  # identity assertion failed. Never re-open by PID, retry installation or kill.
  $remaining=if($installClock){[Math]::Max(0,$installDeadlineMs-[int]$installClock.ElapsedMilliseconds)}else{0}
  if(!$installer.HasExited-and $remaining-gt 0){[void]$installer.WaitForExit($remaining)}
  $report.cleanup.installerHasExited=[bool]$installer.HasExited
  if($installer.HasExited){$report.installer.naturalExit=$true;$report.installer.exitCode=$installer.ExitCode}else{$errors.Add('Owned installer did not retire within its original bounded deadline')}
 }catch{$report.cleanup.installerHasExited=$false;$errors.Add('Owned installer exit audit failed: '+$_.Exception.Message)}finally{$installer.Dispose()}}
 $report.errors=$errors.ToArray();$report.passed=[bool]($installed-and $report.postflight.newChrome-and $report.defaults.unchanged-and $report.googleUpdate.readSucceeded-and $report.cleanup.installerHasExited-and $errors.Count-eq 0)
 $report|ConvertTo-Json -Depth 16|Set-Content -LiteralPath (Join-Path $output 'report.json') -Encoding UTF8
}
if(!$report.passed){exit 1}
