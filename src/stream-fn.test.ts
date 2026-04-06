import type { Message, UserMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { deriveSessionKey, extractNewUserMessages, stripBootstrapWarnings } from "./stream-fn.js";

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
      const text = `REDACTED REDACTED REDACTED
[Bootstrap truncation warning]
Some workspace bootstrap files were truncated before injection.
Treat Project Context as partial and read the relevant files directly if details seem
missing.
- MEMORY.md: 24002 raw -> 18110 injected (~25% removed; max/file).
- If unintentional, raise agents.defaults.bootstrapMaxChars and/or
agents.defaults.bootstrapTotalMaxChars.`;

      const result = stripBootstrapWarnings(text);
      expect(result).toBe("REDACTED REDACTED REDACTED");
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
});
