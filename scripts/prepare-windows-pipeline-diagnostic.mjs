/** Test-only clone instrumentation; formal Windows sources/bundles are never edited. */
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function diagnosticReplace(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Diagnostic source anchor changed: ' + before.slice(0, 100))
  return source.replace(before, after)
}
export function instrumentPipelineSource(name, source) {
  const replace = (a, b) => { source = diagnosticReplace(source, a, b) }
  if (name === 'Program.cs') {
    replace('        Console.InputEncoding = new UTF8Encoding(false);', '        PipelineTrace.Start(args);\n        Console.InputEncoding = new UTF8Encoding(false);')
    replace('        lock (OutputLock) { Console.WriteLine(JsonSerializer.Serialize(value, Json)); Console.Out.Flush(); }', `        PipelineTrace.Mark("emit-lock-wait");
        lock (OutputLock) {
            PipelineTrace.Mark("emit-serialize-start"); var line = JsonSerializer.Serialize(value, Json);
            PipelineTrace.Mark("emit-serialize-end", line.Length); PipelineTrace.Mark("emit-write-start", line.Length);
            Console.WriteLine(line); Console.Out.Flush(); PipelineTrace.Mark("emit-write-end", line.Length);
        }`)
    replace('                    var request = document.RootElement.Clone();', '                    var request = document.RootElement.Clone();\n                    PipelineTrace.Request("stdin-read", request, line.Length);')
    replace('                    dispatcher.BeginInvoke((Action)(() => _ = Dispatch(request)));', '                    PipelineTrace.Request("ui-dispatch-queued", request);\n                    dispatcher.BeginInvoke((Action)(() => _ = Dispatch(request)));')
    replace('        if (exiting) return;\n        if (!request.TryGetProperty("requestId", out var id)) return;', '        PipelineTrace.Enter(request); PipelineTrace.Mark("ui-dispatch-enter");\n        if (exiting) return;\n        if (!request.TryGetProperty("requestId", out var id)) return;')
    replace('"observe" => await Task.Run(() => computer.Observe(', '"observe" => await PipelineTrace.Run(() => computer.Observe(')
    replace('"targets" => await Task.Run(computer.Targets),', '"targets" => await PipelineTrace.Run(computer.Targets, "targets"),')
    replace('"applications" => await Task.Run(applications.Applications),', '"applications" => await PipelineTrace.Run(applications.Applications, "applications"),')
    replace('        } catch (Exception error) {\n            var code = error is NativeFailure', '        } catch (Exception error) {\n            PipelineTrace.Mark("dispatch-error");\n            var code = error is NativeFailure')
    replace('            try { computer?.Dispose(); inputReleased = true; }\n            catch (Exception) { Environment.ExitCode = 1; }', '            try { computer?.Dispose(); inputReleased = true; }\n            catch (Exception) { PipelineTrace.Mark("shutdown-cleanup-failed"); Environment.ExitCode = 1; }')
    replace('        exiting = true; parentWatch.Stop();', '        PipelineTrace.Mark("shutdown-start"); exiting = true; parentWatch.Stop();')
  } else if (name === 'ComputerDriver.cs') {
    replace('    internal object[] Targets()\n    {', '    internal object[] Targets()\n    {\n        PipelineTrace.Mark("targets-enumerate-enter");')
    replace('                var title = WindowTitle(handle);', '                PipelineTrace.Mark("target-title-start", pid); var title = WindowTitle(handle); PipelineTrace.Mark("target-title-end", pid);')
    replace('                var born = process.StartTime.ToUniversalTime().Ticks;', '                PipelineTrace.Mark("target-birth-start", pid); var born = process.StartTime.ToUniversalTime().Ticks; PipelineTrace.Mark("target-birth-end", pid);')
    replace('                var imagePath = Path.GetFullPath(process.MainModule?.FileName ?? throw new InvalidOperationException());', '                PipelineTrace.Mark("target-path-start", pid); var imagePath = Path.GetFullPath(process.MainModule?.FileName ?? throw new InvalidOperationException()); PipelineTrace.Mark("target-path-end", pid);')
    replace('        return targets.ToArray();', '        PipelineTrace.Mark("targets-enumerate-return", targets.Count); return targets.ToArray();')
    replace('    private static (IntPtr Handle, Rectangle Rect) Target(string id)\n    {', '    private static (IntPtr Handle, Rectangle Rect) Target(string id)\n    {\n        PipelineTrace.Mark("target-resolve-enter");')
    replace('        try { using var process = Process.GetProcessById((int)pid); if (process.StartTime.ToUniversalTime().Ticks != born)', '        PipelineTrace.Mark("target-resolve-birth-start", pid);\n        try { using var process = Process.GetProcessById((int)pid); if (process.StartTime.ToUniversalTime().Ticks != born)')
    replace('        return (handle, Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom));', '        PipelineTrace.Mark("target-resolve-complete", pid); return (handle, Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom));')
    replace('    internal object Observe(string targetId, bool preview = false)\n    {', '    internal object Observe(string targetId, bool preview = false)\n    {\n        PipelineTrace.Mark("observe-enter", preview ? 1 : 0);')
    replace('        try { image = captureBroker.Capture(targetId); }', '        try { PipelineTrace.Mark("capture-start"); image = captureBroker.Capture(targetId); PipelineTrace.Mark("capture-end", image.Length); }')
    replace('        var elements = preview ? "" : ReadElements(target.Handle);', '        PipelineTrace.Mark("elements-call-start"); var elements = preview ? "" : ReadElements(target.Handle); PipelineTrace.Mark("elements-call-end", elements.Length);')
    replace('        var cursorPosition = Cursor.Position;', '        var cursorPosition = Cursor.Position; PipelineTrace.Mark("observe-return");')
    replace('        if (!accessibilityGate.Wait(0)) return "Previous accessibility request is still pending.";', '        PipelineTrace.Mark("uia-gate-enter");\n        if (!accessibilityGate.Wait(0)) { PipelineTrace.Mark("uia-gate-busy"); return "Previous accessibility request is still pending."; }')
    replace('        var task = Task.Run(() => {\n            try {\n                var root = AutomationElement.FromHandle(handle);', '        PipelineTrace.Mark("uia-task-queued");\n        var task = Task.Run(() => {\n            PipelineTrace.Mark("uia-task-enter");\n            try {\n                var root = AutomationElement.FromHandle(handle); PipelineTrace.Mark("uia-root-read");')
    replace('            finally { accessibilityGate.Release(); }', '            finally { PipelineTrace.Mark("uia-task-complete"); accessibilityGate.Release(); }')
    replace('        try { return task.Wait(6500) ? task.Result : "Accessibility tree timed out for this application."; }', '        try { PipelineTrace.Mark("uia-wait-start"); var complete = task.Wait(6500); PipelineTrace.Mark(complete ? "uia-wait-complete" : "uia-wait-timeout"); return complete ? task.Result : "Accessibility tree timed out for this application."; }')
  } else if (name === 'CaptureBroker.cs') {
    replace('                worker = startProcess(info) ?? throw new InvalidOperationException();', '                PipelineTrace.Mark("capture-process-start"); worker = startProcess(info) ?? throw new InvalidOperationException(); PipelineTrace.Mark("capture-process-started", worker.Id);')
    replace('                worker.ErrorDataReceived += (_, _) => { }; worker.BeginErrorReadLine();', '                PipelineTrace.Mark("capture-stderr-start"); worker.ErrorDataReceived += (_, _) => { }; worker.BeginErrorReadLine(); PipelineTrace.Mark("capture-stderr-end");')
    replace('                else { if (!process.HasExited) process.Kill(); exited = process.WaitForExit(retirementTimeout); }', '                else { PipelineTrace.Mark("capture-kill-start"); if (!process.HasExited) process.Kill(); PipelineTrace.Mark("capture-kill-end"); exited = process.WaitForExit(retirementTimeout); PipelineTrace.Mark("capture-exit-wait-end", exited ? 1 : 0); }')
    replace('                var process = GetWorker();', '                PipelineTrace.Mark("capture-worker-get"); var process = GetWorker(); PipelineTrace.Mark("capture-worker-ready", process.Id);')
    replace('                    var response = Task.Factory.StartNew(() => {', '                    PipelineTrace.Mark("capture-io-queued");\n                    var response = Task.Factory.StartNew(() => {\n                        PipelineTrace.Mark("capture-io-enter");')
    replace('                        return ReadReply(process.StandardOutput, requestId);', '                        PipelineTrace.Mark("capture-worker-write"); var reply = ReadReply(process.StandardOutput, requestId); PipelineTrace.Mark("capture-worker-reply", reply.Length); return reply;')
    replace('                        if (!response.Wait(captureTimeout)) throw new TimeoutException();', '                        PipelineTrace.Mark("capture-wait-start");\n                        if (!response.Wait(captureTimeout)) { PipelineTrace.Mark("capture-wait-timeout"); throw new TimeoutException(); }\n                        PipelineTrace.Mark("capture-wait-complete");')
    replace('                    Retire(process);', '                    PipelineTrace.Mark("capture-retire-start"); Retire(process); PipelineTrace.Mark("capture-retire-end");')
    replace('                var targetId = Program.Text(request, "targetId", 256);', '                PipelineTrace.Enter(request); PipelineTrace.Mark("worker-stdin-read");\n                var targetId = Program.Text(request, "targetId", 256);')
    replace('                var image = captureForTest != null ? captureForTest(targetId) : ComputerDriver.CaptureForWorker(targetId);', '                PipelineTrace.Mark("worker-capture-start"); var image = captureForTest != null ? captureForTest(targetId) : ComputerDriver.CaptureForWorker(targetId); PipelineTrace.Mark("worker-capture-end", image.Length);')
    replace('        Console.WriteLine(line); Console.Out.Flush();', '        PipelineTrace.Mark("worker-emit-write-start", line.Length); Console.WriteLine(line); Console.Out.Flush(); PipelineTrace.Mark("worker-emit-write-end", line.Length);')
  } else throw new Error('Unreviewed diagnostic source')
  return source
}
export const PIPELINE_TRACE_SOURCE = `using System.Diagnostics;
using System.Text.Json;
namespace QiuYaTools.Windows;
// Diagnostic clone only. Markers never write files or log protocol/user content.
internal static class PipelineTrace {
 private sealed record Context(long Request, string Op, int FirstGroup);
 private sealed record Row(long Sequence,string Phase,long Request,string Op,long Value,long Qpc,long UtcMs,int Thread,int Available,int Minimum,int Maximum,int ThreadCount,long Pending,long Completed,int Processors,bool Preserved);
 private static readonly object gate=new(); private static readonly Row?[] rows=new Row?[4096];
 private static readonly AsyncLocal<Context?> current=new(); private static readonly Dictionary<int,HashSet<long>> firstIds=new(); private static readonly int[] firstCounts=new int[4];
 private static long sequence; private static int tail; private static string? path; private static string mode="unknown";
 private static readonly HashSet<string> operations=new(){"status","applications","launchApplication","targets","observe","lease","release","act","openPreview","closePreview","open","close"};
 internal static void Start(string[] args) {
  var home=Environment.GetEnvironmentVariable("DSH_HOME");
  if(string.IsNullOrEmpty(home)||!home.Contains("qiuya-harness-e2e-",StringComparison.Ordinal)||!Directory.Exists(home))return;
  mode=args.Contains("--computer")?"computer":args.Contains("--capture-worker")?"capture-worker":"session";
  path=Path.Combine(home,$"native-pipeline-{Environment.ProcessId}.json");
  var thread=new Thread(()=>{while(true){try{Flush();}catch{}Thread.Sleep(250);}}){IsBackground=true,Name="QiuYaTools diagnostic snapshot"};thread.Start();Mark("trace-start");
 }
 private static Context Read(JsonElement value){
  if(value.ValueKind!=JsonValueKind.Object)return new(0,"other",0);long request=0;if(value.TryGetProperty("requestId",out var id)&&id.ValueKind==JsonValueKind.Number&&id.TryGetInt64(out var number)&&number>=0)request=number;
  var candidate=value.TryGetProperty("op",out var operation)&&operation.ValueKind==JsonValueKind.String?operation.GetString():null;var op=candidate!=null&&operations.Contains(candidate)?candidate:"other";
  var preview=value.TryGetProperty("preview",out var flag)&&flag.ValueKind==JsonValueKind.True;
  var group=op=="status"?1:op=="targets"?2:op=="observe"&&!preview||mode=="capture-worker"?3:0;
  if(request<=0)group=0;
  if(group>0)lock(gate){if(!firstIds.TryGetValue(group,out var selected)){selected=new();firstIds[group]=selected;}if(!selected.Contains(request)){if(selected.Count<2)selected.Add(request);else group=0;}}
  return new(request,op,group);
 }
 internal static void Enter(JsonElement request)=>current.Value=Read(request);
 internal static void Request(string phase,JsonElement request,long value=0){var previous=current.Value;current.Value=Read(request);try{Mark(phase,value);}finally{current.Value=previous;}}
 internal static void Mark(string phase,long value=0){if(path==null)return;var context=current.Value;ThreadPool.GetAvailableThreads(out var available,out _);ThreadPool.GetMinThreads(out var minimum,out _);ThreadPool.GetMaxThreads(out var maximum,out _);lock(gate){var next=++sequence;int group=context?.FirstGroup??0;int start=group==1?0:group==2?128:1024;int limit=group==1?128:group==2?896:1024;bool preserve=group>0&&firstCounts[group]<limit;int slot=preserve?start+firstCounts[group]++:2048+tail++%2048;rows[slot]=new(next,phase,context?.Request??0,context?.Op??"other",value,Stopwatch.GetTimestamp(),DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),Environment.CurrentManagedThreadId,available,minimum,maximum,ThreadPool.ThreadCount,ThreadPool.PendingWorkItemCount,ThreadPool.CompletedWorkItemCount,Environment.ProcessorCount,preserve);}}
 internal static Task<T> Run<T>(Func<T> operation,string label="observe"){Mark(label+"-outer-queued");return Task.Run(()=>{Mark(label+"-outer-enter");try{return operation();}finally{Mark(label+"-outer-complete");}});}
 private static void Flush(){var destination=path;if(destination==null)return;Row[] snapshot;long last;lock(gate){last=sequence;snapshot=rows.Where(row=>row!=null).Select(row=>row!).OrderBy(row=>row.Sequence).ToArray();}var bytes=JsonSerializer.SerializeToUtf8Bytes(new{version=1,pid=Environment.ProcessId,mode,frequency=Stopwatch.Frequency,capacity=rows.Length,sequence=last,firstStorage="status128-targets896-observe1024-tail2048",flushedUtcMs=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),records=snapshot},Program.Json);var temporary=destination+".tmp";File.WriteAllBytes(temporary,bytes);File.Move(temporary,destination,true);}

}
`
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export async function preparePipelineDiagnostic(output) {
  const root = fileURLToPath(new URL('../', import.meta.url)), clone = join(resolve(output), 'native-source')
  await mkdir(resolve(output), { recursive: true }); await cp(join(root, 'src/native/windows'), clone, { recursive: true, filter: source => !/(?:^|\/)(?:bin|obj)(?:\/|$)/u.test(source) })
  const sourceHashes = {}, diagnosticHashes = {}
  const sourceNames = (await readdir(join(root, 'src/native/windows'), { withFileTypes: true })).filter(value => value.isFile()).map(value => value.name).sort()
  for (const name of sourceNames) {
    const bytes = await readFile(join(clone, name)); sourceHashes[name] = digest(bytes)
    if (['Program.cs', 'ComputerDriver.cs', 'CaptureBroker.cs'].includes(name)) await writeFile(join(clone, name), instrumentPipelineSource(name, bytes.toString('utf8')))
    diagnosticHashes[name] = digest(await readFile(join(clone, name)))
  }
  await writeFile(join(clone, 'PipelineTrace.cs'), PIPELINE_TRACE_SOURCE); diagnosticHashes['PipelineTrace.cs'] = digest(PIPELINE_TRACE_SOURCE)
  const receipt = { kind: 'isolated-Windows-pipeline-diagnostic-clone', clone, sourceHashes, diagnosticHashes, shippingSourceChanged: false,
    thresholds: { captureMs: 2500, captureAttempts: 2, captureRetirementMs: 1500, uiaWaitMs: 6500, nativeRpcMs: 20000 }, boundedTrace: { capacity: 4096, flushMs: 250, markerFileWrites: 0, threadPoolFlush: false, payloadsRecorded: false } }
  await writeFile(join(resolve(output), 'native-source-receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); return receipt
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.ok(process.argv[2], 'Pass a fresh own diagnostic output directory')
  console.log(JSON.stringify(await preparePipelineDiagnostic(process.argv[2]), null, 2))
}
