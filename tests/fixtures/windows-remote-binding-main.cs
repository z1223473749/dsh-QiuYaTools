using System;
using System.Text.Json;
internal static class RemoteBindingSelfTest {
 static void Main() { Console.WriteLine(JsonSerializer.Serialize(QytRemoteAudit.BindingSelfTest())); }
}
