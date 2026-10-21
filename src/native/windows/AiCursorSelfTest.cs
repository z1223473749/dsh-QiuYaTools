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
            Check(a == first.Store("same-session") && Path.GetFileName(a) == "s00" && Path.GetFileName(b) == "s00",
                "same-helper-chat-reopen-retains-its-stable-helper-private-slot");
            var unsafeIdentity = first.Store("../\\unsafe\0会话");
            Check(Path.GetFileName(unsafeIdentity) == "s01" && a.Length < 64 && unsafeIdentity != a && Path.GetDirectoryName(unsafeIdentity) == Path.GetDirectoryName(a),
                "raw-unsafe-session-identities-only-select-short-slots-inside-their-own-guid-scope");
            static string Digest(string value) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value)));
            const string collisionA = "prefix-collision-241", collisionB = "prefix-collision-256";
            Check(Digest(collisionA)[..4] == Digest(collisionB)[..4] && Digest(collisionA) != Digest(collisionB) && first.Store(collisionA) != first.Store(collisionB),
                "sha256-prefix-collisions-do-not-alias-full-dictionary-keys-or-slots");
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
                var slots = new List<string>();
                for (var index = 0; index < PreviewDataScope.SessionLimit; index++) slots.Add(bounded.Store("session-" + index));
                Check(slots.Distinct(StringComparer.Ordinal).Count() == PreviewDataScope.SessionLimit && Path.GetFileName(slots[0]) == "s00" && Path.GetFileName(slots[^1]) == "s1f",
                    "all-32-helper-private-slots-are-distinct-through-the-last-hex-slot");
                var rejected = false; try { bounded.Store("one-too-many"); } catch (NativeFailure error) when (error.Code == "preview-cache-full") { rejected = true; }
                Check(rejected, "one-helper-has-a-fixed-32-session-directory-budget");
                Check(bounded.Store("session-0") == slots[0] && bounded.Store("session-31") == slots[^1],
                    "full-budget-and-rejected-new-chat-never-reassign-existing-chat-slots");
            }
            var maximumRoot = PreviewDataScope.MaximumUdfLength - (1 + PreviewDataScope.Prefix.Length + 32 + 1 + 3);
            var budgetRoot = Path.Combine(home, new string('p', maximumRoot - home.Length - 1));
            using (var boundary = new PreviewDataScope(budgetRoot)) {
                var path = Path.Combine(budgetRoot, boundary.Store("at-the-absolute-budget"));
                Check(budgetRoot.Length == maximumRoot && path.Length == PreviewDataScope.MaximumUdfLength,
                    "maximum-absolute-udf-budget-is-accepted-with-a-full-guid-and-short-slot");
            }
            var tooLong = budgetRoot + "x"; var clock = System.Diagnostics.Stopwatch.StartNew(); var pathRejected = false;
            try { using var excessPath = new PreviewDataScope(tooLong); } catch (NativeFailure error) when (error.Code == "preview-data-path-too-long") { pathRejected = true; }
            Check(pathRejected && !Directory.Exists(tooLong) && clock.ElapsedMilliseconds < 2000,
                "one-character-overlong-root-fails-before-cache-creation-or-browser-start");
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
        foreach (var scale in new[] { 1f, 2f }) {
            using (var bitmap = AiCursorOverlay.DrawPointer(scale, new Rectangle(0, 0, 200, 200), Point.Empty)) {
                var left = bitmap.Width; var top = bitmap.Height; var right = -1; var bottom = -1; var white = 0;
                for (var y = 0; y < bitmap.Height; y++) for (var x = 0; x < bitmap.Width; x++) {
                    var pixel = bitmap.GetPixel(x, y);
                    if (pixel.A >= 180) { left = Math.Min(left, x); top = Math.Min(top, y); right = Math.Max(right, x); bottom = Math.Max(bottom, y); }
                    if (pixel.A >= 180 && pixel.R > 235 && pixel.G > 235 && pixel.B > 235) white++;
                }
                Check(right - left + 1 >= 13 * scale && right - left + 1 <= 18 * scale && bottom - top + 1 >= 14 * scale && bottom - top + 1 <= 20 * scale && white >= 10 * scale * scale,
                    $"approved-small-rounded-contour-and-thin-white-outline-at-{scale}x");
                var body = bitmap.GetPixel((int)((AiCursorOverlay.HotspotX + 4) * scale), (int)((AiCursorOverlay.HotspotY + 5) * scale));
                Check(body.A >= 115 && body.A < 170 && body.R >= 130 && body.R <= 160 && body.G >= 135 && body.G <= 165 && body.B >= 140 && body.B <= 170,
                    $"approved-gray-body-remains-translucent-at-{scale}x");
                var glow = bitmap.GetPixel((int)((AiCursorOverlay.HotspotX - 4) * scale), (int)((AiCursorOverlay.HotspotY + 5) * scale));
                Check(glow.A > 0 && glow.A < 70 && glow.R >= 50 && glow.R <= 120 && glow.G >= 50 && glow.G <= 120 && glow.B >= 50 && glow.B <= 120,
                    $"soft-gray-silhouette-glow-outside-the-glyph-at-{scale}x");
                Check(bitmap.GetPixel((int)(26 * scale), (int)(40 * scale)).A < 6 && bitmap.GetPixel(0, 0).A == 0 && bitmap.GetPixel(bitmap.Width - 1, bitmap.Height - 1).A == 0,
                    $"no-traditional-long-tail-and-transparent-outsets-at-{scale}x");
                var hotspot = bitmap.GetPixel((int)(AiCursorOverlay.HotspotX * scale), (int)(AiCursorOverlay.HotspotY * scale));
                Check(hotspot.A >= 100, $"shared-svg-2-3-hotspot-lies-on-rounded-tip-at-{scale}x");
            }
            var clipTarget = new Rectangle(100, 100, 12, 12); var location = new Point(100 - (int)(AiCursorOverlay.HotspotX * scale), 100 - (int)(AiCursorOverlay.HotspotY * scale));
            using var clipped = AiCursorOverlay.DrawPointer(scale, clipTarget, location);
            var outside = 0; var inside = 0;
            for (var y = 0; y < clipped.Height; y++) for (var x = 0; x < clipped.Width; x++) if (clipped.GetPixel(x, y).A != 0) {
                if (!clipTarget.Contains(x + location.X, y + location.Y)) outside++; else inside++;
            }
            Check(outside == 0 && inside > 20, $"pointer-and-glow-are-actually-clipped-at-the-controlled-target-edge-at-{scale}x");
        }
        return new { passed = true, checks = cases.Count, cases, architecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(), actualOsInput = false, guiStarted = false, systemCursorChanged = false,
            boundary = "State and bitmap tests do not prove HWND click-through, DWM capture exclusion, focus behavior or visual quality on a live desktop." };
    }
}
