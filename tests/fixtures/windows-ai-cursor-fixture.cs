using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class QytAiOracle
{
    public delegate bool EnumCallback(IntPtr window, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; public Point(int x,int y){X=x;Y=y;} }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback,IntPtr data);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rectangle);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window,StringBuilder text,int size);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window,StringBuilder text,int size);
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr window,int index);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window,uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window,uint flags);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPhysicalPoint(Point point);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr window,out uint affinity);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool QueryFullProcessImageName(IntPtr process,int flags,StringBuilder path,ref int size);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern Microsoft.Win32.SafeHandles.SafeProcessHandle OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetProcessTimes(Microsoft.Win32.SafeHandles.SafeProcessHandle process,out long created,out long exit,out long kernel,out long user);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern uint WaitForSingleObject(Microsoft.Win32.SafeHandles.SafeProcessHandle process,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool ProcessIdToSessionId(int pid,out uint session);
    private static readonly Dictionary<string,Microsoft.Win32.SafeHandles.SafeProcessHandle> pins=new Dictionary<string,Microsoft.Win32.SafeHandles.SafeProcessHandle>(StringComparer.OrdinalIgnoreCase);
    private static string PinKey(int pid,string ticks,string executable){return pid+":"+ticks+":"+executable;}
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr value,int index,StringBuilder text,int length,out int needed);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count,Input[] inputs,int size);
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type;public InputUnion Data; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public Mouse Mouse;[FieldOffset(0)] public Keyboard Keyboard; }
    [StructLayout(LayoutKind.Sequential)] private struct Mouse { public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct Keyboard { public ushort Key,Scan;public uint Flags,Time;public UIntPtr Extra; }
    public static object Identity(int pid)
    {
        var handle=OpenProcess(0x00101000,false,pid);bool kept=false;
        try{if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());if(Retired(handle))throw new InvalidOperationException("Process retired before identity capture");long born,ended,kernel,user;if(!GetProcessTimes(handle,out born,out ended,out kernel,out user))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());var path=new StringBuilder(32768);int size=path.Capacity;if(!QueryFullProcessImageName(handle.DangerousGetHandle(),0,path,ref size))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());uint session;if(!ProcessIdToSessionId(pid,out session))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());string ticks=DateTime.FromFileTimeUtc(born).Ticks.ToString(),executable=path.ToString(),key=PinKey(pid,ticks,executable);lock(pins){if(!pins.ContainsKey(key)){if(pins.Count>=512)throw new InvalidOperationException("Own process pin budget exceeded");pins.Add(key,handle);kept=true;}}return new{pid=pid,createdAtTicks=ticks,expectedExecutablePath=executable,sessionId=session};}finally{if(!kept)handle.Dispose();}
    }
    public static object ReadFixture(string path)
    {
        var clock=Stopwatch.StartNew();while(true){try{using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))using(var reader=new StreamReader(file)){return new JavaScriptSerializer().DeserializeObject(reader.ReadToEnd());}}catch(IOException){if(clock.ElapsedMilliseconds>=5000)throw;System.Threading.Thread.Sleep(10);}}
    }
    public static bool Same(int pid,string ticks,string executable)
    {
        if(pid<=0||String.IsNullOrEmpty(ticks)||String.IsNullOrEmpty(executable))throw new InvalidOperationException("Pinned process identity is incomplete");
        Microsoft.Win32.SafeHandles.SafeProcessHandle handle;lock(pins){if(!pins.TryGetValue(PinKey(pid,ticks,executable),out handle))throw new InvalidOperationException("Process was not pinned during identity capture");}
        {
            if(Retired(handle))return false;
            long born,ended,kernel,user;if(!GetProcessTimes(handle,out born,out ended,out kernel,out user)){int error=Marshal.GetLastWin32Error();if(Retired(handle))return false;throw new System.ComponentModel.Win32Exception(error);}
            if(DateTime.FromFileTimeUtc(born).Ticks.ToString()!=ticks)return false;
            var path=new StringBuilder(32768);int size=path.Capacity;
            if(!QueryFullProcessImageName(handle.DangerousGetHandle(),0,path,ref size)){int error=Marshal.GetLastWin32Error();if(Retired(handle))return false;throw new System.ComponentModel.Win32Exception(error);}
            if(!String.Equals(path.ToString(),executable,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Pinned live process image changed");
            return !Retired(handle);
        }
    }
    private static bool Retired(Microsoft.Win32.SafeHandles.SafeProcessHandle handle){uint result=WaitForSingleObject(handle,0);if(result==0)return true;if(result==258)return false;throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
    public static object[] Windows(int expectedPid)
    {
        var result=new List<object>();
        EnumWindows(delegate(IntPtr handle,IntPtr unused){uint pid;GetWindowThreadProcessId(handle,out pid);if(pid!=(uint)expectedPid)return true;
            Rect r;GetWindowRect(handle,out r);var title=new StringBuilder(512);GetWindowText(handle,title,title.Capacity);var cls=new StringBuilder(256);GetClassName(handle,cls,cls.Capacity);uint affinity;var affinityOk=GetWindowDisplayAffinity(handle,out affinity);
            result.Add(new{handle=handle.ToInt64(),pid=pid,title=title.ToString(),windowClass=cls.ToString(),x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top,visible=IsWindowVisible(handle),enabled=IsWindowEnabled(handle),style=GetWindowLongPtr(handle,-16).ToInt64(),exStyle=GetWindowLongPtr(handle,-20).ToInt64(),owner=GetWindow(handle,4).ToInt64(),foreground=GetForegroundWindow().ToInt64(),dpi=GetDpiForWindow(handle),affinityOk=affinityOk,affinity=affinity});return true;},IntPtr.Zero);
        return result.ToArray();
    }
    public static object DesktopState()
    {
        var thread=new StringBuilder(512);int needed;GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()),2,thread,1024,out needed);
        var input=OpenInputDesktop(0,false,1);var active=new StringBuilder(512);bool accessible=input!=IntPtr.Zero;
        if(accessible){GetUserObjectInformation(input,2,active,1024,out needed);CloseDesktop(input);}
        var held=new List<int>();for(int key=1;key<256;key++)if((GetAsyncKeyState(key)&0x8000)!=0)held.Add(key);
        Point cursor;GetCursorPos(out cursor);var screen=SystemInformation.VirtualScreen;
        return new{sessionId=Process.GetCurrentProcess().SessionId,userInteractive=Environment.UserInteractive,threadDesktop=thread.ToString(),activeDesktop=active.ToString(),activeDesktopAccessible=accessible,heldKeys=held.ToArray(),foreground=GetForegroundWindow().ToInt64(),cursor=new{x=cursor.X,y=cursor.Y},screen=new{x=screen.X,y=screen.Y,width=screen.Width,height=screen.Height}};
    }
    public static object LeaseState()
    {
        var desktop=new StringBuilder(512);int needed;if(!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()),2,desktop,1024,out needed))throw new InvalidOperationException("Own desktop unavailable");
        var identity=Process.GetCurrentProcess().SessionId+":"+desktop;string hash;using(var sha=SHA256.Create()){hash=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-","").Substring(0,24);}
        var directory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"QiuYaTools","computer-lease",hash);var lockFile=Path.Combine(directory,"desktop.lock");var journal=Path.Combine(directory,"owned-input.json");bool free=true;
        if(File.Exists(lockFile)){try{using(var handle=new FileStream(lockFile,FileMode.Open,FileAccess.Read,FileShare.None)){} }catch(IOException){free=false;}}
        object record=null;if(File.Exists(journal)){using(var file=new FileStream(journal,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))using(var reader=new StreamReader(file)){var value=(Dictionary<string,object>)new JavaScriptSerializer().DeserializeObject(reader.ReadToEnd());var keys=value["Keys"] as object[];var mouse=value["MouseButtons"] as object[];var unicode=value["UnicodeUnits"] as object[];if(keys==null||mouse==null||unicode==null||Convert.ToInt32(value["Version"])!=1)throw new InvalidOperationException("Lease journal cannot be summarized safely");record=new{Version=1,OwnerId=Convert.ToString(value["OwnerId"]),KeyCount=keys.Length,MouseCount=mouse.Length,UnicodeCount=unicode.Length};}}
        return new{lockFree=free,journal=record,scope=hash};
    }
    public static object Hit(int x,int y)
    {
        var physical=WindowFromPhysicalPoint(new Point(x,y));var logical=WindowFromPoint(new Point(x,y));var root=GetAncestor(physical,2);uint pid;GetWindowThreadProcessId(root,out pid);
        return new{x=x,y=y,physical=physical.ToInt64(),logical=logical.ToInt64(),root=root.ToInt64(),pid=pid};
    }
    public static void CopyScreen(int x,int y,int width,int height,string output)
    {
        using(var bitmap=new Bitmap(width,height,PixelFormat.Format24bppRgb)){using(var drawing=Graphics.FromImage(bitmap)){drawing.CopyFromScreen(x,y,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);}bitmap.Save(output,ImageFormat.Png);}
    }
    public static object KnownBackground(string path,int expectedR,int expectedG,int expectedB)
    {
        int incorrect=0,black=0,white=0;using(var bitmap=new Bitmap(path)){for(int y=0;y<bitmap.Height;y++)for(int x=0;x<bitmap.Width;x++){var p=bitmap.GetPixel(x,y);if(p.R!=expectedR||p.G!=expectedG||p.B!=expectedB)incorrect++;if(p.R<8&&p.G<8&&p.B<8)black++;if(p.R>230&&p.G>230&&p.B>230)white++;}return new{width=bitmap.Width,height=bitmap.Height,pixels=bitmap.Width*bitmap.Height,incorrect=incorrect,black=black,white=white};}
    }
    public static object NativeRegion(string base64,int x,int y,int width,int height,string output)
    {
        using(var stream=new MemoryStream(Convert.FromBase64String(base64)))using(var source=new Bitmap(stream))using(var crop=source.Clone(new Rectangle(x,y,width,height),PixelFormat.Format24bppRgb)){
            int incorrect=0,black=0,white=0;for(int yy=0;yy<height;yy++)for(int xx=0;xx<width;xx++){var p=crop.GetPixel(xx,yy);if(Math.Abs(p.R-37)>3||Math.Abs(p.G-113)>3||Math.Abs(p.B-151)>3)incorrect++;if(p.R<8&&p.G<8&&p.B<8)black++;if(p.R>230&&p.G>230&&p.B>230)white++;}
            crop.Save(output,ImageFormat.Png);return new{width=width,height=height,incorrect=incorrect,black=black,white=white,jpegColorTolerance=3};
        }
    }
    public static object ClickOwn(int pid,string born,string executable,long window,int x,int y)
    {return OwnInput(pid,born,executable,window,x,y,true);}
    public static object MoveOwn(int pid,string born,string executable,long window,int x,int y)
    {return OwnInput(pid,born,executable,window,x,y,false);}
    private static object OwnInput(int pid,string born,string executable,long window,int x,int y,bool click)
    {
        if(!Same(pid,born,executable))throw new InvalidOperationException("Own fixture process changed");var hwnd=new IntPtr(window);uint actualPid;GetWindowThreadProcessId(hwnd,out actualPid);
        if(actualPid!=(uint)pid||GetForegroundWindow()!=hwnd)throw new InvalidOperationException("Own fixture is not foreground");
        var point=WindowFromPhysicalPoint(new Point(x,y));if(GetAncestor(point,2)!=hwnd)throw new InvalidOperationException("Own opaque arrow test point does not physically hit fixture");
        for(int key=1;key<256;key++)if((GetAsyncKeyState(key)&0x8000)!=0)throw new InvalidOperationException("Input already held");
        var screen=SystemInformation.VirtualScreen;int dx=(int)Math.Round((x-screen.Left)*65535.0/Math.Max(1,screen.Width-1));int dy=(int)Math.Round((y-screen.Top)*65535.0/Math.Max(1,screen.Height-1));
        var packets=new[]{new Input{Type=0,Data=new InputUnion{Mouse=new Mouse{X=dx,Y=dy,Flags=0xC001}}},new Input{Type=0,Data=new InputUnion{Mouse=new Mouse{Flags=2}}},new Input{Type=0,Data=new InputUnion{Mouse=new Mouse{Flags=4}}}};
        Point before,after;GetCursorPos(out before);long beforeTicks=Stopwatch.GetTimestamp();uint expected=click?3u:1u;var count=SendInput(expected,packets,Marshal.SizeOf(typeof(Input)));long afterTicks=Stopwatch.GetTimestamp();GetCursorPos(out after);if(count!=expected)throw new InvalidOperationException("Own click injection refused");
        return new{x=x,y=y,packets=count,inputStructureBytes=Marshal.SizeOf(typeof(Input)),absoluteX=dx,absoluteY=dy,before=new{x=before.X,y=before.Y},immediateAfter=new{x=after.X,y=after.Y},beforeTicks=beforeTicks,afterTicks=afterTicks,frequency=Stopwatch.Frequency,source="Win32 SendInput OS-synthetic; not physical HID"};
    }
}

public sealed class QytAiFixture : Form
{
    private readonly string root,title;private readonly Timer timer=new Timer();private readonly JavaScriptSerializer json=new JavaScriptSerializer();private Form other;private int clicks,sequence;private string last="";
    private readonly TcpListener listener=new TcpListener(IPAddress.Loopback,0);private readonly List<object> webEvents=new List<object>();private readonly object webGate=new object();private System.Threading.Thread server;private volatile bool retiring;private int port;
    public QytAiFixture(string root,string title)
    {
        this.root=root;this.title=title;Text=title;StartPosition=FormStartPosition.Manual;Location=new System.Drawing.Point(100,100);ClientSize=new Size(720,520);FormBorderStyle=FormBorderStyle.FixedSingle;MaximizeBox=false;BackColor=Color.FromArgb(37,113,151);DoubleBuffered=true;
        other=new Form{Text=title+" focus",StartPosition=FormStartPosition.Manual,Location=new System.Drawing.Point(900,160),Size=new Size(280,220),BackColor=Color.FromArgb(161,93,51)};
        listener.Start();port=((IPEndPoint)listener.LocalEndpoint).Port;server=new System.Threading.Thread(Serve){IsBackground=true};server.Start();
        MouseDown+=delegate{clicks++;Save();};Activated+=delegate{Save();};Deactivate+=delegate{Save();};Shown+=delegate{Activate();Save();};FormClosing+=delegate{Save();};FormClosed+=delegate{retiring=true;listener.Stop();timer.Stop();other.Close();};
        timer.Interval=20;timer.Tick+=Tick;timer.Start();
    }
    protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);using(var light=new SolidBrush(Color.FromArgb(232,220,99)))e.Graphics.FillRectangle(light,20,20,60,40);using(var dark=new SolidBrush(Color.FromArgb(56,39,108)))e.Graphics.FillRectangle(dark,100,20,60,40);}
    private void Tick(object sender,EventArgs args)
    {
        var path=Path.Combine(root,"fixture-command.txt");if(!File.Exists(path))return;string command;try{command=File.ReadAllText(path);}catch(IOException){return;}if(command==last)return;last=command;var parts=command.Split('|');int next;if(parts.Length!=2||!int.TryParse(parts[0],out next)||next<=sequence)return;sequence=next;
        if(parts[1]=="activate"){other.Hide();Activate();QytAiOracle.SetForegroundWindow(Handle);}
        else if(parts[1]=="focus-other"){other.Show();other.Activate();QytAiOracle.SetForegroundWindow(other.Handle);}
        else if(parts[1]=="exit"){Close();return;}
        Save();
    }
    private void Save()
    {
        object[] observed;lock(webGate){observed=webEvents.ToArray();}
        var current=Process.GetCurrentProcess();var data=new{pid=current.Id,createdAtTicks=current.StartTime.ToUniversalTime().Ticks.ToString(),expectedExecutablePath=current.MainModule.FileName,title=title,handle=IsHandleCreated?Handle.ToInt64():0,clicks=clicks,sequence=sequence,foreground=QytAiOracle.GetForegroundWindow().ToInt64(),x=Left,y=Top,width=Width,height=Height,clientX=PointToScreen(System.Drawing.Point.Empty).X,clientY=PointToScreen(System.Drawing.Point.Empty).Y,knownColor=new{r=37,g=113,b=151},port=port,webEvents=observed};
        string destination=Path.Combine(root,"fixture-state.json"),temporary=destination+".tmp";try{File.WriteAllText(temporary,json.Serialize(data));if(File.Exists(destination))File.Replace(temporary,destination,null);else File.Move(temporary,destination);}catch(IOException){}
    }
    private void Serve()
    {
        while(!retiring){try{using(var client=listener.AcceptTcpClient()){client.ReceiveTimeout=3000;client.SendTimeout=3000;using(var stream=client.GetStream()){
            var header=new StringBuilder();while(header.Length<8192){int next=stream.ReadByte();if(next<0)break;header.Append((char)next);if(header.ToString().EndsWith("\r\n\r\n",StringComparison.Ordinal))break;}
            int contentLength=0;foreach(var field in header.ToString().Split('\n'))if(field.StartsWith("Content-Length:",StringComparison.OrdinalIgnoreCase)){if(!int.TryParse(field.Substring(15).Trim(),out contentLength)||contentLength<0||contentLength>1024)throw new IOException("Own HTTP body bound exceeded");}
            for(int index=0;index<contentLength;index++)if(stream.ReadByte()<0)throw new IOException("Own HTTP body ended early");
            var line=header.ToString().Split('\n')[0].Trim().Split(' ');var request=line.Length>1?new Uri("http://127.0.0.1"+line[1]):null;var body="ok";
            if(request!=null){var sid=request.Query.StartsWith("?sid=",StringComparison.Ordinal)?Uri.UnescapeDataString(request.Query.Substring(5)):"";if(!System.Text.RegularExpressions.Regex.IsMatch(sid,"^[a-z0-9-]{1,40}$"))throw new IOException("Unknown own test SID");
                if(request.AbsolutePath=="/preview"){
                    var encoded=new JavaScriptSerializer().Serialize(sid);body="<!doctype html><meta charset=utf-8><title>Owned preview test</title><p>Own preview lifecycle</p><script>const sid="+encoded+";let preserved=false;Object.defineProperty(window,'__qytPreserveSessionOnClose',{get:()=>preserved,set:v=>{if(v===true){const r=new XMLHttpRequest();r.open('POST','/preserve-ack?sid='+encodeURIComponent(sid),false);r.send('1');if(r.status!==200)throw Error('own ACK failed');}preserved=v;}});fetch('/ready?sid='+encodeURIComponent(sid));</script>";
                }else if(request.AbsolutePath=="/ready"||request.AbsolutePath=="/preserve-ack"){
                    lock(webGate){webEvents.Add(new{kind=request.AbsolutePath.Substring(1),sid=sid,at=DateTime.UtcNow.ToString("o")});}
                    if(!retiring)BeginInvoke((Action)Save);
                }
            }
            var bytes=Encoding.UTF8.GetBytes(body);var headers=Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: "+bytes.Length+"\r\nConnection: close\r\n\r\n");stream.Write(headers,0,headers.Length);stream.Write(bytes,0,bytes.Length);
        }}}catch(SocketException){if(retiring)return;}catch(IOException){}catch(InvalidOperationException){if(retiring)return;}}
    }
    public static void Run(string root,string title){QytAiOracle.SetThreadDpiAwarenessContext(new IntPtr(-4));Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new QytAiFixture(root,title));}
}
