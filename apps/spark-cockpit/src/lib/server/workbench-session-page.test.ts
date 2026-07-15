import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  snapshot: vi.fn(),
  modelControl: vi.fn(),
  activity: vi.fn(),
}));

vi.mock("$lib/server/managed-sessions", () => ({
  archiveManagedSessionForCockpit: vi.fn(),
  createManagedSessionForCockpit: vi.fn(),
  getManagedSessionForCockpit: mocks.get,
  getManagedSessionSnapshotForCockpit: mocks.snapshot,
  listManagedSessionsForCockpit: mocks.list,
}));

vi.mock("$lib/server/db", () => ({ getDatabase: () => ({}) }));
vi.mock("$lib/server/events", () => ({ latestEventCursor: () => null }));
vi.mock("$lib/server/session-activity", () => ({ loadSessionActivity: mocks.activity }));
vi.mock("$lib/session-snapshot-window", () => ({
  sessionSnapshotWindow: (snapshot: unknown) => ({ snapshot, history: null }),
}));
vi.mock("$lib/server/model-control", () => ({
  loadModelControlForCockpit: mocks.modelControl,
  modelValue: vi.fn(),
  parseModelValue: vi.fn(),
  parseThinkingLevelValue: vi.fn(),
  setSessionModelForCockpit: vi.fn(),
  setSessionThinkingLevelForCockpit: vi.fn(),
}));
vi.mock("../../routes/(workbench)/sessions/+page.server", () => ({ actions: {} }));

import { load } from "../../routes/(workbench)/sessions/[sessionId]/+page.server";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({
    available: true,
    sessions: [workspaceSession, channelSession, daemonSession],
  });
  mocks.snapshot.mockResolvedValue(null);
  mocks.modelControl.mockResolvedValue({ available: true, snapshot: null });
  mocks.activity.mockReturnValue({ commands: [], reports: [] });
});

describe("workbench session page scope", () => {
  it("keeps workspace and channel sessions while removing daemon-global registry records", async () => {
    mocks.get.mockResolvedValue(workspaceSession);

    const result = await load({ params: { sessionId: workspaceSession.sessionId } } as never);

    expect(result).toMatchObject({
      sessions: [workspaceSession, channelSession],
      selectedSessionId: workspaceSession.sessionId,
    });
    expect(mocks.activity).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ workspaceId: "ws_current" }),
    );
  });

  it("does not expose a daemon-global session through a stale direct URL", async () => {
    mocks.get.mockResolvedValue(daemonSession);

    await expect(
      load({ params: { sessionId: daemonSession.sessionId } } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.activity).not.toHaveBeenCalled();
  });
});
