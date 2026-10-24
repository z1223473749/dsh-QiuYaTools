using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace QiuYaTools.Windows;

// OS-bound proof for one pipe-owned worker. The recipient's random instance and
// desktop claim come from its own pipe; only OS-readable fields are re-read here.
internal sealed class ForegroundHandoff
{
    private readonly ForegroundWorkerIdentity own;
    internal ForegroundHandoffCore Core { get; }
    internal ForegroundHandoff()
    {
        using var process = Process.GetCurrentProcess();
        var desktop = ReadActiveDesktop();
        own = ReadIdentity(process, desktop.Hash, Guid.NewGuid().ToString("N"), RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant());
        ForegroundHandoffCore.ValidateIdentity(own);
        Core = new ForegroundHandoffCore(own);
    }
    internal bool ActiveDesktop()
    {
        try { return Environment.UserInteractive && ReadActiveDesktop().Hash == own.DesktopSHA256; }
        catch (Exception error) when (error is NativeFailure or InvalidOperationException or System.ComponentModel.Win32Exception) { return false; }
    }
    internal RecipientPin PinRecipient(ForegroundWorkerIdentity expected)
    {
        ForegroundHandoffCore.ValidateIdentity(expected);
        Process? recipient = null; Process? parent = null;
        try {
            recipient = Process.GetProcessById(expected.Pid);
            _ = recipient.SafeHandle; // Keep this exact kernel process object through ASFW.
            var actual = ReadIdentity(recipient, expected.DesktopSHA256, expected.InstanceId, expected.Architecture);
            parent = Process.GetProcessById(actual.ParentPid); _ = parent.SafeHandle;
            if (recipient.HasExited || parent.HasExited || parent.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != actual.ParentCreatedAtTicks)
                throw Fail("foreground-recipient-changed");
            ForegroundHandoffCore.ValidateOsRecipient(expected, actual);
            using var current = Process.GetCurrentProcess();
            var currentOwn = ReadIdentity(current, ReadActiveDesktop().Hash, own.InstanceId, own.Architecture);
            if (currentOwn != own) throw Fail("foreground-donor-changed");
            var result = new RecipientPin(recipient, parent); recipient = null; parent = null; return result;
        } catch (NativeFailure) { throw; }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception or IOException or UnauthorizedAccessException) {
            throw Fail("foreground-identity-unavailable");
        } finally { recipient?.Dispose(); parent?.Dispose(); }
    }
    internal sealed class RecipientPin(Process process, Process parent) : IDisposable
    {
        internal void RequireAlive() { if (process.HasExited || parent.HasExited) throw Fail("foreground-recipient-changed"); }
        public void Dispose() { process.Dispose(); parent.Dispose(); }
    }
    internal static (bool Allowed, int Error) Grant(int pid)
    {
        Marshal.SetLastPInvokeError(0);
        var allowed = AllowSetForegroundWindow(checked((uint)pid));
        return (allowed, allowed ? 0 : Marshal.GetLastWin32Error());
    }
    internal static void RequireNoPhysicalHeld()
    {
        for (var key = 1; key <= 255; key++) if ((GetAsyncKeyState(key) & 0x8000) != 0) throw Fail("foreground-physical-held");
    }
    internal static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    private static ForegroundWorkerIdentity ReadIdentity(Process process, string desktopHash, string instanceId, string architecture)
    {
        var handle = process.SafeHandle;
        if (process.HasExited) throw Fail("foreground-process-exited");
        var capacity = 32768; var path = new StringBuilder(capacity);
        if (!QueryFullProcessImageName(handle, 0, path, ref capacity)) throw Fail("foreground-image-unavailable");
        using var image = new FileStream(path.ToString(), FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
        var canonical = new StringBuilder(32768);
        var length = GetFinalPathNameByHandle(image.SafeFileHandle, canonical, (uint)canonical.Capacity, 0);
        if (length == 0 || length >= canonical.Capacity || image.Length is <= 0 or > 268_435_456) throw Fail("foreground-image-unavailable");
        var normalized = canonical.ToString();
        if (normalized.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) normalized = @"\\" + normalized[8..];
        else if (normalized.StartsWith(@"\\?\", StringComparison.Ordinal)) normalized = normalized[4..];
        normalized = Path.GetFullPath(normalized);
        var sha = Convert.ToHexString(SHA256.HashData(image)).ToLowerInvariant();
        var parentPid = ParentOf(process.Id);
        using var parent = Process.GetProcessById(parentPid); _ = parent.SafeHandle;
        if (parent.HasExited) throw Fail("foreground-parent-exited");
        return new(process.Id, process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture), normalized, sha,
            parentPid, parent.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture), process.SessionId, desktopHash, instanceId, architecture);
    }
    private static int ParentOf(int pid)
    {
        var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw Fail("foreground-parent-unavailable");
        try {
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>(), Name = "" };
            if (!Process32First(snapshot, ref entry)) throw Fail("foreground-parent-unavailable");
            do { if (entry.Pid == (uint)pid) return checked((int)entry.Parent); } while (Process32Next(snapshot, ref entry));
            throw Fail("foreground-parent-unavailable");
        } finally { CloseHandle(snapshot); }
    }
    private static string ObjectName(IntPtr handle)
    {
        var text = new StringBuilder(512);
        if (handle == IntPtr.Zero || !GetUserObjectInformation(handle, 2, text, text.Capacity * 2, out _)) throw Fail("foreground-desktop-unavailable");
        return text.ToString();
    }
    private static (string Name, string Hash) ReadActiveDesktop()
    {
        if (!Environment.UserInteractive) throw Fail("foreground-desktop-unavailable");
        var desktop = ObjectName(GetThreadDesktop(GetCurrentThreadId()));
        var input = OpenInputDesktop(0, false, 1);
        try { if (input == IntPtr.Zero || ObjectName(input) != desktop) throw Fail("foreground-desktop-changed"); }
        finally { if (input != IntPtr.Zero) CloseDesktop(input); }
        using var process = Process.GetCurrentProcess();
        return (desktop, Hash(process.SessionId.ToString(CultureInfo.InvariantCulture) + ":" + ObjectName(GetProcessWindowStation()) + ":" + desktop));
    }
    private static NativeFailure Fail(string code) => new(code, "Foreground handoff identity or desktop could not be verified");
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ProcessEntry { public uint Size, Usage, Pid; public IntPtr Heap; public uint Module, Threads, Parent; public int Priority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageName(SafeProcessHandle process, int flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint capacity, uint flags);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AllowSetForegroundWindow(uint pid);
}
