/**
 * Transparent CC session rotation on observed auto-compact.
 *
 * When Claude Code auto-compacts (token limit hit), it writes a single
 * jsonl entry of shape:
 *
 *   {"type":"user","isCompactSummary":true,
 *    "message":{"role":"user","content":"This session is being continued from
 *    a previous conversation that ran out of context. The summary below
 *    covers the earlier portion of the conversation.\n\nSummary: ..."},...}
 *
 * (Empirically verified against CC v2.1.119 on 2026-04-24.)
 *
 * The content string starts with CC's native continuation prefix, so it can
 * be injected verbatim as the first user message in a fresh CC session and
 * the model treats it as a normal resume context.
 *
 * Flow (see plan G in session-state for full design):
 *
 *   ┌── current turn (pollForResponse jsonl tail) ──┐
 *   │  see entry with isCompactSummary===true       │
 *   │  ─▶ stashPendingRotation(name, {summary,...}) │
 *   │  current turn returns assistant response      │
 *   │  normally (CC keeps writing post-compact)     │
 *   └────────────────────────────────────────────────┘
 *
 *   ┌── next turn (stream-fn entry) ────────────────┐
 *   │  hasPendingRotation(name) → true              │
 *   │  ─▶ consume + kill old window + invalidate    │
 *   │     persisted/stable keys + prepend summary   │
 *   │  proceed normally; getOrCreateSession will    │
 *   │  derive a fresh sessionKey + new CC session.  │
 *   └────────────────────────────────────────────────┘
 *
 * Failure modes are all fail-safe: if detection misses, the next compact
 * gets a new chance; if rotation orchestration throws, caller falls back
 * to fresh start (user notices "it forgot" once).
 */

export interface PendingRotation {
  /** CC's compact summary text, including its native continuation prefix. */
  summary: string;
  /** The CC sessionId being retired (for diagnostics / persistence cleanup). */
  oldClaudeSessionId?: string;
  /** Epoch ms when the compact entry was observed. */
  detectedAt: number;
}

/**
 * TTL for stashed rotations. If the next user message doesn't arrive within
 * an hour, we drop the stash on the assumption that something went sideways
 * (process restart, long idle, etc). Lost stash → next compact stashes
 * again; no rotation this round, no harm.
 */
const ROTATION_TTL_MS = 60 * 60 * 1000;

const pending = new Map<string, PendingRotation>();

export function stashPendingRotation(
  sessionKeyName: string,
  rotation: PendingRotation,
): void {
  if (!sessionKeyName) return;
  pending.set(sessionKeyName, rotation);
}

export function hasPendingRotation(sessionKeyName: string | null | undefined): boolean {
  if (!sessionKeyName) return false;
  const entry = pending.get(sessionKeyName);
  if (!entry) return false;
  if (Date.now() - entry.detectedAt > ROTATION_TTL_MS) {
    pending.delete(sessionKeyName);
    return false;
  }
  return true;
}

export function consumePendingRotation(
  sessionKeyName: string | null | undefined,
): PendingRotation | undefined {
  if (!sessionKeyName) return undefined;
  const entry = pending.get(sessionKeyName);
  pending.delete(sessionKeyName);
  if (!entry) return undefined;
  if (Date.now() - entry.detectedAt > ROTATION_TTL_MS) return undefined;
  return entry;
}

/** Test-only: drop a single stash without consuming. */
export function clearPendingRotation(sessionKeyName: string): void {
  pending.delete(sessionKeyName);
}

/** Test-only: drop all stashes. */
export function clearAllPendingRotations(): void {
  pending.clear();
}

/**
 * Inspect a raw JSONL line and return the compact-summary text if it matches
 * CC's auto-compact shape, otherwise null. Operates on the raw JSON (not the
 * normalized TranscriptEntry) so it can also act as a schema-drift smoke
 * test independent of the rest of the reader pipeline.
 */
export function matchCompactSummary(line: string): { summary: string } | null {
  if (!line || typeof line !== "string") return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.isCompactSummary !== true) return null;
  if (parsed.type !== "user") return null;
  const msg = parsed.message as Record<string, unknown> | undefined;
  if (!msg) return null;
  const content = msg.content;
  let summary: string | null = null;
  if (typeof content === "string") {
    summary = content;
  } else if (Array.isArray(content)) {
    // Defensive: future CC versions might switch to block array form.
    const parts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    summary = parts.join("\n");
  }
  if (!summary || !summary.trim()) return null;
  return { summary };
}

/** Build the prepended user-message text injected into the fresh CC session. */
export function buildRotationPrefix(summary: string, userMessage: string): string {
  // Summary already includes CC's native continuation preamble; just append
  // a clear separator before the actual new user message so the model sees
  // them as one coherent turn.
  return `${summary.trimEnd()}\n\n---\n\n${userMessage}`;
}

/**
 * Dependencies for performRotationIfPending. Injected so tests can verify
 * orchestration without touching the real session map / persistence layer.
 */
export interface RotationExecutionDeps {
  getStableSessionKey: (name: string) => string | undefined;
  deleteSession: (key: string) => Promise<void>;
  removePersistedSession: (key: string) => void;
  removeStableSessionKeysFor: (key: string) => void;
}

/**
 * If a pending rotation is stashed for sessionKeyName, consume it, tear
 * down the old tmux window + persisted/stable-key entries, and return the
 * summary text to prepend to the user's message. Otherwise return null.
 *
 * Fail-safe: any teardown step that throws is caught so we still return
 * the summary; the next steps in stream-fn will derive a fresh sessionKey
 * regardless. If the entire flow can't decide whether to rotate, the only
 * downside is the next jsonl keeps growing — never a hard failure.
 */
export async function performRotationIfPending(
  sessionKeyName: string | null | undefined,
  ephemeral: boolean,
  deps: RotationExecutionDeps,
): Promise<string | null> {
  if (!sessionKeyName || ephemeral) return null;
  if (!hasPendingRotation(sessionKeyName)) return null;
  const pending = consumePendingRotation(sessionKeyName);
  if (!pending) return null;
  const oldSessionKey = deps.getStableSessionKey(sessionKeyName);
  console.log(
    `[tmux-cc] rotation: sessionKeyName=${sessionKeyName}, ` +
    `oldClaudeSessionId=${pending.oldClaudeSessionId ?? "?"}, ` +
    `oldSessionKey=${oldSessionKey ?? "?"}, summaryLen=${pending.summary.length}`,
  );
  if (oldSessionKey) {
    try {
      await deps.deleteSession(oldSessionKey);
    } catch (e) {
      console.error(`[tmux-cc] rotation: deleteSession failed: ${e instanceof Error ? e.message : e}`);
    }
    try { deps.removePersistedSession(oldSessionKey); } catch {}
    try { deps.removeStableSessionKeysFor(oldSessionKey); } catch {}
  }
  return pending.summary;
}
