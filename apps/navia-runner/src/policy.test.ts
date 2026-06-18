import { describe, expect, it } from "vitest";
import { decideCommandPolicy } from "./policy.js";

const workspaceBindingId = "rtwb_11111111111141111111111111111111";

describe("runner command policy", () => {
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

  it("uses read-only tools for diagnostics", () => {
    const decision = decideCommandPolicy({
      workspaceBindingId,
      knownWorkspaceBindingIds: new Set([workspaceBindingId]),
      command: { kind: "diagnostics.request" },
    });

    expect(decision.accepted).toBe(true);
    expect(decision.tools).toEqual(["read", "grep", "find", "ls"]);
  });

  it("adds mutating tools for task starts when mutation is allowed", () => {
    const decision = decideCommandPolicy({
      workspaceBindingId,
      knownWorkspaceBindingIds: new Set([workspaceBindingId]),
      command: { kind: "task.start.request" },
      allowMutation: true,
    });

    expect(decision.accepted).toBe(true);
    expect(decision.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
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
