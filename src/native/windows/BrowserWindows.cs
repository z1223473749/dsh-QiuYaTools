using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace QiuYaTools.Windows;

internal sealed class WindowManager : IDisposable
{
    internal static readonly object Deferred = new();
    // Input release has its own hard deadline. This bound only drains the
    // original WebView process groups after the native input owner is fenced.
    internal const int BrowserShutdownMilliseconds = 5_000;
    private readonly Dictionary<string, BrowserWindow> sessions = new();
    private readonly Dictionary<string, BrowserWindow> previews = new();
    private PreviewDataScope? previewData;
    private string? prepared;
    private readonly HashSet<BrowserWindow> browserLifetimes = new();
    internal async Task<object?> Session(string op, JsonElement request, object requestId)
    {
        if (op is not ("open" or "prepare" or "cancel")) throw new NativeFailure("unknown-operation", "Unknown session operation");
        var id = Program.Text(request, "sessionId", 1024);
        if (string.IsNullOrWhiteSpace(id)) throw new NativeFailure("invalid-request", "Invalid session identity");
        if (op == "cancel") {
            if (prepared == id) { prepared = null; if (sessions.TryGetValue(id, out var hidden) && hidden.Prepared) hidden.Close(); }
            return new { canceled = true };
        }
        var store = Program.Text(request, "storeIdentifier", 36);
        if (!Guid.TryParseExact(store, "D", out var uuid) || uuid == Guid.Empty) throw new NativeFailure("invalid-request", "Invalid storage identity");
        var url = ValidateUrl(Program.Text(request, "url", 32768));
        var query = url.Query.TrimStart('?').Split('&').Select(part => part.Split('=', 2)).Where(parts => Uri.UnescapeDataString(parts[0]) == "qiuya-session").ToArray();
        if (query.Length != 1 || query[0].Length != 2 || Uri.UnescapeDataString(query[0][1]) != id) throw new NativeFailure("invalid-request", "Invalid session URL identity");
        if (sessions.TryGetValue(id, out var existing)) {
            if (!existing.Failed && !existing.IsClosing) {
                if (op == "prepare") return new { prepared = true };
                if (prepared == id) prepared = null;
                existing.Reveal(request, requestId);
                return Deferred;
            }
            existing.Close();
        }
        if (op == "prepare") {
            if (prepared != null && prepared != id && sessions.TryGetValue(prepared, out var old) && old.Prepared) old.Close();
            prepared = id;
        }
        CheckRuntime();
        var title = Program.Text(request, "title", 20_000);
        var window = new BrowserWindow(id, url, title, uuid.ToString("D"), op == "prepare", preview: false);
        sessions[id] = window;
        TrackBrowserLifetime(window);
        window.FormClosed += (_, _) => { if (sessions.GetValueOrDefault(id) == window) { sessions.Remove(id); if (prepared == id) prepared = null; } };
        if (op == "open") window.AddWaiting(requestId);
        window.Position(request);
        // A preparation receipt does not wait for in-page readiness, so Escape remains cancellable.
        _ = window.Initialize();
        if (op == "open") { window.Present(true); return Deferred; }
        await Task.CompletedTask;
        return new { prepared = true };
    }
    internal async Task<object> OpenPreview(JsonElement request)
    {
        var id = Program.Text(request, "sessionId", 1024);
        var url = ValidateUrl(Program.Text(request, "url", 32768));
        var title = Program.Text(request, "title", 20_000);
        if (previews.TryGetValue(id, out var existing) && !existing.IsClosing) { existing.Present(true); return new { opened = true }; }
        CheckRuntime();
        previewData ??= new PreviewDataScope(BrowserWindow.DataRoot());
        var window = new BrowserWindow(id, url, title, previewData.Store(id), false, preview: true, previewData);
        previews[id] = window;
        TrackBrowserLifetime(window);
        window.FormClosed += (_, _) => {
            if (previews.GetValueOrDefault(id) == window) previews.Remove(id);
            if (!window.PreserveSessionOnClose) Program.Emit(new { @event = "previewClosed", sessionId = id });
        };
        await window.Initialize();
        if (window.Failed || window.IsClosing) throw new NativeFailure("preview-failed", "Preview could not load");
        window.Present(false);
        return new { opened = true };
    }
    internal async Task<object> ClosePreview(JsonElement request)
    {
        var preserve = false;
        if (request.TryGetProperty("preserveSession", out var value)) {
            if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new NativeFailure("invalid-request", "Invalid preserveSession");
            preserve = value.GetBoolean();
        }
        if (!request.TryGetProperty("sessionId", out _)) {
            foreach (var window in previews.Values.ToArray()) await window.ClosePreview(preserve);
        } else {
            var id = Program.Text(request, "sessionId", 1024);
            if (previews.TryGetValue(id, out var window)) await window.ClosePreview(preserve);
        }
        return new { closed = true, preserveSession = preserve };
    }
    internal static Uri ValidateUrl(string raw)
    {
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.Port is <= 0 or > 65535 || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0) throw new NativeFailure("invalid-url", "Only authenticated loopback pages may open");
        return uri;
    }
    private static void CheckRuntime()
    {
        try { if (string.IsNullOrWhiteSpace(CoreWebView2Environment.GetAvailableBrowserVersionString())) throw new Exception(); }
        catch { throw new NativeFailure("webview2-runtime-missing", "Install the Microsoft Edge WebView2 Runtime to open native windows"); }
    }
    private void TrackBrowserLifetime(BrowserWindow window)
    {
        browserLifetimes.Add(window);
        _ = ForgetRetiredBrowser(window);
    }
    private async Task ForgetRetiredBrowser(BrowserWindow window)
    {
        try { await window.BrowserRetired; browserLifetimes.Remove(window); }
        catch { /* Keep a failed or unknown lifetime in the shutdown barrier. */ }
    }
    internal async Task ShutdownAsync(int remainingMilliseconds)
    {
        // Snapshot also includes already closed windows whose browser group is still alive.
        // Closing the controls is part of this budget; it is not proof that their
        // browser processes have exited. Keep the STA available for exit events.
        var closeClock = Stopwatch.StartNew();
        var pending = browserLifetimes.ToArray();
        CloseWindows();
        try {
            remainingMilliseconds -= checked((int)closeClock.ElapsedMilliseconds);
            if (remainingMilliseconds < 0) throw new TimeoutException("Browser shutdown deadline");
            if (pending.Length == 0) return;
            if (remainingMilliseconds == 0) throw new TimeoutException("Browser shutdown deadline");
            await Task.WhenAll(pending.Select(window => window.BrowserRetired)).WaitAsync(TimeSpan.FromMilliseconds(remainingMilliseconds));
        } finally { previewData?.Dispose(); previewData = null; }
    }
    private void CloseWindows()
    {
        foreach (var window in sessions.Values.Concat(previews.Values).ToArray()) window.Close();
        sessions.Clear(); previews.Clear();
    }
    public void Dispose()
    {
        CloseWindows(); previewData?.Dispose(); previewData = null;
    }
}

internal sealed class BrowserWindow : Form
{
    private readonly string sessionId;
    private readonly Uri origin;
    private readonly string store;
    private readonly bool preview;
    private readonly PreviewDataScope? previewData;
    private readonly WebView2 web = new() { Dock = DockStyle.Fill, AllowExternalDrop = true };
    private readonly Label failure = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Visible = false };
    private readonly System.Windows.Forms.Timer deadline = new() { Interval = 30_000 };
    private readonly List<object> waiting = new();
    internal bool IsPreview => preview;
    internal bool IsClosing => closeRequested || IsDisposed;
    internal bool PreserveSessionOnClose { get; private set; }
    private Task? preserveClose;
    private bool closeRequested;
    private readonly BrowserExitState browserLifetime = new();
    private CoreWebView2Environment? browserEnvironment;
    internal Task BrowserRetired => browserLifetime.Completion;
    private void BrowserProcessExited(object? sender, CoreWebView2BrowserProcessExitedEventArgs args) => browserLifetime.BrowserExited(args.BrowserProcessId);
    private async Task ReleaseRetiredEnvironment()
    {
        try { await BrowserRetired; }
        catch { return; }
        if (browserEnvironment != null) browserEnvironment.BrowserProcessExited -= BrowserProcessExited;
        browserEnvironment = null;
    }
    protected override bool ShowWithoutActivation => preview;
    protected override CreateParams CreateParams
    {
        get {
            var parameters = base.CreateParams;
            // Declare the native style when the handle is created. A successful
            // later SetWindowPos did not apply TOPMOST in the hidden-startup Host regression.
            if (preview) parameters.ExStyle |= 0x00000008; // WS_EX_TOPMOST
            return parameters;
        }
    }
    internal bool Prepared { get; private set; }
    internal static void UncoverPointer(IReadOnlyList<Point> trajectory)
    {
        if (trajectory.Count == 0) return;
        var placements = new List<(BrowserWindow Window, Point Location)>();
        foreach (var window in Application.OpenForms.OfType<BrowserWindow>().Where(window => window.preview && window.Visible).ToArray()) {
            if (!IntersectsTrajectory(window.Bounds, trajectory)) continue;
            Rectangle? placement = null;
            foreach (var screen in Screen.AllScreens) {
                var area = screen.WorkingArea;
                foreach (var point in new[] { new Point(area.Left + 8, area.Top + 8), new Point(area.Right - window.Width - 8, area.Top + 8), new Point(area.Left + 8, area.Bottom - window.Height - 8), new Point(area.Right - window.Width - 8, area.Bottom - window.Height - 8) }) {
                    var candidate = new Rectangle(point, window.Size);
                    if (area.Contains(candidate) && !IntersectsTrajectory(candidate, trajectory)) { placement = candidate; break; }
                }
                if (placement != null) break;
            }
            if (placement is not Rectangle safe) throw new NativeFailure("preview-overlap", "Move or resize the visible preview away from the pointer path before input");
            placements.Add((window, safe.Location));
        }
        // Plan all placements before moving any window; a rejected action has not pressed a button.
        foreach (var (window, location) in placements) { window.StartPosition = FormStartPosition.Manual; window.Location = location; window.Present(false); }
    }
    internal static bool IntersectsTrajectory(Rectangle bounds, IReadOnlyList<Point> trajectory)
    {
        // Keep the actual piecewise pointer path clear, rather than rejecting its much larger bounding box.
        bounds.Inflate(4, 4);
        for (var index = 0; index < trajectory.Count; index++) {
            var from = trajectory[index];
            if (bounds.Contains(from)) return true;
            if (index == 0) continue;
            var to = trajectory[index - 1];
            var low = 0.0; var high = 1.0;
            var dx = (double)to.X - from.X; var dy = (double)to.Y - from.Y;
            bool Clip(double direction, double distance)
            {
                if (direction == 0) return distance >= 0;
                var ratio = distance / direction;
                if (direction < 0) { if (ratio > high) return false; low = Math.Max(low, ratio); }
                else { if (ratio < low) return false; high = Math.Min(high, ratio); }
                return true;
            }
            if (Clip(-dx, from.X - bounds.Left) && Clip(dx, bounds.Right - from.X) && Clip(-dy, from.Y - bounds.Top) && Clip(dy, bounds.Bottom - from.Y) && low <= high) return true;
        }
        return false;
    }
    internal bool Failed { get; private set; }
    private bool ready;
    internal BrowserWindow(string sessionId, Uri origin, string title, string store, bool prepared, bool preview, PreviewDataScope? previewData = null)
    {
        this.sessionId = sessionId; this.origin = origin; this.store = store; this.preview = preview; this.previewData = previewData; Prepared = prepared;
        Text = title[..Math.Min(title.Length, 200)] + " — QiuYaTools";
        StartPosition = FormStartPosition.CenterScreen;
        Size = preview ? new Size(600, 420) : new Size(1000, 800);
        MinimumSize = preview ? new Size(320, 220) : new Size(600, 480);
        TopMost = preview;
        ShowInTaskbar = !preview;
        Controls.Add(web); Controls.Add(failure);
        deadline.Tick += (_, _) => Fail("会话加载超时，请关闭窗口后重试。");
        FormClosing += (_, args) => {
            if (browserLifetime.CanDisposeView) return;
            // Canceling a hidden preparation must not dispose WebView while its
            // asynchronous controller creation can still create a browser later.
            closeRequested = true; args.Cancel = true; deadline.Stop(); Hide();
        };
        FormClosed += (_, _) => { deadline.Stop(); Complete(false); web.Dispose(); deadline.Dispose(); };
        // Construct a native handle without showing hidden drag preparations.
        _ = Handle; _ = web.Handle;
    }
    internal void Position(JsonElement request)
    {
        if (request.TryGetProperty("source", out var source) && source.GetString() == "drag") {
            var cursor = Cursor.Position;
            var area = Screen.FromPoint(cursor).WorkingArea;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(Math.Clamp(cursor.X - 80, area.Left, Math.Max(area.Left, area.Right - Width)), Math.Clamp(cursor.Y - 30, area.Top, Math.Max(area.Top, area.Bottom - Height)));
        }
    }
    internal void AddWaiting(object requestId) { if (ready) Reply(requestId, true); else waiting.Add(requestId); }
    internal void Reveal(JsonElement request, object requestId)
    {
        Prepared = false; Position(request); AddWaiting(requestId);
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Present(true); if (!ready) { deadline.Stop(); deadline.Start(); }
    }
    internal void Present(bool activate)
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        // Node windowsHide supplies STARTUPINFO/SW_HIDE. Force only this explicitly requested
        // GUI window visible while keeping the companion's console hidden.
        if (!Native.SetWindowPos(Handle, preview ? new IntPtr(-1) : IntPtr.Zero, 0, 0, 0, 0, 0x0040 | 0x0001 | 0x0002 | 0x0010))
            throw new NativeFailure("window-presentation-failed", "Windows could not display the requested window");
        if (activate) Activate();
    }
    internal Task ClosePreview(bool preserve)
    {
        if (!preview) throw new NativeFailure("invalid-request", "Only a preview can preserve its control session");
        if (IsDisposed) return Task.CompletedTask;
        if (!preserve) { Close(); return Task.CompletedTask; }
        if (preserveClose is { IsFaulted: false, IsCanceled: false }) return preserveClose;
        return preserveClose = CloseAndPreserve();
    }
    private async Task CloseAndPreserve()
    {
        try {
            var core = web.CoreWebView2;
            bool OwnedDocument() => core != null && web.CoreWebView2 == core && !IsDisposed && Uri.TryCreate(core.Source, UriKind.Absolute, out var current) && SameOrigin(current) && current.AbsolutePath == origin.AbsolutePath &&
                !current.Query.TrimStart('?').Split('&').Any(part => Uri.UnescapeDataString(part.Split('=', 2)[0]) == "token");
            if (Failed || core == null || !OwnedDocument())
                throw new NativeFailure("preview-not-ready", "Wait for the owned preview before returning it to the chat");
            // This fixed script runs only in this helper's validated preview.
            // Wait for it before closing: pagehide otherwise pauses the task.
            var result = await core.ExecuteScriptAsync("window.__qytPreserveSessionOnClose=true;window.__qytPreserveSessionOnClose===true");
            if (result != "true" || !OwnedDocument()) throw new NativeFailure("preview-close-failed", "The preview did not confirm session preservation");
            PreserveSessionOnClose = true;
            Close();
        } catch { preserveClose = null; throw; }
    }
    internal async Task Initialize()
    {
        try {
            if (IsDisposed || closeRequested) { browserLifetime.NoBrowserCreated(); return; }
            var directory = Path.Combine(DataRoot(), store);
            if (preview) PreviewDataScope.ValidateUdfPath(directory);
            Directory.CreateDirectory(directory);
            if (preview) PreviewDataScope.RequirePlainAncestors(directory);
            // A crash during initialization leaves this scope deliberately uncollectable:
            // no later helper may assume an unrecorded browser process has exited.
            previewData?.BeginningBrowser();
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: directory);
            browserEnvironment = environment;
            environment.BrowserProcessExited += BrowserProcessExited;
            _ = ReleaseRetiredEnvironment();
            if (preview) {
                var options = environment.CreateCoreWebView2ControllerOptions();
                options.IsInPrivateModeEnabled = true;
                options.ProfileName = "Preview" + Guid.NewGuid().ToString("N");
                await web.EnsureCoreWebView2Async(environment, options);
            } else await web.EnsureCoreWebView2Async(environment);
            browserLifetime.BrowserCreated(web.CoreWebView2.BrowserProcessId);
            if (previewData != null) previewData.BrowserCreated(checked((int)web.CoreWebView2.BrowserProcessId));
            if (IsDisposed || closeRequested) return;
            web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            web.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            web.CoreWebView2.NavigationStarting += (_, args) => {
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) || !SameOrigin(uri)) { args.Cancel = true; OpenExternal(args.Uri); }
            };
            web.CoreWebView2.NewWindowRequested += (_, args) => { args.Handled = true; OpenExternal(args.Uri); };
            web.CoreWebView2.PermissionRequested += (_, args) => { args.State = CoreWebView2PermissionState.Deny; args.Handled = true; };
            web.CoreWebView2.ProcessFailed += (_, _) => Fail("窗口页面已退出，请关闭后重试。");
            var queryParts = origin.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries);
            var tokenParts = queryParts.Where(part => Uri.UnescapeDataString(part.Split('=', 2)[0]) == "token").ToArray();
            var cleanPreview = new UriBuilder(origin) { Query = string.Join("&", queryParts.Where(part => Uri.UnescapeDataString(part.Split('=', 2)[0]) != "token")) }.Uri;
            var exchange = preview && tokenParts.Length > 0;
            var waitingForPreview = exchange;
            if (exchange) { web.Visible = false; failure.Text = "正在连接预览…"; failure.Visible = true; failure.BringToFront(); }
            async Task ContinueFromAuthenticatedRoot()
            {
                if (!exchange || !Uri.TryCreate(web.CoreWebView2.Source, UriKind.Absolute, out var current) || !SameOrigin(current) || current.AbsolutePath != "/" || current.Query.TrimStart('?').Split('&').Any(part => Uri.UnescapeDataString(part.Split('=', 2)[0]) == "token")) return;
                exchange = false;
                // The Harness root may keep loading its SPA indefinitely. Continue when the authenticated document commits.
                await web.CoreWebView2.ExecuteScriptAsync("location.replace(" + JsonSerializer.Serialize(cleanPreview.AbsoluteUri) + ")");
            }
            web.CoreWebView2.ContentLoading += async (_, args) => {
                if (!args.IsErrorPage) { try { await ContinueFromAuthenticatedRoot(); } catch { Fail("预览连接失败，请关闭后重试。"); } }
            };
            web.CoreWebView2.NavigationCompleted += async (_, args) => {
                if ((!args.IsSuccess && args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled) || args.HttpStatusCode >= 400) { Fail("页面加载失败，请关闭窗口后重试。"); return; }
                if (!Uri.TryCreate(web.CoreWebView2.Source, UriKind.Absolute, out var current) || !SameOrigin(current)) return;
                if (exchange && current.AbsolutePath == "/" && !current.Query.TrimStart('?').Split('&').Any(part => Uri.UnescapeDataString(part.Split('=', 2)[0]) == "token")) {
                    await ContinueFromAuthenticatedRoot();
                } else if (waitingForPreview && !exchange && current.AbsoluteUri == cleanPreview.AbsoluteUri) {
                    waitingForPreview = false; web.Visible = true; failure.Visible = false;
                }
            };
            if (!preview) {
                web.CoreWebView2.WebMessageReceived += Message;
                var id = JsonSerializer.Serialize(sessionId);
                var boot = $$"""
                if (window.top === window) {
                  window.__QIUYA_SESSION_WINDOW__ = {{id}};
                  window.webkit = window.webkit || {};
                  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
                  window.webkit.messageHandlers.qiuyaSession = { postMessage: value => window.chrome.webview.postMessage(value) };
                  (() => { const guard = document.createElement('style'); guard.dataset.qytSessionWindowBoot = 'true'; guard.textContent = 'body:not([data-qyt-session-window-state="ready"]) :is(main,[class*="_centerCol"],[data-conversation-session]){visibility:hidden!important;pointer-events:none!important}'; const install = () => { if (!document.documentElement) return false; document.documentElement.append(guard); return true; }; if (!install()) { const observer = new MutationObserver(() => { if (install()) observer.disconnect(); }); observer.observe(document,{childList:true}); } })();
                }
                """;
                await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(boot);
                deadline.Start();
            }
            web.CoreWebView2.Navigate(exchange ? new UriBuilder(origin) { Path = "/", Query = string.Join("&", tokenParts), Fragment = "" }.Uri.AbsoluteUri : origin.AbsoluteUri);
        } catch { browserLifetime.InitializationFailed(); Fail("窗口组件初始化失败，请检查 WebView2 Runtime。"); }
        finally { browserLifetime.InitializationFinished(); if (closeRequested && !IsDisposed) Close(); }
    }
    internal static string DataRoot()
    {
        var configured = Environment.GetEnvironmentVariable("QIUYA_TOOLS_NATIVE_DATA_DIR");
        return Path.GetFullPath(string.IsNullOrWhiteSpace(configured) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QiuYaTools", "WebView2") : configured);
    }
    private bool SameOrigin(Uri uri) => uri.Scheme == origin.Scheme && uri.Host == origin.Host && uri.Port == origin.Port;
    private void Message(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (Failed || !Uri.TryCreate(args.Source, UriKind.Absolute, out var source) || !SameOrigin(source)) return;
        try {
            using var doc = JsonDocument.Parse(args.WebMessageAsJson);
            var body = doc.RootElement;
            if (Program.Text(body, "sessionId", 1024) != sessionId) return;
            var kind = Program.Text(body, "type", 32);
            if (kind == "ready") {
                if (body.TryGetProperty("title", out var title) && title.ValueKind == JsonValueKind.String) Text = (title.GetString() ?? "")[..Math.Min((title.GetString() ?? "").Length, 200)] + " — QiuYaTools";
                ready = true; deadline.Stop(); failure.Visible = false; Complete(true);
            } else if (kind == "unavailable" && !ready) Fail("会话暂时不可用，请关闭窗口后在主窗口中查看。");
        } catch (Exception error) when (error is JsonException or NativeFailure) { }
    }
    private static void OpenExternal(string raw)
    {
        if (Uri.TryCreate(raw, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" or "mailto") {
            try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); } catch { }
        }
    }
    private static void Reply(object id, bool ok) => Program.Emit(ok ? (object)new { requestId = id, ok = true } : new { requestId = id, ok = false, error = new { code = "session-window-failed", message = "会话窗口加载失败，请重试。" } });
    private void Complete(bool ok) { foreach (var id in waiting) Reply(id, ok); waiting.Clear(); }
    private void Fail(string message)
    {
        if (Failed || IsDisposed) return;
        Failed = true; deadline.Stop(); Complete(false);
        failure.Text = message; failure.Visible = true; failure.BringToFront();
        if (Prepared) Close();
    }
    protected override bool ProcessCmdKey(ref Message message, Keys keyData)
    {
        if (keyData == (Keys.Control | Keys.W)) { Close(); return true; }
        return base.ProcessCmdKey(ref message, keyData);
    }
}

/** Preview-only disposable cache. Session UUID storage is intentionally outside this namespace. */
internal sealed class PreviewDataScope : IDisposable
{
    internal const int ScopeLimit = 64, SessionLimit = 32;
    // The observed initial private-profile/cache suffix was 91 characters.
    // Reserve 94, including margin, below the 259 usable characters of a
    // conventional MAX_PATH path; future cache paths may differ.
    internal const int MaximumUdfLength = 165;
    internal const string Prefix = "qyt-preview-v2-";
    internal sealed record Identity(int Pid, long Born, string Executable)
    {
        internal static Identity Current(int pid)
        {
            using var process = Process.GetProcessById(pid);
            _ = process.SafeHandle;
            return new(pid, process.StartTime.ToUniversalTime().Ticks, ImagePath(process));
        }
        internal bool Valid => Pid > 0 && Born > 0 && Path.IsPathFullyQualified(Executable);
        internal bool Gone()
        {
            if (!Valid) return false;
            try {
                using var process = Process.GetProcessById(Pid);
                _ = process.SafeHandle; // Keep this process incarnation pinned while checking birth and image.
                if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != Born) return true;
                if (!string.Equals(ImagePath(process), Executable, StringComparison.OrdinalIgnoreCase)) return false;
                return process.HasExited;
            } catch (ArgumentException) { return true; }
            catch { return false; } // Access failure or incomplete identity never means retired.
        }
    }
    internal sealed record Manifest(int Version, string Scope, Identity Owner, int Pending, Identity[] Browsers);
    private readonly string root, scope, directory;
    private readonly FileStream lease;
    private readonly Dictionary<string, string> stores = new(StringComparer.Ordinal);
    private Manifest manifest;
    private bool disposed;
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);
    private static string ImagePath(Process process)
    {
        var path = new StringBuilder(32768); var size = path.Capacity;
        if (!QueryFullProcessImageName(process.Handle, 0, path, ref size)) throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
        return path.ToString();
    }
    internal string DirectoryPath => directory;
    internal PreviewDataScope(string dataRoot)
    {
        root = Path.GetFullPath(dataRoot); RequirePlainAncestors(root, allowMissing: true);
        // Reject before creating any scope or starting a browser. Do not move
        // configured data to another location or change system path policy.
        ValidateUdfPath(Path.Combine(root, Prefix + Guid.Empty.ToString("N"), "s00"));
        Directory.CreateDirectory(root); RequirePlainAncestors(root);
        using var index = Index(root);
        PruneLocked(root);
        if (OwnedDirectories(root).Count >= ScopeLimit) throw new NativeFailure("preview-cache-full", "Preview cache limit reached; close previews and retire inactive preview data before retrying");
        scope = Guid.NewGuid().ToString("N"); directory = Path.Combine(root, Prefix + scope);
        Directory.CreateDirectory(directory); RequirePlainAncestors(directory);
        lease = new FileStream(Path.Combine(directory, ".lease"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        manifest = new(1, scope, Identity.Current(Environment.ProcessId), 0, []);
        try { Save(); } catch { lease.Dispose(); throw; }
    }
    internal string Store(string sessionId)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sessionId))).ToLowerInvariant();
        if (!stores.TryGetValue(key, out var slot)) {
            if (stores.Count >= SessionLimit) throw new NativeFailure("preview-cache-full", "This helper has reached its preview session limit");
            slot = "s" + stores.Count.ToString("x2", System.Globalization.CultureInfo.InvariantCulture);
            stores.Add(key, slot); // Full SHA-256 keys stay in memory; raw identities never become paths.
        }
        var store = Path.Combine(Prefix + scope, slot);
        ValidateUdfPath(Path.Combine(root, store));
        return store;
    }
    internal static void ValidateUdfPath(string path)
    {
        if (Path.GetFullPath(path).Length > MaximumUdfLength)
            throw new NativeFailure("preview-data-path-too-long", "The preview cache path is too long; configure a shorter native data directory");
    }
    internal void BeginningBrowser()
    {
        ObjectDisposedException.ThrowIf(disposed, this); RequirePlainAncestors(directory);
        var live = manifest.Browsers.Where(identity => !identity.Gone()).ToArray();
        if (live.Length >= 128 || manifest.Pending >= SessionLimit) throw new NativeFailure("preview-cache-full", "Preview browser tracking limit reached");
        manifest = manifest with { Pending = manifest.Pending + 1, Browsers = live }; Save();
    }
    internal void BrowserCreated(int pid)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var identity = Identity.Current(pid);
        if (manifest.Pending <= 0) throw new IOException("Preview initialization identity unavailable");
        manifest = manifest with { Pending = manifest.Pending - 1, Browsers = manifest.Browsers.Append(identity).Distinct().ToArray() }; Save();
    }
    private void Save()
    {
        RequirePlainAncestors(directory);
        var path = Path.Combine(directory, ".owner.json"); var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        RequirePlainFile(path);
        try {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                JsonSerializer.Serialize(file, manifest); file.Flush(true);
            }
            File.Move(temporary, path, true);
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private static FileStream Index(string root)
    {
        var path = Path.Combine(root, ".qyt-preview-index.lock");
        RequirePlainFile(path);
        var clock = Stopwatch.StartNew();
        while (true) {
            try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (clock.ElapsedMilliseconds < 1000) { Thread.Sleep(20); }
        }
    }
    private static List<string> OwnedDirectories(string root) => Directory.EnumerateDirectories(root, Prefix + "*")
        .Where(path => Guid.TryParseExact(Path.GetFileName(path)[Prefix.Length..], "N", out _)).ToList();
    private static void RequirePlainFile(string path)
    {
        try { if ((File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) throw new IOException("Preview metadata path is not a plain file"); }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException) { }
    }
    internal static void Prune(string root)
    {
        RequirePlainAncestors(root); using var index = Index(root); PruneLocked(root);
    }
    private static void PruneLocked(string root)
    {
        foreach (var path in OwnedDirectories(root)) {
            try {
                RequirePlainTree(path);
                var recordPath = Path.Combine(path, ".owner.json");
                if (!File.Exists(recordPath) || new FileInfo(recordPath).Length > 65536) continue;
                var record = JsonSerializer.Deserialize<Manifest>(File.ReadAllText(recordPath));
                if (record is not { Version: 1, Pending: 0 } || record.Scope != Path.GetFileName(path)[Prefix.Length..] || record.Owner == null || !record.Owner.Valid ||
                    record.Browsers == null || record.Browsers.Length > 128 || record.Browsers.Any(identity => identity == null || !identity.Valid)) continue;
                // A free helper-owned lock is insufficient: its browser may outlive it.
                using (var ownLock = new FileStream(Path.Combine(path, ".lease"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
                    if (!record.Owner.Gone() || record.Browsers.Any(identity => !identity.Gone())) continue;
                    RequirePlainTree(path);
                }
                // GUID scopes are never reused. Only this index owner can retire them.
                Directory.Delete(path, true);
            } catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException) { /* Unknown or active: preserve, count toward the fixed bound. */ }
        }
    }
    internal static void RequirePlainAncestors(string path, bool allowMissing = false)
    {
        for (string? current = Path.GetFullPath(path); !string.IsNullOrEmpty(current); current = Path.GetDirectoryName(current)) {
            try { if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("Preview cache ancestor is a reparse point"); }
            catch (Exception error) when (allowMissing && error is FileNotFoundException or DirectoryNotFoundException) { }
        }
    }
    private static void RequirePlainTree(string path)
    {
        RequirePlainAncestors(path); var pending = new Stack<string>(); pending.Push(path); var entries = 0;
        while (pending.Count > 0) foreach (var child in Directory.EnumerateFileSystemEntries(pending.Pop())) {
            var attributes = File.GetAttributes(child);
            if ((attributes & FileAttributes.ReparsePoint) != 0 || ++entries > 100_000) throw new IOException("Preview cache tree is not safely enumerable");
            if ((attributes & FileAttributes.Directory) != 0) pending.Push(child);
        }
    }
    public void Dispose() { if (disposed) return; disposed = true; lease.Dispose(); }
}
