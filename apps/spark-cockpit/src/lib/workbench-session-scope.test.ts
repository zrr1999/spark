import { describe, expect, it } from "vitest";
import {
  isSessionVisibleInWorkbenchRail,
  workbenchSessionScope,
  workspaceSessionsForWorkbench,
  workspaceIdForWorkbenchSession,
} from "./workbench-session-scope";

describe("workbench session scope", () => {
  it("shows only sessions scoped to the active workspace and hides daemon-scoped ones", () => {
    expect(isSessionVisibleInWorkbenchRail({ workspaceId: "ws_spore" }, "ws_spore")).toBe(true);
    expect(isSessionVisibleInWorkbenchRail({ workspaceId: "spark" }, "ws_spore")).toBe(false);
    expect(
      isSessionVisibleInWorkbenchRail(
        { workspaceId: "legacy", scope: { kind: "daemon", daemonId: "daemon-a" } },
        "ws_spore",
      ),
    ).toBe(false);
  });

  it("prefers canonical workspace scope over the legacy compatibility field", () => {
    const session = {
      workspaceId: "legacy-workspace",
      scope: { kind: "workspace" as const, workspaceId: "ws_current" },
    };

    expect(workbenchSessionScope(session)).toEqual({
      kind: "workspace",
      workspaceId: "ws_current",
    });
    expect(workspaceIdForWorkbenchSession(session)).toBe("ws_current");
  });

  it("keeps daemon-scoped sessions out of the workspace-scoped Cockpit view", () => {
    const session = { scope: { kind: "daemon" as const, daemonId: "daemon-a" } };
    expect(workbenchSessionScope(session)).toEqual({ kind: "daemon", daemonId: "daemon-a" });
    expect(workspaceIdForWorkbenchSession(session)).toBeNull();
  });

  it("projects daemon registry results to workspace and channel-owned conversations", () => {
    const workspaceSession = {
      sessionId: "sess_workspace",
      scope: { kind: "workspace" as const, workspaceId: "ws_current" },
    };
    const channelSession = {
      sessionId: "sess_channel",
      scope: { kind: "workspace" as const, workspaceId: "ws_current" },
      bindings: [{ kind: "channel", externalKey: "infoflow:user:u1" }],
    };
    const daemonSession = {
      sessionId: "sess_daemon",
      scope: { kind: "daemon" as const, daemonId: "daemon-a" },
    };

    expect(
      workspaceSessionsForWorkbench([workspaceSession, channelSession, daemonSession]),
    ).toEqual([workspaceSession, channelSession]);
  });
});
