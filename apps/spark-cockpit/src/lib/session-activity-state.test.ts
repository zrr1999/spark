import { parseSparkSessionView } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";

import { resolveSessionActivityState } from "./session-activity-state";

describe("session activity presentation", () => {
  it("keeps waiting, running and terminal UI states mutually consistent", () => {
    const queued = resolveSessionActivityState({
      registryStatus: "running",
      session: parseSparkSessionView({
        sessionId: "sess_truth",
        status: "queued",
        pendingTurns: [pendingTurn("inv_truth", "queued")],
      }),
      projectedTurns: [],
      liveActiveTurnId: "inv_truth",
    });
    expect(queued).toMatchObject({
      phase: "queued",
      runningTurnId: null,
      pendingTurns: [{ invocationId: "inv_truth", status: "queued" }],
    });

    const running = resolveSessionActivityState({
      registryStatus: "ready",
      session: parseSparkSessionView({
        sessionId: "sess_truth",
        status: "running",
        pendingTurns: [pendingTurn("inv_truth", "running")],
      }),
      projectedTurns: [],
    });
    expect(running).toMatchObject({
      phase: "running",
      runningTurnId: "inv_truth",
      pendingTurns: [{ invocationId: "inv_truth", status: "running" }],
    });

    const terminal = resolveSessionActivityState({
      registryStatus: "running",
      session: parseSparkSessionView({
        sessionId: "sess_truth",
        status: "idle",
        pendingTurns: [],
      }),
      projectedTurns: [projectedQueuedTurn()],
      liveActiveTurnId: "inv_truth",
    });
    expect(terminal).toEqual({ phase: "idle", pendingTurns: [], runningTurnId: null });
  });
});

function pendingTurn(invocationId: string, status: "queued" | "running") {
  return {
    invocationId,
    prompt: "Continue",
    status,
    createdAt: "2026-07-17T08:00:00.000Z",
    ...(status === "running" ? { startedAt: "2026-07-17T08:00:01.000Z" } : {}),
  };
}

function projectedQueuedTurn() {
  return {
    commandId: "cmd_truth",
    invocationId: "inv_truth",
    prompt: "Continue",
    status: "queued" as const,
    createdAt: "2026-07-17T08:00:00.000Z",
    startedAt: null,
  };
}
