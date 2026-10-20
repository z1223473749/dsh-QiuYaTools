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
        CaptureBroker.RunWorker(_ => {
            if (mode == "hang") Thread.Sleep(Timeout.Infinite);
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
    internal static object Run()
    {
        var checks = new List<string>();
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
        return new { passed = true, checks = checks.Count, cases = checks, kind = "isolated-capture-worker-fault-injection", actualOsInput = false, actualDesktopCapture = false };
    }
}
