import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("$lib/server/managed-sessions", () => ({
  getManagedSessionForCockpit: mocks.get,
  getManagedSessionSnapshotForCockpit: mocks.snapshot,
}));

vi.mock("$lib/session-snapshot-window", () => ({
  normalizeSessionSnapshotLimit: () => 80,
}));

vi.mock("$lib/workbench-session-scope", () => ({
  workspaceIdForWorkbenchSession: (session: { scope?: { kind?: string; workspaceId?: string } }) =>
    session.scope?.kind === "workspace" ? (session.scope.workspaceId ?? null) : null,
}));

import { GET } from "../../routes/api/v1/sessions/[sessionId]/snapshot/+server";

const workspaceSession = {
  sessionId: "sess_workspace",
  scope: { kind: "workspace" as const, workspaceId: "ws_current" },
  workspaceId: "ws_current",
};

function requestEvent(sessionId: string) {
  return {
    params: { sessionId },
    url: new URL(`http://localhost/api/v1/sessions/${sessionId}/snapshot`),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshot.mockResolvedValue({
    snapshot: {
      sessionId: workspaceSession.sessionId,
      status: "idle",
      messages: [],
      tools: [],
      artifacts: [],
      tasks: [],
      runs: [],
      mailbox: [],
    },
    history: {
      totalMessages: 0,
      loadedMessages: 0,
      hiddenMessages: 0,
      earlierMessages: 0,
      laterMessages: 0,
      hasEarlierMessages: false,
    },
  });
});

describe("session snapshot route scope", () => {
  it("returns a snapshot for a workspace session", async () => {
    mocks.get.mockResolvedValue(workspaceSession);

    const response = await GET(requestEvent(workspaceSession.sessionId));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      snapshot: {
        sessionId: workspaceSession.sessionId,
        status: "idle",
        messages: [],
        tools: [],
        artifacts: [],
        tasks: [],
        runs: [],
        mailbox: [],
      },
      history: {
        totalMessages: 0,
        loadedMessages: 0,
        hiddenMessages: 0,
        earlierMessages: 0,
        laterMessages: 0,
        hasEarlierMessages: false,
      },
    });
    expect(mocks.snapshot).toHaveBeenCalledWith(workspaceSession.sessionId, { messageLimit: 80 });
  });

  it("does not expose a daemon-global session snapshot", async () => {
    mocks.get.mockResolvedValue({
      sessionId: "sess_daemon",
      scope: { kind: "daemon", daemonId: "daemon-local" },
    });

    const response = await GET(requestEvent("sess_daemon"));

    expect(response.status).toBe(404);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it("returns not found before requesting a snapshot for a missing session", async () => {
    mocks.get.mockResolvedValue(null);

    const response = await GET(requestEvent("sess_missing"));

    expect(response.status).toBe(404);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});
