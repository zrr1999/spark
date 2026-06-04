import { nowIso } from "spark-core";
import { sweepExpiredTaskClaims } from "spark-runtime";
import { defaultTaskGraphStore, TaskGraphStoreLockTimeoutError } from "spark-tasks";
import { saveSparkGraphAndTodos, type SparkSessionContext } from "./session-state.ts";

const CLAIM_SWEEP_INTERVAL_MS = 30_000;
const claimReaperTimers = new Map<string, ReturnType<typeof setInterval>>();

export function ensureSparkClaimReaper(cwd: string): void {
  if (claimReaperTimers.has(cwd)) return;
  const timer = setInterval(
    () => void sweepExpiredSparkClaims(cwd).catch(reportClaimReaperError),
    CLAIM_SWEEP_INTERVAL_MS,
  );
  (timer as { unref?: () => void }).unref?.();
  claimReaperTimers.set(cwd, timer);
}

function reportClaimReaperError(error: unknown): void {
  console.warn(
    `Spark claim reaper failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export async function sweepExpiredSparkClaims(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<void> {
  const store = defaultTaskGraphStore(cwd);
  try {
    const result = await sweepExpiredTaskClaims(store, nowIso(), { timeoutMs: 250 });
    if (result.saved && result.graph) await saveSparkGraphAndTodos(cwd, result.graph, ctx, store);
  } catch (error) {
    if (error instanceof TaskGraphStoreLockTimeoutError) return;
    throw error;
  }
}
