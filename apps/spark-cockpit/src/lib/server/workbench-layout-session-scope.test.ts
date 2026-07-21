import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  conversationSummaries: vi.fn(),
  getProjected: vi.fn(),
  list: vi.fn(),
  projectedList: vi.fn(),
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
  listProjectedManagedSessionsForCockpit: mocks.projectedList,
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
  mocks.projectedList.mockReturnValue({
    available: true,
    controlAvailable: false,
    sessions: [cachedSession],
  });
  mocks.conversationSummaries.mockImplementation((_db, sessions) => sessions);
  mocks.pendingAsk.mockReturnValue(null);
});

describe("workbench session layout scope", () => {
  it("paints the rail from the projected list without waiting on live session.list", async () => {
    const url = new URL("http://localhost:5173/sessions/sess_cached");
    const result = await load({
      cookies: {},
      url,
      params: {},
      route: { id: "/(workbench)/sessions/[sessionId]" },
    } as never);

    expect(mocks.shellLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/sessions",
        preferredWorkspaceId: null,
      }),
    );
    expect(mocks.projectedList).toHaveBeenCalledWith({ workspaceId: workspace.id });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      activeWorkspace: workspace,
      sessions: [cachedSession],
      sessionsAvailable: true,
      sessionControlAvailable: false,
    });
  });

  it("loads the session rail from workspaceId without depending on the session path", async () => {
    const url = new URL("http://localhost:5173/cached/sessions/sess_cached");
    const result = await load({
      cookies: {},
      url,
      params: { workspaceId: "cached" },
      route: { id: "/(workbench)/[workspaceId]/sessions/[sessionId]" },
    } as never);

    expect(mocks.shellLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/cached",
        preferredWorkspaceId: null,
        preferredWorkspaceSlug: "cached",
      }),
    );
    expect(mocks.list).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sessions: [cachedSession],
      sessionsAvailable: true,
      sessionControlAvailable: false,
    });
  });

  it("falls back to live session.list only when the projection is empty", async () => {
    mocks.projectedList.mockReturnValue({
      available: true,
      controlAvailable: false,
      sessions: [],
    });
    mocks.list.mockResolvedValue({
      available: true,
      controlAvailable: true,
      sessions: [cachedSession],
    });
    const url = new URL("http://localhost:5173/sessions/sess_cached");

    const result = await load({
      cookies: {},
      locals: { workspaceId: workspace.id },
      url,
      params: {},
      route: { id: "/(workbench)/sessions/[sessionId]" },
    } as never);

    expect(mocks.list).toHaveBeenCalledWith({
      scope: { kind: "workspace", workspaceId: workspace.id },
      workspaceId: workspace.id,
      timeoutMs: 800,
    });
    expect(result).toMatchObject({
      sessions: [cachedSession],
      sessionControlAvailable: true,
    });
  });
});
