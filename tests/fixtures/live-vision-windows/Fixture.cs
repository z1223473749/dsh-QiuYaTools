using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using QiuYaTools.VisualAcceptance;

internal sealed class VisualFixture : Form
{
    private readonly BusinessCore business;
    private readonly Canvas canvas;
    private readonly TextBox input = new() { AccessibleName = "收货备注输入框", Location = new(40, 310), Size = new(595, 40), Font = new("Microsoft YaHei UI", 18), Multiline = false };
    private readonly TcpListener server = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource stopping = new();
    private readonly System.Windows.Forms.Timer lifetime = new() { Interval = 240000 };
    private readonly string birth = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString();
    private string windowId = "";
    private readonly object stateLock = new();
    private byte[] state = [];
    internal VisualFixture(BusinessCore value)
    {
        business = value;
        Text = "QiuYaTools Windows Visual Business Fixture " + value.Task;
        ClientSize = new(680, 480); StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false;
        canvas = new(value) { Dock = DockStyle.Fill }; Controls.Add(canvas);
        if (value.Task == 2) {
            canvas.Controls.Add(input);
            input.TextChanged += (_, _) => { business.ObserveText(input.Text); Save(); };
            input.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; business.Submit(); Save(); canvas.Invalidate(); } };
        }
        canvas.Changed += (_, _) => Save();
        lifetime.Tick += (_, _) => Close();
        Shown += (_, _) => {
            Activate(); BringToFront(); windowId = Handle.ToInt64().ToString(); Save();
            server.Start(); var address = (IPEndPoint)server.LocalEndpoint; _ = Serve();
            Console.WriteLine(JsonSerializer.Serialize(new { @event = "ready", pid = Environment.ProcessId, createdAtTicks = birth, windowId, task = business.Task, stateEndpoint = $"http://127.0.0.1:{address.Port}/state" })); Console.Out.Flush();
            Activate(); lifetime.Start();
            _ = Task.Run(() => {
                while (Console.ReadLine() is string line) { if (line == "quit") { BeginInvoke(Close); return; } }
                BeginInvoke(Close);
            });
        };
        FormClosed += (_, _) => { lifetime.Stop(); lifetime.Dispose(); stopping.Cancel(); server.Stop(); };
    }
    private void Save()
    {
        // Serialize on the UI thread; the HTTP observer never mutates business state.
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new { oracle = business.Snapshot(), pid = Environment.ProcessId, createdAtTicks = birth, windowId });
        lock (stateLock) state = bytes;
    }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    private async Task Serve()
    {
        try { while (!stopping.IsCancellationRequested) { var client = await server.AcceptTcpClientAsync(stopping.Token); _ = Respond(client); } }
        catch (Exception error) when (error is OperationCanceledException or SocketException or ObjectDisposedException) { }
    }
    private async Task Respond(TcpClient client)
    {
        using (client) using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token)) {
            timeout.CancelAfter(2000);
            try {
                using var stream = client.GetStream(); using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                var request = await reader.ReadLineAsync(timeout.Token);
                if (request != "GET /state HTTP/1.1" && request != "GET /state HTTP/1.0") { await stream.WriteAsync("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"u8.ToArray(), timeout.Token); return; }
                for (int index = 0; index < 32; index++) { var line = await reader.ReadLineAsync(timeout.Token); if (string.IsNullOrEmpty(line)) break; if (line.Length > 4096) return; }
                byte[] saved; lock (stateLock) saved = state;
                using var snapshot = JsonDocument.Parse(saved);
                byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new { oracle = snapshot.RootElement.GetProperty("oracle"), pid = Environment.ProcessId, createdAtTicks = birth, windowId, foregroundWindowId = GetForegroundWindow().ToInt64().ToString() });
                await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n"), timeout.Token);
                await stream.WriteAsync(bytes, timeout.Token);
            } catch (Exception error) when (error is OperationCanceledException or IOException or SocketException or ObjectDisposedException) { }
        }
    }
    private sealed class Canvas : Control
    {
        private readonly BusinessCore value;
        internal event EventHandler? Changed;
        internal Canvas(BusinessCore core)
        {
            value = core; DoubleBuffered = true; AccessibleName = "Disposable visual business canvas. Inspect the screenshot for the task."; AccessibleRole = AccessibleRole.Pane; TabStop = false;
        }
        private static RectangleF Rect(Box box) => new((float)box.X, (float)box.Y, (float)box.Width, (float)box.Height);
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e); var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias; g.Clear(Color.FromArgb(15, 33, 46));
            void Label(string text, RectangleF box, float size = 22) { using var font = new Font("Microsoft YaHei UI", size); using var brush = new SolidBrush(Color.White); g.DrawString(text, font, brush, box); }
            Label("订单核验 · " + value.Nonce, new(24, 18, 620, 48), 25);
            if (value.Task == 1) {
                Label("请点击绿色「确认本单」按钮", new(24, 80, 620, 55));
                using var green = new SolidBrush(Color.FromArgb(40, 190, 80)); using var red = new SolidBrush(Color.FromArgb(248, 55, 65));
                g.FillRectangle(green, Rect(value.Confirm)); g.FillRectangle(red, Rect(value.Decoy));
                Label("确认本单", new((float)value.Confirm.X + 20, (float)value.Confirm.Y + 15, 210, 60), 23);
                Label("取消订单", new((float)value.Decoy.X + 20, (float)value.Decoy.Y + 15, 210, 60), 23);
            } else if (value.Task == 2) {
                Label("请把以下收货备注逐字输入下方文本框，按 Enter 提交：", new(24, 80, 620, 80), 19);
                Label(value.Note, new(24, 165, 620, 110), 22);
            } else {
                Label("把蓝色订单卡拖入绿色「已核验」框", new(24, 80, 630, 60), 21);
                using var green = new Pen(Color.FromArgb(40, 190, 80), 5); g.DrawRectangle(green, Rectangle.Round(Rect(value.Destination)));
                Label("已核验", new((float)value.Destination.X + 25, (float)value.Destination.Y + 45, 160, 60), 22);
                using var blue = new SolidBrush(Color.FromArgb(40, 120, 230)); g.FillRectangle(blue, Rect(value.Card));
                Label("订单 " + value.Nonce, new((float)value.Card.X + 8, (float)value.Card.Y + 22, 180, 55), 18);
            }
            if (value.Passed) Label("已完成核验 ✓", new(24, 405, 630, 60), 27);
            else if (value.Task == 2 && value.Submitted) Label("校验未通过：请核对文字、标点和空格", new(24, 405, 630, 60), 19);
        }
        protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); if (e.Button != MouseButtons.Left) return; value.Down(e.X, e.Y); Capture = true; Changed?.Invoke(this, EventArgs.Empty); Invalidate(); }
        protected override void OnMouseMove(MouseEventArgs e) { base.OnMouseMove(e); if (e.Button != MouseButtons.Left) return; value.Drag(e.X, e.Y); Changed?.Invoke(this, EventArgs.Empty); Invalidate(); }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); if (e.Button != MouseButtons.Left) return; value.Up(e.X, e.Y); Capture = false; Changed?.Invoke(this, EventArgs.Empty); Invalidate(); }
    }
}
internal static class FixtureProgram
{
    [STAThread] private static void Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        string? line = Console.ReadLine(); if (line == null || line.Length > 4096) { Environment.ExitCode = 2; return; }
        using var parsed = JsonDocument.Parse(line); var config = parsed.RootElement;
        var core = new BusinessCore(config.GetProperty("task").GetInt32(), config.GetProperty("nonce").GetString()!, config.GetProperty("note").GetString()!, config.GetProperty("seed").GetInt32());
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2); Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new VisualFixture(core));
    }
}
