using System.Diagnostics;

namespace QiuYaTools.Windows;

/// Deterministic child-process failure tests. No desktop input or real target capture is performed.
internal static class CaptureSelfTest
{
    private static readonly byte[] Jpeg = [0xff, 0xd8, 0xff, 0xd9];
    internal static void Worker(string[] args)
    {
        var index = Array.IndexOf(args, "--capture-worker-test");
        var mode = index + 1 < args.Length ? args[index + 1] : "invalid";
        if (mode is "pool-saturation" or "pool-saturation-deadline") {
            var result = PoolSaturation(mode == "pool-saturation-deadline");
            Program.Emit(result); Environment.ExitCode = result.Passed ? 0 : 1; return;
        }
        var captures = 0;
        CaptureBroker.RunWorker(_ => {
            if (mode == "hang") Thread.Sleep(Timeout.Infinite);
            if (mode == "hang-after-warm" && ++captures > 1) Thread.Sleep(Timeout.Infinite);
            if (mode == "crash") Environment.Exit(23);
            if (mode == "invalid") { Console.WriteLine("invalid-json"); Console.Out.Flush(); Thread.Sleep(Timeout.Infinite); }
            return Jpeg;
        });
    }
    internal static void Parent()
    {
        var childPid = 0;
        using var broker = new CaptureBroker(info => {
            info.ArgumentList.Add("--capture-worker-test"); info.ArgumentList.Add("hang");
            var child = Process.Start(info) ?? throw new InvalidOperationException(); childPid = child.Id; return child;
        });
        _ = Task.Run(() => broker.Capture("fixture"));
        if (!SpinWait.SpinUntil(() => childPid > 0, 2500)) Environment.Exit(2);
        Program.Emit(new { childPid });
        Thread.Sleep(Timeout.Infinite);
    }
    private sealed record PoolResult(bool Passed, object[] Checks, object Timing, object Cleanup, object[] Workers,
        string Kind = "production-capture-under-isolated-shared-pool-saturation", bool ActualOsInput = false, bool ActualDesktopCapture = false);

    // This mode runs in a separate test process. Product code never changes ThreadPool limits.
    private static PoolResult PoolSaturation(bool timeoutFirst)
    {
        const int maximumWorkers = 4;
        var gateDeadlineMs = timeoutFirst ? 7000 : 4000;
        ThreadPool.GetMinThreads(out var oldMinimum, out var oldMinimumIo);
        ThreadPool.GetMaxThreads(out var oldMaximum, out var oldMaximumIo);
        var gate = new ManualResetEventSlim(); var captureStarted = new ManualResetEventSlim(); var captureDone = new ManualResetEventSlim();
        var workerPins = new List<Process>(); var identities = new List<object>(); var workersLock = new object();
        var entered = 0; var left = 0; var enteredAtCapture = 0; var workersAfterWarm = 0;
        long startedTicks = 0, completedTicks = 0, gateReleasedTicks = 0;
        var warm = false; var saturated = false; var received = false; var callerJoined = true; var watchdogJoined = true;
        var blockersJoined = true; var restored = false; var workersExited = false; var disposed = false;
        string? failure = null; string? captureFailure = null; Task[] blockers = []; Thread? caller = null, watchdog = null;
        using var broker = new CaptureBroker(info => {
            info.ArgumentList.Add("--capture-worker-test"); info.ArgumentList.Add(timeoutFirst && workerPins.Count == 0 ? "hang-after-warm" : "normal");
            var child = Process.Start(info) ?? throw new InvalidOperationException("Pool test worker did not start");
            Process? pin = null;
            try {
                pin = Process.GetProcessById(child.Id); _ = pin.SafeHandle;
                if (pin.StartTime.ToUniversalTime().Ticks != child.StartTime.ToUniversalTime().Ticks) throw new InvalidOperationException("Pool test worker identity changed");
                lock (workersLock) {
                    workerPins.Add(pin);
                    identities.Add(new { pid = pin.Id, createdAtTicks = pin.StartTime.ToUniversalTime().Ticks.ToString(), expectedExecutablePath = Environment.ProcessPath });
                }
                return child;
            } catch {
                pin?.Dispose();
                try { if (!child.HasExited) child.Kill(); if (!child.WaitForExit(1500)) throw new InvalidOperationException("Untracked pool test worker did not retire"); }
                finally { child.Dispose(); }
                throw;
            }
        });
        try {
            // Establish the actual protocol/worker before saturation; cold process startup is outside this test interval.
            warm = broker.Capture("fixture").SequenceEqual(Jpeg);
            lock (workersLock) { workersAfterWarm = workerPins.Count; }
            if (!warm || workersAfterWarm != 1) throw new InvalidOperationException("warm-worker-not-established");
            if (!ThreadPool.SetMinThreads(1, oldMinimumIo) || !ThreadPool.SetMaxThreads(maximumWorkers, oldMaximumIo)) throw new InvalidOperationException("pool-limit-setup-unavailable");
            blockers = Enumerable.Range(0, maximumWorkers).Select(_ => Task.Run(() => {
                Interlocked.Increment(ref entered); gate.Wait(); Interlocked.Increment(ref left);
            })).ToArray();
            // An existing redirected-stderr reader can occupy a worker too. Require zero available workers, not a guessed blocker count.
            saturated = SpinWait.SpinUntil(() => {
                ThreadPool.GetAvailableThreads(out var available, out _);
                return available == 0 && Volatile.Read(ref entered) > 0;
            }, 5000);
            if (!saturated) throw new InvalidOperationException("shared-pool-not-saturated");
            enteredAtCapture = Volatile.Read(ref entered);
            watchdog = new Thread(() => {
                captureStarted.Wait(5000);
                captureDone.Wait(gateDeadlineMs);
                Interlocked.Exchange(ref gateReleasedTicks, Stopwatch.GetTimestamp());
                gate.Set();
            }) { IsBackground = true, Name = "QiuYaTools capture pool test watchdog" };
            caller = new Thread(() => {
                Interlocked.Exchange(ref startedTicks, Stopwatch.GetTimestamp()); captureStarted.Set();
                try { received = broker.Capture("fixture").SequenceEqual(Jpeg); }
                catch (Exception error) { captureFailure = error is NativeFailure native ? native.Code : error.GetType().Name; }
                finally { Interlocked.Exchange(ref completedTicks, Stopwatch.GetTimestamp()); captureDone.Set(); }
            }) { IsBackground = true, Name = "QiuYaTools capture pool test caller" };
            watchdog.Start(); caller.Start();
            callerJoined = caller.Join(13000);
        } catch (Exception error) { failure = error.Message; }
        finally {
            gate.Set(); captureStarted.Set();
            // Restore the upper bound first so the original minimum is always legal.
            restored = ThreadPool.SetMaxThreads(oldMaximum, oldMaximumIo) && ThreadPool.SetMinThreads(oldMinimum, oldMinimumIo);
            if (caller != null && !callerJoined) {
                try { broker.Dispose(); disposed = true; } catch { failure ??= "broker-disposal-failed"; }
                callerJoined = caller.Join(3000);
            }
            captureDone.Set();
            if (watchdog != null) watchdogJoined = watchdog.Join(2000);
            try { blockersJoined = Task.WaitAll(blockers, 3000); } catch { blockersJoined = false; }
            if (!disposed) { try { broker.Dispose(); disposed = true; } catch { failure ??= "broker-disposal-failed"; } }
            lock (workersLock) {
                workersExited = workerPins.All(pin => { try { return pin.HasExited; } catch { return false; } });
                foreach (var pin in workerPins) pin.Dispose();
            }
            ThreadPool.GetMinThreads(out var minimum, out var minimumIo); ThreadPool.GetMaxThreads(out var maximum, out var maximumIo);
            restored = restored && minimum == oldMinimum && minimumIo == oldMinimumIo && maximum == oldMaximum && maximumIo == oldMaximumIo;
            if (callerJoined && watchdogJoined && blockersJoined) { gate.Dispose(); captureStarted.Dispose(); captureDone.Dispose(); }
        }
        var completedWhileGated = startedTicks > 0 && completedTicks > startedTicks && gateReleasedTicks > completedTicks;
        var reused = identities.Count == workersAfterWarm + (timeoutFirst ? 1 : 0) && workersAfterWarm == 1;
        var cleanup = callerJoined && watchdogJoined && blockersJoined && restored && disposed && workersExited && entered == maximumWorkers && left == maximumWorkers;
        var passed = warm && saturated && received && captureFailure == null && failure == null && completedWhileGated && reused && cleanup;
        return new PoolResult(passed, [
            new { id = "warm-real-production-capture-before-saturation", passed = warm && workersAfterWarm == 1 },
            new { id = "shared-pool-has-zero-available-workers-before-capture", passed = saturated, enteredAtCapture },
            new { id = "production-pipe-capture-completes-before-independent-watchdog-releases-pool", passed = received && completedWhileGated, captureFailure },
            new { id = timeoutFirst ? "hung-worker-is-retired-and-retried-once-without-pool-release" : "warm-worker-is-reused-without-retry", passed = reused },
            new { id = "all-test-threads-blockers-worker-processes-retired-and-pool-limits-restored", passed = cleanup }
        ], new {
            frequency = Stopwatch.Frequency, startedTicks, completedTicks, gateReleasedTicks, gateDeadlineMs, timeoutFirst,
            captureElapsedMs = startedTicks > 0 && completedTicks > 0 ? (completedTicks - startedTicks) * 1000.0 / Stopwatch.Frequency : (double?)null,
            completedWhileGated, failure
        }, new { callerJoined, watchdogJoined, blockersJoined, restored, disposed, workersExited, entered, left }, identities.ToArray());
    }

    private static System.Text.Json.JsonElement PoolSaturationChild(bool timeoutFirst)
    {
        var info = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        info.ArgumentList.Add("--capture-worker-test"); info.ArgumentList.Add(timeoutFirst ? "pool-saturation-deadline" : "pool-saturation");
        using var child = Process.Start(info) ?? throw new InvalidOperationException("Pool test process did not start");
        var stdout = child.StandardOutput.ReadToEndAsync(); var stderr = child.StandardError.ReadToEndAsync();
        try {
            if (!child.WaitForExit(30000)) throw new InvalidOperationException("Pool scheduling self-test process deadline");
            var text = stdout.WaitAsync(TimeSpan.FromSeconds(3)).GetAwaiter().GetResult();
            _ = stderr.WaitAsync(TimeSpan.FromSeconds(3)).GetAwaiter().GetResult();
            using var result = System.Text.Json.JsonDocument.Parse(text);
            if (child.ExitCode != 0 || !result.RootElement.GetProperty("passed").GetBoolean()) throw new InvalidOperationException("Production capture waited for the isolated shared pool; see --capture-worker-test pool-saturation metadata");
            return result.RootElement.Clone();
        } finally { if (!child.HasExited) { child.Kill(); if (!child.WaitForExit(1500)) throw new InvalidOperationException("Pool test process did not retire"); } }
    }
    internal static object Run()
    {
        var checks = new List<string>();
        var poolScheduling = PoolSaturationChild(false);
        checks.Add("production-capture-independent-of-saturated-shared-pool");
        var poolDeadline = PoolSaturationChild(true);
        checks.Add("production-capture-timeout-and-single-retry-independent-of-saturated-shared-pool");
        CaptureBroker Broker(Func<int, string> mode, List<int> children)
        {
            return new CaptureBroker(info => {
                info.ArgumentList.Add("--capture-worker-test"); info.ArgumentList.Add(mode(children.Count));
                var child = Process.Start(info) ?? throw new InvalidOperationException("Test child failed to start");
                children.Add(child.Id); return child;
            }, 1500, 1500);
        }
        bool Alive(int pid) { try { using var process = Process.GetProcessById(pid); return !process.HasExited; } catch (ArgumentException) { return false; } }
        void Verify(bool condition, string name) { if (!condition) throw new InvalidOperationException(name); checks.Add(name); }
        var all = new List<int>();
        foreach (var mode in new[] { "hang", "crash", "invalid" }) {
            var children = new List<int>();
            using (var broker = Broker(index => index == 0 ? mode : "normal", children)) {
                Verify(broker.Capture("fixture").SequenceEqual(Jpeg), mode + "-retry-succeeds");
                Verify(children.Count == 2 && !Alive(children[0]), mode + "-old-worker-exited-before-retry");
                broker.Capture("fixture"); Verify(children.Count == 2, mode + "-steady-worker-reused");
            }
            all.AddRange(children);
        }
        var hanging = new List<int>();
        using (var broker = Broker(_ => "hang", hanging)) {
            var started = Stopwatch.StartNew();
            try { broker.Capture("fixture"); throw new InvalidOperationException("Repeated hangs must fail"); }
            catch (NativeFailure failure) when (failure.Code == "capture-timeout") { }
            Verify(hanging.Count == 2 && hanging.All(pid => !Alive(pid)) && started.ElapsedMilliseconds < 6500, "repeated-hang-bounded-and-all-workers-exited");
        }
        all.AddRange(hanging);
        var disposing = new List<int>();
        var disposeBroker = Broker(_ => "hang", disposing);
        var capture = Task.Run(() => { try { disposeBroker.Capture("fixture"); return "unexpected-success"; } catch (NativeFailure failure) { return failure.Code; } });
        SpinWait.SpinUntil(() => disposing.Count == 1, 2000); Thread.Sleep(150);
        disposeBroker.Dispose();
        Verify(capture.Wait(2500) && capture.Result == "capture-disposed" && disposing.All(pid => !Alive(pid)), "dispose-interrupts-inflight-capture");
        all.AddRange(disposing);
        Verify(all.All(pid => !Alive(pid)), "no-capture-worker-remains");
        var retirementAllowed = false; var fencedChildren = new List<int>();
        using (var broker = new CaptureBroker(info => {
            info.ArgumentList.Add("--capture-worker-test"); info.ArgumentList.Add("hang");
            var child = Process.Start(info) ?? throw new InvalidOperationException(); fencedChildren.Add(child.Id); return child;
        }, 1500, 1500, (process, timeout) => { if (!retirementAllowed) return false; if (!process.HasExited) process.Kill(); return process.WaitForExit(timeout); })) {
            try { broker.Capture("fixture"); throw new InvalidOperationException("Unconfirmed retirement must fail"); }
            catch (NativeFailure failure) when (failure.Code == "capture-worker-stuck") { }
            try { broker.Capture("fixture"); throw new InvalidOperationException("Unconfirmed worker must fence replacement"); }
            catch (NativeFailure failure) when (failure.Code == "capture-worker-stuck") { }
            Verify(fencedChildren.Count == 1 && Alive(fencedChildren[0]), "unconfirmed-retirement-fences-new-worker");
            retirementAllowed = true;
        }
        if (fencedChildren.Any(Alive)) throw new InvalidOperationException("Fenced test worker was not cleaned up");
        var info = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardInput = true };
        info.ArgumentList.Add("--capture-parent-test");
        using (var parent = Process.Start(info) ?? throw new InvalidOperationException()) {
            var line = parent.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(4)).GetAwaiter().GetResult() ?? throw new InvalidOperationException("Test parent did not report a worker");
            using var document = System.Text.Json.JsonDocument.Parse(line);
            var childPid = document.RootElement.GetProperty("childPid").GetInt32();
            try {
                parent.Kill(); if (!parent.WaitForExit(1500)) throw new InvalidOperationException("Test parent did not exit");
                Verify(SpinWait.SpinUntil(() => !Alive(childPid), 2500), "orphaned-blocked-worker-exits-after-parent-death");
            } finally { try { if (!parent.HasExited) parent.Kill(); } catch { } try { using var child = Process.GetProcessById(childPid); if (!child.HasExited) child.Kill(); } catch (ArgumentException) { } }
        }
        return new { passed = true, checks = checks.Count, cases = checks, poolScheduling, poolDeadline, kind = "isolated-capture-worker-fault-injection", actualOsInput = false, actualDesktopCapture = false };
    }
}
