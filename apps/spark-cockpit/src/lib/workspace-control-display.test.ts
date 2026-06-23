import { describe, expect, it } from "vitest";
import { workspaceControlDisplay } from "./workspace-control-display";

describe("workspace control display", () => {
  it("renders borrowed and online executor state for Cockpit", () => {
    expect(
      workspaceControlDisplay({
        connection: { status: "connected", lastSeenAt: "2026-05-22T00:00:00.000Z" },
        borrowed: { borrowed: true, interactiveClientCount: 1 },
        executor: { state: "online", activeInvocationCount: 2, activeAgentCount: 3 },
        control: {
          mode: "snapshot_only",
          serverMutationAllowed: false,
          message: "Workspace is borrowed by an open TUI client.",
        },
      }),
    ).toEqual({
      connectionLabel: "Daemon connected",
      borrowedLabel: "Borrowed by 1 TUI client",
      executorLabel: "Background executor online · 2 active invocations · 3 active agents",
      controlLabel: "Workspace is borrowed by an open TUI client.",
    });
  });

  it("renders disconnected, not borrowed, none, starting, and unhealthy executor states", () => {
    expect(
      workspaceControlDisplay({
        connection: { status: "disconnected", lastSeenAt: "2026-05-22T00:00:00.000Z" },
        borrowed: { borrowed: false, interactiveClientCount: 0 },
        executor: { state: "none", activeInvocationCount: 0, activeAgentCount: 0 },
        control: { mode: "snapshot_only", serverMutationAllowed: false },
      }),
    ).toMatchObject({
      connectionLabel: "Daemon disconnected",
      borrowedLabel: "Workspace not borrowed",
      executorLabel: "No background executor",
      controlLabel: "Snapshot-only mode",
    });
    expect(
      workspaceControlDisplay({
        connection: { status: "connected", lastSeenAt: null },
        executor: { state: "starting", activeInvocationCount: 0, activeAgentCount: 0 },
        control: { mode: "full", serverMutationAllowed: true },
      }).executorLabel,
    ).toBe("Background executor starting");
    expect(
      workspaceControlDisplay({
        connection: { status: "connected", lastSeenAt: null },
        executor: {
          state: "unhealthy",
          activeInvocationCount: 1,
          activeAgentCount: 1,
          unhealthyReason: "heartbeat missed",
        },
        control: { mode: "snapshot_only", serverMutationAllowed: false },
      }).executorLabel,
    ).toBe("Background executor unhealthy: heartbeat missed");
  });
});
