/**
 * AgentAdapter interface — abstraction layer for CLI agents (Claude Code, Copilot CLI, etc.).
 *
 * Each adapter encapsulates the agent-specific logic:
 * - How to launch and detect the agent in tmux
 * - How to read and parse conversation transcripts
 * - How to set up the workspace
 * - Model catalog and ID mapping
 *
 * Generic tmux operations (sendKeys, killWindow, etc.) remain in tmux-manager.ts.
 */
import type { TranscriptEntry, TranscriptReadResult, AssistantResponse } from "../types.js";

/** Model definition for an agent. */
export interface AgentModelDef {
  /** Short model ID used in OpenClaw (e.g., "sonnet-4.6") */
  id: string;
  /** Human-readable name (e.g., "Claude Sonnet 4.6 (tmux)") */
  name: string;
  /** Internal model ID for the agent CLI (e.g., "claude-sonnet-4-6") */
  agentModelId: string;
  /** Whether the model supports extended thinking */
  reasoning: boolean;
  /** Context window size in tokens */
  contextWindow: number;
  /** Maximum output tokens */
  maxTokens: number;
}

/**
 * Agent adapter interface.
 *
 * Implementations provide agent-specific lifecycle, transcript, and workspace
 * operations. The session manager and stream function use this interface to
 * remain agent-agnostic.
 */
export interface AgentAdapter {
  /** Unique adapter identifier (e.g., "claude-code") */
  readonly id: string;

  /** Model catalog for this agent */
  readonly models: AgentModelDef[];

  // ─── Lifecycle ─────────────────────────────────────────────

  /**
   * Create a tmux window running the agent.
   * The adapter builds the correct CLI command and env flags.
   */
  createAgentWindow(params: {
    tmuxSession: string;
    windowName: string;
    workingDirectory: string;
    model: string;
    resumeSessionId?: string;
    /** OpenClaw agent account ID — set as env var for MCP server to resolve botToken. */
    agentAccountId?: string;
  }): Promise<void>;

  /**
   * Wait for the agent to become ready in the tmux window.
   * Handles agent-specific startup prompts (trust dialogs, etc.).
   * @returns true if ready within timeout, false otherwise
   */
  waitForReady(tmuxSession: string, windowName: string, timeoutMs?: number): Promise<boolean>;

  /** Check if the agent's TUI is ready to accept input (has prompt). */
  isWindowReady(tmuxSession: string, windowName: string): Promise<boolean>;

  /** Check if the agent process is alive in the tmux window. */
  isProcessAlive(tmuxSession: string, windowName: string): Promise<boolean>;

  /** Check if the agent is actively processing a request. */
  isProcessing(tmuxSession: string, windowName: string): Promise<boolean>;

  /**
   * Switch the model in an existing agent session.
   * May interrupt ongoing processing if necessary.
   */
  switchModel(tmuxSession: string, windowName: string, model: string): Promise<void>;

  /**
   * Handle agent-specific blocking prompts during polling.
   * Called when no transcript activity is detected, to dismiss
   * prompts that might prevent the agent from processing.
   */
  handleBlockingPrompts(tmuxSession: string, windowName: string): Promise<void>;

  /**
   * Validate whether this adapter should handle the given session.
   * - Return `void`/`undefined` to accept the session normally.
   * - Return `{ fallback: modelId }` to route to the fallback adapter.
   * - Throw an error to reject outright (gateway tries fallback providers).
   *
   * Called early in the stream function, before allocating a tmux window.
   *
   * @param sessionKeyName - OpenClaw session key name for whitelist matching
   * @param modelId - Requested model ID, used for rate-limit-based fallback
   */
  validateSession?(sessionKeyName?: string, modelId?: string): { fallback: string } | void;

  /**
   * Record that a model hit a rate limit, triggering a cooldown period
   * during which requests for this model will be routed to a fallback adapter.
   */
  recordRateLimit?(modelId: string): void;

  /**
   * Send a user message to the agent, handling any agent-specific UI state
   * (e.g., ask_user prompts) and message transformations (e.g., appending
   * keep-session prompts). Falls back to plain sendKeys if not implemented.
   *
   * @param sessionKey - OpenClaw session key (e.g., "agent:main:chat:group:-123")
   *   Used by adapters to decide whether to apply KPSS suffix.
   */
  sendMessage?(tmuxSession: string, windowName: string, text: string, sessionKey?: string): Promise<void>;

  /**
   * Check if the agent is waiting for user input (e.g., at an ask_user prompt).
   * Used by cleanup to avoid killing sessions that are preserved for multi-turn.
   * Returns false by default (when not implemented).
   */
  isWaitingForUserInput?(tmuxSession: string, windowName: string): Promise<boolean>;

  // ─── Transcript ────────────────────────────────────────────

  /** Snapshot existing transcript files (path → size) before creating a session. */
  getExistingTranscriptPaths(cwd: string): Map<string, number>;

  /** Find a transcript file by agent session ID. */
  findTranscriptBySessionId(cwd: string, sessionId: string): string | null;

  /** Find a new transcript file not in the snapshot. */
  findNewTranscript(cwd: string, existingPaths: Map<string, number>): string | null;

  /** Find a transcript file that grew since the snapshot. */
  findGrowingTranscript(
    cwd: string,
    existingPaths: Map<string, number>,
  ): { path: string; snapshotSize: number } | null;

  /** Find the most recent transcript file. */
  findLatestTranscript(cwd: string): string | null;

  /** Extract session ID from a transcript file path. */
  extractSessionId(transcriptPath: string): string;

  /** Read new entries from a transcript file starting at byte offset. */
  readNewEntries(transcriptPath: string, offset: number): TranscriptReadResult;

  /** Extract assistant response from transcript entries. */
  extractAssistantResponse(
    entries: TranscriptEntry[],
    opts?: { collectAllText?: boolean },
  ): AssistantResponse;

  // ─── Workspace ─────────────────────────────────────────────

  /** Set up workspace files for this agent (config, instructions, etc.). */
  setupWorkspace(cwd: string): void;

  /** Map an OpenClaw model ID to the agent's internal model ID. */
  resolveModelId(modelId: string): string;
}
