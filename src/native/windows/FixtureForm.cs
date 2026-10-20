using System.Text.Json;
using System.Net;
using System.Net.Sockets;
using System.Text;
namespace QiuYaTools.Windows;

internal sealed class FixtureForm : Form
{
    private readonly string? output;
    private int clicks;
    private int drags;
    private int wheelTotal;
    private int authenticatedPreviews;
    private readonly TcpListener server = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource serverStop = new();
    private readonly System.Windows.Forms.Timer animation = new() { Interval = 33 };
    private int port;
    private readonly TextBox input = new() { Name = "fixture-input", Location = new Point(30, 80), Size = new Size(430, 100), Multiline = true, AccessibleName = "Fixture text input" };
    private readonly Label count = new() { Text = "Clicks: 0", Location = new Point(180, 30), AutoSize = true, AccessibleName = "Fixture click count" };
    internal FixtureForm(string[] args)
    {
        var index = Array.IndexOf(args, "--fixture-output");
        output = index >= 0 && index + 1 < args.Length ? Path.GetFullPath(args[index + 1]) : null;
        Text = "QiuYaTools Windows Test Fixture"; Name = "QiuYaToolsFixture";
        StartPosition = FormStartPosition.Manual; Location = new Point(80, 80); ClientSize = new Size(520, 460);
        var button = new Button { Text = "Click me", Name = "fixture-button", AccessibleName = "Fixture click button", Location = new Point(30, 25), Size = new Size(120, 35) };
        button.Click += (_, _) => { clicks++; count.Text = $"Clicks: {clicks}"; Save(); };
        input.TextChanged += (_, _) => Save();
        Controls.Add(button); Controls.Add(count); Controls.Add(input);
        var scroll = new ListBox { Name = "fixture-scroll", AccessibleName = "Fixture scroll area", Location = new Point(30, 210), Size = new Size(430, 110) };
        scroll.Items.AddRange(Enumerable.Range(1, 60).Select(i => (object)("Fixture row " + i)).ToArray());
        scroll.MouseWheel += (_, e) => { wheelTotal += e.Delta; Save(); }; Controls.Add(scroll);
        var pad = new Panel { Name = "fixture-drag", AccessibleName = "Fixture drag pad", Location = new Point(30, 340), Size = new Size(430, 70), BackColor = Color.LightSteelBlue };
        Point? dragStart = null;
        pad.MouseDown += (_, e) => { dragStart = e.Location; pad.Capture = true; };
        pad.MouseUp += (_, e) => { if (dragStart is Point start && Math.Abs(e.X - start.X) + Math.Abs(e.Y - start.Y) > 10) drags++; dragStart = null; pad.Capture = false; Save(); };
        Controls.Add(pad);
        if (args.Contains("--fixture-animate")) {
            var ticks = 0L;
            var clock = new Label { Location = new Point(30, 425), Size = new Size(450, 25), AccessibleName = "Fixture animation clock" };
            Controls.Add(clock);
            animation.Tick += (_, _) => {
                ticks++; clock.Text = $"Live frame {ticks} at {DateTime.UtcNow:HH:mm:ss.fff}";
                if (output != null && ticks % 30 == 0) {
                    var heartbeat = output + ".heartbeat.json";
                    File.WriteAllText(heartbeat + ".tmp", JsonSerializer.Serialize(new { ticks, utc = DateTime.UtcNow.ToString("O"), pid = Environment.ProcessId }, Program.Json));
                    File.Move(heartbeat + ".tmp", heartbeat, true);
                }
            };
            animation.Start();
        }
        server.Start(); port = ((IPEndPoint)server.LocalEndpoint).Port; _ = Serve();
        FormClosed += (_, _) => { animation.Stop(); animation.Dispose(); serverStop.Cancel(); server.Stop(); };
        Shown += (_, _) => { Activate(); Save(); };
    }
    private async Task Serve()
    {
        try {
            while (!serverStop.IsCancellationRequested) {
                var client = await server.AcceptTcpClientAsync(serverStop.Token);
                // Browsers preconnect idle sockets. One idle socket must not block later fixture requests.
                _ = Task.Run(() => ServeClient(client));
            }
        } catch (Exception error) when (error is OperationCanceledException or SocketException or IOException) { }
    }
    private async Task ServeClient(TcpClient client)
    {
        using (client)
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(serverStop.Token)) {
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            try {
                using var stream = client.GetStream();
                using var reader = new StreamReader(stream, Encoding.ASCII, false, 4096, true);
                var request = await reader.ReadLineAsync(timeout.Token);
                var headers = new List<string>();
                string? headerLine;
                while (!string.IsNullOrEmpty(headerLine = await reader.ReadLineAsync(timeout.Token))) headers.Add(headerLine);
                var requestPath = request?.Split(' ').ElementAtOrDefault(1) ?? "/";
                if (requestPath.StartsWith("/?token=fixture-token", StringComparison.Ordinal)) {
                    await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 303 See Other\r\nSet-Cookie: fixture_preview=authorized; Path=/; HttpOnly; SameSite=Strict\r\nLocation: ./\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), timeout.Token); return;
                }
                var secure = requestPath.StartsWith("/secure-preview", StringComparison.Ordinal);
                var authorized = headers.Any(header => header.StartsWith("Cookie:", StringComparison.OrdinalIgnoreCase) && header.Contains("fixture_preview=authorized", StringComparison.Ordinal));
                if (secure && (!authorized || requestPath.Contains("token=", StringComparison.Ordinal))) {
                    await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), timeout.Token); return;
                }
                if (secure) BeginInvoke((Action)(() => { authenticatedPreviews++; Save(); }));
                var html = "<!doctype html><meta charset='utf-8'><title>QiuYaTools native fixture page</title><h1 id='fixture-heading'>Native window fixture</h1><input id='fixture-upload' type='file' multiple><textarea id='fixture-draft'></textarea><script>document.body.dataset.qytSessionWindowState='ready';const id=window.__QIUYA_SESSION_WINDOW__;if(id)window.webkit.messageHandlers.qiuyaSession.postMessage({type:'ready',sessionId:id,title:'Fixture '+id});</script>";
                var bytes = Encoding.UTF8.GetBytes(html);
                var header = Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(header, timeout.Token); await stream.WriteAsync(bytes, timeout.Token);
            } catch (Exception error) when (error is OperationCanceledException or SocketException or IOException or InvalidOperationException) { }
        }
    }
    private void Save()
    {
        if (output == null) return;
        File.WriteAllText(output, JsonSerializer.Serialize(new { clicks, drags, wheelTotal, authenticatedPreviews, text = input.Text, port, pid = Environment.ProcessId, bounds = new { x = Left, y = Top, width = Width, height = Height } }, Program.Json));
    }
}
