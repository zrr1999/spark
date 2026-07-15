import { describe, expect, it } from "vitest";
import {
  daemonIdentityForWorkbenchSession,
  isSessionVisibleInWorkbenchRail,
  sessionsForWorkbench,
  workbenchSessionScope,
  workspaceIdForWorkbenchSession,
} from "./workbench-session-scope";

describe("workbench session scope", () => {
  it("shows the active workspace plus explicitly daemon-scoped sessions", () => {
    expect(isSessionVisibleInWorkbenchRail({ workspaceId: "ws_spore" }, "ws_spore")).toBe(true);
    expect(isSessionVisibleInWorkbenchRail({ workspaceId: "spark" }, "ws_spore")).toBe(false);
    expect(
      isSessionVisibleInWorkbenchRail(
        { workspaceId: "legacy", scope: { kind: "daemon", daemonId: "daemon-a" } },
        "ws_spore",
      ),
    ).toBe(true);
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

  it("keeps daemon identity available for the global conversation group", () => {
    expect(
      daemonIdentityForWorkbenchSession({
        scope: { kind: "daemon", daemonId: "daemon-a", daemonLabel: "Mac Studio" },
      }),
    ).toEqual({ id: "daemon-a", label: "Mac Studio" });
    expect(
      daemonIdentityForWorkbenchSession({
        scope: { kind: "daemon", daemonId: "daemon-b" },
      }),
    ).toEqual({ id: "daemon-b", label: "daemon-b" });
  });

  it("projects only the active workspace plus global daemon conversations", () => {
    const workspaceSession = {
      sessionId: "sess_workspace",
      scope: { kind: "workspace" as const, workspaceId: "ws_current" },
    };
    const otherWorkspaceSession = {
      sessionId: "sess_other",
      scope: { kind: "workspace" as const, workspaceId: "ws_other" },
    };
    const daemonSession = {
      sessionId: "sess_daemon",
      scope: { kind: "daemon" as const, daemonId: "daemon-a" },
    };

    expect(
      sessionsForWorkbench([workspaceSession, otherWorkspaceSession, daemonSession], "ws_current"),
    ).toEqual([workspaceSession, daemonSession]);
  });
});
