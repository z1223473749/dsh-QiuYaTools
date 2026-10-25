using System.Diagnostics;
using System.Text.Json;
using QiuYaTools.Windows;

namespace QiuYaTools.Windows;

internal static class Program
{
    private static readonly List<object> tests = new();
    internal static readonly List<string> Events = new();
    internal static string? RejectEvent;
    internal static void Emit(object value)
    {
        var json = JsonSerializer.Serialize(value);
        var name = JsonDocument.Parse(json).RootElement.GetProperty("event").GetString();
        if (name == RejectEvent) throw new IOException("Controlled output failure");
        Events.Add(json);
    }
    private static void Check(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException(name);
        tests.Add(new { name, passed = true });
    }
    private static bool Has(string name, bool? passed = null) => Events.Any(row => {
        using var document = JsonDocument.Parse(row);
        var root = document.RootElement;
        return root.GetProperty("event").GetString() == name
            && (passed == null || root.TryGetProperty("passed", out var value) && value.GetBoolean() == passed);
    });
    private static void Reset() { Events.Clear(); RejectEvent = null; Environment.ExitCode = 0; }
    private static async Task Main()
    {
        Reset();
        var delayed = new WindowManager();
        var browser = delayed.Add(41);
        delayed.OnClose = () => { _ = Task.Run(async () => { await Task.Delay(1_100); browser.BrowserExited(41); }); };
        var owner = new TestComputer();
        var computer = new NativeContext(owner, delayed);
        var drainClock = Stopwatch.StartNew();
        var completion = computer.Begin();
        Check(Has("inputReleased", true) && !Has("browserShutdown"), "input-release-is-confirmed-before-browser-retirement");
        Check(!completion.IsCompleted, "input-release-ack-is-not-browser-completion");
        Check(ReferenceEquals(completion, computer.Begin()) && owner.Disposals == 1, "repeat-shutdown-never-releases-or-closes-twice");
        await completion.WaitAsync(TimeSpan.FromSeconds(3));
        var naturalDrainMilliseconds = drainClock.ElapsedMilliseconds;
        Check(WindowManager.BrowserShutdownMilliseconds == 5_000, "product-browser-drain-has-explicit-five-second-bound");
        Check(Has("browserShutdown", true) && Environment.ExitCode == 0, "natural-browser-retirement-after-old-one-second-bound-succeeds");
        Check(computer.Exits == 1 && delayed.Data.Disposals == 1, "normal-shutdown-exits-once-and-releases-preview-scope");

        Reset();
        var session = new NativeContext(null, new WindowManager());
        await session.Begin();
        Check(!Has("inputReleased") && !Has("inputCleanupFailed") && Has("browserShutdown", true), "session-companion-does-not-fabricate-input-ownership");

        foreach (var failure in new Exception[] { new IOException("Controlled input failure"), new InvalidOperationException("Controlled input failure") }) {
            Reset();
            var manager = new WindowManager();
            var failed = new NativeContext(new TestComputer { Failure = failure }, manager);
            await failed.Begin();
            Check(!Has("inputReleased") && Has("inputCleanupFailed") && Environment.ExitCode == 1,
                failure is IOException ? "arbitrary-dispose-io-failure-never-acknowledges-release" : "arbitrary-dispose-state-failure-never-acknowledges-release");
            Check(manager.Closes == 1 && failed.Exits == 1, failure is IOException ? "input-io-failure-still-attempts-bounded-browser-cleanup" : "input-state-failure-still-attempts-bounded-browser-cleanup");
        }

        Reset();
        var unknown = new WindowManager();
        unknown.Add(51).InitializationFailed();
        var faulted = new NativeContext(new TestComputer(), unknown);
        await faulted.Begin();
        Check(Has("inputReleased", true) && Has("browserShutdown", false) && Environment.ExitCode == 1, "released-input-never-converts-unknown-browser-initialization-to-success");

        Reset();
        RejectEvent = "inputReleased";
        var badInputPipe = new NativeContext(new TestComputer(), new WindowManager());
        await badInputPipe.Begin();
        Check(!Has("inputReleased") && Has("browserShutdown", true) && Environment.ExitCode == 1 && badInputPipe.Exits == 1,
            "failed-input-receipt-output-is-nonzero-and-does-not-skip-browser-cleanup");

        Reset();
        RejectEvent = "browserShutdown";
        var badFinalPipe = new NativeContext(null, new WindowManager());
        await badFinalPipe.Begin();
        Check(!Has("browserShutdown") && Environment.ExitCode == 1 && badFinalPipe.Exits == 1,
            "failed-final-receipt-output-is-nonzero-and-always-exits-message-loop");

        Reset();
        var groups = new WindowManager();
        var first = groups.Add(61); var second = groups.Add(62);
        first.BrowserExited(61);
        var all = groups.ShutdownAsync(500);
        second.BrowserExited(999);
        Check(!all.IsCompleted, "wrong-browser-process-exit-does-not-release-original-group");
        second.BrowserExited(62); await all;
        Check(groups.Data.Disposals == 1, "all-exact-browser-groups-must-retire-before-scope-release");

        var alive = new WindowManager();
        var late = alive.Add(71);
        var timedOut = false;
        try { await alive.ShutdownAsync(20); } catch (TimeoutException) { timedOut = true; }
        Check(timedOut && !late.Completion.IsCompleted && alive.Data.Disposals == 1, "bounded-drain-does-not-assume-still-alive-browser-is-retired");
        late.BrowserExited(71); await late.Completion;
        Check(timedOut, "late-browser-exit-does-not-rewrite-prior-timeout");

        var slowClose = new WindowManager { OnClose = () => Thread.Sleep(20) };
        var closeTimedOut = false;
        try { await slowClose.ShutdownAsync(5); } catch (TimeoutException) { closeTimedOut = true; }
        Check(closeTimedOut && slowClose.Data.Disposals == 1, "synchronous-close-time-is-charged-to-original-browser-bound");

        Environment.ExitCode = 0;
        Console.WriteLine(JsonSerializer.Serialize(new { passed = true, tests,
            naturalDrainMilliseconds, browserDrainBoundMilliseconds = WindowManager.BrowserShutdownMilliseconds,
            source = "actual Program.cs Shutdown body, BrowserWindows.cs ShutdownAsync body and bound, and exact linked BrowserExitState.cs",
            GUI = 0, Host = 0, PD = 0, model = 0, input = 0, nativeWindows = 0 }));
    }
}

internal sealed class TestComputer
{
    internal Exception? Failure;
    internal int Disposals;
    internal void Dispose() { Disposals++; if (Failure != null) throw Failure; }
}
internal sealed class TestWatch { internal void Stop() { } }
internal sealed partial class NativeContext
{
    private bool exiting;
    private readonly TestWatch parentWatch = new();
    private readonly TestComputer? computer;
    private readonly WindowManager windows;
    private readonly TaskCompletionSource completed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal int Exits;
    internal NativeContext(TestComputer? computer, WindowManager windows) { this.computer = computer; this.windows = windows; }
    internal Task Begin() { Shutdown(); return completed.Task; }
    private void ExitThread() { Exits++; completed.TrySetResult(); }
}
internal sealed class TestDataScope : IDisposable
{
    internal int Disposals;
    public void Dispose() { Disposals++; }
}
internal sealed class BrowserWindow
{
    internal readonly BrowserExitState State = new();
    internal Task BrowserRetired => State.Completion;
}
internal sealed partial class WindowManager
{
    private readonly HashSet<BrowserWindow> browserLifetimes = new();
    private TestDataScope? previewData;
    internal readonly TestDataScope Data = new();
    internal Action? OnClose;
    internal int Closes;
    internal WindowManager() { previewData = Data; }
    internal BrowserExitState Add(uint pid)
    {
        var window = new BrowserWindow();
        window.State.BrowserCreated(pid); window.State.InitializationFinished();
        browserLifetimes.Add(window); return window.State;
    }
    private void CloseWindows() { Closes++; OnClose?.Invoke(); }
}
