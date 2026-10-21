using System.Text.Json;

namespace QiuYaTools.Windows;

/** State/rendering tests use no window, input injection, focus or account. */
internal static class AiCursorSelfTest
{
    internal static object Run()
    {
        var cases = new List<string>();
        void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException(name); cases.Add(name); }
        static JsonElement Json(string value) => JsonDocument.Parse(value).RootElement.Clone();
        Check(ComputerDriver.LeaseActor(Json("{}")) == "ai", "missing-actor-defaults-to-ai");
        Check(ComputerDriver.LeaseActor(Json("{\"actor\":\"human\"}")) == "human", "trusted-human-lease-is-explicit");
        foreach (var request in new[] { "{\"actor\":\"model\"}", "{\"actor\":false}", "{\"actor\":null}" }) {
            try { ComputerDriver.LeaseActor(Json(request)); throw new InvalidOperationException("Invalid actor accepted"); }
            catch (NativeFailure error) when (error.Code == "invalid-actor") { }
        }
        Check(true, "invalid-actor-does-not-silently-default");
        var state = new AiCursorState(); var target = new IntPtr(42); var bounds = new Rectangle(-400, 200, 1000, 800); var point = new Point(-150, 550);
        Check(!state.Move(0, "own-target", target, 12, bounds, point) && !state.Snapshot().Visible, "unleased-state-never-publishes-a-pointer");
        Check(state.Lease(1, true) && state.Move(1, "own-target", target, 12, bounds, point), "ai-lease-accepts-only-its-own-move");
        var first = state.Read();
        Check(!state.Snapshot().Visible && state.CommitRendered(first.Generation), "pending-surface-is-not-claimed-visible-before-render");
        Check(state.Snapshot() is { X: 250, Y: 350, Visible: true, Actor: "ai" }, "ai-coordinates-are-target-local-with-negative-origin");
        Check(!state.Snapshot("another-target").Visible && state.Snapshot("own-target").Visible, "observation-of-another-target-does-not-relabel-or-hide-the-live-target");
        Check(state.Revoke(1) && !state.CommitRendered(first.Generation) && !state.Move(1, "own-target", target, 12, bounds, point), "release-fences-both-queued-render-and-old-input");
        Check(state.Lease(2, true) && state.Move(2, "own-target", target, 12, bounds, point), "next-lease-has-a-fresh-pending-generation");
        var old = state.Read();
        Check(state.Lease(3, true) && state.Move(3, "own-target", target, 12, bounds, point), "replacement-lease-has-independent-generation");
        var current = state.Read(); Check(state.CommitRendered(current.Generation), "new-lease-can-render");
        Check(!state.Revoke(2) && !state.Hide(2) && !state.Move(2, "own-target", target, 12, bounds, point) && !state.HideGeneration(old.Generation) && !state.CommitRendered(old.Generation) && state.Snapshot().Visible,
            "old-release-hide-and-queued-paint-cannot-clear-a-new-lease");
        Check(state.Lease(4, false) && !state.Move(4, "own-target", target, 12, bounds, point) && !state.Snapshot().Visible,
            "human-lease-never-shows-the-ai-pointer");
        Check(state.Lease(5, true) && state.Move(5, "own-target", target, 12, bounds, point), "ai-can-resume-after-human-control");
        var focused = state.Read(); Check(state.CommitRendered(focused.Generation) && state.HideGeneration(focused.Generation) && !state.CommitRendered(focused.Generation) && !state.Snapshot().Visible,
            "focus-loss-invalidates-inflight-paint-and-does-not-resurrect-without-a-new-action");
        Check(!state.Move(5, "own-target", target, 12, bounds, new Point(2000, 3000)), "out-of-target-position-is-never-published");
        Check(!state.Lease(4, true), "stale-lease-cannot-replace-current-actor");
        using (var waiting = new ManualResetEventSlim(false)) using (var continueOld = new ManualResetEventSlim(false)) {
            var staleCommitted = true; var staleRevoked = true;
            var stale = state.Read();
            var worker = Task.Run(() => { waiting.Set(); continueOld.Wait(); staleCommitted = state.CommitRendered(stale.Generation); staleRevoked = state.Revoke(5); });
            Check(waiting.Wait(1000), "queued-render-test-enters-the-race");
            state.Lease(6, true); state.Move(6, "own-target", target, 12, bounds, point); state.CommitRendered(state.Read().Generation); continueOld.Set();
            Check(worker.Wait(1000) && !staleCommitted && !staleRevoked && state.Snapshot().Visible, "concurrent-old-queue-and-release-preserve-the-new-visible-lease");
        }
        using (var bitmap = AiCursorOverlay.DrawPointer(1, new Rectangle(0, 0, 100, 100), Point.Empty)) {
            var white = 0; var gray = 0; var transparent = 0;
            for (var y = 0; y < bitmap.Height; y++) for (var x = 0; x < bitmap.Width; x++) {
                var pixel = bitmap.GetPixel(x, y);
                if (pixel.A == 0) transparent++;
                else if (pixel.R > 235 && pixel.G > 235 && pixel.B > 235) white++;
                else if (Math.Abs(pixel.R - pixel.G) < 20 && Math.Abs(pixel.G - pixel.B) < 20) gray++;
            }
            Check(white > 10 && gray > 30 && transparent > 100, "arrow-bitmap-has-white-outline-gray-body-glow-and-transparent-background");
        }
        foreach (var scale in new[] { 1f, 2f }) using (var bitmap = AiCursorOverlay.DrawPointer(scale, new Rectangle(100, 100, 12, 12), new Point(95, 95))) {
            var outside = 0;
            for (var y = 0; y < bitmap.Height; y++) for (var x = 0; x < bitmap.Width; x++) if ((x < 5 || y < 5 || x >= 17 || y >= 17) && bitmap.GetPixel(x, y).A != 0) outside++;
            Check(outside == 0, $"pointer-pixels-are-clipped-to-the-controlled-target-at-{scale}x");
        }
        return new { passed = true, checks = cases.Count, cases, architecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(), actualOsInput = false, guiStarted = false, systemCursorChanged = false,
            boundary = "State and bitmap tests do not prove HWND click-through, DWM capture exclusion, focus behavior or visual quality on a live desktop." };
    }
}
