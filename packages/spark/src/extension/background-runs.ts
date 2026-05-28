import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  refId,
  type Artifact,
  type ArtifactRef,
  type RoleRef,
  type RunRef,
  type TaskRef,
  type TaskStatus,
  type ThreadRef,
} from "spark-core";
import {
  defaultSparkDagRunStore,
  type SparkDagRunAcknowledgeResult,
  type SparkDagRunRecord,
  type SparkDagRunStatus,
} from "spark-orchestrator";
import {
  listActiveSparkRoleRunProcesses,
  type ActiveSparkRoleRunProcess,
  type KillSparkRoleRunProcessResult,
  type RoleRunArtifactBody,
  type RoleRunJsonEventsTail,
  type RoleRunTextTail,
} from "spark-runtime";
import type { TaskGraph } from "spark-tasks";

const SPARK_BACKGROUND_ROLE_RUN_METADATA_MAX_BYTES = 256 * 1024;

export type SparkBackgroundRunModeStatus =
  | "running"
  | "paused"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export interface SparkBackgroundRunModeState {
  runRef: RunRef;
  threadRef: ThreadRef;
  status: SparkBackgroundRunModeStatus;
  focus?: string;
  policy: { maxConcurrency: number; timeoutMs: number };
}

export type SparkBackgroundAction = "status" | "list" | "inspect" | "kill" | "reconcile" | "ack";
type SparkBackgroundSummaryState =
  | "idle"
  | "running"
  | "needs_attention"
  | "stale"
  | "legacy_timeout";
type SparkBackgroundChildStatus =
  | "active"
  | "running"
  | "queued"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

interface SparkBackgroundDagRunView {
  runRef: RunRef;
  status: SparkDagRunStatus;
  legacyTimedOut: boolean;
  threadRef?: ThreadRef;
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

interface SparkBackgroundRoleRunArtifactPreview {
  artifactRef: ArtifactRef;
  status?: string;
  summary?: string;
  transcriptRef?: ArtifactRef;
  stdout?: RoleRunTextTail;
  stderr?: RoleRunTextTail;
  jsonEvents?: RoleRunJsonEventsTail;
  bodySize?: number;
  bodyTruncated?: boolean;
  skippedReason?: string;
}

interface SparkBackgroundChildRunView {
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
  roleRunArtifacts?: SparkBackgroundRoleRunArtifactPreview[];
  nextAction?: string;
}

export interface SparkBackgroundRunsDetails {
  action: SparkBackgroundAction;
  currentThreadRef?: ThreadRef;
  runMode?: {
    runRef: RunRef;
    threadRef: ThreadRef;
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
  acknowledged?: SparkDagRunAcknowledgeResult;
}

export function normalizeSparkBackgroundAction(value: unknown): SparkBackgroundAction {
  if (
    value === "list" ||
    value === "inspect" ||
    value === "kill" ||
    value === "reconcile" ||
    value === "ack" ||
    value === "status"
  )
    return value;
  return "status";
}

export function normalizeOptionalRunRef(value: unknown): RunRef | undefined {
  return typeof value === "string" && value.trim() ? (value.trim() as RunRef) : undefined;
}

export function normalizeOptionalTaskSelector(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeOptionalThreadRef(value: unknown): ThreadRef | undefined {
  return typeof value === "string" && value.trim() ? (value.trim() as ThreadRef) : undefined;
}

export function normalizeKillSignal(value: unknown): NodeJS.Signals | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().toUpperCase() as NodeJS.Signals;
}

export function normalizeForceAfterMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

export function activeSparkRoleRunProcessesForCwd(cwd: string) {
  return listActiveSparkRoleRunProcesses().filter((process) => process.cwd === cwd);
}

export async function reconcileSparkDagRunsWithActiveProcesses(
  dagRunStore: ReturnType<typeof defaultSparkDagRunStore>,
  graph: TaskGraph | undefined,
  cwd: string,
): Promise<void> {
  await dagRunStore.reconcile({
    graph,
    activeRunRefs: activeSparkRoleRunProcessesForCwd(cwd).map((process) => process.runRef),
  });
}

function isProblemDagRun(run: SparkDagRunRecord): boolean {
  return run.status === "failed" || run.status === "stale" || run.status === "timed_out";
}

function isActionableProblemDagRun(run: SparkDagRunRecord): boolean {
  return isProblemDagRun(run) && !run.acknowledgedAt;
}

function dagRunInThreadScope(run: SparkDagRunRecord, threadRef: ThreadRef | undefined): boolean {
  return !threadRef || !run.threadRef || run.threadRef === threadRef;
}

function taskRunStatusRank(status: SparkBackgroundChildStatus): number {
  switch (status) {
    case "active":
      return 0;
    case "running":
      return 1;
    case "queued":
      return 2;
    case "failed":
      return 3;
    case "cancelled":
      return 4;
    case "succeeded":
      return 5;
    case "unknown":
      return 6;
  }
}

export function resolveBackgroundTaskRef(
  graph: TaskGraph,
  selector: string | undefined,
  threadRef: ThreadRef | undefined,
): TaskRef | undefined {
  if (!selector) return undefined;
  const normalized = selector.trim().replace(/^@/, "");
  const tasks = graph.tasks(threadRef);
  return tasks.find(
    (task) =>
      task.ref === selector ||
      task.ref === normalized ||
      task.name === normalized ||
      task.title === selector ||
      task.title === normalized,
  )?.ref;
}

function backgroundDagRunView(
  run: SparkDagRunRecord,
  activeChildren: SparkBackgroundChildRunView[],
): SparkBackgroundDagRunView {
  const completed = new Set(run.completedTaskRefs);
  const nextActions = backgroundDagRunNextActions(run, activeChildren.length);
  return {
    runRef: run.ref,
    status: run.status,
    legacyTimedOut: run.status === "timed_out" || run.timedOut,
    threadRef: run.threadRef,
    ownerSessionId: run.ownerSessionId,
    scheduled: run.scheduled,
    completed: run.completed,
    taskRunRefs: run.taskRunRefs,
    incompleteTaskRefs: run.scheduledTaskRefs.filter((taskRef) => !completed.has(taskRef)),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    acknowledgedAt: run.acknowledgedAt,
    nextActions,
  };
}

function backgroundDagRunNextActions(run: SparkDagRunRecord, activeChildren: number): string[] {
  if (run.status === "running" && activeChildren > 0)
    return ["wait, inspect a child run, or kill a child only if it is stuck"];
  if (run.status === "running")
    return ["reconcile; if still incomplete, inspect stale tasks before starting more work"];
  if (run.status === "failed")
    return ["inspect the failed task/run, fix the cause, then rerun the ready frontier"];
  if (run.status === "stale")
    return [
      "reconcile with task runs and active processes; ack only after the stale record is understood",
    ];
  if (run.status === "timed_out")
    return [
      "legacy foreground timeout record; reconcile and inspect incomplete child runs before acking",
    ];
  return ["no action is required for this completed background record"];
}

function backgroundChildNextAction(child: SparkBackgroundChildRunView): string | undefined {
  if (child.activeProcess)
    return `wait for completion, or kill ${child.runRef} if this child is stuck`;
  if (child.status === "failed")
    return "inspect failed task/run evidence, fix the cause, then rerun";
  if (child.status === "queued" || child.status === "running")
    return "reconcile; no active process is currently tracked for this child";
  return undefined;
}

function collectBackgroundChildRuns(input: {
  graph: TaskGraph;
  dagRuns: SparkDagRunRecord[];
  activeProcesses: ActiveSparkRoleRunProcess[];
  threadRef?: ThreadRef;
  targetRunRef?: RunRef;
  targetTaskRef?: TaskRef;
}): SparkBackgroundChildRunView[] {
  const allTasks = input.graph.tasks();
  const taskByRef = new Map(allTasks.map((task) => [task.ref, task]));
  const allTaskRuns = input.graph.runs();
  const taskRunByRef = new Map(allTaskRuns.map((run) => [run.ref, run]));
  const dagRunRefByChild = new Map<RunRef, RunRef>();
  const childRunRefs = new Set<RunRef>();
  for (const dagRun of input.dagRuns) {
    for (const childRunRef of dagRun.taskRunRefs) {
      if (
        input.targetRunRef &&
        input.targetRunRef !== dagRun.ref &&
        input.targetRunRef !== childRunRef
      )
        continue;
      dagRunRefByChild.set(childRunRef, dagRun.ref);
      childRunRefs.add(childRunRef);
    }
  }
  for (const process of input.activeProcesses) childRunRefs.add(process.runRef);
  if (input.targetRunRef && !input.dagRuns.some((run) => run.ref === input.targetRunRef))
    childRunRefs.add(input.targetRunRef);
  for (const task of allTasks) {
    if (input.threadRef && task.threadRef !== input.threadRef) continue;
    if (input.targetTaskRef && task.ref !== input.targetTaskRef) continue;
    if (task.claim?.runRef) childRunRefs.add(task.claim.runRef);
  }
  for (const run of allTaskRuns) {
    if (input.threadRef && run.threadRef !== input.threadRef) continue;
    if (input.targetTaskRef && run.taskRef !== input.targetTaskRef) continue;
    if (input.targetRunRef && run.ref !== input.targetRunRef) continue;
    if (input.targetTaskRef || input.targetRunRef) childRunRefs.add(run.ref);
  }
  const activeByRunRef = new Map(input.activeProcesses.map((process) => [process.runRef, process]));
  const views = [...childRunRefs].flatMap((runRef): SparkBackgroundChildRunView[] => {
    const taskRun = taskRunByRef.get(runRef);
    const activeProcess = activeByRunRef.get(runRef);
    const task = taskRun
      ? taskByRef.get(taskRun.taskRef)
      : allTasks.find((candidate) => candidate.claim?.runRef === runRef);
    if (input.threadRef && task && task.threadRef !== input.threadRef) return [];
    if (input.threadRef && taskRun && taskRun.threadRef !== input.threadRef) return [];
    if (input.targetTaskRef && task?.ref !== input.targetTaskRef) return [];
    const status: SparkBackgroundChildStatus = activeProcess
      ? "active"
      : (taskRun?.status ?? (task?.status === "running" ? "running" : "unknown"));
    const view: SparkBackgroundChildRunView = {
      runRef,
      dagRunRef: dagRunRefByChild.get(runRef),
      taskRef: task?.ref ?? taskRun?.taskRef,
      taskName: task?.name,
      taskTitle: task?.title,
      taskStatus: task?.status,
      roleRef: activeProcess?.roleRef ?? taskRun?.roleRef ?? task?.claim?.roleRef,
      runName: activeProcess?.runName ?? taskRun?.runName ?? task?.claim?.runName,
      ownerSessionId: taskRun?.ownerSessionId ?? task?.claim?.sessionId,
      claimKind: task?.claim?.runRef === runRef ? task.claim.kind : undefined,
      pid: activeProcess?.pid,
      cwd: activeProcess?.cwd,
      startedAt: activeProcess?.startedAt ?? taskRun?.startedAt,
      finishedAt: taskRun?.finishedAt,
      timedOutAt: activeProcess?.timedOutAt,
      activeProcess: Boolean(activeProcess),
      status,
      summary: taskRun?.completionSummary?.summary,
      errorMessage: taskRun?.errorMessage,
      artifactRefs: [
        ...(taskRun?.completionSummary?.artifactRefs ?? []),
        ...(taskRun?.outputArtifacts ?? []).filter(
          (artifactRef) => !(taskRun?.completionSummary?.artifactRefs ?? []).includes(artifactRef),
        ),
      ],
    };
    view.nextAction = backgroundChildNextAction(view);
    return [view];
  });
  return views.sort((a, b) => {
    const byStatus = taskRunStatusRank(a.status) - taskRunStatusRank(b.status);
    if (byStatus !== 0) return byStatus;
    return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  });
}

async function enrichBackgroundChildRunsWithRoleRunArtifacts(input: {
  cwd: string;
  childRuns: SparkBackgroundChildRunView[];
}): Promise<SparkBackgroundChildRunView[]> {
  return Promise.all(
    input.childRuns.map(async (child) => {
      if (child.artifactRefs.length === 0) return child;
      const roleRunArtifacts = await Promise.all(
        child.artifactRefs.map((artifactRef) => readRoleRunArtifactPreview(input.cwd, artifactRef)),
      );
      const compact = roleRunArtifacts.find(
        (artifact) => artifact.summary || artifact.transcriptRef,
      );
      return {
        ...child,
        summary: child.summary ?? compact?.summary,
        transcriptRef: compact?.transcriptRef,
        stdoutTail: compact?.stdout,
        stderrTail: compact?.stderr,
        jsonEventsTail: compact?.jsonEvents,
        roleRunArtifacts,
      };
    }),
  );
}

async function readRoleRunArtifactPreview(
  cwd: string,
  artifactRef: ArtifactRef,
): Promise<SparkBackgroundRoleRunArtifactPreview> {
  const metadataPath = join(cwd, ".spark", "artifacts", `${refId(artifactRef)}.json`);
  let metadataStat: Awaited<ReturnType<typeof stat>>;
  try {
    metadataStat = await stat(metadataPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      artifactRef,
      skippedReason: `metadata_unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (metadataStat.size > SPARK_BACKGROUND_ROLE_RUN_METADATA_MAX_BYTES) {
    return {
      artifactRef,
      bodySize: metadataStat.size,
      skippedReason: `metadata_too_large: ${metadataStat.size} bytes; full artifact not loaded`,
    };
  }
  let rawMetadata: string;
  try {
    rawMetadata = await readFile(metadataPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      artifactRef,
      skippedReason: `metadata_unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let artifact: Artifact;
  try {
    artifact = JSON.parse(rawMetadata) as Artifact;
  } catch (error) {
    return {
      artifactRef,
      bodySize: metadataStat.size,
      skippedReason: `metadata_parse_failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (artifact.kind !== "role-run") {
    return {
      artifactRef,
      bodySize: artifact.bodySize,
      bodyTruncated: artifact.bodyTruncated,
      skippedReason: `not_role_run_artifact: ${artifact.kind}`,
    };
  }
  if (!isRoleRunArtifactBody(artifact.body)) {
    return {
      artifactRef,
      bodySize: artifact.bodySize,
      bodyTruncated: artifact.bodyTruncated,
      skippedReason: "legacy_or_unknown_role_run_body: full artifact not loaded",
    };
  }
  return {
    artifactRef,
    status: artifact.body.status,
    summary: artifact.body.summary,
    transcriptRef: artifact.body.transcriptRef,
    stdout: artifact.body.stdout,
    stderr: artifact.body.stderr,
    jsonEvents: artifact.body.jsonEvents,
    bodySize: artifact.bodySize,
    bodyTruncated: artifact.bodyTruncated,
  };
}

function isRoleRunArtifactBody(value: unknown): value is RoleRunArtifactBody {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.runRef === "string" &&
    typeof value.taskRef === "string" &&
    typeof value.roleRef === "string" &&
    typeof value.status === "string" &&
    typeof value.summary === "string" &&
    isRoleRunTextTail(value.stdout) &&
    isRoleRunTextTail(value.stderr) &&
    isRoleRunJsonEventsTail(value.jsonEvents)
  );
}

function isRoleRunTextTail(value: unknown): value is RoleRunTextTail {
  return (
    isRecord(value) &&
    typeof value.bytes === "number" &&
    typeof value.tail === "string" &&
    typeof value.tailBytes === "number" &&
    typeof value.truncated === "boolean"
  );
}

function isRoleRunJsonEventsTail(value: unknown): value is RoleRunJsonEventsTail {
  return (
    isRecord(value) &&
    typeof value.count === "number" &&
    Array.isArray(value.tail) &&
    value.tail.every((entry) => typeof entry === "string") &&
    typeof value.tailEventCount === "number" &&
    typeof value.truncated === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectBackgroundDagRuns(input: {
  runs: SparkDagRunRecord[];
  threadRef?: ThreadRef;
  includeHistory: boolean;
  targetRunRef?: RunRef;
  targetTaskRef?: TaskRef;
}): SparkDagRunRecord[] {
  const sorted = [...input.runs]
    .filter((run) => dagRunInThreadScope(run, input.threadRef))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (input.targetRunRef) {
    const targetRunRef = input.targetRunRef;
    const direct = sorted.filter((run) => run.ref === targetRunRef);
    if (direct.length > 0) return direct;
    const parent = sorted.filter((run) => run.taskRunRefs.includes(targetRunRef));
    if (parent.length > 0) return parent;
  }
  if (input.targetTaskRef) {
    const targetTaskRef = input.targetTaskRef;
    const taskRuns = sorted.filter((run) => run.scheduledTaskRefs.includes(targetTaskRef));
    if (taskRuns.length > 0) return taskRuns;
  }
  if (input.includeHistory) return sorted.slice(0, 10);
  return sorted
    .filter((run) => run.status === "running" || isActionableProblemDagRun(run))
    .slice(0, 10);
}

function summarizeBackgroundRuns(input: {
  dagRuns: SparkBackgroundDagRunView[];
  childRuns: SparkBackgroundChildRunView[];
}): SparkBackgroundRunsDetails["summary"] {
  const activeDagRun = input.dagRuns.find((run) => run.status === "running");
  const activeChildren = input.childRuns.filter((child) => child.activeProcess).length;
  const actionable = input.dagRuns.filter(
    (run) =>
      (run.status === "failed" || run.status === "stale" || run.status === "timed_out") &&
      !run.acknowledgedAt,
  );
  const problem = actionable[0];
  const scheduled = activeDagRun?.scheduled ?? problem?.scheduled ?? 0;
  const completed = activeDagRun?.completed ?? problem?.completed ?? 0;
  if (activeChildren > 0) {
    return {
      state: "running",
      activeDagRunRef: activeDagRun?.runRef,
      activeChildren,
      scheduled,
      completed,
      actionableProblems: actionable.length,
      nextAction: "wait, inspect a child run, or kill a child only if it is stuck",
    };
  }
  if (activeDagRun) {
    return {
      state: "stale",
      activeDagRunRef: activeDagRun.runRef,
      activeChildren,
      scheduled,
      completed,
      actionableProblems: actionable.length,
      nextAction: "reconcile; if still incomplete, inspect stale tasks",
    };
  }
  if (problem) {
    const state: SparkBackgroundSummaryState =
      problem.status === "timed_out"
        ? "legacy_timeout"
        : problem.status === "stale"
          ? "stale"
          : "needs_attention";
    return {
      state,
      activeChildren,
      scheduled,
      completed,
      actionableProblems: actionable.length,
      nextAction: problem.nextActions[0] ?? "inspect the problem record before continuing",
    };
  }
  return {
    state: "idle",
    activeChildren,
    scheduled: 0,
    completed: 0,
    actionableProblems: 0,
    nextAction: "no background work is active",
  };
}

export async function buildSparkBackgroundDetails(input: {
  action: SparkBackgroundAction;
  cwd: string;
  graph: TaskGraph;
  dagRunStore: ReturnType<typeof defaultSparkDagRunStore>;
  currentThreadRef?: ThreadRef;
  threadRef?: ThreadRef;
  runMode?: SparkBackgroundRunModeState;
  includeHistory: boolean;
  targetRunRef?: RunRef;
  targetTaskRef?: TaskRef;
  killed?: SparkBackgroundRunsDetails["killed"];
  acknowledged?: SparkBackgroundRunsDetails["acknowledged"];
}): Promise<SparkBackgroundRunsDetails> {
  const snapshot = await input.dagRunStore.load();
  const runMode = input.runMode;
  const scopeThreadRef = input.threadRef ?? input.currentThreadRef;
  const selectedDagRuns = selectBackgroundDagRuns({
    runs: snapshot.runs,
    threadRef: scopeThreadRef,
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
      threadRef: scopeThreadRef,
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
    currentThreadRef: input.currentThreadRef,
    runMode:
      runMode && (!scopeThreadRef || runMode.threadRef === scopeThreadRef)
        ? {
            runRef: runMode.runRef,
            threadRef: runMode.threadRef,
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
  dagRunStore: ReturnType<typeof defaultSparkDagRunStore>;
  snapshot: Awaited<ReturnType<ReturnType<typeof defaultSparkDagRunStore>["load"]>>;
  sessionId: string;
  threadRef?: ThreadRef;
  runRef?: RunRef;
}): Promise<NonNullable<SparkBackgroundRunsDetails["acknowledged"]>> {
  if (input.runRef)
    return input.dagRunStore.acknowledgeFailures({
      runRef: input.runRef,
      sessionId: input.sessionId,
    });
  const targets = input.snapshot.runs
    .filter((run) => dagRunInThreadScope(run, input.threadRef))
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

function roleRunTailMetadata(tail: RoleRunTextTail): string {
  const shown = tail.truncated ? `, showing last ${tail.tailBytes} bytes` : "";
  const suffix = tail.truncated ? " (truncated)" : "";
  return `${tail.bytes} bytes${shown}${suffix}`;
}

function jsonEventsTailMetadata(tail: RoleRunJsonEventsTail): string {
  const shown = tail.truncated ? `, showing last ${tail.tailEventCount}` : "";
  const suffix = tail.truncated ? " (truncated)" : "";
  return `${tail.count} event(s)${shown}${suffix}`;
}

function appendBackgroundChildSummaryLines(
  lines: string[],
  child: SparkBackgroundChildRunView,
  indent: string,
): void {
  if (child.summary) lines.push(`${indent}Summary: ${child.summary}`);
  else if (child.errorMessage) lines.push(`${indent}Error: ${child.errorMessage}`);
  if (child.artifactRefs.length > 0)
    lines.push(`${indent}Artifacts: ${child.artifactRefs.join(",")}`);
  if (child.transcriptRef) lines.push(`${indent}Transcript: ${child.transcriptRef}`);
  if (child.stdoutTail)
    lines.push(`${indent}Stdout tail: ${roleRunTailMetadata(child.stdoutTail)}`);
  if (child.stderrTail)
    lines.push(`${indent}Stderr tail: ${roleRunTailMetadata(child.stderrTail)}`);
  if (child.jsonEventsTail)
    lines.push(`${indent}JSON events tail: ${jsonEventsTailMetadata(child.jsonEventsTail)}`);
  for (const artifact of child.roleRunArtifacts ?? []) {
    if (artifact.skippedReason)
      lines.push(`${indent}Artifact ${artifact.artifactRef}: ${artifact.skippedReason}`);
  }
}

function renderBackgroundChildListLine(child: SparkBackgroundChildRunView): string {
  const taskLabel = child.taskName
    ? ` task=@${child.taskName}`
    : child.taskRef
      ? ` task=${child.taskRef}`
      : "";
  const roleLabel = child.roleRef ? ` ${shortRoleLabel(child.roleRef)}` : "";
  const summary = child.summary ? ` — ${child.summary}` : "";
  return `  - ${child.runRef}: ${child.status}${roleLabel}${taskLabel}${summary}`;
}

function shortRoleLabel(roleRef: string): string {
  return roleRef.replace(/^role:(builtin-|project-|user-)?/, "");
}

export function renderSparkBackgroundRunsText(
  details: SparkBackgroundRunsDetails,
  options: { includeDetails: boolean },
): string {
  const lines: string[] = [];
  const activeRunRef = details.summary.activeDagRunRef;
  const problem = details.dagRuns.find(
    (run) =>
      (run.status === "failed" || run.status === "stale" || run.status === "timed_out") &&
      !run.acknowledgedAt,
  );
  if (details.action === "kill") {
    lines.push(`Stopped background child runs: ${details.killed?.length ?? 0}`);
    for (const killed of details.killed ?? []) {
      const task = details.childRuns.find((child) => child.runRef === killed.runRef);
      const taskLabel = task?.taskName ? ` task=@${task.taskName}` : "";
      lines.push(
        `  - ${killed.runRef} ${shortRoleLabel(killed.roleRef)}${taskLabel} signal=${killed.signal} forceScheduled=${killed.forceScheduled}`,
      );
    }
    lines.push(`Next: ${details.summary.nextAction}.`);
    return lines.join("\n");
  }
  if (details.action === "ack") {
    lines.push(
      `Acknowledged background problem runs: ${details.acknowledged?.acknowledged.length ?? 0} newly, ${details.acknowledged?.alreadyAcknowledged.length ?? 0} already, ${details.acknowledged?.skipped.length ?? 0} skipped, ${details.acknowledged?.missing.length ?? 0} missing`,
    );
    lines.push(`Next: ${details.summary.nextAction}.`);
    return lines.join("\n");
  }
  if (details.action === "inspect" && details.childRuns.length === 1) {
    const child = details.childRuns[0]!;
    lines.push(`Background child run: ${child.runRef} ${child.status}`);
    if (child.taskName || child.taskTitle)
      lines.push(
        `  Task: ${child.taskName ? `@${child.taskName}` : child.taskRef} — ${child.taskTitle ?? "untitled"}`,
      );
    if (child.roleRef || child.pid)
      lines.push(
        `  Role: ${child.roleRef ? shortRoleLabel(child.roleRef) : "unknown"}${child.pid ? ` pid=${child.pid}` : ""}${child.startedAt ? ` started=${child.startedAt}` : ""}`,
      );
    if (child.dagRunRef) lines.push(`  DAG: ${child.dagRunRef}`);
    if (child.claimKind)
      lines.push(
        `  Claim: ${child.claimKind}${child.ownerSessionId ? ` owner=${child.ownerSessionId}` : ""}`,
      );
    appendBackgroundChildSummaryLines(lines, child, "  ");
    lines.push(`  Next: ${child.nextAction ?? details.summary.nextAction}.`);
    return lines.join("\n");
  }
  if (details.summary.state === "running") {
    lines.push(`Background work: running${activeRunRef ? ` ${activeRunRef}` : ""}`);
    lines.push(
      `  Progress: ${details.summary.completed}/${details.summary.scheduled} tasks finished, ${details.summary.activeChildren} active child runs`,
    );
  } else if (problem?.status === "timed_out") {
    lines.push(`Background work: legacy timeout record ${problem.runRef}`);
    lines.push(
      "  This is an old foreground-wait timeout record; new background runs should stay running while children are active.",
    );
    lines.push(`  Progress: ${problem.completed}/${problem.scheduled} tasks observed finished`);
  } else if (problem) {
    lines.push(`Background work: ${details.summary.state.replace("_", " ")}`);
    lines.push(
      `  Last problem: ${problem.status} ${problem.runRef}, ${problem.completed}/${problem.scheduled} tasks finished`,
    );
  } else if (details.summary.state === "stale" && activeRunRef) {
    lines.push(`Background work: stale ${activeRunRef}`);
    lines.push(
      `  Progress: ${details.summary.completed}/${details.summary.scheduled} tasks finished, no active child process is tracked`,
    );
  } else {
    lines.push("Background work: idle");
  }
  const activeChildren = details.childRuns.filter((candidate) => candidate.activeProcess);
  if (activeChildren.length > 0) {
    lines.push("  Active children:");
    for (const child of activeChildren) {
      const taskLabel = child.taskName
        ? ` task=@${child.taskName}`
        : child.taskRef
          ? ` task=${child.taskRef}`
          : "";
      const pidLabel = child.pid ? ` pid=${child.pid}` : "";
      const summaryLabel = child.summary ? ` — ${child.summary}` : "";
      lines.push(
        `  - ${child.runRef} ${child.roleRef ? shortRoleLabel(child.roleRef) : "unknown"}${taskLabel}${pidLabel}${summaryLabel}`,
      );
    }
  }
  if (details.action === "list" && details.childRuns.length > 0) {
    lines.push("  Child runs:");
    for (const child of details.childRuns) lines.push(renderBackgroundChildListLine(child));
  }
  if (options.includeDetails) {
    for (const run of details.dagRuns) {
      lines.push(
        `  DAG ${run.runRef}: ${run.status} scheduled=${run.scheduled} completed=${run.completed} incomplete=${run.incompleteTaskRefs.join(",") || "none"}`,
      );
      if (run.legacyTimedOut)
        lines.push(
          "    Legacy timeout record: old foreground-wait timeout; reconcile/inspect before acking.",
        );
      for (const action of run.nextActions) lines.push(`    Next: ${action}`);
    }
    for (const child of details.childRuns.filter((candidate) => !candidate.activeProcess)) {
      lines.push(
        `  Child ${child.runRef}: ${child.status}${child.taskName ? ` task=@${child.taskName}` : ""}${child.claimKind ? ` claim=${child.claimKind}` : ""}`,
      );
      appendBackgroundChildSummaryLines(lines, child, "    ");
    }
  }
  lines.push(`  Next: ${details.summary.nextAction}.`);
  return lines.join("\n");
}
