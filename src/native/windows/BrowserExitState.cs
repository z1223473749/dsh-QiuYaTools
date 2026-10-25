namespace QiuYaTools.Windows;

/** One environment, one initialization, and its exact browser process-group exit. */
internal sealed class BrowserExitState
{
    private readonly object gate = new();
    private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly HashSet<uint> earlyExits = new();
    private uint browserProcessId;
    private bool initialized, noBrowser;
    internal Task Completion => completion.Task;
    internal bool CanDisposeView { get { lock (gate) return initialized; } }

    internal void BrowserCreated(uint processId)
    {
        lock (gate) {
            if (processId == 0 || noBrowser || browserProcessId != 0) throw new InvalidOperationException("Browser lifetime identity is unavailable");
            browserProcessId = processId;
            TryComplete();
        }
    }
    internal void BrowserExited(uint processId)
    {
        lock (gate) {
            if (processId == 0) return;
            if (browserProcessId == 0 && earlyExits.Count >= 8 && !earlyExits.Contains(processId)) {
                completion.TrySetException(new InvalidOperationException("Browser lifetime exit identity is unavailable"));
                return;
            }
            if (browserProcessId == 0 || browserProcessId == processId) earlyExits.Add(processId);
            TryComplete();
        }
    }
    internal void NoBrowserCreated()
    {
        lock (gate) {
            if (browserProcessId != 0) throw new InvalidOperationException("Browser lifetime already owns a process");
            noBrowser = true;
        }
    }
    internal void InitializationFinished()
    {
        lock (gate) { initialized = true; TryComplete(); }
    }
    internal void InitializationFailed()
    {
        completion.TrySetException(new InvalidOperationException("Browser lifetime initialization did not complete"));
    }
    private void TryComplete()
    {
        if (initialized && (noBrowser || browserProcessId != 0 && earlyExits.Contains(browserProcessId))) completion.TrySetResult();
    }
}
