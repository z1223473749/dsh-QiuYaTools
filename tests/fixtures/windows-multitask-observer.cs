using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

// Test-only initial environment maintenance. No focus API, SendInput or ASFW.
public sealed class QytInitialTitlebarPolicy
{
    public readonly string Nonce; public readonly int X,Y; readonly long expires;
    public bool Armed,Finished,Foreign; public int Edges; public readonly List<object> MouseEdges=new List<object>();
    public QytInitialTitlebarPolicy(string nonce,int x,int y,long now,int budget){Guid.Parse(nonce);if(budget!=30000||now<0||now>Int64.MaxValue-budget)throw new InvalidOperationException("Setup budget changed");Nonce=nonce;X=x;Y=y;expires=now+budget;}
    public void Arm(long now){if(Armed||Finished||now>=expires)throw new InvalidOperationException("Setup stale or replayed");Armed=true;}
    public void ForeignEvent(){if(Armed&&!Finished)Foreign=true;}
    public void Mouse(int kind,int x,int y,uint flags,long now,Func<bool> current)
    {
        if(!Armed||Finished)return;
        if(Foreign||now>=expires||flags!=0||x!=X||y!=Y||kind!=0x0200&&kind!=0x0201&&kind!=0x0202){Foreign=true;return;}
        if(kind==0x0200){if(Edges>1)Foreign=true;return;}
        if((kind==0x0201&&Edges!=0)||(kind==0x0202&&Edges!=1)){Foreign=true;return;}
        bool valid=false;try{valid=current();}catch{Foreign=true;return;}if(!valid){Foreign=true;return;}
        MouseEdges.Add(new{kind=kind==0x0201?"down":"up",x=x,y=y,flags=flags,atMs=now,nonce=Nonce});Edges++;
    }
    public void Finish(long now){if(!Armed||Finished||Foreign||now>=expires||Edges!=2)throw new InvalidOperationException("Setup physical click unconfirmed");Finished=true;Armed=false;}
}
public static partial class WindowsMultitaskObserver
{
    delegate IntPtr QytSetupHook(int code,IntPtr message,IntPtr value);
    delegate void QytSetupEvent(IntPtr hook,uint evt,IntPtr hwnd,int objectId,int childId,uint thread,uint time);
    [StructLayout(LayoutKind.Sequential)]struct QytSetupMouse{public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra;}
    [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")]static extern IntPtr GetWindow(IntPtr hwnd,uint command);
    [DllImport("user32.dll")]static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll",SetLastError=true)]static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint msg,IntPtr wparam,IntPtr lparam,uint flags,uint timeout,out IntPtr result);
    [DllImport("user32.dll",SetLastError=true)]static extern IntPtr SetWindowsHookEx(int kind,QytSetupHook callback,IntPtr module,uint thread);
    [DllImport("user32.dll")]static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr value);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")]static extern bool PostThreadMessage(uint thread,uint message,IntPtr wparam,IntPtr lparam);
    [DllImport("user32.dll")]static extern IntPtr SetWinEventHook(uint first,uint last,IntPtr module,QytSetupEvent callback,uint pid,uint thread,uint flags);
    [DllImport("user32.dll")]static extern bool UnhookWinEvent(IntPtr hook);
    static readonly object setupSync=new object();static Thread setupHookWorker;static uint setupHookThread;static QytSetupHook setupMouseCallback,setupKeyCallback;static QytSetupEvent setupForegroundCallback,setupDesktopCallback;
    static IntPtr setupMouseHook,setupKeyHook,setupForegroundHook,setupDesktopHook;static readonly ManualResetEvent setupHookReady=new ManualResetEvent(false);static bool setupHookError,setupPrepared,setupEverBusinessArmed;
    static Dictionary<string,object> setupFixture;static Dictionary<string,object>[] setupNatives;static IntPtr setupWindow;static Rect setupRectangle;static Point setupPoint;static string setupRun,setupTitle;static QytInitialTitlebarPolicy setupPolicy;
    static long SetupNow(){return (long)(Stopwatch.GetTimestamp()*1000.0/Stopwatch.Frequency);}
    static bool SetupOverlap(int l,int t,int r,int b,Rect v){return l<v.Right&&r>v.Left&&t<v.Bottom&&b>v.Top;}
    static void SetupValidate(bool allowOwnLeft)
    {
        if(!setupPrepared||setupEverBusinessArmed||worker!=null||binding!=null||setupFixture==null||setupNatives==null||setupNatives.Length!=2)throw new InvalidOperationException("Setup is only initial unarmed environment maintenance");
        if(!Alive(setupFixture))throw new InvalidOperationException("Setup fixture identity changed");foreach(var native in setupNatives)if(!Alive(native))throw new InvalidOperationException("Setup native identity changed");
        uint owner;uint thread=GetWindowThreadProcessId(setupWindow,out owner);if(thread==0||owner!=Convert.ToUInt32(setupFixture["pid"])||!IsWindow(setupWindow)||!IsWindowVisible(setupWindow)||!IsWindowEnabled(setupWindow))throw new InvalidOperationException("Setup exact window changed");
        var title=new StringBuilder(512);GetWindowText(setupWindow,title,title.Capacity);if(title.ToString()!=setupTitle||!setupTitle.EndsWith(setupRun,StringComparison.Ordinal))throw new InvalidOperationException("Setup own nonce title changed");
        Rect rect;if(!GetWindowRect(setupWindow,out rect)||rect.Left!=setupRectangle.Left||rect.Top!=setupRectangle.Top||rect.Right!=setupRectangle.Right||rect.Bottom!=setupRectangle.Bottom)throw new InvalidOperationException("Setup window moved");
        if(Desktop(GetThreadDesktop(thread))!="Default"||Desktop(GetThreadDesktop(GetCurrentThreadId()))!="Default")throw new InvalidOperationException("Setup desktop changed");IntPtr input=OpenInputDesktop(0,false,1);try{if(Desktop(input)!="Default")throw new InvalidOperationException("Setup active desktop changed");}finally{if(input!=IntPtr.Zero)CloseDesktop(input);}
        for(int key=1;key<256;key++)if((GetAsyncKeyState(key)&0x8000)!=0&&!(allowOwnLeft&&key==1))throw new InvalidOperationException("Setup held foreign input");
        var codec=new JavaScriptSerializer();var lease=codec.Deserialize<Dictionary<string,object>>(codec.Serialize(Lease("Default")));if(!Convert.ToBoolean(lease["lockFree"])||Convert.ToBoolean(lease["journalPresent"]))throw new InvalidOperationException("Setup lease or journal present");
    }
    static object SetupGeometry()
    {
        int sw=GetSystemMetrics(78),sh=GetSystemMetrics(79);if(GetSystemMetrics(80)!=1||GetSystemMetrics(76)!=0||GetSystemMetrics(77)!=0||GetSystemMetrics(0)!=sw||GetSystemMetrics(1)!=sh)throw new InvalidOperationException("Setup single primary monitor required");
        var hit=WindowFromPoint(setupPoint);uint pid;GetWindowThreadProcessId(hit,out pid);IntPtr result;int x=setupPoint.X,y=setupPoint.Y;if(x<0||x>32767||y<0||y>32767||x>=sw||y>=sh||GetAncestor(hit,2)!=setupWindow||pid!=Convert.ToUInt32(setupFixture["pid"])||SendMessageTimeout(setupWindow,0x0084,IntPtr.Zero,new IntPtr((y<<16)|(x&65535)),2,100,out result)==IntPtr.Zero||result.ToInt64()!=2)throw new InvalidOperationException("Setup point is not exact unobscured caption");
        int l=x-96,t=y-16,r=x+96,b=y+16;if(l<setupRectangle.Left||t<setupRectangle.Top||r>setupRectangle.Right||b>setupRectangle.Bottom||l<0||t<0||r>sw||b>sh)throw new InvalidOperationException("Setup own ROI bounds changed");
        int count=0;var seen=new HashSet<IntPtr>();for(var other=GetWindow(setupWindow,3);other!=IntPtr.Zero;other=GetWindow(other,3)){if(++count>512||!seen.Add(other)||!IsWindow(other))throw new InvalidOperationException("Setup z-order unknown");if(!IsWindowVisible(other))continue;Rect bounds;if(!GetWindowRect(other,out bounds))throw new InvalidOperationException("Setup overlay geometry unknown");if(SetupOverlap(l,t,r,b,bounds))throw new InvalidOperationException("Setup ROI intersects foreign window");}
        foreach(var point in new[]{new Point{X=l,Y=t},new Point{X=r-1,Y=t},new Point{X=l,Y=b-1},new Point{X=r-1,Y=b-1}})if(GetAncestor(WindowFromPoint(point),2)!=setupWindow)throw new InvalidOperationException("Setup ROI obscured");
        return new{coordinateSpace="physical-primary-desktop-pixels",point=new{x=x,y=y},windowRect=new{left=setupRectangle.Left,top=setupRectangle.Top,right=setupRectangle.Right,bottom=setupRectangle.Bottom},screen=new{left=0,top=0,width=sw,height=sh,monitors=1},dpi=GetDpiForWindow(setupWindow),hitHwnd=hit.ToInt64().ToString(),hitRoot=setupWindow.ToInt64().ToString(),hitPid=pid,hitTest=2,visible=true,enabled=true,desktop="Default"};
    }
    static IntPtr SetupOnMouse(int code,IntPtr message,IntPtr pointer)
    {
        if(code>=0){var mouse=(QytSetupMouse)Marshal.PtrToStructure(pointer,typeof(QytSetupMouse));lock(setupSync){if(setupPolicy!=null)setupPolicy.Mouse(message.ToInt32(),mouse.X,mouse.Y,mouse.Flags,SetupNow(),delegate{SetupValidate(message.ToInt32()==0x0202);SetupGeometry();return true;});}}
        return CallNextHookEx(setupMouseHook,code,message,pointer);
    }
    static IntPtr SetupOnKey(int code,IntPtr message,IntPtr pointer){if(code>=0)lock(setupSync)if(setupPolicy!=null)setupPolicy.ForeignEvent();return CallNextHookEx(setupKeyHook,code,message,pointer);}
    static void SetupOnForeground(IntPtr hook,uint evt,IntPtr hwnd,int obj,int child,uint thread,uint time){lock(setupSync)if(setupPolicy!=null&&hwnd!=setupWindow)setupPolicy.ForeignEvent();}
    static void SetupOnDesktop(IntPtr hook,uint evt,IntPtr hwnd,int obj,int child,uint thread,uint time){lock(setupSync)if(setupPolicy!=null)setupPolicy.ForeignEvent();}
    static void SetupStartHooks()
    {
        setupHookWorker=new Thread(delegate(){if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero){setupHookError=true;setupHookReady.Set();return;}setupHookThread=GetCurrentThreadId();setupMouseCallback=SetupOnMouse;setupKeyCallback=SetupOnKey;setupForegroundCallback=SetupOnForeground;setupDesktopCallback=SetupOnDesktop;
            setupMouseHook=SetWindowsHookEx(14,setupMouseCallback,GetModuleHandle(null),0);setupKeyHook=SetWindowsHookEx(13,setupKeyCallback,GetModuleHandle(null),0);setupForegroundHook=SetWinEventHook(3,3,IntPtr.Zero,setupForegroundCallback,0,0,0);setupDesktopHook=SetWinEventHook(0x20,0x20,IntPtr.Zero,setupDesktopCallback,0,0,0);setupHookError=setupMouseHook==IntPtr.Zero||setupKeyHook==IntPtr.Zero||setupForegroundHook==IntPtr.Zero||setupDesktopHook==IntPtr.Zero;setupHookReady.Set();try{if(!setupHookError)Application.Run(new ApplicationContext());}finally{if(setupMouseHook!=IntPtr.Zero)UnhookWindowsHookEx(setupMouseHook);if(setupKeyHook!=IntPtr.Zero)UnhookWindowsHookEx(setupKeyHook);if(setupForegroundHook!=IntPtr.Zero)UnhookWinEvent(setupForegroundHook);if(setupDesktopHook!=IntPtr.Zero)UnhookWinEvent(setupDesktopHook);setupMouseHook=setupKeyHook=setupForegroundHook=setupDesktopHook=IntPtr.Zero;}});setupHookWorker.SetApartmentState(ApartmentState.STA);setupHookWorker.Start();if(!setupHookReady.WaitOne(3000)||setupHookError)throw new InvalidOperationException("Setup independent hooks unavailable");
    }
    static void SetupShutdown(){if(setupHookWorker!=null){if(setupHookThread!=0&&setupHookWorker.IsAlive)PostThreadMessage(setupHookThread,0x0012,IntPtr.Zero,IntPtr.Zero);if(!setupHookWorker.Join(3000))throw new InvalidOperationException("Setup hook thread did not retire");setupHookWorker=null;}}
    static object SetupPrepare(Dictionary<string,object> request)
    {
        if(setupPrepared||setupEverBusinessArmed||worker!=null||binding!=null)throw new InvalidOperationException("Setup initial preparation replayed");if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero)throw new InvalidOperationException("Setup physical DPI context unavailable");setupRun=Convert.ToString(request["runId"]);Guid.Parse(setupRun);setupFixture=(Dictionary<string,object>)request["fixture"];setupNatives=new[]{(Dictionary<string,object>)request["nativeA"],(Dictionary<string,object>)request["nativeB"]};setupTitle=Convert.ToString(request["title"]);setupWindow=new IntPtr(Int64.Parse(Convert.ToString(request["hwnd"])));if(!GetWindowRect(setupWindow,out setupRectangle))throw new InvalidOperationException("Setup rectangle unavailable");uint dpi=GetDpiForWindow(setupWindow);if(dpi<96||dpi>768)throw new InvalidOperationException("Setup DPI unknown");setupPoint=new Point{X=setupRectangle.Left+(setupRectangle.Right-setupRectangle.Left)/2,Y=setupRectangle.Top+(int)(16*dpi/96)};setupPrepared=true;SetupValidate(false);object geometry=SetupGeometry();byte[] png;
        using(var bitmap=new System.Drawing.Bitmap(192,32,System.Drawing.Imaging.PixelFormat.Format32bppArgb)){using(var graphics=System.Drawing.Graphics.FromImage(bitmap))graphics.CopyFromScreen(setupPoint.X-96,setupPoint.Y-16,0,0,new System.Drawing.Size(192,32),System.Drawing.CopyPixelOperation.SourceCopy);using(var stream=new MemoryStream()){bitmap.Save(stream,System.Drawing.Imaging.ImageFormat.Png);png=stream.ToArray();}}
        SetupValidate(false);geometry=SetupGeometry();string nonce=Guid.NewGuid().ToString("D");setupPolicy=new QytInitialTitlebarPolicy(nonce,setupPoint.X,setupPoint.Y,SetupNow(),30000);SetupStartHooks();string sha;using(var algorithm=SHA256.Create())sha=BitConverter.ToString(algorithm.ComputeHash(png)).Replace("-","").ToLowerInvariant();return new{runId=setupRun,nonce=nonce,hwnd=setupWindow.ToInt64().ToString(),fixture=setupFixture,nativeA=setupNatives[0],nativeB=setupNatives[1],title=setupTitle,geometry=geometry,preparedAtMs=SetupNow(),setupBudgetMs=30000,heldKeys=new int[0],leaseFree=true,journalAbsent=true,unarmed=true,initialMaintenanceOnly=true,physicalROI=new{source="GDI-CopyFromScreen-own-titlebar-region",left=setupPoint.X-96,top=setupPoint.Y-16,width=192,height=32,sha256=sha,pngBase64=Convert.ToBase64String(png)}};
    }
    static void SetupRequest(Dictionary<string,object> r){if(setupPolicy==null||Convert.ToString(r["runId"])!=setupRun||Convert.ToString(r["nonce"])!=setupPolicy.Nonce)throw new InvalidOperationException("Setup request nonce changed");}
    static object SetupArm(Dictionary<string,object> r){SetupRequest(r);SetupValidate(false);object geometry=SetupGeometry();lock(setupSync)setupPolicy.Arm(SetupNow());return new{runId=setupRun,nonce=setupPolicy.Nonce,armed=true,hookAvailable=setupMouseHook!=IntPtr.Zero&&setupKeyHook!=IntPtr.Zero,geometry=geometry,atMs=SetupNow()};}
    static object SetupState(Dictionary<string,object> r){SetupRequest(r);lock(setupSync)return new{runId=setupRun,nonce=setupPolicy.Nonce,armed=setupPolicy.Armed,foreign=setupPolicy.Foreign,edges=setupPolicy.Edges,atMs=SetupNow()};}
    static object SetupFinish(Dictionary<string,object> r){SetupRequest(r);object edges;lock(setupSync){SetupValidate(false);SetupGeometry();if(GetForegroundWindow()!=setupWindow)throw new InvalidOperationException("Setup exact A is not foreground");setupPolicy.Finish(SetupNow());edges=setupPolicy.MouseEdges.ToArray();}SetupShutdown();return new{runId=setupRun,nonce=setupPolicy.Nonce,verified=true,initialMaintenanceOnly=true,fixture=setupFixture,hwnd=setupWindow.ToInt64().ToString(),foreground=setupWindow.ToInt64().ToString(),edges=edges,heldKeys=new int[0],leaseFree=true,journalAbsent=true,unarmed=true,hookNaturallyRetired=true,atMs=SetupNow()};}
}

// Read-only, prewarmed OS oracle. It has no SendInput, focus, lease, or kill API.
public static partial class WindowsMultitaskObserver
{
    delegate bool EnumProc(IntPtr window,IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X,Y; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ProcessEntry { public uint Size,Usage,Pid; public IntPtr Heap; public uint Module,Threads,Parent; public int Priority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name; }
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr value);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr value);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr value);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr value,out Rect rectangle);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr value,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr value,StringBuilder text,int count);
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr value,int index);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point value);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr value,int index,StringBuilder text,int length,out int needed);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr value);
    [DllImport("kernel32.dll",SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeProcessHandle value,out long created,out long ended,out long kernel,out long user);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(SafeProcessHandle value,int flags,StringBuilder path,ref int size);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder path,uint size,uint flags);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(SafeProcessHandle value,uint milliseconds);
    [DllImport("kernel32.dll",EntryPoint="WaitForSingleObject",SetLastError=true)] static extern uint WaitForPinnedObject(IntPtr value,uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(int pid,out uint session);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr value);
    static readonly JavaScriptSerializer json=new JavaScriptSerializer { MaxJsonLength=4194304 };
    static readonly Dictionary<string,QytVerifiedProcessPin> pins=new Dictionary<string,QytVerifiedProcessPin>();
    static readonly object gate=new object(); static Thread worker; static volatile bool stop;
    [ThreadStatic] static object cleanupRead;
    [ThreadStatic] static string failureOperation,failureContext,failurePhase;
    [ThreadStatic] static int? failurePid,failureNativeError;
    [ThreadStatic] static uint? failureWait;
    static void FailurePhase(string phase,int? pid=null) { failurePhase=phase;failurePid=pid;failureWait=null;failureNativeError=null; }
    static uint IdentityWait(SafeProcessHandle handle) { uint value=WaitForSingleObject(handle,0);failureWait=value;if(value==0xffffffff)failureNativeError=Marshal.GetLastWin32Error();return value; }
    static object FailureFact(Exception error) { return new {operation=failureOperation,context=failureContext,phase=failurePhase,subjectPid=failurePid,exceptionType=error.GetType().Name,hresult=error.HResult,actualWait=failureWait,nativeError=failureNativeError}; }
    static Dictionary<string,object> binding; static object latest; static readonly List<object> samples=new List<object>();
    static string Desktop(IntPtr value) { var text=new StringBuilder(512);int needed;if(value==IntPtr.Zero||!GetUserObjectInformation(value,2,text,1024,out needed))throw new InvalidOperationException("Desktop unavailable");return text.ToString(); }
    static string Canonical(string path)
    {
        using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
            var canonical=new StringBuilder(32768);uint length=GetFinalPathNameByHandle(file.SafeFileHandle,canonical,(uint)canonical.Capacity,0);
            if(length==0||length>=canonical.Capacity)throw new InvalidOperationException("Canonical image unavailable");string result=canonical.ToString();
            if(result.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase))result=@"\\"+result.Substring(8);else if(result.StartsWith(@"\\?\",StringComparison.Ordinal))result=result.Substring(4);
            return Path.GetFullPath(result);
        }
    }
    static string InitialImageSHA(string path,string canonical)
    {
        using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
            var name=new StringBuilder(32768);uint length=GetFinalPathNameByHandle(file.SafeFileHandle,name,(uint)name.Capacity,0);if(length==0||length>=name.Capacity)throw new InvalidOperationException("Image canonical path unavailable");string actual=name.ToString();
            if(actual.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase))actual=@"\\"+actual.Substring(8);else if(actual.StartsWith(@"\\?\",StringComparison.Ordinal))actual=actual.Substring(4);
            if(!String.Equals(Path.GetFullPath(actual),canonical,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Image certificate path changed");long size=file.Length;if(size<1||size>268435456)throw new InvalidOperationException("Image certificate size unknown");
            using(var hash=SHA256.Create()){string value=BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant();if(file.Length!=size)throw new InvalidOperationException("Image certificate changed during read");return value;}
        }
    }
    static object Retired(Dictionary<string,object> expected)
    {
        int pid=Convert.ToInt32(expected["pid"]);if(pid<=0)throw new InvalidOperationException("Invalid expected process");
        using(var handle=OpenProcess(0x00101000,false,pid)) {
            if(handle.IsInvalid){int error=Marshal.GetLastWin32Error();if(error==87)return new {expected=expected,exactAlive=false,reason="pid-absent"};throw new InvalidOperationException("Process retirement unknown");}
            uint wait=WaitForSingleObject(handle,0);if(wait==0)return new {expected=expected,exactAlive=false,reason="pinned-object-signaled"};if(wait!=258)throw new InvalidOperationException("Process wait unknown");
            return QytPinnedRetirementPolicy.Query<object>(
                delegate { return WaitForSingleObject(handle,0); },
                delegate {
            long born,ended,kernel,user;if(!GetProcessTimes(handle,out born,out ended,out kernel,out user))throw new InvalidOperationException("Process birth unknown");
            string ticks=DateTime.FromFileTimeUtc(born).Ticks.ToString();if(ticks!=Convert.ToString(expected["createdAtTicks"]))return new {expected=expected,exactAlive=false,reason="pid-reused-different-birth"};
            var path=new StringBuilder(32768);int capacity=path.Capacity;uint session;if(!QueryFullProcessImageName(handle,0,path,ref capacity)||!ProcessIdToSessionId(pid,out session))throw new InvalidOperationException("Process identity unknown");
            string canonical=Canonical(path.ToString());if(!String.Equals(path.ToString(),Convert.ToString(expected["executablePath"]),StringComparison.OrdinalIgnoreCase)||session!=Convert.ToUInt32(expected["sessionId"])||expected.ContainsKey("canonicalExecutablePath")&&!String.Equals(canonical,Convert.ToString(expected["canonicalExecutablePath"]),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Process identity mismatch");
            return new {expected=expected,exactAlive=true,reason="exact-object-alive"};
                },
                delegate { return new {expected=expected,exactAlive=false,reason="pinned-object-signaled-after-query"}; });
        }
    }
    static Dictionary<string,object> Identity(int pid)
    { lock(pins) { return IdentityLocked(pid); } }
    static Dictionary<string,object> IdentityLocked(int pid)
    {
        FailurePhase("identity-open",pid);var handle=OpenProcess(0x00101000,false,pid);bool keep=false;
        try {
            if(handle.IsInvalid){failureNativeError=Marshal.GetLastWin32Error();throw new InvalidOperationException("Process unavailable");}FailurePhase("identity-initial-wait",pid);if(IdentityWait(handle)!=258)throw new InvalidOperationException("Process unavailable");
            FailurePhase("identity-birth",pid);long born,ended,kernel,user;if(!GetProcessTimes(handle,out born,out ended,out kernel,out user)){failureNativeError=Marshal.GetLastWin32Error();throw new InvalidOperationException("Birth unavailable");}
            FailurePhase("identity-image",pid);var path=new StringBuilder(32768);int size=path.Capacity;uint session;
            if(!QueryFullProcessImageName(handle,0,path,ref size)||!ProcessIdToSessionId(pid,out session)){failureNativeError=Marshal.GetLastWin32Error();throw new InvalidOperationException("Identity unavailable");}
            FailurePhase("identity-canonical",pid);var value=new Dictionary<string,object>{{"pid",pid},{"createdAtTicks",DateTime.FromFileTimeUtc(born).Ticks.ToString()},{"executablePath",path.ToString()},{"canonicalExecutablePath",Canonical(path.ToString())},{"sessionId",session}};
            string key=Key(value);QytVerifiedProcessPin existing;if(pins.TryGetValue(key,out existing)){FailurePhase("identity-existing-pin",pid);if(!existing.Matches(value,false)||existing.ReadState(delegate(IntPtr original){uint state=WaitForPinnedObject(original,0);failureWait=state;if(state==0xffffffff)failureNativeError=Marshal.GetLastWin32Error();return state;})!=258)throw new InvalidOperationException("Existing pin identity changed");FailurePhase("identity-existing-current-wait",pid);if(IdentityWait(handle)!=258)throw new InvalidOperationException("Identity pin retired");FailurePhase("identity-terminal",pid);return existing.CopyCertificate();}
            FailurePhase("identity-pin-bound",pid);if(pins.Count>=512)throw new InvalidOperationException("Pin bound exceeded");FailurePhase("identity-image-sha",pid);value["imageSHA256"]=InitialImageSHA(path.ToString(),Convert.ToString(value["canonicalExecutablePath"]));FailurePhase("identity-new-final-wait",pid);if(IdentityWait(handle)!=258)throw new InvalidOperationException("Identity pin retired during certificate");var verified=new QytVerifiedProcessPin(handle,value);pins.Add(key,verified);keep=true;FailurePhase("identity-terminal",pid);return verified.CopyCertificate();
        } finally {if(!keep)handle.Dispose();}
    }
    static string Key(Dictionary<string,object> value) {return value["pid"]+":"+value["createdAtTicks"]+":"+Convert.ToString(value["executablePath"]).ToLowerInvariant();}
    static bool Alive(Dictionary<string,object> value)
    { lock(pins) { return AliveLocked(value); } }
    static bool AliveLocked(Dictionary<string,object> value)
    {
        QytVerifiedProcessPin pin;if(!pins.TryGetValue(Key(value),out pin)||!pin.Matches(value,true))throw new InvalidOperationException("Identity was never pinned or certificate changed");
        return QytPinnedAlivePolicy.Read(
            delegate { return pin.ReadState(delegate(IntPtr original){return WaitForPinnedObject(original,0);}); },
            delegate { return Key(Identity(Convert.ToInt32(value["pid"])))==Key(value); });
    }
    static bool CleanupAlive(Dictionary<string,object> value)
    {
        lock(pins) {
            string phase="pin-lookup";QytVerifiedProcessPin pin=null;uint? actualWait=null;bool sameHandle=false;int? nativeError=null;
            try {
                if(!pins.TryGetValue(Key(value),out pin))throw new InvalidOperationException("Identity was never pinned");phase="certificate";if(!pin.Matches(value,true))throw new InvalidOperationException("Pinned certificate mismatch");phase="handle-reference";
                uint state=pin.ReadState(delegate(IntPtr original){phase="same-handle-wait";sameHandle=true;uint result=WaitForPinnedObject(original,0);actualWait=result;if(result==0xffffffff)nativeError=Marshal.GetLastWin32Error();return result;});
                cleanupRead=new{operation="cleanup-alive",phase="terminal",exceptionType=(string)null,hresult=(int?)null,actualSameHandleWait=actualWait,sameOriginalHandle=sameHandle,certificateSHA256=pin.Digest,nativeError=nativeError};return state==258;
            }catch(Exception error){cleanupRead=new{operation="cleanup-alive",phase=phase,exceptionType=error.GetType().Name,hresult=(int?)error.HResult,actualSameHandleWait=actualWait,sameOriginalHandle=sameHandle,certificateSHA256=pin==null?null:pin.Digest,nativeError=nativeError};throw;}
        }
    }
    static object[] Windows(int pid)
    {
        var rows=new List<object>();EnumWindows(delegate(IntPtr hwnd,IntPtr unused){uint owner;GetWindowThreadProcessId(hwnd,out owner);if(owner!=(uint)pid)return true;
            Rect r;if(!GetWindowRect(hwnd,out r))throw new InvalidOperationException("Window geometry unavailable");var text=new StringBuilder(512);GetWindowText(hwnd,text,text.Capacity);
            rows.Add(new {hwnd=hwnd.ToInt64().ToString(),pid=pid,title=text.ToString(),visible=IsWindowVisible(hwnd),enabled=IsWindowEnabled(hwnd),exStyle=GetWindowLongPtr(hwnd,-20).ToInt64(),dpi=GetDpiForWindow(hwnd),x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top});return true;},IntPtr.Zero);return rows.ToArray();
    }
    static object Lease(string desktop)
    {
        string scope;using(var sha=SHA256.Create()){scope=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Process.GetCurrentProcess().SessionId+":"+desktop))).Replace("-","").Substring(0,24);}
        string directory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"QiuYaTools","computer-lease",scope),lockFile=Path.Combine(directory,"desktop.lock"),journal=Path.Combine(directory,"owned-input.json");bool free=true;
        if(File.Exists(lockFile))try{using(var file=new FileStream(lockFile,FileMode.Open,FileAccess.Read,FileShare.None)) {}}catch(IOException){free=false;}
        object record=null;bool present=File.Exists(journal);
        if(present)try{using(var file=new FileStream(journal,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))using(var reader=new StreamReader(file)) {var raw=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(reader.ReadToEnd()); record=new {ownerId=Convert.ToString(raw["OwnerId"])};}}catch(IOException){throw new InvalidOperationException("Journal snapshot unknown");}
        return new {lockFree=free,journalPresent=present,journal=record};
    }
    static object Snapshot()
    {
        long before=Stopwatch.GetTimestamp();string thread=Desktop(GetThreadDesktop(GetCurrentThreadId()));IntPtr input=OpenInputDesktop(0,false,1);string active="";try{if(input!=IntPtr.Zero)active=Desktop(input);}finally{if(input!=IntPtr.Zero)CloseDesktop(input);}
        var held=new List<int>();for(int key=1;key<256;key++)if((GetAsyncKeyState(key)&0x8000)!=0)held.Add(key);Point cursor;if(!GetCursorPos(out cursor))throw new InvalidOperationException("Cursor unavailable");
        var screen=SystemInformation.VirtualScreen;object[] windows=new object[0];bool nativeAlive=false,fixtureAlive=false;
        if(binding!=null){var native=(Dictionary<string,object>)binding["native"];var fixture=(Dictionary<string,object>)binding["fixture"];failureContext="snapshot-native";nativeAlive=Alive(native);failureContext="snapshot-fixture";fixtureAlive=Alive(fixture);windows=Windows(Convert.ToInt32(native["pid"]));}
        return new {beforeTicks=before.ToString(),ticks=Stopwatch.GetTimestamp().ToString(),frequency=Stopwatch.Frequency,sessionId=Process.GetCurrentProcess().SessionId,userInteractive=Environment.UserInteractive,activeDesktopAccessible=input!=IntPtr.Zero,activeDesktopMatches=active==thread,heldKeys=held.ToArray(),foreground=GetForegroundWindow().ToInt64().ToString(),cursor=new{x=cursor.X,y=cursor.Y},screen=new{x=screen.X,y=screen.Y,width=screen.Width,height=screen.Height},lease=Lease(thread),nativeAlive=nativeAlive,fixtureAlive=fixtureAlive,windows=windows};
    }
    static void EndSampling() {stop=true;if(worker!=null&&!worker.Join(3000))throw new InvalidOperationException("Observer thread did not retire");worker=null;}
    static object Descendants(int root)
    {
        FailurePhase("tree-snapshot",root);var parents=new Dictionary<int,int>();var handle=CreateToolhelp32Snapshot(2,0);if(handle==new IntPtr(-1)){failureNativeError=Marshal.GetLastWin32Error();throw new InvalidOperationException("Process tree unavailable");}
        try {var entry=new ProcessEntry();entry.Size=(uint)Marshal.SizeOf(typeof(ProcessEntry));FailurePhase("tree-first",root);if(!Process32First(handle,ref entry)){failureNativeError=Marshal.GetLastWin32Error();throw new InvalidOperationException("Process tree empty");}do {parents[(int)entry.Pid]=(int)entry.Parent;FailurePhase("tree-next",root);}while(Process32Next(handle,ref entry));}finally{CloseHandle(handle);}
        var owned=new HashSet<int>{root};var rows=new List<object>();bool changed;
        do {changed=false;foreach(var pair in parents)if(owned.Contains(pair.Value)&&!owned.Contains(pair.Key)){FailurePhase("tree-bound",pair.Key);if(owned.Count>=256)throw new InvalidOperationException("Tree bound exceeded");failureContext="descendants-child";var identity=Identity(pair.Key);identity["parentPid"]=pair.Value;failureContext="descendants-parent";identity["parentCreatedAtTicks"]=Identity(pair.Value)["createdAtTicks"];rows.Add(identity);owned.Add(pair.Key);changed=true;}}while(changed);FailurePhase("tree-terminal",root);return rows.ToArray();
    }
    [STAThread] public static void Main()
    {
        Console.SetIn(new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false)));Console.SetOut(new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false)){AutoFlush=true});SetThreadDpiAwarenessContext(new IntPtr(-4));Console.WriteLine(json.Serialize(new{@event="ready",identity=Identity(Process.GetCurrentProcess().Id),systemConsolePath=Canonical(Path.Combine(Environment.SystemDirectory,"conhost.exe"))}));
        try {string line;while((line=Console.ReadLine())!=null){if(line.Length>32768)throw new InvalidOperationException("Request bound exceeded");var r=json.Deserialize<Dictionary<string,object>>(line);object value;cleanupRead=null;
            try {string op=Convert.ToString(r["op"]);failureOperation=Array.IndexOf(new[]{"setupPrepare","setupArm","setupState","setupFinish","identity","retired","alive","descendants","windows","snapshot","arm","latest","finish"},op)>=0?op:"unknown";failureContext="dispatch";FailurePhase("dispatch");
                if(op=="setupPrepare")value=SetupPrepare(r);
                else if(op=="setupArm")value=SetupArm(r);
                else if(op=="setupState")value=SetupState(r);
                else if(op=="setupFinish")value=SetupFinish(r);
                else if(op=="identity")value=Identity(Convert.ToInt32(r["pid"]));
                else if(op=="retired")value=Retired((Dictionary<string,object>)r["identity"]);
                else if(op=="alive")value=new {alive=CleanupAlive((Dictionary<string,object>)r["identity"])};
                else if(op=="descendants")value=Descendants(Convert.ToInt32(r["pid"]));
                else if(op=="windows")value=Windows(Convert.ToInt32(r["pid"]));
                else if(op=="snapshot")value=Snapshot();
                else if(op=="arm"){if(setupPrepared&&(setupPolicy==null||!setupPolicy.Finished))throw new InvalidOperationException("Setup has not been independently verified");setupEverBusinessArmed=true;EndSampling();binding=(Dictionary<string,object>)r["binding"];lock(gate){samples.Clear();latest=null;}stop=false;worker=new Thread(delegate(){SetThreadDpiAwarenessContext(new IntPtr(-4));var clock=Stopwatch.StartNew();while(!stop&&clock.ElapsedMilliseconds<5000){object sample;try{sample=Snapshot();}catch(Exception error){sample=new{error=error.GetType().Name};}lock(gate){latest=sample;if(samples.Count<512)samples.Add(sample);}Thread.Sleep(4);}}){IsBackground=true};worker.Start();value=new{armed=true};}
                else if(op=="latest"){lock(gate)value=latest;}
                else if(op=="finish"){EndSampling();lock(gate)value=new{samples=samples.ToArray()};}
                else throw new InvalidOperationException("Unknown observer operation");
                Console.WriteLine(json.Serialize(new{requestId=r["requestId"],ok=true,result=value,read=cleanupRead}));
            } catch(Exception error) {Console.WriteLine(json.Serialize(new{requestId=r["requestId"],ok=false,error=error.GetType().Name,read=cleanupRead,failure=FailureFact(error)}));}Console.Out.Flush();}
        } catch(Exception error){Console.Error.WriteLine(error.GetType().Name);Environment.ExitCode=1;}
        finally {try{EndSampling();}finally{try{SetupShutdown();}finally{foreach(var pin in pins.Values)pin.Dispose();}}}
    }
}

// Test-only synchronous identity/retirement policy. Zero-time waits only; no retry,
// process signal, deadline renewal or PID-only disappearance inference.
public static class QytPinnedAlivePolicy
{
    public static bool Read(Func<uint> waitPinned, Func<bool> queryExactIdentity)
    {
        if(waitPinned==null||queryExactIdentity==null)throw new ArgumentNullException();
        uint initial=waitPinned();
        if(initial==0)return false;
        if(initial!=258)throw new InvalidOperationException("Pinned wait unknown");
        bool matches;
        try { matches=queryExactIdentity(); }
        catch {
            // The exact original SafeProcessHandle stays held by the caller.
            // Only an explicitly signaled original object resolves the query race.
            if(waitPinned()==0)return false;
            throw;
        }
        if(matches)return true;
        if(waitPinned()==0)return false;
        throw new InvalidOperationException("Identity changed while exact pinned process retirement remains unknown");
    }
}

// Test-only fresh-retirement query fence. The same original SafeProcessHandle
// remains held by Retired. A failed identity read is unknown unless it signals.
public static class QytPinnedRetirementPolicy
{
    public static T Query<T>(Func<uint> waitPinned, Func<T> queryIdentity, Func<T> signaledRetirement)
    {
        if(waitPinned==null||queryIdentity==null||signaledRetirement==null)throw new ArgumentNullException();
        try { return queryIdentity(); }
        catch {
            if(waitPinned()==0)return signaledRetirement();
            throw;
        }
    }
}

// Test-only certificate and wait policy. The actual SafeHandle object is retained
// from successful initial identity pin until observer EOF; no PID lookup occurs here.
public sealed class QytVerifiedProcessPin : IDisposable
{
    readonly SafeHandle originalHandle;
    readonly Dictionary<string,object> certificate;
    readonly string digest;
    static readonly string[] Fields={"pid","createdAtTicks","executablePath","canonicalExecutablePath","imageSHA256","sessionId"};
    public QytVerifiedProcessPin(SafeHandle handle, Dictionary<string,object> identity)
    {
        if(handle==null||handle.IsClosed||handle.IsInvalid)throw new InvalidOperationException("Pinned handle unavailable");
        if(identity==null)throw new ArgumentNullException("identity");
        certificate=new Dictionary<string,object>();foreach(string field in Fields){object value;if(!identity.TryGetValue(field,out value))throw new InvalidOperationException("Incomplete pin certificate");certificate.Add(field,value);}
        string born=Convert.ToString(certificate["createdAtTicks"]),hash=Convert.ToString(certificate["imageSHA256"]);
        if(Convert.ToInt32(certificate["pid"])<=0||Convert.ToUInt32(certificate["sessionId"])==0||born.Length!=18||hash.Length!=64||String.IsNullOrEmpty(Convert.ToString(certificate["executablePath"]))||String.IsNullOrEmpty(Convert.ToString(certificate["canonicalExecutablePath"])))throw new InvalidOperationException("Invalid pin certificate");
        foreach(char c in born)if(c<'0'||c>'9')throw new InvalidOperationException("Invalid pin birth");foreach(char c in hash)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))throw new InvalidOperationException("Invalid pin image hash");
        using(var sha=SHA256.Create()){string value=String.Join("\0",new[]{Convert.ToString(certificate["pid"]),born,Convert.ToString(certificate["executablePath"]).ToLowerInvariant(),Convert.ToString(certificate["canonicalExecutablePath"]).ToLowerInvariant(),hash,Convert.ToString(certificate["sessionId"])});digest=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-","").ToLowerInvariant();}
        originalHandle=handle;
    }
    public string Digest {get{return digest;}}
    public SafeHandle OriginalHandle {get{return originalHandle;}}
    public Dictionary<string,object> CopyCertificate(){return new Dictionary<string,object>(certificate);}
    public bool Matches(Dictionary<string,object> expected,bool requireHash)
    {
        try {if(expected==null)return false;foreach(string field in Fields){if(field=="imageSHA256"&&!requireHash)continue;object value;if(!expected.TryGetValue(field,out value))return false;
            if(field=="pid"){if(Convert.ToInt32(value)!=Convert.ToInt32(certificate[field]))return false;}
            else if(field=="sessionId"){if(Convert.ToUInt32(value)!=Convert.ToUInt32(certificate[field]))return false;}
            else if(!String.Equals(Convert.ToString(value),Convert.ToString(certificate[field]),field=="executablePath"||field=="canonicalExecutablePath"?StringComparison.OrdinalIgnoreCase:StringComparison.Ordinal))return false;
        }return true;}catch{return false;}
    }
    public uint ReadState(Func<IntPtr,uint> wait)
    {
        if(wait==null)throw new ArgumentNullException("wait");if(originalHandle.IsClosed||originalHandle.IsInvalid)throw new InvalidOperationException("Pinned handle closed or invalid");
        uint state;bool reference=false;try{originalHandle.DangerousAddRef(ref reference);if(originalHandle.IsClosed||originalHandle.IsInvalid)throw new InvalidOperationException("Pinned handle closed before wait");state=wait(originalHandle.DangerousGetHandle());if(originalHandle.IsClosed)throw new InvalidOperationException("Pinned handle closed during wait");if(state!=0&&state!=258)throw new InvalidOperationException("Pinned handle wait unknown");}
        finally{if(reference)originalHandle.DangerousRelease();}
        if(originalHandle.IsClosed||originalHandle.IsInvalid)throw new InvalidOperationException("Pinned handle closed after wait");return state;
    }
    public void Dispose(){originalHandle.Dispose();}
}
