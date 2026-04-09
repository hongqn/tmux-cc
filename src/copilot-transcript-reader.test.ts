/**
 * Tests for the Copilot CLI transcript reader.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseEvent,
  extractSessionId,
  extractAssistantResponse,
} from "./copilot-transcript-reader.js";
import type { TranscriptEntry } from "./types.js";

describe("copilot-transcript-reader", () => {
  describe("parseEvent", () => {
    it("parses user.message events", () => {
      const event = JSON.stringify({
        type: "user.message",
        data: { content: "Hello world", sessionId: "abc-123" },
        timestamp: "2026-04-10T00:00:00.000Z",
      });
      const entry = parseEvent(event);
      expect(entry).not.toBeNull();
      expect(entry!.type).toBe("user");
      expect(entry!.message.content).toEqual([{ type: "text", text: "Hello world" }]);
      expect(entry!.sessionId).toBe("abc-123");
    });

    it("parses assistant.message with text content", () => {
      const event = JSON.stringify({
        type: "assistant.message",
        data: {
          messageId: "msg-1",
          content: "Here is the answer",
          sessionId: "abc-123",
        },
      });
      const entry = parseEvent(event);
      expect(entry).not.toBeNull();
      expect(entry!.type).toBe("assistant");
      expect(entry!.message.content).toEqual([
        { type: "text", text: "Here is the answer" },
      ]);
      expect(entry!.stop_reason).toBeUndefined();
    });

    it("parses assistant.message with tool requests", () => {
      const event = JSON.stringify({
        type: "assistant.message",
        data: {
          messageId: "msg-2",
          content: "",
          toolRequests: [
            {
              toolCallId: "tool-1",
              name: "view",
              arguments: { path: "/tmp/test.txt" },
              type: "function",
            },
            {
              toolCallId: "tool-2",
              name: "bash",
              arguments: { command: "ls" },
              type: "function",
            },
          ],
        },
      });
      const entry = parseEvent(event);
      expect(entry).not.toBeNull();
      expect(entry!.type).toBe("assistant");
      expect(entry!.message.content).toHaveLength(2);
      expect(entry!.message.content[0]).toEqual({
        type: "tool_use",
        id: "tool-1",
        name: "view",
        input: { path: "/tmp/test.txt" },
      });
      expect(entry!.message.content[1]).toEqual({
        type: "tool_use",
        id: "tool-2",
        name: "bash",
        input: { command: "ls" },
      });
      expect(entry!.stop_reason).toBe("tool_use");
    });

    it("parses assistant.message with both text and tool requests", () => {
      const event = JSON.stringify({
        type: "assistant.message",
        data: {
          messageId: "msg-3",
          content: "Let me check that file",
          toolRequests: [
            { toolCallId: "t1", name: "view", arguments: { path: "/a" } },
          ],
        },
      });
      const entry = parseEvent(event);
      expect(entry).not.toBeNull();
      expect(entry!.message.content).toHaveLength(2);
      expect(entry!.message.content[0]).toEqual({ type: "text", text: "Let me check that file" });
      expect(entry!.message.content[1].type).toBe("tool_use");
      expect(entry!.stop_reason).toBe("tool_use");
    });

    it("parses assistant.turn_end as system/turn_duration", () => {
      const event = JSON.stringify({
        type: "assistant.turn_end",
        data: { turnId: "0" },
        timestamp: "2026-04-10T00:01:00.000Z",
      });
      const entry = parseEvent(event);
      expect(entry).not.toBeNull();
      expect(entry!.type).toBe("system");
      expect(entry!.subtype).toBe("turn_duration");
    });

    it("ignores session.start events", () => {
      const event = JSON.stringify({
        type: "session.start",
        data: { sessionId: "abc-123" },
      });
      expect(parseEvent(event)).toBeNull();
    });

    it("ignores tool.execution_start events", () => {
      const event = JSON.stringify({
        type: "tool.execution_start",
        data: { toolCallId: "t1", toolName: "bash" },
      });
      expect(parseEvent(event)).toBeNull();
    });

    it("ignores hook events", () => {
      const event = JSON.stringify({
        type: "hook.start",
        data: { hookInvocationId: "h1" },
      });
      expect(parseEvent(event)).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      expect(parseEvent("not json")).toBeNull();
    });

    it("handles empty content in assistant.message", () => {
      const event = JSON.stringify({
        type: "assistant.message",
        data: { messageId: "msg-4", content: "" },
      });
      const entry = parseEvent(event);
      expect(entry).not.toBeNull();
      expect(entry!.message.content).toHaveLength(0);
    });
  });

  describe("extractSessionId", () => {
    it("extracts session ID from transcript path", () => {
      const path = "/home/user/.copilot/session-state/abc-123-def/events.jsonl";
      expect(extractSessionId(path)).toBe("abc-123-def");
    });
  });

  describe("extractAssistantResponse", () => {
    it("extracts text from last assistant entry", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { content: [{ type: "text", text: "hi" }] }, sessionId: "s1" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello!" }] },
          sessionId: "s1",
        },
        { type: "system", message: { content: [] }, sessionId: "s1", subtype: "turn_duration" },
      ];
      const result = extractAssistantResponse(entries);
      expect(result.text).toBe("Hello!");
      expect(result.isComplete).toBe(true);
    });

    it("returns incomplete when no turn_end yet", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { content: [{ type: "text", text: "hi" }] }, sessionId: "s1" },
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
            ],
          },
          sessionId: "s1",
          stop_reason: "tool_use",
        },
      ];
      const result = extractAssistantResponse(entries);
      expect(result.isComplete).toBe(false);
    });

    it("takes text from last assistant entry only", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { content: [{ type: "text", text: "hi" }] }, sessionId: "s1" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Let me check..." }] },
          sessionId: "s1",
          stop_reason: "tool_use",
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "The answer is 42." }] },
          sessionId: "s1",
        },
        { type: "system", message: { content: [] }, sessionId: "s1", subtype: "turn_duration" },
      ];
      const result = extractAssistantResponse(entries);
      expect(result.text).toBe("The answer is 42.");
      expect(result.isComplete).toBe(true);
    });

    it("collects all text with collectAllText option", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { content: [{ type: "text", text: "hi" }] }, sessionId: "s1" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Part 1" }] },
          sessionId: "s1",
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Part 2" }] },
          sessionId: "s1",
        },
        { type: "system", message: { content: [] }, sessionId: "s1", subtype: "turn_duration" },
      ];
      const result = extractAssistantResponse(entries, { collectAllText: true });
      expect(result.text).toBe("Part 1\nPart 2");
    });

    it("returns empty text when no assistant entries after user", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { content: [{ type: "text", text: "hi" }] }, sessionId: "s1" },
      ];
      const result = extractAssistantResponse(entries);
      expect(result.text).toBe("");
      expect(result.isComplete).toBe(false);
    });

    it("skips assistant entries before last user entry", () => {
      const entries: TranscriptEntry[] = [
        // Previous turn's stale response
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Old response" }] },
          sessionId: "s1",
        },
        { type: "system", message: { content: [] }, sessionId: "s1", subtype: "turn_duration" },
        // Current turn
        { type: "user", message: { content: [{ type: "text", text: "new question" }] }, sessionId: "s1" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "New response" }] },
          sessionId: "s1",
        },
        { type: "system", message: { content: [] }, sessionId: "s1", subtype: "turn_duration" },
      ];
      const result = extractAssistantResponse(entries);
      expect(result.text).toBe("New response");
    });
  });
});
