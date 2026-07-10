import { describe, expect, it } from "vitest";
import { decideCommandPolicy } from "./policy.js";

const workspaceBindingId = "rtwb_11111111111141111111111111111111";

describe("Spark daemon command policy", () => {
  it("rejects commands for unknown workspace bindings", () => {
    const decision = decideCommandPolicy({
      workspaceBindingId,
      knownWorkspaceBindingIds: new Set(),
      command: { kind: "diagnostics.request" },
    });

    expect(decision).toMatchObject({
      accepted: false,
      reasonCode: "UNKNOWN_WORKSPACE_BINDING",
    });
  });

  it("admits diagnostics without pretending to select runtime tools", () => {
    const decision = decideCommandPolicy({
      workspaceBindingId,
      knownWorkspaceBindingIds: new Set([workspaceBindingId]),
      command: { kind: "diagnostics.request" },
    });

    expect(decision.accepted).toBe(true);
    expect("tools" in decision).toBe(false);
  });

  it("admits task starts when mutation is allowed", () => {
    const decision = decideCommandPolicy({
      workspaceBindingId,
      knownWorkspaceBindingIds: new Set([workspaceBindingId]),
      command: { kind: "task.start.request" },
      allowMutation: true,
    });

    expect(decision.accepted).toBe(true);
    expect("tools" in decision).toBe(false);
  });

  it("rejects task starts when mutation is disabled", () => {
    const decision = decideCommandPolicy({
      workspaceBindingId,
      knownWorkspaceBindingIds: new Set([workspaceBindingId]),
      command: { kind: "task.start.request" },
      allowMutation: false,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reasonCode: "MUTATION_NOT_ALLOWED",
    });
  });
});
