using System.Runtime.InteropServices;

namespace QiuYaTools.Windows;

/** Observes physical input without intercepting it. Synthetic SendInput packets are ignored. */
internal sealed class PhysicalInputMonitor : IDisposable
{
    private readonly Hook mouseCallback;
    private readonly Hook keyCallback;
    private IntPtr mouseHook;
    private IntPtr keyHook;
    private readonly Thread thread;
    private readonly ManualResetEventSlim ready = new(false);
    private uint threadId;
    private int running;
    private int disposed;
    private readonly Action<bool, bool> onInput;
    internal bool Available => Volatile.Read(ref running) == 1 && Volatile.Read(ref disposed) == 0 && thread.IsAlive;
    internal PhysicalInputMonitor(Action<bool, bool> onInput)
    {
        this.onInput = onInput;
        mouseCallback = Mouse;
        keyCallback = Keyboard;
        thread = new Thread(Pump) { IsBackground = true, Name = "QiuYaTools physical input monitor" };
        thread.Start();
        if (!ready.Wait(2000)) Dispose();
    }
    private void Pump()
    {
        try {
            threadId = GetCurrentThreadId();
            PeekMessage(out _, IntPtr.Zero, 0, 0, 0);
            if (Volatile.Read(ref disposed) != 0) return;
            var module = GetModuleHandle(null);
            mouseHook = SetWindowsHookEx(14, mouseCallback, module, 0);
            keyHook = SetWindowsHookEx(13, keyCallback, module, 0);
            if (mouseHook == IntPtr.Zero || keyHook == IntPtr.Zero) return;
            Volatile.Write(ref running, 1); ready.Set();
            while (Volatile.Read(ref disposed) == 0 && GetMessage(out var message, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref message); DispatchMessage(ref message); }
        } finally {
            Volatile.Write(ref running, 0);
            if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
            if (keyHook != IntPtr.Zero) { UnhookWindowsHookEx(keyHook); keyHook = IntPtr.Zero; }
            ready.Set();
        }
    }
    private bool OwnWindow(IntPtr window)
    {
        if (window == IntPtr.Zero) return false;
        var root = GetAncestor(window, 2);
        // A click-through AI pointer is display-only. It must never inherit the
        // preview's exemption from idle own-window physical-input revocation.
        if (AiCursorOverlay.IsCursorWindow(root == IntPtr.Zero ? window : root)) return false;
        Native.GetWindowThreadProcessId(root == IntPtr.Zero ? window : root, out var pid);
        return pid == Environment.ProcessId;
    }
    private IntPtr Mouse(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && Volatile.Read(ref disposed) == 0) {
            var input = Marshal.PtrToStructure<MouseData>(data);
            if (message.ToInt64() == 0x0202) InputTrace.Mark("mouse-hook-up", 0, input.Flags);
            if ((input.Flags & 1) == 0) InputTrace.Mark("physical-hook-enter", 0, message.ToInt64());
            if ((input.Flags & 1) == 0) onInput(OwnWindow(WindowFromPoint(input.Point)), false);
            if ((input.Flags & 1) == 0) InputTrace.Mark("physical-hook-return", 0, message.ToInt64());
        }
        return CallNextHookEx(mouseHook, code, message, data);
    }
    private IntPtr Keyboard(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && Volatile.Read(ref disposed) == 0 && (message.ToInt64() is 0x0100 or 0x0104)) {
            var input = Marshal.PtrToStructure<KeyData>(data);
            if ((input.Flags & 0x10) == 0) onInput(OwnWindow(Native.GetForegroundWindow()), input.Vk == 0x1B);
        }
        return CallNextHookEx(keyHook, code, message, data);
    }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        Volatile.Write(ref running, 0);
        if (threadId != 0) PostThreadMessage(threadId, 0x0012, UIntPtr.Zero, IntPtr.Zero);
        if (Thread.CurrentThread != thread) thread.Join(1500);
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
    [StructLayout(LayoutKind.Sequential)] private struct MSG { internal IntPtr Window; internal uint Message; internal UIntPtr WParam; internal IntPtr LParam; internal uint Time; internal POINT Point; internal uint Private; }
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG message, IntPtr window, uint first, uint last, uint flags);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG message, IntPtr window, uint first, uint last);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? module);
}
