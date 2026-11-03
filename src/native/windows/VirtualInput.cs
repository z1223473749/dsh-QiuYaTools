using System.Text.Json;
using System.Windows.Automation;
using System.Runtime.InteropServices;
using System.Text;

namespace QiuYaTools.Windows;

/// UIA is read-only here: legacy provider mutations can activate background windows.
/// Only standard HWND button/edit messages with no activation semantics are dispatched.
/// Other controls fail closed and require separate physical-input approval.
internal sealed class VirtualInput
{
    private string? targetId;
    private Point? point;
    private IntPtr textAnchor;
    private int caret;
    private static NativeFailure Unsupported(string reason = "No supported background control") => new("VIRTUAL_INPUT_UNSUPPORTED", reason + ". Request owner permission for physical input.");
    internal void Hide() { point = null; targetId = null; ClearAnchor(); }
    internal void ClearAnchor() { textAnchor = IntPtr.Zero; caret = 0; }
    internal object? Snapshot(string id, Rectangle rect) => targetId == id && point is Point p && rect.Contains(p)
        ? new { x = p.X - rect.X, y = p.Y - rect.Y, visible = true, actor = "ai", phase = "virtual" } : null;
    private static List<AutomationElement> Path(AutomationElement root, Point point)
    {
        var path = new List<AutomationElement> { root };
        var current = root;
        var deadline = Environment.TickCount64 + 800;
        for (var depth = 0; depth < 24; depth++) {
            var children = current.FindAll(TreeScope.Children, Condition.TrueCondition);
            if (children.Count > 256 || Environment.TickCount64 > deadline) throw Unsupported();
            AutomationElement? hit = null;
            foreach (AutomationElement child in children) {
                if (!child.Current.BoundingRectangle.Contains(point.X, point.Y)) continue;
                if (hit != null) throw Unsupported();
                hit = child;
            }
            if (hit == null) return path;
            path.Add(hit); current = hit;
        }
        throw Unsupported();
    }
    private static bool StandardClass(IntPtr hwnd, string name)
    {
        var buffer = new StringBuilder(256);
        return GetClassName(hwnd, buffer, buffer.Capacity) != 0 &&
            (buffer.ToString().Equals(name, StringComparison.OrdinalIgnoreCase) ||
             buffer.ToString().StartsWith("WindowsForms10." + name + ".", StringComparison.OrdinalIgnoreCase));
    }
    private static void RequireChild(IntPtr hwnd, IntPtr root)
    {
        if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd) || !IsChild(root, hwnd) || !IsWindowEnabled(hwnd)) throw Unsupported("Control is not an enabled child HWND");
        Native.GetWindowThreadProcessId(hwnd, out var pid); Native.GetWindowThreadProcessId(root, out var rootPid);
        if (pid != rootPid) throw Unsupported();
    }
    private static nint Message(IntPtr hwnd, uint message, nint wParam, nint lParam)
    {
        if (SendMessageTimeout(hwnd, message, wParam, lParam, 3, 400, out var result) == IntPtr.Zero)
            throw new InvalidOperationException("Window message was not acknowledged");
        return result;
    }
    private static string ReadText(IntPtr hwnd)
    {
        var length = (int)Message(hwnd, 0x000E, 0, 0);
        if (length < 0 || length > 65534) throw Unsupported();
        var buffer = new StringBuilder(length + 1);
        if (SendTextMessageTimeout(hwnd, 0x000D, buffer.Capacity, buffer, 3, 400, out _) == IntPtr.Zero)
            throw new InvalidOperationException("Text could not be read");
        return buffer.ToString();
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder value, int size);
    [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetStyle(IntPtr hwnd, int index);
    [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr hwnd, ref NativePoint point);
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { internal int X, Y; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, nint wParam, nint lParam, uint flags, uint timeout, out nint result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")] private static extern IntPtr SendTextMessageTimeout(IntPtr hwnd, uint message, nint wParam, StringBuilder value, uint flags, uint timeout, out nint result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")] private static extern IntPtr WriteTextMessageTimeout(IntPtr hwnd, uint message, nint wParam, string value, uint flags, uint timeout, out nint result);
    internal object Act(string id, IntPtr handle, Rectangle rect, JsonElement action, Action checkpoint, Action<Action> dispatch)
    {
        var dispatched = false;
        try {
            checkpoint();
            var kind = Program.Text(action, "kind", 32);
            if (action.TryGetProperty("holdMs", out _) || action.TryGetProperty("inputMode", out var mode) && mode.GetString() == "compatibility") throw Unsupported();
            if (kind is "move" or "click" or "scroll") {
                var x = Program.Number(action, "x"); var y = Program.Number(action, "y");
                if (x < 0 || y < 0 || x >= rect.Width || y >= rect.Height) throw new NativeFailure("invalid-coordinate", "Pointer is outside the observed window");
                if (targetId != id) ClearAnchor();
                targetId = id; point = new Point(rect.X + (int)x, rect.Y + (int)y);
            }
            if (kind == "move") return new { performed = true, delivery = "virtual", kind };
            var root = AutomationElement.FromHandle(handle);
            if (kind == "type") {
                if (targetId != id || textAnchor == IntPtr.Zero) throw Unsupported();
                RequireChild(textAnchor, handle);
                if (!StandardClass(textAnchor, "EDIT") || (GetStyle(textAnchor, -16) & 0x820) != 0) throw Unsupported();
                var oldText = ReadText(textAnchor); var text = Program.Text(action, "text", 100_000);
                if (caret > oldText.Length || oldText.Length + text.Length > 65534) throw Unsupported();
                var next = oldText.Insert(caret, text);
                dispatch(() => {
                    RequireChild(textAnchor, handle);
                    if (ReadText(textAnchor) != oldText) throw Unsupported();
                    dispatched = true;
                    if (WriteTextMessageTimeout(textAnchor, 0x000C, 0, next, 3, 400, out var result) == IntPtr.Zero || result == 0)
                        throw new InvalidOperationException("Text write was not acknowledged");
                    caret += text.Length;
                });
            } else if (kind == "click") {
                if (action.TryGetProperty("button", out var button) && button.GetString() != "left" || point == null) throw Unsupported();
                var path = Path(root, point.Value); path.Reverse(); ClearAnchor();
                // Never invoke UIA patterns: the WinForms/MSAA bridge may call SetFocus.
                foreach (var element in path) {
                    var hwnd = new IntPtr(element.Current.NativeWindowHandle);
                    if (hwnd == IntPtr.Zero) continue;
                    RequireChild(hwnd, handle);
                    if (element.Current.ControlType == ControlType.Edit && StandardClass(hwnd, "EDIT")) {
                        if ((GetStyle(hwnd, -16) & 0x820) != 0) throw Unsupported(); // read-only/password
                        var oldText = ReadText(hwnd); var p = new NativePoint { X = point.Value.X, Y = point.Value.Y };
                        if (!ScreenToClient(hwnd, ref p) || p.X < 0 || p.Y < 0 || p.X > 32767 || p.Y > 32767) throw Unsupported();
                        var index = (int)Message(hwnd, 0x00D7, 0, (p.Y << 16) | p.X) & 0xffff; // EM_CHARFROMPOS
                        if (index > oldText.Length) throw Unsupported();
                        textAnchor = hwnd; caret = index;
                        return new { performed = true, delivery = "virtual", kind };
                    }
                    if (element.Current.ControlType == ControlType.Button && StandardClass(hwnd, "BUTTON")) {
                        var style = GetStyle(hwnd, -16) & 0xf; var parent = GetParent(hwnd); var controlId = GetDlgCtrlID(hwnd);
                        if (style is not (0 or 1 or 11) || parent == IntPtr.Zero) throw Unsupported($"Button style={style}, controlId={controlId}");
                        // Direct BN_CLICKED avoids BM_CLICK's synthetic mouse/focus processing.
                        dispatch(() => { RequireChild(hwnd, handle); if (GetParent(hwnd) != parent || GetDlgCtrlID(hwnd) != controlId) throw Unsupported(); dispatched = true; Message(parent, 0x0111, controlId & 0xffff, hwnd); });
                        break;
                    }
                }
                if (!dispatched) throw Unsupported("No standard child button or edit at the point");
            } else throw Unsupported();
            return new { performed = true, delivery = "virtual", kind };
        } catch (NativeFailure) { throw; }
        catch (Exception error) when (error is ElementNotAvailableException or InvalidOperationException or NotSupportedException or ArgumentException or System.Runtime.InteropServices.COMException or System.UnauthorizedAccessException) {
            throw new NativeFailure(dispatched ? "VIRTUAL_INPUT_UNCONFIRMED" : "VIRTUAL_INPUT_UNSUPPORTED", dispatched ? "Background action result is unconfirmed; do not replay input." : "The control does not expose a usable background action.");
        }
    }
}
