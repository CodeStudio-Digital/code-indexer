using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Spawn suspended: no test code runs before the kernel owns its entire tree.
// The only job handle belongs to this supervisor. Closing it also kills children
// after a supervisor crash; detached Node/Rust processes cannot opt out.
public static class TestProcessJob {
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public Limits Basic; public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] struct Completion { public IntPtr Key, Port; }
    [StructLayout(LayoutKind.Sequential)] struct Security { public uint Size; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public uint Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedPtr, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint concurrency);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr pid, uint timeout);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string file, uint access, uint share, ref Security security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool value, string operation) { if (!value) { int code = Marshal.GetLastWin32Error(); throw new Win32Exception(code, operation + ": " + new Win32Exception(code).Message + " (" + code + ")"); } }
    static IntPtr Handle(IntPtr value, string operation) { Check(value != IntPtr.Zero && value != new IntPtr(-1), operation); return value; }
    static void Set<T>(IntPtr job, int kind, T value) where T:struct {
        var ptr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T)));
        try { Marshal.StructureToPtr(value, ptr, false); Check(SetInformationJobObject(job, kind, ptr, (uint)Marshal.SizeOf(typeof(T))), "SetInformationJobObject"); }
        finally { Marshal.FreeHGlobal(ptr); }
    }
    static string Quote(string value) {
        var text = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); text.Append(c); slashes = 0;
        }
        text.Append('\\', slashes * 2); return text.Append('"').ToString();
    }
    static void Event(StreamWriter log, string kind, long pid) {
        string identity = "";
        if (kind == "started" || kind == "root-suspended" || kind == "supervisor") {
            try {
                using (var member = Process.GetProcessById(checked((int)pid))) {
                    identity = ",\"name\":\"" + member.ProcessName.Replace("\\", "\\\\").Replace("\"", "\\\"")
                        + "\",\"createdAt\":\"" + member.StartTime.ToUniversalTime().ToString("o") + "\"";
                }
            } catch { /* Short-lived children may exit before their notification is consumed. */ }
        }
        log.WriteLine("{\"at\":\"" + DateTime.UtcNow.ToString("o") + "\",\"event\":\"" + kind + "\",\"pid\":" + pid + identity + "}");
    }
    public static int Run(string executable, string[] args, string cwd, string directory, int timeoutSeconds) {
        IntPtr job=IntPtr.Zero, port=IntPtr.Zero, output=IntPtr.Zero, error=IntPtr.Zero, input=IntPtr.Zero;
        ProcessInfo process = new ProcessInfo(); bool assigned = false, timedOut = false, cleaned = false;
        uint code = 1, total = 0, terminated = 0; int forced = 0;
        using (var log = new StreamWriter(Path.Combine(directory, "processes.jsonl"), false, new UTF8Encoding(false))) {
            log.AutoFlush = true; Event(log, "supervisor", Process.GetCurrentProcess().Id);
            try {
                job = Handle(CreateJobObjectW(IntPtr.Zero, null), "CreateJobObject");
                var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; Set(job, 9, limits);
                port = Handle(CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1), "CreateIoCompletionPort");
                Set(job, 7, new Completion { Key = new IntPtr(1), Port = port });
                var security = new Security { Size = (uint)Marshal.SizeOf(typeof(Security)), Inherit = 1 };
                output = Handle(CreateFileW(Path.Combine(directory, "stdout.log"), 0x40000000, 3, ref security, 2, 0x80, IntPtr.Zero), "stdout");
                error = Handle(CreateFileW(Path.Combine(directory, "stderr.log"), 0x40000000, 3, ref security, 2, 0x80, IntPtr.Zero), "stderr");
                input = Handle(CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero), "stdin");
                var startup = new Startup { Size = (uint)Marshal.SizeOf(typeof(Startup)), Flags = 0x100, Input = input, Output = output, Error = error };
                var command = new StringBuilder(Quote(executable)); foreach (string arg in args) command.Append(' ').Append(Quote(arg));
                Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref startup, out process), "CreateProcess suspended");
                Event(log, "root-suspended", process.Pid);
                Check(AssignProcessToJobObject(job, process.Process), "AssignProcessToJobObject"); assigned = true;
                Check(ResumeThread(process.Thread) != uint.MaxValue, "ResumeThread");
                var watch = Stopwatch.StartNew(); long rootEnded = -1, killedAt = -1;
                while (true) {
                    uint message; UIntPtr key; IntPtr member;
                    if (GetQueuedCompletionStatus(port, out message, out key, out member, 100)) {
                        if (message == 6) Event(log, "started", member.ToInt64());
                        if (message == 7 || message == 8) Event(log, message == 7 ? "exited" : "abnormal-exit", member.ToInt64());
                    }
                    Accounting state;
                    Check(QueryInformationJobObject(job, 1, out state, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "QueryJobAccounting");
                    total = state.TotalProcesses; terminated = state.TerminatedProcesses;
                    if (rootEnded < 0 && WaitForSingleObject(process.Process, 0) == 0) {
                        Check(GetExitCodeProcess(process.Process, out code), "GetExitCodeProcess"); rootEnded = watch.ElapsedMilliseconds;
                        Event(log, "root-exited", process.Pid);
                    }
                    if (state.ActiveProcesses == 0) {
                        // Drain queued PID notifications even when children finished between polls.
                        while (GetQueuedCompletionStatus(port, out message, out key, out member, 0)) {
                            if (message == 6) Event(log, "started", member.ToInt64());
                            if (message == 7 || message == 8) Event(log, "exited", member.ToInt64());
                        }
                        cleaned = true; break;
                    }
                    if (killedAt < 0 && (watch.Elapsed.TotalSeconds >= timeoutSeconds || (rootEnded >= 0 && watch.ElapsedMilliseconds - rootEnded >= 2000))) {
                        timedOut = rootEnded < 0; forced = (int)state.ActiveProcesses;
                        Event(log, "terminate-owned-tree", process.Pid);
                        Check(TerminateJobObject(job, 124), "TerminateJobObject"); killedAt = watch.ElapsedMilliseconds;
                    }
                    if (killedAt >= 0 && watch.ElapsedMilliseconds - killedAt > 15000) throw new Exception("Owned processes did not settle after termination");
                }
                // Windows termination codes are unsigned (for example
                // 0xffffffff). Keep the exact code in cleanup.json while
                // returning a shell failure instead of throwing overflow.
                return timedOut ? 124 : code <= int.MaxValue ? (int)code : 1;
            } finally {
                if (process.Process != IntPtr.Zero && !assigned) TerminateProcess(process.Process, 125);
                if (job != IntPtr.Zero) { if (!cleaned) TerminateJobObject(job, 125); CloseHandle(job); }
                foreach (IntPtr handle in new[] {process.Thread, process.Process, input, output, error, port}) if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
                File.WriteAllText(Path.Combine(directory, "cleanup.json"), "{\"rootPid\":" + process.Pid + ",\"rootExitCode\":" + code + ",\"totalProcesses\":" + total + ",\"terminatedProcesses\":" + terminated + ",\"forcedCleanupCount\":" + forced + ",\"timedOut\":" + timedOut.ToString().ToLowerInvariant() + ",\"verifiedEmpty\":" + cleaned.ToString().ToLowerInvariant() + "}");
            }
        }
    }
}
