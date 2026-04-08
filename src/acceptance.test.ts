import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Acceptance tests for the tmux-cc provider plugin.
 *
 * Tests the end-to-end flow by mocking:
 * - tmux commands (via child_process.execSync)
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
import type { TmuxClaudeConfig, SessionState } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

// We need to mock child_process.execSync for all tmux commands
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

describe("acceptance: session lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all tmux commands succeed
    execSyncMock.mockReturnValue("");
  });

  afterEach(() => {
    // Clean up session state between tests
    destroyAllSessions();
  });

  it("creates a new tmux window on first message for a session key", () => {
    // Mock isProcessAlive check REDACTED returns "claude" for pane_current_command
    // Mock waitForReady Phase 2 REDACTED returns content with REDACTED prompt
    // windowExists (select-window) should FAIL for the first check REDACTED no existing window
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("has-session")) return "";
      if (cmd.includes("select-window")) throw new Error("window not found");
      if (cmd.includes("new-window")) return "";
      if (cmd.includes("list-panes") && cmd.includes("pane_current_command")) {
        return "claude 0";
      }
      if (cmd.includes("capture-pane")) return "REDACTED ";
      return "";
    });

    const session = getOrCreateSession("test-session-1", "sonnet-4.6", {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    });

    expect(session.sessionKey).toBe("test-session-1");
    expect(session.windowName).toBe("cc-test-session-1");
    expect(session.model).toBe("sonnet-4.6");

    // Verify tmux new-window was called with correct flags
    const newWindowCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("new-window"),
    );
    expect(newWindowCalls.length).toBeGreaterThanOrEqual(1);
    const windowCmd = newWindowCalls[0][0] as string;
    expect(windowCmd).toContain("--permission-mode");
    expect(windowCmd).toContain("bypassPermissions");
    expect(windowCmd).not.toContain("--dangerously-skip-permissions");
    expect(windowCmd).toContain("--model");
    expect(windowCmd).toContain("sonnet-4.6");
  });

  it("reuses an existing session for the same session key", () => {
    let selectWindowCallCount = 0;
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("select-window")) {
        selectWindowCallCount++;
        // First select-window check: no existing window yet
        if (selectWindowCallCount === 1) throw new Error("window not found");
        return "";
      }
      if (cmd.includes("pane_current_command")) return "claude 0";
      if (cmd.includes("capture-pane")) return "REDACTED ";
      return "";
    });

    const session1 = getOrCreateSession("reuse-test", "sonnet-4.6", {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    });
    const session2 = getOrCreateSession("reuse-test", "sonnet-4.6", {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    });

    expect(session1.windowName).toBe(session2.windowName);

    // new-window should only have been called once
    const newWindowCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("new-window"),
    );
    expect(newWindowCalls).toHaveLength(1);
  });

  it("restarts a crashed session with --resume", () => {
    // Track how many times pane_current_command is polled.
    // During the first getOrCreateSession: waitForReady polls until it sees "claude".
    // During the second getOrCreateSession: getOrCreateSession checks isProcessAlive,
    //   which must see "bash" (dead), triggering restart, then waitForReady
    //   polls until it sees "claude" again.
    let aliveCheckCount = 0;
    let sessionCreated = false;
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("pane_current_command")) {
        aliveCheckCount++;
        if (!sessionCreated) {
          // During first getOrCreateSession: process is alive
          return "claude 0";
        }
        // During second getOrCreateSession:
        // First check (isProcessAlive inside getOrCreateSession) REDACTED dead
        // Subsequent checks (waitForReady after restart) REDACTED alive
        if (aliveCheckCount === 1) return "bash";
        return "claude 0";
      }
      if (cmd.includes("capture-pane")) return "REDACTED ";
      return "";
    });

    const config: TmuxClaudeConfig = {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    };

    // Create initial session
    const session1 = getOrCreateSession("crash-test", "sonnet-4.6", config);
    session1.claudeSessionId = "abc123";

    // Reset counter and mark session as created to change mock behavior
    sessionCreated = true;
    aliveCheckCount = 0;

    // Simulate crash: next getOrCreateSession should detect dead process and restart
    const session2 = getOrCreateSession("crash-test", "sonnet-4.6", config);

    // Same window name REDACTED session was restarted, not recreated
    expect(session2.windowName).toBe(session1.windowName);

    // Verify kill-window was called for the crashed session
    const killCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("kill-window"),
    );
    expect(killCalls.length).toBeGreaterThanOrEqual(1);

    // Verify new-window was called with --resume and the session ID
    const resumeCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("new-window") &&
        (call[0] as string).includes("--resume"),
    );
    expect(resumeCalls.length).toBeGreaterThanOrEqual(1);
    expect(resumeCalls[0][0] as string).toContain("abc123");
  });

  it("cleans up idle sessions after timeout", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("pane_current_command")) return "claude 0";
      if (cmd.includes("capture-pane")) return "REDACTED ";
      return "";
    });

    const config: TmuxClaudeConfig = {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
      idleTimeoutMs: 1000, // 1 second for test
    };

    // Create session
    const session = getOrCreateSession("idle-test", "sonnet-4.6", config);
    // Set lastActivityMs to 2 seconds ago
    session.lastActivityMs = Date.now() - 2000;

    const cleaned = cleanupIdleSessions(config);
    expect(cleaned).toBe(1);

    // Verify kill-window was called
    const killCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("kill-window"),
    );
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
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
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("select-window")) throw new Error("window not found");
      if (cmd.includes("pane_current_command")) return "claude 0";
      if (cmd.includes("capture-pane")) return "REDACTED ";
      return "";
    });
  });

  afterEach(() => {
    destroyAllSessions();
  });

  it("sends /model command when model changes on existing session", () => {
    let sessionCreated = false;
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("select-window")) {
        if (!sessionCreated) throw new Error("window not found");
        return "";
      }
      if (cmd.includes("pane_current_command")) return "claude 0";
      if (cmd.includes("capture-pane")) return "REDACTED ";
      return "";
    });

    const config: TmuxClaudeConfig = {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    };

    // Create session with sonnet
    const session1 = getOrCreateSession("model-switch-test", "sonnet-4.6", config);
    session1.claudeSessionId = "switch-123";
    sessionCreated = true;
    expect(session1.model).toBe("sonnet-4.6");

    // Switch to opus REDACTED should send /model command, not restart
    const session2 = getOrCreateSession("model-switch-test", "opus-4.6", config);
    expect(session2.model).toBe("opus-4.6");
    expect(session2.windowName).toBe(session1.windowName);

    // Verify /model command was sent via send-keys
    const sendKeysCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("send-keys") &&
        (call[0] as string).includes("/model opus-4.6"),
    );
    expect(sendKeysCalls.length).toBeGreaterThanOrEqual(1);

    // Verify NO kill-window or new-window was called (no restart)
    const killCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("kill-window"),
    );
    expect(killCalls).toHaveLength(0);
  });

  it("interrupts CC with Escape before /model when CC is processing", () => {
    let sessionCreated = false;
    let processingCallCount = 0;
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("select-window")) {
        if (!sessionCreated) throw new Error("window not found");
        return "";
      }
      if (cmd.includes("pane_current_command")) return "claude 0";
      if (cmd.includes("capture-pane")) {
        // First capture-pane call during model switch: CC is processing
        // Second call: CC is idle
        processingCallCount++;
        if (processingCallCount <= 1) return "esc to interrupt";
        return "REDACTED ";
      }
      return "";
    });

    const config: TmuxClaudeConfig = {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    };

    const session1 = getOrCreateSession("interrupt-test", "sonnet-4.6", config);
    session1.claudeSessionId = "int-123";
    sessionCreated = true;
    processingCallCount = 0;

    getOrCreateSession("interrupt-test", "opus-4.6", config);

    // Verify Escape was sent (non-literal send-keys without -l)
    const escapeCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("send-keys") &&
        (call[0] as string).includes("Escape") &&
        !(call[0] as string).includes("-l"),
    );
    expect(escapeCalls.length).toBeGreaterThanOrEqual(1);

    // Verify /model was still sent after interrupt
    const modelCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("send-keys") &&
        (call[0] as string).includes("/model opus-4.6"),
    );
    expect(modelCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("passes the correct model to Claude Code", () => {
    getOrCreateSession("model-test", "opus-4.6", {
      tmuxSession: "test-tmux",
      workingDirectory: "/tmp/test-wd",
    });

    const newWindowCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("new-window"),
    );
    expect(newWindowCalls.length).toBeGreaterThanOrEqual(1);
    expect(newWindowCalls[0][0] as string).toContain("opus-4.6");
  });
});
