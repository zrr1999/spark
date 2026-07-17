import type { SparkSessionView } from "@zendev-lab/spark-protocol";
import { resolveSessionPendingTurns, type CockpitPendingTurn } from "./session-pending-turns";
import { sessionIsWorking } from "./session-working-state";

export type SessionActivityPhase = "idle" | "queued" | "running";

export type SessionActivityState = {
  phase: SessionActivityPhase;
  pendingTurns: CockpitPendingTurn[];
  runningTurnId: string | null;
};

/** One presentation boundary for daemon run truth used by spinner, Stop and queue UI. */
export function resolveSessionActivityState(input: {
  registryStatus?: string | null;
  session: SparkSessionView | null;
  projectedTurns: readonly CockpitPendingTurn[];
  liveActiveTurnId?: string | null;
}): SessionActivityState {
  const pendingTurns = resolveSessionPendingTurns(input.projectedTurns, input.session);
  const working = sessionIsWorking({
    registryStatus: input.registryStatus,
    liveStatus: input.session?.status,
  });
  const runningTurnId = working
    ? (pendingTurns.find((turn) => turn.status === "running")?.invocationId ??
      input.liveActiveTurnId ??
      null)
    : null;
  return {
    phase: working
      ? "running"
      : pendingTurns.some((turn) => turn.status === "queued")
        ? "queued"
        : "idle",
    pendingTurns,
    runningTurnId,
  };
}
