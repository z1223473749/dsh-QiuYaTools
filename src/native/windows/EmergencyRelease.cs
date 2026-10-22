using System.Runtime.InteropServices;
using System.Text.Json;
using System.Diagnostics;
namespace QiuYaTools.Windows;

/** Separate process for the Host's last reported owned input if the main worker is unresponsive. */
internal static class EmergencyRelease
{
    internal static void Run(bool testReady = false)
    {
        try {
            // The fixed CLI-only test mode proves startup before one original input
            // action. Normal emergency cleanup emits only its existing final reply.
            if (testReady) Program.Emit(new { @event = "releaseInputReady", readyTicks = Stopwatch.GetTimestamp(), frequency = Stopwatch.Frequency });
            var line = Console.ReadLine();
            if (line == null || line.Length > 16_384) throw new JsonException();
            using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 4 });
            var request = document.RootElement;
            if (request.ValueKind != JsonValueKind.Object || request.EnumerateObject().Any(property => property.Name is not ("keys" or "mouseButtons" or "unicodeUnits" or "ownerId"))) throw new JsonException();
            if (!request.TryGetProperty("keys", out var keys) || keys.ValueKind != JsonValueKind.Array || keys.GetArrayLength() > 32 || !request.TryGetProperty("mouseButtons", out var buttons) || buttons.ValueKind != JsonValueKind.Array || buttons.GetArrayLength() > 3) throw new JsonException();
            if (!request.TryGetProperty("ownerId", out var owner) || owner.ValueKind != JsonValueKind.String || owner.GetString() is not string ownerId) throw new JsonException();
            var enteredTicks = testReady ? Stopwatch.GetTimestamp() : 0;
            var leftBefore = testReady && (GetAsyncKeyState(1) & 0x8000) != 0;
            DesktopLeaseGuard.RecoverOwner(ownerId);
            var leftAfter = testReady && (GetAsyncKeyState(1) & 0x8000) != 0;
            var completedTicks = testReady ? Stopwatch.GetTimestamp() : 0;
            Environment.ExitCode = 0;
            if (testReady) Program.Emit(new { released = true, ownerMatchedCleanup = true, cleanupProbe = new { enteredTicks, completedTicks, leftBefore, leftAfter } });
            else Program.Emit(new { released = true, ownerMatchedCleanup = true });
        } catch (NativeFailure failure) {
            Environment.ExitCode = 1;
            Program.Emit(new { released = false, error = failure.Code });
        } catch (JsonException) {
            Environment.ExitCode = 2;
            Program.Emit(new { released = false, error = "invalid-input-state" });
        }
    }

    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
}
