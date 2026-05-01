import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  ensureTmuxSession,
  createWindow,
  isProcessAlive,
  windowExists,
  killWindow,
  readExitCode,
  sendKeys,
} from "./tmux-manager.js";

// Mock exec from child_process (used via promisify).
// Use callback-based error signaling (not throws) to work correctly with promisify.
const execMock = vi.hoisted(() => vi.fn<any[], any>());
const spawnMock = vi.hoisted(() => vi.fn<any[], any>());

vi.mock("node:child_process", () => ({
  exec: execMock,
  spawn: spawnMock,
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

// Helper to check what command was passed (only first arg)
function getCmds(): string[] {
  return execMock.mock.calls.map((call: any[]) => call[0] as string);
}

// Build a stub for child_process.spawn that immediately succeeds and
// records the data written to stdin so tests can assert on the payload.
function makeFakeSpawn(opts: { exitCode?: number; stderr?: string } = {}) {
  return (...args: any[]) => {
    const child: any = new EventEmitter();
    child.__args = args;
    child.__stdinChunks = [] as Array<string | Buffer>;
    child.stdin = {
      end: (chunk?: string | Buffer) => {
        if (chunk !== undefined) child.__stdinChunks.push(chunk);
      },
      write: (chunk: string | Buffer) => {
        child.__stdinChunks.push(chunk);
        return true;
      },
    };
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
      child.emit("close", opts.exitCode ?? 0);
    });
    return child;
  };
}

describe("tmux-manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execMock.mockImplementation(mockSuccess(""));
    spawnMock.mockImplementation(makeFakeSpawn());
  });

  describe("ensureTmuxSession", () => {
    it("does nothing if session already exists", async () => {
      await ensureTmuxSession("test-session");

      expect(execMock).toHaveBeenCalledTimes(1);
      expect(getCmds()[0]).toContain("has-session");
    });

    it("creates session if it does not exist", async () => {
      execMock
        .mockImplementationOnce(mockError("no session"))
        .mockImplementation(mockSuccess(""));

      await ensureTmuxSession("test-session");

      expect(execMock).toHaveBeenCalledTimes(2);
      expect(getCmds()[1]).toContain("new-session");
      expect(getCmds()[1]).toContain("test-session");
    });
  });

  describe("createWindow", () => {
    it("creates a tmux window with claude command", async () => {
      await createWindow(
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

      const cmds = getCmds();
      const newWindowCmd = cmds.find((c) => c.includes("new-window"));
      expect(newWindowCmd).toBeDefined();
      expect(newWindowCmd).toContain("cc-window1");
      expect(newWindowCmd).toContain("--dangerously-skip-permissions");
      expect(newWindowCmd).not.toContain("--permission-mode");
      expect(newWindowCmd).toContain("sonnet-4.6");
      expect(newWindowCmd).toContain("--disallowedTools");
      expect(newWindowCmd).toContain("AskUserQuestion");
      expect(newWindowCmd).toContain("RemoteTrigger");
      expect(newWindowCmd).toContain("CronCreate");
      expect(newWindowCmd).toContain("CronDelete");
      expect(newWindowCmd).toContain("CronList");
    });

    it("adds --resume flag when resumeSessionId is provided", async () => {
      await createWindow(
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

      const cmds = getCmds();
      const newWindowCmd = cmds.find((c) => c.includes("new-window"));
      expect(newWindowCmd).toContain("--resume");
      expect(newWindowCmd).toContain("session-abc123");
    });
  });

  describe("isProcessAlive", () => {
    it("returns true when pane command contains claude and pane is alive", async () => {
      execMock.mockImplementation(mockSuccess("claude 0"));
      expect(await isProcessAlive("test-session", "cc-window1")).toBe(true);
    });

    it("returns true when pane is alive even if command differs (child process)", async () => {
      execMock.mockImplementation(mockSuccess("bash 0"));
      expect(await isProcessAlive("test-session", "cc-window1")).toBe(true);
    });

    it("returns false when pane is dead even if command is claude (remain-on-exit)", async () => {
      execMock.mockImplementation(mockSuccess("claude 1"));
      expect(await isProcessAlive("test-session", "cc-window1")).toBe(false);
    });

    it("returns false when the pane shows Claude Code's unavailable banner", async () => {
      execMock.mockImplementation((cmd: string, _opts: any, callback?: Function) => {
        const cb = typeof _opts === "function" ? _opts : callback;
        if (cmd.includes("list-panes")) {
          if (cb) cb(null, { stdout: "claude 0", stderr: "" });
          return {};
        }
        if (cmd.includes("capture-pane")) {
          if (cb) cb(null, { stdout: "⚠️ Claude Code session is unavailable. Please retry.", stderr: "" });
          return {};
        }
        if (cb) cb(null, { stdout: "", stderr: "" });
        return {};
      });

      expect(await isProcessAlive("test-session", "cc-window1")).toBe(false);
    });

    it("returns false on error", async () => {
      execMock.mockImplementation(mockError("window not found"));
      expect(await isProcessAlive("test-session", "cc-window1")).toBe(false);
    });
  });

  describe("windowExists", () => {
    it("returns true when window can be selected", async () => {
      expect(await windowExists("test-session", "cc-window1")).toBe(true);
    });

    it("returns false when window cannot be selected", async () => {
      execMock.mockImplementation(mockError("not found"));
      expect(await windowExists("test-session", "cc-window1")).toBe(false);
    });
  });

  describe("killWindow", () => {
    it("calls tmux kill-window", async () => {
      await killWindow("test-session", "cc-window1");

      expect(execMock).toHaveBeenCalledTimes(1);
      expect(getCmds()[0]).toContain("kill-window");
      expect(getCmds()[0]).toContain("cc-window1");
    });

    it("does not throw when window already gone", async () => {
      execMock.mockImplementation(mockError("not found"));
      await killWindow("test-session", "cc-window1");
      // No error thrown
    });
  });

  describe("createWindow regression: no shell wrapper", () => {
    it("runs claude command directly without wrapping in bash/shell", async () => {
      await createWindow(
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

      const cmds = getCmds();
      const cmd = cmds.find((c) => c.includes("new-window"))!;
      expect(cmd).not.toMatch(/bash\s+-c/);
      expect(cmd).not.toMatch(/sh\s+-c/);
      expect(cmd).not.toContain("mkdir -p");
      expect(cmd).not.toContain("echo $?");
    });

    it("sets NODE_OPTIONS env var to limit V8 heap", async () => {
      await createWindow(
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

      const cmds = getCmds();
      const cmd = cmds.find((c) => c.includes("new-window"))!;
      expect(cmd).toContain("-e");
      expect(cmd).toContain("NODE_OPTIONS=--max-old-space-size=1024");
    });

    it("sets remain-on-exit after creating window", async () => {
      await createWindow(
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

      const cmds = getCmds();
      const cmd = cmds.find((c) => c.includes("remain-on-exit"));
      expect(cmd).toBeDefined();
      expect(cmd).toContain("set-option");
      expect(cmd).toContain("remain-on-exit");
      expect(cmd).toContain("on");
    });
  });

  describe("readExitCode", () => {
    it("returns exit code when pane is dead", async () => {
      execMock.mockImplementation(mockSuccess("1 134"));
      expect(await readExitCode("test-session", "cc-window1")).toBe(134);
    });

    it("returns 0 for empty status string (normal exit)", async () => {
      execMock.mockImplementation(mockSuccess("1 "));
      expect(await readExitCode("test-session", "cc-window1")).toBe(0);
    });

    it("returns null when pane is still alive", async () => {
      execMock.mockImplementation(mockSuccess("0 "));
      expect(await readExitCode("test-session", "cc-window1")).toBeNull();
    });

    it("returns null on error", async () => {
      execMock.mockImplementation(mockError("window not found"));
      expect(await readExitCode("test-session", "cc-window1")).toBeNull();
    });
  });

  describe("sendKeys", () => {
    // Speed up the test — sendKeys waits SEND_KEYS_DELAY_MS before pressing Enter.
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it("uses send-keys -l for small payloads", async () => {
      await sendKeys("test-session", "cc-window1", "hello world");

      const cmds = getCmds();
      expect(cmds.some((c) => c.includes("send-keys") && c.includes("-l") && c.includes("hello world"))).toBe(true);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("routes large payloads through load-buffer/paste-buffer (no E2BIG)", async () => {
      const big = "x".repeat(200_000); // larger than ARG_MAX margin
      await sendKeys("test-session", "cc-window1", big);

      // Big text must NOT appear in any exec argv (that's the bug we fixed).
      expect(getCmds().some((c) => c.includes(big))).toBe(false);

      // load-buffer was spawned with stdin = the big text.
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [bin, argv] = spawnMock.mock.calls[0];
      expect(bin).toBe("tmux");
      expect(argv).toContain("load-buffer");
      const stdin = (spawnMock.mock.results[0].value as any).__stdinChunks.join("");
      expect(stdin).toBe(big);

      // paste-buffer was issued (with -d to clean up) and final Enter sent.
      const cmds = getCmds();
      expect(cmds.some((c) => c.includes("paste-buffer") && c.includes("-d"))).toBe(true);
      expect(cmds.some((c) => c.includes("send-keys") && c.includes("Enter"))).toBe(true);
    });

    it("propagates load-buffer failures", async () => {
      spawnMock.mockImplementation(makeFakeSpawn({ exitCode: 1, stderr: "no server" }));
      const big = "y".repeat(200_000);
      await expect(sendKeys("test-session", "cc-window1", big)).rejects.toThrow(/load-buffer exited 1/);
    });
  });
});
