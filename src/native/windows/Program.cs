using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace QiuYaTools.Windows;

internal static class Program
{
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly object OutputLock = new();
    [STAThread]
    private static void Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using var context = new NativeContext();
        Application.Run(context);
    }
    internal static void Emit(object value)
    {
        lock (OutputLock) { Console.WriteLine(JsonSerializer.Serialize(value, Json)); Console.Out.Flush(); }
    }
    internal static string Text(JsonElement request, string name, int limit = 65536)
    {
        if (!request.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String || value.GetString() is not string text || text.Length > limit) throw new NativeFailure("invalid-request", $"Invalid {name}");
        return text;
    }
    internal static double Number(JsonElement request, string name, double fallback = 0)
    {
        if (!request.TryGetProperty(name, out var value)) return fallback;
        if (!value.TryGetDouble(out var number) || !double.IsFinite(number)) throw new NativeFailure("invalid-request", $"Invalid {name}");
        return number;
    }
}

internal sealed class NativeFailure(string code, string message) : Exception(message) { internal string Code { get; } = code; }

internal sealed class NativeContext : ApplicationContext
{
    private readonly Control dispatcher = new();
    private readonly WindowManager windows = new();
    private readonly System.Windows.Forms.Timer parentWatch = new() { Interval = 1500 };
    private readonly int parentPid;
    private bool exiting;
    internal NativeContext()
    {
        dispatcher.CreateControl();
        int.TryParse(Environment.GetEnvironmentVariable("QIUYA_TOOLS_PARENT_PID"), out parentPid);
        parentWatch.Tick += (_, _) => {
            if (parentPid <= 0) return;
            try { using var parent = Process.GetProcessById(parentPid); if (parent.HasExited) Shutdown(); }
            catch (ArgumentException) { Shutdown(); }
        };
        parentWatch.Start();
        _ = Task.Run(ReadLoop);
    }
    private void ReadLoop()
    {
        try {
            string? line;
            while ((line = Console.ReadLine()) != null) {
                if (line.Length > 2 * 1024 * 1024) continue;
                try {
                    using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 32 });
                    var request = document.RootElement.Clone();
                    dispatcher.BeginInvoke((Action)(() => _ = Dispatch(request)));
                } catch (JsonException) { /* malformed, uncorrelated transport data */ }
            }
        } finally { try { dispatcher.BeginInvoke((Action)Shutdown); } catch (InvalidOperationException) { } }
    }
    private async Task Dispatch(JsonElement request)
    {
        if (exiting) return;
        if (!request.TryGetProperty("requestId", out var id)) return;
        object requestId;
        if (id.ValueKind == JsonValueKind.Number && id.TryGetInt64(out var numeric) && numeric >= 0) requestId = numeric;
        else if (id.ValueKind == JsonValueKind.String && id.GetString() is string token && token.Length is > 0 and <= 256 && !token.Any(char.IsControl)) requestId = token;
        else return;
        try {
            var op = Program.Text(request, "op", 64);
            var result = await windows.Session(op, request, requestId);
            // Session open waits for the verified in-page handshake and emits its own reply.
            if (!ReferenceEquals(result, WindowManager.Deferred)) Program.Emit(new { requestId, ok = true, result });
        } catch (Exception error) {
            var code = error is NativeFailure failure ? failure.Code : "native-failed";
            // Never expose arbitrary exception text, authenticated URLs or filesystem paths.
            Program.Emit(new { requestId, ok = false, error = new { code, message = error is NativeFailure ? error.Message : "Native operation failed" } });
        }
    }
    private async void Shutdown()
    {
        if (exiting) return;
        exiting = true; parentWatch.Stop();
        try {
            var browserReleased = false;
            try {
                await windows.ShutdownAsync(WindowManager.BrowserShutdownMilliseconds);
                browserReleased = true;
            } catch (Exception) { Environment.ExitCode = 1; }
            try { Program.Emit(new { @event = "browserShutdown", passed = browserReleased }); }
            catch (Exception) { Environment.ExitCode = 1; }
        } finally { ExitThread(); }
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { Shutdown(); parentWatch.Dispose(); dispatcher.Dispose(); }
        base.Dispose(disposing);
    }
}
