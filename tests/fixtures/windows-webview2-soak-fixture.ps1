param([switch] $CompileOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Error.WriteLine('{"stage":"loading-720p-test-framework"}')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

public sealed class Qyt720Canvas : Control {
 public uint DrawStamp;
 public long DrawnAtMs, DrawCount;
 public Qyt720Canvas() { Dock=DockStyle.Fill; SetStyle(ControlStyles.AllPaintingInWmPaint|ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer,true); }
 public static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
 protected override void OnPaint(PaintEventArgs e) {
  uint stamp=unchecked((uint)Now());
  e.Graphics.Clear(Color.FromArgb(13,46,59));
  // Preserve the independently decoded 640x360 logical bit coordinates at
  // exactly double resolution; simply enlarging the Form would be incorrect.
  e.Graphics.ScaleTransform(2.0f,2.0f);
  for(int bit=0;bit<32;bit++) e.Graphics.FillRectangle((stamp&(1u<<bit))==0?Brushes.Black:Brushes.White,20+bit*16,20,16,24);
  // Real pixels outside the clock also move. This is source animation, not a
  // simulated scroll/drag input workload.
  float x=(stamp%4000)/4000.0f*560.0f;
  e.Graphics.FillRectangle(Brushes.Orange,x,220,80,70);
  e.Graphics.FillRectangle(Brushes.Teal,0,310,(stamp%2000)/2000.0f*640.0f,25);
  using(Font font=new Font(FontFamily.GenericSansSerif,16)) e.Graphics.DrawString("QiuYaTools 1280 x 720 native source\nOnly this disposable window is captured.\nSource epoch-ms (low32): "+stamp,font,Brushes.White,new RectangleF(20,75,610,135));
  DrawStamp=stamp;DrawnAtMs=Now();DrawCount++;base.OnPaint(e);
 }
}
public sealed class Qyt720Window : Form {
 [DllImport("kernel32.dll")]static extern uint SetThreadExecutionState(uint flags);
 [DllImport("user32.dll")]static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags);
 delegate bool EnumWindowProc(IntPtr handle,IntPtr parameter);
 [StructLayout(LayoutKind.Sequential)]struct Rect{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")]static extern bool EnumWindows(EnumWindowProc callback,IntPtr parameter);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr handle,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr handle,System.Text.StringBuilder title,int maximum);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]static extern IntPtr GetWindowLongPtr(IntPtr handle,int index);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("user32.dll")]static extern bool IsIconic(IntPtr handle);
 [DllImport("user32.dll")]static extern IntPtr GetWindow(IntPtr handle,uint command);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr handle,out Rect rectangle);
 // A read-only oracle in the already owned fixture avoids another companion:
 // the production target list deliberately excludes its own preview process.
 static void ObserveOwnedWindow(string line){
  string request="unknown";
  try{
   string[] parts=line.Split('|');if(parts.Length!=5)throw new InvalidOperationException();request=parts[1];
   if(!System.Text.RegularExpressions.Regex.IsMatch(request,"^[a-z0-9-]{1,64}$"))throw new InvalidOperationException();
   int pid=int.Parse(parts[2],System.Globalization.CultureInfo.InvariantCulture);
   long birth=long.Parse(parts[3],System.Globalization.CultureInfo.InvariantCulture);
   string path=System.IO.Path.GetFullPath(System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(parts[4])));
   using(System.Diagnostics.Process process=System.Diagnostics.Process.GetProcessById(pid)){
    var pinned=process.SafeHandle;
    if(process.StartTime.ToUniversalTime().Ticks!=birth||!string.Equals(process.MainModule.FileName,path,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException();
    IntPtr selected=IntPtr.Zero;
    EnumWindows(delegate(IntPtr handle,IntPtr ignored){uint owner;GetWindowThreadProcessId(handle,out owner);if(owner!=(uint)pid)return true;var title=new System.Text.StringBuilder(256);GetWindowText(handle,title,256);if(title.ToString().StartsWith("QiuYaTools",StringComparison.Ordinal)){selected=handle;return false;}return true;},IntPtr.Zero);
    Rect rectangle;if(selected==IntPtr.Zero||!GetWindowRect(selected,out rectangle))throw new InvalidOperationException();
    long style=GetWindowLongPtr(selected,-20).ToInt64();
    Console.WriteLine("{\"oracle\":\""+request+"\",\"ok\":true,\"pid\":"+pid+",\"createdAtTicks\":\""+birth+"\",\"atMs\":"+Qyt720Canvas.Now()+",\"exactHelperIdentity\":true,\"hwnd\":\""+selected.ToInt64().ToString("x")+"\",\"owner\":\""+GetWindow(selected,4).ToInt64().ToString("x")+"\",\"foreground\":\""+GetForegroundWindow().ToInt64().ToString("x")+"\",\"exstyle\":\""+style.ToString("x")+"\",\"visible\":"+(IsWindowVisible(selected)?"true":"false")+",\"iconic\":"+(IsIconic(selected)?"true":"false")+",\"topmost\":"+((style&8)!=0?"true":"false")+",\"x\":"+rectangle.Left+",\"y\":"+rectangle.Top+",\"width\":"+(rectangle.Right-rectangle.Left)+",\"height\":"+(rectangle.Bottom-rectangle.Top)+"}");
   }
  }catch{Console.WriteLine("{\"oracle\":\""+request+"\",\"ok\":false,\"code\":\"owned-window-unavailable\"}");}
 }
 readonly Qyt720Canvas canvas=new Qyt720Canvas();readonly Timer timer=new Timer();long ticks;bool awake;
 public Qyt720Window() {
  AutoScaleMode=AutoScaleMode.None;FormBorderStyle=FormBorderStyle.None;ClientSize=new Size(1280,720);
  StartPosition=FormStartPosition.Manual;Location=new Point(40,40);Text="QiuYaTools 720p native endurance source";Controls.Add(canvas);timer.Interval=33;
  timer.Tick+=delegate{long requested=Qyt720Canvas.Now();canvas.Refresh();ticks++;if(ticks%30==0)Console.WriteLine("{\"tick\":"+ticks+",\"requestedAtMs\":"+requested+",\"drawStamp\":"+canvas.DrawStamp+",\"drawnAtMs\":"+canvas.DrawnAtMs+",\"drawCount\":"+canvas.DrawCount+",\"width\":"+ClientSize.Width+",\"height\":"+ClientSize.Height+",\"visible\":"+(Visible?"true":"false")+"}");};
 }
 protected override void OnShown(EventArgs e) {
  base.OnShown(e);SetWindowPos(Handle,IntPtr.Zero,0,0,0,0,1|2|4|16|64);
  awake=SetThreadExecutionState(0x80000003u)!=0;if(!awake)throw new InvalidOperationException("Temporary display-awake assertion failed");
  canvas.Refresh();timer.Start();
  Console.WriteLine("{\"ready\":true,\"pid\":"+System.Diagnostics.Process.GetCurrentProcess().Id+",\"sessionId\":"+System.Diagnostics.Process.GetCurrentProcess().SessionId+",\"width\":"+ClientSize.Width+",\"height\":"+ClientSize.Height+",\"logicalClockWidth\":640,\"clockScale\":2,\"preventsIdleDisplaySleep\":true}");
  Task.Run(delegate{while(true){string line=Console.ReadLine();if(line==null||line=="quit")break;if(line.Length<4096&&line.StartsWith("oracle|",StringComparison.Ordinal))ObserveOwnedWindow(line);}try{BeginInvoke((Action)delegate{Close();});}catch(InvalidOperationException){}});
 }
 protected override void OnFormClosed(FormClosedEventArgs e){timer.Stop();timer.Dispose();SetThreadExecutionState(0x80000000u);awake=false;base.OnFormClosed(e);}
 public static void Run(){SetProcessDPIAware();Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);using(Qyt720Window window=new Qyt720Window()){window.Show();if(!SetWindowPos(window.Handle,IntPtr.Zero,0,0,0,0,1|2|4|16|64))throw new InvalidOperationException("720p test source could not be presented");Application.Run(window);}}
}
'@
if ($CompileOnly) { [Console]::WriteLine('{"compiled":true,"guiStarted":false,"nativeOps":0}'); return }
[Console]::Error.WriteLine('{"stage":"starting-720p-test-source"}')
[Qyt720Window]::Run()
