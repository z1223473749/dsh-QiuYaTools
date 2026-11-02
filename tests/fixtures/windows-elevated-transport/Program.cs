using System.IO.Pipes;
using System.Reflection;
using System.Text;
using System.Text.Json;
using QiuYaTools.Windows;

foreach (var code in new ushort[] { 0x1D, 0x2A, 0x148, 0x15B }) {
 var down = KeyboardEncoding.Encode(code, false); var up = KeyboardEncoding.Encode(code, true);
 if (down.Scan != up.Scan || down.Scan != (code & 255) || up.Flags != (down.Flags | 2u) || (down.Flags & 1u) != ((code & 256) != 0 ? 1u : 0u)) throw new Exception("Scan prefix or release encoding was lost");
}
foreach (var code in new ushort[] {0, 256, 512, 65535}) {
 try { KeyboardEncoding.Encode(code, false); throw new Exception("Invalid scan code accepted"); } catch (NativeFailure) { }
}
if (!CaptureFramePolicy.Uniform(800, 600, (_, _) => 0) || !CaptureFramePolicy.Uniform(800, 600, (_, _) => 0xFFFFFF)) throw new Exception("Uniform GPU surfaces need visible fallback");
if (CaptureFramePolicy.Uniform(800, 600, (x, y) => x == 0 && y == 0 ? 1 : 0)) throw new Exception("A nonuniform surface was discarded");
var name = "ctl-" + Guid.NewGuid().ToString("N")[..8];
using var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
using var client = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
var accept = server.WaitForConnectionAsync(); await client.ConnectAsync(); await accept;
using var owner = (ElevatedComputer)Activator.CreateInstance(typeof(ElevatedComputer), BindingFlags.Instance | BindingFlags.NonPublic, null, [server], null)!;
using var reader = new StreamReader(client, new UTF8Encoding(false));
using var writer = new StreamWriter(client, new UTF8Encoding(false)) { AutoFlush = true };
using var payload = JsonDocument.Parse("{\"requestId\":999,\"op\":\"act\"}");
var pending = owner.Call("act", payload.RootElement);
using var action = JsonDocument.Parse((await reader.ReadLineAsync())!);
var release = owner.Call("release", payload.RootElement);
using var cleanup = JsonDocument.Parse((await reader.ReadLineAsync())!);
await writer.WriteLineAsync(JsonSerializer.Serialize(new {requestId = cleanup.RootElement.GetProperty("requestId").GetInt64(), ok = true, result = new {released = true}}));
if (!(await release).GetProperty("released").GetBoolean() || pending.IsCompleted) throw new Exception("Release must bypass pending actions");
await writer.WriteLineAsync(JsonSerializer.Serialize(new {requestId = action.RootElement.GetProperty("requestId").GetInt64(), ok = false, error = new {code = "foreground-changed", message = "Stopped"}}));
try { await pending; throw new Exception("Error was lost"); } catch (NativeFailure error) when (error.Code == "foreground-changed") { }
foreach (var op in new[] {"launchApplication", "openPreview", "foregroundGrant", "openSystemSettings", "shell"}) {
 try { await owner.Call(op, payload.RootElement); throw new Exception("Privileged operation escaped the allowlist"); } catch (NativeFailure) { }
}
var closing = owner.Close();
using var stop = JsonDocument.Parse((await reader.ReadLineAsync())!);
if (stop.RootElement.GetProperty("op").GetString() != "shutdownControl" || closing.IsCompleted) throw new Exception("Shutdown must wait for privileged release");
await writer.WriteLineAsync("{\"event\":\"inputReleased\",\"passed\":true}"); await closing;
Console.WriteLine("{\"passed\":true,\"checks\":8,\"actualOsInput\":false}");
namespace QiuYaTools.Windows {
 internal static class Program { internal static void Emit(object value) {} }
 internal static class ProcessPermissions { internal static bool Elevated => false; }
 internal sealed class NativeFailure(string code,string message):Exception(message) {internal string Code=>code;}
}
