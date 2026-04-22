import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock homedir so we don't write to real ~/.openclaw/
const mockHomeDir = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  return mkdtempSync(join(tmpdir(), "tmux-cc-persist-test-"));
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockHomeDir,
  };
});

import {
  loadPersistedSessions,
  persistSession,
  removePersistedSession,
  getPersistedClaudeSessionId,
} from "./session-persistence.js";

describe("session-persistence", () => {
  const persistDir = join(mockHomeDir, ".openclaw");
  const persistPath = join(persistDir, "tmux-cc-sessions.json");

  beforeEach(() => {
    // Ensure clean state
    try {
      rmSync(persistPath);
    } catch {
      // OK if doesn't exist
    }
  });

  afterEach(() => {
    try {
      rmSync(persistPath);
    } catch {
      // OK
    }
  });

  it("persists and retrieves a session", () => {
    persistSession("key-1", "claude-session-abc", "sonnet-4.6", "claude-code");

    const id = getPersistedClaudeSessionId("key-1", "claude-code");
    expect(id).toBe("claude-session-abc");
  });

  it("returns undefined for unknown session key", () => {
    const id = getPersistedClaudeSessionId("nonexistent", "claude-code");
    expect(id).toBeUndefined();
  });

  it("loads all persisted sessions", () => {
    persistSession("key-1", "session-1", "sonnet-4.6", "claude-code");
    persistSession("key-2", "session-2", "opus-4.6", "claude-code");

    const sessions = loadPersistedSessions();
    expect(sessions.size).toBe(2);
  });

  it("scopes persistence by adapter — Copilot and CC IDs don't cross", () => {
    // The bug this prevents: mid-stream rate-limit fallback was feeding
    // Copilot's session id to the CC adapter's --resume, killing the
    // process on startup because the id doesn't exist in ~/.claude/projects/.
    persistSession("key-1", "copilot-id", "claude-opus-4.6", "copilot-cli");
    persistSession("key-1", "cc-id", "opus-4.6", "claude-code");

    expect(getPersistedClaudeSessionId("key-1", "copilot-cli")).toBe("copilot-id");
    expect(getPersistedClaudeSessionId("key-1", "claude-code")).toBe("cc-id");
  });

  it("removes a persisted session (specific adapter)", () => {
    persistSession("key-1", "session-1", "sonnet-4.6", "claude-code");
    removePersistedSession("key-1", "claude-code");

    const id = getPersistedClaudeSessionId("key-1", "claude-code");
    expect(id).toBeUndefined();
  });

  it("removes all adapter entries when no adapter id is passed (used by before_reset)", () => {
    persistSession("key-1", "copilot-id", "claude-opus-4.6", "copilot-cli");
    persistSession("key-1", "cc-id", "opus-4.6", "claude-code");
    removePersistedSession("key-1");

    expect(getPersistedClaudeSessionId("key-1", "copilot-cli")).toBeUndefined();
    expect(getPersistedClaudeSessionId("key-1", "claude-code")).toBeUndefined();
  });

  it("upserts existing session entries", () => {
    persistSession("key-1", "old-id", "sonnet-4.6", "claude-code");
    persistSession("key-1", "new-id", "opus-4.6", "claude-code");

    const id = getPersistedClaudeSessionId("key-1", "claude-code");
    expect(id).toBe("new-id");
  });

  it("prunes stale entries older than 7 days on load", () => {
    // Write a stale entry directly
    mkdirSync(persistDir, { recursive: true });
    const staleData = {
      sessions: {
        "stale-key": {
          claudeSessionId: "stale-session",
          model: "sonnet-4.6",
          lastActivityMs: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
        },
        "fresh-key": {
          claudeSessionId: "fresh-session",
          model: "sonnet-4.6",
          lastActivityMs: Date.now(),
        },
      },
    };
    writeFileSync(persistPath, JSON.stringify(staleData));

    const sessions = loadPersistedSessions();
    expect(sessions.size).toBe(1);
    expect(sessions.has("stale-key")).toBe(false);
    expect(sessions.get("fresh-key")?.claudeSessionId).toBe("fresh-session");

    // Verify stale entry was removed from disk too
    const onDisk = JSON.parse(readFileSync(persistPath, "utf-8"));
    expect(onDisk.sessions["stale-key"]).toBeUndefined();
    expect(onDisk.sessions["fresh-key"]).toBeDefined();
  });

  it("handles corrupt JSON gracefully", () => {
    mkdirSync(persistDir, { recursive: true });
    writeFileSync(persistPath, "not-json{{{");

    const sessions = loadPersistedSessions();
    expect(sessions.size).toBe(0);

    // Should still be able to persist new sessions
    persistSession("key-1", "session-1", "sonnet-4.6", "claude-code");
    expect(getPersistedClaudeSessionId("key-1", "claude-code")).toBe("session-1");
  });

  it("handles missing file gracefully", () => {
    const sessions = loadPersistedSessions();
    expect(sessions.size).toBe(0);
  });

  it("removes non-existent key without error", () => {
    expect(() => removePersistedSession("nonexistent")).not.toThrow();
  });
});
