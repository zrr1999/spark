import { describe, expect, it, vi } from "vitest";
import { RuntimeDeviceAuthorizationError } from "@zendev-lab/spark-coordination/runtime-registration";

const mocks = vi.hoisted(() => ({
  createRuntimeDeviceAuthorization: vi.fn(),
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

vi.mock("$lib/server/runtime-registration", async () => ({
  ...(await vi.importActual("@zendev-lab/spark-coordination/runtime-registration")),
  createRuntimeDeviceAuthorization: mocks.createRuntimeDeviceAuthorization,
}));

import { POST } from "../../routes/api/v1/runtime/device-authorizations/+server";

const authorizationRequest = {
  installationId: "install-test",
  displayName: "Test Spark daemon",
  runtimeVersion: "0.1.0-test",
  supportedFeatures: ["ws-control-v1"],
  labels: { test: "true" },
};

describe("runtime device authorization route", () => {
  it.each([
    ["too_many_pending_authorizations", 429],
    ["authorization_capacity_exceeded", 503],
  ] as const)("maps %s to HTTP %s", async (reasonCode, status) => {
    mocks.createRuntimeDeviceAuthorization.mockImplementationOnce(() => {
      throw new RuntimeDeviceAuthorizationError("Device authorization rejected.", reasonCode);
    });

    const response = await postAuthorization();

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: reasonCode,
        message: "Device authorization rejected.",
        requestId: "req-device-test",
      },
    });
  });
});

async function postAuthorization(): Promise<Response> {
  const url = new URL("http://localhost/api/v1/runtime/device-authorizations");
  const response = await POST({
    request: new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authorizationRequest),
    }),
    locals: { requestId: "req-device-test" },
    url,
  } as Parameters<typeof POST>[0]);
  return response as Response;
}
