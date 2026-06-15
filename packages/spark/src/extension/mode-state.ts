import type { ProjectRef } from "@zendev-lab/pi-extension-api";
import {
  clearSparkExecutionMode,
  loadCurrentProjectState,
  saveSparkExecutionMode,
  saveSparkPlanningMode,
} from "./current-project-state.ts";
import type {
  SparkAgentMode,
  SparkExecuteStrategy,
  SparkExecutionBudget,
  SparkPlanningModeSource,
} from "./current-project-state-schema.ts";
import type { SparkSessionContext } from "./session-identity.ts";

/**
 * Session-level Spark mode. This is now exactly {@link SparkAgentMode}:
 * `research` is the unconditional default and is represented in storage by
 * the absence of any `executionMode` block (i.e. {@link clearSparkExecutionMode}).
 *
 * `research` is the default mode for any new session: Spark investigates and
 * auto-routes from there rather than requiring an explicit mode hand-off.
 */
export type SparkSessionMode = SparkAgentMode;

/**
 * Inputs accepted by {@link saveSparkMode}. `research` is the default and is
 * recorded by clearing executionMode when no project is bound; the `plan` and
 * `implement` modes require a `projectRef` since execution context is bound to
 * the active project.
 */
export interface SparkSessionModeInput {
  mode: SparkSessionMode;
  projectRef?: ProjectRef;
  focus?: string;
  /** Only honored when `mode === "implement"`. Defaults to "default". */
  executeStrategy?: SparkExecuteStrategy;
  /** Only honored when `mode === "implement"` and strategy is "workflow". */
  workflowSelector?: string;
  /** Only honored when `mode === "implement"` and strategy is "workflow". */
  inlineScript?: string;
  /** Only honored when `mode === "implement"` and strategy is "workflow". */
  workflowArgs?: unknown;
  /** Optional execution budget (only honored when `mode === "implement"`). */
  budget?: SparkExecutionBudget;
  /** Only honored when `mode === "plan"`. Defaults to "auto". */
  planningSource?: SparkPlanningModeSource;
}

/**
 * Resolved Spark session mode, derived from the persisted current-project
 * snapshot. `mode === "research"` indicates either no record exists or the
 * record explicitly cleared the execution block.
 */
export interface SparkSessionModeState {
  mode: SparkSessionMode;
  projectRef?: ProjectRef;
  focus?: string;
  executeStrategy?: SparkExecuteStrategy;
  workflowSelector?: string;
  inlineScript?: string;
  workflowArgs?: unknown;
  budget?: SparkExecutionBudget;
  planningSource?: SparkPlanningModeSource;
  /** Iso timestamp of when the active mode block was written, if any. */
  enteredAt?: string;
}

/**
 * Resolve the session-level mode, falling back to `research` when no execution
 * block is recorded. Surfacing `projectRef` even in the default mode lets
 * callers keep track of the current project regardless of mode state.
 */
export async function loadSparkMode(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionModeState> {
  const state = await loadCurrentProjectState(cwd, ctx);
  if (!state) return { mode: "research" };
  const exec = state.executionMode;
  if (!exec) return { mode: "research", projectRef: state.projectRef };
  return {
    mode: exec.mode,
    projectRef: exec.projectRef,
    focus: exec.focus,
    executeStrategy: exec.mode === "implement" ? (exec.strategy ?? "default") : undefined,
    workflowSelector: exec.workflowName,
    inlineScript: exec.inlineScript,
    workflowArgs: exec.workflowArgs,
    budget: exec.budget,
    planningSource: state.planningMode?.source,
    enteredAt: exec.enteredAt,
  };
}

/**
 * Persist the session-level mode. `research` clears the execution block (and
 * any associated planning block) but preserves the current `projectRef`.
 * The `plan` and `implement` modes require `projectRef`; pass an empty value
 * and the call is rejected so we never write half-formed state.
 */
export async function saveSparkMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  next: SparkSessionModeInput,
): Promise<void> {
  if (next.mode === "research" && !next.projectRef) {
    await clearSparkExecutionMode(cwd, ctx);
    return;
  }
  if (!next.projectRef) {
    throw new Error(`saveSparkMode: projectRef is required for mode=${next.mode}`);
  }
  if (next.mode === "plan") {
    await saveSparkPlanningMode(
      cwd,
      ctx,
      next.projectRef,
      next.focus,
      next.planningSource ?? "auto",
    );
    return;
  }
  if (next.mode === "research") {
    await saveSparkExecutionMode(cwd, ctx, next.projectRef, next.focus, "research");
    return;
  }
  // implement
  await saveSparkExecutionMode(
    cwd,
    ctx,
    next.projectRef,
    next.focus,
    "implement",
    next.executeStrategy ?? "default",
    {
      workflowName: next.workflowSelector,
      inlineScript: next.inlineScript,
      workflowArgs: next.workflowArgs,
      budget: next.budget,
    },
  );
}

/**
 * Reset to `research`, equivalent to {@link clearSparkExecutionMode}. Kept as
 * a named alias so callers can write `clearSparkMode` when their intent
 * is "drop the active mode" rather than "drop a specific block".
 */
export async function clearSparkMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<void> {
  await clearSparkExecutionMode(cwd, ctx);
}

/**
 * Cycle order for the Shift+Tab manual switch and any caller that needs
 * the canonical sequence: research → plan → implement → research.
 */
export const SPARK_SESSION_MODE_CYCLE: readonly SparkSessionMode[] = [
  "research",
  "plan",
  "implement",
] as const;

/** Return the next mode in {@link SPARK_SESSION_MODE_CYCLE}. */
export function nextSparkSessionMode(current: SparkSessionMode): SparkSessionMode {
  const index = SPARK_SESSION_MODE_CYCLE.indexOf(current);
  if (index < 0) return "research";
  return SPARK_SESSION_MODE_CYCLE[(index + 1) % SPARK_SESSION_MODE_CYCLE.length] ?? "research";
}
