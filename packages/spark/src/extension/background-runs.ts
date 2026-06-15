import type {
  ArtifactRef,
  RoleRef,
  RunRef,
  TaskRef,
  TaskStatus,
  ProjectRef,
} from "@zendev-lab/pi-extension-api";
import type { WorkflowRunAcknowledgeResult, WorkflowRunStatus } from "@zendev-lab/pi-workflows";
import {
  listActiveSparkRoleRunProcesses,
  type KillSparkRoleRunProcessResult,
  type RoleRunArtifactPreview,
  type RoleRunJsonEventsTail,
  type RoleRunTextTail,
} from "@zendev-lab/spark-runtime";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import {
  collectBackgroundChildRuns,
  enrichBackgroundChildRunsWithRoleRunArtifacts,
  resolveBackgroundTaskRef,
} from "./background-child-runs.ts";
import {
  backgroundDagRunView,
  dagRunInProjectScope,
  isActionableProblemDagRun,
  selectBackgroundDagRuns,
  summarizeBackgroundRuns,
} from "./background-dag-runs.ts";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";

export { resolveBackgroundTaskRef } from "./background-child-runs.ts";

export type SparkBackgroundRunModeStatus =
  | "running"
  | "paused"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export interface SparkBackgroundRunModeState {
  runRef: RunRef;
  projectRef: ProjectRef;
  status: SparkBackgroundRunModeStatus;
  focus?: string;
  policy: { maxConcurrency: number; timeoutMs: number };
}

export type SparkBackgroundAction = "status" | "list" | "inspect" | "kill" | "reconcile" | "ack";
const SPARK_BACKGROUND_ACTIONS: SparkBackgroundAction[] = [
  "status",
  "list",
  "inspect",
  "kill",
  "reconcile",
  "ack",
];
const SPARK_BACKGROUND_KILL_SIGNALS = new Set<NodeJS.Signals>([
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
]);
export type SparkBackgroundSummaryState =
  | "idle"
  | "running"
  | "needs_attention"
  | "stale"
  | "legacy_timeout";
export type SparkBackgroundChildStatus =
  | "active"
  | "running"
  | "queued"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface SparkBackgroundDagRunView {
  runRef: RunRef;
  status: WorkflowRunStatus;
  legacyTimedOut: boolean;
  projectRef?: ProjectRef;
  ownerSessionId?: string;
  scheduled: number;
  completed: number;
  taskRunRefs: RunRef[];
  incompleteTaskRefs: TaskRef[];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  acknowledgedAt?: string;
  nextActions: string[];
}

export interface SparkBackgroundChildRunView {
  runRef: RunRef;
  dagRunRef?: RunRef;
  taskRef?: TaskRef;
  taskName?: string;
  taskTitle?: string;
  taskStatus?: TaskStatus;
  roleRef?: RoleRef;
  runName?: string;
  ownerSessionId?: string;
  claimKind?: string;
  pid?: number;
  cwd?: string;
  startedAt?: string;
  finishedAt?: string;
  timedOutAt?: string;
  activeProcess: boolean;
  status: SparkBackgroundChildStatus;
  summary?: string;
  errorMessage?: string;
  artifactRefs: ArtifactRef[];
  transcriptRef?: ArtifactRef;
  stdoutTail?: RoleRunTextTail;
  stderrTail?: RoleRunTextTail;
  jsonEventsTail?: RoleRunJsonEventsTail;
  roleRunArtifacts?: RoleRunArtifactPreview[];
  nextAction?: string;
}

export interface SparkBackgroundRunsDetails {
  action: SparkBackgroundAction;
  currentProjectRef?: ProjectRef;
  runMode?: {
    runRef: RunRef;
    projectRef: ProjectRef;
    status: SparkBackgroundRunModeStatus;
    focus?: string;
    policy: { maxConcurrency: number; foregroundTimeoutMs?: number };
  };
  summary: {
    state: SparkBackgroundSummaryState;
    activeDagRunRef?: RunRef;
    activeChildren: number;
    scheduled: number;
    completed: number;
    actionableProblems: number;
    nextAction: string;
  };
  dagRuns: SparkBackgroundDagRunView[];
  childRuns: SparkBackgroundChildRunView[];
  killed?: KillSparkRoleRunProcessResult[];
  acknowledged?: WorkflowRunAcknowledgeResult;
}

export function normalizeSparkBackgroundAction(value: unknown): SparkBackgroundAction {
  if (value === undefined || value === null) return "status";
  if (SPARK_BACKGROUND_ACTIONS.includes(value as SparkBackgroundAction))
    return value as SparkBackgroundAction;
  throw new Error(
    "spark_background_runs action must be status, list, inspect, kill, reconcile, or ack",
  );
}

export function normalizeOptionalRunRef(value: unknown, field = "runRef"): RunRef | undefined {
  const text = normalizeOptionalString(value, field);
  if (!text) return undefined;
  if (!text.startsWith("run:")) throw new Error(`${field} must be a run ref`);
  return text as RunRef;
}

export function normalizeOptionalTaskSelector(
  value: unknown,
  field = "taskRef",
): string | undefined {
  return normalizeOptionalString(value, field);
}

export function normalizeOptionalProjectRef(
  value: unknown,
  field = "projectRef",
): ProjectRef | undefined {
  const text = normalizeOptionalString(value, field);
  if (!text) return undefined;
  if (!text.startsWith("proj:")) throw new Error(`${field} must be a project ref`);
  return text as ProjectRef;
}

export function normalizeKillSignal(value: unknown, field = "signal"): NodeJS.Signals | undefined {
  const text = normalizeOptionalString(value, field);
  if (!text) return undefined;
  const signal = text.toUpperCase() as NodeJS.Signals;
  if (!SPARK_BACKGROUND_KILL_SIGNALS.has(signal)) {
    throw new Error(`${field} must be one of SIGTERM, SIGKILL, SIGINT, or SIGHUP`);
  }
  return signal;
}

export function normalizeForceAfterMs(value: unknown, field = "forceAfterMs"): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number`);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative integer`);
  return value;
}

export function normalizeSparkBackgroundBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${field} must be a boolean`);
}

function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value.trim() || undefined;
}

export function activeSparkRoleRunProcessesForCwd(cwd: string) {
  return listActiveSparkRoleRunProcesses().filter((process) => process.cwd === cwd);
}

export async function reconcileSparkDagRunsWithActiveProcesses(
  dagRunStore: ReturnType<typeof defaultSparkWorkflowRunStore>,
  graph: TaskGraph | undefined,
  cwd: string,
): Promise<void> {
  await dagRunStore.reconcile({
    graph,
    activeRunRefs: activeSparkRoleRunProcessesForCwd(cwd).map((process) => process.runRef),
  });
}

export async function buildSparkBackgroundDetails(input: {
  action: SparkBackgroundAction;
  cwd: string;
  graph: TaskGraph;
  dagRunStore: ReturnType<typeof defaultSparkWorkflowRunStore>;
  currentProjectRef?: ProjectRef;
  projectRef?: ProjectRef;
  runMode?: SparkBackgroundRunModeState;
  includeHistory: boolean;
  targetRunRef?: RunRef;
  targetTaskRef?: TaskRef;
  killed?: SparkBackgroundRunsDetails["killed"];
  acknowledged?: SparkBackgroundRunsDetails["acknowledged"];
}): Promise<SparkBackgroundRunsDetails> {
  const snapshot = await input.dagRunStore.load();
  const runMode = input.runMode;
  const scopeProjectRef = input.projectRef ?? input.currentProjectRef;
  const selectedDagRuns = selectBackgroundDagRuns({
    runs: snapshot.runs,
    projectRef: scopeProjectRef,
    includeHistory: input.includeHistory,
    targetRunRef: input.targetRunRef,
    targetTaskRef: input.targetTaskRef,
  });
  const childRuns = await enrichBackgroundChildRunsWithRoleRunArtifacts({
    cwd: input.cwd,
    childRuns: collectBackgroundChildRuns({
      graph: input.graph,
      dagRuns: selectedDagRuns,
      activeProcesses: activeSparkRoleRunProcessesForCwd(input.cwd),
      projectRef: scopeProjectRef,
      targetRunRef: input.targetRunRef,
      targetTaskRef: input.targetTaskRef,
    }),
  });
  const dagRuns = selectedDagRuns.map((run) =>
    backgroundDagRunView(
      run,
      childRuns.filter((child) => child.dagRunRef === run.ref && child.activeProcess),
    ),
  );
  const summary = summarizeBackgroundRuns({ dagRuns, childRuns });
  return {
    action: input.action,
    currentProjectRef: input.currentProjectRef,
    runMode:
      runMode && (!scopeProjectRef || runMode.projectRef === scopeProjectRef)
        ? {
            runRef: runMode.runRef,
            projectRef: runMode.projectRef,
            status: runMode.status,
            focus: runMode.focus,
            policy: {
              maxConcurrency: runMode.policy.maxConcurrency,
              foregroundTimeoutMs: runMode.policy.timeoutMs,
            },
          }
        : undefined,
    summary,
    dagRuns,
    childRuns,
    killed: input.killed,
    acknowledged: input.acknowledged,
  };
}

export async function acknowledgeBackgroundDagRuns(input: {
  dagRunStore: ReturnType<typeof defaultSparkWorkflowRunStore>;
  snapshot: Awaited<ReturnType<ReturnType<typeof defaultSparkWorkflowRunStore>["load"]>>;
  sessionId: string;
  projectRef?: ProjectRef;
  runRef?: RunRef;
}): Promise<NonNullable<SparkBackgroundRunsDetails["acknowledged"]>> {
  if (input.runRef)
    return input.dagRunStore.acknowledgeFailures({
      runRef: input.runRef,
      sessionId: input.sessionId,
    });
  const targets = input.snapshot.runs
    .filter((run) => dagRunInProjectScope(run, input.projectRef))
    .filter(isActionableProblemDagRun)
    .map((run) => run.ref);
  let result: NonNullable<SparkBackgroundRunsDetails["acknowledged"]> = {
    snapshot: input.snapshot,
    acknowledged: [],
    alreadyAcknowledged: [],
    skipped: [],
    missing: [],
  };
  for (const runRef of targets) {
    const next = await input.dagRunStore.acknowledgeFailures({
      runRef,
      sessionId: input.sessionId,
    });
    result = {
      snapshot: next.snapshot,
      acknowledged: [...result.acknowledged, ...next.acknowledged],
      alreadyAcknowledged: [...result.alreadyAcknowledged, ...next.alreadyAcknowledged],
      skipped: [...result.skipped, ...next.skipped],
      missing: [...result.missing, ...next.missing],
    };
  }
  return result;
}
