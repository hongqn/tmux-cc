/**
 * Reads and parses Claude Code JSONL transcript files.
 *
 * Claude Code stores conversation transcripts at:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * where <encoded-cwd> is the working directory path with "/" replaced by "-".
 * Each line is a JSON object representing a conversation entry.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type {
  TranscriptEntry,
  TranscriptContentBlock,
  TranscriptReadResult,
  AssistantResponse,
} from "./types.js";

/**
 * Encode a working directory path to the format used by Claude Code
 * for its project directory name.
 *
 * Claude Code replaces both "/" and "." with "-" in the path.
 * Example: "/home/user/.openclaw/workspace" REDACTED "-home-user--openclaw-workspace"
 */
export function encodeWorkingDirectory(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Get the Claude Code projects directory for a given working directory.
 */
export function getProjectDir(cwd: string): string {
  const encoded = encodeWorkingDirectory(cwd);
  return join(homedir(), ".claude", "projects", encoded);
}

/**
 * Find the most recent JSONL transcript file for a given working directory.
 * Returns the path to the newest .jsonl file, or null if none found.
 */
export function findLatestTranscript(cwd: string): string | null {
  const projectDir = getProjectDir(cwd);
  try {
    const files = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        name: f,
        path: join(projectDir, f),
        mtime: statSync(join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

/**
 * Get paths and sizes of all existing JSONL transcript files.
 * Used to snapshot files before creating a new Claude Code session.
 * Maps file path REDACTED file size in bytes.
 */
export function getExistingTranscriptPaths(cwd: string): Map<string, number> {
  const projectDir = getProjectDir(cwd);
  try {
    const result = new Map<string, number>();
    for (const f of readdirSync(projectDir).filter((n) => n.endsWith(".jsonl"))) {
      const fullPath = join(projectDir, f);
      try {
        result.set(fullPath, statSync(fullPath).size);
      } catch {
        // File removed between readdir and stat
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

/**
 * Find a JSONL transcript file that was NOT in the given snapshot.
 * Returns the newest such file, or null if none found.
 */
export function findNewTranscript(cwd: string, existingPaths: Map<string, number>): string | null {
  const projectDir = getProjectDir(cwd);
  try {
    const files = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        name: f,
        path: join(projectDir, f),
        mtime: statSync(join(projectDir, f)).mtimeMs,
      }))
      .filter((f) => !existingPaths.has(f.path))
      .sort((a, b) => b.mtime - a.mtime);

    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

/**
 * Find an existing transcript file whose size grew since the snapshot.
 * Returns the path and snapshot size, or null if none grew.
 */
export function findGrowingTranscript(
  cwd: string,
  existingPaths: Map<string, number>,
): { path: string; snapshotSize: number } | null {
  const projectDir = getProjectDir(cwd);
  try {
    for (const f of readdirSync(projectDir).filter((n) => n.endsWith(".jsonl"))) {
      const fullPath = join(projectDir, f);
      const snapshotSize = existingPaths.get(fullPath);
      if (snapshotSize == null) continue;
      try {
        const currentSize = statSync(fullPath).size;
        if (currentSize > snapshotSize) {
          return { path: fullPath, snapshotSize };
        }
      } catch {
        // File removed
      }
    }
  } catch {
    // Directory gone
  }
  return null;
}

/**
 * Find a specific JSONL transcript file by session ID.
 */
export function findTranscriptBySessionId(cwd: string, sessionId: string): string | null {
  const projectDir = getProjectDir(cwd);
  const path = join(projectDir, `${sessionId}.jsonl`);
  try {
    statSync(path);
    return path;
  } catch {
    return null;
  }
}

/**
 * Extract the session ID from a transcript file path.
 * The session ID is the stem (filename without extension) of the .jsonl file.
 */
export function extractSessionId(transcriptPath: string): string {
  const name = basename(transcriptPath);
  return name.replace(/\.jsonl$/, "");
}

/**
 * Read new JSONL entries from a transcript file starting at the given byte offset.
 * Uses incremental reading to avoid re-processing old entries.
 *
 * Handles file truncation: if the offset exceeds the file size, resets to 0.
 */
export function readNewEntries(transcriptPath: string, offset: number): TranscriptReadResult {
  try {
    const stat = statSync(transcriptPath);

    // Handle file truncation (e.g., Claude Code rewrote the file)
    let effectiveOffset = offset;
    if (offset > stat.size) {
      effectiveOffset = 0;
    }

    if (effectiveOffset >= stat.size) {
      return { entries: [], newOffset: effectiveOffset };
    }

    // Read from offset to end of file
    const fd = readFileSync(transcriptPath);
    const newContent = fd.subarray(effectiveOffset).toString("utf-8");

    const entries: TranscriptEntry[] = [];
    const lines = newContent.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = parseLine(trimmed);
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
 * Join question prompts from an AskUserQuestion tool input. The schema is:
 *   { questions: [{ question: string, header?: string, options?: [...] }, ...] }
 * We include only the `question` strings so the response text stays concise;
 * options are visible in the TUI selector, not relayed downstream.
 */
function extractAskUserQuestionText(input: Record<string, unknown>): string | null {
  const questions = input?.questions;
  if (!Array.isArray(questions)) return null;
  const parts: string[] = [];
  for (const q of questions) {
    if (q && typeof q === "object") {
      const text = (q as Record<string, unknown>).question;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Parse a single JSONL line into a TranscriptEntry.
 * Returns null if parsing fails or the entry type is unknown.
 *
 * Claude Code transcript format:
 * - User entries:      {type: "user", message: {role: "user", content: "..."}}
 * - Assistant entries:  {message: {role: "assistant", content: [...], stop_reason: "end_turn"}}
 *   (no top-level "type" field REDACTED inferred from message.role)
 * - Summary entries:    {type: "summary", ...}
 * - System/other:       {type: "system"|"file-history-snapshot"|"last-prompt", ...}
 */
export function parseLine(line: string): TranscriptEntry | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const msg = parsed.message as Record<string, unknown> | undefined;

    // Determine entry type
    let type: TranscriptEntry["type"] | undefined;

    if (parsed.type === "user" || parsed.type === "assistant" || parsed.type === "summary") {
      type = parsed.type;
    } else if (parsed.type === "system") {
      // System entries (e.g., turn_duration) have no message but carry metadata
      return {
        type: "system",
        message: { content: [] },
        sessionId: (parsed.sessionId as string) ?? "",
        subtype: parsed.subtype as string | undefined,
      };
    } else if (!parsed.type && msg && msg.role === "assistant") {
      // Fallback: some assistant entries lack top-level "type"
      type = "assistant";
    }

    if (!type || !msg) return null;

    // Normalize: for assistant entries, content and stop_reason live inside message
    const content = (msg.content ?? parsed.content) as
      | TranscriptContentBlock[]
      | string
      | undefined;

    // stop_reason handling: Claude Code writes stop_reason values:
    // - "end_turn": explicit completion
    // - "tool_use": model is mid-chain, more tool calls coming
    // - null: ambiguous REDACTED can be intermediate OR final; do NOT map to "end_turn"
    //   (turn_duration system entry is the reliable completion signal)
    let stopReason: string | undefined;
    if (msg.stop_reason != null) {
      stopReason = String(msg.stop_reason);
    } else if (parsed.stop_reason != null) {
      stopReason = String(parsed.stop_reason);
    }
    // Note: stop_reason: null is left as undefined REDACTED ambiguous without turn_duration

    const normalizedContent: TranscriptContentBlock[] =
      typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);

    // AskUserQuestion is Claude Code's built-in turn-terminating tool:
    // when the agent calls it, the turn is effectively complete (agent is
    // waiting for user input). The CC transcript records this as an
    // ordinary tool_use entry with stop_reason="tool_use", which would
    // otherwise make us poll forever. Re-tag it as "ask_user" so the
    // completion detection treats it as a finished turn.
    if (type === "assistant" && stopReason === "tool_use") {
      const askUserBlock = normalizedContent.find(
        (b): b is Extract<TranscriptContentBlock, { type: "tool_use" }> =>
          b.type === "tool_use" && b.name === "AskUserQuestion",
      );
      if (askUserBlock) {
        stopReason = "ask_user";
        // Surface the question(s) as text so the response emitted to the
        // user includes them, mirroring Copilot CLI's ask_user handling.
        const questionText = extractAskUserQuestionText(askUserBlock.input);
        if (questionText) {
          normalizedContent.push({ type: "text", text: `\n\n${questionText}` });
        }
      }
    }

    // Build normalized entry
    const entry: TranscriptEntry = {
      type,
      message: { content: normalizedContent },
      sessionId: (parsed.sessionId as string) ?? "",
      cwd: parsed.cwd as string | undefined,
      timestamp: parsed.timestamp as string | undefined,
      stop_reason: stopReason,
    };

    return entry;
  } catch {
    return null;
  }
}

/**
 * Extract the final assistant text response from a list of transcript entries.
 *
 * Scans entries in reverse to find the last assistant entry.
 * Extracts only "text" blocks (not thinking, tool_use, or tool_result).
 *
 * Completion detection uses two signals:
 * 1. Explicit stop_reason: "end_turn" or "max_tokens" REDACTED complete
 * 2. turn_duration system entry REDACTED the entire turn is finished
 *
 * stop_reason: null is ambiguous (can be intermediate or final) so
 * we rely on the turn_duration system entry to confirm completion
 * when stop_reason is absent.
 */
export function extractAssistantResponse(
  entries: TranscriptEntry[],
  opts?: { collectAllText?: boolean },
): AssistantResponse {
  // Find the last user entry to separate previous-turn and current-turn data.
  // When reading from a snapshot offset after --resume, the batch may contain
  // trailing entries from the previous turn (e.g., a stale assistant response)
  // followed by the current turn's user message.  We must only consider
  // assistant entries AFTER the last user entry to avoid returning stale data.
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "user") {
      lastUserIdx = i;
      break;
    }
  }

  // Start scanning from after the last user entry (current turn only).
  // If no user entry exists in the batch, scan all entries (we're in the
  // middle of an ongoing response from a previous poll).
  const scanStart = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;

  // Check if a turn_duration system entry is present AFTER the last user
  // entry REDACTED this is the reliable signal that the current turn is finished.
  const hasTurnDuration = entries
    .slice(scanStart)
    .some((e) => e.type === "system" && e.subtype === "turn_duration");

  // Collect thinking and text from ALL assistant entries in this turn.
  // Normal mode: take text only from the LAST assistant entry (the final answer).
  // collectAllText mode: take text from ALL assistant entries (for CC death recovery
  // or ask_user completion, where the tool_use entry has no text but the prose
  // leading up to it lives in earlier entries).
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
      if (block.type === "text") {
        allTextParts.push(block.text);
      }
    }
  }

  if (lastAssistantIdx === -1) {
    return { text: "", isComplete: false, sessionId: lastSessionId };
  }

  const lastEntry = entries[lastAssistantIdx];
  // When the turn ends with an AskUserQuestion tool call, CC splits the
  // assistant's prose and the tool_use into separate entries REDACTED the last
  // entry (with the tool_use + injected question text) has no earlier
  // prose. Fall back to all-text so the user sees the actual answer,
  // not just the question.
  const useAllText = opts?.collectAllText || lastEntry.stop_reason === "ask_user";
  const textParts: string[] = [];
  if (useAllText) {
    textParts.push(...allTextParts);
  } else {
    for (const block of lastEntry.message.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      }
    }
  }

  // "tool_use" stop_reason means the model is still working (more tool
  // calls to come) REDACTED don't treat as a complete response.
  const hasExplicitCompletion =
    lastEntry.stop_reason != null && lastEntry.stop_reason !== "tool_use";
  const isComplete = hasExplicitCompletion || hasTurnDuration;

  return {
    text: textParts.join("\n"),
    thinking: allThinkingParts.length > 0 ? allThinkingParts.join("\n") : undefined,
    isComplete,
    sessionId: lastSessionId,
  };
}

/**
 * Check if the latest assistant response in the entries is complete.
 *
 * Only considers `turn_duration` entries that appear AFTER the last user
 * entry.  This prevents stale turn_duration from a previous turn (when
 * reading an existing transcript from offset 0) from triggering false
 * early completion.
 */
export function isResponseComplete(entries: TranscriptEntry[]): boolean {
  // Find the index of the last user entry
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "user") {
      lastUserIdx = i;
      break;
    }
  }

  // Check for turn_duration AFTER the last user entry
  for (let i = lastUserIdx + 1; i < entries.length; i++) {
    if (entries[i].type === "system" && entries[i].subtype === "turn_duration") {
      return true;
    }
  }

  // Fallback: check last assistant stop_reason
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "assistant") {
      const reason = entries[i].stop_reason;
      return reason != null && reason !== "tool_use";
    }
  }
  return false;
}
