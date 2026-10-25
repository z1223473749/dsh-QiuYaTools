# Test-only normal window close. No foreground change, injected input or process signal.
param([Parameter(Mandatory=$true)][string]$BindingBase64)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($BindingBase64.Length -gt 16384 -or $BindingBase64 -cnotmatch '^[A-Za-z0-9+/=]+$'){throw 'Invalid own close binding'}
$b=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BindingBase64))|ConvertFrom-Json
if($b.version -ne 1 -or $b.operation -cne 'normal-close-owned-session-windows' -or $b.budgetMs -ne 5000 -or $b.architecture -cnotmatch '^(arm64|x64)$' -or $b.nativeSHA256 -cnotmatch '^[a-f0-9]{64}$' -or $b.hostSHA256 -cnotmatch '^[a-f0-9]{64}$' -or $b.profileRoot -notmatch '\\qiuya-harness-e2e-[A-Za-z0-9]{6}\\qiuya-harness-home$' -or [IO.Path]::GetFullPath($b.profileRoot) -cne $b.profileRoot -or $b.windows.Count -lt 1 -or $b.windows.Count -gt 2){throw 'Invalid exact own close scope'}
$expected=Join-Path $b.profileRoot ('profiles\web\node_modules\dsh-qiuya-tools\lib\native\win32-'+$b.architecture+'\qiuya-windows.exe')
if($b.nativeExecutable -ine $expected -or $b.helperPID -le 0 -or $b.hostPID -le 0 -or $b.helperPID -eq $b.hostPID){throw 'Invalid exact own native image'}
$ancestor=Get-Item -LiteralPath $b.profileRoot -Force
while($ancestor){if(($ancestor.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Own profile must have no reparse ancestors'};$ancestor=$ancestor.Parent}
$helper=Get-Process -Id $b.helperPID;$owner=Get-Process -Id $b.hostPID
$helperHandle=$helper.Handle;$ownerHandle=$owner.Handle
if($helper.HasExited -or $owner.HasExited -or $helper.Path -ine $expected -or $owner.Path -ine $b.hostExecutable -or [string]$helper.StartTime.ToUniversalTime().Ticks -cne [string]$b.helperBirthTicks -or $helper.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or $owner.SessionId -ne $helper.SessionId){throw 'Own original Host/helper process identity changed'}
if((Get-FileHash -LiteralPath $helper.Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $b.nativeSHA256 -or (Get-FileHash -LiteralPath $owner.Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $b.hostSHA256){throw 'Own original process image changed'}
$table=@(Get-CimInstance Win32_Process)
$helperRow=@($table|Where-Object ProcessId -eq $b.helperPID)
if($helperRow.Count -ne 1 -or $helperRow[0].ParentProcessId -ne $b.hostPID){throw 'Own native helper parent changed'}
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class QytNormalSessionClose {
 [DllImport("user32.dll")]static extern bool IsWindow(IntPtr hwnd);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int capacity);
 [DllImport("user32.dll",SetLastError=true)]static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr wparam,IntPtr lparam);
 public static bool OriginalWindow(long raw,int expectedPID,string title){var h=new IntPtr(raw);if(!IsWindow(h))return false;uint pid;GetWindowThreadProcessId(h,out pid);var text=new StringBuilder(1024);GetWindowText(h,text,1024);if(pid!=expectedPID||text.ToString()!=title)throw new InvalidOperationException("Own original HWND identity changed");return true;}
 public static void Close(long raw,int expectedPID,string title){if(!OriginalWindow(raw,expectedPID,title))throw new InvalidOperationException("Own original window disappeared before normal close");if(!PostMessage(new IntPtr(raw),0x0010,IntPtr.Zero,IntPtr.Zero))throw new InvalidOperationException("Normal WM_CLOSE was not accepted");}
}
'@
$windows=@();$seen=@{};$sessions=@{}
foreach($w in $b.windows){
 $m=[regex]::Match($w.targetId,'^window:([a-fA-F0-9]+):(\d+):(\d+)$')
 if(-not $m.Success -or [int]$m.Groups[2].Value -ne $b.helperPID -or $m.Groups[3].Value -cne $b.helperBirthTicks -or $w.sessionId -cnotmatch '^session-[A-Za-z0-9-]+$' -or $w.title -cnotmatch '^E2E:(Alpha|Beta)-[A-Za-z0-9]+ \u2014 QiuYaTools$' -or $seen.ContainsKey($w.targetId) -or $sessions.ContainsKey($w.sessionId)){throw 'Own exact session/window tuple changed'}
 $handle=[Convert]::ToInt64($m.Groups[1].Value,16);if(-not [QytNormalSessionClose]::OriginalWindow($handle,$b.helperPID,$w.title)){throw 'Own window must exist before normal close'}
 $seen[$w.targetId]=$true;$sessions[$w.sessionId]=$true;$windows+=@{Binding=$w;Handle=$handle}
}
function Descendants($rows,[int]$root){$ids=@{};$ids[[string]$root]=$true;$changed=$true;while($changed){$changed=$false;foreach($row in $rows){if($ids.ContainsKey([string]$row.ParentProcessId)-and -not $ids.ContainsKey([string]$row.ProcessId)){$ids[[string]$row.ProcessId]=$true;$changed=$true}}};return @($rows|Where-Object {$_.ProcessId -ne $root -and $ids.ContainsKey([string]$_.ProcessId)})}
$pins=@();$consoles=@()
try{
 foreach($row in @(Descendants $table $b.helperPID)){
  if($row.Name -ieq 'conhost.exe'){
   $console=Get-Process -Id $row.ProcessId;[void]$console.Handle
   $consolePath=Join-Path ([Environment]::SystemDirectory) 'conhost.exe'
   if($row.ParentProcessId -ne $b.helperPID -or $console.HasExited -or $console.Path -ine $consolePath -or $console.SessionId -ne $helper.SessionId){throw 'Own console infrastructure identity changed'}
   $signature=Get-AuthenticodeSignature -LiteralPath $console.Path
   if([string]$signature.Status -cne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '^CN=Microsoft Windows, O=Microsoft Corporation,'){throw 'Own console infrastructure signature is not trusted Microsoft Windows'}
   $consoles+=,@{Process=$console;PID=$console.Id;BirthTicks=[string]$console.StartTime.ToUniversalTime().Ticks;ParentPID=$row.ParentProcessId;SHA256=(Get-FileHash -LiteralPath $console.Path -Algorithm SHA256).Hash.ToLowerInvariant();SignatureStatus=[string]$signature.Status};continue
  }
  if($row.Name -ine 'msedgewebview2.exe'){throw 'Unexpected own native browser descendant'}
  $p=Get-Process -Id $row.ProcessId
  if($p.HasExited -or $p.SessionId -ne $helper.SessionId -or $p.ProcessName -ine 'msedgewebview2'){throw 'Own browser descendant identity is unavailable'}
  $pin=@{Process=$p;PID=$p.Id;BirthTicks=[string]$p.StartTime.ToUniversalTime().Ticks};[void]$pin.Process.Handle;$pins+=,$pin
 }
 if($pins.Count -lt 1 -or $consoles.Count -ne 1){throw 'Original browser group and exact Microsoft console infrastructure must be observed before normal close'}
 if($helper.HasExited -or $owner.HasExited){throw 'Own original helper or Host exited before close'}
 $clock=[Diagnostics.Stopwatch]::StartNew()
 foreach($w in $windows){[QytNormalSessionClose]::Close($w.Handle,$b.helperPID,$w.Binding.title)}
 $complete=$false
 while($clock.ElapsedMilliseconds -lt 5000){
  $windowsGone=$true;foreach($w in $windows){if([QytNormalSessionClose]::OriginalWindow($w.Handle,$b.helperPID,$w.Binding.title)){$windowsGone=$false}}
  $childrenGone=$true;foreach($pin in $pins){if(-not $pin.Process.HasExited){$childrenGone=$false}}
  if($windowsGone -and $childrenGone){if(@($consoles|Where-Object {$_.Process.HasExited}).Count -ne 0){throw 'Own original console ended before Host EOF'};$left=@(Descendants @(Get-CimInstance Win32_Process) $b.helperPID|Where-Object {$_.ProcessId -notin @($consoles|ForEach-Object PID)});if($left.Count -eq 0){$complete=$true;break}}
  Start-Sleep -Milliseconds 25
 }
 if(-not $complete -or $clock.ElapsedMilliseconds -gt 5000){throw 'Original WebView window-group did not naturally retire within5000ms after normal WM_CLOSE'}
 if($helper.HasExited -or $owner.HasExited -or [string]$helper.StartTime.ToUniversalTime().Ticks -cne [string]$b.helperBirthTicks){throw 'Own original helper or Host changed during window cleanup'}
 $children=@($pins|ForEach-Object {if(-not $_.Process.HasExited){throw 'Own original browser remains alive'};@{pid=$_.PID;birthTicks=$_.BirthTicks;exitCode=$_.Process.ExitCode;cachedOriginalHandle=$true}})
 if(@($children|Where-Object exitCode -ne 0).Count -gt 0){throw 'Own original browser process exited nonzero'}
 $consoleIdentity=@($consoles|ForEach-Object {@{pid=$_.PID;birthTicks=$_.BirthTicks;parentPID=$_.ParentPID;sha256=$_.SHA256;signatureStatus=$_.SignatureStatus;systemConsolePathVerified=$true;cachedOriginalHandle=$true}})
 $first=@{phase='window-group-released';version=1;operation=$b.operation;passed=$true;hostPID=$b.hostPID;helperPID=$b.helperPID;helperBirthTicks=$b.helperBirthTicks;helperSHA256=$b.nativeSHA256;windows=@($windows|ForEach-Object {@{sessionId=$_.Binding.sessionId;targetId=$_.Binding.targetId;wmClosePosted=$true;windowGone=$true}});browserProcesses=$children;consoleProcesses=$consoleIdentity;windowGroupReleased=$true;processSignalsSent=0;normalWMCloseCount=$windows.Count;budgetMs=5000;elapsedMs=$clock.ElapsedMilliseconds;boundary='Business native windows normally closed and their original WebView process groups retired before Host EOF; open-window Host shutdown remains a separate boundary'}
 [Console]::WriteLine(($first|ConvertTo-Json -Depth 6 -Compress));[Console]::Out.Flush()
 if([Console]::ReadLine() -cne 'host-eof'){throw 'Own original Host EOF boundary was not received'}
 $retiring=[Diagnostics.Stopwatch]::StartNew();$retired=$false
 while($retiring.ElapsedMilliseconds -lt 3000){if($owner.HasExited -and $helper.HasExited -and @($consoles|Where-Object {-not $_.Process.HasExited}).Count -eq 0){$retired=$true;break};Start-Sleep -Milliseconds 10}
 if(-not $retired -or $retiring.ElapsedMilliseconds -gt 3000 -or $owner.ExitCode -ne 0 -or $helper.ExitCode -ne 0 -or @($consoles|Where-Object {$_.Process.ExitCode -ne 0}).Count -gt 0){throw 'Own original Host/helper/Microsoft console did not naturally retire within3000ms after Host EOF'}
 [Console]::WriteLine((@{phase='host-console-released';passed=$true;hostPID=$b.hostPID;helperPID=$b.helperPID;hostExitCode=$owner.ExitCode;helperExitCode=$helper.ExitCode;consoleProcesses=@($consoles|ForEach-Object {@{pid=$_.PID;birthTicks=$_.BirthTicks;parentPID=$_.ParentPID;sha256=$_.SHA256;signatureStatus=$_.SignatureStatus;systemConsolePathVerified=$true;cachedOriginalHandle=$true;exitCode=$_.Process.ExitCode}});processSignalsSent=0;budgetMs=3000;elapsedMs=$retiring.ElapsedMilliseconds}|ConvertTo-Json -Depth 6 -Compress));[Console]::Out.Flush()
}finally{foreach($pin in @($pins)+@($consoles)){$pin.Process.Dispose()};$helper.Dispose();$owner.Dispose()}
