using System;
using System.Runtime.InteropServices;
public static class QytH2ProcessWait {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
 [DllImport("iphlpapi.dll",SetLastError=true)] static extern uint GetExtendedTcpTable(IntPtr p,ref int n,bool order,uint family,int table,uint reserved);
 public static int ListenerCount(int pid,int port){int n=0;uint r=GetExtendedTcpTable(IntPtr.Zero,ref n,false,2,3,0);if(r!=122||n<4||n>1048576)throw new InvalidOperationException("TCP size unknown");IntPtr p=Marshal.AllocHGlobal(n);try{r=GetExtendedTcpTable(p,ref n,false,2,3,0);if(r!=0)throw new InvalidOperationException("TCP read unknown");int count=Marshal.ReadInt32(p);if(count<0||count>16384||4L+24L*count>n)throw new InvalidOperationException("TCP bounds");int found=0;for(int i=0;i<count;i++){int o=4+i*24;uint a=unchecked((uint)Marshal.ReadInt32(p,o+4)),v=unchecked((uint)Marshal.ReadInt32(p,o+8));int q=(int)(((v&255)<<8)|((v>>8)&255));if(Marshal.ReadInt32(p,o)==2&&a==0x0100007f&&q==port&&Marshal.ReadInt32(p,o+20)==pid)found++;}return found;}finally{Marshal.FreeHGlobal(p);}}
}
