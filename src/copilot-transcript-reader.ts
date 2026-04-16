/**
 * Reads and parses Copilot CLI event transcript files.
 *
 * Copilot CLI stores conversation transcripts at:
 *   ~/.copilot/session-state/<session-id>/events.jsonl
 *
 * Each line is a JSON event object. Key event types:
 * - session.start: session metadata (sessionId, context)
 * - user.message: user input (content field)
 * - assistant.message: assistant response (content + toolRequests)
 * - assistant.turn_start/turn_end: turn boundaries
 * - tool.execution_start/complete: tool call lifecycle
 *
 * This module converts Copilot events into the shared TranscriptEntry
 * format used by the stream function and session map.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  TranscriptEntry,
  TranscriptContentBlock,
  TranscriptReadResult,
  AssistantResponse,
} from "./types.js";

/**
 * Get the Copilot session state directory.
 */
export function getSessionStateDir(): string {
  return join(homedir(), ".copilot", "session-state");
}

/**
 * Get the transcript path for a specific Copilot session ID.
 */
export function getTranscriptPath(sessionId: string): string {
  return join(getSessionStateDir(), sessionId, "events.jsonl");
}

/**
 * Find the most recent events.jsonl transcript file across all sessions.
 * Returns the path to the newest file, or null if none found.
 *
 * Note: Unlike CC, Copilot transcripts are NOT scoped to a project directory.
 * All sessions live under ~/.copilot/session-state/<id>/events.jsonl.
 * The `cwd` parameter is accepted for API compatibility but not used for
 * directory scoping (Copilot doesn't organize by project).
 */
export function findLatestTranscript(_cwd: string): string | null {
  const stateDir = getSessionStateDir();
  try {
    const sessions = readdirSync(stateDir).filter((f) => {
      const eventsPath = join(stateDir, f, "events.jsonl");
      try { statSync(eventsPath); return true; } catch { return false; }
    });

    if (sessions.length === 0) return null;

    const sorted = sessions
      .map((s) => {
        const p = join(stateDir, s, "events.jsonl");
        return { path: p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    return sorted[0].path;
  } catch {
    return null;
  }
}

/**
 * Get paths and sizes of all existing events.jsonl transcript files.
 * Used to snapshot before creating a new Copilot session.
 */
export function getExistingTranscriptPaths(_cwd: string): Map<string, number> {
  const stateDir = getSessionStateDir();
  try {
    const result = new Map<string, number>();
    for (const s of readdirSync(stateDir)) {
      const eventsPath = join(stateDir, s, "events.jsonl");
      try {
        result.set(eventsPath, statSync(eventsPath).size);
      } catch {
        // No events.jsonl in this session
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

/**
 * Find an events.jsonl file that was NOT in the given snapshot.
 */
export function findNewTranscript(_cwd: string, existingPaths: Map<string, number>): string | null {
  const stateDir = getSessionStateDir();
  try {
    const candidates = readdirSync(stateDir)
      .map((s) => {
        const p = join(stateDir, s, "events.jsonl");
        try {
          return { path: p, mtime: statSync(p).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((c): c is { path: string; mtime: number } => c !== null)
      .filter((c) => !existingPaths.has(c.path))
      .sort((a, b) => b.mtime - a.mtime);

    return candidates.length > 0 ? candidates[0].path : null;
  } catch {
    return null;
  }
}

/**
 * Find an existing transcript file whose size grew since the snapshot.
 */
export function findGrowingTranscript(
  _cwd: string,
  existingPaths: Map<string, number>,
): { path: string; snapshotSize: number } | null {
  for (const [path, snapshotSize] of existingPaths) {
    try {
      const currentSize = statSync(path).size;
      if (currentSize > snapshotSize) {
        return { path, snapshotSize };
      }
    } catch {
      // File removed
    }
  }
  return null;
}

/**
 * Find a transcript file by Copilot session ID.
 */
export function findTranscriptBySessionId(_cwd: string, sessionId: string): string | null {
  const path = getTranscriptPath(sessionId);
  try {
    statSync(path);
    return path;
  } catch {
    return null;
  }
}

/**
 * Extract the session ID from a transcript file path.
 * Path format: ~/.copilot/session-state/<session-id>/events.jsonl
 * The session ID is the parent directory name.
 */
export function extractSessionId(transcriptPath: string): string {
  // Get the directory name containing events.jsonl
  const parts = transcriptPath.split("/");
  // events.jsonl is the last part, session-id is the second-to-last
  return parts[parts.length - 2];
}

/**
 * Read new JSONL entries from a Copilot transcript file starting at byte offset.
 * Converts Copilot events into TranscriptEntry format.
 */
export function readNewEntries(transcriptPath: string, offset: number): TranscriptReadResult {
  try {
    const stat = statSync(transcriptPath);

    let effectiveOffset = offset;
    if (offset > stat.size) {
      effectiveOffset = 0;
    }

    if (effectiveOffset >= stat.size) {
      return { entries: [], newOffset: effectiveOffset };
    }

    const fd = readFileSync(transcriptPath);
    const newContent = fd.subarray(effectiveOffset).toString("utf-8");

    const entries: TranscriptEntry[] = [];
    const lines = newContent.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = parseEvent(trimmed);
      if (entry) {
        entries.push(entry);
      }
    }

    return {
      entries,
      newOffset: stat.size,
    };
  } catch {
    return { entries: [], newOffset: offset };
  }
}

/**
 * Copilot event types that we care about.
 */
interface CopilotEvent {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  timestamp?: string;
}

/**
 * Parse a single Copilot event line into a TranscriptEntry.
 *
 * Copilot events mapped to TranscriptEntry:
 * - user.message REDACTED {type: "user", ...}
 * - assistant.message REDACTED {type: "assistant", ...}
 * - assistant.turn_end REDACTED {type: "system", subtype: "turn_duration"}
 *   (maps to CC's turn_duration signal for completion detection)
 * - session.start REDACTED extracted for sessionId
 */
export function parseEvent(line: string): TranscriptEntry | null {
  try {
    const event = JSON.parse(line) as CopilotEvent;
    const sessionId = extractEventSessionId(event);

    switch (event.type) {
      case "user.message":
        return parseUserMessage(event, sessionId);
      case "assistant.message":
        return parseAssistantMessage(event, sessionId);
      case "assistant.turn_end":
        // Map to the "turn_duration" system entry that CC uses
        // for reliable completion detection
        return {
          type: "system",
          message: { content: [] },
          sessionId,
          subtype: "turn_duration",
          timestamp: event.timestamp,
        };
      case "session.error":
        return parseSessionError(event, sessionId);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function extractEventSessionId(event: CopilotEvent): string {
  // sessionId can be in event.data.sessionId or derived from the file path
  return (event.data?.sessionId as string) ?? "";
}

function parseUserMessage(event: CopilotEvent, sessionId: string): TranscriptEntry {
  const content = (event.data?.content as string) ?? "";
  return {
    type: "user",
    message: {
      content: [{ type: "text", text: content }],
    },
    sessionId,
    timestamp: event.timestamp,
  };
}

/**
 * Synthesize a completed assistant entry from a session.error event. Without
 * this, Copilot CLI failures like rate limits show a message in the TUI but
 * never land as `assistant.message` events REDACTED the poller would hang on an
 * empty turn and `containsRateLimitError` (which looks at response.text)
 * would never trigger the adapter's recordRateLimit hook.
 *
 * The synthetic entry carries the error message as text and stop_reason
 * "end_turn" so extractAssistantResponse returns a complete response and
 * the stream-fn rate-limit-detection path runs normally.
 */
function parseSessionError(event: CopilotEvent, sessionId: string): TranscriptEntry {
  const errorType = (event.data?.errorType as string) ?? "unknown";
  const message = (event.data?.message as string) ?? "Copilot CLI session error";
  // Prefix with errorType so containsRateLimitError patterns (rate.?limit,
  // 429, overloaded, REDACTED) match for all the relevant classifications even
  // when the message text is localized or phrased unusually.
  const text = `[${errorType}] ${message}`;
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    sessionId,
    timestamp: event.timestamp,
    stop_reason: "end_turn",
  };
}

function parseAssistantMessage(event: CopilotEvent, sessionId: string): TranscriptEntry {
  const blocks: TranscriptContentBlock[] = [];

  // Text content
  const content = event.data?.content as string | undefined;
  if (content) {
    blocks.push({ type: "text", text: content });
  }

  // Tool requests REDACTED tool_use blocks
  const toolRequests = event.data?.toolRequests as Array<{
    toolCallId: string;
    name: string;
    arguments: Record<string, unknown>;
    type?: string;
  }> | undefined;

  if (toolRequests) {
    for (const req of toolRequests) {
      blocks.push({
        type: "tool_use",
        id: req.toolCallId,
        name: req.name,
        input: req.arguments ?? {},
      });
    }
  }

  // Determine stop_reason:
  // - ask_user tool call = turn is effectively complete (agent is waiting for input)
  // - other tool requests = "tool_use" (agent is still working)
  // - no tool requests = undefined (completion detected via turn_duration)
  const hasAskUser = toolRequests?.some((r) => r.name === "ask_user") ?? false;
  const stopReason = hasAskUser
    ? "ask_user"
    : toolRequests && toolRequests.length > 0
      ? "tool_use"
      : undefined;

  // Append ask_user question as text so it appears in the response
  // visible in Telegram. Without this, only the text content before ask_user shows.
  if (hasAskUser) {
    const askUserReq = toolRequests!.find((r) => r.name === "ask_user");
    const question = askUserReq?.arguments?.question as string | undefined;
    if (question) {
      blocks.push({ type: "text", text: `\n\n${question}` });
    }
  }

  return {
    type: "assistant",
    message: { content: blocks },
    sessionId,
    timestamp: event.timestamp,
    stop_reason: stopReason,
  };
}

/**
 * Extract assistant response from Copilot transcript entries.
 * Same logic as CC's extractAssistantResponse REDACTED scan from last user entry,
 * collect thinking/text, check for turn_duration completion signal.
 */
export function extractAssistantResponse(
  entries: TranscriptEntry[],
  opts?: { collectAllText?: boolean },
): AssistantResponse {
  // Find the last user entry
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const scanStart = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;

  // Check for turn_duration (our mapped turn_end)
  const hasTurnDuration = entries
    .slice(scanStart)
    .some((e) => e.type === "system" && e.subtype === "turn_duration");

  const allThinkingParts: string[] = [];
  const allTextParts: string[] = [];
  let lastAssistantIdx = -1;
  let lastSessionId: string | undefined;

  for (let i = scanStart; i < entries.length; i++) {
    if (entries[i].type !== "assistant") continue;
    lastAssistantIdx = i;
    lastSessionId = entries[i].sessionId ?? lastSessionId;

    for (const block of entries[i].message.content) {
      if (block.type === "thinking") {
        allThinkingParts.push(block.thinking);
      }
      if (block.type === "text" && opts?.collectAllText) {
        allTextParts.push(block.text);
      }
    }
  }

  if (lastAssistantIdx === -1) {
    return { text: "", isComplete: false, sessionId: lastSessionId };
  }

  const lastEntry = entries[lastAssistantIdx];
  const textParts: string[] = [];
  if (opts?.collectAllText) {
    textParts.push(...allTextParts);
  } else {
    for (const block of lastEntry.message.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      }
    }
  }

  const hasExplicitCompletion =
    lastEntry.stop_reason != null && lastEntry.stop_reason !== "tool_use";
  // ask_user is treated as completion REDACTED the agent is waiting for user input
  const isComplete = hasExplicitCompletion || hasTurnDuration;

  return {
    text: textParts.join("\n"),
    thinking: allThinkingParts.length > 0 ? allThinkingParts.join("\n") : undefined,
    isComplete,
    sessionId: lastSessionId,
  };
}
