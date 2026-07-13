import { describe, expect, it } from "vitest";
import {
  conversationActivityStatus,
  visibleConversationActivityStatus,
  visibleSessionStatus,
} from "./conversation-status";

describe("conversation status presentation", () => {
  it("keeps completed work separate from session availability", () => {
    expect(conversationActivityStatus("succeeded")).toBe("completed");
    expect(visibleConversationActivityStatus("succeeded")).toBeNull();
    expect(visibleConversationActivityStatus("completed")).toBeNull();
    expect(visibleSessionStatus("ready")).toBeNull();
    expect(visibleSessionStatus("available")).toBeNull();
  });

  it("keeps actionable activity visible", () => {
    expect(visibleConversationActivityStatus("acked")).toBe("queued");
    expect(visibleConversationActivityStatus("in-progress")).toBe("running");
    expect(visibleConversationActivityStatus("needs-input")).toBe("blocked");
    expect(visibleConversationActivityStatus("lost")).toBe("failed");
  });

  it("only shows non-idle session lifecycle states", () => {
    expect(visibleSessionStatus("running")).toBe("running");
    expect(visibleSessionStatus("archived")).toBe("archived");
  });
});
