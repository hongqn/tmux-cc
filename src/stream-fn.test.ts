import type { Message, UserMessage } from "@mariozechner/pi-ai";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveSessionKey,
  extractNewUserMessages,
  extractSteeringText,
  extractUnstreamedFinalText,
  stripBootstrapWarnings,
  transcriptContainsUserText,
  updateTranscriptPath,
} from "./stream-fn.js";
import { isEphemeralSessionKeyName } from "./session-map.js";
import { removePersistedSession } from "./session-persistence.js";
import { getProjectDir } from "./transcript-reader.js";
import type { SessionState, TranscriptEntry } from "./types.js";

describe("stream-fn", () => {
  describe("deriveSessionKey", () => {
    it("produces a stable key for the same first user message", () => {
      const messages: Message[] = [{ role: "user", content: "Hello, Claude!", timestamp: 1000 }];
      const key1 = deriveSessionKey(messages);
      const key2 = deriveSessionKey(messages);
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^tmux-[0-9a-f]{16}$/);
    });

    it("produces different keys for different first messages", () => {
      const msgs1: Message[] = [{ role: "user", content: "Hello", timestamp: 1000 }];
      const msgs2: Message[] = [{ role: "user", content: "Goodbye", timestamp: 1000 }];
      expect(deriveSessionKey(msgs1)).not.toBe(deriveSessionKey(msgs2));
    });

    it("uses the FIRST user message, ignoring later messages", () => {
      const msgs1: Message[] = [{ role: "user", content: "Hello", timestamp: 1000 }];
      const msgs2: Message[] = [
        { role: "user", content: "Hello", timestamp: 1000 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          api: "anthropic-v1",
          provider: "test",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2000,
        },
        { role: "user", content: "Follow up", timestamp: 3000 },
      ];
      expect(deriveSessionKey(msgs1)).toBe(deriveSessionKey(msgs2));
    });

    it("handles structured content", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", data: "base64", mimeType: "image/png" } as never,
          ],
          timestamp: 1000,
        } as UserMessage,
      ];
      const key = deriveSessionKey(messages);
      expect(key).toMatch(/^tmux-[0-9a-f]{16}$/);
    });

    it("generates a random key when no user messages", () => {
      const key = deriveSessionKey([]);
      expect(key).toMatch(/^tmux-[0-9a-f-]{12}$/);
    });

    it("prefers sessionId from options when provided", () => {
      const messages: Message[] = [{ role: "user", content: "Hello", timestamp: 1000 }];
      const key = deriveSessionKey(messages, "session-abc-123");
      expect(key).toMatch(/^tmux-[0-9a-f]{16}$/);
      // Same sessionId should produce stable key
      expect(deriveSessionKey(messages, "session-abc-123")).toBe(key);
    });

    it("different sessionIds produce different keys", () => {
      const messages: Message[] = [{ role: "user", content: "Hello", timestamp: 1000 }];
      const key1 = deriveSessionKey(messages, "session-group-1");
      const key2 = deriveSessionKey(messages, "session-group-2");
      expect(key1).not.toBe(key2);
    });

    it("same message in different sessions gets different keys", () => {
      const messages: Message[] = [{ role: "user", content: "Hello", timestamp: 1000 }];
      const keyWithSession = deriveSessionKey(messages, "session-group-1");
      const keyWithoutSession = deriveSessionKey(messages);
      // With sessionId, key is derived from sessionId, not message content
      expect(keyWithSession).not.toBe(keyWithoutSession);
    });

    it("falls back to first message hash when sessionId is undefined", () => {
      const messages: Message[] = [{ role: "user", content: "Hello", timestamp: 1000 }];
      const key1 = deriveSessionKey(messages, undefined);
      const key2 = deriveSessionKey(messages);
      expect(key1).toBe(key2);
    });
  });

  describe("extractNewUserMessages", () => {
    it("extracts the last user message when no assistant message exists", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: "Hello!",
          timestamp: 1000,
        },
      ];

      expect(extractNewUserMessages(messages)).toBe("Hello!");
    });

    it("extracts user message after last assistant message", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: "First message",
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Response" }],
          api: "anthropic-v1",
          provider: "test",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 2000,
        },
        {
          role: "user",
          content: "Follow up",
          timestamp: 3000,
        },
      ];

      expect(extractNewUserMessages(messages)).toBe("Follow up");
    });

    it("concatenates multiple user messages after last assistant", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [{ type: "text", text: "Response" }],
          api: "anthropic-v1",
          provider: "test",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 1000,
        },
        {
          role: "user",
          content: "Message 1",
          timestamp: 2000,
        },
        {
          role: "user",
          content: "Message 2",
          timestamp: 3000,
        },
      ];

      expect(extractNewUserMessages(messages)).toBe("Message 1\n\nMessage 2");
    });

    it("handles structured content with TextContent", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this:" },
            { type: "text", text: "More text" },
          ],
          timestamp: 1000,
        },
      ];

      expect(extractNewUserMessages(messages)).toBe("Look at this:\nMore text");
    });

    it("extracts text from mixed content (text + image)", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            {
              type: "image",
              data: "base64data",
              mimeType: "image/jpeg",
            },
          ],
          timestamp: 1000,
        } as UserMessage,
      ];

      expect(extractNewUserMessages(messages)).toBe("What's in this image?");
    });

    it("returns null for empty messages", () => {
      expect(extractNewUserMessages([])).toBeNull();
    });

    it("returns null when no user messages after assistant", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: "Hello",
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          api: "anthropic-v1",
          provider: "test",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 2000,
        },
      ];

      expect(extractNewUserMessages(messages)).toBeNull();
    });

    it("skips ToolResultMessage between user messages", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [{ type: "text", text: "Response" }],
          api: "anthropic-v1",
          provider: "test",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 1000,
        },
        {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "test",
          content: [{ type: "text", text: "result" }],
          isError: false,
          timestamp: 2000,
        },
        {
          role: "user",
          content: "After tool result",
          timestamp: 3000,
        },
      ];

      expect(extractNewUserMessages(messages)).toBe("After tool result");
    });
  });

  describe("stripBootstrapWarnings", () => {
    it("strips bootstrap truncation warning from text", () => {
      const text = `Should I buy more today?
[Bootstrap truncation warning]
Some workspace bootstrap files were truncated before injection.
Treat Project Context as partial and read the relevant files directly if details seem
missing.
- MEMORY.md: 24002 raw -> 18110 injected (~25% removed; max/file).
- If unintentional, raise agents.defaults.bootstrapMaxChars and/or
agents.defaults.bootstrapTotalMaxChars.`;

      const result = stripBootstrapWarnings(text);
      expect(result).toBe("Should I buy more today?");
    });

    it("returns text unchanged when no warning present", () => {
      const text = "Hello, world!";
      expect(stripBootstrapWarnings(text)).toBe(text);
    });

    it("handles text with only the warning", () => {
      const text = `[Bootstrap truncation warning]
Some workspace bootstrap files were truncated before injection.
Treat Project Context as partial and read the relevant files directly if details seem
missing.
- MEMORY.md: 24002 raw -> 18110 injected (~25% removed; max/file).
- If unintentional, raise agents.defaults.bootstrapMaxChars and/or
agents.defaults.bootstrapTotalMaxChars.`;

      const result = stripBootstrapWarnings(text);
      expect(result).toBe("");
    });
  });

  describe("extractSteeringText", () => {
    it("extracts plain string content", () => {
      expect(extractSteeringText({ content: "hello" })).toBe("hello");
    });

    it("extracts text from content blocks array", () => {
      expect(extractSteeringText({
        content: [
          { type: "text", text: "part1" },
          { type: "text", text: " part2" },
        ],
      })).toBe("part1 part2");
    });

    it("skips non-text blocks in content array", () => {
      expect(extractSteeringText({
        content: [
          { type: "image", url: "http://example.com" },
          { type: "text", text: "only text" },
        ],
      })).toBe("only text");
    });

    it("returns null for empty content array", () => {
      expect(extractSteeringText({ content: [] })).toBeNull();
    });

    it("returns null for array with no text blocks", () => {
      expect(extractSteeringText({
        content: [{ type: "image", url: "http://example.com" }],
      })).toBeNull();
    });

    it("returns null for null input", () => {
      expect(extractSteeringText(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(extractSteeringText(undefined)).toBeNull();
    });

    it("returns null for non-object input", () => {
      expect(extractSteeringText("just a string")).toBeNull();
    });

    it("returns null for object without content", () => {
      expect(extractSteeringText({ role: "user" })).toBeNull();
    });
  });

  describe("extractUnstreamedFinalText", () => {
    it("drops final text that was already emitted as a progressive text block", () => {
      const productionSample = "Notification sent, timestamp updated.\n\n**Email summary:**\n- Category A: task assignments, service notifications, security updates\n- Category B: promotional offers\n- No billing emails";

      expect(extractUnstreamedFinalText(productionSample, [productionSample])).toBe("");
    });

    it("returns only the suffix when progressive blocks are a prefix of final text", () => {
      expect(extractUnstreamedFinalText("part 1\npart 2\nfinal", ["part 1", "part 2"])).toBe("final");
    });

    it("drops final text that matches the last progressive block after earlier commentary", () => {
      expect(extractUnstreamedFinalText("final answer", ["checking files", "final answer"])).toBe("");
    });

    it("keeps final text when no progressive text was emitted", () => {
      expect(extractUnstreamedFinalText("final only", [])).toBe("final only");
    });

    it("keeps final text when progressive text does not match the final response prefix", () => {
      expect(extractUnstreamedFinalText("final answer", ["tool progress"])).toBe("final answer");
    });
  });

  describe("transcriptContainsUserText", () => {
    it("matches the accepted user turn exactly", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { content: [{ type: "text", text: "cron payload" }] }, sessionId: "s1" },
      ];

      expect(transcriptContainsUserText(entries, "cron payload")).toBe(true);
    });

    it("matches when an adapter appends a suffix to the submitted text", () => {
      const entries: TranscriptEntry[] = [
        {
          type: "user",
          message: { content: [{ type: "text", text: "cron payload\n\nkeep this session open" }] },
          sessionId: "s1",
        },
      ];

      expect(transcriptContainsUserText(entries, "cron payload")).toBe(true);
    });

    it("matches long media turns when Claude normalizes whitespace and drops wrapper text", () => {
      const expected = [
        "Please grade this paper.",
        "<file>",
        "Question 1:     The candidate answered 15.",
        "Question 2: The working spans multiple lines with repeated margin text.",
        "DO NOT WRITE IN THIS MARGIN DO NOT WRITE IN THIS MARGIN",
        "Question 3: The final answer is 3240.1 after compounding.",
        "</file>",
        "OpenClaw routing metadata and attachment instructions omitted by Claude Code.",
      ].join("\n\n");
      const acceptedByClaude = [
        "Please grade this paper. <file>",
        "Question 1: The candidate answered 15.",
        "Question 2: The working spans multiple lines with repeated margin text.",
        "DO NOT WRITE IN THIS MARGIN",
        "Question 3: The final answer is 3240.1 after compounding.",
        "</file>",
      ].join(" ");
      const entries: TranscriptEntry[] = [
        { type: "user", message: { content: [{ type: "text", text: acceptedByClaude }] }, sessionId: "s1" },
      ];

      expect(transcriptContainsUserText(entries, expected)).toBe(true);
    });

    it("does not fuzzy-match unrelated long user turns", () => {
      const expected = "alpha ".repeat(80) + "expected payload marker";
      const unrelated = "beta ".repeat(80) + "different payload marker";
      const entries: TranscriptEntry[] = [
        { type: "user", message: { content: [{ type: "text", text: unrelated }] }, sessionId: "s1" },
      ];

      expect(transcriptContainsUserText(entries, expected)).toBe(false);
    });

    it("does not match assistant-only activity", () => {
      const entries: TranscriptEntry[] = [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "cron payload" }] },
          sessionId: "s1",
          stop_reason: "end_turn",
        },
      ];

      expect(transcriptContainsUserText(entries, "cron payload")).toBe(false);
    });
  });

  describe("ephemeral sessionKeyName <-> deriveSessionKey integration", () => {
    it("ephemeral helper agrees with documented kinds", () => {
      expect(isEphemeralSessionKeyName("agent:main:cron:job-1")).toBe(true);
      expect(isEphemeralSessionKeyName("agent:horo:telegram:btw:42")).toBe(true);
      expect(isEphemeralSessionKeyName("agent:horo:telegram:chat:-100")).toBe(false);
      expect(isEphemeralSessionKeyName("agent:main:main")).toBe(false);
    });

    it("deriveSessionKey with sessionId fallback is stable across calls (retry safety)", () => {
      const messages: Message[] = [{ role: "user", content: "run cron task", timestamp: 1000 }];
      const sessionId = "cron-run-uuid-abc";
      const k1 = deriveSessionKey(messages, sessionId);
      const k2 = deriveSessionKey(messages, sessionId);
      expect(k1).toBe(k2);
    });

    it("deriveSessionKey with different sessionId fallback yields different keys (fresh-per-run)", () => {
      const messages: Message[] = [{ role: "user", content: "run cron task", timestamp: 1000 }];
      expect(deriveSessionKey(messages, "cron-run-1")).not.toBe(deriveSessionKey(messages, "cron-run-2"));
    });
  });

  describe("updateTranscriptPath: spawn-with-resume fork (HQN-18)", () => {
    let uniqueCwd: string;
    let projectDir: string;
    const sessionKey = `tmux-test-${randomUUID()}`;

    beforeEach(() => {
      uniqueCwd = `/tmp/tmux-test-resume-${randomUUID()}`;
      projectDir = getProjectDir(uniqueCwd);
      mkdirSync(projectDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
      removePersistedSession(sessionKey, "claude-code");
    });

    function makeState(claudeSessionId: string, snapshot: Map<string, number>): SessionState {
      return {
        sessionKey,
        windowName: "cc-test-window",
        transcriptOffset: 0,
        lastActivityMs: Date.now(),
        model: "sonnet-4.6",
        turnCount: 0,
        existingTranscriptPaths: snapshot,
        claudeSessionId,
      };
    }

    it("prefers the brand-new <newId>.jsonl over the persisted <oldId>.jsonl after `claude --resume`", () => {
      const oldId = "old-session-aaaaaaaaaaaa";
      const newId = "new-session-bbbbbbbbbbbb";
      const oldPath = join(projectDir, `${oldId}.jsonl`);
      const newPath = join(projectDir, `${newId}.jsonl`);

      writeFileSync(oldPath, "old content".repeat(100));
      const snapshot = new Map<string, number>([[oldPath, 1100]]);

      // Simulate the persistedId file growing slightly while CC re-reads it.
      writeFileSync(oldPath, "old content".repeat(100) + "x");

      // CC has now created its new fork file.
      writeFileSync(newPath, "");

      const state = makeState(oldId, snapshot);
      updateTranscriptPath(state, uniqueCwd);

      expect(state.transcriptPath).toBe(newPath);
      expect(state.transcriptOffset).toBe(0);
      expect(state.claudeSessionId).toBe(newId);
      expect(state.existingTranscriptPaths).toBeUndefined();
    });

    it("tentatively uses <id>.jsonl with snapshot offset when no fork has appeared yet, KEEPING the snapshot", () => {
      const oldId = "old-session-cccccccccccc";
      const oldPath = join(projectDir, `${oldId}.jsonl`);
      writeFileSync(oldPath, "old content");
      const snapshot = new Map<string, number>([[oldPath, 11]]);

      // CC re-reads <oldId>.jsonl and grows it slightly. No fork yet.
      writeFileSync(oldPath, "old content + replay");

      const state = makeState(oldId, snapshot);
      updateTranscriptPath(state, uniqueCwd);

      // Tentatively pick the persistedId file with snapshot offset.
      expect(state.transcriptPath).toBe(oldPath);
      expect(state.transcriptOffset).toBe(11);
      expect(state.claudeSessionId).toBe(oldId);
      // Snapshot MUST be retained so a fork can still be detected on the next call.
      expect(state.existingTranscriptPaths).toBe(snapshot);
    });

    it("switches from tentative <id>.jsonl to a fork that appears on a later call", () => {
      const oldId = "old-session-eeeeeeeeeeee";
      const newId = "new-session-ffffffffffff";
      const oldPath = join(projectDir, `${oldId}.jsonl`);
      const newPath = join(projectDir, `${newId}.jsonl`);

      writeFileSync(oldPath, "old content");
      const snapshot = new Map<string, number>([[oldPath, 11]]);

      const state = makeState(oldId, snapshot);

      // First call: no fork yet → tentative pick.
      updateTranscriptPath(state, uniqueCwd);
      expect(state.transcriptPath).toBe(oldPath);
      expect(state.existingTranscriptPaths).toBe(snapshot);

      // Fork appears.
      writeFileSync(newPath, "");

      // Second call: must switch.
      updateTranscriptPath(state, uniqueCwd);
      expect(state.transcriptPath).toBe(newPath);
      expect(state.transcriptOffset).toBe(0);
      expect(state.claudeSessionId).toBe(newId);
      expect(state.existingTranscriptPaths).toBeUndefined();
    });

    it("uses claudeSessionId directly when no snapshot is set (post-discovery state)", () => {
      const sid = "live-session-dddddddddddd";
      const path = join(projectDir, `${sid}.jsonl`);
      writeFileSync(path, "live content");

      const state: SessionState = {
        sessionKey,
        windowName: "cc-test-window",
        transcriptOffset: 0,
        lastActivityMs: Date.now(),
        model: "sonnet-4.6",
        turnCount: 0,
        claudeSessionId: sid,
      };
      updateTranscriptPath(state, uniqueCwd);

      expect(state.transcriptPath).toBe(path);
      expect(state.claudeSessionId).toBe(sid);
    });
  });
});
