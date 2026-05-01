import type { Context } from "@mariozechner/pi-ai";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentModelDef } from "./adapters/types.js";
import type { AssistantResponse, TranscriptEntry, TranscriptReadResult } from "./types.js";

const tmuxManagerMock = vi.hoisted(() => ({
  capturePane: vi.fn(async () => "❯ "),
  createWindow: vi.fn(async () => {}),
  ensureTmuxSession: vi.fn(async () => {}),
  isClaudeProcessing: vi.fn(async () => false),
  isProcessAlive: vi.fn(async () => true),
  isWindowReady: vi.fn(async () => true),
  killSession: vi.fn(async () => {}),
  killWindow: vi.fn(async () => {}),
  listWindows: vi.fn(async () => []),
  readCrashLog: vi.fn(async () => ""),
  readExitCode: vi.fn(async () => null),
  sendKeys: vi.fn(async () => {}),
  sendTmuxKey: vi.fn(async () => {}),
  waitForReady: vi.fn(async () => true),
  windowExists: vi.fn(async () => false),
}));

const persistenceMock = vi.hoisted(() => ({
  getPersistedClaudeSessionId: vi.fn(() => null),
  getStableSessionKey: vi.fn(() => undefined),
  persistSession: vi.fn(),
  persistStableSessionKey: vi.fn(),
  removePersistedSession: vi.fn(),
  removeStableSessionKeysFor: vi.fn(),
}));

vi.mock("./tmux-manager.js", () => tmuxManagerMock);
vi.mock("./session-persistence.js", () => persistenceMock);

const transcriptReader = await import("./transcript-reader.js");
const { createTmuxClaudeStreamFn } = await import("./stream-fn.js");
const { destroyAllSessions } = await import("./session-map.js");

class RecoveringAdapter implements AgentAdapter {
  readonly id = "test-agent";
  readonly models: AgentModelDef[] = [];

  sendAttempts = 0;
  createAttempts = 0;
  transcriptPath: string;

  constructor(private readonly transcriptDir: string) {
    this.transcriptPath = join(transcriptDir, "session-after-restart.jsonl");
  }

  async createAgentWindow(): Promise<void> {
    this.createAttempts++;
  }

  async waitForReady(): Promise<boolean> {
    return true;
  }

  async isWindowReady(): Promise<boolean> {
    return true;
  }

  async isProcessAlive(): Promise<boolean> {
    return true;
  }

  async isProcessing(): Promise<boolean> {
    return false;
  }

  async switchModel(): Promise<void> {}

  async handleBlockingPrompts(): Promise<void> {}

  async sendMessage(_tmuxSession: string, _windowName: string, text: string): Promise<void> {
    this.sendAttempts++;
    if (this.sendAttempts === 1) {
      throw new Error("Claude Code session is unavailable");
    }

    const entries = [
      {
        type: "user",
        message: { content: [{ type: "text", text }] },
        sessionId: "session-after-restart",
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "heartbeat ok" }] },
        sessionId: "session-after-restart",
        stop_reason: "end_turn",
      },
    ];
    writeFileSync(this.transcriptPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }

  getExistingTranscriptPaths(): Map<string, number> {
    const result = new Map<string, number>();
    for (const name of readdirSync(this.transcriptDir).filter((entry) => entry.endsWith(".jsonl"))) {
      const path = join(this.transcriptDir, name);
      result.set(path, statSync(path).size);
    }
    return result;
  }

  findTranscriptBySessionId(_cwd: string, sessionId: string): string | null {
    const path = join(this.transcriptDir, `${sessionId}.jsonl`);
    return path === this.transcriptPath ? path : null;
  }

  findNewTranscript(_cwd: string, existingPaths: Map<string, number>): string | null {
    return existingPaths.has(this.transcriptPath) ? null : this.transcriptPath;
  }

  findGrowingTranscript(
    _cwd: string,
    existingPaths: Map<string, number>,
  ): { path: string; snapshotSize: number } | null {
    const snapshotSize = existingPaths.get(this.transcriptPath);
    if (snapshotSize == null) return null;
    const currentSize = statSync(this.transcriptPath).size;
    return currentSize > snapshotSize ? { path: this.transcriptPath, snapshotSize } : null;
  }

  findLatestTranscript(): string | null {
    return this.transcriptPath;
  }

  extractSessionId(transcriptPath: string): string {
    return basename(transcriptPath, ".jsonl");
  }

  readNewEntries(transcriptPath: string, offset: number): TranscriptReadResult {
    return transcriptReader.readNewEntries(transcriptPath, offset);
  }

  extractAssistantResponse(
    entries: TranscriptEntry[],
    opts?: { collectAllText?: boolean },
  ): AssistantResponse {
    return transcriptReader.extractAssistantResponse(entries, opts);
  }

  setupWorkspace(): void {}

  resolveModelId(modelId: string): string {
    return modelId;
  }
}

describe("session unavailable recovery", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "tmux-cc-unavailable-"));
  });

  afterEach(async () => {
    await destroyAllSessions({ tmuxSession: "test-tmux" });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("restarts the agent and re-injects the message when send reports the session unavailable", async () => {
    const adapter = new RecoveringAdapter(tmpDir);
    const streamFn = createTmuxClaudeStreamFn({
      config: {
        defaultModel: "sonnet-4.6",
        pollingIntervalMs: 1,
        responseTimeoutMs: 1000,
        tmuxSession: "test-tmux",
        workingDirectory: tmpDir,
      },
      adapter,
    });
    const context: Context = {
      messages: [{ role: "user", content: "heartbeat", timestamp: Date.now() }],
    };

    const events = [];
    for await (const event of streamFn({}, context)) {
      events.push(event);
    }

    expect(adapter.sendAttempts).toBe(2);
    expect(adapter.createAttempts).toBe(2);
    expect(tmuxManagerMock.killWindow).toHaveBeenCalledWith("test-tmux", expect.any(String));
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: {
        stopReason: "stop",
        content: [{ type: "text", text: "heartbeat ok" }],
      },
    });
  });
});
