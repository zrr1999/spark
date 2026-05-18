import { spawn } from "node:child_process";

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
  newRef,
  nowIso,
} from "spark-core";
import type { TaskGraph, TaskGraphStore } from "spark-tasks";

export interface AgentRunResult {
  record: AgentRunRecord;
  stdout: string;
  stderr: string;
  jsonEvents: unknown[];
}

export interface AgentRunnerOptions {
  cwd: string;
  piCommand?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  sessionDir?: string;
}

export interface SparkTaskRunOptions {
  graph: TaskGraph;
  taskRef: TaskRef;
  registry: AgentRegistry;
  artifactStore?: ArtifactStore;
  cwd?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  sessionDir?: string;
  heartbeatIntervalMs?: number;
  onHeartbeat?: (graph: TaskGraph) => void | Promise<void>;
  claim?: {
    kind?: "main" | "subagent";
    claimedBy?: string;
    sessionId?: string;
    leaseMs?: number;
  };
}

export interface ExpiredTaskClaimSweepResult {
  graph: TaskGraph | null;
  expired: Task[];
  saved: boolean;
}

export async function sweepExpiredTaskClaims(
  store: Pick<TaskGraphStore, "load" | "save">,
  now = nowIso(),
): Promise<ExpiredTaskClaimSweepResult> {
  const graph = await store.load();
  if (!graph) return { graph: null, expired: [], saved: false };
  const expired = graph.expireTaskClaims(now);
  if (expired.length === 0) return { graph, expired, saved: false };
  await store.save(graph);
  return { graph, expired, saved: true };
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
  const claimedBy = input.claim?.claimedBy ?? task.agentRef;
  const leaseMs = input.claim?.leaseMs ?? input.timeoutMs ?? 600_000;
  input.graph.claimTask(task.ref, {
    kind: input.claim?.kind ?? "subagent",
    claimedBy,
    agentRef: task.agentRef,
    sessionId: input.claim?.sessionId,
    runRef,
    leaseMs,
  });

  const run: TaskRun = {
    ref: runRef,
    threadRef: task.threadRef,
    taskRef: task.ref,
    agentRef: task.agentRef,
    status: "running",
    startedAt: nowIso(),
    outputArtifacts: [],
  };
  input.graph.recordRun(run);
  const stopHeartbeat =
    (input.dryRun ?? true)
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
        dryRun: input.dryRun ?? true,
        timeoutMs: input.timeoutMs,
        sessionDir: input.sessionDir,
      },
      runRef,
    );

    let outputArtifactRef: ArtifactRef | undefined;
    if (input.artifactStore) {
      const artifact = await input.artifactStore.put({
        kind: "agent-run",
        title: `Agent run for ${task.title}`,
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
    input.graph.setTaskStatus(task.ref, succeeded ? "done" : "failed");
    return finished;
  } catch (error) {
    const failed: TaskRun = {
      ...run,
      status: "failed",
      failureKind: error instanceof AgentRunTimeoutError ? "runtime_timeout" : "runtime_error",
      errorMessage: error instanceof Error ? error.message : String(error),
      finishedAt: nowIso(),
      outputArtifacts: [],
    };
    input.graph.recordRun(failed);
    input.graph.setTaskStatus(task.ref, "failed");
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
    Pick<AgentRunnerOptions, "sessionDir">,
  runRef: RunRef,
): Promise<AgentRunResult> {
  const prompt = [agent.systemPrompt, "", "Instruction:", instruction.instruction].join("\n");
  const args = ["--mode", "json", "--prompt", prompt];
  if (options.sessionDir) args.push("--session-dir", options.sessionDir);

  const startedAt = nowIso();
  const child = spawn(options.piCommand, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new AgentRunTimeoutError(options.timeoutMs));
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const status: AgentRunStatus = exitCode === 0 ? "succeeded" : "failed";
  return {
    record: {
      ref: runRef,
      agentRef: agent.ref,
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
