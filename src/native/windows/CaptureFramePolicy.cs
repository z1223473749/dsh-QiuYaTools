namespace QiuYaTools.Windows;

internal static class CaptureFramePolicy
{
    // A uniform PrintWindow surface is ambiguous, so try a verified visible-desktop capture.
    // The fallback may legitimately be uniform too; no arbitrary refresh clicks are issued.
    internal static bool Uniform(int width, int height, Func<int, int, int> rgb)
    {
        var first = rgb(width / 2, height / 2);
        for (var y = 0; y < 7; y++) for (var x = 0; x < 7; x++)
            if (rgb((width - 1) * x / 6, (height - 1) * y / 6) != first) return false;
        return true;
    }
}
