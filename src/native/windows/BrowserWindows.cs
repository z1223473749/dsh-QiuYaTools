using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace QiuYaTools.Windows;

internal sealed class WindowManager : IDisposable
{
    internal static readonly object Deferred = new();
    private readonly Dictionary<string, BrowserWindow> sessions = new();
    private readonly Dictionary<string, BrowserWindow> previews = new();
    private string? prepared;
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
            if (!existing.Failed) {
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
        window.FormClosed += (_, _) => { if (sessions.GetValueOrDefault(id) == window) sessions.Remove(id); if (prepared == id) prepared = null; };
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
        if (previews.TryGetValue(id, out var existing)) { existing.Present(true); return new { opened = true }; }
        CheckRuntime();
        var window = new BrowserWindow(id, url, title, "preview-runtime", false, preview: true);
        previews[id] = window;
        window.FormClosed += (_, _) => {
            if (previews.GetValueOrDefault(id) == window) previews.Remove(id);
            Program.Emit(new { @event = "previewClosed", sessionId = id });
        };
        await window.Initialize();
        if (window.Failed) throw new NativeFailure("preview-failed", "Preview could not load");
        window.Present(false);
        return new { opened = true };
    }
    internal object ClosePreview(JsonElement request)
    {
        if (!request.TryGetProperty("sessionId", out _)) {
            foreach (var window in previews.Values.ToArray()) window.Close();
        } else {
            var id = Program.Text(request, "sessionId", 1024);
            if (previews.TryGetValue(id, out var window)) window.Close();
        }
        return new { closed = true };
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
    public void Dispose()
    {
        foreach (var window in sessions.Values.Concat(previews.Values).ToArray()) window.Close();
        sessions.Clear(); previews.Clear();
    }
}

internal sealed class BrowserWindow : Form
{
    private readonly string sessionId;
    private readonly Uri origin;
    private readonly string store;
    private readonly bool preview;
    private readonly WebView2 web = new() { Dock = DockStyle.Fill, AllowExternalDrop = true };
    private readonly Label failure = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Visible = false };
    private readonly System.Windows.Forms.Timer deadline = new() { Interval = 30_000 };
    private readonly List<object> waiting = new();
    internal bool IsPreview => preview;
    protected override bool ShowWithoutActivation => preview;
    internal bool Prepared { get; private set; }
    internal static IDisposable UncoverTarget(Rectangle target)
    {
        var hidden = new List<BrowserWindow>();
        foreach (var window in Application.OpenForms.OfType<BrowserWindow>().Where(window => window.preview && window.Visible).ToArray()) {
            if (!window.Bounds.IntersectsWith(target)) continue;
            Rectangle? placement = null;
            foreach (var screen in Screen.AllScreens) {
                var area = screen.WorkingArea;
                foreach (var point in new[] { new Point(area.Left + 8, area.Top + 8), new Point(area.Right - window.Width - 8, area.Top + 8), new Point(area.Left + 8, area.Bottom - window.Height - 8), new Point(area.Right - window.Width - 8, area.Bottom - window.Height - 8) }) {
                    var candidate = new Rectangle(point, window.Size);
                    if (area.Contains(candidate) && !candidate.IntersectsWith(target)) { placement = candidate; break; }
                }
                if (placement != null) break;
            }
            if (placement is Rectangle safe) { window.StartPosition = FormStartPosition.Manual; window.Location = safe.Location; }
            else { window.Hide(); hidden.Add(window); }
        }
        return new RestorePreviews(hidden);
    }
    private sealed class RestorePreviews(List<BrowserWindow> windows) : IDisposable
    {
        public void Dispose() { foreach (var window in windows) if (!window.IsDisposed && !window.Failed) window.Present(false); }
    }
    internal bool Failed { get; private set; }
    private bool ready;
    internal BrowserWindow(string sessionId, Uri origin, string title, string store, bool prepared, bool preview)
    {
        this.sessionId = sessionId; this.origin = origin; this.store = store; this.preview = preview; Prepared = prepared;
        Text = title[..Math.Min(title.Length, 200)] + " — QiuYaTools";
        StartPosition = FormStartPosition.CenterScreen;
        Size = preview ? new Size(600, 420) : new Size(1000, 800);
        MinimumSize = preview ? new Size(320, 220) : new Size(600, 480);
        TopMost = preview;
        ShowInTaskbar = !preview;
        Controls.Add(web); Controls.Add(failure);
        deadline.Tick += (_, _) => Fail("会话加载超时，请关闭窗口后重试。");
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
    internal async Task Initialize()
    {
        try {
            var dataRoot = Environment.GetEnvironmentVariable("QIUYA_TOOLS_NATIVE_DATA_DIR");
            var directory = Path.Combine(string.IsNullOrWhiteSpace(dataRoot) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QiuYaTools", "WebView2") : Path.GetFullPath(dataRoot), store);
            Directory.CreateDirectory(directory);
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: directory);
            if (preview) {
                var options = environment.CreateCoreWebView2ControllerOptions();
                options.IsInPrivateModeEnabled = true;
                options.ProfileName = "Preview" + Guid.NewGuid().ToString("N");
                await web.EnsureCoreWebView2Async(environment, options);
            } else await web.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;
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
        } catch { Fail("窗口组件初始化失败，请检查 WebView2 Runtime。"); }
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
