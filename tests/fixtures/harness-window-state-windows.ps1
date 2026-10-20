# Read-only Win32 oracle. Do not initialize UIAutomation or change window state.
param([Parameter(Mandatory=$true)][string]$WindowId,[Parameter(Mandatory=$true)][string]$ProfileRoot)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$parts=$WindowId.Split(':');if($parts.Length -ne 4 -or $parts[0] -ne 'window'){throw 'Invalid fixture target'}
$process=Get-Process -Id ([int]$parts[2]);$handle=[IntPtr]([Convert]::ToInt64($parts[1],16))
if($process.StartTime.ToUniversalTime().Ticks -ne [long]$parts[3] -or -not $process.Path.StartsWith($ProfileRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Readonly state must stay inside the disposable fixture profile'}
Add-Type @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class QytReadonlyWindow {
 [StructLayout(LayoutKind.Sequential)]struct Rect{public int Left,Top,Right,Bottom;}
 [DllImport("kernel32.dll",EntryPoint="SetLastError")]static extern void ClearError(uint code);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW",SetLastError=true)]static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")]static extern IntPtr GetWindow(IntPtr h,uint command);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")]static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder text,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder text,int count);
 [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")]static extern int FrameBounds(IntPtr h,int attribute,out Rect value,int size);
 [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")]static extern int Cloaked(IntPtr h,int attribute,out int value,int size);
 static object Window(IntPtr h){
  uint pid;uint thread=GetWindowThreadProcessId(h,out pid);var title=new StringBuilder(512);var cls=new StringBuilder(256);GetWindowText(h,title,512);GetClassName(h,cls,256);
  ClearError(0);uint style=unchecked((uint)GetWindowLongPtr(h,-16).ToInt64());int styleError=Marshal.GetLastWin32Error();
  ClearError(0);uint exstyle=unchecked((uint)GetWindowLongPtr(h,-20).ToInt64());int exstyleError=Marshal.GetLastWin32Error();
  Rect r,frame;bool rectOk=GetWindowRect(h,out r);int frameResult=FrameBounds(h,9,out frame,Marshal.SizeOf<Rect>()),cloaked;int cloakResult=Cloaked(h,14,out cloaked,4);
  return new{hwnd=h.ToInt64().ToString("x"),pid,thread,title=title.ToString(),windowClass=cls.ToString(),style,styleHex=style.ToString("x"),styleError,extendedStyle=exstyle,extendedStyleHex=exstyle.ToString("x"),extendedStyleError=exstyleError,topmost=(exstyle&8)!=0,visible=IsWindowVisible(h),enabled=IsWindowEnabled(h),iconic=IsIconic(h),cloaked,cloakResult,dpi=GetDpiForWindow(h),rectOk,rect=new{x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top},physicalFrameResult=frameResult,physicalFrame=new{x=frame.Left,y=frame.Top,width=frame.Right-frame.Left,height=frame.Bottom-frame.Top}};
 }
 public static object Read(IntPtr h,uint expectedPid){
  uint pid;GetWindowThreadProcessId(h,out pid);if(pid!=expectedPid)throw new Exception("Readonly target HWND identity changed");
  var owners=new List<object>();var seen=new HashSet<IntPtr>();var owner=GetWindow(h,4);
  while(owner!=IntPtr.Zero&&owners.Count<8&&seen.Add(owner)){owners.Add(Window(owner));owner=GetWindow(owner,4);}
  return new{window=Window(h),owners=owners.ToArray(),foreground=Window(GetForegroundWindow()),above=Window(GetWindow(h,3)),below=Window(GetWindow(h,2)),session=System.Diagnostics.Process.GetCurrentProcess().SessionId,kind="read-only Win32; no UIA/SetWindowPos/ShowWindow/SendInput/lease/act"};
 }
}
'@
$state=[QytReadonlyWindow]::Read($handle,[uint32]$process.Id)
$hash=Get-FileHash -LiteralPath $process.Path -Algorithm SHA256
@{windowId=$WindowId;observedAt=[DateTime]::UtcNow.ToString('o');process=@{pid=$process.Id;startTicks=$process.StartTime.ToUniversalTime().Ticks;path=$process.Path;sha256=$hash.Hash.ToLowerInvariant()};state=$state}|ConvertTo-Json -Depth 10 -Compress
