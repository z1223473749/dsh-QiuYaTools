using System;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using System.Collections.Generic;
public sealed class QytVirtualFixture : Form {
  readonly TextBox text=new TextBox(); readonly Button button=new Button(); readonly Panel pad=new Panel();
  readonly JavaScriptSerializer json=new JavaScriptSerializer(); readonly string ready,token;
  TcpListener listener; Thread server; int clicks,drags,activations,focusEvents; bool held; long injectedMouse,injectedKeys; IntPtr mouseHook,keyHook;
  HookProc mouseProc,keyProc; bool running=true; Form sentinel; TextBox sentinelText; string pendingRequest; Panel approval;
  delegate IntPtr HookProc(int code,IntPtr message,IntPtr data);
  [StructLayout(LayoutKind.Sequential)] struct P {public int X,Y;}
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public P Pt; public uint Data,Flags,Time;public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct Key {public uint Code,Scan,Flags,Time;public UIntPtr Extra;}
  [StructLayout(LayoutKind.Sequential)] struct GUI {public uint Size,Flags;public IntPtr Active,Focus,Capture,Menu,Move,Caret; public Rectangle Rect;}
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out P point);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GUI gui);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int hook,HookProc fn,IntPtr module,uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  protected override bool ShowWithoutActivation {get{return true;}}
  protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x08000000;return p;}}
  public QytVirtualFixture(string path,string secret) {
    ready=path;token=secret;Text="QiuYaTools Virtual Input Background Fixture";StartPosition=FormStartPosition.Manual;Location=new Point(1080,100);ClientSize=new Size(620,420);
    Activated+=delegate{activations++;};GotFocus+=delegate{focusEvents++;};button.GotFocus+=delegate{focusEvents++;};text.GotFocus+=delegate{focusEvents++;};pad.GotFocus+=delegate{focusEvents++;};
    button.Text="Virtual click target";button.Bounds=new Rectangle(30,30,220,45);button.Click+=delegate{clicks++;};Controls.Add(button);
    text.Bounds=new Rectangle(30,110,460,40);text.AccessibleName="Virtual text target";Controls.Add(text);
    pad.Bounds=new Rectangle(30,210,460,120);pad.BackColor=Color.LightSteelBlue;pad.AccessibleName="Unsupported virtual drag target";
    pad.MouseDown+=delegate{held=true;};pad.MouseUp+=delegate{if(held)drags++;held=false;};Controls.Add(pad);
    Shown+=delegate { mouseProc=MouseEvent;keyProc=KeyEvent;var module=GetModuleHandle(null);mouseHook=SetWindowsHookEx(14,mouseProc,module,0);keyHook=SetWindowsHookEx(13,keyProc,module,0);
      listener=new TcpListener(IPAddress.Loopback,0);listener.Start();server=new Thread(Serve);server.IsBackground=true;server.Start();
      File.WriteAllText(ready,json.Serialize(new{pid=System.Diagnostics.Process.GetCurrentProcess().Id,hwnd=Handle.ToInt64().ToString(),port=((IPEndPoint)listener.LocalEndpoint).Port})); };
    FormClosed+=delegate{running=false;if(listener!=null)listener.Stop();if(mouseHook!=IntPtr.Zero)UnhookWindowsHookEx(mouseHook);if(keyHook!=IntPtr.Zero)UnhookWindowsHookEx(keyHook);if(sentinel!=null)sentinel.Close();};
  }
  IntPtr MouseEvent(int code,IntPtr msg,IntPtr data){if(code>=0&&(((Mouse)Marshal.PtrToStructure(data,typeof(Mouse))).Flags&1)!=0)Interlocked.Increment(ref injectedMouse);return CallNextHookEx(mouseHook,code,msg,data);}
  IntPtr KeyEvent(int code,IntPtr msg,IntPtr data){if(code>=0&&(((Key)Marshal.PtrToStructure(data,typeof(Key))).Flags&0x10)!=0)Interlocked.Increment(ref injectedKeys);return CallNextHookEx(keyHook,code,msg,data);}
  object PointOf(Control c){var p=c.PointToScreen(new Point(c.Width/2,c.Height/2));return new{x=p.X,y=p.Y};}
  object State(){P p;GetCursorPos(out p);var gui=new GUI();gui.Size=(uint)Marshal.SizeOf(typeof(GUI));bool focusRead=GetGUIThreadInfo(0,ref gui);return new{pid=System.Diagnostics.Process.GetCurrentProcess().Id,hwnd=Handle.ToInt64().ToString(),clicks=clicks,drags=drags,activations=activations,focusEvents=focusEvents,text=text.Text,button=PointOf(button),field=PointOf(text),pad=PointOf(pad),cursor=new{x=p.X,y=p.Y},foreground=GetForegroundWindow().ToInt64().ToString(),focus=gui.Focus.ToInt64().ToString(),focusRead=focusRead,fixtureHasForeground=GetForegroundWindow()==Handle,fixtureHasFocus=focusRead&&GetAncestor(gui.Focus,2)==Handle,clipboardSequence=GetClipboardSequenceNumber(),injectedMouse=Interlocked.Read(ref injectedMouse),injectedKeys=Interlocked.Read(ref injectedKeys),hooksAvailable=mouseHook!=IntPtr.Zero&&keyHook!=IntPtr.Zero,sentinel=sentinelText==null?null:sentinelText.Text,screen=new{width=SystemInformation.VirtualScreen.Width,height=SystemInformation.VirtualScreen.Height}};}
  void ShowSentinel(){if(sentinel!=null)return;sentinel=new Form();sentinel.Text="QiuYaTools Normal User Input Sentinel";sentinel.StartPosition=FormStartPosition.Manual;sentinel.Location=new Point(60,100);sentinel.ClientSize=new Size(700,380);sentinelText=new TextBox();sentinelText.Multiline=true;sentinelText.Dock=DockStyle.Fill;sentinel.Controls.Add(sentinelText);sentinel.Shown+=delegate{sentinelText.Focus();};sentinel.Show();sentinel.Activate();
    var timer=new System.Windows.Forms.Timer();timer.Interval=200;timer.Tick+=delegate { try {var path=Path.Combine(Path.GetDirectoryName(ready),"pending-physical-card.json");if(!File.Exists(path))return;var card=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path));var id=(string)card["requestId"];if(id==pendingRequest)return;pendingRequest=id;if(approval!=null)sentinel.Controls.Remove(approval);approval=new Panel();approval.Dock=DockStyle.Bottom;approval.Height=140;approval.BackColor=Color.LightGoldenrodYellow;var label=new Label();label.Text="Separate permission: ONE real mouse drag in the test window.\nThis will move the system pointer and activate that test window.";label.Bounds=new Rectangle(10,10,670,50);approval.Controls.Add(label);var yes=new Button();yes.Text="Allow this one real action";yes.Bounds=new Rectangle(10,75,260,40);var no=new Button();no.Text="Deny real mouse";no.Bounds=new Rectangle(290,75,220,40);yes.Click+=delegate{Decision(id,"once");yes.Enabled=false;no.Enabled=false;};no.Click+=delegate{Decision(id,"deny");yes.Enabled=false;no.Enabled=false;};approval.Controls.Add(yes);approval.Controls.Add(no);sentinel.Controls.Add(approval);approval.BringToFront();}catch{}};timer.Start();}
  void Decision(string id,string value){File.WriteAllText(Path.Combine(Path.GetDirectoryName(ready),"owner-decision.json"),json.Serialize(new{requestId=id,decision=value,source="separate-visible-owner-card"}));}
  void Serve(){while(running){try{using(var c=listener.AcceptTcpClient())using(var stream=c.GetStream())using(var reader=new StreamReader(stream,Encoding.ASCII,false,1024,true)){c.ReceiveTimeout=3000;c.SendTimeout=3000;var line=reader.ReadLine();string h;while(!String.IsNullOrEmpty(h=reader.ReadLine())){}var path=line==null?"":line.Split(' ')[1];bool valid=path=="/"+token+"/state"||path=="/"+token+"/sentinel"||path=="/"+token+"/close";if(!valid){var bad=Encoding.ASCII.GetBytes("HTTP/1.1 404 Not Found\r\nContent-Length:0\r\n\r\n");stream.Write(bad,0,bad.Length);continue;}object value=Invoke(new Func<object>(delegate{if(path.EndsWith("/sentinel"))ShowSentinel();return State();}));var body=Encoding.UTF8.GetBytes(json.Serialize(value));var header=Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type:application/json\r\nContent-Length:"+body.Length+"\r\nConnection:close\r\n\r\n");stream.Write(header,0,header.Length);stream.Write(body,0,body.Length);if(path.EndsWith("/close"))BeginInvoke(new Action(Close));}}catch(Exception){if(!running)return;}}}
  public static void Run(string path,string token){SetThreadDpiAwarenessContext(new IntPtr(-4));Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new QytVirtualFixture(path,token));}
}
