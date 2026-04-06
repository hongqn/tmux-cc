import { execSync } from "node:child_process";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ensureTmuxSession,
  createWindow,
  isProcessAlive,
  windowExists,
  killWindow,
} from "./tmux-manager.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const execSyncMock = vi.mocked(execSync);

describe("tmux-manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("ensureTmuxSession", () => {
    it("does nothing if session already exists", () => {
      execSyncMock.mockReturnValue("");

      ensureTmuxSession("test-session");

      // Only has-session should be called
      expect(execSyncMock).toHaveBeenCalledTimes(1);
      expect(execSyncMock.mock.calls[0][0]).toContain("has-session");
    });

    it("creates session if it does not exist", () => {
      execSyncMock
        .mockImplementationOnce(() => {
          throw new Error("no session");
        })
        .mockReturnValue("");

      ensureTmuxSession("test-session");

      expect(execSyncMock).toHaveBeenCalledTimes(2);
      expect(execSyncMock.mock.calls[1][0]).toContain("new-session");
      expect(execSyncMock.mock.calls[1][0]).toContain("test-session");
    });
  });

  describe("createWindow", () => {
    it("creates a tmux window with claude command", () => {
      execSyncMock.mockReturnValue("");

      createWindow(
        {
          tmuxSession: "test-session",
          claudeCommand: "claude",
          workingDirectory: "/home/user/project",
        },
        {
          windowName: "cc-window1",
          model: "sonnet-4.6",
        },
      );

      // Should call has-session (or new-session) + new-window
      const newWindowCall = execSyncMock.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("new-window"),
      );
      expect(newWindowCall).toBeDefined();
      const cmd = newWindowCall![0] as string;
      expect(cmd).toContain("new-window");
      expect(cmd).toContain("cc-window1");
      expect(cmd).toContain("--dangerously-skip-permissions");
      expect(cmd).toContain("sonnet-4.6");
    });

    it("adds --resume flag when resumeSessionId is provided", () => {
      execSyncMock.mockReturnValue("");

      createWindow(
        {
          tmuxSession: "test-session",
          claudeCommand: "claude",
          workingDirectory: "/home/user/project",
        },
        {
          windowName: "cc-window1",
          model: "sonnet-4.6",
          resumeSessionId: "session-abc123",
        },
      );

      const newWindowCall = execSyncMock.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("new-window"),
      );
      const cmd = newWindowCall![0] as string;
      expect(cmd).toContain("--resume");
      expect(cmd).toContain("session-abc123");
    });
  });

  describe("isProcessAlive", () => {
    it("returns true when pane command contains claude", () => {
      execSyncMock.mockReturnValue("claude");

      expect(isProcessAlive("test-session", "cc-window1")).toBe(true);
    });

    it("returns false when pane command is something else", () => {
      execSyncMock.mockReturnValue("bash");

      expect(isProcessAlive("test-session", "cc-window1")).toBe(false);
    });

    it("returns false on error", () => {
      execSyncMock.mockImplementation(() => {
        throw new Error("window not found");
      });

      expect(isProcessAlive("test-session", "cc-window1")).toBe(false);
    });
  });

  describe("windowExists", () => {
    it("returns true when window can be selected", () => {
      execSyncMock.mockReturnValue("");
      expect(windowExists("test-session", "cc-window1")).toBe(true);
    });

    it("returns false when window cannot be selected", () => {
      execSyncMock.mockImplementation(() => {
        throw new Error("not found");
      });
      expect(windowExists("test-session", "cc-window1")).toBe(false);
    });
  });

  describe("killWindow", () => {
    it("calls tmux kill-window", () => {
      execSyncMock.mockReturnValue("");

      killWindow("test-session", "cc-window1");

      expect(execSyncMock).toHaveBeenCalledTimes(1);
      const cmd = execSyncMock.mock.calls[0][0] as string;
      expect(cmd).toContain("kill-window");
      expect(cmd).toContain("cc-window1");
    });

    it("does not throw when window already gone", () => {
      execSyncMock.mockImplementation(() => {
        throw new Error("not found");
      });

      expect(() => killWindow("test-session", "cc-window1")).not.toThrow();
    });
  });
});
