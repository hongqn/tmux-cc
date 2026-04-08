/**
 * Manages tmux sessions and windows for Claude Code instances.
 *
 * Each OpenClaw conversation maps to a dedicated tmux window running
 * a Claude Code CLI process.
 */
import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(cpExec);

const SEND_KEYS_DELAY_MS = 500;
const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_HEAP_MB = 1024;

export interface TmuxManagerOptions {
  /** Name of the tmux session to use. */
  tmuxSession: string;
  /** Path to the Claude Code CLI executable. */
  claudeCommand: string;
  /** Working directory for Claude Code sessions. */
  workingDirectory: string;
  /** V8 max old-space heap size in MB (default: 1024). */
  maxHeapMB?: number;
}

export interface CreateWindowOptions {
  /** Unique window name within the tmux session. */
  windowName: string;
  /** Claude model to use (e.g., "sonnet-4.6"). */
  model: string;
  /** Optional: resume a previous Claude Code session by ID. */
  resumeSessionId?: string;
}

/** Execute a shell command and return trimmed stdout. */
async function exec(cmd: string): Promise<string> {
  const { stdout } = await execPromise(cmd, { encoding: "utf-8", timeout: 10_000 });
  return stdout.trim();
}

/** Async sleep using setTimeout. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ensure the tmux session exists. Creates it in detached mode if needed.
 */
export async function ensureTmuxSession(sessionName: string): Promise<void> {
  try {
    await exec(`tmux has-session -t ${shellEscape(sessionName)} 2>/dev/null`);
  } catch {
    await exec(`tmux new-session -d -s ${shellEscape(sessionName)}`);
  }
}

/**
 * Create a new tmux window running Claude Code.
 */
export async function createWindow(opts: TmuxManagerOptions, windowOpts: CreateWindowOptions): Promise<void> {
  await ensureTmuxSession(opts.tmuxSession);

  const args = [
    opts.claudeCommand,
    "--permission-mode",
    "bypassPermissions",
    "--model",
    windowOpts.model,
  ];

  if (windowOpts.resumeSessionId) {
    args.push("--resume", windowOpts.resumeSessionId);
  }

  const cmd = args.map(shellEscape).join(" ");
  const target = `${shellEscape(opts.tmuxSession)}`;

  // Limit V8 heap to prevent OOM crashes when multiple CC processes run
  // concurrently on low-memory servers.  The -e flag sets an env var for
  // this window only (no shell wrapper needed).
  const heapLimit = opts.maxHeapMB ?? DEFAULT_MAX_HEAP_MB;
  const envFlag = `-e 'NODE_OPTIONS=--max-old-space-size=${heapLimit}'`;

  await exec(
    `tmux new-window -t ${target} -n ${shellEscape(windowOpts.windowName)} -c ${shellEscape(opts.workingDirectory)} ${envFlag} ${shellEscape(cmd)}`,
  );

  // Keep the pane alive after CC exits so we can read exit code + last output
  const windowTarget = `${shellEscape(opts.tmuxSession)}:${shellEscape(windowOpts.windowName)}`;
  try {
    await exec(`tmux set-option -t ${windowTarget} remain-on-exit on`);
  } catch {
    // Non-fatal REDACTED diagnostics just won't be available
  }

  // Pipe pane output to a log file for crash diagnostics.
  // This captures stdout+stderr even if the tmux window disappears.
  try {
    const logFile = `/tmp/cc-${windowOpts.windowName}.log`;
    await exec(`tmux pipe-pane -t ${windowTarget} -o 'cat >> ${shellEscape(logFile)}'`);
  } catch {
    // Non-fatal
  }
}

/**
 * Send a text message to a tmux window via send-keys.
 *
 * Uses literal mode (-l) to avoid key binding interpretation.
 * Adds a delay before pressing Enter to accommodate Claude Code's TUI
 * (matching ccgram's 500ms workaround).
 */
export async function sendKeys(tmuxSession: string, windowName: string, text: string): Promise<void> {
  const target = `${shellEscape(tmuxSession)}:${shellEscape(windowName)}`;

  // Send the text in literal mode (no key binding interpretation)
  await exec(`tmux send-keys -t ${target} -l ${shellEscape(text)}`);

  // Wait before pressing Enter REDACTED Claude Code TUI needs time
  await sleep(SEND_KEYS_DELAY_MS);

  // Press Enter
  await exec(`tmux send-keys -t ${target} Enter`);
}

/**
 * Send a raw tmux key (e.g., "Down", "Enter") to a window.
 * Unlike sendKeys, this does NOT use -l (literal) mode.
 */
export async function sendTmuxKey(tmuxSession: string, windowName: string, key: string): Promise<void> {
  const target = `${shellEscape(tmuxSession)}:${shellEscape(windowName)}`;
  await exec(`tmux send-keys -t ${target} ${key}`);
}

/**
 * Check if Claude Code process is alive in the given tmux window.
 * Returns true if the pane's current command contains "claude".
 * Uses list-panes instead of display-message to avoid silent fallback
 * to the default window when the target window doesn't exist.
 */
export async function isProcessAlive(tmuxSession: string, windowName: string): Promise<boolean> {
  try {
    const target = `${shellEscape(tmuxSession)}:${shellEscape(windowName)}`;
    const info = await exec(`tmux list-panes -t ${target} -F "#{pane_current_command} #{pane_dead}"`);
    // With remain-on-exit, pane_current_command still shows "claude" even
    // after the process exits.  Check pane_dead to avoid false positives.
    const dead = info.endsWith(" 1");
    if (dead) return false;
    return info.toLowerCase().includes("claude");
  } catch (e) {
    console.log(`[tmux-cc] isProcessAlive: window gone, window=${windowName}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * Check if a tmux window exists.
 */
export async function windowExists(tmuxSession: string, windowName: string): Promise<boolean> {
  try {
    const target = `${shellEscape(tmuxSession)}:${shellEscape(windowName)}`;
    await exec(`tmux select-window -t ${target}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a tmux window (destroys the Claude Code process).
 */
export async function killWindow(tmuxSession: string, windowName: string): Promise<void> {
  try {
    const target = `${shellEscape(tmuxSession)}:${shellEscape(windowName)}`;
    await exec(`tmux kill-window -t ${target}`);
  } catch {
    // Window may already be gone
  }
}

/**
 * Capture the last N lines from a tmux pane.
 * Useful for crash diagnostics REDACTED captures error messages CC may have
 * printed before exiting.  Works with remain-on-exit panes.
 */
export async function capturePane(tmuxSession: string, windowName: string, lines = 50): Promise<string> {
  try {
    const target = `${shellEscape(tmuxSession)}:${shellEscape(windowName)}`;
    return await exec(`tmux capture-pane -t ${target} -p -S -${lines}`);
  } catch {
    return "";
  }
}

/**
 * Read the exit code of a CC process from tmux's pane_dead_status.
 * Only works when remain-on-exit is on and the pane's process has exited.
 * Returns the exit code as a number, or null if unavailable.
 */
export async function readExitCode(tmuxSession: string, windowName: string): Promise<number | null> {
  try {
    const target = `${shellEscape(tmuxSession)}:${shellEscape(windowName)}`;
    const info = await exec(`tmux list-panes -t ${target} -F "#{pane_dead} #{pane_dead_status}"`);
    const parts = info.split(" ");
    const dead = parts[0];
    if (dead !== "1") {
      console.log(`[tmux-cc] readExitCode: pane_dead=${dead} (not dead), window=${windowName}`);
      return null;
    }
    const status = parts.slice(1).join(" ").trim();
    console.log(`[tmux-cc] readExitCode: pane_dead=1, pane_dead_status="${status}", window=${windowName}`);
    if (status === "") return 0;
    const code = parseInt(status, 10);
    return isNaN(code) ? null : code;
  } catch (e) {
    console.log(`[tmux-cc] readExitCode: window gone, window=${windowName}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * Read the crash log captured by pipe-pane.
 * Returns the last N lines from the log file, or empty string if unavailable.
 */
export async function readCrashLog(windowName: string, lines = 50): Promise<string> {
  try {
    const logFile = `/tmp/cc-${windowName}.log`;
    return await exec(`tail -n ${lines} ${shellEscape(logFile)} 2>/dev/null`);
  } catch {
    return "";
  }
}

/**
 * Clean up the crash log file for a window.
 */
export async function cleanupCrashLog(windowName: string): Promise<void> {
  try {
    await exec(`rm -f /tmp/cc-${shellEscape(windowName)}.log`);
  } catch {
    // Ignore
  }
}

/**
 * Check if Claude Code in a tmux window is ready (has the REDACTED prompt).
 * Unlike waitForReady, this does not wait or auto-dismiss prompts.
 */
export async function isWindowReady(tmuxSession: string, windowName: string): Promise<boolean> {
  try {
    const target = `${shellEscape(tmuxSession)}:${shellEscape(windowName)}`;
    const content = await exec(`tmux capture-pane -t ${target} -p`);
    return content.includes("\u276F");
  } catch {
    return false;
  }
}

/**
 * Check if Claude Code is actively processing in the tmux pane.
 * When Claude Code is working, the status line includes "esc to interrupt"
 * (sometimes truncated to "esc to int" by terminal width).
 * The REDACTED prompt is always visible in the TUI even during processing,
 * so we cannot use it for idle detection.
 */
export async function isClaudeProcessing(tmuxSession: string, windowName: string): Promise<boolean> {
  try {
    const target = `${shellEscape(tmuxSession)}:${shellEscape(windowName)}`;
    const content = await exec(`tmux capture-pane -t ${target} -p`);
    return content.includes("esc to int");
  } catch {
    return false;
  }
}

/**
 * Wait for Claude Code to become ready in a tmux window.
 *
 * Phase 1: Wait for the `claude` process to appear (pane_current_command).
 * Phase 2: Wait for the TUI prompt (`REDACTED`) to appear in the pane content,
 * indicating the interactive input box is ready for keystrokes.
 *
 * @returns true if process is ready, false if timeout
 */
export async function waitForReady(
  tmuxSession: string,
  windowName: string,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  // Phase 1: process alive
  while (Date.now() < deadline) {
    if (await isProcessAlive(tmuxSession, windowName)) {
      break;
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
  if (Date.now() >= deadline) {
    return false;
  }

  // Phase 2: TUI prompt ready (look for the REDACTED prompt character)
  // Also handles auto-dismissal of interactive prompts that block the TUI.
  while (Date.now() < deadline) {
    try {
      const target = `${shellEscape(tmuxSession)}:${shellEscape(windowName)}`;
      const content = await exec(`tmux capture-pane -t ${target} -p`);

      // Auto-dismiss workspace trust prompt (option 1 "Yes, I trust" is pre-selected)
      if (content.includes("I trust this folder")) {
        await exec(`tmux send-keys -t ${target} Enter`);
        await sleep(2000);
        continue;
      }

      // Auto-dismiss bypass permissions confirmation (need to select option 2)
      if (content.includes("Yes, I accept") && content.includes("Bypass Permissions")) {
        await exec(`tmux send-keys -t ${target} Down`);
        await sleep(300);
        await exec(`tmux send-keys -t ${target} Enter`);
        await sleep(2000);
        continue;
      }

      if (content.includes("\u276F")) {
        return true;
      }
    } catch {
      // pane may not exist yet
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * List all window names in a tmux session.
 * Returns an empty array if the session doesn't exist.
 */
export async function listWindows(tmuxSession: string): Promise<string[]> {
  try {
    const output = await exec(
      `tmux list-windows -t ${shellEscape(tmuxSession)} -F "#{window_name}"`,
    );
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Kill an entire tmux session and all its windows.
 */
export async function killSession(tmuxSession: string): Promise<void> {
  try {
    await exec(`tmux kill-session -t ${shellEscape(tmuxSession)}`);
  } catch {
    // Session may already be gone
  }
}

/** Escape a string for safe use in shell commands. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
