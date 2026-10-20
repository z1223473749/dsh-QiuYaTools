using System.Runtime.InteropServices;

namespace QiuYaTools.Windows;

/** Observes physical input without intercepting it. Synthetic SendInput packets are ignored. */
internal sealed class PhysicalInputMonitor : IDisposable
{
    private readonly Hook mouseCallback;
    private readonly Hook keyCallback;
    private readonly IntPtr mouseHook;
    private readonly IntPtr keyHook;
    private readonly Action<bool, bool> onInput;
    internal bool Available => mouseHook != IntPtr.Zero && keyHook != IntPtr.Zero;
    internal PhysicalInputMonitor(Action<bool, bool> onInput)
    {
        this.onInput = onInput;
        mouseCallback = Mouse;
        keyCallback = Keyboard;
        var module = GetModuleHandle(null);
        mouseHook = SetWindowsHookEx(14, mouseCallback, module, 0);
        keyHook = SetWindowsHookEx(13, keyCallback, module, 0);
    }
    private bool OwnWindow(IntPtr window)
    {
        if (window == IntPtr.Zero) return false;
        var root = GetAncestor(window, 2);
        Native.GetWindowThreadProcessId(root == IntPtr.Zero ? window : root, out var pid);
        return pid == Environment.ProcessId;
    }
    private IntPtr Mouse(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0) {
            var input = Marshal.PtrToStructure<MouseData>(data);
            if ((input.Flags & 1) == 0) onInput(OwnWindow(WindowFromPoint(input.Point)), false);
        }
        return CallNextHookEx(mouseHook, code, message, data);
    }
    private IntPtr Keyboard(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && (message.ToInt64() is 0x0100 or 0x0104)) {
            var input = Marshal.PtrToStructure<KeyData>(data);
            if ((input.Flags & 0x10) == 0) onInput(OwnWindow(Native.GetForegroundWindow()), input.Vk == 0x1B);
        }
        return CallNextHookEx(keyHook, code, message, data);
    }
    public void Dispose()
    {
        if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
        if (keyHook != IntPtr.Zero) UnhookWindowsHookEx(keyHook);
        GC.KeepAlive(mouseCallback); GC.KeepAlive(keyCallback);
    }
    private delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] private struct POINT { internal int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseData { internal POINT Point; internal uint MouseDataValue, Flags, Time; internal UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct KeyData { internal uint Vk, Scan, Flags, Time; internal UIntPtr Extra; }
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, Hook callback, IntPtr module, uint threadId);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UnhookWindowsHookEx(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr handle, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? module);
}
