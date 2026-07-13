import { describe, expect, it } from "vitest";
import {
  isInfoflowGroupAllowed,
  isInfoflowGroupTriggered,
  isInfoflowInboundAllowed,
  isInfoflowPrivateAllowed,
} from "./infoflow-policy.ts";
import type { InfoflowAdapterConfig } from "./types.ts";

const base: InfoflowAdapterConfig = { type: "infoflow" };

describe("infoflow policy", () => {
  it("allows all private senders when allowlist is empty", () => {
    expect(isInfoflowPrivateAllowed(base, "anyone")).toBe(true);
    expect(isInfoflowPrivateAllowed({ ...base, allowed_user_ids: [] }, "anyone")).toBe(true);
  });

  it("restricts private senders to allowlist ids or names", () => {
    const config = { ...base, allowed_user_ids: ["zhanrongrui", "alice"] };
    expect(isInfoflowPrivateAllowed(config, "zhanrongrui")).toBe(true);
    expect(isInfoflowPrivateAllowed(config, "u1", "alice")).toBe(true);
    expect(isInfoflowPrivateAllowed(config, "bob")).toBe(false);
  });

  it("defaults group policy to disabled", () => {
    expect(isInfoflowGroupAllowed(base, "10838226")).toBe(false);
  });

  it("allowlists specific groups when configured", () => {
    const config = {
      ...base,
      group_policy: "allowlist" as const,
      allowed_group_ids: ["10838226"],
    };
    expect(isInfoflowGroupAllowed(config, "10838226")).toBe(true);
    expect(isInfoflowGroupAllowed(config, "999")).toBe(false);
    expect(
      isInfoflowInboundAllowed(config, {
        chatType: "group",
        senderId: "anyone",
        groupId: "10838226",
        text: "@Spark status",
        mentionedSelf: true,
      }),
    ).toBe(true);
  });

  it("opens all groups when policy is open", () => {
    expect(isInfoflowGroupAllowed({ ...base, group_policy: "open" }, "1")).toBe(true);
  });

  it("defaults group turns to platform-detected bot mentions", () => {
    const config = { ...base, group_policy: "open" as const };
    expect(
      isInfoflowGroupTriggered(config, { text: "ambient", eventType: "ALL_MESSAGE_FORWARD" }),
    ).toBe(false);
    expect(
      isInfoflowGroupTriggered(config, {
        text: "@Spark status",
        eventType: "MESSAGE_RECEIVE",
        mentionedSelf: true,
      }),
    ).toBe(true);
    expect(
      isInfoflowGroupTriggered(config, {
        text: "@someone-else status",
        eventType: "MESSAGE_RECEIVE",
        mentionedSelf: false,
      }),
    ).toBe(false);
  });

  it("supports command and all-message group triggers", () => {
    expect(
      isInfoflowGroupTriggered(
        { ...base, group_trigger: "command" },
        { text: "/status", eventType: "MESSAGE_RECEIVE" },
      ),
    ).toBe(true);
    expect(
      isInfoflowGroupTriggered(
        { ...base, group_trigger: "command" },
        { text: "ambient", eventType: "ALL_MESSAGE_FORWARD" },
      ),
    ).toBe(false);
    expect(
      isInfoflowGroupTriggered(
        { ...base, group_trigger: "all" },
        { text: "ambient", eventType: "ALL_MESSAGE_FORWARD" },
      ),
    ).toBe(true);
    expect(
      isInfoflowGroupTriggered(
        { ...base, group_trigger: "all" },
        { text: "@Spark status", eventType: "MESSAGE_RECEIVE", mentionedSelf: true },
      ),
    ).toBe(true);
    expect(
      isInfoflowGroupTriggered(
        { ...base, group_trigger: "all" },
        { text: "unknown", eventType: "OTHER_EVENT" },
      ),
    ).toBe(false);
  });
});
