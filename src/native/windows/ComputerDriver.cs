using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;

namespace QiuYaTools.Windows;

internal sealed class ComputerDriver : IDisposable
{
    private readonly object inputLock = new();
    private static readonly SemaphoreSlim accessibilityGate = new(1, 1);
    private readonly SemaphoreSlim captureGate = new(1, 1);
    private readonly SemaphoreSlim actionGate = new(1, 1);
    private readonly ConcurrentDictionary<string, Rectangle> observations = new();
    private readonly HashSet<ushort> heldKeys = new();
    private readonly HashSet<ushort> heldUnicode = new();
    private readonly Func<Native.INPUT[], uint> writeInputs;
    private readonly DesktopLeaseGuard? desktopLease;
    private readonly HashSet<ushort> journalUnicodeSuperset = new();
    private long epoch;
    private long lastEpoch;
    private IntPtr inputTarget;
    private readonly HashSet<uint> heldMouse = new();
    private bool disposed;
    private bool inputCleanupFailed;
    private readonly PhysicalInputMonitor physicalInput;
    internal ComputerDriver(Func<Native.INPUT[], uint>? inputWriter = null) { writeInputs = inputWriter ?? (inputs => Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Native.INPUT>())); desktopLease = inputWriter == null ? new DesktopLeaseGuard() : null; physicalInput = new PhysicalInputMonitor(OnPhysicalInput); }
    private void OnPhysicalInput(bool ownWindow, bool emergency)
    {
        long previous;
        lock (inputLock) {
            previous = epoch;
            if (previous == 0 || disposed || (ownWindow && !emergency && actionGate.CurrentCount != 0)) return;
            epoch = 0;
            try { ClearHeld(); desktopLease?.Release(); } catch (NativeFailure) { /* Preserve owned state; never throw through a native hook callback. */ }
        }
        Program.Emit(new { @event = "humanInput", epoch = previous });
    }
    internal object Status() => new { available = Environment.UserInteractive, platform = "win32", architecture = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(), protocolVersion = 1, permissions = new { screen = Environment.UserInteractive, accessibility = Environment.UserInteractive }, capabilities = new { capture = true, accessibility = true, input = true, preview = true, backgroundInput = false, secureDesktop = false, humanInputDetection = physicalInput.Available } };
    internal object[] Targets()
    {
        var targets = new List<object>();
        Native.EnumWindows((handle, _) => {
            try {
                if (!Native.IsWindowVisible(handle) || Native.IsIconic(handle)) return true;
                Native.GetWindowThreadProcessId(handle, out var pid);
                if (pid == Environment.ProcessId || pid == 0) return true;
                var title = WindowTitle(handle);
                if (string.IsNullOrWhiteSpace(title) || !Native.GetWindowRect(handle, out var rect) || rect.Width < 16 || rect.Height < 16) return true;
                using var process = Process.GetProcessById((int)pid);
                var born = process.StartTime.ToUniversalTime().Ticks;
                var id = $"window:{handle.ToInt64():x}:{pid}:{born}";
                var imagePath = Path.GetFullPath(process.MainModule?.FileName ?? throw new InvalidOperationException());
                var appId = imagePath.Length <= 512 ? imagePath.ToLowerInvariant() : "winexe:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(imagePath.ToUpperInvariant()))).ToLowerInvariant();
                targets.Add(new { id, appId, title, pid, x = rect.Left, y = rect.Top, width = rect.Width, height = rect.Height, scale = Native.GetDpiForWindow(handle) / 96.0 });
            } catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { }
            return targets.Count < 256;
        }, IntPtr.Zero);
        return targets.ToArray();
    }
    private static string WindowTitle(IntPtr handle)
    {
        var text = new StringBuilder(1025);
        Native.GetWindowText(handle, text, text.Capacity);
        return text.ToString();
    }
    private static (IntPtr Handle, Rectangle Rect) Target(string id)
    {
        var pieces = id.Split(':');
        if (pieces.Length != 4 || pieces[0] != "window" || !long.TryParse(pieces[1], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var raw) || !uint.TryParse(pieces[2], out var pid) || !long.TryParse(pieces[3], out var born)) throw new NativeFailure("invalid-target", "Invalid target identity");
        var handle = new IntPtr(raw);
        if (!Native.IsWindow(handle) || !Native.IsWindowVisible(handle) || Native.IsIconic(handle)) throw new NativeFailure("target-unavailable", "Target is closed, hidden or minimized");
        Native.GetWindowThreadProcessId(handle, out var actualPid);
        if (actualPid != pid || pid == Environment.ProcessId) throw new NativeFailure("target-changed", "Target identity changed");
        try { using var process = Process.GetProcessById((int)pid); if (process.StartTime.ToUniversalTime().Ticks != born) throw new NativeFailure("target-changed", "Target process changed"); }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { throw new NativeFailure("target-unavailable", "Target process is unavailable"); }
        if (!Native.GetWindowRect(handle, out var rect) || rect.Width <= 0 || rect.Height <= 0 || rect.Width > 16384 || rect.Height > 16384 || (long)rect.Width * rect.Height > 34_000_000) throw new NativeFailure("target-unavailable", "Target geometry cannot be captured");
        return (handle, Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom));
    }
    internal object Observe(string targetId, bool preview = false)
    {
        var target = Target(targetId);
        // PrintWindow can hang inside another process. Keep its GDI objects owned by one bounded worker;
        // a timed-out worker retains the gate until it actually exits, so retries never create extra capture threads.
        if (!captureGate.Wait(0)) throw new NativeFailure("capture-busy", "The previous target capture is still pending");
        var capture = Task.Run(() => { try { return Capture(target); } finally { captureGate.Release(); } });
        if (!Task.WhenAny(capture, Task.Delay(2500)).GetAwaiter().GetResult().Equals(capture)) throw new NativeFailure("capture-timeout", "The target did not finish rendering within the capture deadline");
        var image = capture.GetAwaiter().GetResult();
        var elements = preview ? "" : ReadElements(target.Handle);
        var after = Target(targetId);
        if (after.Rect != target.Rect) throw new NativeFailure("geometry-changed", "Target moved while observing");
        observations[targetId] = target.Rect;
        return new { targetId, frameId = Guid.NewGuid().ToString("N"), imageBase64 = Convert.ToBase64String(image), mediaType = "image/jpeg", width = target.Rect.Width, height = target.Rect.Height, elements, geometry = new { x = target.Rect.X, y = target.Rect.Y, width = target.Rect.Width, height = target.Rect.Height, scale = Native.GetDpiForWindow(target.Handle) / 96.0 } };
    }
    private static byte[] Capture((IntPtr Handle, Rectangle Rect) target)
    {
        using var bitmap = new Bitmap(target.Rect.Width, target.Rect.Height, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap)) {
            var context = graphics.GetHdc();
            bool rendered;
            try { rendered = Native.PrintWindow(target.Handle, context, 2); }
            finally { graphics.ReleaseHdc(context); }
            if (!rendered) {
                var desktop = SystemInformation.VirtualScreen;
                if (!desktop.Contains(target.Rect)) throw new NativeFailure("capture-unavailable", "Target is outside the visible desktop");
                graphics.CopyFromScreen(target.Rect.Location, Point.Empty, target.Rect.Size, CopyPixelOperation.SourceCopy);
            }
        }
        using var stream = new MemoryStream();
        var codec = ImageCodecInfo.GetImageEncoders().Single(item => item.FormatID == ImageFormat.Jpeg.Guid);
        using var encoder = new EncoderParameters(1);
        encoder.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 75L);
        bitmap.Save(stream, codec, encoder);
        return stream.ToArray();
    }
    private static string ReadElements(IntPtr handle)
    {
        // UIA may block inside a third-party application. Bound waiting; the input/lease thread stays responsive.
        if (!accessibilityGate.Wait(0)) return "Previous accessibility request is still pending.";
        var task = Task.Run(() => {
            try {
                var root = AutomationElement.FromHandle(handle);
                var walker = TreeWalker.ControlViewWalker;
                var text = new StringBuilder();
                var queue = new Queue<(AutomationElement Node, int Depth)>();
                queue.Enqueue((root, 0));
                var stopwatch = Stopwatch.StartNew();
                for (var count = 0; queue.Count > 0 && count < 160 && stopwatch.ElapsedMilliseconds < 1800; count++) {
                    var (node, depth) = queue.Dequeue();
                    var current = node.Current;
                    var bounds = current.BoundingRectangle;
                    var name = current.Name ?? "";
                    text.AppendLine($"{current.ControlType.ProgrammaticName} name={name[..Math.Min(name.Length, 300)]} id={current.AutomationId} enabled={current.IsEnabled} bounds={bounds.X},{bounds.Y},{bounds.Width},{bounds.Height}");
                    if (depth >= 6 || text.Length > 24_000) continue;
                    var child = walker.GetFirstChild(node);
                    var siblings = 0;
                    while (child != null && siblings++ < 80 && queue.Count < 240 && stopwatch.ElapsedMilliseconds < 1800) { queue.Enqueue((child, depth + 1)); child = walker.GetNextSibling(child); }
                }
                return text.ToString();
            } catch (Exception error) { return "Accessibility tree unavailable for this application (" + error.GetType().Name + ")."; }
            finally { accessibilityGate.Release(); }
        });
        try { return task.Wait(6500) ? task.Result : "Accessibility tree timed out for this application."; }
        catch { return "Accessibility tree unavailable for this application."; }
    }
    private static long Epoch(JsonElement request)
    {
        if (!request.TryGetProperty("epoch", out var value) || !value.TryGetInt64(out var number) || number <= 0 || number > 9_007_199_254_740_991) throw new NativeFailure("invalid-epoch", "Epoch must be a positive safe integer");
        return number;
    }
    internal object Lease(JsonElement request)
    {
        var requested = Epoch(request);
        lock (inputLock) {
            if (inputCleanupFailed) throw new NativeFailure("input-cleanup-failed", "Input cleanup is uncertain; retire this companion before reconnecting");
            if (disposed || requested <= lastEpoch) throw new NativeFailure("stale-epoch", "Lease epoch is stale");
            ClearHeld(); desktopLease?.Release(); desktopLease?.Acquire(); epoch = requested; lastEpoch = requested;
        }
        return new { epoch = requested, acquired = true };
    }
    internal object Release(JsonElement request)
    {
        var requested = Epoch(request);
        lock (inputLock) {
            if (epoch == requested) { epoch = 0; ClearHeld(); desktopLease?.Release(); }
            if (inputCleanupFailed) throw new NativeFailure("input-cleanup-failed", "Input cleanup is uncertain; retire this companion before reconnecting");
        }
        return new { epoch = requested, released = true };
    }
    private void Check(long requested)
    {
        if (inputCleanupFailed) throw new NativeFailure("input-cleanup-failed", "Input cleanup is uncertain; retire this companion before reconnecting");
        if (disposed || epoch == 0 || epoch != requested) throw new NativeFailure("stale-epoch", "Input lease has been revoked");
    }
    private void Send(long requested, params Native.INPUT[] inputs)
    {
        lock (inputLock) { Check(requested); if (inputTarget != IntPtr.Zero && Native.GetForegroundWindow() != inputTarget) throw new NativeFailure("foreground-changed", "Target lost foreground input ownership"); if (writeInputs(inputs) != inputs.Length) throw new NativeFailure("input-denied", "Windows refused input; the target may require a higher integrity level"); }
    }
    internal async Task<object> Act(JsonElement request)
    {
        if (!actionGate.Wait(0)) throw new NativeFailure("input-busy", "Another input action is still running");
        try { return await ActCore(request); }
        finally { actionGate.Release(); }
    }
    private async Task<object> ActCore(JsonElement request)
    {
        var requested = Epoch(request);
        var targetId = Program.Text(request, "targetId", 256);
        if (!request.TryGetProperty("action", out var action) || action.ValueKind != JsonValueKind.Object) throw new NativeFailure("invalid-request", "Missing action");
        var kind = Program.Text(action, "kind", 32);
        var target = Target(targetId);
        lock (inputLock) { Check(requested); }
        if (!observations.TryGetValue(targetId, out var observed)) throw new NativeFailure("observation-required", "Observe the target before input");
        if (observed != target.Rect) throw new NativeFailure("geometry-changed", "Target moved; observe again before input");
        using var uncovered = BrowserWindow.UncoverTarget(target.Rect);
        if (Native.GetForegroundWindow() != target.Handle) {
            Native.SetForegroundWindow(target.Handle);
            await Task.Delay(80);
            if (Native.GetForegroundWindow() != target.Handle) throw new NativeFailure("foreground-denied", "Activate the target window before input");
        }
        if (Target(targetId).Rect != observed) throw new NativeFailure("geometry-changed", "Target moved while activating");
        lock (inputLock) { Check(requested); inputTarget = target.Handle; }
        Program.Emit(new { @event = "action", phase = "started", targetId, epoch = requested, action });
        switch (kind) {
            case "move": Move(requested, target.Rect, action, "x", "y"); break;
            case "click": {
                Move(requested, target.Rect, action, "x", "y");
                var button = Button(action);
                try {
                    lock (inputLock) { Check(requested); heldMouse.Add(button.Up); EmitHeld(); Send(requested, Native.Mouse(button.Down)); }
                } finally { lock (inputLock) { var released = ReleaseMouse(button.Up); EmitHeld(); if (!released) CleanupFailure(); } }
                break;
            }
            case "drag": {
                var from = PointOf(target.Rect, action, "x", "y");
                var to = PointOf(target.Rect, action, "toX", "toY");
                MoveAbsolute(requested, from);
                var button = Button(action);
                try {
                    lock (inputLock) { Check(requested); heldMouse.Add(button.Up); EmitHeld(); Send(requested, Native.Mouse(button.Down)); }
                    var stepDelay = (int)Math.Clamp(Math.Sqrt(Math.Pow(to.X - from.X, 2) + Math.Pow(to.Y - from.Y, 2)) / 10, 10, 40);
                    for (var step = 1; step <= 20; step++) {
                        MoveAbsolute(requested, new Point(from.X + (to.X - from.X) * step / 20, from.Y + (to.Y - from.Y) * step / 20));
                        await Task.Delay(stepDelay);
                    }
                } finally { lock (inputLock) { var released = ReleaseMouse(button.Up); EmitHeld(); if (!released) CleanupFailure(); } }
                break;
            }
            case "scroll": {
                Move(requested, target.Rect, action, "x", "y");
                var dy = Program.Number(action, "deltaY"); var dx = Program.Number(action, "deltaX");
                if (Math.Abs(dy) > 12000 || Math.Abs(dx) > 12000) throw new NativeFailure("invalid-action", "Scroll distance is too large");
                if (dy != 0) Send(requested, Native.Mouse(0x0800, unchecked((uint)(int)-dy)));
                if (dx != 0) Send(requested, Native.Mouse(0x1000, unchecked((uint)(int)dx)));
                break;
            }
            case "type": {
                var text = Program.Text(action, "text", 100_000);
                foreach (var chunk in text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Chunk(512)) {
                    lock (inputLock) { Check(requested); journalUnicodeSuperset.UnionWith(chunk.Select(character => (ushort)(character == '\n' ? '\r' : character))); EmitHeld(); }
                    try {
                        foreach (var character in chunk) {
                            // A CRLF pair is one logical edit newline, including in Win32 EDIT controls.
                            var unit = character == '\n' ? '\r' : character;
                            try {
                                lock (inputLock) { Check(requested); heldUnicode.Add(unit); EmitHeld(); Send(requested, Native.Keyboard(0, unit, 0x0004)); }
                            } finally { lock (inputLock) { var released = ReleaseUnicode(unit); EmitHeld(); if (!released) CleanupFailure(); } }
                            if ((character & 15) == 0) await Task.Delay(1);
                        }
                    } finally { lock (inputLock) { journalUnicodeSuperset.Clear(); EmitHeld(); } }
                }
                break;
            }
            case "key": await Key(requested, Program.Text(action, "key", 128)); break;
            default: throw new NativeFailure("invalid-action", "Unknown input action");
        }
        Program.Emit(new { @event = "action", phase = "completed", targetId, epoch = requested, action });
        return new { performed = true, epoch = requested, targetId };
    }
    private static Point PointOf(Rectangle rect, JsonElement action, string xName, string yName)
    {
        if (!action.TryGetProperty(xName, out _) || !action.TryGetProperty(yName, out _)) throw new NativeFailure("invalid-action", "Missing pointer coordinates");
        var x = Program.Number(action, xName); var y = Program.Number(action, yName);
        if (x < 0 || y < 0 || x >= rect.Width || y >= rect.Height) throw new NativeFailure("invalid-coordinate", "Pointer is outside the observed target");
        return new Point(rect.X + Math.Clamp((int)Math.Round(x), 0, rect.Width - 1), rect.Y + Math.Clamp((int)Math.Round(y), 0, rect.Height - 1));
    }
    private static (uint Down, uint Up) Button(JsonElement action)
    {
        var button = action.TryGetProperty("button", out var value) ? value.GetString() : "left";
        return button switch { "left" => (0x0002, 0x0004), "right" => (0x0008, 0x0010), "middle" => (0x0020, 0x0040), _ => throw new NativeFailure("invalid-button", "Unsupported mouse button") };
    }
    private void Move(long requested, Rectangle rect, JsonElement action, string xName, string yName) => MoveAbsolute(requested, PointOf(rect, action, xName, yName));
    private void MoveAbsolute(long requested, Point point)
    {
        var screen = SystemInformation.VirtualScreen;
        if (!screen.Contains(point)) throw new NativeFailure("invalid-coordinate", "Pointer is outside the visible desktop");
        var x = (int)Math.Round((point.X - screen.Left) * 65535.0 / Math.Max(1, screen.Width - 1));
        var y = (int)Math.Round((point.Y - screen.Top) * 65535.0 / Math.Max(1, screen.Height - 1));
        Send(requested, Native.Mouse(0x0001 | 0x8000 | 0x4000, 0, x, y));
    }
    private async Task Key(long requested, string raw)
    {
        var names = raw.Replace("Control", "CTRL", StringComparison.OrdinalIgnoreCase).Replace("Arrow", "", StringComparison.OrdinalIgnoreCase).Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (names.Length == 0 || names.Length > 5) throw new NativeFailure("invalid-key", "Invalid key combination");
        var keys = names.Select(name => name.ToUpperInvariant() switch {
            "CTRL" => (ushort)0x11, "ALT" => (ushort)0x12, "SHIFT" => (ushort)0x10, "META" or "WIN" => (ushort)0x5B,
            "ENTER" or "RETURN" => (ushort)0x0D, "TAB" => (ushort)0x09, "ESC" or "ESCAPE" => (ushort)0x1B,
            "BACKSPACE" => (ushort)0x08, "DELETE" => (ushort)0x2E, "SPACE" => (ushort)0x20,
            "LEFT" => (ushort)0x25, "UP" => (ushort)0x26, "RIGHT" => (ushort)0x27, "DOWN" => (ushort)0x28,
            "HOME" => (ushort)0x24, "END" => (ushort)0x23, "PAGEUP" => (ushort)0x21, "PAGEDOWN" => (ushort)0x22,
            _ when name.Length == 1 && char.IsAsciiLetterOrDigit(name[0]) => (ushort)char.ToUpperInvariant(name[0]),
            _ when name.StartsWith('F') && int.TryParse(name.AsSpan(1), out var function) && function is >= 1 and <= 24 => (ushort)(0x6F + function),
            _ => throw new NativeFailure("invalid-key", "Unsupported key name")
        }).Distinct().ToArray();
        try {
            foreach (var key in keys) { lock (inputLock) { Check(requested); heldKeys.Add(key); EmitHeld(); Send(requested, Native.Keyboard(key, 0, 0)); } }
            await Task.Delay(12);
        } finally {
            lock (inputLock) { var released = true; foreach (var key in keys.Reverse()) if (!ReleaseKey(key)) released = false; EmitHeld(); if (!released) CleanupFailure(); }
        }
    }
    private void EmitHeld()
    {
        var snapshot = new { @event = "inputHeld", ownerId = desktopLease?.OwnerId, keys = heldKeys.Order().ToArray(), unicodeUnits = heldUnicode.Order().ToArray(), mouseButtons = heldMouse.Select(flag => flag switch { 0x0004 => "left", 0x0010 => "right", _ => "middle" }).Order().ToArray() };
        try { if (desktopLease?.OwnerId != null) desktopLease.Record(heldKeys, heldMouse, heldUnicode.Concat(journalUnicodeSuperset)); }
        catch (NativeFailure) { epoch = 0; inputCleanupFailed = true; Program.Emit(snapshot); throw; }
        Program.Emit(snapshot);
    }
    private bool ReleaseKey(ushort key)
    {
        if (!heldKeys.Contains(key)) return true;
        if (writeInputs([Native.Keyboard(key, 0, 0x0002)]) != 1) return false;
        heldKeys.Remove(key); return true;
    }
    private bool ReleaseUnicode(ushort unit)
    {
        if (!heldUnicode.Contains(unit)) return true;
        if (writeInputs([Native.Keyboard(0, unit, 0x0004 | 0x0002)]) != 1) return false;
        heldUnicode.Remove(unit); return true;
    }
    private bool ReleaseMouse(uint button)
    {
        if (!heldMouse.Contains(button)) return true;
        if (writeInputs([Native.Mouse(button)]) != 1) return false;
        heldMouse.Remove(button); return true;
    }
    private void CleanupFailure()
    {
        epoch = 0; inputCleanupFailed = true;
        throw new NativeFailure("input-cleanup-failed", "Windows did not confirm all owned input releases; retire this companion before reconnecting");
    }
    private void ClearHeld()
    {
        var released = true;
        foreach (var key in heldKeys.ToArray()) if (!ReleaseKey(key)) released = false;
        foreach (var button in heldMouse.ToArray()) if (!ReleaseMouse(button)) released = false;
        foreach (var unit in heldUnicode.ToArray()) if (!ReleaseUnicode(unit)) released = false;
        EmitHeld();
        if (!released) CleanupFailure();
    }
    internal static object TestReleaseFailures()
    {
        var accepted = false;
        var sent = new List<Native.INPUT>();
        using var driver = new ComputerDriver(inputs => { sent.AddRange(inputs); return accepted ? (uint)inputs.Length : 0; });
        driver.epoch = 9;
        driver.heldKeys.Add(0x11); driver.heldMouse.Add(0x0004); driver.heldUnicode.Add(0x4E2D);
        try { driver.ClearHeld(); throw new InvalidOperationException("Rejected releases must fail"); }
        catch (NativeFailure failure) when (failure.Code == "input-cleanup-failed") { }
        if (!driver.inputCleanupFailed || driver.epoch != 0 || driver.heldKeys.Count != 1 || driver.heldMouse.Count != 1 || driver.heldUnicode.Count != 1) throw new InvalidOperationException("Rejected release state was lost");
        accepted = true;
        driver.ClearHeld();
        if (driver.heldKeys.Count != 0 || driver.heldMouse.Count != 0 || driver.heldUnicode.Count != 0) throw new InvalidOperationException("Accepted releases were not removed");
        if (!sent.Any(input => input.Type == 1 && input.Data.Keyboard.Scan == 0x4E2D && input.Data.Keyboard.Flags == 6)) throw new InvalidOperationException("Unicode release must preserve its scan unit");
        try { driver.Check(9); throw new InvalidOperationException("Failed cleanup must fence the worker"); }
        catch (NativeFailure failure) when (failure.Code == "input-cleanup-failed") { }
        return new { passed = true, checks = 4, kind = "deterministic-rejected-release-state-machine", actualOsInput = false };
    }
    public void Dispose()
    {
        try { lock (inputLock) { disposed = true; epoch = 0; ClearHeld(); desktopLease?.Release(); } }
        finally { physicalInput.Dispose(); desktopLease?.Dispose(); }
    }
}

internal static class Native
{
    internal delegate bool EnumWindowsCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr handle);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool PrintWindow(IntPtr handle, IntPtr context, uint flags);
    [DllImport("user32.dll", SetLastError = true)] internal static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [StructLayout(LayoutKind.Sequential)] internal struct RECT { internal int Left, Top, Right, Bottom; internal readonly int Width => Right - Left; internal readonly int Height => Bottom - Top; }
    [StructLayout(LayoutKind.Sequential)] internal struct INPUT { internal uint Type; internal InputUnion Data; }
    [StructLayout(LayoutKind.Explicit)] internal struct InputUnion { [FieldOffset(0)] internal MOUSEINPUT Mouse; [FieldOffset(0)] internal KEYBDINPUT Keyboard; }
    [StructLayout(LayoutKind.Sequential)] internal struct MOUSEINPUT { internal int Dx, Dy; internal uint MouseData, Flags, Time; internal UIntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] internal struct KEYBDINPUT { internal ushort Vk, Scan; internal uint Flags, Time; internal UIntPtr ExtraInfo; }
    internal static INPUT Mouse(uint flags, uint data = 0, int x = 0, int y = 0) => new() { Type = 0, Data = new() { Mouse = new() { Dx = x, Dy = y, MouseData = data, Flags = flags } } };
    internal static INPUT Keyboard(ushort key, ushort scan, uint flags) => new() { Type = 1, Data = new() { Keyboard = new() { Vk = key, Scan = scan, Flags = flags } } };
}
