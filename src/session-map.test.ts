import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { windowNameFromSessionKey, cleanupOrphanedWindows, _setHasEverCreatedSession, resolveSessionLocation, __resetForTests, isEphemeralSessionKeyName, getOrCreateSession, deleteSession, getSession, destroyAllSessions } from "./session-map.js";
import * as tmuxManager from "./tmux-manager.js";
import * as fsPromises from "node:fs/promises";
import type { AgentAdapter } from "./adapters/types.js";

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("./tmux-manager.js", () => ({
  createWindow: vi.fn(() => Promise.resolve()),
  isProcessAlive: vi.fn(() => Promise.resolve(false)),
  isWindowReady: vi.fn(() => Promise.resolve(false)),
  killSession: vi.fn(() => Promise.resolve()),
  killWindow: vi.fn(() => Promise.resolve()),
  listWindows: vi.fn(() => Promise.resolve([])),
  waitForReady: vi.fn(() => Promise.resolve(true)),
  windowExists: vi.fn(() => Promise.resolve(false)),
}));

describe("session-map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await destroyAllSessions({ tmuxSession: "test-tmux" });
  });

  function makeAdapter(id: string): AgentAdapter {
    return {
      id,
      models: [],
      createAgentWindow: vi.fn(() => Promise.resolve()),
      waitForReady: vi.fn(() => Promise.resolve(true)),
      isWindowReady: vi.fn(() => Promise.resolve(false)),
      isProcessAlive: vi.fn(() => Promise.resolve(false)),
      isProcessing: vi.fn(() => Promise.resolve(false)),
      switchModel: vi.fn(() => Promise.resolve()),
      handleBlockingPrompts: vi.fn(() => Promise.resolve()),
      getExistingTranscriptPaths: vi.fn(() => new Map()),
      findTranscriptBySessionId: vi.fn(() => null),
      findNewTranscript: vi.fn(() => null),
      findGrowingTranscript: vi.fn(() => null),
      findLatestTranscript: vi.fn(() => null),
      extractSessionId: vi.fn(() => "session-id"),
      readNewEntries: vi.fn(() => ({ entries: [], newOffset: 0 })),
      extractAssistantResponse: vi.fn(() => ({ text: "", isComplete: false })),
      setupWorkspace: vi.fn(),
      resolveModelId: vi.fn((modelId: string) => modelId),
    };
  }

  describe("windowNameFromSessionKey", () => {
    it("prefixes with cc-", () => {
      expect(windowNameFromSessionKey("test")).toBe("cc-test");
    });

    it("sanitizes special characters", () => {
      expect(windowNameFromSessionKey("user@telegram:12345")).toBe("cc-user-telegram-12345");
    });

    it("truncates long session keys", () => {
      const longKey = "a".repeat(100);
      const result = windowNameFromSessionKey(longKey);
      expect(result.length).toBeLessThanOrEqual(53); // cc- + 50 chars
    });

    it("handles empty string", () => {
      expect(windowNameFromSessionKey("")).toBe("cc-");
    });

    it("preserves alphanumeric, dash, and underscore", () => {
      expect(windowNameFromSessionKey("my_session-123")).toBe("cc-my_session-123");
    });
  });

  describe("adapter-scoped runtime sessions", () => {
    it("keeps separate live sessions for different adapters sharing one logical session key", async () => {
      vi.mocked(tmuxManager.windowExists).mockResolvedValue(false);
      const copilotAdapter = makeAdapter("copilot-cli");
      const claudeAdapter = makeAdapter("claude-code");
      const config = { tmuxSession: "test-tmux", workingDirectory: "/tmp/test-wd" };

      const copilotSession = await getOrCreateSession("shared-session", "claude-opus-4.6", config, copilotAdapter);
      const claudeSession = await getOrCreateSession("shared-session", "sonnet-4.6", config, claudeAdapter);

      expect(copilotSession.sessionKey).toBe("shared-session");
      expect(claudeSession.sessionKey).toBe("shared-session");
      expect(copilotSession.windowName).not.toBe(claudeSession.windowName);
      expect(copilotSession.windowName).toContain("copilot-cli");
      expect(claudeSession.windowName).toContain("claude-code");

      await deleteSession("shared-session", config, copilotAdapter);

      expect(getSession("shared-session", copilotAdapter)).toBeNull();
      expect(getSession("shared-session", claudeAdapter)).toBe(claudeSession);
      expect(tmuxManager.killWindow).toHaveBeenCalledWith("test-tmux", copilotSession.windowName);
      expect(tmuxManager.killWindow).not.toHaveBeenCalledWith("test-tmux", claudeSession.windowName);
    });
  });

  describe("cleanupOrphanedWindows", () => {
    beforeEach(() => {
      _setHasEverCreatedSession(true);
    });

    it("skips cleanup when no session has ever been created", async () => {
      _setHasEverCreatedSession(false);
      vi.mocked(tmuxManager.listWindows).mockResolvedValue(["bash", "cc-orphan"]);

      const cleaned = await cleanupOrphanedWindows({ tmuxSession: "openclaw-cc" });
      expect(cleaned).toBe(0);
      expect(tmuxManager.killWindow).not.toHaveBeenCalled();
    });

    it("kills orphaned cc-* windows not tracked in sessions Map", async () => {
      vi.mocked(tmuxManager.listWindows).mockImplementation(async (session: string) => {
        if (session === "openclaw-cc") {
          return ["bash", "cc-orphan1", "cc-orphan2"];
        }
        return [];
      });

      const cleaned = await cleanupOrphanedWindows({ tmuxSession: "openclaw-cc" });
      expect(cleaned).toBe(2);
      expect(tmuxManager.killWindow).toHaveBeenCalledWith("openclaw-cc", "cc-orphan1");
      expect(tmuxManager.killWindow).toHaveBeenCalledWith("openclaw-cc", "cc-orphan2");
    });

    it("does not kill non-cc-* windows", async () => {
      vi.mocked(tmuxManager.listWindows).mockImplementation(async (session: string) => {
        if (session === "openclaw-cc") {
          return ["bash", "other-window"];
        }
        return [];
      });

      const cleaned = await cleanupOrphanedWindows({ tmuxSession: "openclaw-cc" });
      expect(cleaned).toBe(0);
      expect(tmuxManager.killWindow).not.toHaveBeenCalled();
    });

    it("cleans up legacy openclaw-claude sessions", async () => {
      const listWindowsCalls: string[] = [];
      vi.mocked(tmuxManager.listWindows).mockImplementation(async (session: string) => {
        listWindowsCalls.push(session);
        if (session === "openclaw-claude") {
          // First call: before cleanup. Second call: after cleanup (bash remains)
          const callCount = listWindowsCalls.filter((s) => s === "openclaw-claude").length;
          if (callCount === 1) return ["bash", "cc-old1", "cc-old2"];
          return ["bash"];
        }
        return [];
      });

      const cleaned = await cleanupOrphanedWindows({ tmuxSession: "openclaw-cc" });
      expect(cleaned).toBe(2);
      expect(tmuxManager.killWindow).toHaveBeenCalledWith("openclaw-claude", "cc-old1");
      expect(tmuxManager.killWindow).toHaveBeenCalledWith("openclaw-claude", "cc-old2");
      // Only bash left → kill the entire session
      expect(tmuxManager.killSession).toHaveBeenCalledWith("openclaw-claude");
    });

    it("kills entire legacy session when all windows are orphaned", async () => {
      vi.mocked(tmuxManager.listWindows)
        .mockResolvedValueOnce([]) // current session: empty
        .mockResolvedValueOnce(["cc-orphan"]) // legacy: has orphan
        .mockResolvedValueOnce([]); // legacy after cleanup: empty

      const cleaned = await cleanupOrphanedWindows({ tmuxSession: "openclaw-cc" });
      expect(cleaned).toBe(1);
      expect(tmuxManager.killSession).toHaveBeenCalledWith("openclaw-claude");
    });

    it("does not kill legacy session if non-cc windows remain", async () => {
      vi.mocked(tmuxManager.listWindows)
        .mockResolvedValueOnce([]) // current session
        .mockResolvedValueOnce(["bash", "cc-orphan", "manual-window"]) // legacy
        .mockResolvedValueOnce(["bash", "manual-window"]); // legacy after cleanup

      const cleaned = await cleanupOrphanedWindows({ tmuxSession: "openclaw-cc" });
      expect(cleaned).toBe(1);
      expect(tmuxManager.killWindow).toHaveBeenCalledWith("openclaw-claude", "cc-orphan");
      expect(tmuxManager.killSession).not.toHaveBeenCalled();
    });
  });

  describe("resolveSessionLocation", () => {
    const SESSION_ID = "6b90c5d0-705e-4c92-bcb1-13d6e51f8c8c";
    const AGENTS_DIR_RE = /\.openclaw[/\\]agents$/;

    beforeEach(() => {
      __resetForTests();
      vi.clearAllMocks();
    });

    afterEach(() => {
      __resetForTests();
    });

    function mockAgentsDir(agentDirs: string[]) {
      vi.mocked(fsPromises.readdir).mockImplementation(async (p) => {
        if (AGENTS_DIR_RE.test(String(p))) return agentDirs as unknown as ReturnType<typeof fsPromises.readdir>;
        throw new Error(`unexpected readdir: ${p}`);
      });
    }

    function mockSessionsJson(agentId: string, content: Record<string, unknown>) {
      vi.mocked(fsPromises.readFile).mockImplementation(async (p) => {
        if (String(p).includes(`${agentId}/sessions/sessions.json`)) {
          return JSON.stringify(content) as unknown as ReturnType<typeof fsPromises.readFile>;
        }
        throw new Error(`ENOENT: ${p}`);
      });
    }

    // (a) First-turn resolve from sessions.json with no JSONL present
    it("(a) resolves from sessions.json on first turn with no JSONL", async () => {
      mockAgentsDir(["main"]);
      mockSessionsJson("main", {
        "agent:main:telegram:group:-1003880947940": { sessionId: SESSION_ID, foo: "bar" },
      });
      // stat should not be called (primary path succeeds)
      vi.mocked(fsPromises.stat).mockRejectedValue(new Error("ENOENT"));

      const result = await resolveSessionLocation(SESSION_ID);
      expect(result).toEqual({ agentId: "main", keyName: "agent:main:telegram:group:-1003880947940" });
      expect(fsPromises.stat).not.toHaveBeenCalled();
    });

    // (b) Cache hit on second call — readdir/readFile invoked exactly once across both calls
    it("(b) returns cached result on second call without rescanning", async () => {
      mockAgentsDir(["main"]);
      mockSessionsJson("main", {
        "agent:main:telegram:group:-1003880947940": { sessionId: SESSION_ID },
      });

      const r1 = await resolveSessionLocation(SESSION_ID);
      const r2 = await resolveSessionLocation(SESSION_ID);
      expect(r1).toEqual(r2);
      expect(fsPromises.readdir).toHaveBeenCalledTimes(1);
      expect(fsPromises.readFile).toHaveBeenCalledTimes(1);
    });

    // (c) Returns null when no agent's sessions.json contains the sessionId
    it("(c) returns null when no agent matches and both scans fail", async () => {
      mockAgentsDir(["main"]);
      mockSessionsJson("main", {
        "agent:main:telegram:group:-1003880947940": { sessionId: "other-session-id" },
      });
      vi.mocked(fsPromises.stat).mockRejectedValue(new Error("ENOENT"));

      const result = await resolveSessionLocation(SESSION_ID);
      expect(result).toBeNull();
    });

    // (d) Returns null gracefully when sessions.json is missing or malformed in one agent dir,
    //     but correctly resolves from another well-formed agent dir.
    it("(d) skips malformed agent dir and resolves from another agent dir", async () => {
      mockAgentsDir(["broken", "good"]);
      vi.mocked(fsPromises.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("broken/sessions/sessions.json")) return "NOT_JSON" as unknown as ReturnType<typeof fsPromises.readFile>;
        if (ps.includes("good/sessions/sessions.json")) {
          return JSON.stringify({ "agent:good:main": { sessionId: SESSION_ID } }) as unknown as ReturnType<typeof fsPromises.readFile>;
        }
        throw new Error(`ENOENT: ${ps}`);
      });
      vi.mocked(fsPromises.stat).mockRejectedValue(new Error("ENOENT"));

      const result = await resolveSessionLocation(SESSION_ID);
      expect(result).toEqual({ agentId: "good", keyName: "agent:good:main" });
    });

    it("(d-missing) returns null and does not throw when sessions.json is missing for all agents", async () => {
      mockAgentsDir(["main"]);
      vi.mocked(fsPromises.readFile).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fsPromises.stat).mockRejectedValue(new Error("ENOENT"));

      await expect(resolveSessionLocation(SESSION_ID)).resolves.toBeNull();
    });

    // REQ-007: warning emitted exactly once per sessionId, not emitted for null/undefined
    it("(req-007) warns exactly once per sessionId when not found", async () => {
      mockAgentsDir(["main"]);
      vi.mocked(fsPromises.readFile).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fsPromises.stat).mockRejectedValue(new Error("ENOENT"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await resolveSessionLocation(SESSION_ID);
      await resolveSessionLocation(SESSION_ID); // second call — rescans (negative result not cached); warn dedup suppresses the duplicate warning
      await resolveSessionLocation(SESSION_ID); // third call

      // Warning fired for first unmatched call only
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(SESSION_ID));
      expect(warnSpy.mock.calls[0][0]).toContain("potential session split");
      warnSpy.mockRestore();
    });

    it("(req-007) does NOT warn when gatewaySessionId is null/undefined", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await resolveSessionLocation(undefined);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("isEphemeralSessionKeyName", () => {
    it("returns true for cron sessionKeyName", () => {
      expect(isEphemeralSessionKeyName("agent:main:cron:39c55720-766f-45e0-b3ef-a77bbc653a03")).toBe(true);
    });

    it("returns true for any agent's cron sessionKeyName", () => {
      expect(isEphemeralSessionKeyName("agent:horo:cron:job-abc")).toBe(true);
    });

    it("returns true for telegram /btw sessionKeyName", () => {
      expect(isEphemeralSessionKeyName("agent:horo:telegram:btw:12345")).toBe(true);
    });

    it("returns false for main conversation", () => {
      expect(isEphemeralSessionKeyName("agent:main:main")).toBe(false);
    });

    it("returns false for telegram chat", () => {
      expect(isEphemeralSessionKeyName("agent:horo:telegram:chat:-100123456")).toBe(false);
    });

    it("returns false for telegram slash", () => {
      expect(isEphemeralSessionKeyName("agent:horo:telegram:slash:67890")).toBe(false);
    });

    it("returns false for null", () => {
      expect(isEphemeralSessionKeyName(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isEphemeralSessionKeyName(undefined)).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isEphemeralSessionKeyName("")).toBe(false);
    });

    it("returns false for malformed (no colons)", () => {
      expect(isEphemeralSessionKeyName("notavalidkey")).toBe(false);
    });

    it("returns false for too-short prefix (agent:foo)", () => {
      expect(isEphemeralSessionKeyName("agent:foo")).toBe(false);
    });

    it("returns false for telegram without :btw: subkind", () => {
      expect(isEphemeralSessionKeyName("agent:horo:telegram")).toBe(false);
    });
  });
});
