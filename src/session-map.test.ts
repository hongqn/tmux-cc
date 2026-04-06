import { describe, expect, it } from "vitest";
import { windowNameFromSessionKey } from "./session-map.js";

describe("session-map", () => {
  describe("windowNameFromSessionKey", () => {
    it("prefixes with cc-", () => {
      expect(windowNameFromSessionKey("test")).toBe("cc-test");
    });

    it("sanitizes special characters", () => {
      expect(windowNameFromSessionKey("user@telegram:12345")).toBe("cc-user-telegram-12345");
    });

    it("truncates long session keys", () => {
      const longKey = "a".repeat(100);
      const result = windowNameFromSessionKey(longKey);
      expect(result.length).toBeLessThanOrEqual(53); // cc- + 50 chars
    });

    it("handles empty string", () => {
      expect(windowNameFromSessionKey("")).toBe("cc-");
    });

    it("preserves alphanumeric, dash, and underscore", () => {
      expect(windowNameFromSessionKey("my_session-123")).toBe("cc-my_session-123");
    });
  });
});
