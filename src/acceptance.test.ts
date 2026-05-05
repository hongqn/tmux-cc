import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Acceptance tests for the tmux-cc provider plugin.
 *
 * Tests the end-to-end flow by mocking:
 * - tmux commands (via child_process.exec)
 * - JSONL transcript files (via fs)
 *
 * Each test verifies a complete scenario from message input to response output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  windowNameFromSessionKey,
  getOrCreateSession,
  cleanupIdleSessions,
  destroyAllSessions,
} from "./session-map.js";
import { createTmuxClaudeStreamFn, extractNewUserMessages } from "./stream-fn.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import type { TmuxClaudeConfig, SessionState } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

// Mock exec from child_process (used via promisify).
// Use callback-based error signaling to work correctly with promisify.
const execMock = vi.hoisted(() => vi.fn<any[], any>());

vi.mock("node:child_process", () => ({
  exec: execMock,
}));

// Helpers for setting mock exec behavior
function mockSuccess(stdout = "") {
  return (_cmd: string, _opts: any, callback?: Function) => {
    const cb = typeof _opts === "function" ? _opts : callback;
    if (cb) cb(null, { stdout, stderr: "" });
    return {};
  };
}

function mockError(msg: string) {
  return (_cmd: string, _opts: any, callback?: Function) => {
    const cb = typeof _opts === "function" ? _opts : callback;
    if (cb) cb(new Error(msg));
    return {};
  };
}

function getCmds(): string[] {
  return execMock.mock.calls.map((call: any[]) => call[0] as string);
}

// Command-routing mock: dispatches based on command content
function mockRouter(router: (cmd: string) => string) {
  return (cmd: string, _opts: any, callback?: Function) => {
    const cb = typeof _opts === "function" ? _opts : callback;
    try {
      const stdout = router(cmd);
      if (cb) cb(null, { stdout, stderr: "" });
    } catch (e) {
      if (cb) cb(e);
    }
    return {};
  };
}

describe("acceptance: session lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execMock.mockImplementation(mockSuccess(""));
  });

  afterEach(async () => {
    await destroyAllSessions();
  });

  it("creates a new tmux window on first message for a session key", async () => {
    execMock.mockImplementation(mockRouter((cmd: string) => {
      if (cmd.includes("has-session")) return "";
      if (cmd.includes("select-window")) throw new Error("window not found");
      if (cmd.includes("new-window")) return "";
      if (cmd.includes("list-panes") && cmd.includes("pane_current_command")) return "claude 0";
      if (cmd.includes("capture-pane")) return "❯ ";
      return "";
    }));

    const session = await getOrCreateSession("test-session-1", "sonnet-4.6", {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    });

    expect(session.sessionKey).toBe("test-session-1");
    expect(session.windowName).toBe("cc-test-session-1");
    expect(session.model).toBe("sonnet-4.6");

    const cmds = getCmds();
    const windowCmd = cmds.find((c) => c.includes("new-window"));
    expect(windowCmd).toBeDefined();
    expect(windowCmd).toContain("--dangerously-skip-permissions");
    expect(windowCmd).not.toContain("--permission-mode");
    expect(windowCmd).toContain("--model");
    expect(windowCmd).toContain("sonnet-4.6");
  });

  it("reuses an existing session for the same session key", async () => {
    let selectWindowCallCount = 0;
    execMock.mockImplementation(mockRouter((cmd: string) => {
      if (cmd.includes("select-window")) {
        selectWindowCallCount++;
        if (selectWindowCallCount === 1) throw new Error("window not found");
        return "";
      }
      if (cmd.includes("pane_current_command")) return "claude 0";
      if (cmd.includes("capture-pane")) return "❯ ";
      return "";
    }));

    const session1 = await getOrCreateSession("reuse-test", "sonnet-4.6", {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    });
    const session2 = await getOrCreateSession("reuse-test", "sonnet-4.6", {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    });

    expect(session1.windowName).toBe(session2.windowName);

    const newWindowCalls = getCmds().filter((c) => c.includes("new-window"));
    expect(newWindowCalls).toHaveLength(1);
  });

  it("restarts a crashed session with --resume", async () => {
    let aliveCheckCount = 0;
    let sessionCreated = false;
    execMock.mockImplementation(mockRouter((cmd: string) => {
      if (cmd.includes("pane_current_command")) {
        aliveCheckCount++;
        if (!sessionCreated) return "claude 0";
        if (aliveCheckCount === 1) return "claude 1";  // pane_dead=1 (remain-on-exit)
        return "claude 0";
      }
      if (cmd.includes("capture-pane")) return "❯ ";
      return "";
    }));

    const config: TmuxClaudeConfig = {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    };

    const session1 = await getOrCreateSession("crash-test", "sonnet-4.6", config);
    session1.claudeSessionId = "abc123";

    sessionCreated = true;
    aliveCheckCount = 0;

    const session2 = await getOrCreateSession("crash-test", "sonnet-4.6", config);

    expect(session2.windowName).toBe(session1.windowName);

    const cmds = getCmds();
    expect(cmds.some((c) => c.includes("kill-window"))).toBe(true);

    const resumeCmds = cmds.filter((c) => c.includes("new-window") && c.includes("--resume"));
    expect(resumeCmds.length).toBeGreaterThanOrEqual(1);
    expect(resumeCmds[0]).toContain("abc123");
  });

  it("cleans up idle sessions after timeout", async () => {
    execMock.mockImplementation(mockRouter((cmd: string) => {
      if (cmd.includes("pane_current_command")) return "claude 0";
      if (cmd.includes("capture-pane")) return "❯ ";
      return "";
    }));

    const config: TmuxClaudeConfig = {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
      idleTimeoutMs: 1000,
    };

    const session = await getOrCreateSession("idle-test", "sonnet-4.6", config);
    session.lastActivityMs = Date.now() - 2000;

    const cleaned = await cleanupIdleSessions(config);
    expect(cleaned).toBe(1);

    expect(getCmds().some((c) => c.includes("kill-window"))).toBe(true);
  });
});

describe("acceptance: message extraction", () => {
  it("extracts text from a simple conversation", () => {
    const messages = [{ role: "user" as const, content: "Hello, Claude!" }];
    const text = extractNewUserMessages(messages);
    expect(text).toBe("Hello, Claude!");
  });

  it("extracts only new messages after last assistant turn", () => {
    const messages = [
      { role: "user" as const, content: "First question" },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "First answer" }],
        api: "anthropic-v1",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      },
      { role: "user" as const, content: "Second question" },
    ];
    const text = extractNewUserMessages(messages);
    expect(text).toBe("Second question");
  });

  it("handles structured content with images", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "What's in this image?" },
          {
            type: "image" as const,
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
          },
        ],
      },
    ];
    const text = extractNewUserMessages(messages);
    // extractNewUserMessages only extracts text parts; images are handled separately
    expect(text).toBe("What's in this image?");
  });
});

describe("acceptance: transcript reading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tmux-cc-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads and parses a JSONL transcript file", async () => {
    const { readNewEntries, extractAssistantResponse, isResponseComplete } =
      await import("./transcript-reader.js");

    // Create a mock transcript file
    const transcriptFile = join(tmpDir, "test-session.jsonl");
    const entries = [
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Hello" }] },
        sessionId: "test-123",
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello! How can I help?" }],
        },
        sessionId: "test-123",
        timestamp: new Date().toISOString(),
        stop_reason: "end_turn",
      }),
    ];
    writeFileSync(transcriptFile, entries.join("\n") + "\n");

    // Read entries
    const result = readNewEntries(transcriptFile, 0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].type).toBe("user");
    expect(result.entries[1].type).toBe("assistant");

    // Extract response
    const response = extractAssistantResponse(result.entries);
    expect(response.text).toBe("Hello! How can I help?");
    expect(response.isComplete).toBe(true);
    expect(response.sessionId).toBe("test-123");

    // Check completion
    expect(isResponseComplete(result.entries)).toBe(true);
  });

  it("handles incremental reading with byte offsets", async () => {
    const { readNewEntries } = await import("./transcript-reader.js");

    const transcriptFile = join(tmpDir, "incremental.jsonl");

    // Write first entry
    const entry1 =
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Part 1" }] },
        sessionId: "inc-123",
      }) + "\n";
    writeFileSync(transcriptFile, entry1);

    const result1 = readNewEntries(transcriptFile, 0);
    expect(result1.entries).toHaveLength(1);
    expect(result1.newOffset).toBe(Buffer.byteLength(entry1));

    // Append second entry
    const entry2 =
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Reply" }] },
        sessionId: "inc-123",
        stop_reason: "end_turn",
      }) + "\n";
    writeFileSync(transcriptFile, entry1 + entry2);

    // Read only new entries from previous offset
    const result2 = readNewEntries(transcriptFile, result1.newOffset);
    expect(result2.entries).toHaveLength(1);
    expect(result2.entries[0].type).toBe("assistant");
  });
});

describe("acceptance: window naming", () => {
  it("generates valid tmux window names from session keys", () => {
    expect(windowNameFromSessionKey("telegram:12345:67890")).toBe("cc-telegram-12345-67890");
    expect(windowNameFromSessionKey("discord:guild:channel")).toBe("cc-discord-guild-channel");
    expect(windowNameFromSessionKey("web-session-abc")).toBe("cc-web-session-abc");
  });

  it("truncates long session keys to avoid tmux limits", () => {
    const longKey = "a".repeat(100);
    const name = windowNameFromSessionKey(longKey);
    // cc- prefix (3) + 50 chars = 53
    expect(name.length).toBeLessThanOrEqual(53);
    expect(name).toMatch(/^cc-/);
  });
});

describe("acceptance: model selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execMock.mockImplementation(mockRouter((cmd: string) => {
      if (cmd.includes("select-window")) throw new Error("window not found");
      if (cmd.includes("pane_current_command")) return "claude 0";
      if (cmd.includes("capture-pane")) return "❯ ";
      return "";
    }));
  });

  afterEach(async () => {
    await destroyAllSessions();
  });

  it("sends /model command when model changes on existing session", async () => {
    let sessionCreated = false;
    execMock.mockImplementation(mockRouter((cmd: string) => {
      if (cmd.includes("select-window")) {
        if (!sessionCreated) throw new Error("window not found");
        return "";
      }
      if (cmd.includes("pane_current_command")) return "claude 0";
      if (cmd.includes("capture-pane")) return "❯ ";
      return "";
    }));

    const config: TmuxClaudeConfig = {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    };

    const session1 = await getOrCreateSession("model-switch-test", "sonnet-4.6", config);
    session1.claudeSessionId = "switch-123";
    sessionCreated = true;
    expect(session1.model).toBe("sonnet-4.6");

    const session2 = await getOrCreateSession("model-switch-test", "opus-4.6", config);
    expect(session2.model).toBe("opus-4.6");
    expect(session2.windowName).toBe(session1.windowName);

    const cmds = getCmds();
    expect(cmds.some((c) => c.includes("send-keys") && c.includes("/model opus-4.6"))).toBe(true);
    expect(cmds.some((c) => c.includes("kill-window"))).toBe(false);
  });

  it("interrupts CC with Escape before /model when CC is processing", async () => {
    let sessionCreated = false;
    let processingCallCount = 0;
    execMock.mockImplementation(mockRouter((cmd: string) => {
      if (cmd.includes("select-window")) {
        if (!sessionCreated) throw new Error("window not found");
        return "";
      }
      if (cmd.includes("pane_current_command")) return "claude 0";
      if (cmd.includes("capture-pane")) {
        processingCallCount++;
        if (processingCallCount <= 2) return "esc to interrupt";
        return "❯ ";
      }
      return "";
    }));

    const config: TmuxClaudeConfig = {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    };
    const adapter = new ClaudeCodeAdapter();

    const session1 = await getOrCreateSession("interrupt-test", "sonnet-4.6", config, adapter);
    session1.claudeSessionId = "int-123";
    sessionCreated = true;
    processingCallCount = 0;

    await getOrCreateSession("interrupt-test", "opus-4.6", config, adapter);

    const cmds = getCmds();
    expect(cmds.some((c) => c.includes("send-keys") && c.includes("Escape") && !c.includes("-l"))).toBe(true);
    expect(cmds.some((c) => c.includes("send-keys") && c.includes("/model claude-opus-4-6"))).toBe(true);
  });

  it("passes the correct model to Claude Code", async () => {
    await getOrCreateSession("model-test", "opus-4.6", {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    });

    const cmds = getCmds();
    const newWindowCmd = cmds.find((c) => c.includes("new-window"));
    expect(newWindowCmd).toBeDefined();
    expect(newWindowCmd).toContain("opus-4.6");
  });
});
