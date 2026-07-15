import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("$lib/server/managed-sessions", () => ({
  getManagedSessionForCockpit: mocks.get,
}));

vi.mock("$lib/workbench-session-scope", () => ({
  workspaceIdForWorkbenchSession: (session: { scope?: { kind?: string; workspaceId?: string } }) =>
    session.scope?.kind === "workspace" ? (session.scope.workspaceId ?? null) : null,
}));

import { GET } from "../../routes/api/v1/sessions/[sessionId]/status/+server";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("session status route scope", () => {
  it("returns status for a workspace session", async () => {
    mocks.get.mockResolvedValue({
      sessionId: "sess_workspace",
      scope: { kind: "workspace", workspaceId: "ws_current" },
      status: "ready",
      updatedAt: "2026-07-15T00:00:00.000Z",
    });

    const response = await GET({ params: { sessionId: "sess_workspace" } } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: "sess_workspace",
      status: "ready",
    });
  });

  it("does not expose daemon-global session status", async () => {
    mocks.get.mockResolvedValue({
      sessionId: "sess_daemon",
      scope: { kind: "daemon", daemonId: "daemon-local" },
      status: "ready",
      updatedAt: "2026-07-15T00:00:00.000Z",
    });

    const response = await GET({ params: { sessionId: "sess_daemon" } } as never);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "session_not_found" });
  });
});
