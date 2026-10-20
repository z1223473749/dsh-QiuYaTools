namespace QiuYaTools.Windows;

internal static class PreviewSelfTest
{
    internal static object Run()
    {
        var cases = new List<string>();
        void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException(name); cases.Add(name); }
        var rectangle = new Rectangle(10, 10, 20, 20);
        Check(BrowserWindow.IntersectsTrajectory(rectangle, [new(0, 0), new(40, 40)]), "diagonal-crossing-is-blocked");
        Check(BrowserWindow.IntersectsTrajectory(rectangle, [new(0, 40), new(40, 0)]), "reverse-diagonal-crossing-is-blocked");
        Check(!BrowserWindow.IntersectsTrajectory(new(0, 30, 5, 5), [new(0, 0), new(40, 40)]), "bounding-box-overlap-without-path-crossing-is-safe");
        Check(BrowserWindow.IntersectsTrajectory(rectangle, [new(20, 20)]), "inside-click-is-blocked");
        Check(!BrowserWindow.IntersectsTrajectory(rectangle, [new(50, 50)]), "outside-click-is-safe");
        Check(!BrowserWindow.IntersectsTrajectory(rectangle, []), "keyboard-actions-have-no-pointer-path");
        return new { passed = true, checks = cases.Count, cases, actualOsInput = false };
    }
}
