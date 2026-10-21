param([Parameter(Mandatory=$true)][string]$Helper,[Parameter(Mandatory=$true)][string]$Output,[Parameter(Mandatory=$true)][string]$FixtureSource)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.Drawing,System.Windows.Forms,System.Web.Extensions
Add-Type -Path $FixtureSource -ReferencedAssemblies System,System.Core,System.Drawing,System.Windows.Forms,System.Web.Extensions
[void][QytAiOracle]::SetThreadDpiAwarenessContext([IntPtr](-4))
New-Item -ItemType Directory -Force $Output|Out-Null
$checks=[Collections.Generic.List[object]]::new();$children=[Collections.Generic.List[object]]::new();$events=[Collections.Generic.List[object]]::new();$sequence=0;$command=0;$active=@{};$forced=@();$tracked=@();$result=$null
$env:QIUYA_TOOLS_NATIVE_DATA_DIR=Join-Path $Output 'webview-data'
$env:QIUYA_WINDOWS_INPUT_TRACE='1'
$env:QIUYA_WINDOWS_PREVIEW_TRACE='1'
function Save([string]$name,$value){$value|ConvertTo-Json -Depth 24|Set-Content -LiteralPath (Join-Path $Output $name) -Encoding UTF8}
function Assert([bool]$condition,[string]$id,$details=$null){$checks.Add(@{id=$id;passed=$condition;details=$details});if(!$condition){throw $id}}
function Until([scriptblock]$operation,[string]$message,[int]$timeout=4000){$clock=[Diagnostics.Stopwatch]::StartNew();do{$value=& $operation;if($value){return $value};Start-Sleep -Milliseconds 25}while($clock.ElapsedMilliseconds -lt $timeout);throw $message}
function Start-Owned([string]$executable,[string]$arguments,[string]$role,[bool]$pipes=$true){
 $info=[Diagnostics.ProcessStartInfo]::new($executable,$arguments);$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$pipes;$info.RedirectStandardOutput=$pipes;$info.RedirectStandardError=$pipes
 if($pipes){$info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)}
 $p=[Diagnostics.Process]::Start($info);$child=@{process=$p;identity=$null;role=$role};$children.Add($child);$identity=[QytAiOracle]::Identity($p.Id);$child.identity=$identity;return $p
}
function Bound($p){$i=($children|Where-Object {$_.process.Id -eq  $p.Id}).identity;if(!$i -or ![QytAiOracle]::Same($i.pid,$i.createdAtTicks,$i.expectedExecutablePath)){throw 'Own process identity changed'};return $i}
function Rpc($p,[string]$op,[hashtable]$body=@{}){
 [void](Bound $p);$script:sequence++;$id='ai-real-'+$script:sequence;$body.requestId=$id;$body.op=$op;$text=$body|ConvertTo-Json -Depth 10 -Compress
 $text=[regex]::Replace($text,'[^\x00-\x7F]',{param($m)'\u'+([int][char]$m.Value).ToString('x4')});$p.StandardInput.WriteLine($text);$p.StandardInput.Flush();$clock=[Diagnostics.Stopwatch]::StartNew()
 while($clock.ElapsedMilliseconds -lt  30000){$read=$p.StandardOutput.ReadLineAsync();if(!$read.Wait([Math]::Max(1,30000-[int]$clock.ElapsedMilliseconds))){throw 'Native RPC timeout'};if($null -eq  $read.Result){throw 'Native EOF before reply'};$answer=$read.Result|ConvertFrom-Json;if($answer.event){$events.Add($answer);Save 'events.json' $events;continue};if($answer.requestId -ne  $id){throw 'Out of order native reply'};return $answer};throw 'Native RPC timeout'
}
function Good($p,[string]$op,[hashtable]$body=@{}){$r=Rpc $p $op $body;if(!$r.ok){throw ('Native '+$op+' failed: '+$r.error.code)};return $r.result}
function Lease($p,[long]$epoch,[string]$actor='ai'){$r=Good $p 'lease' @{epoch=$epoch;actor=$actor};$active[$p.Id]=$epoch;return $r}
function Release($p,[long]$epoch){$r=Good $p 'release' @{epoch=$epoch};if($active[$p.Id] -eq  $epoch){$active.Remove($p.Id)};return $r}
function Fixture {[QytAiOracle]::ReadFixture((Join-Path $Output 'fixture-state.json'))}
function FixtureCommand([string]$op){[void](Bound $fixture);$script:command++;[IO.File]::WriteAllText((Join-Path $Output 'fixture-command.txt'),($script:command.ToString()+'|'+$op));if($op -ne  'exit'){[void](Until {if((Fixture).sequence -eq  $script:command){return Fixture}} ('Fixture command not acknowledged: '+$op))}}
function PointerWindows($p){@([QytAiOracle]::Windows($p.Id)|Where-Object {($_.exStyle -band  0x80020) -eq  0x80020})}
function PointerVisible($p){@((PointerWindows $p)|Where-Object visible).Count -eq  1}
function PointerHidden($p){@((PointerWindows $p)|Where-Object visible).Count -eq  0}
function Move-Ai($p,[long]$epoch,[int]$x,[int]$y){[void](Good $p 'act' @{epoch=$epoch;targetId=$target.id;action=@{kind='move';x=$x;y=$y}});Until {$s=Good $p 'status';if($s.aiCursor.visible -and (PointerVisible $p)){return $s}} 'Actual AI surface did not become visible'}
function Track-Native {
 $all=@(Get-CimInstance Win32_Process);$owned=@{};foreach($row in $all){if($row.ExecutablePath -ieq $Helper -or ($row.CommandLine -and $row.CommandLine.Contains($env:QIUYA_TOOLS_NATIVE_DATA_DIR))){$owned[[int]$row.ProcessId]=$true}}
 do{$added=$false;foreach($row in $all){if($owned.ContainsKey([int]$row.ParentProcessId) -and !$owned.ContainsKey([int]$row.ProcessId)){$owned[[int]$row.ProcessId]=$true;$added=$true}}}while($added)
 $list=@();foreach($row in @($all|Where-Object {$owned.ContainsKey([int]$_.ProcessId)})){try{$i=[QytAiOracle]::Identity([int]$row.ProcessId);$list+=@{pid=$i.pid;createdAtTicks=$i.createdAtTicks;expectedExecutablePath=$i.expectedExecutablePath;parentPid=[int]$row.ParentProcessId}}catch{}}
 return $list
}
try{
 $before=[QytAiOracle]::DesktopState();$guard=[QytAiOracle]::LeaseState();Save 'before-desktop.json' @{desktop=$before;lease=$guard}
 Assert ($before.sessionId -gt  0 -and  $before.userInteractive -and  $before.activeDesktopAccessible -and  $before.activeDesktop -eq  $before.threadDesktop -and  @($before.heldKeys).Count -eq  0) 'AI-INTERACTIVE-DESKTOP-AND-EMPTY-INPUT' $before
 Assert ($guard.lockFree -and  (!$guard.journal -or  ($guard.journal.KeyCount -eq  0 -and  $guard.journal.MouseCount -eq  0 -and  $guard.journal.UnicodeCount -eq  0))) 'AI-NO-EXTERNAL-INPUT-OWNER' $guard
 $fixtureBoot=Join-Path $Output 'fixture-run.ps1';$quotedSource=$FixtureSource.Replace("'","''");$quotedOutput=$Output.Replace("'","''");$title='QiuYaTools AI pixels '+[Guid]::NewGuid().ToString('N')
 [IO.File]::WriteAllText($fixtureBoot,("Add-Type -AssemblyName System.Drawing,System.Windows.Forms,System.Web.Extensions`r`nAdd-Type -Path '"+$quotedSource+"' -ReferencedAssemblies System,System.Core,System.Drawing,System.Windows.Forms,System.Web.Extensions`r`n[QytAiFixture]::Run('"+$quotedOutput+"','"+$title+"')"))
 $fixture=Start-Owned (Join-Path $PSHOME 'powershell.exe') ('-NoProfile -STA -ExecutionPolicy Bypass -File "'+$fixtureBoot+'"') 'known-pixel-fixture' $false
 $f=Until {if(Test-Path (Join-Path $Output 'fixture-state.json')){return Fixture}} 'Fixture startup timed out' 15000
 Assert ($f.pid -eq  $fixture.Id -and  $f.createdAtTicks -eq  (Bound $fixture).createdAtTicks) 'AI-FIXTURE-EXACT-IDENTITY' $f
 $computer=Start-Owned $Helper '--computer' 'computer-a';$status=Good $computer 'status';$target=Good $computer 'targets'|Where-Object {$_.pid -eq  $fixture.Id -and  $_.title -eq  $title}|Select-Object -First 1
 Assert ($target -and  $target.id -like  ('window:*:'+ $fixture.Id+':'+$f.createdAtTicks)) 'AI-TARGET-EXACT-IDENTITY' $target
 [void](Good $computer 'observe' @{targetId=$target.id;preview=$true});$f=Fixture;$x=[int]$f.clientX+300-[int]$target.x;$y=[int]$f.clientY+220-[int]$target.y
 $px=[int]$target.x+$x;$py=[int]$target.y+$y
 [void](Lease $computer 1);$shown=Move-Ai $computer 1 $x $y;$pointer=@(PointerWindows $computer)[0];Save 'shown-native.json' @{status=$shown;window=$pointer}
 $required=0x080800A8
 Assert ($pointer.visible -and  !$pointer.enabled -and  ($pointer.exStyle -band  $required) -eq  $required -and  $pointer.foreground -eq  [long]$f.handle) 'AI-ACTUAL-NOACTIVATE-TOPMOST-TRANSPARENT-DISABLED' $pointer
 Assert ($shown.aiCursor.actor -eq  'ai'-and $shown.aiCursor.targetId -eq  $target.id -and  [Math]::Abs($shown.aiCursor.x-$x) -le  1 -and  [Math]::Abs($shown.aiCursor.y-$y) -le  1) 'AI-TARGET-LOCAL-METADATA' $shown.aiCursor
 $sameCursor=([QytAiOracle]::DesktopState()).cursor
 Assert ([Math]::Abs($sameCursor.x-$px) -le 1 -and [Math]::Abs($sameCursor.y-$py) -le 1) 'AI-SAME-POINT-ACTUAL-OS-CURSOR-POSITION' $sameCursor
 $sameScale=$pointer.dpi/96.0
 Save 'same-point-checkpoint.json' @{phase='ai-and-os-same-point';crop=@{x=$pointer.x;y=$pointer.y;width=$pointer.width;height=$pointer.height};screen=([QytAiOracle]::DesktopState()).screen;target=@{x=$target.x;y=$target.y;width=$target.width;height=$target.height};pointer=$pointer;ai=$shown.aiCursor;real=@{x=($sameCursor.x-$target.x);y=($sameCursor.y-$target.y);visible=$true};bodyPoint=@{x=($px+[int](4*$sameScale));y=($py+[int](5*$sameScale))}}
 $sameCapture=Until {if(Test-Path (Join-Path $Output 'same-point-go.json')){return Get-Content -LiteralPath (Join-Path $Output 'same-point-go.json') -Raw|ConvertFrom-Json}} 'Host did not capture actual co-located system and AI pointers' 30000
 Assert $sameCapture.captured 'AI-SAME-POINT-COMPOSITE-CAPTURED-FOR-VISUAL-REVIEW' $sameCapture
 $identity=Bound $fixture;$moved=[QytAiOracle]::MoveOwn($identity.pid,$identity.createdAtTicks,$identity.expectedExecutablePath,$f.handle,([int]$f.clientX+580),([int]$f.clientY+420));Start-Sleep -Milliseconds 50
 $frame=Good $computer 'observe' @{targetId=$target.id;preview=$true};[IO.File]::WriteAllBytes((Join-Path $Output 'native-observe.jpg'),[Convert]::FromBase64String($frame.imageBase64))
 Assert ($frame.aiCursor.visible -and  $frame.cursor.visible -and  [Math]::Abs($frame.aiCursor.x-$frame.cursor.x) -gt  100 -and  [Math]::Abs($frame.aiCursor.y-$frame.cursor.y) -gt  100) 'AI-AND-REAL-OS-CURSOR-ARE-INDEPENDENT' @{ai=$frame.aiCursor;real=$frame.cursor;move=$moved}
 # Approved SVG body (6,8) relative to shared hotspot (2,3).
 $scale=$pointer.dpi/96.0;$hitX=$px+[int](4*$scale);$hitY=$py+[int](5*$scale);$hit=[QytAiOracle]::Hit($hitX,$hitY)
 $realPosition=([QytAiOracle]::DesktopState()).cursor
 Assert ([Math]::Abs($pointer.x+[Math]::Round(18*$scale)-$px) -le  1 -and  [Math]::Abs($pointer.y+[Math]::Round(16*$scale)-$py) -le  1 -and  [Math]::Abs($frame.cursor.x-($realPosition.x-$target.x)) -le  1 -and  [Math]::Abs($frame.cursor.y-($realPosition.y-$target.y)) -le  1) 'AI-RASTER-HOTSPOT-AND-OS-CURSOR-GEOMETRY-AGREE' @{window=$pointer;real=$realPosition;svgHotspot=@{x=2;y=3}}
 $nativePixels=[QytAiOracle]::NativeRegion($frame.imageBase64,($pointer.x-$target.x),($pointer.y-$target.y),$pointer.width,$pointer.height,(Join-Path $Output 'native-known-region.png'))
 Assert ($nativePixels.incorrect -eq  0 -and  $nativePixels.black -eq  0 -and  $nativePixels.white -eq  0) 'AI-NATIVE-OBSERVE-HAS-KNOWN-BACKGROUND-NO-BAKED-ARROW' $nativePixels
 Assert ($hit.root -eq  [long]$f.handle -and  $hit.pid -eq  $fixture.Id -and  $hit.physical -ne  [long]$pointer.handle) 'AI-VISIBLE-GLYPH-POINT-HITS-UNDERLYING-OWN-TARGET' $hit
 $copy=Join-Path $Output 'screen-fallback.png';[QytAiOracle]::CopyScreen($pointer.x,$pointer.y,$pointer.width,$pointer.height,$copy);$pixels=[QytAiOracle]::KnownBackground($copy,37,113,151)
 Save 'fallback-known-pixels.json' @{pixels=$pixels;window=$pointer;affinity=$pointer.affinity;api='Graphics.CopyFromScreen (same fallback primitive, not a forced PrintWindow failure)'}
 Assert ($pixels.incorrect -eq  0 -and  $pixels.black -eq  0 -and  $pixels.white -eq  0) 'AI-SCREEN-FALLBACK-HAS-KNOWN-BACKGROUND-NO-HOLE-NO-DUPLICATE' $pixels
 $screen=([QytAiOracle]::DesktopState()).screen;Save 'raster-checkpoint.json' @{phase='ai-visible';crop=@{x=$pointer.x;y=$pointer.y;width=$pointer.width;height=$pointer.height};screen=$screen;target=@{x=$target.x;y=$target.y;width=$target.width;height=$target.height};pointer=$pointer;ai=$frame.aiCursor;real=$frame.cursor;hit=$hit;bodyPoint=@{x=$hitX;y=$hitY};expectedBackground=@{r=37;g=113;b=151};foreground=[QytAiOracle]::GetForegroundWindow().ToInt64()}
 $raster=Until {if(Test-Path (Join-Path $Output 'raster-go.json')){return Get-Content -LiteralPath (Join-Path $Output 'raster-go.json') -Raw|ConvertFrom-Json}} 'Host did not provide independent VM raster verdict' 30000
 Assert ($raster.passed -and  $raster.bodyPointIsArrow) 'AI-PHYSICAL-DISPLAY-ARROW-PIXELS-INDEPENDENT-OF-WDA' $raster
 $clicks=(Fixture).clicks;$click=[QytAiOracle]::ClickOwn($identity.pid,$identity.createdAtTicks,$identity.expectedExecutablePath,$f.handle,$hitX,$hitY)
 [void](Until {if((Fixture).clicks -eq  ($clicks+1)){return $true}} 'Click-through did not reach fixture business event')
 Assert ((Fixture).clicks -eq  ($clicks+1) -and  (Good $computer 'status').aiCursor.visible) 'AI-ACTUAL-VISIBLE-GLYPH-AREA-CLICK-THROUGH' $click
 [void](Release $computer 1);[void](Until {if((PointerHidden $computer) -and  !(Good $computer 'status').aiCursor.visible){return $true}} 'Release did not hide pointer')
 Assert $true 'AI-PAUSE-RELEASE-HIDES-SURFACE'
 [void](Lease $computer 2);[void](Move-Ai $computer 2 ($x+40) $y);[void](Release $computer 1)
 Assert ((PointerVisible $computer) -and  (Good $computer 'status').aiCursor.visible) 'AI-OLD-RELEASE-CANNOT-HIDE-NEW-LEASE'
 [void](Release $computer 2);[void](Lease $computer 3 'human');[void](Good $computer 'act' @{epoch=3;targetId=$target.id;action=@{kind='move';x=$x;y=$y}});Start-Sleep -Milliseconds 80
 Assert ((PointerHidden $computer) -and  !(Good $computer 'status').aiCursor.visible -and  (Good $computer 'status').leaseActor -eq  'human') 'AI-HUMAN-ACTOR-NEVER-SHOWS-ARROW'
 [void](Release $computer 3);[void](Lease $computer 4);[void](Move-Ai $computer 4 $x $y);FixtureCommand 'focus-other'
 [void](Until {if((PointerHidden $computer) -and  !(Good $computer 'status').aiCursor.visible){return $true}} 'Focus loss did not hide AI pointer')
 Assert $true 'AI-FOCUS-LOSS-HIDES-SURFACE';FixtureCommand 'activate';Start-Sleep -Milliseconds 150
 Assert ((PointerHidden $computer) -and  !(Good $computer 'status').aiCursor.visible) 'AI-FOCUS-RETURN-DOES-NOT-RESURRECT-OLD-ARROW'
 # Real WebView2 independently ACKs the fixed preserve flag through its own HTTP fixture.
 $ownPreview='http://127.0.0.1:'+(Fixture).port+'/preview?sid='
 [void](Good $computer 'openPreview' @{sessionId='preserved';url=($ownPreview+'preserved');title='Own preserved preview'})
 [void](Until {if(@((Fixture).webEvents|Where-Object {$_.kind -eq 'ready' -and $_.sid -eq 'preserved'}).Count -eq 1){return $true}} 'Actual preserve test page did not load' 10000)
 $tracked+=Track-Native
 $preservedWindow=@([QytAiOracle]::Windows($computer.Id)|Where-Object {$_.title -like 'Own preserved preview*' -and $_.visible})[0]
 Assert ($preservedWindow -and ($preservedWindow.exStyle -band 8) -ne 0) 'AI-PRESERVE-ACTUAL-WEBVIEW-IS-VISIBLE-TOPMOST' $preservedWindow
 [void](Good $computer 'closePreview' @{sessionId='preserved';preserveSession=$true});[void](Good $computer 'status')
 Assert (@((Fixture).webEvents|Where-Object {$_.kind -eq 'preserve-ack' -and $_.sid -eq 'preserved'}).Count -eq 1) 'AI-PRESERVE-JAVASCRIPT-ACKED-BY-INDEPENDENT-OWN-HTTP-PAGE'
 Assert (@($events|Where-Object {$_.event -eq 'previewClosed' -and $_.sessionId -eq 'preserved'}).Count -eq 0 -and ![QytAiOracle]::IsWindow([IntPtr]$preservedWindow.handle)) 'AI-PRESERVE-CLOSE-DESTROYS-ONLY-WINDOW-WITHOUT-PAUSE-EVENT'
 [void](Move-Ai $computer 4 $x $y);Assert ((Good $computer 'status').aiCursor.visible) 'AI-PRESERVE-SAME-LEASE-CAN-CONTINUE-ACTING'
 [void](Good $computer 'openPreview' @{sessionId='ordinary';url=($ownPreview+'ordinary');title='Own ordinary preview'})
 [void](Until {if(@((Fixture).webEvents|Where-Object {$_.kind -eq 'ready' -and $_.sid -eq 'ordinary'}).Count -eq 1){return $true}} 'Actual ordinary test page did not load' 10000)
 [void](Good $computer 'closePreview' @{sessionId='ordinary'});[void](Good $computer 'status')
 Assert (@($events|Where-Object {$_.event -eq 'previewClosed' -and $_.sessionId -eq 'ordinary'}).Count -eq 1) 'AI-ORDINARY-CLOSE-STILL-EMITS-EXACTLY-ONE-PAUSE-EVENT'
 [void](Move-Ai $computer 4 $x $y);$oldArrow=@(PointerWindows $computer)[0].handle;$tracked+=Track-Native;$computer.StandardInput.Close();Assert ($computer.WaitForExit(4000) -and  $computer.ExitCode -eq  0) 'AI-EOF-NATURAL-HELPER-EXIT'
 $active.Remove($computer.Id);Assert (![QytAiOracle]::IsWindow([IntPtr]$oldArrow)) 'AI-EOF-DESTROYS-DISPLAY-SURFACE'
 $computer=Start-Owned $Helper '--computer' 'computer-b';[void](Good $computer 'status');[void](Good $computer 'observe' @{targetId=$target.id;preview=$true});[void](Lease $computer 1);[void](Move-Ai $computer 1 $x $y)
 FixtureCommand 'exit';Assert ($fixture.WaitForExit(4000) -and  $fixture.ExitCode -eq  0) 'AI-TARGET-FIXTURE-NATURAL-CLOSE'
 [void](Until {if((PointerHidden $computer) -and  !(Good $computer 'status').aiCursor.visible){return $true}} 'Target close did not hide AI pointer')
 Assert $true 'AI-TARGET-CLOSE-HIDES-SURFACE';[void](Release $computer 1)
 $result=@{passed=$true;checks=$checks;architecture=$status.architecture;sessionId=$before.sessionId;actualOsInput=$true;mouseSource='native and independent Win32 SendInput OS-synthetic; not HID';physicalRaster='prlctl capture only own confirmed rectangle';events=$events.Count;sourceBoundary='Native HWND/driver matrix; no actual Harness Host or production preview-page UI lifecycle is claimed'}
}catch{$result=@{passed=$false;checks=$checks;error=$_.Exception.Message;trace=$_.ScriptStackTrace};Save 'failure-summary.json' $result;try{Save 'failure-windows.json' @{computerWindows=if($computer -and  !$computer.HasExited){[QytAiOracle]::Windows($computer.Id)}else{@()};nativeStatus=if($computer -and !$computer.HasExited){Good $computer 'status'}else{$null};desktop=[QytAiOracle]::DesktopState();fixture=if(Test-Path (Join-Path $Output 'fixture-state.json')){Fixture}else{$null}}}catch{}}
finally{
 try{$tracked+=Track-Native}catch{}
 foreach($child in $children){$p=$child.process;if($p.HasExited){continue};if($active.ContainsKey($p.Id)){try{[void](Release $p $active[$p.Id])}catch{}};try{if($p.StartInfo.RedirectStandardInput){$p.StandardInput.Close()}else{FixtureCommand 'exit'};[void]$p.WaitForExit(4000)}catch{};if(!$p.HasExited){$forced+=@{identity=$child.identity;role=$child.role};if([QytAiOracle]::Same($child.identity.pid,$child.identity.createdAtTicks,$child.identity.expectedExecutablePath)){$p.Kill();[void]$p.WaitForExit(2000)}}}
 $remaining=@();$clock=[Diagnostics.Stopwatch]::StartNew();do{$remaining=@();foreach($i in @($tracked|Sort-Object pid,createdAtTicks -Unique)){if([QytAiOracle]::Same($i.pid,$i.createdAtTicks,$i.expectedExecutablePath)){$remaining+=$i}};if($remaining.Count -eq  0){break};Start-Sleep -Milliseconds 100}while($clock.ElapsedMilliseconds -lt  5000)
 $after=[QytAiOracle]::DesktopState();$guardAfter=[QytAiOracle]::LeaseState();$result.cleanup=@{tracked=$tracked;forced=$forced;remaining=$remaining;desktop=$after;lease=$guardAfter;passed=($forced.Count -eq  0 -and  $remaining.Count -eq  0 -and  @($after.heldKeys).Count -eq  0 -and  $guardAfter.lockFree)}
 if(!$result.cleanup.passed){$result.passed=$false};Save 'after-desktop.json' @{desktop=$after;lease=$guardAfter};Save 'events.json' $events;Save 'report.json' $result
}
if(!$result.passed){exit 1}
