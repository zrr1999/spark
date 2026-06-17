import { isActiveSessionTodo, isUnfinishedTaskStatus, type TaskGraph } from "@zendev-lab/pi-tasks";
import { listBuiltinWorkflows } from "@zendev-lab/pi-workflows";
import { nowIso, type ProjectRef } from "@zendev-lab/pi-extension-api";
import type { SparkEntryIntent, SparkEntryMode } from "./spark-entry.ts";
import {
  applySparkEntryResolution,
  type SparkEntryApplicationDeps,
} from "./spark-entry-application.ts";
import { detectSparkProjectState, resolveSparkEntry } from "./spark-entry-resolution.ts";
import { currentSparkProject, loadSparkGraph, sparkSessionOwnerKey } from "./session-state.ts";
import { loadIndependentTodos } from "./session-todos.ts";
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
  goalContextStrings,
  goalInstructions,
  goalNotifications,
  sparkLanguageForProject,
  type SparkLanguage,
} from "./spark-i18n.ts";
import { defaultSparkModeRegistry, resolveActiveMode } from "./mode/index.ts";
import { renderSparkGoalDriverModePrompt } from "./spark-mode-prompts.ts";
import { enterSparkWorkflowDriver } from "./spark-workflow-driver-entry.ts";

type SparkProjectLike = ReturnType<TaskGraph["projects"]>[number];
import type { ReviewerRunner } from "./reviewer-runner.ts";
import { isSparkReviewerLeaseActive } from "./spark-reviewer-lease.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

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
const foregroundGoalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const foregroundGoalAwaitingTurns = new Map<string, ForegroundGoalAwaitingTurn>();
const foregroundGoalLoopGenerations = new Map<string, number>();

interface ForegroundGoalAwaitingTurn {
  piApi: SparkCommandApi;
  ctx: SparkGoalLoopContext;
  goalId: string;
  generation: number;
  startedAtMs: number;
  failure?: string;
}

function sendSparkRuntimeInstruction(
  piApi: SparkCommandApi,
  customType: "spark-goal-request",
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
    await scheduleForegroundGoalLoopIfActive(pi, ctx);
  });
  pi.on?.("session_shutdown", async (_event, ctx) => {
    clearForegroundGoalLoop(ctx.cwd, ctx);
  });
  pi.on?.("input", (_event, ctx) => {
    clearForegroundGoalTimer(ctx.cwd, ctx);
  });
  pi.on?.("turn_start", (_event, ctx) => {
    clearForegroundGoalTimer(ctx.cwd, ctx);
  });
  pi.on?.("turn_end", async (event, ctx) => {
    handleForegroundGoalTurnEnd(ctx, event);
  });
  pi.on?.("agent_end", async (event, ctx) => {
    await handleForegroundGoalAgentEnd(pi, ctx, event);
  });
  pi.on?.("tool_execution_end", async (event, ctx) => {
    if (isGoalToolDeactivationEvent(event)) clearForegroundGoalLoop(ctx.cwd, ctx);
  });

  pi.registerCommand("spark", {
    description:
      "Compatibility entry: infer Spark mode or initialize a new Spark idea from the provided prompt.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, { kind: "auto", prompt: args.trim() });
    },
  });

  pi.registerCommand("research", {
    description: "Enter Spark research mode: investigate and report without changing tasks.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "research",
        prompt: args.trim(),
      });
    },
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
      "Enter Spark implement mode for one bounded task; use /goal or /workflow for broader progress.",
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

  pi.registerCommand("workflow", {
    description:
      "Enter Spark workflow execution mode; accepts optional selector like builtin:foo, workspace:foo, or user:foo.",
    async handler(args, ctx) {
      const parsed = parseWorkflowCommandArgs(args);
      await handleSparkWorkflowCommand(pi, ctx, parsed);
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
  }

  async function handleSparkWorkflowCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    parsed: { selector?: string; focus: string },
  ): Promise<void> {
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    if (!graph) {
      ctx.ui?.notify?.(
        'Spark workflow driver needs initialized Spark project state. Create or select a project with task_write({ action: "project_use", title, description }) before using /workflow.',
        "warning",
      );
      return;
    }
    await enterSparkWorkflowDriver(piApi, deps, ctx, graph, parsed.focus, parsed.selector);
  }

  async function handleSparkGoalCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    rawArgs: string,
  ): Promise<void> {
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
      lines.push(strings.currentProjectLine(project.title, project.status));
      lines.push(strings.unfinishedReadyLine(unfinished.length, ready.length));
      const readyTitles = ready.slice(0, 5).map((task) => task.title);
      if (readyTitles.length > 0) lines.push(strings.readyFrontierLine(readyTitles));
    } else {
      const projects = graph.projects();
      lines.push(strings.noActiveProject(projects.length));
      const activeTitles = projects
        .filter((candidate) => candidate.status !== "done")
        .slice(0, 5)
        .map((candidate) => candidate.title);
      if (activeTitles.length > 0) lines.push(strings.activeProjectCandidates(activeTitles));
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
    if (!candidate || candidate.status !== "done") return undefined;
    return candidate;
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
    const sweep = await renderSessionTodoSweepLines(ctx, language);
    const instructions = goalInstructions(language);
    const instruction = [
      instructions.goalActiveHeader,
      projectTitle ? instructions.currentProject(projectTitle) : undefined,
      instructions.goalLine(goal.objective),
      ...sweep,
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
    });
    markForegroundGoalAwaitingTurn(piApi, ctx, goal.goalId);
    if (!piApi.on)
      scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        goalId: goal.goalId,
      });
  }

  async function renderSessionTodoSweepLines(
    ctx: SparkCommandContext,
    language: SparkLanguage,
  ): Promise<string[]> {
    const instructions = goalInstructions(language);
    const todos = (await loadIndependentTodos(ctx.cwd, ctx)).filter(isActiveSessionTodo);
    if (todos.length === 0) return [instructions.todoSweepNoneActive];
    const labels = todos
      .slice(0, 8)
      .map((todo) => `- [${todo.status}] ${compactInline(todo.content)}`);
    const more = todos.length > 8 ? instructions.todoSweepMore(todos.length - 8) : "";
    return [
      instructions.todoSweepHeader(todos.length),
      `${labels.join("\n")}${more}`,
      instructions.todoSweepDisposition,
    ];
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
    const active = await loadActiveForegroundGoal(ctx);
    if (!active || (options.goalId && active.goal.goalId !== options.goalId)) return;
    if (isSparkReviewerLeaseActive(ctx.cwd, ctx)) {
      scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        goalId: active.goal.goalId,
      });
      return;
    }
    const { project, goal } = active;
    const shouldContinue = await reviewActiveForegroundGoal(ctx, active);
    if (!shouldContinue) return;
    const projectLabel = project ? ` · project: ${project.title}` : "";
    const language = sparkLanguageForProject({ project, goal });
    const notifications = goalNotifications(language);
    const visible = notifications.goalTickHeader(compactInline(goal.objective), projectLabel);
    const instruction = renderForegroundGoalTickInstruction(
      project?.title,
      goal.objective,
      active.graph,
      project,
      language,
    );
    sendSparkRuntimeInstruction(piApi, "spark-goal-request", instruction, visible, {
      goalId: goal.goalId,
      purpose: "foreground-goal-tick",
    });
    markForegroundGoalAwaitingTurn(piApi, ctx, goal.goalId);
  }

  function handleForegroundGoalTurnEnd(ctx: SparkToolContext, event: unknown): void {
    const failure = foregroundGoalTurnFailure(event);
    if (!failure) return;
    for (const [, awaiting] of foregroundGoalAwaitingTurnsForSession(ctx)) {
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

  function foregroundGoalAwaitingTurnsForSession(
    ctx: SparkToolContext,
  ): Array<[string, ForegroundGoalAwaitingTurn]> {
    const currentKey = foregroundGoalLoopKey(ctx.cwd, ctx);
    return [...foregroundGoalAwaitingTurns.entries()].filter(([key]) => key === currentKey);
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
      review: goal.lastReview,
      retryState: null,
    });
    await deps.refreshSparkWidget(ctx.cwd, ctx);
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

  function renderForegroundGoalTickInstruction(
    projectTitle: string | undefined,
    objective: string,
    graph: TaskGraph | null | undefined,
    project: SparkProjectLike | undefined,
    language: SparkLanguage,
  ): string {
    const instructions = goalInstructions(language);
    const status = renderForegroundGoalTickStatus(graph, project, language);
    return [
      instructions.loopTickHeader,
      projectTitle ? instructions.currentProject(projectTitle) : undefined,
      instructions.goalLine(objective),
      status,
      instructions.loopModeDecisionContract,
      instructions.loopReviewerOwnership,
      graph ? renderForegroundGoalModePrompt(graph, project?.ref, objective) : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
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

  function suggestForegroundGoalMode(
    graph: TaskGraph,
    selectedProjectRef: ProjectRef | undefined,
    objective: string,
  ): SparkEntryMode {
    const normalized = objective.trim();
    if (/(调研|研究|审阅|review|research|investigate|inspect|audit)/iu.test(normalized))
      return "research";
    if (/(规划|计划|拆分|plan|clarify|decompose|break down)/iu.test(normalized)) return "plan";
    if (
      /(执行|完成|修复|继续|跑完|ready queue|until done|finish|fix|implement|execute)/iu.test(
        normalized,
      )
    )
      return "implement";
    if (!selectedProjectRef) return "plan";
    const ready = graph.readyTasks(selectedProjectRef);
    if (ready.length > 0) return "implement";
    const unfinished = graph
      .tasks(selectedProjectRef)
      .filter((task) => isUnfinishedTaskStatus(task.status));
    return unfinished.length > 0 ? "plan" : "implement";
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
