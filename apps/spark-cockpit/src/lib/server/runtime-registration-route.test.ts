import { describe, expect, it, vi } from "vitest";
import { RuntimeWorkspaceLeaseConflictError } from "@zendev-lab/spark-coordination/runtime-registration";

const mocks = vi.hoisted(() => ({
  registerRuntime: vi.fn(),
  registerRuntimeWorkspace: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({
  getDatabase: () => ({}),
}));

vi.mock("$lib/server/json", () => ({
  errorJson: (
    code: string,
    message: string,
    status: number,
    _details: unknown,
    requestId: string,
  ) => Response.json({ error: { code, message, requestId } }, { status }),
}));

vi.mock("@zendev-lab/spark-coordination/runtime-registration", async () => ({
  ...(await vi.importActual("@zendev-lab/spark-coordination/runtime-registration")),
  registerRuntime: mocks.registerRuntime,
  registerRuntimeWorkspace: mocks.registerRuntimeWorkspace,
}));

import { POST as registerRuntimePost } from "../../routes/api/v1/runtime/runtimes/register/+server";
import { POST as registerWorkspacePost } from "../../routes/api/v1/runtime/runtimes/[runtimeId]/workspaces/register/+server";

const conflict = new RuntimeWorkspaceLeaseConflictError({
  workspaceId: "ws_00000000000000000000000000000000",
  currentRuntimeId: "rt_00000000000000000000000000000000",
  currentBindingId: "rtwb_00000000000000000000000000000000",
  attemptedRuntimeId: "rt_11111111111111111111111111111111",
  attemptedBindingId: "rtwb_11111111111111111111111111111111",
  occurredAt: "2026-07-15T00:00:00.000Z",
});

describe("runtime registration lease conflict routes", () => {
  it("maps initial runtime registration conflict to HTTP 409", async () => {
    mocks.registerRuntime.mockImplementationOnce(() => {
      throw conflict;
    });
    const url = new URL("http://localhost/api/v1/runtime/runtimes/register");
    const response = (await registerRuntimePost({
      request: new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer spark_wsreg_route_test_marker",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          installationId: "install-conflict",
          displayName: "Conflict daemon",
          runtimeVersion: "0.1.0-test",
          supportedFeatures: [],
          labels: {},
          workspaceRegistration: {
            localWorkspaceKey: "conflict-local",
            displayName: "Conflict workspace",
          },
        }),
      }),
      locals: { requestId: "req-runtime-conflict" },
      url,
    } as Parameters<typeof registerRuntimePost>[0])) as Response;

    await expectLeaseConflictResponse(response, "req-runtime-conflict");
  });

  it("maps authenticated workspace registration conflict to HTTP 409", async () => {
    mocks.registerRuntimeWorkspace.mockImplementationOnce(() => {
      throw conflict;
    });
    const url = new URL(
      "http://localhost/api/v1/runtime/runtimes/rt_11111111111111111111111111111111/workspaces/register",
    );
    const response = (await registerWorkspacePost({
      params: { runtimeId: "rt_11111111111111111111111111111111" },
      request: new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer spark_rt_route_test_marker",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          registrationToken: "spark_wsreg_route_workspace_marker",
          workspaceRegistration: {
            localWorkspaceKey: "conflict-local",
            displayName: "Conflict workspace",
            workspaceSlug: "conflict-workspace",
          },
        }),
      }),
      locals: { requestId: "req-workspace-conflict" },
    } as Parameters<typeof registerWorkspacePost>[0])) as Response;

    await expectLeaseConflictResponse(response, "req-workspace-conflict");
  });
});

async function expectLeaseConflictResponse(response: Response, requestId: string): Promise<void> {
  expect(response.status).toBe(409);
  // Primary HTTP code is workspace_lease_conflict; aliasReasonCode remains WORKSPACE_OWNER_CONFLICT.
  await expect(response.json()).resolves.toEqual({
    error: {
      code: "workspace_lease_conflict",
      message: "Workspace already has an active origin lease.",
      requestId,
    },
  });
}
