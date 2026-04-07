import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  encodeWorkingDirectory,
  getProjectDir,
  parseLine,
  readNewEntries,
  extractAssistantResponse,
  isResponseComplete,
  extractSessionId,
  findTranscriptBySessionId,
  getExistingTranscriptPaths,
  findNewTranscript,
  findGrowingTranscript,
} from "./transcript-reader.js";

describe("transcript-reader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `tmux-cc-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("encodeWorkingDirectory", () => {
    it("replaces slashes and dots with dashes", () => {
      expect(encodeWorkingDirectory("/home/user/project")).toBe("-home-user-project");
    });

    it("handles hidden directories (dot prefix)", () => {
      expect(encodeWorkingDirectory("/home/user/.openclaw/workspace")).toBe(
        "-home-user--openclaw-workspace",
      );
    });

    it("handles root path", () => {
      expect(encodeWorkingDirectory("/")).toBe("-");
    });

    it("handles path without leading slash", () => {
      expect(encodeWorkingDirectory("relative/path")).toBe("relative-path");
    });
  });

  describe("parseLine", () => {
    it("parses a valid assistant entry", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello!" }],
        },
        sessionId: "abc123",
        timestamp: "2024-01-15T10:30:00Z",
        stop_reason: "end_turn",
      });

      const entry = parseLine(line);
      expect(entry).not.toBeNull();
      expect(entry?.type).toBe("assistant");
      expect(entry?.message.content).toHaveLength(1);
      expect(entry?.message.content[0].type).toBe("text");
      expect(entry?.stop_reason).toBe("end_turn");
    });

    it("parses a valid user entry", () => {
      const line = JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "text", text: "Hi there" }],
        },
        sessionId: "abc123",
      });

      const entry = parseLine(line);
      expect(entry).not.toBeNull();
      expect(entry?.type).toBe("user");
    });

    it("returns null for invalid JSON", () => {
      expect(parseLine("not json")).toBeNull();
    });

    it("returns null for entry without type", () => {
      const line = JSON.stringify({ message: { content: [] } });
      expect(parseLine(line)).toBeNull();
    });

    it("returns null for unknown type", () => {
      const line = JSON.stringify({
        type: "unknown",
        message: { content: [] },
      });
      expect(parseLine(line)).toBeNull();
    });

    it("returns null for entry without message", () => {
      const line = JSON.stringify({ type: "assistant" });
      expect(parseLine(line)).toBeNull();
    });

    it("parses entry with thinking block", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Let me think..." },
            { type: "text", text: "Here's my answer" },
          ],
        },
        sessionId: "abc123",
        stop_reason: "end_turn",
      });

      const entry = parseLine(line);
      expect(entry?.message.content).toHaveLength(2);
      expect(entry?.message.content[0].type).toBe("thinking");
      expect(entry?.message.content[1].type).toBe("text");
    });

    it("parses entry with tool_use block", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-123",
              name: "Read",
              input: { file_path: "test.txt" },
            },
          ],
        },
        sessionId: "abc123",
      });

      const entry = parseLine(line);
      expect(entry?.message.content[0].type).toBe("tool_use");
    });

    it("treats explicit stop_reason null as undefined (ambiguous)", () => {
      const line = JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "NO_REPLY" }],
          stop_reason: null,
        },
        sessionId: "abc123",
      });

      const entry = parseLine(line);
      expect(entry).not.toBeNull();
      expect(entry?.type).toBe("assistant");
      // null is ambiguous REDACTED could be intermediate or final REDACTED left as undefined
      expect(entry?.stop_reason).toBeUndefined();
    });

    it("parses system turn_duration entries", () => {
      const line = JSON.stringify({
        type: "system",
        subtype: "turn_duration",
        durationMs: 5000,
        sessionId: "abc123",
      });

      const entry = parseLine(line);
      expect(entry).not.toBeNull();
      expect(entry?.type).toBe("system");
      expect(entry?.subtype).toBe("turn_duration");
    });
  });

  describe("readNewEntries", () => {
    it("reads all entries from a new file", () => {
      const filePath = join(tempDir, "test.jsonl");
      const entries = [
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: "Hello" }] },
          sessionId: "s1",
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hi!" }] },
          sessionId: "s1",
          stop_reason: "end_turn",
        }),
      ];
      writeFileSync(filePath, entries.join("\n") + "\n");

      const result = readNewEntries(filePath, 0);
      expect(result.entries).toHaveLength(2);
      expect(result.newOffset).toBeGreaterThan(0);
    });

    it("reads only new entries with offset", () => {
      const filePath = join(tempDir, "test.jsonl");
      const line1 = JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Hello" }] },
        sessionId: "s1",
      });
      const line2 = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hi!" }] },
        sessionId: "s1",
        stop_reason: "end_turn",
      });

      // Write first line
      writeFileSync(filePath, line1 + "\n");
      const result1 = readNewEntries(filePath, 0);
      expect(result1.entries).toHaveLength(1);

      // Append second line
      writeFileSync(filePath, line1 + "\n" + line2 + "\n");
      const result2 = readNewEntries(filePath, result1.newOffset);
      expect(result2.entries).toHaveLength(1);
      expect(result2.entries[0].type).toBe("assistant");
    });

    it("handles file truncation", () => {
      const filePath = join(tempDir, "test.jsonl");
      const line = JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Hello" }] },
        sessionId: "s1",
      });

      writeFileSync(filePath, line + "\n");
      const result1 = readNewEntries(filePath, 0);

      // "Truncate" by writing shorter content
      writeFileSync(filePath, "x\n");
      const result2 = readNewEntries(filePath, result1.newOffset);

      // Should reset offset and read from beginning
      expect(result2.newOffset).toBeLessThan(result1.newOffset);
    });

    it("returns empty for nonexistent file", () => {
      const result = readNewEntries("/nonexistent/path.jsonl", 0);
      expect(result.entries).toHaveLength(0);
      expect(result.newOffset).toBe(0);
    });

    it("returns empty when no new content", () => {
      const filePath = join(tempDir, "test.jsonl");
      const line = JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Hello" }] },
        sessionId: "s1",
      });
      writeFileSync(filePath, line + "\n");

      const result1 = readNewEntries(filePath, 0);
      const result2 = readNewEntries(filePath, result1.newOffset);
      expect(result2.entries).toHaveLength(0);
    });
  });

  describe("extractAssistantResponse", () => {
    it("extracts text from the last assistant entry", () => {
      const entries = [
        {
          type: "user" as const,
          message: { content: [{ type: "text" as const, text: "Hello" }] },
          sessionId: "s1",
        },
        {
          type: "assistant" as const,
          message: {
            content: [{ type: "text" as const, text: "Hi there!" }],
          },
          sessionId: "s1",
          stop_reason: "end_turn" as const,
        },
      ];

      const response = extractAssistantResponse(entries);
      expect(response.text).toBe("Hi there!");
      expect(response.isComplete).toBe(true);
      expect(response.sessionId).toBe("s1");
    });

    it("concatenates multiple text blocks", () => {
      const entries = [
        {
          type: "assistant" as const,
          message: {
            content: [
              { type: "text" as const, text: "First part." },
              { type: "text" as const, text: "Second part." },
            ],
          },
          sessionId: "s1",
          stop_reason: "end_turn" as const,
        },
      ];

      const response = extractAssistantResponse(entries);
      expect(response.text).toBe("First part.\nSecond part.");
    });

    it("filters out thinking and tool_use blocks", () => {
      const entries = [
        {
          type: "assistant" as const,
          message: {
            content: [
              { type: "thinking" as const, thinking: "Let me think..." },
              { type: "text" as const, text: "Here's my answer" },
              {
                type: "tool_use" as const,
                id: "t1",
                name: "Read",
                input: {},
              },
            ],
          },
          sessionId: "s1",
          stop_reason: "end_turn" as const,
        },
      ];

      const response = extractAssistantResponse(entries);
      expect(response.text).toBe("Here's my answer");
    });

    it("returns incomplete when no stop_reason", () => {
      const entries = [
        {
          type: "assistant" as const,
          message: {
            content: [{ type: "text" as const, text: "Partial..." }],
          },
          sessionId: "s1",
        },
      ];

      const response = extractAssistantResponse(entries);
      expect(response.text).toBe("Partial...");
      expect(response.isComplete).toBe(false);
    });

    it("returns empty for no assistant entries", () => {
      const entries = [
        {
          type: "user" as const,
          message: { content: [{ type: "text" as const, text: "Hello" }] },
          sessionId: "s1",
        },
      ];

      const response = extractAssistantResponse(entries);
      expect(response.text).toBe("");
      expect(response.isComplete).toBe(false);
    });

    it("returns the LAST assistant entry", () => {
      const entries = [
        {
          type: "assistant" as const,
          message: {
            content: [{ type: "text" as const, text: "First response" }],
          },
          sessionId: "s1",
          stop_reason: "end_turn" as const,
        },
        {
          type: "user" as const,
          message: { content: [{ type: "text" as const, text: "Follow up" }] },
          sessionId: "s1",
        },
        {
          type: "assistant" as const,
          message: {
            content: [{ type: "text" as const, text: "Second response" }],
          },
          sessionId: "s1",
          stop_reason: "end_turn" as const,
        },
      ];

      const response = extractAssistantResponse(entries);
      expect(response.text).toBe("Second response");
    });

    it("treats stop_reason 'tool_use' as incomplete", () => {
      const entries = [
        {
          type: "assistant" as const,
          message: {
            content: [
              { type: "text" as const, text: "Let me check that file" },
              { type: "tool_use" as const, id: "t1", name: "Read", input: { file_path: "foo.ts" } },
            ],
          },
          sessionId: "s1",
          stop_reason: "tool_use",
        },
      ];

      const response = extractAssistantResponse(entries);
      expect(response.text).toBe("Let me check that file");
      expect(response.isComplete).toBe(false);
    });

    it("finds complete response after tool_use chain", () => {
      const entries = [
        {
          type: "assistant" as const,
          message: {
            content: [
              { type: "text" as const, text: "Let me read it" },
              { type: "tool_use" as const, id: "t1", name: "Read", input: {} },
            ],
          },
          sessionId: "s1",
          stop_reason: "tool_use",
        },
        {
          type: "user" as const,
          message: {
            content: [
              { type: "tool_result" as const, tool_use_id: "t1", content: "file contents" },
            ],
          },
          sessionId: "s1",
        },
        {
          type: "assistant" as const,
          message: {
            content: [{ type: "text" as const, text: "Here is your answer" }],
          },
          sessionId: "s1",
          stop_reason: "end_turn" as const,
        },
      ];

      const response = extractAssistantResponse(entries);
      expect(response.text).toBe("Here is your answer");
      expect(response.isComplete).toBe(true);
    });

    it("uses turn_duration system entry as completion signal", () => {
      const entries = [
        {
          type: "assistant" as const,
          message: {
            content: [{ type: "text" as const, text: "NO_REPLY" }],
          },
          sessionId: "s1",
          // stop_reason is undefined (null in JSON REDACTED ambiguous)
        },
        {
          type: "system" as const,
          message: { content: [] },
          sessionId: "s1",
          subtype: "turn_duration",
        },
      ];

      const response = extractAssistantResponse(entries);
      expect(response.text).toBe("NO_REPLY");
      expect(response.isComplete).toBe(true);
    });

    it("does not treat null stop_reason as complete without turn_duration", () => {
      const entries = [
        {
          type: "assistant" as const,
          message: {
            content: [{ type: "text" as const, text: "Intermediate text" }],
          },
          sessionId: "s1",
          // stop_reason undefined REDACTED could be intermediate
        },
      ];

      const response = extractAssistantResponse(entries);
      expect(response.text).toBe("Intermediate text");
      expect(response.isComplete).toBe(false);
    });

    it("ignores stale assistant entries from a previous turn when a user entry follows", () => {
      // Bug scenario: after --resume, the batch straddles two turns:
      // [old_assistant (complete), new_user] REDACTED the old assistant must be skipped.
      const entries: TranscriptEntry[] = [
        {
          type: "assistant",
          message: {
            content: [{ type: "text" as const, text: "No response requested." }],
          },
          sessionId: "s1",
          stop_reason: "stop_sequence",
        },
        {
          type: "user",
          message: {
            content: [{ type: "text" as const, text: "Please analyse this PDF." }],
          },
          sessionId: "s1",
        },
      ];

      const response = extractAssistantResponse(entries);
      // Should NOT return the stale "No response requested." from the previous turn
      expect(response.text).toBe("");
      expect(response.isComplete).toBe(false);
    });

    it("returns assistant response that appears after the last user entry", () => {
      // Normal case: [old_assistant, new_user, new_assistant]
      const entries: TranscriptEntry[] = [
        {
          type: "assistant",
          message: {
            content: [{ type: "text" as const, text: "Stale response" }],
          },
          sessionId: "s1",
          stop_reason: "end_turn",
        },
        {
          type: "user",
          message: {
            content: [{ type: "text" as const, text: "New question" }],
          },
          sessionId: "s1",
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text" as const, text: "Fresh response" }],
          },
          sessionId: "s1",
          stop_reason: "end_turn",
        },
      ];

      const response = extractAssistantResponse(entries);
      expect(response.text).toBe("Fresh response");
      expect(response.isComplete).toBe(true);
    });
  });

  describe("isResponseComplete", () => {
    it("returns true when last assistant has stop_reason", () => {
      const entries = [
        {
          type: "assistant" as const,
          message: {
            content: [{ type: "text" as const, text: "Done" }],
          },
          sessionId: "s1",
          stop_reason: "end_turn" as const,
        },
      ];
      expect(isResponseComplete(entries)).toBe(true);
    });

    it("returns false when last assistant has stop_reason tool_use", () => {
      const entries = [
        {
          type: "assistant" as const,
          message: {
            content: [{ type: "tool_use" as const, id: "t1", name: "Bash", input: {} }],
          },
          sessionId: "s1",
          stop_reason: "tool_use",
        },
      ];
      expect(isResponseComplete(entries)).toBe(false);
    });

    it("returns false when last assistant has no stop_reason", () => {
      const entries = [
        {
          type: "assistant" as const,
          message: {
            content: [{ type: "text" as const, text: "Still going..." }],
          },
          sessionId: "s1",
        },
      ];
      expect(isResponseComplete(entries)).toBe(false);
    });

    it("returns false when no assistant entries", () => {
      const entries = [
        {
          type: "user" as const,
          message: { content: [{ type: "text" as const, text: "Hello" }] },
          sessionId: "s1",
        },
      ];
      expect(isResponseComplete(entries)).toBe(false);
    });

    it("returns true when turn_duration system entry present", () => {
      const entries = [
        {
          type: "assistant" as const,
          message: {
            content: [{ type: "text" as const, text: "Answer" }],
          },
          sessionId: "s1",
          // no stop_reason (null in JSON)
        },
        {
          type: "system" as const,
          message: { content: [] },
          sessionId: "s1",
          subtype: "turn_duration",
        },
      ];
      expect(isResponseComplete(entries)).toBe(true);
    });
  });

  describe("extractSessionId", () => {
    it("extracts session ID from path", () => {
      expect(extractSessionId("/path/to/abc123.jsonl")).toBe("abc123");
    });

    it("handles complex session IDs", () => {
      expect(extractSessionId("/path/to/session-uuid-12345.jsonl")).toBe("session-uuid-12345");
    });
  });

  describe("findTranscriptBySessionId", () => {
    it("returns null when file does not exist", () => {
      const result = findTranscriptBySessionId("/nonexistent", "session1");
      expect(result).toBeNull();
    });
  });

  describe("getExistingTranscriptPaths", () => {
    // Use a unique CWD so getProjectDir resolves under ~/.claude/projects/
    const uniqueCwd = `/tmp/tmux-test-${randomUUID()}`;
    let projectDir: string;

    beforeEach(() => {
      projectDir = getProjectDir(uniqueCwd);
      mkdirSync(projectDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("returns map of existing jsonl file paths with sizes", () => {
      writeFileSync(join(projectDir, "aaa.jsonl"), "aa");
      writeFileSync(join(projectDir, "bbb.jsonl"), "bbbb");
      writeFileSync(join(projectDir, "readme.txt"), "not a transcript");

      const result = getExistingTranscriptPaths(uniqueCwd);
      expect(result.size).toBe(2);
      expect(result.has(join(projectDir, "aaa.jsonl"))).toBe(true);
      expect(result.get(join(projectDir, "aaa.jsonl"))).toBe(2);
      expect(result.has(join(projectDir, "bbb.jsonl"))).toBe(true);
      expect(result.get(join(projectDir, "bbb.jsonl"))).toBe(4);
    });

    it("returns empty map when directory does not exist", () => {
      const result = getExistingTranscriptPaths("/nonexistent/path/that/does/not/exist");
      expect(result.size).toBe(0);
    });
  });

  describe("findNewTranscript", () => {
    const uniqueCwd = `/tmp/tmux-test-new-${randomUUID()}`;
    let projectDir: string;

    beforeEach(() => {
      projectDir = getProjectDir(uniqueCwd);
      mkdirSync(projectDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("returns a file not in the existing map", () => {
      writeFileSync(join(projectDir, "old.jsonl"), "{}");
      const existingPaths = new Map([[join(projectDir, "old.jsonl"), 2]]);

      // Create a new file after the snapshot
      writeFileSync(join(projectDir, "new.jsonl"), "{}");

      const result = findNewTranscript(uniqueCwd, existingPaths);
      expect(result).toBe(join(projectDir, "new.jsonl"));
    });

    it("returns null when no new files exist", () => {
      writeFileSync(join(projectDir, "old.jsonl"), "{}");
      const existingPaths = new Map([[join(projectDir, "old.jsonl"), 2]]);

      const result = findNewTranscript(uniqueCwd, existingPaths);
      expect(result).toBeNull();
    });

    it("returns null when directory does not exist", () => {
      const result = findNewTranscript("/nonexistent/path/that/does/not/exist", new Map());
      expect(result).toBeNull();
    });
  });

  describe("findGrowingTranscript", () => {
    const uniqueCwd = `/tmp/tmux-test-grow-${randomUUID()}`;
    let projectDir: string;

    beforeEach(() => {
      projectDir = getProjectDir(uniqueCwd);
      mkdirSync(projectDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("detects a file that grew since snapshot", () => {
      writeFileSync(join(projectDir, "active.jsonl"), "ab");
      const existingPaths = new Map([[join(projectDir, "active.jsonl"), 2]]);

      // File grows
      writeFileSync(join(projectDir, "active.jsonl"), "abcdef");

      const result = findGrowingTranscript(uniqueCwd, existingPaths);
      expect(result).not.toBeNull();
      expect(result!.path).toBe(join(projectDir, "active.jsonl"));
      expect(result!.snapshotSize).toBe(2);
    });

    it("returns null when no files grew", () => {
      writeFileSync(join(projectDir, "stable.jsonl"), "ab");
      const existingPaths = new Map([[join(projectDir, "stable.jsonl"), 2]]);

      const result = findGrowingTranscript(uniqueCwd, existingPaths);
      expect(result).toBeNull();
    });

    it("ignores files not in snapshot", () => {
      writeFileSync(join(projectDir, "new.jsonl"), "data");
      const existingPaths = new Map<string, number>();

      const result = findGrowingTranscript(uniqueCwd, existingPaths);
      expect(result).toBeNull();
    });
  });
});
