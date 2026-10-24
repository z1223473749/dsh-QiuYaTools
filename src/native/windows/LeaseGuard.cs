using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace QiuYaTools.Windows;

/// One input owner per interactive desktop, including different profiles and paired agents.
/// The write-ahead journal survives process death; acquiring its lock always recovers it first.
internal sealed class DesktopLeaseGuard : IDisposable
{
    private sealed record Journal(int Version, string OwnerId, ushort[] Keys, uint[] MouseButtons, ushort[] UnicodeUnits);
    private readonly string directory;
    private readonly string lockPath;
    private readonly string journalPath;
    private FileStream? lease;
    private Process? guardian;
    private string? lastRecord;
    internal string? OwnerId { get; private set; }

    internal DesktopLeaseGuard()
    {
        var desktop = new StringBuilder(512);
        if (!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 2, desktop, desktop.Capacity * 2, out _))
            throw new NativeFailure("desktop-unavailable", "The interactive desktop identity is unavailable");
        var identity = $"{Process.GetCurrentProcess().SessionId}:{desktop}";
        var scope = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))[..24];
        directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QiuYaTools", "computer-lease", scope);
        Directory.CreateDirectory(directory);
        lockPath = Path.Combine(directory, "desktop.lock");
        journalPath = Path.Combine(directory, "owned-input.json");
    }

    internal void Acquire()
    {
        if (lease != null) throw new NativeFailure("desktop-busy", "This companion already owns an input lease");
        lease = OpenLock();
        try {
            RecoverJournal(null);
            OwnerId = Guid.NewGuid().ToString("N");
            Record([], [], []);
            StartGuardian();
        } catch { lease.Dispose(); lease = null; OwnerId = null; throw; }
    }

    private FileStream OpenLock()
    {
        try { return new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { throw new NativeFailure("desktop-busy", "Another QiuYaTools companion owns this desktop; pause it before taking control"); }
    }

    internal void Record(IEnumerable<ushort> keys, IEnumerable<uint> mouseButtons, IEnumerable<ushort> unicodeUnits)
    {
        if (lease == null || OwnerId == null) throw new NativeFailure("desktop-lease-required", "No desktop input lease is held");
        var record = new Journal(1, OwnerId, keys.Distinct().Order().ToArray(), mouseButtons.Distinct().Order().ToArray(), unicodeUnits.Distinct().Order().ToArray());
        var json = JsonSerializer.Serialize(record);
        if (json == lastRecord) return;
        WriteJournal(json);
        lastRecord = json;
    }

    private void WriteJournal(string json)
    {
        var temporary = Path.Combine(directory, $"journal-{Environment.ProcessId}-{Guid.NewGuid():N}.tmp");
        try {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                var bytes = Encoding.UTF8.GetBytes(json); stream.Write(bytes); stream.Flush(true);
            }
            AtomicJournalPublish.Publish(temporary, journalPath);
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException) {
            throw new NativeFailure("input-journal-failed", "Owned input could not be durably recorded; no further input is allowed");
        } finally { try { File.Delete(temporary); } catch (IOException) { } }
    }

    private Journal? ReadJournal()
    {
        // An obsolete owner's readonly probe must not block the current owner's atomic replacement.
        using var stream = new FileStream(journalPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (stream.Length > 1_048_576) throw new JsonException();
        return JsonSerializer.Deserialize<Journal>(stream);
    }

    private void RecoverJournal(string? expectedOwner)
    {
        if (!File.Exists(journalPath)) return;
        Journal? journal;
        try {
            journal = ReadJournal();
            if (journal is not { Version: 1 } || !Guid.TryParseExact(journal.OwnerId, "N", out _) || journal.Keys == null || journal.Keys.Length > 32 || journal.Keys.Any(key => key > 255)
                || journal.MouseButtons == null || journal.MouseButtons.Length > 3 || journal.MouseButtons.Any(button => button is not (0x0004 or 0x0010 or 0x0040))
                || journal.UnicodeUnits == null || journal.UnicodeUnits.Length > 65_536) throw new JsonException();
        } catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException) {
            throw new NativeFailure("input-journal-invalid", "The previous owner's input journal cannot be read safely; control remains blocked");
        }
        if (expectedOwner != null && !string.Equals(journal.OwnerId, expectedOwner, StringComparison.Ordinal)) return;
        var inputs = journal.Keys.Select(key => Native.Keyboard(key, 0, 0x0002))
            .Concat(journal.UnicodeUnits.Select(unit => Native.Keyboard(0, unit, 0x0004 | 0x0002)))
            .Concat(journal.MouseButtons.Select(button => Native.Mouse(button))).ToArray();
        foreach (var input in inputs) {
            if (Native.SendInput(1, [input], Marshal.SizeOf<Native.INPUT>()) != 1)
                throw new NativeFailure("input-cleanup-failed", "Windows did not confirm recovery of the previous owner's input; control remains blocked");
        }
        File.Delete(journalPath);
    }

    // Read-only proof used between clean release and a sibling ASFW handoff.
    // It neither recovers a journal nor injects releases. Hold it through ASFW.
    internal IDisposable RequireIdleAndJournalAbsent()
    {
        if (lease != null || OwnerId != null) throw new NativeFailure("desktop-busy", "Foreground handoff requires a released desktop lease");
        var proof = OpenLock();
        try {
            if (File.Exists(journalPath)) throw new NativeFailure("foreground-journal-present", "Foreground handoff requires an empty input journal");
            return proof;
        } catch { proof.Dispose(); throw; }
    }

    internal void Release()
    {
        if (lease == null) return;
        // This is called only after ComputerDriver confirmed all its owned key/button releases.
        try { File.Delete(journalPath); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new NativeFailure("input-journal-failed", "The owned input journal could not be cleared; control remains blocked"); }
        lastRecord = null; OwnerId = null;
        lease.Dispose(); lease = null;
    }

    private void StartGuardian()
    {
        if (guardian is { HasExited: false }) return;
        guardian?.Dispose();
        var executable = Environment.ProcessPath ?? throw new NativeFailure("guardian-unavailable", "The companion executable path is unavailable");
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add("--input-guardian");
        guardian = Process.Start(start) ?? throw new NativeFailure("guardian-unavailable", "The input guardian could not be started");
        guardian.BeginOutputReadLine(); guardian.BeginErrorReadLine();
    }

    internal static void RunGuardian()
    {
        Console.In.ReadToEnd();
        try {
            using var guard = new DesktopLeaseGuard();
            guard.lease = guard.OpenLock();
            guard.RecoverJournal(null);
        } catch (NativeFailure failure) when (failure.Code == "desktop-busy") { /* A new owner already recovered the journal under the same lock. */ }
        catch { Environment.ExitCode = 1; }
    }

    internal static void RecoverOwner(string ownerId)
    {
        if (!Guid.TryParseExact(ownerId, "N", out _)) throw new NativeFailure("invalid-input-state", "Invalid owned input identity");
        using var guard = new DesktopLeaseGuard();
        try { guard.lease = guard.OpenLock(); }
        catch (NativeFailure failure) when (failure.Code == "desktop-busy") {
            // An old Host cleanup must never send key-ups into a newer lease. Atomic
            // journals can be read without the lock solely to establish a different owner.
            try {
                var journal = guard.ReadJournal();
                if (journal is { Version: 1 } && Guid.TryParseExact(journal.OwnerId, "N", out _) && !string.Equals(journal.OwnerId, ownerId, StringComparison.Ordinal)) return;
            } catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { }
            throw;
        }
        guard.RecoverJournal(ownerId);
    }

    public void Dispose()
    {
        // An uncertain journal is intentionally retained. The independent guardian/new owner
        // must recover it before a subsequent lease can inject input.
        lease?.Dispose(); lease = null; OwnerId = null;
        if (guardian != null) { try { guardian.StandardInput.Close(); } catch (IOException) { } guardian.Dispose(); guardian = null; }
    }

    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder information, int length, out int needed);
}
