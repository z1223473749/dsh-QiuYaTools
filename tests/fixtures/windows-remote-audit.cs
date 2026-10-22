// Test-only, read-only audit of this interactive Windows desktop. No SendInput,
// focus, cursor, journal recovery, settings changes or process termination.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public static class QytRemoteAudit {
 // Pure metadata policy, also used by the PowerShell readiness sampler. Waiting
 // is allowed only while independently verified CIM metadata names the exact
 // child; a nonempty foreign module, foreign session or reused birth rejects.
 public static string BindingDecision(string expectedBirth,string actualBirth,string cimBirth,int expectedParent,int actualParent,string expectedPath,string cimPath,int expectedSession,int cimSession,string modulePath,int processSession,bool exited,int moduleError) {
  long expected,actual,cim;
  if(exited || !long.TryParse(expectedBirth,out expected) || expected<=0 || !long.TryParse(actualBirth,out actual) || expected!=actual || !long.TryParse(cimBirth,out cim) || actual-actual%10!=cim) return "reject";
  if((expectedParent>0&&expectedParent!=actualParent) || !String.Equals(expectedPath,cimPath,StringComparison.OrdinalIgnoreCase) || expectedSession<=0 || cimSession!=expectedSession) return "reject";
  if(!String.IsNullOrEmpty(modulePath) && !String.Equals(expectedPath,modulePath,StringComparison.OrdinalIgnoreCase)) return "reject";
  if(processSession!=0 && processSession!=expectedSession) return "reject";
  if(moduleError!=0 && moduleError!=299 && moduleError!=10001) return "reject";
  return String.IsNullOrEmpty(modulePath) || processSession==0 || moduleError!=0 ? "wait" : "ready";
 }
 public static object BindingSelfTest() {
  int checks=0; Action<string,string> expect=(actual,wanted)=>{if(actual!=wanted)throw new InvalidOperationException("Exact process binding policy self-test failed");checks++;};
  Func<string,string,string,int,int,string,string,int,int,string,int,bool,int,string> decide=BindingDecision;
  string b="639282603569536549",c="639282603569536540",p="C:\\own-uuid\\node.exe";
  expect(decide(b,b,c,40,40,p,p,1,1,p,1,false,0),"ready");
  expect(decide(b,b,c,40,40,p,p,1,1,null,0,false,0),"wait");
  expect(decide(b,b,c,40,40,p,p,1,1,null,0,false,299),"wait");
  expect(decide(b,b,c,40,40,p,p,1,1,"C:\\foreign.exe",1,false,0),"reject");
  expect(decide(b,b,c,40,40,p,p,1,1,p,2,false,0),"reject");
  expect(decide(b,"639282603569536550",c,40,40,p,p,1,1,p,1,false,0),"reject");
  expect(decide(b,b,"639282603569536530",40,40,p,p,1,1,p,1,false,0),"reject");
  expect(decide(b,b,c,40,41,p,p,1,1,p,1,false,0),"reject");
  expect(decide(b,b,c,40,40,p,"C:\\foreign.exe",1,1,p,1,false,0),"reject");
  expect(decide(b,b,c,40,40,p,p,1,1,p,1,true,0),"reject");
  expect(decide(b,b,c,40,40,p,p,1,1,null,0,false,5),"reject");
  return new {passed=true,checks=checks,gui=false,osReads=false,nativeInputEvents=0};
 }
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,int length,out int needed);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 public static object Snapshot() {
  var thread = new StringBuilder(512); int needed;
  if(!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()),2,thread,1024,out needed)) throw new InvalidOperationException("Thread desktop identity unavailable");
  var active = OpenInputDesktop(0,false,1); var name = new StringBuilder(512); bool readable = active != IntPtr.Zero;
  try { if(readable) readable = GetUserObjectInformation(active,2,name,1024,out needed); }
  finally { if(active != IntPtr.Zero) CloseDesktop(active); }
  int held=0; for(int key=1;key<256;key++) if((GetAsyncKeyState(key)&0x8000)!=0) held++;
  var identity=Process.GetCurrentProcess().SessionId+":"+thread.ToString(); string scope;
  using(var hash=SHA256.Create()) scope=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-","").Substring(0,24);
  var directory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"QiuYaTools","computer-lease",scope);
  bool exists=Directory.Exists(directory),free=true,present=false;
  if(exists) {
   // Enumerating the own scope makes access failures explicit; File.Exists alone
   // can turn access-denied into false and must not establish journal absence.
   present=Directory.GetFiles(directory,"owned-input.json",SearchOption.TopDirectoryOnly).Length!=0;
   var locks=Directory.GetFiles(directory,"desktop.lock",SearchOption.TopDirectoryOnly);
   if(locks.Length!=1) throw new InvalidOperationException("Desktop lease lock is unavailable");
   try { using(var file=new FileStream(locks[0],FileMode.Open,FileAccess.Read,FileShare.None)){} }
   catch(IOException) { free=false; }
  }
  return new { sessionId=Process.GetCurrentProcess().SessionId,userInteractive=Environment.UserInteractive,activeDesktopAccessible=readable,activeDesktopMatches=readable&&name.ToString()==thread.ToString(),heldKeyCount=held,leaseScopeExists=exists,leaseFree=free,journalPresent=present };
 }
}
