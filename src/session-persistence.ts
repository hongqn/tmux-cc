/**
 * Persist session key REDACTED Claude Code session ID mapping to disk.
 *
 * This allows the plugin to resume Claude Code sessions after both the
 * gateway and the tmux window have been restarted (e.g., idle timeout
 * reclamation followed by a new message).
 *
 * Storage: ~/.openclaw/tmux-claude-sessions.json
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
}

const PERSIST_DIR = join(homedir(), ".openclaw");
const PERSIST_PATH = join(PERSIST_DIR, "tmux-claude-sessions.json");

/** Max age for persisted entries (7 days). Stale entries are pruned on load. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function loadRaw(): PersistedData {
  try {
    const raw = readFileSync(PERSIST_PATH, "utf-8");
    const data = JSON.parse(raw) as PersistedData;
    if (data && typeof data.sessions === "object") {
      return data;
    }
  } catch {
    // File doesn't exist or is corrupt REDACTED start fresh
  }
  return { sessions: {} };
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
 * Persist a single session entry (upsert).
 */
export function persistSession(sessionKey: string, claudeSessionId: string, model: string): void {
  const data = loadRaw();
  data.sessions[sessionKey] = {
    claudeSessionId,
    model,
    lastActivityMs: Date.now(),
  };
  save(data);
}

/**
 * Remove a persisted session entry.
 */
export function removePersistedSession(sessionKey: string): void {
  const data = loadRaw();
  if (sessionKey in data.sessions) {
    delete data.sessions[sessionKey];
    save(data);
  }
}

/**
 * Look up a persisted Claude session ID for a given session key.
 */
export function getPersistedClaudeSessionId(sessionKey: string): string | undefined {
  const data = loadRaw();
  return data.sessions[sessionKey]?.claudeSessionId;
}
