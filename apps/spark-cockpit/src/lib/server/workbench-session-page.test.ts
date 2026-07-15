import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cursor: vi.fn(),
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
vi.mock("$lib/server/events", () => ({ latestEventCursor: mocks.cursor }));
vi.mock("$lib/server/session-activity", () => ({ loadSessionActivity: mocks.activity }));
vi.mock("$lib/session-snapshot-window", () => ({
  sessionSnapshotWindow: (snapshot: unknown) => ({
    snapshot,
    history: snapshot ? { hasEarlier: true, nextBefore: "cursor-before" } : null,
  }),
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
  mocks.cursor.mockReturnValue(null);
  mocks.modelControl.mockResolvedValue({ available: true, snapshot: null });
  mocks.activity.mockReturnValue({ commands: [], reports: [] });
});

describe("workbench session page scope", () => {
  it("keeps workspace, channel, and daemon-global registry records in the conversation rail", async () => {
    mocks.get.mockResolvedValue(workspaceSession);

    const result = await load({
      params: { sessionId: workspaceSession.sessionId },
      parent: async () => ({ activeWorkspace: { id: "ws_current" } }),
    } as never);

    expect(result).toMatchObject({
      sessions: [workspaceSession, channelSession, daemonSession],
      selectedSessionId: workspaceSession.sessionId,
    });
    expect(mocks.activity).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ workspaceId: "ws_current" }),
    );
  });

  it("opens a daemon-global conversation without querying workspace activity", async () => {
    mocks.get.mockResolvedValue(daemonSession);
    mocks.snapshot.mockResolvedValue({ sessionId: daemonSession.sessionId, messages: [] });
    mocks.cursor.mockReturnValue({
      createdAt: "2026-07-15T00:01:00.000Z",
      id: "evt-global",
    });

    await expect(
      load({
        params: { sessionId: daemonSession.sessionId },
        parent: async () => ({ activeWorkspace: { id: "ws_current" } }),
      } as never),
    ).resolves.toMatchObject({
      sessions: [workspaceSession, channelSession, daemonSession],
      selectedSessionId: daemonSession.sessionId,
      sessionEventCursor: "2026-07-15T00:01:00.000Z|evt-global",
      sessionHistory: { hasEarlier: true, nextBefore: "cursor-before" },
      sessionActivity: { commands: [], reports: [] },
    });
    expect(mocks.activity).not.toHaveBeenCalled();
  });
});
