using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace QiuYaTools.Windows;

internal static class ProcessPermissions
{
    internal static int Integrity(uint pid)
    {
        using var process = OpenProcess(0x1000, false, pid);
        if (process.IsInvalid || !OpenProcessToken(process, 8, out var token)) throw new NativeFailure("target-permission-unknown", "The target permission level could not be checked");
        using (token) {
            GetTokenInformation(token, 25, IntPtr.Zero, 0, out var size);
            if (size <= 0 || size > 65536) throw new NativeFailure("target-permission-unknown", "Invalid process permission metadata");
            var buffer = Marshal.AllocHGlobal(size);
            try {
                if (!GetTokenInformation(token, 25, buffer, size, out _)) throw new NativeFailure("target-permission-unknown", "The target permission level could not be checked");
                var sid = Marshal.ReadIntPtr(buffer);
                var count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                if (count == 0) throw new NativeFailure("target-permission-unknown", "Invalid process permission metadata");
                return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
            } finally { Marshal.FreeHGlobal(buffer); }
        }
    }
    internal static bool Elevated => Integrity((uint)Environment.ProcessId) >= 0x3000;
    internal static void RequireTarget(uint pid)
    {
        if (Integrity(pid) > Integrity((uint)Environment.ProcessId)) throw new NativeFailure("administrator-required", "This application requires administrator control. Pause control and enable administrator access on the target computer.");
    }
    internal static void ShareJournalIntegrity(string path)
    {
        if (!Elevated) return;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;;NW;;;ME)", 1, out var descriptor, out _)) throw new NativeFailure("input-journal-failed", "The shared desktop journal could not be secured");
        try {
            if (!GetSecurityDescriptorSacl(descriptor, out _, out var acl, out _) || SetNamedSecurityInfo(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, acl) != 0)
                throw new NativeFailure("input-journal-failed", "The shared desktop journal could not be secured");
        } finally { LocalFree(descriptor); }
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr acl, out bool defaulted);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "SetNamedSecurityInfoW")] private static extern uint SetNamedSecurityInfo(string name, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int kind, IntPtr buffer, int length, out int needed);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
}
