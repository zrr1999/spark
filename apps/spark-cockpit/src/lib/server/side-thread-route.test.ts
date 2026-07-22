import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("$lib/server/managed-sessions", () => ({
  getManagedSessionForCockpit: mocks.get,
  getManagedSideThreadSnapshotForCockpit: mocks.snapshot,
}));

vi.mock("$lib/workbench-session-scope", () => ({
  workspaceIdForWorkbenchSession: (session: { scope?: { kind?: string; workspaceId?: string } }) =>
    session.scope?.kind === "workspace" ? (session.scope.workspaceId ?? null) : null,
}));

import { GET } from "../../routes/api/v1/sessions/[sessionId]/side-thread/+server";

const parent = {
  sessionId: "sess_workspace",
  scope: { kind: "workspace", workspaceId: "ws_current" },
  status: "ready",
  updatedAt: "2026-07-22T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(parent);
});

describe("side thread route", () => {
  it("serves the parent-scoped read-only snapshot without a background ensure", async () => {
    mocks.snapshot.mockResolvedValue({
      parentSessionId: parent.sessionId,
      sessionId: "sess_workspace_btw",
      generation: 2,
      mode: "tangent",
      status: "idle",
      pendingTurns: [],
      exchanges: [],
      hasMore: false,
    });

    const response = await GET({
      locals: { workspaceId: "ws_current" },
      params: { sessionId: parent.sessionId },
      url: new URL("http://localhost/api/v1/sessions/sess_workspace/side-thread?limit=8"),
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ generation: 2, mode: "tangent" });
    expect(mocks.snapshot).toHaveBeenCalledWith(parent.sessionId, {
      workspaceId: "ws_current",
      limit: 8,
    });
    expect(mocks.get).toHaveBeenCalledWith(parent.sessionId);
  });

  it("returns 404 when the parent has no Side Thread", async () => {
    mocks.snapshot.mockResolvedValue(null);
    const response = await GET({
      locals: { workspaceId: "ws_current" },
      params: { sessionId: parent.sessionId },
      url: new URL("http://localhost/api/v1/sessions/sess_workspace/side-thread"),
    } as never);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "side_thread_not_found" });
  });

  it("does not expose a parent from another workspace", async () => {
    mocks.get.mockResolvedValue({
      ...parent,
      scope: { kind: "workspace", workspaceId: "ws_foreign" },
    });

    const response = await GET({
      locals: { workspaceId: "ws_current" },
      params: { sessionId: parent.sessionId },
      url: new URL("http://localhost/api/v1/sessions/sess_workspace/side-thread"),
    } as never);

    expect(response.status).toBe(404);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});
