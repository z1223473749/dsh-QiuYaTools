# Explicit fixture-user activation; never alter the system foreground-lock policy.
param([Parameter(Mandatory=$true)][string]$WindowId,[Parameter(Mandatory=$true)][string]$ProfileRoot)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$parts=$WindowId.Split(':');if($parts.Length -ne 4 -or $parts[0] -ne 'window'){throw 'Invalid fixture target'}
$target=Get-Process -Id ([int]$parts[2]);$handle=[IntPtr]([Convert]::ToInt64($parts[1],16))
if($target.StartTime.ToUniversalTime().Ticks -ne [long]$parts[3] -or -not $target.Path.StartsWith($ProfileRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Activation must stay inside the disposable fixture profile'}
Add-Type @'
using System;using System.Runtime.InteropServices;
public class QytFixtureActivation {
 [StructLayout(LayoutKind.Sequential)]struct Rect{public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)]struct Point{public int X,Y;}
 [StructLayout(LayoutKind.Sequential)]struct MouseInput{public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra;}
 [StructLayout(LayoutKind.Sequential)]struct Input{public uint Type;public MouseInput Mouse;}
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int z,uint flags);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
 [DllImport("user32.dll")]static extern bool SetPhysicalCursorPos(int x,int y);
 [DllImport("user32.dll",SetLastError=true)]static extern uint SendInput(uint n,Input[] input,int size);
 public static object Activate(IntPtr h) {
  Rect bounds;if(!GetWindowRect(h,out bounds))throw new Exception("Fixture target disappeared");
  bool top=(GetWindowLongPtr(h,-20).ToInt64()&8)!=0;long before=GetForegroundWindow().ToInt64();
  int x=(bounds.Left+bounds.Right)/2,y=bounds.Top+15;
  try {
   if(!SetWindowPos(h,new IntPtr(-1),0,0,0,0,1|2|16))throw new Exception("Could not uncover fixture titlebar");
   System.Threading.Thread.Sleep(100);
   if(GetAncestor(WindowFromPoint(new Point{X=x,Y=y}),2)!=h)throw new Exception("Another window covers the fixture titlebar; no input sent");
   if(!SetPhysicalCursorPos(x,y))throw new Exception("Could not position fixture mouse");
   var input=new[]{new Input{Mouse=new MouseInput{Flags=2}},new Input{Mouse=new MouseInput{Flags=4}}};
   if(SendInput(2,input,Marshal.SizeOf<Input>())!=2)throw new Exception("Fixture activation click failed");
   for(int n=0;n<20&&GetForegroundWindow()!=h;n++)System.Threading.Thread.Sleep(50);
   if(GetForegroundWindow()!=h)throw new Exception("User fixture click did not activate its own target");
   return new{active=true,targetHandle=h.ToInt64(),foregroundBefore=before,foregroundAfter=GetForegroundWindow().ToInt64(),x,y,source="Win32 SendInput OS-synthetic user-preflight click; not Parallels hardware"};
  }finally{SetWindowPos(h,new IntPtr(top?-1:-2),0,0,0,0,1|2|16);}
 }
}
'@
[QytFixtureActivation]::Activate($handle)|ConvertTo-Json -Compress
