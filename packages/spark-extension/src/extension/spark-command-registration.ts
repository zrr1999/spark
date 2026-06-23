import {
  LOOP_COMPLETION_BOUNDARY_GUIDANCE,
  createLoop,
  evaluateLoopTick,
  loopContinuationPrompt,
} from "@zendev-lab/pi-loop";
import { isUnfinishedTaskStatus, type TaskGraph } from "@zendev-lab/pi-tasks";
import { listBuiltinWorkflows } from "@zendev-lab/pi-workflows";
import { nowIso, type ProjectRef, type RunRef } from "@zendev-lab/pi-extension-api";
import type { SparkEntryIntent, SparkEntryMode } from "./spark-entry.ts";
import {
  applySparkEntryResolution,
  type SparkEntryApplicationDeps,
} from "./spark-entry-application.ts";
import { detectSparkProjectState, resolveSparkEntry } from "./spark-entry-resolution.ts";
import { currentSparkProject, loadSparkGraph, sparkSessionOwnerKey } from "./session-state.ts";
import { suggestForegroundGoalMode } from "./spark-foreground-goal-mode.ts";
import {
  requestGoalCompletionReview,
  type GoalCompletionReviewOutcome,
} from "./spark-goal-completion-review.ts";
import { startOrInferSessionGoal } from "./spark-goal-tool-registration.ts";
import {
  clearSessionGoal,
  loadSessionGoal,
  updateSessionGoalStatus,
  type SparkSessionGoal,
} from "./spark-session-goals.ts";
import {
  clearSessionLoop,
  loadSessionLoop,
  setSessionLoop,
  updateSessionLoopStatus,
  type SparkSessionLoop,
} from "./spark-session-loops.ts";
import {
  goalContextStrings,
  goalInstructions,
  goalNotifications,
  sparkLanguageForProject,
  type SparkLanguage,
} from "./spark-i18n.ts";
import {
  defaultSparkModeRegistry,
  renderSparkImplementationModePrompt,
  renderSparkModeVisibleMessage,
  resolveActiveMode,
} from "./mode/index.ts";
import { renderSparkGoalDriverModePrompt } from "./spark-mode-prompts.ts";
import {
  enterSparkUltracodeDriver,
  enterSparkWorkflowDriver,
  executeDynamicWorkflowNavigatorAction,
  publishDynamicWorkflowRunViews,
  type SparkWorkflowNavigatorAction,
} from "./spark-workflow-driver-entry.ts";
import { defaultSparkDynamicWorkflowEventStore } from "./spark-dynamic-workflow-event-store.ts";
import {
  buildSparkDynamicWorkflowDashboardView,
  renderSparkDynamicWorkflowDashboardText,
} from "./spark-dynamic-workflow-run-rendering.ts";

type SparkProjectLike = ReturnType<TaskGraph["projects"]>[number];
import type { ReviewerRunner } from "./reviewer-runner.ts";
import { isSparkReviewerLeaseActive } from "./spark-reviewer-lease.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";
import { isClaimOwnedBySession } from "./task-ownership.ts";

type SparkGoalLoopContext = SparkToolContext & {
  waitForIdle?: () => Promise<void>;
  setEditorText?: (text: string) => void;
};

export interface SparkCommandContext extends SparkGoalLoopContext {}

export interface SparkCommandApi {
  registerCommand(
    name: string,
    config: {
      description: string;
      argumentHint?: string;
      getArgumentCompletions?: (
        argumentPrefix: string,
      ) =>
        | Array<{ value: string; label: string; description?: string }>
        | null
        | Promise<Array<{ value: string; label: string; description?: string }> | null>;
      handler: (args: string, ctx: SparkCommandContext) => void | Promise<void>;
    },
  ): void;
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
  sendUserMessage?(
    content: string,
    options?: {
      deliverAs?: "steer" | "followUp" | "nextTurn";
      streamingBehavior?: "steer" | "followUp";
    },
  ): void;
}

interface SparkCommandRegistrationDeps extends SparkEntryApplicationDeps {
  createReviewerRunner?: (
    cwd: string,
    ctx: SparkToolContext,
  ) => ReviewerRunner | Promise<ReviewerRunner>;
}

const FOREGROUND_GOAL_LOOP_INTERVAL_MS = 30_000;
const FOREGROUND_GOAL_RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 120_000, 120_000] as const;
const FOREGROUND_GOAL_RETRY_BUDGET = 5;
const FOREGROUND_COMPACTION_GATE_STALE_MS = 30 * 60_000;
const foregroundGoalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const foregroundGoalAwaitingTurns = new Map<string, ForegroundGoalAwaitingTurn>();
const foregroundGoalLoopGenerations = new Map<string, number>();
const foregroundLoopTimers = new Map<string, ReturnType<typeof setTimeout>>();
const foregroundLoopAwaitingTurns = new Map<string, ForegroundLoopAwaitingTurn>();
const foregroundLoopGenerations = new Map<string, number>();
const foregroundCompactionGates = new Map<string, { startedAtMs: number }>();
const foregroundImplementAwaitingTurns = new Map<string, ForegroundImplementAwaitingTurn>();
const foregroundImplementGenerations = new Map<string, number>();

interface ForegroundGoalAwaitingTurn {
  piApi: SparkCommandApi;
  ctx: SparkGoalLoopContext;
  goalId: string;
  generation: number;
  startedAtMs: number;
  failure?: string;
}

interface ForegroundLoopAwaitingTurn {
  piApi: SparkCommandApi;
  ctx: SparkGoalLoopContext;
  loopId: string;
  generation: number;
  startedAtMs: number;
  failure?: string;
}

interface ForegroundImplementAwaitingTurn {
  piApi: SparkCommandApi;
  ctx: SparkGoalLoopContext;
  focus?: string;
  generation: number;
  startedAtMs: number;
  failure?: string;
}

function sendSparkRuntimeInstruction(
  piApi: SparkCommandApi,
  customType: "spark-goal-request" | "spark-loop-request",
  instruction: string,
  visible: string,
  details: Record<string, unknown> = {},
): void {
  piApi.sendMessage(
    {
      customType,
      content: instruction,
      display: false,
      details: { ...details, visible },
    },
    { deliverAs: "followUp", triggerTurn: true },
  );
}

export function registerSparkCommands(
  pi: SparkCommandApi,
  deps: SparkCommandRegistrationDeps,
): void {
  pi.on?.("session_start", async (_event, ctx) => {
    await clearStaleForegroundGoalRetryState(ctx);
    if (await loadActiveForegroundGoal(ctx)) {
      clearForegroundLoop(ctx.cwd, ctx);
      await scheduleForegroundGoalLoopIfActive(pi, ctx);
      return;
    }
    clearForegroundGoalLoop(ctx.cwd, ctx);
    await scheduleForegroundLoopIfActive(pi, ctx);
  });
  pi.on?.("session_before_compact", (event, ctx) => {
    markForegroundCompactionGate(pi, ctx, event);
  });
  pi.on?.("session_compact", async (_event, ctx) => {
    clearForegroundCompactionGate(ctx.cwd, ctx);
    await scheduleForegroundDriverIfActive(pi, ctx);
  });
  pi.on?.("session_shutdown", async (_event, ctx) => {
    clearForegroundGoalLoop(ctx.cwd, ctx);
    clearForegroundLoop(ctx.cwd, ctx);
    clearForegroundImplement(ctx.cwd, ctx);
    clearForegroundCompactionGate(ctx.cwd, ctx);
  });
  pi.on?.("input", (_event, ctx) => {
    clearForegroundGoalTimer(ctx.cwd, ctx);
    clearForegroundLoopTimer(ctx.cwd, ctx);
  });
  pi.on?.("turn_start", (_event, ctx) => {
    clearForegroundGoalTimer(ctx.cwd, ctx);
    clearForegroundLoopTimer(ctx.cwd, ctx);
  });
  pi.on?.("turn_end", async (event, ctx) => {
    handleForegroundGoalTurnEnd(ctx, event);
    handleForegroundLoopTurnEnd(ctx, event);
    handleForegroundImplementTurnEnd(ctx, event);
  });
  pi.on?.("agent_end", async (event, ctx) => {
    await handleForegroundGoalAgentEnd(pi, ctx, event);
    await handleForegroundLoopAgentEnd(pi, ctx, event);
    await handleForegroundImplementAgentEnd(pi, ctx, event);
  });
  pi.on?.("tool_execution_end", async (event, ctx) => {
    if (isGoalToolDeactivationEvent(event)) clearForegroundGoalLoop(ctx.cwd, ctx);
  });

  pi.registerCommand("plan", {
    description:
      "Enter Spark plan mode directly, or initialize an existing non-empty project into plan mode.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "plan",
        prompt: args.trim(),
      });
    },
  });

  pi.registerCommand("implement", {
    description:
      "Enter Spark implement mode: keep working through ready project tasks until blocked.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "implement",
        prompt: args.trim(),
      });
    },
  });

  pi.registerCommand("goal", {
    description: "Set or start the current session's durable Spark goal.",
    async handler(args, ctx) {
      await handleSparkGoalCommand(pi, ctx, args.trim());
    },
  });

  pi.registerCommand("loop", {
    description:
      "Start or continue an open-ended Spark loop driver; unlike /goal, this never requests reviewer-gated completion.",
    async handler(args, ctx) {
      await handleSparkLoopCommand(pi, ctx, args.trim());
    },
  });

  pi.registerCommand("workflow", {
    description:
      "Enter Spark workflow execution mode; accepts optional selector like builtin:foo, workspace:foo, or user:foo. Empty /workflow opens the blocking workflow navigator.",
    async handler(args, ctx) {
      const parsed = parseWorkflowCommandArgs(args);
      await handleSparkWorkflowCommand(pi, ctx, parsed);
    },
  });

  pi.registerCommand("workflows", {
    description:
      "Open the Spark workflow dashboard/navigator without requiring project state; shows dynamic runs and explicit controls.",
    async handler(args, ctx) {
      await handleSparkWorkflowCommand(pi, ctx, {
        focus: args.trim(),
        forceNavigator: true,
      });
    },
  });

  pi.registerCommand("workflow-runs", {
    description: "Show the live dynamic workflow run dashboard. Usage: /workflow-runs [runRef].",
    argumentHint: "[runRef]",
    async handler(args, ctx) {
      await handleSparkDynamicWorkflowDashboardCommand(ctx, args.trim());
    },
  });

  for (const action of ["inspect", "pause", "resume", "stop", "restart", "save", "ack"] as const) {
    pi.registerCommand(`workflow-${action}`, {
      description: `Dynamic workflow ${action}. Usage: /workflow-${action} <runRef>.`,
      argumentHint: "<runRef>",
      async handler(args, ctx) {
        await handleSparkDynamicWorkflowActionCommand(ctx, action, args.trim());
      },
    });
  }

  pi.registerCommand("ultracode", {
    description:
      "Opt into high-effort dynamic workflow generation and execution through workflow_run.",
    async handler(args, ctx) {
      await handleSparkUltracodeCommand(pi, ctx, args.trim());
    },
  });

  for (const workflow of listBuiltinWorkflows()) {
    pi.registerCommand("workflow:" + workflow.id, {
      description: `Enter Spark builtin workflow ${workflow.id}.`,
      async handler(args, ctx) {
        await handleSparkWorkflowCommand(pi, ctx, {
          selector: "builtin:" + workflow.id,
          focus: args.trim(),
        });
      },
    });
  }

  async function handleSparkDynamicWorkflowDashboardCommand(
    ctx: SparkCommandContext,
    args: string,
  ): Promise<void> {
    const store = defaultSparkDynamicWorkflowEventStore(ctx.cwd);
    await store.reconcileStale();
    const runRef = args ? parseDynamicWorkflowRunRefArg("workflow-runs", args) : undefined;
    const runs = await store.listRuns();
    publishDynamicWorkflowRunViews(ctx, runs);
    const text = renderSparkDynamicWorkflowDashboardText(
      buildSparkDynamicWorkflowDashboardView({
        action: "dashboard",
        runs,
        includeHistory: true,
        detailed: true,
        targetRunRef: runRef,
      }),
    );
    ctx.ui?.notify?.(text, "info");
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  }

  async function handleSparkDynamicWorkflowActionCommand(
    ctx: SparkCommandContext,
    action: SparkWorkflowNavigatorAction,
    args: string,
  ): Promise<void> {
    const runRef = parseDynamicWorkflowRunRefArg(`workflow-${action}`, args);
    await executeDynamicWorkflowNavigatorAction(ctx, deps, { dynamicAction: action, runRef });
  }

  function parseDynamicWorkflowRunRefArg(command: string, args: string): RunRef {
    const runRef = args.trim().split(/\s+/u)[0] ?? "";
    if (!/^run:[a-zA-Z0-9-]+$/u.test(runRef)) {
      throw new Error(`/${command} requires a runRef like run:<id>`);
    }
    return runRef as RunRef;
  }

  function parseWorkflowCommandArgs(args: string): { selector?: string; focus: string } {
    const trimmed = args.trim();
    if (!trimmed) return { focus: "" };
    const firstWhitespace = firstWhitespaceIndex(trimmed);
    const candidate = firstWhitespace < 0 ? trimmed : trimmed.slice(0, firstWhitespace);
    const rest = firstWhitespace < 0 ? "" : trimmed.slice(firstWhitespace + 1).trim();
    const separator = candidate.indexOf(":");
    if (separator < 0) return { focus: trimmed };
    const source = candidate.slice(0, separator);
    const id = candidate.slice(separator + 1);
    if ((source === "builtin" || source === "workspace" || source === "user") && isWorkflowId(id)) {
      return { selector: source + ":" + id, focus: rest };
    }
    return { focus: trimmed };
  }

  function parseGoalCommandArgs(args: string): string {
    return args.trim();
  }

  function parseLoopCommandAction(
    args: string,
  ): { action: "continue"; objective: string } | { action: "pause" } {
    const trimmed = args.trim();
    const normalized = trimmed.toLocaleLowerCase();
    if (["stop", "pause", "halt", "停止", "暂停", "停下"].includes(normalized)) {
      return { action: "pause" };
    }
    return { action: "continue", objective: trimmed };
  }

  function firstWhitespaceIndex(value: string): number {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index]?.trim() === "") return index;
    }
    return -1;
  }

  function isWorkflowId(value: string): boolean {
    if (!value) return false;
    const first = value[0];
    if (!first || !isLowerAlphaNumeric(first)) return false;
    for (const char of value.slice(1)) {
      if (!isLowerAlphaNumeric(char) && char !== "-") return false;
    }
    return true;
  }

  function isLowerAlphaNumeric(char: string): boolean {
    return (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
  }

  async function handleSparkEntryCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    intent: SparkEntryIntent,
  ): Promise<void> {
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const projectState = await detectSparkProjectState(ctx.cwd, graph, ctx);
    const resolution = await resolveSparkEntry(ctx, intent, graph, projectState);
    await applySparkEntryResolution(piApi, deps, ctx, graph, resolution);
    if (
      intent.kind === "direct" &&
      intent.mode === "implement" &&
      resolution.action === "enter_mode"
    ) {
      clearForegroundGoalLoop(ctx.cwd, ctx);
      delete ctx.askAutoAnswer;
      delete ctx.askAutoAnswerResolver;
      markForegroundImplementAwaitingTurn(piApi, ctx, resolution.focus);
    } else {
      clearForegroundImplement(ctx.cwd, ctx);
    }
  }

  async function handleSparkWorkflowCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    parsed: { selector?: string; focus: string; forceNavigator?: boolean },
  ): Promise<void> {
    clearForegroundImplement(ctx.cwd, ctx);
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    await enterSparkWorkflowDriver(piApi, deps, ctx, graph, parsed.focus, parsed.selector, {
      forceNavigator: parsed.forceNavigator,
    });
  }

  async function handleSparkUltracodeCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    focus: string,
  ): Promise<void> {
    clearForegroundImplement(ctx.cwd, ctx);
    clearForegroundGoalLoop(ctx.cwd, ctx);
    clearForegroundLoop(ctx.cwd, ctx);
    await enterSparkUltracodeDriver(piApi, deps, ctx, focus);
  }

  async function handleSparkLoopCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    rawArgs: string,
  ): Promise<void> {
    clearForegroundImplement(ctx.cwd, ctx);
    const loopAction = parseLoopCommandAction(rawArgs);
    const existingLoop = await loadSessionLoop(ctx.cwd, ctx);
    if (loopAction.action === "pause") {
      if (!existingLoop) {
        ctx.ui?.notify?.("No Spark loop is active.", "info");
        return;
      }
      clearForegroundLoop(ctx.cwd, ctx);
      const paused = await updateSessionLoopStatus(ctx.cwd, ctx, "paused", {
        reason: "Paused by /loop stop.",
        retryState: null,
        expectedLoopId: existingLoop.loopId,
      });
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      ctx.ui?.notify?.(
        `Spark loop paused: ${compactInline((paused ?? existingLoop).objective)}`,
        "info",
      );
      return;
    }

    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const project = graph ? await currentSparkProject(ctx.cwd, ctx, graph) : undefined;
    const existingGoal = await loadSessionGoal(ctx.cwd, ctx);
    const explicitObjective = loopAction.objective;
    const objective =
      explicitObjective ||
      existingLoop?.objective ||
      existingGoal?.objective ||
      project?.purpose ||
      project?.description ||
      project?.title ||
      "Continue Spark progress until blocked.";
    if (existingGoal) {
      clearForegroundGoalLoop(ctx.cwd, ctx);
      await clearSessionGoal(ctx.cwd, ctx);
    }
    const loop =
      existingLoop && !explicitObjective
        ? await updateSessionLoopStatus(ctx.cwd, ctx, "active", {
            retryState: null,
            expectedLoopId: existingLoop.loopId,
          })
        : await setSessionLoop(ctx.cwd, ctx, {
            objective,
            source: explicitObjective ? "explicit" : "inferred",
            status: "active",
          });
    if (!loop) return;
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    const projectLabel = project ? ` · project: ${project.title}` : "";
    const visible = `Spark loop active: ${compactInline(loop.objective)}${projectLabel}`;
    ctx.ui?.notify?.(visible, "info");
    await runForegroundLoopTick(piApi, ctx, {
      idleGateSatisfied: true,
      loopId: loop.loopId,
    });
  }

  async function handleSparkGoalCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    rawArgs: string,
  ): Promise<void> {
    clearForegroundImplement(ctx.cwd, ctx);
    const objective = parseGoalCommandArgs(rawArgs);
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const project = graph ? await currentSparkProject(ctx.cwd, ctx, graph) : undefined;
    const existingGoal = await loadSessionGoal(ctx.cwd, ctx);
    const language = sparkLanguageForProject({
      project,
      goal: existingGoal,
      fallbackText: objective,
    });
    const notifications = goalNotifications(language);
    if (existingGoal && existingGoal.status !== "complete") {
      const completedProject = graph
        ? completedProjectForInferredGoal(existingGoal, graph)
        : undefined;
      if (completedProject) {
        clearForegroundGoalLoop(ctx.cwd, ctx);
        if (objective.trim()) {
          const goal = await startOrInferSessionGoal(ctx.cwd, ctx, graph, objective);
          if (!goal) return;
          await clearSessionLoopForGoal(ctx);
          await deps.refreshSparkWidget(ctx.cwd, ctx);
          const projectLabel = project ? ` · project: ${project.title}` : "";
          const visible = notifications.goalActiveHeader(
            compactInline(goal.objective),
            projectLabel,
          );
          ctx.ui?.notify?.(notifications.staleReplaced, "info");
          await queueForegroundGoalStartInstruction(
            piApi,
            ctx,
            project?.title,
            goal,
            visible,
            language,
          );
          return;
        }
        await clearSessionGoal(ctx.cwd, ctx);
        await deps.refreshSparkWidget(ctx.cwd, ctx);
        ctx.ui?.notify?.(
          notifications.staleClearedFor(compactInline(completedProject.title)),
          "info",
        );
        return;
      }
      const goal =
        existingGoal.status === "active"
          ? existingGoal
          : await updateSessionGoalStatus(ctx.cwd, ctx, "active", {
              reason: "Goal restarted by /goal without changing the existing objective.",
              retryState: null,
            });
      if (!goal) return;
      await clearSessionLoopForGoal(ctx);
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      const projectLabel = project ? ` · project: ${project.title}` : "";
      const visible = notifications.goalContinuingHeader(
        compactInline(goal.objective),
        projectLabel,
      );
      ctx.ui?.notify?.(visible, "info");
      await runForegroundGoalLoopTick(piApi, ctx, {
        idleGateSatisfied: true,
        goalId: goal.goalId,
      });
      return;
    }
    if (!objective) {
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      const summary = renderEmptyGoalInferContext(graph, project, language);
      ctx.ui?.notify?.(notifications.noActiveGoal, "info");
      const instructions = goalInstructions(language);
      const instruction = [
        instructions.emptyGoalNotSet,
        instructions.emptyGoalReadContext,
        instructions.emptyGoalWriteHint,
        instructions.emptyGoalNoCounts,
        summary,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      sendSparkRuntimeInstruction(
        piApi,
        "spark-goal-request",
        instruction,
        notifications.inferDispatched,
        { purpose: "empty-goal-infer" },
      );
      return;
    }
    const goal = await startOrInferSessionGoal(ctx.cwd, ctx, graph, objective);
    if (!goal) return;
    await clearSessionLoopForGoal(ctx);
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    const projectLabel = project ? ` · project: ${project.title}` : "";
    const goalLanguage = sparkLanguageForProject({ project, goal, fallbackText: objective });
    const goalNotificationsForLang = goalNotifications(goalLanguage);
    const visible = goalNotificationsForLang.goalActiveHeader(
      compactInline(goal.objective),
      projectLabel,
    );
    ctx.ui?.notify?.(visible, "info");
    await queueForegroundGoalStartInstruction(
      piApi,
      ctx,
      project?.title,
      goal,
      visible,
      goalLanguage,
    );
  }

  function renderEmptyGoalInferContext(
    graph: TaskGraph | null,
    project: SparkProjectLike | undefined,
    language: SparkLanguage,
  ): string {
    const strings = goalContextStrings(language);
    if (!graph) return strings.notInitialized;
    const lines: string[] = [];
    if (project) {
      const tasks = graph.tasks(project.ref);
      const unfinished = tasks.filter((task) => isUnfinishedTaskStatus(task.status));
      const ready = graph.readyTasks(project.ref);
      lines.push(strings.currentProjectLine(project.title));
      lines.push(strings.unfinishedReadyLine(unfinished.length, ready.length));
      const readyTitles = ready.slice(0, 5).map((task) => task.title);
      if (readyTitles.length > 0) lines.push(strings.readyFrontierLine(readyTitles));
    } else {
      const projects = graph.projects();
      lines.push(strings.noActiveProject(projects.length));
      const projectTitles = projects.slice(0, 5).map((candidate) => candidate.title);
      if (projectTitles.length > 0) lines.push(strings.activeProjectCandidates(projectTitles));
    }
    return lines.join("\n");
  }

  function completedProjectForInferredGoal(
    goal: SparkSessionGoal,
    graph: TaskGraph,
  ): ReturnType<TaskGraph["projects"]>[number] | undefined {
    if (goal.source !== "inferred") return undefined;
    const projects = graph.projects();
    const candidate = projects.find((project) =>
      inferredGoalObjectiveMatchesProject(goal.objective, project),
    );
    if (!candidate) return undefined;
    const unfinished = graph
      .tasks(candidate.ref)
      .some((task) => isUnfinishedTaskStatus(task.status));
    return unfinished ? undefined : candidate;
  }

  function inferredGoalObjectiveMatchesProject(
    objective: string,
    project: SparkProjectLike,
  ): boolean {
    const normalized = normalizeGoalMatchText(objective);
    const title = normalizeGoalMatchText(project.title);
    const outcome =
      normalizeGoalMatchText(project.purpose) || normalizeGoalMatchText(project.description);
    const legacyTitleCandidates = [
      `Advance project “${title}”`,
      `Advance project "${title}"`,
      `Advance project '${title}'`,
    ];
    if (legacyTitleCandidates.some((candidate) => normalized.includes(candidate))) return true;
    const candidates = [
      `Achieve the intended outcome of “${title}”.`,
      `Achieve the intended outcome of "${title}".`,
      `Achieve the intended outcome of '${title}'.`,
      `实现“${title}”的预期成果。`,
      `实现"${title}"的预期成果。`,
      outcome
        ? `Achieve the intended project outcome: ${withGoalMatchPunctuation(outcome, ".")}`
        : undefined,
      outcome ? `实现项目预期成果：${withGoalMatchPunctuation(outcome, "。")}` : undefined,
    ].filter((item): item is string => Boolean(item));
    return candidates.some((candidate) => normalized === normalizeGoalMatchText(candidate));
  }

  function normalizeGoalMatchText(value: string | undefined): string {
    return value?.replaceAll(/\s+/gu, " ").trim() ?? "";
  }

  function withGoalMatchPunctuation(text: string, fallback: "." | "。"): string {
    return /[.!?。！？]$/u.test(text) ? text : `${text}${fallback}`;
  }

  async function clearSessionLoopForGoal(ctx: SparkGoalLoopContext): Promise<void> {
    clearForegroundLoop(ctx.cwd, ctx);
    if (await loadSessionLoop(ctx.cwd, ctx)) await clearSessionLoop(ctx.cwd, ctx);
  }

  async function queueForegroundGoalStartInstruction(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    projectTitle: string | undefined,
    goal: SparkSessionGoal,
    visible: string,
    language: SparkLanguage,
  ): Promise<void> {
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const project = graph ? await currentSparkProject(ctx.cwd, ctx, graph) : undefined;
    const instructions = goalInstructions(language);
    const selectedMode = graph
      ? resolveForegroundGoalMode(graph, project?.ref, goal.objective)
      : "plan";
    const instruction = [
      instructions.goalActiveHeader,
      projectTitle ? instructions.currentProject(projectTitle) : undefined,
      instructions.goalLine(goal.objective),
      instructions.pauseLineForeground,
      instructions.loopModeDecisionContract,
      instructions.loopReviewerOwnership,
      graph ? renderForegroundGoalModePrompt(graph, project?.ref, goal.objective) : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    sendSparkRuntimeInstruction(piApi, "spark-goal-request", instruction, visible, {
      goalId: goal.goalId,
      purpose: "foreground-goal-start",
      selectedMode,
    });
    markForegroundGoalAwaitingTurn(piApi, ctx, goal.goalId);
    if (!piApi.on)
      scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        goalId: goal.goalId,
      });
  }

  async function scheduleForegroundDriverIfActive(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
  ): Promise<void> {
    if (await loadActiveForegroundGoal(ctx)) {
      clearForegroundLoop(ctx.cwd, ctx);
      await scheduleForegroundGoalLoopIfActive(piApi, ctx);
      return;
    }
    clearForegroundGoalLoop(ctx.cwd, ctx);
    await scheduleForegroundLoopIfActive(piApi, ctx);
  }

  function markForegroundCompactionGate(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
    event: unknown,
  ): void {
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    foregroundCompactionGates.set(key, { startedAtMs: Date.now() });
    const signal = compactionAbortSignal(event);
    if (!signal) return;
    if (signal.aborted) {
      clearForegroundCompactionGate(ctx.cwd, ctx);
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearForegroundCompactionGate(ctx.cwd, ctx);
        void scheduleForegroundDriverIfActive(piApi, ctx).catch(reportGoalLoopError);
      },
      { once: true },
    );
  }

  function clearForegroundCompactionGate(cwd: string, ctx: SparkGoalLoopContext): void {
    foregroundCompactionGates.delete(foregroundGoalLoopKey(cwd, ctx));
  }

  function isForegroundCompactionGateActive(cwd: string, ctx: SparkGoalLoopContext): boolean {
    const key = foregroundGoalLoopKey(cwd, ctx);
    const gate = foregroundCompactionGates.get(key);
    if (!gate) return false;
    if (Date.now() - gate.startedAtMs > FOREGROUND_COMPACTION_GATE_STALE_MS) {
      foregroundCompactionGates.delete(key);
      return false;
    }
    return true;
  }

  async function scheduleForegroundGoalLoopIfActive(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
  ): Promise<void> {
    const active = await loadActiveForegroundGoal(ctx);
    if (!active) {
      clearForegroundGoalLoop(ctx.cwd, ctx);
      return;
    }
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    const awaiting = foregroundGoalAwaitingTurns.get(key);
    if (awaiting?.goalId === active.goal.goalId) return;
    scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
      goalId: active.goal.goalId,
    });
  }

  function scheduleForegroundGoalLoop(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
    delayMs = FOREGROUND_GOAL_LOOP_INTERVAL_MS,
    options: { idleGateSatisfied?: boolean; goalId?: string } = {},
  ): void {
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    const generation = nextForegroundGoalLoopGeneration(key);
    clearForegroundGoalLoop(ctx.cwd, ctx, { preserveGeneration: true });
    const timer = setTimeout(() => {
      if (foregroundGoalLoopGenerations.get(key) !== generation) return;
      foregroundGoalTimers.delete(key);
      void runForegroundGoalLoopTick(piApi, ctx, { ...options, generation }).catch(
        reportGoalLoopError,
      );
    }, delayMs);
    timer.unref?.();
    foregroundGoalTimers.set(key, timer);
  }

  function clearForegroundGoalTimer(cwd: string, ctx: SparkGoalLoopContext): void {
    const key = foregroundGoalLoopKey(cwd, ctx);
    const timer = foregroundGoalTimers.get(key);
    if (timer) clearTimeout(timer);
    foregroundGoalTimers.delete(key);
  }

  function clearForegroundGoalLoop(
    cwd: string,
    ctx: SparkGoalLoopContext,
    options: { preserveGeneration?: boolean } = {},
  ): void {
    const key = foregroundGoalLoopKey(cwd, ctx);
    clearForegroundGoalTimer(cwd, ctx);
    foregroundGoalAwaitingTurns.delete(key);
    if (!options.preserveGeneration) nextForegroundGoalLoopGeneration(key);
  }

  async function scheduleForegroundLoopIfActive(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
  ): Promise<void> {
    const active = await loadActiveForegroundLoop(ctx);
    if (!active) {
      clearForegroundLoop(ctx.cwd, ctx);
      return;
    }
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    const awaiting = foregroundLoopAwaitingTurns.get(key);
    if (awaiting?.loopId === active.loop.loopId) return;
    scheduleForegroundLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
      loopId: active.loop.loopId,
    });
  }

  function scheduleForegroundLoop(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
    delayMs = FOREGROUND_GOAL_LOOP_INTERVAL_MS,
    options: { idleGateSatisfied?: boolean; loopId?: string } = {},
  ): void {
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    const generation = nextForegroundLoopGeneration(key);
    clearForegroundLoop(ctx.cwd, ctx, { preserveGeneration: true });
    const timer = setTimeout(() => {
      if (foregroundLoopGenerations.get(key) !== generation) return;
      foregroundLoopTimers.delete(key);
      void runForegroundLoopTick(piApi, ctx, { ...options, generation }).catch(reportGoalLoopError);
    }, delayMs);
    timer.unref?.();
    foregroundLoopTimers.set(key, timer);
  }

  function clearForegroundLoopTimer(cwd: string, ctx: SparkGoalLoopContext): void {
    const key = foregroundGoalLoopKey(cwd, ctx);
    const timer = foregroundLoopTimers.get(key);
    if (timer) clearTimeout(timer);
    foregroundLoopTimers.delete(key);
  }

  function clearForegroundLoop(
    cwd: string,
    ctx: SparkGoalLoopContext,
    options: { preserveGeneration?: boolean } = {},
  ): void {
    const key = foregroundGoalLoopKey(cwd, ctx);
    clearForegroundLoopTimer(cwd, ctx);
    foregroundLoopAwaitingTurns.delete(key);
    if (!options.preserveGeneration) nextForegroundLoopGeneration(key);
  }

  function isGoalToolDeactivationEvent(event: unknown): boolean {
    if (!event || typeof event !== "object") return false;
    const toolEvent = event as { toolName?: unknown; isError?: unknown; params?: unknown };
    if (toolEvent.toolName !== "goal" || toolEvent.isError === true) return false;
    if (!toolEvent.params || typeof toolEvent.params !== "object") return false;
    const action = (toolEvent.params as { action?: unknown }).action;
    return action === "pause" || action === "clear";
  }

  function nextForegroundGoalLoopGeneration(key: string): number {
    const generation = (foregroundGoalLoopGenerations.get(key) ?? 0) + 1;
    foregroundGoalLoopGenerations.set(key, generation);
    return generation;
  }

  function nextForegroundLoopGeneration(key: string): number {
    const generation = (foregroundLoopGenerations.get(key) ?? 0) + 1;
    foregroundLoopGenerations.set(key, generation);
    return generation;
  }

  function nextForegroundImplementGeneration(key: string): number {
    const generation = (foregroundImplementGenerations.get(key) ?? 0) + 1;
    foregroundImplementGenerations.set(key, generation);
    return generation;
  }

  function clearForegroundImplement(cwd: string, ctx: SparkGoalLoopContext): void {
    const key = foregroundGoalLoopKey(cwd, ctx);
    foregroundImplementAwaitingTurns.delete(key);
    nextForegroundImplementGeneration(key);
  }

  function markForegroundGoalAwaitingTurn(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
    goalId: string,
  ): void {
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    const timer = foregroundGoalTimers.get(key);
    if (timer) clearTimeout(timer);
    foregroundGoalTimers.delete(key);
    const generation = nextForegroundGoalLoopGeneration(key);
    ctx.sparkAutonomousGoalTurn = { goalId };
    foregroundGoalAwaitingTurns.set(key, {
      piApi,
      ctx,
      goalId,
      generation,
      startedAtMs: Date.now(),
    });
  }

  function markForegroundLoopAwaitingTurn(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
    loopId: string,
  ): void {
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    const timer = foregroundLoopTimers.get(key);
    if (timer) clearTimeout(timer);
    foregroundLoopTimers.delete(key);
    const generation = nextForegroundLoopGeneration(key);
    foregroundLoopAwaitingTurns.set(key, {
      piApi,
      ctx,
      loopId,
      generation,
      startedAtMs: Date.now(),
    });
  }

  function markForegroundImplementAwaitingTurn(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
    focus?: string,
  ): void {
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    const generation = nextForegroundImplementGeneration(key);
    foregroundImplementAwaitingTurns.set(key, {
      piApi,
      ctx,
      focus,
      generation,
      startedAtMs: Date.now(),
    });
  }

  async function runForegroundGoalLoopTick(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
    options: { idleGateSatisfied?: boolean; goalId?: string; generation?: number } = {},
  ): Promise<void> {
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    if (
      options.generation !== undefined &&
      foregroundGoalLoopGenerations.get(key) !== options.generation
    )
      return;
    const initial = await loadActiveForegroundGoal(ctx);
    if (!initial || (options.goalId && initial.goal.goalId !== options.goalId)) return;
    if (isForegroundCompactionGateActive(ctx.cwd, ctx)) {
      scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        goalId: initial.goal.goalId,
      });
      return;
    }
    if (ctx.waitForIdle && !options.idleGateSatisfied) {
      await ctx.waitForIdle();
      const active = await loadActiveForegroundGoal(ctx);
      if (active && (!options.goalId || active.goal.goalId === options.goalId)) {
        scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
          idleGateSatisfied: true,
          goalId: active.goal.goalId,
        });
      }
      return;
    }
    if (ctx.isIdle?.() === false) {
      scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        idleGateSatisfied: false,
        goalId: initial.goal.goalId,
      });
      return;
    }
    if (isForegroundCompactionGateActive(ctx.cwd, ctx)) {
      scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        goalId: initial.goal.goalId,
      });
      return;
    }
    const active = await loadActiveForegroundGoal(ctx);
    if (!active || (options.goalId && active.goal.goalId !== options.goalId)) return;
    if (isSparkReviewerLeaseActive(ctx.cwd, ctx)) {
      scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        goalId: active.goal.goalId,
      });
      return;
    }
    const { project, goal } = active;
    const loopTick = evaluateLoopTick({ loop: createLoop(goal.objective), reason: "idle" });
    if (loopTick.decision !== "continue" || !loopTick.loop) {
      ctx.ui?.notify?.(`Spark goal loop did not continue: ${loopTick.message}`, "info");
      return;
    }
    const shouldContinue = await reviewActiveForegroundGoal(ctx, active);
    if (!shouldContinue) return;
    if (isForegroundCompactionGateActive(ctx.cwd, ctx)) {
      scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        goalId: active.goal.goalId,
      });
      return;
    }
    const projectLabel = project ? ` · project: ${project.title}` : "";
    const language = sparkLanguageForProject({ project, goal });
    const notifications = goalNotifications(language);
    const visible = notifications.goalTickHeader(compactInline(goal.objective), projectLabel);
    const selectedMode = active.graph
      ? resolveForegroundGoalMode(active.graph, project?.ref, goal.objective)
      : "plan";
    ctx.sparkActiveLens = { mode: selectedMode, driver: "goal" };
    const instruction = renderForegroundGoalTickInstruction(
      project?.title,
      goal.objective,
      active.graph,
      project,
      language,
      loopTick.loop,
    );
    sendSparkRuntimeInstruction(piApi, "spark-goal-request", instruction, visible, {
      goalId: goal.goalId,
      purpose: "foreground-goal-tick",
      selectedMode,
    });
    markForegroundGoalAwaitingTurn(piApi, ctx, goal.goalId);
  }

  async function runForegroundLoopTick(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
    options: { idleGateSatisfied?: boolean; loopId?: string; generation?: number } = {},
  ): Promise<void> {
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    if (
      options.generation !== undefined &&
      foregroundLoopGenerations.get(key) !== options.generation
    )
      return;
    const initial = await loadActiveForegroundLoop(ctx);
    if (!initial || (options.loopId && initial.loop.loopId !== options.loopId)) return;
    if (isForegroundCompactionGateActive(ctx.cwd, ctx)) {
      scheduleForegroundLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        loopId: initial.loop.loopId,
      });
      return;
    }
    if (ctx.waitForIdle && !options.idleGateSatisfied) {
      await ctx.waitForIdle();
      const active = await loadActiveForegroundLoop(ctx);
      if (active && (!options.loopId || active.loop.loopId === options.loopId)) {
        scheduleForegroundLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
          idleGateSatisfied: true,
          loopId: active.loop.loopId,
        });
      }
      return;
    }
    if (ctx.isIdle?.() === false) {
      scheduleForegroundLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        idleGateSatisfied: false,
        loopId: initial.loop.loopId,
      });
      return;
    }
    if (isForegroundCompactionGateActive(ctx.cwd, ctx)) {
      scheduleForegroundLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        loopId: initial.loop.loopId,
      });
      return;
    }
    const active = await loadActiveForegroundLoop(ctx);
    if (!active || (options.loopId && active.loop.loopId !== options.loopId)) return;
    const { project, loop } = active;
    const tick = evaluateLoopTick({ loop: createLoop(loop.objective), reason: "idle" });
    if (tick.decision !== "continue" || !tick.loop) {
      ctx.ui?.notify?.(`Spark loop did not continue: ${tick.message}`, "info");
      return;
    }
    if (isForegroundCompactionGateActive(ctx.cwd, ctx)) {
      scheduleForegroundLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        loopId: active.loop.loopId,
      });
      return;
    }
    const projectLabel = project ? ` · project: ${project.title}` : "";
    const visible = `Spark loop tick: ${compactInline(loop.objective)}${projectLabel}`;
    const selectedMode = active.graph
      ? resolveForegroundGoalMode(active.graph, project?.ref, loop.objective)
      : "plan";
    ctx.sparkActiveLens = { mode: selectedMode, driver: "goal" };
    const instruction = renderSparkLoopInstruction(
      loop.objective,
      active.graph,
      project,
      tick.loop,
    );
    sendSparkRuntimeInstruction(piApi, "spark-loop-request", instruction, visible, {
      loopId: loop.loopId,
      purpose: "foreground-loop-tick",
      selectedMode,
    });
    markForegroundLoopAwaitingTurn(piApi, ctx, loop.loopId);
  }

  function handleForegroundGoalTurnEnd(ctx: SparkToolContext, event: unknown): void {
    const failure = foregroundGoalTurnFailure(event);
    if (!failure) return;
    for (const [, awaiting] of foregroundGoalAwaitingTurnsForSession(ctx)) {
      awaiting.failure = failure;
    }
  }

  function handleForegroundLoopTurnEnd(ctx: SparkToolContext, event: unknown): void {
    const failure = foregroundGoalTurnFailure(event);
    if (!failure) return;
    for (const [, awaiting] of foregroundLoopAwaitingTurnsForSession(ctx)) {
      awaiting.failure = failure;
    }
  }

  async function handleForegroundGoalAgentEnd(
    piApi: SparkCommandApi,
    ctx: SparkToolContext,
    event: unknown,
  ): Promise<void> {
    const pending = foregroundGoalAwaitingTurnsForSession(ctx);
    if (pending.length === 0) {
      const agentOutcome = foregroundGoalAgentOutcome(event);
      if (!agentOutcome.failure && agentOutcome.hasAssistantMessage)
        await scheduleForegroundGoalLoopIfActive(piApi, ctx);
      return;
    }
    for (const [key, awaiting] of pending) {
      foregroundGoalAwaitingTurns.delete(key);
      if (awaiting.ctx.sparkAutonomousGoalTurn?.goalId === awaiting.goalId)
        delete awaiting.ctx.sparkAutonomousGoalTurn;
      if (foregroundGoalLoopGenerations.get(key) !== awaiting.generation) continue;
      const active = await loadActiveForegroundGoal(awaiting.ctx);
      if (!active || active.goal.goalId !== awaiting.goalId) continue;
      const agentOutcome = foregroundGoalAgentOutcome(event);
      const failure =
        agentOutcome.failure ?? (!agentOutcome.hasAssistantMessage ? awaiting.failure : undefined);
      if (failure) {
        if (isForegroundGoalAbortFailure(failure)) {
          await recordForegroundGoalAbortedTurn(awaiting.ctx, awaiting.goalId, failure);
          continue;
        }
        const retry = await recordForegroundGoalFailedTurn(awaiting.ctx, awaiting.goalId, failure);
        if (!retry.paused)
          scheduleForegroundGoalLoop(awaiting.piApi ?? piApi, awaiting.ctx, retry.delayMs, {
            goalId: awaiting.goalId,
          });
        continue;
      }
      const accounting = await recordForegroundGoalSuccessfulTurn(awaiting.ctx);
      await resetForegroundGoalRetryState(awaiting.ctx, accounting.goal ?? active.goal);
      scheduleForegroundGoalLoop(
        awaiting.piApi ?? piApi,
        awaiting.ctx,
        FOREGROUND_GOAL_LOOP_INTERVAL_MS,
        { goalId: awaiting.goalId },
      );
    }
  }

  async function handleForegroundLoopAgentEnd(
    piApi: SparkCommandApi,
    ctx: SparkToolContext,
    event: unknown,
  ): Promise<void> {
    const pending = foregroundLoopAwaitingTurnsForSession(ctx);
    if (pending.length === 0) {
      const agentOutcome = foregroundGoalAgentOutcome(event);
      if (!agentOutcome.failure && agentOutcome.hasAssistantMessage)
        await scheduleForegroundLoopIfActive(piApi, ctx);
      return;
    }
    for (const [key, awaiting] of pending) {
      foregroundLoopAwaitingTurns.delete(key);
      if (foregroundLoopGenerations.get(key) !== awaiting.generation) continue;
      const active = await loadActiveForegroundLoop(awaiting.ctx);
      if (!active || active.loop.loopId !== awaiting.loopId) continue;
      const agentOutcome = foregroundGoalAgentOutcome(event);
      const failure =
        agentOutcome.failure ?? (!agentOutcome.hasAssistantMessage ? awaiting.failure : undefined);
      if (failure) {
        if (isForegroundGoalAbortFailure(failure)) {
          await recordForegroundLoopAbortedTurn(awaiting.ctx, awaiting.loopId, failure);
          continue;
        }
        const retry = await recordForegroundLoopFailedTurn(awaiting.ctx, awaiting.loopId, failure);
        if (!retry.paused)
          scheduleForegroundLoop(awaiting.piApi ?? piApi, awaiting.ctx, retry.delayMs, {
            loopId: awaiting.loopId,
          });
        continue;
      }
      await resetForegroundLoopRetryState(awaiting.ctx, active.loop);
      scheduleForegroundLoop(
        awaiting.piApi ?? piApi,
        awaiting.ctx,
        FOREGROUND_GOAL_LOOP_INTERVAL_MS,
        { loopId: awaiting.loopId },
      );
    }
  }

  function handleForegroundImplementTurnEnd(ctx: SparkToolContext, event: unknown): void {
    const failure = foregroundGoalTurnFailure(event);
    if (!failure) return;
    for (const [, awaiting] of foregroundImplementAwaitingTurnsForSession(ctx)) {
      awaiting.failure = failure;
    }
  }

  async function handleForegroundImplementAgentEnd(
    piApi: SparkCommandApi,
    ctx: SparkToolContext,
    event: unknown,
  ): Promise<void> {
    const pending = foregroundImplementAwaitingTurnsForSession(ctx);
    if (pending.length === 0) return;
    for (const [key, awaiting] of pending) {
      foregroundImplementAwaitingTurns.delete(key);
      if (foregroundImplementGenerations.get(key) !== awaiting.generation) continue;
      const agentOutcome = foregroundGoalAgentOutcome(event);
      const failure =
        agentOutcome.failure ?? (!agentOutcome.hasAssistantMessage ? awaiting.failure : undefined);
      if (failure) continue;
      await continueForegroundImplementIfReady(
        awaiting.piApi ?? piApi,
        awaiting.ctx,
        awaiting.focus,
      );
    }
  }

  async function continueForegroundImplementIfReady(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
    focus?: string,
  ): Promise<void> {
    if (isSparkReviewerLeaseActive(ctx.cwd, ctx)) return;
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    if (!graph) return;
    const project = await currentSparkProject(ctx.cwd, ctx, graph);
    if (!project) return;
    const sessionKey = sparkSessionOwnerKey(ctx);
    const currentSessionClaim = graph
      .tasks(project.ref)
      .some(
        (task) => isClaimOwnedBySession(task, sessionKey) && isUnfinishedTaskStatus(task.status),
      );
    if (currentSessionClaim) return;
    const ready = graph.readyTasks(project.ref);
    if (ready.length === 0) return;
    const visible = renderSparkModeVisibleMessage("implement", project.title, focus);
    const instruction = renderSparkImplementationModePrompt(graph, project.ref, focus);
    piApi.sendMessage(
      {
        customType: "spark-mode-request",
        content: instruction,
        display: false,
        details: { visible },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    markForegroundImplementAwaitingTurn(piApi, ctx, focus);
  }

  function foregroundGoalAwaitingTurnsForSession(
    ctx: SparkToolContext,
  ): Array<[string, ForegroundGoalAwaitingTurn]> {
    const currentKey = foregroundGoalLoopKey(ctx.cwd, ctx);
    return [...foregroundGoalAwaitingTurns.entries()].filter(([key]) => key === currentKey);
  }

  function foregroundLoopAwaitingTurnsForSession(
    ctx: SparkToolContext,
  ): Array<[string, ForegroundLoopAwaitingTurn]> {
    const currentKey = foregroundGoalLoopKey(ctx.cwd, ctx);
    return [...foregroundLoopAwaitingTurns.entries()].filter(([key]) => key === currentKey);
  }

  function foregroundImplementAwaitingTurnsForSession(
    ctx: SparkToolContext,
  ): Array<[string, ForegroundImplementAwaitingTurn]> {
    const currentKey = foregroundGoalLoopKey(ctx.cwd, ctx);
    return [...foregroundImplementAwaitingTurns.entries()].filter(([key]) => key === currentKey);
  }

  async function recordForegroundGoalAbortedTurn(
    ctx: SparkGoalLoopContext,
    goalId: string,
    failure: string,
  ): Promise<void> {
    const existing = await loadSessionGoal(ctx.cwd, ctx);
    if (!existing || existing.status !== "active" || existing.goalId !== goalId) return;
    const reviewedAt = nowIso();
    await updateSessionGoalStatus(ctx.cwd, ctx, "paused", {
      reason: `foreground goal loop stopped after manual abort: ${failure}`,
      review: {
        achieved: false,
        confidence: "user-aborted",
        reason: `Foreground goal loop stopped because the turn was manually aborted: ${failure}`,
        remainingWork: "Resume the goal when ready; manual aborts are not retried automatically.",
        blockers: [failure],
        reviewedAt,
      },
      retryState: null,
      expectedGoalId: goalId,
    });
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  }

  async function recordForegroundGoalFailedTurn(
    ctx: SparkGoalLoopContext,
    goalId: string,
    failure: string,
  ): Promise<{ paused: boolean; delayMs: number }> {
    const existing = await loadSessionGoal(ctx.cwd, ctx);
    if (!existing || existing.status !== "active" || existing.goalId !== goalId) {
      return { paused: true, delayMs: FOREGROUND_GOAL_LOOP_INTERVAL_MS };
    }
    const consecutiveFailures = (existing.retryState?.consecutiveFailures ?? 0) + 1;
    const reviewedAt = nowIso();
    const retryState = {
      consecutiveFailures,
      lastFailureAt: reviewedAt,
      nextDelayMs: foregroundGoalRetryDelayMs(consecutiveFailures),
    };
    const review = {
      achieved: false,
      confidence: "turn-failed",
      reason: `Foreground goal loop turn failed; foreground goal turn will retry: ${failure}`,
      remainingWork:
        consecutiveFailures >= FOREGROUND_GOAL_RETRY_BUDGET
          ? "Automatic goal review paused because the retry budget was exhausted."
          : "Automatic goal review remains active and will retry on the next tick.",
      blockers: [failure],
      reviewedAt,
    };
    const exhausted = consecutiveFailures >= FOREGROUND_GOAL_RETRY_BUDGET;
    const goal = await updateSessionGoalStatus(ctx.cwd, ctx, exhausted ? "paused" : "active", {
      reason: exhausted
        ? `retry budget exhausted after ${consecutiveFailures} failed foreground goal turn(s): ${failure}`
        : undefined,
      review,
      retryState: exhausted ? { ...retryState, exhaustedAt: reviewedAt } : retryState,
      expectedGoalId: goalId,
    });
    if (!goal) return { paused: true, delayMs: FOREGROUND_GOAL_LOOP_INTERVAL_MS };
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    if (exhausted) {
      const active = await loadActiveForegroundGoal(ctx);
      const language = sparkLanguageForProject({
        project: active?.project,
        goal,
        fallbackText: failure,
      });
      const notifications = goalNotifications(language);
      ctx.ui?.notify?.(notifications.pauseRetryExhausted(compactInline(failure)), "warning");
      return { paused: true, delayMs: retryState.nextDelayMs };
    }
    return { paused: false, delayMs: retryState.nextDelayMs };
  }

  async function recordForegroundGoalSuccessfulTurn(ctx: SparkGoalLoopContext): Promise<{
    goal?: NonNullable<Awaited<ReturnType<typeof loadSessionGoal>>>;
  }> {
    const goal = await loadSessionGoal(ctx.cwd, ctx);
    return { goal: goal ?? undefined };
  }

  async function resetForegroundGoalRetryState(
    ctx: SparkGoalLoopContext,
    goal: NonNullable<Awaited<ReturnType<typeof loadSessionGoal>>>,
  ): Promise<void> {
    if (!goal.retryState || goal.retryState.consecutiveFailures === 0) return;
    if (goal.status !== "active") return;
    const updated = await updateSessionGoalStatus(ctx.cwd, ctx, "active", {
      retryState: null,
      expectedGoalId: goal.goalId,
    });
    if (updated) await deps.refreshSparkWidget(ctx.cwd, ctx);
  }

  async function clearStaleForegroundGoalRetryState(ctx: SparkGoalLoopContext): Promise<void> {
    const goal = await loadSessionGoal(ctx.cwd, ctx);
    if (!goal) return;
    if (!goal.retryState || goal.retryState.consecutiveFailures === 0) return;
    if (goal.status === "complete") return;
    await updateSessionGoalStatus(ctx.cwd, ctx, goal.status, {
      reason: goal.pauseReason,
      retryState: null,
    });
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  }

  async function recordForegroundLoopAbortedTurn(
    ctx: SparkGoalLoopContext,
    loopId: string,
    failure: string,
  ): Promise<void> {
    const existing = await loadSessionLoop(ctx.cwd, ctx);
    if (!existing || existing.status !== "active" || existing.loopId !== loopId) return;
    await updateSessionLoopStatus(ctx.cwd, ctx, "paused", {
      reason: `foreground loop paused after manual abort: ${failure}`,
      retryState: null,
      expectedLoopId: loopId,
    });
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  }

  async function recordForegroundLoopFailedTurn(
    ctx: SparkGoalLoopContext,
    loopId: string,
    failure: string,
  ): Promise<{ paused: boolean; delayMs: number }> {
    const existing = await loadSessionLoop(ctx.cwd, ctx);
    if (!existing || existing.status !== "active" || existing.loopId !== loopId) {
      return { paused: true, delayMs: FOREGROUND_GOAL_LOOP_INTERVAL_MS };
    }
    const consecutiveFailures = (existing.retryState?.consecutiveFailures ?? 0) + 1;
    const failedAt = nowIso();
    const retryState = {
      consecutiveFailures,
      lastFailureAt: failedAt,
      nextDelayMs: foregroundGoalRetryDelayMs(consecutiveFailures),
    };
    const exhausted = consecutiveFailures >= FOREGROUND_GOAL_RETRY_BUDGET;
    const loop = await updateSessionLoopStatus(ctx.cwd, ctx, exhausted ? "paused" : "active", {
      reason: exhausted
        ? `retry budget exhausted after ${consecutiveFailures} failed foreground loop turn(s): ${failure}`
        : undefined,
      retryState: exhausted ? { ...retryState, exhaustedAt: failedAt } : retryState,
      expectedLoopId: loopId,
    });
    if (!loop) return { paused: true, delayMs: FOREGROUND_GOAL_LOOP_INTERVAL_MS };
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    if (exhausted) {
      ctx.ui?.notify?.(
        `Spark loop paused after retry budget was exhausted: ${compactInline(failure)}`,
        "warning",
      );
      return { paused: true, delayMs: retryState.nextDelayMs };
    }
    return { paused: false, delayMs: retryState.nextDelayMs };
  }

  async function resetForegroundLoopRetryState(
    ctx: SparkGoalLoopContext,
    loop: SparkSessionLoop,
  ): Promise<void> {
    if (!loop.retryState || loop.retryState.consecutiveFailures === 0) return;
    if (loop.status !== "active") return;
    const updated = await updateSessionLoopStatus(ctx.cwd, ctx, "active", {
      retryState: null,
      expectedLoopId: loop.loopId,
    });
    if (updated) await deps.refreshSparkWidget(ctx.cwd, ctx);
  }

  function isForegroundGoalAbortFailure(failure: string): boolean {
    return /\b(?:operation aborted|assistant turn was aborted|user_abort|aborterror)\b/i.test(
      failure,
    );
  }

  function foregroundGoalRetryDelayMs(consecutiveFailures: number): number {
    const index = Math.min(
      Math.max(0, consecutiveFailures - 1),
      FOREGROUND_GOAL_RETRY_BACKOFF_MS.length - 1,
    );
    return FOREGROUND_GOAL_RETRY_BACKOFF_MS[index] ?? FOREGROUND_GOAL_LOOP_INTERVAL_MS;
  }

  function foregroundGoalAgentOutcome(event: unknown): {
    failure?: string;
    hasAssistantMessage: boolean;
  } {
    const eventFailure = eventLevelFailure(event);
    if (!event || typeof event !== "object")
      return { failure: eventFailure, hasAssistantMessage: false };
    const messages = (event as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return { failure: eventFailure, hasAssistantMessage: false };
    const assistantMessages = messages.filter(
      (message): message is Record<string, unknown> =>
        !!message &&
        typeof message === "object" &&
        (message as { role?: unknown }).role === "assistant",
    );
    const message = assistantMessages.at(-1);
    return {
      failure: message ? (assistantMessageFailure(message) ?? eventFailure) : eventFailure,
      hasAssistantMessage: assistantMessages.length > 0,
    };
  }

  function eventLevelFailure(event: unknown): string | undefined {
    if (!event || typeof event !== "object") return undefined;
    const errorMessage = (event as { errorMessage?: unknown }).errorMessage;
    return typeof errorMessage === "string" && errorMessage.trim()
      ? errorMessage.trim()
      : undefined;
  }

  function foregroundGoalTurnFailure(event: unknown): string | undefined {
    const message = eventMessage(event);
    if (!message) return undefined;
    return assistantMessageFailure(message);
  }

  function assistantMessageFailure(message: Record<string, unknown>): string | undefined {
    const stopReason = typeof message?.stopReason === "string" ? message.stopReason : undefined;
    const errorMessage =
      typeof message?.errorMessage === "string" ? message.errorMessage.trim() : undefined;
    if (stopReason === "error") return errorMessage || "assistant turn ended with an error";
    if (stopReason === "aborted") return errorMessage || "assistant turn was aborted";
    return undefined;
  }

  function eventMessage(event: unknown): Record<string, unknown> | undefined {
    if (!event || typeof event !== "object") return undefined;
    const message = (event as { message?: unknown }).message;
    return message && typeof message === "object"
      ? (message as Record<string, unknown>)
      : undefined;
  }

  async function loadActiveForegroundGoal(ctx: SparkGoalLoopContext): Promise<
    | {
        graph?: NonNullable<Awaited<ReturnType<typeof loadSparkGraph>>>;
        project?: NonNullable<Awaited<ReturnType<typeof currentSparkProject>>>;
        goal: NonNullable<Awaited<ReturnType<typeof loadSessionGoal>>>;
      }
    | undefined
  > {
    const goal = await loadSessionGoal(ctx.cwd, ctx);
    if (!goal || goal.status !== "active") return undefined;
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const completedProject = graph ? completedProjectForInferredGoal(goal, graph) : undefined;
    if (completedProject) {
      await clearSessionGoal(ctx.cwd, ctx);
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      const language = sparkLanguageForProject({
        project: completedProject,
        goal,
      });
      const notifications = goalNotifications(language);
      ctx.ui?.notify?.(
        notifications.staleClearedFor(compactInline(completedProject.title)),
        "info",
      );
      return undefined;
    }
    const project = graph ? await currentSparkProject(ctx.cwd, ctx, graph) : undefined;
    return { graph: graph ?? undefined, project, goal };
  }

  async function loadActiveForegroundLoop(ctx: SparkGoalLoopContext): Promise<
    | {
        graph?: NonNullable<Awaited<ReturnType<typeof loadSparkGraph>>>;
        project?: NonNullable<Awaited<ReturnType<typeof currentSparkProject>>>;
        loop: SparkSessionLoop;
      }
    | undefined
  > {
    const loop = await loadSessionLoop(ctx.cwd, ctx);
    if (!loop || loop.status !== "active") return undefined;
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const project = graph ? await currentSparkProject(ctx.cwd, ctx, graph) : undefined;
    return { graph: graph ?? undefined, project, loop };
  }

  async function reviewActiveForegroundGoal(
    ctx: SparkGoalLoopContext,
    active: NonNullable<Awaited<ReturnType<typeof loadActiveForegroundGoal>>>,
  ): Promise<boolean> {
    const outcome: GoalCompletionReviewOutcome = await requestGoalCompletionReview(
      ctx,
      deps,
      active,
      { trigger: "loop" },
    );
    if (outcome.outcome === "completed") {
      const completionLanguage = sparkLanguageForProject({
        project: active.project,
        goal: active.goal,
        fallbackText: outcome.reason,
      });
      const completionLabel =
        completionLanguage === "zh"
          ? `Spark 目标 completion 已由 reviewer 审核通过：${compactInline(outcome.reason)}`
          : `Spark goal completion approved by reviewer: ${compactInline(outcome.reason)}`;
      ctx.ui?.notify?.(completionLabel, "info");
      return false;
    }
    if (outcome.outcome === "deferred") return false;
    return true;
  }

  function renderSparkLoopInstruction(
    objective: string,
    graph: TaskGraph | null | undefined,
    project: SparkProjectLike | undefined,
    loop: ReturnType<typeof createLoop>,
  ): string {
    const status = renderSparkLoopStatus(graph, project);
    return [
      loopContinuationPrompt(loop),
      "",
      "Spark foreground loop tick.",
      project ? `Current project: ${project.title}.` : undefined,
      `Loop objective: ${objective}`,
      status,
      LOOP_COMPLETION_BOUNDARY_GUIDANCE,
      "For reviewer-gated goal completion, start or continue /goal instead of this open-ended loop.",
      renderSparkLoopModePrompt(graph, project?.ref, objective),
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  function renderSparkLoopModePrompt(
    graph: TaskGraph | null | undefined,
    selectedProjectRef: ProjectRef | undefined,
    objective: string,
  ): string {
    const mode = graph ? resolveForegroundGoalMode(graph, selectedProjectRef, objective) : "plan";
    return [
      `Selected Spark mode for loop driver: ${mode}.`,
      "Loop driver requirements:",
      "- Use the selected mode's tool policy for this turn: research, plan, or implement.",
      "- Continue one concrete low-risk step; block on human decisions or report external blockers instead of lowering scope.",
      "- Use /goal when the user wants evidence-audited completion with reviewer gating.",
    ].join("\n");
  }

  function renderSparkLoopStatus(
    graph: TaskGraph | null | undefined,
    project: SparkProjectLike | undefined,
  ): string | undefined {
    if (!graph || !project) {
      return 'No current project is selected. If durable task state is needed, use task_read({ action: "workspace_status" }) and task_write({ action: "project_use", title, description }) explicitly.';
    }
    const tasks = graph.tasks(project.ref);
    const unfinished = tasks.filter((task) => isUnfinishedTaskStatus(task.status));
    const ready = graph.readyTasks(project.ref);
    const readyHead = ready.slice(0, 3).map((task) => task.title);
    return [
      `Project status: unfinished=${unfinished.length}, ready=${ready.length}.`,
      readyHead.length > 0 ? `Ready frontier: ${readyHead.join("; ")}.` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  function renderForegroundGoalTickInstruction(
    projectTitle: string | undefined,
    objective: string,
    graph: TaskGraph | null | undefined,
    project: SparkProjectLike | undefined,
    language: SparkLanguage,
    loop: ReturnType<typeof createLoop>,
  ): string {
    const instructions = goalInstructions(language);
    const status = renderForegroundGoalTickStatus(graph, project, language);
    return [
      instructions.loopTickHeader,
      projectTitle ? instructions.currentProject(projectTitle) : undefined,
      instructions.goalLine(objective),
      status,
      renderForegroundGoalLoopLayer(loop),
      instructions.loopModeDecisionContract,
      instructions.loopReviewerOwnership,
      graph ? renderForegroundGoalModePrompt(graph, project?.ref, objective) : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  function renderForegroundGoalLoopLayer(loop: ReturnType<typeof createLoop>): string {
    return [
      `Foreground goal tick scheduled (loop_id=${loop.loopId}).`,
      'When the objective is fully verified, request reviewer-gated completion with goal({ action: "complete" }); otherwise continue the next concrete step or report the blocker.',
    ].join("\n");
  }

  function renderForegroundGoalModePrompt(
    graph: TaskGraph,
    selectedProjectRef: ProjectRef | undefined,
    objective: string,
  ): string {
    const mode = resolveForegroundGoalMode(graph, selectedProjectRef, objective);
    return [
      `Selected Spark mode for goal driver: ${mode}.`,
      renderSparkGoalDriverModePrompt(graph, selectedProjectRef, objective, mode),
    ].join("\n\n");
  }

  function resolveForegroundGoalMode(
    graph: TaskGraph,
    selectedProjectRef: ProjectRef | undefined,
    objective: string,
  ): SparkEntryMode {
    const suggested = suggestForegroundGoalMode(graph, selectedProjectRef, objective);
    const resolved = resolveActiveMode({
      registry: defaultSparkModeRegistry(),
      driver: "goal",
      suggest: suggested,
      fallback: "implement",
    });
    return isSparkEntryMode(resolved.mode) ? resolved.mode : "implement";
  }

  function isSparkEntryMode(mode: string): mode is SparkEntryMode {
    return mode === "research" || mode === "plan" || mode === "implement";
  }

  function renderForegroundGoalTickStatus(
    graph: TaskGraph | null | undefined,
    project: SparkProjectLike | undefined,
    language: SparkLanguage,
  ): string | undefined {
    if (!graph || !project) return renderGoalBootstrapStatus(language);
    const tasks = graph.tasks(project.ref);
    const unfinished = tasks.filter((task) => isUnfinishedTaskStatus(task.status));
    const ready = graph.readyTasks(project.ref);
    const readyHead = ready.slice(0, 3).map((task) => task.title);
    return goalContextStrings(language).projectStatus(unfinished.length, ready.length, readyHead);
  }

  function renderGoalBootstrapStatus(language: SparkLanguage): string {
    return language === "zh"
      ? '当前 goal 尚未绑定项目。下一步：用 task_write({ action: "project_use", title, description }) 基于目标创建或选择项目，然后用 task_write({ action: "plan" }) 规划初始具体任务。不要等待用户手动建项目，除非目标意图确实不明确。'
      : 'No current project is selected for this goal. Next: create or select a project with task_write({ action: "project_use", title, description }) using the goal objective as project intent, then plan initial concrete tasks with task_write({ action: "plan" }). Do not wait for the user to create the project manually unless the goal intent is genuinely ambiguous.';
  }

  function foregroundGoalLoopKey(cwd: string, ctx: SparkToolContext): string {
    return `${cwd}:${sparkSessionOwnerKey(ctx)}`;
  }

  function compactInline(value: string): string {
    const normalized = value.replace(/\s+/gu, " ").trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }
}

function reportGoalLoopError(error: unknown): void {
  console.warn(
    `Spark foreground goal loop failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function compactionAbortSignal(event: unknown): AbortSignal | undefined {
  if (!event || typeof event !== "object") return undefined;
  const signal = (event as { signal?: unknown }).signal;
  if (!signal || typeof signal !== "object") return undefined;
  const candidate = signal as { aborted?: unknown; addEventListener?: unknown };
  if (typeof candidate.aborted !== "boolean") return undefined;
  if (typeof candidate.addEventListener !== "function") return undefined;
  return signal as AbortSignal;
}
