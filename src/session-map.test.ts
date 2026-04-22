import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { windowNameFromSessionKey, cleanupOrphanedWindows, _setHasEverCreatedSession, resolveSessionLocation, __resetForTests } from "./session-map.js";
import * as tmuxManager from "./tmux-manager.js";
import * as fsPromises from "node:fs/promises";

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
      await resolveSessionLocation(SESSION_ID); // second call — no rescan (no cache hit, but warn dedup fires)
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
});
