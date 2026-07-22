import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOrpc: vi.fn(),
  invokeOrpc: vi.fn(),
  legacyRequest: vi.fn(),
}));

vi.mock("@zendev-lab/spark-system/daemon-local-rpc-orpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zendev-lab/spark-system/daemon-local-rpc-orpc")>()),
  createSparkDaemonOrpcClient: mocks.createOrpc,
  invokeSparkDaemonOrpcLiveMethod: mocks.invokeOrpc,
  isSparkDaemonOrpcLiveMethod: () => true,
}));

vi.mock("@zendev-lab/spark-system/daemon-local-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zendev-lab/spark-system/daemon-local-rpc")>()),
  requestSparkDaemonLocalRpcWire: mocks.legacyRequest,
}));

import { requestSparkDaemonControl } from "../apps/spark-tui/src/cli/daemon.ts";

const client = {
  paths: {
    runtimeDir: "/tmp/spark-control-transport",
    socketPath: "/tmp/spark-control-transport/daemon.sock",
    pidFile: "/tmp/spark-control-transport/daemon.pid",
    lockPath: "/tmp/spark-control-transport/daemon.lock",
  },
  startService: vi.fn(),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("daemon control transport migration", () => {
  it("falls back before dispatch when the oRPC socket is unavailable", async () => {
    mocks.createOrpc.mockRejectedValueOnce(new Error("connect ENOENT"));
    mocks.legacyRequest.mockResolvedValueOnce({ source: "legacy" });

    await expect(
      requestSparkDaemonControl("side-thread.ensure", { parentSessionId: "parent" }, client),
    ).resolves.toEqual({ source: "legacy" });
    expect(mocks.invokeOrpc).not.toHaveBeenCalled();
    expect(mocks.legacyRequest).toHaveBeenCalledOnce();
  });

  it("does not replay an unknown oRPC mutation outcome over the legacy socket", async () => {
    const close = vi.fn();
    mocks.createOrpc.mockResolvedValueOnce({ client: {}, close });
    mocks.invokeOrpc.mockRejectedValueOnce(new Error("connection closed after dispatch"));

    await expect(
      requestSparkDaemonControl(
        "side-thread.reset",
        { parentSessionId: "parent", expectedGeneration: 1, mode: "contextual" },
        client,
      ),
    ).rejects.toThrow("connection closed after dispatch");
    expect(mocks.legacyRequest).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns a live oRPC result and closes its one-shot transport", async () => {
    const close = vi.fn();
    mocks.createOrpc.mockResolvedValueOnce({ client: {}, close });
    mocks.invokeOrpc.mockResolvedValueOnce({ source: "orpc" });

    await expect(
      requestSparkDaemonControl("side-thread.snapshot", { parentSessionId: "parent" }, client),
    ).resolves.toEqual({ source: "orpc" });
    expect(mocks.legacyRequest).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
