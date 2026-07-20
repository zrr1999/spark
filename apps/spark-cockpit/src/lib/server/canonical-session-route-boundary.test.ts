import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({})),
  listLoad: vi.fn(),
  detailLoad: vi.fn(),
  requireWorkspaceByRouteId: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("$lib/server/workspace-routing", () => ({
  requireWorkspaceByRouteId: mocks.requireWorkspaceByRouteId,
}));
vi.mock("../../routes/(workbench)/sessions/+page.server", () => ({
  actions: {},
  _loadSessionsPage: mocks.listLoad,
}));
vi.mock("../../routes/(workbench)/sessions/[sessionId]/+page.server", () => ({
  _loadSessionPage: mocks.detailLoad,
}));

import { load as loadCanonicalList } from "../../routes/(workbench)/[workspaceId]/sessions/+page.server";
import { load as loadCanonicalDetail } from "../../routes/(workbench)/[workspaceId]/sessions/[sessionId]/+page.server";

describe("canonical workspace session route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkspaceByRouteId.mockReturnValue({
      id: "ws_demo",
      slug: "demo",
      name: "Demo",
    });
    mocks.listLoad.mockResolvedValue({ selectedSessionId: null });
    mocks.detailLoad.mockResolvedValue({ selectedSessionId: "sess_demo" });
  });

  it("resolves the active route workspace before loading list or detail data", async () => {
    const listEvent = routeEvent("demo");
    const detailEvent = routeEvent("demo", "sess_demo");

    await expect(loadCanonicalList(listEvent as never)).resolves.toEqual({
      selectedSessionId: null,
    });
    await expect(loadCanonicalDetail(detailEvent as never)).resolves.toEqual({
      selectedSessionId: "sess_demo",
    });

    expect(mocks.listLoad).toHaveBeenCalledWith(listEvent, "ws_demo");
    expect(mocks.detailLoad).toHaveBeenCalledWith(detailEvent, "ws_demo");
  });

  it("returns 404 for an unknown or archived route without loading parent state", async () => {
    const routeError = Object.assign(new Error("Workspace not found."), { status: 404 });
    mocks.requireWorkspaceByRouteId.mockImplementation(() => {
      throw routeError;
    });
    const parent = vi.fn();

    await expect(
      loadCanonicalList({ ...routeEvent("archived"), parent } as never),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      loadCanonicalDetail({ ...routeEvent("missing", "sess_missing"), parent } as never),
    ).rejects.toMatchObject({ status: 404 });

    expect(parent).not.toHaveBeenCalled();
    expect(mocks.listLoad).not.toHaveBeenCalled();
    expect(mocks.detailLoad).not.toHaveBeenCalled();
  });
});

function routeEvent(workspaceId: string, sessionId?: string) {
  return {
    params: { workspaceId, ...(sessionId ? { sessionId } : {}) },
    parent: vi.fn(),
    url: new URL(`http://localhost/${workspaceId}/sessions${sessionId ? `/${sessionId}` : ""}`),
  };
}
