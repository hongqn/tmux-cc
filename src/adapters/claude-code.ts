/**
 * Claude Code adapter REDACTED implements AgentAdapter for Claude Code CLI.
 *
 * Wraps existing CC-specific logic from tmux-manager.ts, transcript-reader.ts,
 * and index.ts workspace setup. This is a thin delegation layer; the original
 * implementation files remain unchanged.
 */
import { existsSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentAdapter, AgentModelDef } from "./types.js";
import type { TranscriptEntry, TranscriptReadResult, AssistantResponse } from "../types.js";
import {
  createWindow,
  waitForReady as tmuxWaitForReady,
  isWindowReady as tmuxIsWindowReady,
  isProcessAlive as tmuxIsProcessAlive,
  isClaudeProcessing,
  sendKeys,
  sendTmuxKey,
} from "../tmux-manager.js";
import {
  getExistingTranscriptPaths as trGetExistingPaths,
  findTranscriptBySessionId as trFindBySessionId,
  findNewTranscript as trFindNew,
  findGrowingTranscript as trFindGrowing,
  findLatestTranscript as trFindLatest,
  extractSessionId as trExtractSessionId,
  readNewEntries as trReadNewEntries,
  extractAssistantResponse as trExtractResponse,
} from "../transcript-reader.js";

const MODEL_SWITCH_POLL_MS = 500;
const MODEL_SWITCH_INTERRUPT_TIMEOUT_MS = 15_000;

/** Claude Code adapter configuration. */
export interface ClaudeCodeAdapterOptions {
  /** Path to the Claude Code CLI executable (default: "claude"). */
  claudeCommand?: string;
  /** V8 max old-space heap size in MB (default: 1024). */
  maxHeapMB?: number;
  /** Directory where the plugin source lives (for MCP server script path). */
  pluginDir?: string;
}

/** Claude models available through Claude Code CLI. */
const CLAUDE_MODELS: AgentModelDef[] = [
  {
    id: "opus-4.6",
    name: "Claude Opus 4.6 (tmux)",
    agentModelId: "claude-opus-4-6",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "sonnet-4.6",
    name: "Claude Sonnet 4.6 (tmux)",
    agentModelId: "claude-sonnet-4-6",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "sonnet-4.5",
    name: "Claude Sonnet 4.5 (tmux)",
    agentModelId: "claude-sonnet-4-5-20250514",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "haiku-4.5",
    name: "Claude Haiku 4.5 (tmux)",
    agentModelId: "claude-haiku-4-5-20250514",
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
];

const DEFAULT_CLAUDE_MD = `# Claude Code Project Instructions

Read and follow the instructions in these files (in order):

1. \`AGENTS.md\` REDACTED Workspace rules, behavior guidelines, and constraints
2. \`SOUL.md\` REDACTED Character, personality, and communication style
3. \`MEMORY.md\` REDACTED Conversation history, learned preferences, and context

---

## Messaging Protocol

You are receiving messages from users through a messaging gateway.
Each incoming user message includes metadata headers like \`Conversation info\` and \`Sender\` REDACTED use these to identify who is speaking.

### Silent Replies (NO_REPLY)

When you have nothing meaningful to say (e.g., a message wasn't directed at you, or it's just noise), respond with ONLY:

\`\`\`
NO_REPLY
\`\`\`

Rules:
- It must be your ENTIRE message REDACTED nothing else
- Never append it to an actual response
- Never wrap it in markdown or code blocks

### Heartbeat Protocol (HEARTBEAT_OK)

You may receive heartbeat poll messages. If you receive one and there is nothing that needs attention, reply exactly:

\`\`\`
HEARTBEAT_OK
\`\`\`

If something needs attention, do NOT include "HEARTBEAT_OK" REDACTED reply with the alert/update text instead.
If \`HEARTBEAT.md\` exists, read it and follow its instructions during heartbeats.
`;

/**
 * Claude Code adapter implementation.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";
  readonly models = CLAUDE_MODELS;

  private readonly claudeCommand: string;
  private readonly maxHeapMB: number;
  private readonly pluginDir: string;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.claudeCommand = opts.claudeCommand ?? "claude";
    this.maxHeapMB = opts.maxHeapMB ?? 1024;
    this.pluginDir = opts.pluginDir ?? (import.meta.dirname ?? __dirname);
  }

  // REDACTED Lifecycle REDACTED

  async createAgentWindow(params: {
    tmuxSession: string;
    windowName: string;
    workingDirectory: string;
    model: string;
    resumeSessionId?: string;
  }): Promise<void> {
    await createWindow(
      {
        tmuxSession: params.tmuxSession,
        claudeCommand: this.claudeCommand,
        workingDirectory: params.workingDirectory,
        maxHeapMB: this.maxHeapMB,
      },
      {
        windowName: params.windowName,
        model: params.model,
        resumeSessionId: params.resumeSessionId,
      },
    );
  }

  async waitForReady(
    tmuxSession: string,
    windowName: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    return tmuxWaitForReady(tmuxSession, windowName, timeoutMs);
  }

  async isWindowReady(tmuxSession: string, windowName: string): Promise<boolean> {
    return tmuxIsWindowReady(tmuxSession, windowName);
  }

  async isProcessAlive(tmuxSession: string, windowName: string): Promise<boolean> {
    return tmuxIsProcessAlive(tmuxSession, windowName);
  }

  async isProcessing(tmuxSession: string, windowName: string): Promise<boolean> {
    return isClaudeProcessing(tmuxSession, windowName);
  }

  async switchModel(
    tmuxSession: string,
    windowName: string,
    model: string,
  ): Promise<void> {
    // Wait for CC to be idle before sending /model command
    if (await isClaudeProcessing(tmuxSession, windowName)) {
      console.log(`[claude-code] switchModel: CC is processing, sending Escape to interrupt`);
      await sendTmuxKey(tmuxSession, windowName, "Escape");

      const deadline = Date.now() + MODEL_SWITCH_INTERRUPT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, MODEL_SWITCH_POLL_MS));
        if (!(await isClaudeProcessing(tmuxSession, windowName))) {
          console.log(`[claude-code] switchModel: CC is now idle`);
          break;
        }
      }
    }

    await sendKeys(tmuxSession, windowName, `/model ${model}`);
  }

  async handleBlockingPrompts(
    tmuxSession: string,
    windowName: string,
  ): Promise<void> {
    try {
      const { capturePane } = await import("../tmux-manager.js");
      const content = await capturePane(tmuxSession, windowName, 20);
      if (!content) return;

      if (content.includes("Yes, I accept") && content.includes("Bypass Permissions")) {
        console.log(`[claude-code] auto-dismissing bypass permissions prompt`);
        await sendTmuxKey(tmuxSession, windowName, "Down");
        await new Promise(resolve => setTimeout(resolve, 300));
        await sendTmuxKey(tmuxSession, windowName, "Enter");
      } else if (content.includes("I trust this folder")) {
        console.log(`[claude-code] auto-dismissing trust prompt`);
        await sendTmuxKey(tmuxSession, windowName, "Enter");
      } else if (content.includes("[Pasted text #")) {
        console.log(`[claude-code] pasted text not submitted, sending Enter`);
        await sendTmuxKey(tmuxSession, windowName, "Enter");
      }
    } catch {
      // Ignore errors from prompt check
    }
  }

  // REDACTED Transcript REDACTED

  getExistingTranscriptPaths(cwd: string): Map<string, number> {
    return trGetExistingPaths(cwd);
  }

  findTranscriptBySessionId(cwd: string, sessionId: string): string | null {
    return trFindBySessionId(cwd, sessionId);
  }

  findNewTranscript(cwd: string, existingPaths: Map<string, number>): string | null {
    return trFindNew(cwd, existingPaths);
  }

  findGrowingTranscript(
    cwd: string,
    existingPaths: Map<string, number>,
  ): { path: string; snapshotSize: number } | null {
    return trFindGrowing(cwd, existingPaths);
  }

  findLatestTranscript(cwd: string): string | null {
    return trFindLatest(cwd);
  }

  extractSessionId(transcriptPath: string): string {
    return trExtractSessionId(transcriptPath);
  }

  readNewEntries(transcriptPath: string, offset: number): TranscriptReadResult {
    return trReadNewEntries(transcriptPath, offset);
  }

  extractAssistantResponse(
    entries: TranscriptEntry[],
    opts?: { collectAllText?: boolean },
  ): AssistantResponse {
    return trExtractResponse(entries, opts);
  }

  // REDACTED Workspace REDACTED

  setupWorkspace(cwd: string): void {
    this.writeMcpSettings(cwd);
    this.ensureClaudeMd(cwd);
    this.ensureSkillsSymlink(cwd);
  }

  resolveModelId(modelId: string): string {
    const bare = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
    const match = CLAUDE_MODELS.find(m => m.id === bare);
    return match?.agentModelId ?? bare;
  }

  // REDACTED Private helpers REDACTED

  private writeMcpSettings(workingDirectory: string): void {
    const claudeDir = join(workingDirectory, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    const settingsPath = join(claudeDir, "settings.json");
    const mcpServerScript = resolve(this.pluginDir, "src", "mcp-server.ts");

    const settings = {
      mcpServers: {
        "gateway-tools": {
          command: "tsx",
          args: [mcpServerScript],
          env: {
            GATEWAY_CLI_COMMAND: process.env.GATEWAY_CLI_COMMAND ?? "openclaw",
          },
        },
      },
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  private ensureClaudeMd(workingDirectory: string): void {
    const claudeMdPath = join(workingDirectory, "CLAUDE.md");
    if (existsSync(claudeMdPath)) return;
    writeFileSync(claudeMdPath, DEFAULT_CLAUDE_MD);
  }

  private ensureSkillsSymlink(workingDirectory: string): void {
    const skillsDir = join(workingDirectory, "skills");
    if (!existsSync(skillsDir)) return;

    const claudeDir = join(workingDirectory, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    const symlinkPath = join(claudeDir, "skills");
    if (existsSync(symlinkPath)) {
      try { readlinkSync(symlinkPath); } catch { /* not a symlink */ }
      return;
    }

    symlinkSync("../skills", symlinkPath);
  }
}
