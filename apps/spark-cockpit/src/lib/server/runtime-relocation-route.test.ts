import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeRelocationPreflightError } from "@zendev-lab/spark-coordination/runtime-registration";
import { runtimeProtocolVersion } from "@zendev-lab/spark-protocol";

const instanceId = "cockpit_11111111111111111111111111111111";
const runtimeId = "rt_11111111111111111111111111111111";
const mocks = vi.hoisted(() => ({
  preflightCockpitRuntimeRelocation: vi.fn(),
  cockpitRuntimeRelocationInstanceId: vi.fn(),
}));

vi.mock("$lib/server/json", () => ({
  errorJson: (code: string, message: string, status: number) =>
    Response.json({ error: { code, message } }, { status }),
}));
vi.mock("$lib/server/runtime-relocation", async () => ({
  ...(await vi.importActual("@zendev-lab/spark-coordination/runtime-registration")),
  preflightCockpitRuntimeRelocation: mocks.preflightCockpitRuntimeRelocation,
  cockpitRuntimeRelocationInstanceId: mocks.cockpitRuntimeRelocationInstanceId,
}));

import { GET as metadataGet } from "../../routes/api/v1/runtime/relocation/metadata/+server";
import { POST as preflightPost } from "../../routes/api/v1/runtime/relocation/preflight/+server";

describe("runtime relocation routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only non-secret Cockpit instance metadata", async () => {
    mocks.cockpitRuntimeRelocationInstanceId.mockReturnValueOnce(instanceId);
    const response = (await metadataGet({
      locals: { requestId: "req-metadata" },
    } as Parameters<typeof metadataGet>[0])) as Response;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      instanceId,
      protocolVersion: runtimeProtocolVersion,
    });
  });

  it("rotates a matching restored runtime and returns same-origin WSS metadata", async () => {
    mocks.cockpitRuntimeRelocationInstanceId.mockReturnValueOnce(instanceId);
    mocks.preflightCockpitRuntimeRelocation.mockReturnValueOnce({
      runtimeId,
      runtimeToken: "runtime-token-rotated-00000000000000000000",
      runtimeTokenExpiresAt: "2026-07-15T01:00:00.000Z",
      refreshToken: "refresh-token-rotated-00000000000000000000",
      refreshTokenExpiresAt: "2026-08-15T00:00:00.000Z",
      refreshedAt: "2026-07-15T00:00:00.000Z",
    });
    const url = new URL("https://target.example.test/api/v1/runtime/relocation/preflight");
    const payload = {
      sourceInstanceId: instanceId,
      runtimeId,
      installationId: "install-relocation",
      refreshToken: "refresh-token-source-000000000000000000000",
    };
    const response = (await preflightPost({
      request: new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      url,
      locals: { requestId: "req-preflight" },
    } as Parameters<typeof preflightPost>[0])) as Response;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      instanceId,
      runtimeId,
      webSocketUrl: `wss://target.example.test/api/v1/runtime/runtimes/${runtimeId}/ws`,
    });
    expect(mocks.preflightCockpitRuntimeRelocation).toHaveBeenCalledWith(payload);
  });

  it.each([
    ["http", "http://target.example.test", 400, "relocation_https_required"],
    ["instance mismatch", "https://target.example.test", 409, "relocation_instance_mismatch"],
  ] as const)("rejects %s before credential rotation", async (_name, origin, status, code) => {
    mocks.cockpitRuntimeRelocationInstanceId.mockReturnValueOnce(instanceId);
    if (code === "relocation_instance_mismatch") {
      mocks.preflightCockpitRuntimeRelocation.mockImplementationOnce(() => {
        throw new RuntimeRelocationPreflightError(
          "Target Cockpit instance does not match the source instance.",
          code,
        );
      });
    }
    const url = new URL("/api/v1/runtime/relocation/preflight", origin);
    const response = (await preflightPost({
      request: new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceInstanceId: instanceId,
          runtimeId,
          installationId: "install-relocation",
          refreshToken: "refresh-token-source-000000000000000000000",
        }),
      }),
      url,
      locals: { requestId: "req-reject" },
    } as Parameters<typeof preflightPost>[0])) as Response;
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(mocks.preflightCockpitRuntimeRelocation).toHaveBeenCalledTimes(
      code === "relocation_instance_mismatch" ? 1 : 0,
    );
  });
});
