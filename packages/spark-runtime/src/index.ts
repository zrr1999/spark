export * from "./workflow-role-run-adapter.ts";

import {
  buildRoleRunArgs as buildGenericRoleRunArgs,
  cancelRoleRun,
  defaultProjectRoleModelSettingsStore,
  defaultUserRoleModelSettingsStore,
  listActiveRoleRuns,
  parsePiJsonlEvents,
  resolveRoleModelSetting,
  RoleRunCancelledError as PiRoleRunCancelledError,
  RoleRunTimeoutError as PiRoleRunTimeoutError,
  runRole,
  sendInputToRoleRun,
  type ActiveRoleRun,
  type RoleRunInputControl,
  type RoleRegistry,
  type RoleLaunchMode,
} from "@zendev-lab/spark-roles";
import type { ArtifactStore } from "@zendev-lab/spark-artifacts";
import {
  DependencyError,
  type ArtifactRef,
  type JsonValue,
  newRef,
  nowIso,
  refId,
  type RoleRef,
  type RoleRunCompletionOutcome,
  type RunRef,
  type Task,
  type TaskRef,
  type TaskRun,
  type TaskRunCompletionSummary,
  type TaskTodo,
} from "@zendev-lab/spark-core";
import type { RoleInstruction, RoleRunRecord, RoleSpec } from "@zendev-lab/spark-roles";
import {
  taskCompletionReadiness,
  type TaskGraph,
  type TaskGraphStore,
  type TaskGraphStoreUpdateOptions,
} from "@zendev-lab/spark-tasks";
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
  record: RoleRunRecord & {
    launch?: RoleLaunchMode;
    model?: string;
    sessionDir?: string;
    forkFromSession?: string;
    noSession?: boolean;
    sessionPersistence?: "anonymous" | "persistent";
  };
  outcome?: RoleRunCompletionOutcome;
  stdout: string;
  stderr: string;
  jsonEvents: unknown[];
}

export interface SparkRoleInstructionExecutorInput {
  role: Pick<RoleSpec, "ref" | "id" | "systemPrompt" | "allowedTools">;
  instruction: RoleInstruction;
  record: SparkRoleRunResult["record"];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  sessionDir?: string;
  runName?: string;
  launch?: RoleLaunchMode;
  forkFromSession?: string;
  model?: string;
  noSession?: boolean;
  sessionPersistence?: "anonymous" | "persistent";
  phase?: "plan" | "implement";
  requireStructuredOutcome?: boolean;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: unknown) => void | Promise<void>;
}

/**
 * Host-provided role execution hook. Spark daemon uses this to run headless
 * roles through the native executor instead of spawning `pi --print --mode json`.
 * Packages that do not provide it use the shared headless executor fallback.
 */
export type SparkRoleInstructionExecutor = (
  input: SparkRoleInstructionExecutorInput,
) => Promise<SparkRoleRunResult>;

export { type RoleLaunchMode } from "@zendev-lab/spark-roles";

export type SparkRoleRunInputControl = RoleRunInputControl;

export interface ActiveSparkRoleRunProcess {
  runRef: RunRef;
  roleRef: RoleRef;
  runName?: string;
  pid?: number;
  cwd: string;
  startedAt: string;
  timedOutAt?: string;
  inputControl: SparkRoleRunInputControl;
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

export interface SendSparkRoleRunInputResult extends ActiveSparkRoleRunProcess {
  bytes: number;
  delivered: boolean;
  errorMessage?: string;
}

const EMPTY_ROLE_RUN_FAILURE_KIND = "runtime_error";
const MAX_TASK_ROLE_INSTRUCTION_CHARS = 6_000;
const MAX_TASK_ROLE_TODO_PREVIEW_ITEMS = 2;
const MAX_ROLE_RUN_ARTIFACT_TEXT_TAIL_BYTES = 12 * 1024;
const MAX_ROLE_RUN_ARTIFACT_JSON_EVENT_TAIL_COUNT = 10;
const MAX_ROLE_RUN_ARTIFACT_JSON_EVENT_CHARS = 1_000;
const DEFAULT_ROLE_RUN_SHUTDOWN_WAIT_MS = 3_000;
const ROLE_RUN_SECRET_PATTERN = /(?:api[-_\s]?key|token|bearer)\s*[:=]\s*[^\s,;}]+/giu;

export interface RoleRunFailureDiagnostic {
  failureCategory: string;
  executorKind: "daemon-native" | "process";
  modelSelector?: string;
  launch?: RoleLaunchMode;
  exitOrTimeout: string;
  sessionPersistence?: "anonymous" | "persistent";
  nextAction: string;
}

export function buildRoleRunFailureDiagnostic(input: {
  result: SparkRoleRunResult;
  executorKind?: "daemon-native" | "process";
  modelSelector?: string;
  exitOrTimeout?: string;
}): RoleRunFailureDiagnostic {
  const { result } = input;
  const emptyOutput =
    result.stdout.trim().length === 0 &&
    result.stderr.trim().length === 0 &&
    result.jsonEvents.length === 0;
  const providerFailure = result.jsonEvents.some((event) =>
    JSON.stringify(event).includes("provider_resolution_failed"),
  );
  const failureCategory = providerFailure
    ? "provider_resolution_failed"
    : emptyOutput
      ? "empty_output"
      : "role_run_failed";
  return {
    failureCategory,
    executorKind:
      input.executorKind ?? (result.record.sessionPersistence ? "daemon-native" : "process"),
    ...((input.modelSelector ?? result.record.model)
      ? { modelSelector: redactDiagnosticText(input.modelSelector ?? result.record.model ?? "") }
      : {}),
    ...(result.record.launch ? { launch: result.record.launch } : {}),
    exitOrTimeout: redactDiagnosticText(input.exitOrTimeout ?? result.record.status),
    ...(result.record.sessionPersistence
      ? { sessionPersistence: result.record.sessionPersistence }
      : {}),
    nextAction: diagnosticNextAction(failureCategory),
  };
}

function diagnosticNextAction(failureCategory: string): string {
  if (failureCategory === "provider_resolution_failed")
    return "Check the native Spark provider registry/model selector and align role model settings with an available provider/model.";
  if (failureCategory === "empty_output")
    return "Inspect role executor configuration, model selection, and runtime stderr; rerun with diagnostics if the executor produced no stdout, stderr, or JSON events.";
  return "Inspect stderr, JSON events, and role-run artifact tails for the failing run.";
}

function redactDiagnosticText(text: string): string {
  return text.replace(ROLE_RUN_SECRET_PATTERN, (match) => {
    const key = match.split(/[:=]/u, 1)[0]?.trim() || "secret";
    return `${key}=<redacted>`;
  });
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortSignalReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? "aborted"));
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function effectiveRoleRunEnv(
  overrides: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!overrides) return undefined;
  return { ...process.env, ...overrides };
}

export function listActiveSparkRoleRunProcesses(): ActiveSparkRoleRunProcess[] {
  return listActiveRoleRuns().map(snapshotActiveRoleRun);
}

export async function killActiveSparkRoleRunProcesses(
  options: KillSparkRoleRunProcessOptions = {},
): Promise<KillSparkRoleRunProcessResult[]> {
  const targets = selectActiveRoleRuns(options);
  return Promise.all(targets.map((record) => cancelActiveRoleRun(record, options)));
}

export async function sendInputToActiveSparkRoleRunProcesses(options: {
  runRef?: RunRef;
  runRefs?: RunRef[];
  runName?: string;
  runNames?: string[];
  text: string;
}): Promise<SendSparkRoleRunInputResult[]> {
  const targets = selectActiveRoleRuns(options);
  return Promise.all(targets.map((record) => sendInputToActiveRoleRun(record, options.text)));
}

function selectActiveRoleRuns(options: {
  runRef?: RunRef;
  runRefs?: RunRef[];
  runName?: string;
  runNames?: string[];
}): ActiveRoleRun[] {
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
  return listActiveRoleRuns().filter((record) => {
    if (hasRunFilter && !runRefs.has(record.ref as RunRef)) return false;
    if (hasNameFilter && !runNames.has(record.runName ?? "")) return false;
    return true;
  });
}

function snapshotActiveRoleRun(record: ActiveRoleRun): ActiveSparkRoleRunProcess {
  return {
    runRef: record.ref as RunRef,
    roleRef: record.roleRef,
    runName: record.runName,
    pid: record.pid,
    cwd: record.cwd,
    startedAt: record.startedAt,
    timedOutAt: record.timedOutAt,
    inputControl: record.inputControl,
  };
}

async function cancelActiveRoleRun(
  record: ActiveRoleRun,
  options: KillSparkRoleRunProcessOptions,
): Promise<KillSparkRoleRunProcessResult> {
  const signal = options.signal ?? "SIGTERM";
  const forceSignal = options.forceSignal ?? "SIGKILL";
  const waitMs = options.waitMs ?? DEFAULT_ROLE_RUN_SHUTDOWN_WAIT_MS;
  const signalSent = cancelRoleRun(record.ref, options.reason ?? `spark role-run ${signal}`);
  const closed = await waitForActiveRoleRunInactive(record.ref, waitMs);
  return {
    ...snapshotActiveRoleRun(record),
    signal,
    forceSignal,
    signalSent,
    forceScheduled: false,
    closed,
    ...(signalSent ? {} : { errorMessage: "active role-run was no longer registered" }),
  };
}

async function sendInputToActiveRoleRun(
  record: ActiveRoleRun,
  text: string,
): Promise<SendSparkRoleRunInputResult> {
  const payload = text.endsWith("\n") ? text : `${text}\n`;
  const delivery = await sendInputToRoleRun(record.ref, text);
  return {
    ...snapshotActiveRoleRun(record),
    ...(delivery ? { inputControl: delivery.inputControl } : {}),
    bytes: delivery?.bytes ?? Buffer.byteLength(payload),
    delivered: delivery?.delivered ?? false,
    errorMessage: delivery?.errorMessage ?? "active role-run was no longer registered",
  };
}

async function waitForActiveRoleRunInactive(runRef: RunRef, waitMs: number): Promise<boolean> {
  if (!isActiveRoleRunRegistered(runRef)) return true;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!isActiveRoleRunRegistered(runRef)) return true;
  }
  return !isActiveRoleRunRegistered(runRef);
}

function isActiveRoleRunRegistered(runRef: RunRef): boolean {
  return listActiveRoleRuns().some((record) => record.ref === runRef);
}

export function createRoleRunName(roleRef: RoleRef, runRef: RunRef, roleId?: string): string {
  const base = sanitizeRoleRunName(
    roleId?.trim() || refId(roleRef).replace(/^(builtin-|project-|user-)/, ""),
  );
  const suffix = sanitizeRoleRunName(refId(runRef)).slice(0, 8) || "run";
  return `${base}-${suffix}`;
}

function sanitizeRoleRunName(value: string): string {
  return slugifyRoleRunPart(value) || "role";
}

function slugifyRoleRunPart(value: string): string {
  let output = "";
  let previousDash = false;
  for (const char of value.trim().toLowerCase()) {
    const allowed = (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "_";
    if (allowed) {
      output += char;
      previousDash = false;
    } else if (output && !previousDash) {
      output += "-";
      previousDash = true;
    }
  }
  return output.endsWith("-") ? output.slice(0, -1) : output;
}

export function createRoleRunClaimId(sessionId: string | undefined, runName: string): string {
  const sessionPart = sanitizeClaimPart(sessionId?.trim() || "session:unknown");
  const runPart = sanitizeClaimPart(runName.trim() || "role");
  return `${sessionPart}+${runPart}`;
}

function sanitizeClaimPart(value: string): string {
  let output = "";
  let previousDash = false;
  for (const char of value) {
    if (char === "+" || char.trim() === "") {
      if (output && !previousDash) output += "-";
      previousDash = true;
    } else {
      output += char;
      previousDash = false;
    }
  }
  return output || "unknown";
}

export interface PiRoleCommandInput {
  roleRef: RoleRef;
  systemPrompt: string;
  instruction: string;
  model?: string;
  allowedTools?: string[];
  noSession?: boolean;
  sessionDir?: string;
  launch?: RoleLaunchMode;
  forkFromSession?: string;
}

export function buildRoleRunArgs(input: PiRoleCommandInput): string[] {
  return buildGenericRoleRunArgs({
    roleRef: input.roleRef,
    launch: input.launch,
    systemPrompt: input.systemPrompt,
    instruction: input.instruction,
    model: input.model,
    allowedTools: input.allowedTools,
    noSession: input.noSession,
    runGuidance: sparkRoleRunGuidance(),
    sessionDir: input.sessionDir,
    forkFromSession: input.forkFromSession,
  });
}

export interface RoleRunnerOptions {
  cwd: string;
  dryRun?: boolean;
  phase?: "plan" | "implement";
  requireStructuredOutcome?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  sessionDir?: string;
  runName?: string;
  launch?: RoleLaunchMode;
  forkFromSession?: string;
  sessionModel?: string;
  env?: NodeJS.ProcessEnv;
  allowedTools?: string[];
  roleExecutor?: SparkRoleInstructionExecutor;
  onRoleEvent?: (event: unknown) => void | Promise<void>;
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
  dryRun?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  sessionDir?: string;
  launch?: RoleLaunchMode;
  forkFromSession?: string;
  sessionModel?: string;
  env?: NodeJS.ProcessEnv;
  allowedTools?: string[];
  roleExecutor?: SparkRoleInstructionExecutor;
  onRoleEvent?: (event: unknown) => void | Promise<void>;
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

export const DEFAULT_TASK_CLAIM_LEASE_MS = 600_000;

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
  const leaseMs = input.claim?.leaseMs ?? DEFAULT_TASK_CLAIM_LEASE_MS;
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
  let stopHeartbeat: (() => void) | undefined;

  try {
    if (!dryRun) {
      try {
        input.graph.heartbeatTaskClaim(task.ref, { claimedBy, leaseMs });
        await input.onHeartbeat?.(input.graph);
      } catch (error) {
        throw new TaskClaimHeartbeatError(error);
      }
      stopHeartbeat = startTaskClaimHeartbeat({
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
    }

    const result = await runRoleInstructionOnly(
      input.registry,
      {
        roleRef: taskRoleRef,
        instruction: buildSparkTaskRoleInstruction(task, input.graph),
        inputs: task.inputArtifacts,
      },
      {
        cwd: input.cwd ?? process.cwd(),
        dryRun,
        timeoutMs: input.timeoutMs,
        signal: runSignal,
        sessionDir: input.sessionDir,
        runName,
        launch: input.launch,
        forkFromSession: input.forkFromSession,
        sessionModel: input.sessionModel,
        env: input.env,
        allowedTools: input.allowedTools,
        phase: "implement",
        requireStructuredOutcome: true,
        roleExecutor: input.roleExecutor,
        onRoleEvent: input.onRoleEvent,
      },
      runRef,
    );
    if (runSignal?.aborted) throw abortSignalReason(runSignal);

    let outputArtifactRef: ArtifactRef | undefined;
    if (input.artifactStore) {
      const artifact = await input.artifactStore.put({
        kind: "trace",
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

    const outcome = result.outcome ?? result.record.outcome;
    const outcomeFailure =
      outcome && outcome.kind !== "completed" ? outcome.reason.trim() || outcome.code : undefined;
    const missingOutcomeFailure =
      !outcome && !dryRun
        ? "role run ended without a required structured completion outcome"
        : undefined;
    const roleFailure = roleRunCompletionFailure(result, dryRun);
    const executionFailure = outcomeFailure ?? roleFailure ?? missingOutcomeFailure;
    if (!executionFailure && outcome?.kind === "completed" && !dryRun) {
      markOpenTaskPlanItemsDone(input.graph, task.ref);
    }
    const completionFailure =
      executionFailure ??
      roleRunEvidenceCompletionFailure(
        input.graph.getTask(task.ref),
        dryRun,
        Boolean(input.artifactStore),
      );
    const succeeded = !completionFailure;
    const finishedAt = nowIso();
    const outputArtifacts = outputArtifactRef ? [outputArtifactRef] : [];
    const status = taskRunStatusForOutcome(succeeded, outcome);
    const finished: TaskRun = {
      ...run,
      status,
      outcome,
      failureKind: completionFailure ? taskRunFailureKindForOutcome(outcome) : undefined,
      errorMessage: completionFailure,
      finishedAt,
      outputArtifacts,
      completionSummary: dryRun
        ? undefined
        : createTaskRunCompletionSummary({
            run,
            status,
            finishedAt,
            outcome,
            outputArtifacts,
            summary: completionFailure ?? summarizeRoleRunResult(result),
          }),
    };
    input.graph.recordRun(finished);
    if (dryRun) input.graph.setTaskStatus(task.ref, originalStatus);
    else input.graph.setTaskStatus(task.ref, taskStatusForRun(status));
    return finished;
  } catch (error) {
    if (error instanceof PiRoleRunTimeoutError && !dryRun) {
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
    if (
      !(error instanceof TaskClaimHeartbeatError) &&
      (error instanceof PiRoleRunCancelledError || runSignal?.aborted)
    ) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const finishedAt = nowIso();
      const outcome: RoleRunCompletionOutcome = {
        kind: "cancelled",
        code: "role_run_cancelled",
        reason: errorMessage,
      };
      const cancelled: TaskRun = {
        ...run,
        status: "cancelled",
        failureKind: "runtime_cancelled",
        errorMessage,
        outcome,
        finishedAt,
        outputArtifacts: [],
        completionSummary: dryRun
          ? undefined
          : createTaskRunCompletionSummary({
              run,
              status: "cancelled",
              finishedAt,
              outcome,
              outputArtifacts: [],
              summary: errorMessage,
            }),
      };
      input.graph.recordRun(cancelled);
      input.graph.setTaskStatus(task.ref, dryRun ? originalStatus : "cancelled");
      return cancelled;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const finishedAt = nowIso();
    const failed: TaskRun = {
      ...run,
      status: "failed",
      failureKind: error instanceof PiRoleRunTimeoutError ? "runtime_timeout" : "runtime_error",
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
    if (error instanceof TaskClaimHeartbeatError) throw error;
    return failed;
  } finally {
    stopHeartbeat?.();
  }
}

function markOpenTaskPlanItemsDone(graph: TaskGraph, taskRef: TaskRef): void {
  const task = graph.getTask(taskRef);
  const plan = task.plan;
  const items = plan?.items;
  if (!plan || !items || items.length === 0) return;
  const updatedAt = nowIso();
  graph.updateTask(taskRef, {
    plan: {
      ...plan,
      items: items.map((item) =>
        item.status === "done" || item.status === "cancelled" || item.status === "deleted"
          ? item
          : { ...item, status: "done", updatedAt },
      ),
      steps: items.map((item) => item.title),
    },
  });
}

function buildSparkTaskRoleInstruction(task: Task, graph: TaskGraph): string {
  const sections = [task.description.trim()];
  if (task.plan) {
    sections.push(
      [
        "Task plan (execution contract):",
        `- Objective: ${task.plan.objective}`,
        "- Required terminal report: call role_report_outcome exactly once before ending. Use kind=completed only after all success criteria are satisfied; use kind=blocked, failed, or cancelled with a stable code and concrete reason otherwise.",
        renderInstructionList("Success criteria", task.plan.successCriteria),
        renderInstructionList("Evidence required", task.plan.evidenceRequired),
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
        `Current task plan item preview (showing ${todos.visible.length}/${todos.total} active item${todos.total === 1 ? "" : "s"}; do not expand the full plan item list unless needed):`,
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
  return `${instruction.slice(0, MAX_TASK_ROLE_INSTRUCTION_CHARS).trimEnd()}\n\n… task instruction truncated; inspect task_read({ action: "task_status", taskRef: "task:..." }) and artifact({ action: "read" }) if more context is needed.`;
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
    ...(result.record.status === "succeeded"
      ? {}
      : { diagnostic: buildRoleRunFailureDiagnostic({ result }) }),
  };
}

function compactRoleRunRecord(
  record: SparkRoleRunResult["record"],
): Omit<RoleRunRecord, "instruction"> {
  const { instruction: _instruction, ...compact } = record;
  return Object.fromEntries(
    Object.entries(compact).filter((entry) => entry[1] !== undefined),
  ) as Omit<RoleRunRecord, "instruction">;
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
  outcome?: RoleRunCompletionOutcome;
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
    outcome: input.outcome ? { ...input.outcome } : undefined,
    createdAt: input.finishedAt,
  };
}

function summarizeRoleRunResult(result: SparkRoleRunResult): string {
  const finalAssistantText = extractFinalAssistantText(result.jsonEvents);
  if (finalAssistantText) return summarizeText(finalAssistantText);
  const stdoutNonJson = nonJsonStdoutText(result.stdout);
  const stderr = result.stderr.trim();
  const parts = [stdoutNonJson, stderr ? `stderr: ${stderr}` : ""].filter(Boolean);
  if (parts.length > 0) return summarizeText(parts.join("\n"));
  if (result.jsonEvents.length > 0) return summarizeText(JSON.stringify(result.jsonEvents.at(-1)));
  return `role run finished with status ${result.record.status}`;
}

function extractFinalAssistantText(events: unknown[]): string | undefined {
  for (const event of [...events].reverse()) {
    const direct = extractAssistantText(eventMessage(event));
    if (direct) return direct;
    const messages = eventMessages(event);
    for (const message of [...messages].reverse()) {
      const text = extractAssistantText(message);
      if (text) return text;
    }
  }
  return undefined;
}

function eventMessage(event: unknown): unknown {
  if (!event || typeof event !== "object") return undefined;
  return (event as { message?: unknown }).message;
}

function eventMessages(event: unknown): unknown[] {
  if (!event || typeof event !== "object") return [];
  const messages = (event as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : [];
}

function extractAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  if ((message as { role?: unknown }).role !== "assistant") return undefined;
  return messageContentText((message as { content?: unknown }).content);
}

function messageContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const item = block as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("")
    .trim();
  return text || undefined;
}

function nonJsonStdoutText(value: string): string | undefined {
  const text = value
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (looksLikePiJsonProtocolFragment(trimmed)) return false;
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function looksLikePiJsonProtocolFragment(value: string): boolean {
  if (value.startsWith('{"type":"') || value.startsWith('{"type": "')) return true;
  if (value.startsWith('"type":"') || value.startsWith('"type": "')) return true;
  return (
    value.includes('"assistantMessageEvent"') ||
    value.includes('"toolCallId"') ||
    value.includes('"toolName"') ||
    value.includes('"message_update"') ||
    value.includes('"message_end"') ||
    value.includes('"turn_end"')
  );
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
    return emptyOutput ? "role run succeeded without producing task output" : undefined;
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

function taskRunStatusForOutcome(
  succeeded: boolean,
  outcome: RoleRunCompletionOutcome | undefined,
): TaskRun["status"] {
  if (succeeded) return "succeeded";
  if (outcome?.kind === "blocked") return "blocked";
  if (outcome?.kind === "cancelled") return "cancelled";
  return "failed";
}

function taskRunFailureKindForOutcome(
  outcome: RoleRunCompletionOutcome | undefined,
): NonNullable<TaskRun["failureKind"]> {
  if (outcome?.kind === "blocked") return "blocked";
  if (outcome?.kind === "cancelled") return "runtime_cancelled";
  if (outcome?.code === "provider_resolution_failed" || outcome?.code === "provider_failure") {
    return "provider_failure";
  }
  return EMPTY_ROLE_RUN_FAILURE_KIND;
}

function taskStatusForRun(status: TaskRun["status"]): Task["status"] {
  if (status === "succeeded") return "done";
  if (status === "blocked") return "blocked";
  if (status === "cancelled") return "cancelled";
  return "failed";
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
    options.intervalMs ?? Math.max(1, Math.min(30_000, Math.floor(options.leaseMs / 3)));
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

  const roleOptions = {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 600_000,
    signal: options.signal,
    sessionDir: options.sessionDir,
    runName: baseRecord.runName,
    launch: options.launch,
    forkFromSession: options.forkFromSession,
    sessionModel: options.sessionModel,
    env: effectiveRoleRunEnv(options.env),
    allowedTools: options.allowedTools,
    phase: options.phase,
    requireStructuredOutcome: options.requireStructuredOutcome ?? false,
    roleExecutor: options.roleExecutor,
    onRoleEvent: options.onRoleEvent,
  };

  return runNativeSparkRole(role, instruction, roleOptions, baseRecord);
}

export function parseJsonlEvents(text: string): unknown[] {
  return parsePiJsonlEvents(text);
}

async function runNativeSparkRole(
  role: RoleSpec,
  instruction: RoleInstruction,
  options: Required<Pick<RoleRunnerOptions, "cwd" | "timeoutMs">> &
    Pick<
      RoleRunnerOptions,
      | "signal"
      | "sessionDir"
      | "runName"
      | "launch"
      | "forkFromSession"
      | "sessionModel"
      | "env"
      | "allowedTools"
      | "phase"
      | "requireStructuredOutcome"
      | "onRoleEvent"
      | "roleExecutor"
    >,
  baseRecord: SparkRoleRunResult["record"],
): Promise<SparkRoleRunResult> {
  const roleModel = await resolveRoleModelSetting({
    roleRef: role.ref,
    roleId: role.id,
    roleName: role.id,
    projectStore: defaultProjectRoleModelSettingsStore(options.cwd),
    userStore: defaultUserRoleModelSettingsStore(),
  });
  const model = roleModel?.model ?? (options.sessionModel?.trim() || undefined);
  let streamedEventCount = 0;
  const onEvent = options.onRoleEvent
    ? async (event: unknown) => {
        streamedEventCount += 1;
        await options.onRoleEvent?.(event);
      }
    : undefined;
  const result = await runRole({
    runRef: baseRecord.ref,
    roleRef: role.ref,
    roleId: role.id,
    systemPrompt: role.systemPrompt,
    instruction: instruction.instruction,
    model,
    allowedTools: options.allowedTools ?? role.allowedTools,
    phase: options.phase,
    requireStructuredOutcome: options.requireStructuredOutcome ?? false,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    sessionDir: options.sessionDir,
    launch: options.launch,
    forkFromSession: options.forkFromSession,
    env: options.env,
    nativeExecutor: options.roleExecutor,
    onEvent,
    noSession: options.launch !== "forked",
    onTimeout: () => undefined,
  });
  if (streamedEventCount === 0) {
    for (const event of result.jsonEvents) await options.onRoleEvent?.(event);
  }
  return {
    record: {
      ...baseRecord,
      ...result.record,
      ref: baseRecord.ref,
      roleRef: role.ref,
      runName: options.runName,
      instruction: instruction.instruction,
      model: result.record.model ?? model,
    },
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    outcome: result.outcome ?? result.record.outcome,
    jsonEvents: result.jsonEvents ?? [],
  };
}

export function sparkTaskExecutorRoleRef(task: Task, defaultRoleRef?: RoleRef): RoleRef {
  return task.roleRef ?? defaultRoleRef ?? defaultRoleRefForTaskKind(task.kind);
}

function defaultRoleRefForTaskKind(kind: Task["kind"]): RoleRef {
  if (kind === "research") return "role:builtin-scout" as RoleRef;
  if (kind === "review") return "role:builtin-reviewer" as RoleRef;
  return "role:builtin-worker" as RoleRef;
}

function sparkRoleRunGuidance(): string {
  return [
    "Spark role-run interaction policy:",
    "- You do not have interactive ask tools in this run. If the task is blocked by missing user intent, an approval gate, or a real ambiguity that cannot be resolved from repository context, stop and report the blocker plus the exact question needed upward in your final response.",
    "- Do not stop for routine implementation choices you can safely infer from the assigned task and repository context; proceed and document the decision.",
    "- If a required decision cannot be made from the available context, do not continue past the gate; report the blocked state and required decision.",
    "",
    "Spark naming quality policy:",
    "- Judge whether the active project title and your task @name/title are placeholder, generic, stale, too broad, or inconsistent with the current instruction.",
    '- When the improvement is obvious, update Spark display names without asking: use task_write({ action: "project_rename" }) for the project title, project_metadata_update for project metadata, and task_write({ action: "claim" }) with the existing task ref/name intent to improve your claimed task @name/title/description. Stable refs must remain unchanged.',
    "- Preserve user-specific intentional names and distinctive project/code names; ask only if multiple plausible names require a real user decision.",
  ].join("\n");
}
