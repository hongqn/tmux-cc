import { execSync } from "node:child_process";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ensureTmuxSession,
  createWindow,
  isProcessAlive,
  windowExists,
  killWindow,
  readExitCode,
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
      expect(cmd).toContain("--permission-mode");
      expect(cmd).toContain("bypassPermissions");
      expect(cmd).not.toContain("--dangerously-skip-permissions");
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
    it("returns true when pane command contains claude and pane is alive", () => {
      execSyncMock.mockReturnValue("claude 0");

      expect(isProcessAlive("test-session", "cc-window1")).toBe(true);
    });

    it("returns false when pane command is something else", () => {
      execSyncMock.mockReturnValue("bash 0");

      expect(isProcessAlive("test-session", "cc-window1")).toBe(false);
    });

    it("returns false when pane is dead even if command is claude (remain-on-exit)", () => {
      execSyncMock.mockReturnValue("claude 1");

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

  describe("createWindow regression: no shell wrapper", () => {
    it("runs claude command directly without wrapping in bash/shell", () => {
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

      const newWindowCall = execSyncMock.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("new-window"),
      );
      const cmd = newWindowCall![0] as string;
      // The command must NOT be wrapped in bash -c, sh -c, or any shell intermediary.
      // A shell wrapper would change tmux's pane_current_command from "claude" to "bash",
      // causing isProcessAlive() to return false even while CC is running.
      expect(cmd).not.toMatch(/bash\s+-c/);
      expect(cmd).not.toMatch(/sh\s+-c/);
      expect(cmd).not.toContain("mkdir -p");
      expect(cmd).not.toContain("echo $?");
    });

    it("sets remain-on-exit after creating window", () => {
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

      const setOptionCall = execSyncMock.mock.calls.find(
        (call) =>
          typeof call[0] === "string" && call[0].includes("remain-on-exit"),
      );
      expect(setOptionCall).toBeDefined();
      expect(setOptionCall![0]).toContain("set-option");
      expect(setOptionCall![0]).toContain("remain-on-exit");
      expect(setOptionCall![0]).toContain("on");
    });
  });

  describe("readExitCode", () => {
    it("returns exit code when pane is dead", () => {
      execSyncMock
        .mockReturnValueOnce("1")   // pane_dead
        .mockReturnValueOnce("134"); // pane_dead_status

      expect(readExitCode("test-session", "cc-window1")).toBe(134);
    });

    it("returns 0 for empty status string (normal exit)", () => {
      execSyncMock
        .mockReturnValueOnce("1") // pane_dead
        .mockReturnValueOnce("");  // pane_dead_status (empty = 0)

      expect(readExitCode("test-session", "cc-window1")).toBe(0);
    });

    it("returns null when pane is still alive", () => {
      execSyncMock.mockReturnValueOnce("0"); // pane_dead

      expect(readExitCode("test-session", "cc-window1")).toBeNull();
    });

    it("returns null on error", () => {
      execSyncMock.mockImplementation(() => {
        throw new Error("window not found");
      });

      expect(readExitCode("test-session", "cc-window1")).toBeNull();
    });
  });
});
