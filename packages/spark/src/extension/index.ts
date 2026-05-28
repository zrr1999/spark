import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

import { Type } from "typebox";
import { defaultArtifactStore } from "spark-artifacts";
import {
  defaultLearningStore,
  type LearningCategory,
  type LearningRecord,
  type LearningRecordInput,
  type LearningScope,
  type LearningSearchResult,
  type LearningStatus,
} from "spark-learnings";
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
  defaultProjectRoleStore,
  defaultUserRoleModelBindingStore,
  saveValidatedRoleModelBinding,
  type RoleSpec,
} from "pi-roles";
import {
  DependencyError,
  contentHash,
  newRef,
  nowIso,
  type RoleRef,
  type Artifact,
  type ArtifactKind,
  type ArtifactRef,
  type AskRef,
  type JsonValue,
  stableId,
  type SparkRunTrace,
  type Task,
  type TaskCompletionReadiness,
  type TaskPlan,
  type RunRef,
  type TaskRun,
  type TaskRunCompletionSummary,
  type TaskStatus,
  type TaskRef,
  type ThreadRef,
} from "spark-core";
import { registerPiCueTools } from "pi-cue";
import { createReviewGate } from "spark-review";
import {
  DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
  defaultSparkDagRunStore,
  type SparkDagCompletionFollowUp,
  type SparkDagRunRecord,
  type SparkDagRunStatus,
  type SparkDagStatusSummary,
  runReadySparkTasks,
  sparkDagRunNextSteps,
} from "spark-orchestrator";
import {
  createRoleRunClaimId,
  findResumableBackgroundRoleRunTasks,
  killActiveSparkRoleRunProcesses,
  listActiveSparkRoleRunProcesses,
  runSparkTask,
  sweepExpiredTaskClaims,
} from "spark-runtime";
import {
  defaultTaskGraphStore,
  isUnfinishedTaskStatus,
  taskCompletionReadiness,
  TaskGraph,
  TaskGraphStoreLockTimeoutError,
  type TaskGraphStore,
  type TaskPlanInput,
  type TaskPlanResult,
  type TaskTodoOp,
  type TaskTodoSummary,
} from "spark-tasks";
import {
  applyRoadmapHintsToTaskPlanInput,
  attachRoadmapPlanningRefs,
  renderRoadmapPlanningContext,
  roadmapPlanningContext,
  type RoadmapPlanningContext,
} from "../flows/roadmap-flow.ts";
import { decideTaskPlanBeforeCreate } from "../flows/task-plan-flow.ts";
import { clarifyThreadIntentIfNeeded } from "../flows/thread-intent-flow.ts";
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
import {
  acknowledgeBackgroundDagRuns,
  activeSparkRoleRunProcessesForCwd,
  buildSparkBackgroundDetails,
  normalizeForceAfterMs,
  normalizeKillSignal,
  normalizeOptionalRunRef,
  normalizeOptionalTaskSelector,
  normalizeOptionalThreadRef,
  normalizeSparkBackgroundAction,
  reconcileSparkDagRunsWithActiveProcesses,
  renderSparkBackgroundRunsText,
  resolveBackgroundTaskRef,
} from "./background-runs.ts";
import {
  SPARK_ROLE_RUN_RETENTION_RENDER_LIMIT,
  SPARK_ROLE_RUN_RETENTION_TAIL_BYTES,
  SPARK_STATE_LARGE_ARTIFACT_THRESHOLD_BYTES,
  appendRoleRunArtifactRetentionLines,
  appendSparkDagRunPruneLines,
  appendSparkStateDiagnosticsLines,
  appendSparkStateHousekeepingLines,
  collectRoleRunArtifactRetentionPlan,
  collectSparkStateCleanupPlan,
  collectSparkStateDiagnostics,
  collectSparkStateHousekeeping,
  formatSparkProtectedStoreReason,
  formatSparkStateCacheKind,
  type SparkStateSessionScopes,
} from "./state-housekeeping.ts";
import {
  clearCurrentThreadRef,
  clearSparkExecutionMode,
  currentSparkThread,
  loadCurrentThreadRef,
  loadCurrentThreadState,
  loadHiddenRoleRunInboxState,
  loadSparkExecutionMode,
  loadSparkGraph,
  loadSparkRunMode,
  sanitizeStoreScope,
  saveCurrentThreadRef,
  saveHiddenRoleRunInboxState,
  saveSparkExecutionMode,
  saveSparkPlanningMode,
  saveSparkRunMode,
  sparkRunStrategyForMaxConcurrency,
  sparkSessionKey,
  sparkSessionOwnerKey,
  sparkTodoStore,
  updateSparkRunModeStatus,
  writeJsonFileAtomic,
  type SparkPlanningModeSource,
  type SparkRunModeState,
  type SparkRunModeStatus,
  type SparkRunStrategy,
} from "./session-state.ts";

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
  sendMessage(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
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
  setEditorText?: (text: string) => void;
}

const CLAIM_SWEEP_INTERVAL_MS = 30_000;
const MAIN_TASK_CLAIM_LEASE_MS = 10 * 60 * 1_000;
const DAG_MANAGER_POLL_INTERVAL_MS = 1_000;
const DEFAULT_SPARK_STATUS_ACTIVE_LIMIT = 20;
const DEFAULT_SPARK_STATUS_TODO_LIMIT = 3;
const DEFAULT_SPARK_STATUS_RECENT_COMPLETIONS_LIMIT = 5;
const DEFAULT_SPARK_HIDDEN_INBOX_COMPLETIONS_LIMIT = 5;
const SPARK_HIDDEN_INBOX_RECENT_MS = 7 * 24 * 60 * 60 * 1_000;
const SPARK_HIDDEN_INBOX_MAX_DELIVERED = 1_000;
const DEFAULT_SPARK_PLAN_TASK_OUTPUT_LIMIT = 5;
const SPARK_PLAN_TASKS_READINESS_RULES = [
  "Readiness rules:",
  "- Tasks must be concrete executable/review/validation/research work; do not create standalone design/planning tasks. Discuss design with the user first, then place the chosen design and rationale inside each concrete task.plan.",
  "- TaskPlanIssue kinds currently have no warning-only entries; every current kind below is blocking.",
  "- missing_plan: the task must have a bound plan.",
  "- missing_objective: plan.objective must be non-empty.",
  "- missing_success_criteria: plan.successCriteria must include at least one observable success criterion.",
  "- missing_evidence_required: plan.evidenceRequired must include at least one concrete evidence item required before completion.",
  "- missing_steps: plan.steps must include at least one execution step.",
  "- open_questions: plan.openQuestions must be empty; resolve material questions through context-specific spark_ask artifacts before planning.",
  "- dependsOn resolution is active-thread scoped and includes both existing thread tasks and every task created/updated in the same spark_plan_tasks batch before dependencies are added. Use a bare task name (displayed as @name, passed without @), exact task title, or task:* ref; unresolved dependencies block the plan, and cross-thread dependencies are unsupported.",
].join("\n");

interface SparkToolOperationalNotes {
  atomic: string;
  idempotent: string;
  prerequisites: string[];
}

const DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES: SparkToolOperationalNotes = {
  atomic: "read-only",
  idempotent: "yes; repeated calls only re-read current Spark state",
  prerequisites: ["Spark state exists in the current workspace."],
};

const SPARK_TOOL_OPERATIONAL_NOTES: Record<string, SparkToolOperationalNotes> = {
  spark_status: DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES,
  spark_state: DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES,
  spark_list_threads: DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES,
  spark_list_artifacts: DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES,
  spark_get_artifact: {
    atomic: "read-only",
    idempotent: "yes; repeated calls re-read the same artifact ref",
    prerequisites: ["Spark state exists.", "The requested artifact ref exists."],
  },
  spark_learning_search: DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES,
  spark_learning_list: DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES,
  spark_learning_read: {
    atomic: "read-only",
    idempotent: "yes; repeated calls re-read the same learning ref",
    prerequisites: ["Spark learning store exists.", "The requested learning ref/id exists."],
  },
  spark_update_todos: {
    atomic: "yes; applies the submitted session TODO op batch in one store write",
    idempotent: "operation-dependent; done/delete ops are safe when targeting stable ids",
    prerequisites: ["Spark state exists in the current workspace."],
  },
  spark_update_task_todos: {
    atomic: "yes; applies the submitted task TODO op batch in one store write",
    idempotent: "operation-dependent; done/delete ops are safe when targeting stable ids",
    prerequisites: [
      "A current Spark thread is selected.",
      "This session has one claimed unfinished task, or the task parameter resolves to one.",
    ],
  },
  spark_finish_task: {
    atomic: "yes; completes one claimed task and clears its claim in one graph update",
    idempotent: "no; a finished task cannot be finished again",
    prerequisites: [
      "A current Spark thread is selected.",
      "This session has a claimed unfinished task, or task resolves to one.",
    ],
  },
  spark_claim_task: {
    atomic: "yes; creates/updates and claims one task in one graph update",
    idempotent: "no; repeated calls can refresh metadata, claims, and updatedAt",
    prerequisites: ["A current Spark thread is selected."],
  },
  spark_rename_thread: {
    atomic: "yes; updates one thread metadata record",
    idempotent: "yes when repeated with the same metadata",
    prerequisites: [
      "Spark state exists.",
      "A target thread exists, or a current thread is selected.",
    ],
  },
  spark_use_thread: {
    atomic:
      "no; selecting an existing thread writes only session state, while creating a new thread writes graph state then session state",
    idempotent:
      "yes for selecting an existing thread; creating by title may create once then select on repeat",
    prerequisites: [
      "Spark state exists.",
      "Provide an existing thread selector, or provide title to create a thread.",
    ],
  },
  spark_plan_tasks: {
    atomic:
      "yes for thread graph changes; roadmap ref attachment is a follow-up write after readiness passes",
    idempotent:
      "mostly yes for stable task names/titles, but repeated updates refresh task metadata",
    prerequisites: [
      "A current Spark thread is selected.",
      "Each task is concrete and plan-bound, with no unresolved openQuestions.",
    ],
  },
  spark_run_ready_tasks: {
    atomic: "no; starts or previews DAG scheduling and real runs complete asynchronously",
    idempotent:
      "dryRun=true is safe; dryRun=false can launch role-runs and should not be repeated blindly",
    prerequisites: [
      "A current Spark thread is selected.",
      "Ready tasks exist for the selected thread.",
      "Required role model bindings exist before real dispatch.",
    ],
  },
  spark_background_runs: {
    atomic:
      "action-dependent; status/list/inspect are read-only except reconcile refresh, kill/ack/reconcile mutate runtime or DAG records",
    idempotent:
      "status/list/inspect/reconcile are safe to repeat; ack is safe for the same problem records; kill is state-changing",
    prerequisites: [
      "Spark state exists for this workspace.",
      "Use runRef/taskRef/all=true for kill; broad kills are never implicit.",
    ],
  },
  spark_dag_manager: {
    atomic:
      "action-dependent; status is read-only; reconcile/ack/clear/kill mutate run records or processes",
    idempotent: "status, reconcile, and repeat ack are safe; clear/kill actions are state-changing",
    prerequisites: ["Spark DAG run store exists for this workspace."],
  },
  spark_ask: {
    atomic: "yes; creates one ask artifact and waits for one answer artifact",
    idempotent: "no; repeated calls create or replay user-facing asks depending on flow settings",
    prerequisites: ["A concrete, context-specific user decision or clarification is needed."],
  },
  spark_ask_replay: {
    atomic: "no; replays a user-facing ask interaction",
    idempotent: "no; repeated calls can create additional answer artifacts",
    prerequisites: ["A previous Spark ask artifact exists, or a specific artifactRef is provided."],
  },
  spark_learning_record: {
    atomic: "yes; writes one learning record",
    idempotent: "yes when repeated with the same stable id and content",
    prerequisites: ["Evidence-backed reusable learning content is available."],
  },
  spark_learning_mark_stale: {
    atomic: "yes; updates one learning record status",
    idempotent: "yes when repeated with the same reason",
    prerequisites: ["The target learning ref/id exists.", "A stale reason is provided."],
  },
  spark_learning_supersede: {
    atomic: "yes; updates one learning record with replacement refs",
    idempotent: "yes when repeated with the same replacement refs",
    prerequisites: ["The target learning ref/id exists.", "Replacement learning refs are known."],
  },
  spark_learning_reject: {
    atomic: "yes; updates one learning candidate status",
    idempotent: "yes when repeated with the same reason",
    prerequisites: [
      "The target learning candidate ref/id exists.",
      "A rejection reason is provided.",
    ],
  },
  spark_learning_export_markdown: {
    atomic: "yes for the export file/artifact write",
    idempotent:
      "yes for the same filters and outputPath, subject to current learning store contents",
    prerequisites: [
      "Spark learning store exists.",
      "An output path is provided when a file export is desired.",
    ],
  },
  spark_learning_import_markdown: {
    atomic:
      "no when apply=true; imports multiple learning records and may optionally delete verified legacy sources",
    idempotent: "dry-run is safe; apply=true depends on source ids and import contents",
    prerequisites: [
      "inputPath exists and points to a Spark learning export, legacy Markdown file, or .learnings directory.",
    ],
  },
};

function withSparkToolOperationalNotes(toolName: string, description: string): string {
  const notes = SPARK_TOOL_OPERATIONAL_NOTES[toolName] ?? DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES;
  return [
    description.trimEnd(),
    "",
    `Atomic: ${notes.atomic}`,
    `Idempotent: ${notes.idempotent}`,
    "Prerequisites:",
    ...notes.prerequisites.map((item) => `- ${item}`),
  ].join("\n");
}
type SparkStatusView = "active" | "summary" | "full";
type SparkStatusFormat = "text" | "json";
type SparkThreadListStatus = "active" | "done" | "all";
type SparkCommandProjectStateKind = "empty_project" | "existing_project" | "initialized";
interface SparkCommandProjectState {
  kind: SparkCommandProjectStateKind;
  hasCurrentThread: boolean;
  unfinishedTaskCount: number;
}

type SparkEntryMode = "planning" | "execution" | "run";
type SparkEntryModeChoice = SparkEntryMode | "new_project";
type SparkEntryConfidence = "high" | "ambiguous" | "conflicting";

interface SparkEntryModeAnalysis {
  recommendation: SparkEntryModeChoice;
  confidence: SparkEntryConfidence;
  reasons: string[];
  prompt: string;
  currentThreadTitle: string;
  threadCount: number;
  unfinishedTaskCount: number;
  readyTaskCount: number;
  pendingTaskCount: number;
}

type SparkEntryIntent =
  | { kind: "auto"; prompt: string }
  | { kind: "run_auto"; prompt: string }
  | { kind: "direct"; mode: SparkEntryMode; prompt: string; runStrategy?: SparkRunStrategy };

type SparkEntryResolution =
  | {
      action: "initialize_new_project";
      idea: string;
      enterPlanning: boolean;
      planningSource?: SparkPlanningModeSource;
    }
  | { action: "initialize_existing_project"; idea: string; planningSource: SparkPlanningModeSource }
  | {
      action: "enter_mode";
      mode: SparkEntryMode;
      focus?: string;
      planningSource?: SparkPlanningModeSource;
      runStrategy?: SparkRunStrategy;
    }
  | { action: "blocked"; message: string }
  | { action: "none" };

const dagManagerTimers = new Map<string, ReturnType<typeof setTimeout>>();
const claimReaperTimers = new Map<string, ReturnType<typeof setInterval>>();

function ensureClaimReaper(cwd: string): void {
  if (claimReaperTimers.has(cwd)) return;
  const timer = setInterval(
    () => void sweepExpiredSparkClaims(cwd).catch(() => undefined),
    CLAIM_SWEEP_INTERVAL_MS,
  );
  (timer as { unref?: () => void }).unref?.();
  claimReaperTimers.set(cwd, timer);
}

async function sweepExpiredSparkClaims(cwd: string, ctx?: unknown): Promise<void> {
  const store = defaultTaskGraphStore(cwd);
  try {
    const result = await sweepExpiredTaskClaims(store, nowIso(), { timeoutMs: 250 });
    if (result.saved && result.graph) await sparkTodoStore(cwd, ctx).save(result.graph);
  } catch (error) {
    if (error instanceof TaskGraphStoreLockTimeoutError) return;
    throw error;
  }
}

const SPARK_EXECUTION_CONTINUATION_TTL_MS = 10 * 60 * 1000;

interface PendingSparkExecutionContinuation {
  threadRef: ThreadRef;
  taskRef: TaskRef;
  reason: string;
}

interface PendingSparkAgentInstruction {
  content: string;
  queuedAtMs: number;
  continuation?: PendingSparkExecutionContinuation;
}

async function validPendingSparkAgentInstructions(
  ctx: SparkToolContext,
  entries: PendingSparkAgentInstruction[],
): Promise<PendingSparkAgentInstruction[]> {
  const continuations = entries.filter((entry) => entry.continuation);
  const graph = continuations.length > 0 ? await loadSparkGraph(ctx.cwd, ctx) : undefined;
  const sessionKey = sparkSessionOwnerKey(ctx);
  return entries.filter((entry) => {
    if (!entry.continuation) return true;
    if (Date.now() - entry.queuedAtMs > SPARK_EXECUTION_CONTINUATION_TTL_MS) return false;
    if (!graph) return false;
    const thread = graph.getThread(entry.continuation.threadRef);
    if (!thread || thread.status !== "active") return false;
    const task = graph.getTask(entry.continuation.taskRef);
    if (!task || task.threadRef !== thread.ref) return false;
    return task.status === "running" && isClaimOwnedBySession(task, sessionKey);
  });
}

export default function sparkExtension(pi: SparkExtensionAPI) {
  if (pi.registerTool) {
    registerPiCueTools(pi as unknown as Parameters<typeof registerPiCueTools>[0]);
  }

  const pendingSparkAgentInstructions = new Map<string, PendingSparkAgentInstruction[]>();

  function queueSparkAgentInstruction(
    ctx: SparkToolContext,
    instruction: string,
    continuation?: PendingSparkExecutionContinuation,
  ): void {
    const sessionKey = sparkSessionOwnerKey(ctx);
    const entries = pendingSparkAgentInstructions.get(sessionKey) ?? [];
    const nextEntry: PendingSparkAgentInstruction = {
      content: instruction,
      queuedAtMs: Date.now(),
      continuation,
    };
    pendingSparkAgentInstructions.set(
      sessionKey,
      continuation
        ? [
            ...entries.filter(
              (entry) =>
                !entry.continuation ||
                entry.continuation.threadRef !== continuation.threadRef ||
                entry.continuation.taskRef !== continuation.taskRef ||
                entry.continuation.reason !== continuation.reason,
            ),
            nextEntry,
          ]
        : [nextEntry],
    );
  }

  pi.on?.("input", async (event: unknown, ctx: SparkToolContext) => handleSparkInput(event, ctx));
  pi.on?.("before_role_start", async (event: unknown, ctx: SparkToolContext) =>
    injectSparkHints(event, ctx),
  );
  pi.on?.("before_agent_start", async (_event: unknown, ctx: SparkToolContext) => {
    const sessionKey = sparkSessionOwnerKey(ctx);
    const entries = pendingSparkAgentInstructions.get(sessionKey) ?? [];
    const validEntries =
      entries.length > 0 ? await validPendingSparkAgentInstructions(ctx, entries) : [];
    const inbox = await collectUnreadHiddenRoleRunInbox(ctx);
    if (validEntries.length === 0 && inbox.summaries.length === 0) {
      if (entries.length > 0) pendingSparkAgentInstructions.delete(sessionKey);
      return undefined;
    }
    const contentParts = validEntries.map((entry) => entry.content);
    if (inbox.summaries.length > 0) contentParts.push(formatHiddenRoleRunInbox(inbox));
    if (inbox.summaries.length > 0) await markHiddenRoleRunInboxDelivered(ctx, inbox.summaries);
    if (entries.length > 0) pendingSparkAgentInstructions.delete(sessionKey);
    return {
      message: {
        customType: "spark-mode-context",
        content: contentParts.join("\n\n"),
        display: false,
      },
    };
  });
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
      isToolExecutionEvent(event, "spark_finish_task") ||
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
    const sessionKey = sparkSessionKey(ctx);
    const ownerSessionKey = sparkSessionOwnerKey(ctx);
    const independentTodos = (await loadIndependentTodos(cwd, ctx)).filter(
      (todo) => todo.status !== "done" && todo.status !== "cancelled" && todo.status !== "deleted",
    );
    const todoDisplayNumbers = await loadTodoDisplayNumberState(cwd, ctx);
    const numberedIndependentTodos = independentTodos.map((todo) => ({
      ...todo,
      displayNumber: assignTodoDisplayNumber(todoDisplayNumbers, independentTodoDisplayKey(todo)),
    }));
    const thread = await currentSparkThread(cwd, ctx, graph);
    const currentState = await loadCurrentThreadState(cwd, ctx);
    if (!thread) {
      const dagStatus = await defaultSparkDagRunStore(cwd).status();
      widgetState = {
        dag: sparkDagWidgetEntry(dagStatus),
        run: sparkRunWidgetEntry(currentState?.runMode),
        tasks: [],
        independentTodos: numberedIndependentTodos,
        taskCountTotal: 0,
        taskCountClaimed: 0,
        taskCountClaimedBySession: 0,
        outputLanguage: "en",
      };
      if (todoDisplayNumbers.changed)
        await saveTodoDisplayNumberState(cwd, ctx, todoDisplayNumbers);
      widget.update();
      return;
    }
    const dagStatus = await defaultSparkDagRunStore(cwd).status();
    const allTasks = graph.tasks(thread.ref);
    const claimedTasks = allTasks.filter((task) => taskClaimedBy(task));
    const sessionTasks = claimedTasks.filter((task) => isClaimOwnedBySession(task, sessionKey));
    const taskTodosByRef = new Map(allTasks.map((task) => [task.ref, graph.taskTodos(task.ref)]));
    const lastRunsByTaskRef = latestRunsByTaskRef(graph.runs(thread.ref));
    const activeRunRefs = new Set(
      listActiveSparkRoleRunProcesses()
        .filter((process) => process.cwd === cwd)
        .map((process) => process.runRef),
    );
    widgetState = {
      threadTitle: isPlaceholderThreadTitle(thread.title) ? undefined : thread.title,
      dag: sparkDagWidgetEntry(dagStatus, thread.ref),
      run: sparkRunWidgetEntry(currentState?.runMode, thread.ref),
      tasks: allTasks.map((task) => ({
        title: task.title,
        status: mapTaskStatus(task.status),
        claim: mapTaskClaim(task, sessionKey),
        agentLabel: deriveTaskRoleLabel({
          task,
          currentSessionKey: sessionKey,
          latestRun: lastRunsByTaskRef.get(task.ref),
        }),
        planSummary: taskPlanSummary(task),
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        const runRef = newRef("run");
        const finishedAt = nowIso();
        graph.recordRun({
          ref: runRef,
          threadRef: task.threadRef,
          taskRef: task.ref,
          roleRef: task.claim?.roleRef ?? task.roleRef,
          runName,
          ownerSessionId,
          status: "failed",
          failureKind: "runtime_error",
          errorMessage,
          startedAt: finishedAt,
          finishedAt,
          outputArtifacts: [],
          completionSummary: {
            runRef,
            taskRef: task.ref,
            roleRef: task.claim?.roleRef ?? task.roleRef,
            runName,
            status: "failed",
            summary: errorMessage,
            artifactRefs: [],
            createdAt: finishedAt,
          },
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
      const runMode = await loadSparkRunMode(cwd, ctx);
      if (scheduled > 0 && (!runMode || runMode.status === "running")) {
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
    const currentThread = await currentSparkThread(cwd, ctx, graph);
    const runMode = await loadSparkRunMode(cwd, ctx);
    if (runMode && runMode.status !== "running") return 0;
    const readyBeforeReconcile = currentThread ? graph.readyTasks(currentThread.ref) : [];
    if (readyBeforeReconcile.length === 0) {
      const dagStatus = await dagRunStore.status();
      if (!dagStatus.activeRun) {
        if (runMode && currentThread?.ref === runMode.threadRef)
          await updateSparkRunModeStatus(
            cwd,
            ctx,
            terminalSparkRunModeStatus(graph, runMode.threadRef),
          );
        return 0;
      }
    }
    await dagRunStore.reconcile({
      graph,
      activeRunRefs: listActiveSparkRoleRunProcesses().map((process) => process.runRef),
    });
    if (!currentThread) return 0;
    const readyTasks = graph.readyTasks(currentThread.ref);
    if (readyTasks.length === 0) {
      const dagStatus = await dagRunStore.status();
      if (dagStatus.activeRun?.status === "running") return 1;
      if (runMode && currentThread.ref === runMode.threadRef)
        await updateSparkRunModeStatus(
          cwd,
          ctx,
          terminalSparkRunModeStatus(graph, runMode.threadRef),
        );
      return 0;
    }
    const bindingResult = await ensureRoleModelBindingsForThread({
      graph,
      threadRef: currentThread.ref,
      registry,
      cwd,
      ctx,
    });
    if (!bindingResult.ready) {
      if (runMode && currentThread.ref === runMode.threadRef)
        await updateSparkRunModeStatus(cwd, ctx, "blocked");
      ctx.ui?.notify?.(bindingResult.message, "warning");
      return 0;
    }
    const ownerSessionId = sparkSessionOwnerKey(ctx);
    const maxConcurrency =
      runMode?.policy.maxConcurrency ?? DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY;
    const timeoutMs = runMode?.policy.timeoutMs ?? DEFAULT_SPARK_READY_TASK_TIMEOUT_MS;
    const dagRun = await dagRunStore.startRun({
      threadRef: currentThread.ref,
      dryRun: false,
      maxConcurrency,
      timeoutMs,
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
        maxConcurrency,
        timeoutMs,
        threadRef: currentThread.ref,
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
      if (runMode && currentThread.ref === runMode.threadRef && dagResultTerminalForRunMode(result))
        await updateSparkRunModeStatus(cwd, ctx, "blocked");
      emitSparkDagCompletionFollowUp(ctx, followUp);
    } catch (error) {
      const followUp = await dagRunStore.finishRun(
        dagRun.ref,
        { scheduled: touched.size, completed: 0, timedOut: false },
        error,
      );
      if (runMode && currentThread.ref === runMode.threadRef)
        await updateSparkRunModeStatus(cwd, ctx, "failed");
      emitSparkDagCompletionFollowUp(ctx, followUp);
      throw error;
    }
    if (touched.size > 0) {
      await mergeTaskProgressIntoStore(store, graph, [...touched]);
      await sparkTodoStore(cwd, ctx).save(graph);
      await refreshSparkWidget(cwd, ctx);
    }
    return runMode && currentThread.ref === runMode.threadRef && dagResultTerminalForRunMode(result)
      ? 0
      : result.scheduled;
  }

  function terminalSparkRunModeStatus(graph: TaskGraph, threadRef: ThreadRef): SparkRunModeStatus {
    const unfinished = graph.tasks(threadRef).filter((task) => isUnfinishedTaskStatus(task.status));
    return unfinished.length === 0 ? "done" : "blocked";
  }

  function dagResultTerminalForRunMode(result: { failed?: number; cancelled?: number }): boolean {
    return (result.failed ?? 0) > 0 || (result.cancelled ?? 0) > 0;
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

  function taskPlanSummary(task: Pick<Task, "plan">): "missing" | undefined {
    return task.plan ? undefined : "missing";
  }

  function taskLifecycleSuffix(task: Task): string {
    const parts: string[] = [];
    if (task.supersededBy.length > 0) parts.push(`supersededBy=${task.supersededBy.join(",")}`);
    if (task.cancellation) {
      const by = task.cancellation.by ? ` by=${task.cancellation.by}` : "";
      const reason = task.cancellation.reason
        ? ` reason=${JSON.stringify(truncateInline(task.cancellation.reason, 120))}`
        : "";
      parts.push(`cancelledAt=${task.cancellation.at}${by}${reason}`);
    }
    return parts.length > 0 ? ` ${parts.join(" ")}` : "";
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

  function normalizeSparkStatusFormat(params: Record<string, unknown>): SparkStatusFormat {
    return params.format === "json" ? "json" : "text";
  }

  function normalizeSparkThreadListStatus(params: Record<string, unknown>): SparkThreadListStatus {
    if (params.status === "done" || params.status === "all") return params.status;
    return "active";
  }

  function normalizeSparkStatusLimit(params: Record<string, unknown>): number | undefined {
    if (typeof params.limit !== "number" || !Number.isFinite(params.limit)) return undefined;
    const limit = Math.floor(params.limit);
    return limit >= 0 ? limit : undefined;
  }

  function normalizeSparkFinishStatus(value: unknown): "done" | "failed" | "cancelled" {
    if (value === "failed" || value === "cancelled" || value === "cancel")
      return value === "cancel" ? "cancelled" : value;
    return "done";
  }

  function normalizeArtifactLimit(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.max(0, Math.floor(value));
  }

  function normalizePositiveInteger(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value));
  }

  function normalizeArtifactKind(value: unknown): ArtifactKind | undefined {
    if (
      value === "spark-md" ||
      value === "research" ||
      value === "plan" ||
      value === "task-breakdown" ||
      value === "role-plan" ||
      value === "handoff" ||
      value === "review" ||
      value === "cue-output" ||
      value === "role-run" ||
      value === "role-spec-proposal" ||
      value === "ask-answer" ||
      value === "run-trace" ||
      value === "learning" ||
      value === "learning-candidate" ||
      value === "learning-export"
    )
      return value;
    return undefined;
  }

  function normalizeArtifactProducer(value: unknown) {
    if (
      value === "spark" ||
      value === "role" ||
      value === "task" ||
      value === "ask" ||
      value === "cue" ||
      value === "review" ||
      value === "user"
    )
      return value;
    return undefined;
  }

  function normalizeSparkDagManagerAction(
    value: unknown,
  ): "status" | "reconcile" | "ack" | "clear_inactive" | "prune" | "kill_active" {
    if (value === "acknowledge") return "ack";
    if (
      value === "reconcile" ||
      value === "ack" ||
      value === "clear_inactive" ||
      value === "prune" ||
      value === "kill_active" ||
      value === "status"
    )
      return value;
    return "status";
  }

  function collectNonConcreteTaskIssues(tasks: TaskPlanInput[]): Array<{
    name?: string;
    title: string;
    message: string;
  }> {
    return tasks.flatMap((task) => {
      const message = nonConcreteTaskMessage(task);
      return message ? [{ name: task.name, title: task.title, message }] : [];
    });
  }

  function nonConcreteTaskMessage(task: TaskPlanInput): string | undefined {
    if (task.status === "cancelled" || task.status === "done") return undefined;
    if (task.kind === "plan")
      return "kind=plan is reserved for planning logic; create concrete implement/review/research/validation work and put design details in task.plan";
    const title = task.title.trim();
    if (/^(设计|规划)(\s|[:：]|$)/u.test(title))
      return "title starts with a design/planning verb; discuss the design with the user, then create concrete implementation/review/validation tasks";
    if (/^(design|plan)(\s|[:：-]|$)/iu.test(title))
      return "title starts with a design/planning verb; discuss the design with the user, then create concrete implementation/review/validation tasks";
    return undefined;
  }

  function sparkRunWidgetEntry(
    runMode: SparkRunModeState | undefined,
    threadRef?: ThreadRef,
  ): SparkWidgetState["run"] {
    if (!runMode) return undefined;
    if (threadRef && runMode.threadRef !== threadRef) return undefined;
    return { status: runMode.status, runRef: runMode.runRef, focus: runMode.focus };
  }

  function sparkRunModeStatusLine(runMode: SparkRunModeState): string {
    const focusSuffix = runMode.focus ? ` focus=${runMode.focus}` : "";
    const strategy = sparkRunStrategyForMaxConcurrency(runMode.policy.maxConcurrency);
    return `Spark run mode: ${runMode.status} ${runMode.runRef} thread=${runMode.threadRef}${focusSuffix} strategy=${strategy} maxConcurrency=${runMode.policy.maxConcurrency} timeoutMs=${runMode.policy.timeoutMs}`;
  }

  function sparkDagWidgetEntry(
    dagStatus: SparkDagStatusSummary,
    threadRef?: ThreadRef,
  ): SparkWidgetState["dag"] {
    const activeRun = dagStatus.activeRun;
    if (activeRun && (!threadRef || activeRun.threadRef === threadRef)) {
      return {
        status: activeRun.status,
        runRef: activeRun.ref,
        scheduled: activeRun.scheduled,
        completed: activeRun.completed,
        active: true,
      };
    }
    const actionableRun = dagStatus.actionableRun;
    if (actionableRun && (!threadRef || actionableRun.threadRef === threadRef)) {
      return {
        status: actionableRun.status,
        runRef: actionableRun.ref,
        scheduled: actionableRun.scheduled,
        completed: actionableRun.completed,
      };
    }
    return undefined;
  }

  function emitSparkDagCompletionFollowUp(
    ctx: SparkToolContext,
    followUp: SparkDagCompletionFollowUp | undefined,
  ): void {
    if (!followUp) return;
    const action = followUp.status === "succeeded" ? undefined : followUp.nextActions[0];
    ctx.ui?.notify?.(
      action ? `${followUp.summary} ${action}` : followUp.summary,
      sparkDagCompletionNotificationLevel(followUp.status),
    );
  }

  function sparkDagCompletionNotificationLevel(
    status: SparkDagRunStatus,
  ): "info" | "warning" | "error" {
    return status === "succeeded" ? "info" : status === "timed_out" ? "warning" : "error";
  }

  function appendCompactSparkDagStatusLines(
    lines: string[],
    dagStatus: SparkDagStatusSummary,
  ): SparkDagRunRecord | undefined {
    const compactRun = dagStatus.activeRun ?? dagStatus.actionableRun;
    if (!compactRun) return undefined;
    const runKind = compactRun.ref === dagStatus.activeRun?.ref ? "active" : "actionable";
    lines.push(
      `Spark orchestrator: ${dagStatus.manager.status} ${runKind}=${compactRun.ref} | running=${dagStatus.running} actionable=${dagStatus.actionable}`,
    );
    return compactRun;
  }

  function appendSparkDagStatusLines(lines: string[], dagStatus: SparkDagStatusSummary): void {
    const managerSuffix = dagStatus.manager.activeRunRef
      ? ` active=${dagStatus.manager.activeRunRef}`
      : "";
    lines.push(
      `Spark orchestrator: ${dagStatus.manager.status}${managerSuffix} runs=${dagStatus.recentRuns.length} recent | running=${dagStatus.running} succeeded=${dagStatus.succeeded} failed=${dagStatus.failed} stale=${dagStatus.stale} timed_out=${dagStatus.timedOut} acknowledged=${dagStatus.acknowledged}`,
    );
    if (dagStatus.lastRun) {
      lines.push(`  Last DAG run: ${formatSparkDagRun(dagStatus.lastRun)}`);
      appendSparkDagRunNextStepLines(lines, dagStatus.lastRun, "  ");
    }
    if (dagStatus.activeRun && dagStatus.activeRun.ref !== dagStatus.lastRun?.ref) {
      lines.push(`  Active DAG run: ${formatSparkDagRun(dagStatus.activeRun)}`);
      appendSparkDagRunNextStepLines(lines, dagStatus.activeRun, "  ");
    }
    if (dagStatus.recentRuns.length > 0) {
      lines.push("  Recent DAG runs:");
      for (const run of dagStatus.recentRuns) lines.push(`    - ${formatSparkDagRun(run)}`);
    }
  }

  function appendSparkDagRunNextStepLines(
    lines: string[],
    run: SparkDagRunRecord,
    indent: string,
  ): void {
    const nextSteps = sparkDagRunNextSteps(run);
    if (!nextSteps) return;
    lines.push(`${indent}Next steps (${nextSteps.status}):`);
    for (const action of nextSteps.nextActions) lines.push(`${indent}  - ${action}`);
  }

  function collectRecentRoleRunCompletions(input: {
    graph: TaskGraph;
    threadRef?: ThreadRef;
    limit: number;
  }): TaskRunCompletionSummary[] {
    return input.graph
      .runs(input.threadRef)
      .flatMap((run) => (run.completionSummary ? [run.completionSummary] : []))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, input.limit)
      .map(cloneTaskRunCompletionSummary);
  }

  async function collectUnreadHiddenRoleRunInbox(
    ctx: SparkToolContext,
  ): Promise<{ summaries: TaskRunCompletionSummary[]; remaining: number }> {
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    if (!graph) return { summaries: [], remaining: 0 };
    const ownerSessionId = sparkSessionOwnerKey(ctx);
    const deliveredRunRefs = new Set(
      (await loadHiddenRoleRunInboxState(ctx.cwd, ctx)).delivered.map((entry) => entry.runRef),
    );
    const recentCutoffMs = Date.now() - SPARK_HIDDEN_INBOX_RECENT_MS;
    const unread = graph
      .runs()
      .filter((run) => run.ownerSessionId === ownerSessionId)
      .flatMap((run) => {
        if (!run.completionSummary || deliveredRunRefs.has(run.ref)) return [];
        const createdAtMs = Date.parse(run.completionSummary.createdAt);
        if (Number.isFinite(createdAtMs) && createdAtMs < recentCutoffMs) return [];
        return [run.completionSummary];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const summaries = unread
      .slice(0, DEFAULT_SPARK_HIDDEN_INBOX_COMPLETIONS_LIMIT)
      .map(cloneTaskRunCompletionSummary);
    return { summaries, remaining: Math.max(0, unread.length - summaries.length) };
  }

  function formatHiddenRoleRunInbox(input: {
    summaries: TaskRunCompletionSummary[];
    remaining: number;
  }): string {
    const lines = ["Recent unread background role-run results:"];
    for (const summary of input.summaries) {
      const role = summary.roleRef ? ` role=${shortRoleLabel(summary.roleRef)}` : "";
      const runName = summary.runName ? ` name=${summary.runName}` : "";
      const artifacts =
        summary.artifactRefs.length > 0
          ? ` artifacts=${summary.artifactRefs.join(",")}`
          : " artifacts=none";
      const nextAction = hiddenRoleRunNextAction(summary);
      lines.push(
        `- [${summary.status}] task=${summary.taskRef} run=${summary.runRef}${role}${runName} — ${truncateInline(summary.summary, 180)}${artifacts}; next=${nextAction}`,
      );
    }
    if (input.remaining > 0)
      lines.push(`- ${input.remaining} more unread result(s) remain for a later turn.`);
    lines.push("Use artifact refs or spark_background_runs inspect for full details if needed.");
    return lines.join("\n");
  }

  function hiddenRoleRunNextAction(summary: TaskRunCompletionSummary): string {
    if (summary.status === "failed") {
      return `inspect with spark_background_runs inspect runRef=${summary.runRef}; fix the failure cause, then rerun the ready frontier`;
    }
    if (summary.status === "cancelled") {
      return `inspect with spark_background_runs inspect runRef=${summary.runRef}; decide whether to requeue, supersede, or acknowledge cancellation`;
    }
    return "continue parent task using this compact summary and artifact refs";
  }

  async function markHiddenRoleRunInboxDelivered(
    ctx: SparkToolContext,
    summaries: TaskRunCompletionSummary[],
  ): Promise<void> {
    const state = await loadHiddenRoleRunInboxState(ctx.cwd, ctx);
    const deliveredAt = nowIso();
    const byRunRef = new Map(state.delivered.map((entry) => [entry.runRef, entry]));
    for (const summary of summaries)
      byRunRef.set(summary.runRef, { runRef: summary.runRef, deliveredAt });
    state.delivered = [...byRunRef.values()]
      .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt))
      .slice(0, SPARK_HIDDEN_INBOX_MAX_DELIVERED);
    await saveHiddenRoleRunInboxState(ctx.cwd, ctx, state);
  }

  function cloneTaskRunCompletionSummary(
    summary: TaskRunCompletionSummary,
  ): TaskRunCompletionSummary {
    return { ...summary, artifactRefs: [...summary.artifactRefs] };
  }

  function appendRecentRoleRunCompletionLines(
    lines: string[],
    summaries: TaskRunCompletionSummary[],
  ): void {
    lines.push("Recent role-run completions:");
    for (const summary of summaries) {
      const role = summary.roleRef ? ` role=${shortRoleLabel(summary.roleRef)}` : "";
      const runName = summary.runName ? ` name=${summary.runName}` : "";
      const artifacts =
        summary.artifactRefs.length > 0
          ? ` artifacts=${summary.artifactRefs.join(",")}`
          : " artifacts=none";
      lines.push(
        `  - [${summary.status}] task=${summary.taskRef} run=${summary.runRef}${role}${runName} — ${truncateInline(summary.summary, 180)}${artifacts}`,
      );
    }
  }

  function formatSparkDagRun(run: SparkDagRunRecord): string {
    const finishedSuffix = run.finishedAt ? ` finished=${run.finishedAt}` : "";
    const timeoutSuffix = run.timedOut ? " timed_out=true" : "";
    const ackSuffix = run.acknowledgedAt
      ? ` acknowledgedAt=${run.acknowledgedAt} acknowledgedBySession=${run.acknowledgedBySession ?? "unknown"}`
      : "";
    return `${run.ref} [${run.status}] scheduled=${run.scheduled} completed=${run.completed} maxConcurrency=${run.maxConcurrency} timeoutMs=${run.timeoutMs} updated=${run.updatedAt}${finishedSuffix}${timeoutSuffix}${ackSuffix}`;
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

  function compactTaskDetail(task: Task) {
    return {
      ref: task.ref,
      name: task.name,
      title: task.title,
      status: task.status,
      kind: task.kind,
      roleRef: task.roleRef,
      threadRef: task.threadRef,
      cancellation: task.cancellation,
      supersededBy: task.supersededBy,
    };
  }

  function compactTaskPlanResult(result: TaskPlanResult) {
    return {
      created: result.created.map(compactTaskDetail),
      updated: result.updated.map(compactTaskDetail),
      skipped: result.skipped.length,
      dependencies: result.dependencies.length,
    };
  }

  function compactArtifactDetail(artifact: Artifact) {
    return {
      ref: artifact.ref,
      kind: artifact.kind,
      title: artifact.title,
      format: artifact.format,
      producer: artifact.provenance.producer,
      threadRef: artifact.provenance.threadRef,
      taskRef: artifact.provenance.taskRef,
      roleRef: artifact.provenance.roleRef,
      bodySize: artifact.bodySize,
      bodyTruncated: artifact.bodyTruncated,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    };
  }

  function normalizeLearningStatus(value: unknown): LearningStatus | undefined {
    if (
      value === "candidate" ||
      value === "active" ||
      value === "stale" ||
      value === "superseded" ||
      value === "rejected"
    )
      return value;
    return undefined;
  }

  function normalizeLearningStatusFilter(
    value: unknown,
  ): LearningStatus | LearningStatus[] | undefined {
    if (Array.isArray(value)) {
      const statuses = value.flatMap((item) => {
        const status = normalizeLearningStatus(item);
        return status ? [status] : [];
      });
      return statuses.length ? statuses : undefined;
    }
    return normalizeLearningStatus(value);
  }

  function normalizeLearningScope(value: unknown): LearningScope | undefined {
    if (value === "global" || value === "project" || value === "thread" || value === "task")
      return value;
    return undefined;
  }

  function normalizeLearningCategory(value: unknown): LearningCategory | undefined {
    if (
      value === "pattern" ||
      value === "gotcha" ||
      value === "decision" ||
      value === "workflow" ||
      value === "tool" ||
      value === "project"
    )
      return value;
    return undefined;
  }

  function normalizeStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const values = value.filter((item): item is string => typeof item === "string");
    return values.length ? values : undefined;
  }

  function normalizeLearningInput(params: Record<string, unknown>): LearningRecordInput {
    return {
      title: typeof params.title === "string" ? params.title : "",
      statement: typeof params.statement === "string" ? params.statement : "",
      id: typeof params.id === "string" ? params.id : undefined,
      category: normalizeLearningCategory(params.category),
      scope: normalizeLearningScope(params.scope),
      status: normalizeLearningStatus(params.status),
      applicability: typeof params.applicability === "string" ? params.applicability : undefined,
      nonApplicability:
        typeof params.nonApplicability === "string" ? params.nonApplicability : undefined,
      rationale: typeof params.rationale === "string" ? params.rationale : undefined,
      evidenceRefs: normalizeStringArray(params.evidenceRefs),
      sourcePaths: normalizeStringArray(params.sourcePaths),
      sourceHash: typeof params.sourceHash === "string" ? params.sourceHash : undefined,
      sourceContent: typeof params.sourceContent === "string" ? params.sourceContent : undefined,
      dependsOn: normalizeStringArray(params.dependsOn),
      supersedes: normalizeStringArray(params.supersedes),
      supersededBy: normalizeStringArray(params.supersededBy),
      contradictedBy: normalizeStringArray(params.contradictedBy),
      tags: normalizeStringArray(params.tags),
      confidence: typeof params.confidence === "number" ? params.confidence : undefined,
    };
  }

  async function recordTaskLearningCandidate(
    cwd: string,
    task: Task,
    summary: string,
  ): Promise<Artifact<LearningRecord>> {
    return defaultLearningStore(cwd).record({
      title: `Candidate from @${task.name}: ${task.title}`,
      statement: summary,
      category: "workflow",
      scope: "project",
      status: "candidate",
      applicability: "Review this task-derived candidate before applying it to future Spark work.",
      evidenceRefs: [task.ref],
      tags: ["task-finish", task.kind],
      confidence: 0.4,
      sourceContent: [
        `Task: @${task.name}: ${task.title} (${task.ref})`,
        `Kind: ${task.kind}`,
        "",
        task.description,
        "",
        `Completion summary: ${summary}`,
      ].join("\n"),
    });
  }

  function compactLearningDetail(artifact: Artifact<LearningRecord>) {
    return {
      ref: artifact.ref,
      kind: artifact.kind,
      title: artifact.body.title,
      status: artifact.body.status,
      category: artifact.body.category,
      scope: artifact.body.scope,
      tags: artifact.body.tags,
      evidenceRefs: artifact.body.evidenceRefs,
      dependsOn: artifact.body.dependsOn,
      supersedes: artifact.body.supersedes,
      supersededBy: artifact.body.supersededBy,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    };
  }

  function compactLearningSearchResult(result: LearningSearchResult) {
    return {
      ref: result.ref,
      title: result.record.title,
      status: result.record.status,
      category: result.record.category,
      scope: result.record.scope,
      score: result.score,
      snippet: result.snippet,
      evidenceSummary: result.evidenceSummary,
    };
  }

  function formatLearningLine(artifact: Artifact<LearningRecord>): string {
    const tags = artifact.body.tags.length ? ` tags=${artifact.body.tags.join(",")}` : "";
    return `- [${artifact.body.status}/${artifact.body.category}/${artifact.body.scope}] ${artifact.ref}: ${artifact.body.title}${tags}`;
  }

  function formatLearningSearchLine(result: LearningSearchResult): string {
    const tags = result.record.tags.length ? ` tags=${result.record.tags.join(",")}` : "";
    return `- [${result.record.status}/${result.record.category}/${result.record.scope}] ${result.ref}: ${result.record.title} — ${result.snippet}${tags}`;
  }

  function renderLearningExportMarkdown(records: LearningRecord[]): string {
    const lines = [
      "---",
      "spark_learning_export_version: 1",
      `exported_at: ${nowIso()}`,
      `count: ${records.length}`,
      "---",
      "",
      "# Spark Learnings Export",
      "",
      "This file was generated by spark_learning_export_markdown. Import with spark_learning_import_markdown.",
      "",
    ];
    for (const record of records) {
      lines.push(
        `## ${record.title}`,
        "",
        "```json spark-learning",
        JSON.stringify(record, null, 2),
        "```",
        "",
      );
    }
    return lines.join("\n");
  }

  function parseLearningExportMarkdown(markdown: string): LearningRecord[] {
    const records: LearningRecord[] = [];
    const blockPattern = /```json spark-learning\n([\s\S]*?)```/g;
    for (const match of markdown.matchAll(blockPattern)) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      records.push(JSON.parse(raw) as LearningRecord);
    }
    return records;
  }

  interface ParsedLearningImport {
    source: "spark-export" | "legacy-compound-learnings";
    records: LearningRecord[];
    inputs: LearningRecordInput[];
  }

  async function parseLearningImportPath(
    cwd: string,
    inputPath: string,
  ): Promise<ParsedLearningImport> {
    const inputStat = await stat(inputPath);
    if (inputStat.isDirectory()) {
      const files = await collectLegacyLearningMarkdownFiles(inputPath);
      const inputs = [];
      for (const file of files)
        inputs.push(
          parseLegacyCompoundLearning(cwd, inputPath, file, await readFile(file, "utf8")),
        );
      return { source: "legacy-compound-learnings", records: [], inputs };
    }

    const markdown = await readFile(inputPath, "utf8");
    const records = parseLearningExportMarkdown(markdown);
    if (records.length > 0) return { source: "spark-export", records, inputs: [] };
    return {
      source: "legacy-compound-learnings",
      records: [],
      inputs: [parseLegacyCompoundLearning(cwd, dirname(inputPath), inputPath, markdown)],
    };
  }

  async function collectLegacyLearningMarkdownFiles(rootPath: string): Promise<string[]> {
    const categoryDirs = ["patterns", "gotchas", "decisions"];
    const files: string[] = [];
    for (const categoryDir of categoryDirs) {
      const dir = join(rootPath, categoryDir);
      try {
        await collectMarkdownFiles(dir, files);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return files.sort();
  }

  async function collectMarkdownFiles(dir: string, files: string[]): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) await collectMarkdownFiles(entryPath, files);
      else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
        files.push(entryPath);
    }
  }

  function parseLegacyCompoundLearning(
    cwd: string,
    rootPath: string,
    filePath: string,
    markdown: string,
  ): LearningRecordInput {
    const { frontmatter, body } = splitMarkdownFrontmatter(markdown);
    const sourcePath = displaySourcePath(cwd, filePath);
    const title = frontmatter.title ?? firstMarkdownHeading(body) ?? filenameTitle(filePath);
    const context = frontmatter.context;
    return {
      title,
      statement: context ?? firstMeaningfulMarkdownParagraph(body) ?? title,
      category: legacyLearningCategory(frontmatter.category, rootPath, filePath),
      scope: "project",
      status: "active",
      applicability: context ?? `Imported from legacy compound-learnings file ${sourcePath}.`,
      evidenceRefs: [sourcePath],
      sourcePaths: [sourcePath],
      sourceHash: contentHash(markdown),
      sourceContent: markdown,
      tags: parseLegacyTags(frontmatter.tags),
      confidence: 0.8,
    };
  }

  function splitMarkdownFrontmatter(markdown: string): {
    frontmatter: Record<string, string>;
    body: string;
  } {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
    if (!match) return { frontmatter: {}, body: markdown };
    return {
      frontmatter: parseSimpleFrontmatter(match[1] ?? ""),
      body: markdown.slice(match[0].length),
    };
  }

  function parseSimpleFrontmatter(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index < 0) continue;
      const key = line.slice(0, index).trim();
      if (!key) continue;
      result[key] = stripFrontmatterQuotes(line.slice(index + 1).trim());
    }
    return result;
  }

  function stripFrontmatterQuotes(value: string): string {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      return value.slice(1, -1);
    return value;
  }

  function parseLegacyTags(value: string | undefined): string[] {
    if (!value) return [];
    const trimmed = value.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return trimmed
        .slice(1, -1)
        .split(",")
        .map(stripFrontmatterQuotes)
        .map((tag) => tag.trim())
        .filter(Boolean);
    }
    return trimmed
      .split(/[,\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  function legacyLearningCategory(
    frontmatterCategory: string | undefined,
    rootPath: string,
    filePath: string,
  ): LearningCategory {
    const normalized = frontmatterCategory?.toLowerCase().trim();
    if (normalized === "pattern" || normalized === "patterns") return "pattern";
    if (normalized === "gotcha" || normalized === "gotchas") return "gotcha";
    if (normalized === "decision" || normalized === "decisions") return "decision";

    const segments = relative(rootPath, filePath).split(/[\\/]/);
    if (segments.includes("patterns")) return "pattern";
    if (segments.includes("gotchas")) return "gotcha";
    if (segments.includes("decisions")) return "decision";
    return "pattern";
  }

  function displaySourcePath(cwd: string, filePath: string): string {
    const relativePath = relative(cwd, filePath);
    return relativePath.startsWith("..") ? filePath : relativePath;
  }

  function firstMarkdownHeading(markdown: string): string | undefined {
    const heading = markdown
      .split(/\r?\n/)
      .find((line) => line.startsWith("# ") && line.slice(2).trim());
    return heading?.slice(2).trim();
  }

  function firstMeaningfulMarkdownParagraph(markdown: string): string | undefined {
    const paragraphs = markdown.split(/\r?\n\s*\r?\n/);
    for (const paragraph of paragraphs) {
      const normalized = paragraph
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("#") && !line.trim().startsWith("```"))
        .join(" ")
        .replace(/[`*_]/g, "")
        .trim();
      if (normalized) return normalized;
    }
    return undefined;
  }

  function filenameTitle(filePath: string): string {
    const filename = filePath.split(/[\\/]/).pop() ?? "learning.md";
    return filename.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
  }

  function truncateBlock(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }

  const registerSparkTool = (config: SparkRegisteredToolConfig): void => {
    pi.registerTool?.({
      ...config,
      description: withSparkToolOperationalNotes(config.name, config.description),
      renderCall: (args, theme, context) => renderSparkToolCall(config.name, args, theme, context),
    });
  };

  pi.registerCommand("spark", {
    description:
      "Enter the inferred Spark mode, or initialize a new Spark idea with /spark <idea>.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, { kind: "auto", prompt: args.trim() });
    },
  });

  pi.registerCommand("plan", {
    description:
      "Enter Spark planning mode directly, or initialize an existing non-empty project into planning mode.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "planning",
        prompt: args.trim(),
      });
    },
  });

  pi.registerCommand("execute", {
    description: "Enter Spark execution mode directly to execute one task, then stop.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "execution",
        prompt: args.trim(),
      });
    },
  });

  pi.registerCommand("run", {
    description:
      "Start Spark run mode with an inferred execution strategy; use /run-sequential or /run-parallel to be explicit.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "run_auto",
        prompt: args.trim(),
      });
    },
  });

  pi.registerCommand("run-sequential", {
    description:
      "Start Spark run mode to continuously execute ready tasks one at a time until done or blocked.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "run",
        prompt: args.trim(),
        runStrategy: "sequential",
      });
    },
  });

  pi.registerCommand("run-parallel", {
    description:
      "Start Spark run mode to continuously execute ready tasks in parallel until done or blocked.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "run",
        prompt: args.trim(),
        runStrategy: "parallel",
      });
    },
  });

  async function handleSparkEntryCommand(
    piApi: SparkExtensionAPI,
    ctx: SparkCommandContext,
    intent: SparkEntryIntent,
  ): Promise<void> {
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const projectState = await detectSparkProjectState(ctx.cwd, graph, ctx);
    const resolution = await resolveSparkEntry(ctx, intent, graph, projectState);
    await applySparkEntryResolution(piApi, ctx, graph, resolution);
  }

  async function resolveSparkEntry(
    ctx: SparkCommandContext,
    intent: SparkEntryIntent,
    graph: TaskGraph | null,
    projectState: SparkCommandProjectState,
  ): Promise<SparkEntryResolution> {
    if (!graph) return resolveSparkEntryWithoutGraph(ctx, intent, projectState);

    const mode =
      intent.kind === "direct"
        ? intent.mode
        : intent.kind === "run_auto"
          ? "run"
          : await chooseInitializedSparkMode(ctx, graph, projectState, intent.prompt);
    if (!mode) return { action: "none" };
    if (mode === "new_project") {
      const idea = intent.prompt || (await promptSparkNewProjectIdea(ctx));
      return idea
        ? { action: "initialize_new_project", idea, enterPlanning: true, planningSource: "auto" }
        : { action: "none" };
    }
    const runStrategy =
      mode === "run"
        ? intent.kind === "direct" && intent.runStrategy
          ? intent.runStrategy
          : await chooseSparkRunStrategy(ctx, graph, projectState, intent.prompt)
        : undefined;
    if (mode === "run" && !runStrategy) return { action: "none" };
    return {
      action: "enter_mode",
      mode,
      focus: intent.prompt || undefined,
      planningSource: intent.kind === "direct" && mode === "planning" ? "direct" : "auto",
      runStrategy,
    };
  }

  async function resolveSparkEntryWithoutGraph(
    ctx: SparkCommandContext,
    intent: SparkEntryIntent,
    projectState: SparkCommandProjectState,
  ): Promise<SparkEntryResolution> {
    if (projectState.kind === "empty_project") {
      if (intent.kind === "auto") {
        const idea = intent.prompt || (await promptSparkNewProjectIdea(ctx));
        return idea
          ? { action: "initialize_new_project", idea, enterPlanning: false, planningSource: "auto" }
          : { action: "none" };
      }
      const modeLabel = intent.kind === "direct" ? intent.mode : "run";
      return {
        action: "blocked",
        message:
          modeLabel === "planning"
            ? "Spark planning mode needs an existing project or a Spark idea. Use /spark <idea> to initialize an empty project."
            : `Spark ${modeLabel} mode needs initialized Spark state. Use /spark <idea> or /plan first.`,
      };
    }

    if (
      intent.kind === "run_auto" ||
      (intent.kind === "direct" && (intent.mode === "execution" || intent.mode === "run"))
    ) {
      const modeLabel = intent.kind === "direct" ? intent.mode : "run";
      return {
        action: "blocked",
        message: `Spark ${modeLabel} mode needs initialized Spark state. Use /spark <idea> or /plan first.`,
      };
    }

    const idea = intent.prompt || (await inferExistingProjectSparkIdea(ctx));
    return idea
      ? {
          action: "initialize_existing_project",
          idea,
          planningSource:
            intent.kind === "direct" && intent.mode === "planning" ? "direct" : "auto",
        }
      : { action: "none" };
  }

  async function applySparkEntryResolution(
    piApi: SparkExtensionAPI,
    ctx: SparkCommandContext,
    graph: TaskGraph | null,
    resolution: SparkEntryResolution,
  ): Promise<void> {
    switch (resolution.action) {
      case "initialize_new_project":
        await startSparkNewProject(piApi, ctx, resolution.idea, {
          enterPlanning: resolution.enterPlanning,
          planningSource: resolution.planningSource,
        });
        return;
      case "initialize_existing_project":
        await startSparkNewProject(piApi, ctx, resolution.idea, {
          enterPlanning: true,
          planningSource: resolution.planningSource,
          materializeSparkMd: resolution.planningSource !== "direct",
        });
        return;
      case "enter_mode":
        if (!graph) {
          ctx.ui?.notify?.("Spark mode needs initialized Spark state.", "warning");
          return;
        }
        if (resolution.mode === "planning")
          await enterSparkPlanningMode(
            piApi,
            ctx,
            graph,
            resolution.focus,
            resolution.planningSource,
          );
        else if (resolution.mode === "execution")
          await enterSparkExecutionMode(piApi, ctx, graph, resolution.focus);
        else
          await enterSparkRunMode(
            piApi,
            ctx,
            graph,
            resolution.focus,
            resolution.runStrategy ?? "sequential",
          );
        return;
      case "blocked":
        ctx.ui?.notify?.(resolution.message, "warning");
        return;
      case "none":
        return;
    }
  }

  async function detectSparkProjectState(
    cwd: string,
    graph: TaskGraph | null,
    ctx: SparkCommandContext,
  ): Promise<SparkCommandProjectState> {
    if (graph) {
      const thread = await currentSparkThread(cwd, ctx, graph);
      return {
        kind: "initialized",
        hasCurrentThread: Boolean(thread),
        unfinishedTaskCount: graph
          .tasks(thread?.ref)
          .filter((task) => isUnfinishedTaskStatus(task.status)).length,
      };
    }
    return {
      kind: (await hasNonSparkProjectFiles(cwd)) ? "existing_project" : "empty_project",
      hasCurrentThread: false,
      unfinishedTaskCount: 0,
    };
  }

  function analyzeSparkEntryMode(
    graph: TaskGraph,
    projectState: SparkCommandProjectState,
    prompt: string,
    selectedThread: { ref: ThreadRef; title: string } | undefined,
  ): SparkEntryModeAnalysis {
    const currentThreadTitle =
      selectedThread?.title ?? graph.threads()[0]?.title ?? "current Spark workspace";
    const tasks = graph.tasks(selectedThread?.ref);
    const pendingTaskCount = tasks.filter(
      (task) => task.status === "pending" || task.status === "ready",
    ).length;
    const readyTaskCount = graph.readyTasks(selectedThread?.ref).length;
    const normalizedPrompt = prompt.trim();
    const hasRunSignal =
      /(持续|连续|自动推进|一直做|跑完|直到完成|run\b|keep going|until done|continue until|work through)/i.test(
        normalizedPrompt,
      );
    const hasExecutionSignal =
      /(执行|运行|完成|继续做|认领|claim|execute|run ready|dispatch|work through|finish)/i.test(
        normalizedPrompt,
      );
    const hasPlanningSignal =
      /(计划|规划|调研|梳理|拆分|增加.*task|新增.*task|thread|plan|research|clarify|break down)/i.test(
        normalizedPrompt,
      );
    const hasNewProjectSignal = /(新项目|新想法|另一个|new project|new idea|start over)/i.test(
      normalizedPrompt,
    );
    const reasons = [
      `Current thread “${currentThreadTitle}” has ${projectState.unfinishedTaskCount} unfinished task(s).`,
      `Ready frontier has ${readyTaskCount} execution-ready task(s) out of ${pendingTaskCount} pending/ready task(s).`,
    ];
    if (normalizedPrompt) reasons.push(`Prompt: ${normalizedPrompt}`);
    if (hasNewProjectSignal && !hasPlanningSignal && !hasExecutionSignal && !hasRunSignal)
      return {
        recommendation: "new_project",
        confidence: "high",
        reasons: [...reasons, "The prompt asks to start a distinct Spark idea."],
        prompt: normalizedPrompt,
        currentThreadTitle,
        threadCount: graph.threads().length,
        unfinishedTaskCount: projectState.unfinishedTaskCount,
        readyTaskCount,
        pendingTaskCount,
      };
    if (hasRunSignal)
      return {
        recommendation: "run",
        confidence: "conflicting",
        reasons: [
          ...reasons,
          "The prompt asks for continuous or until-done progress, so Spark should ask before starting background run mode.",
        ],
        prompt: normalizedPrompt,
        currentThreadTitle,
        threadCount: graph.threads().length,
        unfinishedTaskCount: projectState.unfinishedTaskCount,
        readyTaskCount,
        pendingTaskCount,
      };
    if (hasPlanningSignal && hasExecutionSignal)
      return {
        recommendation: readyTaskCount > 0 ? "execution" : "planning",
        confidence: "conflicting",
        reasons: [
          ...reasons,
          "The prompt contains both planning and execution signals, so the mode needs confirmation.",
        ],
        prompt: normalizedPrompt,
        currentThreadTitle,
        threadCount: graph.threads().length,
        unfinishedTaskCount: projectState.unfinishedTaskCount,
        readyTaskCount,
        pendingTaskCount,
      };
    if (hasExecutionSignal)
      return {
        recommendation: "execution",
        confidence: "high",
        reasons: [...reasons, "The prompt asks to execute, claim, dispatch, run, or finish work."],
        prompt: normalizedPrompt,
        currentThreadTitle,
        threadCount: graph.threads().length,
        unfinishedTaskCount: projectState.unfinishedTaskCount,
        readyTaskCount,
        pendingTaskCount,
      };
    if (hasPlanningSignal)
      return {
        recommendation: "planning",
        confidence: "high",
        reasons: [
          ...reasons,
          "The prompt asks to plan, research, clarify, split, or organize tasks.",
        ],
        prompt: normalizedPrompt,
        currentThreadTitle,
        threadCount: graph.threads().length,
        unfinishedTaskCount: projectState.unfinishedTaskCount,
        readyTaskCount,
        pendingTaskCount,
      };
    if (!projectState.hasCurrentThread || projectState.unfinishedTaskCount === 0)
      return {
        recommendation: "planning",
        confidence: "high",
        reasons: [...reasons, "No active unfinished current-thread work needs execution."],
        prompt: normalizedPrompt,
        currentThreadTitle,
        threadCount: graph.threads().length,
        unfinishedTaskCount: projectState.unfinishedTaskCount,
        readyTaskCount,
        pendingTaskCount,
      };
    return {
      recommendation: readyTaskCount > 0 ? "execution" : "planning",
      confidence: "ambiguous",
      reasons: [
        ...reasons,
        normalizedPrompt
          ? "The prompt does not clearly choose planning or execution."
          : "Bare /spark in an initialized workspace should confirm the next mode.",
      ],
      prompt: normalizedPrompt,
      currentThreadTitle,
      threadCount: graph.threads().length,
      unfinishedTaskCount: projectState.unfinishedTaskCount,
      readyTaskCount,
      pendingTaskCount,
    };
  }

  async function startSparkNewProject(
    piApi: SparkExtensionAPI,
    ctx: SparkCommandContext,
    idea: string,
    options: {
      enterPlanning?: boolean;
      planningSource?: SparkPlanningModeSource;
      materializeSparkMd?: boolean;
    } = {},
  ): Promise<void> {
    const existing = await loadSparkGraph(ctx.cwd, ctx);
    if (existing) {
      ctx.ui?.notify?.(
        "Spark is already initialized for this workspace; entering planning mode instead.",
        "info",
      );
      await enterSparkPlanningMode(piApi, ctx, existing, idea, options.planningSource);
      return;
    }

    const language = detectCopyLanguage(idea);
    const workingTitle = titleFromIdea(idea);
    const outputLanguage: SparkCopyLanguage = language;
    const initAsk = maybeClarifySparkInit(ctx.cwd, idea, sparkAskUi(ctx));
    if (initAsk?.blocked) {
      ctx.ui?.notify?.(
        language === "zh"
          ? "Spark 初始化已暂停：clarification ask 未完成"
          : "Spark initialization paused: clarification ask was not completed",
        "warning",
      );
      return;
    }
    const clarification =
      initAsk?.clarification ??
      ({
        workingTitle,
        outputLanguage,
        objective: idea,
        nextAction: "analyze_then_targeted_ask",
      } satisfies SparkInitClarificationData);

    const result = await initializeSparkIdea(ctx.cwd, idea, {
      threadTitle: clarification.workingTitle ?? workingTitle,
      outputLanguage: clarification.outputLanguage ?? outputLanguage,
      clarification,
      askArtifactRefs: initAsk ? [initAsk.askArtifactRef] : undefined,
      askRefs: initAsk ? [initAsk.askRef] : undefined,
      materializeSparkMd: options.materializeSparkMd,
    });

    ctx.ui?.notify?.(
      language === "zh" ? "Spark 线程已初始化" : "Spark thread initialized",
      "success",
    );
    if (!options.enterPlanning) {
      dispatchSparkAgentInstruction(
        piApi,
        ctx,
        renderSparkInitFollowUp(result),
        renderSparkInitSummary(result),
      );
    }

    await saveCurrentThreadRef(ctx.cwd, ctx, result.threadRef as ThreadRef);
    await refreshSparkWidget(ctx.cwd, ctx);
    ensureSparkDagManager(ctx.cwd, ctx);

    if (options.enterPlanning) {
      const graph = await loadSparkGraph(ctx.cwd, ctx);
      if (graph) await enterSparkPlanningMode(piApi, ctx, graph, idea, options.planningSource);
    }
  }

  async function chooseInitializedSparkMode(
    ctx: SparkCommandContext,
    graph: TaskGraph,
    projectState: SparkCommandProjectState,
    prompt: string,
  ): Promise<SparkEntryModeChoice | undefined> {
    const thread = await currentSparkThread(ctx.cwd, ctx, graph);
    const analysis = analyzeSparkEntryMode(graph, projectState, prompt, thread);
    if (analysis.confidence === "high") return analysis.recommendation;

    const response = await runSparkAskTool(sparkModeAsk(analysis), {
      cwd: ctx.cwd,
      ui: sparkAskUi(ctx),
    });
    return sparkModeFromAskDetails(response.details);
  }

  async function chooseSparkRunStrategy(
    ctx: SparkCommandContext,
    graph: TaskGraph,
    projectState: SparkCommandProjectState,
    prompt: string,
  ): Promise<SparkRunStrategy | undefined> {
    const inferred = inferSparkRunStrategy(prompt);
    if (inferred) return inferred;

    const thread = await currentSparkThread(ctx.cwd, ctx, graph);
    const response = await runSparkAskTool(
      sparkRunStrategyAsk(graph, projectState, prompt, thread),
      {
        cwd: ctx.cwd,
        ui: sparkAskUi(ctx),
      },
    );
    return sparkRunStrategyFromAskDetails(response.details);
  }

  function inferSparkRunStrategy(prompt: string): SparkRunStrategy | undefined {
    const normalizedPrompt = prompt.trim();
    const hasParallelSignal =
      /(并行|同时|多任务|并发|parallel|concurrent|concurrency|at once|in parallel)/i.test(
        normalizedPrompt,
      );
    const hasSequentialSignal =
      /(顺序|串行|一个个|一个一个|逐个|依次|sequential|serial|one by one|one at a time)/i.test(
        normalizedPrompt,
      );
    if (hasParallelSignal && hasSequentialSignal) return undefined;
    if (hasParallelSignal) return "parallel";
    return "sequential";
  }

  async function inferExistingProjectSparkIdea(
    ctx: SparkCommandContext,
  ): Promise<string | undefined> {
    const idea = await ctx.ui?.input?.("What should Spark plan for this existing project?", "");
    const trimmed = idea?.trim();
    if (trimmed) return trimmed;
    ctx.ui?.notify?.(
      "Spark planning needs a concrete focus for this existing project. You can also run /spark <focus> or /plan <focus>.",
      "warning",
    );
    return undefined;
  }

  async function promptSparkNewProjectIdea(ctx: SparkCommandContext): Promise<string | undefined> {
    const idea = await ctx.ui?.input?.(
      "What new Spark project or idea should this workspace start?",
      "",
    );
    const trimmed = idea?.trim();
    if (trimmed) return trimmed;
    ctx.ui?.notify?.(
      "Spark new-project mode needs an idea. You can also run /spark <idea>.",
      "warning",
    );
    return undefined;
  }

  function dispatchSparkAgentInstruction(
    piApi: SparkExtensionAPI,
    ctx: SparkCommandContext,
    instruction: string,
    visibleMessage: string,
  ): void {
    queueSparkAgentInstruction(ctx, instruction);
    piApi.sendMessage(
      {
        customType: "spark-mode-request",
        content: visibleMessage,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  async function enterSparkPlanningMode(
    piApi: SparkExtensionAPI,
    ctx: SparkCommandContext,
    graph: TaskGraph,
    focus?: string,
    source: SparkPlanningModeSource = "auto",
  ): Promise<void> {
    const thread = await currentSparkThread(ctx.cwd, ctx, graph);
    if (thread) await saveSparkPlanningMode(ctx.cwd, ctx, thread.ref, focus, source);
    else await clearSparkExecutionMode(ctx.cwd, ctx);
    await refreshSparkWidget(ctx.cwd, ctx);
    ctx.ui?.notify?.("Spark planning mode: research, clarify, and add threads/tasks.", "info");
    const roadmapContext = await roadmapPlanningContext(ctx.cwd, focus);
    dispatchSparkAgentInstruction(
      piApi,
      ctx,
      renderSparkPlanningModePrompt(graph, thread?.ref, focus, roadmapContext, source),
      renderSparkModeVisibleMessage("planning", thread?.title, focus),
    );
  }

  async function enterSparkExecutionMode(
    piApi: SparkExtensionAPI,
    ctx: SparkCommandContext,
    graph: TaskGraph,
    focus?: string,
  ): Promise<void> {
    const thread = await currentSparkThread(ctx.cwd, ctx, graph);
    if (thread) await saveSparkExecutionMode(ctx.cwd, ctx, thread.ref, focus);
    else await clearSparkExecutionMode(ctx.cwd, ctx);
    await refreshSparkWidget(ctx.cwd, ctx);
    ctx.ui?.notify?.("Spark execution mode: execute one task, then stop.", "info");
    dispatchSparkAgentInstruction(
      piApi,
      ctx,
      renderSparkExecutionModePrompt(graph, thread?.ref, focus),
      renderSparkModeVisibleMessage("execution", thread?.title, focus),
    );
  }

  async function enterSparkRunMode(
    piApi: SparkExtensionAPI,
    ctx: SparkCommandContext,
    graph: TaskGraph,
    focus: string | undefined,
    strategy: SparkRunStrategy,
  ): Promise<void> {
    const thread = await currentSparkThread(ctx.cwd, ctx, graph);
    const runMode = thread
      ? await saveSparkRunMode(ctx.cwd, ctx, thread.ref, focus, strategy)
      : undefined;
    if (!thread) await clearSparkExecutionMode(ctx.cwd, ctx);
    await refreshSparkWidget(ctx.cwd, ctx);
    if (runMode) ensureSparkDagManager(ctx.cwd, ctx);
    ctx.ui?.notify?.(
      runMode
        ? `Spark run mode: ${strategy} background orchestrator ${runMode.runRef} started for current thread.`
        : "Spark run mode: select a thread before starting a background run.",
      "info",
    );
    piApi.sendMessage(
      {
        customType: "spark-mode-request",
        content: renderSparkModeVisibleMessage("run", thread?.title, focus, strategy),
        display: true,
        details: {
          runModeStarted: Boolean(runMode),
          runModeRef: runMode?.runRef,
          threadRef: thread?.ref,
          runStrategy: strategy,
          backgroundOrchestrator: runMode
            ? "started_or_resumed_without_agent_turn"
            : "thread_required",
        },
      },
      { deliverAs: "followUp", triggerTurn: false },
    );
  }

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
      format: Type.Optional(
        Type.String({
          default: "text",
          description:
            "text | json. text returns the human-readable status; json returns the structured status payload as JSON text for tool/LLM callers.",
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
      const format = normalizeSparkStatusFormat(params);
      const store = defaultTaskGraphStore(cwd);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph) {
        const details = { found: false, active: false, format };
        return {
          content: [
            {
              type: "text",
              text: format === "json" ? JSON.stringify(details, null, 2) : "No Spark thread found.",
            },
          ],
          details,
        };
      }
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
      const runMode = await loadSparkRunMode(cwd, ctx);
      const lines = [
        `Spark tasks (${view} view${typeof taskLimit === "number" ? `, limit=${taskLimit}` : ""}):`,
      ];
      if (runMode) lines.push(sparkRunModeStatusLine(runMode));
      if (view === "active") {
        const compactDagRun = appendCompactSparkDagStatusLines(lines, dagStatus);
        if (compactDagRun) {
          const label = compactDagRun.ref === dagStatus.activeRun?.ref ? "Active" : "Actionable";
          lines.push(`  ${label} DAG run: ${formatSparkDagRun(compactDagRun)}`);
          appendSparkDagRunNextStepLines(lines, compactDagRun, "  ");
        }
      } else if (view === "summary") {
        appendCompactSparkDagStatusLines(lines, dagStatus);
      } else appendSparkDagStatusLines(lines, dagStatus);
      const sessionKey = sparkSessionKey(ctx);
      const independentTodos = await loadIndependentTodos(cwd, ctx);
      const currentThread = await currentSparkThread(cwd, ctx, graph);
      const selectedThread = currentThread;
      const recentRoleRunCompletions =
        view === "summary"
          ? []
          : collectRecentRoleRunCompletions({
              graph,
              threadRef: selectedThread?.ref,
              limit: DEFAULT_SPARK_STATUS_RECENT_COMPLETIONS_LIMIT,
            });
      if (recentRoleRunCompletions.length > 0)
        appendRecentRoleRunCompletionLines(lines, recentRoleRunCompletions);
      if (view === "active" && !currentThread)
        lines.push(
          "\nSpark available: no thread selected for this session. Use spark_use_thread to select a thread, or use view=summary/full to inspect all threads.",
        );
      let renderedThreads = 0;
      const renderedThreadDetails: Array<Record<string, unknown>> = [];
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
            activeThreadRef: selectedThread?.ref,
            sessionClaimedCount: sessionClaimed.length,
          })
        )
          continue;
        renderedThreads += 1;
        const visibleTasks =
          typeof taskLimit === "number" ? allVisibleTasks.slice(0, taskLimit) : allVisibleTasks;
        const renderedTaskDetails: Array<Record<string, unknown>> = [];
        const lastRunsByTaskRef = latestRunsByTaskRef(graph.runs(thread.ref));
        const hiddenByView = tasks.length - allVisibleTasks.length;
        const hiddenByLimit = allVisibleTasks.length - visibleTasks.length;
        const currentSuffix = thread.ref === currentThread?.ref ? " [current]" : "";
        const isCurrent = thread.ref === currentThread?.ref;
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
        const renderedThreadDetail = {
          ref: thread.ref,
          title: thread.title,
          status: thread.status,
          current: isCurrent,
          taskCounts: {
            total: tasks.length,
            unfinished: tasks.filter((task) => isUnfinishedTaskStatus(task.status)).length,
            claimed: claimed.length,
            claimedBySession: sessionClaimed.length,
            statusCounts,
          },
          hiddenFinishedTasks: hiddenByView,
          hiddenByLimit,
          tasks: renderedTaskDetails,
        };
        if (view === "summary") {
          renderedThreadDetails.push(renderedThreadDetail);
          continue;
        }
        lines.push(view === "full" ? "  Durable tasks:" : "  Active tasks:");
        for (const task of visibleTasks) {
          const owner = deriveTaskRoleLabel({
            task,
            currentSessionKey: sessionKey,
            latestRun: lastRunsByTaskRef.get(task.ref),
          });
          const planSummary = taskPlanSummary(task);
          const planSuffix = planSummary ? ` plan=${planSummary}` : "";
          const lifecycleSuffix = taskLifecycleSuffix(task);
          const taskOwnedBySession = isClaimOwnedBySession(task, sessionKey);
          const taskTodos = taskOwnedBySession ? graph.taskTodos(task.ref) : [];
          const visibleTaskTodos =
            view === "active" ? taskTodos.slice(0, DEFAULT_SPARK_STATUS_TODO_LIMIT) : taskTodos;
          renderedTaskDetails.push({
            ref: task.ref,
            name: task.name,
            title: task.title,
            description: task.description,
            status: task.status,
            kind: task.kind,
            roleRef: task.roleRef,
            threadRef: task.threadRef,
            cancellation: task.cancellation,
            supersededBy: task.supersededBy,
            owner,
            claimed: taskClaimSummary(task),
            claimedByCurrentSession: taskOwnedBySession,
            plan: planSummary,
            todos: {
              total: taskTodos.length,
              hidden: taskTodos.length - visibleTaskTodos.length,
              items: visibleTaskTodos.map((todo) => ({
                id: todo.id,
                content: todo.content,
                status: todo.status,
                notes: todo.notes,
              })),
            },
          });
          if (view === "active") {
            lines.push(
              `  - [${task.status}] @${task.name}: ${task.title} owner=@${owner}${planSuffix}${lifecycleSuffix}`,
            );
            if (taskOwnedBySession) {
              for (const todo of visibleTaskTodos) {
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
            `  - [${task.status}] @${task.name}: ${task.title} (${task.ref}) kind=${task.kind} owner=@${owner} claimed=${taskClaimSummary(task)} todos=${taskSummary.total}/${taskSummary.inProgress}/${taskSummary.pending}/${taskSummary.done}${planSuffix}${lifecycleSuffix}`,
          );
          if (taskOwnedBySession) {
            for (const todo of visibleTaskTodos) {
              lines.push(`    - [${todo.status}] ${todo.id} ${todo.content}`);
            }
          }
        }
        if (visibleTasks.length === 0) lines.push("  - none");
        renderedThreadDetails.push(renderedThreadDetail);
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
      const independentTodoDetails = {
        total: displayedIndependentTodos.length,
        hidden: hiddenIndependentTodos,
        todos: visibleIndependentTodos.map((todo) => ({
          id: todo.id,
          content: todo.content,
          status: todo.status,
          notes: todo.notes,
        })),
      };
      const state =
        view === "full"
          ? await collectSparkStateHousekeeping(cwd, sparkStateSessionScopes(ctx), graph)
          : undefined;
      if (state) appendSparkStateHousekeepingLines(lines, state);
      const details = {
        found: true,
        format,
        view,
        limit: taskLimit,
        activeThreadRef: currentThread?.ref,
        renderedThreads: renderedThreadDetails,
        independentTodos: independentTodoDetails,
        threads: compactThreadStatusSummaries(graph, sessionKey),
        dag: dagStatus,
        runMode,
        recentRoleRunCompletions,
        ...(state ? { state } : {}),
      };
      return {
        content: [
          {
            type: "text",
            text: format === "json" ? JSON.stringify(details, null, 2) : lines.join("\n"),
          },
        ],
        details,
      };
    },
  });

  registerSparkTool({
    name: "spark_state",
    label: "Spark State",
    description:
      "Inspect or explicitly clean safe Spark session/cache state. action=status and action=diagnostics/doctor are read-only; action=cleanup defaults to dryRun=true and never deletes protected stores such as thread graph, artifacts, notes, role-reports, dag-runs, or review-gate. action=compact-role-run-artifacts previews or applies historical role-run transcript blob replacement and defaults to dry-run.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description:
            "status | diagnostics | doctor | cleanup | prune | compact-role-run-artifacts. status summarizes cache/protected stores; diagnostics/doctor reports protected-store candidates read-only; cleanup previews or deletes safe cache files; prune previews or applies typed DAG-run retention; compact-role-run-artifacts previews/applies role-run transcript blob replacement.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          default: true,
          description:
            "Preview deletions without removing files. Defaults to true for cleanup, prune, and compact-role-run-artifacts.",
        }),
      ),
      olderThanDays: Type.Optional(
        Type.Number({
          default: 30,
          description: "Staleness cutoff for cleanup candidates. Defaults to 30 days.",
        }),
      ),
      includeBroken: Type.Optional(
        Type.Boolean({
          default: false,
          description:
            "Also treat malformed cache JSON as cleanup candidates. Defaults to false so broken files are reported but not deleted unless explicitly requested.",
        }),
      ),
      thresholdBytes: Type.Optional(
        Type.Number({
          default: SPARK_STATE_LARGE_ARTIFACT_THRESHOLD_BYTES,
          description:
            "For action=compact-role-run-artifacts, only consider role-run/agent-run blobs at or above this byte size.",
        }),
      ),
      tailBytes: Type.Optional(
        Type.Number({
          default: SPARK_ROLE_RUN_RETENTION_TAIL_BYTES,
          description:
            "For action=compact-role-run-artifacts, retain this many bytes of serialized transcript tail in replacement metadata.",
        }),
      ),
      exportDir: Type.Optional(
        Type.String({
          description:
            "For action=compact-role-run-artifacts apply, copy each full transcript blob to this directory before deleting the in-store blob.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          default: SPARK_ROLE_RUN_RETENTION_RENDER_LIMIT,
          description:
            "For action=compact-role-run-artifacts, maximum candidate rows to render in text output.",
        }),
      ),
      keepRecent: Type.Optional(
        Type.Number({
          default: 10,
          description: "For action=prune, retain this many newest terminal DAG runs globally.",
        }),
      ),
      keepRecentPerThread: Type.Optional(
        Type.Number({
          default: 10,
          description: "For action=prune, retain this many newest terminal DAG runs per thread.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      await ensureSparkStateForActiveWorkspace(cwd, ctx);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false },
        };
      const action =
        typeof (params as { action?: unknown }).action === "string"
          ? (params as { action: string }).action
          : "status";
      if (action === "status") {
        const summary = await collectSparkStateHousekeeping(
          cwd,
          sparkStateSessionScopes(ctx),
          graph,
        );
        const lines = ["Spark state status:"];
        appendSparkStateHousekeepingLines(lines, summary);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { found: true, action, state: summary },
        };
      }
      if (action === "diagnostics" || action === "doctor") {
        const diagnostics = await collectSparkStateDiagnostics(cwd, graph);
        const lines = ["Spark state diagnostics (read-only):"];
        appendSparkStateDiagnosticsLines(lines, diagnostics);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { found: true, action, diagnostics },
        };
      }
      const dryRun = (params as { dryRun?: boolean }).dryRun ?? true;
      const olderThanDaysParam = (params as { olderThanDays?: number }).olderThanDays;
      const olderThanDays =
        typeof olderThanDaysParam === "number" && Number.isFinite(olderThanDaysParam)
          ? Math.max(0, olderThanDaysParam)
          : 30;
      if (action === "prune") {
        const dagRunStore = defaultSparkDagRunStore(cwd);
        const prune = await dagRunStore.pruneRuns({
          dryRun,
          olderThanDays,
          keepRecent: normalizeArtifactLimit((params as { keepRecent?: unknown }).keepRecent, 10),
          keepRecentPerThread: normalizeArtifactLimit(
            (params as { keepRecentPerThread?: unknown }).keepRecentPerThread,
            10,
          ),
          activeRunRefs: activeSparkRoleRunProcessesForCwd(cwd).map((process) => process.runRef),
        });
        const lines = [`Spark DAG run prune ${dryRun ? "dry-run" : "apply"}:`];
        appendSparkDagRunPruneLines(lines, prune);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { found: true, action, prune },
        };
      }
      if (action === "compact-role-run-artifacts") {
        const retention = await collectRoleRunArtifactRetentionPlan(cwd, {
          dryRun,
          thresholdBytes: normalizePositiveInteger(
            (params as { thresholdBytes?: unknown }).thresholdBytes,
            SPARK_STATE_LARGE_ARTIFACT_THRESHOLD_BYTES,
          ),
          tailBytes: normalizePositiveInteger(
            (params as { tailBytes?: unknown }).tailBytes,
            SPARK_ROLE_RUN_RETENTION_TAIL_BYTES,
          ),
          exportDir:
            typeof (params as { exportDir?: unknown }).exportDir === "string"
              ? (params as { exportDir: string }).exportDir
              : undefined,
        });
        const lines = [
          `Spark role-run artifact retention ${dryRun ? "dry-run" : "apply"}: ${dryRun ? "would replace" : "replaced"} ${retention.candidates.length} large transcript blob(s).`,
        ];
        appendRoleRunArtifactRetentionLines(
          lines,
          retention,
          normalizeArtifactLimit(
            (params as { limit?: unknown }).limit,
            SPARK_ROLE_RUN_RETENTION_RENDER_LIMIT,
          ),
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { found: true, action, retention },
        };
      }
      if (action !== "cleanup")
        return {
          content: [{ type: "text", text: `Unsupported spark_state action: ${action}` }],
          details: { found: true, action, error: "unsupported_action" },
        };
      const includeBroken = (params as { includeBroken?: boolean }).includeBroken ?? false;
      const plan = await collectSparkStateCleanupPlan(cwd, sparkStateSessionScopes(ctx), graph, {
        dryRun,
        olderThanDays,
        includeBroken,
      });
      if (!dryRun) {
        for (const candidate of plan.candidates)
          await rm(join(cwd, candidate.path), { force: true });
        plan.deleted = [...plan.candidates];
      }
      const actionLabel = dryRun ? "would delete" : "deleted";
      const lines = [
        `Spark state cleanup ${dryRun ? "dry-run" : "apply"}: ${actionLabel} ${plan.candidates.length} safe cache file(s).`,
      ];
      for (const candidate of plan.candidates)
        lines.push(
          `  - ${candidate.path} (${formatSparkStateCacheKind(candidate.kind)}: ${candidate.reason})`,
        );
      lines.push("Skipped cache files:");
      for (const skipped of plan.skipped)
        lines.push(`  - ${formatSparkStateCacheKind(skipped.kind)}: ${skipped.files}`);
      lines.push("Protected stores were not considered for cleanup:");
      for (const store of plan.protectedStores)
        lines.push(`  - ${formatSparkProtectedStoreReason(store.reason)}: ${store.path}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { found: true, action, cleanup: plan },
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

  registerSparkTool({
    name: "spark_finish_task",
    label: "Spark Finish Task",
    description:
      "Finish this session's claimed Spark task as done, failed, or cancelled. Defaults to the current claimed task and status=done.",
    parameters: Type.Object({
      task: Type.Optional(
        Type.String({
          description:
            "Claimed task ref, @name/name, title, or title prefix. Defaults to current claimed task.",
        }),
      ),
      status: Type.Optional(
        Type.String({ description: "done | failed | cancelled. Default: done." }),
      ),
      summary: Type.Optional(Type.String({ description: "Short completion/failure summary." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const p = params as { task?: string; status?: string; summary?: string };
      const status = normalizeSparkFinishStatus(p.status);
      const executionMode = await loadSparkExecutionMode(cwd, ctx);
      const store = defaultTaskGraphStore(cwd);
      let updated: Awaited<ReturnType<typeof store.update>>;
      try {
        updated = await store.update(
          async (graph) => {
            await sparkTodoStore(cwd, ctx).hydrate(graph);
            const thread = await currentSparkThread(cwd, ctx, graph);
            if (!thread) return { error: "no_thread" as const };
            const sessionKey = sparkSessionKey(ctx);
            const task = resolveSessionClaimedTask(graph, thread.ref, sessionKey, p.task);
            if (!task) return { error: "no_matching_claimed_task" as const };
            const finished = graph.setTaskStatus(task.ref, status);
            const completionReadiness =
              status === "done" ? taskCompletionReadiness(finished) : undefined;
            const nextReady = status === "done" ? graph.readyTasks(thread.ref)[0] : undefined;
            await sparkTodoStore(cwd, ctx).save(graph);
            return {
              task: finished,
              completionReadiness,
              threadRef: thread.ref,
              nextReady,
            };
          },
          { createIfMissing: false },
        );
      } catch (error) {
        if (error instanceof DependencyError) {
          return {
            content: [{ type: "text", text: `Cannot finish Spark task: ${error.message}` }],
            details: { found: true, error: "task_dependency_error", message: error.message },
          };
        }
        throw error;
      }
      const finishResult = updated.result as
        | { error: "no_thread" | "no_matching_claimed_task" }
        | {
            task: Task;
            completionReadiness?: TaskCompletionReadiness;
            threadRef: ThreadRef;
            nextReady?: Task;
          };
      if (!updated.graph || ("error" in finishResult && finishResult.error === "no_thread"))
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false },
        };
      if ("error" in finishResult && finishResult.error === "no_matching_claimed_task")
        return {
          content: [{ type: "text", text: "No matching claimed task for this session." }],
          details: { found: true, error: "no_matching_claimed_task" },
        };
      const finishedResult = finishResult as {
        task: Task;
        completionReadiness?: TaskCompletionReadiness;
        threadRef: ThreadRef;
        nextReady?: Task;
      };
      await refreshSparkWidget(cwd, ctx);
      const trimmedSummary = p.summary?.trim();
      const learningCandidate =
        status === "done" && trimmedSummary
          ? await recordTaskLearningCandidate(cwd, finishedResult.task, trimmedSummary)
          : undefined;
      const summarySuffix = trimmedSummary ? ` — ${truncateInline(trimmedSummary, 160)}` : "";
      const completionIssueSuffix =
        finishedResult.completionReadiness && !finishedResult.completionReadiness.ready
          ? `\nCompletion evidence warning: ${finishedResult.completionReadiness.issues
              .map((issue) => issue.message)
              .join("; ")}`
          : "";
      const candidateSuffix = learningCandidate
        ? `\nLearning candidate: ${learningCandidate.ref}`
        : "";
      const executionSuffix =
        executionMode?.threadRef === finishedResult.threadRef && status === "done"
          ? finishedResult.nextReady
            ? `\nExecution mode stopped after one task. Next ready task: @${finishedResult.nextReady.name}: ${finishedResult.nextReady.title}. Run /execute to take one more step, or /run to continue automatically.`
            : "\nExecution mode stopped after one task. No ready task remains; inspect blockers or finish the thread."
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Finished Spark task: [${finishedResult.task.status}] @${finishedResult.task.name}: ${finishedResult.task.title}${summarySuffix}${completionIssueSuffix}${candidateSuffix}${executionSuffix}`,
          },
        ],
        details: {
          task: compactTaskDetail(finishedResult.task),
          completionReadiness: finishedResult.completionReadiness,
          nextReadyTask: finishedResult.nextReady
            ? compactTaskDetail(finishedResult.nextReady)
            : undefined,
          learningCandidate: learningCandidate
            ? compactLearningDetail(learningCandidate)
            : undefined,
        },
      };
    },
  });

  registerSparkTool({
    name: "spark_list_threads",
    label: "Spark List Threads",
    description:
      "List Spark threads as structured JSON without parsing spark_status text. Parameters: status=active|done|all (default active). Example output item: { ref, title, status, taskCounts: { total, active, done, cancelled }, currentForSession }.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({
          default: "active",
          description: "active | done | all. Defaults to active.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const graph = await loadSparkGraph(cwd, ctx);
      const status = normalizeSparkThreadListStatus(params);
      if (!graph) {
        const details = { found: false, status, threads: [] };
        return { content: [{ type: "text", text: JSON.stringify([], null, 2) }], details };
      }
      const currentThread = await currentSparkThread(cwd, ctx, graph);
      const threads = graph
        .threads()
        .filter((thread) =>
          status === "all"
            ? true
            : status === "done"
              ? thread.status === "done"
              : thread.status !== "done",
        )
        .map((thread) => {
          const tasks = graph.tasks(thread.ref);
          return {
            ref: thread.ref,
            title: thread.title,
            status: thread.status,
            taskCounts: {
              total: tasks.length,
              active: tasks.filter((task) => isImportantStatus(task.status)).length,
              done: tasks.filter((task) => task.status === "done").length,
              cancelled: tasks.filter((task) => task.status === "cancelled").length,
            },
            currentForSession: currentThread?.ref === thread.ref,
          };
        });
      return {
        content: [{ type: "text", text: JSON.stringify(threads, null, 2) }],
        details: { found: true, status, threads },
      };
    },
  });

  registerSparkTool({
    name: "spark_claim_task",
    label: "Spark Claim Task",
    description:
      "Create or update a concrete Spark task for this session. For Spark-native delegated work, tasks may include an optional roleRef hint, but spark_run_ready_tasks assigns the concrete executor role at dispatch; do not spawn nested pi CLI sessions as pseudo-roles unless explicitly testing Pi CLI behavior.",
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
            "Optional builtin/project/user role spec id or ref from list_roles, e.g. planner or role:builtin-planner. This is a preferred executor hint; spark_run_ready_tasks can also assign a role at dispatch.",
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
          const thread = await currentSparkThread(cwd, ctx, graph);
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
                plan: normalizeToolTaskPlan(p.plan ?? existing.plan, description, title),
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
        details: {
          task: claimed.result.task as unknown as Record<string, unknown>,
        },
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
            : await currentSparkThread(cwd, ctx, graph);
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
      const currentThreadRef = await loadCurrentThreadRef(cwd, ctx);
      if (updated.result.thread.status === "done" && currentThreadRef === updated.result.thread.ref)
        await clearCurrentThreadRef(cwd, ctx);
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
      let created = false;
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
        const description = p.description?.trim() || title;
        const clarification = await clarifyThreadIntentIfNeeded({
          cwd,
          title,
          description,
          explicitThread: p.thread,
          ui: sparkAskUi(ctx),
        });
        thread = graph.createThread({
          title,
          description,
          outputLanguage:
            p.outputLanguage === "zh" || p.outputLanguage === "en" ? p.outputLanguage : undefined,
        });
        created = true;
        await store.save(graph);
        await saveThreadIntentTrace(cwd, thread.ref, clarification);
      }
      await saveCurrentThreadRef(cwd, ctx, thread.ref);
      await refreshSparkWidget(cwd, ctx);
      return {
        content: [
          {
            type: "text",
            text: `${created ? "Created new" : "Selected existing"} Spark thread for this session: ${thread.title} (${thread.ref})`,
          },
        ],
        details: { created, thread: thread as unknown as Record<string, unknown> },
      };
    },
  });

  async function saveThreadIntentTrace(
    cwd: string,
    threadRef: ThreadRef,
    clarification: Awaited<ReturnType<typeof clarifyThreadIntentIfNeeded>>,
  ): Promise<void> {
    if (!clarification.asked || !clarification.artifactRef) return;
    await defaultArtifactStore(cwd).put({
      kind: "run-trace",
      title: "Thread intent clarification",
      format: "json",
      body: {
        threadRef,
        askArtifactRef: clarification.artifactRef,
        summary: clarification.summary,
        blocked: clarification.blocked,
      } as unknown as JsonValue,
      provenance: { producer: "spark", threadRef, parentArtifactRefs: [clarification.artifactRef] },
    });
  }

  registerSparkTool({
    name: "spark_plan_tasks",
    label: "Spark Plan Tasks",
    description: [
      "Create or update multiple durable Spark tasks in the active thread from a concrete task plan. Tasks must be concrete executable/review/validation/research work, not standalone design/planning placeholders; design discussion belongs in conversation with the user and in each task.plan after decisions are clear. Use this dedicated spark-tasks-backed planning tool whenever the request requires durable task planning before assigning roles; it does not claim tasks for the current session. The tool writes directly after readiness checks pass, so clarify all planning-affecting questions before calling it and refine by calling it again with concrete updates.",
      "",
      SPARK_PLAN_TASKS_READINESS_RULES,
    ].join("\n"),
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          name: Type.Optional(
            Type.String({ description: "Stable simple @name handle for the task." }),
          ),
          title: Type.String({ description: "Human-readable task title shown as @name: title." }),
          description: Type.String({
            description:
              "Concrete task objective/instruction; do not use this for abstract design/planning placeholders.",
          }),
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
                "Optional builtin/project/user Spark role spec id or ref, e.g. scout, planner, reviewer, worker. This is a preferred executor hint, not a readiness requirement.",
            }),
          ),
          plan: Type.Optional(taskPlanSchema()),
          dependsOn: Type.Optional(
            Type.Array(
              Type.String({
                description:
                  "Dependency task ref, bare task name (displayed as @name), or exact task title in this plan/thread.",
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
      const roadmapContext = await roadmapPlanningContext(cwd);
      const tasks: TaskPlanInput[] = p.tasks.map((task) =>
        applyRoadmapHintsToTaskPlanInput(
          {
            name: task.name,
            title: task.title,
            description: task.description,
            kind: normalizeTaskKind(task.kind) ?? "generic",
            status: normalizeTaskStatus(task.status) ?? (task.roleRef ? "pending" : "proposed"),
            roleRef: task.roleRef?.trim() ? registry.select(task.roleRef.trim()).ref : undefined,
            plan: normalizeToolTaskPlan(task.plan, task.description, task.title),
            dependsOn: task.dependsOn,
            rationale: task.rationale,
          },
          roadmapContext?.item,
        ),
      );
      const concreteIssues = collectNonConcreteTaskIssues(tasks);
      if (concreteIssues.length > 0) {
        const lines = [
          "task_not_concrete: Spark tasks must be concrete executable/review/validation work, not standalone design/planning placeholders.",
          ...concreteIssues.map(
            (issue) => `- @${issue.name ?? "unnamed"}: ${issue.title} — ${issue.message}`,
          ),
          "Discuss design/architecture decisions with the user first, then embed the chosen design in each concrete task.plan.",
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { found: true, error: "task_not_concrete", issues: concreteIssues },
        };
      }
      let result: TaskPlanResult;
      try {
        result = graph.planTasks(thread.ref, tasks);
      } catch (error) {
        if (error instanceof DependencyError) {
          return {
            content: [{ type: "text", text: `Task plan dependency error: ${error.message}` }],
            details: { found: true, error: "task_dependency_error", message: error.message },
          };
        }
        throw error;
      }
      const changedForDecision = [...result.created, ...result.updated];
      const planDecisions = changedForDecision.map((task) =>
        decideTaskPlanBeforeCreate({ cwd, task, ui: sparkAskUi(ctx) }),
      );
      const rejectedIndex = planDecisions.findIndex((decision) => !decision.accepted);
      if (rejectedIndex >= 0) {
        const task = changedForDecision[rejectedIndex];
        const decision = planDecisions[rejectedIndex];
        const rejectionText = `Task plan not ready: @${task.name}: ${task.title}; revise the task plan with context-specific success criteria and evidence requirements before creating or updating it.`;
        return {
          content: [
            {
              type: "text",
              text: rejectionText,
            },
          ],
          details: {
            found: true,
            error: "task_plan_not_ready",
            result: compactTaskPlanResult(result),
            task: compactTaskDetail(task),
            planDecision: decision as unknown as Record<string, unknown>,
            planDecisions,
          },
        };
      }
      const changedRefs = [...result.created, ...result.updated].map((task) => task.ref);
      const updatedRoadmapItem = await attachRoadmapPlanningRefs(
        cwd,
        roadmapContext?.item.ref,
        thread.ref,
        changedRefs,
      );
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
      if (updatedRoadmapItem) lines.push(`- roadmap item updated: ${updatedRoadmapItem.ref}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          result: compactTaskPlanResult(result),
          planDecisions,
          roadmapItem: updatedRoadmapItem as unknown as Record<string, unknown> | undefined,
        },
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
          description:
            "Foreground wait budget in milliseconds for this tool call; active background role-runs continue after it expires.",
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
      const thread = await currentSparkThread(cwd, ctx, graph);
      if (!thread)
        return {
          content: [
            {
              type: "text",
              text: "No current Spark thread selected. Use spark_use_thread before running ready tasks.",
            },
          ],
          details: { found: false, error: "no_current_thread" },
        };
      const dryRun = params.dryRun !== false;
      const registry = new RoleRegistry();
      await defaultProjectRoleStore(cwd).hydrate(registry);
      if (!dryRun) {
        const bindingResult = await ensureRoleModelBindingsForThread({
          graph,
          threadRef: thread.ref,
          registry,
          cwd,
          ctx,
        });
        if (!bindingResult.ready) {
          return {
            content: [{ type: "text", text: bindingResult.message }],
            details: bindingResult as unknown as Record<string, unknown>,
          };
        }
        ensureSparkDagManager(cwd, ctx);
        ctx.ui?.notify?.(
          `Spark orchestrator started for “${thread.title}”. Progress appears in the Spark widget; inspect with spark_background_runs status.`,
          "info",
        );
        return {
          content: [
            {
              type: "text",
              text: `Spark orchestrator started for current thread “${thread.title}”. Progress appears in the Spark widget; inspect with spark_background_runs status, or stop explicit stuck child role-runs with spark_background_runs kill.`,
            },
          ],
          details: { orchestrator: "started", dryRun: false, threadRef: thread.ref },
        };
      }

      const artifactStore = defaultArtifactStore(cwd);
      const result = await runReadySparkTasks({
        graph,
        registry,
        artifactStore,
        cwd,
        threadRef: thread.ref,
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
      const timeoutSuffix = result.foregroundTimedOut
        ? " Foreground wait expired; active role-runs remain detached in the background."
        : "";
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
    name: "spark_background_runs",
    label: "Spark Background Runs",
    description:
      "Inspect and control user-facing Spark background work: list/status/inspect/kill/reconcile/ack active child role-runs, compact summaries, transcript refs/tail metadata, task claims, pids, run refs, and next actions.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description: "status | list | inspect | kill | reconcile | ack",
        }),
      ),
      runRef: Type.Optional(
        Type.String({ description: "DAG run ref or child role-run ref to inspect, kill, or ack." }),
      ),
      taskRef: Type.Optional(
        Type.String({
          description: "Task ref, @name, bare task name, or exact title to inspect or kill.",
        }),
      ),
      threadRef: Type.Optional(
        Type.String({
          description: "Optional thread filter; defaults to the current thread for status/list.",
        }),
      ),
      includeHistory: Type.Optional(
        Type.Boolean({
          description: "Include acknowledged and terminal recent runs in list/status output.",
        }),
      ),
      includeDetails: Type.Optional(
        Type.Boolean({ description: "Expand task/run records in text output." }),
      ),
      signal: Type.Optional(Type.String({ description: "Kill only; default SIGTERM." })),
      forceAfterMs: Type.Optional(
        Type.Number({ description: "Kill only; delay before force-kill scheduling." }),
      ),
      all: Type.Optional(
        Type.Boolean({
          description:
            "Kill only; required to kill all active children when no runRef/taskRef is provided.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph) {
        return {
          content: [
            { type: "text", text: "Spark background runs unavailable: no Spark task graph found." },
          ],
          details: { background: { error: "missing_task_graph" } },
        };
      }
      const dagRunStore = defaultSparkDagRunStore(cwd);
      const action = normalizeSparkBackgroundAction(params.action);
      const currentThread = await currentSparkThread(cwd, ctx, graph);
      const currentThreadRef = currentThread?.ref;
      const requestedThreadRef = normalizeOptionalThreadRef(params.threadRef);
      const scopeThreadRef = requestedThreadRef ?? currentThreadRef;
      const runRef = normalizeOptionalRunRef(params.runRef);
      const taskSelector = normalizeOptionalTaskSelector(params.taskRef);
      const taskRef = resolveBackgroundTaskRef(graph, taskSelector, scopeThreadRef);
      const runMode = await loadSparkRunMode(cwd, ctx);
      if (taskSelector && !taskRef) {
        const background = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          dagRunStore,
          currentThreadRef,
          threadRef: requestedThreadRef,
          runMode,
          includeHistory: Boolean(params.includeHistory),
          targetRunRef: runRef,
        });
        return {
          content: [{ type: "text", text: `Spark background task not found: ${taskSelector}` }],
          details: { background: { ...background, error: "task_not_found", taskSelector } },
        };
      }
      if (action === "status" || action === "list") {
        await reconcileSparkDagRunsWithActiveProcesses(dagRunStore, graph, cwd);
      }
      if (action === "reconcile") {
        const before = await dagRunStore.load();
        await reconcileSparkDagRunsWithActiveProcesses(dagRunStore, graph, cwd);
        const after = await dagRunStore.load();
        const changed = after.runs.filter((run) => {
          const previous = before.runs.find((candidate) => candidate.ref === run.ref);
          return (
            previous && (previous.status !== run.status || previous.completed !== run.completed)
          );
        });
        const background = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          dagRunStore,
          currentThreadRef,
          threadRef: requestedThreadRef,
          runMode,
          includeHistory: true,
          targetRunRef: runRef,
          targetTaskRef: taskRef,
        });
        const text = `${renderSparkBackgroundRunsText(background, { includeDetails: params.includeDetails === true })}\nReconciled background records changed: ${changed.length}`;
        return {
          content: [{ type: "text", text }],
          details: { background, changedDagRuns: changed },
        };
      }
      if (action === "kill") {
        if (!runRef && !taskRef && params.all !== true) {
          const background = await buildSparkBackgroundDetails({
            action,
            cwd,
            graph,
            dagRunStore,
            currentThreadRef,
            threadRef: requestedThreadRef,
            runMode,
            includeHistory: Boolean(params.includeHistory),
          });
          return {
            content: [
              {
                type: "text",
                text: "kill_requires_target: Provide runRef, taskRef, or all:true to kill background child role-runs.",
              },
            ],
            details: { background: { ...background, error: "kill_requires_target" } },
          };
        }
        const before = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          dagRunStore,
          currentThreadRef,
          threadRef: requestedThreadRef,
          runMode,
          includeHistory: true,
          targetRunRef: runRef,
          targetTaskRef: taskRef,
        });
        let targetRunRefs: RunRef[] = [];
        const dagTarget = runRef ? before.dagRuns.find((run) => run.runRef === runRef) : undefined;
        if (params.all === true && !runRef && !taskRef) {
          targetRunRefs = before.childRuns
            .filter((child) => child.activeProcess)
            .map((child) => child.runRef);
        } else if (dagTarget) {
          targetRunRefs = before.childRuns
            .filter((child) => child.activeProcess && child.dagRunRef === dagTarget.runRef)
            .map((child) => child.runRef);
        } else {
          targetRunRefs = before.childRuns
            .filter(
              (child) =>
                child.activeProcess &&
                (!runRef || child.runRef === runRef) &&
                (!taskRef || child.taskRef === taskRef),
            )
            .map((child) => child.runRef);
          if (runRef && targetRunRefs.length === 0) targetRunRefs = [runRef];
        }
        const killed = await killActiveSparkRoleRunProcesses({
          runRefs: targetRunRefs,
          signal: normalizeKillSignal(params.signal),
          forceAfterMs: normalizeForceAfterMs(params.forceAfterMs),
          reason: "spark_background_runs kill",
        });
        await reconcileSparkDagRunsWithActiveProcesses(dagRunStore, graph, cwd);
        const background = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          dagRunStore,
          currentThreadRef,
          threadRef: requestedThreadRef,
          runMode,
          includeHistory: true,
          targetRunRef: runRef,
          targetTaskRef: taskRef,
          killed,
        });
        return {
          content: [
            {
              type: "text",
              text: renderSparkBackgroundRunsText(background, {
                includeDetails: params.includeDetails === true,
              }),
            },
          ],
          details: { background },
        };
      }
      if (action === "ack") {
        await reconcileSparkDagRunsWithActiveProcesses(dagRunStore, graph, cwd);
        const snapshot = await dagRunStore.load();
        const acknowledged = await acknowledgeBackgroundDagRuns({
          dagRunStore,
          snapshot,
          sessionId: sparkSessionOwnerKey(ctx),
          threadRef: scopeThreadRef,
          runRef,
        });
        const background = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          dagRunStore,
          currentThreadRef,
          threadRef: requestedThreadRef,
          runMode,
          includeHistory: true,
          targetRunRef: runRef,
          targetTaskRef: taskRef,
          acknowledged,
        });
        return {
          content: [
            {
              type: "text",
              text: renderSparkBackgroundRunsText(background, {
                includeDetails: params.includeDetails === true,
              }),
            },
          ],
          details: { background },
        };
      }
      const background = await buildSparkBackgroundDetails({
        action,
        cwd,
        graph,
        dagRunStore,
        currentThreadRef,
        threadRef: requestedThreadRef,
        runMode,
        includeHistory: Boolean(params.includeHistory) || action === "inspect",
        targetRunRef: runRef,
        targetTaskRef: taskRef,
      });
      return {
        content: [
          {
            type: "text",
            text: renderSparkBackgroundRunsText(background, {
              includeDetails: params.includeDetails === true || action === "inspect",
            }),
          },
        ],
        details: { background },
      };
    },
  });

  registerSparkTool({
    name: "spark_dag_manager",
    label: "Spark Orchestrator Debug",
    description:
      "Low-level persisted Spark orchestrator compatibility/debug surface. Prefer spark_background_runs status/inspect/kill and spark_state prune for normal user-facing background work; kill_active targets child role-run processes, and timed_out is a legacy problem record.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description:
            "status | reconcile | ack | prune | clear_inactive | kill_active. Prefer spark_background_runs for user-facing background inspection and spark_state prune for retention.",
        }),
      ),
      runRef: Type.Optional(
        Type.String({
          description: "Optional DAG run ref for ack, or child run ref filter for kill_active.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          default: true,
          description: "For action=prune, preview deletions without writing by default.",
        }),
      ),
      olderThanDays: Type.Optional(
        Type.Number({
          default: 30,
          description:
            "For action=prune, only old terminal DAG runs older than this age are candidates.",
        }),
      ),
      keepRecent: Type.Optional(
        Type.Number({
          default: 10,
          description: "For action=prune, retain this many newest terminal DAG runs globally.",
        }),
      ),
      keepRecentPerThread: Type.Optional(
        Type.Number({
          default: 10,
          description: "For action=prune, retain this many newest terminal DAG runs per thread.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const graph = await loadSparkGraph(cwd, ctx);
      const dagRunStore = defaultSparkDagRunStore(cwd);
      const action = normalizeSparkDagManagerAction(params.action);
      const runRef = typeof params.runRef === "string" ? (params.runRef as RunRef) : undefined;
      let killed: Awaited<ReturnType<typeof killActiveSparkRoleRunProcesses>> = [];
      let acknowledged: Awaited<ReturnType<typeof dagRunStore.acknowledgeFailures>> | undefined;
      if (action === "kill_active") {
        killed = await killActiveSparkRoleRunProcesses({ runRef });
      }
      if (
        action === "reconcile" ||
        action === "status" ||
        action === "kill_active" ||
        action === "ack"
      ) {
        await dagRunStore.reconcile({
          graph: graph ?? undefined,
          activeRunRefs: listActiveSparkRoleRunProcesses().map((process) => process.runRef),
        });
      }
      if (action === "ack") {
        acknowledged = await dagRunStore.acknowledgeFailures({
          runRef,
          sessionId: sparkSessionOwnerKey(ctx),
        });
      }
      let prune: Awaited<ReturnType<typeof dagRunStore.pruneRuns>> | undefined;
      if (action === "prune") {
        prune = await dagRunStore.pruneRuns({
          dryRun: (params as { dryRun?: boolean }).dryRun ?? true,
          olderThanDays: normalizeArtifactLimit(
            (params as { olderThanDays?: unknown }).olderThanDays,
            30,
          ),
          keepRecent: normalizeArtifactLimit((params as { keepRecent?: unknown }).keepRecent, 10),
          keepRecentPerThread: normalizeArtifactLimit(
            (params as { keepRecentPerThread?: unknown }).keepRecentPerThread,
            10,
          ),
          activeRunRefs: activeSparkRoleRunProcessesForCwd(cwd).map((process) => process.runRef),
        });
      }
      if (action === "clear_inactive") await dagRunStore.clearInactiveRuns();
      const status = await dagRunStore.status({ limit: 10 });
      const lines = [
        `Spark orchestrator debug action=${action}`,
        "Low-level compatibility tool; prefer spark_background_runs status/inspect/kill for user-facing background work.",
      ];
      appendSparkDagStatusLines(lines, status);
      if (action === "ack" && acknowledged) {
        lines.push(
          `Acknowledged DAG problem runs: ${acknowledged.acknowledged.length} newly, ${acknowledged.alreadyAcknowledged.length} already, ${acknowledged.skipped.length} skipped, ${acknowledged.missing.length} missing`,
        );
      }
      if (action === "prune" && prune) appendSparkDagRunPruneLines(lines, prune);
      if (action === "kill_active")
        lines.push(`Killed active role-run processes: ${killed.length}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { action, dag: status, killed, acknowledged, prune },
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
      "When user-facing open questions or decision points would change task scope, dependencies, priorities, success criteria, evidence, architecture, dependency choices, or implementation order, turn them into a context-specific spark_ask instead of leaving them as prose.",
      "Each option needs a stable id, short label, and clear description explaining what choosing it means.",
      "Use freeform questions for notes/context instead of creating business options named Other or Type your own.",
      "Do not use generic or template intake questions; ask only questions grounded in the inspected situation whose answers would change the next action or plan.",
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
      flow: Type.Optional(
        Type.String({ description: "Stable flow identifier for this context-specific ask." }),
      ),
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

  registerSparkTool({
    name: "spark_learning_record",
    label: "Spark Learning Record",
    description:
      "Record one evidence-backed reusable learning as a local Spark artifact. Use export tools for sharing.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: "Stable learning id. Defaults to a content hash." }),
      ),
      title: Type.String({ description: "Short learning title." }),
      statement: Type.String({ description: "Reusable judgment or rule learned from evidence." }),
      category: Type.Optional(
        Type.String({ description: "pattern | gotcha | decision | workflow | tool | project" }),
      ),
      scope: Type.Optional(Type.String({ description: "global | project | thread | task" })),
      status: Type.Optional(
        Type.String({ description: "candidate | active | stale | superseded | rejected" }),
      ),
      applicability: Type.Optional(Type.String({ description: "When this learning applies." })),
      nonApplicability: Type.Optional(
        Type.String({ description: "When this learning should not apply." }),
      ),
      rationale: Type.Optional(Type.String({ description: "Why this learning is useful." })),
      evidenceRefs: Type.Optional(
        Type.Array(Type.String({ description: "Evidence refs or paths." })),
      ),
      sourcePaths: Type.Optional(Type.Array(Type.String({ description: "Source file paths." }))),
      sourceHash: Type.Optional(Type.String({ description: "Hash of imported source content." })),
      sourceContent: Type.Optional(
        Type.String({ description: "Original source Markdown content." }),
      ),
      dependsOn: Type.Optional(
        Type.Array(Type.String({ description: "Learning or fact refs this depends on." })),
      ),
      supersedes: Type.Optional(
        Type.Array(Type.String({ description: "Learning refs this replaces." })),
      ),
      contradictedBy: Type.Optional(
        Type.Array(Type.String({ description: "Refs that contradict this learning." })),
      ),
      tags: Type.Optional(Type.Array(Type.String({ description: "Search tags." }))),
      confidence: Type.Optional(Type.Number({ description: "Evidence confidence from 0 to 1." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultLearningStore(ctxCwd(ctx));
      const artifact = await store.record(normalizeLearningInput(params));
      return {
        content: [
          {
            type: "text",
            text: `Recorded learning ${artifact.ref} [${artifact.body.status}] ${artifact.body.title}`,
          },
        ],
        details: { learning: compactLearningDetail(artifact) },
      };
    },
  });

  registerSparkTool({
    name: "spark_learning_search",
    label: "Spark Learning Search",
    description:
      "Search local Spark learnings. Defaults to active learnings only; candidates are opt-in.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      status: Type.Optional(
        Type.Union([
          Type.String({ description: "Single learning status." }),
          Type.Array(Type.String({ description: "Learning status." })),
        ]),
      ),
      scope: Type.Optional(Type.String({ description: "global | project | thread | task" })),
      category: Type.Optional(
        Type.String({ description: "pattern | gotcha | decision | workflow | tool | project" }),
      ),
      tag: Type.Optional(Type.String({ description: "Filter by tag." })),
      includeCandidates: Type.Optional(Type.Boolean({ default: false })),
      includeInactive: Type.Optional(Type.Boolean({ default: false })),
      limit: Type.Optional(Type.Number({ description: "Maximum results. Default: 10." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultLearningStore(ctxCwd(ctx));
      const limit = normalizeArtifactLimit(params.limit, 10);
      const results = await store.search({
        query: typeof params.query === "string" ? params.query : "",
        status: normalizeLearningStatusFilter(params.status),
        scope: normalizeLearningScope(params.scope),
        category: normalizeLearningCategory(params.category),
        tag: typeof params.tag === "string" ? params.tag : undefined,
        includeCandidates: params.includeCandidates === true,
        includeInactive: params.includeInactive === true,
        limit,
      });
      const lines = [
        `Spark learnings: ${results.length} result(s)`,
        ...results.map(formatLearningSearchLine),
      ];
      if (results.length === 0) lines.push("- No matching learnings.");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: results.length, results: results.map(compactLearningSearchResult) },
      };
    },
  });

  registerSparkTool({
    name: "spark_learning_list",
    label: "Spark Learning List",
    description: "List local Spark learnings with compact metadata.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union([
          Type.String({ description: "Single learning status." }),
          Type.Array(Type.String({ description: "Learning status." })),
        ]),
      ),
      scope: Type.Optional(Type.String({ description: "global | project | thread | task" })),
      category: Type.Optional(
        Type.String({ description: "pattern | gotcha | decision | workflow | tool | project" }),
      ),
      tag: Type.Optional(Type.String({ description: "Filter by tag." })),
      includeCandidates: Type.Optional(Type.Boolean({ default: false })),
      includeInactive: Type.Optional(Type.Boolean({ default: false })),
      limit: Type.Optional(Type.Number({ description: "Maximum rows. Default: 20." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultLearningStore(ctxCwd(ctx));
      const limit = normalizeArtifactLimit(params.limit, 20);
      const artifacts = await store.list({
        status: normalizeLearningStatusFilter(params.status),
        scope: normalizeLearningScope(params.scope),
        category: normalizeLearningCategory(params.category),
        tag: typeof params.tag === "string" ? params.tag : undefined,
        includeCandidates: params.includeCandidates === true,
        includeInactive: params.includeInactive === true,
      });
      const visible = artifacts.slice(0, limit);
      const lines = [
        `Spark learnings: ${artifacts.length}${visible.length < artifacts.length ? ` (showing ${visible.length})` : ""}`,
        ...visible.map(formatLearningLine),
      ];
      if (visible.length === 0) lines.push("- No learnings.");
      if (visible.length < artifacts.length)
        lines.push(`- … ${artifacts.length - visible.length} more learning(s)`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: artifacts.length,
          shown: visible.length,
          learnings: visible.map(compactLearningDetail),
        },
      };
    },
  });

  registerSparkTool({
    name: "spark_learning_read",
    label: "Spark Learning Read",
    description: "Read one Spark learning by artifact ref or stable id.",
    parameters: Type.Object({
      ref: Type.String({ description: "Learning artifact ref or stable id." }),
      full: Type.Optional(Type.Boolean({ default: false })),
      maxChars: Type.Optional(
        Type.Number({ description: "Maximum JSON chars when full=false. Default: 4000." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultLearningStore(ctxCwd(ctx));
      const artifact = await store.get(typeof params.ref === "string" ? params.ref : "");
      const body = JSON.stringify(artifact.body, null, 2);
      const full = params.full === true;
      const maxChars = normalizeArtifactLimit(params.maxChars, 4_000);
      const renderedBody = full ? body : truncateBlock(body, maxChars);
      const truncated = !full && renderedBody.length < body.length;
      const lines = [
        `${artifact.ref} [${artifact.body.status}/${artifact.body.category}/${artifact.body.scope}] ${artifact.body.title}`,
        `updated=${artifact.updatedAt} evidence=${artifact.body.evidenceRefs.length}`,
        "",
        renderedBody,
      ];
      if (truncated)
        lines.push(
          "",
          `… truncated ${body.length - renderedBody.length} char(s); call full=true for the complete learning`,
        );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          learning: compactLearningDetail(artifact),
          bodyChars: body.length,
          shownChars: renderedBody.length,
          truncated,
        },
      };
    },
  });

  registerSparkTool({
    name: "spark_learning_mark_stale",
    label: "Spark Learning Mark Stale",
    description: "Mark one learning stale with an explicit reason.",
    parameters: Type.Object({
      ref: Type.String({ description: "Learning artifact ref or stable id." }),
      reason: Type.String({ description: "Why this learning is stale." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultLearningStore(ctxCwd(ctx));
      const artifact = await store.markStale(
        typeof params.ref === "string" ? params.ref : "",
        typeof params.reason === "string" ? params.reason : "",
      );
      return {
        content: [{ type: "text", text: `Marked stale ${artifact.ref}: ${artifact.body.title}` }],
        details: { learning: compactLearningDetail(artifact) },
      };
    },
  });

  registerSparkTool({
    name: "spark_learning_supersede",
    label: "Spark Learning Supersede",
    description: "Mark a learning superseded by one or more replacement learning refs.",
    parameters: Type.Object({
      ref: Type.String({ description: "Learning artifact ref or stable id to supersede." }),
      supersededBy: Type.Array(Type.String({ description: "Replacement learning ref." })),
      reason: Type.Optional(Type.String({ description: "Why it was superseded." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultLearningStore(ctxCwd(ctx));
      const artifact = await store.markSuperseded(
        typeof params.ref === "string" ? params.ref : "",
        normalizeStringArray(params.supersededBy) ?? [],
        typeof params.reason === "string" ? params.reason : undefined,
      );
      return {
        content: [
          { type: "text", text: `Marked superseded ${artifact.ref}: ${artifact.body.title}` },
        ],
        details: { learning: compactLearningDetail(artifact) },
      };
    },
  });

  registerSparkTool({
    name: "spark_learning_reject",
    label: "Spark Learning Reject",
    description: "Reject one learning candidate while keeping a traceable rejected record.",
    parameters: Type.Object({
      ref: Type.String({ description: "Learning candidate artifact ref or stable id." }),
      reason: Type.String({ description: "Why this candidate is rejected." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultLearningStore(ctxCwd(ctx));
      const artifact = await store.rejectCandidate(
        typeof params.ref === "string" ? params.ref : "",
        typeof params.reason === "string" ? params.reason : "",
      );
      return {
        content: [
          {
            type: "text",
            text: `Rejected learning candidate ${artifact.ref}: ${artifact.body.title}`,
          },
        ],
        details: { learning: compactLearningDetail(artifact) },
      };
    },
  });

  registerSparkTool({
    name: "spark_learning_export_markdown",
    label: "Spark Learning Export Markdown",
    description:
      "Export selected local Spark learnings to an explicit Markdown artifact/file for sharing or review.",
    parameters: Type.Object({
      outputPath: Type.Optional(
        Type.String({ description: "Optional path to write the Markdown export." }),
      ),
      status: Type.Optional(
        Type.Union([
          Type.String({ description: "Single learning status." }),
          Type.Array(Type.String({ description: "Learning status." })),
        ]),
      ),
      includeCandidates: Type.Optional(Type.Boolean({ default: false })),
      includeInactive: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const store = defaultLearningStore(cwd);
      const artifacts = await store.list({
        status: normalizeLearningStatusFilter(params.status),
        includeCandidates: params.includeCandidates === true,
        includeInactive: params.includeInactive === true,
      });
      const markdown = renderLearningExportMarkdown(artifacts.map((artifact) => artifact.body));
      const exportArtifact = await defaultArtifactStore(cwd).put({
        kind: "learning-export",
        title: "Spark learnings export",
        format: "markdown",
        body: markdown,
        provenance: { producer: "spark", note: "spark-learning explicit export" },
        links: artifacts.map((artifact) => ({
          to: artifact.ref,
          relation: "derived-from" as const,
        })),
      });
      const outputPath =
        typeof params.outputPath === "string" && params.outputPath.trim()
          ? resolve(cwd, params.outputPath)
          : undefined;
      if (outputPath) {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, markdown, "utf8");
      }
      const suffix = outputPath ? ` and wrote ${outputPath}` : "";
      return {
        content: [
          {
            type: "text",
            text: `Exported ${artifacts.length} learning(s) to ${exportArtifact.ref}${suffix}`,
          },
        ],
        details: {
          artifact: compactArtifactDetail(exportArtifact),
          outputPath,
          count: artifacts.length,
        },
      };
    },
  });

  registerSparkTool({
    name: "spark_learning_import_markdown",
    label: "Spark Learning Import Markdown",
    description:
      "Import Markdown produced by spark_learning_export_markdown, or legacy compound-learnings Markdown/.learnings directories. Dry-run by default; set apply=true to persist.",
    parameters: Type.Object({
      inputPath: Type.String({
        description:
          "Path to a Spark learnings export, legacy learning Markdown file, or .learnings directory.",
      }),
      apply: Type.Optional(Type.Boolean({ default: false })),
      deleteLegacyAfterVerifiedExport: Type.Optional(
        Type.Boolean({
          default: false,
          description:
            "When importing legacy compound-learnings with apply=true, write a verification export then delete the legacy source path.",
        }),
      ),
      verificationExportPath: Type.Optional(
        Type.String({ description: "Optional path for the verification export before deletion." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const inputPath = resolve(cwd, typeof params.inputPath === "string" ? params.inputPath : "");
      const parsed = await parseLearningImportPath(cwd, inputPath);
      const count = parsed.records.length + parsed.inputs.length;
      const apply = params.apply === true;
      const store = defaultLearningStore(cwd);
      const imported = [];
      if (apply) {
        for (const record of parsed.records) imported.push(await store.restore(record));
        for (const input of parsed.inputs) imported.push(await store.record(input));
      }
      const deleteLegacyAfterVerifiedExport = params.deleteLegacyAfterVerifiedExport === true;
      if (deleteLegacyAfterVerifiedExport && !apply)
        throw new Error("deleteLegacyAfterVerifiedExport requires apply=true");
      if (deleteLegacyAfterVerifiedExport && parsed.source !== "legacy-compound-learnings")
        throw new Error(
          "deleteLegacyAfterVerifiedExport only applies to legacy compound-learnings imports",
        );
      if (deleteLegacyAfterVerifiedExport && imported.length !== count)
        throw new Error(
          "refusing to delete legacy learnings because import count did not match parsed count",
        );
      let verificationExportArtifact: Artifact | undefined;
      let verificationExportPath: string | undefined;
      if (deleteLegacyAfterVerifiedExport) {
        const markdown = renderLearningExportMarkdown(imported.map((artifact) => artifact.body));
        verificationExportArtifact = await defaultArtifactStore(cwd).put({
          kind: "learning-export",
          title: "Legacy compound-learnings import verification export",
          format: "markdown",
          body: markdown,
          provenance: {
            producer: "spark",
            note: "spark-learning legacy import verification export",
          },
          links: imported.map((artifact) => ({
            to: artifact.ref,
            relation: "derived-from" as const,
          })),
        });
        verificationExportPath =
          typeof params.verificationExportPath === "string" && params.verificationExportPath.trim()
            ? resolve(cwd, params.verificationExportPath)
            : undefined;
        if (verificationExportPath) {
          await mkdir(dirname(verificationExportPath), { recursive: true });
          await writeFile(verificationExportPath, markdown, "utf8");
        }
        await rm(inputPath, { recursive: true, force: false });
      }
      const action = apply ? "Imported" : "Dry-run parsed";
      const deletionSuffix = deleteLegacyAfterVerifiedExport
        ? `; verification export ${verificationExportArtifact?.ref}; deleted legacy source`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `${action} ${count} learning(s) from ${inputPath} (${parsed.source})${deletionSuffix}`,
          },
        ],
        details: {
          inputPath,
          source: parsed.source,
          apply,
          count,
          imported: imported.map(compactLearningDetail),
          deletedLegacySource: deleteLegacyAfterVerifiedExport,
          verificationExportArtifact: verificationExportArtifact
            ? compactArtifactDetail(verificationExportArtifact)
            : undefined,
          verificationExportPath,
          records: [
            ...parsed.records.map((record) => ({
              id: record.id,
              title: record.title,
              status: record.status,
            })),
            ...parsed.inputs.map((input) => ({
              id: input.id,
              title: input.title,
              status: input.status ?? "active",
            })),
          ],
        },
      };
    },
  });

  registerSparkTool({
    name: "spark_list_artifacts",
    label: "Spark List Artifacts",
    description: "List Spark artifacts with a compact, bounded default view.",
    parameters: Type.Object({
      kind: Type.Optional(Type.String({ description: "Artifact kind filter, e.g. ask-answer." })),
      producer: Type.Optional(Type.String({ description: "Artifact provenance producer filter." })),
      threadRef: Type.Optional(Type.String({ description: "Filter by provenance thread ref." })),
      taskRef: Type.Optional(Type.String({ description: "Filter by provenance task ref." })),
      roleRef: Type.Optional(Type.String({ description: "Filter by provenance role ref." })),
      limit: Type.Optional(Type.Number({ description: "Maximum artifacts to show. Default: 20." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultArtifactStore(ctxCwd(ctx));
      const limit = normalizeArtifactLimit(params.limit, 20);
      const artifacts = await store.list({
        kind: normalizeArtifactKind(params.kind),
        producer: normalizeArtifactProducer(params.producer),
        threadRef: typeof params.threadRef === "string" ? params.threadRef : undefined,
        taskRef: typeof params.taskRef === "string" ? params.taskRef : undefined,
        roleRef: typeof params.roleRef === "string" ? params.roleRef : undefined,
      });
      const newest = artifacts.slice().reverse();
      const visible = newest.slice(0, limit);
      const lines = [
        `Spark artifacts: ${artifacts.length}${visible.length < artifacts.length ? ` (showing ${visible.length})` : ""}`,
      ];
      for (const artifact of visible)
        lines.push(`- [${artifact.kind}] ${artifact.ref}: ${artifact.title}`);
      if (visible.length < artifacts.length)
        lines.push(`- … ${artifacts.length - visible.length} more artifact(s)`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: artifacts.length,
          shown: visible.length,
          artifacts: visible.map(compactArtifactDetail),
        },
      };
    },
  });

  registerSparkTool({
    name: "spark_get_artifact",
    label: "Spark Get Artifact",
    description:
      "Read one Spark artifact. Defaults to metadata plus a truncated body; set full=true for the complete body.",
    parameters: Type.Object({
      artifactRef: Type.String({ description: "Artifact ref, e.g. artifact:<uuid>." }),
      full: Type.Optional(Type.Boolean({ default: false })),
      maxChars: Type.Optional(
        Type.Number({ description: "Maximum body chars when full=false. Default: 4000." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = defaultArtifactStore(ctxCwd(ctx));
      const artifactRef = params.artifactRef as ArtifactRef;
      const artifact = await store.get(artifactRef);
      const body = await store.getBody(artifactRef);
      const full = params.full === true;
      const maxChars = normalizeArtifactLimit(params.maxChars, 4_000);
      const renderedBody = full ? body : truncateBlock(body, maxChars);
      const truncated = !full && renderedBody.length < body.length;
      const lines = [
        `${artifact.ref} [${artifact.kind}] ${artifact.title}`,
        `format=${artifact.format} producer=${artifact.provenance.producer} updated=${artifact.updatedAt}`,
        "",
        renderedBody,
      ];
      if (truncated)
        lines.push(
          "",
          `… truncated ${body.length - renderedBody.length} char(s); call full=true for the complete artifact body`,
        );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          artifact: compactArtifactDetail(artifact),
          bodyChars: body.length,
          shownChars: renderedBody.length,
          truncated,
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
    : renderNoCurrentSparkThreadSummary(graph);
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

function renderNoCurrentSparkThreadSummary(graph: TaskGraph): string {
  const threads = graph.threads();
  const activeThreads = threads.filter((thread) => thread.status !== "done");
  return [
    "Spark available: no thread selected for this session.",
    `- Threads: ${threads.length} total / ${activeThreads.length} active`,
    "- Use spark_use_thread to select or create a current thread before planning, claiming, or updating thread-bound tasks.",
  ].join("\n");
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
        const spec = task.finishedBy?.roleRef ? shortRoleLabel(task.finishedBy.roleRef) : undefined;
        return spec ? `${owner}/${finishedRoleName}(spec:${spec})` : `${owner}/${finishedRoleName}`;
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

function shortRoleLabel(roleRef: string): string {
  return roleRef.replace(/^role:(builtin-|project-|user-)?/, "");
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
  await writeJsonFileAtomic(todoDisplayNumberStorePath(cwd, ctx), {
    version: 1,
    next: state.next,
    numbers: state.numbers,
  });
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
  await writeJsonFileAtomic(independentTodoStorePath(cwd, ctx), {
    version: 1,
    todos,
    updatedAt: nowIso(),
  });
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

function sparkStateSessionScopes(ctx: unknown): SparkStateSessionScopes {
  return {
    currentSessionScope: sanitizeStoreScope(sparkSessionKey(ctx)),
    currentOwnerScope: sanitizeStoreScope(sparkSessionOwnerKey(ctx)),
  };
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

async function hasNonSparkProjectFiles(cwd: string): Promise<boolean> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".spark" || entry.name === ".git") continue;
      if (entry.name === "node_modules" || entry.name === ".pi") continue;
      if (entry.name.startsWith(".DS_Store")) continue;
      const entryPath = join(cwd, entry.name);
      if (entry.isFile()) return true;
      if (entry.isDirectory()) {
        const info = await stat(entryPath).catch(() => undefined);
        if (info?.isDirectory()) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
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

interface SparkInitClarificationAskResult {
  askRef: AskRef;
  askArtifactRef: ArtifactRef;
  clarification: SparkInitClarificationData;
  blocked: boolean;
}

interface SparkInitOptions {
  threadTitle?: string;
  outputLanguage?: SparkCopyLanguage;
  clarification?: SparkInitClarificationData;
  sparkMd?: string;
  askArtifactRefs?: ArtifactRef[];
  askRefs?: AskRef[];
  materializeSparkMd?: boolean;
}

function maybeClarifySparkInit(
  cwd: string,
  idea: string,
  ui: ReturnType<typeof sparkAskUi>,
): SparkInitClarificationAskResult | undefined {
  void cwd;
  void idea;
  void ui;
  return undefined;
}

export function shouldClarifyBeforeInit(idea: string): boolean {
  void idea;
  return false;
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

  createInitialSparkTasks(graph, thread.ref, idea, options.clarification);

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
  const shouldWriteSparkMd =
    options.materializeSparkMd !== false && (await shouldMaterializeSparkMd(cwd));
  const sparkMdPath = shouldWriteSparkMd ? join(cwd, "SPARK.md") : undefined;
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
  await writeJsonFileAtomic(join(sparkDir, "review-gate.json"), gate);

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

function createInitialSparkTasks(
  graph: TaskGraph,
  threadRef: ThreadRef,
  idea: string,
  clarification?: SparkInitClarificationData,
): void {
  if (hasScopedClarification(clarification)) {
    const scopedClarification = clarification;
    const scope = graph.createTask({
      threadRef,
      name: "validate-scoped-intent",
      title: "Validate scoped intent",
      description: compactInstruction([
        scopedClarification.objective
          ? `Objective: ${scopedClarification.objective}`
          : `Idea: ${idea}`,
        scopedClarification.targetUser
          ? `Target user: ${scopedClarification.targetUser}`
          : undefined,
        scopedClarification.nonGoals ? `Non-goals: ${scopedClarification.nonGoals}` : undefined,
        "Check the workspace context and surface only blockers that change this confirmed scope.",
      ]),
      kind: "research",
      roleRef: builtinRoleRef("scout"),
    });
    const slice = graph.createTask({
      threadRef,
      name: "execute-smallest-slice",
      title: "Execute smallest confirmed slice",
      description: compactInstruction([
        scopedClarification.smallestSlice
          ? `Smallest slice: ${scopedClarification.smallestSlice}`
          : "Implement the smallest confirmed slice from the clarified scope.",
        scopedClarification.deliveryMode
          ? `Delivery mode: ${describeDeliveryMode(scopedClarification.deliveryMode, scopedClarification.outputLanguage ?? "en")}`
          : undefined,
        "Keep changes inside the confirmed non-goals boundary.",
      ]),
      kind: "implement",
      roleRef: builtinRoleRef("worker"),
    });
    const verify = graph.createTask({
      threadRef,
      name: "verify-success-signal",
      title: "Verify success signal",
      description: compactInstruction([
        scopedClarification.successSignal
          ? `Success signal: ${scopedClarification.successSignal}`
          : "Verify the implemented slice against the clarified objective.",
        "Report whether another ask, review gate, or follow-up task is needed.",
      ]),
      kind: "review",
      roleRef: builtinRoleRef("reviewer"),
    });
    graph.addDependency(slice.ref, scope.ref);
    graph.addDependency(verify.ref, slice.ref);
    return;
  }

  // No scoped clarification means Spark has not learned enough to create real tasks yet.
  // Leave the thread task-free; planning mode will inspect the workspace and call
  // spark_plan_tasks with concrete, plan-bound tasks instead of canned scaffolding.
}

function hasScopedClarification(
  clarification: SparkInitClarificationData | undefined,
): clarification is SparkInitClarificationData {
  return Boolean(
    clarification?.smallestSlice?.trim() ||
    clarification?.successSignal?.trim() ||
    clarification?.nonGoals?.trim() ||
    clarification?.targetUser?.trim(),
  );
}

function compactInstruction(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part?.trim())).join(" ");
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

function sparkModeAsk(analysis: SparkEntryModeAnalysis): SparkAskToolParams {
  const title = analysis.currentThreadTitle;
  const reasonLines = analysis.reasons.map((reason) => `- ${reason}`);
  return {
    mode: "decision",
    flow: "spark-command-mode",
    title: `Choose the next Spark mode for “${truncateInline(title, 80)}”`,
    context: [
      `Spark could not choose a high-confidence automatic route for this /spark turn because the signal is ${analysis.confidence}.`,
      `Current workspace context: ${analysis.threadCount} thread(s), ${analysis.unfinishedTaskCount} unfinished task(s) in the current thread, ${analysis.readyTaskCount} execution-ready task(s), ${analysis.pendingTaskCount} pending/ready task(s).`,
      ...reasonLines,
    ].join("\n"),
    questions: [
      {
        id: "mode",
        prompt: `For “${truncateInline(title, 80)}”, should this turn organize tasks, execute one task, or run continuously? Recommended: ${analysis.recommendation}.`,
        type: "single",
        required: true,
        options: [
          {
            id: "planning",
            label: `Plan “${truncateInline(title, 32)}”`,
            description: `Use planning mode now: inspect the ${analysis.unfinishedTaskCount} unfinished task(s), ask context-specific clarification or decision questions when they change the task plan, and add or refine concrete plan-bound tasks before execution.`,
          },
          {
            id: "execution",
            label: `Execute “${truncateInline(title, 32)}”`,
            description: `Use execution mode now: inspect the ${analysis.readyTaskCount} execution-ready task(s), then claim and complete at most one concrete task without broad replanning or continuous background progress.`,
          },
          {
            id: "run",
            label: `Run “${truncateInline(title, 32)}”`,
            description: `Use run mode now: start a background Spark run that continuously advances ready tasks until the work is done, blocked, cancelled, or needs a decision. The run strategy is inferred from the prompt; use /run-sequential or /run-parallel to be explicit.`,
          },
          {
            id: "new_project",
            label: `Start a different Spark idea`,
            description: `Do not continue “${truncateInline(title, 80)}”; ask for a distinct idea and initialize it as separate Spark project context.`,
          },
        ],
      },
    ],
  };
}

function sparkModeFromAskDetails(
  details: Record<string, unknown>,
): SparkEntryModeChoice | undefined {
  const modeAnswer = (details.answers as { mode?: { values?: unknown[] } } | undefined)?.mode;
  const value = modeAnswer?.values?.[0];
  return value === "new_project" || value === "planning" || value === "execution" || value === "run"
    ? value
    : undefined;
}

function sparkRunStrategyAsk(
  graph: TaskGraph,
  projectState: SparkCommandProjectState,
  prompt: string,
  selectedThread: { ref: ThreadRef; title: string } | undefined,
): SparkAskToolParams {
  const title = selectedThread?.title ?? graph.threads()[0]?.title ?? "current Spark workspace";
  const readyTaskCount = graph.readyTasks(selectedThread?.ref).length;
  const promptLine = prompt.trim() ? `\nPrompt: ${prompt.trim()}` : "";
  return {
    mode: "decision",
    flow: "spark-run-strategy",
    title: `Choose run strategy for “${truncateInline(title, 80)}”`,
    context: [
      `Spark run mode can either execute ready tasks one at a time or keep the existing parallel frontier scheduler.`,
      `Current workspace context: ${projectState.unfinishedTaskCount} unfinished task(s), ${readyTaskCount} execution-ready task(s).${promptLine}`,
    ].join("\n"),
    questions: [
      {
        id: "strategy",
        prompt: `How should Spark continuously run “${truncateInline(title, 80)}”?`,
        type: "single",
        required: true,
        options: [
          {
            id: "sequential",
            label: "Sequential",
            description:
              "Run ready tasks one at a time (maxConcurrency=1), continuing through newly unblocked work until done or blocked.",
          },
          {
            id: "parallel",
            label: "Parallel",
            description:
              "Use the existing parallel ready-frontier scheduler (default maxConcurrency=4), continuing until done or blocked.",
          },
        ],
      },
    ],
  };
}

function sparkRunStrategyFromAskDetails(
  details: Record<string, unknown>,
): SparkRunStrategy | undefined {
  const answer = (details.answers as { strategy?: { values?: unknown[] } } | undefined)?.strategy;
  const value = answer?.values?.[0];
  return value === "sequential" || value === "parallel" ? value : undefined;
}

function renderSparkPlanningModePrompt(
  graph: TaskGraph,
  selectedThreadRef: ThreadRef | undefined,
  focus: string | undefined,
  roadmapContext: RoadmapPlanningContext | undefined,
  source: SparkPlanningModeSource,
): string {
  const summary = renderExistingSparkSummary(graph, selectedThreadRef);
  const focusLine = focus?.trim() ? `\n\nPlanning focus: ${focus.trim()}` : "";
  const roadmapLine = renderRoadmapPlanningContext(roadmapContext);
  if (source === "direct") {
    return `${summary}${focusLine}${roadmapLine}\n\nEnter Spark planning mode from /plan. Treat this as a high-priority planning prompt, not as a permission gate and not as an answer-only research turn. First do a short context scan, then brainstorm the plan shape and keep clarifying until every material planning-affecting choice is either clear from inspected context or answered through context-specific spark_ask questions, including target thread selection, whether the user wants design options only or durable task planning, desired outcome, constraints, priority, scope, success evidence, architecture, dependency choices, and implementation order. Do not call spark_plan_tasks while those choices remain unresolved. If you are about to list user-facing open questions or decision points that would change the task plan, do not leave them as prose: group them into spark_ask questions first. Keep asks dynamic and grounded in the inspected context; do not use canned intake templates or ask questions whose answers would not change the task plan. Once planning-affecting uncertainty is resolved, call spark_plan_tasks directly to create or refine concrete plan-bound tasks with dependencies and evidence expectations. Refine plans by calling spark_plan_tasks again with concrete updates rather than using a separate dry-run/apply phase. Be strict: never create standalone “design”, “规划”, or “planning” tasks; discuss design/architecture with the user in this conversation first, then embed the chosen design, rationale, constraints, alternatives, and success evidence inside each concrete task.plan. Do not execute tasks yet unless the user explicitly asks to switch to execution.`;
  }
  return `${summary}${focusLine}${roadmapLine}\n\nEnter Spark planning mode. Research and clarify the project context first, then choose the lightest appropriate action from the actual request: answer directly for a simple research/read-and-comment turn, call spark_rename_thread when context shows the bootstrap title is only an action/request or a better project label is available, and call spark_plan_tasks only when there are concrete plan-bound tasks (executable/review/validation work) to organize; never create standalone design/planning tasks, and instead put confirmed design inside task.plan. Before generating or changing a durable plan, brainstorm the plan shape and keep clarifying through context-specific spark_ask questions until every material task-scope, dependency, priority, success-criteria, evidence, architecture, dependency-choice, or implementation-order uncertainty is resolved. Do not use generic intake templates. spark_plan_tasks writes directly after readiness checks pass; refine plans by calling it again with concrete updates rather than using a separate dry-run/apply phase. Do not execute tasks yet unless the user explicitly asks to switch to execution.`;
}

function renderSparkModeVisibleMessage(
  mode: SparkEntryMode,
  threadTitle: string | undefined,
  focus: string | undefined,
  runStrategy?: SparkRunStrategy,
): string {
  const title =
    mode === "planning"
      ? "Spark planning mode requested"
      : mode === "execution"
        ? "Spark execution mode requested"
        : "Spark run mode requested";
  const parts = [title];
  if (threadTitle?.trim()) parts.push(`thread: ${threadTitle.trim()}`);
  if (mode === "run" && runStrategy) parts.push(`strategy: ${runStrategy}`);
  if (focus?.trim()) parts.push(`focus: ${focus.trim()}`);
  return parts.join(" · ");
}

interface RoleModelBindingPreflightResult {
  ready: boolean;
  message: string;
  checkedRoleRefs: RoleRef[];
  boundRoleRefs: RoleRef[];
  missingRoleRefs: RoleRef[];
  error?: string;
}

async function ensureRoleModelBindingsForThread(input: {
  graph: TaskGraph;
  threadRef: ThreadRef;
  registry: RoleRegistry;
  cwd: string;
  ctx: SparkToolContext;
}): Promise<RoleModelBindingPreflightResult> {
  const roleRefs = uniqueRoleRefs(input.graph.readyTasks(input.threadRef).map(roleRefForSparkTask));
  const store = defaultUserRoleModelBindingStore();
  const boundRoleRefs: RoleRef[] = [];
  const missingRoleRefs: RoleRef[] = [];
  for (const roleRef of roleRefs) {
    const existing = await store.get(roleRef);
    if (existing) {
      boundRoleRefs.push(roleRef);
      continue;
    }
    const role = input.registry.get(roleRef) as RoleSpec;
    const selected = await input.ctx.ui?.input?.(
      `Choose Pi model for Spark role ${role.id}`,
      role.defaultModel,
    );
    const model = selected?.trim();
    if (!model) {
      missingRoleRefs.push(roleRef);
      continue;
    }
    try {
      await saveValidatedRoleModelBinding({
        store,
        roleRef,
        model,
        piCommand: "pi",
        cwd: input.cwd,
      });
      boundRoleRefs.push(roleRef);
      input.ctx.ui?.notify?.(`Saved model binding for Spark role ${role.id}: ${model}`, "success");
    } catch (error) {
      return {
        ready: false,
        message: `Model validation failed for ${role.id} (${roleRef}): ${error instanceof Error ? error.message : String(error)}`,
        checkedRoleRefs: roleRefs,
        boundRoleRefs,
        missingRoleRefs: [roleRef],
        error: "model_validation_failed",
      };
    }
  }
  if (missingRoleRefs.length > 0) {
    return {
      ready: false,
      message: `Spark role model binding required before dispatch: ${missingRoleRefs.join(", ")}. Rerun with an interactive UI or bind a concrete model for each role.`,
      checkedRoleRefs: roleRefs,
      boundRoleRefs,
      missingRoleRefs,
      error: "missing_role_model_binding",
    };
  }
  return {
    ready: true,
    message: `Spark role model bindings ready for ${boundRoleRefs.length} role(s).`,
    checkedRoleRefs: roleRefs,
    boundRoleRefs,
    missingRoleRefs: [],
  };
}

function roleRefForSparkTask(task: Task): RoleRef {
  return (task.roleRef ?? defaultRoleRefForSparkTaskKind(task.kind)) as RoleRef;
}

function defaultRoleRefForSparkTaskKind(kind: Task["kind"]): RoleRef {
  if (kind === "research") return builtinRoleRef("scout") as RoleRef;
  if (kind === "plan") return builtinRoleRef("planner") as RoleRef;
  if (kind === "review") return builtinRoleRef("reviewer") as RoleRef;
  return builtinRoleRef("worker") as RoleRef;
}

function uniqueRoleRefs(roleRefs: RoleRef[]): RoleRef[] {
  return [...new Set(roleRefs)].sort((a, b) => a.localeCompare(b));
}

function renderSparkExecutionModePrompt(
  graph: TaskGraph,
  selectedThreadRef: ThreadRef | undefined,
  focus: string | undefined,
): string {
  const summary = renderExistingSparkSummary(graph, selectedThreadRef);
  const focusLine = focus?.trim()
    ? `\n\nExecution focus: ${focus.trim()}\nUse this focus to filter ready tasks and pre-flight questions; do not auto-dispatch solely because a focus was provided.`
    : "";
  const action = selectedThreadRef
    ? "Read the current thread/task plan and inspect ready tasks with spark_status. Claim at most one concrete task with spark_claim_task, execute it, verify the required evidence, then call spark_finish_task. Stop after that task finishes; do not auto-claim another task or dispatch a continuous DAG run from /execute. If the user wants background progress through multiple tasks, suggest /run-sequential or /run-parallel (or /run for inferred strategy)."
    : "Select a current thread with spark_use_thread before claiming thread-bound work; use spark_status view=summary/full to inspect available threads first if needed.";
  return `${summary}${focusLine}\n\nEnter Spark execution mode. ${action}`;
}

function renderExistingSparkSummary(graph: TaskGraph, selectedThreadRef?: ThreadRef): string {
  const threads = graph.threads();
  const thread = selectedThreadRef
    ? threads.find((candidate) => candidate.ref === selectedThreadRef)
    : undefined;
  if (!thread) {
    const activeCount = threads.filter((candidate) => candidate.status !== "done").length;
    return [
      "Spark is already initialized; existing state was not overwritten.",
      "- Spark available: no thread selected for this session.",
      `- Threads: ${threads.length} total / ${activeCount} active`,
      "- Use spark_use_thread to select or create a current thread before planning or claiming thread-bound tasks.",
    ].join("\n");
  }
  return [
    "Spark is already initialized; existing state was not overwritten.",
    `- Current thread for this session: ${thread.title} (${thread.ref})`,
    `- Tasks: ${graph.tasks(thread.ref).length}`,
  ].join("\n");
}

function renderSparkInitFollowUp(result: SparkInitResult): string {
  const summary = renderSparkInitSummary(result);
  if (result.outputLanguage === "zh") {
    return [
      summary,
      "",
      "Spark 初始化只创建了最小本地状态；不要把自动线程标题当成最终项目命名。先按用户原始意图研究上下文并给出回应：如果阅读真实上下文后发现当前标题只是动作/请求复述，或已有更合适的项目标签，请用 spark_rename_thread 动态改名。只有在确实需要组织具体可执行工作时才调用 spark_plan_tasks；不要因为 Spark 刚初始化就创建任务。",
    ].join("\n");
  }
  return [
    summary,
    "",
    "Spark initialization only created minimal local state; do not treat the automatic thread title as the final project name. First research the context and respond to the user's original intent: if the inspected context shows the current title only repeats an action/request, or a better project label is available, call spark_rename_thread with that dynamic name. Call spark_plan_tasks only when there are concrete executable work items to organize; do not create tasks merely because Spark just initialized.",
  ].join("\n");
}

function renderSparkInitSummary(result: SparkInitResult): string {
  if (result.outputLanguage === "zh") {
    const lines = [
      "Spark 已初始化：",
      `- 想法：${result.idea}`,
      `- 初始线程标题：${result.threadTitle}`,
      result.sparkMdPath
        ? `- SPARK.md：${result.sparkMdPath}`
        : "- SPARK.md：未物化（intent 已保存为 spark-md artifact）",
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
    `- Initial thread title: ${result.threadTitle}`,
    result.sparkMdPath
      ? `- SPARK.md: ${result.sparkMdPath}`
      : "- SPARK.md: not materialized (intent saved as spark-md artifact)",
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
