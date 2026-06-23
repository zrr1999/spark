import type { ProjectRef } from "@zendev-lab/pi-extension-api";
import {
  clearCurrentProjectRef,
  loadCurrentProjectState,
  saveCurrentProjectRef,
} from "./current-project-state.ts";
import type { SparkAgentMode, SparkPlanningModeSource } from "./current-project-state-schema.ts";
import type { SparkSessionContext } from "./session-identity.ts";

interface SparkActiveLensContext extends SparkSessionContext {
  sparkActiveLens?: {
    mode: SparkSessionMode;
  };
}

/**
 * Per-turn Spark operating lens. The durable session store no longer records
 * this value; callers that need a direct lens for the current turn inject it as
 * prompt/steer context instead of writing `.spark/sessions/*.json`.
 */
export type SparkSessionMode = SparkAgentMode;

/**
 * Input for updating the durable current-project pointer through mode-shaped callers.
 * Only `projectRef` is durable; the lens itself is per-turn context.
 */
export interface SparkSessionModeInput {
  mode: SparkSessionMode;
  projectRef?: ProjectRef;
  focus?: string;
  planningSource?: SparkPlanningModeSource;
}

/**
 * Resolved Spark lens state. The durable disk value intentionally falls back to
 * `research`; non-default direct lenses are per-turn instructions. When the
 * current host context carries an active per-turn lens, expose that lens so the
 * mode tool and active prompt agree with the driver that selected the turn.
 */
export interface SparkSessionModeState {
  mode: SparkSessionMode;
  projectRef?: ProjectRef;
  focus?: string;
  planningSource?: SparkPlanningModeSource;
  enteredAt?: string;
}

export async function loadSparkMode(
  cwd: string,
  ctx?: SparkActiveLensContext,
): Promise<SparkSessionModeState> {
  const state = await loadCurrentProjectState(cwd, ctx);
  const mode = ctx?.sparkActiveLens?.mode ?? "research";
  return state?.projectRef ? { mode, projectRef: state.projectRef } : { mode };
}

/**
 * Persists only the selected project pointer. The requested lens is intentionally
 * not stored because mode is resolved per turn.
 */
export async function saveSparkMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  next: SparkSessionModeInput,
): Promise<void> {
  if (next.projectRef) await saveCurrentProjectRef(cwd, ctx, next.projectRef);
  else await clearCurrentProjectRef(cwd, ctx);
}

export async function clearSparkMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  await clearCurrentProjectRef(cwd, ctx);
}

export const SPARK_SESSION_MODE_CYCLE: readonly SparkSessionMode[] = [
  "research",
  "plan",
  "implement",
] as const;

export function nextSparkSessionMode(current: SparkSessionMode): SparkSessionMode {
  const index = SPARK_SESSION_MODE_CYCLE.indexOf(current);
  if (index < 0) return "research";
  return SPARK_SESSION_MODE_CYCLE[(index + 1) % SPARK_SESSION_MODE_CYCLE.length] ?? "research";
}
