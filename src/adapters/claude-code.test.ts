import { describe, expect, it, vi, beforeEach } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code.js";

// Mock tmux-manager to avoid actual tmux calls
vi.mock("../tmux-manager.js", () => ({
  createWindow: vi.fn(() => Promise.resolve()),
  isProcessAlive: vi.fn(() => Promise.resolve(false)),
  isWindowReady: vi.fn(() => Promise.resolve(false)),
  isClaudeProcessing: vi.fn(() => Promise.resolve(false)),
  waitForReady: vi.fn(() => Promise.resolve(true)),
  sendKeys: vi.fn(() => Promise.resolve()),
  sendTmuxKey: vi.fn(() => Promise.resolve()),
  capturePane: vi.fn(() => Promise.resolve("")),
}));

const tmuxManager = await import("../tmux-manager.js");

describe("ClaudeCodeAdapter.handleBlockingPrompts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-dismisses "Do you want to create SKILL.md?" prompt', async () => {
    const adapter = new ClaudeCodeAdapter();
    vi.mocked(tmuxManager.capturePane).mockResolvedValue(
      "Do you want to create SKILL.md?\n❯ 1. Yes\n  2. Yes, and allow Claude to edit its own settings for this session\n  3. No",
    );

    await adapter.handleBlockingPrompts("sess", "win");

    const calls = vi.mocked(tmuxManager.sendTmuxKey).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["sess", "win", "Enter"]);
  });

  it('auto-dismisses "Do you want to make this edit" prompt (regression)', async () => {
    const adapter = new ClaudeCodeAdapter();
    vi.mocked(tmuxManager.capturePane).mockResolvedValue(
      "Do you want to make this edit to file.txt?\n❯ 1. Yes\n  2. Yes, and allow Claude to edit its own settings for this session\n  3. No",
    );

    await adapter.handleBlockingPrompts("sess", "win");

    const calls = vi.mocked(tmuxManager.sendTmuxKey).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["sess", "win", "Enter"]);
  });

  it("does not fire on assistant text containing the substring without option list", async () => {
    const adapter = new ClaudeCodeAdapter();
    vi.mocked(tmuxManager.capturePane).mockResolvedValue(
      "Sure — Do you want to refactor this function next?",
    );

    await adapter.handleBlockingPrompts("sess", "win");

    expect(vi.mocked(tmuxManager.sendTmuxKey)).not.toHaveBeenCalled();
  });

  it("tolerates leading whitespace and ❯ marker variants on the option line", async () => {
    const adapter = new ClaudeCodeAdapter();
    vi.mocked(tmuxManager.capturePane).mockResolvedValue(
      "Do you want to proceed?\n   ❯  1.  Yes\n  2. No",
    );

    await adapter.handleBlockingPrompts("sess", "win");

    const calls = vi.mocked(tmuxManager.sendTmuxKey).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["sess", "win", "Enter"]);
  });

  it("does not interfere with bypass-permissions prompt", async () => {
    const adapter = new ClaudeCodeAdapter();
    vi.mocked(tmuxManager.capturePane).mockResolvedValue(
      "❯ Yes, I accept\n  Bypass Permissions\n  Do not bypass permissions",
    );

    await adapter.handleBlockingPrompts("sess", "win");

    const calls = vi.mocked(tmuxManager.sendTmuxKey).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["sess", "win", "Down"]);
    expect(calls[1]).toEqual(["sess", "win", "Enter"]);
  });
});
