using System.Text.Json;
using QiuYaTools.VisualAcceptance;
static void Check(bool value) { if (!value) throw new Exception("Independent business oracle self-test failed"); }
const string nonce = "A1B2C3", note = "青山路18号，请轻放，核验码A1B2C3";
foreach (int seed in new[] { 0, 1, 122, 65535 }) {
    var click = new BusinessCore(1, nonce, note, seed);
    Check(!click.Passed);
    click.Down(click.Decoy.X + 20, click.Decoy.Y + 20); click.Up(click.Decoy.X + 20, click.Decoy.Y + 20);
    Check(!click.Passed && click.WrongClicks == 1);
    click.Down(click.Confirm.X + 20, click.Confirm.Y + 20); Check(!click.Passed);
    click.Up(click.Confirm.X + 20, click.Confirm.Y + 20); Check(click.Passed && click.CorrectClicks == 1 && click.MouseDown == click.MouseUp);
    var drag = new BusinessCore(3, nonce, note, seed);
    drag.Down(drag.Destination.X + 50, drag.Destination.Y + 50); drag.Drag(drag.Destination.X + 80, drag.Destination.Y + 50); drag.Up(drag.Destination.X + 80, drag.Destination.Y + 50); Check(!drag.Passed);
    double sx = drag.Card.X + 90, sy = drag.Card.Y + 40, dx = drag.Destination.X + 90, dy = drag.Destination.Y + 80;
    drag.Down(sx, sy); drag.Drag((sx + dx) / 2, (sy + dy) / 2); drag.Drag(dx, dy); Check(!drag.Passed); drag.Up(dx, dy); Check(drag.Passed && drag.Dragged == 2);
}
var input = new BusinessCore(2, nonce, note, 0);
input.ObserveText("青山路 18 号，请轻放，核验码 A1B2C3"); input.Submit(); Check(input.Submitted && !input.Passed);
input.ObserveText(note); Check(!input.Passed); input.Submit(); Check(input.Passed);
Check(!JsonSerializer.Serialize(input.Snapshot()).Contains(nonce));
Check(!JsonSerializer.Serialize(input.Snapshot()).Contains(note));
foreach (var bad in new[] { (0, nonce, note, 1), (1, "SECRET7", note, 1), (2, nonce, note, -1) }) {
    bool rejected = false; try { _ = new BusinessCore(bad.Item1, bad.Item2, bad.Item3, bad.Item4); } catch (ArgumentException) { rejected = true; } Check(rejected);
}
Console.WriteLine(JsonSerializer.Serialize(new { passed = true, actualGuiStarted = false, actualInputPosted = false, task1CompletedClick = true, task2ExactTextAndSubmission = true, task3RealDragSequence = true, initialAnswerNotInOracle = true, randomizedSides = 4 }));
