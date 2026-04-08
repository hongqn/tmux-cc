import { getPersistedClaudeSessionId, persistSession } from "./session-persistence.js";
import {
  createWindow,
  isClaudeProcessing,
  isProcessAlive,
  isWindowReady,
  killSession,
  killWindow,
  listWindows,
  sendKeys,
  sendTmuxKey,
  waitForReady,
  windowExists,
  type TmuxManagerOptions,
  type CreateWindowOptions,
} from "./tmux-manager.js";
import {
  findLatestTranscript,
  findTranscriptBySessionId,
  getExistingTranscriptPaths,
  extractSessionId,
} from "./transcript-reader.js";
/**
 * Maps OpenClaw session keys to tmux windows running Claude Code.
 *
 * Each OpenClaw conversation (identified by a session key) gets its own
 * tmux window with a dedicated Claude Code instance.
 */
import type { SessionState, TmuxClaudeConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { randomBytes } from "node:crypto";

/** Unique ID for this module instance REDACTED detects multiple module loads. */
const MODULE_INSTANCE_ID = randomBytes(4).toString("hex");
console.log(`[tmux-cc] module instance ${MODULE_INSTANCE_ID} loaded`);

const MODEL_SWITCH_POLL_MS = 500;
const MODEL_SWITCH_INTERRUPT_TIMEOUT_MS = 15_000;

/** In-memory map of session key REDACTED session state. */
const sessions = new Map<string, SessionState>();

/** Handle for the idle cleanup interval timer. */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Whether this module instance has ever created a session.
 *  Used to guard orphan cleanup REDACTED a process that never creates sessions
 *  (e.g., openclaw-agent) must not kill windows it doesn't own. */
let hasEverCreatedSession = false;

/** @internal Test-only: set the hasEverCreatedSession flag. */
export function _setHasEverCreatedSession(value: boolean): void {
  hasEverCreatedSession = value;
}

/**
 * Generate a tmux window name from an OpenClaw session key.
 * Sanitizes the key to be a valid tmux window name.
 */
export function windowNameFromSessionKey(sessionKey: string): string {
  // Replace non-alphanumeric chars with dashes, truncate to 50 chars
  const sanitized = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50);
  return `cc-${sanitized}`;
}

/**
 * Get the current session state for a session key, or null if none exists.
 */
export function getSession(sessionKey: string): SessionState | null {
  return sessions.get(sessionKey) ?? null;
}

/**
 * Ensure Claude Code is idle before sending a /model command.
 * If CC is currently processing, sends Escape to interrupt it,
 * then polls until it becomes idle (up to 15s).
 */
function waitForIdle(tmuxSession: string, windowName: string): void {
  if (!isClaudeProcessing(tmuxSession, windowName)) {
    return;
  }

  console.log(`[tmux-cc] waitForIdle: CC is processing in window=${windowName}, sending Escape to interrupt`);
  sendTmuxKey(tmuxSession, windowName, "Escape");

  const deadline = Date.now() + MODEL_SWITCH_INTERRUPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, MODEL_SWITCH_POLL_MS);
    if (!isClaudeProcessing(tmuxSession, windowName)) {
      console.log(`[tmux-cc] waitForIdle: CC is now idle in window=${windowName}`);
      return;
    }
    console.log(`[tmux-cc] waitForIdle: still waiting for CC to stop in window=${windowName}`);
  }
  console.warn(`[tmux-cc] waitForIdle: timed out after ${MODEL_SWITCH_INTERRUPT_TIMEOUT_MS}ms, proceeding anyway`);
}

/**
 * Get or create a session for the given session key.
 *
 * If no session exists, creates a new tmux window with Claude Code.
 * If the session exists but Claude Code has crashed, restarts it with --resume.
 */
export function getOrCreateSession(
  sessionKey: string,
  model: string,
  config: TmuxClaudeConfig = {},
): SessionState {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const existing = sessions.get(sessionKey);

  if (existing) {
    // Check if the process is still alive
    if (isProcessAlive(mergedConfig.tmuxSession, existing.windowName)) {
      // Model changed REDACTED wait for CC to be idle, then send /model command
      if (existing.model !== model) {
        console.log(`[tmux-cc] getOrCreateSession: model changed (${existing.model} REDACTED ${model}), sending /model command for key=${sessionKey}`);
        waitForIdle(mergedConfig.tmuxSession, existing.windowName);
        sendKeys(mergedConfig.tmuxSession, existing.windowName, `/model ${model}`);
        existing.model = model;
      }
      console.log(`[tmux-cc] getOrCreateSession: reusing existing session key=${sessionKey}, window=${existing.windowName}`);
      existing.lastActivityMs = Date.now();
      return existing;
    }

    // Process died REDACTED restart with --resume
    console.log(`[tmux-cc] getOrCreateSession: restarting dead session key=${sessionKey}, window=${existing.windowName}`);
    return restartSession(existing, mergedConfig);
  }

  // Create a new session
  console.log(`[tmux-cc] getOrCreateSession: creating new session key=${sessionKey}`);
  return createNewSession(sessionKey, model, mergedConfig);
}

/**
 * Create a new Claude Code session in a tmux window.
 */
function createNewSession(
  sessionKey: string,
  model: string,
  config: Required<TmuxClaudeConfig>,
): SessionState {
  const windowName = windowNameFromSessionKey(sessionKey);

  // Check if an existing window with this name is still alive and ready
  // (e.g., from a previous gateway run). Reconnect instead of killing it
  // to preserve Claude Code's conversation history.
  if (
    windowExists(config.tmuxSession, windowName) &&
    isProcessAlive(config.tmuxSession, windowName) &&
    isWindowReady(config.tmuxSession, windowName)
  ) {
    // Snapshot existing transcript files so pollForResponse can find the
    // NEW file that Claude Code creates when it receives the next message.
    // We can't predict which file will be active REDACTED Claude Code may start
    // a new session even in a reconnected window.
    const existingFiles = getExistingTranscriptPaths(config.workingDirectory);
    console.log(`[tmux-cc] createNewSession: reconnecting to existing window=${windowName}, snapshotFiles=${existingFiles.size}`);

    const state: SessionState = {
      sessionKey,
      windowName,
      transcriptOffset: 0,
      lastActivityMs: Date.now(),
      model,
      existingTranscriptPaths: existingFiles,
    };

    sessions.set(sessionKey, state);
    hasEverCreatedSession = true;
    return state;
  }

  const tmuxOpts: TmuxManagerOptions = {
    tmuxSession: config.tmuxSession,
    claudeCommand: config.claudeCommand,
    workingDirectory: config.workingDirectory,
  };

  // Check if we have a persisted Claude session ID from a previous run.
  // This enables --resume even after the tmux window was reclaimed.
  const persistedClaudeId = getPersistedClaudeSessionId(sessionKey);
  console.log(`[tmux-cc] createNewSession: key=${sessionKey}, window=${windowName}, model=${model}, persistedId=${persistedClaudeId ?? "none"}, cwd=${config.workingDirectory}`);

  const windowOpts: CreateWindowOptions = {
    windowName,
    model,
    resumeSessionId: persistedClaudeId,
  };

  // Snapshot existing transcript files BEFORE creating the window so we can
  // identify the new file that belongs to our session after message is sent.
  const existingFiles = getExistingTranscriptPaths(config.workingDirectory);
  console.log(`[tmux-cc] createNewSession: snapshot has ${existingFiles.size} existing transcript files`);

  // Kill any orphaned tmux window with the same name from a previous gateway
  // run to avoid ambiguous tmux targets.
  if (windowExists(config.tmuxSession, windowName)) {
    console.log(`[tmux-cc] createNewSession: killing orphaned window=${windowName}`);
    killWindow(config.tmuxSession, windowName);
  }

  createWindow(tmuxOpts, windowOpts);

  // Wait for Claude Code to start
  const ready = waitForReady(config.tmuxSession, windowName);
  console.log(`[tmux-cc] createNewSession: waitForReady=${ready}`);

  // Don't discover transcript here REDACTED Claude Code creates the file when the
  // first message is sent, not at startup. Store the snapshot so
  // pollForResponse can find the NEW file after sendKeys.
  const state: SessionState = {
    sessionKey,
    windowName,
    transcriptOffset: 0,
    lastActivityMs: Date.now(),
    model,
    existingTranscriptPaths: existingFiles,
    claudeSessionId: persistedClaudeId,
  };

  sessions.set(sessionKey, state);
  hasEverCreatedSession = true;
  return state;
}

/**
 * Restart a crashed Claude Code session using --resume.
 */
export function restartSession(state: SessionState, config: Required<TmuxClaudeConfig>): SessionState {
  // Kill the old window if it still exists
  killWindow(config.tmuxSession, state.windowName);

  const tmuxOpts: TmuxManagerOptions = {
    tmuxSession: config.tmuxSession,
    claudeCommand: config.claudeCommand,
    workingDirectory: config.workingDirectory,
  };

  const windowOpts: CreateWindowOptions = {
    windowName: state.windowName,
    model: state.model,
    resumeSessionId: state.claudeSessionId,
  };

  // Snapshot existing transcript files BEFORE creating the new window so
  // pollForResponse can discover the new file Claude Code writes to after
  // the restart.  Without this, polling continues reading the old (stale)
  // transcript file and times out.
  const existingFiles = getExistingTranscriptPaths(config.workingDirectory);

  createWindow(tmuxOpts, windowOpts);
  const ready = waitForReady(config.tmuxSession, state.windowName);
  console.log(`[tmux-cc] restartSession: window=${state.windowName}, ready=${ready}, snapshotFiles=${existingFiles.size}`);

  // Reset transcript state so pollForResponse re-discovers the file
  state.transcriptPath = undefined;
  state.transcriptOffset = 0;
  state.existingTranscriptPaths = existingFiles;
  state.lastActivityMs = Date.now();
  return state;
}

/**
 * Try to discover the Claude Code transcript file for a session.
 * Updates the session state with the transcript path and session ID.
 */
function discoverTranscript(state: SessionState, workingDirectory: string): void {
  if (state.claudeSessionId) {
    // If we know the session ID, look for its specific file
    const path = findTranscriptBySessionId(workingDirectory, state.claudeSessionId);
    if (path) {
      state.transcriptPath = path;
      return;
    }
  }

  // Fall back to the most recent transcript file
  const path = findLatestTranscript(workingDirectory);
  if (path) {
    state.transcriptPath = path;
    state.claudeSessionId = extractSessionId(path);
  }
}

/**
 * Clean up idle sessions that have exceeded the idle timeout.
 */
export function cleanupIdleSessions(config: TmuxClaudeConfig = {}): number {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();
  let cleaned = 0;

  for (const [key, state] of sessions) {
    const idleMs = now - state.lastActivityMs;
    if (idleMs > mergedConfig.idleTimeoutMs) {
      console.log(`[tmux-cc] cleanupIdleSessions: inst=${MODULE_INSTANCE_ID} killing idle session key=${key}, window=${state.windowName}, idleMs=${idleMs}`);
      killWindow(mergedConfig.tmuxSession, state.windowName);
      sessions.delete(key);
      cleaned++;
    }
  }

  // Also clean up orphaned windows not tracked in the sessions Map.
  cleaned += cleanupOrphanedWindows(mergedConfig);

  return cleaned;
}

/**
 * The window name prefix used by this plugin.
 */
const WINDOW_PREFIX = "cc-";

/**
 * Clean up orphaned tmux windows that have the plugin's prefix but are
 * not tracked in the in-memory sessions Map.
 *
 * This handles windows left behind after a gateway restart, plugin rename,
 * or other situations where the in-memory state is lost.
 *
 * Also kills entire tmux sessions that were created by older plugin versions
 * (e.g., `openclaw-claude`) if all their windows are orphaned.
 */
export function cleanupOrphanedWindows(config: TmuxClaudeConfig = {}): number {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  let cleaned = 0;

  // Guard: only clean up orphans if this process has actively created sessions.
  // Other processes (e.g., openclaw-agent) load this module but never create
  // sessions REDACTED their empty sessions map would wrongly flag ALL windows as orphans.
  if (!hasEverCreatedSession) {
    console.log(`[tmux-cc] cleanupOrphanedWindows: inst=${MODULE_INSTANCE_ID} skipping REDACTED no sessions ever created in this process`);
    return 0;
  }

  // Collect all window names currently tracked in the sessions Map
  const trackedWindows = new Set<string>();
  for (const state of sessions.values()) {
    trackedWindows.add(state.windowName);
  }

  // Scan the current tmux session for orphaned windows
  const currentWindows = listWindows(mergedConfig.tmuxSession);
  console.log(`[tmux-cc] cleanupOrphanedWindows: inst=${MODULE_INSTANCE_ID}, tracked=[${[...trackedWindows].join(",")}], current=[${currentWindows.join(",")}]`);
  for (const winName of currentWindows) {
    if (winName.startsWith(WINDOW_PREFIX) && !trackedWindows.has(winName)) {
      console.log(`[tmux-cc] cleanupOrphanedWindows: inst=${MODULE_INSTANCE_ID} killing orphaned window=${winName}`);
      killWindow(mergedConfig.tmuxSession, winName);
      cleaned++;
    }
  }

  // Scan for legacy tmux sessions from previous plugin versions.
  // Known legacy session names that this plugin may have created.
  const legacySessions = ["openclaw-claude"];
  for (const legacySession of legacySessions) {
    if (legacySession === mergedConfig.tmuxSession) continue;
    const legacyWindows = listWindows(legacySession);
    if (legacyWindows.length === 0) continue;

    // Kill all cc-* windows in legacy sessions
    for (const winName of legacyWindows) {
      if (winName.startsWith(WINDOW_PREFIX)) {
        killWindow(legacySession, winName);
        cleaned++;
      }
    }
    // If only the default "bash" window remains, kill the entire session
    const remaining = listWindows(legacySession);
    if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === "bash")) {
      killSession(legacySession);
    }
  }

  return cleaned;
}

/**
 * Start the periodic idle cleanup timer.
 * Also runs an immediate orphan cleanup on startup to reclaim windows
 * left behind by previous gateway runs.
 */
export function startCleanupTimer(config: TmuxClaudeConfig = {}): void {
  if (cleanupTimer) {
    console.log(`[tmux-cc] startCleanupTimer: inst=${MODULE_INSTANCE_ID} already running, skipping`);
    return;
  }

  console.log(`[tmux-cc] startCleanupTimer: inst=${MODULE_INSTANCE_ID} starting timer`);
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Run immediate orphan cleanup on startup
  cleanupOrphanedWindows(mergedConfig);

  // Check every 5 minutes
  const intervalMs = Math.min(mergedConfig.idleTimeoutMs / 6, 5 * 60 * 1000);

  cleanupTimer = setInterval(() => {
    console.log(`[tmux-cc] cleanupInterval: inst=${MODULE_INSTANCE_ID} firing`);
    cleanupIdleSessions(mergedConfig);
  }, intervalMs);

  // Don't block process exit
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

/**
 * Stop the periodic idle cleanup timer.
 */
export function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Destroy all sessions and clean up resources.
 */
export function destroyAllSessions(config: TmuxClaudeConfig = {}): void {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  for (const [key, state] of sessions) {
    killWindow(mergedConfig.tmuxSession, state.windowName);
    sessions.delete(key);
  }
  stopCleanupTimer();
}

/**
 * Get the count of active sessions.
 */
export function getSessionCount(): number {
  return sessions.size;
}

/**
 * Get all active session keys.
 */
export function getSessionKeys(): string[] {
  return Array.from(sessions.keys());
}
