import type { ChildProcess } from "node:child_process";
import {
  buildRoleRunArgs as buildGenericRoleRunArgs,
  parsePiJsonlEvents,
  RoleRunCancelledError,
  RoleRunTimeoutError as PiRoleRunTimeoutError,
  runRole,
  type RoleRegistry,
  type RoleRunMode,
} from "pi-roles";
import type { ArtifactStore } from "spark-artifacts";
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
} from "spark-core";
import type { RoleInstruction, RoleRunRecord, RoleRunStatus } from "pi-roles";
import type { TaskGraph, TaskGraphStore, TaskGraphStoreUpdateOptions } from "spark-tasks";

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
const DEFAULT_ROLE_RUN_FORCE_KILL_AFTER_MS = 1_000;
const DEFAULT_ROLE_RUN_SHUTDOWN_WAIT_MS = 3_000;
const activeSparkRoleRunProcesses = new Map<RunRef, TrackedSparkRoleRunProcess>();

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
  roleRef?: RoleRef;
  /** @deprecated use roleRef. */
  specRef?: RoleRef;
  systemPrompt: string;
  instruction: string;
  sessionDir?: string;
  mode?: RoleRunMode;
  forkFromSession?: string;
}

export function buildRoleRunArgs(input: PiRoleCommandInput): string[] {
  return buildGenericRoleRunArgs({
    roleRef: (input.roleRef ?? input.specRef) as `role:${string}`,
    mode: input.mode,
    systemPrompt: input.systemPrompt,
    instruction: input.instruction,
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
  artifactStore?: ArtifactStore;
  cwd?: string;
  piCommand?: string;
  dryRun?: boolean;
  timeoutMs?: number;
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
  store: Pick<TaskGraphStore, "update">,
  now = nowIso(),
  options: Omit<TaskGraphStoreUpdateOptions, "createIfMissing"> = {},
): Promise<ExpiredTaskClaimSweepResult> {
  const result = await store.update((graph) => graph.expireTaskClaims(now), {
    ...options,
    createIfMissing: false,
  });
  if (!result.graph) return { graph: null, expired: [], saved: false };
  const expired = result.result ?? [];
  return { graph: result.graph, expired, saved: expired.length > 0 };
}

export async function runSparkTask(input: SparkTaskRunOptions): Promise<TaskRun> {
  const task = input.graph.getTask(input.taskRef);
  const taskRoleRef = normalizeRoleRefCompat(input.assignedRoleRef) ?? assignedRoleRefForTask(task);
  const unmet = input.graph
    .dependencies(task.threadRef)
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
    threadRef: task.threadRef,
    taskRef: task.ref,
    roleRef: taskRoleRef,
    runName,
    ownerSessionId,
    status: "running",
    startedAt: nowIso(),
    outputArtifacts: [],
  };
  input.graph.recordRun(run);
  const stopHeartbeat = dryRun
    ? undefined
    : startTaskClaimHeartbeat({
        graph: input.graph,
        taskRef: task.ref,
        claimedBy,
        leaseMs,
        intervalMs: input.heartbeatIntervalMs,
        onHeartbeat: input.onHeartbeat,
      });

  try {
    const result = await runRoleInstructionOnly(
      input.registry,
      {
        roleRef: taskRoleRef,
        instruction: task.description,
        inputs: task.inputArtifacts,
      },
      {
        cwd: input.cwd ?? process.cwd(),
        piCommand: input.piCommand,
        dryRun,
        timeoutMs: input.timeoutMs,
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
        body: {
          record: result.record,
          stdout: result.stdout,
          stderr: result.stderr,
          jsonEvents: result.jsonEvents,
        } as unknown as JsonValue,
        provenance: {
          producer: "task",
          threadRef: task.threadRef,
          taskRef: task.ref,
          roleRef: taskRoleRef,
          note: `runName=${runName}`,
        },
      });
      outputArtifactRef = artifact.ref;
      input.graph.attachOutputArtifact(task.ref, artifact.ref);
    }

    const completionFailure = roleRunCompletionFailure(result, dryRun);
    const succeeded = !completionFailure;
    const finished: TaskRun = {
      ...run,
      status: succeeded ? "succeeded" : "failed",
      failureKind: completionFailure ? EMPTY_ROLE_RUN_FAILURE_KIND : undefined,
      errorMessage: completionFailure,
      finishedAt: nowIso(),
      outputArtifacts: outputArtifactRef ? [outputArtifactRef] : [],
    };
    input.graph.recordRun(finished);
    if (dryRun) input.graph.setTaskStatus(task.ref, originalStatus);
    else input.graph.setTaskStatus(task.ref, succeeded ? "done" : "failed");
    return finished;
  } catch (error) {
    if (error instanceof RoleRunTimeoutError && !dryRun) {
      const background: TaskRun = {
        ...run,
        status: "running",
        failureKind: "runtime_timeout",
        errorMessage: `${error.message}; keeping role-run claim in background`,
        outputArtifacts: [],
      };
      input.graph.recordRun(background);
      input.graph.setTaskStatus(task.ref, "running");
      return background;
    }
    const failed: TaskRun = {
      ...run,
      status: "failed",
      failureKind: error instanceof RoleRunTimeoutError ? "runtime_timeout" : "runtime_error",
      errorMessage: error instanceof Error ? error.message : String(error),
      finishedAt: nowIso(),
      outputArtifacts: [],
    };
    input.graph.recordRun(failed);
    input.graph.setTaskStatus(task.ref, dryRun ? originalStatus : "failed");
    throw error;
  } finally {
    stopHeartbeat?.();
  }
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
    } catch {
      stopped = true;
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
    Pick<RoleRunnerOptions, "sessionDir" | "runName" | "mode" | "forkFromSession">,
  runRef: RunRef,
): Promise<SparkRoleRunResult> {
  let tracked: TrackedSparkRoleRunProcess | undefined;
  try {
    const result = await runRole({
      runRef: runRef as `run:${string}`,
      roleRef: role.ref as `role:${string}`,
      systemPrompt: role.systemPrompt,
      instruction: instruction.instruction,
      runGuidance: sparkRoleRunGuidance(),
      sessionDir: options.sessionDir,
      mode: options.mode,
      forkFromSession: options.forkFromSession,
      piCommand: options.piCommand,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
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

function normalizeRoleRefCompat(
  value: RoleRef | `agent:${string}` | undefined,
): RoleRef | undefined {
  if (!value) return undefined;
  return (value.startsWith("agent:") ? `role:${value.slice("agent:".length)}` : value) as RoleRef;
}

function assignedRoleRefForTask(task: Task): RoleRef {
  return normalizeRoleRefCompat(task.roleRef) ?? defaultRoleRefForTaskKind(task.kind);
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
    "- You have access to Spark ask tools in this run. If the task is blocked by missing user intent, an approval gate, or a real ambiguity that cannot be resolved from repository context, use the available Spark ask tools rather than only writing questions in your final response.",
    "- Do not ask for routine implementation choices you can safely infer from the assigned task and repository context; proceed and document the decision.",
    "- If an ask times out or returns no selection for a decision/approval gate, stop and report the blocked state rather than continuing.",
    "",
    "Spark naming quality policy:",
    "- Judge whether the active thread title and your task @name/title are placeholder, generic, stale, too broad, or inconsistent with the current instruction.",
    "- When the improvement is obvious, update Spark display names without asking: use spark_rename_thread for the thread, and spark_claim_task with the existing task ref/name intent to improve your claimed task @name/title/description. Stable refs must remain unchanged.",
    "- Preserve user-specific intentional names and distinctive project/code names; ask only if multiple plausible names require a real user decision.",
  ].join("\n");
}
