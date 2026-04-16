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

    it("parses session.error (rate_limit) as a completed assistant entry with error text", () => {
      // Real Copilot rate-limit events from events.jsonl REDACTED the agent
      // never writes assistant.message, only turn_start/turn_end +
      // session.error. Without this mapping the poller would hang
      // on an empty turn and the rate-limit cooldown would never fire.
      const event = JSON.stringify({
        type: "session.error",
        data: {
          errorType: "rate_limit",
          message:
            "Sorry, you've hit a rate limit that restricts the number of Copilot model requests you can make within a specific time period.",
          sessionId: "abc-123",
        },
        timestamp: "2026-04-10T00:02:00.000Z",
      });
      const entry = parseEvent(event);
      expect(entry).not.toBeNull();
      expect(entry!.type).toBe("assistant");
      // stop_reason must NOT be "tool_use" so extractAssistantResponse
      // treats it as complete.
      expect(entry!.stop_reason).toBe("end_turn");
      const textBlock = entry!.message.content[0];
      expect(textBlock.type).toBe("text");
      expect((textBlock as { type: "text"; text: string }).text).toContain("rate_limit");
      expect((textBlock as { type: "text"; text: string }).text).toContain("rate limit");
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

    it("handles real Copilot events.jsonl user.message with transformedContent", () => {
      // Real event from Copilot CLI v1.0.23
      const event = JSON.stringify({
        type: "user.message",
        data: {
          content: "say hello",
          transformedContent: "<current_datetime>2026-04-12T02:30:56.118Z</current_datetime>\n\nsay hello\n\n<reminder>...</reminder>",
          attachments: [],
          agentMode: "autopilot",
          interactionId: "f416a16c-f5ee-40fe-962f-b9367b1b65d0",
        },
        id: "55120dbb-ae44-40ff-87d4-d5ec91a4b99b",
        timestamp: "2026-04-12T02:30:56.118Z",
      });
      const entry = parseEvent(event);
      expect(entry).not.toBeNull();
      expect(entry!.type).toBe("user");
      // Should use original content, not transformedContent
      expect(entry!.message.content).toEqual([{ type: "text", text: "say hello" }]);
    });

    it("handles real Copilot task_complete tool request", () => {
      const event = JSON.stringify({
        type: "assistant.message",
        data: {
          messageId: "54a4cdd2-1244-4d29-8a10-50d5ac10f28d",
          content: "",
          toolRequests: [{
            toolCallId: "call_b46dhJ8BpqqRVSIX9QESRRKK",
            name: "task_complete",
            arguments: { summary: "Greeted the user." },
            type: "function",
            toolTitle: "Task complete",
          }],
        },
      });
      const entry = parseEvent(event);
      expect(entry).not.toBeNull();
      expect(entry!.type).toBe("assistant");
      expect(entry!.message.content).toHaveLength(1);
      expect(entry!.message.content[0]).toEqual({
        type: "tool_use",
        id: "call_b46dhJ8BpqqRVSIX9QESRRKK",
        name: "task_complete",
        input: { summary: "Greeted the user." },
      });
      expect(entry!.stop_reason).toBe("tool_use");
    });

    it("ignores session.mode_changed events", () => {
      const event = JSON.stringify({
        type: "session.mode_changed",
        data: { previousMode: "interactive", newMode: "autopilot" },
      });
      expect(parseEvent(event)).toBeNull();
    });

    it("ignores session.model_change events", () => {
      const event = JSON.stringify({
        type: "session.model_change",
        data: { previousModel: "gpt-4.1", newModel: "gpt-5.1" },
      });
      expect(parseEvent(event)).toBeNull();
    });

    it("ignores session.shutdown events", () => {
      const event = JSON.stringify({
        type: "session.shutdown",
        data: { shutdownType: "routine" },
      });
      expect(parseEvent(event)).toBeNull();
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

    it("handles real Copilot multi-turn with tool use and continuation", () => {
      // Simulates a real Copilot autopilot session:
      // 1. User asks to list files
      // 2. Assistant calls "view" tool (no text)
      // 3. Turn ends, continuation turn starts
      // 4. Assistant responds with text
      // 5. Turn ends, continuation user message (empty)
      // 6. Assistant calls task_complete
      // 7. Final turn end
      const entries: TranscriptEntry[] = [
        // User prompt
        { type: "user", message: { content: [{ type: "text", text: "list the files" }] }, sessionId: "s1" },
        // Turn 1: tool call
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "view", input: { path: "." } },
            ],
          },
          sessionId: "s1",
          stop_reason: "tool_use",
        },
        { type: "system", message: { content: [] }, sessionId: "s1", subtype: "turn_duration" },
        // Turn 2: text response (continuation)
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Here are the files:\n- file1\n- file2" }] },
          sessionId: "s1",
        },
        { type: "system", message: { content: [] }, sessionId: "s1", subtype: "turn_duration" },
        // Continuation user message (empty - autopilot)
        { type: "user", message: { content: [{ type: "text", text: "" }] }, sessionId: "s1" },
        // Turn 3: task_complete
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t2", name: "task_complete", input: { summary: "Listed files" } },
            ],
          },
          sessionId: "s1",
          stop_reason: "tool_use",
        },
        { type: "system", message: { content: [] }, sessionId: "s1", subtype: "turn_duration" },
      ];

      // The last user entry is the empty continuation message
      // Response after that is the task_complete tool call (no text)
      const result = extractAssistantResponse(entries);
      // Text is empty since the last assistant message after the last user entry only has tool_use
      expect(result.text).toBe("");
      expect(result.isComplete).toBe(true);
    });

    it("handles Copilot multi-turn with collectAllText across continuation", () => {
      const entries: TranscriptEntry[] = [
        { type: "user", message: { content: [{ type: "text", text: "list files" }] }, sessionId: "s1" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Let me check..." }] },
          sessionId: "s1",
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Here are the files: a, b, c" }] },
          sessionId: "s1",
        },
        { type: "system", message: { content: [] }, sessionId: "s1", subtype: "turn_duration" },
      ];
      const result = extractAssistantResponse(entries, { collectAllText: true });
      expect(result.text).toBe("Let me check...\nHere are the files: a, b, c");
      expect(result.isComplete).toBe(true);
    });
  });
});
