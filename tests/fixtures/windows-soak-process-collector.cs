// Test-only, short-lived read-only process sampler. C# 5 / .NET Framework 4.8.
// Compile before measurement; the sampler itself remains part of the owned tree.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Text;
#if !COLLECTOR_SELF_TEST
using System.Management;
using System.Web.Script.Serialization;
#endif

internal static class WindowsSoakProcessCollector
{
    internal const string Precision = "native-100ns-verified-against-CIM-microseconds";
    internal static bool CanOmitMissingCreation(int pid)
    {
        // PID 0 is the system Idle sentinel and cannot be a positive-PID owned child.
        // Unknown birth for any other WMI process must not disappear from RSS evidence.
        if (pid == 0) return true;
        throw new InvalidOperationException("Process CIM birth unavailable");
    }
    internal static bool Corroborates(long native, long cim)
    {
        return native > 0 && cim > 0 && cim % 10 == 0 && native - native % 10 == cim;
    }
    internal static bool HasMarker(string name, string command, string expectedName, string marker)
    {
        return !String.IsNullOrEmpty(marker) && !String.IsNullOrEmpty(command)
            && String.Equals(name, expectedName, StringComparison.OrdinalIgnoreCase)
            && command.IndexOf(marker, StringComparison.OrdinalIgnoreCase) >= 0;
    }
    internal static Dictionary<string, object> Project(int pid, int parent, string name, long cim,
        long? native, string path, long rss, long privateBytes, double cpu, string command,
        string marker, string fixture)
    {
        if (pid < 0 || parent < 0 || cim <= 0 || cim % 10 != 0 || rss < 0 || privateBytes < 0
            || Double.IsNaN(cpu) || Double.IsInfinity(cpu) || cpu < 0 || String.IsNullOrEmpty(name))
            throw new InvalidOperationException("Invalid process measurement");
        if (native.HasValue && !Corroborates(native.Value, cim)) return null; // exited/reused WMI row
        return new Dictionary<string, object> {
            {"pid", pid}, {"parentPid", parent}, {"name", name},
            {"createdAtTicks", native.HasValue ? native.Value.ToString(CultureInfo.InvariantCulture) : null},
            {"cimCreatedAtTicks", cim.ToString(CultureInfo.InvariantCulture)},
            {"identityPrecision", native.HasValue ? Precision : "unavailable"},
            {"executablePath", path}, {"workingSetBytes", rss}, {"privateBytes", privateBytes},
            {"cpuSeconds", cpu},
            {"ownedFixture", HasMarker(name, command, "powershell.exe", fixture)},
            {"ownedWebView", HasMarker(name, command, "msedgewebview2.exe", marker)}
        };
    }
#if COLLECTOR_SELF_TEST
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); }
    public static int Main(string[] args)
    {
        try {
            const long birth = 639281324193729179L, cim = 639281324193729170L;
            Check(Corroborates(birth, cim), "100ns identity");
            Check(!Corroborates(birth + 10, cim), "reused PID");
            Check(!Corroborates(birth, cim + 1), "CIM precision");
            Check(!Corroborates(0, 0), "zero identity");
            Dictionary<string, object> row = Project(12, 11, "msedgewebview2.exe", cim, birth,
                "C:\\owned\\browser.exe", 123, 99, 1.25, "browser --user-data-dir=C:\\uuid", "C:\\uuid", "C:\\fixture.ps1");
            Check(row.Count == 12 && (string)row["createdAtTicks"] == birth.ToString(), "finite projection");
            Check((bool)row["ownedWebView"] && !(bool)row["ownedFixture"] && !row.ContainsKey("commandLine"), "no command contents");
            Check(Project(12, 11, "x.exe", cim, birth + 10, null, 1, 1, 0, null, "", "") == null, "mismatch omitted");
            row = Project(12, 11, "x.exe", cim, null, null, 1, 1, 0, null, "", "");
            Check(row["createdAtTicks"] == null && (string)row["identityPrecision"] == "unavailable", "live inaccessible retained");
            Check(HasMarker("PowerShell.EXE", "x C:\\Own.ps1", "powershell.exe", "c:\\own.ps1"), "fixture case");
            Check(!HasMarker("other.exe", "marker", "msedgewebview2.exe", "marker") && !HasMarker("msedgewebview2.exe", "x", "msedgewebview2.exe", ""), "no broad adoption");
            bool rejected = false; try { Project(1, 1, "x", cim, birth, null, -1, 0, 0, null, "", ""); } catch (InvalidOperationException) { rejected = true; }
            Check(rejected, "negative measurement rejected");
            Check(CanOmitMissingCreation(0), "only Idle sentinel may omit absent CIM birth");
            rejected = false; try { CanOmitMissingCreation(12); } catch (InvalidOperationException) { rejected = true; }
            Check(rejected, "unknown live owner birth fails closed");
            Console.WriteLine("{\"passed\":true,\"checks\":13,\"windowsWmiExecuted\":false}"); return 0;
        } catch (Exception) { Console.Error.WriteLine("collector-self-test-failed"); return 1; }
    }
#else
    public static int Main(string[] args)
    {
        try {
            if (args.Length != 2 || String.IsNullOrEmpty(args[0]) || String.IsNullOrEmpty(args[1]))
                throw new InvalidOperationException("Expected own data directory and fixture path");
            Console.OutputEncoding = new UTF8Encoding(false);
            Stopwatch clock = Stopwatch.StartNew();
            List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
            const string query = "SELECT ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime,CommandLine FROM Win32_Process";
            EnumerationOptions options = new EnumerationOptions();
            options.ReturnImmediately = false; options.Timeout = TimeSpan.FromSeconds(20);
            using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("root\\cimv2", query, options))
            using (ManagementObjectCollection found = searcher.Get()) {
                foreach (ManagementObject item in found) {
                    using (item) {
                        if (clock.ElapsedMilliseconds > 20000 || rows.Count >= 4096) throw new InvalidOperationException("Collector budget exceeded");
                        int pid = Convert.ToInt32(item["ProcessId"], CultureInfo.InvariantCulture);
                        string creation = Convert.ToString(item["CreationDate"], CultureInfo.InvariantCulture);
                        if (String.IsNullOrEmpty(creation) && CanOmitMissingCreation(pid)) continue;
                        long cim = ManagementDateTimeConverter.ToDateTime(creation).ToUniversalTime().Ticks;
                        long? native = null; bool gone = false;
                        try {
                            using (Process process = Process.GetProcessById(pid)) {
                                // Pin before StartTime and retain that exact handle until after the read.
                                var handle = process.SafeHandle;
                                native = process.StartTime.ToUniversalTime().Ticks;
                                GC.KeepAlive(handle);
                            }
                        } catch {
                            try { using (Process check = Process.GetProcessById(pid)) { gone = check.HasExited; } }
                            catch (ArgumentException) { gone = true; }
                            catch { /* Retain a live inaccessible row; ownership must fail closed. */ }
                        }
                        if (gone) continue;
                        Dictionary<string, object> projected = Project(pid,
                            Convert.ToInt32(item["ParentProcessId"], CultureInfo.InvariantCulture),
                            Convert.ToString(item["Name"], CultureInfo.InvariantCulture), cim, native,
                            item["ExecutablePath"] as string,
                            Convert.ToInt64(item["WorkingSetSize"], CultureInfo.InvariantCulture),
                            Convert.ToInt64(item["PrivatePageCount"], CultureInfo.InvariantCulture),
                            (Convert.ToDouble(item["KernelModeTime"], CultureInfo.InvariantCulture) + Convert.ToDouble(item["UserModeTime"], CultureInfo.InvariantCulture)) / 10000000,
                            item["CommandLine"] as string, args[0], args[1]);
                        if (projected != null) rows.Add(projected);
                    }
                }
            }
            JavaScriptSerializer serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = 8 * 1024 * 1024;
            string json = serializer.Serialize(rows);
            if (clock.ElapsedMilliseconds > 20000 || Encoding.UTF8.GetByteCount(json) > 8 * 1024 * 1024) throw new InvalidOperationException("Collector output budget exceeded");
            Console.WriteLine(json); return 0;
        } catch (Exception error) {
            // Exception type only: WMI error messages can include unrelated machine paths.
            Console.Error.WriteLine("collector-failed:" + error.GetType().Name); return 1;
        }
    }
#endif
}
