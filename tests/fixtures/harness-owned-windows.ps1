param([Parameter(Mandatory=$true)][string]$ProfileRoot)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$pids=@(Get-Process qiuya-windows -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($ProfileRoot,[StringComparison]::OrdinalIgnoreCase) } | Select-Object -ExpandProperty Id)
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;
public class QytOwnedWindowEvidence {
 public delegate bool Callback(IntPtr hwnd,IntPtr state);
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback callback,IntPtr state);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int capacity);
 public static object[] Collect(int[] pids) {
  var result=new List<object>();
  EnumWindows((hwnd,state)=>{uint pid;GetWindowThreadProcessId(hwnd,out pid);if(Array.IndexOf(pids,(int)pid)>=0){var text=new StringBuilder(1024);GetWindowText(hwnd,text,1024);result.Add(new {pid,handle=hwnd.ToInt64(),visible=IsWindowVisible(hwnd),title=text.ToString()});}return true;},IntPtr.Zero);
  return result.ToArray();
 }
}
'@
@([QytOwnedWindowEvidence]::Collect([int[]]$pids)) | ConvertTo-Json -Depth 4 -Compress
