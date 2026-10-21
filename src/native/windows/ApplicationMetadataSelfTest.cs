using System.Text.Json;

namespace QiuYaTools.Windows;

internal static class ApplicationMetadataSelfTest
{
    internal static object Run()
    {
        var cases = new List<string>();
        void Check(bool valid, string name) { if (!valid) throw new InvalidOperationException(name); cases.Add(name); }
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
        foreach (var scale in new[] { .75f, 1f, 1.5f, 2f, 4f }) {
            var target = new Rectangle(-1800, -100, (int)(640 * scale), (int)(460 * scale));
            var placement = AiCursorOverlay.OperationBounds(target, scale);
            Check(placement.HasValue && target.Contains(placement.Value) && placement.Value.Top >= target.Top + 40 * scale && placement.Value.Right <= target.Right - 12 * scale,
                "operation-receipt-stays-below-title-controls-and-inside-negative-origin-target-" + scale);
        }
        Check(AiCursorOverlay.OperationBounds(new Rectangle(0, 0, 120, 60), 1) == null, "tiny-target-omits-optional-operation-receipt");
        return new { passed = true, checks = cases.Count, cases, guiStarted = false, actualOsInput = false, applicationLaunches = 0, settingsOpens = 0 };
    }
}
