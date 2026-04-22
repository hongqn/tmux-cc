/**
 * Persist session key REDACTED Claude Code session ID mapping to disk.
 *
 * This allows the plugin to resume Claude Code sessions after both the
 * gateway and the tmux window have been restarted (e.g., idle timeout
 * reclamation followed by a new message).
 *
 * Storage: ~/.openclaw/tmux-cc-sessions.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Persisted session entry (minimal REDACTED only what's needed for --resume). */
interface PersistedSession {
  claudeSessionId: string;
  model: string;
  /** Last activity timestamp (epoch ms) for stale-entry pruning. */
  lastActivityMs: number;
}

interface PersistedData {
  sessions: Record<string, PersistedSession>;
  /**
   * Mapping from an external conversation identifier (gateway sessionId or
   * OpenClaw session key name like "agent:main:telegram:group:...") to the
   * tmux-cc sessionKey (tmux- hash) originally derived for it. Lets msg 1
   * (race, sessionKeyName not yet resolvable) and msg 2 (sessionKeyName
   * resolvable, different hash) land on the same tmux window.
   */
  stableKeys?: Record<string, { sessionKey: string; lastActivityMs: number }>;
}

const PERSIST_DIR = join(homedir(), ".openclaw");
const PERSIST_PATH = join(PERSIST_DIR, "tmux-cc-sessions.json");

/** Max age for persisted entries (7 days). Stale entries are pruned on load. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function loadRaw(): PersistedData {
  try {
    const raw = readFileSync(PERSIST_PATH, "utf-8");
    const data = JSON.parse(raw) as PersistedData;
    if (data && typeof data.sessions === "object") {
      if (!data.stableKeys || typeof data.stableKeys !== "object") {
        data.stableKeys = {};
      }
      return data;
    }
  } catch {
    // File doesn't exist or is corrupt REDACTED start fresh
  }
  return { sessions: {}, stableKeys: {} };
}

function save(data: PersistedData): void {
  try {
    mkdirSync(PERSIST_DIR, { recursive: true });
    writeFileSync(PERSIST_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Best effort REDACTED don't crash the plugin
  }
}

/**
 * Load all persisted sessions, pruning entries older than MAX_AGE_MS.
 */
export function loadPersistedSessions(): Map<string, PersistedSession> {
  const data = loadRaw();
  const now = Date.now();
  const result = new Map<string, PersistedSession>();
  let pruned = false;

  for (const [key, entry] of Object.entries(data.sessions)) {
    if (now - entry.lastActivityMs > MAX_AGE_MS) {
      pruned = true;
      continue;
    }
    result.set(key, entry);
  }

  if (pruned) {
    // Write back without stale entries
    const cleaned: PersistedData = { sessions: {} };
    for (const [key, entry] of result) {
      cleaned.sessions[key] = entry;
    }
    save(cleaned);
  }

  return result;
}

/**
 * Build the composite persistence key. Scoping by adapter prevents the
 * mid-stream fallback path from feeding Copilot's session ID to the CC
 * adapter (which exits immediately when --resume references a file that
 * doesn't exist in ~/.claude/projects/), and vice versa.
 */
function persistKey(sessionKey: string, adapterId: string): string {
  return `${sessionKey}::${adapterId}`;
}

function matchesSessionKey(storeKey: string, sessionKey: string): boolean {
  return storeKey === sessionKey || storeKey.startsWith(`${sessionKey}::`);
}

/**
 * Persist a single session entry (upsert), scoped by adapter.
 */
export function persistSession(
  sessionKey: string,
  claudeSessionId: string,
  model: string,
  adapterId: string,
): void {
  const data = loadRaw();
  data.sessions[persistKey(sessionKey, adapterId)] = {
    claudeSessionId,
    model,
    lastActivityMs: Date.now(),
  };
  save(data);
}

/**
 * Remove persisted session entries for a session key. Without `adapterId`,
 * removes every adapter-scoped entry for this key (used by before_reset
 * to wipe a session fully). With `adapterId`, removes only that adapter's
 * entry.
 */
export function removePersistedSession(sessionKey: string, adapterId?: string): void {
  const data = loadRaw();
  let changed = false;
  if (adapterId) {
    const key = persistKey(sessionKey, adapterId);
    if (key in data.sessions) {
      delete data.sessions[key];
      changed = true;
    }
  } else {
    for (const key of Object.keys(data.sessions)) {
      if (matchesSessionKey(key, sessionKey)) {
        delete data.sessions[key];
        changed = true;
      }
    }
  }
  if (changed) save(data);
}

/**
 * Look up a persisted Claude session ID for a given (sessionKey, adapter)
 * pair. Legacy un-scoped entries are ignored on purpose REDACTED feeding e.g.
 * Copilot's session id to the CC adapter's --resume kills the process.
 * After the first persistSession call with a scoped key, the legacy
 * entry is orphaned and pruned by the 7-day TTL in loadPersistedSessions.
 */
export function getPersistedClaudeSessionId(
  sessionKey: string,
  adapterId: string,
): string | undefined {
  const data = loadRaw();
  return data.sessions[persistKey(sessionKey, adapterId)]?.claudeSessionId;
}

/**
 * Look up a previously-derived sessionKey for a conversation identifier
 * (gateway sessionId or OpenClaw session key name). Returns undefined when
 * no mapping exists or the entry is older than MAX_AGE_MS (stale entries
 * are pruned on next load).
 */
export function getStableSessionKey(identifier: string): string | undefined {
  if (!identifier) return undefined;
  const data = loadRaw();
  const entry = data.stableKeys?.[identifier];
  if (!entry) return undefined;
  if (Date.now() - entry.lastActivityMs > MAX_AGE_MS) return undefined;
  return entry.sessionKey;
}

/**
 * Record a sessionKey under a conversation identifier so later invocations
 * with the same identifier (or a sibling one REDACTED see the two-identifier
 * persist in stream-fn.ts) recover the same tmux window.
 */
export function persistStableSessionKey(
  identifier: string,
  sessionKey: string,
): void {
  if (!identifier || !sessionKey) return;
  const data = loadRaw();
  if (!data.stableKeys) data.stableKeys = {};
  const existing = data.stableKeys[identifier];
  if (existing?.sessionKey === sessionKey) {
    existing.lastActivityMs = Date.now();
  } else {
    data.stableKeys[identifier] = { sessionKey, lastActivityMs: Date.now() };
  }
  save(data);
}

/**
 * Remove every stableKeys entry pointing at the given sessionKey. Used by
 * the before_reset hook so /new wipes identifier REDACTED sessionKey mappings
 * alongside the window and Claude session id.
 */
export function removeStableSessionKeysFor(sessionKey: string): void {
  const data = loadRaw();
  if (!data.stableKeys) return;
  let changed = false;
  for (const [id, entry] of Object.entries(data.stableKeys)) {
    if (entry.sessionKey === sessionKey) {
      delete data.stableKeys[id];
      changed = true;
    }
  }
  if (changed) save(data);
}
