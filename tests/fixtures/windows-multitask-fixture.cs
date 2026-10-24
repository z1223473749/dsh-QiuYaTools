using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Test-only opaque applications. No input injection, account, or production changes.
public sealed class WindowsMultitaskFixture : Form
{
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder title, int count);
    [DllImport("user32.dll",SetLastError=true)] static extern bool AllowSetForegroundWindow(uint pid);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    readonly List<object> events = new List<object>();
    readonly List<object> foregroundPermits = new List<object>();
    Dictionary<string,object> foregroundPeer;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly object output = new object();
    readonly string label;
    readonly string runId; bool startupActivationAttempted, startupCreditAttempted;
    int downs, ups, drags, clicks;
    bool moving;
    WindowsMultitaskFixture(string[] args)
    {
        label = Arg(args, "--label"); runId = Guid.Parse(Arg(args,"--run-id")).ToString("D"); Text = "QiuYaTools multitask " + label + " " + runId;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(Int32.Parse(Arg(args,"--x")), Int32.Parse(Arg(args,"--y")));
        ClientSize = new Size(540,360); BackColor = Color.FromArgb(37,113,151);
        FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false;
        DoubleBuffered = true; ShowInTaskbar = false;
        MouseDown += delegate(object sender, MouseEventArgs e) { if(e.Button != MouseButtons.Left)return; downs++; moving=false; Capture=true; Record("down",e); };
        MouseMove += delegate(object sender, MouseEventArgs e) { if(e.Button != MouseButtons.Left)return; moving=true; drags++; Record("drag",e); };
        MouseUp += delegate(object sender, MouseEventArgs e) { if(e.Button != MouseButtons.Left)return; ups++; if(!moving)clicks++; Capture=false; Record("up",e); PermitForeground("mouse-up"); };
        Shown += delegate { Send(new { @event="ready", state=Snapshot() }); var reader = new Thread(Read) { IsBackground=true }; reader.Start(); };
    }
    static string Arg(string[] args,string name) { int i=Array.IndexOf(args,name); if(i<0||i+1>=args.Length)throw new ArgumentException(name); return args[i+1]; }
    void Record(string kind,MouseEventArgs e) { if(events.Count>=128)throw new InvalidOperationException("Fixture event bound exceeded"); events.Add(new { kind=kind, ticks=Stopwatch.GetTimestamp().ToString(), x=e.X, y=e.Y }); }
    static Dictionary<string,object> ProcessIdentity(Process p)
    {
        var pinned=p.SafeHandle;
        return new Dictionary<string,object>{{"pid",p.Id},{"createdAtTicks",p.StartTime.ToUniversalTime().Ticks.ToString()},{"executablePath",p.MainModule.FileName},{"sessionId",p.SessionId}};
    }
    object PermitForeground(string reason)
    {
        if(foregroundPeer==null)return null;
        if(foregroundPermits.Count>=32)throw new InvalidOperationException("Foreground permit bound exceeded");
        int pid=Convert.ToInt32(foregroundPeer["pid"]);if(pid<=0)throw new InvalidOperationException("Exact foreground peer required");
        Dictionary<string,object> caller,callee;
        using(var self=Process.GetCurrentProcess())caller=ProcessIdentity(self);
        using(var peer=Process.GetProcessById(pid)) {
            callee=ProcessIdentity(peer);string image=Convert.ToString(callee["executablePath"]),own=Path.GetDirectoryName(Convert.ToString(caller["executablePath"]));
            bool imageAllowed=String.Equals(image,Path.Combine(own,"native","win32-arm64","qiuya-windows.exe"),StringComparison.OrdinalIgnoreCase)||String.Equals(image,Path.Combine(own,"native","win32-x64","qiuya-windows.exe"),StringComparison.OrdinalIgnoreCase);
            if(peer.HasExited||!imageAllowed||Convert.ToString(callee["createdAtTicks"])!=Convert.ToString(foregroundPeer["createdAtTicks"])||!String.Equals(image,Convert.ToString(foregroundPeer["executablePath"]),StringComparison.OrdinalIgnoreCase)||Convert.ToInt32(callee["sessionId"])!=Convert.ToInt32(caller["sessionId"])||Convert.ToInt32(callee["sessionId"])!=Convert.ToInt32(foregroundPeer["sessionId"]))throw new InvalidOperationException("Exact own foreground peer changed");
            long before=GetForegroundWindow().ToInt64();var held=new List<int>();for(int key=1;key<256;key++)if((GetAsyncKeyState(key)&0x8000)!=0)held.Add(key);
            bool attempted=before==Handle.ToInt64(),allowed=attempted&&AllowSetForegroundWindow((uint)pid);int error=attempted&&!allowed?Marshal.GetLastWin32Error():0;
            var receipt=new{reason=reason,ticks=Stopwatch.GetTimestamp().ToString(),caller=caller,callerWindow=Handle.ToInt64().ToString(),foregroundBefore=before.ToString(),foregroundAfter=GetForegroundWindow().ToInt64().ToString(),callee=callee,heldKeys=held.ToArray(),attempted=attempted,allowed=allowed,error=error,extraInputEvents=0,focusChangesRequested=0};foregroundPermits.Add(receipt);return receipt;
        }
    }
    static Dictionary<string,object> StartupIdentity(Process process)
    {
        var identity=ProcessIdentity(process);string image=Convert.ToString(identity["executablePath"]);
        if((File.GetAttributes(image)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("Startup fixture image must not be a reparse point");
        using(var file=new FileStream(image,FileMode.Open,FileAccess.Read,FileShare.Read)) {
            if(file.Length<1||file.Length>8*1024*1024)throw new InvalidOperationException("Startup fixture image bound");
            using(var sha=SHA256.Create())identity["imageSHA256"]=BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
        }
        identity["canonicalExecutablePath"]=image;return identity;
    }
    object GrantInitialOwnedForeground(Dictionary<string,object> request)
    {
        if(label!="chat-B"||startupCreditAttempted||Convert.ToString(request["runId"])!=runId||downs!=0||ups!=0||drags!=0||clicks!=0)throw new InvalidOperationException("Initial owned credit is once before fixture business");
        string nonce=Guid.Parse(Convert.ToString(request["nonce"])).ToString("D");startupCreditAttempted=true;
        var expected=(Dictionary<string,object>)request["identity"];int pid=Convert.ToInt32(expected["pid"]);
        IntPtr target=new IntPtr(Int64.Parse(Convert.ToString(request["hwnd"])));uint targetPid;GetWindowThreadProcessId(target,out targetPid);
        var title=new StringBuilder(512);GetWindowText(target,title,title.Capacity);
        if(pid<=0||targetPid!=(uint)pid||title.ToString()!="QiuYaTools multitask chat-A "+runId)throw new InvalidOperationException("Exact initial A window required");
        using(var own=Process.GetCurrentProcess())using(var peer=Process.GetProcessById(pid)) {
            var caller=StartupIdentity(own);var callee=StartupIdentity(peer);
            foreach(string key in new[]{"pid","createdAtTicks","sessionId","imageSHA256"})if(Convert.ToString(callee[key])!=Convert.ToString(expected[key]))throw new InvalidOperationException("Exact initial A identity changed");
            string ownPath=Convert.ToString(caller["executablePath"]),peerPath=Convert.ToString(callee["executablePath"]);
            if(peer.HasExited||pid==own.Id||!String.Equals(ownPath,peerPath,StringComparison.OrdinalIgnoreCase)||!String.Equals(peerPath,Convert.ToString(expected["executablePath"]),StringComparison.OrdinalIgnoreCase)||!String.Equals(peerPath,Convert.ToString(expected["canonicalExecutablePath"]),StringComparison.OrdinalIgnoreCase)||Convert.ToString(caller["imageSHA256"])!=Convert.ToString(callee["imageSHA256"])||Convert.ToInt32(caller["sessionId"])!=Convert.ToInt32(callee["sessionId"]))throw new InvalidOperationException("Credit is only between exact same-run fixture images");
            var held=new List<int>();for(int key=1;key<256;key++)if((GetAsyncKeyState(key)&0x8000)!=0)held.Add(key);
            long before=GetForegroundWindow().ToInt64();if(before!=Handle.ToInt64()||held.Count!=0)throw new InvalidOperationException("Only released current foreground B can grant initial credit");
            bool allowed=AllowSetForegroundWindow((uint)pid);int error=allowed?0:Marshal.GetLastWin32Error();
            return new{scope="owned-foreground-credit-before-business",runId=runId,nonce=nonce,caller=caller,callee=callee,callerWindow=Handle.ToInt64().ToString(),calleeWindow=target.ToInt64().ToString(),foregroundBefore=before.ToString(),foregroundAfter=GetForegroundWindow().ToInt64().ToString(),heldKeys=held.ToArray(),attempted=true,allowed=allowed,error=error,grantCalls=1,extraInputEvents=0,focusChangesRequested=0,physicalCUAVerified=false};
        }
    }
    object Snapshot()
    {
        var p=Process.GetCurrentProcess(); var origin=PointToScreen(Point.Empty);
        return new { label=label, pid=p.Id, createdAtTicks=p.StartTime.ToUniversalTime().Ticks.ToString(), executablePath=p.MainModule.FileName,
            sessionId=p.SessionId, hwnd=Handle.ToInt64().ToString(), title=Text, visible=Visible, foreground=GetForegroundWindow().ToInt64().ToString(),
            bounds=new { x=Left,y=Top,width=Width,height=Height }, client=new {x=origin.X,y=origin.Y,width=ClientSize.Width,height=ClientSize.Height},
            point=new { x=origin.X+80,y=origin.Y+180 }, counts=new { downs=downs,ups=ups,drags=drags,clicks=clicks }, frequency=Stopwatch.Frequency,
            events=events.ToArray(), foregroundPermits=foregroundPermits.ToArray() };
    }
    void Send(object value) { lock(output) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); } }
    void Read()
    {
        try {
            string line;
            while((line=Console.ReadLine())!=null) {
                if(line.Length>4096)throw new InvalidOperationException("Fixture request bound exceeded");
                var request=json.Deserialize<Dictionary<string,object>>(line); var id=request["requestId"]; var op=Convert.ToString(request["op"]);
                if(op=="snapshot")Invoke((Action)delegate { Send(new { requestId=id,ok=true,result=Snapshot() }); });
                else if(op=="grantInitialOwnedForeground")Invoke((Action)delegate { Send(new{requestId=id,ok=true,result=GrantInitialOwnedForeground(request)}); });
                else if(op=="normalOwnedStartupActivate")Invoke((Action)delegate {
                    if(label!="chat-A"||startupActivationAttempted||Convert.ToString(request["runId"])!=runId)throw new InvalidOperationException("Normal own startup may occur exactly once before business");
                    string nonce=Guid.Parse(Convert.ToString(request["nonce"])).ToString("D");startupActivationAttempted=true;
                    string foregroundBefore=GetForegroundWindow().ToInt64().ToString();
                    Activate();
                    Dictionary<string,object> identity;using(var own=Process.GetCurrentProcess())identity=ProcessIdentity(own);
                    Send(new {requestId=id,ok=true,result=new {scope="owned-foreground-credit-before-business",runId=runId,nonce=nonce,identity=identity,hwnd=Handle.ToInt64().ToString(),foregroundBefore=foregroundBefore,foregroundAfter=GetForegroundWindow().ToInt64().ToString(),activationCalls=1,syntheticInputEvents=0,physicalCUAVerified=false}});
                });
                else if(op=="permitForeground")Invoke((Action)delegate { foregroundPeer=(Dictionary<string,object>)request["identity"];Send(new { requestId=id,ok=true,result=PermitForeground("setup") }); });
                else throw new InvalidOperationException("Unknown fixture operation");
            }
            BeginInvoke((Action)Close);
        } catch(Exception error) { Console.Error.WriteLine(error.GetType().Name); Environment.ExitCode=1; try { BeginInvoke((Action)Close); } catch {} }
    }
    [STAThread] public static void Main(string[] args)
    {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        Console.SetIn(new StreamReader(Console.OpenStandardInput(),new System.Text.UTF8Encoding(false)));
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(),new System.Text.UTF8Encoding(false)){AutoFlush=true});
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new WindowsMultitaskFixture(args));
    }
}
