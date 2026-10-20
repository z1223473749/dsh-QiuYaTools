using System.Runtime.InteropServices;
using System.Text.Json;
namespace QiuYaTools.Windows;

/** Separate process for the Host's last reported owned input if the main worker is unresponsive. */
internal static class EmergencyRelease
{
    internal static void Run()
    {
        try {
            var line = Console.ReadLine();
            if (line == null || line.Length > 16_384) throw new JsonException();
            using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 4 });
            var request = document.RootElement;
            if (request.ValueKind != JsonValueKind.Object || request.EnumerateObject().Any(property => property.Name is not ("keys" or "mouseButtons" or "unicodeUnits" or "ownerId"))) throw new JsonException();
            if (!request.TryGetProperty("keys", out var keys) || keys.ValueKind != JsonValueKind.Array || keys.GetArrayLength() > 32 || !request.TryGetProperty("mouseButtons", out var buttons) || buttons.ValueKind != JsonValueKind.Array || buttons.GetArrayLength() > 3) throw new JsonException();
            if (!request.TryGetProperty("ownerId", out var owner) || owner.ValueKind != JsonValueKind.String || owner.GetString() is not string ownerId) throw new JsonException();
            DesktopLeaseGuard.RecoverOwner(ownerId);
            Environment.ExitCode = 0;
            Program.Emit(new { released = true, ownerMatchedCleanup = true });
        } catch (NativeFailure failure) {
            Environment.ExitCode = 1;
            Program.Emit(new { released = false, error = failure.Code });
        } catch (JsonException) {
            Environment.ExitCode = 2;
            Program.Emit(new { released = false, error = "invalid-input-state" });
        }
    }
}
