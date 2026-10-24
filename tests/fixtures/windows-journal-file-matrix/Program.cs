using QiuYaTools.Windows;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// Standalone file-system matrix. No desktop, input, screenshot, process query or OS signal APIs.
internal static class Program
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly byte[] Old = Encoding.UTF8.GetBytes("{\"Version\":1,\"OwnerId\":\"00112233445566778899aabbccddeeff\",\"Keys\":[],\"MouseButtons\":[],\"UnicodeUnits\":[]}");
    private static readonly byte[] New = Encoding.UTF8.GetBytes("{\"Version\":1,\"OwnerId\":\"00112233445566778899aabbccddeeff\",\"Keys\":[],\"MouseButtons\":[4],\"UnicodeUnits\":[]}");
    private static readonly Stopwatch Budget = Stopwatch.StartNew();
    private static readonly List<object> Rows = new();
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static void Guard() { if (Budget.ElapsedMilliseconds > 25000) throw new TimeoutException("file-matrix-budget"); }
    private static void Write(string path, byte[] bytes) { Guard(); using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None); file.Write(bytes); file.Flush(true); }
    private static void Publish(string source, string destination, bool? replace)
    {
        Guard();
        if (replace == null) AtomicJournalPublish.Publish(source, destination);
        else if (replace == true && File.Exists(destination)) File.Replace(source, destination, null, false);
        else File.Move(source, destination, replace == false);
    }
    private static (string kind, int hresult, int nativeError) Error(Exception error) => (error.GetType().Name, error.HResult, (uint)error.HResult >> 16 == 0x8007 ? error.HResult & 0xffff : 0);
    private static byte[] ReadHeld(FileStream file) { file.Position = 0; using var buffer = new MemoryStream(); file.CopyTo(buffer); return buffer.ToArray(); }
    private static string Strategy(bool? replace) => replace == null ? "FileRenameInfoEx-replace-posix" : replace.Value ? "File.Replace-or-create-new" : "File.Move-overwrite";
    private static string Prefix(bool? replace) => replace == null ? "posix" : replace.Value ? "replace" : "move";
    private static void Matrix(string directory, string name, FileShare share, bool? replace)
    {
        Guard();
        var target = Path.Combine(directory, name + ".json"); var temporary = Path.Combine(directory, name + ".tmp");
        Write(target, Old); Write(temporary, New);
        using var reader = new FileStream(target, FileMode.Open, FileAccess.Read, share);
        Exception? failure = null;
        var started = Budget.ElapsedTicks;
        try { Publish(temporary, target, replace); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { failure = error; }
        var elapsed = Budget.ElapsedTicks - started;
        var held = ReadHeld(reader); var current = File.ReadAllBytes(target);
        var sourceExists = File.Exists(temporary); var success = failure == null;
        if (!held.AsSpan().SequenceEqual(Old)) throw new Exception("old-reader-content-changed");
        if (success && (!current.AsSpan().SequenceEqual(New) || sourceExists)) throw new Exception("publish-not-exact-new-record");
        if (!success && (!current.AsSpan().SequenceEqual(Old) || !sourceExists || !File.ReadAllBytes(temporary).AsSpan().SequenceEqual(New))) throw new Exception("failed-publish-lost-durable-record");
        var e = failure == null ? ("", 0, 0) : Error(failure);
        Rows.Add(new { name, strategy = Strategy(replace), share = share.ToString(), success, exceptionKind=e.Item1, hresult=e.Item2, nativeError=e.Item3, sourcePresent=sourceExists, oldHandleUnchanged=true, currentSHA256=Hash(current), elapsedTicks=elapsed });
    }
    private static void Missing(string directory, bool? replace)
    {
        var name = Prefix(replace)+"-first"; var target=Path.Combine(directory,name+".json"); var source=Path.Combine(directory,name+".tmp");
        Write(source,New); Publish(source,target,replace);
        if(File.Exists(source)||!File.ReadAllBytes(target).AsSpan().SequenceEqual(New))throw new Exception("initial-create-not-exact");
        Rows.Add(new{name,strategy=Strategy(replace),success=true,currentSHA256=Hash(New)});
    }
    private static void DirectoryTarget(string directory, bool? replace)
    {
        var name=Prefix(replace)+"-directory";var target=Path.Combine(directory,name); Directory.CreateDirectory(target);var source=Path.Combine(directory,name+".tmp");Write(source,New);
        Exception? failure=null;try{Publish(source,target,replace);}catch(Exception error)when(error is IOException or UnauthorizedAccessException){failure=error;}
        if(failure==null||!Directory.Exists(target)||!File.ReadAllBytes(source).AsSpan().SequenceEqual(New))throw new Exception("directory-error-not-fail-closed");
        var e=Error(failure);Rows.Add(new{name,strategy=Strategy(replace),success=false,expectedRejection=true,exceptionKind=e.kind,hresult=e.hresult,nativeError=e.nativeError,durableSourceRetained=true});
    }
    private static void ConcurrentReaders(string directory, bool? replace)
    {
        var name=Prefix(replace)+"-concurrent";var target=Path.Combine(directory,name+".json");Write(target,Old);
        var failures=new List<object>();var reads=0;var invalid=0;using var cancellation=new CancellationTokenSource();using var started=new ManualResetEventSlim();
        var reader=Task.Run(()=> { started.Set(); while(!cancellation.IsCancellationRequested) { try { using var held=new FileStream(target,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Delete); var bytes=ReadHeld(held); if(!bytes.AsSpan().SequenceEqual(Old)&&!bytes.AsSpan().SequenceEqual(New))Interlocked.Increment(ref invalid); Interlocked.Increment(ref reads); Thread.Sleep(1); } catch(IOException){} catch(UnauthorizedAccessException){} } });
        if(!started.Wait(1000))throw new Exception("reader-not-ready");
        var succeeded=0;
        try { for(var i=0;i<64;i++) { Guard();var source=Path.Combine(directory,name+"-"+i+".tmp");Write(source,i%2==0?New:Old);try{Publish(source,target,replace);succeeded++;}catch(Exception error)when(error is IOException or UnauthorizedAccessException){var e=Error(error);if(failures.Count<16)failures.Add(new{iteration=i,kind=e.kind,hresult=e.hresult,nativeError=e.nativeError});} } }
        finally { cancellation.Cancel();if(!reader.Wait(1500))throw new Exception("reader-not-retired"); }
        if(invalid!=0)throw new Exception("partial-record-observed");
        Rows.Add(new{name,strategy=Strategy(replace),attempts=64,succeeded,failures,readerObservations=reads,invalidPartialRecords=invalid,readOnlyReaderNaturallyRetired=true});
    }
    private static void LayoutTests()
    {
        const string path="C:\\QiuYaTools\\你好\\owned-input.json";var bytes=AtomicJournalPublish.EncodeRenameInfo(path);var offset=AtomicJournalPublish.NameOffset;
        if(IntPtr.Size!=8||offset!=20)throw new Exception("rename-layout-unexpected");
        if(System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(bytes)!=3)throw new Exception("rename-flags-weakened");
        if(bytes.AsSpan(4,12).IndexOfAnyExcept((byte)0)>=0)throw new Exception("rename-root-or-padding-not-zero");
        if(System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(16))!=Encoding.Unicode.GetByteCount(path)||Encoding.Unicode.GetString(bytes.AsSpan(offset,bytes.Length-offset-2))!=path||bytes[^1]!=0||bytes[^2]!=0)throw new Exception("rename-path-not-exact");
        Rows.Add(new{name="public-rename-layout",success=true,nameOffset=offset,flags=3,noIgnoreReadonly=true,exactUtf16=true,nulTerminated=true,lengthExcludesTerminator=true});
    }
    private static void Main(string[] args)
    {
        if(args.Length==1 && args[0]=="--encode-layout") { Console.WriteLine(JsonSerializer.Serialize(new{bytes=Convert.ToBase64String(AtomicJournalPublish.EncodeRenameInfo("C:\\QiuYaTools\\你好\\owned-input.json")),nameOffset=AtomicJournalPublish.NameOffset}));return; }
        var root=Path.Combine(Path.GetTempPath(),"QiuYaTools-journal-matrix-"+Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root); string? failure=null;var cleaned=false;
        try {
            LayoutTests();Missing(root,false);Missing(root,true);DirectoryTarget(root,false);DirectoryTarget(root,true);if(OperatingSystem.IsWindows()){Missing(root,null);DirectoryTarget(root,null);}
            if(OperatingSystem.IsWindows()) {
                foreach(var replace in new bool?[]{false,true,null}) {
                    Matrix(root,Prefix(replace)+"-read-delete",FileShare.Read|FileShare.Delete,replace);
                    Matrix(root,Prefix(replace)+"-readwrite-delete",FileShare.ReadWrite|FileShare.Delete,replace);
                    Matrix(root,Prefix(replace)+"-read-only",FileShare.Read,replace);
                    ConcurrentReaders(root,replace);
                }
            }
        } catch(Exception error) { var e=Error(error);failure=e.kind+":"+e.nativeError;Environment.ExitCode=1; }
        finally {
            try { foreach(var path in Directory.EnumerateFiles(root))File.Delete(path);foreach(var path in Directory.EnumerateDirectories(root))Directory.Delete(path,false);Directory.Delete(root,false);cleaned=!Directory.Exists(root); }catch(Exception error){failure??="cleanup:"+error.GetType().Name;Environment.ExitCode=1;}
            Console.WriteLine(JsonSerializer.Serialize(new{status=failure==null?"completed-file-observation":"failed-file-observation",failure,platform=OperatingSystem.IsWindows()?"win32":"prepare-host-unix",architecture=System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString(),processId=Environment.ProcessId,createdAtTicks=Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString(),sessionId=Process.GetCurrentProcess().SessionId,oldSHA256=Hash(Old),newSHA256=Hash(New),rows=Rows,elapsedMilliseconds=Budget.ElapsedMilliseconds,stopwatchFrequency=Stopwatch.Frequency,ownTemporaryCleaned=cleaned,nativeInputCalls=0,guiCalls=0,captureCalls=0,signals=0,productionLeaseAccesses=0,retries=0,windowsMatrixExecuted=OperatingSystem.IsWindows()},Json));
        }
    }
}
