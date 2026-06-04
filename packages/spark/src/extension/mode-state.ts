import type { ProjectRef } from "spark-core";
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
 * Session-level Spark mode. Unlike {@link SparkAgentMode}, this includes
 * the implicit `auto` mode which is represented in storage by the absence
 * of any `executionMode` block (i.e. {@link clearSparkExecutionMode}).
 *
 * `auto` is the default mode for any new session: Spark will analyze the
 * first user input and ask which mode (research/plan/execute) to switch
 * into rather than acting unilaterally.
 */
export type SparkSessionMode = "auto" | SparkAgentMode;

/**
 * Inputs accepted by {@link saveSparkMode}. `auto` ignores all other fields
 * (it is recorded by clearing executionMode). Non-auto modes require a
 * `projectRef` since execution context is bound to the active project.
 */
export interface SparkSessionModeInput {
  mode: SparkSessionMode;
  projectRef?: ProjectRef;
  focus?: string;
  /** Only honored when `mode === "execute"`. Defaults to "default". */
  executeStrategy?: SparkExecuteStrategy;
  /** Only honored when `mode === "execute"` and strategy is "workflow". */
  workflowSelector?: string;
  /** Only honored when `mode === "execute"` and strategy is "workflow". */
  inlineScript?: string;
  /** Only honored when `mode === "execute"` and strategy is "workflow". */
  workflowArgs?: unknown;
  /** Optional execution budget (only honored when `mode === "execute"`). */
  budget?: SparkExecutionBudget;
  /** Only honored when `mode === "plan"`. Defaults to "auto". */
  planningSource?: SparkPlanningModeSource;
}

/**
 * Resolved Spark session mode, derived from the persisted current-project
 * snapshot. `mode === "auto"` indicates either no record exists or the
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
 * Resolve the session-level mode, falling back to `auto` when no execution
 * block is recorded. Surfacing `projectRef` even in auto mode lets callers
 * keep track of the current project regardless of mode state.
 */
export async function loadSparkMode(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionModeState> {
  const state = await loadCurrentProjectState(cwd, ctx);
  if (!state) return { mode: "auto" };
  const exec = state.executionMode;
  if (!exec) return { mode: "auto", projectRef: state.projectRef };
  return {
    mode: exec.mode,
    projectRef: exec.projectRef,
    focus: exec.focus,
    executeStrategy: exec.mode === "execute" ? (exec.strategy ?? "default") : undefined,
    workflowSelector: exec.workflowName,
    inlineScript: exec.inlineScript,
    workflowArgs: exec.workflowArgs,
    budget: exec.budget,
    planningSource: state.planningMode?.source,
    enteredAt: exec.enteredAt,
  };
}

/**
 * Persist the session-level mode. `auto` clears the execution block (and
 * any associated planning block) but preserves the current `projectRef`.
 * Non-auto modes require `projectRef`; pass an empty value and the call
 * is rejected so we never write half-formed state.
 */
export async function saveSparkMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  next: SparkSessionModeInput,
): Promise<void> {
  if (next.mode === "auto") {
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
  // execute
  await saveSparkExecutionMode(
    cwd,
    ctx,
    next.projectRef,
    next.focus,
    "execute",
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
 * Reset to `auto`, equivalent to {@link clearSparkExecutionMode}. Kept as
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
 * the canonical sequence. `auto` is included so the cycle wraps cleanly.
 */
export const SPARK_SESSION_MODE_CYCLE: readonly SparkSessionMode[] = [
  "auto",
  "research",
  "plan",
  "execute",
] as const;

/** Return the next mode in {@link SPARK_SESSION_MODE_CYCLE}. */
export function nextSparkSessionMode(current: SparkSessionMode): SparkSessionMode {
  const index = SPARK_SESSION_MODE_CYCLE.indexOf(current);
  if (index < 0) return "auto";
  return SPARK_SESSION_MODE_CYCLE[(index + 1) % SPARK_SESSION_MODE_CYCLE.length] ?? "auto";
}
