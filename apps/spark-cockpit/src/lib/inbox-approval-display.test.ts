import { describe, expect, it } from "vitest";
import { canActOnInboxApproval, canQuickDecideInboxApproval } from "./inbox-approval-display";

function item(overrides: Partial<Parameters<typeof canQuickDecideInboxApproval>[0]> = {}) {
  return {
    status: "pending",
    requestStatus: "pending",
    questions: [],
    approval: { kind: "workflow_risk", actionable: true },
    ...overrides,
  };
}

describe("inbox approval-center display", () => {
  it("shows quick approval actions for actionable binary approval records", () => {
    expect(canActOnInboxApproval(item())).toBe(true);
    expect(canQuickDecideInboxApproval(item())).toBe(true);
  });

  it("keeps ask records with required questions on the full answer form", () => {
    expect(
      canQuickDecideInboxApproval(
        item({ approval: { kind: "ask", actionable: true }, questions: [{ id: "q1" }] }),
      ),
    ).toBe(false);
  });

  it("hides approval actions after the inbox item is resolved", () => {
    expect(canActOnInboxApproval(item({ status: "resolved" }))).toBe(false);
    expect(canQuickDecideInboxApproval(item({ requestStatus: "answered" }))).toBe(false);
  });
});
