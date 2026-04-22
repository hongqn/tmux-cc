/**
 * Copilot CLI adapter — implements AgentAdapter for GitHub Copilot CLI.
 *
 * Wraps Copilot-specific logic: different CLI flags, transcript location/format,
 * MCP config path, and workspace setup. The tmux operations (sendKeys, capturePane)
 * remain shared with the Claude Code adapter via tmux-manager.ts.
 */
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentAdapter, AgentModelDef } from "./types.js";
import type { TranscriptEntry, TranscriptReadResult, AssistantResponse } from "../types.js";
import {
  ensureTmuxSession,
  isProcessAlive as tmuxIsProcessAlive,
  sendKeys,
  sendTmuxKey,
  capturePane,
} from "../tmux-manager.js";
import {
  getExistingTranscriptPaths as cpGetExistingPaths,
  findTranscriptBySessionId as cpFindBySessionId,
  findNewTranscript as cpFindNew,
  findGrowingTranscript as cpFindGrowing,
  findLatestTranscript as cpFindLatest,
  extractSessionId as cpExtractSessionId,
  readNewEntries as cpReadNewEntries,
  extractAssistantResponse as cpExtractResponse,
} from "../copilot-transcript-reader.js";
import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(cpExec);

async function exec(cmd: string): Promise<string> {
  const { stdout } = await execPromise(cmd, { encoding: "utf-8", timeout: 10_000 });
  return stdout.trim();
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const MODEL_SWITCH_POLL_MS = 500;
const MODEL_SWITCH_INTERRUPT_TIMEOUT_MS = 15_000;
const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 120_000; // Copilot CLI loads MCP servers + skills on startup
const DEFAULT_MAX_HEAP_MB = 1024;

/** Duration to suppress a rate-limited model before retrying (1 hour). */
const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Substrings that identify a rendered ask_user selector. Copilot's TUI has
 * evolved across versions: older builds say "↑↓ to select", newer builds
 * say "↑/↓ to navigate". We match either so upgrades don't silently break
 * ask_user routing.
 */
const ASK_USER_SELECTOR_HINTS = ["↑↓ to select", "↑/↓ to navigate"];

/** Whether a pane contains a rendered ask_user option list. */
function hasAskUserSelector(pane: string): boolean {
  return ASK_USER_SELECTOR_HINTS.some((h) => pane.includes(h));
}

/**
 * Keep-session prompt (KSSP) suffix appended to every user message.
 * Instructs the agent to call ask_user at the end of each response,
 * keeping the turn alive to avoid per-request billing.
 */
const KSSP_SUFFIX = " . Use the ask user tool at the very end to prompt me if I really want to quit or have other requests. Never quit in the middle before I have confirmed.";

/** Copilot CLI adapter configuration. */
export interface CopilotCliAdapterOptions {
  /** Path to the Copilot CLI executable (default: "copilot"). */
  copilotCommand?: string;
  /** V8 max old-space heap size in MB (default: 1024). */
  maxHeapMB?: number;
  /** Directory where the plugin source lives (for MCP server script path). */
  pluginDir?: string;
  /**
   * Session key whitelist patterns for KPSS (Keep Persistent Session Stop).
   * Only sessions whose OpenClaw session key matches one of these glob patterns
   * get the KPSS suffix appended (which causes the agent to call ask_user,
   * keeping the session alive for multi-turn without per-request billing).
   *
   * Example: ["telegram:group:*", "telegram:*"]
   *
   * If empty or undefined, KPSS is applied to ALL sessions (legacy behavior).
   */
  kpssSessionWhitelist?: string[];
  /**
   * Behavior for sessions not matching the KPSS whitelist.
   * - "no-kpss": Don't append KPSS suffix, allow normal cleanup.
   * - "reject": Refuse to serve the request (throw an error).
   * - { fallback: "model-id" }: Route to a fallback adapter with the given model.
   * Default: "no-kpss"
   */
  kpssNonWhitelistBehavior?: "no-kpss" | "reject" | { fallback: string };
  /**
   * Map of Copilot model IDs to fallback adapter model IDs for rate limit scenarios.
   * When a rate limit is detected for a Copilot model, subsequent requests
   * will be routed to the fallback adapter with the mapped model ID.
   *
   * Example: { "claude-opus-4.6": "opus-4.6" }
   */
  rateLimitFallbackModels?: Record<string, string>;
}

/**
 * Models available through Copilot CLI.
 * Copilot CLI supports both OpenAI and Claude models.
 */
const COPILOT_MODELS: AgentModelDef[] = [
  // OpenAI flagship models
  {
    id: "gpt-5.4",
    name: "GPT-5.4 (copilot)",
    agentModelId: "gpt-5.4",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "gpt-5.2",
    name: "GPT-5.2 (copilot)",
    agentModelId: "gpt-5.2",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "gpt-5.1",
    name: "GPT-5.1 (copilot)",
    agentModelId: "gpt-5.1",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "gpt-4.1",
    name: "GPT-4.1 (copilot)",
    agentModelId: "gpt-4.1",
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  // OpenAI codex models
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex (copilot)",
    agentModelId: "gpt-5.3-codex",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex (copilot)",
    agentModelId: "gpt-5.2-codex",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  // OpenAI mini models
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini (copilot)",
    agentModelId: "gpt-5.4-mini",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "gpt-5-mini",
    name: "GPT-5 Mini (copilot)",
    agentModelId: "gpt-5-mini",
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  // Claude models
  {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6 (copilot)",
    agentModelId: "claude-sonnet-4.6",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-opus-4.6",
    name: "Claude Opus 4.6 (copilot)",
    agentModelId: "claude-opus-4.6",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5 (copilot)",
    agentModelId: "claude-sonnet-4.5",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-opus-4.5",
    name: "Claude Opus 4.5 (copilot)",
    agentModelId: "claude-opus-4.5",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4 (copilot)",
    agentModelId: "claude-sonnet-4",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5 (copilot)",
    agentModelId: "claude-haiku-4.5",
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
];

const DEFAULT_COPILOT_MD = `# Copilot Project Instructions

Read and follow the instructions in these files (in order):

1. \`AGENTS.md\` — Workspace rules, behavior guidelines, and constraints
2. \`SOUL.md\` — Character, personality, and communication style
3. \`MEMORY.md\` — Conversation history, learned preferences, and context

---

## Messaging Protocol

You are receiving messages from users through a messaging gateway.
Each incoming user message includes metadata headers like \`Conversation info\` and \`Sender\` — use these to identify who is speaking.

### Silent Replies (NO_REPLY)

When you have nothing meaningful to say (e.g., a message wasn't directed at you, or it's just noise), respond with ONLY:

\`\`\`
NO_REPLY
\`\`\`

Rules:
- It must be your ENTIRE message — nothing else
- Never append it to an actual response
- Never wrap it in markdown or code blocks

### Heartbeat Protocol (HEARTBEAT_OK)

You may receive heartbeat poll messages. If you receive one and there is nothing that needs attention, reply exactly:

\`\`\`
HEARTBEAT_OK
\`\`\`

If something needs attention, do NOT include "HEARTBEAT_OK" — reply with the alert/update text instead.
If \`HEARTBEAT.md\` exists, read it and follow its instructions during heartbeats.
`;

/**
 * Copilot CLI adapter implementation.
 */
export class CopilotCliAdapter implements AgentAdapter {
  readonly id = "copilot-cli";
  readonly models = COPILOT_MODELS;

  private readonly copilotCommand: string;
  private readonly maxHeapMB: number;
  private readonly pluginDir: string;
  private readonly kpssSessionWhitelist: string[];
  private readonly kpssNonWhitelistBehavior: "no-kpss" | "reject" | { fallback: string };
  private readonly rateLimitFallbackModels: Record<string, string>;

  /** Per-model rate limit cooldown: modelId → expiry timestamp (ms). */
  private readonly modelRateLimits = new Map<string, number>();

  constructor(opts: CopilotCliAdapterOptions = {}) {
    this.copilotCommand = opts.copilotCommand ?? "copilot";
    this.maxHeapMB = opts.maxHeapMB ?? DEFAULT_MAX_HEAP_MB;
    this.pluginDir = opts.pluginDir ?? (import.meta.dirname ?? __dirname);
    this.kpssSessionWhitelist = opts.kpssSessionWhitelist ?? [];
    this.kpssNonWhitelistBehavior = opts.kpssNonWhitelistBehavior ?? "no-kpss";
    this.rateLimitFallbackModels = opts.rateLimitFallbackModels ?? {};
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  async createAgentWindow(params: {
    tmuxSession: string;
    windowName: string;
    workingDirectory: string;
    model: string;
    resumeSessionId?: string;
    agentAccountId?: string;
  }): Promise<void> {
    await ensureTmuxSession(params.tmuxSession);

    const args = [
      this.copilotCommand,
      "--allow-all",
      "--model",
      this.resolveModelId(params.model),
      // Reduce memory footprint: disable features not needed for headless agent use
      "--disable-builtin-mcps",
      "--no-custom-instructions",
      "--no-auto-update",
      "--no-remote",
    ];

    if (params.resumeSessionId) {
      args.push(`--resume=${params.resumeSessionId}`);
    }

    const cmd = args.map(shellEscape).join(" ");
    const target = shellEscape(params.tmuxSession);

    // Limit V8 heap to prevent OOM crashes
    const heapLimit = this.maxHeapMB;
    const envFlags = [`-e 'NODE_OPTIONS=--max-old-space-size=${heapLimit}'`];
    if (params.agentAccountId) {
      envFlags.push(`-e ${shellEscape(`OPENCLAW_AGENT_ACCOUNT_ID=${params.agentAccountId}`)}`);
    }

    await exec(
      `tmux new-window -t ${target} -n ${shellEscape(params.windowName)} -c ${shellEscape(params.workingDirectory)} ${envFlags.join(" ")} ${shellEscape(cmd)}`,
    );

    // Keep pane alive after exit for diagnostics
    const windowTarget = `${shellEscape(params.tmuxSession)}:${shellEscape(params.windowName)}`;
    try {
      await exec(`tmux set-option -t ${windowTarget} remain-on-exit on`);
    } catch {
      // Non-fatal
    }

    // Log pane output for crash diagnostics
    try {
      const logFile = `/tmp/cc-${params.windowName}.log`;
      await exec(`tmux pipe-pane -t ${windowTarget} -o 'cat >> ${shellEscape(logFile)}'`);
    } catch {
      // Non-fatal
    }
  }

  async waitForReady(
    tmuxSession: string,
    windowName: string,
    timeoutMs: number = READY_TIMEOUT_MS,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    // Phase 1: process alive
    while (Date.now() < deadline) {
      if (await this.isProcessAlive(tmuxSession, windowName)) {
        break;
      }
      await sleep(READY_POLL_INTERVAL_MS);
    }
    if (Date.now() >= deadline) return false;

    // Phase 2: TUI prompt ready (❯ character)
    while (Date.now() < deadline) {
      try {
        const content = await capturePane(tmuxSession, windowName);

        // Auto-dismiss workspace trust prompt — select "remember" option
        if (content.includes("Do you trust the files")) {
          const target = `${shellEscape(tmuxSession)}:${shellEscape(windowName)}`;
          // Select option 2: "Yes, and remember this folder"
          await exec(`tmux send-keys -t ${target} Down Enter`);
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

  async isWindowReady(tmuxSession: string, windowName: string): Promise<boolean> {
    try {
      const content = await capturePane(tmuxSession, windowName);
      return content.includes("\u276F");
    } catch {
      return false;
    }
  }

  async isProcessAlive(tmuxSession: string, windowName: string): Promise<boolean> {
    // Copilot CLI runs as `node`, not `copilot`, in pane_current_command
    return tmuxIsProcessAlive(tmuxSession, windowName, "node") ||
           tmuxIsProcessAlive(tmuxSession, windowName, "copilot");
  }

  async isProcessing(tmuxSession: string, windowName: string): Promise<boolean> {
    try {
      const content = await capturePane(tmuxSession, windowName);
      // Interactive ask_user prompts show "Esc to cancel" alongside selection UI.
      // These are NOT processing — the agent is waiting for user input.
      if (hasAskUserSelector(content) || content.includes("Enter to confirm")) {
        return false;
      }
      // Copilot shows "Esc to cancel" (or "esc to int" in some versions) while processing
      return content.includes("Esc to cancel") || content.includes("esc to int");
    } catch {
      return false;
    }
  }

  async switchModel(
    tmuxSession: string,
    windowName: string,
    model: string,
  ): Promise<void> {
    // Wait for Copilot to be idle before sending /model command
    if (await this.isProcessing(tmuxSession, windowName)) {
      console.log(`[copilot-cli] switchModel: Copilot is processing, sending Escape to interrupt`);
      await sendTmuxKey(tmuxSession, windowName, "Escape");

      const deadline = Date.now() + MODEL_SWITCH_INTERRUPT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(MODEL_SWITCH_POLL_MS);
        if (!(await this.isProcessing(tmuxSession, windowName))) {
          console.log(`[copilot-cli] switchModel: Copilot is now idle`);
          break;
        }
      }
    }

    await sendKeys(tmuxSession, windowName, `/model ${this.resolveModelId(model)}`);
  }

  async handleBlockingPrompts(
    tmuxSession: string,
    windowName: string,
  ): Promise<void> {
    try {
      const content = await capturePane(tmuxSession, windowName, 20);
      if (!content) return;

      // Trust prompt
      if (content.includes("Do you trust the files")) {
        console.log(`[copilot-cli] auto-dismissing trust prompt`);
        // Select "Yes, and remember" (option 2)
        await sendTmuxKey(tmuxSession, windowName, "Down");
        await sleep(300);
        await sendTmuxKey(tmuxSession, windowName, "Enter");
      }
      // Pasted text not submitted — Copilot uses "[Paste #N - M lines]",
      // Claude Code uses "[Pasted text #N]"
      else if (content.includes("[Pasted text #") || content.includes("[Paste #")) {
        console.log(`[copilot-cli] pasted text not submitted, sending Enter`);
        await sendTmuxKey(tmuxSession, windowName, "Enter");
      }
    } catch {
      // Ignore errors from prompt check
    }
  }

  // ─── Message Sending ────────────────────────────────────────

  /**
   * Reject or redirect sessions that don't match the KPSS whitelist,
   * or redirect rate-limited models to a fallback adapter.
   *
   * Called early, before tmux window allocation, so the gateway can
   * fall back to another provider (e.g., tmux-cc for cron sessions).
   *
   * Returns `{ fallback: modelId }` when the request should be routed
   * to a fallback adapter instead of being handled by this adapter.
   */
  validateSession(sessionKeyName?: string, modelId?: string): { fallback: string } | void {
    // Check rate limit cooldown first — applies regardless of KPSS whitelist.
    if (modelId) {
      const expiresAt = this.modelRateLimits.get(modelId);
      if (expiresAt) {
        if (Date.now() < expiresAt) {
          const fallback = this.rateLimitFallbackModels[modelId];
          if (fallback) {
            const remainMin = Math.round((expiresAt - Date.now()) / 60_000);
            console.log(`[copilot-cli] model ${modelId} rate-limited for ${remainMin}m more, falling back to ${fallback}`);
            return { fallback };
          }
        } else {
          // Cooldown expired — clear and retry
          this.modelRateLimits.delete(modelId);
          console.log(`[copilot-cli] rate limit cooldown expired for model=${modelId}, retrying`);
        }
      }
    }

    if (this.isKpssEnabled(sessionKeyName)) return;

    if (typeof this.kpssNonWhitelistBehavior === "object") {
      return { fallback: this.kpssNonWhitelistBehavior.fallback };
    }

    if (this.kpssNonWhitelistBehavior === "reject") {
      throw new Error(
        `[copilot-cli] session "${sessionKeyName}" rejected — does not match conversation whitelist`,
      );
    }
    // "no-kpss": proceed without KPSS
  }

  /**
   * Record that a model hit a rate limit. Subsequent requests for this model
   * will be routed to the fallback adapter for RATE_LIMIT_COOLDOWN_MS (1 hour).
   */
  recordRateLimit(modelId: string): void {
    // Only record if we have a fallback configured for this model
    if (!this.rateLimitFallbackModels[modelId]) {
      console.log(`[copilot-cli] rate limit detected for model=${modelId} but no fallback configured, ignoring`);
      return;
    }
    const expiresAt = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    this.modelRateLimits.set(modelId, expiresAt);
    console.log(`[copilot-cli] rate limit recorded for model=${modelId}, falling back to ${this.rateLimitFallbackModels[modelId]} until ${new Date(expiresAt).toISOString()}`);
  }

  /**
   * Send a user message to Copilot CLI with KSSP suffix.
   * Detects if the agent is at an ask_user prompt and handles
   * navigation to freeform input when showing options.
   */
  async sendMessage(
    tmuxSession: string,
    windowName: string,
    text: string,
    sessionKey?: string,
  ): Promise<void> {
    // KPSS suffix: always enabled here since validateSession() already
    // rejected non-whitelisted sessions before we reach sendMessage.
    const kpssEnabled = this.isKpssEnabled(sessionKey);
    const messageText = kpssEnabled ? text + KSSP_SUFFIX : text;

    // Check if agent is at an ask_user prompt — route user's message through it.
    // Capture extra lines (50) to ensure the selection box is visible.
    let pane = await capturePane(tmuxSession, windowName, 50);
    if (pane && this.isAskUserPrompt(pane)) {
      // When "○ Asking user" appears but the selection box hasn't rendered yet,
      // wait up to 5s for it to appear before falling back to freeform.
      if (pane.includes("○ Asking user") && !hasAskUserSelector(pane)) {
        for (let waitMs = 0; waitMs < 5000; waitMs += 500) {
          await sleep(500);
          pane = await capturePane(tmuxSession, windowName, 50) || '';
          if (hasAskUserSelector(pane)) break;
        }
      }

      if (hasAskUserSelector(pane)) {
        // Options variant — navigate to "Other (type your answer)" and type answer
        const optionCount = this.countAskUserOptions(pane);
        console.log(`[copilot-cli] ask_user prompt with ${optionCount} options, routing text to Other`);

        // Navigate down to last option (Other)
        for (let i = 0; i < optionCount - 1; i++) {
          await sendTmuxKey(tmuxSession, windowName, "Down");
          await sleep(100);
        }
        // Select "Other" to open freeform text input
        await sendTmuxKey(tmuxSession, windowName, "Enter");
        await sleep(500);

        // Type the user's message and submit (sendKeys adds Enter)
        await sendKeys(tmuxSession, windowName, messageText);
        return;
      } else {
        // Freeform variant — type the answer directly
        console.log(`[copilot-cli] ask_user freeform prompt, typing answer directly`);
        await sendKeys(tmuxSession, windowName, messageText);
        return;
      }
    }

    await sendKeys(tmuxSession, windowName, messageText);
  }

  /**
   * Count the number of options in an ask_user prompt.
   * Options look like: "❯ 1. Label" or "  2. Label" etc.
   * Lines may be inside a box border (│ prefix).
   *
   * The freeform-input fallback label is "Other (type…)" in older Copilot
   * builds and "Type something" in newer ones — both are counted.
   */
  private countAskUserOptions(paneContent: string): number {
    const lines = paneContent.split("\n");
    let count = 0;
    for (const line of lines) {
      // Strip box border characters before matching
      const stripped = line.replace(/^[│┃|]+\s*/, '');
      if (
        /^[❯>]?\s*\d+\.\s/.test(stripped) ||
        /^[❯>]?\s*Other[\s(]/.test(stripped) ||
        /^[❯>]?\s*Type something/.test(stripped)
      ) {
        count++;
      }
    }
    return Math.max(count, 1);
  }

  /**
   * Detect if the pane shows an ask_user prompt (options or freeform).
   * The bordered box with a selector hint or "○ Asking user" is reliable.
   */
  private isAskUserPrompt(paneContent: string): boolean {
    // Options variant: bordered box with selector (old or new TUI strings)
    if (hasAskUserSelector(paneContent) && paneContent.includes("Esc to cancel")) {
      return true;
    }
    // Freeform variant or generic: "○ Asking user" indicator
    if (paneContent.includes("○ Asking user")) {
      return true;
    }
    return false;
  }

  /**
   * Check if KPSS is enabled for the given session key.
   * If no whitelist is configured, KPSS is enabled for all sessions.
   * Otherwise, the session key must match at least one glob pattern.
   */
  private isKpssEnabled(sessionKey?: string): boolean {
    if (this.kpssSessionWhitelist.length === 0) return true;
    if (!sessionKey) return true; // no session key → default to enabled
    return this.kpssSessionWhitelist.some(pattern =>
      this.matchSessionKeyPattern(sessionKey, pattern),
    );
  }

  /**
   * Simple glob matching for session key patterns.
   * Supports * as wildcard for any characters.
   */
  private matchSessionKeyPattern(sessionKey: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
    return regex.test(sessionKey);
  }

  /**
   * Check if the agent is at an ask_user prompt waiting for user input.
   * Used by cleanup to preserve KPSS sessions.
   */
  async isWaitingForUserInput(tmuxSession: string, windowName: string): Promise<boolean> {
    try {
      const pane = await capturePane(tmuxSession, windowName, 30);
      if (!pane) return false;
      return this.isAskUserPrompt(pane);
    } catch {
      return false;
    }
  }

  // ─── Transcript ────────────────────────────────────────────

  getExistingTranscriptPaths(cwd: string): Map<string, number> {
    return cpGetExistingPaths(cwd);
  }

  findTranscriptBySessionId(cwd: string, sessionId: string): string | null {
    return cpFindBySessionId(cwd, sessionId);
  }

  findNewTranscript(cwd: string, existingPaths: Map<string, number>): string | null {
    return cpFindNew(cwd, existingPaths);
  }

  findGrowingTranscript(
    cwd: string,
    existingPaths: Map<string, number>,
  ): { path: string; snapshotSize: number } | null {
    return cpFindGrowing(cwd, existingPaths);
  }

  findLatestTranscript(cwd: string): string | null {
    return cpFindLatest(cwd);
  }

  extractSessionId(transcriptPath: string): string {
    return cpExtractSessionId(transcriptPath);
  }

  readNewEntries(transcriptPath: string, offset: number): TranscriptReadResult {
    return cpReadNewEntries(transcriptPath, offset);
  }

  extractAssistantResponse(
    entries: TranscriptEntry[],
    opts?: { collectAllText?: boolean },
  ): AssistantResponse {
    return cpExtractResponse(entries, opts);
  }

  // ─── Workspace ─────────────────────────────────────────────

  setupWorkspace(cwd: string): void {
    this.writeMcpConfig();
    this.ensureCopilotMd(cwd);
    this.ensureSkillsSymlink(cwd);
  }

  resolveModelId(modelId: string): string {
    const bare = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
    const match = COPILOT_MODELS.find(m => m.id === bare);
    return match?.agentModelId ?? bare;
  }

  // ─── Private helpers ───────────────────────────────────────

  private writeMcpConfig(): void {
    // Copilot CLI reads MCP servers from ~/.copilot/mcp-config.json
    const configDir = join(homedir(), ".copilot");
    const mcpConfigPath = join(configDir, "mcp-config.json");
    const mcpServerScript = resolve(this.pluginDir, "src", "mcp-server.ts");

    mkdirSync(configDir, { recursive: true });

    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(readFileSync(mcpConfigPath, "utf-8")) as Record<string, unknown>;
    } catch {
      // Start fresh
    }

    const servers = (data.mcpServers ?? data.servers ?? {}) as Record<string, unknown>;

    servers["gateway-tools"] = {
      type: "stdio",
      command: "tsx",
      args: [mcpServerScript],
      env: {
        GATEWAY_CLI_COMMAND: process.env.GATEWAY_CLI_COMMAND ?? "openclaw",
      },
    };

    data.mcpServers = servers;
    // Remove legacy key if present
    delete data.servers;
    writeFileSync(mcpConfigPath, JSON.stringify(data, null, 2));
  }

  private ensureCopilotMd(workingDirectory: string): void {
    const copilotMdPath = join(workingDirectory, "COPILOT.md");
    if (existsSync(copilotMdPath)) return;
    writeFileSync(copilotMdPath, DEFAULT_COPILOT_MD);
  }

  private ensureSkillsSymlink(workingDirectory: string): void {
    const skillsDir = join(workingDirectory, "skills");
    if (!existsSync(skillsDir)) return;

    const copilotDir = join(workingDirectory, ".copilot");
    mkdirSync(copilotDir, { recursive: true });

    const symlinkPath = join(copilotDir, "skills");
    if (existsSync(symlinkPath)) {
      try { readlinkSync(symlinkPath); } catch { /* not a symlink */ }
      return;
    }

    symlinkSync("../skills", symlinkPath);
  }
}
