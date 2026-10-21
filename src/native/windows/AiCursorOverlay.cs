using System.Collections.Concurrent;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace QiuYaTools.Windows;

internal sealed record AiCursorFrame(long Epoch, long LastEpoch, long Generation, bool IsAi, string? TargetId,
    IntPtr Target, uint TargetPid, Rectangle Bounds, Point Position, bool Pending, bool Rendered);
internal sealed record AiCursorSnapshot(int X, int Y, bool Visible, string Actor, string? TargetId);

/** Immutable CAS state: neither the input hook nor a stale renderer waits for a UI lock. */
internal sealed class AiCursorState
{
    private AiCursorFrame frame = new(0, 0, 0, false, null, IntPtr.Zero, 0, Rectangle.Empty, Point.Empty, false, false);
    private long generation;
    internal AiCursorFrame Read() => Volatile.Read(ref frame);
    internal bool Lease(long epoch, bool isAi)
    {
        if (epoch <= 0) return false;
        for (;;) {
            var old = Read(); if (epoch <= old.LastEpoch) return false;
            var next = new AiCursorFrame(epoch, epoch, Interlocked.Increment(ref generation), isAi, null, IntPtr.Zero, 0, Rectangle.Empty, Point.Empty, false, false);
            if (ReferenceEquals(Interlocked.CompareExchange(ref frame, next, old), old)) return true;
        }
    }
    internal bool Move(long epoch, string targetId, IntPtr target, uint pid, Rectangle bounds, Point point)
    {
        if (epoch <= 0 || target == IntPtr.Zero || pid == 0 || string.IsNullOrEmpty(targetId) || !bounds.Contains(point)) return false;
        for (;;) {
            var old = Read(); if (old.Epoch != epoch || !old.IsAi) return false;
            var next = old with { Generation = Interlocked.Increment(ref generation), TargetId = targetId, Target = target,
                TargetPid = pid, Bounds = bounds, Position = point, Pending = true, Rendered = false };
            if (ReferenceEquals(Interlocked.CompareExchange(ref frame, next, old), old)) return true;
        }
    }
    internal bool Revoke(long epoch) => Change(epoch, null, true);
    internal bool Hide(long epoch) => Change(epoch, null, false);
    internal bool HideGeneration(long value) => Change(null, value, false);
    private bool Change(long? epoch, long? expectedGeneration, bool revoke)
    {
        for (;;) {
            var old = Read();
            if ((epoch.HasValue && (epoch <= 0 || old.Epoch != epoch)) || (expectedGeneration.HasValue && old.Generation != expectedGeneration)) return false;
            if (!old.Pending && !old.Rendered && (!revoke || old.Epoch == 0)) return false;
            var next = old with { Epoch = revoke ? 0 : old.Epoch, Generation = Interlocked.Increment(ref generation), Pending = false, Rendered = false };
            if (ReferenceEquals(Interlocked.CompareExchange(ref frame, next, old), old)) return true;
        }
    }
    internal bool CommitRendered(long value)
    {
        for (;;) {
            var old = Read(); if (old.Generation != value || old.Epoch <= 0 || !old.IsAi || !old.Pending) return false;
            if (ReferenceEquals(Interlocked.CompareExchange(ref frame, old with { Rendered = true }, old), old)) return true;
        }
    }
    internal AiCursorSnapshot Snapshot(string? targetId = null)
    {
        var value = Read();
        return new(value.Position.X - value.Bounds.X, value.Position.Y - value.Bounds.Y,
            value.Epoch > 0 && value.IsAi && value.Pending && value.Rendered && (targetId == null || targetId == value.TargetId), "ai", value.TargetId);
    }
}

/** A separate, input-free transparent surface. It never changes the system cursor. */
internal sealed class AiCursorOverlay : IDisposable
{
    internal const float HotspotX = 18, HotspotY = 16;
    private const int WakeMessage = 0x8000 + 73;
    private static readonly ConcurrentDictionary<IntPtr, byte> cursorWindows = new();
    private readonly AiCursorState state = new();
    private readonly AiCursorState operation = new();
    private readonly Func<long, bool> leaseIsCurrent;
    private readonly Thread? thread;
    private readonly ManualResetEventSlim ready = new(false);
    private IntPtr window;
    private int wakePosted;
    private int disposed;
    private long paintedGeneration = -1;
    private long paintedOperationGeneration = -1;
    private OperationForm? operationForm;
    private readonly WinEvent foregroundCallback;
    internal static bool IsCursorWindow(IntPtr handle) => cursorWindows.ContainsKey(handle);
    internal AiCursorOverlay(Func<long, bool> leaseIsCurrent, bool enabled)
    {
        this.leaseIsCurrent = leaseIsCurrent;
        foregroundCallback = (_, _, _, _, _, _, _) => {
            var value = state.Read(); if (value.Pending && !Eligible(value)) { state.HideGeneration(value.Generation); Wake(); }
            var activity = operation.Read(); if (activity.Pending && !EligibleOperation(activity)) { operation.HideGeneration(activity.Generation); Wake(); }
        };
        if (!enabled) return;
        thread = new Thread(Pump) { IsBackground = true, Name = "QiuYaTools AI pointer display" };
        thread.SetApartmentState(ApartmentState.STA); thread.Start();
        ready.Wait(2000);
    }
    internal void Lease(long epoch, bool isAi) { operation.Lease(epoch, isAi); if (state.Lease(epoch, isAi)) Wake(); }
    internal void Revoke(long epoch) { operation.Revoke(epoch); state.Revoke(epoch); Wake(); }
    internal void Hide(long epoch) { operation.Hide(epoch); state.Hide(epoch); Wake(); }
    internal void OperationStart(long epoch, string targetId, IntPtr target, Rectangle bounds)
    {
        if (Volatile.Read(ref disposed) != 0 || !leaseIsCurrent(epoch)) return;
        var old = operation.Read();
        if (old.Epoch == epoch && old.Pending && old.TargetId == targetId && old.Target == target && old.Bounds == bounds) return;
        Native.GetWindowThreadProcessId(target, out var pid);
        if (operation.Move(epoch, targetId, target, pid, bounds, new Point(bounds.X + bounds.Width / 2, bounds.Y + bounds.Height / 2))) Wake();
    }
    internal void OperationEnd(long epoch) { if (operation.Hide(epoch)) Wake(); }
    internal object OperationSnapshot()
    {
        var value = operation.Read();
        if (value.Pending && !EligibleOperation(value)) { operation.HideGeneration(value.Generation); Wake(); }
        var snapshot = operation.Snapshot();
        return new { visible = snapshot.Visible, actor = "ai", text = "AI 操作中", targetId = snapshot.TargetId, epoch = value.Epoch > 0 ? (long?)value.Epoch : null };
    }
    private bool EligibleOperation(AiCursorFrame value)
    {
        if (Volatile.Read(ref disposed) != 0 || value.Epoch <= 0 || !value.IsAi || !value.Pending || !leaseIsCurrent(value.Epoch) ||
            !Native.IsWindow(value.Target) || !Native.IsWindowVisible(value.Target) || Native.IsIconic(value.Target) || Native.GetForegroundWindow() != value.Target ||
            !Native.GetWindowRect(value.Target, out var rectangle) || Rectangle.FromLTRB(rectangle.Left, rectangle.Top, rectangle.Right, rectangle.Bottom) != value.Bounds) return false;
        Native.GetWindowThreadProcessId(value.Target, out var pid); return pid == value.TargetPid;
    }
    internal void Move(long epoch, string targetId, IntPtr target, Rectangle bounds, Point point)
    {
        if (Volatile.Read(ref disposed) != 0 || !leaseIsCurrent(epoch)) return;
        Native.GetWindowThreadProcessId(target, out var pid);
        if (state.Move(epoch, targetId, target, pid, bounds, point)) Wake();
    }
    internal AiCursorSnapshot Snapshot(string? targetId = null)
    {
        var value = state.Read();
        if (value.Pending && !Eligible(value)) { state.HideGeneration(value.Generation); Wake(); }
        return state.Snapshot(targetId);
    }
    private bool Eligible(AiCursorFrame value)
    {
        if (Volatile.Read(ref disposed) != 0 || value.Epoch <= 0 || !value.IsAi || !value.Pending || !leaseIsCurrent(value.Epoch) ||
            !Native.IsWindow(value.Target) || !Native.IsWindowVisible(value.Target) || Native.IsIconic(value.Target) || Native.GetForegroundWindow() != value.Target ||
            !Native.GetWindowRect(value.Target, out var rectangle) || Rectangle.FromLTRB(rectangle.Left, rectangle.Top, rectangle.Right, rectangle.Bottom) != value.Bounds) return false;
        if (value.Rendered && (Volatile.Read(ref window) == IntPtr.Zero || !Native.IsWindowVisible(Volatile.Read(ref window)))) return false;
        Native.GetWindowThreadProcessId(value.Target, out var pid);
        return pid == value.TargetPid && value.Bounds.Contains(value.Position);
    }
    private void Wake()
    {
        var handle = Volatile.Read(ref window);
        if (handle != IntPtr.Zero && Interlocked.CompareExchange(ref wakePosted, 1, 0) == 0 && !PostMessage(handle, WakeMessage, UIntPtr.Zero, IntPtr.Zero)) Volatile.Write(ref wakePosted, 0);
    }
    private void Pump()
    {
        IntPtr hook = IntPtr.Zero, badgeHandle = IntPtr.Zero;
        try {
            using var context = new ApplicationContext();
            using var form = new PointerForm(this, context);
            using var badge = new OperationForm();
            operationForm = badge;
            var handle = form.Handle; cursorWindows.TryAdd(handle, 0); Volatile.Write(ref window, handle);
            badgeHandle = badge.Handle; cursorWindows.TryAdd(badgeHandle, 0);
            // This excludes our own visual from supported DWM captures. It is
            // not a guarantee about every third-party or fallback capture API.
            if (OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041)) _ = SetWindowDisplayAffinity(handle, 0x11);
            using var watch = new System.Windows.Forms.Timer { Interval = 16 };
            watch.Tick += (_, _) => Render(form, context); watch.Start();
            hook = SetWinEventHook(3, 3, IntPtr.Zero, foregroundCallback, 0, 0, 0);
            ready.Set(); Application.Run(context);
        } catch { var value = state.Read(); state.HideGeneration(value.Generation); }
        finally {
            var handle = Interlocked.Exchange(ref window, IntPtr.Zero);
            operationForm = null; if (badgeHandle != IntPtr.Zero) cursorWindows.TryRemove(badgeHandle, out _);
            if (handle != IntPtr.Zero) cursorWindows.TryRemove(handle, out _);
            if (hook != IntPtr.Zero) UnhookWinEvent(hook);
            ready.Set(); GC.KeepAlive(foregroundCallback);
        }
    }
    private void RenderOperation(OperationForm badge)
    {
        var value = operation.Read();
        if (!EligibleOperation(value)) { operation.HideGeneration(value.Generation); badge.HideSurface(); paintedOperationGeneration = -1; return; }
        if (paintedOperationGeneration == value.Generation) return;
        try {
            if (!badge.Present(value) || !EligibleOperation(value) || !operation.CommitRendered(value.Generation)) { badge.HideSurface(); paintedOperationGeneration = -1; return; }
            paintedOperationGeneration = value.Generation;
        } catch { operation.HideGeneration(value.Generation); badge.HideSurface(); paintedOperationGeneration = -1; }
    }
    private void Render(PointerForm form, ApplicationContext context)
    {
        Volatile.Write(ref wakePosted, 0);
        if (operationForm != null) RenderOperation(operationForm);
        if (Volatile.Read(ref disposed) != 0) { form.HideSurface(); context.ExitThread(); return; }
        var value = state.Read();
        if (!Eligible(value)) { state.HideGeneration(value.Generation); form.HideSurface(); paintedGeneration = -1; return; }
        if (paintedGeneration == value.Generation) return;
        try {
            form.PaintPointer(value);
            if (!Eligible(value) || !state.CommitRendered(value.Generation)) { form.HideSurface(); paintedGeneration = -1; return; }
            paintedGeneration = value.Generation;
        } catch { state.HideGeneration(value.Generation); form.HideSurface(); paintedGeneration = -1; }
    }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        var value = state.Read(); state.Revoke(value.Epoch); var activity = operation.Read(); operation.Revoke(activity.Epoch); Wake();
        if (thread == null || (Thread.CurrentThread != thread && thread.Join(2000))) ready.Dispose();
    }
    internal static Rectangle? OperationBounds(Rectangle target, float scale)
    {
        scale = Math.Clamp(scale, 0.75f, 4f);
        var width = (int)Math.Ceiling(146 * scale); var height = (int)Math.Ceiling(30 * scale);
        var margin = (int)Math.Ceiling(12 * scale); var top = (int)Math.Ceiling(40 * scale);
        if (target.Width < width + margin * 2 || target.Height < top + height + margin) return null;
        return new Rectangle(target.Right - margin - width, target.Top + top, width, height);
    }
    private sealed class OperationForm : Form
    {
        private float scale = 1;
        internal OperationForm()
        {
            FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
            Text = "QiuYaTools AI operation"; Enabled = false; Opacity = .96; BackColor = Color.FromArgb(7, 44, 51);
            SetStyle(ControlStyles.Selectable, false); DoubleBuffered = true;
        }
        protected override bool ShowWithoutActivation => true;
        protected override CreateParams CreateParams { get { var value = base.CreateParams; value.ExStyle |= 0x00080000 | 0x00000020 | 0x08000000 | 0x00000080 | 0x00000008; value.Style |= 0x08000000; return value; } }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x0084) { message.Result = new IntPtr(-1); return; }
            if (message.Msg == 0x0021) { message.Result = new IntPtr(3); return; }
            base.WndProc(ref message);
        }
        internal void HideSurface() { if (IsHandleCreated && Native.IsWindowVisible(Handle)) ShowWindow(Handle, 0); }
        internal bool Present(AiCursorFrame value)
        {
            scale = Math.Clamp(Native.GetDpiForWindow(value.Target) / 96f, .75f, 4f);
            var rect = OperationBounds(value.Bounds, scale); if (!rect.HasValue) return false;
            var r = rect.Value;
            using var rounded = new GraphicsPath(); var diameter = Math.Min(r.Height, 30 * scale);
            rounded.AddArc(0, 0, diameter, diameter, 180, 90); rounded.AddArc(r.Width - diameter, 0, diameter, diameter, 270, 90);
            rounded.AddArc(r.Width - diameter, r.Height - diameter, diameter, diameter, 0, 90); rounded.AddArc(0, r.Height - diameter, diameter, diameter, 90, 90); rounded.CloseFigure();
            var old = Region; Region = new Region(rounded); old?.Dispose();
            if (!Native.SetWindowPos(Handle, new IntPtr(-1), r.X, r.Y, r.Width, r.Height, 0x0010 | 0x0040 | 0x0200)) return false;
            Invalidate();
            const long required = 0x00080000 | 0x00000020 | 0x08000000 | 0x00000080 | 0x00000008;
            return Native.IsWindowVisible(Handle) && !IsWindowEnabled(Handle) && (GetWindowLongPtr(Handle, -20).ToInt64() & required) == required;
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e); var g = e.Graphics; g.ScaleTransform(scale, scale); g.SmoothingMode = SmoothingMode.AntiAlias;
            using var cyan = new SolidBrush(Color.FromArgb(82, 230, 237)); using var outline = new Pen(Color.FromArgb(130, 82, 230, 237), 1.1f);
            g.DrawRectangle(outline, 11, 7, 18, 14); g.DrawLine(outline, 20, 21, 20, 24); g.DrawLine(outline, 17, 24, 23, 24);
            using var q = new Font("Segoe UI", 8, FontStyle.Bold, GraphicsUnit.Pixel); g.DrawString("Q", q, cyan, 16, 8);
            using var text = new Font("Segoe UI", 12, FontStyle.Regular, GraphicsUnit.Pixel); using var white = new SolidBrush(Color.FromArgb(225, 252, 255));
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit; g.DrawString("AI 操作中", text, white, 38, 7);
        }
    }
    private sealed class PointerForm : Form
    {
        private readonly AiCursorOverlay owner;
        private readonly ApplicationContext context;
        internal PointerForm(AiCursorOverlay owner, ApplicationContext context)
        {
            this.owner = owner; this.context = context; FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual; Text = ""; Enabled = false;
            SetStyle(ControlStyles.Selectable, false);
        }
        protected override bool ShowWithoutActivation => true;
        protected override CreateParams CreateParams {
            get { var value = base.CreateParams; value.ExStyle |= 0x00080000 | 0x00000020 | 0x08000000 | 0x00000080 | 0x00000008; value.Style |= 0x08000000; return value; }
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == WakeMessage) { owner.Render(this, context); return; }
            if (message.Msg == 0x0084) { message.Result = new IntPtr(-1); return; }
            if (message.Msg == 0x0021) { message.Result = new IntPtr(3); return; }
            base.WndProc(ref message);
        }
        internal void HideSurface() { if (IsHandleCreated && Native.IsWindowVisible(Handle)) ShowWindow(Handle, 0); }
        internal void PaintPointer(AiCursorFrame value)
        {
            var scale = Math.Clamp(Native.GetDpiForWindow(value.Target) / 96f, 0.75f, 4f);
            var width = (int)Math.Ceiling(46 * scale); var height = (int)Math.Ceiling(58 * scale);
            var location = new Point(value.Position.X - (int)Math.Round(HotspotX * scale), value.Position.Y - (int)Math.Round(HotspotY * scale));
            using var bitmap = DrawPointer(scale, value.Bounds, location);
            var screen = GetDC(IntPtr.Zero); var memory = CreateCompatibleDC(screen); var nativeBitmap = IntPtr.Zero; var old = IntPtr.Zero;
            try {
                if (screen == IntPtr.Zero || memory == IntPtr.Zero) throw new InvalidOperationException("AI pointer context unavailable");
                nativeBitmap = bitmap.GetHbitmap(Color.FromArgb(0)); old = SelectObject(memory, nativeBitmap);
                var destination = new NativePoint(location.X, location.Y); var size = new NativeSize(width, height); var source = new NativePoint(0, 0);
                var blend = new Blend { Operation = 0, Flags = 0, Alpha = 255, Format = 1 };
                if (!UpdateLayeredWindow(Handle, screen, ref destination, ref size, memory, ref source, 0, ref blend, 2) ||
                    !Native.SetWindowPos(Handle, new IntPtr(-1), location.X, location.Y, width, height, 0x0010 | 0x0040 | 0x0200)) throw new InvalidOperationException("AI pointer surface unavailable");
                const long required = 0x00080000 | 0x00000020 | 0x08000000 | 0x00000080 | 0x00000008;
                if (!Native.IsWindowVisible(Handle) || IsWindowEnabled(Handle) || (GetWindowLongPtr(Handle, -20).ToInt64() & required) != required)
                    throw new InvalidOperationException("AI pointer did not confirm transparent non-activating presentation");
            } finally { if (old != IntPtr.Zero) SelectObject(memory, old); if (nativeBitmap != IntPtr.Zero) DeleteObject(nativeBitmap); if (memory != IntPtr.Zero) DeleteDC(memory); if (screen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screen); }
        }
    }
    internal static Bitmap DrawPointer(float scale, Rectangle target, Point location)
    {
        var bitmap = new Bitmap((int)Math.Ceiling(46 * scale), (int)Math.Ceiling(58 * scale), PixelFormat.Format32bppPArgb);
        try {
            using var glyph = new Bitmap(bitmap.Width, bitmap.Height, PixelFormat.Format32bppPArgb);
            using (var graphics = Graphics.FromImage(glyph)) {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                // Approved 18x20 SVG. Its shared desktop/preview hotspot (2,3) is the physical action point.
                using var transform = new Matrix(scale, 0, 0, scale, (HotspotX - 2) * scale, (HotspotY - 3) * scale);
                graphics.Transform = transform;
                using var path = new GraphicsPath();
                path.AddBezier(3.1f, 2.4f, 2.3f, 2, 1.6f, 2.6f, 1.8f, 3.5f);
                path.AddLine(1.8f, 3.5f, 4, 16); path.AddBezier(4, 16, 4.2f, 17.1f, 5.4f, 17.3f, 6, 16.3f);
                path.AddLine(6, 16.3f, 9, 11.4f); path.AddLine(9, 11.4f, 14.4f, 9.1f);
                path.AddBezier(14.4f, 9.1f, 15.5f, 8.7f, 15.6f, 7.4f, 14.5f, 6.9f); path.CloseFigure();
                using var fill = new SolidBrush(Color.FromArgb(115, 149, 153, 158)); graphics.FillPath(fill, path);
                using var outline = new Pen(Color.FromArgb(245, 255, 255, 255), 1.25f) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round };
                graphics.DrawPath(outline, path);
            }
            var width = bitmap.Width; var height = bitmap.Height; var source = Pixels(glyph); var horizontal = new double[width * height];
            var sigma = 5 * scale; var radius = (int)Math.Ceiling(3 * sigma); var kernel = new double[2 * radius + 1]; var total = 0.0;
            for (var offset = -radius; offset <= radius; offset++) { var weight = Math.Exp(-(double)offset * offset / (2 * sigma * sigma)); kernel[offset + radius] = weight; total += weight; }
            for (var index = 0; index < kernel.Length; index++) kernel[index] /= total;
            for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) {
                var value = 0.0;
                for (var offset = -radius; offset <= radius; offset++) if (x + offset >= 0 && x + offset < width) value += source[(y * width + x + offset) * 4 + 3] * kernel[offset + radius];
                horizontal[y * width + x] = value;
            }
            var pixels = new byte[width * height * 4]; var down = (int)Math.Round(scale);
            for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) {
                var value = 0.0;
                for (var offset = -radius; offset <= radius; offset++) if (y - down + offset >= 0 && y - down + offset < height) value += horizontal[(y - down + offset) * width + x] * kernel[offset + radius];
                var alpha = (byte)Math.Clamp((int)Math.Round(value * .44), 0, 255); var index = (y * width + x) * 4;
                // UpdateLayeredWindow consumes premultiplied BGRA. This is a blurred silhouette, not a painted circle.
                pixels[index] = (byte)Math.Round(90 * alpha / 255.0); pixels[index + 1] = (byte)Math.Round(84 * alpha / 255.0); pixels[index + 2] = (byte)Math.Round(81 * alpha / 255.0); pixels[index + 3] = alpha;
            }
            SetPixels(bitmap, pixels);
            using (var graphics = Graphics.FromImage(bitmap)) graphics.DrawImageUnscaled(glyph, 0, 0);
            if (!target.Contains(new Rectangle(location, bitmap.Size))) {
                pixels = Pixels(bitmap);
                for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) if (!target.Contains(x + location.X, y + location.Y)) Array.Clear(pixels, (y * width + x) * 4, 4);
                SetPixels(bitmap, pixels);
            }
            return bitmap;
        } catch { bitmap.Dispose(); throw; }
    }
    private static byte[] Pixels(Bitmap bitmap)
    {
        var data = bitmap.LockBits(new Rectangle(Point.Empty, bitmap.Size), ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
        try { var value = new byte[checked(bitmap.Width * bitmap.Height * 4)]; Marshal.Copy(data.Scan0, value, 0, value.Length); return value; }
        finally { bitmap.UnlockBits(data); }
    }
    private static void SetPixels(Bitmap bitmap, byte[] pixels)
    {
        var data = bitmap.LockBits(new Rectangle(Point.Empty, bitmap.Size), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
        try { Marshal.Copy(pixels, 0, data.Scan0, pixels.Length); }
        finally { bitmap.UnlockBits(data); }
    }
    private delegate void WinEvent(IntPtr hook, uint kind, IntPtr window, int objectId, int childId, uint thread, uint time);
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint(int x, int y) { internal int X = x, Y = y; }
    [StructLayout(LayoutKind.Sequential)] private struct NativeSize(int width, int height) { internal int Width = width, Height = height; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] private struct Blend { internal byte Operation, Flags, Alpha, Format; }
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool PostMessage(IntPtr handle, int message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowEnabled(IntPtr handle);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, WinEvent callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
    [DllImport("gdi32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DeleteObject(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UpdateLayeredWindow(IntPtr window, IntPtr destinationDc, ref NativePoint destination, ref NativeSize size, IntPtr sourceDc, ref NativePoint source, uint key, ref Blend blend, uint flags);
}
