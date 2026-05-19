import { spawn, type ChildProcess } from "node:child_process";

import type { AgentRegistry } from "spark-agents";
import type { ArtifactStore } from "spark-artifacts";
import {
  DependencyError,
  type AgentInstruction,
  type AgentRef,
  type AgentRunRecord,
  type AgentRunStatus,
  type ArtifactRef,
  type JsonValue,
  type RunRef,
  type Task,
  type TaskRef,
  type TaskRun,
  type ThreadRef,
  newRef,
  nowIso,
  refId,
} from "spark-core";
import type { TaskGraph, TaskGraphStore } from "spark-tasks";

export interface AgentRunResult {
  record: AgentRunRecord;
  stdout: string;
  stderr: string;
  jsonEvents: unknown[];
}

export interface ActiveSparkSubagentProcess {
  runRef: RunRef;
  agentRef: AgentRef;
  agentName?: string;
  pid?: number;
  cwd: string;
  startedAt: string;
  timedOutAt?: string;
}

export interface KillSparkSubagentProcessOptions {
  runRef?: RunRef;
  runRefs?: RunRef[];
  agentName?: string;
  agentNames?: string[];
  reason?: string;
  signal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  forceAfterMs?: number;
  waitMs?: number;
}

export interface KillSparkSubagentProcessResult extends ActiveSparkSubagentProcess {
  signal: NodeJS.Signals;
  forceSignal: NodeJS.Signals;
  signalSent: boolean;
  forceScheduled: boolean;
  closed: boolean;
  errorMessage?: string;
}

interface TrackedSparkSubagentProcess extends ActiveSparkSubagentProcess {
  child: ChildProcess;
  closed: boolean;
  forceKillTimer?: ReturnType<typeof setTimeout>;
  terminationReason?: string;
}

const DEFAULT_SUBAGENT_FORCE_KILL_AFTER_MS = 1_000;
const DEFAULT_SUBAGENT_SHUTDOWN_WAIT_MS = 3_000;
const activeSparkSubagentProcesses = new Map<RunRef, TrackedSparkSubagentProcess>();

export function listActiveSparkSubagentProcesses(): ActiveSparkSubagentProcess[] {
  return [...activeSparkSubagentProcesses.values()].map(snapshotSparkSubagentProcess);
}

export async function killActiveSparkSubagentProcesses(
  options: KillSparkSubagentProcessOptions = {},
): Promise<KillSparkSubagentProcessResult[]> {
  const hasRunFilter = options.runRef !== undefined || options.runRefs !== undefined;
  const hasAgentFilter = options.agentName !== undefined || options.agentNames !== undefined;
  const runRefs = new Set([
    ...(options.runRefs ?? []),
    ...(options.runRef ? [options.runRef] : []),
  ]);
  const agentNames = new Set([
    ...(options.agentNames ?? []),
    ...(options.agentName ? [options.agentName] : []),
  ]);
  const targets = [...activeSparkSubagentProcesses.values()].filter((record) => {
    if (hasRunFilter && !runRefs.has(record.runRef)) return false;
    if (hasAgentFilter && !agentNames.has(record.agentName ?? "")) return false;
    return true;
  });
  return Promise.all(targets.map((record) => killTrackedSparkSubagentProcess(record, options)));
}

function trackSparkSubagentProcess(input: {
  child: ChildProcess;
  runRef: RunRef;
  agentRef: AgentRef;
  agentName?: string;
  cwd: string;
  startedAt: string;
}): TrackedSparkSubagentProcess {
  const tracked: TrackedSparkSubagentProcess = {
    runRef: input.runRef,
    agentRef: input.agentRef,
    agentName: input.agentName,
    pid: input.child.pid,
    cwd: input.cwd,
    startedAt: input.startedAt,
    child: input.child,
    closed: input.child.exitCode !== null || input.child.signalCode !== null,
  };
  if (tracked.closed) return tracked;
  activeSparkSubagentProcesses.set(input.runRef, tracked);
  input.child.once("close", () => {
    tracked.closed = true;
    if (tracked.forceKillTimer) clearTimeout(tracked.forceKillTimer);
    activeSparkSubagentProcesses.delete(input.runRef);
  });
  input.child.once("error", () => {
    tracked.closed = true;
    if (tracked.forceKillTimer) clearTimeout(tracked.forceKillTimer);
    activeSparkSubagentProcesses.delete(input.runRef);
  });
  return tracked;
}

function untrackSparkSubagentProcess(runRef: RunRef): void {
  const tracked = activeSparkSubagentProcesses.get(runRef);
  if (tracked?.forceKillTimer) clearTimeout(tracked.forceKillTimer);
  activeSparkSubagentProcesses.delete(runRef);
}

function snapshotSparkSubagentProcess(
  record: TrackedSparkSubagentProcess,
): ActiveSparkSubagentProcess {
  return {
    runRef: record.runRef,
    agentRef: record.agentRef,
    agentName: record.agentName,
    pid: record.pid,
    cwd: record.cwd,
    startedAt: record.startedAt,
    timedOutAt: record.timedOutAt,
  };
}

async function killTrackedSparkSubagentProcess(
  record: TrackedSparkSubagentProcess,
  options: KillSparkSubagentProcessOptions,
): Promise<KillSparkSubagentProcessResult> {
  const signal = options.signal ?? "SIGTERM";
  const forceSignal = options.forceSignal ?? "SIGKILL";
  const forceAfterMs = options.forceAfterMs ?? DEFAULT_SUBAGENT_FORCE_KILL_AFTER_MS;
  const waitMs = options.waitMs ?? DEFAULT_SUBAGENT_SHUTDOWN_WAIT_MS;
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

  const closed = await waitForTrackedSparkSubagentClose(record, waitMs);
  return {
    ...snapshotSparkSubagentProcess(record),
    signal,
    forceSignal,
    signalSent,
    forceScheduled,
    closed,
    errorMessage,
  };
}

async function waitForTrackedSparkSubagentClose(
  record: TrackedSparkSubagentProcess,
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

export function createAgentRunName(agentRef: AgentRef, runRef: RunRef, agentId?: string): string {
  const base = sanitizeAgentRunName(
    agentId?.trim() || refId(agentRef).replace(/^(builtin-|managed-)/, ""),
  );
  const suffix = sanitizeAgentRunName(refId(runRef)).slice(0, 8) || "run";
  return `${base}-${suffix}`;
}

function sanitizeAgentRunName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-") || "agent"
  );
}

export function createSubagentClaimId(sessionId: string | undefined, agentName: string): string {
  const sessionPart = sanitizeClaimPart(sessionId?.trim() || "session:unknown");
  const agentPart = sanitizeClaimPart(agentName.trim() || "agent");
  return `${sessionPart}+${agentPart}`;
}

function sanitizeClaimPart(value: string): string {
  return value.replace(/\+/g, "-").replace(/\s+/g, "-") || "unknown";
}

export interface PiAgentCommandInput {
  systemPrompt: string;
  instruction: string;
  sessionDir?: string;
}

export function buildPiAgentArgs(input: PiAgentCommandInput): string[] {
  const prompt = [
    input.systemPrompt,
    "",
    "Spark subagent ask policy:",
    "- If you hit a real ambiguity, missing decision, approval need, or blocker that prevents correct execution, use the available Spark ask tools (for example spark_ask or spark_ask_unblock_task) instead of only mentioning the question in your final response.",
    "- Do not ask for routine implementation choices you can safely infer from the assigned task and repository context; proceed and document the decision.",
    "- If an ask times out or returns no selection for a decision/approval gate, stop and report the blocked state rather than continuing.",
    "",
    "Instruction:",
    input.instruction,
  ].join("\n");
  const args = ["--print", "--mode", "json"];
  if (input.sessionDir) args.push("--session-dir", input.sessionDir);
  args.push("--append-system-prompt", input.systemPrompt, prompt);
  return args;
}

export interface AgentRunnerOptions {
  cwd: string;
  piCommand?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  sessionDir?: string;
  agentName?: string;
}

export interface SparkReadyTaskRunnerOptions {
  graph: TaskGraph;
  registry: AgentRegistry;
  artifactStore?: ArtifactStore;
  threadRef?: ThreadRef;
  cwd?: string;
  piCommand?: string;
  dryRun?: boolean;
  /** Maximum number of subagents running at the same time. Default: 4. */
  maxConcurrency?: number;
  /** Overall scheduler timeout for the DAG run. Individual subagents do not get this timeout. */
  timeoutMs?: number;
  /** Per-subagent timeout. Defaults to no per-task timeout; use only when deliberately bounding each child. */
  taskTimeoutMs?: number;
  sessionDir?: string;
  heartbeatIntervalMs?: number;
  onHeartbeat?: (graph: TaskGraph) => void | Promise<void>;
  onProgress?: (result: SparkReadyTaskRunnerProgress) => void | Promise<void>;
  claim?: {
    sessionId?: string;
    leaseMs?: number;
  };
}

export interface SparkReadyTaskRunnerProgress {
  taskRef: TaskRef;
  run: TaskRun;
  running: number;
  completed: number;
}

export interface SparkReadyTaskRunnerResult {
  runs: TaskRun[];
  scheduled: number;
  completed: number;
  timedOut: boolean;
  maxConcurrency: number;
}

export const DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY = 4;
export const DEFAULT_SPARK_READY_TASK_TIMEOUT_MS = 3_600_000;

export interface SparkTaskRunOptions {
  graph: TaskGraph;
  taskRef: TaskRef;
  registry: AgentRegistry;
  artifactStore?: ArtifactStore;
  cwd?: string;
  piCommand?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  sessionDir?: string;
  heartbeatIntervalMs?: number;
  onHeartbeat?: (graph: TaskGraph) => void | Promise<void>;
  claim?: {
    kind?: "main" | "subagent";
    /** Concrete claimant identity. Defaults to `${sessionId}+${agentName}` for subagents. */
    claimedBy?: string;
    /** Human-readable name for this concrete agent run; agentRef remains the spec/type. */
    agentName?: string;
    sessionId?: string;
    leaseMs?: number;
  };
}

export interface ExpiredTaskClaimSweepResult {
  graph: TaskGraph | null;
  expired: Task[];
  saved: boolean;
}

export function findResumableBackgroundSubagentTasks(
  graph: TaskGraph,
  ownerSessionId: string,
): Task[] {
  return graph
    .tasks()
    .filter(
      (task) =>
        task.claim?.kind === "subagent" &&
        task.claim.sessionId === ownerSessionId &&
        Boolean(task.agentRef) &&
        (task.status === "running" || task.status === "pending" || task.status === "ready"),
    );
}

export async function sweepExpiredTaskClaims(
  store: Pick<TaskGraphStore, "update">,
  now = nowIso(),
): Promise<ExpiredTaskClaimSweepResult> {
  const result = await store.update((graph) => graph.expireTaskClaims(now), {
    createIfMissing: false,
  });
  if (!result.graph) return { graph: null, expired: [], saved: false };
  const expired = result.result ?? [];
  return { graph: result.graph, expired, saved: expired.length > 0 };
}

export async function runReadySparkTasks(
  input: SparkReadyTaskRunnerOptions,
): Promise<SparkReadyTaskRunnerResult> {
  const dryRun = input.dryRun ?? true;
  const maxConcurrency = normalizeMaxConcurrency(input.maxConcurrency);
  const timeoutMs = normalizeReadyTaskRunnerTimeoutMs(input.timeoutMs);
  const taskTimeoutMs = normalizeTaskTimeoutMs(input.taskTimeoutMs);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const runs: TaskRun[] = [];
  const running = new Set<Promise<TaskRun>>();
  const scheduled = new Set<TaskRef>();
  const promiseRunRefs = new Map<Promise<TaskRun>, RunRef>();
  const cancelledRunRefs = new Set<RunRef>();
  let timedOut = false;

  const schedule = (task: Task): void => {
    scheduled.add(task.ref);
    const preexistingRunRefs = new Set(input.graph.runs(task.threadRef).map((run) => run.ref));
    const runPromise = runSparkTask({
      graph: input.graph,
      taskRef: task.ref,
      registry: input.registry,
      artifactStore: input.artifactStore,
      cwd: input.cwd,
      piCommand: input.piCommand,
      dryRun,
      timeoutMs: taskTimeoutMs ?? 0,
      sessionDir: input.sessionDir,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
      onHeartbeat: input.onHeartbeat,
      claim: dryRun
        ? undefined
        : {
            sessionId: input.claim?.sessionId,
            leaseMs: input.claim?.leaseMs ?? timeoutMs,
          },
    })
      .catch((error: unknown) => taskRunFromError(input.graph.getTask(task.ref), error))
      .then(async (run) => {
        if (!cancelledRunRefs.has(run.ref)) {
          runs.push(run);
          await input.onProgress?.({
            taskRef: task.ref,
            run,
            running: Math.max(0, running.size - 1),
            completed: runs.length,
          });
        }
        return run;
      })
      .finally(() => {
        running.delete(runPromise);
      });
    running.add(runPromise);
    const claimedRunRef = input.graph.getTask(task.ref).claim?.runRef;
    const recordedRunRef = input.graph
      .runs(task.threadRef)
      .find((run) => !preexistingRunRefs.has(run.ref) && run.taskRef === task.ref)?.ref;
    const runRef = claimedRunRef ?? recordedRunRef;
    if (runRef) promiseRunRefs.set(runPromise, runRef);
  };

  while (true) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }

    const ready = input.graph
      .readyTasks(input.threadRef)
      .filter((task) => !scheduled.has(task.ref))
      .slice(0, Math.max(0, maxConcurrency - running.size));
    for (const task of ready) schedule(task);

    if (running.size === 0) {
      const hasMoreReady = input.graph
        .readyTasks(input.threadRef)
        .some((task) => !scheduled.has(task.ref));
      if (!hasMoreReady) break;
      continue;
    }

    await Promise.race([
      Promise.race(running),
      sleep(Math.max(0, deadline - Date.now())).then(() => {
        timedOut = true;
      }),
    ]);
    if (timedOut) break;
  }

  if (timedOut && running.size > 0) {
    const timedOutRunRefs = new Set(
      [...running]
        .map((runPromise) => promiseRunRefs.get(runPromise))
        .filter((runRef): runRef is RunRef => Boolean(runRef)),
    );
    for (const runRef of timedOutRunRefs) cancelledRunRefs.add(runRef);
    const runningTasks = input.graph
      .tasks(input.threadRef)
      .filter((task) => task.claim?.runRef && timedOutRunRefs.has(task.claim.runRef));
    const cancellations = cancelTimedOutTasks(input.graph, runningTasks, timeoutMs, runs);
    await killActiveSparkSubagentProcesses({
      reason: "spark ready-task DAG timeout",
      runRefs: [...timedOutRunRefs],
    });
    await Promise.allSettled(running);
    for (const cancellation of cancellations) {
      input.graph.setTaskStatus(cancellation.taskRef, "pending");
      input.graph.recordRun(cancellation.run);
    }
  } else {
    await Promise.allSettled(running);
  }

  return {
    runs,
    scheduled: scheduled.size,
    completed: runs.filter((run) => run.status !== "running" && run.status !== "queued").length,
    timedOut,
    maxConcurrency,
  };
}

function cancelTimedOutTasks(
  graph: TaskGraph,
  tasks: Task[],
  timeoutMs: number,
  runs: TaskRun[],
): Array<{ taskRef: TaskRef; run: TaskRun }> {
  const cancellations: Array<{ taskRef: TaskRef; run: TaskRun }> = [];
  for (const task of tasks) {
    const runRef = task.claim?.runRef;
    if (!runRef) continue;
    const run = graph.runs(task.threadRef).find((candidate) => candidate.ref === runRef);
    if (run?.status === "running" || run?.status === "queued") {
      const cancelled: TaskRun = {
        ...run,
        status: "cancelled",
        failureKind: "runtime_timeout",
        errorMessage: `Spark ready-task DAG timed out after ${timeoutMs}ms`,
        finishedAt: nowIso(),
      };
      graph.recordRun(cancelled);
      runs.push(cancelled);
      cancellations.push({ taskRef: task.ref, run: cancelled });
    }
    if (task.claim) graph.releaseTaskClaim(task.ref, task.claim.claimedBy);
  }
  return cancellations;
}

function normalizeMaxConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value ?? DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY))
    return DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY;
  return Math.max(1, Math.floor(value ?? DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY));
}

function normalizeReadyTaskRunnerTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value ?? DEFAULT_SPARK_READY_TASK_TIMEOUT_MS))
    return DEFAULT_SPARK_READY_TASK_TIMEOUT_MS;
  return Math.max(1, Math.floor(value ?? DEFAULT_SPARK_READY_TASK_TIMEOUT_MS));
}

function normalizeTaskTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function taskRunFromError(task: Task, error: unknown): TaskRun {
  const latest = task.claim?.runRef ? task.claim.runRef : task.ref.replace(/^task:/, "run:error-");
  return {
    ref: latest as RunRef,
    threadRef: task.threadRef,
    taskRef: task.ref,
    agentRef: task.agentRef,
    agentName: task.claim?.agentName,
    ownerSessionId: task.claim?.sessionId,
    status: "failed",
    failureKind: error instanceof AgentRunTimeoutError ? "runtime_timeout" : "runtime_error",
    errorMessage: error instanceof Error ? error.message : String(error),
    startedAt: nowIso(),
    finishedAt: nowIso(),
    outputArtifacts: [],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function runSparkTask(input: SparkTaskRunOptions): Promise<TaskRun> {
  const task = input.graph.getTask(input.taskRef);
  if (!task.agentRef) throw new DependencyError(`task has no agent binding: ${task.ref}`);
  const unmet = input.graph
    .dependencies(task.threadRef)
    .filter(
      (dep) => dep.taskRef === task.ref && input.graph.getTask(dep.dependsOn).status !== "done",
    );
  if (unmet.length > 0) throw new DependencyError(`task has unmet dependencies: ${task.ref}`);

  const runRef = newRef("run");
  const dryRun = input.dryRun ?? true;
  const originalStatus = task.status;
  const agentSpec = input.registry.get(task.agentRef);
  const agentName =
    input.claim?.agentName?.trim() || createAgentRunName(task.agentRef, runRef, agentSpec.id);
  const claimKind = input.claim?.kind ?? "subagent";
  const claimedBy =
    input.claim?.claimedBy?.trim() ||
    (claimKind === "subagent"
      ? createSubagentClaimId(input.claim?.sessionId, agentName)
      : agentName);
  const ownerSessionId = input.claim?.sessionId;
  const leaseMs = input.claim?.leaseMs ?? input.timeoutMs ?? 600_000;
  if (!dryRun) {
    input.graph.claimTask(task.ref, {
      kind: claimKind,
      claimedBy,
      agentRef: task.agentRef,
      agentName,
      sessionId: input.claim?.sessionId,
      runRef,
      leaseMs,
    });
  }

  const run: TaskRun = {
    ref: runRef,
    threadRef: task.threadRef,
    taskRef: task.ref,
    agentRef: task.agentRef,
    agentName,
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
    const result = await runAgentInstructionOnly(
      input.registry,
      {
        agentRef: task.agentRef,
        instruction: task.description,
        inputs: task.inputArtifacts,
      },
      {
        cwd: input.cwd ?? process.cwd(),
        piCommand: input.piCommand,
        dryRun,
        timeoutMs: input.timeoutMs,
        sessionDir: input.sessionDir,
        agentName,
      },
      runRef,
    );

    let outputArtifactRef: ArtifactRef | undefined;
    if (input.artifactStore) {
      const artifact = await input.artifactStore.put({
        kind: "agent-run",
        title: `Agent run ${agentName} for ${task.title}`,
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
          agentRef: task.agentRef,
          note: `agentName=${agentName}`,
        },
      });
      outputArtifactRef = artifact.ref;
      input.graph.attachOutputArtifact(task.ref, artifact.ref);
    }

    const succeeded =
      result.record.status === "succeeded" || result.record.status === "not_started";
    const finished: TaskRun = {
      ...run,
      status: succeeded ? "succeeded" : "failed",
      finishedAt: nowIso(),
      outputArtifacts: outputArtifactRef ? [outputArtifactRef] : [],
    };
    input.graph.recordRun(finished);
    if (dryRun) input.graph.setTaskStatus(task.ref, originalStatus);
    else input.graph.setTaskStatus(task.ref, succeeded ? "done" : "failed");
    return finished;
  } catch (error) {
    if (error instanceof AgentRunTimeoutError && !dryRun) {
      const background: TaskRun = {
        ...run,
        status: "running",
        failureKind: "runtime_timeout",
        errorMessage: `${error.message}; keeping subagent claim in background`,
        outputArtifacts: [],
      };
      input.graph.recordRun(background);
      input.graph.setTaskStatus(task.ref, "running");
      return background;
    }
    const failed: TaskRun = {
      ...run,
      status: "failed",
      failureKind: error instanceof AgentRunTimeoutError ? "runtime_timeout" : "runtime_error",
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

export class AgentRunTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`agent run timed out after ${timeoutMs}ms`);
    this.name = "AgentRunTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export async function runAgentInstructionOnly(
  registry: AgentRegistry,
  instruction: AgentInstruction,
  options: Partial<AgentRunnerOptions> = {},
  runRef: RunRef = newRef("run"),
): Promise<AgentRunResult> {
  const agent = registry.get(instruction.agentRef);
  if (!instruction.instruction.trim()) throw new Error("agent instruction is required");
  const startedAt = nowIso();
  const baseRecord: AgentRunRecord = {
    ref: runRef,
    agentRef: agent.ref,
    agentName: options.agentName?.trim() || createAgentRunName(agent.ref, runRef),
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

  return runPiJsonAgent(
    agent,
    instruction,
    {
      cwd: options.cwd ?? process.cwd(),
      piCommand: options.piCommand ?? "pi",
      timeoutMs: options.timeoutMs ?? 600_000,
      sessionDir: options.sessionDir,
      agentName: baseRecord.agentName,
    },
    baseRecord.ref,
  );
}

export function parseJsonlEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Pi may emit non-JSON diagnostics. Keep parser tolerant.
    }
  }
  return events;
}

async function runPiJsonAgent(
  agent: { ref: AgentRef; systemPrompt: string },
  instruction: AgentInstruction,
  options: Required<Pick<AgentRunnerOptions, "cwd" | "piCommand" | "timeoutMs">> &
    Pick<AgentRunnerOptions, "sessionDir" | "agentName">,
  runRef: RunRef,
): Promise<AgentRunResult> {
  const args = buildPiAgentArgs({
    systemPrompt: agent.systemPrompt,
    instruction: instruction.instruction,
    sessionDir: options.sessionDir,
  });

  const startedAt = nowIso();
  const child = spawn(options.piCommand, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tracked = trackSparkSubagentProcess({
    child,
    runRef,
    agentRef: agent.ref,
    agentName: options.agentName,
    cwd: options.cwd,
    startedAt,
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (cb: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cb();
    };
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        tracked.timedOutAt = nowIso();
        child.kill("SIGTERM");
        settle(() => reject(new AgentRunTimeoutError(options.timeoutMs)));
      }, options.timeoutMs);
      timer.unref?.();
    }
    child.once("error", (error) => {
      untrackSparkSubagentProcess(runRef);
      settle(() => reject(error));
    });
    child.once("close", (code) => {
      if (!tracked.timedOutAt) untrackSparkSubagentProcess(runRef);
      settle(() => resolve(code));
    });
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const status: AgentRunStatus = exitCode === 0 ? "succeeded" : "failed";
  return {
    record: {
      ref: runRef,
      agentRef: agent.ref,
      agentName: options.agentName,
      instruction: instruction.instruction,
      status,
      startedAt,
      finishedAt: nowIso(),
    },
    stdout,
    stderr,
    jsonEvents: parseJsonlEvents(stdout),
  };
}
