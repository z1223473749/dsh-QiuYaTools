using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace QiuYaTools.Windows;

internal sealed class NativeApplicationCatalog
{
    internal sealed record Fingerprint(uint Volume, uint IndexHigh, uint IndexLow, uint SizeHigh, uint SizeLow, long Modified);
    internal sealed record Installation(string Path, string Name, Fingerprint Identity);
    internal delegate void PathSource(Func<bool> canRead, Action markTruncated, Action<string> accept);
    internal sealed record Sources(PathSource Running, PathSource Registered, Func<string, Installation> Metadata, Func<long> ElapsedMilliseconds,
        Func<Installation, string?>? Icon = null, Func<long>? IconElapsedMilliseconds = null, Func<long>? IconClockMilliseconds = null);
    internal sealed class IconCache
    {
        private sealed record Entry(Installation Installation, string? Icon, long Created);
        private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
        internal Dictionary<string, string> Complete(IReadOnlyDictionary<string, Installation> applications, Func<Installation, string?> read, Func<long> elapsed, long now)
        {
            lock (entries) {
                foreach (var id in entries.Keys.Where(id => !applications.ContainsKey(id)).ToArray()) entries.Remove(id);
                var result = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var (id, installation) in applications) {
                    if (entries.TryGetValue(id, out var entry) && entry.Installation.Path == installation.Path && entry.Installation.Identity == installation.Identity &&
                        now >= entry.Created && now - entry.Created < (entry.Icon == null ? 5000 : 60000)) {
                        if (entry.Icon != null) result[id] = entry.Icon;
                        continue;
                    }
                    // Cooperative icon-only budget. A synchronous system read
                    // is not preempted, but another read never starts after it.
                    if (elapsed() >= 500) continue;
                    string? icon = null;
                    try { icon = read(installation); }
                    catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException or
                        System.Security.SecurityException or System.ComponentModel.Win32Exception or ExternalException or NativeFailure) { }
                    if (entries.Count >= 512 && !entries.ContainsKey(id)) entries.Remove(entries.Keys.First());
                    entries[id] = new(installation, icon, now);
                    if (icon != null) result[id] = icon;
                }
                return result;
            }
        }
    }
    private readonly object gate = new();
    private readonly Sources? sourceOverrides;
    private Dictionary<string, Installation> listed = new(StringComparer.Ordinal);
    private readonly IconCache icons = new();
    internal NativeApplicationCatalog(Sources? sources = null) { sourceOverrides = sources; }
    internal static string AppId(string path)
    {
        var canonical = System.IO.Path.GetFullPath(path);
        // Match the established target identity, including existing persisted grants.
        return canonical.Length <= 512 ? canonical.ToLowerInvariant() : "winexe:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToUpperInvariant()))).ToLowerInvariant();
    }
    private static string DisplayName(string value) => new(value.Where(c => !char.IsControl(c)).Take(160).ToArray());
    internal static int IconPriority(bool running, string path, string windowsRoot)
    {
        if (running) return 0;
        var normalized = path.Replace('/', '\\');
        var root = windowsRoot.Replace('/', '\\').TrimEnd('\\') + "\\";
        var file = normalized.Split('\\').Last();
        if (file.Contains("helper", StringComparison.OrdinalIgnoreCase)) return 3;
        if (normalized.StartsWith(root + "SystemApps\\", StringComparison.OrdinalIgnoreCase)) return 2;
        return normalized.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? 3 : 1;
    }
    private static (SafeFileHandle Handle, Installation Installation) Pin(string path, bool launch)
    {
        path = System.IO.Path.GetFullPath(path);
        if (!System.IO.Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal) || !string.Equals(System.IO.Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase)) throw new NativeFailure("APPLICATION_NOT_LISTED", "Select a registered executable application");
        var handle = File.OpenHandle(path, FileMode.Open, FileAccess.Read, launch ? FileShare.Read : FileShare.ReadWrite | FileShare.Delete);
        try {
            var final = new StringBuilder(32768);
            var length = GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0);
            if (length == 0 || length >= final.Capacity || !GetFileInformationByHandle(handle, out var info) || (info.Attributes & (uint)(FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) throw new NativeFailure("APPLICATION_CHANGED", "The application identity cannot be verified");
            var actual = final.ToString(); if (actual.StartsWith(@"\\?\", StringComparison.Ordinal)) actual = actual[4..];
            if (!string.Equals(actual, path, StringComparison.OrdinalIgnoreCase)) throw new NativeFailure("APPLICATION_CHANGED", "The application path changed");
            var identity = new Fingerprint(info.VolumeSerial, info.IndexHigh, info.IndexLow, info.SizeHigh, info.SizeLow, ((long)info.Modified.High << 32) | info.Modified.Low);
            var description = FileVersionInfo.GetVersionInfo(path).FileDescription;
            var name = DisplayName(string.IsNullOrWhiteSpace(description) ? System.IO.Path.GetFileNameWithoutExtension(path) : description).Trim();
            if (name.Length == 0) name = "Application";
            return (handle, new Installation(path, name, identity));
        } catch { handle.Dispose(); throw; }
    }
    internal object Applications()
    {
        var found = new Dictionary<string, Installation>(StringComparer.Ordinal);
        var running = new HashSet<string>(StringComparer.Ordinal);
        var launchableIds = new HashSet<string>(StringComparer.Ordinal);
        var timer = Stopwatch.StartNew(); var truncated = false;
        var sources = sourceOverrides ?? new Sources(RunningVisibleWindows, RegisteredPaths, ReadMetadata, () => timer.ElapsedMilliseconds);
        bool CanRead(long limit, bool requireSpace = false)
        {
            if (sources.ElapsedMilliseconds() > limit || requireSpace && found.Count >= 512) { truncated = true; return false; }
            return true;
        }
        void Add(string path, bool isRunning, bool launchable)
        {
            try {
                var candidateId = AppId(path);
                if ((found.Count >= 512 && !found.ContainsKey(candidateId)) || !CanRead(isRunning ? 2500 : 3000)) { truncated = true; return; }
                var installation = sources.Metadata(path);
                var id = AppId(installation.Path);
                if (id != candidateId) throw new NativeFailure("APPLICATION_CHANGED", "The application path changed");
                if (isRunning) running.Add(id);
                // A running window is not an application registration. Only a
                // successful, identity-checked App Paths read permits Launch.
                if (launchable) launchableIds.Add(id);
                if (!found.ContainsKey(id) || launchable) found[id] = installation;
            } catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException or System.Security.SecurityException or System.ComponentModel.Win32Exception or NativeFailure) { }
        }
        // Reserve the first phase for the apps the user can actually operate.
        // Registration I/O must not consume their time or all 512 output slots.
        // These are cooperative budgets; a synchronous OS read is not preempted.
        sources.Running(() => CanRead(2500), () => truncated = true, path => Add(path, true, false));
        sources.Registered(() => CanRead(3000, true), () => truncated = true, path => Add(path, false, true));
        lock (gate) listed = found.Where(pair => launchableIds.Contains(pair.Key)).ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        // Discovery is complete before icon I/O begins. A missing or slow icon
        // must not reduce the searchable catalog or change launch capability.
        var windowsRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var iconOrder = found.OrderBy(pair => IconPriority(running.Contains(pair.Key), pair.Value.Path, windowsRoot))
            .ThenBy(pair => pair.Value.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        var iconTimer = Stopwatch.StartNew();
        var iconValues = icons.Complete(iconOrder, sourceOverrides == null ? ReadIcon : sources.Icon ?? (_ => null),
            sources.IconElapsedMilliseconds ?? (() => iconTimer.ElapsedMilliseconds), sources.IconClockMilliseconds?.Invoke() ?? Environment.TickCount64);
        return new { applications = found.OrderBy(pair => pair.Value.Name, StringComparer.CurrentCultureIgnoreCase).Select(pair => {
            var value = new Dictionary<string, object> { ["appId"] = pair.Key, ["name"] = pair.Value.Name, ["running"] = running.Contains(pair.Key), ["launchable"] = launchableIds.Contains(pair.Key) };
            if (iconValues.TryGetValue(pair.Key, out var icon)) value["iconDataUrl"] = icon;
            return value;
        }).ToArray(), truncated };
    }
    internal static string? PngDataURL(byte[] png)
    {
        if (png.Length < 33 || png.Length > 16 * 1024 || !png.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) ||
            !png.AsSpan(12, 4).SequenceEqual("IHDR"u8) || System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(16, 4)) != 32 ||
            System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(20, 4)) != 32) return null;
        return "data:image/png;base64," + Convert.ToBase64String(png);
    }
    private static string? ReadIcon(Installation expected)
    {
        // Hold the exact already-cataloged executable against replacement while
        // the OS extracts its icon. No arbitrary path or command is accepted.
        var current = Pin(expected.Path, true); using var file = current.Handle;
        if (current.Installation.Identity != expected.Identity || !string.Equals(current.Installation.Path, expected.Path, StringComparison.OrdinalIgnoreCase)) return null;
        using var icon = System.Drawing.Icon.ExtractAssociatedIcon(expected.Path);
        if (icon == null) return null;
        using var source = icon.ToBitmap();
        using var bitmap = new System.Drawing.Bitmap(32, 32, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var graphics = System.Drawing.Graphics.FromImage(bitmap)) {
            graphics.Clear(System.Drawing.Color.Transparent);
            graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            graphics.DrawImage(source, new System.Drawing.Rectangle(0, 0, 32, 32));
        }
        using var output = new MemoryStream(); bitmap.Save(output, System.Drawing.Imaging.ImageFormat.Png);
        return PngDataURL(output.ToArray());
    }
    private static Installation ReadMetadata(string path)
    {
        var pinned = Pin(path, false); using var handle = pinned.Handle;
        return pinned.Installation;
    }
    private static void RegisteredPaths(Func<bool> canRead, Action markTruncated, Action<string> accept)
    {
        // App Paths are explicit OS application registrations. Never scan the
        // user's home, shortcuts, command lines, Run keys or uninstall commands.
        foreach (var hive in new[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser }) {
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 }) {
                if (!canRead()) return;
                try {
                    using var root = RegistryKey.OpenBaseKey(hive, view);
                    using var paths = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths", false);
                    if (paths == null) continue;
                    var names = paths.GetSubKeyNames();
                    if (names.Length > 1024) markTruncated();
                    foreach (var name in names.Take(1024)) {
                        if (!canRead()) return;
                        using var key = paths.OpenSubKey(name, false);
                        if (key?.GetValue(null, null, RegistryValueOptions.DoNotExpandEnvironmentNames) is not string raw) continue;
                        var path = Environment.ExpandEnvironmentVariables(raw.Trim());
                        if (path.StartsWith('"') && path.EndsWith('"') && path.Length > 2) path = path[1..^1];
                        accept(path);
                    }
                } catch (Exception error) when (error is UnauthorizedAccessException or System.Security.SecurityException or IOException) { }
            }
        }
    }
    private static void RunningVisibleWindows(Func<bool> canRead, Action markTruncated, Action<string> accept)
    {
        var accepted = 0;
        Native.EnumWindows((handle, _) => {
            if (!canRead()) return false;
            try {
                // Match ComputerDriver.Targets instead of MainWindowHandle:
                // a process may own an eligible secondary or tool window.
                if (!Native.IsWindowVisible(handle) || Native.IsIconic(handle)) return true;
                Native.GetWindowThreadProcessId(handle, out var pid);
                if (pid == 0 || pid == Environment.ProcessId) return true;
                var title = new StringBuilder(1025); Native.GetWindowText(handle, title, title.Capacity);
                if (string.IsNullOrWhiteSpace(title.ToString()) || !Native.GetWindowRect(handle, out var rect) || rect.Width < 16 || rect.Height < 16) return true;
                using var process = Process.GetProcessById((int)pid);
                var born = process.StartTime.ToUniversalTime().Ticks;
                if (process.HasExited || process.MainModule?.FileName is not string path || process.StartTime.ToUniversalTime().Ticks != born) return true;
                Native.GetWindowThreadProcessId(handle, out var currentPid);
                if (currentPid != pid || !Native.IsWindowVisible(handle) || Native.IsIconic(handle)) return true;
                accept(Path.GetFullPath(path));
                accepted++;
                if (accepted >= 256) { markTruncated(); return false; }
            } catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { }
            return canRead();
        }, IntPtr.Zero);
    }
    internal object Launch(string appId)
    {
        Installation? expected; lock (gate) listed.TryGetValue(appId, out expected);
        if (expected == null) throw new NativeFailure("APPLICATION_NOT_LISTED", "Refresh applications and select a registered launchable application");
        try {
            var current = Pin(expected.Path, true); using var handle = current.Handle;
            if (current.Installation.Identity != expected.Identity || AppId(current.Installation.Path) != appId) throw new NativeFailure("APPLICATION_CHANGED", "The selected application changed; refresh applications");
            using var process = Process.Start(new ProcessStartInfo { FileName = expected.Path, UseShellExecute = true, Arguments = "", WindowStyle = ProcessWindowStyle.Normal });
            if (process == null) throw new NativeFailure("APPLICATION_LAUNCH_FAILED", "The selected application could not be opened");
            return new { launched = true, appId };
        } catch (NativeFailure) { throw; }
        catch { throw new NativeFailure("APPLICATION_LAUNCH_FAILED", "The selected application could not be opened"); }
    }
    internal static object OpenSystemSettings(string kind)
    {
        if (kind is not ("screenRecording" or "accessibility" or "inputMonitoring")) throw new NativeFailure("INVALID_PERMISSION_KIND", "Select a supported system permission");
        // Windows does not expose these macOS TCC permissions. Do not open an
        // unrelated Settings page or claim an elevated/secure desktop is usable.
        return new { opened = false, supported = false, kind };
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileTime { internal uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation {
        internal uint Attributes; internal FileTime Created, Accessed, Modified; internal uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint count, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
}
