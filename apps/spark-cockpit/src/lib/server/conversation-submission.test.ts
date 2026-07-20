import { describe, expect, it } from "vitest";
import {
  conversationStartSessionId,
  conversationTurnIdempotencyKey,
  normalizeConversationSubmissionId,
} from "./conversation-submission";

describe("conversation submission identity", () => {
  it("derives stable workspace-scoped start session ids", () => {
    const first = conversationStartSessionId("ws_one", " idem_1 ");
    expect(first).toMatch(/^sess_cockpit_[a-f0-9]{32}$/);
    expect(conversationStartSessionId("ws_one", "idem_1")).toBe(first);
    expect(conversationStartSessionId("ws_two", "idem_1")).not.toBe(first);
  });

  it("uses the same normalized nonce for later-turn idempotency", () => {
    const key = conversationTurnIdempotencyKey("sess_one", " idem_1 ");
    expect(key).toMatch(/^idem_[a-f0-9]{32}$/);
    expect(conversationTurnIdempotencyKey("sess_one", "idem_1")).toBe(key);
    expect(conversationTurnIdempotencyKey("sess_two", "idem_1")).not.toBe(key);
    expect(conversationTurnIdempotencyKey("sess_one", " ")).toBeUndefined();
  });

  it("rejects oversized submission ids", () => {
    expect(() => normalizeConversationSubmissionId("x".repeat(129))).toThrow(
      "Conversation submission id is too long.",
    );
  });
});
