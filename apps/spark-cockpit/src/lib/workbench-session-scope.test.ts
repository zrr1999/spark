import { describe, expect, it } from "vitest";
import {
  daemonIdentityForWorkbenchSession,
  isSessionVisibleInWorkbenchRail,
  workbenchSessionScope,
  workspaceIdForWorkbenchSession,
} from "./workbench-session-scope";

describe("workbench session scope", () => {
  it("shows only the active workspace plus explicitly daemon-scoped sessions", () => {
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

  it("keeps daemon identity available for separate global groups", () => {
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
});
