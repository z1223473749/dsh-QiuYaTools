using System.Text.Json;

namespace QiuYaTools.Windows;

/** State/rendering tests use no window, input injection, focus or account. */
internal static class AiCursorSelfTest
{
    internal static object PreviewStorage()
    {
        var cases = new List<string>();
        void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException(name); cases.Add(name); }
        var home = Path.Combine(Path.GetTempPath(), "qyt-preview-storage-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(home, "cache"); var outside = Path.Combine(home, "outside"); string? junction = null;
        Directory.CreateDirectory(root); Directory.CreateDirectory(outside); File.WriteAllText(Path.Combine(outside, "keep.txt"), "own-external-marker");
        try {
            using var first = new PreviewDataScope(root); using var second = new PreviewDataScope(root);
            var a = first.Store("same-session"); var b = second.Store("same-session");
            Check(a != b && Path.GetDirectoryName(a) != Path.GetDirectoryName(b), "same-chat-in-two-helpers-has-independent-data-folders");
            Check(a == first.Store("same-session"), "same-helper-chat-reopen-retains-its-stable-hashed-path");
            Check(Path.GetFileName(a).Length == 64 && a.Length < 128 && first.Store("../\\unsafe\0会话") != a,
                "preview-path-is-short-and-session-identity-is-only-a-sha256-segment");
            var uuid = Path.Combine(root, Guid.NewGuid().ToString("D")); Directory.CreateDirectory(uuid); File.WriteAllText(Path.Combine(uuid, "keep.txt"), "session-uuid");
            PreviewDataScope.Prune(root);
            Check(Directory.Exists(first.DirectoryPath) && Directory.Exists(second.DirectoryPath), "live-helper-scopes-are-never-pruned");
            Check(File.ReadAllText(Path.Combine(uuid, "keep.txt")) == "session-uuid", "ordinary-session-uuid-storage-remains-untouched");
            var cache = Path.Combine(root, a); Directory.CreateDirectory(cache);
            using (var cancel = new CancellationTokenSource()) using (var started = new ManualResetEventSlim(false)) {
                var writes = 0;
                var churn = Task.Run(() => { started.Set(); while (!cancel.IsCancellationRequested) {
                    var transient = Path.Combine(cache, "browser-transient-" + Interlocked.Increment(ref writes));
                    File.WriteAllText(transient, "cache-write"); File.Delete(transient);
                } });
                if (!started.Wait(1000)) throw new IOException("Cache churn did not start");
                try { for (var index = 0; index < 24; index++) { first.BeginningBrowser(); first.BrowserCreated(Environment.ProcessId); } }
                finally { cancel.Cancel(); if (!churn.Wait(5000)) throw new IOException("Cache churn did not retire"); }
                Check(writes > 0, "metadata-updates-succeed-during-concurrent-browser-cache-file-churn");
            }
            string retired;
            using (var old = new PreviewDataScope(root)) { retired = old.DirectoryPath; }
            var ownerPath = Path.Combine(retired, ".owner.json");
            var record = JsonSerializer.Deserialize<PreviewDataScope.Manifest>(File.ReadAllText(ownerPath))!;
            var oldIdentity = record.Owner with { Born = record.Owner.Born - 1 };
            File.WriteAllText(ownerPath, JsonSerializer.Serialize(record with { Owner = oldIdentity, Browsers = [record.Owner] }));
            PreviewDataScope.Prune(root); Check(Directory.Exists(retired), "retired-helper-with-an-exact-live-browser-identity-is-preserved");
            File.WriteAllText(ownerPath, JsonSerializer.Serialize(record with { Owner = oldIdentity, Pending = 1 }));
            PreviewDataScope.Prune(root); Check(Directory.Exists(retired), "incomplete-browser-initialization-is-unknown-and-not-collected");
            File.WriteAllText(ownerPath, "{}"); PreviewDataScope.Prune(root);
            Check(Directory.Exists(retired), "unverifiable-owner-manifest-is-preserved");
            File.WriteAllText(ownerPath, JsonSerializer.Serialize(record with { Owner = oldIdentity }));
            junction = Path.Combine(retired, "linked-outside");
            using (var command = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
                "/d /c mklink /J \"" + junction + "\" \"" + outside + "\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true })!) {
                if (!command.WaitForExit(5000) || command.ExitCode != 0) throw new IOException("The owned junction test setup failed");
            }
            Check((File.GetAttributes(junction) & FileAttributes.ReparsePoint) != 0, "junction-test-uses-an-actual-ntfs-reparse-point");
            PreviewDataScope.Prune(root);
            Check(Directory.Exists(retired) && File.ReadAllText(Path.Combine(outside, "keep.txt")) == "own-external-marker", "any-reparse-child-preserves-the-whole-old-scope-and-external-target");
            var refusedAncestor = false;
            try { using var redirected = new PreviewDataScope(Path.Combine(junction, "must-not-be-created")); } catch (IOException) { refusedAncestor = true; }
            Check(refusedAncestor && !Directory.Exists(Path.Combine(outside, "must-not-be-created")), "reparse-ancestor-is-rejected-before-creating-any-cache-folder");
            Directory.Delete(junction); junction = null; PreviewDataScope.Prune(root);
            Check(!Directory.Exists(retired), "verified-retired-owner-and-browser-free-scope-is-collected");
            using (var bounded = new PreviewDataScope(root)) {
                for (var index = 0; index < PreviewDataScope.SessionLimit; index++) bounded.Store("session-" + index);
                var rejected = false; try { bounded.Store("one-too-many"); } catch (NativeFailure error) when (error.Code == "preview-cache-full") { rejected = true; }
                Check(rejected, "one-helper-has-a-fixed-32-session-directory-budget");
            }
            var full = Path.Combine(home, "full"); Directory.CreateDirectory(full);
            for (var index = 0; index < PreviewDataScope.ScopeLimit; index++) Directory.CreateDirectory(Path.Combine(full, PreviewDataScope.Prefix + Guid.NewGuid().ToString("N")));
            var capped = false; try { using var excess = new PreviewDataScope(full); } catch (NativeFailure error) when (error.Code == "preview-cache-full") { capped = true; }
            Check(capped && Directory.GetDirectories(full).Length == PreviewDataScope.ScopeLimit, "unknown-old-scopes-count-toward-a-fixed-64-scope-budget-and-fail-closed");
            return new { passed = true, checks = cases.Count, cases, architecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(), guiStarted = false, actualOsInput = false,
                boundary = "Actual filesystem, process-handle and NTFS-junction tests; not a WebView2 initialization, cookie or browser-retirement integration test." };
        } finally {
            if (junction != null && Directory.Exists(junction)) Directory.Delete(junction);
            if (Directory.Exists(home)) Directory.Delete(home, true);
        }
    }
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
