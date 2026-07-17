import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  conversationSummaries: vi.fn(),
  getProjected: vi.fn(),
  list: vi.fn(),
  pendingAsk: vi.fn(),
  shellLayout: vi.fn(),
}));

vi.mock("$lib/server/conversation-summaries", () => ({
  loadConversationSummaries: mocks.conversationSummaries,
}));
vi.mock("$lib/server/db", () => ({ getDatabase: () => ({}) }));
vi.mock("$lib/server/managed-sessions", () => ({
  getProjectedManagedSessionForCockpit: mocks.getProjected,
  listManagedSessionsForCockpit: mocks.list,
}));
vi.mock("$lib/server/pending-ask", () => ({
  loadPendingWorkbenchAsk: mocks.pendingAsk,
}));
vi.mock("$lib/server/shell-layout", () => ({
  loadShellWorkspaceLayout: mocks.shellLayout,
}));
vi.mock("$lib/workbench-session-scope", () => ({
  workspaceIdForWorkbenchSession: (session: typeof cachedSession) => session.workspaceId ?? null,
  workspaceSessionsForWorkbench: (sessions: (typeof cachedSession)[]) => sessions,
}));

import { load } from "../../routes/(workbench)/+layout.server";

const workspace = {
  id: "ws_cached",
  slug: "cached",
  name: "Cached workspace",
};

const cachedSession = {
  sessionId: "sess_cached",
  scope: { kind: "workspace" as const, workspaceId: workspace.id },
  workspaceId: workspace.id,
  title: "Cached conversation",
  status: "ready" as const,
  bindings: [],
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProjected.mockReturnValue(cachedSession);
  mocks.shellLayout.mockReturnValue({
    workspaces: [workspace],
    activeWorkspace: workspace,
  });
  mocks.list.mockResolvedValue({
    available: true,
    controlAvailable: false,
    sessions: [cachedSession],
  });
  mocks.conversationSummaries.mockImplementation((_db, sessions) => sessions);
  mocks.pendingAsk.mockReturnValue(null);
});

describe("workbench session layout scope", () => {
  it("loads only the selected workspace and preserves cached sessions when its owner is offline", async () => {
    const url = new URL("http://localhost:5173/sessions/sess_cached");
    const result = await load({ cookies: {}, url } as never);

    expect(mocks.shellLayout).toHaveBeenCalledWith(
      expect.objectContaining({ preferredWorkspaceId: workspace.id }),
    );
    expect(mocks.list).toHaveBeenCalledWith({
      scope: { kind: "workspace", workspaceId: workspace.id },
      workspaceId: workspace.id,
    });
    expect(result).toMatchObject({
      activeWorkspace: workspace,
      sessions: [cachedSession],
      sessionsAvailable: true,
      sessionControlAvailable: false,
    });
  });
});
