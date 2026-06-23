import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
type ArtifactRef = `artifact:${string}`;
type ProjectRef = `proj:${string}`;
type RunRef = `run:${string}`;
type TaskRef = `task:${string}`;
type RoleRef = `role:${string}`;

type TaskRun = {
  ref: RunRef;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  failureKind?: string;
  errorMessage?: string;
  outputArtifacts: ArtifactRef[];
};

type SparkTaskRunOptionsLike = Record<string, unknown>;
type ExecuteSparkTaskFn = (input: SparkTaskRunOptionsLike) => Promise<TaskRun>;
type SparkRoleInstructionExecutorLike = (
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
type CreateSparkHeadlessRoleExecutorFn = (options?: {
  sparkHome?: string;
}) => SparkRoleInstructionExecutorLike;

type TaskGraphStoreLike = {
  update<T>(
    fn: (graph: TaskGraphLike) => T | Promise<T>,
  ): Promise<{ graph: TaskGraphLike | null; result: T }>;
  save(graph: TaskGraphLike): Promise<void>;
};

type ArtifactStoreLike = {
  get(ref: ArtifactRef): Promise<{
    ref: ArtifactRef;
    kind: string;
    title: string;
    format: string;
    hash?: string;
    provenance: { runRef?: string; taskRef?: string };
  }>;
  getBody(ref: ArtifactRef): Promise<string>;
};

type TaskGraphLike = {
  projects(): Array<{ ref: ProjectRef; description: string }>;
  tasks(projectRef?: ProjectRef): Array<{ ref: TaskRef; name: string }>;
  createProject(input: { title: string; description: string; purpose?: string }): {
    ref: ProjectRef;
    description: string;
  };
  createTask(input: Record<string, unknown>): { ref: TaskRef; name: string };
};

type SparkRuntimeModules = {
  defaultArtifactStore(cwd: string): ArtifactStoreLike;
  builtinRoleRef(id: "worker"): RoleRef;
  createDefaultRoleRegistry(): unknown;
  hydrateDefaultRoleRegistry(
    registry: unknown,
    cwd: string,
    options: { includeUser: boolean },
  ): Promise<void>;
  defaultTaskGraphStore(cwd: string): TaskGraphStoreLike;
  runSparkTask(input: SparkTaskRunOptionsLike): Promise<TaskRun>;
  killActiveSparkRoleRunProcesses(
    input: Record<string, unknown>,
  ): Promise<Array<{ signalSent?: boolean; closed?: boolean }>>;
  createSparkHeadlessRoleExecutor: CreateSparkHeadlessRoleExecutorFn;
};
import {
  createId,
  type ArtifactProjectionPayload,
  type ServerCommandPayload,
  type serverCommandEnvelopeSchema,
} from "@zendev-lab/spark-protocol";
import type { NaviaPaths } from "@zendev-lab/navia-system";
import type { SparkDaemonWorkspace } from "../store/workspaces.js";
import {
  artifactProjected,
  commandAck,
  commandReject,
  invocationLogChunk,
  invocationUpdated,
  taskGraphSnapshot,
  type RouteContext,
} from "../protocol/outbound.js";

export type ServerCommandEnvelope = ReturnType<typeof serverCommandEnvelopeSchema.parse>;

export interface SparkDaemonBridgeInput {
  command: ServerCommandEnvelope;
  workspace: SparkDaemonWorkspace;
  route: RouteContext;
  paths: NaviaPaths;
  db: DatabaseSync;
  emit(message: unknown): void;
  invocationId?: string;
  signal?: AbortSignal;
  taskGraphStore?: TaskGraphStoreLike;
  artifactStore?: ArtifactStoreLike;
  executeSparkTask?: ExecuteSparkTaskFn;
}

export interface SparkDaemonBridgeResult {
  invocationId: string;
  taskRuntimeId: string;
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  sparkProjectRef?: ProjectRef;
  sparkTaskRef?: TaskRef;
  sparkRunRef?: RunRef;
  outputArtifactIds: string[];
}

export interface CancelSparkBridgeInvocationInput {
  invocationId: string;
  reason?: string;
}

export interface CancelSparkBridgeInvocationResult {
  invocationId: string;
  cancelled: boolean;
  message: string;
}

export type RunSparkCommandFn = (input: SparkDaemonBridgeInput) => Promise<SparkDaemonBridgeResult>;
export type CancelSparkInvocationFn = (
  input: CancelSparkBridgeInvocationInput,
) => Promise<CancelSparkBridgeInvocationResult>;

interface SparkTaskBinding {
  graph: TaskGraphLike;
  projectRef: ProjectRef;
  taskRef: TaskRef;
}

const DEFAULT_SPARK_TIMEOUT_MS = 30 * 60_000;

async function dynamicImport<T>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ specifier) as Promise<T>;
}

async function loadSparkRuntimeModules(): Promise<SparkRuntimeModules> {
  const [artifacts, roles, tasks, runtime, headless] = await Promise.all([
    dynamicImport<{ defaultArtifactStore: SparkRuntimeModules["defaultArtifactStore"] }>(
      "@zendev-lab/pi-artifacts",
    ),
    dynamicImport<{
      builtinRoleRef: SparkRuntimeModules["builtinRoleRef"];
      createDefaultRoleRegistry: SparkRuntimeModules["createDefaultRoleRegistry"];
      hydrateDefaultRoleRegistry: SparkRuntimeModules["hydrateDefaultRoleRegistry"];
    }>("@zendev-lab/pi-roles"),
    dynamicImport<{ defaultTaskGraphStore: SparkRuntimeModules["defaultTaskGraphStore"] }>(
      "@zendev-lab/pi-tasks",
    ),
    dynamicImport<{
      runSparkTask: SparkRuntimeModules["runSparkTask"];
      killActiveSparkRoleRunProcesses: SparkRuntimeModules["killActiveSparkRoleRunProcesses"];
    }>("@zendev-lab/spark-runtime"),
    dynamicImport<{
      createSparkHeadlessRoleExecutor: SparkRuntimeModules["createSparkHeadlessRoleExecutor"];
    }>("@zendev-lab/spark-tui-app/headless-role-executor"),
  ]);
  return {
    defaultArtifactStore: artifacts.defaultArtifactStore,
    builtinRoleRef: roles.builtinRoleRef,
    createDefaultRoleRegistry: roles.createDefaultRoleRegistry,
    hydrateDefaultRoleRegistry: roles.hydrateDefaultRoleRegistry,
    defaultTaskGraphStore: tasks.defaultTaskGraphStore,
    runSparkTask: runtime.runSparkTask,
    killActiveSparkRoleRunProcesses: runtime.killActiveSparkRoleRunProcesses,
    createSparkHeadlessRoleExecutor: headless.createSparkHeadlessRoleExecutor,
  };
}

export async function runSparkCommandBridge(
  input: SparkDaemonBridgeInput,
): Promise<SparkDaemonBridgeResult> {
  const invocationId = input.invocationId ?? createId("inv");
  const command = input.command.payload;
  const taskRuntimeId = taskRuntimeIdForCommand(command, invocationId);
  const startedAt = new Date().toISOString();
  const route = { ...input.route, invocationId };
  const prompt = promptForCommand(command);

  recordInvocationStarted(input.db, {
    invocationId,
    commandId: input.command.commandId,
    workspaceBindingId: input.workspace.id,
    prompt,
    now: startedAt,
  });

  input.emit(commandAck({ accepted: true, invocationId }, route));
  input.emit(
    invocationUpdated(
      {
        runtimeInvocationId: invocationId,
        taskRuntimeId,
        agentName: "spark-runtime",
        status: "running",
        startedAt,
        payload: {
          commandKind: command.kind,
          retryOfInvocationId: retryOfInvocationId(command),
        },
      },
      route,
    ),
  );
  input.emit(
    taskGraphSnapshot(
      taskGraphForCommand(command, taskRuntimeId, invocationId, "running", 1),
      route,
    ),
  );
  input.emit(
    invocationLogChunk(
      {
        runtimeInvocationId: invocationId,
        stream: "system",
        sequence: 1,
        content: "Spark runtime role-run started.",
      },
      route,
    ),
  );

  const spark = input.executeSparkTask ? null : await loadSparkRuntimeModules();
  const taskGraphStore =
    input.taskGraphStore ?? spark!.defaultTaskGraphStore(input.workspace.localPath);
  const artifactStore =
    input.artifactStore ?? spark!.defaultArtifactStore(input.workspace.localPath);

  try {
    const binding = await ensureSparkTaskBinding({
      store: taskGraphStore,
      command,
      projectId: input.command.projectId,
      taskRuntimeId,
      prompt,
    });
    const registry = spark ? spark.createDefaultRoleRegistry() : {};
    if (spark)
      await spark.hydrateDefaultRoleRegistry(registry, input.workspace.localPath, {
        includeUser: true,
      });
    const executeSparkTask = input.executeSparkTask ?? ((options) => spark!.runSparkTask(options));
    const run = await executeSparkTask({
      graph: binding.graph,
      taskRef: binding.taskRef,
      registry,
      defaultRoleRef: spark ? spark.builtinRoleRef("worker") : "role:builtin-worker",
      artifactStore,
      cwd: input.workspace.localPath,
      dryRun: false,
      timeoutMs: DEFAULT_SPARK_TIMEOUT_MS,
      signal: input.signal,
      ...(spark ? { roleExecutor: spark.createSparkHeadlessRoleExecutor() } : {}),
      claim: {
        kind: "role-run",
        sessionId: `spark-daemon:${input.route.runtimeId}`,
        runName: `spark-daemon-${invocationId}`,
        leaseMs: DEFAULT_SPARK_TIMEOUT_MS,
      },
      onHeartbeat: async (graph: TaskGraphLike) => {
        await taskGraphStore.save(graph);
      },
    });
    await taskGraphStore.save(binding.graph);

    const completedAt = new Date().toISOString();
    const outputArtifactIds = await projectSparkArtifacts({
      artifactStore,
      artifactRefs: run.outputArtifacts,
      emit: (message) => input.emit(message),
      route,
      invocationId,
    });
    const terminalStatus = naviaStatusForRun(run);
    recordInvocationStatus(input.db, invocationId, terminalStatus, completedAt);
    const taskStatus = terminalStatus === "succeeded" ? "done" : "failed";
    input.emit(
      taskGraphSnapshot(
        taskGraphForCommand(command, taskRuntimeId, invocationId, taskStatus, 2, outputArtifactIds),
        route,
      ),
    );
    input.emit(
      invocationUpdated(
        {
          runtimeInvocationId: invocationId,
          taskRuntimeId,
          agentName: "spark-runtime",
          status: terminalStatus,
          completedAt,
          terminalReason: run.errorMessage,
          payload: {
            commandKind: command.kind,
            sparkProjectRef: binding.projectRef,
            sparkTaskRef: binding.taskRef,
            sparkRunRef: run.ref,
            outputArtifactIds,
            retryOfInvocationId: retryOfInvocationId(command),
          },
        },
        route,
      ),
    );
    return {
      invocationId,
      taskRuntimeId,
      status: terminalStatus,
      sparkProjectRef: binding.projectRef,
      sparkTaskRef: binding.taskRef,
      sparkRunRef: run.ref,
      outputArtifactIds,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    recordInvocationStatus(input.db, invocationId, "failed", completedAt);
    input.emit(
      invocationLogChunk(
        {
          runtimeInvocationId: invocationId,
          stream: "system",
          sequence: 2,
          content: errorMessage,
        },
        route,
      ),
    );
    input.emit(
      taskGraphSnapshot(
        taskGraphForCommand(command, taskRuntimeId, invocationId, "failed", 2),
        route,
      ),
    );
    input.emit(
      invocationUpdated(
        {
          runtimeInvocationId: invocationId,
          taskRuntimeId,
          agentName: "spark-runtime",
          status: "failed",
          completedAt,
          terminalReason: errorMessage,
          payload: { commandKind: command.kind, retryOfInvocationId: retryOfInvocationId(command) },
        },
        route,
      ),
    );
    return { invocationId, taskRuntimeId, status: "failed", outputArtifactIds: [] };
  }
}

export async function cancelSparkBridgeInvocation(
  input: CancelSparkBridgeInvocationInput,
): Promise<CancelSparkBridgeInvocationResult> {
  const spark = await loadSparkRuntimeModules();
  const killed = await spark.killActiveSparkRoleRunProcesses({
    runName: `spark-daemon-${input.invocationId}`,
    reason: input.reason ?? "Spark daemon invocation cancellation requested.",
  });
  return {
    invocationId: input.invocationId,
    cancelled: killed.some((result) => result.signalSent || result.closed),
    message:
      killed.length === 0
        ? "No active Spark role-run process matched the Spark daemon invocation."
        : `Cancellation signalled for ${killed.length} Spark role-run process(es).`,
  };
}

async function ensureSparkTaskBinding(input: {
  store: TaskGraphStoreLike;
  command: ServerCommandPayload;
  projectId?: string | undefined;
  taskRuntimeId: string;
  prompt: string;
}): Promise<SparkTaskBinding> {
  const result = await input.store.update((graph) => {
    const projectKey = input.projectId ?? "spark-daemon-local-project";
    const project =
      graph
        .projects()
        .find((candidate) => candidate.description.includes(`cockpitProjectId=${projectKey}`)) ??
      graph.createProject({
        title: `Navia project ${projectKey}`,
        description: `Spark daemon projected Spark project. cockpitProjectId=${projectKey}`,
        purpose: "Execute cockpit-requested tasks through Spark runtime primitives.",
      });
    const taskName = stableTaskName(input.taskRuntimeId);
    const existing = graph.tasks(project.ref).find((task) => task.name === taskName);
    const task =
      existing ??
      graph.createTask({
        projectRef: project.ref,
        name: taskName,
        title: input.command.title ?? "Navia runtime task",
        description: input.prompt,
        kind: "implement",
        status: "ready",
        roleRef: "role:builtin-worker",
        plan: {
          objective: input.prompt,
          contextRefs: [],
          constraints: ["Execute from Spark daemon bridge; preserve cockpit protocol projections."],
          nonGoals: ["Do not write cockpit SQLite as Spark source of truth."],
          successCriteria: [
            "Spark role-run reaches a terminal status and emits cockpit projections.",
          ],
          evidenceRequired: ["Spark role-run artifact and Spark daemon invocation projection."],
          items: [
            { title: "Run the requested task through Spark runtime." },
            { title: "Report terminal status and evidence." },
          ],
          openQuestions: [],
          askRefs: [],
        },
      });
    return { projectRef: project.ref, taskRef: task.ref };
  });
  if (!result.graph) throw new Error("Spark task graph store did not return a graph.");
  return {
    graph: result.graph,
    projectRef: result.result.projectRef,
    taskRef: result.result.taskRef,
  };
}

async function projectSparkArtifacts(input: {
  artifactStore: ArtifactStoreLike;
  artifactRefs: ArtifactRef[];
  emit(message: unknown): void;
  route: RouteContext;
  invocationId: string;
}): Promise<string[]> {
  const projected: string[] = [];
  for (const artifactRef of input.artifactRefs) {
    const artifact = await input.artifactStore.get(artifactRef);
    const artifactId = naviaArtifactIdForSparkRef(artifactRef);
    const serializedPreview = await input.artifactStore.getBody(artifactRef);
    const payload: ArtifactProjectionPayload = {
      artifactId,
      scope: "project",
      kind: artifact.kind,
      title: artifact.title,
      format:
        artifact.format === "json" || artifact.format === "markdown" || artifact.format === "text"
          ? artifact.format
          : "blob",
      source: "runtime",
      hash: artifact.hash,
      sizeBytes: Buffer.byteLength(serializedPreview, "utf8"),
      mime: mimeForArtifactFormat(artifact.format),
      contentRef: {
        sparkArtifactRef: artifactRef,
        inlineMarkdown: artifact.format === "markdown" ? serializedPreview : undefined,
        inlineText: artifact.format === "text" ? serializedPreview : undefined,
      },
      contentAvailability: {
        hash: artifact.hash,
        mime: mimeForArtifactFormat(artifact.format),
        sizeBytes: Buffer.byteLength(serializedPreview, "utf8"),
        daemonAvailable: true,
      },
      provenance: {
        runtimeInvocationId: input.invocationId,
        sparkArtifactRef: artifactRef,
        sparkRunRef: artifact.provenance.runRef,
        sparkTaskRef: artifact.provenance.taskRef,
      },
      links: [{ targetKind: "invocation", targetId: input.invocationId, relation: "produced-by" }],
    };
    input.emit(artifactProjected(payload, { ...input.route, invocationId: input.invocationId }));
    projected.push(artifactId);
  }
  return projected;
}

function recordInvocationStarted(
  db: DatabaseSync,
  input: {
    invocationId: string;
    commandId?: string | undefined;
    workspaceBindingId: string;
    prompt: string;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO invocations
      (id, command_id, workspace_binding_id, status, prompt, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      command_id = excluded.command_id,
      workspace_binding_id = excluded.workspace_binding_id,
      status = excluded.status,
      prompt = excluded.prompt,
      updated_at = excluded.updated_at`,
  ).run(
    input.invocationId,
    input.commandId ?? null,
    input.workspaceBindingId,
    input.prompt,
    input.now,
    input.now,
  );
}

function recordInvocationStatus(
  db: DatabaseSync,
  invocationId: string,
  status: "succeeded" | "failed" | "cancelled" | "timed_out",
  now: string,
): void {
  db.prepare(
    `UPDATE invocations
     SET status = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(status, now, invocationId);
}

function naviaStatusForRun(run: TaskRun): "succeeded" | "failed" | "cancelled" | "timed_out" {
  if (run.status === "succeeded") return "succeeded";
  if (run.status === "cancelled") return "cancelled";
  if (run.failureKind === "runtime_timeout") return "timed_out";
  return "failed";
}

function retryOfInvocationId(command: ServerCommandPayload): string | undefined {
  const value = command.payload?.retryOfInvocationId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function promptForCommand(command: ServerCommandPayload): string {
  if (typeof command.payload?.prompt === "string") return command.payload.prompt;
  return command.title ?? "Run the requested Navia task for this workspace.";
}

function taskRuntimeIdForCommand(command: ServerCommandPayload, invocationId: string): string {
  const explicitTaskId = command.payload?.runtimeTaskId;
  return typeof explicitTaskId === "string" && explicitTaskId.trim()
    ? explicitTaskId.trim()
    : `task-${invocationId}`;
}

function taskGraphForCommand(
  command: ServerCommandPayload,
  taskRuntimeId: string,
  invocationId: string,
  status: "running" | "done" | "failed",
  snapshotVersion: number,
  outputArtifactIds: string[] = [],
) {
  return {
    runtimeSnapshotId: `${invocationId}-${status}`,
    snapshotVersion,
    clusters: [
      {
        runtimeClusterId: "spark-runtime",
        title: "Spark runtime",
        status,
        payload: {},
      },
    ],
    tasks: [
      {
        runtimeTaskId: taskRuntimeId,
        runtimeClusterId: "spark-runtime",
        title: command.title ?? "Spark runtime task",
        description: promptForCommand(command),
        kind: "task.start",
        status,
        agentRef: "spark-runtime",
        inputArtifactIds: [],
        outputArtifactIds,
        runIds: [invocationId],
        payload: { commandKind: command.kind, retryOfInvocationId: retryOfInvocationId(command) },
      },
    ],
    dependencies: [],
    payload: {},
  };
}

function naviaArtifactIdForSparkRef(ref: ArtifactRef): `art_${string}` {
  return `art_${createHash("sha256").update(ref).digest("hex").slice(0, 32)}`;
}

function stableTaskName(taskRuntimeId: string): string {
  const normalized = taskRuntimeId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized ? `spark-daemon-${normalized}` : "spark-daemon-task";
}

function mimeForArtifactFormat(format: string): string {
  if (format === "markdown") return "text/markdown; charset=utf-8";
  if (format === "json") return "application/json; charset=utf-8";
  if (format === "text") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export function commandRejectForUnknownInvocation(route: RouteContext, messageId: string) {
  return commandReject(
    {
      reasonCode: "UNKNOWN_INVOCATION",
      message: "Spark daemon has no active Spark invocation matching this cancellation request.",
      retryable: false,
    },
    { ...route, ackOf: messageId },
  );
}
