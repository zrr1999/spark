import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { Type } from "typebox";
import { defaultArtifactStore } from "spark-artifacts";
import {
  approveManagedAgentAsk,
  clarifyThreadAsk,
  createSparkAskRequest,
  detectCopyLanguage,
  isSparkAskArtifactBody,
  isSparkAskGateBlocked,
  normalizeSparkAskResult,
  replaySparkAsk,
  reviewGateAsk,
  runSparkAsk,
  resolveTaskBlockerAsk,
  type SparkCopyLanguage,
} from "spark-ask";
import {
  AgentRegistry,
  builtinAgentRef,
  createManagedAgentSpec,
  defaultManagedAgentStore,
} from "spark-agents";
import {
  newRef,
  nowIso,
  type AgentRef,
  type ArtifactRef,
  type AskRef,
  type JsonValue,
  type ManagedAgentProposal,
  stableId,
  type SparkRunTrace,
  type Task,
  type TaskKind,
  type TaskStatus,
  type ThreadRef,
} from "spark-core";
import { registerPiCueTools } from "pi-cue";
import { createReviewGate } from "spark-review";
import {
  createSubagentClaimId,
  findResumableBackgroundSubagentTasks,
  DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
  killActiveSparkSubagentProcesses,
  runReadySparkTasks,
  runSparkTask,
  sweepExpiredTaskClaims,
} from "spark-runtime";
import {
  defaultTaskGraphStore,
  defaultTaskTodoStore,
  isUnfinishedTaskStatus,
  TaskGraph,
  type TaskPlanInput,
  type TaskTodoOp,
  type TaskTodoSummary,
} from "spark-tasks";
import {
  SparkWidget,
  type SessionTodoEntry,
  type SparkWidgetState,
  type TaskEntry,
} from "../ui/spark-widget.ts";

interface SparkExtensionAPI {
  registerCommand(
    name: string,
    config: {
      description: string;
      handler: (args: string, ctx: SparkCommandContext) => void | Promise<void>;
    },
  ): void;
  registerTool?(config: {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: SparkToolContext,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      details?: Record<string, unknown>;
    }>;
  }): void;
  on?(event: string, handler: (event: unknown, ctx: SparkToolContext) => unknown): void;
  sendUserMessage?(
    content: string,
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

interface SparkToolContext {
  cwd: string;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getLeafId?: () => string | undefined;
  };
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
    confirm?: (title: string, message: string) => Promise<boolean>;
    input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
    select?: (title: string, options: string[]) => Promise<string | undefined>;
    setWidget?: (key: string, cb: unknown, opts?: { placement?: string }) => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
}

interface SparkCommandContext extends SparkToolContext {
  waitForIdle?: () => Promise<void>;
  sendUserMessage?: (content: string) => Promise<void>;
}

const CLAIM_SWEEP_INTERVAL_MS = 30_000;
const claimReaperTimers = new Map<string, ReturnType<typeof setInterval>>();

function ensureClaimReaper(cwd: string): void {
  if (claimReaperTimers.has(cwd)) return;
  const timer = setInterval(() => void sweepExpiredSparkClaims(cwd), CLAIM_SWEEP_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  claimReaperTimers.set(cwd, timer);
}

async function sweepExpiredSparkClaims(cwd: string, ctx?: unknown): Promise<void> {
  const store = defaultTaskGraphStore(cwd);
  const result = await sweepExpiredTaskClaims(store);
  if (result.saved && result.graph) await sparkTodoStore(cwd, ctx).save(result.graph);
}

export default function sparkExtension(pi: SparkExtensionAPI) {
  if (pi.registerTool) {
    registerPiCueTools(pi as unknown as Parameters<typeof registerPiCueTools>[0]);
  }

  pi.on?.("input", async (event: unknown, ctx: SparkToolContext) => handleSparkInput(event, ctx));
  pi.on?.("before_agent_start", async (event: unknown, ctx: SparkToolContext) =>
    injectSparkHints(event, ctx),
  );
  pi.on?.("turn_start", async (_event: unknown, ctx: SparkToolContext) => {
    ensureClaimReaper(ctx.cwd);
    await sweepExpiredSparkClaims(ctx.cwd, ctx);
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
    await refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("session_start", async (_event: unknown, ctx: SparkToolContext) => {
    ensureClaimReaper(ctx.cwd);
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx, { skipSweep: true });
    await resumeOwnedBackgroundSubagents(ctx.cwd, ctx);
    await sweepExpiredSparkClaims(ctx.cwd, ctx);
    await refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("session_compact", async (_event: unknown, ctx: SparkToolContext) => {
    await refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("session_shutdown", async (event: unknown, ctx: SparkToolContext) => {
    await cleanupOwnedBackgroundSubagents(ctx.cwd, ctx, shutdownReason(event));
  });
  pi.on?.("session_tree", async (_event: unknown, ctx: SparkToolContext) => {
    await refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("tool_execution_end", async (event: unknown, ctx: SparkToolContext) => {
    if (
      isToolExecutionEvent(event, "spark_update_todos") ||
      isToolExecutionEvent(event, "spark_update_task_todos") ||
      isToolExecutionEvent(event, "spark_claim_task") ||
      isToolExecutionEvent(event, "spark_use_thread")
    ) {
      await refreshSparkWidget(ctx.cwd, ctx);
    }
  });
  pi.on?.("session_switch", async (_event: unknown, ctx: SparkToolContext) => {
    // Restore widget after session switch (/new, /resume)
    ensureClaimReaper(ctx.cwd);
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx, { skipSweep: true });
    await resumeOwnedBackgroundSubagents(ctx.cwd, ctx);
    await sweepExpiredSparkClaims(ctx.cwd, ctx);
    const store = defaultTaskGraphStore(ctx.cwd);
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    if (graph) {
      if (ensureSparkGraphInvariants(graph)) {
        await store.save(graph);
        await sparkTodoStore(ctx.cwd, ctx).save(graph);
      }
      await refreshSparkWidget(ctx.cwd, ctx);
    }
  });

  let widgetState: SparkWidgetState | undefined;
  let widgetCtx: SparkToolContext | undefined;
  let widgetUi: SparkToolContext["ui"] | undefined;
  const widget = new SparkWidget(
    () => widgetState,
    (key, cb) => {
      (
        widgetCtx?.ui as { setWidget?: (...args: unknown[]) => void } | null | undefined
      )?.setWidget?.(key, cb, { placement: "aboveEditor" });
    },
  );

  async function refreshSparkWidget(cwd: string, ctx?: SparkToolContext): Promise<void> {
    if (ctx?.ui !== widgetUi) {
      widget.dispose();
      widgetCtx = ctx;
      widgetUi = ctx?.ui;
    } else {
      widgetCtx = ctx;
    }

    const store = defaultTaskGraphStore(cwd);
    const graph = await loadSparkGraph(cwd, ctx);
    if (!graph) {
      widgetState = undefined;
      widget.update();
      return;
    }
    if (ensureSparkGraphInvariants(graph)) {
      await store.save(graph);
      await sparkTodoStore(cwd, ctx).save(graph);
    }
    const thread = await currentSparkThread(cwd, ctx, graph);
    if (!thread) {
      widgetState = undefined;
      widget.update();
      return;
    }
    const sessionKey = sparkSessionKey(ctx);
    const ownerSessionKey = sparkSessionOwnerKey(ctx);
    const allTasks = graph.tasks(thread.ref);
    const claimedTasks = allTasks.filter((task) => taskClaimedBy(task));
    const sessionTasks = claimedTasks.filter((task) => isClaimOwnedBySession(task, sessionKey));
    const independentTodos = (await loadIndependentTodos(cwd, ctx)).filter(
      (todo) => todo.status !== "done" && todo.status !== "cancelled" && todo.status !== "deleted",
    );
    const todoDisplayNumbers = await loadTodoDisplayNumberState(cwd, ctx);
    const numberedIndependentTodos = independentTodos.map((todo) => ({
      ...todo,
      displayNumber: assignTodoDisplayNumber(todoDisplayNumbers, independentTodoDisplayKey(todo)),
    }));
    const taskTodosByRef = new Map(allTasks.map((task) => [task.ref, graph.taskTodos(task.ref)]));
    const lastRunsByTaskRef = latestRunsByTaskRef(graph.runs(thread.ref));
    widgetState = {
      threadTitle: isPlaceholderThreadTitle(thread.title) ? undefined : thread.title,
      tasks: allTasks.map((task) => ({
        title: task.title,
        status: mapTaskStatus(task.status),
        claim: mapTaskClaim(task, sessionKey),
        agentLabel: taskAgentLabel(task, sessionKey, lastRunsByTaskRef.get(task.ref)),
        backgroundOwner:
          task.claim?.kind === "subagent" && task.claim.sessionId === ownerSessionKey
            ? "session"
            : undefined,
        todos: (taskTodosByRef.get(task.ref) ?? []).map((todo) => ({
          id: todo.id,
          displayNumber: assignTodoDisplayNumber(
            todoDisplayNumbers,
            taskTodoDisplayKey(task.ref, todo.id),
          ),
          content: todo.content,
          status: mapTodoStatus(todo.status),
        })),
      })),
      independentTodos: numberedIndependentTodos,
      taskCountTotal: allTasks.length,
      taskCountClaimed: claimedTasks.length,
      taskCountClaimedBySession: sessionTasks.length,
      outputLanguage: (thread.outputLanguage as "zh" | "en" | undefined) ?? "en",
    };

    if (todoDisplayNumbers.changed) await saveTodoDisplayNumberState(cwd, ctx, todoDisplayNumbers);
    widget.update();
  }

  async function cleanupOwnedBackgroundSubagents(
    cwd: string,
    ctx: SparkToolContext,
    reason: string,
  ): Promise<number> {
    const store = defaultTaskGraphStore(cwd);
    const graph = await loadSparkGraph(cwd, ctx);
    const ownerSessionId = sparkSessionOwnerKey(ctx);
    const owned = graph ? findResumableBackgroundSubagentTasks(graph, ownerSessionId) : [];
    const ownedRunRefs = owned.flatMap((task) => (task.claim?.runRef ? [task.claim.runRef] : []));
    const ownedAgentNames = owned.flatMap((task) =>
      task.claim?.agentName ? [task.claim.agentName] : [],
    );
    const killed = await killActiveSparkSubagentProcesses({
      reason: `spark session shutdown: ${reason}`,
      runRefs: ownedRunRefs.length > 0 ? ownedRunRefs : undefined,
      agentNames: ownedRunRefs.length > 0 ? undefined : ownedAgentNames,
    });
    if (!graph) return killed.length;
    const killedRunRefs = new Set(killed.map((run) => run.runRef));
    const killedAgentNames = new Set(
      killed.flatMap((run) => (run.agentName ? [run.agentName] : [])),
    );
    let changed = false;
    for (const task of owned) {
      const runRef = task.claim?.runRef;
      if (killedRunRefs.size > 0 && (!runRef || !killedRunRefs.has(runRef))) continue;
      if (
        killedRunRefs.size === 0 &&
        killedAgentNames.size > 0 &&
        !killedAgentNames.has(task.claim?.agentName ?? "")
      )
        continue;
      if (runRef) {
        const run = graph.runs(task.threadRef).find((candidate) => candidate.ref === runRef);
        if (run?.status === "running" || run?.status === "queued") {
          graph.recordRun({
            ...run,
            status: "cancelled",
            failureKind: "runtime_error",
            errorMessage: `background subagent killed on Spark session shutdown (${reason})`,
            finishedAt: nowIso(),
          });
          changed = true;
        }
      }
      graph.releaseTaskClaim(task.ref, task.claim?.claimedBy);
      changed = true;
    }
    if (changed) {
      await store.save(graph);
      await sparkTodoStore(cwd, ctx).save(graph);
      await refreshSparkWidget(cwd, ctx);
    }
    return killed.length;
  }

  async function resumeOwnedBackgroundSubagents(
    cwd: string,
    ctx: SparkToolContext,
    options: { runTask?: typeof runSparkTask } = {},
  ): Promise<number> {
    const store = defaultTaskGraphStore(cwd);
    const graph = await loadSparkGraph(cwd, ctx);
    if (!graph) return 0;
    const ownerSessionId = sparkSessionOwnerKey(ctx);
    const resumable = findResumableBackgroundSubagentTasks(graph, ownerSessionId);
    if (resumable.length === 0) return 0;
    const registry = new AgentRegistry();
    await defaultManagedAgentStore(cwd).hydrate(registry);
    const artifactStore = defaultArtifactStore(cwd);
    let resumed = 0;
    for (const task of resumable) {
      if (!task.claim?.agentName) continue;
      try {
        graph.releaseTaskClaim(task.ref, task.claim.claimedBy);
        await (options.runTask ?? runSparkTask)({
          graph,
          taskRef: task.ref,
          registry,
          artifactStore,
          cwd,
          dryRun: false,
          claim: {
            sessionId: ownerSessionId,
            agentName: task.claim.agentName,
            claimedBy: createSubagentClaimId(ownerSessionId, task.claim.agentName),
          },
          onHeartbeat: async () => {
            await store.save(graph);
          },
        });
        resumed += 1;
      } catch (error) {
        graph.recordRun({
          ref: newRef("run"),
          threadRef: task.threadRef,
          taskRef: task.ref,
          agentRef: task.agentRef,
          agentName: task.claim?.agentName,
          status: "failed",
          failureKind: "runtime_error",
          errorMessage: error instanceof Error ? error.message : String(error),
          startedAt: nowIso(),
          finishedAt: nowIso(),
          outputArtifacts: [],
        });
      }
    }
    await store.save(graph);
    await sparkTodoStore(cwd, ctx).save(graph);
    return resumed;
  }

  function mapTaskStatus(status: string): TaskEntry["status"] {
    switch (status) {
      case "running":
        return "running";
      case "done":
        return "done";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      case "blocked":
        return "blocked";
      default:
        return "pending";
    }
  }

  function mapTaskClaim(task: Task, sessionKey: string): TaskEntry["claim"] {
    if (task.claim?.kind === "subagent") return "subagent";
    const claimedBy = taskClaimedBy(task);
    if (!claimedBy) return undefined;
    return isClaimOwnedBySession(task, sessionKey) ? "mine" : "other";
  }

  function taskAgentLabel(
    task: Task,
    sessionKey: string,
    lastRun?: ReturnType<TaskGraph["runs"]>[number],
  ): string {
    const claimedBy = taskClaimedBy(task);
    const agentName = task.claim?.agentName?.trim();
    if (task.claim?.kind === "subagent") {
      if (!agentName) return "unknown-subagent";
      const owner = task.claim.sessionId
        ? sessionDisplayLabel(task.claim.sessionId, sessionKey)
        : "unknown-session";
      return `${owner}/${agentName}`;
    }
    if (!claimedBy) {
      if (!isUnfinishedTaskStatus(task.status)) {
        const completedAgentName = task.completedByAgentName?.trim();
        const completedBySession = task.completedBySession?.trim();
        if (completedAgentName) {
          const owner = completedBySession
            ? sessionDisplayLabel(completedBySession, sessionKey)
            : "unknown-session";
          return `${owner}/${completedAgentName}`;
        }
        if (completedBySession) return sessionDisplayLabel(completedBySession, sessionKey);
        if (lastRun?.agentName) {
          const owner = lastRun.ownerSessionId
            ? sessionDisplayLabel(lastRun.ownerSessionId, sessionKey)
            : "unknown-session";
          return `${owner}/${lastRun.agentName}`;
        }
      }
      return "unassigned";
    }
    if (isClaimOwnedBySession(task, sessionKey)) return "me";
    if (claimedBy.startsWith("session:")) return sessionDisplayLabel(claimedBy, sessionKey);
    return claimedBy;
  }

  function sessionDisplayLabel(sessionId: string, currentSessionKey: string): string {
    if (sessionId === currentSessionKey) return "me";
    return sessionId.startsWith("session:")
      ? sessionId.slice("session:".length, "session:".length + 8)
      : sessionId;
  }

  function latestRunsByTaskRef(
    runs: ReturnType<TaskGraph["runs"]>,
  ): Map<string, ReturnType<TaskGraph["runs"]>[number]> {
    const result = new Map<string, ReturnType<TaskGraph["runs"]>[number]>();
    for (const run of runs) {
      const current = result.get(run.taskRef);
      const currentTime = current?.finishedAt ?? current?.startedAt ?? "";
      const runTime = run.finishedAt ?? run.startedAt ?? "";
      if (!current || runTime >= currentTime) result.set(run.taskRef, run);
    }
    return result;
  }

  function taskClaimSummary(task: Task): string {
    const claimedBy = taskClaimedBy(task);
    if (!claimedBy) return "no";
    const agentName = task.claim?.agentName?.trim();
    const spec = task.claim?.agentRef ? shortAgentLabel(task.claim.agentRef) : undefined;
    if (agentName) return spec ? `${agentName}(spec:${spec})` : agentName;
    return claimedBy;
  }

  function shortAgentLabel(agentRef: string): string {
    return agentRef.replace(/^agent:(builtin-|managed-)?/, "");
  }

  function mapTodoStatus(status: string): SessionTodoEntry["status"] {
    switch (status) {
      case "in_progress":
      case "done":
      case "blocked":
      case "cancelled":
      case "pending":
        return status;
      default:
        return "pending";
    }
  }

  function isImportantStatus(status: TaskStatus): boolean {
    return status !== "done" && status !== "cancelled";
  }

  function countTaskStatuses(tasks: Task[]): Partial<Record<TaskStatus, number>> {
    const counts: Partial<Record<TaskStatus, number>> = {};
    for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }

  function formatTaskStatusCounts(counts: Partial<Record<TaskStatus, number>>): string {
    const order: TaskStatus[] = [
      "running",
      "blocked",
      "pending",
      "ready",
      "proposed",
      "failed",
      "done",
      "cancelled",
    ];
    const parts = order.flatMap((status) => {
      const count = counts[status] ?? 0;
      return count > 0 ? [`${status}=${count}`] : [];
    });
    return parts.length > 0 ? parts.join(" ") : "none";
  }

  pi.registerCommand("spark", {
    description:
      "Turn an idea into SPARK.md, a thread/task DAG, agent plan, artifacts, and review gates.",
    async handler(args, ctx) {
      const idea = args.trim();
      if (!idea) {
        ctx.ui?.notify?.("Usage: /spark <idea>", "warning");
        return;
      }

      const existing = await loadSparkGraph(ctx.cwd, ctx);
      if (existing) {
        ctx.ui?.notify?.(
          "Spark is already initialized for this workspace; existing thread state was not overwritten.",
          "info",
        );
        const existingThread = await currentSparkThread(ctx.cwd, ctx, existing);
        pi.sendUserMessage?.(renderExistingSparkSummary(existing, existingThread?.ref), {
          deliverAs: "followUp",
        });
        await refreshSparkWidget(ctx.cwd, ctx);
        return;
      }

      const language = detectCopyLanguage(idea);
      const workingTitle = titleFromIdea(idea);
      const outputLanguage: SparkCopyLanguage = language;

      const result = await initializeSparkIdea(ctx.cwd, idea, {
        threadTitle: workingTitle,
        outputLanguage,
        clarification: {
          workingTitle,
          outputLanguage,
          objective: idea,
          nextAction: "analyze_then_targeted_ask",
        },
      });

      ctx.ui?.notify?.(
        language === "zh" ? "Spark 线程已初始化" : "Spark thread initialized",
        "success",
      );
      pi.sendUserMessage?.(renderSparkInitSummary(result), {
        deliverAs: "followUp",
      });

      await saveCurrentThreadRef(ctx.cwd, ctx, result.threadRef as ThreadRef);
      await refreshSparkWidget(ctx.cwd, ctx);

      // Auto-execute the first ready DAG layer (scout — no dependencies)
      const store = defaultTaskGraphStore(ctx.cwd);
      await store.update(
        async (graph) => {
          const registry = new AgentRegistry();
          await defaultManagedAgentStore(ctx.cwd).hydrate(registry);
          const artifactStore = defaultArtifactStore(ctx.cwd);
          const runResult = await runReadySparkTasks({
            graph,
            registry,
            artifactStore,
            threadRef: result.threadRef as ThreadRef,
            cwd: ctx.cwd,
            maxConcurrency: DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
            timeoutMs: DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
            claim: { sessionId: sparkSessionOwnerKey(ctx) },
            onHeartbeat: async () => {
              await store.save(graph);
            },
            onProgress: async () => {
              await store.save(graph);
              await sparkTodoStore(ctx.cwd, ctx).save(graph);
            },
          });
          if (runResult.scheduled > 0) await sparkTodoStore(ctx.cwd, ctx).save(graph);
        },
        { createIfMissing: false },
      );
    },
  });

  pi.registerTool?.({
    name: "spark_status",
    label: "Spark Status",
    description: "Show the current Spark thread/task DAG status for the active workspace.",
    parameters: Type.Object({
      showFinished: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Include done/cancelled tasks. Failed tasks are always shown.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd =
        typeof (ctx as { cwd?: unknown }).cwd === "string"
          ? (ctx as { cwd: string }).cwd
          : process.cwd();
      await ensureSparkStateForActiveWorkspace(cwd, ctx);
      const store = defaultTaskGraphStore(cwd);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false, active: false },
        };
      if (ensureSparkGraphInvariants(graph)) {
        await store.save(graph);
        await sparkTodoStore(cwd, ctx).save(graph);
      }
      const showFinished = (params as { showFinished?: boolean }).showFinished === true;
      const lines = ["Spark tasks:"];
      const sessionKey = sparkSessionKey(ctx);
      const independentTodos = await loadIndependentTodos(cwd, ctx);
      for (const thread of graph.threads()) {
        const tasks = graph.tasks(thread.ref);
        const claimed = tasks.filter((task) => taskClaimedBy(task));
        const sessionClaimed = claimed.filter((task) => isClaimOwnedBySession(task, sessionKey));
        const statusCounts = countTaskStatuses(tasks);
        const visibleTasks = tasks.filter((task) => showFinished || isImportantStatus(task.status));
        const hiddenFinished = tasks.length - visibleTasks.length;
        lines.push(`\nThread ${thread.ref}: ${thread.title}`);
        lines.push(
          `  Tasks: ${tasks.length} total | ${claimed.length} claimed | ${sessionClaimed.length} claimed_by_session | ${formatTaskStatusCounts(statusCounts)}`,
        );
        if (hiddenFinished > 0)
          lines.push(
            `  Hidden finished tasks: ${hiddenFinished} (pass showFinished=true to include)`,
          );
        lines.push(showFinished ? "  Durable tasks:" : "  Active/important tasks:");
        for (const task of visibleTasks) {
          const taskSummary = graph.todoSummary(task.ref);
          lines.push(
            `  - [${task.status}] @${task.name}: ${task.title} (${task.ref}) kind=${task.kind} claimed=${taskClaimSummary(task)} todos=${taskSummary.total}/${taskSummary.inProgress}/${taskSummary.pending}/${taskSummary.done}`,
          );
          if (isClaimOwnedBySession(task, sessionKey)) {
            for (const todo of graph.taskTodos(task.ref)) {
              lines.push(`    - [${todo.status}] ${todo.id} ${todo.content}`);
            }
          }
        }
        if (visibleTasks.length === 0) lines.push("  - none");
      }
      lines.push(`\nIndependent session TODOs: ${independentTodos.length}`);
      for (const todo of independentTodos)
        lines.push(`  - [${todo.status}] ${todo.id ?? ""} ${todo.content}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: graph.snapshot() as unknown as Record<string, unknown>,
      };
    },
  });

  pi.registerTool?.({
    name: "spark_update_todos",
    label: "Spark Update TODOs",
    description:
      "Update independent session TODOs. These TODOs are not tied to a claimed task and survive reload/restart for this session.",
    parameters: Type.Object({
      ops: Type.Array(
        Type.Object({
          op: Type.String({
            description:
              "init | append | start | done | block | cancel | delete | restore | remove | note",
          }),
          id: Type.Optional(Type.String()),
          item: Type.Optional(Type.String()),
          items: Type.Optional(Type.Array(Type.String())),
          text: Type.Optional(Type.String()),
          blockedBy: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const p = params as { ops?: TaskTodoOp[] };
      if (!p.ops?.length)
        return {
          content: [{ type: "text", text: "TODO ops are required." }],
          details: { error: "missing_ops" },
        };
      const todos = applyIndependentTodoOps(await loadIndependentTodos(cwd, ctx), p.ops);
      await saveIndependentTodos(cwd, ctx, todos);
      await refreshSparkWidget(cwd, ctx);
      return {
        content: [{ type: "text", text: `Updated ${todos.length} independent Spark TODO(s).` }],
        details: { todos: todos as unknown as Record<string, unknown>[] },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_update_task_todos",
    label: "Spark Update Task TODOs",
    description:
      "Update TODOs attached to this session's one currently claimed unfinished task. Only claimed unfinished tasks can have task TODOs modified; use spark_update_todos for independent session TODOs.",
    parameters: Type.Object({
      task: Type.Optional(
        Type.String({
          description:
            "Claimed task ref, title, or title prefix. Defaults to current claimed task.",
        }),
      ),
      ops: Type.Array(
        Type.Object({
          op: Type.String({
            description:
              "init | append | start | done | block | cancel | delete | restore | remove | note",
          }),
          id: Type.Optional(Type.String()),
          item: Type.Optional(Type.String()),
          items: Type.Optional(Type.Array(Type.String())),
          text: Type.Optional(Type.String()),
          blockedBy: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const p = params as { task?: string; ops?: TaskTodoOp[] };
      if (!p.ops?.length)
        return {
          content: [{ type: "text", text: "TODO ops are required." }],
          details: { found: true, error: "missing_ops" },
        };
      const store = defaultTaskGraphStore(cwd);
      const updated = await store.update(
        async (graph) => {
          await sparkTodoStore(cwd, ctx).hydrate(graph);
          const thread = await currentSparkThread(cwd, ctx, graph);
          if (!thread) return { error: "no_thread" as const };
          const task = resolveSessionClaimedTask(graph, thread.ref, sparkSessionKey(ctx), p.task);
          if (!task) return { error: "no_matching_claimed_task" as const };
          graph.applyTodoOps(task.ref, p.ops ?? []);
          await sparkTodoStore(cwd, ctx).save(graph);
          return { task: graph.getTask(task.ref) };
        },
        { createIfMissing: false },
      );
      if (!updated.graph)
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false },
        };
      if (updated.result.error === "no_thread")
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false },
        };
      if (updated.result.error === "no_matching_claimed_task")
        return {
          content: [{ type: "text", text: "No matching claimed task for this session." }],
          details: { found: true, error: "no_matching_claimed_task" },
        };
      await refreshSparkWidget(cwd, ctx);
      return {
        content: [
          {
            type: "text",
            text: `Updated TODOs for ${updated.result.task.title} (${updated.result.task.ref}).`,
          },
        ],
        details: { task: updated.result.task as unknown as Record<string, unknown> },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_claim_task",
    label: "Spark Claim Task",
    description:
      "Create or update a concrete Spark task for this session. For Spark-native delegated work, bind the task to a builtin or managed agent with agentRef and run it via spark_run_ready_tasks; do not spawn nested pi CLI sessions as pseudo-agents unless explicitly testing Pi CLI behavior.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description: "Simple @name handle for this task (lowercase, digits, - or _).",
        }),
      ),
      title: Type.String({ description: "Human-readable task title shown as @name: title." }),
      description: Type.String({ description: "What the claimed task will accomplish." }),
      kind: Type.Optional(
        Type.String({
          description: "research | plan | implement | review | ask | cue | interaction | generic",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description: "proposed | pending | ready | running | blocked | done | failed | cancelled",
        }),
      ),
      agentRef: Type.Optional(
        Type.String({
          description:
            "Optional builtin/managed Spark agent id or ref from spark_list_agents, e.g. planner or agent:builtin-planner. Agent-bound tasks default to pending and are eligible for spark_run_ready_tasks.",
        }),
      ),
      todos: Type.Optional(Type.Array(Type.String({ description: "Task-local TODO item." }))),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const p = params as {
        name?: string;
        title: string;
        description: string;
        kind?: string;
        status?: string;
        agentRef?: string;
        todos?: string[];
      };
      const name = p.name?.trim();
      const title = p.title.trim();
      const description = p.description.trim();
      if (!title || !description)
        return {
          content: [{ type: "text", text: "Task title and description are required." }],
          details: { found: true, error: "missing_title_or_description" },
        };
      let agentRef: AgentRef | undefined;
      if (p.agentRef?.trim()) {
        const registry = new AgentRegistry();
        await defaultManagedAgentStore(cwd).hydrate(registry);
        agentRef = registry.select(p.agentRef.trim()).ref;
      }
      const kind = normalizeTaskKind(p.kind) ?? "interaction";
      const status = normalizeTaskStatus(p.status) ?? (agentRef ? "pending" : "running");
      const sessionKey = sparkSessionKey(ctx);
      const store = defaultTaskGraphStore(cwd);
      const claimed = await store.update(
        async (graph) => {
          await sparkTodoStore(cwd, ctx).hydrate(graph);
          const thread = await currentSparkThread(cwd, ctx, graph);
          if (!thread) return { error: "no_thread" as const };
          const existing = graph
            .tasks(thread.ref)
            .find(
              (task) =>
                task.claimedBySession === sessionKey &&
                ((name && task.name === name) || task.title === title),
            );
          const activeClaim = findActiveSessionClaim(graph, thread.ref, sessionKey, existing?.ref);
          if (isUnfinishedTaskStatus(status) && activeClaim)
            return { error: "active_claim_exists" as const, activeTask: activeClaim };
          const task = existing
            ? graph.updateTask(existing.ref, {
                name,
                title,
                description,
                kind,
                status,
                agentRef,
                claimedBySession: sessionKey,
              })
            : graph.createTask({
                threadRef: thread.ref,
                name,
                title,
                description,
                kind,
                status,
                agentRef,
                claimedBySession: sessionKey,
              });
          if (isUnfinishedTaskStatus(status)) {
            graph.claimTask(task.ref, {
              kind: "main",
              claimedBy: sessionKey,
              sessionId: sessionKey,
              agentRef,
            });
          }
          const todos = p.todos?.map((todo) => todo.trim()).filter(Boolean) ?? [];
          if (todos.length > 0) {
            graph.applyTodoOps(task.ref, [
              {
                op: "init",
                items: todos,
              },
            ]);
            await sparkTodoStore(cwd, ctx).save(graph);
          }
          return { task: graph.getTask(task.ref) };
        },
        { createIfMissing: false },
      );
      if (!claimed.graph || claimed.result.error === "no_thread")
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false },
        };
      if (claimed.result.error === "active_claim_exists")
        return {
          content: [
            {
              type: "text",
              text: `Cannot claim ${title}: this session already has unfinished claimed task ${claimed.result.activeTask.title} (${claimed.result.activeTask.ref}). Finish, fail, or cancel it before claiming another task.`,
            },
          ],
          details: {
            found: true,
            error: "active_claim_exists",
            activeTask: claimed.result.activeTask as unknown as Record<string, unknown>,
          },
        };
      return {
        content: [
          {
            type: "text",
            text: `Claimed Spark task: @${claimed.result.task.name}: ${claimed.result.task.title} (${claimed.result.task.ref})`,
          },
        ],
        details: { task: claimed.result.task as unknown as Record<string, unknown> },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_use_thread",
    label: "Spark Use Thread",
    description:
      "Set or create this Pi session's current Spark thread. Other sessions keep their own current thread selection.",
    parameters: Type.Object({
      thread: Type.Optional(
        Type.String({ description: "Existing thread ref or title/title prefix to use." }),
      ),
      title: Type.Optional(
        Type.String({ description: "Title for a new thread if thread is omitted." }),
      ),
      description: Type.Optional(
        Type.String({ description: "Description for a newly created thread." }),
      ),
      outputLanguage: Type.Optional(
        Type.String({ description: "zh | en for a newly created thread." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const store = defaultTaskGraphStore(cwd);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false },
        };
      const p = params as {
        thread?: string;
        title?: string;
        description?: string;
        outputLanguage?: string;
      };
      let thread = resolveSparkThread(graph, p.thread);
      if (!thread) {
        const title = p.title?.trim();
        if (!title)
          return {
            content: [
              {
                type: "text",
                text: "Provide an existing thread ref/title, or provide title to create a new current thread for this session.",
              },
            ],
            details: { found: true, error: "missing_thread_or_title" },
          };
        thread = graph.createThread({
          title,
          description: p.description?.trim() || title,
          outputLanguage:
            p.outputLanguage === "zh" || p.outputLanguage === "en" ? p.outputLanguage : undefined,
        });
        await store.save(graph);
      }
      await saveCurrentThreadRef(cwd, ctx, thread.ref);
      await refreshSparkWidget(cwd, ctx);
      return {
        content: [
          {
            type: "text",
            text: `Current Spark thread for this session: ${thread.title} (${thread.ref})`,
          },
        ],
        details: { thread: thread as unknown as Record<string, unknown> },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_plan_tasks",
    label: "Spark Plan Tasks",
    description:
      "Create or update multiple durable Spark tasks in the active thread from a concrete task plan. Use this dedicated spark-tasks-backed planning tool when asked to梳理/organize work before assigning agents; it does not claim tasks for the current session.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          name: Type.Optional(
            Type.String({ description: "Stable simple @name handle for the task." }),
          ),
          title: Type.String({ description: "Human-readable task title shown as @name: title." }),
          description: Type.String({ description: "Concrete task objective/instruction." }),
          kind: Type.Optional(
            Type.String({
              description:
                "research | plan | implement | review | ask | cue | interaction | generic",
            }),
          ),
          status: Type.Optional(
            Type.String({
              description:
                "proposed | pending | ready | running | blocked | done | failed | cancelled",
            }),
          ),
          agentRef: Type.Optional(
            Type.String({
              description:
                "Optional builtin/managed Spark agent id or ref, e.g. scout, planner, reviewer, worker.",
            }),
          ),
          dependsOn: Type.Optional(
            Type.Array(
              Type.String({
                description: "Dependency task ref, @name/name, or task title in this plan/thread.",
              }),
            ),
          ),
          rationale: Type.Optional(
            Type.String({ description: "Why this task belongs in the plan." }),
          ),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const store = defaultTaskGraphStore(cwd);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false },
        };
      const thread = await currentSparkThread(cwd, ctx, graph);
      if (!thread)
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false },
        };
      const registry = new AgentRegistry();
      await defaultManagedAgentStore(cwd).hydrate(registry);
      const p = params as {
        tasks?: Array<{
          name?: string;
          title: string;
          description: string;
          kind?: string;
          status?: string;
          agentRef?: string;
          dependsOn?: string[];
          rationale?: string;
        }>;
      };
      if (!p.tasks?.length)
        return {
          content: [{ type: "text", text: "Task plan is required." }],
          details: { found: true, error: "missing_tasks" },
        };
      const tasks: TaskPlanInput[] = p.tasks.map((task) => ({
        name: task.name,
        title: task.title,
        description: task.description,
        kind: normalizeTaskKind(task.kind) ?? "generic",
        status: normalizeTaskStatus(task.status) ?? (task.agentRef ? "pending" : "proposed"),
        agentRef: task.agentRef?.trim() ? registry.select(task.agentRef.trim()).ref : undefined,
        dependsOn: task.dependsOn,
        rationale: task.rationale,
      }));
      const result = graph.planTasks(thread.ref, tasks);
      await store.save(graph);
      await sparkTodoStore(cwd, ctx).save(graph);
      await refreshSparkWidget(cwd, ctx);
      const lines = [
        `Planned ${result.created.length} new task(s), updated ${result.updated.length}, added ${result.dependencies.length} dependencies.`,
        ...result.created.map(
          (task) => `- created [${task.status}] @${task.name}: ${task.title} (${task.ref})`,
        ),
        ...result.updated.map(
          (task) => `- updated [${task.status}] @${task.name}: ${task.title} (${task.ref})`,
        ),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { result: result as unknown as Record<string, unknown> },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_run_ready_tasks",
    label: "Spark Run Ready Tasks",
    description:
      "Run all currently ready Spark tasks with their bound builtin/managed Spark agents and persist task-run artifacts. Dry-run by default. Use this for Spark-native agent/task workflow instead of spawning nested pi CLI sessions.",
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ default: true })),
      maxConcurrency: Type.Optional(
        Type.Number({
          default: DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
          description: "Maximum number of subagents running at once. Default: 4.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          default: DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
          description: "Overall DAG-level timeout in milliseconds. This is not a per-task timeout.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd =
        typeof (ctx as { cwd?: unknown }).cwd === "string"
          ? (ctx as { cwd: string }).cwd
          : process.cwd();
      const store = defaultTaskGraphStore(cwd);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false },
        };
      if (ensureSparkGraphInvariants(graph)) {
        await store.save(graph);
        await sparkTodoStore(cwd, ctx).save(graph);
      }
      const artifactStore = defaultArtifactStore(cwd);
      const registry = new AgentRegistry();
      await defaultManagedAgentStore(cwd).hydrate(registry);
      const dryRun = params.dryRun !== false;
      const result = await runReadySparkTasks({
        graph,
        registry,
        artifactStore,
        cwd,
        dryRun,
        maxConcurrency:
          typeof params.maxConcurrency === "number"
            ? params.maxConcurrency
            : DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
        timeoutMs:
          typeof params.timeoutMs === "number"
            ? params.timeoutMs
            : DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
        claim: dryRun ? undefined : { sessionId: sparkSessionOwnerKey(ctx) },
        onHeartbeat: async () => {
          await store.save(graph);
        },
        onProgress: async () => {
          await store.save(graph);
          await sparkTodoStore(cwd, ctx).save(graph);
        },
      });
      await store.save(graph);
      await sparkTodoStore(cwd, ctx).save(graph);
      const runLabels = result.runs.map((run) => run.agentName ?? run.agentRef ?? run.ref);
      const timeoutSuffix = result.timedOut ? " Timed out before the DAG finished." : "";
      return {
        content: [
          {
            type: "text",
            text: runLabels.length
              ? `Ran ${result.runs.length} Spark task run(s) with maxConcurrency=${result.maxConcurrency}: ${runLabels.join(", ")}.${timeoutSuffix}`
              : `Ran 0 ready Spark task(s) with maxConcurrency=${result.maxConcurrency}.${timeoutSuffix}`,
          },
        ],
        details: { result: result as unknown as Record<string, unknown> },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_ask",
    label: "Spark Ask",
    description:
      "Ask the user a structured clarification, decision, approval, or unblock question and persist the answer as an artifact.",
    parameters: Type.Object({
      kind: Type.String({
        description: "clarification | decision | approval | unblock",
      }),
      question: Type.String({ description: "Question shown to the user." }),
      options: Type.Array(
        Type.Object({
          id: Type.String(),
          label: Type.String(),
          description: Type.String(),
          preview: Type.Optional(Type.String()),
        }),
      ),
      multiSelect: Type.Optional(Type.Boolean({ default: false })),
      defaultOptionId: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as {
        question: string;
        options?: Array<{ id: string; label: string; description: string }>;
        multiSelect?: boolean;
        timeoutMs?: number;
      };
      const cwd = ctxCwd(ctx);
      const request = createSparkAskRequest({
        flow: "custom",
        title: p.question,
        questions: [
          {
            id: "answer",
            prompt: p.question,
            type: p.multiSelect === true ? "multi" : "single",
            options:
              p.options?.map((option) => ({
                value: option.id,
                label: option.label,
                description: option.description,
              })) ?? [],
            required: true,
          },
        ],
        behaviour: {
          allowElaborate: true,
          allowReplay: true,
          preservePriorAnswers: true,
        },
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      });
      const result = normalizeSparkAskResult(await runSparkAsk(request, sparkAskUi(ctx)), request);
      const sparkAskRequest = request as { title?: string };
      const artifact = await defaultArtifactStore(cwd).put({
        kind: "ask-answer",
        title: `Ask answer: ${sparkAskRequest.title ?? "custom ask"}`,
        format: "json",
        body: { request, result } as unknown as JsonValue,
        provenance: { producer: "ask" },
      });
      const answer = result.answers.answer;
      const blocked = isSparkAskGateBlocked(result, request);
      return {
        content: [
          {
            type: "text",
            text: blocked
              ? `Ask blocked (${result.status}): no decision/approval selection (${artifact.ref})`
              : `Ask ${result.status}: ${answer?.values.join(", ") || answer?.customText || "no selection"} (${artifact.ref})`,
          },
        ],
        details: {
          request: request as unknown as Record<string, unknown>,
          result: result as unknown as Record<string, unknown>,
          status: result.status,
          blocked,
          artifactRef: artifact.ref,
        },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_ask_clarify_thread",
    label: "Spark Ask Clarify Thread",
    description: "Run the thread-clarification ask flow for a new or ambiguous Spark request.",
    parameters: Type.Object({
      idea: Type.String({ description: "The initial project intent or ambiguous request." }),
      title: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as { idea: string; title?: string; timeoutMs?: number };
      return runAndPersistSparkAskFlow(
        ctxCwd(ctx),
        clarifyThreadAsk({
          idea: p.idea,
          title: p.title,
          timeoutMs: p.timeoutMs,
        }),
        sparkAskUi(ctx),
      );
    },
  });

  pi.registerTool?.({
    name: "spark_ask_approve_agent",
    label: "Spark Ask Approve Agent",
    description: "Run the managed-agent approval ask flow.",
    parameters: Type.Object({
      id: Type.String(),
      description: Type.String(),
      systemPrompt: Type.String(),
      rationale: Type.String(),
      expectedUses: Type.Array(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as {
        id: string;
        description: string;
        systemPrompt: string;
        rationale: string;
        expectedUses: string[];
        timeoutMs?: number;
      };
      return runAndPersistSparkAskFlow(
        ctxCwd(ctx),
        approveManagedAgentAsk({
          proposal: {
            id: p.id,
            description: p.description,
            systemPrompt: p.systemPrompt,
            rationale: p.rationale,
            expectedUses: p.expectedUses,
          },
          timeoutMs: p.timeoutMs,
        }),
        sparkAskUi(ctx),
      );
    },
  });

  pi.registerTool?.({
    name: "spark_ask_unblock_task",
    label: "Spark Ask Unblock Task",
    description: "Run the task-blocker resolution ask flow.",
    parameters: Type.Object({
      taskTitle: Type.String(),
      blocker: Type.String(),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as { taskTitle: string; blocker: string; timeoutMs?: number };
      return runAndPersistSparkAskFlow(
        ctxCwd(ctx),
        resolveTaskBlockerAsk({
          taskTitle: p.taskTitle,
          blocker: p.blocker,
          timeoutMs: p.timeoutMs,
        }),
        sparkAskUi(ctx),
      );
    },
  });

  pi.registerTool?.({
    name: "spark_ask_review_gate",
    label: "Spark Ask Review Gate",
    description: "Run the review-gate decision ask flow.",
    parameters: Type.Object({
      subject: Type.String(),
      summary: Type.String(),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as { subject: string; summary: string; timeoutMs?: number };
      return runAndPersistSparkAskFlow(
        ctxCwd(ctx),
        reviewGateAsk({
          subject: p.subject,
          summary: p.summary,
          timeoutMs: p.timeoutMs,
        }),
        sparkAskUi(ctx),
      );
    },
  });

  pi.registerTool?.({
    name: "spark_ask_replay",
    label: "Spark Ask Replay",
    description:
      "Replay the latest Spark ask artifact, or a specified ask artifact, preserving prior answers where possible.",
    parameters: Type.Object({
      artifactRef: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const store = defaultArtifactStore(cwd);
      const artifactRef =
        typeof params.artifactRef === "string" ? (params.artifactRef as ArtifactRef) : undefined;
      const artifact = artifactRef
        ? await store.get(artifactRef)
        : (await store.list({ kind: "ask-answer" })).slice(-1)[0];
      if (!artifact) {
        return {
          content: [{ type: "text", text: "No replayable ask artifact found." }],
          details: { found: false },
        };
      }
      if (!isSparkAskArtifactBody(artifact.body)) {
        return {
          content: [
            {
              type: "text",
              text: `Artifact ${artifact.ref} is not a Spark ask artifact.`,
            },
          ],
          details: { found: true, replayable: false },
        };
      }
      const request = artifact.body.request;
      const prior = artifact.body.result;
      const result = normalizeSparkAskResult(
        await replaySparkAsk(request, prior, sparkAskUi(ctx)),
        request,
      );
      const replayArtifact = await store.put({
        kind: "ask-answer",
        title: `Replay ask: ${request.title ?? request.flow}`,
        format: "json",
        body: { request, result } as unknown as JsonValue,
        provenance: { producer: "ask", parentArtifactRefs: [artifact.ref] },
      });
      const blocked = isSparkAskGateBlocked(result, request);
      return {
        content: [
          {
            type: "text",
            text: blocked
              ? `Replay blocked (${result.status}): no decision/approval selection (${replayArtifact.ref})`
              : `Replayed ask ${result.status} saved to ${replayArtifact.ref}`,
          },
        ],
        details: {
          artifactRef: replayArtifact.ref,
          request: request,
          result: result,
          status: result.status,
          blocked,
        },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_list_agents",
    label: "Spark List Agents",
    description: "List builtin and managed agents available to Spark.",
    parameters: Type.Object({
      scope: Type.Optional(Type.String({ description: "builtin | managed" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const registry = new AgentRegistry();
      await defaultManagedAgentStore(cwd).hydrate(registry);
      const scope = typeof params.scope === "string" ? params.scope : undefined;
      const agents = registry.list().filter((agent) => !scope || agent.scope === scope);
      const lines = agents.map(
        (agent) => `- [${agent.scope}] ${agent.id} (${agent.ref}) — ${agent.description}`,
      );
      return {
        content: [
          {
            type: "text",
            text: lines.length ? lines.join("\n") : "No matching agents.",
          },
        ],
        details: { agents: agents as unknown as Record<string, unknown>[] },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_get_agent",
    label: "Spark Get Agent",
    description: "Inspect one builtin or managed agent spec.",
    parameters: Type.Object({
      agent: Type.String({ description: "agent id or full agent ref" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as { agent: string };
      const cwd = ctxCwd(ctx);
      const registry = new AgentRegistry();
      await defaultManagedAgentStore(cwd).hydrate(registry);
      const agent = registry.select(p.agent);
      return {
        content: [
          {
            type: "text",
            text: [
              `${agent.id} (${agent.ref})`,
              `scope: ${agent.scope}`,
              `description: ${agent.description}`,
            ].join("\n"),
          },
        ],
        details: { agent: agent as unknown as Record<string, unknown> },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_create_managed_agent",
    label: "Spark Create Managed Agent",
    description: "Create and persist a managed Spark agent from a validated proposal shape.",
    parameters: Type.Object({
      id: Type.String({ description: "stable managed agent id" }),
      description: Type.String({ description: "what this agent is for" }),
      systemPrompt: Type.String({
        description: "fixed system prompt for the managed agent",
      }),
      rationale: Type.String({
        description: "why this managed agent should exist",
      }),
      expectedUses: Type.Array(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as {
        id: string;
        description: string;
        systemPrompt: string;
        rationale: string;
        expectedUses: string[];
      };
      const cwd = ctxCwd(ctx);
      const proposal: ManagedAgentProposal = {
        id: p.id,
        description: p.description,
        systemPrompt: p.systemPrompt,
        rationale: p.rationale,
        expectedUses: p.expectedUses,
      };
      const artifactStore = defaultArtifactStore(cwd);
      const proposalArtifact = await artifactStore.put({
        kind: "agent-spec-proposal",
        title: `Managed agent proposal: ${proposal.id}`,
        format: "json",
        body: proposal as unknown as JsonValue,
        provenance: { producer: "agent" },
      });
      const spec = createManagedAgentSpec({
        ...proposal,
        artifactRef: proposalArtifact.ref,
      });
      await defaultManagedAgentStore(cwd).save(spec);
      return {
        content: [
          {
            type: "text",
            text: `Managed agent created: ${spec.id} (${spec.ref}) proposal=${proposalArtifact.ref}`,
          },
        ],
        details: {
          agent: spec as unknown as Record<string, unknown>,
          proposalArtifactRef: proposalArtifact.ref,
        },
      };
    },
  });
}

interface SparkInputEvent {
  text: string;
  source?: string;
}

interface SparkContextLike {
  cwd?: string;
}

async function handleSparkInput(event: unknown, ctx: unknown): Promise<unknown> {
  if (!isSparkInputEvent(event)) return { action: "continue" };
  if (event.source === "extension") return { action: "continue" };
  const text = event.text.trim();
  if (!text || text.startsWith("/")) return { action: "continue" };
  const cwd = ctxCwd(ctx);
  const activation = await detectSparkActivation(cwd);
  if (activation.active) return { action: "continue" };
  const intent = detectNaturalSparkIntent(text);
  if (intent === "new_idea") return { action: "transform", text: `/spark ${text}` };
  return { action: "continue" };
}

async function injectSparkHints(event: unknown, ctx: unknown): Promise<unknown> {
  const cwd = ctxCwd(ctx);
  const activation = await detectSparkActivation(cwd);
  if (!activation.active) return undefined;
  await ensureSparkStateForActiveWorkspace(cwd, ctx);
  const contextSummary = await renderActiveSparkContextSummary(cwd, ctx);
  const sparkPrompt = renderSparkActiveSystemPrompt(eventSystemPrompt(event), activation.reason);
  return {
    systemPrompt: contextSummary ? `${sparkPrompt}\n\n${contextSummary}` : sparkPrompt,
  };
}

async function renderActiveSparkContextSummary(
  cwd: string,
  ctx?: unknown,
): Promise<string | undefined> {
  const store = defaultTaskGraphStore(cwd);
  const graph = await loadSparkGraph(cwd, ctx);
  if (!graph) return undefined;
  if (ensureSparkGraphInvariants(graph)) {
    await store.save(graph);
    await sparkTodoStore(cwd, ctx).save(graph);
  }
  const sparkMd = await readActiveSparkMd(cwd);
  const thread = await currentSparkThread(cwd, ctx, graph);
  const sessionKey = sparkSessionKey(ctx);
  const independentTodos = await loadIndependentTodos(cwd, ctx);
  const stateLines = thread
    ? (() => {
        const tasks = graph.tasks(thread.ref);
        const claimed = tasks.filter((task) => taskClaimedBy(task));
        const sessionClaimed = claimed.filter((task) => isClaimOwnedBySession(task, sessionKey));
        const taskLines = sessionClaimed.flatMap((task) => {
          const summary = graph.todoSummary(task.ref);
          return [
            `- Claimed task: @${task.name}: ${task.title} (${task.ref}) TODOs ${summary.total}/${summary.inProgress}/${summary.pending}/${summary.done}`,
            ...graph
              .taskTodos(task.ref)
              .slice(0, 5)
              .map((todo) => `  - [${todo.status}] ${todo.id} ${todo.content}`),
          ];
        });
        const independentLines = independentTodos
          .slice(0, 5)
          .map((todo) => `  - [${todo.status}] ${todo.id ?? ""} ${todo.content}`);
        return [
          "Spark current state:",
          `- Thread: ${thread.title} (${thread.ref})`,
          `- Tasks: ${tasks.length} total / ${claimed.length} claimed / ${sessionClaimed.length} claimed_by_session`,
          ...taskLines,
          independentTodos.length > 0
            ? `- Independent TODOs: ${independentTodos.length}`
            : undefined,
          ...independentLines,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n");
      })()
    : undefined;
  const lines = [
    sparkMd ? ["SPARK.md (persistent project intent):", sparkMd.trim()].join("\n") : undefined,
    stateLines,
  ].filter((line): line is string => Boolean(line));
  return lines.length ? lines.join("\n\n") : undefined;
}

async function loadSparkGraph(cwd: string, ctx?: unknown): Promise<TaskGraph | null> {
  const graph = await defaultTaskGraphStore(cwd).load();
  if (!graph) return null;
  await sparkTodoStore(cwd, ctx).hydrate(graph);
  return graph;
}

function sparkTodoStore(cwd: string, ctx: unknown): ReturnType<typeof defaultTaskTodoStore> {
  return defaultTaskTodoStore(cwd, sparkSessionKey(ctx));
}

function currentThreadStorePath(cwd: string, ctx: unknown): string {
  return join(
    cwd,
    ".spark",
    "current-thread",
    `${sanitizeStoreScope(sparkSessionOwnerKey(ctx))}.json`,
  );
}

async function loadCurrentThreadRef(cwd: string, ctx: unknown): Promise<ThreadRef | undefined> {
  try {
    const raw = JSON.parse(await readFile(currentThreadStorePath(cwd, ctx), "utf8")) as {
      threadRef?: string;
    };
    return raw.threadRef as ThreadRef | undefined;
  } catch {
    return undefined;
  }
}

async function saveCurrentThreadRef(
  cwd: string,
  ctx: unknown,
  threadRef: ThreadRef,
): Promise<void> {
  const filePath = currentThreadStorePath(cwd, ctx);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ version: 1, threadRef }, null, 2)}\n`, "utf8");
}

async function currentSparkThread(
  cwd: string,
  ctx: unknown,
  graph: TaskGraph,
): Promise<ReturnType<TaskGraph["threads"]>[number] | undefined> {
  const threads = graph.threads();
  if (threads.length === 0) return undefined;
  const stored = await loadCurrentThreadRef(cwd, ctx);
  const selected = stored ? threads.find((thread) => thread.ref === stored) : undefined;
  if (selected) return selected;
  const fallback = threads[0];
  if (fallback) await saveCurrentThreadRef(cwd, ctx, fallback.ref);
  return fallback;
}

function resolveSparkThread(
  graph: TaskGraph,
  query?: string,
): ReturnType<TaskGraph["threads"]>[number] | undefined {
  const threads = graph.threads();
  const needle = query?.trim();
  if (!needle) return undefined;
  return threads.find(
    (thread) => thread.ref === needle || thread.title === needle || thread.title.startsWith(needle),
  );
}

function taskClaimedBy(task: Task): string | undefined {
  return task.claim?.claimedBy ?? task.claimedBySession;
}

function isClaimOwnedBySession(task: Task, sessionKey: string): boolean {
  return task.claim?.sessionId === sessionKey || task.claimedBySession === sessionKey;
}

function resolveSessionClaimedTask(
  graph: TaskGraph,
  threadRef: ThreadRef,
  sessionKey: string,
  query?: string,
): Task | undefined {
  const claimed = graph
    .tasks(threadRef)
    .filter(
      (task) => isClaimOwnedBySession(task, sessionKey) && isUnfinishedTaskStatus(task.status),
    );
  if (query?.trim()) {
    const needle = query.trim();
    const normalizedNeedle = needle.startsWith("@") ? needle.slice(1) : needle;
    return claimed.find(
      (task) =>
        task.ref === needle ||
        task.name === normalizedNeedle ||
        task.title === needle ||
        task.title.startsWith(needle),
    );
  }
  const current = graph.currentTask(threadRef);
  if (
    current &&
    isClaimOwnedBySession(current, sessionKey) &&
    isUnfinishedTaskStatus(current.status)
  )
    return current;
  return claimed.at(-1);
}

function findActiveSessionClaim(
  graph: TaskGraph,
  threadRef: ThreadRef,
  sessionKey: string,
  exceptTaskRef?: string,
): Task | undefined {
  return graph
    .tasks(threadRef)
    .find(
      (task) =>
        task.ref !== exceptTaskRef &&
        isClaimOwnedBySession(task, sessionKey) &&
        isUnfinishedTaskStatus(task.status),
    );
}

function independentTodoStorePath(cwd: string, ctx: unknown): string {
  return join(cwd, ".spark", "session-todos", `${sanitizeStoreScope(sparkSessionKey(ctx))}.json`);
}

interface TodoDisplayNumberState {
  version: 1;
  next: number;
  numbers: Record<string, number>;
  changed?: boolean;
}

function todoDisplayNumberStorePath(cwd: string, ctx: unknown): string {
  return join(
    cwd,
    ".spark",
    "todo-display-numbers",
    `${sanitizeStoreScope(sparkSessionKey(ctx))}.json`,
  );
}

async function loadTodoDisplayNumberState(
  cwd: string,
  ctx: unknown,
): Promise<TodoDisplayNumberState> {
  try {
    const raw = JSON.parse(await readFile(todoDisplayNumberStorePath(cwd, ctx), "utf8")) as {
      version?: number;
      next?: number;
      numbers?: Record<string, number>;
    };
    const numbers: Record<string, number> = {};
    let max = 0;
    for (const [key, value] of Object.entries(raw.numbers ?? {})) {
      if (!Number.isInteger(value) || value <= 0) continue;
      numbers[key] = value;
      max = Math.max(max, value);
    }
    return { version: 1, next: Math.max(raw.next ?? 1, max + 1), numbers };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, next: 1, numbers: {} };
    throw error;
  }
}

function assignTodoDisplayNumber(state: TodoDisplayNumberState, key: string): number {
  const existing = state.numbers[key];
  if (existing) return existing;
  const displayNumber = state.next;
  state.numbers[key] = displayNumber;
  state.next += 1;
  state.changed = true;
  return displayNumber;
}

async function saveTodoDisplayNumberState(
  cwd: string,
  ctx: unknown,
  state: TodoDisplayNumberState,
): Promise<void> {
  const filePath = todoDisplayNumberStorePath(cwd, ctx);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ version: 1, next: state.next, numbers: state.numbers }, null, 2)}\n`,
    "utf8",
  );
  state.changed = false;
}

function taskTodoDisplayKey(taskRef: string, todoId: string): string {
  return `task:${taskRef}:${todoId}`;
}

function independentTodoDisplayKey(todo: SessionTodoEntry): string {
  return `independent:${todo.id ?? stableId(todo.content)}`;
}

async function loadIndependentTodos(cwd: string, ctx: unknown): Promise<SessionTodoEntry[]> {
  try {
    const raw = JSON.parse(await readFile(independentTodoStorePath(cwd, ctx), "utf8")) as {
      todos?: SessionTodoEntry[];
    };
    return (raw.todos ?? []).filter((todo) => todo.status !== "deleted");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function saveIndependentTodos(
  cwd: string,
  ctx: unknown,
  todos: SessionTodoEntry[],
): Promise<void> {
  const filePath = independentTodoStorePath(cwd, ctx);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ version: 1, todos, updatedAt: nowIso() }, null, 2)}\n`,
    "utf8",
  );
}

function applyIndependentTodoOps(todos: SessionTodoEntry[], ops: TaskTodoOp[]): SessionTodoEntry[] {
  let next = [...todos];
  for (const op of ops) next = applyIndependentTodoOp(next, op);
  return normalizeIndependentTodos(next);
}

function applyIndependentTodoOp(todos: SessionTodoEntry[], op: TaskTodoOp): SessionTodoEntry[] {
  const now = nowIso();
  switch (op.op) {
    case "init":
      if (!op.items?.length) throw new Error("todo init items are required");
      return op.items.map((content, index) => materializeIndependentTodo(content, index, now));
    case "append": {
      if (!op.items?.length) throw new Error("todo append items are required");
      const next = [...todos];
      for (const item of op.items) {
        const content = item.trim();
        if (!content) throw new Error("todo content is required");
        if (next.some((todo) => todo.content === content))
          throw new Error(`duplicate todo content: ${content}`);
        next.push(materializeIndependentTodo(content, next.length, now));
      }
      return next;
    }
    case "start": {
      const target = resolveIndependentTodo(todos, op, "todo item is required for start");
      return todos.map((todo) => {
        if (todo.id === target.id) return { ...todo, status: "in_progress", updatedAt: now };
        if (todo.status === "in_progress") return { ...todo, status: "pending", updatedAt: now };
        return todo;
      });
    }
    case "done":
      return patchIndependentTodoStatus(todos, op, "done", now, "todo item is required for done");
    case "block":
      return patchIndependentTodoStatus(
        todos,
        op,
        "blocked",
        now,
        "todo item is required for block",
      );
    case "cancel":
      return patchIndependentTodoStatus(
        todos,
        op,
        "cancelled",
        now,
        "todo item is required for cancel",
      );
    case "delete":
    case "remove":
      return patchIndependentTodoStatus(
        todos,
        op,
        "deleted",
        now,
        "todo item is required for delete",
      );
    case "restore":
      return patchIndependentTodoStatus(
        todos,
        op,
        "pending",
        now,
        "todo item is required for restore",
        true,
      );
    case "note": {
      const target = resolveIndependentTodo(todos, op, "todo item is required for note");
      const text = op.text?.trimEnd();
      if (!text) throw new Error("todo note text is required");
      return todos.map((todo) =>
        todo.id === target.id
          ? { ...todo, notes: todo.notes ? [...todo.notes, text] : [text], updatedAt: now }
          : todo,
      );
    }
  }
}

function materializeIndependentTodo(content: string, index: number, now: string): SessionTodoEntry {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("todo content is required");
  return {
    id: `todo-${stableId(`${trimmed}:${index}`).slice(0, 8)}`,
    content: trimmed,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

function patchIndependentTodoStatus(
  todos: SessionTodoEntry[],
  op: TaskTodoOp,
  status: SessionTodoEntry["status"],
  now: string,
  missingMessage: string,
  includeDeleted = false,
): SessionTodoEntry[] {
  const target = resolveIndependentTodo(todos, op, missingMessage, includeDeleted);
  return todos.map((todo) => (todo.id === target.id ? { ...todo, status, updatedAt: now } : todo));
}

function resolveIndependentTodo(
  todos: SessionTodoEntry[],
  op: TaskTodoOp,
  missingMessage: string,
  includeDeleted = false,
): SessionTodoEntry {
  const id = op.id?.trim();
  const item = op.item?.trim();
  if (!id && !item) throw new Error(missingMessage);
  const candidates = includeDeleted ? todos : todos.filter((todo) => todo.status !== "deleted");
  const found = id
    ? candidates.find((todo) => todo.id === id)
    : candidates.find((todo) => todo.content === item);
  if (!found) throw new Error(id ? `todo id not found: ${id}` : `todo item not found: ${item}`);
  return found;
}

function normalizeIndependentTodos(todos: SessionTodoEntry[]): SessionTodoEntry[] {
  const next = todos.map((todo) => ({ ...todo }));
  const live = next.filter((todo) => todo.status !== "deleted" && todo.status !== "cancelled");
  const active = live.filter((todo) => todo.status === "in_progress");
  if (active.length > 1) {
    for (const todo of active.slice(1)) todo.status = "pending";
  }
  if (!live.some((todo) => todo.status === "in_progress")) {
    const first = live.find((todo) => todo.status === "pending");
    if (first) first.status = "in_progress";
  }
  return next;
}

function sanitizeStoreScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-") || "default";
}

async function ensureSparkStateForActiveWorkspace(
  cwd: string,
  ctx?: unknown,
  options: { skipSweep?: boolean } = {},
): Promise<TaskGraph | null> {
  if (!options.skipSweep) await sweepExpiredSparkClaims(cwd, ctx);
  ensureClaimReaper(cwd);
  const existing = await loadSparkGraph(cwd, ctx);
  if (existing) return existing;
  const sparkMdPath = await findUpExisting(cwd, "SPARK.md");
  if (!sparkMdPath) return null;
  const sparkMd = await readFile(sparkMdPath, "utf8");
  await initializeSparkIdea(cwd, ideaFromSparkMd(sparkMd), {
    threadTitle: titleFromSparkMd(sparkMd),
    sparkMd,
  });
  return loadSparkGraph(cwd, ctx);
}

async function detectSparkActivation(cwd: string): Promise<{ active: boolean; reason: string }> {
  if (await findUpExisting(cwd, "SPARK.md")) return { active: true, reason: "SPARK.md" };
  if (await findUpExisting(cwd, join(".spark", "thread.json")))
    return { active: true, reason: ".spark/thread.json" };
  if (await isWhitelistedByConfig(cwd))
    return { active: true, reason: "~/.config/spark/config.toml" };
  return { active: false, reason: "none" };
}

function detectNaturalSparkIntent(text: string): "new_idea" | "maybe_idea" | "normal_task" {
  const normalized = text.toLowerCase();
  if (
    /^(我想|我希望|我有个|帮我构建|帮我做|构建一个|做一个|create a|build a|i want to build|i have an idea)/i.test(
      text.trim(),
    )
  )
    return "new_idea";
  if (normalized.includes("idea") || text.includes("想法") || text.includes("新项目"))
    return "maybe_idea";
  return "normal_task";
}

async function isWhitelistedByConfig(cwd: string): Promise<boolean> {
  const configPath = join(homedir(), ".config", "spark", "config.toml");
  try {
    const config = await readFile(configPath, "utf8");
    if (/enabled\s*=\s*false/.test(config)) return false;
    const dirs = [...config.matchAll(/"([^"]+)"/g)].map((match) =>
      resolve(expandHome(match[1] ?? "")),
    );
    const resolved = resolve(cwd);
    return dirs.some((dir) => resolved === dir || resolved.startsWith(`${dir}/`));
  } catch {
    return false;
  }
}

async function findUpExisting(cwd: string, relativePath: string): Promise<string | null> {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, relativePath);
    if (await exists(candidate)) return candidate;
    const parent = dirname(current);
    if (current === parent) return null;
    current = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function shouldMaterializeSparkMd(cwd: string): Promise<boolean> {
  return exists(join(cwd, ".git"));
}

function expandHome(value: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function isSparkInputEvent(event: unknown): event is SparkInputEvent {
  return Boolean(
    event && typeof event === "object" && typeof (event as { text?: unknown }).text === "string",
  );
}

function ctxCwd(ctx: unknown): string {
  return ctx && typeof ctx === "object" && typeof (ctx as SparkContextLike).cwd === "string"
    ? (ctx as { cwd: string }).cwd
    : process.cwd();
}

function isToolExecutionEvent(event: unknown, toolName: string): boolean {
  return Boolean(
    event &&
    typeof event === "object" &&
    (event as { toolName?: unknown }).toolName === toolName &&
    (event as { isError?: unknown }).isError !== true,
  );
}

function shutdownReason(event: unknown): string {
  return event &&
    typeof event === "object" &&
    typeof (event as { reason?: unknown }).reason === "string"
    ? (event as { reason: string }).reason
    : "unknown";
}

function sparkSessionKey(ctx: unknown): string {
  if (ctx && typeof ctx === "object") {
    const manager = (ctx as SparkToolContext).sessionManager;
    const sessionFile = manager?.getSessionFile?.();
    if (sessionFile) return `session:${stableId(sessionFile)}`;
    const leaf = manager?.getLeafId?.();
    if (leaf) return `leaf:${leaf}`;
  }
  return "session:ephemeral";
}

function sparkSessionOwnerKey(ctx: unknown): string {
  if (ctx && typeof ctx === "object") {
    const manager = (ctx as SparkToolContext).sessionManager;
    const sessionFile = manager?.getSessionFile?.();
    if (sessionFile) return `session:${stableId(sessionFile)}`;
  }
  return sparkSessionKey(ctx);
}

function sparkAskUi(ctx: unknown) {
  if (!ctx || typeof ctx !== "object") return undefined;
  const ui = (ctx as { ui?: unknown }).ui;
  if (!ui || typeof ui !== "object") return undefined;
  return {
    select:
      typeof (ui as { select?: unknown }).select === "function"
        ? (
            ui as {
              select: (title: string, options: string[]) => Promise<string | undefined>;
            }
          ).select
        : undefined,
    confirm:
      typeof (ui as { confirm?: unknown }).confirm === "function"
        ? (
            ui as {
              confirm: (title: string, message: string) => Promise<boolean>;
            }
          ).confirm
        : undefined,
    input:
      typeof (ui as { input?: unknown }).input === "function"
        ? (
            ui as {
              input: (title: string, defaultValue?: string) => Promise<string | undefined>;
            }
          ).input
        : undefined,
    notify:
      typeof (ui as { notify?: unknown }).notify === "function"
        ? (
            ui as {
              notify: (message: string, level?: "info" | "warning" | "error" | "success") => void;
            }
          ).notify
        : undefined,
  };
}

async function runAndPersistSparkAskFlow(
  cwd: string,
  request: Parameters<typeof createSparkAskRequest>[0],
  ui: ReturnType<typeof sparkAskUi>,
) {
  const normalizedRequest = createSparkAskRequest(request);
  const result = normalizeSparkAskResult(
    await runSparkAsk(normalizedRequest, ui),
    normalizedRequest,
  );
  const artifact = await defaultArtifactStore(cwd).put({
    kind: "ask-answer",
    title: `Spark ask: ${normalizedRequest.title ?? normalizedRequest.flow}`,
    format: "json",
    body: { request: normalizedRequest, result } as unknown as JsonValue,
    provenance: { producer: "ask" },
  });
  const preview = Object.entries(result.answers).map(
    ([id, answer]) => `${id}=${answer.values.join(",") || answer.customText || ""}`,
  );
  const blocked = isSparkAskGateBlocked(result, normalizedRequest);
  return {
    content: [
      {
        type: "text" as const,
        text: blocked
          ? `Spark ask blocked (${result.status}): no decision/approval selection (${artifact.ref})`
          : `Spark ask ${result.status}/${result.mode}: ${preview.join("; ") || "no answers"} (${artifact.ref})`,
      },
    ],
    details: {
      request: normalizedRequest as unknown as Record<string, unknown>,
      result: result as unknown as Record<string, unknown>,
      status: result.status,
      blocked,
      artifactRef: artifact.ref,
    },
  };
}

function eventSystemPrompt(event: unknown): string {
  return event &&
    typeof event === "object" &&
    typeof (event as { systemPrompt?: unknown }).systemPrompt === "string"
    ? (event as { systemPrompt: string }).systemPrompt
    : "";
}

export function renderSparkActiveSystemPrompt(basePrompt: string, reason: string): string {
  const sparkPrompt = [
    `Spark is active for the current workspace (${reason}).`,
    "The spark skill is loaded and available — read it with the read tool when Spark workflow guidance is needed.",
    "SPARK.md is persistent project intent supplied in this system prompt; follow it as standing context instead of relying on chat history.",
    "Use spark_status for thread state, spark_use_thread to select or create this session's current thread, spark_plan_tasks to organize or create a task plan without claiming it, spark_claim_task when this session has concrete task work to claim, spark_update_task_todos for TODOs attached to the currently claimed task, spark_update_todos for independent session TODOs, spark_list_agents/spark_get_agent to choose Spark agents, spark_run_ready_tasks when the user asks to proceed, and pi-cue tools (run/jobs/status/kill/wait/cron/scopes/log) for command execution.",
    "Each agent/session may claim at most one unfinished task at a time; finish, fail, or cancel the current claim before claiming another. Do not auto-create placeholder tasks or threads for display; only claim tasks inferred from the actual situation. TODOs are session-maintained: task-scoped TODOs can be modified only on a claimed unfinished task, while independent TODOs are siblings of the thread display.",
    "During Spark initialization, do not ask a broad upfront form. First analyze the request and workspace context, then ask only targeted clarification questions if the analysis finds a concrete ambiguity.",
    "Before launching multiple agents or parallel workstreams, present the workstream split with goals and expected outputs via spark_ask unless the user explicitly requested immediate dispatch; do not continue on timeout or no-selection for decision/approval gates.",
    "For Spark workstreams, prefer the built-in/managed Spark agent flow: bind concrete tasks to agentRef values from spark_list_agents or spark_get_agent, then run them with spark_run_ready_tasks. Agent refs such as @worker are specs/types; each real running subagent gets a distinct concrete agentName that appears in claims/status. Do not spawn nested pi CLI sessions as pseudo-agents unless the task is explicitly testing Pi CLI behavior.",
    "When using pi-cue run, prefer direct-exec commands and Pi file tools over /bin/sh; use /bin/sh -lc only for genuine shell semantics such as redirection, here-docs, variable expansion, or compound shell conditionals.",
    "Keep temporary plans, agent reports, and scratch artifacts out of the repo root; write them under .spark/notes, .spark/agent-reports, or the Spark artifact store unless the user asks for committed documentation.",
    "Do not guess missing intent. If scope, output, or next action is ambiguous, ask the user to clarify before proceeding.",
    "After a clarification or decision answer is confirmed, continue with the selected action in the same turn when the next action is clear; do not stop just to ask for permission to proceed again.",
    "If the user points out a concrete Spark/pi-tool behavior change or defect in the current codebase, treat that as an implementation task unless they explicitly say it is only a preference/memory update.",
    "Do not satisfy such feedback by only storing memory or preferences; update the relevant code, docs, tests, or Spark state when appropriate.",
  ].join(" ");
  return basePrompt ? `${basePrompt}\n\n${sparkPrompt}` : sparkPrompt;
}

export interface SparkInitResult {
  cwd: string;
  idea: string;
  threadTitle: string;
  threadRef: string;
  taskCount: number;
  outputLanguage: SparkCopyLanguage;
  currentTaskRef?: string;
  currentTaskTitle?: string;
  /** Initialization TODOs persisted separately from thread.json. */
  todoSummary: {
    total: number;
    inProgress: number;
    pending: number;
    done: number;
    blocked: number;
    cancelled: number;
  };
  sparkMdPath?: string;
  sparkMdArtifactRef: string;
  agentPlanArtifactRef: string;
  traceRef: string;
  askArtifactRefs: ArtifactRef[];
}

export interface SparkInitClarificationData {
  workingTitle?: string;
  outputLanguage?: SparkCopyLanguage;
  sparkFocus?: string;
  objective?: string;
  targetUser?: string;
  smallestSlice?: string;
  successSignal?: string;
  nonGoals?: string;
  deliveryMode?: string;
  nextAction?: string;
}

interface SparkInitOptions {
  threadTitle?: string;
  outputLanguage?: SparkCopyLanguage;
  clarification?: SparkInitClarificationData;
  sparkMd?: string;
  askArtifactRefs?: ArtifactRef[];
  askRefs?: AskRef[];
}

export async function initializeSparkIdea(
  cwd: string,
  idea: string,
  options: SparkInitOptions = {},
): Promise<SparkInitResult> {
  const sparkDir = join(cwd, ".spark");
  await mkdir(sparkDir, { recursive: true });

  const existingGraph = await defaultTaskGraphStore(cwd).load();
  if (existingGraph) return sparkInitResultFromExisting(cwd, idea, existingGraph, options);

  const graph = new TaskGraph();
  const threadTitle =
    options.threadTitle ?? options.clarification?.workingTitle ?? titleFromIdea(idea);
  const thread = graph.createThread({
    title: threadTitle,
    description: options.clarification?.objective ?? idea,
    outputLanguage: options.outputLanguage ?? options.clarification?.outputLanguage,
  });

  const scout = graph.createTask({
    threadRef: thread.ref,
    title: "Analyze project intent",
    description:
      "Inspect the request and workspace context first, then identify only targeted clarification questions; do not start with a broad intake form.",
    kind: "research",
    agentRef: builtinAgentRef("scout"),
  });
  const planner = graph.createTask({
    threadRef: thread.ref,
    title: "Plan targeted clarification",
    description:
      "Turn the analysis into a small task graph and targeted asks with explicit agent bindings and no guessed scope.",
    kind: "plan",
    agentRef: builtinAgentRef("planner"),
  });
  const reviewer = graph.createTask({
    threadRef: thread.ref,
    title: "Review initial direction",
    description:
      "Verify that the task graph follows the analyzed intent, asks only targeted questions after analysis, and avoids premature implementation.",
    kind: "review",
    agentRef: builtinAgentRef("reviewer"),
  });
  graph.addDependency(planner.ref, scout.ref);
  graph.addDependency(reviewer.ref, planner.ref);

  const store = defaultArtifactStore(cwd);
  const sparkMd =
    options.sparkMd ??
    renderSparkMd({ idea, workingTitle: threadTitle, clarification: options.clarification });
  const sparkMdArtifact = await store.put({
    kind: "spark-md",
    title: "SPARK.md draft",
    format: "markdown",
    body: sparkMd,
    provenance: { producer: "spark", threadRef: thread.ref },
  });
  const sparkMdPath = (await shouldMaterializeSparkMd(cwd)) ? join(cwd, "SPARK.md") : undefined;
  if (sparkMdPath) await writeFile(sparkMdPath, sparkMd, "utf8");

  const agentPlan = renderAgentPlan({ idea, tasks: graph.tasks(thread.ref) });
  const agentPlanArtifact = await store.put({
    kind: "agent-plan",
    title: "Initial agent plan",
    format: "markdown",
    body: agentPlan,
    provenance: {
      producer: "spark",
      threadRef: thread.ref,
      parentArtifactRefs: [sparkMdArtifact.ref],
    },
  });

  const gate = createReviewGate({
    subject: agentPlanArtifact.ref,
    lens: "artifact",
    policy: "required",
    outcome: "blocked",
    summary: "Initial Spark flow created a review gate; reviewer execution is pending.",
  });

  const trace: SparkRunTrace = {
    ref: newRef("spark"),
    idea,
    threadRef: thread.ref,
    sparkMdArtifactRef: sparkMdArtifact.ref,
    taskRefs: graph.tasks(thread.ref).map((task) => task.ref),
    reviewRefs: [gate.ref],
    askRefs: options.askRefs ?? [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await store.put({
    kind: "run-trace",
    title: "Spark run trace",
    format: "json",
    body: trace as unknown as JsonValue,
    provenance: {
      producer: "spark",
      threadRef: thread.ref,
      parentArtifactRefs: [sparkMdArtifact.ref, agentPlanArtifact.ref],
    },
  });
  await defaultTaskGraphStore(cwd).save(graph);
  await sparkTodoStore(cwd, undefined).save(graph);
  await writeFile(join(sparkDir, "review-gate.json"), `${JSON.stringify(gate, null, 2)}\n`, "utf8");

  const currentTask = graph.currentTask(thread.ref);
  const todoSummary = currentTask ? graph.todoSummary(currentTask.ref) : emptyTodoSummary();
  return {
    cwd,
    idea,
    threadTitle,
    threadRef: thread.ref,
    taskCount: graph.tasks(thread.ref).length,
    outputLanguage: options.clarification?.outputLanguage ?? detectCopyLanguage(idea),
    currentTaskRef: currentTask?.ref,
    currentTaskTitle: currentTask?.title,
    todoSummary: {
      total: todoSummary.total,
      inProgress: todoSummary.inProgress,
      pending: todoSummary.pending,
      done: todoSummary.done,
      blocked: todoSummary.blocked,
      cancelled: todoSummary.cancelled,
    },
    sparkMdPath,
    sparkMdArtifactRef: sparkMdArtifact.ref,
    agentPlanArtifactRef: agentPlanArtifact.ref,
    traceRef: trace.ref,
    askArtifactRefs: options.askArtifactRefs ?? [],
  };
}

async function sparkInitResultFromExisting(
  cwd: string,
  idea: string,
  graph: TaskGraph,
  options: SparkInitOptions,
): Promise<SparkInitResult> {
  const thread = graph.threads()[0];
  if (!thread) throw new Error("existing Spark graph has no thread");
  const currentTask = graph.currentTask(thread.ref);
  const todoSummary = currentTask ? graph.todoSummary(currentTask.ref) : emptyTodoSummary();
  const latestSparkMd = await readActiveSparkMd(cwd);
  const sparkMdPath = (await exists(join(cwd, "SPARK.md"))) ? join(cwd, "SPARK.md") : undefined;
  return {
    cwd,
    idea,
    threadTitle: thread.title,
    threadRef: thread.ref,
    taskCount: graph.tasks(thread.ref).length,
    outputLanguage:
      options.clarification?.outputLanguage ??
      (thread.outputLanguage as SparkCopyLanguage | undefined) ??
      detectCopyLanguage(latestSparkMd ?? idea),
    currentTaskRef: currentTask?.ref,
    currentTaskTitle: currentTask?.title,
    todoSummary: {
      total: todoSummary.total,
      inProgress: todoSummary.inProgress,
      pending: todoSummary.pending,
      done: todoSummary.done,
      blocked: todoSummary.blocked,
      cancelled: todoSummary.cancelled,
    },
    sparkMdPath,
    sparkMdArtifactRef: "artifact:existing" as ArtifactRef,
    agentPlanArtifactRef: "artifact:existing" as ArtifactRef,
    traceRef: "spark:existing",
    askArtifactRefs: options.askArtifactRefs ?? [],
  };
}

function renderExistingSparkSummary(graph: TaskGraph, selectedThreadRef?: ThreadRef): string {
  const threads = graph.threads();
  const thread =
    (selectedThreadRef
      ? threads.find((candidate) => candidate.ref === selectedThreadRef)
      : undefined) ?? threads[0];
  if (!thread) return "Spark is already initialized; no thread was overwritten.";
  return [
    "Spark is already initialized; existing state was not overwritten.",
    `- Current thread for this session: ${thread.title} (${thread.ref})`,
    `- Tasks: ${graph.tasks(thread.ref).length}`,
  ].join("\n");
}

function renderSparkInitSummary(result: SparkInitResult): string {
  if (result.outputLanguage === "zh") {
    const lines = [
      "Spark 已初始化：",
      `- 想法：${result.idea}`,
      `- 线程标题：${result.threadTitle}`,
      result.sparkMdPath
        ? `- SPARK.md：${result.sparkMdPath}`
        : "- SPARK.md：未物化（当前 cwd 没有 .git）",
      `- Thread：${result.threadRef}`,
      `- Tasks：${result.taskCount}`,
      result.currentTaskTitle
        ? `- 当前 task：${result.currentTaskTitle} (${result.currentTaskRef})`
        : "- 当前 task：无",
      `- 当前 TODO：${result.todoSummary.total} total / ${result.todoSummary.inProgress} in_progress / ${result.todoSummary.pending} pending / ${result.todoSummary.done} done`,
      `- SPARK artifact：${result.sparkMdArtifactRef}`,
      `- Agent plan artifact：${result.agentPlanArtifactRef}`,
      `- Trace：${result.traceRef}`,
    ];
    for (const askRef of result.askArtifactRefs) lines.push(`- Clarification ask：${askRef}`);
    return lines.join("\n");
  }

  const lines = [
    "Spark initialized:",
    `- Idea: ${result.idea}`,
    `- Thread title: ${result.threadTitle}`,
    result.sparkMdPath
      ? `- SPARK.md: ${result.sparkMdPath}`
      : "- SPARK.md: not materialized (cwd has no .git)",
    `- Thread: ${result.threadRef}`,
    `- Tasks: ${result.taskCount}`,
    result.currentTaskTitle
      ? `- Current task: ${result.currentTaskTitle} (${result.currentTaskRef})`
      : "- Current task: none",
    `- Current TODOs: ${result.todoSummary.total} total / ${result.todoSummary.inProgress} in_progress / ${result.todoSummary.pending} pending / ${result.todoSummary.done} done`,
    `- SPARK artifact: ${result.sparkMdArtifactRef}`,
    `- Agent plan artifact: ${result.agentPlanArtifactRef}`,
    `- Trace: ${result.traceRef}`,
  ];
  for (const askRef of result.askArtifactRefs) lines.push(`- Clarification ask: ${askRef}`);
  return lines.join("\n");
}

function titleFromIdea(idea: string): string {
  const firstLine = idea.split(/\r?\n/, 1)[0]?.trim() ?? "Spark thread";
  return normalizeThreadTitle(firstLine);
}

function titleFromSparkMd(markdown: string): string {
  const description = /^description:\s*(.+)$/m.exec(markdown)?.[1]?.trim();
  if (description) return normalizeThreadTitle(description.replace(/^['"]|['"]$/g, ""));
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  if (heading) return normalizeThreadTitle(heading);
  const workingTitle = /##\s+(?:Working title|当前工作标题)\s+\n\s*-\s+(.+)/i
    .exec(markdown)?.[1]
    ?.trim();
  return normalizeThreadTitle(workingTitle ?? "Spark thread");
}

function ideaFromSparkMd(markdown: string): string {
  const origin = sectionBody(markdown, "Origin") ?? sectionBody(markdown, "起源");
  return origin || titleFromSparkMd(markdown);
}

function sectionBody(markdown: string, heading: string): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`##\\s+${escaped}\\s+\\n([\\s\\S]*?)(?:\\n##\\s+|$)`, "i").exec(
    markdown,
  );
  const body = match?.[1]?.trim();
  return body || undefined;
}

function normalizeThreadTitle(title: string): string {
  const line = title.replace(/\s+/g, " ").trim() || "Spark thread";
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
}

function emptyTodoSummary(): TaskTodoSummary {
  return {
    total: 0,
    pending: 0,
    inProgress: 0,
    done: 0,
    blocked: 0,
    cancelled: 0,
    deleted: 0,
    noteCount: 0,
  };
}

function describeSparkFocus(value: string | undefined, language: SparkCopyLanguage): string {
  if (language === "zh") {
    switch (value) {
      case "audit":
        return "审计差距。";
      case "light_refactor":
        return "轻量重构。";
      case "docs_alignment":
        return "文档对齐。";
      case "execute_change":
        return "执行改动。";
      default:
        return "待确认。";
    }
  }
  switch (value) {
    case "audit":
      return "Audit gaps.";
    case "light_refactor":
      return "Light refactor.";
    case "docs_alignment":
      return "Docs alignment.";
    case "execute_change":
      return "Execute change.";
    default:
      return "To be confirmed.";
  }
}

function renderSparkMd(input: {
  idea: string;
  workingTitle?: string;
  clarification?: SparkInitClarificationData;
}): string {
  const language = input.clarification?.outputLanguage ?? detectCopyLanguage(input.idea);
  return language === "zh" ? renderSparkMdZh(input) : renderSparkMdEn(input);
}

function renderSparkMdEn(input: {
  idea: string;
  workingTitle?: string;
  clarification?: SparkInitClarificationData;
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const title =
    input.workingTitle ?? input.clarification?.workingTitle ?? shortSummaryEn(input.idea);
  const sections: string[] = [];

  sections.push(`---
description: ${escapeYamlLine(title)}
owner: zrr1999
created: ${date}
updated: ${date}
inspired_by: []
---`);
  sections.push("");
  sections.push("## Origin");
  sections.push("");
  sections.push(shortSummaryEn(input.idea));
  sections.push("");
  sections.push("## Working title");
  sections.push("");
  sections.push(`- ${title}`);

  if (input.clarification?.sparkFocus) {
    sections.push("");
    sections.push("## Spark focus");
    sections.push("");
    sections.push(`- ${describeSparkFocus(input.clarification.sparkFocus, "en")}`);
  }
  if (input.clarification?.deliveryMode) {
    sections.push("");
    sections.push("## Delivery mode");
    sections.push("");
    sections.push(`- ${describeDeliveryMode(input.clarification.deliveryMode, "en")}`);
  }
  if (input.clarification?.targetUser) {
    sections.push("");
    sections.push("## Target users");
    sections.push("");
    sections.push(`- ${input.clarification.targetUser}`);
  }
  if (input.clarification?.objective) {
    sections.push("");
    sections.push("## Objective");
    sections.push("");
    sections.push(`- ${input.clarification.objective}`);
  }
  if (input.clarification?.smallestSlice) {
    sections.push("");
    sections.push("## Smallest slice");
    sections.push("");
    sections.push(`- ${input.clarification.smallestSlice}`);
  }
  if (input.clarification?.successSignal) {
    sections.push("");
    sections.push("## Success signal");
    sections.push("");
    sections.push(`- ${input.clarification.successSignal}`);
  }
  if (input.clarification?.nonGoals) {
    sections.push("");
    sections.push("## Non-goals");
    sections.push("");
    sections.push(`- ${input.clarification.nonGoals}`);
  }

  sections.push("");
  sections.push("## Open questions");
  sections.push("");
  sections.push(
    "- Does the current interaction task reflect the latest confirmed intent?<!-- dynamically maintained -->",
  );
  sections.push(
    "- Is the next concrete action specific enough to execute?<!-- dynamically maintained -->",
  );
  sections.push("");
  sections.push("## Revision history");
  sections.push("");
  sections.push(`- ${date}: Generated by /spark.`);
  return `${sections.join("\n")}\n`;
}

function renderSparkMdZh(input: {
  idea: string;
  workingTitle?: string;
  clarification?: SparkInitClarificationData;
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const title =
    input.workingTitle ?? input.clarification?.workingTitle ?? shortSummaryZh(input.idea);
  const sections: string[] = [];

  sections.push(`---
description: ${escapeYamlLine(title)}
owner: zrr1999
created: ${date}
updated: ${date}
inspired_by: []
---`);
  sections.push("");
  sections.push("## 起源");
  sections.push("");
  sections.push(shortSummaryZh(input.idea));
  sections.push("");
  sections.push("## 当前工作标题");
  sections.push("");
  sections.push(`- ${title}`);

  if (input.clarification?.sparkFocus) {
    sections.push("");
    sections.push("## Spark 重点");
    sections.push("");
    sections.push(`- ${describeSparkFocus(input.clarification.sparkFocus, "zh")}`);
  }
  if (input.clarification?.deliveryMode) {
    sections.push("");
    sections.push("## 交付方式");
    sections.push("");
    sections.push(`- ${describeDeliveryMode(input.clarification.deliveryMode, "zh")}`);
  }
  if (input.clarification?.targetUser) {
    sections.push("");
    sections.push("## 目标用户");
    sections.push("");
    sections.push(`- ${input.clarification.targetUser}`);
  }
  if (input.clarification?.objective) {
    sections.push("");
    sections.push("## 目标");
    sections.push("");
    sections.push(`- ${input.clarification.objective}`);
  }
  if (input.clarification?.smallestSlice) {
    sections.push("");
    sections.push("## 最小切片");
    sections.push("");
    sections.push(`- ${input.clarification.smallestSlice}`);
  }
  if (input.clarification?.successSignal) {
    sections.push("");
    sections.push("## 成功信号");
    sections.push("");
    sections.push(`- ${input.clarification.successSignal}`);
  }
  if (input.clarification?.nonGoals) {
    sections.push("");
    sections.push("## 非目标");
    sections.push("");
    sections.push(`- ${input.clarification.nonGoals}`);
  }

  sections.push("");
  sections.push("## 开放问题");
  sections.push("");
  sections.push("- 当前交互 task 是否准确反映了最新确认的意图？<!-- 动态维护 -->");
  sections.push("- 下一个具体动作是否已经明确到可执行？<!-- 动态维护 -->");
  sections.push("");
  sections.push("## 修订记录");
  sections.push("");
  sections.push(`- ${date}：由 /spark 生成。`);
  return `${sections.join("\n")}\n`;
}

function shortSummaryEn(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? text.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function shortSummaryZh(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? text.trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function renderAgentPlan(input: {
  idea: string;
  tasks: Array<{
    title: string;
    description: string;
    kind?: string;
    agentRef?: string;
  }>;
}): string {
  const lines = ["# Initial Agent Plan", "", `Idea: ${input.idea}`, "", "## Tasks", ""];
  for (const task of input.tasks) {
    lines.push(`- **${task.title}**`);
    lines.push(`  - Kind: ${task.kind ?? "generic"}`);
    lines.push(`  - Agent: ${task.agentRef ?? "unbound"}`);
    lines.push(`  - Instruction: ${task.description}`);
  }
  return `${lines.join("\n")}\n`;
}

function describeDeliveryMode(value: string | undefined, language: SparkCopyLanguage): string {
  if (language === "zh") {
    switch (value) {
      case "clarify_only":
        return "只澄清意图，不继续扩展交付。";
      case "document":
        return "澄清并写入文档。";
      case "document_and_execute":
        return "澄清、写入文档并继续执行。";
      case "execute":
        return "直接进入执行。";
      default:
        return "待确认。";
    }
  }
  switch (value) {
    case "clarify_only":
      return "Clarification only.";
    case "document":
      return "Clarification and documentation.";
    case "document_and_execute":
      return "Clarification, documentation, and continued execution.";
    case "execute":
      return "Proceed directly to execution.";
    default:
      return "To be confirmed.";
  }
}

function ensureSparkGraphInvariants(graph: TaskGraph): boolean {
  let changed = false;
  for (const thread of graph.threads()) {
    const threadState = graph.getThread(thread.ref);
    const betterTitle = fallbackThreadTitle(graph, threadState);
    if (betterTitle && betterTitle !== threadState.title) {
      graph.updateThread(thread.ref, { title: betterTitle });
      changed = true;
    }
    if (!threadState.currentTaskRef) continue;
    try {
      const current = graph.getTask(threadState.currentTaskRef);
      if (current.threadRef === thread.ref) continue;
    } catch {
      // Clear stale current task refs, but never synthesize a placeholder task.
    }
    graph.setCurrentTask(thread.ref, undefined);
    changed = true;
  }
  return changed;
}

function fallbackThreadTitle(
  graph: TaskGraph,
  thread: { title: string; ref: ThreadRef },
): string | undefined {
  if (!isPlaceholderThreadTitle(thread.title)) return undefined;
  const firstConcrete = graph
    .tasks(thread.ref)
    .find(
      (task) =>
        isUnfinishedTaskStatus(task.status) &&
        !isGenericInitialTaskTitle(task.title) &&
        !isPlaceholderThreadTitle(task.title),
    );
  if (firstConcrete) return normalizeThreadTitle(firstConcrete.title);
  return undefined;
}

function isPlaceholderThreadTitle(title: string): boolean {
  const normalized = title.trim();
  return (
    normalized === "「自定义输入」" ||
    normalized === "[Enter custom title]" ||
    normalized === "Enter custom title" ||
    normalized === "自定义输入"
  );
}

function isGenericInitialTaskTitle(title: string): boolean {
  return (
    title === "Capture project intent" ||
    title === "Build initial task graph" ||
    title === "Review initial direction"
  );
}

async function readActiveSparkMd(cwd: string): Promise<string | undefined> {
  const sparkMdPath = await findUpExisting(cwd, "SPARK.md");
  if (sparkMdPath) return readFile(sparkMdPath, "utf8");
  const store = defaultArtifactStore(cwd);
  const [latest] = (await store.list({ kind: "spark-md" })).slice(-1);
  if (!latest) return undefined;
  return store.getBody(latest.ref);
}

function normalizeTaskKind(value: string | undefined): TaskKind | undefined {
  if (!value) return undefined;
  if (
    value === "research" ||
    value === "plan" ||
    value === "implement" ||
    value === "review" ||
    value === "ask" ||
    value === "cue" ||
    value === "interaction" ||
    value === "generic"
  )
    return value;
  return undefined;
}

function normalizeTaskStatus(value: string | undefined) {
  if (!value) return undefined;
  if (
    value === "proposed" ||
    value === "pending" ||
    value === "ready" ||
    value === "running" ||
    value === "blocked" ||
    value === "done" ||
    value === "failed" ||
    value === "cancelled"
  )
    return value;
  return undefined;
}

function escapeYamlLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(line.length > 160 ? `${line.slice(0, 157)}...` : line);
}
