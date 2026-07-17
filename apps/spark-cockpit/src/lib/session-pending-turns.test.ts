import { parseSparkSessionView } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";

import { resolveSessionPendingTurns, type CockpitPendingTurn } from "./session-pending-turns";

const staleQueued: CockpitPendingTurn = {
  commandId: "cmd_continue",
  invocationId: "inv_continue",
  prompt: "继续",
  status: "queued",
  createdAt: "2026-07-17T07:46:14.348Z",
  startedAt: null,
};

describe("session pending turn resolution", () => {
  it("uses daemon pendingTurns so the active invocation is not rendered as queued", () => {
    const session = parseSparkSessionView({
      sessionId: "sess_active",
      status: "running",
      pendingTurns: [
        {
          invocationId: "inv_continue",
          prompt: "继续",
          status: "running",
          createdAt: "2026-07-17T07:46:14.348Z",
          startedAt: "2026-07-17T07:46:14.589Z",
        },
      ],
    });

    expect(resolveSessionPendingTurns([staleQueued], session)).toEqual([
      {
        commandId: "inv_continue",
        invocationId: "inv_continue",
        prompt: "继续",
        status: "running",
        createdAt: "2026-07-17T07:46:14.348Z",
        startedAt: "2026-07-17T07:46:14.589Z",
      },
    ]);
  });

  it("clears stale projected queue rows when the daemon has no pending turns", () => {
    const session = parseSparkSessionView({
      sessionId: "sess_idle",
      status: "idle",
      pendingTurns: [],
    });

    expect(resolveSessionPendingTurns([staleQueued], session)).toEqual([]);
  });

  it("keeps the Cockpit projection only when daemon admission truth is unavailable", () => {
    const projectedOnly = parseSparkSessionView({ sessionId: "sess_offline", status: "idle" });
    expect(resolveSessionPendingTurns([staleQueued], projectedOnly)).toEqual([staleQueued]);
    expect(resolveSessionPendingTurns([staleQueued], null)).toEqual([staleQueued]);
  });
});
