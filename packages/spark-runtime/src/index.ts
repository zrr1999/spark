export * from "./workflow-role-run-adapter.ts";

import type { ChildProcess } from "node:child_process";
import {
  buildRoleRunArgs as buildGenericRoleRunArgs,
  defaultUserRoleModelBindingStore,
  parsePiJsonlEvents,
  RoleRunCancelledError,
  RoleRunTimeoutError as PiRoleRunTimeoutError,
  runRole,
  type RoleRegistry,
  type RoleRunMode,
} from "pi-roles";
import type { ArtifactStore } from "pi-artifacts";
import {
  DependencyError,
  type ArtifactRef,
  type JsonValue,
  newRef,
  nowIso,
  refId,
  type RoleRef,
  type RunRef,
  type Task,
  type TaskRef,
  type TaskRun,
  type TaskRunCompletionSummary,
  type TaskTodo,
} from "pi-extension-api";
import type { RoleInstruction, RoleRunRecord, RoleRunStatus } from "pi-roles";
import {
  taskCompletionReadiness,
  type TaskGraph,
  type TaskGraphStore,
  type TaskGraphStoreUpdateOptions,
} from "pi-tasks";
import {
  type RoleRunArtifactBody,
  type RoleRunJsonEventsTail,
  type RoleRunTextTail,
} from "./role-run-artifacts.ts";

export {
  SPARK_ROLE_RUN_ARTIFACT_PREVIEW_METADATA_MAX_BYTES,
  SPARK_ROLE_RUN_RETENTION_TAIL_BYTES,
  collectRoleRunArtifactRetentionPlan,
  isRoleRunArtifactBody,
  isRoleRunJsonEventsTail,
  isRoleRunTextTail,
  readRoleRunArtifactPreview,
  type RoleRunArtifactBody,
  type RoleRunArtifactPreview,
  type RoleRunArtifactRetentionCandidate,
  type RoleRunArtifactRetentionPlan,
  type RoleRunArtifactRetentionSkipReason,
  type RoleRunArtifactRetentionSkipped,
  type RoleRunJsonEventsTail,
  type RoleRunTextTail,
} from "./role-run-artifacts.ts";

export interface SparkRoleRunResult {
  record: RoleRunRecord;
  stdout: string;
  stderr: string;
  jsonEvents: unknown[];
}

export { type RoleRunMode } from "pi-roles";

export interface ActiveSparkRoleRunProcess {
  runRef: RunRef;
  roleRef: RoleRef;
  runName?: string;
  pid?: number;
  cwd: string;
  startedAt: string;
  timedOutAt?: string;
}

export interface KillSparkRoleRunProcessOptions {
  runRef?: RunRef;
  runRefs?: RunRef[];
  runName?: string;
  runNames?: string[];
  reason?: string;
  signal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  forceAfterMs?: number;
  waitMs?: number;
}

export interface KillSparkRoleRunProcessResult extends ActiveSparkRoleRunProcess {
  signal: NodeJS.Signals;
  forceSignal: NodeJS.Signals;
  signalSent: boolean;
  forceScheduled: boolean;
  closed: boolean;
  errorMessage?: string;
}

interface TrackedSparkRoleRunProcess extends ActiveSparkRoleRunProcess {
  child: ChildProcess;
  closed: boolean;
  forceKillTimer?: ReturnType<typeof setTimeout>;
  terminationReason?: string;
}

const EMPTY_ROLE_RUN_FAILURE_KIND = "runtime_error";
const MAX_TASK_ROLE_INSTRUCTION_CHARS = 6_000;
const MAX_TASK_ROLE_TODO_PREVIEW_ITEMS = 2;
const MAX_ROLE_RUN_ARTIFACT_TEXT_TAIL_BYTES = 12 * 1024;
const MAX_ROLE_RUN_ARTIFACT_JSON_EVENT_TAIL_COUNT = 10;
const MAX_ROLE_RUN_ARTIFACT_JSON_EVENT_CHARS = 1_000;
const DEFAULT_ROLE_RUN_FORCE_KILL_AFTER_MS = 1_000;
const DEFAULT_ROLE_RUN_SHUTDOWN_WAIT_MS = 3_000;
const activeSparkRoleRunProcesses = new Map<RunRef, TrackedSparkRoleRunProcess>();

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

export function listActiveSparkRoleRunProcesses(): ActiveSparkRoleRunProcess[] {
  return [...activeSparkRoleRunProcesses.values()].map(snapshotSparkRoleRunProcess);
}

export async function killActiveSparkRoleRunProcesses(
  options: KillSparkRoleRunProcessOptions = {},
): Promise<KillSparkRoleRunProcessResult[]> {
  const hasRunFilter = options.runRef !== undefined || options.runRefs !== undefined;
  const hasNameFilter = options.runName !== undefined || options.runNames !== undefined;
  const runRefs = new Set([
    ...(options.runRefs ?? []),
    ...(options.runRef ? [options.runRef] : []),
  ]);
  const runNames = new Set([
    ...(options.runNames ?? []),
    ...(options.runName ? [options.runName] : []),
  ]);
  const targets = [...activeSparkRoleRunProcesses.values()].filter((record) => {
    if (hasRunFilter && !runRefs.has(record.runRef)) return false;
    if (hasNameFilter && !runNames.has(record.runName ?? "")) return false;
    return true;
  });
  return Promise.all(targets.map((record) => killTrackedSparkRoleRunProcess(record, options)));
}

function trackSparkRoleRunProcess(input: {
  child: ChildProcess;
  runRef: RunRef;
  roleRef: RoleRef;
  runName?: string;
  cwd: string;
  startedAt: string;
}): TrackedSparkRoleRunProcess {
  const tracked: TrackedSparkRoleRunProcess = {
    runRef: input.runRef,
    roleRef: input.roleRef,
    runName: input.runName,
    pid: input.child.pid,
    cwd: input.cwd,
    startedAt: input.startedAt,
    child: input.child,
    closed: input.child.exitCode !== null || input.child.signalCode !== null,
  };
  if (tracked.closed) return tracked;
  activeSparkRoleRunProcesses.set(input.runRef, tracked);
  input.child.once("close", () => {
    tracked.closed = true;
    if (tracked.forceKillTimer) clearTimeout(tracked.forceKillTimer);
    activeSparkRoleRunProcesses.delete(input.runRef);
  });
  input.child.once("error", () => {
    tracked.closed = true;
    if (tracked.forceKillTimer) clearTimeout(tracked.forceKillTimer);
    activeSparkRoleRunProcesses.delete(input.runRef);
  });
  return tracked;
}

function untrackSparkRoleRunProcess(runRef: RunRef): void {
  const tracked = activeSparkRoleRunProcesses.get(runRef);
  if (tracked?.forceKillTimer) clearTimeout(tracked.forceKillTimer);
  activeSparkRoleRunProcesses.delete(runRef);
}

function snapshotSparkRoleRunProcess(
  record: TrackedSparkRoleRunProcess,
): ActiveSparkRoleRunProcess {
  return {
    runRef: record.runRef,
    roleRef: record.roleRef,
    runName: record.runName,
    pid: record.pid,
    cwd: record.cwd,
    startedAt: record.startedAt,
    timedOutAt: record.timedOutAt,
  };
}

async function killTrackedSparkRoleRunProcess(
  record: TrackedSparkRoleRunProcess,
  options: KillSparkRoleRunProcessOptions,
): Promise<KillSparkRoleRunProcessResult> {
  const signal = options.signal ?? "SIGTERM";
  const forceSignal = options.forceSignal ?? "SIGKILL";
  const forceAfterMs = options.forceAfterMs ?? DEFAULT_ROLE_RUN_FORCE_KILL_AFTER_MS;
  const waitMs = options.waitMs ?? DEFAULT_ROLE_RUN_SHUTDOWN_WAIT_MS;
  record.terminationReason = options.reason;
  let signalSent = false;
  let errorMessage: string | undefined;

  if (!record.closed) {
    try {
      signalSent = record.child.kill(signal);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  let forceScheduled = false;
  if (!record.closed && forceAfterMs >= 0) {
    forceScheduled = true;
    record.forceKillTimer = setTimeout(() => {
      if (!record.closed) record.child.kill(forceSignal);
    }, forceAfterMs);
    record.forceKillTimer.unref?.();
  }

  const closed = await waitForTrackedSparkRoleRunClose(record, waitMs);
  return {
    ...snapshotSparkRoleRunProcess(record),
    signal,
    forceSignal,
    signalSent,
    forceScheduled,
    closed,
    errorMessage,
  };
}

async function waitForTrackedSparkRoleRunClose(
  record: TrackedSparkRoleRunProcess,
  waitMs: number,
): Promise<boolean> {
  if (record.closed) return true;
  return new Promise<boolean>((resolve) => {
    const done = () => {
      cleanup();
      resolve(true);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve(record.closed);
    }, waitMs);
    const cleanup = () => {
      clearTimeout(timeout);
      record.child.off("close", done);
      record.child.off("error", done);
    };
    timeout.unref?.();
    record.child.once("close", done);
    record.child.once("error", done);
  });
}

export function createRoleRunName(roleRef: RoleRef, runRef: RunRef, roleId?: string): string {
  const base = sanitizeRoleRunName(
    roleId?.trim() || refId(roleRef).replace(/^(builtin-|project-|user-)/, ""),
  );
  const suffix = sanitizeRoleRunName(refId(runRef)).slice(0, 8) || "run";
  return `${base}-${suffix}`;
}

function sanitizeRoleRunName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-") || "role"
  );
}

export function createRoleRunClaimId(sessionId: string | undefined, runName: string): string {
  const sessionPart = sanitizeClaimPart(sessionId?.trim() || "session:unknown");
  const runPart = sanitizeClaimPart(runName.trim() || "role");
  return `${sessionPart}+${runPart}`;
}

function sanitizeClaimPart(value: string): string {
  return value.replace(/\+/g, "-").replace(/\s+/g, "-") || "unknown";
}

export interface PiRoleCommandInput {
  roleRef: RoleRef;
  systemPrompt: string;
  instruction: string;
  model?: string;
  sessionDir?: string;
  mode?: RoleRunMode;
  forkFromSession?: string;
}

export function buildRoleRunArgs(input: PiRoleCommandInput): string[] {
  return buildGenericRoleRunArgs({
    roleRef: input.roleRef,
    mode: input.mode,
    systemPrompt: input.systemPrompt,
    instruction: input.instruction,
    model: input.model,
    runGuidance: sparkRoleRunGuidance(),
    sessionDir: input.sessionDir,
    forkFromSession: input.forkFromSession,
  });
}

export interface RoleRunnerOptions {
  cwd: string;
  piCommand?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  sessionDir?: string;
  runName?: string;
  mode?: RoleRunMode;
  forkFromSession?: string;
}

export interface SparkTaskRunOptions {
  graph: TaskGraph;
  taskRef: TaskRef;
  registry: RoleRegistry;
  /** Concrete executor role assigned for this run. Falls back to task.roleRef, then kind defaults. */
  assignedRoleRef?: RoleRef;
  /** Fallback role used only when assignedRoleRef and task.roleRef are both absent. */
  defaultRoleRef?: RoleRef;
  artifactStore?: ArtifactStore;
  cwd?: string;
  piCommand?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  sessionDir?: string;
  mode?: RoleRunMode;
  forkFromSession?: string;
  heartbeatIntervalMs?: number;
  onHeartbeat?: (graph: TaskGraph) => void | Promise<void>;
  claim?: {
    kind?: "main" | "role-run";
    /** Concrete claimant identity. Defaults to `${sessionId}+${runName}` for role runs. */
    claimedBy?: string;
    /** Human-readable name for this concrete role run; roleRef remains the spec/type. */
    runName?: string;
    sessionId?: string;
    leaseMs?: number;
  };
}

export class TaskClaimHeartbeatError extends Error {
  constructor(error: unknown) {
    super(`task claim heartbeat failed: ${unknownErrorMessage(error)}`);
    this.name = "TaskClaimHeartbeatError";
  }
}

export interface ExpiredTaskClaimSweepResult {
  graph: TaskGraph | null;
  expired: Task[];
  saved: boolean;
}

export function findResumableBackgroundRoleRunTasks(
  graph: TaskGraph,
  ownerSessionId: string,
): Task[] {
  return graph
    .tasks()
    .filter(
      (task) =>
        task.claim?.kind === "role-run" &&
        task.claim.sessionId === ownerSessionId &&
        Boolean(task.claim.roleRef ?? task.roleRef) &&
        (task.status === "running" || task.status === "pending" || task.status === "ready"),
    );
}

export async function sweepExpiredTaskClaims(
  store: Pick<TaskGraphStore, "withLock" | "load" | "save">,
  now = nowIso(),
  options: Omit<TaskGraphStoreUpdateOptions, "createIfMissing"> = {},
): Promise<ExpiredTaskClaimSweepResult> {
  return store.withLock(async () => {
    const graph = await store.load();
    if (!graph) return { graph: null, expired: [], saved: false };
    const expired = graph.expireTaskClaims(now);
    if (expired.length === 0) return { graph, expired, saved: false };
    await store.save(graph);
    return { graph, expired, saved: true };
  }, options);
}

export async function runSparkTask(input: SparkTaskRunOptions): Promise<TaskRun> {
  const task = input.graph.getTask(input.taskRef);
  const taskRoleRef = input.assignedRoleRef ?? sparkTaskExecutorRoleRef(task, input.defaultRoleRef);
  const unmet = input.graph
    .dependencies(task.projectRef)
    .filter(
      (dep) => dep.taskRef === task.ref && input.graph.getTask(dep.dependsOn).status !== "done",
    );
  if (unmet.length > 0) throw new DependencyError(`task has unmet dependencies: ${task.ref}`);

  const runRef = newRef("run");
  const dryRun = input.dryRun ?? true;
  const originalStatus = task.status;
  const roleSpec = input.registry.get(taskRoleRef);
  const runName =
    input.claim?.runName?.trim() || createRoleRunName(taskRoleRef, runRef, roleSpec.id);
  const claimKind = input.claim?.kind ?? "role-run";
  const claimedBy =
    input.claim?.claimedBy?.trim() ||
    (claimKind === "role-run" ? createRoleRunClaimId(input.claim?.sessionId, runName) : runName);
  const ownerSessionId = input.claim?.sessionId;
  const leaseMs = input.claim?.leaseMs ?? input.timeoutMs ?? 600_000;
  if (!dryRun) {
    input.graph.claimTask(task.ref, {
      kind: claimKind,
      claimedBy,
      roleRef: taskRoleRef,
      runName,
      sessionId: input.claim?.sessionId,
      runRef,
      leaseMs,
    });
  }

  const run: TaskRun = {
    ref: runRef,
    projectRef: task.projectRef,
    taskRef: task.ref,
    roleRef: taskRoleRef,
    runName,
    ownerSessionId,
    status: "running",
    startedAt: nowIso(),
    outputArtifacts: [],
  };
  input.graph.recordRun(run);
  const heartbeatAbort = dryRun ? undefined : new AbortController();
  const runSignal = combineAbortSignals([input.signal, heartbeatAbort?.signal]);
  const stopHeartbeat = dryRun
    ? undefined
    : startTaskClaimHeartbeat({
        graph: input.graph,
        taskRef: task.ref,
        claimedBy,
        leaseMs,
        intervalMs: input.heartbeatIntervalMs,
        onHeartbeat: input.onHeartbeat,
        onError: (error) => {
          heartbeatAbort?.abort(new TaskClaimHeartbeatError(error));
        },
      });

  try {
    const result = await runRoleInstructionOnly(
      input.registry,
      {
        roleRef: taskRoleRef,
        instruction: buildSparkTaskRoleInstruction(task, input.graph),
        inputs: task.inputArtifacts,
      },
      {
        cwd: input.cwd ?? process.cwd(),
        piCommand: input.piCommand,
        dryRun,
        timeoutMs: input.timeoutMs,
        signal: runSignal,
        sessionDir: input.sessionDir,
        runName,
        mode: input.mode,
        forkFromSession: input.forkFromSession,
      },
      runRef,
    );

    let outputArtifactRef: ArtifactRef | undefined;
    if (input.artifactStore) {
      const artifact = await input.artifactStore.put({
        kind: "role-run",
        title: `Role run ${runName} for ${task.title}`,
        format: "json",
        body: createRoleRunArtifactBody({
          result,
          taskRef: task.ref,
          roleRef: taskRoleRef,
        }) as unknown as JsonValue,
        provenance: {
          producer: "task",
          projectRef: task.projectRef,
          taskRef: task.ref,
          roleRef: taskRoleRef,
          runRef,
          note: `runName=${runName}`,
        },
      });
      outputArtifactRef = artifact.ref;
      input.graph.attachOutputArtifact(task.ref, artifact.ref);
    }

    const completionFailure =
      roleRunCompletionFailure(result, dryRun) ??
      roleRunEvidenceCompletionFailure(
        input.graph.getTask(task.ref),
        dryRun,
        Boolean(input.artifactStore),
      );
    const succeeded = !completionFailure;
    const finishedAt = nowIso();
    const outputArtifacts = outputArtifactRef ? [outputArtifactRef] : [];
    const finished: TaskRun = {
      ...run,
      status: succeeded ? "succeeded" : "failed",
      failureKind: completionFailure ? EMPTY_ROLE_RUN_FAILURE_KIND : undefined,
      errorMessage: completionFailure,
      finishedAt,
      outputArtifacts,
      completionSummary: dryRun
        ? undefined
        : createTaskRunCompletionSummary({
            run,
            status: succeeded ? "succeeded" : "failed",
            finishedAt,
            outputArtifacts,
            summary: completionFailure ?? summarizeRoleRunResult(result),
          }),
    };
    input.graph.recordRun(finished);
    if (dryRun) input.graph.setTaskStatus(task.ref, originalStatus);
    else input.graph.setTaskStatus(task.ref, succeeded ? "done" : "failed");
    return finished;
  } catch (error) {
    if (error instanceof RoleRunTimeoutError && !dryRun) {
      const errorMessage = error.message;
      const finishedAt = nowIso();
      const failed: TaskRun = {
        ...run,
        status: "failed",
        failureKind: "runtime_timeout",
        errorMessage,
        finishedAt,
        outputArtifacts: [],
        completionSummary: createTaskRunCompletionSummary({
          run,
          status: "failed",
          finishedAt,
          outputArtifacts: [],
          summary: errorMessage,
        }),
      };
      input.graph.recordRun(failed);
      input.graph.setTaskStatus(task.ref, "failed");
      return failed;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const finishedAt = nowIso();
    const failed: TaskRun = {
      ...run,
      status: "failed",
      failureKind: error instanceof RoleRunTimeoutError ? "runtime_timeout" : "runtime_error",
      errorMessage,
      finishedAt,
      outputArtifacts: [],
      completionSummary: dryRun
        ? undefined
        : createTaskRunCompletionSummary({
            run,
            status: "failed",
            finishedAt,
            outputArtifacts: [],
            summary: errorMessage,
          }),
    };
    input.graph.recordRun(failed);
    input.graph.setTaskStatus(task.ref, dryRun ? originalStatus : "failed");
    throw error;
  } finally {
    stopHeartbeat?.();
  }
}

function buildSparkTaskRoleInstruction(task: Task, graph: TaskGraph): string {
  const sections = [task.description.trim()];
  if (task.plan) {
    sections.push(
      [
        "Task plan (execution contract):",
        `- Objective: ${task.plan.objective}`,
        renderInstructionList("Success criteria", task.plan.successCriteria),
        renderInstructionList("Evidence required", task.plan.evidenceRequired),
        renderInstructionList("Steps", task.plan.steps),
        renderInstructionList("Constraints", task.plan.constraints),
        renderInstructionList("Non-goals", task.plan.nonGoals),
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }

  const todos = selectTaskTodoPreview(graph.taskTodos(task.ref));
  if (todos.visible.length > 0) {
    sections.push(
      [
        `Current task TODO preview (showing ${todos.visible.length}/${todos.total} active item${todos.total === 1 ? "" : "s"}; do not expand the full TODO list unless needed):`,
        ...todos.visible.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`),
        todos.hidden > 0
          ? `- … ${todos.hidden} more TODO(s) hidden from the role-run prompt`
          : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }

  return boundTaskRoleInstruction(sections.filter(Boolean).join("\n\n"));
}

function renderInstructionList(label: string, values: readonly string[]): string | undefined {
  if (values.length === 0) return undefined;
  const visible = values.slice(0, 6).map((value) => `  - ${value}`);
  const hidden = values.length - visible.length;
  return [`- ${label}:`, ...visible, hidden > 0 ? `  - … ${hidden} more` : undefined]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function selectTaskTodoPreview(todos: TaskTodo[]): {
  visible: TaskTodo[];
  total: number;
  hidden: number;
} {
  const active = todos.filter(
    (todo) => todo.status !== "done" && todo.status !== "cancelled" && todo.status !== "deleted",
  );
  const visible = [...active]
    .sort((a, b) => taskTodoInstructionRank(a) - taskTodoInstructionRank(b))
    .slice(0, MAX_TASK_ROLE_TODO_PREVIEW_ITEMS);
  return { visible, total: active.length, hidden: active.length - visible.length };
}

function taskTodoInstructionRank(todo: TaskTodo): number {
  switch (todo.status) {
    case "in_progress":
      return 0;
    case "blocked":
      return 1;
    case "pending":
      return 2;
    default:
      return 3;
  }
}

function boundTaskRoleInstruction(instruction: string): string {
  if (instruction.length <= MAX_TASK_ROLE_INSTRUCTION_CHARS) return instruction;
  return `${instruction.slice(0, MAX_TASK_ROLE_INSTRUCTION_CHARS).trimEnd()}\n\n… task instruction truncated; inspect task({ action: "status" }) and artifact({ action: "read" }) if more context is needed.`;
}

function createRoleRunArtifactBody(input: {
  result: SparkRoleRunResult;
  taskRef: TaskRef;
  roleRef: RoleRef;
}): RoleRunArtifactBody {
  const { result } = input;
  return {
    schemaVersion: 1,
    runRef: result.record.ref,
    taskRef: input.taskRef,
    roleRef: input.roleRef,
    runName: result.record.runName,
    status: result.record.status,
    startedAt: result.record.startedAt,
    finishedAt: result.record.finishedAt,
    summary: summarizeRoleRunResult(result),
    record: compactRoleRunRecord(result.record),
    stdout: createTextTail(result.stdout),
    stderr: createTextTail(result.stderr),
    jsonEvents: createJsonEventsTail(result.jsonEvents),
  };
}

function compactRoleRunRecord(record: RoleRunRecord): Omit<RoleRunRecord, "instruction"> {
  const { instruction: _instruction, ...compact } = record;
  return compact;
}

function createTextTail(
  text: string,
  maxBytes = MAX_ROLE_RUN_ARTIFACT_TEXT_TAIL_BYTES,
): RoleRunTextTail {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { bytes, tail: text, tailBytes: bytes, truncated: false };
  const tail = Buffer.from(text, "utf8").subarray(-maxBytes).toString("utf8");
  return {
    bytes,
    tail,
    tailBytes: Buffer.byteLength(tail, "utf8"),
    truncated: true,
  };
}

function createJsonEventsTail(
  events: unknown[],
  maxEvents = MAX_ROLE_RUN_ARTIFACT_JSON_EVENT_TAIL_COUNT,
): RoleRunJsonEventsTail {
  const rawTail = events.slice(-maxEvents);
  let truncated = events.length > rawTail.length;
  const tail = rawTail.map((event) => {
    const serialized = JSON.stringify(event) ?? String(event);
    if (serialized.length <= MAX_ROLE_RUN_ARTIFACT_JSON_EVENT_CHARS) return serialized;
    truncated = true;
    return `${serialized.slice(0, MAX_ROLE_RUN_ARTIFACT_JSON_EVENT_CHARS).trimEnd()}…`;
  });
  return {
    count: events.length,
    tail,
    tailEventCount: tail.length,
    truncated,
  };
}

function createTaskRunCompletionSummary(input: {
  run: TaskRun;
  status: TaskRunCompletionSummary["status"];
  finishedAt: string;
  outputArtifacts: ArtifactRef[];
  summary: string;
}): TaskRunCompletionSummary {
  return {
    runRef: input.run.ref,
    taskRef: input.run.taskRef,
    roleRef: input.run.roleRef,
    runName: input.run.runName,
    status: input.status,
    summary: boundCompletionSummary(input.summary),
    artifactRefs: [...input.outputArtifacts],
    createdAt: input.finishedAt,
  };
}

function summarizeRoleRunResult(result: SparkRoleRunResult): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const parts = [stdout, stderr ? `stderr: ${stderr}` : ""].filter(Boolean);
  if (parts.length > 0) return summarizeText(parts.join("\n"));
  if (result.jsonEvents.length > 0) return summarizeText(JSON.stringify(result.jsonEvents.at(-1)));
  return `role run finished with status ${result.record.status}`;
}

function summarizeText(text: string): string {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  return boundCompletionSummary(lines.join(" "));
}

function boundCompletionSummary(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return "role run finished without summary output";
  return normalized.length <= 300 ? normalized : `${normalized.slice(0, 300).trimEnd()}…`;
}

function roleRunEvidenceCompletionFailure(
  task: Task,
  dryRun: boolean,
  enforceEvidence: boolean,
): string | undefined {
  if (dryRun || !enforceEvidence) return undefined;
  const readiness = taskCompletionReadiness(task);
  return readiness.ready ? undefined : readiness.issues.map((issue) => issue.message).join("; ");
}

function roleRunCompletionFailure(result: SparkRoleRunResult, dryRun: boolean): string | undefined {
  if (result.record.status === "succeeded") {
    if (dryRun) return undefined;
    const emptyOutput =
      result.stdout.trim().length === 0 &&
      result.stderr.trim().length === 0 &&
      result.jsonEvents.length === 0;
    return emptyOutput ? "role run succeeded without producing output" : undefined;
  }
  if (result.record.status === "not_started") {
    if (dryRun) return undefined;
    const emptyOutput =
      result.stdout.trim().length === 0 &&
      result.stderr.trim().length === 0 &&
      result.jsonEvents.length === 0;
    return emptyOutput ? "role run did not start and produced no output" : "role run did not start";
  }
  return `role run finished with status ${result.record.status}`;
}

export interface TaskClaimHeartbeatOptions {
  graph: TaskGraph;
  taskRef: TaskRef;
  claimedBy: string;
  leaseMs: number;
  intervalMs?: number;
  onHeartbeat?: (graph: TaskGraph) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export function startTaskClaimHeartbeat(options: TaskClaimHeartbeatOptions): () => void {
  const intervalMs =
    options.intervalMs ?? Math.max(1_000, Math.min(30_000, Math.floor(options.leaseMs / 3)));
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      options.graph.heartbeatTaskClaim(options.taskRef, {
        claimedBy: options.claimedBy,
        leaseMs: options.leaseMs,
      });
      await options.onHeartbeat?.(options.graph);
    } catch (error) {
      stopped = true;
      options.onError?.(error);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export class RoleRunTimeoutError extends PiRoleRunTimeoutError {
  constructor(timeoutMs: number) {
    super(timeoutMs);
    this.name = "RoleRunTimeoutError";
  }
}

export async function runRoleInstructionOnly(
  registry: RoleRegistry,
  instruction: RoleInstruction,
  options: Partial<RoleRunnerOptions> = {},
  runRef: RunRef = newRef("run"),
): Promise<SparkRoleRunResult> {
  const role = registry.get(instruction.roleRef);
  if (!instruction.instruction.trim()) throw new Error("role instruction is required");
  const startedAt = nowIso();
  const baseRecord: RoleRunRecord = {
    ref: runRef,
    roleRef: role.ref,
    runName: options.runName?.trim() || createRoleRunName(role.ref, runRef),

    instruction: instruction.instruction,
    status: (options.dryRun ?? true) ? "not_started" : "running",
    startedAt,
  };

  if (options.dryRun ?? true) {
    return {
      record: { ...baseRecord, status: "not_started", finishedAt: nowIso() },
      stdout: "",
      stderr: "",
      jsonEvents: [],
    };
  }

  return runPiJsonRole(
    role,
    instruction,
    {
      cwd: options.cwd ?? process.cwd(),
      piCommand: options.piCommand ?? "pi",
      timeoutMs: options.timeoutMs ?? 600_000,
      signal: options.signal,
      sessionDir: options.sessionDir,
      runName: baseRecord.runName,
      mode: options.mode,
      forkFromSession: options.forkFromSession,
    },
    baseRecord.ref,
  );
}

export function parseJsonlEvents(text: string): unknown[] {
  return parsePiJsonlEvents(text);
}

async function runPiJsonRole(
  role: { ref: RoleRef; systemPrompt: string },
  instruction: RoleInstruction,
  options: Required<Pick<RoleRunnerOptions, "cwd" | "piCommand" | "timeoutMs">> &
    Pick<RoleRunnerOptions, "signal" | "sessionDir" | "runName" | "mode" | "forkFromSession">,
  runRef: RunRef,
): Promise<SparkRoleRunResult> {
  let tracked: TrackedSparkRoleRunProcess | undefined;
  try {
    const modelBinding = await defaultUserRoleModelBindingStore().get(role.ref);
    if (!modelBinding && options.piCommand === "pi") {
      throw new Error(
        `role model binding required for ${role.ref}; run the role once interactively or bind a model before dispatch`,
      );
    }
    const result = await runRole({
      runRef: runRef as `run:${string}`,
      roleRef: role.ref as `role:${string}`,
      systemPrompt: role.systemPrompt,
      model: modelBinding?.model,
      instruction: instruction.instruction,
      runGuidance: sparkRoleRunGuidance(),
      sessionDir: options.sessionDir,
      mode: options.mode,
      forkFromSession: options.forkFromSession,
      piCommand: options.piCommand,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onChildProcess(child, startedAt) {
        tracked = trackSparkRoleRunProcess({
          child,
          runRef,
          roleRef: role.ref,
          runName: options.runName,

          cwd: options.cwd,
          startedAt,
        });
      },
      onTimeout() {
        if (tracked) tracked.timedOutAt = nowIso();
      },
    });
    untrackSparkRoleRunProcess(runRef);
    return {
      record: {
        ref: runRef,
        roleRef: role.ref,
        runName: options.runName,
        instruction: instruction.instruction,
        status: result.record.status as RoleRunStatus,
        startedAt: result.record.startedAt,
        finishedAt: result.record.finishedAt,
      },
      stdout: result.stdout,
      stderr: result.stderr,
      jsonEvents: result.jsonEvents,
    };
  } catch (error) {
    if (error instanceof PiRoleRunTimeoutError) throw new RoleRunTimeoutError(error.timeoutMs);
    if (error instanceof RoleRunCancelledError) throw error;
    untrackSparkRoleRunProcess(runRef);
    throw error;
  }
}

export function sparkTaskExecutorRoleRef(task: Task, defaultRoleRef?: RoleRef): RoleRef {
  return task.roleRef ?? defaultRoleRef ?? defaultRoleRefForTaskKind(task.kind);
}

function defaultRoleRefForTaskKind(kind: Task["kind"]): RoleRef {
  if (kind === "research") return "role:builtin-scout" as RoleRef;
  if (kind === "plan") return "role:builtin-planner" as RoleRef;
  if (kind === "review") return "role:builtin-reviewer" as RoleRef;
  return "role:builtin-worker" as RoleRef;
}

function sparkRoleRunGuidance(): string {
  return [
    "Spark role-run ask policy:",
    "- You have access to ask tools in this run. If the task is blocked by missing user intent, an approval gate, or a real ambiguity that cannot be resolved from repository context, use the canonical ask tool rather than only writing questions in your final response.",
    "- Do not ask for routine implementation choices you can safely infer from the assigned task and repository context; proceed and document the decision.",
    "- If an ask times out or returns no selection for a decision/approval gate, stop and report the blocked state rather than continuing.",
    "",
    "Spark naming quality policy:",
    "- Judge whether the active project title and your task @name/title are placeholder, generic, stale, too broad, or inconsistent with the current instruction.",
    '- When the improvement is obvious, update Spark display names without asking: use task({ action: "project_update" }) for the project, and task({ action: "claim" }) with the existing task ref/name intent to improve your claimed task @name/title/description. Stable refs must remain unchanged.',
    "- Preserve user-specific intentional names and distinctive project/code names; ask only if multiple plausible names require a real user decision.",
  ].join("\n");
}
