# Explicit fixture-user activation; never alter the system foreground-lock policy.
param([Parameter(Mandatory=$true)][string]$WindowId,[Parameter(Mandatory=$true)][string]$ProfileRoot,[string]$DiagnosticPath='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$parts=$WindowId.Split(':');if($parts.Length -ne 4 -or $parts[0] -ne 'window'){throw 'Invalid fixture target'}
$target=Get-Process -Id ([int]$parts[2]);$handle=[IntPtr]([Convert]::ToInt64($parts[1],16))
if($target.StartTime.ToUniversalTime().Ticks -ne [long]$parts[3] -or -not $target.Path.StartsWith($ProfileRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Activation must stay inside the disposable fixture profile'}
Add-Type @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class QytFixtureActivation {
 [StructLayout(LayoutKind.Sequential)]struct Rect{public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)]struct Point{public int X,Y;}
 [StructLayout(LayoutKind.Sequential)]struct MonitorInfo{public int Size;public Rect Monitor,Work;public uint Flags;}
 [StructLayout(LayoutKind.Sequential)]struct LastInput{public uint Size,Time;}
 [StructLayout(LayoutKind.Sequential)]struct MouseInput{public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra;}
 [StructLayout(LayoutKind.Sequential)]struct Input{public uint Type;public MouseInput Mouse;}
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll",SetLastError=true)]static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int z,uint flags);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool GetMonitorInfo(IntPtr h,ref MonitorInfo info);
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")]static extern IntPtr WindowFromPhysicalPoint(Point p);
 [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")]static extern IntPtr GetWindow(IntPtr h,uint command);
 [DllImport("user32.dll")]static extern IntPtr GetLastActivePopup(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder text,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder text,int count);
 [DllImport("user32.dll")]static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")]static extern uint GetDpiForSystem();
 [DllImport("user32.dll")]static extern IntPtr GetThreadDpiAwarenessContext();
 [DllImport("user32.dll")]static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll")]static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder text,uint size,out uint needed);
 [DllImport("user32.dll")]static extern IntPtr GetThreadDesktop(uint thread);
 [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")]static extern bool GetLastInputInfo(ref LastInput info);
 [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")]static extern int FrameBounds(IntPtr h,int attribute,out Rect value,int size);
 [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")]static extern int Cloaked(IntPtr h,int attribute,out int value,int size);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
 [DllImport("user32.dll")]static extern bool SetPhysicalCursorPos(int x,int y);
 [DllImport("user32.dll",SetLastError=true)]static extern uint SendInput(uint n,Input[] input,int size);
 public static Dictionary<string,object> Diagnostics=new Dictionary<string,object>();
 static string DesktopName(IntPtr h){uint needed;var name=new StringBuilder(256);return GetUserObjectInformation(h,2,name,512,out needed)?name.ToString():"";}
 static object Desktop(){var input=OpenInputDesktop(0,false,1);int error=input==IntPtr.Zero?Marshal.GetLastWin32Error():0;string name=input==IntPtr.Zero?"":DesktopName(input);if(input!=IntPtr.Zero)CloseDesktop(input);var last=new LastInput{Size=(uint)Marshal.SizeOf<LastInput>()};bool known=GetLastInputInfo(ref last);return new{inputDesktop=name,inputDesktopError=error,threadDesktop=DesktopName(GetThreadDesktop(GetCurrentThreadId())),idleMs=known?(long)unchecked((uint)Environment.TickCount-last.Time):-1,session=System.Diagnostics.Process.GetCurrentProcess().SessionId};}
 static object Rectangle(Rect r){return new{x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top};}
 static object Window(IntPtr h){
  uint pid;uint thread=GetWindowThreadProcessId(h,out pid);var title=new StringBuilder(512);var cls=new StringBuilder(256);GetWindowText(h,title,512);GetClassName(h,cls,256);
  Rect r,frame;bool rectOk=GetWindowRect(h,out r);int frameResult=FrameBounds(h,9,out frame,Marshal.SizeOf<Rect>()),cloaked;int cloakResult=Cloaked(h,14,out cloaked,4);
  return new{hwnd=h.ToInt64(),pid,thread,owner=GetWindow(h,4).ToInt64(),enabledPopup=GetWindow(h,6).ToInt64(),lastActivePopup=GetLastActivePopup(h).ToInt64(),title=title.ToString(),windowClass=cls.ToString(),rectOk,rect=Rectangle(r),physicalFrameResult=frameResult,physicalFrame=Rectangle(frame),visible=IsWindowVisible(h),enabled=IsWindowEnabled(h),iconic=IsIconic(h),cloakResult,cloaked,dpi=GetDpiForWindow(h),style=GetWindowLongPtr(h,-16).ToInt64(),extendedStyle=GetWindowLongPtr(h,-20).ToInt64()};
 }
 static void Record(string stage,IntPtr h,int x,int y){
  var hit=WindowFromPhysicalPoint(new Point{X=x,Y=y});var root=GetAncestor(hit,2);
  Diagnostics[stage]=new{target=Window(h),point=new{x,y},hit=Window(root),foreground=Window(GetForegroundWindow()),above=Window(GetWindow(h,3)),below=Window(GetWindow(h,2)),activePopup=Window(GetLastActivePopup(h)),systemDpi=GetDpiForSystem(),threadDpiContext=GetThreadDpiAwarenessContext().ToInt64(),threadAwareness=GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()),desktop=Desktop()};
 }
 static Rect RequireTarget(IntPtr h,int expectedPid,long expectedBorn) {
  uint pid;GetWindowThreadProcessId(h,out pid);
  if(pid!=expectedPid)throw new Exception("Own fixture identity changed");
  using(var process=System.Diagnostics.Process.GetProcessById(expectedPid))if(process.StartTime.ToUniversalTime().Ticks!=expectedBorn)throw new Exception("Own fixture process changed");
  Rect r;int cloaked;
  if(!GetWindowRect(h,out r)||!IsWindowVisible(h)||!IsWindowEnabled(h)||IsIconic(h)||Cloaked(h,14,out cloaked,4)!=0||cloaked!=0)throw new Exception("Own fixture is unavailable for a visible titlebar click");
  return r;
 }
 static bool ExposedTitlePoint(IntPtr h,int expectedPid,long expectedBorn,List<object> attempts,string stage,object placement,out int x,out int y) {
  var r=RequireTarget(h,expectedPid,expectedBorn);double scale=Math.Max(1,GetDpiForWindow(h)/96.0);
  int left=r.Left+(int)Math.Ceiling(48*scale),right=r.Right-(int)Math.Ceiling(160*scale);
  y=r.Top+(int)Math.Round(15*scale);x=0;
  if(right<left)throw new Exception("Own fixture has no safe titlebar segment");
  var xs=new List<int>{(left+right)/2,left,right};
  for(int candidate=left;candidate<right;candidate+=(int)Math.Ceiling(32*scale))xs.Add(candidate);
  var seen=new HashSet<int>();var points=new List<object>();bool exposed=false;
  foreach(int candidate in xs){
   if(!seen.Add(candidate))continue;
   var root=GetAncestor(WindowFromPhysicalPoint(new Point{X=candidate,Y=y}),2);bool own=root==h;
   points.Add(new{x=candidate,y,matchedOwnTarget=own,hit=Window(root)});
   if(own){x=candidate;exposed=true;break;}
  }
  attempts.Add(new{stage,bounds=Rectangle(r),placement,points,exposed});return exposed;
 }
 public static object Activate(IntPtr h,int expectedPid,long expectedBorn) {
  var priorDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
  if(priorDpi==IntPtr.Zero)throw new Exception("Could not use physical coordinates for this fixture thread");
  try{return ActivatePhysical(h,expectedPid,expectedBorn);}
  finally{SetThreadDpiAwarenessContext(priorDpi);}
 }
 static object ActivatePhysical(IntPtr h,int expectedPid,long expectedBorn) {
  var original=RequireTarget(h,expectedPid,expectedBorn);int width=original.Right-original.Left,height=original.Bottom-original.Top;
  bool top=(GetWindowLongPtr(h,-20).ToInt64()&8)!=0;long before=GetForegroundWindow().ToInt64();
  int x=(original.Left+original.Right)/2,y=original.Top+15;bool restored=false;int restoreError=0;
  var attempts=new List<object>();Diagnostics["titlebarAttempts"]=attempts;Diagnostics["originalBounds"]=Rectangle(original);
  Record("before",h,x,y);
  try {
   bool exposed=ExposedTitlePoint(h,expectedPid,expectedBorn,attempts,"original",null,out x,out y);
   if(!exposed){
    var monitor=MonitorFromWindow(h,2);var info=new MonitorInfo{Size=Marshal.SizeOf<MonitorInfo>()};
    if(monitor==IntPtr.Zero||!GetMonitorInfo(monitor,ref info))throw new Exception("Could not inspect the own fixture monitor working area");
    Diagnostics["workingArea"]=Rectangle(info.Work);
    if(width>info.Work.Right-info.Work.Left||height>info.Work.Bottom-info.Work.Top)throw new Exception("Own fixture cannot retain its size inside this monitor working area");
    var candidates=new[]{new Point{X=info.Work.Left,Y=info.Work.Top},new Point{X=info.Work.Right-width,Y=info.Work.Top},new Point{X=info.Work.Left,Y=info.Work.Bottom-height},new Point{X=info.Work.Right-width,Y=info.Work.Bottom-height}};
    var seen=new HashSet<string>();int attempt=0;
    foreach(var candidate in candidates){
     if(!seen.Add(candidate.X+":"+candidate.Y))continue;
     RequireTarget(h,expectedPid,expectedBorn);
     // Only this profile-bound Alpha moves. Preserve size and z-order and do not activate it.
     const uint flags=0x0001|0x0004|0x0010|0x0200;
     bool moved=SetWindowPos(h,IntPtr.Zero,candidate.X,candidate.Y,0,0,flags);int error=moved?0:Marshal.GetLastWin32Error();
     System.Threading.Thread.Sleep(100);
     var current=RequireTarget(h,expectedPid,expectedBorn);
     var placement=new{requestedX=candidate.X,requestedY=candidate.Y,requestedInsertAfter=0,flags,callResult=moved,win32Error=error,currentExtendedStyle=GetWindowLongPtr(h,-20).ToInt64()};
     if(current.Right-current.Left!=width||current.Bottom-current.Top!=height)throw new Exception("Own fixture size changed during safe placement");
     exposed=ExposedTitlePoint(h,expectedPid,expectedBorn,attempts,"corner-"+(++attempt),placement,out x,out y);
     if(exposed)break;
    }
   }
   Diagnostics["boundsAfterSetup"]=Rectangle(RequireTarget(h,expectedPid,expectedBorn));Record("afterSetup",h,x,y);
   if(!exposed||GetAncestor(WindowFromPhysicalPoint(new Point{X=x,Y=y}),2)!=h)throw new Exception("No exposed own fixture titlebar point; no input sent");
   if(!SetPhysicalCursorPos(x,y))throw new Exception("Could not position fixture mouse");
   var input=new[]{new Input{Mouse=new MouseInput{Flags=2}},new Input{Mouse=new MouseInput{Flags=4}}};
   uint sent=SendInput(2,input,Marshal.SizeOf<Input>());Diagnostics["activationInputCount"]=sent;
   if(sent!=2)throw new Exception("Fixture activation click failed");
   for(int n=0;n<20&&GetForegroundWindow()!=h;n++)System.Threading.Thread.Sleep(50);
   if(GetForegroundWindow()!=h)throw new Exception("User fixture click did not activate its own target");
  }finally{
   restored=SetWindowPos(h,new IntPtr(top?-1:-2),0,0,0,0,1|2|16);restoreError=restored?0:Marshal.GetLastWin32Error();
   Diagnostics["restore"]=new{callResult=restored,win32Error=restoreError,originalTopmost=top};Record("afterRestore",h,x,y);
   if(!restored)throw new Exception("Could not restore own fixture z-order: Win32="+restoreError);
   if(((GetWindowLongPtr(h,-20).ToInt64()&8)!=0)!=top)throw new Exception("The own fixture topmost state was not restored");
  }
  return new{active=true,targetHandle=h.ToInt64(),foregroundBefore=before,foregroundAfter=GetForegroundWindow().ToInt64(),topmostBefore=top,restoreCallResult=restored,restoreWin32Error=restoreError,topmostAfter=(GetWindowLongPtr(h,-20).ToInt64()&8)!=0,originalBounds=Rectangle(original),boundsAfterSetup=Rectangle(RequireTarget(h,expectedPid,expectedBorn)),x,y,source="Win32 SendInput OS-synthetic user-preflight click; not Parallels hardware"};
 }

}
'@
try{$result=[QytFixtureActivation]::Activate($handle,$target.Id,[long]$parts[3])}catch{
 if($DiagnosticPath){[IO.File]::WriteAllText($DiagnosticPath,(@{error=$_.Exception.Message;observations=[QytFixtureActivation]::Diagnostics}|ConvertTo-Json -Depth 10 -Compress))}
 throw
}
if($DiagnosticPath){[IO.File]::WriteAllText($DiagnosticPath,(@{observations=[QytFixtureActivation]::Diagnostics}|ConvertTo-Json -Depth 10 -Compress))}
$result|ConvertTo-Json -Compress
