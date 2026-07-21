import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  projectedModelControl: vi.fn(),
  projectedSnapshot: vi.fn(),
  snapshot: vi.fn(),
  modelControl: vi.fn(),
  activity: vi.fn(),
}));

vi.mock("$lib/server/managed-sessions", () => ({
  archiveManagedSessionForCockpit: vi.fn(),
  createManagedSessionForCockpit: vi.fn(),
  getManagedSessionForCockpit: mocks.get,
  getManagedSessionSnapshotForCockpit: mocks.snapshot,
  getProjectedManagedSessionForCockpit: mocks.get,
  getProjectedManagedSessionSnapshotForCockpit: mocks.projectedSnapshot,
  listManagedSessionsForCockpit: mocks.list,
}));

vi.mock("$lib/server/db", () => ({ getDatabase: () => ({}) }));
vi.mock("@zendev-lab/spark-coordination/events", () => ({ latestEventCursor: () => null }));
vi.mock("@zendev-lab/spark-coordination/session-activity", () => ({
  loadSessionActivity: mocks.activity,
}));
vi.mock("$lib/server/model-control", () => ({
  loadModelControlForCockpit: mocks.modelControl,
  loadProjectedModelControlForCockpit: mocks.projectedModelControl,
  modelValue: vi.fn(),
  parseModelValue: vi.fn(),
  parseThinkingLevelValue: vi.fn(),
  setSessionModelForCockpit: vi.fn(),
  setSessionThinkingLevelForCockpit: vi.fn(),
}));
vi.mock("$lib/server/submission-idempotency", () => ({
  createCockpitSubmissionId: () => "generated-browser-submission",
}));
vi.mock("../../routes/(workbench)/sessions/+page.server", () => ({ actions: {} }));

import { _loadSessionPage } from "../../routes/(workbench)/sessions/[sessionId]/+page.server";

const workspaceSession = {
  sessionId: "sess_workspace",
  scope: { kind: "workspace" as const, workspaceId: "ws_current" },
  workspaceId: "ws_current",
  status: "ready" as const,
  bindings: [],
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
};

const channelSession = {
  ...workspaceSession,
  sessionId: "sess_channel",
  bindings: [
    {
      kind: "channel" as const,
      adapter: "infoflow" as const,
      externalKey: "infoflow:user:u1",
      boundAt: "2026-07-15T00:00:00.000Z",
    },
  ],
};

const daemonSession = {
  ...workspaceSession,
  sessionId: "sess_daemon",
  scope: { kind: "daemon" as const, daemonId: "daemon-local" },
  workspaceId: undefined,
};

const otherWorkspaceSession = {
  ...workspaceSession,
  sessionId: "sess_other_workspace",
  scope: { kind: "workspace" as const, workspaceId: "ws_other" },
  workspaceId: "ws_other",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({
    available: true,
    sessions: [workspaceSession, channelSession, daemonSession, otherWorkspaceSession],
  });
  mocks.snapshot.mockResolvedValue(null);
  mocks.projectedSnapshot.mockReturnValue(null);
  mocks.modelControl.mockResolvedValue({ available: true, snapshot: null });
  mocks.projectedModelControl.mockResolvedValue({ available: true, snapshot: null });
  mocks.activity.mockReturnValue({ commands: [], reports: [] });
});

describe("workbench session page scope", () => {
  it("reuses the parent workspace projection instead of refetching the session list", async () => {
    const parent = vi.fn().mockResolvedValue({
      sessions: [workspaceSession, channelSession],
      sessionsAvailable: true,
      activeWorkspace: { id: "ws_current" },
      sessionControlAvailable: true,
    });

    const result = await _loadSessionPage(
      {
        params: { sessionId: workspaceSession.sessionId },
        parent,
      } as never,
      "ws_current",
    );

    expect(result).toMatchObject({
      selectedSessionId: workspaceSession.sessionId,
      sendSubmissionIdSeed: expect.stringMatching(/^idem_/),
    });
    expect(result).not.toHaveProperty("sessions");
    expect(parent).toHaveBeenCalledOnce();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.projectedSnapshot).toHaveBeenCalledWith(workspaceSession.sessionId);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.modelControl).not.toHaveBeenCalled();
    expect(mocks.projectedModelControl).toHaveBeenCalledWith({ workspaceId: "ws_current" });
    expect(mocks.activity).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ workspaceId: "ws_current" }),
    );
  });

  it("paints from the projected snapshot without waiting on live RPC", async () => {
    mocks.projectedSnapshot.mockReturnValue({
      snapshot: { sessionId: workspaceSession.sessionId, messages: [] },
      history: { earlierMessages: 0, laterMessages: 0, hasEarlierMessages: false },
    });
    const parent = vi.fn().mockResolvedValue({
      sessions: [workspaceSession],
      sessionsAvailable: true,
      activeWorkspace: { id: "ws_current" },
      sessionControlAvailable: true,
    });

    const result = await _loadSessionPage(
      {
        params: { sessionId: workspaceSession.sessionId },
        parent,
      } as never,
      "ws_current",
    );

    expect(result.sessionSnapshot).toEqual({
      sessionId: workspaceSession.sessionId,
      messages: [],
    });
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.modelControl).not.toHaveBeenCalled();
    expect(mocks.projectedModelControl).toHaveBeenCalledWith({ workspaceId: "ws_current" });
  });

  it("does not expose a daemon-global direct URL", async () => {
    const parent = vi.fn().mockResolvedValue({
      sessions: [workspaceSession, channelSession, daemonSession],
      sessionsAvailable: true,
      activeWorkspace: { id: "ws_current" },
      sessionControlAvailable: true,
    });

    await expect(
      _loadSessionPage({ params: { sessionId: daemonSession.sessionId }, parent } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.modelControl).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it("does not restore a detached workspace session through a direct URL", async () => {
    const parent = vi.fn().mockResolvedValue({
      sessions: [workspaceSession, channelSession, otherWorkspaceSession],
      sessionsAvailable: true,
      activeWorkspace: { id: "ws_current" },
      sessionControlAvailable: true,
    });

    await expect(
      _loadSessionPage({
        params: { sessionId: otherWorkspaceSession.sessionId },
        parent,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.modelControl).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it("keeps an offline cached session readable while disabling assignment", async () => {
    const parent = vi.fn().mockResolvedValue({
      sessions: [workspaceSession],
      sessionsAvailable: true,
      activeWorkspace: { id: "ws_current" },
      sessionControlAvailable: false,
    });

    const result = await _loadSessionPage(
      {
        params: { sessionId: workspaceSession.sessionId },
        parent,
      } as never,
      "ws_current",
    );

    expect(result).toMatchObject({
      selectedSession: workspaceSession,
      canAssign: false,
    });
    expect(result).not.toHaveProperty("sessionControlAvailable");
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.modelControl).not.toHaveBeenCalled();
    expect(mocks.projectedSnapshot).toHaveBeenCalledWith(workspaceSession.sessionId);
    expect(mocks.projectedModelControl).toHaveBeenCalledWith({ workspaceId: "ws_current" });
  });
});
