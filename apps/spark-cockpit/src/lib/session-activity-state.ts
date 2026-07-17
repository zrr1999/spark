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
  const authoritativePendingTurns = input.session?.pendingTurns !== undefined;
  const runningTurnId =
    pendingTurns.find((turn) => turn.status === "running")?.invocationId ?? null;

  // Once the daemon supplies pendingTurns, that list is the execution truth.
  // A stale session status or locally remembered cancellation target must not
  // resurrect a spinner/Stop control after the invocation has settled.
  if (authoritativePendingTurns) {
    return {
      phase: runningTurnId
        ? "running"
        : pendingTurns.some((turn) => turn.status === "queued")
          ? "queued"
          : "idle",
      pendingTurns,
      runningTurnId,
    };
  }

  const working = sessionIsWorking({
    registryStatus: input.registryStatus,
    liveStatus: input.session?.status,
  });
  return {
    phase: working
      ? "running"
      : pendingTurns.some((turn) => turn.status === "queued")
        ? "queued"
        : "idle",
    pendingTurns,
    runningTurnId: working ? (runningTurnId ?? input.liveActiveTurnId ?? null) : null,
  };
}
