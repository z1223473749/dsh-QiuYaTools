$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Error.WriteLine('{"stage":"loading-test-framework"}')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Console]::Error.WriteLine('{"stage":"compiling-test-fixture"}')
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

public sealed class QytSoakCanvas : Control {
    public uint DrawStamp;
    public long DrawnAtMs, DrawCount;
    public QytSoakCanvas() {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Dock = DockStyle.Fill;
    }
    public static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    protected override void OnPaint(PaintEventArgs e) {
        e.Graphics.Clear(Color.FromArgb(13, 46, 59));
        uint stamp = unchecked((uint)Now());
        // Exact same logical geometry as macOS ClockCanvas: bit-center (28+16b,32).
        for (int bit = 0; bit < 32; bit++)
            e.Graphics.FillRectangle((stamp & (1u << bit)) == 0 ? Brushes.Black : Brushes.White, 20 + bit * 16, 20, 16, 24);
        using (Font font = new Font(FontFamily.GenericSansSerif, 17))
            e.Graphics.DrawString("QiuYaTools native endurance fixture\nSource: " + stamp + "\nOnly this disposable window is recorded.", font, Brushes.White, new RectangleF(20, 80, 600, 200));
        DrawStamp = stamp; DrawnAtMs = Now(); DrawCount++;
        base.OnPaint(e);
    }
}
public sealed class QytSoakWindow : Form {
    [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    readonly QytSoakCanvas canvas = new QytSoakCanvas();
    readonly Timer timer = new Timer();
    long ticks;
    bool awake;
    public QytSoakWindow() {
        AutoScaleMode = AutoScaleMode.None; FormBorderStyle = FormBorderStyle.None;
        ClientSize = new Size(640, 360); StartPosition = FormStartPosition.Manual;
        Location = new Point(80, 80); Text = "QiuYaTools native endurance fixture";
        Controls.Add(canvas); timer.Interval = 33;
        timer.Tick += delegate {
            long requested = QytSoakCanvas.Now(); canvas.Refresh(); ticks++;
            if (ticks % 30 == 0) Console.WriteLine("{\"tick\":" + ticks + ",\"requestedAtMs\":" + requested + ",\"drawStamp\":" + canvas.DrawStamp + ",\"drawnAtMs\":" + canvas.DrawnAtMs + ",\"drawCount\":" + canvas.DrawCount + ",\"windowVisible\":" + (Visible ? "true" : "false") + ",\"preventsIdleDisplaySleep\":" + (awake ? "true" : "false") + "}");
        };
    }
    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        // Node hides the PowerShell console via STARTUPINFO; show only this test Form.
        SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0040);
        awake = SetThreadExecutionState(0x80000003u) != 0;
        if (!awake) throw new InvalidOperationException("Fixture could not hold the temporary display-awake assertion");
        canvas.Refresh(); timer.Start();
        Console.WriteLine("{\"ready\":true,\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + ",\"sessionId\":" + System.Diagnostics.Process.GetCurrentProcess().SessionId + ",\"width\":640,\"height\":360,\"preventsIdleDisplaySleep\":true}");
        Task.Run(delegate {
            while (true) { string line = Console.ReadLine(); if (line == null || line == "quit") break; }
            try { BeginInvoke((Action)delegate { Close(); }); } catch (InvalidOperationException) { }
        });
    }
    protected override void OnFormClosed(FormClosedEventArgs e) {
        timer.Stop(); timer.Dispose(); SetThreadExecutionState(0x80000000u); awake = false;
        base.OnFormClosed(e);
    }
    public static void Run() {
        SetProcessDPIAware(); Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (QytSoakWindow window = new QytSoakWindow()) {
            Console.Error.WriteLine("{\"stage\":\"showing-test-window\"}");
            window.Show();
            // STARTUPINFO SW_HIDE can suppress the first ShowWindow call and its
            // Shown callback. Present outside that callback, then enter the pump.
            if (!SetWindowPos(window.Handle, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0040))
                throw new InvalidOperationException("Fixture window could not be presented");
            Console.Error.WriteLine("{\"stage\":\"test-window-presented\"}");
            Application.Run(window);
        }
    }
}
'@
[Console]::Error.WriteLine('{"stage":"starting-test-window"}')
[QytSoakWindow]::Run()
