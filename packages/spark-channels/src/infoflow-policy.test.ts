import { describe, expect, it } from "vitest";
import {
  isInfoflowGroupAllowed,
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
      }),
    ).toBe(true);
  });

  it("opens all groups when policy is open", () => {
    expect(isInfoflowGroupAllowed({ ...base, group_policy: "open" }, "1")).toBe(true);
  });
});
