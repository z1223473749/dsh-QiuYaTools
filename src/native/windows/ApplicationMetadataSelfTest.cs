using System.Text.Json;

namespace QiuYaTools.Windows;

internal static class ApplicationMetadataSelfTest
{
    private sealed class CatalogFixture
    {
        internal readonly List<string> Running = new(), Registered = new();
        internal readonly HashSet<string> RejectedMetadata = new(StringComparer.Ordinal);
        internal long Elapsed, RunningReadCost, RegisteredReadCost;
        internal int MetadataReads;
        internal NativeApplicationCatalog Catalog()
        {
            void Paths(IEnumerable<string> paths, bool registered, Func<bool> canRead, Action<string> accept)
            {
                foreach (var path in paths) {
                    if (!canRead()) return;
                    Elapsed += registered ? RegisteredReadCost : RunningReadCost;
                    accept(path);
                }
            }
            return new NativeApplicationCatalog(new NativeApplicationCatalog.Sources(
                (canRead, _, accept) => Paths(Running, false, canRead, accept),
                (canRead, _, accept) => Paths(Registered, true, canRead, accept),
                path => {
                    MetadataReads++;
                    if (RejectedMetadata.Contains(path)) throw new IOException("Synthetic metadata unavailable");
                    return new NativeApplicationCatalog.Installation(Path.GetFullPath(path), Path.GetFileNameWithoutExtension(path), new(1, 0, 1, 0, 1, 1));
                }, () => Elapsed));
        }
        internal static string PathFor(string name) => Path.Combine(Path.GetTempPath(), "qyt-application-catalog-selftest", name + ".exe");
        internal static JsonElement Read(NativeApplicationCatalog catalog) => JsonSerializer.SerializeToElement(catalog.Applications(), Program.Json);
        internal static JsonElement[] Applications(JsonElement result) => result.GetProperty("applications").EnumerateArray().ToArray();
        internal static JsonElement? Find(JsonElement result, string path) => Applications(result).Where(row => row.GetProperty("appId").GetString() == NativeApplicationCatalog.AppId(path)).Select(row => (JsonElement?)row).FirstOrDefault();
    }
    internal static object Run()
    {
        var cases = new List<string>();
        var failures = new List<string>();
        void Check(bool valid, string name) { if (!valid) failures.Add(name); else cases.Add(name); }
        foreach (var kind in new[] { "screenRecording", "accessibility", "inputMonitoring" }) {
            var response = JsonSerializer.SerializeToElement(NativeApplicationCatalog.OpenSystemSettings(kind), Program.Json);
            Check(!response.GetProperty("opened").GetBoolean() && !response.GetProperty("supported").GetBoolean() && response.GetProperty("kind").GetString() == kind,
                "macos-tcc-kind-is-explicitly-unsupported-without-opening-windows-settings-" + kind);
        }
        foreach (var input in new[] { "", "file:///tmp/x", "https://example.com", "accessibility&url=x", "screenRecording\n" }) {
            var rejected = false;
            try { _ = NativeApplicationCatalog.OpenSystemSettings(input); } catch (NativeFailure error) when (error.Code == "INVALID_PERMISSION_KIND") { rejected = true; }
            Check(rejected, "arbitrary-settings-kind-rejected-" + cases.Count);
        }
        var catalog = new NativeApplicationCatalog();
        foreach (var input in new[] { "", "..\\unlisted.exe", "cmd.exe /c anything", "https://example.com" }) {
            var rejected = false;
            try { _ = catalog.Launch(input); } catch (NativeFailure error) when (error.Code == "APPLICATION_NOT_LISTED") { rejected = true; }
            Check(rejected, "unlisted-launch-never-reaches-process-start-" + cases.Count);
        }
        string ownIcon;
        using (var bitmap = new System.Drawing.Bitmap(32, 32, System.Drawing.Imaging.PixelFormat.Format32bppArgb)) {
            using (var graphics = System.Drawing.Graphics.FromImage(bitmap)) graphics.Clear(System.Drawing.Color.Teal);
            using var png = new MemoryStream(); bitmap.Save(png, System.Drawing.Imaging.ImageFormat.Png);
            ownIcon = NativeApplicationCatalog.PngDataURL(png.ToArray()) ?? throw new InvalidOperationException("Own icon PNG could not be encoded");
            Check(ownIcon.StartsWith("data:image/png;base64,", StringComparison.Ordinal) && png.Length <= 16 * 1024, "application-icon-is-fixed-32-png-with-bounded-data-only");
            var wrongSize = png.ToArray(); wrongSize[19] = 64;
            Check(NativeApplicationCatalog.PngDataURL(wrongSize) == null, "application-icon-rejects-non-32-pixel-png");
            var wrongSignature = png.ToArray(); wrongSignature[0] = 0;
            Check(NativeApplicationCatalog.PngDataURL(wrongSignature) == null && NativeApplicationCatalog.PngDataURL(new byte[16 * 1024 + 1]) == null,
                "application-icon-rejects-invalid-signature-and-over-16k-png");
        }
        {
            var path = CatalogFixture.PathFor("cached-icon"); var installation = new NativeApplicationCatalog.Installation(path, "Cached", new(1, 0, 1, 0, 1, 1));
            var apps = new Dictionary<string, NativeApplicationCatalog.Installation> { ["own"] = installation };
            var cache = new NativeApplicationCatalog.IconCache(); var reads = 0;
            string? Read(NativeApplicationCatalog.Installation _) { reads++; return ownIcon; }
            var first = cache.Complete(apps, Read, () => 0, 1000);
            var second = cache.Complete(apps, Read, () => 500, 2500);
            Check(reads == 1 && first["own"] == ownIcon && second["own"] == ownIcon, "application-icon-cache-avoids-reextracting-and-serves-cached-icons-after-budget");
            apps["own"] = installation with { Identity = new(1, 0, 2, 0, 1, 1) };
            _ = cache.Complete(apps, Read, () => 0, 2600);
            Check(reads == 2, "application-installation-identity-change-invalidates-icon-cache");
            _ = cache.Complete(apps, Read, () => 0, 62600);
            Check(reads == 3, "application-icon-cache-expires-after-sixty-seconds");
            _ = cache.Complete(new Dictionary<string, NativeApplicationCatalog.Installation>(), Read, () => 0, 63000);
            _ = cache.Complete(apps, Read, () => 0, 64000);
            Check(reads == 4, "application-removed-from-catalog-retires-its-cached-icon");
        }
        {
            var path = CatalogFixture.PathFor("negative-icon");
            var apps = new Dictionary<string, NativeApplicationCatalog.Installation> { ["own"] = new(path, "Own", new(1, 0, 1, 0, 1, 1)) };
            var cache = new NativeApplicationCatalog.IconCache(); var reads = 0;
            string? Read(NativeApplicationCatalog.Installation _) { reads++; throw new IOException("Own icon unavailable"); }
            var first = cache.Complete(apps, Read, () => 0, 1000); _ = cache.Complete(apps, Read, () => 0, 2500);
            Check(first.Count == 0 && reads == 1, "application-icon-failure-is-contained-and-negatively-cached");
            _ = cache.Complete(apps, Read, () => 0, 6000);
            Check(reads == 2, "application-icon-negative-cache-retries-after-five-seconds");
        }
        {
            var a = CatalogFixture.PathFor("icon-budget-a"); var b = CatalogFixture.PathFor("icon-budget-b");
            var metadataReads = 0; var iconReads = 0; var iconElapsed = 0L;
            var sources = new NativeApplicationCatalog.Sources(
                (canRead, _, accept) => { if (canRead()) accept(a); if (canRead()) accept(b); },
                (_, _, _) => { },
                path => { metadataReads++; return new(path, Path.GetFileNameWithoutExtension(path), new(1, 0, (uint)metadataReads, 0, 1, 1)); }, () => 0,
                _ => { Check(metadataReads == 2, "all-application-metadata-is-discovered-before-icon-io"); iconReads++; iconElapsed = 501; return ownIcon; },
                () => iconElapsed, () => 1000);
            var result = CatalogFixture.Read(new NativeApplicationCatalog(sources)); var rows = CatalogFixture.Applications(result);
            Check(rows.Length == 2 && iconReads == 1 && rows.Count(row => row.TryGetProperty("iconDataUrl", out _)) == 1 && !result.GetProperty("truncated").GetBoolean(),
                "icon-budget-keeps-all-applications-and-never-starts-a-second-read-after-five-hundred-ms");
            Check(rows.All(row => row.GetProperty("running").GetBoolean() && !row.GetProperty("launchable").GetBoolean()), "icon-enrichment-does-not-acquire-launch-or-control-capability");
        }
        Check(NativeApplicationCatalog.IconPriority(true, @"C:\Windows\System32\OwnHelper.exe", @"C:\Windows") == 0,
            "running-application-icons-precede-registered-apps-and-helpers");
        Check(NativeApplicationCatalog.IconPriority(false, @"C:\Program Files\Own\Own.exe", @"C:\Windows") == 1 &&
            NativeApplicationCatalog.IconPriority(false, @"C:\Users\Own\AppData\Local\Own\Own.exe", @"C:\Windows") == 1,
            "common-and-per-user-application-icons-precede-system-apps");
        Check(NativeApplicationCatalog.IconPriority(false, @"C:\Windows\SystemApps\Own\Own.exe", @"C:\Windows") == 2 &&
            NativeApplicationCatalog.IconPriority(false, @"C:\Windows\System32\Own.exe", @"C:\Windows") == 3 &&
            NativeApplicationCatalog.IconPriority(false, @"C:\Program Files\Own\OwnHelper.exe", @"C:\Windows") == 3,
            "system-application-icons-precede-inactive-service-helpers");
        Check(NativeApplicationCatalog.IconPriority(false, @"c:\WINDOWSother\Own.exe", @"C:\Windows") == 1 &&
            NativeApplicationCatalog.IconPriority(false, @"c:/WINDOWS/SystemApps/Own/Own.exe", @"C:\Windows") == 2,
            "icon-priority-matches-windows-case-and-directory-boundaries");
        {
            var applicationRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "qyt-icon-priority-selftest");
            var normal = Path.Combine(applicationRoot, "z-normal-application.exe"); var helper = Path.Combine(applicationRoot, "a-OwnHelper.exe");
            var system = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "SystemApps", "b-system.exe");
            var elapsed = 0L; var loaded = new List<string>();
            var sources = new NativeApplicationCatalog.Sources(
                (_, _, _) => { },
                (canRead, _, accept) => { foreach (var path in new[] { helper, system, normal }) if (canRead()) accept(path); },
                path => new(path, Path.GetFileNameWithoutExtension(path), new(1, 0, 1, 0, 1, 1)), () => 0,
                value => { loaded.Add(value.Path); elapsed = 501; return ownIcon; }, () => elapsed, () => 1000);
            var rows = CatalogFixture.Applications(CatalogFixture.Read(new NativeApplicationCatalog(sources)));
            Check(loaded.SequenceEqual(new[] { normal }) && rows.Single(row => row.GetProperty("appId").GetString() == NativeApplicationCatalog.AppId(normal)).TryGetProperty("iconDataUrl", out _),
                "bounded-icon-phase-loads-a-common-app-before-alphabetically-earlier-system-helpers");
            Check(rows.Select(row => row.GetProperty("name").GetString()).SequenceEqual(new[] { "a-OwnHelper", "b-system", "z-normal-application" }),
                "icon-enrichment-priority-does-not-reorder-the-visible-application-catalog");
        }
        {
            var f = new CatalogFixture(); var own = CatalogFixture.PathFor("running-only"); f.Running.Add(own);
            f.Registered.AddRange(Enumerable.Range(0, 512).Select(index => CatalogFixture.PathFor("registered-" + index)));
            var result = CatalogFixture.Read(f.Catalog()); var row = CatalogFixture.Find(result, own);
            Check(row.HasValue && row.Value.GetProperty("running").GetBoolean() && !row.Value.GetProperty("launchable").GetBoolean(), "registered-capacity-cannot-starve-running-window-application");
            Check(CatalogFixture.Applications(result).Length == 512 && result.GetProperty("truncated").GetBoolean(), "running-priority-retains-512-output-limit-and-truncation");
        }
        {
            var f = new CatalogFixture { RegisteredReadCost = 3201 }; var own = CatalogFixture.PathFor("cold-registration-running");
            f.Running.Add(own); f.Registered.Add(CatalogFixture.PathFor("cold-registration"));
            var result = CatalogFixture.Read(f.Catalog()); var row = CatalogFixture.Find(result, own);
            Check(row.HasValue && row.Value.GetProperty("running").GetBoolean(), "slow-registration-crossing-total-budget-cannot-starve-running-application");
            Check(result.GetProperty("truncated").GetBoolean(), "slow-registration-reports-cooperative-budget-truncation");
        }
        {
            var f = new CatalogFixture(); var own = CatalogFixture.PathFor("registered-and-running");
            f.Running.AddRange(new[] { own, own }); f.Registered.Add(own);
            var result = CatalogFixture.Read(f.Catalog()); var rows = CatalogFixture.Applications(result);
            Check(rows.Length == 1 && rows[0].GetProperty("running").GetBoolean() && rows[0].GetProperty("launchable").GetBoolean(), "running-and-registered-same-app-merge-with-both-flags");
        }
        {
            var f = new CatalogFixture(); var own = CatalogFixture.PathFor("never-registered"); f.Running.Add(own);
            var ownCatalog = f.Catalog(); var result = CatalogFixture.Read(ownCatalog); var row = CatalogFixture.Find(result, own);
            Check(row.HasValue && !row.Value.GetProperty("launchable").GetBoolean(), "running-only-source-does-not-acquire-launch-capability");
            var rejected = false;
            try { _ = ownCatalog.Launch(NativeApplicationCatalog.AppId(own)); } catch (NativeFailure error) when (error.Code == "APPLICATION_NOT_LISTED") { rejected = true; }
            Check(rejected, "running-only-launch-rejected-before-file-pin-or-process-start");
        }
        {
            var f = new CatalogFixture(); var own = CatalogFixture.PathFor("running-with-rejected-registration");
            f.Running.Add(own); f.Registered.Add(own);
            var reads = 0;
            var sources = new NativeApplicationCatalog.Sources(
                (canRead, _, accept) => { if (canRead()) accept(own); },
                (canRead, _, accept) => { if (canRead()) { f.RejectedMetadata.Add(own); accept(own); } },
                path => { reads++; if (f.RejectedMetadata.Contains(path)) throw new IOException("Synthetic registration metadata changed"); return new(path, "Own running app", new(1, 0, 1, 0, 1, 1)); }, () => f.Elapsed);
            var result = CatalogFixture.Read(new NativeApplicationCatalog(sources)); var row = CatalogFixture.Find(result, own);
            Check(reads == 2 && row.HasValue && row.Value.GetProperty("running").GetBoolean() && !row.Value.GetProperty("launchable").GetBoolean(), "failed-registered-metadata-cannot-upgrade-running-launch-capability");
        }
        {
            var f = new CatalogFixture { Elapsed = 3001 }; f.Running.Add(CatalogFixture.PathFor("expired-running")); f.Registered.Add(CatalogFixture.PathFor("expired-registration"));
            var result = CatalogFixture.Read(f.Catalog());
            Check(f.MetadataReads == 0 && CatalogFixture.Applications(result).Length == 0 && result.GetProperty("truncated").GetBoolean(), "expired-budget-never-starts-metadata-read");
        }
        {
            var f = new CatalogFixture { RunningReadCost = 2501 }; var running = CatalogFixture.PathFor("late-running-path"); var registered = CatalogFixture.PathFor("remaining-registration-budget");
            f.Running.Add(running); f.Registered.Add(registered);
            var result = CatalogFixture.Read(f.Catalog()); var row = CatalogFixture.Find(result, registered);
            Check(f.MetadataReads == 1 && !CatalogFixture.Find(result, running).HasValue && row.HasValue && row.Value.GetProperty("launchable").GetBoolean() && result.GetProperty("truncated").GetBoolean(), "running-path-read-crossing-phase-budget-cannot-start-metadata-or-block-registration-remainder");
        }
        {
            var f = new CatalogFixture(); var own = CatalogFixture.PathFor("registration-retired"); f.Running.Add(own); f.Registered.Add(own);
            var ownCatalog = f.Catalog(); _ = CatalogFixture.Read(ownCatalog); f.Registered.Clear(); _ = CatalogFixture.Read(ownCatalog);
            var rejected = false;
            try { _ = ownCatalog.Launch(NativeApplicationCatalog.AppId(own)); } catch (NativeFailure error) when (error.Code == "APPLICATION_NOT_LISTED") { rejected = true; }
            Check(rejected, "refresh-without-registered-source-retires-old-launch-capability");
        }
        {
            var requested = CatalogFixture.PathFor("requested-identity"); var different = CatalogFixture.PathFor("different-identity");
            var sources = new NativeApplicationCatalog.Sources(
                (canRead, _, accept) => { if (canRead()) accept(requested); },
                (canRead, _, accept) => { if (canRead()) accept(requested); },
                _ => new(different, "Wrong identity", new(1, 0, 2, 0, 1, 1)), () => 0);
            var ownCatalog = new NativeApplicationCatalog(sources); var result = CatalogFixture.Read(ownCatalog); var rejected = false;
            try { _ = ownCatalog.Launch(NativeApplicationCatalog.AppId(different)); } catch (NativeFailure error) when (error.Code == "APPLICATION_NOT_LISTED") { rejected = true; }
            Check(CatalogFixture.Applications(result).Length == 0 && rejected, "changed-metadata-path-cannot-enter-results-or-launch-list");
        }
        foreach (var scale in new[] { .75f, 1f, 1.5f, 2f, 4f }) {
            var target = new Rectangle(-1800, -100, (int)(640 * scale), (int)(460 * scale));
            var placement = AiCursorOverlay.OperationBounds(target, scale);
            Check(placement.HasValue && target.Contains(placement.Value) && placement.Value.Top >= target.Top + 40 * scale && placement.Value.Right <= target.Right - 12 * scale,
                "operation-receipt-stays-below-title-controls-and-inside-negative-origin-target-" + scale);
        }
        Check(AiCursorOverlay.OperationBounds(new Rectangle(0, 0, 120, 60), 1) == null, "tiny-target-omits-optional-operation-receipt");
        if (failures.Count != 0) throw new InvalidOperationException("Application metadata self-test failed: " + string.Join("; ", failures));
        return new { passed = true, checks = cases.Count, cases, guiStarted = false, actualOsInput = false, applicationLaunches = 0, settingsOpens = 0 };
    }
}
