import { describe, expect, it } from "vitest";
import {
  sparkLocalRpcOrpcContract,
  sparkLocalRpcOrpcMethodPaths,
  type SparkLocalRpcOrpcSpikeMethod,
} from "./local-rpc-orpc-contract.ts";

describe("sparkLocalRpcOrpcContract (Phase 4 spike)", () => {
  it("exposes exactly five representative local-rpc methods", () => {
    const methods = Object.keys(sparkLocalRpcOrpcMethodPaths) as SparkLocalRpcOrpcSpikeMethod[];
    expect(methods.sort()).toEqual(
      ["daemon.status", "daemon.stop", "model.catalog", "uplink.status", "workspace.list"].sort(),
    );
  });

  it("nests contracts under domain routers matching method path map", () => {
    for (const [method, path] of Object.entries(sparkLocalRpcOrpcMethodPaths)) {
      const [domain, procedure] = path;
      expect(domain, method).toBeTruthy();
      expect(procedure, method).toBeTruthy();
      const domainRouter =
        sparkLocalRpcOrpcContract[domain as keyof typeof sparkLocalRpcOrpcContract];
      expect(domainRouter, method).toBeTruthy();
      expect((domainRouter as Record<string, unknown>)[procedure as string], method).toBeTruthy();
    }
  });

  it("keeps daemon.status / daemon.stop / workspace.list / uplink.status / model.catalog leaves", () => {
    expect(sparkLocalRpcOrpcContract.daemon.status).toBeDefined();
    expect(sparkLocalRpcOrpcContract.daemon.stop).toBeDefined();
    expect(sparkLocalRpcOrpcContract.workspace.list).toBeDefined();
    expect(sparkLocalRpcOrpcContract.uplink.status).toBeDefined();
    expect(sparkLocalRpcOrpcContract.model.catalog).toBeDefined();
  });
});
