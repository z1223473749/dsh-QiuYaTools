# Bounded, read-only first-show oracle. Start before the preview-open click.
# The only process inspected is the --computer child of this disposable profile.
param([Parameter(Mandatory=$true)][string]$ProfileRoot,
 [Parameter(Mandatory=$true)][string]$ReadyPath,
 [Parameter(Mandatory=$true)][string]$OutputPath,
 [ValidateRange(100,10000)][int]$DurationMs=8000)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$started=[DateTime]::UtcNow.ToString('o')
$result=@{kind='read-only profile-bound Win32 timeline; no UIA/hooks/window mutation/input/lease/act';status='failed';startedAt=$started}
try {
 $candidates=@(Get-CimInstance Win32_Process -Filter "Name='qiuya-windows.exe'" | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($ProfileRoot+'\',[StringComparison]::OrdinalIgnoreCase) -and
  $_.CommandLine -match '(?:^|\s)--computer(?:\s|$)'
 })
 if($candidates.Count -ne 1){throw "Expected one disposable-profile computer child, found $($candidates.Count)"}
 $process=Get-Process -Id $candidates[0].ProcessId
 $identity=@{pid=$process.Id;startTicks=$process.StartTime.ToUniversalTime().Ticks;path=$process.Path;sha256=(Get-FileHash -LiteralPath $process.Path -Algorithm SHA256).Hash.ToLowerInvariant();session=$process.SessionId}
 if($identity.session -ne [System.Diagnostics.Process]::GetCurrentProcess().SessionId){throw 'The monitor and computer child must share the interactive session'}
 $result.process=$identity
 Add-Type @'
using System;using System.Text;using System.Collections.Generic;using System.Diagnostics;using System.Runtime.InteropServices;
public class QytWindowTimeline {
 delegate bool EnumProc(IntPtr h,IntPtr data);
 [StructLayout(LayoutKind.Sequential)]struct Rect{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")]static extern bool EnumWindows(EnumProc proc,IntPtr data);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder text,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder text,int count);
 [DllImport("kernel32.dll",EntryPoint="SetLastError")]static extern void ClearError(uint error);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW",SetLastError=true)]static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
 [DllImport("user32.dll")]static extern IntPtr GetWindow(IntPtr h,uint command);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out Rect rect);
 static Dictionary<string,object> Window(IntPtr h){
  uint pid;uint thread=GetWindowThreadProcessId(h,out pid);var title=new StringBuilder(512);var cls=new StringBuilder(256);GetWindowText(h,title,512);GetClassName(h,cls,256);
  ClearError(0);uint style=unchecked((uint)GetWindowLongPtr(h,-16).ToInt64());int styleError=Marshal.GetLastWin32Error();
  ClearError(0);uint exstyle=unchecked((uint)GetWindowLongPtr(h,-20).ToInt64());int exstyleError=Marshal.GetLastWin32Error();Rect r;bool rectOk=GetWindowRect(h,out r);
  return new Dictionary<string,object>{{"hwnd",h.ToInt64().ToString("x")},{"pid",pid},{"thread",thread},{"title",title.ToString()},{"windowClass",cls.ToString()},{"styleHex",style.ToString("x")},{"styleError",styleError},{"extendedStyleHex",exstyle.ToString("x")},{"extendedStyleError",exstyleError},{"topmost",(exstyle&8)!=0},{"visible",IsWindowVisible(h)},{"enabled",IsWindowEnabled(h)},{"iconic",IsIconic(h)},{"rectOk",rectOk},{"x",r.Left},{"y",r.Top},{"width",r.Right-r.Left},{"height",r.Bottom-r.Top}};
 }
 public static Dictionary<string,object> Poll(uint pid,long born,int durationMs,Action ready){
  using(var bound=Process.GetProcessById((int)pid)){
  if(bound.StartTime.ToUniversalTime().Ticks!=born)throw new Exception("Computer child identity changed before the timeline");
  var changes=new List<object>();var previous=new Dictionary<string,string>();var clock=Stopwatch.StartNew();int samples=0;double largestGap=0,lastSample=0;ready();
  while(clock.ElapsedMilliseconds<durationMs){
   if(bound.HasExited)throw new Exception("Computer child exited during the timeline");
   double at=clock.Elapsed.TotalMilliseconds;if(samples>0)largestGap=Math.Max(largestGap,at-lastSample);lastSample=at;samples++;
   var handles=new List<IntPtr>();EnumWindows((h,d)=>{uint actual;GetWindowThreadProcessId(h,out actual);if(actual==pid){var title=new StringBuilder(512);GetWindowText(h,title,512);if(title.ToString().Contains("\u7535\u8111\u64cd\u63a7"))handles.Add(h);}return true;},IntPtr.Zero);
   var present=new HashSet<string>();foreach(var h in handles){var window=Window(h);string id=(string)window["hwnd"];present.Add(id);var owner=GetWindow(h,4);var owners=new List<object>();var seen=new HashSet<IntPtr>();while(owner!=IntPtr.Zero&&owners.Count<8&&seen.Add(owner)){owners.Add(Window(owner));owner=GetWindow(owner,4);}var foreground=Window(GetForegroundWindow());
    // Include all sampled state, but exclude timestamps from change detection.
    var state=new Dictionary<string,object>{{"window",window},{"owners",owners.ToArray()},{"foreground",foreground}};string signature=Signature(state);
    string prior;if(!previous.TryGetValue(id,out prior)||signature!=prior){changes.Add(new Dictionary<string,object>{{"utc",DateTime.UtcNow.ToString("o")},{"elapsedMs",clock.Elapsed.TotalMilliseconds},{"event",previous.ContainsKey(id)?"changed":"first-seen"},{"state",state}});previous[id]=signature;}
   }
   foreach(var id in new List<string>(previous.Keys)){if(!present.Contains(id)){changes.Add(new Dictionary<string,object>{{"utc",DateTime.UtcNow.ToString("o")},{"elapsedMs",clock.Elapsed.TotalMilliseconds},{"event","no-longer-enumerated"},{"hwnd",id}});previous.Remove(id);}}
   System.Threading.Thread.Sleep(10);
  }
  return new Dictionary<string,object>{{"sampleIntervalMs",10},{"sampleCount",samples},{"elapsedMs",clock.Elapsed.TotalMilliseconds},{"largestSampleGapMs",largestGap},{"changes",changes.ToArray()}};
  }
 }
 static string Signature(object value){
  var dict=value as Dictionary<string,object>;if(dict!=null){var parts=new List<string>();foreach(var pair in dict)parts.Add(pair.Key+":"+Signature(pair.Value));return "{"+string.Join("|",parts)+"}";}
  var array=value as object[];if(array!=null){var parts=new List<string>();foreach(var item in array)parts.Add(Signature(item));return "["+string.Join("|",parts)+"]";}return Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture);
 }
}
'@
 $ready=[Action]{[IO.File]::WriteAllText($ReadyPath+'.tmp',(@{status='ready';at=[DateTime]::UtcNow.ToString('o');process=$identity}|ConvertTo-Json -Depth 4 -Compress));[IO.File]::Move($ReadyPath+'.tmp',$ReadyPath)}
 $result.timeline=[QytWindowTimeline]::Poll([uint32]$process.Id,[long]$identity.startTicks,$DurationMs,$ready)
 $again=Get-Process -Id $process.Id
 if($again.StartTime.ToUniversalTime().Ticks -ne $identity.startTicks){throw 'Computer child identity changed during the timeline'}
 $result.status='diagnostic'
} catch {$result.error=$_.Exception.Message}
finally {$result.finishedAt=[DateTime]::UtcNow.ToString('o');[IO.File]::WriteAllText($OutputPath,($result|ConvertTo-Json -Depth 12 -Compress))}
if($result.status -ne 'diagnostic'){throw $result.error}
