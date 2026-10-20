using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace QiuYaTools.Windows;

/// PrintWindow is uninterruptible in-process. Only this expendable, input-free worker may call it.
internal sealed class CaptureBroker : IDisposable
{
    private const int MaximumReply = 48 * 1024 * 1024;
    private const int MaximumImage = (MaximumReply - 4096) / 4 * 3;
    private readonly object lifecycle = new();
    private readonly object captures = new();
    private readonly object retirement = new();
    private readonly Func<ProcessStartInfo, Process?> startProcess;
    private readonly Func<Process, int, bool>? retireForTest;
    private readonly int captureTimeout;
    private readonly int retirementTimeout;
    private Process? worker;
    private long sequence;
    private bool disposed;
    private bool fenced;

    internal CaptureBroker() : this(info => Process.Start(info)) { }
    // Test-only factory may append a fixed worker-test argument. No RPC accepts executable paths/arguments.
    internal CaptureBroker(Func<ProcessStartInfo, Process?> factory, int captureTimeoutMs = 2500, int retirementTimeoutMs = 1500, Func<Process, int, bool>? retireProcessForTest = null)
    {
        startProcess = factory;
        retireForTest = retireProcessForTest;
        captureTimeout = Math.Clamp(captureTimeoutMs, 25, 2500);
        retirementTimeout = Math.Clamp(retirementTimeoutMs, 25, 1500);
    }

    private void CheckLive()
    {
        if (disposed) throw new NativeFailure("capture-disposed", "The capture broker is closed");
        if (fenced) throw new NativeFailure("capture-worker-stuck", "The previous capture worker has not exited; further captures are blocked");
    }

    private Process GetWorker()
    {
        lock (lifecycle) {
            CheckLive();
            if (worker != null) return worker;
            var executable = Environment.ProcessPath ?? throw new NativeFailure("capture-unavailable", "The companion executable is unavailable");
            var info = new ProcessStartInfo(executable) {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false)
            };
            info.ArgumentList.Add("--capture-worker");
            using var parent = Process.GetCurrentProcess();
            info.Environment["QIUYA_CAPTURE_PARENT_PID"] = parent.Id.ToString(CultureInfo.InvariantCulture);
            info.Environment["QIUYA_CAPTURE_PARENT_START_TICKS"] = parent.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
            try {
                worker = startProcess(info) ?? throw new InvalidOperationException();
                worker.ErrorDataReceived += (_, _) => { }; worker.BeginErrorReadLine();
                return worker;
            } catch {
                // A factory that returned a started process is still tracked if stderr setup failed.
                throw new NativeFailure("capture-unavailable", "The isolated capture worker could not be started");
            }
        }
    }

    internal byte[] Capture(string targetId)
    {
        if (string.IsNullOrEmpty(targetId) || targetId.Length > 256 || targetId.Any(char.IsControl)) throw new NativeFailure("invalid-target", "Invalid capture target identity");
        lock (captures) {
            for (var attempt = 0; attempt < 2; attempt++) {
                lock (lifecycle) { CheckLive(); }
                var process = GetWorker();
                try {
                    var requestId = ++sequence;
                    // Keep both a blocked pipe write and the bounded reply read off the caller's thread.
                    var response = Task.Run(() => {
                        process.StandardInput.WriteLine(JsonSerializer.Serialize(new { requestId, targetId }));
                        process.StandardInput.Flush();
                        return ReadReply(process.StandardOutput, requestId);
                    });
                    // A killed worker closes its pipes. Observe any late task fault even after timeout.
                    _ = response.ContinueWith(task => { _ = task.Exception; }, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously);
                    var bytes = response.WaitAsync(TimeSpan.FromMilliseconds(captureTimeout)).GetAwaiter().GetResult();
                    lock (lifecycle) { CheckLive(); }
                    return bytes;
                } catch (Exception error) when (error is TimeoutException or IOException or ObjectDisposedException or InvalidOperationException || error is NativeFailure failure && failure.Code is "capture-protocol" or "capture-worker-exited" or "capture-timeout") {
                    Retire(process);
                    lock (lifecycle) { CheckLive(); }
                    if (attempt == 1) throw new NativeFailure("capture-timeout", "Window capture did not complete after one isolated worker retry");
                }
            }
        }
        throw new NativeFailure("capture-timeout", "Window capture did not complete");
    }

    private void Retire(Process process)
    {
        lock (retirement) {
            lock (lifecycle) { if (!ReferenceEquals(worker, process)) return; }
            var exited = false;
            try {
                if (retireForTest != null) exited = retireForTest(process, retirementTimeout);
                else { if (!process.HasExited) process.Kill(); exited = process.WaitForExit(retirementTimeout); }
            } catch (InvalidOperationException) { try { exited = process.HasExited; } catch { } }
            catch (System.ComponentModel.Win32Exception) { try { exited = process.HasExited; } catch { } }
            if (!exited) {
                lock (lifecycle) { fenced = true; }
                throw new NativeFailure("capture-worker-stuck", "The timed-out capture worker did not exit; further captures are blocked");
            }
            lock (lifecycle) { if (ReferenceEquals(worker, process)) worker = null; }
            process.Dispose();
        }
    }

    private static string? ReadBoundedLine(TextReader reader, int maximum)
    {
        var line = new StringBuilder(Math.Min(maximum, 4096));
        while (true) {
            var value = reader.Read();
            if (value < 0) return line.Length == 0 ? null : throw new NativeFailure("capture-protocol", "The capture reply was incomplete");
            if (value == '\n') return line.ToString();
            if (line.Length >= maximum) throw new NativeFailure("capture-protocol", "The capture protocol exceeded its size limit");
            line.Append((char)value);
        }
    }

    private static byte[] ReadReply(TextReader reader, long expected)
    {
        var line = ReadBoundedLine(reader, MaximumReply) ?? throw new NativeFailure("capture-worker-exited", "The capture worker exited before replying");
        try {
            using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 8 });
            var value = document.RootElement;
            if (!value.TryGetProperty("requestId", out var id) || !id.TryGetInt64(out var actual) || actual != expected) throw new JsonException();
            if (value.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.False && value.TryGetProperty("error", out var error)) {
                var code = Program.Text(error, "code", 64); var message = Program.Text(error, "message", 256);
                throw new NativeFailure(code, message);
            }
            if (ok.ValueKind != JsonValueKind.True || !value.TryGetProperty("imageBase64", out var image) || image.ValueKind != JsonValueKind.String) throw new JsonException();
            var bytes = Convert.FromBase64String(image.GetString()!);
            if (bytes.Length is < 4 or > MaximumImage || bytes[0] != 0xff || bytes[1] != 0xd8) throw new JsonException();
            return bytes;
        } catch (Exception error) when (error is JsonException or FormatException or InvalidOperationException) {
            throw new NativeFailure("capture-protocol", "The capture worker returned an invalid reply");
        }
    }

    internal static void RunWorker(Func<string, byte[]>? captureForTest = null)
    {
        if (!int.TryParse(Environment.GetEnvironmentVariable("QIUYA_CAPTURE_PARENT_PID"), out var parentPid) || parentPid <= 0
            || !long.TryParse(Environment.GetEnvironmentVariable("QIUYA_CAPTURE_PARENT_START_TICKS"), out var parentStart) || parentStart <= 0) { Environment.ExitCode = 2; return; }
        // This callback remains independent of a main thread wedged inside PrintWindow.
        using var watch = new System.Threading.Timer(_ => {
            try { using var parent = Process.GetProcessById(parentPid); if (!parent.HasExited && parent.StartTime.ToUniversalTime().Ticks == parentStart) return; } catch { }
            try { Process.GetCurrentProcess().Kill(); } catch { Environment.Exit(1); }
        }, null, 250, 250);
        while (true) {
            long requestId = 0;
            try {
                var line = ReadBoundedLine(Console.In, 4096); if (line == null) return;
                using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 4 });
                var request = document.RootElement;
                if (!request.TryGetProperty("requestId", out var id) || !id.TryGetInt64(out requestId) || requestId <= 0) throw new JsonException();
                var targetId = Program.Text(request, "targetId", 256);
                var image = captureForTest != null ? captureForTest(targetId) : ComputerDriver.CaptureForWorker(targetId);
                if (image.Length is < 4 or > MaximumImage || image[0] != 0xff || image[1] != 0xd8) throw new NativeFailure("capture-limit", "The captured image exceeded its bounded protocol or was invalid");
                EmitReply(new { requestId, ok = true, imageBase64 = Convert.ToBase64String(image) });
            } catch (IOException) { return; }
            catch (Exception error) {
                var failure = error as NativeFailure;
                try { EmitReply(new { requestId, ok = false, error = new { code = failure?.Code ?? "capture-failed", message = failure is { Message.Length: <= 256 } ? failure.Message : "Window capture failed" } }); }
                catch (IOException) { return; }
                if (requestId <= 0) { Environment.ExitCode = 2; return; }
            }
        }
    }

    private static void EmitReply(object value)
    {
        // This JSONL channel is never HTML. Avoid default HTML/UTF-7 escaping of
        // '+' expanding base64 beyond its computed wire bound, and check exact size.
        var options = new JsonSerializerOptions(Program.Json) { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
        var line = JsonSerializer.Serialize(value, options);
        if (line.Length > MaximumReply) throw new NativeFailure("capture-limit", "The capture reply exceeded its size limit");
        Console.WriteLine(line); Console.Out.Flush();
    }

    public void Dispose()
    {
        Process? process;
        lock (lifecycle) { disposed = true; process = worker; }
        if (process != null) Retire(process);
    }
}
