<#
.SYNOPSIS
Runs the test runner on a second, invisible Windows desktop.

.DESCRIPTION
The VS Code test host is an Electron application, so the window it opens becomes the
foreground window and takes focus from whatever else the developer is doing. A window
can only take focus on the desktop that currently receives input, so a process started
on a newly created desktop can never steal focus from the interactive desktop.

Stdout and stderr are redirected to -LogPath, because the child has no console of its
own on that desktop. The launcher prints the log once the child exits.

There is deliberately no fallback. When the second desktop cannot be created, the run
fails instead of launching a window on the interactive desktop.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $NodeExecutable,
    [Parameter(Mandatory = $true)][string] $ScriptPath,
    [Parameter(Mandatory = $true)][string] $LogPath,
    [Parameter(Mandatory = $true)][string] $WorkingDirectory,
    [Parameter(Mandatory = $true)][int] $TimeoutSeconds
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class LmcrHiddenDesktop
{
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint GenericAll = 0x10000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint CreateAlways = 2;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x00000080;
    private const int StartfUseStdHandles = 0x00000100;
    private const uint CreateSuspended = 0x00000004;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const int ExtendedLimitInformation = 9;
    private const uint KillOnJobClose = 0x00002000;
    /** Exit code given to the killed process tree, the same code the runner uses for its own timeout. */
    private const uint KilledTreeExitCode = 124;
    /** The launcher's own timeout code, kept apart from 124 so its message prints only for the launcher's timer. */
    public const int LauncherTimeoutExitCode = 125;
    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved;
        public string Desktop;
        public string Title;
        public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public short ShowWindow;
        public short Reserved2Size;
        public IntPtr Reserved2;
        public IntPtr StdInput, StdOutput, StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public int ProcessId;
        public int ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformationBuffer
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktopW(string desktop, IntPtr device, IntPtr deviceMode, int flags, uint desiredAccess, IntPtr securityAttributes);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string fileName, uint desiredAccess, uint shareMode, ref SecurityAttributes securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    public static int Run(string nodeExecutable, string scriptPath, string logPath, string workingDirectory, int timeoutSeconds)
    {
        string desktopName = "lmcr-test-" + Guid.NewGuid().ToString("N");
        IntPtr desktop = CreateDesktopW(desktopName, IntPtr.Zero, IntPtr.Zero, 0, GenericAll, IntPtr.Zero);
        if (desktop == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktop failed for " + desktopName);
        }

        IntPtr logHandle = IntPtr.Zero;
        IntPtr nullHandle = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr processHandle = IntPtr.Zero;
        IntPtr threadHandle = IntPtr.Zero;
        try
        {
            SecurityAttributes inheritable = new SecurityAttributes();
            inheritable.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            inheritable.InheritHandle = true;

            logHandle = CreateFileW(logPath, GenericWrite, FileShareRead, ref inheritable, CreateAlways, FileAttributeNormal, IntPtr.Zero);
            if (logHandle == InvalidHandleValue)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "could not open " + logPath + " for the test host output");
            }

            nullHandle = CreateFileW("NUL", GenericRead, FileShareRead | FileShareWrite, ref inheritable, OpenExisting, 0, IntPtr.Zero);
            if (nullHandle == InvalidHandleValue)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "could not open NUL for the test host input");
            }

            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
            }
            SetKillOnJobClose(job);

            StartupInfo startupInfo = new StartupInfo();
            startupInfo.Size = Marshal.SizeOf(typeof(StartupInfo));
            startupInfo.Desktop = desktopName;
            startupInfo.Flags = StartfUseStdHandles;
            startupInfo.StdInput = nullHandle;
            startupInfo.StdOutput = logHandle;
            startupInfo.StdError = logHandle;

            StringBuilder commandLine = new StringBuilder("\"" + nodeExecutable + "\" \"" + scriptPath + "\" --hidden-desktop=" + desktopName);
            ProcessInformation processInformation;
            if (!CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, true, CreateSuspended, IntPtr.Zero, workingDirectory, ref startupInfo, out processInformation))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed for " + commandLine);
            }

            processHandle = processInformation.Process;
            threadHandle = processInformation.Thread;

            // The process is created suspended so every descendant inherits the job before
            // it can spawn, which is what makes the whole tree die with this run.
            if (!AssignProcessToJobObject(job, processHandle))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(processHandle, 1);
                throw new Win32Exception(error, "AssignProcessToJobObject failed");
            }
            if (ResumeThread(threadHandle) == 0xFFFFFFFFu)
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(processHandle, 1);
                throw new Win32Exception(error, "ResumeThread failed");
            }

            uint waitResult = WaitForSingleObject(processHandle, (uint)(timeoutSeconds * 1000));
            if (waitResult == WaitTimeout)
            {
                TerminateJobObject(job, KilledTreeExitCode);
                WaitForSingleObject(processHandle, 10000);
                return LauncherTimeoutExitCode;
            }
            if (waitResult != WaitObject0)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "waiting for the test host failed");
            }

            uint exitCode;
            if (!GetExitCodeProcess(processHandle, out exitCode))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "reading the test host exit code failed");
            }
            return unchecked((int)exitCode);
        }
        finally
        {
            if (threadHandle != IntPtr.Zero) CloseHandle(threadHandle);
            if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (nullHandle != IntPtr.Zero && nullHandle != InvalidHandleValue) CloseHandle(nullHandle);
            if (logHandle != IntPtr.Zero && logHandle != InvalidHandleValue) CloseHandle(logHandle);
            CloseDesktop(desktop);
        }
    }

    private static void SetKillOnJobClose(IntPtr job)
    {
        ExtendedLimitInformationBuffer information = new ExtendedLimitInformationBuffer();
        information.BasicLimitInformation.LimitFlags = KillOnJobClose;

        int size = Marshal.SizeOf(typeof(ExtendedLimitInformationBuffer));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, buffer, false);
            if (!SetInformationJobObject(job, ExtendedLimitInformation, buffer, (uint)size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
'@

[Console]::Error.WriteLine("Running the VS Code test host on an invisible desktop, so its window cannot take focus.")
try {
    $exitCode = [LmcrHiddenDesktop]::Run($NodeExecutable, $ScriptPath, $LogPath, $WorkingDirectory, $TimeoutSeconds)
}
catch {
    [Console]::Error.WriteLine("Hidden desktop launcher: $($_.Exception.Message)")
    [Console]::Error.WriteLine("Hidden desktop launcher: no window was opened, because a fallback to the interactive desktop would steal focus.")
    exit 1
}

if (Test-Path -LiteralPath $LogPath) {
    # The test host writes UTF-8, and the console would otherwise encode the reporter's
    # symbols with its own code page.
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $log = [System.IO.File]::ReadAllText($LogPath, [System.Text.Encoding]::UTF8)
    if ($log) {
        [Console]::Out.Write($log)
    }
}

if ($exitCode -eq [LmcrHiddenDesktop]::LauncherTimeoutExitCode) {
    [Console]::Error.WriteLine("Hidden desktop launcher: the test host did not finish within $TimeoutSeconds seconds and was terminated.")
}

exit $exitCode
