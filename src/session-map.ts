import { getPersistedClaudeSessionId, persistSession } from "./session-persistence.js";
import {
  createWindow as tmuxCreateWindow,
  isProcessAlive as tmuxIsProcessAlive,
  isWindowReady as tmuxIsWindowReady,
  waitForReady as tmuxWaitForReady,
  sendKeys as tmuxSendKeys,
  killSession,
  killWindow,
  listWindows,
  windowExists,
  type TmuxManagerOptions,
} from "./tmux-manager.js";
import {
  getExistingTranscriptPaths as trGetExistingPaths,
} from "./transcript-reader.js";
import type { AgentAdapter } from "./adapters/types.js";
/**
 * Maps OpenClaw session keys to tmux windows running Claude Code.
 *
 * Each OpenClaw conversation (identified by a session key) gets its own
 * tmux window with a dedicated agent instance (e.g., Claude Code).
 *
 * The agent-specific logic (launching, readiness detection, transcript
 * parsing, etc.) is delegated to an {@link AgentAdapter}.
 */
import type { SessionState, TmuxClaudeConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

/** Unique ID for this module instance — detects multiple module loads. */
const MODULE_INSTANCE_ID = randomBytes(4).toString("hex");
console.log(`[tmux-cc] module instance ${MODULE_INSTANCE_ID} loaded`);

/** In-memory map of logical session key + adapter id → session state. */
const sessions = new Map<string, SessionState>();

/** Handle for the idle cleanup interval timer. */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Whether this module instance has ever created a session.
 *  Used to guard orphan cleanup — a process that never creates sessions
 *  (e.g., openclaw-agent) must not kill windows it doesn't own. */
let hasEverCreatedSession = false;

function sessionMapKey(sessionKey: string, adapter?: AgentAdapter): string {
  return adapter ? `${sessionKey}::${adapter.id}` : sessionKey;
}

function matchesSessionMapKey(mapKey: string, sessionKey: string): boolean {
  return mapKey === sessionKey || mapKey.startsWith(`${sessionKey}::`);
}

/** @internal Test-only: set the hasEverCreatedSession flag. */
export function _setHasEverCreatedSession(value: boolean): void {
  hasEverCreatedSession = value;
}

/** Resolved location of an openclaw session: which agent owns it and its key name. */
export type SessionLocation = { agentId: string; keyName: string | null };

/**
 * Combined cache of gateway sessionId → resolved location. Only successful lookups are cached.
 * Negative results are intentionally NOT cached so a delayed sessions.json write can still
 * resolve on retry (and so the REQ-007 warning can flip to success on a later turn).
 */
const sessionLocationCache = new Map<string, SessionLocation>();

/** Tracks sessionIds for which a "not found" warning has already been emitted (per-process dedup). */
const warnedSessionIds = new Set<string>();

/** @internal Test-only: reset all module-level caches and dedup state. */
export function __resetForTests(): void {
  sessionLocationCache.clear();
  warnedSessionIds.clear();
}

/**
 * Resolve both the OpenClaw agent ID and session key name from a gateway session ID
 * in a single scan.
 *
 * Primary path: scans ~/.openclaw/agents/AGENT/sessions/sessions.json for the entry
 * whose sessionId matches gatewaySessionId. This path works on the very first
 * turn of a new session because the gateway writes sessions.json before invoking
 * the plugin.
 *
 * Fallback (defence in depth): if no sessions.json entry matches, checks for the
 * existence of a SESSIONID.jsonl transcript file. This covers the theoretical case
 * where sessions.json is temporarily unavailable.
 *
 * When neither path resolves the session and gatewaySessionId is non-null, emits a
 * one-time warning so log watchers can detect potential session splits.
 *
 * Results are cached so repeat calls for the same sessionId are O(1).
 */
export async function resolveSessionLocation(
  gatewaySessionId: string | undefined,
): Promise<SessionLocation | null> {
  if (!gatewaySessionId) return null;

  const cached = sessionLocationCache.get(gatewaySessionId);
  if (cached) return cached;

  const agentsDir = join(homedir(), ".openclaw", "agents");
  let agentDirs: string[];
  try {
    agentDirs = await readdir(agentsDir);
  } catch {
    return null;
  }

  // Primary path: scan sessions.json for each agent.
  // This is always correct on turn 1 because the gateway writes sessions.json
  // before dispatching to the plugin.
  for (const agentDir of agentDirs) {
    const sessionsFile = join(agentsDir, agentDir, "sessions", "sessions.json");
    try {
      const data = JSON.parse(await readFile(sessionsFile, "utf-8"));
      for (const [keyName, entry] of Object.entries(data)) {
        if ((entry as { sessionId?: string }).sessionId === gatewaySessionId) {
          const location: SessionLocation = { agentId: agentDir, keyName };
          sessionLocationCache.set(gatewaySessionId, location);
          console.log(`[tmux-cc] resolveAgentId: ${gatewaySessionId} → ${agentDir}`);
          console.log(`[tmux-cc] resolveSessionKeyName: ${gatewaySessionId} → ${keyName}`);
          return location;
        }
      }
    } catch {
      // This agent's sessions.json is missing or malformed; try the next agent.
    }
  }

  // Fallback: JSONL existence check (defence in depth for sessions.json lag).
  for (const agentDir of agentDirs) {
    const jsonlFile = join(agentsDir, agentDir, "sessions", `${gatewaySessionId}.jsonl`);
    try {
      await stat(jsonlFile);
      // JSONL exists — re-check sessions.json for keyName (may have appeared by now).
      let keyName: string | null = null;
      const sessionsFile = join(agentsDir, agentDir, "sessions", "sessions.json");
      try {
        const data = JSON.parse(await readFile(sessionsFile, "utf-8"));
        for (const [k, entry] of Object.entries(data)) {
          if ((entry as { sessionId?: string }).sessionId === gatewaySessionId) {
            keyName = k;
            break;
          }
        }
      } catch {
        // sessions.json still unavailable; proceed with keyName=null.
      }
      const location: SessionLocation = { agentId: agentDir, keyName };
      sessionLocationCache.set(gatewaySessionId, location);
      console.log(`[tmux-cc] resolveAgentId: ${gatewaySessionId} → ${agentDir}`);
      if (keyName) console.log(`[tmux-cc] resolveSessionKeyName: ${gatewaySessionId} → ${keyName}`);
      return location;
    } catch {
      // JSONL doesn't exist in this agent dir; try the next.
    }
  }

  // Both paths failed — warn once per sessionId to flag potential session split.
  if (!warnedSessionIds.has(gatewaySessionId)) {
    warnedSessionIds.add(gatewaySessionId);
    console.warn(
      `[tmux-cc] WARN: sessionId=${gatewaySessionId} not found in any agent's sessions.json — falling back to derived key (potential session split)`,
    );
  }
  return null;
}

/**
 * Resolve the OpenClaw agent ID from a gateway session ID.
 * @deprecated Prefer {@link resolveSessionLocation} for new call sites; this thin
 * wrapper exists for backward compatibility.
 */
export async function resolveAgentId(gatewaySessionId: string | undefined): Promise<string | null> {
  const location = await resolveSessionLocation(gatewaySessionId);
  return location?.agentId ?? null;
}

/**
 * Resolve the OpenClaw session key name from a gateway session UUID.
 * @deprecated Prefer {@link resolveSessionLocation} for new call sites; this thin
 * wrapper exists for backward compatibility.
 */
export async function resolveSessionKeyName(
  gatewaySessionId: string | undefined,
): Promise<string | null> {
  if (!gatewaySessionId) return null;
  const location = await resolveSessionLocation(gatewaySessionId);
  return location?.keyName ?? null;
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
/**
 * Kill a session's tmux window and drop it from the in-memory map.
 * Used by mid-stream fallback, where we need to tear down the primary
 * adapter's window so the next getOrCreateSession allocates a fresh
 * one (with the fallback adapter) instead of reusing the existing one.
 */
export async function deleteSession(
  sessionKey: string,
  config: TmuxClaudeConfig = {},
  adapter?: AgentAdapter,
): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  for (const [key, state] of sessions) {
    if (adapter ? key === sessionMapKey(sessionKey, adapter) : matchesSessionMapKey(key, sessionKey)) {
      try {
        await killWindow(mergedConfig.tmuxSession, state.windowName);
      } catch {
        // Window may already be gone
      }
      sessions.delete(key);
    }
  }
}

export function getSession(sessionKey: string, adapter?: AgentAdapter): SessionState | null {
  if (adapter) return sessions.get(sessionMapKey(sessionKey, adapter)) ?? null;
  return sessions.get(sessionKey) ?? [...sessions.entries()].find(([key]) => matchesSessionMapKey(key, sessionKey))?.[1] ?? null;
}

/**
 * Get or create a session for the given session key.
 *
 * If no session exists, creates a new tmux window with the agent.
 * If the session exists but the agent has crashed, restarts it with --resume.
 *
 * @param adapter - Agent adapter for lifecycle and transcript operations
 */
export async function getOrCreateSession(
  sessionKey: string,
  model: string,
  config: TmuxClaudeConfig = {},
  adapter?: AgentAdapter,
  agentAccountId?: string,
): Promise<SessionState> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const mapKey = sessionMapKey(sessionKey, adapter);
  const existing = sessions.get(mapKey);

  if (existing) {
    // Check if the process is still alive
    const alive = adapter
      ? await adapter.isProcessAlive(mergedConfig.tmuxSession, existing.windowName)
      : await tmuxIsProcessAlive(mergedConfig.tmuxSession, existing.windowName);

    if (alive) {
      // Model changed — use adapter's switchModel (handles interrupt + idle wait)
      if (existing.model !== model) {
        console.log(`[tmux-cc] getOrCreateSession: model changed (${existing.model} → ${model}), switching model for key=${sessionKey}`);
        if (adapter) {
          await adapter.switchModel(mergedConfig.tmuxSession, existing.windowName, model);
        } else {
          await tmuxSendKeys(mergedConfig.tmuxSession, existing.windowName, `/model ${model}`);
        }
        existing.model = model;
      }
      console.log(`[tmux-cc] getOrCreateSession: reusing existing session key=${sessionKey}, window=${existing.windowName}`);
      existing.lastActivityMs = Date.now();
      return existing;
    }

    // Process died — restart with --resume
    console.log(`[tmux-cc] getOrCreateSession: restarting dead session key=${sessionKey}, window=${existing.windowName}`);
    return await restartSession(existing, mergedConfig, adapter);
  }

  // Create a new session
  console.log(`[tmux-cc] getOrCreateSession: creating new session key=${sessionKey}`);
  return await createNewSession(sessionKey, model, mergedConfig, adapter, agentAccountId);
}

/**
 * Create a new agent session in a tmux window.
 */
async function createNewSession(
  sessionKey: string,
  model: string,
  config: Required<TmuxClaudeConfig>,
  adapter?: AgentAdapter,
  agentAccountId?: string,
): Promise<SessionState> {
  const mapKey = sessionMapKey(sessionKey, adapter);
  const windowName = windowNameFromSessionKey(mapKey);

  // Check if an existing window with this name is still alive and ready
  const isAlive = adapter
    ? await adapter.isProcessAlive(config.tmuxSession, windowName)
    : await tmuxIsProcessAlive(config.tmuxSession, windowName);
  const isReady = adapter
    ? await adapter.isWindowReady(config.tmuxSession, windowName)
    : await tmuxIsWindowReady(config.tmuxSession, windowName);

  if (
    (await windowExists(config.tmuxSession, windowName)) &&
    isAlive &&
    isReady
  ) {
    const existingFiles = adapter
      ? adapter.getExistingTranscriptPaths(config.workingDirectory)
      : trGetExistingPaths(config.workingDirectory);
    console.log(`[tmux-cc] createNewSession: reconnecting to existing window=${windowName}, snapshotFiles=${existingFiles.size}`);

    const state: SessionState = {
      sessionKey,
      windowName,
      transcriptOffset: 0,
      lastActivityMs: Date.now(),
      model,
      turnCount: 0,
      existingTranscriptPaths: existingFiles,
      agentAccountId,
      adapter,
    };

    sessions.set(mapKey, state);
    hasEverCreatedSession = true;
    return state;
  }

  // Check if we have a persisted Claude session ID from a previous run.
  // Scoped by adapter id — Copilot's session ids live in ~/.copilot/session-state/
  // and CC's live in ~/.claude/projects/, so crossing them kills --resume.
  const persistedClaudeId = getPersistedClaudeSessionId(sessionKey, adapter?.id ?? "claude-code");
  console.log(`[tmux-cc] createNewSession: key=${sessionKey}, window=${windowName}, model=${model}, persistedId=${persistedClaudeId ?? "none"}, cwd=${config.workingDirectory}`);

  // Snapshot existing transcript files BEFORE creating the window
  const existingFiles = adapter
    ? adapter.getExistingTranscriptPaths(config.workingDirectory)
    : trGetExistingPaths(config.workingDirectory);
  console.log(`[tmux-cc] createNewSession: snapshot has ${existingFiles.size} existing transcript files`);

  // Kill any orphaned tmux window with the same name
  if (await windowExists(config.tmuxSession, windowName)) {
    console.log(`[tmux-cc] createNewSession: killing orphaned window=${windowName}`);
    await killWindow(config.tmuxSession, windowName);
  }

  // Register the session in the map BEFORE creating the window so that
  // the cleanup interval (which can fire at any time) won't kill it as
  // an "orphan" while waitForReady is still pending.
  const state: SessionState = {
    sessionKey,
    windowName,
    transcriptOffset: 0,
    lastActivityMs: Date.now(),
    model,
    turnCount: 0,
    existingTranscriptPaths: existingFiles,
    claudeSessionId: persistedClaudeId,
    agentAccountId,
    adapter,
  };
  sessions.set(mapKey, state);
  hasEverCreatedSession = true;

  // Create the agent window via adapter or legacy path
  if (adapter) {
    await adapter.createAgentWindow({
      tmuxSession: config.tmuxSession,
      windowName,
      workingDirectory: config.workingDirectory,
      model,
      resumeSessionId: persistedClaudeId,
      agentAccountId,
    });
  } else {
    const tmuxOpts: TmuxManagerOptions = {
      tmuxSession: config.tmuxSession,
      claudeCommand: config.claudeCommand,
      workingDirectory: config.workingDirectory,
    };
    await tmuxCreateWindow(tmuxOpts, { windowName, model, resumeSessionId: persistedClaudeId });
  }

  // Wait for agent to start
  const ready = adapter
    ? await adapter.waitForReady(config.tmuxSession, windowName)
    : await tmuxWaitForReady(config.tmuxSession, windowName);
  console.log(`[tmux-cc] createNewSession: waitForReady=${ready}`);

  // Update lastActivityMs after startup completes
  state.lastActivityMs = Date.now();
  return state;
}

/**
 * Restart a crashed agent session using --resume.
 */
export async function restartSession(
  state: SessionState,
  config: Required<TmuxClaudeConfig>,
  adapter?: AgentAdapter,
): Promise<SessionState> {
  // Kill the old window if it still exists
  await killWindow(config.tmuxSession, state.windowName);

  // Snapshot existing transcript files BEFORE creating the new window
  const existingFiles = adapter
    ? adapter.getExistingTranscriptPaths(config.workingDirectory)
    : trGetExistingPaths(config.workingDirectory);

  // Create agent window via adapter or legacy path
  if (adapter) {
    await adapter.createAgentWindow({
      tmuxSession: config.tmuxSession,
      windowName: state.windowName,
      workingDirectory: config.workingDirectory,
      model: state.model,
      resumeSessionId: state.claudeSessionId,
      agentAccountId: state.agentAccountId,
    });
  } else {
    const tmuxOpts: TmuxManagerOptions = {
      tmuxSession: config.tmuxSession,
      claudeCommand: config.claudeCommand,
      workingDirectory: config.workingDirectory,
    };
    await tmuxCreateWindow(tmuxOpts, {
      windowName: state.windowName,
      model: state.model,
      resumeSessionId: state.claudeSessionId,
    });
  }

  const ready = adapter
    ? await adapter.waitForReady(config.tmuxSession, state.windowName)
    : await tmuxWaitForReady(config.tmuxSession, state.windowName);
  console.log(`[tmux-cc] restartSession: window=${state.windowName}, ready=${ready}, snapshotFiles=${existingFiles.size}`);

  // Reset transcript state so pollForResponse re-discovers the file
  state.transcriptPath = undefined;
  state.transcriptOffset = 0;
  state.existingTranscriptPaths = existingFiles;
  state.lastActivityMs = Date.now();
  return state;
}

/**
 * Try to discover the transcript file for a session.
 * Updates the session state with the transcript path and session ID.
 */
function discoverTranscript(state: SessionState, workingDirectory: string, adapter?: AgentAdapter): void {
  if (state.claudeSessionId) {
    const path = adapter
      ? adapter.findTranscriptBySessionId(workingDirectory, state.claudeSessionId)
      : null; // Legacy: import inline
    if (path) {
      state.transcriptPath = path;
      return;
    }
    if (!adapter) {
      // Legacy fallback — dynamic import not feasible in sync function
      // This path is only used during cleanup, not critical
    }
  }

  const path = adapter?.findLatestTranscript(workingDirectory) ?? null;
  if (path) {
    state.transcriptPath = path;
    state.claudeSessionId = adapter?.extractSessionId(path);
  }
}

/**
 * Clean up idle sessions that have exceeded the idle timeout.
 */
export async function cleanupIdleSessions(config: TmuxClaudeConfig = {}): Promise<number> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();
  let cleaned = 0;

  for (const [key, state] of sessions) {
    const idleMs = now - state.lastActivityMs;
    if (idleMs > mergedConfig.idleTimeoutMs) {
      // Check if adapter reports the session is waiting for user input (KPSS)
      if (state.adapter?.isWaitingForUserInput) {
        try {
          const waiting = await state.adapter.isWaitingForUserInput(mergedConfig.tmuxSession, state.windowName);
          if (waiting) {
            console.log(`[tmux-cc] cleanupIdleSessions: skipping key=${key}, window=${state.windowName} — waiting for user input (KPSS)`);
            continue;
          }
        } catch {
          // If check fails (window gone), proceed with cleanup
        }
      }

      console.log(`[tmux-cc] cleanupIdleSessions: inst=${MODULE_INSTANCE_ID} killing idle session key=${key}, window=${state.windowName}, idleMs=${idleMs}`);
      await killWindow(mergedConfig.tmuxSession, state.windowName);
      sessions.delete(key);
      cleaned++;
    }
  }

  // Also clean up orphaned windows not tracked in the sessions Map.
  cleaned += await cleanupOrphanedWindows(mergedConfig);

  return cleaned;
}

/**
 * Grace period before eager cleanup kills an idle session (ms).
 * Shorter than idleTimeoutMs — this fires after a stream completes
 * to reclaim sessions that won't receive new messages soon (e.g., cron one-shots).
 */
const EAGER_CLEANUP_GRACE_MS = 120_000; // 2 minutes

/**
 * Schedule eager cleanup for a session after its stream completes.
 *
 * After the grace period, if the session hasn't received new activity
 * (i.e., lastActivityMs hasn't changed), we assume the conversation
 * is done and kill the tmux window to free memory.
 *
 * This is critical on memory-constrained machines where many cron-triggered
 * sessions can pile up and exhaust RAM+swap.
 */
export function scheduleEagerCleanup(
  sessionKey: string,
  config: TmuxClaudeConfig = {},
  adapter?: AgentAdapter,
): void {
  const mapKey = sessionMapKey(sessionKey, adapter);
  const state = sessions.get(mapKey);
  if (!state) return;

  const activityAtSchedule = state.lastActivityMs;
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  const timer = setTimeout(async () => {
    const current = sessions.get(mapKey);
    if (!current) return; // already cleaned up
    if (current.lastActivityMs !== activityAtSchedule) {
      // Session was active again — a new message arrived, skip cleanup
      console.log(`[tmux-cc] eagerCleanup: session key=${sessionKey} has new activity, skipping`);
      return;
    }

    // Check if adapter reports the session is waiting for user input (KPSS)
    if (current.adapter?.isWaitingForUserInput) {
      try {
        const waiting = await current.adapter.isWaitingForUserInput(mergedConfig.tmuxSession, current.windowName);
        if (waiting) {
          console.log(`[tmux-cc] eagerCleanup: session key=${sessionKey} is waiting for user input (KPSS), skipping`);
          return;
        }
      } catch {
        // If check fails (window gone), proceed with cleanup
      }
    }

    console.log(`[tmux-cc] eagerCleanup: session key=${sessionKey} idle for ${EAGER_CLEANUP_GRACE_MS}ms after stream, killing window=${current.windowName}`);
    try {
      await killWindow(mergedConfig.tmuxSession, current.windowName);
    } catch (e) {
      console.error(`[tmux-cc] eagerCleanup: killWindow failed: ${e instanceof Error ? e.message : e}`);
    }
    sessions.delete(mapKey);
  }, EAGER_CLEANUP_GRACE_MS);

  // Don't block process exit
  if (timer.unref) {
    timer.unref();
  }
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
export async function cleanupOrphanedWindows(config: TmuxClaudeConfig = {}): Promise<number> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  let cleaned = 0;

  // Guard: only clean up orphans if this process has actively created sessions.
  // Other processes (e.g., openclaw-agent) load this module but never create
  // sessions — their empty sessions map would wrongly flag ALL windows as orphans.
  if (!hasEverCreatedSession) {
    console.log(`[tmux-cc] cleanupOrphanedWindows: inst=${MODULE_INSTANCE_ID} skipping — no sessions ever created in this process`);
    return 0;
  }

  // Collect all window names currently tracked in the sessions Map
  const trackedWindows = new Set<string>();
  for (const state of sessions.values()) {
    trackedWindows.add(state.windowName);
  }

  // Scan the current tmux session for orphaned windows
  const currentWindows = await listWindows(mergedConfig.tmuxSession);
  console.log(`[tmux-cc] cleanupOrphanedWindows: inst=${MODULE_INSTANCE_ID}, tracked=[${[...trackedWindows].join(",")}], current=[${currentWindows.join(",")}]`);
  for (const winName of currentWindows) {
    if (winName.startsWith(WINDOW_PREFIX) && !trackedWindows.has(winName)) {
      console.log(`[tmux-cc] cleanupOrphanedWindows: inst=${MODULE_INSTANCE_ID} killing orphaned window=${winName}`);
      await killWindow(mergedConfig.tmuxSession, winName);
      cleaned++;
    }
  }

  // Scan for legacy tmux sessions from previous plugin versions.
  // Known legacy session names that this plugin may have created.
  const legacySessions = ["openclaw-claude"];
  for (const legacySession of legacySessions) {
    if (legacySession === mergedConfig.tmuxSession) continue;
    const legacyWindows = await listWindows(legacySession);
    if (legacyWindows.length === 0) continue;

    // Kill all cc-* windows in legacy sessions
    for (const winName of legacyWindows) {
      if (winName.startsWith(WINDOW_PREFIX)) {
        await killWindow(legacySession, winName);
        cleaned++;
      }
    }
    // If only the default "bash" window remains, kill the entire session
    const remaining = await listWindows(legacySession);
    if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === "bash")) {
      await killSession(legacySession);
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
  cleanupOrphanedWindows(mergedConfig).catch(e => {
    console.error(`[tmux-cc] startCleanupTimer: orphan cleanup failed: ${e instanceof Error ? e.message : e}`);
  });

  // Check every 5 minutes
  const intervalMs = Math.min(mergedConfig.idleTimeoutMs / 6, 5 * 60 * 1000);

  cleanupTimer = setInterval(() => {
    console.log(`[tmux-cc] cleanupInterval: inst=${MODULE_INSTANCE_ID} firing`);
    cleanupIdleSessions(mergedConfig).catch(e => {
      console.error(`[tmux-cc] cleanupInterval: error: ${e instanceof Error ? e.message : e}`);
    });
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
export async function destroyAllSessions(config: TmuxClaudeConfig = {}): Promise<void> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  for (const [key, state] of sessions) {
    await killWindow(mergedConfig.tmuxSession, state.windowName);
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
  return Array.from(new Set(Array.from(sessions.values(), (state) => state.sessionKey)));
}

/**
 * sessionKeyName whose runs are independent: each invocation is a fresh task
 * with no memory carryover (e.g. cron jobs, Telegram /btw side questions).
 *
 * For these kinds, reusing the same tmux window + persisted Claude Code
 * session causes the on-disk transcript JSONL to grow unbounded across runs.
 * Eventually CC's `--resume` (which reads the whole file to rebuild state and
 * may auto-compact) exceeds the gateway's per-call timeout and the run aborts.
 *
 * Callers should skip the sessionKeyName-keyed entries in the stable-key
 * recovery map for these kinds, so each invocation gets a fresh tmux window
 * and a fresh CC session. Persisting under sessionId is still safe and useful
 * because retries inside one cron run share a sessionId.
 *
 * Returns false for null/undefined/empty so callers can pass `name ?? null`.
 */
export function isEphemeralSessionKeyName(name: string | null | undefined): boolean {
  if (!name) return false;
  const s = name.split(":");
  // Expected shape: agent:<agent>:<kind>[:<sub>[:<arg>...]]
  if (s.length < 3) return false;
  if (s[2] === "cron") return true;
  if (s[2] === "telegram" && s[3] === "btw") return true;
  return false;
}
