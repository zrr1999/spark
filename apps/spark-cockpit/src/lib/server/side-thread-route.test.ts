import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeControlCommandError } from "@zendev-lab/spark-cockpit-coordination/runtime-control";
import { CockpitRuntimeSessionUnavailableError } from "./cockpit-runtime-session-client";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  snapshot: vi.fn(),
  control: vi.fn(),
  client: {
    ensureSideThread: vi.fn(),
    submitSideThread: vi.fn(),
    resetSideThread: vi.fn(),
    configureSideThread: vi.fn(),
    handoffSideThread: vi.fn(),
  },
}));

vi.mock("$lib/server/managed-sessions", () => ({
  getManagedSessionForCockpit: mocks.get,
  getLiveManagedSessionForCockpit: mocks.get,
  getManagedSideThreadSnapshotForCockpit: mocks.snapshot,
  controlManagedSideThreadForCockpit: mocks.control,
}));

vi.mock("$lib/workbench-session-scope", () => ({
  workspaceIdForWorkbenchSession: (session: { scope?: { kind?: string; workspaceId?: string } }) =>
    session.scope?.kind === "workspace" ? (session.scope.workspaceId ?? null) : null,
}));

import { GET, POST } from "../../routes/api/v1/sessions/[sessionId]/side-thread/+server";

const parent = {
  sessionId: "sess_workspace",
  scope: { kind: "workspace", workspaceId: "ws_current" },
  status: "ready",
  updatedAt: "2026-07-22T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(parent);
  mocks.control.mockImplementation(
    async (
      _sessionId: string,
      _workspaceId: string,
      command: (client: typeof mocks.client) => unknown,
    ) => await command(mocks.client),
  );
  mocks.client.ensureSideThread.mockResolvedValue({ generation: 1 });
  mocks.client.submitSideThread.mockResolvedValue({ invocationId: "inv_1" });
  mocks.client.resetSideThread.mockResolvedValue({ generation: 2 });
  mocks.client.configureSideThread.mockResolvedValue({ generation: 2 });
  mocks.client.handoffSideThread.mockResolvedValue({ parentInvocationId: "inv_parent" });
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

  it.each([
    ["GET", GET],
    ["POST", POST],
  ])(
    "returns 503 when the live owner is unavailable during %s authorization",
    async (method, route) => {
      mocks.get.mockRejectedValueOnce(new CockpitRuntimeSessionUnavailableError("daemon offline"));
      const response = await route({
        locals: { workspaceId: "ws_current" },
        params: { sessionId: parent.sessionId },
        url: new URL("http://localhost/api/v1/sessions/sess_workspace/side-thread"),
        request: new Request("http://localhost/api/v1/sessions/sess_workspace/side-thread", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "ensure" }),
        }),
      } as never);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "side_thread_unavailable" });
    },
  );

  it.each([
    [
      "ensure",
      { mode: "tangent" },
      "ensureSideThread",
      { parentSessionId: parent.sessionId, mode: "tangent" },
    ],
    [
      "submit",
      { expectedGeneration: 1, prompt: "investigate", idempotencyKey: "submit-1" },
      "submitSideThread",
      {
        parentSessionId: parent.sessionId,
        expectedGeneration: 1,
        prompt: "investigate",
        idempotencyKey: "submit-1",
      },
    ],
    [
      "reset",
      { expectedGeneration: 1, mode: "contextual" },
      "resetSideThread",
      { parentSessionId: parent.sessionId, expectedGeneration: 1, mode: "contextual" },
    ],
    [
      "configure",
      {
        expectedGeneration: 1,
        modelOverride: { providerName: "openai", modelId: "gpt" },
        thinkingOverride: "high",
      },
      "configureSideThread",
      {
        parentSessionId: parent.sessionId,
        expectedGeneration: 1,
        modelOverride: { providerName: "openai", modelId: "gpt" },
        thinkingOverride: "high",
      },
    ],
    [
      "handoff",
      {
        expectedGeneration: 1,
        expectedHeadExchangeId: "exchange-1",
        kind: "summary",
        instructions: "use this",
        idempotencyKey: "handoff-1",
      },
      "handoffSideThread",
      {
        parentSessionId: parent.sessionId,
        expectedGeneration: 1,
        expectedHeadExchangeId: "exchange-1",
        kind: "summary",
        instructions: "use this",
        idempotencyKey: "handoff-1",
      },
    ],
  ])("forwards %s through the daemon-owned controller", async (action, input, method, expected) => {
    const response = await POST({
      locals: { workspaceId: "ws_current" },
      params: { sessionId: parent.sessionId },
      request: new Request("http://localhost/api/v1/sessions/sess_workspace/side-thread", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...input }),
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(mocks.client[method as keyof typeof mocks.client]).toHaveBeenCalledWith(expected);
    expect(mocks.control).toHaveBeenCalledWith(
      parent.sessionId,
      "ws_current",
      expect.any(Function),
    );
  });

  it("keeps the authorized URL parent authoritative over a body override", async () => {
    const response = await POST({
      locals: { workspaceId: "ws_current" },
      params: { sessionId: parent.sessionId },
      request: new Request("http://localhost/api/v1/sessions/sess_workspace/side-thread", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "ensure",
          parentSessionId: "sess_foreign_workspace",
          mode: "tangent",
        }),
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(mocks.client.ensureSideThread).toHaveBeenCalledWith({
      parentSessionId: parent.sessionId,
      mode: "tangent",
    });
    expect(mocks.control).toHaveBeenCalledWith(
      parent.sessionId,
      "ws_current",
      expect.any(Function),
    );
  });

  it("rejects unknown actions without invoking the controller", async () => {
    const response = await POST({
      locals: { workspaceId: "ws_current" },
      params: { sessionId: parent.sessionId },
      request: new Request("http://localhost/api/v1/sessions/sess_workspace/side-thread", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "destroy" }),
      }),
    } as never);

    expect(response.status).toBe(400);
    expect(mocks.control).not.toHaveBeenCalled();
  });

  it.each([
    [new Request("http://localhost", { method: "POST", body: "{" }), "invalid JSON"],
    [
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "submit", expectedGeneration: 1 }),
      }),
      "invalid schema",
    ],
  ])("returns a stable 400 for %s", async (request, _label) => {
    const response = await POST({
      locals: { workspaceId: "ws_current" },
      params: { sessionId: parent.sessionId },
      request,
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_side_thread_action" });
  });

  it.each([
    ["side_thread_generation_conflict", 409, "side_thread_generation_conflict"],
    ["side_thread_head_conflict", 409, "side_thread_head_conflict"],
    ["side_thread_idempotency_conflict", 409, "side_thread_idempotency_conflict"],
    ["side_thread_busy", 409, "side_thread_busy"],
    ["side_thread_parent_archived", 409, "side_thread_parent_archived"],
    ["side_thread_nesting_forbidden", 409, "side_thread_nesting_forbidden"],
    ["side_thread_model_unavailable", 422, "side_thread_model_unavailable"],
    ["side_thread_handoff_too_large", 413, "side_thread_handoff_too_large"],
    ["side_thread_not_found", 404, "side_thread_not_found"],
    ["COMMAND_RESULT_TIMEOUT", 503, "side_thread_unavailable"],
  ])("maps daemon reason %s to stable HTTP response", async (reasonCode, status, error) => {
    mocks.control.mockRejectedValueOnce(
      new RuntimeControlCommandError("secret detail", reasonCode),
    );
    const response = await POST({
      locals: { workspaceId: "ws_current" },
      params: { sessionId: parent.sessionId },
      request: new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "ensure" }),
      }),
    } as never);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
  });

  it("returns 503 when the Side Thread snapshot times out", async () => {
    mocks.snapshot.mockRejectedValueOnce(
      new RuntimeControlCommandError("secret timeout detail", "COMMAND_RESULT_TIMEOUT"),
    );
    const response = await GET({
      locals: { workspaceId: "ws_current" },
      params: { sessionId: parent.sessionId },
      url: new URL("http://localhost/api/v1/sessions/sess_workspace/side-thread"),
    } as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "side_thread_unavailable" });
  });
});
