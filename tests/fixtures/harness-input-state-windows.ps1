$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;
public static class QytFailedCaseInputReadback {
 [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
 [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")]static extern IntPtr GetThreadDesktop(uint thread);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool GetUserObjectInformation(IntPtr value,int index,StringBuilder text,int capacity,out uint count);
 public static int[] Held(){var result=new List<int>();for(int key=1;key<256;key++)if((GetAsyncKeyState(key)&0x8000)!=0)result.Add(key);return result.ToArray();}
 public static string Desktop(){var text=new StringBuilder(512);uint count;if(!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()),2,text,text.Capacity*2,out count))throw new Exception("Desktop identity unavailable");return text.ToString();}
}
'@
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
if($session -le 0 -or -not [Environment]::UserInteractive){throw 'Interactive readback required'}
$identity=$session.ToString()+':'+[QytFailedCaseInputReadback]::Desktop()
$sha=[Security.Cryptography.SHA256]::Create()
try{$scope=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity)))).Replace('-','').Substring(0,24)}finally{$sha.Dispose()}
$directory=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('QiuYaTools\computer-lease\'+$scope)
$lockPath=Join-Path $directory 'desktop.lock'
$lockFree=$false
if(-not [IO.File]::Exists($lockPath)){$lockFree=$true}else{try{$stream=[IO.File]::Open($lockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$stream.Dispose();$lockFree=$true}catch [IO.IOException]{$lockFree=$false}}
@{heldKeys=@([QytFailedCaseInputReadback]::Held());leaseLockFree=$lockFree;journalPresent=[IO.File]::Exists((Join-Path $directory 'owned-input.json'));inputEventsPosted=0}|ConvertTo-Json -Compress
