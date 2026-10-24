using System.Diagnostics;
using System.Globalization;

namespace QiuYaTools.Windows;

// Pipe-private records. These are ordering fences, never application/owner authorization.
// Long clock/sequence/process-birth values are strings so the Host cannot round them.
internal sealed record ForegroundWorkerIdentity(int Pid, string CreatedAtTicks, string ExecutablePath, string ImageSHA256,
    int ParentPid, string ParentCreatedAtTicks, int SessionId, string DesktopSHA256, string InstanceId, string Architecture);
internal sealed record ForegroundActionTicket(string TicketId, ForegroundWorkerIdentity Identity, long Epoch, long LogicalEpoch,
    string TargetId, string GeometrySHA256, string ActionSHA256, long SurfaceGeneration, string PhysicalSequence, string ExpiresAtQpc);
internal sealed record ForegroundReleaseToken(string TokenId, ForegroundWorkerIdentity Identity, long Epoch, string TargetId,
    string PhysicalSequence, string ExpiresAtQpc);
internal sealed record ForegroundContext(ForegroundWorkerIdentity Identity, string PhysicalSequence, bool Controlled, ForegroundReleaseToken? Release);
internal sealed record ForegroundGrantReceipt(bool Attempted, bool Allowed, int Error, ForegroundWorkerIdentity Donor, ForegroundWorkerIdentity Recipient,
    string TicketId, string ReleaseTokenId, string PhysicalSequence);

// The state machine has no Win32 dependency. Native calls/clock are injected at the boundary,
// so rejection, replay and failure ordering are executable on every development platform.
internal sealed class ForegroundHandoffCore
{
    internal const int TicketLifetimeMilliseconds = 2000;
    // A real model request may use the existing180s request budget. Keep the
    // clean-release qualification for one bounded300s interval without renewal;
    // the receiver's fresh action ticket still expires after2000ms.
    internal const int ReleaseLifetimeMilliseconds = 300000;
    private const long MaxSafeInteger = 9_007_199_254_740_991;
    private readonly Func<long> now;
    private readonly long frequency;
    private readonly Func<string> nextId;
    private readonly ForegroundWorkerIdentity identity;
    private ForegroundActionTicket? pending;
    private ForegroundReleaseToken? released;
    private long succeededEpoch;
    private string? succeededTarget;
    private long sequence;
    private long actionSequence;
    private bool controlled;
    private bool observing;
    private bool monitorWasAvailable = true;
    private bool desktopWasActive = true;
    internal bool Armed => pending != null || released != null;
    internal bool Controlled => controlled;
    internal bool Observing => observing;
    internal ForegroundWorkerIdentity Identity => identity;
    internal ForegroundHandoffCore(ForegroundWorkerIdentity identity, Func<long>? clock = null, long clockFrequency = 0, Func<string>? newId = null)
    {
        ValidateIdentity(identity);
        this.identity = identity; now = clock ?? Stopwatch.GetTimestamp;
        frequency = clockFrequency == 0 ? Stopwatch.Frequency : clockFrequency;
        if (frequency <= 0) throw Fail("foreground-clock-invalid");
        nextId = newId ?? (() => Guid.NewGuid().ToString("N"));
    }
    private static NativeFailure Fail(string code) => new(code, "Foreground handoff precondition failed; activate the target before continuing");
    internal static string Decimal(long value) => value.ToString(CultureInfo.InvariantCulture);
    private static long UnsignedDecimal(string? value)
    {
        if (value == null || value.Length is < 1 or > 20 || value.Any(character => character is < '0' or > '9') || !long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) || parsed < 0) throw Fail("foreground-identity-invalid");
        return parsed;
    }
    internal static bool Digest(string? value) => value is { Length: 64 } && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    internal static void ValidateIdentity(ForegroundWorkerIdentity value)
    {
        if (value == null || value.Pid <= 0 || value.ParentPid <= 0 || value.Pid == value.ParentPid || value.SessionId <= 0
            || value.ExecutablePath == null || value.ExecutablePath.Length is < 3 or > 32768 || value.ExecutablePath.Any(char.IsControl)
            || !Digest(value.ImageSHA256) || !Digest(value.DesktopSHA256) || !Guid.TryParseExact(value.InstanceId, "N", out _)
            || value.Architecture is not ("arm64" or "x64") || UnsignedDecimal(value.CreatedAtTicks) <= 0 || UnsignedDecimal(value.ParentCreatedAtTicks) <= 0)
            throw Fail("foreground-identity-invalid");
    }
    // Only these fields can be independently re-read from the pinned process.
    // Instance/architecture/desktop are authenticated by the receiver's Host pipe,
    // not presented as fields the donor can query from another process's memory.
    internal static void ValidateOsRecipient(ForegroundWorkerIdentity expected, ForegroundWorkerIdentity actual)
    {
        ValidateIdentity(expected); ValidateIdentity(actual);
        if (actual.Pid != expected.Pid || actual.CreatedAtTicks != expected.CreatedAtTicks || actual.ParentPid != expected.ParentPid
            || actual.ParentCreatedAtTicks != expected.ParentCreatedAtTicks || actual.SessionId != expected.SessionId || actual.ImageSHA256 != expected.ImageSHA256
            || !string.Equals(actual.ExecutablePath, expected.ExecutablePath, StringComparison.OrdinalIgnoreCase)) throw Fail("foreground-recipient-changed");
    }
    private static void Positive(long value) { if (value <= 0 || value > MaxSafeInteger) throw Fail("foreground-ticket-invalid"); }
    private static void Logical(long value) { if (value < 0 || value > MaxSafeInteger) throw Fail("foreground-ticket-invalid"); }
    private static void Target(string? value) { if (string.IsNullOrEmpty(value) || value.Length > 256 || value.Any(char.IsControl)) throw Fail("foreground-ticket-invalid"); }
    private long Deadline(int milliseconds) => checked(now() + checked(frequency * milliseconds / 1000));
    private bool Expired(string deadline) => UnsignedDecimal(deadline) <= now();
    internal string? Refresh(long physicalSequence, bool monitorAvailable, bool activeDesktop)
    {
        if (physicalSequence < 0) throw Fail("foreground-sequence-invalid");
        string? reason = null;
        if (Armed || observing) {
            if (!monitorAvailable && monitorWasAvailable) reason = "monitor-unavailable";
            else if (!activeDesktop && desktopWasActive) reason = "desktop-changed";
            else if (physicalSequence != sequence) reason = "physical-input";
            else if (pending != null && Expired(pending.ExpiresAtQpc)) reason = "ticket-expired";
            else if (released != null && Expired(released.ExpiresAtQpc)) reason = "release-expired";
        }
        if (physicalSequence != sequence || !monitorAvailable || !activeDesktop) { succeededEpoch = 0; succeededTarget = null; }
        sequence = physicalSequence; monitorWasAvailable = monitorAvailable; desktopWasActive = activeDesktop;
        if (reason != null) { pending = null; released = null; succeededEpoch = 0; succeededTarget = null; }
        return reason;
    }
    internal ForegroundContext Context() { observing = true; return new(identity, Decimal(sequence), controlled, released); }
    internal ForegroundActionTicket Prepare(long epoch, long logicalEpoch, string targetId, string geometrySHA256, string actionSHA256, long surfaceGeneration)
    {
        Positive(epoch); Logical(logicalEpoch); Positive(surfaceGeneration); Target(targetId);
        if (!Digest(geometrySHA256) || !Digest(actionSHA256)) throw Fail("foreground-ticket-invalid");
        if (pending != null) throw Fail("foreground-ticket-pending");
        // Once a recipient can acquire an OS ASFW right it never regains an unticketed
        // activation path, even after cancellation or an expired ticket.
        controlled = true; observing = true;
        pending = new(nextId(), identity, epoch, logicalEpoch, targetId, geometrySHA256, actionSHA256, surfaceGeneration, Decimal(sequence), Decimal(Deadline(TicketLifetimeMilliseconds)));
        return pending;
    }
    internal void BeforeLease(long epoch)
    {
        Positive(epoch);
        released = null; succeededEpoch = 0; succeededTarget = null; actionSequence = sequence;
        if (controlled && (pending == null || pending.Epoch != epoch || pending.PhysicalSequence != Decimal(sequence) || Expired(pending.ExpiresAtQpc))) {
            pending = null; throw Fail("foreground-ticket-required");
        }
    }
    internal void Consume(ForegroundActionTicket? ticket, long epoch, string targetId, string geometrySHA256, string actionSHA256)
    {
        if (!controlled) { if (ticket != null) throw Fail("foreground-ticket-unexpected"); return; }
        var own = pending;
        // Every attempt consumes the pending ticket, including a mismatched/replayed
        // descriptor. Nothing after this point can turn it back into a retry.
        pending = null; released = null; succeededEpoch = 0; succeededTarget = null;
        if (own == null || ticket == null || ticket != own || own.Identity != identity || own.Epoch != epoch || own.TargetId != targetId
            || own.GeometrySHA256 != geometrySHA256 || own.ActionSHA256 != actionSHA256 || own.PhysicalSequence != Decimal(sequence) || Expired(own.ExpiresAtQpc))
            throw Fail("foreground-ticket-invalid");
    }
    internal bool Cancel(string ticketId)
    {
        if (!Guid.TryParseExact(ticketId, "N", out _)) throw Fail("foreground-ticket-invalid");
        if (pending == null || pending.TicketId != ticketId) return false;
        pending = null; return true;
    }
    internal void ActionSucceeded(long epoch, string targetId) { if (sequence == actionSequence) { succeededEpoch = epoch; succeededTarget = targetId; } }
    internal bool CancelRelease(string tokenId)
    {
        if (!Guid.TryParseExact(tokenId, "N", out _)) throw Fail("foreground-release-invalid");
        if (released == null || released.TokenId != tokenId) return false;
        released = null; return true;
    }
    internal void ActionFailed() { succeededEpoch = 0; succeededTarget = null; released = null; }
    internal ForegroundReleaseToken? CleanRelease(long epoch, bool clean)
    {
        if (!clean || epoch != succeededEpoch || succeededTarget == null || released != null) return null;
        released = new(nextId(), identity, epoch, succeededTarget, Decimal(sequence), Decimal(Deadline(ReleaseLifetimeMilliseconds)));
        succeededEpoch = 0; succeededTarget = null;
        return released;
    }
    internal ForegroundGrantReceipt Grant(ForegroundReleaseToken requested, ForegroundWorkerIdentity recipient, ForegroundActionTicket ticket,
        Action validatePinnedPeerAndDesktop, Func<int, (bool Allowed, int Error)> allowSetForeground)
    {
        ValidateIdentity(recipient);
        var own = released;
        if (own == null || requested != own || requested.Identity != identity || requested.PhysicalSequence != Decimal(sequence) || Expired(requested.ExpiresAtQpc)) throw Fail("foreground-release-invalid");
        if (recipient.Pid == identity.Pid || recipient.InstanceId == identity.InstanceId || recipient.ParentPid != identity.ParentPid
            || recipient.ParentCreatedAtTicks != identity.ParentCreatedAtTicks || recipient.SessionId != identity.SessionId
            || !string.Equals(recipient.ExecutablePath, identity.ExecutablePath, StringComparison.OrdinalIgnoreCase) || recipient.ImageSHA256 != identity.ImageSHA256
            || recipient.DesktopSHA256 != identity.DesktopSHA256 || recipient.Architecture != identity.Architecture) throw Fail("foreground-recipient-mismatch");
        if (ticket == null || ticket.Identity != recipient || !Guid.TryParseExact(ticket.TicketId, "N", out _) || !Digest(ticket.ActionSHA256) || !Digest(ticket.GeometrySHA256)
            || UnsignedDecimal(ticket.ExpiresAtQpc) <= now()) throw Fail("foreground-ticket-invalid");
        Positive(ticket.Epoch); Logical(ticket.LogicalEpoch); Positive(ticket.SurfaceGeneration); Target(ticket.TargetId); UnsignedDecimal(ticket.PhysicalSequence);
        // Consume before OS validation/API as well: a false result or exception must
        // never allow the same clean release to attempt ASFW again.
        released = null;
        var grantedSequence = sequence;
        validatePinnedPeerAndDesktop();
        if (sequence != grantedSequence || Expired(requested.ExpiresAtQpc) || Expired(ticket.ExpiresAtQpc)) throw Fail("foreground-context-changed");
        var result = allowSetForeground(recipient.Pid);
        return new(true, result.Allowed, result.Error, identity, recipient, ticket.TicketId, requested.TokenId, Decimal(sequence));
    }
    internal void Invalidate() { pending = null; released = null; succeededEpoch = 0; succeededTarget = null; }
}
