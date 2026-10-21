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
        if (args.Contains("--self-test-ai-cursor")) { Emit(AiCursorSelfTest.Run()); return; }
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.Contains("--capture-worker-test")) { CaptureSelfTest.Worker(args); return; }
        if (args.Contains("--capture-parent-test")) { CaptureSelfTest.Parent(); return; }
        if (args.Contains("--capture-worker")) { CaptureBroker.RunWorker(); return; }
        if (args.Contains("--self-test-capture")) { Program.Emit(CaptureSelfTest.Run()); return; }
        if (args.Contains("--self-test-preview")) { Program.Emit(PreviewSelfTest.Run()); return; }
        if (args.Contains("--input-guardian")) { DesktopLeaseGuard.RunGuardian(); return; }
        if (args.Contains("--self-test-input")) { Program.Emit(ComputerDriver.TestReleaseFailures()); return; }
        if (args.Contains("--release-input")) { EmergencyRelease.Run(); return; }
        if (args.Contains("--fixture")) { Application.Run(new FixtureForm(args)); return; }
        using var context = new NativeContext(args.Contains("--computer"));
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
    private readonly ComputerDriver? computer;
    private readonly System.Windows.Forms.Timer parentWatch = new() { Interval = 1500 };
    private readonly int parentPid;
    private bool exiting;
    internal NativeContext(bool computerMode)
    {
        dispatcher.CreateControl();
        if (computerMode) computer = new ComputerDriver();
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
                    if (InputTrace.Enabled && request.TryGetProperty("op", out var tracedOp) && tracedOp.ValueKind == JsonValueKind.String && tracedOp.GetString() == "release") InputTrace.Mark("stdin-release-read", request.TryGetProperty("epoch", out var tracedEpoch) && tracedEpoch.ValueKind == JsonValueKind.Number && tracedEpoch.TryGetInt64(out var value) ? value : 0);
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
            if (op == "release") InputTrace.Mark("dispatch-release", request.TryGetProperty("epoch", out var tracedEpoch) && tracedEpoch.ValueKind == JsonValueKind.Number && tracedEpoch.TryGetInt64(out var value) ? value : 0);
            object? result;
            if (computer == null) result = await windows.Session(op, request, requestId);
            else result = op switch {
                "status" => computer.Status(),
                "targets" => await Task.Run(computer.Targets),
                "observe" => await Task.Run(() => computer.Observe(Program.Text(request, "targetId", 256), request.TryGetProperty("preview", out var preview) && preview.ValueKind == JsonValueKind.True)),
                "lease" => computer.Lease(request),
                "release" => computer.Release(request),
                "act" => await computer.Act(request),
                "openPreview" => await windows.OpenPreview(request),
                "closePreview" => await windows.ClosePreview(request),
                _ => throw new NativeFailure("unknown-operation", "Unknown native operation")
            };
            // Session open waits for the verified in-page handshake and emits its own reply.
            if (!ReferenceEquals(result, WindowManager.Deferred)) Program.Emit(new { requestId, ok = true, result });
        } catch (Exception error) {
            var code = error is NativeFailure failure ? failure.Code : "native-failed";
            // Never expose arbitrary exception text, authenticated URLs or filesystem paths.
            Program.Emit(new { requestId, ok = false, error = new { code, message = error is NativeFailure ? error.Message : "Native operation failed" } });
        }
    }
    private void Shutdown()
    {
        if (exiting) return;
        exiting = true; parentWatch.Stop();
        try { computer?.Dispose(); }
        catch (NativeFailure) { Environment.ExitCode = 1; Program.Emit(new { @event = "inputCleanupFailed" }); }
        finally { windows.Dispose(); ExitThread(); }
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { Shutdown(); parentWatch.Dispose(); dispatcher.Dispose(); }
        base.Dispose(disposing);
    }
}
