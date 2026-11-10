import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";
import process from "node:process";
import console from "node:console";

// Exit code for test timeout (unique identifier for timeout-related failures)
const TIMEOUT_EXIT_CODE = 124; // Traditional timeout command uses 124

// Maximum time to allow the test process to run (in milliseconds).
// The suite itself runs for about 45 s, and VS Code takes several seconds to
// launch and exit on Windows, so the default leaves headroom instead of
// killing a green run. Override with TEST_TIMEOUT_MS when needed.
const TEST_TIMEOUT_MS = (() => {
    const configured = Number(process.env.TEST_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : 300000;
})();

/**
 * Remove directory contents without removing the directory itself.
 * This handles mount points where we cannot remove the mount point directory.
 */
function clearDirectory(dirPath) {
  if (!existsSync(dirPath)) {
    return;
  }

  const entries = readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    try {
      rmSync(fullPath, { recursive: true, force: true });
    } catch (err) {
      // If we can't remove it (e.g., mount point), log and continue
      console.warn(`Warning: Could not remove ${fullPath}: ${err.message}`);
    }
  }
}

const coveragePath = join(process.cwd(), "coverage");
clearDirectory(coveragePath);
if (!existsSync(coveragePath)) {
  mkdirSync(coveragePath, { recursive: true });
}

const testResultsDir = join(process.cwd(), "test-results");
process.env.VSCODE_TEST_RESULTS_DIR = testResultsDir;
clearDirectory(testResultsDir);
if (!existsSync(testResultsDir)) {
  mkdirSync(testResultsDir, { recursive: true });
}

// The junit report is the only proof the suite actually loaded.
const junitReportPath = join(testResultsDir, "test-results.xml");

function countReportedTestCases() {
  if (!existsSync(junitReportPath)) {
    return 0;
  }
  const report = readFileSync(junitReportPath, "utf8");
  return report.split("<testcase").length - 1;
}

/**
 * A test host that quits before the suite loads still exits with code 0 and an
 * empty coverage summary, which would report a broken run as a green one.
 */
function exitAfterRun(exitCode) {
  if (exitCode === 0 && countReportedTestCases() === 0) {
    console.error(
      `No test cases were reported in ${junitReportPath}. The VS Code test host exited before the suite ran, so this run proves nothing and fails instead of passing.`
    );
    process.exit(1);
  }
  process.exit(exitCode);
}

const testArgs = [
  "--coverage",
  "--coverage-output",
  "coverage",
  "--coverage-reporter",
  "lcovonly",
  "--coverage-reporter",
  "html",
  "--coverage-reporter",
  "text-summary",
];

const HIDDEN_DESKTOP_LAUNCHER = fileURLToPath(new URL("./hidden-desktop-launcher.ps1", import.meta.url));
const HIDDEN_DESKTOP_LOG = join(process.cwd(), ".vscode-test", "test-host-output.log");
// Only the launcher knows the desktop it created, and it passes the name as an argument.
// An inherited environment variable therefore cannot make a run skip the launcher and open
// a test window on the developer's desktop.
const HIDDEN_DESKTOP_ARGUMENT = /^--hidden-desktop=lmcr-test-[0-9a-f]{32}$/;
const launchDesktopArgument = process.argv.slice(2).find((arg) => arg.startsWith("--hidden-desktop="));
const onHiddenDesktop = launchDesktopArgument !== undefined && HIDDEN_DESKTOP_ARGUMENT.test(launchDesktopArgument);

/**
 * The VS Code test host is a real Electron window, so on Windows it takes focus when it
 * opens and interrupts whatever the developer is doing. The test CLI forwards no launch
 * switches, so no launch switch can prevent it. The desktop the run starts on can: a window
 * can only take focus on the desktop that currently receives input, so the launcher starts
 * the whole run on a newly created desktop instead. There is no fallback, so a launcher
 * failure leaves the developer's desktop untouched.
 */
function runOnHiddenDesktop() {
  mkdirSync(dirname(HIDDEN_DESKTOP_LOG), { recursive: true });
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const launcher = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      HIDDEN_DESKTOP_LAUNCHER,
      "-NodeExecutable",
      process.execPath,
      "-ScriptPath",
      fileURLToPath(import.meta.url),
      "-LogPath",
      HIDDEN_DESKTOP_LOG,
      "-WorkingDirectory",
      process.cwd(),
      "-TimeoutSeconds",
      String(Math.ceil(TEST_TIMEOUT_MS / 1000) + 60),
    ],
    { stdio: "inherit" }
  );
  if (launcher.error) {
    console.error(`The hidden desktop launcher could not start: ${launcher.error.message}`);
    return 1;
  }
  return launcher.status ?? 1;
}

if (process.platform === "win32" && !onHiddenDesktop) {
  process.exit(runOnHiddenDesktop());
}

const hasXvfb =
  process.platform === "linux" &&
  spawnSync("sh", ["-lc", "command -v xvfb-run >/dev/null 2>&1"]).status === 0;

let child;
if (hasXvfb) {
  // xvfb-run wraps the entire command
  child = spawn("xvfb-run", ["vscode-test", ...testArgs], {
    stdio: "inherit",
    env: process.env,
  });
} else {
  // On Windows the bare `vscode-test` name resolves to the POSIX sh shim,
  // which a no-shell spawn cannot run; shell: true lets Windows resolve the
  // .cmd shim instead.
  child = spawn("vscode-test", testArgs, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
}

// Set a timeout to kill the process if it runs too long
const timeoutId = setTimeout(() => {
  timedOut = true;
  console.error(`Test process timed out after ${TEST_TIMEOUT_MS}ms, terminating...`);
  child.kill("SIGTERM");

  // Force kill after 5 seconds if SIGTERM doesn't work
  setTimeout(() => {
    if (!child.killed) {
      console.error("Process did not terminate gracefully, force killing...");
      child.kill("SIGKILL");
    }
  }, 5000);
}, TEST_TIMEOUT_MS);

let timedOut = false;

// Handle process exit
child.on("exit", (code, signal) => {
  clearTimeout(timeoutId);
  if (timedOut) {
    console.error("Test process terminated due to timeout.");
    process.exit(TIMEOUT_EXIT_CODE);
  }
  if (typeof code === "number") {
    exitAfterRun(code);
  } else if (signal) {
    console.error(`Process terminated by signal: ${signal}`);
    process.exit(1);
  }
  process.exit(1);
});

// Handle process errors
child.on("error", (err) => {
  clearTimeout(timeoutId);
  console.error(`Failed to start test process: ${err.message}`);
  process.exit(1);
});
