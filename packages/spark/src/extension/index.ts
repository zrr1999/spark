import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { Type } from "typebox";
import { defaultArtifactStore } from "spark-artifacts";
import {
  detectCopyLanguage,
  replaySparkAskTool,
  runSparkAskTool,
  type SparkAskToolParams,
  type SparkCopyLanguage,
} from "spark-ask";
import {
  RoleRegistry,
  builtinRoleRef,
  createRoleSpec,
  defaultProjectRoleStore,
  type RoleSpecProposal,
} from "pi-roles";
import {
  newRef,
  nowIso,
  type RoleRef,
  type ArtifactRef,
  type AskRef,
  type JsonValue,
  stableId,
  type SparkRunTrace,
  type Task,
  type TaskPlan,
  type TaskRun,
  type TaskStatus,
  type TaskRef,
  type ThreadRef,
} from "spark-core";
import { registerPiCueTools } from "pi-cue";
import { createReviewGate } from "spark-review";
import {
  createRoleRunClaimId,
  findResumableBackgroundRoleRunTasks,
  DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
  defaultSparkDagRunStore,
  type SparkDagCompletionFollowUp,
  type SparkDagRunRecord,
  type SparkDagStatusSummary,
  killActiveSparkRoleRunProcesses,
  listActiveSparkRoleRunProcesses,
  runReadySparkTasks,
  runSparkTask,
  sweepExpiredTaskClaims,
} from "spark-runtime";
import {
  defaultTaskGraphStore,
  defaultTaskTodoStore,
  isUnfinishedTaskStatus,
  TaskGraph,
  type TaskGraphStore,
  type TaskPlanInput,
  type TaskPlanResult,
  type TaskTodoOp,
  type TaskTodoSummary,
} from "spark-tasks";
import {
  SparkWidget,
  type SessionTodoEntry,
  type SparkWidgetState,
  type TaskEntry,
} from "../ui/spark-widget.ts";
import {
  escapeYamlLine,
  normalizeTaskKind,
  normalizeTaskStatus,
  normalizeToolTaskPlan,
  taskPlanSchema,
} from "./task-plan-tool.ts";
import {
  renderSparkToolCall,
  truncateInline,
  type ToolCallComponent,
  type ToolCallRenderTheme,
} from "./tool-rendering.ts";

interface SparkExtensionAPI {
  registerCommand(
    name: string,
    config: {
      description: string;
      handler: (args: string, ctx: SparkCommandContext) => void | Promise<void>;
    },
  ): void;
  registerTool?(config: SparkRegisteredToolConfig): void;
  on?(event: string, handler: (event: unknown, ctx: SparkToolContext) => unknown): void;
  sendUserMessage?(
    content: string,
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

interface SparkRegisteredToolConfig {
  name: string;
  label?: string;
  description: string;
  promptGuidelines?: string[];
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolCallRenderTheme,
    context: unknown,
  ) => ToolCallComponent;
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
    custom?: (...args: unknown[]) => unknown;
  };
}

interface SparkCommandContext extends SparkToolContext {
  waitForIdle?: () => Promise<void>;
  sendUserMessage?: (content: string) => Promise<void>;
}

const CLAIM_SWEEP_INTERVAL_MS = 30_000;
const MAIN_TASK_CLAIM_LEASE_MS = 10 * 60 * 1_000;
const DAG_MANAGER_POLL_INTERVAL_MS = 1_000;
const DEFAULT_SPARK_STATUS_ACTIVE_LIMIT = 20;
const DEFAULT_SPARK_STATUS_TODO_LIMIT = 3;
const DEFAULT_SPARK_PLAN_TASK_OUTPUT_LIMIT = 5;
type SparkStatusView = "active" | "summary" | "full";
const dagManagerTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
  pi.on?.("before_role_start", async (event: unknown, ctx: SparkToolContext) =>
    injectSparkHints(event, ctx),
  );
  pi.on?.("turn_start", async (_event: unknown, ctx: SparkToolContext) => {
    if (!(await hasLocalSparkDirectory(ctx.cwd))) return;
    ensureClaimReaper(ctx.cwd);
    await sweepExpiredSparkClaims(ctx.cwd, ctx);
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
    await refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("session_start", async (_event: unknown, ctx: SparkToolContext) => {
    if (!(await hasLocalSparkDirectory(ctx.cwd))) return;
    ensureClaimReaper(ctx.cwd);
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx, { skipSweep: true });
    await resumeOwnedBackgroundSubroles(ctx.cwd, ctx);
    await sweepExpiredSparkClaims(ctx.cwd, ctx);
    await refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("session_compact", async (_event: unknown, ctx: SparkToolContext) => {
    await refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("session_shutdown", async (event: unknown, ctx: SparkToolContext) => {
    await cleanupOwnedBackgroundSubroles(ctx.cwd, ctx, shutdownReason(event));
  });
  pi.on?.("session_tree", async (_event: unknown, ctx: SparkToolContext) => {
    await refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("tool_execution_end", async (event: unknown, ctx: SparkToolContext) => {
    if (
      isToolExecutionEvent(event, "spark_update_todos") ||
      isToolExecutionEvent(event, "spark_update_task_todos") ||
      isToolExecutionEvent(event, "spark_claim_task") ||
      isToolExecutionEvent(event, "spark_rename_thread") ||
      isToolExecutionEvent(event, "spark_use_thread")
    ) {
      await refreshSparkWidget(ctx.cwd, ctx);
    }
  });
  pi.on?.("session_switch", async (_event: unknown, ctx: SparkToolContext) => {
    // Restore widget after session switch (/new, /resume)
    if (!(await hasLocalSparkDirectory(ctx.cwd))) return;
    ensureClaimReaper(ctx.cwd);
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx, { skipSweep: true });
    await resumeOwnedBackgroundSubroles(ctx.cwd, ctx);
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
    const thread = await currentSparkThread(cwd, ctx, graph, { activate: true });
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
    const activeRunRefs = new Set(
      listActiveSparkRoleRunProcesses()
        .filter((process) => process.cwd === cwd)
        .map((process) => process.runRef),
    );
    widgetState = {
      threadTitle: isPlaceholderThreadTitle(thread.title) ? undefined : thread.title,
      tasks: allTasks.map((task) => ({
        title: task.title,
        status: mapTaskStatus(task.status),
        claim: mapTaskClaim(task, sessionKey),
        agentLabel: deriveTaskRoleLabel({
          task,
          currentSessionKey: sessionKey,
          latestRun: lastRunsByTaskRef.get(task.ref),
        }),
        backgroundOwner:
          task.claim?.kind === "role-run" &&
          task.claim.sessionId === ownerSessionKey &&
          task.claim.runRef &&
          activeRunRefs.has(task.claim.runRef)
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

  async function cleanupOwnedBackgroundSubroles(
    cwd: string,
    ctx: SparkToolContext,
    reason: string,
  ): Promise<number> {
    const store = defaultTaskGraphStore(cwd);
    const graph = await loadSparkGraph(cwd, ctx);
    const ownerSessionId = sparkSessionOwnerKey(ctx);
    const owned = graph ? findResumableBackgroundRoleRunTasks(graph, ownerSessionId) : [];
    const ownedRunRefs = owned.flatMap((task) => (task.claim?.runRef ? [task.claim.runRef] : []));
    const ownedRoleNames = owned.flatMap((task) =>
      task.claim?.runName ? [task.claim.runName] : [],
    );
    const killed = await killActiveSparkRoleRunProcesses({
      reason: `spark session shutdown: ${reason}`,
      runRefs: ownedRunRefs.length > 0 ? ownedRunRefs : undefined,
      runNames: ownedRunRefs.length > 0 ? undefined : ownedRoleNames,
    });
    if (!graph) return killed.length;
    const killedRunRefs = new Set(killed.map((run) => run.runRef));
    const killedRoleNames = new Set(killed.flatMap((run) => (run.runName ? [run.runName] : [])));
    let changed = false;
    for (const task of owned) {
      const runRef = task.claim?.runRef;
      if (killedRunRefs.size > 0 && (!runRef || !killedRunRefs.has(runRef))) continue;
      if (
        killedRunRefs.size === 0 &&
        killedRoleNames.size > 0 &&
        !killedRoleNames.has(task.claim?.runName ?? "")
      )
        continue;
      if (runRef) {
        const run = graph.runs(task.threadRef).find((candidate) => candidate.ref === runRef);
        if (run?.status === "running" || run?.status === "queued") {
          graph.recordRun({
            ...run,
            status: "cancelled",
            failureKind: "runtime_error",
            errorMessage: `background role run killed on Spark session shutdown (${reason})`,
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

  async function resumeOwnedBackgroundSubroles(
    cwd: string,
    ctx: SparkToolContext,
    options: { runTask?: typeof runSparkTask } = {},
  ): Promise<number> {
    const store = defaultTaskGraphStore(cwd);
    const graph = await loadSparkGraph(cwd, ctx);
    if (!graph) return 0;
    const ownerSessionId = sparkSessionOwnerKey(ctx);
    const resumable = findResumableBackgroundRoleRunTasks(graph, ownerSessionId);
    if (resumable.length === 0) return 0;
    const registry = new RoleRegistry();
    await defaultProjectRoleStore(cwd).hydrate(registry);
    const artifactStore = defaultArtifactStore(cwd);
    let resumed = 0;
    for (const task of resumable) {
      const runName = task.claim?.runName;
      const claimedBy = runName ? createRoleRunClaimId(ownerSessionId, runName) : undefined;
      if (!runName || !claimedBy) continue;
      try {
        graph.releaseTaskClaim(task.ref, task.claim?.claimedBy);
        await (options.runTask ?? runSparkTask)({
          graph,
          taskRef: task.ref,
          registry,
          artifactStore,
          cwd,
          dryRun: false,
          claim: {
            sessionId: ownerSessionId,
            runName,
            claimedBy,
          },
        });
        await mergeTaskProgressIntoStore(store, graph, [task.ref]);
        await sparkTodoStore(cwd, ctx).save(graph);
        resumed += 1;
      } catch (error) {
        graph.recordRun({
          ref: newRef("run"),
          threadRef: task.threadRef,
          taskRef: task.ref,
          roleRef: task.roleRef,
          runName,
          ownerSessionId,
          status: "failed",
          failureKind: "runtime_error",
          errorMessage: error instanceof Error ? error.message : String(error),
          startedAt: nowIso(),
          finishedAt: nowIso(),
          outputArtifacts: [],
        });
        graph.setTaskStatus(task.ref, "failed");
        await mergeTaskProgressIntoStore(store, graph, [task.ref]);
        await sparkTodoStore(cwd, ctx).save(graph);
      }
    }
    return resumed;
  }

  async function mergeTaskProgressIntoStore(
    store: TaskGraphStore,
    source: TaskGraph,
    taskRefs: TaskRef[],
  ): Promise<void> {
    await store.update(
      (current) => {
        current.mergeTaskProgressFrom(source, taskRefs);
      },
      { createIfMissing: false },
    );
  }

  function ensureSparkDagManager(cwd: string, ctx: SparkToolContext): void {
    if (dagManagerTimers.has(cwd)) return;
    const tick = async () => {
      dagManagerTimers.delete(cwd);
      if (!(await hasLocalSparkDirectory(cwd))) return;
      const scheduled = await runSparkDagManagerOnce(cwd, ctx);
      if (scheduled > 0) {
        const timer = setTimeout(() => void tick(), DAG_MANAGER_POLL_INTERVAL_MS);
        timer.unref?.();
        dagManagerTimers.set(cwd, timer);
      }
    };
    const timer = setTimeout(() => void tick(), 0);
    timer.unref?.();
    dagManagerTimers.set(cwd, timer);
  }

  async function runSparkDagManagerOnce(cwd: string, ctx: SparkToolContext): Promise<number> {
    const store = defaultTaskGraphStore(cwd);
    const graph = await loadSparkGraph(cwd, ctx);
    if (!graph) return 0;
    const registry = new RoleRegistry();
    await defaultProjectRoleStore(cwd).hydrate(registry);
    const artifactStore = defaultArtifactStore(cwd);
    const touched = new Set<TaskRef>();
    const dagRunStore = defaultSparkDagRunStore(cwd);
    await dagRunStore.reconcile({
      graph,
      activeRunRefs: listActiveSparkRoleRunProcesses().map((process) => process.runRef),
    });
    const ownerSessionId = sparkSessionOwnerKey(ctx);
    const dagRun = await dagRunStore.startRun({
      dryRun: false,
      maxConcurrency: DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
      timeoutMs: DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
      ownerSessionId,
    });
    let result;
    try {
      result = await runReadySparkTasks({
        graph,
        registry,
        artifactStore,
        cwd,
        dryRun: false,
        maxConcurrency: DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
        timeoutMs: DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
        claim: { sessionId: ownerSessionId },
        onSchedule: async (progress) => {
          touched.add(progress.taskRef);
          await dagRunStore.recordSchedule(dagRun.ref, progress);
          await mergeTaskProgressIntoStore(store, graph, [progress.taskRef]);
          await sparkTodoStore(cwd, ctx).save(graph);
          await refreshSparkWidget(cwd, ctx);
        },
        onProgress: async (progress) => {
          touched.add(progress.taskRef);
          await dagRunStore.recordProgress(dagRun.ref, progress);
          await mergeTaskProgressIntoStore(store, graph, [progress.taskRef]);
          await sparkTodoStore(cwd, ctx).save(graph);
          await refreshSparkWidget(cwd, ctx);
        },
      });
      const followUp = await dagRunStore.finishRun(dagRun.ref, result);
      emitSparkDagCompletionFollowUp(ctx, followUp);
    } catch (error) {
      const followUp = await dagRunStore.finishRun(
        dagRun.ref,
        { scheduled: touched.size, completed: 0, timedOut: false },
        error,
      );
      emitSparkDagCompletionFollowUp(ctx, followUp);
      throw error;
    }
    if (touched.size > 0) {
      await mergeTaskProgressIntoStore(store, graph, [...touched]);
      await sparkTodoStore(cwd, ctx).save(graph);
      await refreshSparkWidget(cwd, ctx);
    }
    return result.scheduled;
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
    if (task.claim?.kind === "role-run") return "role-run";
    const claimedBy = taskClaimedBy(task);
    if (!claimedBy) return undefined;
    return isClaimOwnedBySession(task, sessionKey) ? "mine" : "other";
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
    const runName = task.claim?.runName?.trim();
    const spec = task.claim?.roleRef ? shortRoleLabel(task.claim.roleRef) : undefined;
    if (runName) return spec ? `${runName}(spec:${spec})` : runName;
    return claimedBy;
  }

  function shortRoleLabel(roleRef: string): string {
    return roleRef.replace(/^role:(builtin-|project-|user-)?/, "");
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

  function taskStatusVisibilityRank(status: TaskStatus): number {
    switch (status) {
      case "running":
        return 0;
      case "blocked":
        return 1;
      case "ready":
      case "pending":
      case "proposed":
        return 2;
      case "failed":
        return 3;
      case "done":
        return 4;
      case "cancelled":
        return 5;
    }
  }

  function sortTasksForStatusVisibility(tasks: Task[]): Task[] {
    return [...tasks].sort((a, b) => {
      const byStatus = taskStatusVisibilityRank(a.status) - taskStatusVisibilityRank(b.status);
      if (byStatus !== 0) return byStatus;
      return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    });
  }

  function normalizeSparkStatusView(params: Record<string, unknown>): SparkStatusView {
    if (params.view === "summary" || params.view === "full") return params.view;
    return "active";
  }

  function normalizeSparkStatusLimit(params: Record<string, unknown>): number | undefined {
    if (typeof params.limit !== "number" || !Number.isFinite(params.limit)) return undefined;
    const limit = Math.floor(params.limit);
    return limit >= 0 ? limit : undefined;
  }

  function normalizeRoleSpecSourceFilter(
    value: unknown,
  ): "builtin" | "project" | "user" | undefined {
    if (value === "builtin" || value === "predefined") return "builtin";
    if (value === "project" || value === "managed") return "project";
    if (value === "user") return "user";
    return undefined;
  }

  function normalizeSparkDagManagerAction(
    value: unknown,
  ): "status" | "reconcile" | "clear_inactive" | "kill_active" {
    if (
      value === "reconcile" ||
      value === "clear_inactive" ||
      value === "kill_active" ||
      value === "status"
    )
      return value;
    return "status";
  }

  function emitSparkDagCompletionFollowUp(
    ctx: SparkToolContext,
    followUp: SparkDagCompletionFollowUp | undefined,
  ): void {
    if (!followUp) return;
    const message = [followUp.summary, ...followUp.nextActions.map((action) => `- ${action}`)].join(
      "\n",
    );
    pi.sendUserMessage?.(message, { deliverAs: "followUp" });
    ctx.ui?.notify?.(followUp.summary, "info");
  }

  function appendCompactSparkDagStatusLines(
    lines: string[],
    dagStatus: SparkDagStatusSummary,
  ): void {
    const activeSuffix = dagStatus.manager.activeRunRef
      ? ` active=${dagStatus.manager.activeRunRef}`
      : "";
    const lastSuffix = dagStatus.lastRun
      ? ` last=${dagStatus.lastRun.status} completed=${dagStatus.lastRun.completed}/${dagStatus.lastRun.scheduled}`
      : " last=none";
    lines.push(
      `DAG manager: ${dagStatus.manager.status}${activeSuffix}${lastSuffix} | running=${dagStatus.running} failed=${dagStatus.failed} timed_out=${dagStatus.timedOut}`,
    );
  }

  function appendSparkDagStatusLines(lines: string[], dagStatus: SparkDagStatusSummary): void {
    const managerSuffix = dagStatus.manager.activeRunRef
      ? ` active=${dagStatus.manager.activeRunRef}`
      : "";
    lines.push(
      `DAG manager: ${dagStatus.manager.status}${managerSuffix} runs=${dagStatus.recentRuns.length} recent | running=${dagStatus.running} succeeded=${dagStatus.succeeded} failed=${dagStatus.failed} timed_out=${dagStatus.timedOut}`,
    );
    if (dagStatus.lastRun) lines.push(`  Last DAG run: ${formatSparkDagRun(dagStatus.lastRun)}`);
    if (dagStatus.activeRun && dagStatus.activeRun.ref !== dagStatus.lastRun?.ref)
      lines.push(`  Active DAG run: ${formatSparkDagRun(dagStatus.activeRun)}`);
  }

  function formatSparkDagRun(run: SparkDagRunRecord): string {
    const finishedSuffix = run.finishedAt ? ` finished=${run.finishedAt}` : "";
    const timeoutSuffix = run.timedOut ? " timed_out=true" : "";
    return `${run.ref} [${run.status}] scheduled=${run.scheduled} completed=${run.completed} maxConcurrency=${run.maxConcurrency} timeoutMs=${run.timeoutMs} updated=${run.updatedAt}${finishedSuffix}${timeoutSuffix}`;
  }

  function shouldRenderThreadInSparkStatus(input: {
    view: SparkStatusView;
    threadRef: ThreadRef;
    activeThreadRef?: ThreadRef;
    sessionClaimedCount: number;
  }): boolean {
    if (input.view === "full" || input.view === "summary") return true;
    if (input.threadRef === input.activeThreadRef) return true;
    return input.sessionClaimedCount > 0;
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

  function compactThreadStatusSummaries(graph: TaskGraph, sessionKey: string) {
    return graph.threads().map((thread) => {
      const tasks = graph.tasks(thread.ref);
      const claimed = tasks.filter((task) => taskClaimedBy(task));
      const sessionClaimed = claimed.filter((task) => isClaimOwnedBySession(task, sessionKey));
      return {
        ref: thread.ref,
        title: thread.title,
        status: thread.status,
        tasks: tasks.length,
        unfinished: tasks.filter((task) => isUnfinishedTaskStatus(task.status)).length,
        claimed: claimed.length,
        claimedBySession: sessionClaimed.length,
        statusCounts: countTaskStatuses(tasks),
      };
    });
  }

  function compactTaskPlanResult(result: TaskPlanResult) {
    const summarizeTask = (task: Task) => ({
      ref: task.ref,
      name: task.name,
      title: task.title,
      status: task.status,
    });
    return {
      created: result.created.map(summarizeTask),
      updated: result.updated.map(summarizeTask),
      skipped: result.skipped.length,
      dependencies: result.dependencies.length,
    };
  }

  const registerSparkTool = (config: SparkRegisteredToolConfig): void => {
    pi.registerTool?.({
      renderCall: (args, theme, context) => renderSparkToolCall(config.name, args, theme, context),
      ...config,
    });
  };

  pi.registerCommand("spark", {
    description:
      "Turn an idea into SPARK.md, a thread/task DAG, role plan, artifacts, and review gates.",
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
        const existingThread = await currentSparkThread(ctx.cwd, ctx, existing, { activate: true });
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

      // Hand DAG execution to the background manager instead of driving it from this turn.
      ensureSparkDagManager(ctx.cwd, ctx);
    },
  });

  registerSparkTool({
    name: "spark_status",
    label: "Spark Status",
    description:
      "Show Spark thread/task status. Defaults to an active view focused on unfinished work and current session state; use view=full for all history.",
    parameters: Type.Object({
      view: Type.Optional(
        Type.String({
          default: "active",
          description:
            "active | summary | full. active shows unfinished work for the current thread/session, summary shows thread counts only, full includes done/cancelled history.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description:
            "Maximum number of task rows per thread. Defaults to 20 in active view; omitted in summary/full unless provided.",
        }),
      ),
      showFinished: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Deprecated alias for view=full when true.",
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
      const view = (params as { showFinished?: boolean }).showFinished
        ? "full"
        : normalizeSparkStatusView(params);
      const explicitLimit = normalizeSparkStatusLimit(params);
      const taskLimit =
        view === "summary"
          ? undefined
          : (explicitLimit ?? (view === "active" ? DEFAULT_SPARK_STATUS_ACTIVE_LIMIT : undefined));
      const dagRunStore = defaultSparkDagRunStore(cwd);
      await dagRunStore.reconcile({
        graph,
        activeRunRefs: listActiveSparkRoleRunProcesses().map((process) => process.runRef),
      });
      const dagStatus = await dagRunStore.status();
      const lines = [
        `Spark tasks (${view} view${typeof taskLimit === "number" ? `, limit=${taskLimit}` : ""}):`,
      ];
      if (view === "active") {
        appendCompactSparkDagStatusLines(lines, dagStatus);
        if (dagStatus.lastRun)
          lines.push(`  Last DAG run: ${formatSparkDagRun(dagStatus.lastRun)}`);
      } else appendSparkDagStatusLines(lines, dagStatus);
      const sessionKey = sparkSessionKey(ctx);
      const independentTodos = await loadIndependentTodos(cwd, ctx);
      const activeThread = await currentSparkThread(cwd, ctx, graph, { activate: true });
      let renderedThreads = 0;
      for (const thread of graph.threads()) {
        const tasks = graph.tasks(thread.ref);
        const claimed = tasks.filter((task) => taskClaimedBy(task));
        const sessionClaimed = claimed.filter((task) => isClaimOwnedBySession(task, sessionKey));
        const statusCounts = countTaskStatuses(tasks);
        const allVisibleTasks = sortTasksForStatusVisibility(
          tasks.filter((task) => view === "full" || isImportantStatus(task.status)),
        );
        if (
          !shouldRenderThreadInSparkStatus({
            view,
            threadRef: thread.ref,
            activeThreadRef: activeThread?.ref,
            sessionClaimedCount: sessionClaimed.length,
          })
        )
          continue;
        renderedThreads += 1;
        const visibleTasks =
          typeof taskLimit === "number" ? allVisibleTasks.slice(0, taskLimit) : allVisibleTasks;
        const lastRunsByTaskRef = latestRunsByTaskRef(graph.runs(thread.ref));
        const hiddenByView = tasks.length - allVisibleTasks.length;
        const hiddenByLimit = allVisibleTasks.length - visibleTasks.length;
        const currentSuffix = thread.ref === activeThread?.ref ? " [current]" : "";
        const statusSuffix = thread.status === "done" ? " [done]" : "";
        const threadPrefix = view === "active" ? "Thread" : `Thread ${thread.ref}:`;
        lines.push(`\n${threadPrefix} ${thread.title}${currentSuffix}${statusSuffix}`);
        if (view !== "active") lines.push(`  Thread status: ${thread.status}`);
        lines.push(
          `  Tasks: ${tasks.length} total | ${claimed.length} claimed | ${sessionClaimed.length} claimed_by_session | ${formatTaskStatusCounts(statusCounts)}`,
        );
        if (hiddenByView > 0)
          lines.push(`  Hidden finished tasks: ${hiddenByView} (use view=full to include)`);
        if (hiddenByLimit > 0)
          lines.push(
            `  Hidden by limit: ${hiddenByLimit} (increase limit or use view=full without limit)`,
          );
        if (view === "summary") continue;
        lines.push(view === "full" ? "  Durable tasks:" : "  Active tasks:");
        for (const task of visibleTasks) {
          const owner = deriveTaskRoleLabel({
            task,
            currentSessionKey: sessionKey,
            latestRun: lastRunsByTaskRef.get(task.ref),
          });
          if (view === "active") {
            lines.push(`  - [${task.status}] @${task.name}: ${task.title} owner=@${owner}`);
            if (isClaimOwnedBySession(task, sessionKey)) {
              const taskTodos = graph.taskTodos(task.ref);
              for (const todo of taskTodos.slice(0, DEFAULT_SPARK_STATUS_TODO_LIMIT)) {
                lines.push(
                  `    - [${todo.status}] ${todo.id} ${truncateInline(todo.content, 160)}`,
                );
              }
              const hiddenTodos = taskTodos.length - DEFAULT_SPARK_STATUS_TODO_LIMIT;
              if (hiddenTodos > 0) lines.push(`    - … ${hiddenTodos} more TODOs`);
            }
            continue;
          }
          const taskSummary = graph.todoSummary(task.ref);
          lines.push(
            `  - [${task.status}] @${task.name}: ${task.title} (${task.ref}) kind=${task.kind} owner=@${owner} claimed=${taskClaimSummary(task)} todos=${taskSummary.total}/${taskSummary.inProgress}/${taskSummary.pending}/${taskSummary.done}`,
          );
          if (isClaimOwnedBySession(task, sessionKey)) {
            for (const todo of graph.taskTodos(task.ref)) {
              lines.push(`    - [${todo.status}] ${todo.id} ${todo.content}`);
            }
          }
        }
        if (visibleTasks.length === 0) lines.push("  - none");
      }
      if (renderedThreads === 0) lines.push("\nNo Spark threads matched this view.");
      const displayedIndependentTodos = independentTodos;
      const visibleIndependentTodos =
        view === "active"
          ? displayedIndependentTodos.slice(0, DEFAULT_SPARK_STATUS_TODO_LIMIT)
          : displayedIndependentTodos;
      const independentSuffix = view === "active" ? " active" : "";
      lines.push(
        `\nIndependent session TODOs: ${displayedIndependentTodos.length}${independentSuffix}`,
      );
      for (const todo of visibleIndependentTodos)
        lines.push(`  - [${todo.status}] ${todo.id ?? ""} ${truncateInline(todo.content, 160)}`);
      const hiddenIndependentTodos =
        displayedIndependentTodos.length - visibleIndependentTodos.length;
      if (hiddenIndependentTodos > 0)
        lines.push(`  - … ${hiddenIndependentTodos} more independent TODOs`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          found: true,
          view,
          limit: taskLimit,
          activeThreadRef: activeThread?.ref,
          threads: compactThreadStatusSummaries(graph, sessionKey),
          dag: dagStatus,
        },
      };
    },
  });

  registerSparkTool({
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

  registerSparkTool({
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
          const thread = await currentSparkThread(cwd, ctx, graph, { activate: true });
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

  registerSparkTool({
    name: "spark_claim_task",
    label: "Spark Claim Task",
    description:
      "Create or update a concrete Spark task for this session. For Spark-native delegated work, bind the task to a builtin, project, or user role spec with roleRef and run it via spark_run_ready_tasks; do not spawn nested pi CLI sessions as pseudo-roles unless explicitly testing Pi CLI behavior.",
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
          description: "proposed | pending | ready | running | blocked",
        }),
      ),
      roleRef: Type.Optional(
        Type.String({
          description:
            "Optional builtin/project/user Spark role spec id or ref from spark_list_roles, e.g. planner or role:builtin-planner. Role-bound tasks default to pending and are eligible for spark_run_ready_tasks.",
        }),
      ),
      plan: Type.Optional(taskPlanSchema()),
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
        roleRef?: string;
        plan?: Partial<TaskPlan>;
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
      let roleRef: RoleRef | undefined;
      if (p.roleRef?.trim()) {
        const registry = new RoleRegistry();
        await defaultProjectRoleStore(cwd).hydrate(registry);
        roleRef = registry.select(p.roleRef.trim()).ref;
      }
      const kind = normalizeTaskKind(p.kind) ?? "interaction";
      const requestedStatus = normalizeTaskStatus(p.status);
      if (requestedStatus && !isUnfinishedTaskStatus(requestedStatus))
        return {
          content: [
            {
              type: "text",
              text: `Cannot claim ${title}: spark_claim_task only accepts unfinished statuses (proposed, pending, ready, running, blocked). Use task completion/failure/cancellation flows instead of claiming with terminal status ${requestedStatus}.`,
            },
          ],
          details: { found: true, error: "terminal_status_not_allowed", status: requestedStatus },
        };
      const status = requestedStatus ?? (roleRef ? "pending" : "running");
      const sessionKey = sparkSessionKey(ctx);
      const store = defaultTaskGraphStore(cwd);
      const claimed = await store.update(
        async (graph) => {
          await sparkTodoStore(cwd, ctx).hydrate(graph);
          const thread = await currentSparkThread(cwd, ctx, graph, { activate: true });
          if (!thread) return { error: "no_thread" as const };
          const tasks = graph.tasks(thread.ref);
          const existing =
            resolveSessionClaimedTask(graph, thread.ref, sessionKey, name ?? title) ??
            tasks.find((task) => Boolean(name) && task.name === name) ??
            tasks.find((task) => task.title === title) ??
            resolveObviousTaskRenameCandidate(graph, thread.ref, tasks);
          if (existing && taskClaimedBy(existing) && !isClaimOwnedBySession(existing, sessionKey))
            return { error: "claimed_by_other" as const, activeTask: existing };
          const activeClaim = findActiveSessionClaim(graph, thread.ref, sessionKey, existing?.ref);
          if (isUnfinishedTaskStatus(status) && activeClaim)
            return { error: "active_claim_exists" as const, activeTask: activeClaim };
          const requestedName = taskNamePatchForClaim(existing, name, title);
          const namePatch = requestedName
            ? uniqueTaskNameForExistingTask(tasks, requestedName, existing?.ref)
            : undefined;
          const task = existing
            ? graph.updateTask(existing.ref, {
                ...(namePatch ? { name: namePatch } : {}),
                title,
                description,
                kind,
                status,
                roleRef,
                claimedBySession: sessionKey,
                plan: normalizeToolTaskPlan(p.plan, description, title),
              })
            : graph.createTask({
                threadRef: thread.ref,
                name,
                title,
                description,
                kind,
                status,
                roleRef,
                claimedBySession: sessionKey,
                plan: normalizeToolTaskPlan(p.plan, description, title),
              });
          if (isUnfinishedTaskStatus(status)) {
            graph.claimTask(task.ref, {
              kind: "main",
              claimedBy: sessionKey,
              sessionId: sessionKey,
              roleRef,
              leaseMs: MAIN_TASK_CLAIM_LEASE_MS,
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
      if (
        claimed.result.error === "active_claim_exists" ||
        claimed.result.error === "claimed_by_other"
      )
        return {
          content: [
            {
              type: "text",
              text:
                claimed.result.error === "active_claim_exists"
                  ? `Cannot claim ${title}: this session already has unfinished claimed task ${claimed.result.activeTask.title} (${claimed.result.activeTask.ref}). Finish, fail, or cancel it before claiming another task.`
                  : `Cannot update ${title}: matching task is currently claimed by another session (${taskClaimSummary(claimed.result.activeTask)}).`,
            },
          ],
          details: {
            found: true,
            error: claimed.result.error,
            activeTask: claimed.result.activeTask as unknown as Record<string, unknown>,
          },
        };
      await refreshSparkWidget(cwd, ctx);
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

  registerSparkTool({
    name: "spark_rename_thread",
    label: "Spark Rename Thread",
    description:
      "Rename or update metadata for an existing Spark thread without changing task refs. Defaults to this session's current thread.",
    parameters: Type.Object({
      thread: Type.Optional(
        Type.String({
          description: "Existing thread ref or title/title prefix. Defaults to current thread.",
        }),
      ),
      title: Type.Optional(Type.String({ description: "New thread title." })),
      description: Type.Optional(Type.String({ description: "New thread description." })),
      status: Type.Optional(Type.String({ description: "active | done" })),
      outputLanguage: Type.Optional(Type.String({ description: "zh | en" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const p = params as {
        thread?: string;
        title?: string;
        description?: string;
        status?: string;
        outputLanguage?: string;
      };
      const title = p.title?.trim();
      const description = p.description?.trim();
      const status = p.status === "active" || p.status === "done" ? p.status : undefined;
      const outputLanguage =
        p.outputLanguage === "zh" || p.outputLanguage === "en" ? p.outputLanguage : undefined;
      if (!title && !description && !status && !outputLanguage)
        return {
          content: [
            {
              type: "text",
              text: "Provide title, description, status, or outputLanguage to update the Spark thread.",
            },
          ],
          details: { found: true, error: "missing_thread_patch" },
        };

      const store = defaultTaskGraphStore(cwd);
      const updated = await store.update(
        async (graph) => {
          const thread = p.thread?.trim()
            ? resolveSparkThread(graph, p.thread)
            : await currentSparkThread(cwd, ctx, graph, { activate: true });
          if (!thread) return { error: "no_thread" as const };
          const renamed = graph.updateThread(thread.ref, {
            title,
            description,
            status,
            outputLanguage,
          });
          return { thread: renamed };
        },
        { createIfMissing: false },
      );
      if (!updated.graph || updated.result.error === "no_thread")
        return {
          content: [{ type: "text", text: "No matching Spark thread found." }],
          details: { found: false, error: "no_thread" },
        };
      if (updated.result.thread.status === "done") await clearCurrentThreadRef(cwd, ctx);
      else await saveCurrentThreadRef(cwd, ctx, updated.result.thread.ref);
      await refreshSparkWidget(cwd, ctx);
      return {
        content: [
          {
            type: "text",
            text: `Renamed Spark thread: ${updated.result.thread.title} (${updated.result.thread.ref})`,
          },
        ],
        details: { thread: updated.result.thread as unknown as Record<string, unknown> },
      };
    },
  });

  registerSparkTool({
    name: "spark_use_thread",
    label: "Spark Use Thread",
    description:
      "Set or create this Pi session's current Spark thread. Other sessions keep their own current thread selection. Use spark_rename_thread to rename an existing thread.",
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

  registerSparkTool({
    name: "spark_plan_tasks",
    label: "Spark Plan Tasks",
    description:
      "Create or update multiple durable Spark tasks in the active thread from a concrete task plan. Use this dedicated spark-tasks-backed planning tool when asked to梳理/organize work before assigning roles; it does not claim tasks for the current session.",
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
          roleRef: Type.Optional(
            Type.String({
              description:
                "Optional builtin/project/user Spark role spec id or ref, e.g. scout, planner, reviewer, worker.",
            }),
          ),
          plan: Type.Optional(taskPlanSchema()),
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
      const thread = await currentSparkThread(cwd, ctx, graph, { activate: true });
      if (!thread)
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false },
        };
      const registry = new RoleRegistry();
      await defaultProjectRoleStore(cwd).hydrate(registry);
      const p = params as {
        tasks?: Array<{
          name?: string;
          title: string;
          description: string;
          kind?: string;
          status?: string;
          roleRef?: string;
          plan?: Partial<TaskPlan>;
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
        status: normalizeTaskStatus(task.status) ?? (task.roleRef ? "pending" : "proposed"),
        roleRef: task.roleRef?.trim() ? registry.select(task.roleRef.trim()).ref : undefined,
        plan: normalizeToolTaskPlan(task.plan, task.description, task.title),
        dependsOn: task.dependsOn,
        rationale: task.rationale,
      }));
      const result = graph.planTasks(thread.ref, tasks);
      await store.save(graph);
      await sparkTodoStore(cwd, ctx).save(graph);
      await refreshSparkWidget(cwd, ctx);
      const changed = [
        ...result.created.map((task) => ({ action: "created" as const, task })),
        ...result.updated.map((task) => ({ action: "updated" as const, task })),
      ];
      const visibleChanged = changed.slice(0, DEFAULT_SPARK_PLAN_TASK_OUTPUT_LIMIT);
      const hiddenChanged = changed.length - visibleChanged.length;
      const lines = [
        `Planned tasks: created=${result.created.length} updated=${result.updated.length} dependencies=${result.dependencies.length}`,
        ...visibleChanged.map(
          ({ action, task }) => `- ${action} [${task.status}] @${task.name}: ${task.title}`,
        ),
      ];
      if (hiddenChanged > 0) lines.push(`- … ${hiddenChanged} more changed task(s)`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { result: compactTaskPlanResult(result) },
      };
    },
  });

  registerSparkTool({
    name: "spark_run_ready_tasks",
    label: "Spark Run Ready Tasks",
    description:
      "Run all currently ready Spark tasks with their bound builtin/project/user Spark role specs and persist task-run artifacts. Dry-run by default. Use this for Spark-native role/task workflow instead of spawning nested pi CLI sessions.",
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ default: true })),
      maxConcurrency: Type.Optional(
        Type.Number({
          default: DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
          description: "Maximum number of role runs running at once. Default: 4.",
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
      const dryRun = params.dryRun !== false;
      if (!dryRun) {
        ensureSparkDagManager(cwd, ctx);
        return {
          content: [
            {
              type: "text",
              text: "Started Spark DAG manager. Ready tasks will be scheduled and persisted in the background.",
            },
          ],
          details: { manager: "started", dryRun: false },
        };
      }

      const registry = new RoleRegistry();
      await defaultProjectRoleStore(cwd).hydrate(registry);
      const artifactStore = defaultArtifactStore(cwd);
      const result = await runReadySparkTasks({
        graph,
        registry,
        artifactStore,
        cwd,
        dryRun: true,
        maxConcurrency:
          typeof params.maxConcurrency === "number"
            ? params.maxConcurrency
            : DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
        timeoutMs:
          typeof params.timeoutMs === "number"
            ? params.timeoutMs
            : DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
      });
      const runLabels = result.runs.map((run) => run.runName ?? run.roleRef ?? run.ref);
      const timeoutSuffix = result.timedOut ? " Timed out before the DAG finished." : "";
      return {
        content: [
          {
            type: "text",
            text: runLabels.length
              ? `Dry-run checked ${result.runs.length} Spark task run(s) with maxConcurrency=${result.maxConcurrency}: ${runLabels.join(", ")}.${timeoutSuffix}`
              : `Dry-run found 0 ready Spark task(s) with maxConcurrency=${result.maxConcurrency}.${timeoutSuffix}`,
          },
        ],
        details: { result: result as unknown as Record<string, unknown> },
      };
    },
  });

  registerSparkTool({
    name: "spark_dag_manager",
    label: "Spark DAG Manager",
    description:
      "Inspect and control the persisted Spark DAG manager: status, reconcile stale state, clear inactive run records, or kill active background role runs.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description: "status | reconcile | clear_inactive | kill_active",
        }),
      ),
      runRef: Type.Optional(
        Type.String({ description: "Optional child run ref filter for kill_active." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const graph = await loadSparkGraph(cwd, ctx);
      const dagRunStore = defaultSparkDagRunStore(cwd);
      const action = normalizeSparkDagManagerAction(params.action);
      let killed: Awaited<ReturnType<typeof killActiveSparkRoleRunProcesses>> = [];
      if (action === "kill_active") {
        killed = await killActiveSparkRoleRunProcesses({
          runRef: typeof params.runRef === "string" ? (params.runRef as never) : undefined,
        });
      }
      if (action === "reconcile" || action === "status" || action === "kill_active") {
        await dagRunStore.reconcile({
          graph: graph ?? undefined,
          activeRunRefs: listActiveSparkRoleRunProcesses().map((process) => process.runRef),
        });
      }
      if (action === "clear_inactive") await dagRunStore.clearInactiveRuns();
      const status = await dagRunStore.status({ limit: 10 });
      const lines = [`Spark DAG manager action=${action}`];
      appendSparkDagStatusLines(lines, status);
      if (action === "kill_active")
        lines.push(`Killed active role-run processes: ${killed.length}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { action, dag: status, killed },
      };
    },
  });

  registerSparkTool({
    name: "spark_ask",
    label: "Spark Ask",
    description:
      "Ask the user a structured multi-question clarification, decision, approval, or unblock form and persist the answer as an artifact.",
    promptGuidelines: [
      "Use spark_ask as the single Spark ask tool; prefer questions[] for both single- and multi-question asks.",
      "Each option needs a stable id, short label, and clear description explaining what choosing it means.",
      "Use freeform questions for notes/context instead of creating business options named Other or Type your own.",
    ],
    parameters: Type.Object({
      kind: Type.Optional(
        Type.String({
          description: "clarification | decision | approval | unblock (legacy alias for mode)",
        }),
      ),
      mode: Type.Optional(
        Type.String({ description: "clarification | decision | approval | unblock" }),
      ),
      title: Type.Optional(Type.String({ description: "Form title shown to the user." })),
      context: Type.Optional(
        Type.String({ description: "Additional context shown with the form." }),
      ),
      flow: Type.Optional(Type.String({ description: "Stable flow/preset identifier." })),
      questions: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({ description: "Stable question identifier used as result key." }),
            prompt: Type.String({ description: "Question shown to the user." }),
            header: Type.Optional(Type.String({ description: "Short tab/header label." })),
            type: Type.Optional(
              Type.String({ description: "single | multi | preview | freeform" }),
            ),
            required: Type.Optional(Type.Boolean()),
            options: Type.Optional(
              Type.Array(
                Type.Object({
                  id: Type.String({ description: "Stable option ID returned in answers." }),
                  label: Type.String({ description: "Short user-visible label." }),
                  description: Type.String({
                    description:
                      "Required clear explanation of what choosing this option means; do not repeat only the id/label.",
                  }),
                  preview: Type.Optional(Type.String()),
                }),
              ),
            ),
          }),
        ),
      ),
      behaviour: Type.Optional(
        Type.Object({
          allowElaborate: Type.Optional(Type.Boolean()),
          allowReplay: Type.Optional(Type.Boolean()),
          preservePriorAnswers: Type.Optional(Type.Boolean()),
        }),
      ),
      question: Type.Optional(
        Type.String({ description: "Legacy single-question prompt; prefer questions[]." }),
      ),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({ description: "Stable option ID returned in answers." }),
            label: Type.String({ description: "Short user-visible label." }),
            description: Type.String({
              description:
                "Required clear explanation of what choosing this option means; do not repeat only the id/label.",
            }),
            preview: Type.Optional(Type.String()),
          }),
        ),
      ),
      multiSelect: Type.Optional(Type.Boolean({ default: false })),
      defaultOptionId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runSparkAskTool(params as unknown as SparkAskToolParams, {
        cwd: ctxCwd(ctx),
        ui: sparkAskUi(ctx),
      });
    },
  });

  registerSparkTool({
    name: "spark_ask_replay",
    label: "Spark Ask Replay",
    description:
      "Replay the latest Spark ask artifact, or a specified ask artifact, preserving prior answers where possible.",
    parameters: Type.Object({
      artifactRef: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return replaySparkAskTool({
        cwd: ctxCwd(ctx),
        artifactRef:
          typeof params.artifactRef === "string" ? (params.artifactRef as ArtifactRef) : undefined,
        ui: sparkAskUi(ctx),
      });
    },
  });

  const listRoleSpecsToolConfig: SparkRegisteredToolConfig = {
    name: "spark_list_roles",
    label: "Spark List Role Specs",
    description: "List builtin, project, and user role specs available to Spark.",
    parameters: Type.Object({
      source: Type.Optional(
        Type.String({ description: "builtin | project | user (legacy: builtin | managed)" }),
      ),
      scope: Type.Optional(Type.String({ description: "Legacy alias for source." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const registry = new RoleRegistry();
      await defaultProjectRoleStore(cwd).hydrate(registry);
      const source = normalizeRoleSpecSourceFilter(params.source ?? params.scope);
      const roles = registry.list().filter((role) => !source || role.source === source);
      const lines = roles.map(
        (role) => `- [${role.source}] ${role.id} (${role.ref}) — ${role.description}`,
      );
      return {
        content: [
          {
            type: "text",
            text: lines.length ? lines.join("\n") : "No matching role specs.",
          },
        ],
        details: { roles: roles as unknown as Record<string, unknown>[] },
      };
    },
  };
  registerSparkTool(listRoleSpecsToolConfig);

  const getRoleSpecToolConfig: SparkRegisteredToolConfig = {
    name: "spark_get_role",
    label: "Spark Get Role Spec",
    description: "Inspect one builtin, project, or user role spec.",
    parameters: Type.Object({
      role: Type.String({ description: "role spec id or full role ref" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as { role: string };
      const cwd = ctxCwd(ctx);
      const registry = new RoleRegistry();
      await defaultProjectRoleStore(cwd).hydrate(registry);
      const role = registry.select(p.role);
      return {
        content: [
          {
            type: "text",
            text: [
              `${role.id} (${role.ref})`,
              `source: ${role.source}`,
              `description: ${role.description}`,
            ].join("\n"),
          },
        ],
        details: { role: role as unknown as Record<string, unknown> },
      };
    },
  };
  registerSparkTool(getRoleSpecToolConfig);

  const createRoleSpecToolConfig: SparkRegisteredToolConfig = {
    name: "spark_create_role",
    label: "Spark Create Role Spec",
    description: "Create and persist a project Spark role spec from a validated proposal shape.",
    parameters: Type.Object({
      id: Type.String({ description: "stable role spec id" }),
      description: Type.String({ description: "what this role spec is for" }),
      systemPrompt: Type.String({
        description: "fixed system prompt for the role spec",
      }),
      rationale: Type.String({
        description: "why this role spec should exist",
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
      const proposal: RoleSpecProposal = {
        id: p.id,
        description: p.description,
        systemPrompt: p.systemPrompt,
        rationale: p.rationale,
        expectedUses: p.expectedUses,
      };
      const artifactStore = defaultArtifactStore(cwd);
      const proposalArtifact = await artifactStore.put({
        kind: "role-spec-proposal",
        title: `Role spec proposal: ${proposal.id}`,
        format: "json",
        body: proposal as unknown as JsonValue,
        provenance: { producer: "role" },
      });
      const spec = createRoleSpec({
        ...proposal,
        artifactRef: proposalArtifact.ref,
      });
      await defaultProjectRoleStore(cwd).save(spec);
      return {
        content: [
          {
            type: "text",
            text: `Role spec created: ${spec.id} (${spec.ref}) proposal=${proposalArtifact.ref}`,
          },
        ],
        details: {
          role: spec as unknown as Record<string, unknown>,
          proposalArtifactRef: proposalArtifact.ref,
        },
      };
    },
  };
  registerSparkTool(createRoleSpecToolConfig);
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

const SPARK_CONTEXT_TODO_LIMIT = 3;
const SPARK_CONTEXT_CLAIMED_TASK_LIMIT = 1;
const SPARK_MD_CONTEXT_MAX_LINES = 20;
const SPARK_MD_CONTEXT_MAX_CHARS = 1_200;

export async function renderActiveSparkContextSummary(
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
    ? renderActiveSparkThreadSummary(graph, thread, sessionKey, independentTodos)
    : undefined;
  const sparkMdExcerpt = sparkMd ? renderSparkMdActiveExcerpt(sparkMd) : undefined;
  const lines = [
    sparkMdExcerpt ? ["SPARK.md (active intent excerpt):", sparkMdExcerpt].join("\n") : undefined,
    stateLines,
  ].filter((line): line is string => Boolean(line));
  return lines.length ? lines.join("\n\n") : undefined;
}

function renderActiveSparkThreadSummary(
  graph: TaskGraph,
  thread: ReturnType<TaskGraph["threads"]>[number],
  sessionKey: string,
  independentTodos: SessionTodoEntry[],
): string {
  const tasks = graph.tasks(thread.ref);
  const unfinishedTasks = tasks.filter((task) => isUnfinishedTaskStatus(task.status));
  const claimed = unfinishedTasks.filter((task) => taskClaimedBy(task));
  const sessionClaimed = claimed.filter((task) => isClaimOwnedBySession(task, sessionKey));
  const lines = [
    "Active Spark context:",
    `- Current thread: ${thread.title} (${thread.ref})`,
    `- Unfinished tasks: ${unfinishedTasks.length} / claimed: ${claimed.length} / claimed_by_session: ${sessionClaimed.length} (${tasks.length} total)`,
  ];

  const visibleSessionClaimed = sessionClaimed.slice(0, SPARK_CONTEXT_CLAIMED_TASK_LIMIT);
  for (const task of visibleSessionClaimed) {
    const activeTodos = graph
      .taskTodos(task.ref)
      .filter((todo) => isActiveSparkTodoStatus(todo.status));
    const visibleTodos = activeTodos.slice(0, SPARK_CONTEXT_TODO_LIMIT);
    const todoSuffix = activeTodos.length > 0 ? `; ${activeTodos.length} active TODOs` : "";
    lines.push(
      `- My claimed task: [${task.status}] @${task.name}: ${task.title} (${task.ref})${todoSuffix}`,
    );
    for (const todo of visibleTodos) {
      lines.push(`  - [${todo.status}] ${todo.id} ${truncateInline(todo.content, 160)}`);
    }
    const hidden = activeTodos.length - visibleTodos.length;
    if (hidden > 0) lines.push(`  - … ${hidden} more active TODOs`);
  }
  const hiddenSessionClaimed = sessionClaimed.length - visibleSessionClaimed.length;
  if (hiddenSessionClaimed > 0)
    lines.push(`- … ${hiddenSessionClaimed} more claimed task(s); use spark_status for details`);

  const activeIndependentTodos = independentTodos.filter((todo) =>
    isActiveSparkTodoStatus(todo.status),
  );
  if (activeIndependentTodos.length > 0) {
    const visibleTodos = activeIndependentTodos.slice(0, SPARK_CONTEXT_TODO_LIMIT);
    lines.push(`- Independent TODOs: ${activeIndependentTodos.length} active`);
    for (const todo of visibleTodos) {
      const id = todo.id ? `${todo.id} ` : "";
      lines.push(`  - [${todo.status}] ${id}${truncateInline(todo.content, 160)}`);
    }
    const hidden = activeIndependentTodos.length - visibleTodos.length;
    if (hidden > 0) lines.push(`  - … ${hidden} more active TODOs`);
  }

  return lines.join("\n");
}

function isActiveSparkTodoStatus(status: string): boolean {
  return status !== "done" && status !== "cancelled" && status !== "deleted";
}

function renderSparkMdActiveExcerpt(markdown: string): string | undefined {
  return truncateSparkContextBlock(stripFinishedSparkMdSections(markdown));
}

function stripFinishedSparkMdSections(markdown: string): string {
  const lines = markdown.trim().split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) skipping = isFinishedSparkMdHeading(heading[1] ?? "");
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim();
}

function isFinishedSparkMdHeading(heading: string): boolean {
  const normalized = heading
    .replaceAll(/[#*_`]/g, "")
    .trim()
    .toLowerCase();
  if (/^(修订记录|变更记录|历史|完成|已完成)/.test(normalized)) return true;
  return /^(revision history|revisions?|changelog|change log|history|completed|finished|done)\b/i.test(
    normalized,
  );
}

function truncateSparkContextBlock(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/);
  let truncated = false;
  let text = lines.slice(0, SPARK_MD_CONTEXT_MAX_LINES).join("\n").trimEnd();
  if (lines.length > SPARK_MD_CONTEXT_MAX_LINES) truncated = true;
  if (text.length > SPARK_MD_CONTEXT_MAX_CHARS) {
    text = `${text.slice(0, SPARK_MD_CONTEXT_MAX_CHARS - 1).trimEnd()}…`;
    truncated = true;
  }
  return truncated ? `${text}\n… (read SPARK.md for full intent)` : text;
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

async function clearCurrentThreadRef(cwd: string, ctx: unknown): Promise<void> {
  await rm(currentThreadStorePath(cwd, ctx), { force: true });
}

async function currentSparkThread(
  cwd: string,
  ctx: unknown,
  graph: TaskGraph,
  options: { activate?: boolean } = {},
): Promise<ReturnType<TaskGraph["threads"]>[number] | undefined> {
  const threads = graph.threads();
  if (threads.length === 0) return undefined;
  const activeThreads = threads.filter((thread) => thread.status !== "done");
  const stored = await loadCurrentThreadRef(cwd, ctx);
  const selected = stored ? threads.find((thread) => thread.ref === stored) : undefined;
  if (selected && selected.status !== "done") return selected;
  if (selected?.status === "done") await clearCurrentThreadRef(cwd, ctx);
  if (!options.activate) return undefined;
  const fallback = activeThreads[0];
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

export function deriveTaskRoleLabel(input: {
  task: Task;
  currentSessionKey: string;
  latestRun?: TaskRun;
}): string {
  const { task, currentSessionKey, latestRun } = input;
  const claimedBy = taskClaimedBy(task);
  const runName = task.claim?.runName?.trim();
  if (task.claim?.kind === "role-run") {
    if (!runName) return "unknown-role-run";
    const owner = task.claim.sessionId
      ? sessionDisplayLabel(task.claim.sessionId, currentSessionKey)
      : "unknown-session";
    return `${owner}/${runName}`;
  }
  if (!claimedBy) {
    if (!isUnfinishedTaskStatus(task.status)) {
      const finishedRoleName = task.finishedBy?.runName?.trim();
      const finishedSessionId = task.finishedBy?.sessionId?.trim();
      if (finishedRoleName) {
        const owner = finishedSessionId
          ? sessionDisplayLabel(finishedSessionId, currentSessionKey)
          : "unknown-session";
        return `${owner}/${finishedRoleName}`;
      }
      if (finishedSessionId) return sessionDisplayLabel(finishedSessionId, currentSessionKey);
      if (latestRun?.runName) {
        const owner = latestRun.ownerSessionId
          ? sessionDisplayLabel(latestRun.ownerSessionId, currentSessionKey)
          : sessionDisplayLabel(currentSessionKey, currentSessionKey);
        return `${owner}/${latestRun.runName}`;
      }
      return sessionDisplayLabel(currentSessionKey, currentSessionKey);
    }
    return "unassigned";
  }
  if (isClaimOwnedBySession(task, currentSessionKey)) return "me";
  if (claimedBy.startsWith("session:")) return sessionDisplayLabel(claimedBy, currentSessionKey);
  return claimedBy;
}

function sessionDisplayLabel(sessionId: string, currentSessionKey: string): string {
  if (sessionId === currentSessionKey) return "me";
  return sessionId.startsWith("session:")
    ? sessionId.slice("session:".length, "session:".length + 8)
    : sessionId;
}

function resolveObviousTaskRenameCandidate(
  graph: TaskGraph,
  threadRef: ThreadRef,
  tasks: Task[],
): Task | undefined {
  const current = graph.currentTask(threadRef);
  if (current && isObviousTaskRenameCandidate(current)) return current;
  const candidates = tasks.filter(isObviousTaskRenameCandidate);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function isObviousTaskRenameCandidate(task: Task): boolean {
  return (
    isUnfinishedTaskStatus(task.status) &&
    (isGenericInitialTaskTitle(task.title) || isGenericTaskNameForTitle(task.name, task.title))
  );
}

function uniqueTaskNameForExistingTask(
  tasks: Task[],
  preferred: string,
  existingTaskRef?: TaskRef,
): string {
  const existingNames = new Set(
    tasks.filter((task) => task.ref !== existingTaskRef).map((task) => task.name),
  );
  const base = preferred.trim();
  if (!existingNames.has(base)) return base;
  let index = 2;
  while (existingNames.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function taskNamePatchForClaim(
  existing: Task | undefined,
  requestedName: string | undefined,
  requestedTitle: string,
): string | undefined {
  if (!existing) return requestedName;
  if (requestedName && requestedName !== existing.name) return requestedName;
  if (!requestedName && isGenericTaskNameForTitle(existing.name, existing.title)) {
    return taskNameFromTitleForPrompt(requestedTitle);
  }
  return undefined;
}

export function isGenericTaskNameForTitle(name: string, title: string): boolean {
  return name === taskNameFromTitleForPrompt(title) || /^task-[a-f0-9]{16}$/.test(name);
}

function taskNameFromTitleForPrompt(title: string): string {
  const ascii = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return ascii || `task-${stableId(title)}`;
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
  if (!(await hasLocalSparkDirectory(cwd))) return null;
  if (!options.skipSweep) await sweepExpiredSparkClaims(cwd, ctx);
  ensureClaimReaper(cwd);
  return loadSparkGraph(cwd, ctx);
}

async function hasLocalSparkDirectory(cwd: string): Promise<boolean> {
  return exists(join(cwd, ".spark"));
}

export async function detectSparkActivation(
  cwd: string,
): Promise<{ active: boolean; reason: string }> {
  if (!(await hasLocalSparkDirectory(cwd))) return { active: false, reason: "no .spark" };
  if (await exists(join(cwd, ".spark", "thread.json")))
    return { active: true, reason: ".spark/thread.json" };
  if (await exists(join(cwd, "SPARK.md"))) return { active: true, reason: "SPARK.md" };
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
    custom:
      typeof (ui as { custom?: unknown }).custom === "function"
        ? (ui as { custom: (...args: unknown[]) => unknown }).custom
        : undefined,
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
    `Spark is active for this workspace (${reason}).`,
    "Use the injected Active Spark context as standing project state; read SPARK.md or the spark skill only when you need full intent or workflow details.",
    "Follow the active workflow contract: use Spark tools for thread/task/TODO/DAG/ask state, claim at most one unfinished session task, ask via Spark ask tools for real blockers or missing decisions, and fix concrete repo behavior feedback in code/docs/tests instead of treating it as memory-only.",
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
  status?: string;
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
  rolePlanArtifactRef: string;
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
    roleRef: builtinRoleRef("scout"),
  });
  const planner = graph.createTask({
    threadRef: thread.ref,
    title: "Plan targeted clarification",
    description:
      "Turn the analysis into a small task graph and targeted asks with explicit role bindings and no guessed scope.",
    kind: "plan",
    roleRef: builtinRoleRef("planner"),
  });
  const reviewer = graph.createTask({
    threadRef: thread.ref,
    title: "Review initial direction",
    description:
      "Verify that the task graph follows the analyzed intent, asks only targeted questions after analysis, and avoids premature implementation.",
    kind: "review",
    roleRef: builtinRoleRef("reviewer"),
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

  const rolePlan = renderRolePlan({ idea, tasks: graph.tasks(thread.ref) });
  const rolePlanArtifact = await store.put({
    kind: "role-plan",
    title: "Initial role plan",
    format: "markdown",
    body: rolePlan,
    provenance: {
      producer: "spark",
      threadRef: thread.ref,
      parentArtifactRefs: [sparkMdArtifact.ref],
    },
  });

  const gate = createReviewGate({
    subject: rolePlanArtifact.ref,
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
      parentArtifactRefs: [sparkMdArtifact.ref, rolePlanArtifact.ref],
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
    rolePlanArtifactRef: rolePlanArtifact.ref,
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
    rolePlanArtifactRef: "artifact:existing" as ArtifactRef,
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
      `- Role plan artifact：${result.rolePlanArtifactRef}`,
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
    `- Role plan artifact: ${result.rolePlanArtifactRef}`,
    `- Trace: ${result.traceRef}`,
  ];
  for (const askRef of result.askArtifactRefs) lines.push(`- Clarification ask: ${askRef}`);
  return lines.join("\n");
}

function titleFromIdea(idea: string): string {
  const firstLine = idea.split(/\r?\n/, 1)[0]?.trim() ?? "Spark thread";
  return normalizeThreadTitle(firstLine);
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

function renderRolePlan(input: {
  idea: string;
  tasks: Array<{
    title: string;
    description: string;
    kind?: string;
    roleRef?: string;
  }>;
}): string {
  const lines = ["# Initial Role Plan", "", `Idea: ${input.idea}`, "", "## Tasks", ""];
  for (const task of input.tasks) {
    lines.push(`- **${task.title}**`);
    lines.push(`  - Kind: ${task.kind ?? "generic"}`);
    lines.push(`  - Role: ${task.roleRef ?? "unbound"}`);
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
    if (!threadState.status) {
      graph.updateThread(thread.ref, { status: "active" });
      changed = true;
    }
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

export function isPlaceholderThreadTitle(title: string): boolean {
  const normalized = title.trim();
  const normalizedLower = normalized.toLowerCase();
  return (
    normalized === "「自定义输入」" ||
    normalized === "[Enter custom title]" ||
    normalized === "Enter custom title" ||
    normalized === "自定义输入" ||
    normalizedLower === "untitled" ||
    normalizedLower === "untitled spark thread" ||
    normalizedLower === "spark thread" ||
    normalizedLower === "new thread" ||
    normalizedLower === "current thread"
  );
}

function isGenericInitialTaskTitle(title: string): boolean {
  const normalized = title.trim();
  const normalizedLower = normalized.toLowerCase();
  return (
    normalized === "Capture project intent" ||
    normalized === "Build initial task graph" ||
    normalized === "Analyze project intent" ||
    normalized === "Plan targeted clarification" ||
    normalized === "Review initial direction" ||
    normalizedLower === "current task" ||
    normalizedLower === "task" ||
    normalizedLower === "todo" ||
    normalizedLower === "implement task" ||
    normalizedLower === "do the task"
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

/** @deprecated use deriveTaskRoleLabel. */
export const deriveTaskAgentLabel = deriveTaskRoleLabel;
