import { describe, expect, it, vi } from "vitest";
import {
  LEASE_TRANSFER_TIMEOUT_MS,
  leaseTransferDecisionFromAnswers,
  SparkDaemonLeaseTransferBroker,
} from "./lease-transfer.ts";

describe("SparkDaemonLeaseTransferBroker", () => {
  it("auto-authorizes when no session responds before timeout", async () => {
    vi.useFakeTimers();
    const broker = new SparkDaemonLeaseTransferBroker();
    const { request, settlement } = broker.request({
      workspaceId: "ws_1",
      workspaceDisplayName: "spark",
      previousServerUrl: "http://127.0.0.1:5173/",
      targetServerUrl: "http://127.0.0.1:5174/",
      timeoutMs: 1_000,
      now: "2026-05-26T00:00:00.000Z",
    });
    expect(request.transferId).toMatch(/^xfer_/);
    expect(broker.pendingForWorkspace("ws_1")?.transferId).toBe(request.transferId);

    const pending = settlement;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({
      transferId: request.transferId,
      decision: "auto-authorize",
      source: "timeout",
    });
    expect(broker.pendingForWorkspace("ws_1")).toBeNull();
    vi.useRealTimers();
  });

  it("accepts an explicit reject from any occupying surface", async () => {
    const broker = new SparkDaemonLeaseTransferBroker();
    const { request, settlement } = broker.request({
      workspaceId: "ws_1",
      workspaceDisplayName: "spark",
      previousServerUrl: "http://127.0.0.1:5173/",
      targetServerUrl: "http://127.0.0.1:5174/",
      timeoutMs: LEASE_TRANSFER_TIMEOUT_MS,
    });
    expect(broker.respond(request.transferId, "reject", "tui")).toMatchObject({
      decision: "reject",
      source: "tui",
    });
    await expect(settlement).resolves.toMatchObject({ decision: "reject", source: "tui" });
  });

  it("maps cockpit human answers onto accept/reject", () => {
    expect(leaseTransferDecisionFromAnswers("answered", { decision: "accept" })).toBe("accept");
    expect(leaseTransferDecisionFromAnswers("answered", { decision: "reject" })).toBe("reject");
    expect(leaseTransferDecisionFromAnswers("cancelled", {})).toBe("reject");
  });
});
