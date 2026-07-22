import { describe, expect, it } from "vitest";
import { localRpcMethodToSparkCommandKind } from "./command-events.ts";
import {
  sparkLocalRpcOrpcContract,
  sparkLocalRpcOrpcLiveMethods,
  sparkLocalRpcOrpcMethodPaths,
  type SparkLocalRpcOrpcMethod,
} from "./local-rpc-orpc-contract.ts";

function resolveContractPath(path: readonly string[]): unknown {
  let cursor: unknown = sparkLocalRpcOrpcContract;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

describe("sparkLocalRpcOrpcContract (Phase 4)", () => {
  it("covers every local-rpc method mapped in command events", () => {
    const commandMethods = Object.keys(localRpcMethodToSparkCommandKind).sort();
    const contractMethods = Object.keys(sparkLocalRpcOrpcMethodPaths).sort();
    expect(contractMethods).toEqual(commandMethods);
  });

  it("nests contracts under domain routers matching method path map", () => {
    for (const [method, path] of Object.entries(sparkLocalRpcOrpcMethodPaths)) {
      expect(resolveContractPath(path), method).toBeTruthy();
    }
  });

  it("keeps a live half-migration allowlist of at least ten methods", () => {
    expect(sparkLocalRpcOrpcLiveMethods.length).toBeGreaterThanOrEqual(10);
    for (const method of sparkLocalRpcOrpcLiveMethods) {
      expect(sparkLocalRpcOrpcMethodPaths[method as SparkLocalRpcOrpcMethod]).toBeTruthy();
    }
  });

  it("keeps spike leaves for daemon/workspace/uplink/model", () => {
    expect(sparkLocalRpcOrpcContract.daemon.status).toBeDefined();
    expect(sparkLocalRpcOrpcContract.daemon.stop).toBeDefined();
    expect(sparkLocalRpcOrpcContract.workspace.list).toBeDefined();
    expect(sparkLocalRpcOrpcContract.uplink.status).toBeDefined();
    expect(sparkLocalRpcOrpcContract.model.catalog).toBeDefined();
  });
});
