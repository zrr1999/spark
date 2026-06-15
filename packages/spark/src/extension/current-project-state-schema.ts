import {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_READY_TASK_TIMEOUT_MS,
  type ProjectRef,
  type RunRef,
} from "@zendev-lab/pi-extension-api";
import { JsonStoreFormatError } from "./json-store.ts";

export type SparkRunStrategy = "sequential" | "parallel";
export type SparkPlanningModeSource = "auto" | "direct";

export interface SparkPlanningModeState {
  version: 1;
  projectRef: ProjectRef;
  focus?: string;
  source: SparkPlanningModeSource;
  enteredAt: string;
}

export type SparkAgentMode = "research" | "plan" | "implement";
export type SparkExecuteStrategy = "default" | "goal" | "workflow";

export interface SparkExecutionBudget {
  tokenLimit?: number;
}

export interface SparkExecutionModeState {
  version: 1;
  projectRef: ProjectRef;
  focus?: string;
  mode: SparkAgentMode;
  strategy?: SparkExecuteStrategy;
  workflowName?: string;
  inlineScript?: string;
  workflowArgs?: unknown;
  budget?: SparkExecutionBudget;
  enteredAt: string;
}

export type SparkRunModeStatus = "running" | "paused" | "blocked" | "done" | "failed" | "cancelled";

export interface SparkRunModeState {
  version: 1;
  runRef: RunRef;
  projectRef: ProjectRef;
  focus?: string;
  status: SparkRunModeStatus;
  policy: {
    maxConcurrency: number;
    timeoutMs: number;
    stopOnAsk: true;
    stopOnValidationFailure: true;
  };
  enteredAt: string;
  updatedAt: string;
}

export interface CurrentProjectStoreSnapshot {
  version: 1;
  projectRef?: ProjectRef;
  planningMode?: SparkPlanningModeState;
  executionMode?: SparkExecutionModeState;
  runMode?: SparkRunModeState;
}

export function normalizeCurrentProjectStoreSnapshot(
  raw: Record<string, unknown>,
  filePath: string,
): CurrentProjectStoreSnapshot {
  const hasMode =
    raw.planningMode !== undefined || raw.executionMode !== undefined || raw.runMode !== undefined;
  if (raw.version === undefined && !hasMode) {
    const projectRef = requireString(raw.projectRef, filePath, "projectRef") as ProjectRef;
    return { version: 1, projectRef };
  }
  if (raw.version !== 1) {
    throw new JsonStoreFormatError(filePath, "version must be 1");
  }
  const projectRef = requireString(raw.projectRef, filePath, "projectRef") as ProjectRef;
  return {
    version: 1,
    projectRef,
    planningMode:
      raw.planningMode === undefined
        ? undefined
        : normalizeSparkPlanningModeState(raw.planningMode, filePath),
    executionMode:
      raw.executionMode === undefined
        ? undefined
        : normalizeSparkExecutionModeState(raw.executionMode, filePath),
    runMode:
      raw.runMode === undefined ? undefined : normalizeSparkRunModeState(raw.runMode, filePath),
  };
}

function normalizeSparkPlanningModeState(value: unknown, filePath: string): SparkPlanningModeState {
  const mode = requireRecord(value, filePath, "planningMode");
  assertOptionalVersionOne(mode.version, filePath, "planningMode.version");
  const source = mode.source ?? "auto";
  if (source !== "auto" && source !== "direct") {
    throw new JsonStoreFormatError(filePath, "planningMode.source must be auto or direct");
  }
  return {
    version: 1,
    projectRef: requireString(mode.projectRef, filePath, "planningMode.projectRef") as ProjectRef,
    focus: optionalTrimmedString(mode.focus, filePath, "planningMode.focus"),
    source,
    enteredAt: requireString(mode.enteredAt, filePath, "planningMode.enteredAt"),
  };
}

function normalizeSparkExecutionModeState(
  value: unknown,
  filePath: string,
): SparkExecutionModeState {
  const mode = requireRecord(value, filePath, "executionMode");
  assertOptionalVersionOne(mode.version, filePath, "executionMode.version");
  const agentMode = normalizeSparkAgentMode(mode.mode, filePath);
  const strategy =
    mode.strategy === undefined
      ? undefined
      : normalizeSparkExecuteStrategy(mode.strategy, filePath);
  if (agentMode !== "implement" && strategy !== undefined) {
    throw new JsonStoreFormatError(
      filePath,
      "executionMode.strategy is only valid when executionMode.mode is implement",
    );
  }
  return {
    version: 1,
    projectRef: requireString(mode.projectRef, filePath, "executionMode.projectRef") as ProjectRef,
    focus: optionalTrimmedString(mode.focus, filePath, "executionMode.focus"),
    mode: agentMode,
    strategy: agentMode === "implement" ? (strategy ?? "default") : undefined,
    workflowName: optionalTrimmedString(mode.workflowName, filePath, "executionMode.workflowName"),
    inlineScript: optionalTrimmedString(mode.inlineScript, filePath, "executionMode.inlineScript"),
    workflowArgs: mode.workflowArgs,
    budget:
      mode.budget === undefined ? undefined : normalizeSparkExecutionBudget(mode.budget, filePath),
    enteredAt: requireString(mode.enteredAt, filePath, "executionMode.enteredAt"),
  };
}

function normalizeSparkAgentMode(value: unknown, filePath: string): SparkAgentMode {
  if (value === "research" || value === "plan" || value === "implement") return value;
  // Legacy sessions persisted the third mode as "execute"; normalize to "implement".
  if (value === "execute") return "implement";
  throw new JsonStoreFormatError(
    filePath,
    "executionMode.mode must be research, plan, or implement",
  );
}

function normalizeSparkExecuteStrategy(value: unknown, filePath: string): SparkExecuteStrategy {
  if (value === "default" || value === "goal" || value === "workflow") return value;
  throw new JsonStoreFormatError(
    filePath,
    "executionMode.strategy must be default, goal, or workflow",
  );
}

function normalizeSparkExecutionBudget(value: unknown, filePath: string): SparkExecutionBudget {
  const budget = requireRecord(value, filePath, "executionMode.budget");
  return {
    tokenLimit:
      budget.tokenLimit === undefined
        ? undefined
        : requirePositiveNumber(budget.tokenLimit, filePath, "executionMode.budget.tokenLimit"),
  };
}

function normalizeSparkRunModeState(value: unknown, filePath: string): SparkRunModeState {
  const raw = requireRecord(value, filePath, "runMode");
  assertOptionalVersionOne(raw.version, filePath, "runMode.version");
  const status = normalizeSparkRunModeStatus(raw.status, filePath);
  const policy =
    raw.policy === undefined ? undefined : requireRecord(raw.policy, filePath, "runMode.policy");
  return {
    version: 1,
    runRef: requireString(raw.runRef, filePath, "runMode.runRef") as RunRef,
    projectRef: requireString(raw.projectRef, filePath, "runMode.projectRef") as ProjectRef,
    focus: optionalTrimmedString(raw.focus, filePath, "runMode.focus"),
    status,
    policy: {
      maxConcurrency:
        policy?.maxConcurrency === undefined
          ? DEFAULT_READY_TASK_MAX_CONCURRENCY
          : requirePositiveNumber(policy.maxConcurrency, filePath, "runMode.policy.maxConcurrency"),
      timeoutMs:
        policy?.timeoutMs === undefined
          ? DEFAULT_READY_TASK_TIMEOUT_MS
          : requirePositiveNumber(policy.timeoutMs, filePath, "runMode.policy.timeoutMs"),
      stopOnAsk: true,
      stopOnValidationFailure: true,
    },
    enteredAt: requireString(raw.enteredAt, filePath, "runMode.enteredAt"),
    updatedAt:
      raw.updatedAt === undefined
        ? requireString(raw.enteredAt, filePath, "runMode.enteredAt")
        : requireString(raw.updatedAt, filePath, "runMode.updatedAt"),
  };
}

function normalizeSparkRunModeStatus(value: unknown, filePath: string): SparkRunModeStatus {
  if (value === undefined || value === "running") return "running";
  if (
    value === "paused" ||
    value === "blocked" ||
    value === "done" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new JsonStoreFormatError(filePath, "runMode.status must be a valid status");
}

function assertOptionalVersionOne(value: unknown, filePath: string, path: string): void {
  if (value !== undefined && value !== 1) {
    throw new JsonStoreFormatError(filePath, `${path} must be 1`);
  }
}

function requireRecord(value: unknown, filePath: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonStoreFormatError(filePath, `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, filePath: string, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new JsonStoreFormatError(filePath, `${path} must be a non-empty string`);
  }
  return value;
}

function optionalTrimmedString(value: unknown, filePath: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new JsonStoreFormatError(filePath, `${path} must be a string`);
  return value.trim() || undefined;
}

function requirePositiveNumber(value: unknown, filePath: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new JsonStoreFormatError(filePath, `${path} must be a positive number`);
  }
  return value;
}
