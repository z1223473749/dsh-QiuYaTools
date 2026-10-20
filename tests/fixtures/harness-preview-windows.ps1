# Disposable Harness E2E observer: invoke only a named button in the exact
# PID/start-time-bound native preview window selected by the companion.
param([Parameter(Mandatory=$true)][string]$WindowId, [string]$Button = '', [switch]$MouseButton,
 [ValidateSet('observe','click-image','set-text')][string]$Operation='observe',
 [string]$ImageLabel='', [ValidateRange(0,1)][double]$X=0.5, [ValidateRange(0,1)][double]$Y=0.85,
 [ValidateLength(0,2048)][string]$Text='', [string]$TextLabel='')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$pieces = $WindowId.Split(':')
if ($pieces.Length -ne 4 -or $pieces[0] -ne 'window') { throw 'Invalid fixture window identity' }
$handle = [IntPtr]([Convert]::ToInt64($pieces[1], 16))
$targetProcess = Get-Process -Id ([int]$pieces[2])
if ($targetProcess.StartTime.ToUniversalTime().Ticks -ne [long]$pieces[3]) { throw 'Fixture process identity changed' }
$element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($element.Current.ProcessId -ne $targetProcess.Id -or -not $element.Current.Name.StartsWith('QiuYaTools')) { throw 'Fixture must be the exact native computer preview' }
$items = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$labels = New-Object 'System.Collections.Generic.List[string]'
$pressed = $false
$clicked=$false;$typed=$false;$point=$null;$textValue=$null
 Add-Type @'
using System;using System.Runtime.InteropServices;
public class QytPreviewMouse {
 [StructLayout(LayoutKind.Sequential)]struct Point{public int X,Y;}
 [StructLayout(LayoutKind.Sequential)]struct Rect{public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)]struct MouseInput{public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra;}
 [StructLayout(LayoutKind.Sequential)]struct Input{public uint Type;public MouseInput Mouse;}
 [DllImport("user32.dll")]static extern bool SetPhysicalCursorPos(int x,int y);
 [DllImport("user32.dll",SetLastError=true)]static extern uint SendInput(uint count,Input[] input,int size);
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr handle,uint flags);
 [DllImport("user32.dll")]static extern IntPtr WindowFromPhysicalPoint(Point point);
 [DllImport("user32.dll")]public static extern uint GetDpiForWindow(IntPtr handle);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr handle,out Rect rect);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr handle);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]static extern IntPtr GetWindowLongPtr(IntPtr handle,int index);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr handle,out uint pid);
 public static uint ProcessId(IntPtr handle){uint pid;GetWindowThreadProcessId(handle,out pid);return pid;}
 public static object WindowInfo(IntPtr handle){Rect r;GetWindowRect(handle,out r);return new{hwnd=handle.ToInt64().ToString("x"),pid=ProcessId(handle),dpi=GetDpiForWindow(handle),topmost=(GetWindowLongPtr(handle,-20).ToInt64()&8)!=0,visible=IsWindowVisible(handle),enabled=IsWindowEnabled(handle),x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top};}
 public static void Click(int x,int y,IntPtr expected,bool requireFocus){var hit=GetAncestor(WindowFromPhysicalPoint(new Point{X=x,Y=y}),2);if(hit!=expected)throw new Exception("The own preview physical click is obscured: point="+x+","+y+" expected="+WindowInfo(expected)+" hit="+WindowInfo(hit)+" foreground="+GetForegroundWindow().ToInt64().ToString("x"));if(!SetPhysicalCursorPos(x,y))throw new Exception("Could not position fixture mouse");System.Threading.Thread.Sleep(80);var input=new[]{new Input{Mouse=new MouseInput{Flags=2}},new Input{Mouse=new MouseInput{Flags=4}}};if(SendInput(2,input,Marshal.SizeOf<Input>())!=2)throw new Exception("Fixture SendInput click failed");if(requireFocus){for(var i=0;i<100&&GetForegroundWindow()!=expected;i++)System.Threading.Thread.Sleep(10);if(GetForegroundWindow()!=expected)throw new Exception("The own preview footer did not acquire foreground");}}
}
'@
function Get-FixtureForeground {
 $current=[QytPreviewMouse]::GetForegroundWindow()
 @{hwnd=$current.ToInt64().ToString('x');pid=[QytPreviewMouse]::ProcessId($current)}
}
$foregroundBefore=Get-FixtureForeground
for ($i = 0; $i -lt [Math]::Min($items.Count, 300); $i++) {
  $item = $items.Item($i)
  $label = $item.Current.Name
  if ($label) { $labels.Add($label) }
  if($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document){
    # Chromium can expose rapidly changing ready/latency text only through its
    # live document range while Current.Name's descendant list is still stale.
    try {
      $document=$item.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      $documentText=$document.DocumentRange.GetText(6000)
      if($documentText){$labels.Add($documentText)}
    } catch {}
  }
  if ($Operation -eq 'click-image' -and -not $clicked -and $label -eq $ImageLabel -and $item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Image) {
    $bounds=$item.Current.BoundingRectangle
    if($bounds.Width -le 0 -or $bounds.Height -le 0){throw 'Preview image is not visible'}
    $point=@{x=[int][Math]::Round($bounds.Left+$bounds.Width*$X);y=[int][Math]::Round($bounds.Top+$bounds.Height*$Y)}
    [QytPreviewMouse]::Click($point.x,$point.y,$handle,$false);$clicked=$true
  }
  if ($Operation -eq 'set-text' -and -not $typed -and $TextLabel -and $label -eq $TextLabel -and $item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
    # Match the user workflow: actually click the own preview footer before
    # setting its value. Background UIA ValuePattern alone grants no foreground
    # input ownership to the helper that will forward the subsequent type.
    $bounds=$item.Current.BoundingRectangle
    if($bounds.Width -le 0 -or $bounds.Height -le 0){throw 'Preview footer is not visible'}
    $point=@{x=[int][Math]::Round($bounds.Left+$bounds.Width/2);y=[int][Math]::Round($bounds.Top+$bounds.Height/2)}
    [QytPreviewMouse]::Click($point.x,$point.y,$handle,$true);$clicked=$true
    $value=$item.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value.SetValue($Text);$textValue=$value.Current.Value;$typed=$true
  }
  if ($Button -and -not $pressed -and $label -eq $Button -and $item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
    if($MouseButton){
      $bounds=$item.Current.BoundingRectangle
      if($bounds.Width -le 0 -or $bounds.Height -le 0){throw 'Preview button is not visible'}
      $point=@{x=[int][Math]::Round($bounds.Left+$bounds.Width/2);y=[int][Math]::Round($bounds.Top+$bounds.Height/2)}
      [QytPreviewMouse]::Click($point.x,$point.y,$handle,$false);$clicked=$true
    }else{
      $pattern = $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $pattern.Invoke()
    }
    $pressed = $true
  }
}
if ($Button -and -not $pressed) { throw 'Native preview button was not invokable' }
if($Operation -eq 'click-image' -and -not $clicked){throw 'Native preview image was not clickable'}
if($Operation -eq 'set-text' -and -not $typed){throw 'Native preview text input was not writable'}
@{ targetId=$WindowId; pid=$targetProcess.Id;window=[QytPreviewMouse]::WindowInfo($handle);windowDpi=[QytPreviewMouse]::GetDpiForWindow($handle);coordinates='UIA physical / WindowFromPhysicalPoint / SetPhysicalCursorPos';labels=$labels.ToArray(); pressed=$pressed;clicked=$clicked;typed=$typed;textValue=$textValue;point=$point;foregroundBefore=$foregroundBefore;foregroundAfter=(Get-FixtureForeground);mouseSource=if($clicked){'Win32 SendInput OS-synthetic, not Parallels hardware'}else{$null} } | ConvertTo-Json -Depth 6 -Compress
