using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace QiuYaTools.Windows;

internal static class WindowProcessIdentity
{
    internal static (long Born, string Path) Read(uint pid)
    {
        using var process = OpenProcess(0x1000, false, pid);
        if (process.IsInvalid || !GetProcessTimes(process, out var born, out _, out _, out _)) throw new NativeFailure("target-unavailable", "The target process identity is unavailable");
        var path = new StringBuilder(32768); var length = path.Capacity;
        if (!QueryFullProcessImageName(process, 0, path, ref length) || length <= 0) throw new NativeFailure("target-unavailable", "The target executable identity is unavailable");
        return (DateTime.FromFileTimeUtc(born).Ticks, System.IO.Path.GetFullPath(path.ToString()));
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetProcessTimes(SafeProcessHandle process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "QueryFullProcessImageNameW", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder name, ref int length);
}
