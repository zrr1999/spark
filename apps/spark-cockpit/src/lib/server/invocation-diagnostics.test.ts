import { describe, expect, it, vi } from "vitest";
import { SparkDaemonLocalRpcUnavailableError } from "@zendev-lab/spark-daemon-client";
import { loadInvocationDiagnosticsForCockpit } from "./invocation-diagnostics";

const NOW = "2026-07-15T12:00:00.000Z";

describe("Cockpit invocation diagnostics", () => {
  it("projects bounded daemon list status and recent events without owning invocation state", async () => {
    const client = diagnosticsClient();
    const result = await loadInvocationDiagnosticsForCockpit(
      {
        status: "failed",
        sessionId: " sess_target ",
        since: "2026-07-15T00:00:00.000Z",
        limit: 500,
        offset: 4,
        invocationId: "inv_selected0001",
      },
      client,
    );

    expect(result).toMatchObject({
      available: true,
      daemon: {
        invocations: { queued: 1, running: 2, succeeded: 10, failed: 3, cancelled: 1 },
        invocationHealth: {
          oldestQueuedAt: "2026-07-15T11:59:00.000Z",
          oldestRunningAt: "2026-07-15T11:58:00.000Z",
        },
      },
      list: { total: 3, limit: 100, offset: 4 },
      selected: {
        status: { invocationId: "inv_selected0001", status: "failed", eventCursor: 249 },
      },
    });
    expect(client.list).toHaveBeenCalledWith({
      status: "failed",
      sessionId: "sess_target",
      since: "2026-07-15T00:00:00.000Z",
      limit: 100,
      offset: 4,
    });
    expect(client.stream).toHaveBeenCalledWith("inv_selected0001", 149, 100);
  });

  it("degrades to an empty bounded projection when the daemon is unavailable", async () => {
    const client = diagnosticsClient();
    client.daemonStatus = vi.fn(async () => {
      throw new SparkDaemonLocalRpcUnavailableError("daemon unavailable");
    });

    await expect(
      loadInvocationDiagnosticsForCockpit({ status: "failed", limit: 25 }, client),
    ).resolves.toMatchObject({
      available: false,
      daemon: null,
      list: { invocations: [], total: 0, limit: 25, offset: 0 },
      selected: null,
      error: "daemon unavailable",
    });
    expect(client.status).not.toHaveBeenCalled();
    expect(client.stream).not.toHaveBeenCalled();
  });
});

function diagnosticsClient() {
  return {
    daemonStatus: vi.fn(async () => ({
      invocations: { queued: 1, running: 2, succeeded: 10, failed: 3, cancelled: 1 },
      invocationHealth: {
        oldestQueuedAt: "2026-07-15T11:59:00.000Z",
        oldestRunningAt: "2026-07-15T11:58:00.000Z",
      },
      lifecycle: { state: "running" },
      observedAt: NOW,
    })),
    list: vi.fn(async (input) => ({
      invocations: [
        {
          invocationId: "inv_selected0001",
          sessionId: "sess_target",
          status: "failed",
          attemptCount: 1,
          errorCode: "EXECUTION_FAILED",
          errorMessage: "failed",
          retryable: false,
          eventCursor: 249,
          createdAt: NOW,
          updatedAt: NOW,
          finishedAt: NOW,
        },
      ],
      total: 3,
      limit: input.limit,
      offset: input.offset,
      observedAt: NOW,
    })),
    status: vi.fn(async () => ({
      invocationId: "inv_selected0001",
      sessionId: "sess_target",
      status: "failed",
      createdAt: NOW,
      updatedAt: NOW,
      finishedAt: NOW,
      error: { code: "EXECUTION_FAILED", message: "failed" },
      eventCursor: 249,
    })),
    stream: vi.fn(async (_invocationId, after) => ({
      invocationId: "inv_selected0001",
      events: [
        {
          invocationId: "inv_selected0001",
          sequence: after + 1,
          kind: "daemon.task.lifecycle",
          payload: { status: "failed" },
          createdAt: NOW,
        },
      ],
      nextCursor: after + 1,
      hasMore: false,
    })),
  };
}
