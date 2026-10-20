param([Parameter(Mandatory=$true)][string]$Helper,[Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$checks = [System.Collections.Generic.List[object]]::new()
$children = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$events = [System.Collections.Generic.List[object]]::new()
$script:sequence = 0
New-Item -ItemType Directory -Force $Output | Out-Null
$env:QIUYA_TOOLS_NATIVE_DATA_DIR = Join-Path $Output 'webview-profiles'
function Assert([bool]$condition,[string]$id,[object]$detail=$null) {
  $checks.Add(@{id=$id;passed=$condition;detail=$detail})
  if (!$condition) { throw "Failed native check $id" }
}
function Start-Helper([string]$arguments) {
  $info = [System.Diagnostics.ProcessStartInfo]::new($Helper,$arguments)
  $info.UseShellExecute=$false; $info.CreateNoWindow=$true
  $info.RedirectStandardInput=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
  $info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
  $info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
  $process=[Diagnostics.Process]::Start($info)
  $children.Add($process)
  return $process
}
function Send-Request($process,[string]$op,[hashtable]$body=@{}) {
  $script:sequence++
  $id='win-native-'+$script:sequence
  $body['requestId']=$id; $body['op']=$op
  $payload=$body | ConvertTo-Json -Depth 12 -Compress
  # Windows PowerShell 5.1's Process.StandardInput writer uses its legacy codepage. Keep transport JSON ASCII; the native consumer decodes Unicode escapes.
  $payload=[regex]::Replace($payload,'[^\x00-\x7F]',{param($match) '\u'+([int][char]$match.Value).ToString('x4')})
  $process.StandardInput.WriteLine($payload); $process.StandardInput.Flush()
  return $id
}
function Read-Reply($process,[string]$id,[int]$timeout=35000) {
  $stopwatch=[Diagnostics.Stopwatch]::StartNew()
  while ($stopwatch.ElapsedMilliseconds -lt $timeout) {
    $lineTask=$process.StandardOutput.ReadLineAsync()
    if (!$lineTask.Wait([Math]::Max(1,$timeout-[int]$stopwatch.ElapsedMilliseconds))) { throw 'Native response timed out' }
    $line=$lineTask.Result
    if ($null -eq $line) { throw 'Native helper ended before reply' }
    $answer=$line | ConvertFrom-Json
    if ($answer.event) { $events.Add($answer); continue }
    if ($answer.requestId -eq $id) { return $answer }
    throw 'Unexpected out-of-order native response'
  }
  throw 'Native response timed out'
}
function Rpc($process,[string]$op,[hashtable]$body=@{}) { $id=Send-Request $process $op $body; return Read-Reply $process $id }
function Good($process,[string]$op,[hashtable]$body=@{}) {
  $reply=Rpc $process $op $body
  if (!$reply.ok) { throw "Native $op failed: $($reply.error.code) $($reply.error.message)" }
  return $reply.result
}
function Fixture-State { return Get-Content (Join-Path $Output 'fixture-state.json') -Raw -Encoding UTF8 | ConvertFrom-Json }
function Element-Point($observation,[string]$name) {
  $line=($observation.elements -split "`n" | Where-Object { $_ -match ('name='+[regex]::Escape($name)+' ') } | Select-Object -First 1)
  if (!$line -or $line -notmatch 'bounds=([-0-9.]+),([-0-9.]+),([-0-9.]+),([-0-9.]+)') { throw "Missing UIA fixture element $name" }
  return @{ x=[double]$Matches[1]+[double]$Matches[3]/2-$observation.geometry.x; y=[double]$Matches[2]+[double]$Matches[4]/2-$observation.geometry.y }
}
try {
  Assert ([Environment]::UserInteractive -and [Diagnostics.Process]::GetCurrentProcess().SessionId -gt 0) 'WIN-NATIVE-INTERACTIVE-01' @{sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId}
  $fixtureInfo=[Diagnostics.ProcessStartInfo]::new($Helper,('--fixture --fixture-output "'+(Join-Path $Output 'fixture-state.json')+'"'))
  $fixtureInfo.UseShellExecute=$false; $fixtureInfo.CreateNoWindow=$true
  $fixture=[Diagnostics.Process]::Start($fixtureInfo); $children.Add($fixture)
  for($i=0;$i -lt 80 -and !(Test-Path (Join-Path $Output 'fixture-state.json'));$i++){Start-Sleep -Milliseconds 100}
  Assert (Test-Path (Join-Path $Output 'fixture-state.json')) 'WIN-NATIVE-FIXTURE-01'
  $unit=Start-Helper '--self-test-input';$last=$null;while($null -ne ($line=$unit.StandardOutput.ReadLine())){$last=$line|ConvertFrom-Json};Assert ($last.passed -eq $true -and $last.actualOsInput -eq $false) 'WIN-REJECTED-RELEASE-STATE-01' $last
  $computer=Start-Helper '--computer'
  $status=Good $computer 'status'
  Assert ($status.available -and $status.platform -eq 'win32') 'WIN-NATIVE-STATUS-01' $status
  $targets=Good $computer 'targets'
  $target=$targets | Where-Object {$_.pid -eq $fixture.Id -and $_.title -eq 'QiuYaTools Windows Test Fixture'} | Select-Object -First 1
  Assert ($null -ne $target) 'WIN-NATIVE-TARGET-01'
  $observed=Good $computer 'observe' @{targetId=$target.id}
  $uiaAttempts=1
  while($uiaAttempts -lt 3 -and !($observed.elements.Contains('Fixture click button') -and $observed.elements.Contains('Fixture text input'))){Start-Sleep -Milliseconds 800;$uiaAttempts++;$observed=Good $computer 'observe' @{targetId=$target.id}}
  Assert ($observed.elements.Contains('Fixture click button') -and $observed.elements.Contains('Fixture text input')) 'WIN-NATIVE-UIA-01' $observed.elements
  $image=[Convert]::FromBase64String($observed.imageBase64)
  [IO.File]::WriteAllBytes((Join-Path $Output 'fixture-observe.jpg'),$image)
  $stream=[IO.MemoryStream]::new($image); $bitmap=[Drawing.Bitmap]::FromStream($stream)
  Assert ($bitmap.Width -eq $observed.width -and $bitmap.Height -eq $observed.height -and $image.Length -gt 3000) 'WIN-NATIVE-CAPTURE-01' @{width=$bitmap.Width;height=$bitmap.Height;bytes=$image.Length}
  $colors=[Collections.Generic.HashSet[int]]::new(); for($x=5;$x -lt $bitmap.Width;$x+=25){for($y=5;$y -lt $bitmap.Height;$y+=25){[void]$colors.Add($bitmap.GetPixel($x,$y).ToArgb())}}
  Assert ($colors.Count -ge 4) 'WIN-NATIVE-CAPTURE-CONTENT-01' @{sampleColors=$colors.Count}; $bitmap.Dispose();$stream.Dispose()
  [void](Good $computer 'lease' @{epoch=1})
  $competitor=Start-Helper '--computer'
  $busy=Rpc $competitor 'lease' @{epoch=1};Assert (!$busy.ok -and $busy.error.code -eq 'desktop-busy') 'WIN-DESKTOP-EXCLUSIVE-01'
  $stale=Rpc $computer 'lease' @{epoch=1}; Assert (!$stale.ok -and $stale.error.code -eq 'stale-epoch') 'WIN-NATIVE-LEASE-01'
  $point=Element-Point $observed 'Fixture click button'
  [void](Good $computer 'act' @{epoch=1;targetId=$target.id;action=@{kind='click';x=$point.x;y=$point.y}})
  Start-Sleep -Milliseconds 180
  Assert ((Fixture-State).clicks -eq 1) 'WIN-NATIVE-CLICK-01'
  $cursorFrame=Good $computer 'observe' @{targetId=$target.id;preview=$true}
  Assert ($cursorFrame.cursor.visible -and [Math]::Abs($cursorFrame.cursor.x-$point.x) -le 1 -and [Math]::Abs($cursorFrame.cursor.y-$point.y) -le 1) 'WIN-NATIVE-LIVE-CURSOR-LOCAL-01' $cursorFrame.cursor
  $point=Element-Point $observed 'Fixture text input'
  [void](Good $computer 'act' @{epoch=1;targetId=$target.id;action=@{kind='click';x=$point.x;y=$point.y}})
  $text='QiuYa '+[char]0x4E2D+[char]0x6587+[char]::ConvertFromUtf32(0x1F642)+"`r`nline2"
  [void](Good $computer 'act' @{epoch=1;targetId=$target.id;action=@{kind='type';text=$text}})
  Start-Sleep -Milliseconds 250
  Assert ((Fixture-State).text -eq $text) 'WIN-NATIVE-UNICODE-01' @{characters=(Fixture-State).text.Length}
  [void](Good $computer 'act' @{epoch=1;targetId=$target.id;action=@{kind='key';key='CTRL+A'}})
  [void](Good $computer 'act' @{epoch=1;targetId=$target.id;action=@{kind='type';text='replacement'}})
  Start-Sleep -Milliseconds 180
  Assert ((Fixture-State).text -eq 'replacement') 'WIN-NATIVE-KEY-01'
  $point=Element-Point $observed 'Fixture scroll area'
  [void](Good $computer 'act' @{epoch=1;targetId=$target.id;action=@{kind='click';x=$point.x;y=$point.y}})
  [void](Good $computer 'act' @{epoch=1;targetId=$target.id;action=@{kind='scroll';x=$point.x;y=$point.y;deltaY=480;deltaX=0}})
  Start-Sleep -Milliseconds 100
  Assert ((Fixture-State).wheelTotal -lt 0) 'WIN-NATIVE-SCROLL-01'
  $point=Element-Point $observed 'Fixture drag pad'
  [void](Good $computer 'act' @{epoch=1;targetId=$target.id;action=@{kind='drag';x=($point.x-40);y=$point.y;toX=($point.x+40);toY=$point.y}})
  Start-Sleep -Milliseconds 100
  Assert ((Fixture-State).drags -eq 1) 'WIN-NATIVE-DRAG-01'
  [void](Good $computer 'release' @{epoch=1})
  [void](Good $competitor 'lease' @{epoch=1})
  $busy=Rpc $computer 'lease' @{epoch=2};Assert (!$busy.ok -and $busy.error.code -eq 'desktop-busy') 'WIN-DESKTOP-CROSS-HELPER-01'
  [void](Good $competitor 'release' @{epoch=1})
  $stale=Rpc $computer 'act' @{epoch=1;targetId=$target.id;action=@{kind='click';x=$point.x;y=$point.y}}
  Assert (!$stale.ok -and $stale.error.code -eq 'stale-epoch') 'WIN-NATIVE-RELEASE-01'
  [void](Good $computer 'lease' @{epoch=2})
  $out=Rpc $computer 'act' @{epoch=2;targetId=$target.id;action=@{kind='click';x=-1;y=20}}
  Assert (!$out.ok -and $out.error.code -eq 'invalid-coordinate') 'WIN-NATIVE-BOUNDS-01'
  [void](Good $computer 'release' @{epoch=2})
  $sessions=Start-Helper ''
  $store=[Guid]::NewGuid().ToString('D'); $port=(Fixture-State).port
  $url='http://127.0.0.1:'+ $port +'/?qiuya-session=test-session-a'
  $reply=Rpc $sessions 'prepare' @{sessionId='test-session-a';storeIdentifier=$store;url=$url;title='Test Session';source='drag'}
  Assert $reply.ok 'WIN-WINDOW-PREPARE-01'
  $reply=Rpc $sessions 'open' @{sessionId='test-session-a';storeIdentifier=$store;url=$url;title='Test Session';source='menu'}
  Assert $reply.ok 'WIN-WINDOW-HANDSHAKE-01'
  $reply=Rpc $sessions 'open' @{sessionId='test-session-a';storeIdentifier=$store;url=$url;title='Test Session';source='menu'}
  Assert $reply.ok 'WIN-WINDOW-REUSE-01'
  $reply=Rpc $sessions 'open' @{sessionId='test-session-b';storeIdentifier=[Guid]::NewGuid().ToString('D');url=$url;title='Bad';source='menu'}
  Assert (!$reply.ok -and $reply.error.code -eq 'invalid-request') 'WIN-WINDOW-IDENTITY-01'
  $reply=Rpc $sessions 'open' @{sessionId='test-session-a';storeIdentifier=$store;url='https://example.com/?qiuya-session=test-session-a';title='Bad';source='menu'}
  Assert (!$reply.ok -and $reply.error.code -eq 'invalid-url') 'WIN-WINDOW-ORIGIN-01'
  [void](Good $computer 'openPreview' @{sessionId='preview-test';url=('http://127.0.0.1:'+$port+'/preview');title='QiuYaTools Test Preview'})
  Assert (($events | Where-Object {$_.event -eq 'action' -and $_.phase -eq 'completed'}).Count -ge 4) 'WIN-NATIVE-ACTION-EVENTS-01'
  [void](Good $computer 'closePreview' @{sessionId='preview-test'})
  Assert (@($events | Where-Object {$_.event -eq 'previewClosed' -and $_.sessionId -eq 'preview-test'}).Count -eq 1) 'WIN-PREVIEW-CLOSE-01'
  [void](Good $computer 'openPreview' @{sessionId='preview-overlap';url=('http://127.0.0.1:'+$port+'/preview');title='QiuYaTools Overlap Preview'})
  [void](Good $computer 'lease' @{epoch=3})
  $observed=Good $computer 'observe' @{targetId=$target.id;preview=$true}
  Assert ($observed.elements -eq '') 'WIN-PREVIEW-CAPTURE-ONLY-01'
  # Deliberately cover the target with the native topmost preview; act must move/hide it before injection.
  Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class FixtureNative{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out Rect r);struct Rect{public int L,T,R,B;}public static int[] Center(IntPtr h){Rect r;GetWindowRect(h,out r);return new[]{(r.L+r.R)/2,(r.T+r.B)/2};}public static IntPtr Window(string t){return FindWindow(null,t);}[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int h2,uint f);[DllImport("user32.dll")]public static extern short GetAsyncKeyState(int k);}'
  $previewHandle=[FixtureNative]::Window(('QiuYaTools Overlap Preview '+[char]0x2014+' QiuYaTools'))
  Assert ($previewHandle -ne [IntPtr]::Zero -and [FixtureNative]::SetWindowPos($previewHandle,[IntPtr](-1),$observed.geometry.x,$observed.geometry.y,600,420,0x0010)) 'WIN-PREVIEW-OVERLAP-SETUP-01' @{handle=$previewHandle.ToInt64()} 
  $point=Element-Point (Good $computer 'observe' @{targetId=$target.id}) 'Fixture click button'
  [void](Good $computer 'act' @{epoch=3;targetId=$target.id;action=@{kind='click';x=$point.x;y=$point.y}})
  Start-Sleep -Milliseconds 100
  Assert ((Fixture-State).clicks -eq 2) 'WIN-PREVIEW-OVERLAP-INPUT-01'
  [void](Good $computer 'closePreview')
  Assert (@($events | Where-Object {$_.event -eq 'previewClosed' -and $_.sessionId -eq 'preview-overlap'}).Count -eq 1) 'WIN-PREVIEW-CLOSE-ALL-01'
  $observed=Good $computer 'observe' @{targetId=$target.id}
  $point=Element-Point $observed 'Fixture drag pad'
  [IO.File]::WriteAllText((Join-Path $Output 'physical-checkpoint.json'),'{"phase":"awaiting-physical-escape"}')
  $go=Join-Path $Output 'physical-go'
  for($i=0;$i -lt 1500 -and !(Test-Path $go);$i++){Start-Sleep -Milliseconds 20}
  Assert (Test-Path $go) 'WIN-PHYSICAL-RUNNER-01'
  $id=Send-Request $computer 'act' @{epoch=3;targetId=$target.id;action=@{kind='drag';x=($point.x-180);y=$point.y;toX=($point.x+180);toY=$point.y}}
  $interrupted=Read-Reply $computer $id
  Assert (!$interrupted.ok -and $interrupted.error.code -eq 'stale-epoch') 'WIN-PHYSICAL-ESCAPE-DRAG-01'
  Assert (@($events | Where-Object {$_.event -eq 'humanInput'}).Count -ge 1) 'WIN-PHYSICAL-HUMAN-EVENT-01'
  Assert (([FixtureNative]::GetAsyncKeyState(1) -band 0x8000) -eq 0) 'WIN-PHYSICAL-MOUSE-RELEASE-01'
  [void](Good $computer 'openPreview' @{sessionId='preview-physical-busy';url=('http://127.0.0.1:'+$port+'/preview');title='QiuYaTools Busy Preview'})
  $busyPreview=[FixtureNative]::Window(('QiuYaTools Busy Preview '+[char]0x2014+' QiuYaTools'))
  Assert ($busyPreview -ne [IntPtr]::Zero) 'WIN-PREVIEW-BUSY-HOOK-SETUP-01'
  [void](Good $computer 'lease' @{epoch=4})
  $id=Send-Request $computer 'act' @{epoch=4;targetId=$target.id;action=@{kind='drag';x=($point.x-180);y=$point.y;toX=($point.x+180);toY=$point.y}}
  $held=$null
  for($i=0;$i -lt 20 -and $null -eq $held;$i++){
    $lineTask=$computer.StandardOutput.ReadLineAsync();if(!$lineTask.Wait(10000)){throw 'No held-input notification'};$event=$lineTask.Result|ConvertFrom-Json
    if($event.event){$events.Add($event);if($event.event -eq 'inputHeld' -and @($event.mouseButtons) -contains 'left'){$held=$event}}
    else{throw 'Drag finished before held-input notification'}
  }
  for($i=0;$i -lt 40 -and (([FixtureNative]::GetAsyncKeyState(1)-band 0x8000)-eq 0);$i++){Start-Sleep -Milliseconds 5}
  Assert (([FixtureNative]::GetAsyncKeyState(1)-band 0x8000)-ne 0) 'WIN-PREVIEW-BUSY-ACTUAL-DOWN-01'
  $center=[FixtureNative]::Center($busyPreview)
  # This is only a cursor-routing diagnostic. It is not proof of a physical HID event.
  [void][FixtureNative]::SetCursorPos($center[0],$center[1])
  $interrupted=Read-Reply $computer $id
  $cursorProbe=if(!$interrupted.ok -and $interrupted.error.code -eq 'stale-epoch'){'non-SendInput cursor event interrupted the busy preview'}else{'SetCursorPos did not prove a physical HID preview event; separate HID preview test required'}
  Assert (([FixtureNative]::GetAsyncKeyState(1)-band 0x8000)-eq 0) 'WIN-PREVIEW-POST-DRAG-RELEASE-01'
  [void](Good $computer 'closePreview')
  [void](Good $computer 'openPreview' @{sessionId='preview-auth';url=('http://127.0.0.1:'+$port+'/secure-preview?token=fixture-token');title='QiuYaTools Auth Preview'})
  for($i=0;$i -lt 100 -and (Fixture-State).authenticatedPreviews -lt 1;$i++){Start-Sleep -Milliseconds 100}
  Assert ((Fixture-State).authenticatedPreviews -ge 1) 'WIN-PREVIEW-ROOT-COOKIE-BOOTSTRAP-01'
  [void](Good $computer 'closePreview')
  # Prove the separate cleanup executable can release an actually-down owned button after hard worker termination.
  [void](Good $computer 'lease' @{epoch=5})
  $id=Send-Request $computer 'act' @{epoch=5;targetId=$target.id;action=@{kind='drag';x=($point.x-180);y=$point.y;toX=($point.x+180);toY=$point.y}}
  $held=$null
  for($i=0;$i -lt 20 -and $null -eq $held;$i++){
    $lineTask=$computer.StandardOutput.ReadLineAsync();if(!$lineTask.Wait(10000)){throw 'No held state before crash'};$event=$lineTask.Result|ConvertFrom-Json
    if($event.event){$events.Add($event);if($event.event -eq 'inputHeld' -and @($event.mouseButtons) -contains 'left'){$held=$event}}
    else{throw 'Drag finished before crash injection'}
  }
  for($i=0;$i -lt 40 -and (([FixtureNative]::GetAsyncKeyState(1)-band 0x8000)-eq 0);$i++){Start-Sleep -Milliseconds 5}
  Assert (([FixtureNative]::GetAsyncKeyState(1)-band 0x8000)-ne 0) 'WIN-CRASH-OWNED-DOWN-01'
  $computer.Kill();[void]$computer.WaitForExit(3000)
  $cleanup=Start-Helper '--release-input';$cleanup.StandardInput.WriteLine((@{keys=@($held.keys);mouseButtons=@($held.mouseButtons);unicodeUnits=@($held.unicodeUnits);ownerId=$held.ownerId}|ConvertTo-Json -Compress));$cleanup.StandardInput.Close()
  $cleanupRead=$cleanup.StandardOutput.ReadLineAsync();if(!$cleanupRead.Wait(10000)){throw 'Emergency cleanup timed out'};$cleanupResult=$cleanupRead.Result|ConvertFrom-Json
  Assert ($cleanupResult.released -eq $true -and $cleanupResult.ownerMatchedCleanup -eq $true) 'WIN-CRASH-OWNER-CLEANUP-01'
  Start-Sleep -Milliseconds 50
  Assert (([FixtureNative]::GetAsyncKeyState(1)-band 0x8000)-eq 0) 'WIN-CRASH-NO-HELD-MOUSE-01'
  # A new helper must recover the old journal before it can acquire; late cleanup cannot affect this owner.
  [void](Good $competitor 'lease' @{epoch=2})
  Assert (([FixtureNative]::GetAsyncKeyState(1)-band 0x8000)-eq 0) 'WIN-GUARDIAN-RECOVER-BEFORE-LEASE-01'
  [void](Good $competitor 'observe' @{targetId=$target.id;preview=$true})
  $late=Start-Helper '--release-input'
  Start-Sleep -Milliseconds 150
  $newDrag=Send-Request $competitor 'act' @{epoch=2;targetId=$target.id;action=@{kind='drag';x=($point.x-180);y=$point.y;toX=($point.x+180);toY=$point.y}}
  $newHeld=$null
  for($i=0;$i -lt 20 -and $null -eq $newHeld;$i++){
    $read=$competitor.StandardOutput.ReadLineAsync();if(!$read.Wait(10000)){throw 'New owner held event missing'};$event=$read.Result|ConvertFrom-Json
    if($event.event){$events.Add($event);if($event.event -eq 'inputHeld' -and @($event.mouseButtons) -contains 'left'){$newHeld=$event}}else{throw 'New owner drag ended too early'}
  }
  Assert ($newHeld.ownerId -and $newHeld.ownerId -ne $held.ownerId) 'WIN-DESKTOP-OWNER-IDENTITY-01'
  $late.StandardInput.WriteLine((@{keys=@($held.keys);mouseButtons=@($held.mouseButtons);unicodeUnits=@($held.unicodeUnits);ownerId=$held.ownerId}|ConvertTo-Json -Compress));$late.StandardInput.Close()
  $read=$late.StandardOutput.ReadLineAsync();if(!$read.Wait(10000)){throw 'Late old-owner cleanup timed out'};$lateResult=$read.Result|ConvertFrom-Json
  Assert ($lateResult.released -eq $true) 'WIN-OLD-OWNER-CLEANUP-SKIP-01'
  Assert (([FixtureNative]::GetAsyncKeyState(1)-band 0x8000)-ne 0) 'WIN-OLD-CLEANUP-PRESERVES-NEW-DOWN-01'
  $done=Read-Reply $competitor $newDrag;Assert $done.ok 'WIN-NEW-OWNER-DRAG-COMPLETES-01'
  [void](Good $competitor 'release' @{epoch=2})
  [void][FixtureNative]::SetCursorPos(2,2)
  $outsideCursor=Good $competitor 'observe' @{targetId=$target.id;preview=$true}
  Assert (!$outsideCursor.cursor.visible) 'WIN-NATIVE-CURSOR-OUTSIDE-HIDDEN-01' $outsideCursor.cursor
  $result=@{passed=$true;checks=$checks;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;architecture=$status.architecture;events=$events.Count;uiaAttempts=$uiaAttempts;cursorProbe=$cursorProbe;unverified=@('physical HID click on own preview during drag');runtime='self-contained; WebView2 Evergreen system runtime'}
} catch {
  $result=@{passed=$false;checks=$checks;error=$_.Exception.Message;trace=$_.ScriptStackTrace}
} finally {
  if($held -and @($held.mouseButtons).Count -gt 0){try{$release=Start-Helper '--release-input';$release.StandardInput.WriteLine((@{keys=@($held.keys);mouseButtons=@($held.mouseButtons);unicodeUnits=@($held.unicodeUnits);ownerId=$held.ownerId}|ConvertTo-Json -Compress));$release.StandardInput.Close();[void]$release.WaitForExit(5000)}catch{}}
  foreach($child in $children){try{if(!$child.HasExited){if($child.StartInfo.RedirectStandardInput){$child.StandardInput.Close();[void]$child.WaitForExit(2000)};if(!$child.HasExited){$child.Kill()}}}catch{}}
  $result | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $Output 'report.json') -Encoding UTF8
}
