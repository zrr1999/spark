import type { ProjectRef } from "@zendev-lab/spark-extension-api";
import {
  clearCurrentProjectRef,
  loadCurrentProjectState,
  saveCurrentProjectRef,
  saveSessionPhase,
} from "./current-project-state.ts";
import {
  normalizeSparkAgentPhase,
  type SparkAgentPhase,
  type SparkPlanningModeSource,
} from "./current-project-state-schema.ts";
import type { SparkActiveLensDriveState } from "./spark-drive-state.ts";
import type { SparkSessionContext } from "./session-identity.ts";

interface SparkActiveLensContext extends SparkSessionContext {
  sparkActiveLens?: SparkActiveLensDriveState;
}

/**
 * Session-scoped Spark operating phase/lens. It controls prompt/tool policy only;
 * drive mode is derived from registered active drive state.
 */
export type SparkSessionPhase = SparkAgentPhase;
/** @deprecated Use SparkSessionPhase. */
export type SparkSessionMode = SparkSessionPhase;

/** Input for updating the durable session phase and optional current-project pointer. */
export interface SparkSessionPhaseInput {
  phase: SparkSessionPhase;
  projectRef?: ProjectRef;
  focus?: string;
  planningSource?: SparkPlanningModeSource;
}
/** @deprecated Use SparkSessionPhaseInput. */
export interface SparkSessionModeInput extends Omit<SparkSessionPhaseInput, "phase"> {
  mode: SparkSessionPhase;
}

/** Resolved Spark phase state for this session. */
export interface SparkSessionPhaseState {
  phase: SparkSessionPhase;
  projectRef?: ProjectRef;
  focus?: string;
  planningSource?: SparkPlanningModeSource;
  enteredAt?: string;
}
/** @deprecated Use SparkSessionPhaseState. */
export interface SparkSessionModeState extends Omit<SparkSessionPhaseState, "phase"> {
  mode: SparkSessionPhase;
}

export async function loadSparkPhase(
  cwd: string,
  ctx?: SparkActiveLensContext,
): Promise<SparkSessionPhaseState> {
  const state = await loadCurrentProjectState(cwd, ctx);
  const phase = normalizeSparkAgentPhase(ctx?.sparkActiveLens?.phase) ?? state?.phase ?? "plan";
  return state?.projectRef ? { phase, projectRef: state.projectRef } : { phase };
}

/** @deprecated Use loadSparkPhase. */
export async function loadSparkMode(
  cwd: string,
  ctx?: SparkActiveLensContext,
): Promise<SparkSessionModeState> {
  const state = await loadSparkPhase(cwd, ctx);
  return state.projectRef
    ? { mode: state.phase, projectRef: state.projectRef }
    : { mode: state.phase };
}

export async function saveSparkPhase(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  next: SparkSessionPhaseInput,
): Promise<void> {
  await saveSessionPhase(cwd, ctx, next.phase);
  if (next.projectRef) await saveCurrentProjectRef(cwd, ctx, next.projectRef);
}

/** @deprecated Use saveSparkPhase. */
export async function saveSparkMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  next: SparkSessionModeInput,
): Promise<void> {
  await saveSparkPhase(cwd, ctx, { ...next, phase: next.mode });
}

export async function clearSparkPhase(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  await clearCurrentProjectRef(cwd, ctx);
}

/** @deprecated Use clearSparkPhase. */
export async function clearSparkMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  await clearSparkPhase(cwd, ctx);
}

export const SPARK_SESSION_PHASE_CYCLE: readonly SparkSessionPhase[] = [
  "plan",
  "implement",
] as const;
/** @deprecated Use SPARK_SESSION_PHASE_CYCLE. */
export const SPARK_SESSION_MODE_CYCLE = SPARK_SESSION_PHASE_CYCLE;

export function nextSparkSessionPhase(current: SparkSessionPhase): SparkSessionPhase {
  const index = SPARK_SESSION_PHASE_CYCLE.indexOf(current);
  if (index < 0) return "plan";
  return SPARK_SESSION_PHASE_CYCLE[(index + 1) % SPARK_SESSION_PHASE_CYCLE.length] ?? "plan";
}

/** @deprecated Use nextSparkSessionPhase. */
export function nextSparkSessionMode(current: SparkSessionMode): SparkSessionMode {
  return nextSparkSessionPhase(current);
}
