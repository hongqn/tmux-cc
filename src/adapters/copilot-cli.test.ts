import { describe, expect, it, vi, beforeEach } from "vitest";
import { CopilotCliAdapter } from "./copilot-cli.js";

// Mock tmux-manager to avoid actual tmux calls
vi.mock("../tmux-manager.js", () => ({
  createWindow: vi.fn(() => Promise.resolve()),
  isProcessAlive: vi.fn(() => Promise.resolve(false)),
  isWindowReady: vi.fn(() => Promise.resolve(false)),
  killWindow: vi.fn(() => Promise.resolve()),
  listWindows: vi.fn(() => Promise.resolve([])),
  waitForReady: vi.fn(() => Promise.resolve(true)),
  windowExists: vi.fn(() => Promise.resolve(false)),
  sendKeys: vi.fn(() => Promise.resolve()),
  sendTmuxKey: vi.fn(() => Promise.resolve()),
  capturePane: vi.fn(() => Promise.resolve("")),
  listPanes: vi.fn(() => Promise.resolve("")),
}));

const tmuxManager = await import("../tmux-manager.js");

describe("CopilotCliAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("KPSS whitelist", () => {
    it("appends KPSS suffix when no whitelist configured", async () => {
      const adapter = new CopilotCliAdapter();
      vi.mocked(tmuxManager.capturePane).mockResolvedValue("❯ prompt");

      await adapter.sendMessage("sess", "win", "hello", "agent:main:cron:123");

      const sentText = vi.mocked(tmuxManager.sendKeys).mock.calls[0][2];
      expect(sentText).toContain("Use the ask user tool");
    });

    it("appends KPSS suffix for whitelisted session key", async () => {
      const adapter = new CopilotCliAdapter({
        kpssSessionWhitelist: ["*telegram*"],
      });
      vi.mocked(tmuxManager.capturePane).mockResolvedValue("❯ prompt");

      await adapter.sendMessage("sess", "win", "hello", "agent:main:telegram:group:-123");

      const sentText = vi.mocked(tmuxManager.sendKeys).mock.calls[0][2];
      expect(sentText).toContain("Use the ask user tool");
    });

    it("does NOT append KPSS suffix for non-whitelisted session key", async () => {
      const adapter = new CopilotCliAdapter({
        kpssSessionWhitelist: ["*telegram*"],
        kpssNonWhitelistBehavior: "no-kpss",
      });
      vi.mocked(tmuxManager.capturePane).mockResolvedValue("❯ prompt");

      await adapter.sendMessage("sess", "win", "hello", "agent:main:cron:abc-123");

      const sentText = vi.mocked(tmuxManager.sendKeys).mock.calls[0][2];
      expect(sentText).toBe("hello");
      expect(sentText).not.toContain("Use the ask user tool");
    });

    it("throws error for non-whitelisted session when behavior is reject", () => {
      const adapter = new CopilotCliAdapter({
        kpssSessionWhitelist: ["*telegram*"],
        kpssNonWhitelistBehavior: "reject",
      });

      expect(() =>
        adapter.validateSession("agent:main:cron:abc-123"),
      ).toThrow("rejected");
    });

    it("returns fallback info for non-whitelisted session when fallback configured", () => {
      const adapter = new CopilotCliAdapter({
        kpssSessionWhitelist: ["*telegram*"],
        kpssNonWhitelistBehavior: { fallback: "sonnet-4.6" },
      });

      const result = adapter.validateSession("agent:main:cron:abc-123");
      expect(result).toEqual({ fallback: "sonnet-4.6" });
    });

    it("returns undefined for non-whitelisted session when behavior is no-kpss", () => {
      const adapter = new CopilotCliAdapter({
        kpssSessionWhitelist: ["*telegram*"],
        kpssNonWhitelistBehavior: "no-kpss",
      });

      const result = adapter.validateSession("agent:main:cron:abc-123");
      expect(result).toBeUndefined();
    });

    it("returns undefined for whitelisted session regardless of behavior", () => {
      const adapter = new CopilotCliAdapter({
        kpssSessionWhitelist: ["*telegram*"],
        kpssNonWhitelistBehavior: { fallback: "sonnet-4.6" },
      });

      const result = adapter.validateSession("agent:main:telegram:123");
      expect(result).toBeUndefined();
    });

    it("matches multiple whitelist patterns", async () => {
      const adapter = new CopilotCliAdapter({
        kpssSessionWhitelist: ["*telegram*", "*main"],
      });
      vi.mocked(tmuxManager.capturePane).mockResolvedValue("❯ prompt");

      // Test main pattern
      await adapter.sendMessage("sess", "win", "hello", "agent:main:main");
      let sentText = vi.mocked(tmuxManager.sendKeys).mock.calls[0][2];
      expect(sentText).toContain("Use the ask user tool");

      vi.clearAllMocks();

      // Test telegram pattern
      await adapter.sendMessage("sess", "win", "hello", "agent:main:telegram:123");
      sentText = vi.mocked(tmuxManager.sendKeys).mock.calls[0][2];
      expect(sentText).toContain("Use the ask user tool");
    });

    it("defaults to KPSS enabled when sessionKey is undefined", async () => {
      const adapter = new CopilotCliAdapter({
        kpssSessionWhitelist: ["*telegram*"],
      });
      vi.mocked(tmuxManager.capturePane).mockResolvedValue("❯ prompt");

      await adapter.sendMessage("sess", "win", "hello");

      const sentText = vi.mocked(tmuxManager.sendKeys).mock.calls[0][2];
      expect(sentText).toContain("Use the ask user tool");
    });
  });

  describe("isWaitingForUserInput", () => {
    it("returns true when pane shows ask_user options", async () => {
      const adapter = new CopilotCliAdapter();
      vi.mocked(tmuxManager.capturePane).mockResolvedValue(
        "some text\n↑↓ to select · Enter to confirm · Esc to cancel\n❯ 1. Option",
      );

      const result = await adapter.isWaitingForUserInput("sess", "win");
      expect(result).toBe(true);
    });

    it("returns true for new TUI string 'Enter to select · ↑/↓ to navigate · Esc to cancel'", async () => {
      // Newer Copilot builds (and Claude Code's AskUserQuestion UI) render
      // the selector hint differently. The detection must accept both
      // variants so we don't silently lose ask_user routing on upgrade.
      const adapter = new CopilotCliAdapter();
      vi.mocked(tmuxManager.capturePane).mockResolvedValue(
        "❯ 1. Add more\n  2. Done\n  3. Type something.\nEnter to select · ↑/↓ to navigate · Esc to cancel",
      );

      const result = await adapter.isWaitingForUserInput("sess", "win");
      expect(result).toBe(true);
    });

    it("returns true when pane shows asking user indicator", async () => {
      const adapter = new CopilotCliAdapter();
      vi.mocked(tmuxManager.capturePane).mockResolvedValue(
        "some text\n○ Asking user What do you want?",
      );

      const result = await adapter.isWaitingForUserInput("sess", "win");
      expect(result).toBe(true);
    });

    it("returns false when pane shows normal prompt", async () => {
      const adapter = new CopilotCliAdapter();
      vi.mocked(tmuxManager.capturePane).mockResolvedValue("❯ Type something");

      const result = await adapter.isWaitingForUserInput("sess", "win");
      expect(result).toBe(false);
    });

    it("returns false when capturePane fails", async () => {
      const adapter = new CopilotCliAdapter();
      vi.mocked(tmuxManager.capturePane).mockRejectedValue(new Error("window gone"));

      const result = await adapter.isWaitingForUserInput("sess", "win");
      expect(result).toBe(false);
    });

    it("returns false when pane is empty", async () => {
      const adapter = new CopilotCliAdapter();
      vi.mocked(tmuxManager.capturePane).mockResolvedValue("");

      const result = await adapter.isWaitingForUserInput("sess", "win");
      expect(result).toBe(false);
    });
  });
});
