using System.Collections.Concurrent;
using System.Diagnostics;

namespace QiuYaTools.Windows;

/// Opt-in, bounded numeric diagnostics for isolated input-latency tests. Never records keys, text or coordinates.
internal static class InputTrace
{
    internal static readonly bool Enabled = Environment.GetEnvironmentVariable("QIUYA_WINDOWS_INPUT_TRACE") == "1";
    private static readonly ConcurrentQueue<object> records = new();
    internal static void Mark(string phase, long epoch = 0, long value = 0)
    {
        if (!Enabled) return;
        records.Enqueue(new { phase, epoch, value, ticks = Stopwatch.GetTimestamp(), thread = Environment.CurrentManagedThreadId });
        while (records.Count > 1024) records.TryDequeue(out _);
    }
    internal static object Snapshot() => new { frequency = Stopwatch.Frequency, records = records.ToArray() };
}
