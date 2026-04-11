/**
 * Shared types for the tmux-cc provider plugin.
 */

/** Plugin configuration schema. */
export interface TmuxClaudeConfig {
  /** Working directory for Claude Code sessions (where CLAUDE.md lives). */
  workingDirectory?: string;
  /** Path to Claude Code CLI executable. */
  claudeCommand?: string;
  /** Name of the tmux session to use. */
  tmuxSession?: string;
  /** Polling interval for JSONL transcript in milliseconds. */
  pollingIntervalMs?: number;
  /** Maximum time to wait for a response in milliseconds. */
  responseTimeoutMs?: number;
  /** Time after which idle Claude Code instances are cleaned up. */
  idleTimeoutMs?: number;
  /** Default Claude model to use (e.g., "sonnet-4.6"). */
  defaultModel?: string;
}

export const DEFAULT_CONFIG: Required<TmuxClaudeConfig> = {
  workingDirectory: process.cwd(),
  claudeCommand: "claude",
  tmuxSession: "openclaw-cc",
  pollingIntervalMs: 1000,
  responseTimeoutMs: 300_000,
  idleTimeoutMs: 1_800_000,
  defaultModel: "sonnet-4.6",
};

/** State for a single Claude Code session mapped to an OpenClaw conversation. */
export interface SessionState {
  /** OpenClaw session key (conversation identifier). */
  sessionKey: string;
  /** tmux window name (unique within the tmux session). */
  windowName: string;
  /** Claude Code session ID (from JSONL transcript). */
  claudeSessionId?: string;
  /** Path to the JSONL transcript file. */
  transcriptPath?: string;
  /** Byte offset for incremental JSONL reading. */
  transcriptOffset: number;
  /** Timestamp of last activity (message sent or response received). */
  lastActivityMs: number;
  /** The model currently used by this session. */
  model: string;
  /** Number of completed request/response turns in this session. */
  turnCount: number;
  /**
   * Snapshot of existing transcript files taken before creating the tmux window.
   * Maps file path REDACTED file size at snapshot time.
   * Used by pollForResponse to identify NEW files or detect when Claude Code
   * appends to an existing file (size increase).
   */
  existingTranscriptPaths?: Map<string, number>;
  /** OpenClaw agent account ID (e.g., "myagent") REDACTED used to set env var for MCP server. */
  agentAccountId?: string;
}

/**
 * Claude Code JSONL transcript entry.
 * Based on analysis of ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 */
export interface TranscriptEntry {
  type: "user" | "assistant" | "summary" | "system";
  message: {
    content: TranscriptContentBlock[];
  };
  sessionId: string;
  cwd?: string;
  timestamp?: string;
  /** Present when the assistant turn is complete. */
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  stop_reason?: "end_turn" | "max_tokens" | string;
  /** System entry subtype (e.g., "turn_duration"). */
  subtype?: string;
}

export type TranscriptContentBlock =
  | TranscriptTextBlock
  | TranscriptThinkingBlock
  | TranscriptToolUseBlock
  | TranscriptToolResultBlock;

export interface TranscriptTextBlock {
  type: "text";
  text: string;
}

export interface TranscriptThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface TranscriptToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TranscriptToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

/** Result of reading new JSONL entries from a transcript file. */
export interface TranscriptReadResult {
  entries: TranscriptEntry[];
  newOffset: number;
}

/** Result of extracting assistant response text from transcript entries. */
export interface AssistantResponse {
  text: string;
  thinking?: string;
  isComplete: boolean;
  sessionId?: string;
}
