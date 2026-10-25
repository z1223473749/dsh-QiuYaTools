using System.Diagnostics;
using System.Text.Json;
using QiuYaTools.Windows;

var tests = new List<object>();
void Check(bool value, string name) { if (!value) throw new Exception(name); tests.Add(new { name, passed = true }); }
async Task<bool> Completes(Task task, int budget = 100) { try { await task.WaitAsync(TimeSpan.FromMilliseconds(budget)); return true; } catch (TimeoutException) { return false; } }
var live = new BrowserExitState(); Check(!live.CanDisposeView,"pending-creation-defers-view-disposal"); live.BrowserCreated(23); live.InitializationFinished(); Check(live.CanDisposeView,"completed-initialization-allows-deferred-view-close");
// Red control: the old native shutdown treated Dispose returning as proof and exited now.
Check(!live.Completion.IsCompleted, "legacy-form-dispose-is-not-browser-retirement-red-control");
live.BrowserExited(999); Check(!live.Completion.IsCompleted, "different-browser-exit-never-retires-original");
live.BrowserExited(23); Check(await Completes(live.Completion), "exact-environment-browser-process-group-exit-completes");
var early = new BrowserExitState(); early.BrowserExited(32); early.BrowserCreated(32);
Check(!early.Completion.IsCompleted, "exit-before-ready-still-waits-initialization-finally");
early.InitializationFinished(); Check(await Completes(early.Completion), "early-exact-exit-is-not-lost-after-browser-bind");
var canceled = new BrowserExitState(); canceled.NoBrowserCreated(); canceled.InitializationFinished(); Check(await Completes(canceled.Completion), "closed-before-initialization-start-does-not-create-browser");
var failed = new BrowserExitState(); failed.InitializationFailed(); failed.InitializationFinished();
try { await failed.Completion; throw new Exception("failure should reject"); } catch (InvalidOperationException) { Check(true, "unknown-initialization-fails-closed"); }
var a = new BrowserExitState(); var b = new BrowserExitState(); a.BrowserCreated(41); b.BrowserCreated(42); a.InitializationFinished(); b.InitializationFinished(); a.BrowserExited(41);
Check(!Task.WhenAll(a.Completion, b.Completion).IsCompleted, "previously-closed-lifetime-remains-in-whole-shutdown-barrier");
b.BrowserExited(42); Check(await Completes(Task.WhenAll(a.Completion,b.Completion)), "all-original-groups-required-before-native-exit");
var pump = new BrowserExitState(); pump.BrowserCreated(51); pump.InitializationFinished();
var posted = Task.Run(async () => { await Task.Yield(); pump.BrowserExited(51); });
Check(await Completes(pump.Completion), "await-does-not-block-asynchronous-exit-delivery"); await posted;
var alive = new BrowserExitState(); alive.BrowserCreated(61); alive.InitializationFinished(); var clock=Stopwatch.StartNew();
Check(!await Completes(alive.Completion,25) && clock.ElapsedMilliseconds < 1000, "still-alive-fails-original-bound-without-kill-or-extension");
alive.BrowserExited(61); Check(await Completes(alive.Completion), "late-event-can-release-resources-but-does-not-change-prior-timeout");
SessionPreparationControl.Run(Check);
Console.WriteLine(JsonSerializer.Serialize(new { passed=true, tests, source="production BrowserExitState.cs exact linked source and BrowserWindows.cs session FormClosed callback", GUI=0, Host=0, PD=0, model=0, input=0, nativeWindows=0 }));

namespace QiuYaTools.Windows
{
    // The delayed window is a platform double. Attach is compiled from the actual
    // production FormClosed delegate by the Node runner; no GUI or WebView is started.
    internal sealed partial class SessionPreparationControl
    {
        private readonly Dictionary<string, TestWindow> sessions = new();
        private string? prepared;
        private TestWindow Prepare(string id, bool legacy = false)
        {
            if (sessions.TryGetValue(id, out var previous)) previous.Close();
            prepared = id;
            var window = new TestWindow();
            sessions[id] = window;
            if (legacy) AttachLegacy(id, window); else Attach(id, window);
            return window;
        }
        private void Cancel(string id)
        {
            if (prepared == id) {
                prepared = null;
                if (sessions.TryGetValue(id, out var hidden) && hidden.Prepared) hidden.Close();
            }
        }
        internal static void Run(Action<bool, string> check)
        {
            const string id = "same-owned-session";
            var legacy = new SessionPreparationControl();
            var oldLegacy = legacy.Prepare(id, legacy: true);
            legacy.Cancel(id);
            var replacementLegacy = legacy.Prepare(id, legacy: true);
            oldLegacy.CompleteInitialization();
            legacy.Cancel(id);
            check(legacy.sessions.GetValueOrDefault(id) == replacementLegacy && replacementLegacy.CloseCalls == 0,
                "legacy-stale-close-clears-new-preparation-red-control");

            var current = new SessionPreparationControl();
            var old = current.Prepare(id);
            current.Cancel(id);
            var replacement = current.Prepare(id);
            old.CompleteInitialization();
            check(current.prepared == id && current.sessions.GetValueOrDefault(id) == replacement,
                "stale-canceled-window-close-keeps-new-preparation");
            current.Cancel(id);
            check(replacement.CloseCalls == 1 && current.prepared == null,
                "same-session-replacement-remains-cancellable");

            var own = new SessionPreparationControl();
            var ownWindow = own.Prepare(id);
            ownWindow.CompleteInitialization();
            ownWindow.Close();
            check(own.prepared == null && !own.sessions.ContainsKey(id), "current-window-close-clears-own-preparation");

            var different = new SessionPreparationControl();
            var other = different.Prepare("old-owned-session");
            var selected = different.Prepare("new-owned-session");
            other.CompleteInitialization();
            other.Close();
            check(different.prepared == "new-owned-session" && different.sessions.GetValueOrDefault("new-owned-session") == selected,
                "different-session-close-keeps-current-preparation");
        }
        private sealed class TestWindow
        {
            internal event EventHandler? FormClosed;
            internal bool Prepared => true;
            internal int CloseCalls { get; private set; }
            private bool initialized, closeRequested, closed;
            internal void Close()
            {
                CloseCalls++;
                closeRequested = true;
                if (initialized && !closed) { closed = true; FormClosed?.Invoke(this, EventArgs.Empty); }
            }
            internal void CompleteInitialization()
            {
                initialized = true;
                if (closeRequested) Close();
            }
        }
    }
}
