using System.Diagnostics;
using System.Text.Json;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace QiuYaTools.Windows;

internal sealed class WindowManager : IDisposable
{
    internal static readonly object Deferred = new();
    // Session windows drain their original WebView process groups before exit.
    internal const int BrowserShutdownMilliseconds = 5_000;
    private readonly Dictionary<string, BrowserWindow> sessions = new();
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
        var window = new BrowserWindow(id, url, title, uuid.ToString("D"), op == "prepare");
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
        remainingMilliseconds -= checked((int)closeClock.ElapsedMilliseconds);
        if (remainingMilliseconds < 0) throw new TimeoutException("Browser shutdown deadline");
        if (pending.Length == 0) return;
        if (remainingMilliseconds == 0) throw new TimeoutException("Browser shutdown deadline");
        await Task.WhenAll(pending.Select(window => window.BrowserRetired)).WaitAsync(TimeSpan.FromMilliseconds(remainingMilliseconds));
    }
    private void CloseWindows()
    {
        foreach (var window in sessions.Values.ToArray()) window.Close();
        sessions.Clear();
    }
    public void Dispose()
    {
        CloseWindows();
    }
}

internal sealed class BrowserWindow : Form
{
    private readonly string sessionId;
    private readonly Uri origin;
    private readonly string store;
    private readonly WebView2 web = new() { Dock = DockStyle.Fill, AllowExternalDrop = true };
    private readonly Label failure = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Visible = false };
    private readonly System.Windows.Forms.Timer deadline = new() { Interval = 30_000 };
    private readonly List<object> waiting = new();
    internal bool IsClosing => closeRequested || IsDisposed;
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
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    internal bool Prepared { get; private set; }
    internal bool Failed { get; private set; }
    private bool ready;
    internal BrowserWindow(string sessionId, Uri origin, string title, string store, bool prepared)
    {
        this.sessionId = sessionId; this.origin = origin; this.store = store; Prepared = prepared;
        Text = title[..Math.Min(title.Length, 200)] + " — QiuYaTools";
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1000, 800);
        MinimumSize = new Size(600, 480);
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
        if (!SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x0040 | 0x0001 | 0x0002 | 0x0010))
            throw new NativeFailure("window-presentation-failed", "Windows could not display the requested window");
        if (activate) Activate();
    }
    internal async Task Initialize()
    {
        try {
            if (IsDisposed || closeRequested) { browserLifetime.NoBrowserCreated(); return; }
            var directory = Path.Combine(DataRoot(), store);
            Directory.CreateDirectory(directory);
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: directory);
            browserEnvironment = environment;
            environment.BrowserProcessExited += BrowserProcessExited;
            _ = ReleaseRetiredEnvironment();
            await web.EnsureCoreWebView2Async(environment);
            browserLifetime.BrowserCreated(web.CoreWebView2.BrowserProcessId);
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
            web.CoreWebView2.NavigationCompleted += (_, args) => {
                if ((!args.IsSuccess && args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled) || args.HttpStatusCode >= 400) Fail("页面加载失败，请关闭窗口后重试。");
            };
            web.CoreWebView2.Navigate(origin.AbsoluteUri);
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
