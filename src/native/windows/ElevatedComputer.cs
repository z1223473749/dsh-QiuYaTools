using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace QiuYaTools.Windows;

/// An owner-requested UAC child. No shell commands, application launch or browser content are accepted.
internal sealed class ElevatedComputer : IDisposable
{
    internal static bool Worker { get; private set; }
    private static NamedPipeClientStream? workerPipe; // Keeps the duplex channel alive for the worker lifetime.
    internal static bool Allows(string op) => op is "status" or "applications" or "targets" or "observe" or "lease" or "release" or "act";
    private readonly NamedPipeServerStream pipe;
    private readonly StreamReader reader;
    private readonly StreamWriter writer;
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonElement>> pending = new();
    private readonly TaskCompletionSource<bool> released = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly SemaphoreSlim writes = new(1, 1);
    private long sequence;
    private int disposed;
    private ElevatedComputer(NamedPipeServerStream pipe)
    {
        this.pipe = pipe;
        reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true);
        writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
        _ = Read();
    }
    internal static async Task<ElevatedComputer> Start()
    {
        var name = "QiuYaTools-control-" + Guid.NewGuid().ToString("N");
        var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try {
            var executable = Environment.ProcessPath ?? throw new NativeFailure("elevation-unavailable", "The control executable is unavailable");
            var start = new ProcessStartInfo(executable) { UseShellExecute = true, Verb = "runas" };
            start.ArgumentList.Add("--elevated-computer"); start.ArgumentList.Add(name); start.ArgumentList.Add(Environment.ProcessId.ToString());
            using var child = await Task.Run(() => Process.Start(start)) ?? throw new NativeFailure("elevation-unavailable", "Administrator control could not be started");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            await pipe.WaitForConnectionAsync(timeout.Token);
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid) || pid != child.Id) throw new NativeFailure("elevation-peer-invalid", "Administrator control identity did not match");
            return new ElevatedComputer(pipe);
        } catch (System.ComponentModel.Win32Exception error) when (error.NativeErrorCode == 1223) {
            pipe.Dispose(); throw new NativeFailure("elevation-cancelled", "Administrator access was cancelled");
        } catch { pipe.Dispose(); throw; }
    }
    internal static void ConnectWorker(string[] args)
    {
        var index = Array.IndexOf(args, "--elevated-computer");
        if (index < 0) return;
        if (args.Length != index + 3 || !args[index + 1].StartsWith("QiuYaTools-control-", StringComparison.Ordinal) ||
            !Guid.TryParseExact(args[index + 1]["QiuYaTools-control-".Length..], "N", out _) || !uint.TryParse(args[index + 2], out var expected) || !ProcessPermissions.Elevated)
            throw new NativeFailure("elevation-peer-invalid", "Invalid administrator control request");
        var pipe = new NamedPipeClientStream(".", args[index + 1], PipeDirection.InOut, PipeOptions.Asynchronous);
        pipe.Connect(10000);
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var actual) || actual != expected) { pipe.Dispose(); throw new NativeFailure("elevation-peer-invalid", "The control owner did not match"); }
        using (var parent = Process.GetProcessById((int)actual)) {
            if (parent.SessionId != Process.GetCurrentProcess().SessionId || !string.Equals(parent.MainModule?.FileName, Environment.ProcessPath, StringComparison.OrdinalIgnoreCase)) {
                pipe.Dispose(); throw new NativeFailure("elevation-peer-invalid", "The control owner executable did not match");
            }
        }
        workerPipe = pipe; Worker = true;
        Console.SetIn(new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true));
        Console.SetOut(new StreamWriter(workerPipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true });
        Environment.SetEnvironmentVariable("QIUYA_TOOLS_PARENT_PID", expected.ToString());
    }
    private async Task Read()
    {
        try {
            while (await reader.ReadLineAsync() is { } line) {
                if (line.Length > 48 * 1024 * 1024) throw new IOException();
                using var json = JsonDocument.Parse(line); var value = json.RootElement;
                if (value.TryGetProperty("event", out var ev)) {
                    if (ev.GetString() == "inputReleased") released.TrySetResult(value.TryGetProperty("passed", out var passed) && passed.ValueKind == JsonValueKind.True);
                    else if (ev.GetString() != "browserShutdown") Program.Emit(value.Clone());
                } else if (value.TryGetProperty("requestId", out var id) && id.TryGetInt64(out var number) && pending.TryRemove(number, out var waiter)) waiter.TrySetResult(value.Clone());
            }
        } catch (Exception error) when (error is IOException or ObjectDisposedException or JsonException) { }
        finally {
            foreach (var waiter in pending.Values) waiter.TrySetException(new NativeFailure("elevated-disconnected", "Administrator control disconnected; input release must be confirmed before reconnecting"));
            pending.Clear(); released.TrySetResult(false);
        }
    }
    internal async Task<JsonElement> Call(string op, JsonElement request)
    {
        if (!Allows(op) || Volatile.Read(ref disposed) != 0) throw new NativeFailure("elevation-unavailable", "Administrator control is unavailable");
        var id = Interlocked.Increment(ref sequence);
        var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = completion;
        var payload = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(request.GetRawText())!;
        payload["requestId"] = JsonSerializer.SerializeToElement(id); payload["op"] = JsonSerializer.SerializeToElement(op);
        try {
            await writes.WaitAsync();
            try { await writer.WriteLineAsync(JsonSerializer.Serialize(payload)); } finally { writes.Release(); }
            var reply = await completion.Task.WaitAsync(TimeSpan.FromSeconds(30));
            if (!reply.GetProperty("ok").GetBoolean()) {
                var error = reply.GetProperty("error"); throw new NativeFailure(error.GetProperty("code").GetString()!, error.GetProperty("message").GetString()!);
            }
            return reply.GetProperty("result").Clone();
        } finally { pending.TryRemove(id, out _); }
    }
    internal async Task Close()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        // Explicit shutdown preserves the duplex read side until the privileged owner confirms release.
        await writes.WaitAsync();
        try { await writer.WriteLineAsync("{\"requestId\":0,\"op\":\"shutdownControl\"}"); } finally { writes.Release(); }
        try { if (!await released.Task.WaitAsync(TimeSpan.FromMilliseconds(1200))) throw new IOException(); }
        catch { throw new NativeFailure("input-cleanup-failed", "Administrator input release was not confirmed"); }
        finally { pipe.Dispose(); }
    }
    public void Dispose() { pipe.Dispose(); }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
}
