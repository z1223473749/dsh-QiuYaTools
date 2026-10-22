namespace QiuYaTools.VisualAcceptance;

// This independent oracle changes only in response to actual fixture events.
internal readonly record struct Box(double X, double Y, double Width, double Height)
{
    internal bool Contains(double x, double y) => x >= X && y >= Y && x < X + Width && y < Y + Height;
}
internal sealed class BusinessCore
{
    internal int Task { get; }
    internal string Nonce { get; }
    internal string Note { get; }
    internal Box Confirm { get; }
    internal Box Decoy { get; }
    internal Box Destination { get; }
    internal Box Card { get; private set; }
    internal bool Passed { get; private set; }
    internal bool Submitted { get; private set; }
    internal int CorrectClicks { get; private set; }
    internal int WrongClicks { get; private set; }
    internal int MouseDown { get; private set; }
    internal int MouseUp { get; private set; }
    internal int Dragged { get; private set; }
    private bool dragging, confirmDown;
    private double offsetX, offsetY;
    private string text = "";

    internal BusinessCore(int task, string nonce, string note, int seed)
    {
        if (task is < 1 or > 3 || nonce.Length != 6 || nonce.Any(c => !"0123456789ABCDEF".Contains(c)) || note.Length is < 1 or > 150 || seed is < 0 or > 65535) throw new ArgumentException("Invalid visual fixture configuration");
        Task = task; Nonce = nonce; Note = note;
        bool reversed = seed % 2 == 0;
        Confirm = new(reversed ? 365 : 65, 175 + seed % 75, 230, 75);
        Decoy = new(reversed ? 65 : 365, Confirm.Y, 230, 75);
        Destination = new(reversed ? 45 : 430, 175, 180, 160);
        Card = new(reversed ? 420 : 50, 190 + seed % 45, 180, 85);
    }
    internal void Down(double x, double y)
    {
        MouseDown++;
        if (Task == 1) confirmDown = Confirm.Contains(x, y);
        if (Task == 3) { dragging = Card.Contains(x, y); offsetX = x - Card.X; offsetY = y - Card.Y; }
    }
    internal void Drag(double x, double y)
    {
        if (Task != 3 || !dragging) return;
        if (Math.Abs(x - offsetX - Card.X) + Math.Abs(y - offsetY - Card.Y) < 1) return;
        Dragged++; Card = Card with { X = x - offsetX, Y = y - offsetY };
    }
    internal void Up(double x, double y)
    {
        MouseUp++;
        if (Task == 1) {
            if (confirmDown && Confirm.Contains(x, y)) { CorrectClicks++; Passed = true; }
            else WrongClicks++;
            confirmDown = false;
        }
        if (Task == 3 && dragging && Dragged >= 2 && Destination.Contains(x, y) && Destination.Contains(Card.X + Card.Width / 2, Card.Y + Card.Height / 2)) Passed = true;
        dragging = false;
    }
    internal void ObserveText(string value) => text = value;
    internal void Submit() { if (Task != 2) return; Submitted = true; Passed = string.Equals(text, Note, StringComparison.Ordinal); }
    internal object Snapshot() => new { task = Task, passed = Passed, correctClicks = CorrectClicks, wrongClicks = WrongClicks, mouseDown = MouseDown, mouseUp = MouseUp, dragged = Dragged, submitted = Submitted, textMatches = string.Equals(text, Note, StringComparison.Ordinal) };
}
