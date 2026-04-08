import { describe, expect, it, vi, beforeEach } from "vitest";
import { windowNameFromSessionKey, cleanupOrphanedWindows, _setHasEverCreatedSession } from "./session-map.js";
import * as tmuxManager from "./tmux-manager.js";

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
      // Only bash left REDACTED kill the entire session
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
});
