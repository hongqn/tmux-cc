import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  matchCompactSummary,
  stashPendingRotation,
  consumePendingRotation,
  hasPendingRotation,
  clearAllPendingRotations,
  buildRotationPrefix,
  performRotationIfPending,
  type RotationExecutionDeps,
} from "./rotation.js";

const SUMMARY_PREFIX =
  "This session is being continued from a previous conversation that ran out of context. " +
  "The summary below covers the earlier portion of the conversation.";

function makeCompactLine(content: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    isCompactSummary: true,
    message: { role: "user", content },
    parentUuid: "abc",
    sessionId: "sess-old",
    timestamp: "2026-04-24T12:00:00.000Z",
    ...overrides,
  });
}

describe("matchCompactSummary", () => {
  it("returns the summary string for a valid CC compact entry", () => {
    const line = makeCompactLine(`${SUMMARY_PREFIX}\n\nSummary:\n1. Did stuff.`);
    const m = matchCompactSummary(line);
    expect(m).not.toBeNull();
    expect(m!.summary.startsWith(SUMMARY_PREFIX)).toBe(true);
  });

  it("returns null for a regular user message", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: "hello" },
      sessionId: "s",
    });
    expect(matchCompactSummary(line)).toBeNull();
  });

  it("returns null for an assistant entry even with the flag", () => {
    const line = JSON.stringify({
      type: "assistant",
      isCompactSummary: true,
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      sessionId: "s",
    });
    expect(matchCompactSummary(line)).toBeNull();
  });

  it("returns null for malformed JSON without throwing", () => {
    expect(matchCompactSummary("not json{")).toBeNull();
    expect(matchCompactSummary("")).toBeNull();
  });

  it("returns null when isCompactSummary is true but content is empty", () => {
    expect(matchCompactSummary(makeCompactLine(""))).toBeNull();
    expect(matchCompactSummary(makeCompactLine("   "))).toBeNull();
  });

  it("handles future block-array content as a fallback", () => {
    const line = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: {
        role: "user",
        content: [{ type: "text", text: `${SUMMARY_PREFIX}\n\nSummary: x` }],
      },
      sessionId: "s",
    });
    const m = matchCompactSummary(line);
    expect(m).not.toBeNull();
    expect(m!.summary).toContain(SUMMARY_PREFIX);
  });
});

describe("pending rotation stash", () => {
  beforeEach(() => {
    clearAllPendingRotations();
  });

  it("stash → has → consume → has=false", () => {
    expect(hasPendingRotation("agent:k:main")).toBe(false);
    stashPendingRotation("agent:k:main", {
      summary: "s",
      detectedAt: Date.now(),
      oldClaudeSessionId: "old",
    });
    expect(hasPendingRotation("agent:k:main")).toBe(true);
    const p = consumePendingRotation("agent:k:main");
    expect(p?.summary).toBe("s");
    expect(p?.oldClaudeSessionId).toBe("old");
    expect(hasPendingRotation("agent:k:main")).toBe(false);
  });

  it("consume without stash returns undefined", () => {
    expect(consumePendingRotation("nope")).toBeUndefined();
  });

  it("double stash overwrites — last compact wins", () => {
    stashPendingRotation("agent:k:main", { summary: "first", detectedAt: Date.now() });
    stashPendingRotation("agent:k:main", { summary: "second", detectedAt: Date.now() });
    expect(consumePendingRotation("agent:k:main")?.summary).toBe("second");
  });

  it("ignores empty sessionKeyName arguments", () => {
    stashPendingRotation("", { summary: "x", detectedAt: Date.now() });
    expect(hasPendingRotation("")).toBe(false);
    expect(hasPendingRotation(null)).toBe(false);
    expect(hasPendingRotation(undefined)).toBe(false);
    expect(consumePendingRotation(null)).toBeUndefined();
  });

  it("expires after TTL and consume returns undefined", () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-04-24T12:00:00.000Z").getTime();
      vi.setSystemTime(t0);
      stashPendingRotation("agent:k:main", { summary: "s", detectedAt: t0 });
      expect(hasPendingRotation("agent:k:main")).toBe(true);

      // Advance 60min + 1s — past TTL.
      vi.setSystemTime(t0 + 60 * 60 * 1000 + 1000);
      expect(hasPendingRotation("agent:k:main")).toBe(false);
      expect(consumePendingRotation("agent:k:main")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildRotationPrefix", () => {
  it("joins summary and message with a separator", () => {
    const out = buildRotationPrefix("SUMMARY", "hello");
    expect(out).toBe("SUMMARY\n\n---\n\nhello");
  });

  it("trims trailing whitespace from summary", () => {
    expect(buildRotationPrefix("S\n\n", "u")).toBe("S\n\n---\n\nu");
  });
});

describe("performRotationIfPending", () => {
  function makeDeps(overrides: Partial<RotationExecutionDeps> = {}): {
    deps: RotationExecutionDeps;
    spies: {
      getStableSessionKey: ReturnType<typeof vi.fn>;
      deleteSession: ReturnType<typeof vi.fn>;
      removePersistedSession: ReturnType<typeof vi.fn>;
      removeStableSessionKeysFor: ReturnType<typeof vi.fn>;
    };
  } {
    const spies = {
      getStableSessionKey: vi.fn().mockReturnValue("tmux-old-key"),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      removePersistedSession: vi.fn(),
      removeStableSessionKeysFor: vi.fn(),
    };
    const deps: RotationExecutionDeps = {
      getStableSessionKey: spies.getStableSessionKey,
      deleteSession: spies.deleteSession,
      removePersistedSession: spies.removePersistedSession,
      removeStableSessionKeysFor: spies.removeStableSessionKeysFor,
      ...overrides,
    };
    return { deps, spies };
  }

  beforeEach(() => clearAllPendingRotations());

  it("returns null and does nothing when sessionKeyName is empty", async () => {
    const { deps, spies } = makeDeps();
    const result = await performRotationIfPending(undefined, false, deps);
    expect(result).toBeNull();
    expect(spies.deleteSession).not.toHaveBeenCalled();
  });

  it("returns null and does nothing for ephemeral sessions", async () => {
    const { deps, spies } = makeDeps();
    stashPendingRotation("agent:cron:once", { summary: "S", detectedAt: Date.now() });
    const result = await performRotationIfPending("agent:cron:once", true, deps);
    expect(result).toBeNull();
    expect(spies.deleteSession).not.toHaveBeenCalled();
    // ephemeral early-return must NOT consume the stash (defensive: ephemeral
    // sessions should never have one stashed in the first place, but if they
    // somehow do we don't want to silently drop it on the floor either).
    expect(hasPendingRotation("agent:cron:once")).toBe(true);
  });

  it("returns null when no rotation is pending", async () => {
    const { deps, spies } = makeDeps();
    const result = await performRotationIfPending("agent:horo:main", false, deps);
    expect(result).toBeNull();
    expect(spies.deleteSession).not.toHaveBeenCalled();
  });

  it("happy path: consumes stash, tears down old window, returns summary", async () => {
    const { deps, spies } = makeDeps();
    stashPendingRotation("agent:horo:main", {
      summary: "the summary",
      oldClaudeSessionId: "claude-old-uuid",
      detectedAt: Date.now(),
    });
    const result = await performRotationIfPending("agent:horo:main", false, deps);
    expect(result).toBe("the summary");
    expect(spies.getStableSessionKey).toHaveBeenCalledWith("agent:horo:main");
    expect(spies.deleteSession).toHaveBeenCalledWith("tmux-old-key");
    expect(spies.removePersistedSession).toHaveBeenCalledWith("tmux-old-key");
    expect(spies.removeStableSessionKeysFor).toHaveBeenCalledWith("tmux-old-key");
    // stash is consumed
    expect(hasPendingRotation("agent:horo:main")).toBe(false);
  });

  it("skips teardown when no oldSessionKey resolves but still returns summary", async () => {
    const { deps, spies } = makeDeps({
      getStableSessionKey: vi.fn().mockReturnValue(undefined),
    });
    stashPendingRotation("agent:horo:main", { summary: "S", detectedAt: Date.now() });
    const result = await performRotationIfPending("agent:horo:main", false, deps);
    expect(result).toBe("S");
    expect(spies.deleteSession).not.toHaveBeenCalled();
    expect(spies.removePersistedSession).not.toHaveBeenCalled();
    expect(spies.removeStableSessionKeysFor).not.toHaveBeenCalled();
  });

  it("fail-safe: deleteSession throws → still returns summary + still cleans persisted/stable keys", async () => {
    const { deps, spies } = makeDeps({
      deleteSession: vi.fn().mockRejectedValue(new Error("tmux exploded")),
    });
    stashPendingRotation("agent:horo:main", { summary: "S", detectedAt: Date.now() });
    const result = await performRotationIfPending("agent:horo:main", false, deps);
    expect(result).toBe("S");
    expect(spies.removePersistedSession).toHaveBeenCalledWith("tmux-old-key");
    expect(spies.removeStableSessionKeysFor).toHaveBeenCalledWith("tmux-old-key");
  });

  it("fail-safe: removePersistedSession throws → still returns summary + still calls removeStableSessionKeysFor", async () => {
    const { deps, spies } = makeDeps({
      removePersistedSession: vi.fn(() => {
        throw new Error("disk error");
      }),
    });
    stashPendingRotation("agent:horo:main", { summary: "S", detectedAt: Date.now() });
    const result = await performRotationIfPending("agent:horo:main", false, deps);
    expect(result).toBe("S");
    expect(spies.removeStableSessionKeysFor).toHaveBeenCalledWith("tmux-old-key");
  });
});
