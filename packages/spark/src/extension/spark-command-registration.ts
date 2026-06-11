import { defaultArtifactStore } from "pi-artifacts";
import {
  isActiveSessionTodo,
  isUnfinishedTaskStatus,
  type SessionTodoEntry,
  type TaskGraph,
} from "pi-tasks";
import {
  nowIso,
  type ArtifactRef,
  type JsonValue,
  type ProjectRef,
  type RoleRef,
} from "pi-extension-api";
import { type SparkEntryIntent } from "./spark-entry.ts";
import {
  applySparkEntryResolution,
  type SparkEntryApplicationDeps,
} from "./spark-entry-application.ts";
import { detectSparkProjectState, resolveSparkEntry } from "./spark-entry-resolution.ts";
import { currentSparkProject, loadSparkGraph, sparkSessionOwnerKey } from "./session-state.ts";
import { loadIndependentTodos } from "./session-todos.ts";
import {
  normalizeSparkGoalTokenBudget,
  reviewedPauseCurrentSessionGoal,
  startOrInferSessionGoal,
} from "./spark-goal-tool-registration.ts";
import {
  applySessionGoalUsage,
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

type SparkProjectLike = ReturnType<TaskGraph["projects"]>[number];
import type {
  GoalReviewInput,
  GoalReviewVerdict,
  ReviewerRunResult,
  ReviewerRunner,
} from "./reviewer-runner.ts";
import { isSparkReviewerLeaseActive, withSparkReviewerLease } from "./spark-reviewer-lease.ts";
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
const GOAL_COMPLETION_TODO_BLOCKER_LIMIT = 3;
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

export function registerSparkCommands(
  pi: SparkCommandApi,
  deps: SparkCommandRegistrationDeps,
): void {
  pi.on?.("session_start", async (_event, ctx) => {
    await clearStaleForegroundGoalRetryState(ctx);
    await scheduleForegroundGoalLoopIfActive(pi, ctx);
  });
  pi.on?.("session_shutdown", async (event, ctx) => {
    clearForegroundGoalLoop(ctx.cwd, ctx);
    await pauseActiveGoalForSessionReset(ctx, event);
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

  pi.registerCommand("spark", {
    description:
      "Enter the inferred Spark mode, or initialize a new Spark idea with /spark <idea>.",
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

  pi.registerCommand("execute", {
    description:
      "Enter Spark execute mode for one bounded task; use /goal or /workflow for broader progress.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "execute",
        prompt: args.trim(),
        executeStrategy: "default",
      });
    },
  });

  pi.registerCommand("goal", {
    description: "Set or start the current session's durable Spark goal.",
    async handler(args, ctx) {
      await handleSparkGoalCommand(pi, ctx, args.trim());
    },
  });

  pi.registerCommand("pause-goal", {
    description: "Pause the current session's active Spark goal without deleting it.",
    async handler(args, ctx) {
      await handleSparkPauseGoalCommand(pi, ctx, args.trim());
    },
  });

  pi.registerCommand("workflow", {
    description:
      "Enter Spark workflow execution mode; accepts optional selector like workspace:foo or user:foo.",
    async handler(args, ctx) {
      const parsed = parseWorkflowCommandArgs(args);
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        mode: "execute",
        prompt: parsed.focus,
        executeStrategy: "workflow",
        workflowSelector: parsed.selector,
      });
    },
  });

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
    if ((source === "workspace" || source === "user") && isWorkflowId(id)) {
      return { selector: source + ":" + id, focus: rest };
    }
    return { focus: trimmed };
  }

  function parseGoalCommandArgs(args: string): { objective: string; tokenBudget: number | null } {
    const trimmed = args.trim();
    const tokenPrefixes = ["--tokens=", "--token-budget="];
    const prefix = tokenPrefixes.find((candidate) => trimmed.startsWith(candidate));
    if (!prefix) return { objective: trimmed, tokenBudget: null };
    const afterPrefix = trimmed.slice(prefix.length);
    const tokenEnd = firstWhitespaceIndex(afterPrefix);
    const tokenText = tokenEnd < 0 ? afterPrefix : afterPrefix.slice(0, tokenEnd);
    if (!isDecimalDigits(tokenText)) return { objective: trimmed, tokenBudget: null };
    return {
      objective: (tokenEnd < 0 ? "" : afterPrefix.slice(tokenEnd + 1)).trim(),
      tokenBudget: normalizeSparkGoalTokenBudget(tokenText),
    };
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

  function isDecimalDigits(value: string): boolean {
    if (!value) return false;
    for (const char of value) if (char < "0" || char > "9") return false;
    return true;
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

  async function handleSparkGoalCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    rawArgs: string,
  ): Promise<void> {
    const parsedGoalArgs = parseGoalCommandArgs(rawArgs);
    const objective = parsedGoalArgs.objective;
    const tokenBudget = parsedGoalArgs.tokenBudget;
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
          const goal = await startOrInferSessionGoal(ctx.cwd, ctx, graph, objective, tokenBudget);
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
      if (existingGoal.status === "budgetLimited") {
        const budget =
          existingGoal.tokenBudget === null ? "unlimited" : String(existingGoal.tokenBudget);
        ctx.ui?.notify?.(
          `Spark goal cannot continue because its token budget is exhausted (${existingGoal.usage.tokensUsed}/${budget}). Start a new /goal or raise the budget with the goal tool.`,
          "warning",
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
      deps.queueSparkAgentInstruction(
        ctx,
        [
          instructions.emptyGoalNotSet,
          instructions.emptyGoalReadContext,
          instructions.emptyGoalWriteHint,
          instructions.emptyGoalNoCounts,
          summary,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      );
      piApi.sendMessage(
        {
          customType: "spark-goal-request",
          content: notifications.inferDispatched,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return;
    }
    const goal = await startOrInferSessionGoal(ctx.cwd, ctx, graph, objective, tokenBudget);
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
    const candidate = goal.projectRef
      ? projects.find((project) => project.ref === goal.projectRef)
      : projects.find((project) =>
          inferredGoalObjectiveNamesProject(goal.objective, project.title),
        );
    if (!candidate || candidate.status !== "done") return undefined;
    return candidate;
  }

  function inferredGoalObjectiveNamesProject(objective: string, title: string): boolean {
    return (
      objective.includes(`Advance project “${title}”`) ||
      objective.includes(`Advance project "${title}"`) ||
      objective.includes(`Advance project '${title}'`)
    );
  }

  async function queueForegroundGoalStartInstruction(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    projectTitle: string | undefined,
    goal: SparkSessionGoal,
    visible: string,
    language: SparkLanguage,
  ): Promise<void> {
    const sweep = await renderSessionTodoSweepLines(ctx, language);
    const instructions = goalInstructions(language);
    deps.queueSparkAgentInstruction(
      ctx,
      [
        instructions.goalActiveHeader,
        projectTitle ? instructions.currentProject(projectTitle) : undefined,
        instructions.goalLine(goal.objective),
        ...sweep,
        instructions.pauseLineForeground,
        instructions.loopReviewerOwnership,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      { goalId: goal.goalId },
    );
    piApi.sendMessage(
      { customType: "spark-goal-request", content: visible, display: false },
      { deliverAs: "followUp", triggerTurn: true },
    );
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

  async function handleSparkPauseGoalCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    reason: string,
  ): Promise<void> {
    const result = await reviewedPauseCurrentSessionGoal(ctx.cwd, ctx, deps, reason || undefined);
    const project = await currentSparkProjectForCtx(ctx);
    const language = sparkLanguageForProject({
      project,
      goal: result.goal,
      fallbackText: reason,
    });
    const notifications = goalNotifications(language);
    if (!result.goal) {
      ctx.ui?.notify?.(notifications.noSessionGoal, "warning");
      return;
    }
    if (!result.approved) {
      const visible = notifications.pauseBlocked(compactInline(result.goal.objective));
      ctx.ui?.notify?.(visible, "warning");
      piApi.sendMessage({ customType: "spark-goal-request", content: visible, display: true });
      return;
    }
    clearForegroundGoalLoop(ctx.cwd, ctx);
    const visible = notifications.paused(compactInline(result.goal.objective));
    ctx.ui?.notify?.(visible, "info");
    piApi.sendMessage({ customType: "spark-goal-request", content: visible, display: true });
  }

  async function currentSparkProjectForCtx(
    ctx: SparkCommandContext,
  ): Promise<SparkProjectLike | undefined> {
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    return graph ? await currentSparkProject(ctx.cwd, ctx, graph) : undefined;
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
    deps.queueSparkAgentInstruction(
      ctx,
      renderForegroundGoalTickInstruction(
        project?.title,
        goal.objective,
        active.graph,
        project,
        language,
      ),
      { goalId: goal.goalId },
    );
    piApi.sendMessage(
      { customType: "spark-goal-request", content: visible, display: false },
      { deliverAs: "followUp", triggerTurn: true },
    );
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
      const accounting = await recordForegroundGoalSuccessfulTurn(awaiting.ctx, awaiting, event);
      await resetForegroundGoalRetryState(awaiting.ctx, accounting.goal ?? active.goal);
      if (accounting.crossedBudget) {
        await notifyForegroundGoalBudgetLimited(awaiting.ctx, accounting.goal ?? active.goal);
        continue;
      }
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
      reason: `Foreground goal loop turn failed; automatic review will retry: ${failure}`,
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

  async function recordForegroundGoalSuccessfulTurn(
    ctx: SparkGoalLoopContext,
    awaiting: ForegroundGoalAwaitingTurn,
    event: unknown,
  ): Promise<{
    goal?: NonNullable<Awaited<ReturnType<typeof loadSessionGoal>>>;
    changed: boolean;
    crossedBudget: boolean;
  }> {
    const tokensUsedDelta = foregroundGoalEventTokensUsed(event);
    const activeSecondsDelta = Math.max(0, Math.floor((Date.now() - awaiting.startedAtMs) / 1000));
    const result = await applySessionGoalUsage(ctx.cwd, ctx, {
      goalId: awaiting.goalId,
      tokensUsedDelta,
      activeSecondsDelta,
    });
    if (result.changed) await deps.refreshSparkWidget(ctx.cwd, ctx);
    return result;
  }

  async function notifyForegroundGoalBudgetLimited(
    ctx: SparkGoalLoopContext,
    goal: NonNullable<Awaited<ReturnType<typeof loadSessionGoal>>>,
  ): Promise<void> {
    clearForegroundGoalLoop(ctx.cwd, ctx);
    const project = await currentSparkProjectForCtx(ctx);
    const language = sparkLanguageForProject({ project, goal });
    const message =
      language === "zh"
        ? `Spark 目标因 token budget 耗尽而停止自动续跑：${goal.usage.tokensUsed}/${goal.tokenBudget}`
        : `Spark goal stopped after token budget was exhausted: ${goal.usage.tokensUsed}/${goal.tokenBudget}`;
    ctx.ui?.notify?.(message, "warning");
  }

  function foregroundGoalEventTokensUsed(event: unknown): number {
    const usage = findTokenUsage(event);
    if (!usage) return 0;
    return usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
  }

  function findTokenUsage(
    event: unknown,
  ): { inputTokens: number; outputTokens: number; totalTokens?: number } | undefined {
    if (!event || typeof event !== "object") return undefined;
    const record = event as Record<string, unknown>;
    const direct = normalizeTokenUsageRecord(record.usage);
    if (direct) return direct;
    const message = normalizeTokenUsageRecord(record.message);
    if (message) return message;
    const messages = record.messages;
    if (Array.isArray(messages)) {
      for (const candidate of [...messages].reverse()) {
        const usage = normalizeTokenUsageRecord(candidate);
        if (usage) return usage;
      }
    }
    return undefined;
  }

  function normalizeTokenUsageRecord(
    value: unknown,
  ): { inputTokens: number; outputTokens: number; totalTokens?: number } | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const usage = record.usage && typeof record.usage === "object" ? record.usage : record;
    const usageRecord = usage as Record<string, unknown>;
    const inputTokens = optionalTokenCount(
      usageRecord.inputTokens ?? usageRecord.input_tokens ?? usageRecord.promptTokens,
    );
    const outputTokens = optionalTokenCount(
      usageRecord.outputTokens ?? usageRecord.output_tokens ?? usageRecord.completionTokens,
    );
    const totalTokens = optionalTokenCount(usageRecord.totalTokens ?? usageRecord.total_tokens);
    if (totalTokens === undefined && inputTokens === undefined && outputTokens === undefined)
      return undefined;
    return {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    };
  }

  function optionalTokenCount(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    return Math.trunc(value);
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
      reason: goal.pauseReason ?? goal.budgetLimitedReason,
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
    const project = graph
      ? goal.scope === "project" && goal.projectRef
        ? graph.projects().find((candidate) => candidate.ref === goal.projectRef)
        : await currentSparkProject(ctx.cwd, ctx, graph)
      : undefined;
    return { graph: graph ?? undefined, project, goal };
  }

  async function reviewActiveForegroundGoal(
    ctx: SparkGoalLoopContext,
    active: NonNullable<Awaited<ReturnType<typeof loadActiveForegroundGoal>>>,
  ): Promise<boolean> {
    const independentTodos = await loadIndependentTodos(ctx.cwd, ctx);
    const unresolvedSessionTodos = independentTodos
      .filter(isActiveSessionTodo)
      .filter(isUnresolvedSessionTodoBlocker);
    if (unresolvedSessionTodos.length > 0) {
      const reviewedAt = nowIso();
      const blockers = activeSessionTodoBlockers(unresolvedSessionTodos);
      const reason = `Goal completion blocked by ${unresolvedSessionTodos.length} unresolved session TODO(s).`;
      const updated = await updateSessionGoalStatus(ctx.cwd, ctx, "active", {
        review: {
          achieved: false,
          confidence: "deterministic-blocker",
          reason,
          remainingWork: `${reason} Resolve or disposition them before completing the goal.`,
          blockers,
          reviewedAt,
        },
        expectedGoalId: active.goal.goalId,
      });
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      return Boolean(updated);
    }
    const reviewerRunner = await deps.createReviewerRunner?.(ctx.cwd, ctx);
    if (!reviewerRunner) return true;
    const reviewContext = await goalReviewContext(ctx, active, independentTodos);
    const reviewInput: GoalReviewInput = {
      targetKind: "goal",
      cwd: ctx.cwd,
      projectRef:
        active.goal.scope === "project" ? active.goal.projectRef : reviewContext.projectRef,
      projectStatus: reviewContext.projectStatus,
      goalId: active.goal.goalId,
      objective: active.goal.objective,
      status: active.goal.status,
      requestedStatus: "complete",
      evidenceRefs: reviewContext.evidenceRefs,
      sessionKey: active.goal.sessionKey,
      forkFromSession: ctx.sessionManager?.getSessionFile?.(),
    };
    const leasedReview = await withSparkReviewerLease(ctx.cwd, ctx, () =>
      runGoalReviewer(reviewerRunner, reviewInput),
    );
    if (!leasedReview.acquired || !leasedReview.result) return false;
    const review = leasedReview.result;
    const verdict = review.verdict as GoalReviewVerdict;
    const artifact = await recordGoalReviewArtifact(ctx.cwd, active, review, reviewInput);
    const reviewedAt = review.record.finishedAt || nowIso();
    const deterministicBlocker = goalCompletionDeterministicBlocker(active, reviewInput);
    const effectiveAchieved = verdict.achieved && !deterministicBlocker;
    const reviewSummary = {
      achieved: effectiveAchieved,
      confidence: deterministicBlocker ? "deterministic-blocker" : verdict.confidence,
      reason: deterministicBlocker?.reason ?? verdict.summary,
      remainingWork: deterministicBlocker?.remainingWork ?? verdict.remainingWork,
      blockers: deterministicBlocker?.blockers ?? verdict.blockers,
      artifactRef: artifact.ref,
      reviewedAt,
    };
    if (effectiveAchieved) {
      await updateSessionGoalStatus(ctx.cwd, ctx, "complete", {
        reason: reviewSummary.reason,
        review: reviewSummary,
        retryState: null,
      });
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      const completionLanguage = sparkLanguageForProject({
        project: active.project,
        goal: active.goal,
        fallbackText: verdict.summary,
      });
      const completionLabel =
        completionLanguage === "zh"
          ? `Spark 目标已由 reviewer 完成：${compactInline(verdict.summary)}`
          : `Spark goal completed by reviewer: ${compactInline(verdict.summary)}`;
      ctx.ui?.notify?.(completionLabel, "info");
      return false;
    }
    await updateSessionGoalStatus(ctx.cwd, ctx, "active", { review: reviewSummary });
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    return true;
  }

  function goalCompletionDeterministicBlocker(
    active: NonNullable<Awaited<ReturnType<typeof loadActiveForegroundGoal>>>,
    reviewInput: GoalReviewInput,
  ): { reason: string; remainingWork: string; blockers: string[] } | undefined {
    const unfinished = reviewInput.projectStatus?.taskCounts.unfinished ?? 0;
    if (unfinished <= 0) return undefined;
    if (isPlanningOnlyGoalObjective(active.goal.objective)) return undefined;
    const readyTasks = reviewInput.projectStatus?.readyTasks ?? [];
    const readyText = readyTasks.length
      ? readyTasks.map((task) => `@${task.name ?? task.ref}: ${task.title}`).join("; ")
      : "no ready task; inspect dependencies";
    const reason = `Goal completion blocked by ${unfinished} unfinished project task(s).`;
    return {
      reason,
      remainingWork: `${reason} Next ready frontier: ${readyText}. Continue by claiming a ready task with task-local TODOs, or narrow the goal objective if only planning readiness is intended.`,
      blockers: [`unfinished_project_tasks=${unfinished}`, `ready_frontier=${readyText}`],
    };
  }

  function isPlanningOnlyGoalObjective(objective: string): boolean {
    return (
      /\b(planning-only|readiness-only|plan-only)\b/i.test(objective) ||
      /仅规划|只规划|计划就绪|规划就绪/u.test(objective)
    );
  }

  function isUnresolvedSessionTodoBlocker(todo: SessionTodoEntry): boolean {
    if (todo.status === "blocked") return !todo.blockedBy?.length;
    return true;
  }

  function activeSessionTodoBlockers(
    todos: Awaited<ReturnType<typeof loadIndependentTodos>>,
  ): string[] {
    const visible = todos.slice(0, GOAL_COMPLETION_TODO_BLOCKER_LIMIT).map((todo) => {
      const id = todo.id ? `${todo.id}: ` : "";
      return `${id}${todo.content} [${todo.status}]`;
    });
    const hidden = todos.length - visible.length;
    return hidden > 0 ? [...visible, `… ${hidden} more unresolved session TODO(s)`] : visible;
  }

  async function runGoalReviewer(
    reviewerRunner: ReviewerRunner,
    input: GoalReviewInput,
  ): Promise<ReviewerRunResult> {
    try {
      return await reviewerRunner.review(input);
    } catch (error) {
      const timestamp = nowIso();
      const reason = error instanceof Error ? error.message : String(error);
      return {
        verdict: {
          targetKind: "goal",
          goalId: input.goalId,
          achieved: false,
          outcome: "blocked",
          summary: `reviewer failed: ${reason}`,
          remainingWork: reason,
          findings: [],
          blockers: [reason],
          confidence: "low",
        },
        record: {
          roleRef: "role:builtin-reviewer" as RoleRef,
          runName: "goal-reviewer-failed",
          startedAt: timestamp,
          finishedAt: timestamp,
        },
      };
    }
  }

  async function goalReviewContext(
    ctx: SparkGoalLoopContext,
    active: NonNullable<Awaited<ReturnType<typeof loadActiveForegroundGoal>>>,
    independentTodos: SessionTodoEntry[],
  ): Promise<{
    projectRef?: ProjectRef;
    projectStatus?: GoalReviewInput["projectStatus"];
    evidenceRefs: ArtifactRef[];
  }> {
    if (isSessionTodoDispositionGoal(active.goal)) {
      const evidence = await recordSessionTodoDispositionEvidence(
        ctx.cwd,
        active.goal,
        independentTodos,
      );
      return { evidenceRefs: [evidence.ref] };
    }
    const project = goalReviewEvidenceProject(active);
    return {
      projectRef: project?.ref,
      projectStatus:
        project && active.graph ? projectGoalReviewStatus(active.graph, project) : undefined,
      evidenceRefs:
        project && active.graph
          ? await projectGoalEvidenceRefs(ctx.cwd, active.graph, project.ref)
          : [],
    };
  }

  function isSessionTodoDispositionGoal(goal: SparkSessionGoal): boolean {
    return goal.scope === "session" && /session TODO/i.test(goal.objective);
  }

  async function recordSessionTodoDispositionEvidence(
    cwd: string,
    goal: SparkSessionGoal,
    todos: SessionTodoEntry[],
  ): Promise<{ ref: ArtifactRef }> {
    const unresolvedBlockers = todos
      .filter(isActiveSessionTodo)
      .filter(isUnresolvedSessionTodoBlocker);
    const statusCounts = todos.reduce<Record<string, number>>((counts, todo) => {
      counts[todo.status] = (counts[todo.status] ?? 0) + 1;
      return counts;
    }, {});
    const artifact = await defaultArtifactStore(cwd).put({
      kind: "review",
      title: `Session TODO disposition snapshot for goal: ${compactInline(goal.objective)}`,
      format: "json",
      body: {
        goalId: goal.goalId,
        scope: goal.scope,
        objective: goal.objective,
        sessionKey: goal.sessionKey,
        recordedAt: nowIso(),
        statusCounts,
        unresolvedBlockerCount: unresolvedBlockers.length,
        unresolvedBlockers: unresolvedBlockers.map(sessionTodoEvidenceEntry),
        todos: todos.map(sessionTodoEvidenceEntry),
      } as unknown as JsonValue,
      provenance: {
        producer: "spark",
        note: "Current session TODO disposition evidence for goal completion review.",
      },
    });
    return { ref: artifact.ref };
  }

  function sessionTodoEvidenceEntry(todo: SessionTodoEntry): JsonValue {
    return {
      ...(todo.id ? { id: todo.id } : {}),
      content: todo.content,
      status: todo.status,
      ...(todo.blockedBy?.length ? { blockedBy: [...todo.blockedBy] } : {}),
      ...(todo.notes?.length ? { notes: [...todo.notes] } : {}),
      ...(todo.updatedAt ? { updatedAt: todo.updatedAt } : {}),
    };
  }

  function goalReviewEvidenceProject(
    active: NonNullable<Awaited<ReturnType<typeof loadActiveForegroundGoal>>>,
  ): SparkProjectLike | undefined {
    if (!active.graph) return active.project;
    if (active.project) return active.project;
    if (active.goal.scope === "project" && active.goal.projectRef)
      return active.graph.projects().find((project) => project.ref === active.goal.projectRef);
    const projectsWithEvidence = active.graph
      .projects()
      .filter((project) => projectTaskEvidenceRefs(active.graph!, project.ref).length > 0);
    const completedProjects = projectsWithEvidence.filter((project) => project.status === "done");
    return (
      mostRecentlyUpdatedProject(completedProjects) ??
      mostRecentlyUpdatedProject(projectsWithEvidence)
    );
  }

  function compactProjectTaskForGoalReview(task: ReturnType<TaskGraph["tasks"]>[number]) {
    return {
      ref: task.ref,
      name: task.name,
      title: task.title,
      status: task.status,
      kind: task.kind,
    };
  }

  async function projectGoalEvidenceRefs(
    cwd: string,
    graph: TaskGraph,
    projectRef: ProjectRef,
  ): Promise<ArtifactRef[]> {
    const taskEvidenceRefs = projectTaskEvidenceRefs(graph, projectRef);
    const projectReviewRefs = (
      await defaultArtifactStore(cwd).list({ kind: "review", projectRef })
    ).map((artifact) => artifact.ref);
    return [...new Set([...taskEvidenceRefs, ...projectReviewRefs])].slice(-20);
  }

  function projectTaskEvidenceRefs(graph: TaskGraph, projectRef: ProjectRef): ArtifactRef[] {
    return [...new Set(graph.tasks(projectRef).flatMap((task) => task.outputArtifacts))].slice(-20);
  }

  function projectGoalReviewStatus(
    graph: TaskGraph,
    project: SparkProjectLike,
  ): GoalReviewInput["projectStatus"] {
    const tasks = graph.tasks(project.ref);
    const statusCounts = tasks.reduce<Record<string, number>>((counts, task) => {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
      return counts;
    }, {});
    return {
      ref: project.ref,
      title: project.title,
      status: project.status,
      taskCounts: {
        total: tasks.length,
        unfinished: tasks.filter((task) => isUnfinishedTaskStatus(task.status)).length,
        claimed: tasks.filter((task) => Boolean(task.claim)).length,
        statusCounts,
      },
      readyTasks: graph.readyTasks(project.ref).slice(0, 5).map(compactProjectTaskForGoalReview),
      unfinishedTasks: tasks
        .filter((task) => isUnfinishedTaskStatus(task.status))
        .slice(0, 10)
        .map(compactProjectTaskForGoalReview),
    };
  }

  function mostRecentlyUpdatedProject(projects: SparkProjectLike[]): SparkProjectLike | undefined {
    return [...projects].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )[0];
  }

  async function recordGoalReviewArtifact(
    cwd: string,
    active: NonNullable<Awaited<ReturnType<typeof loadActiveForegroundGoal>>>,
    review: ReviewerRunResult,
    input: GoalReviewInput,
  ) {
    const verdict = review.verdict as GoalReviewVerdict;
    const reviewerRun = {
      ...(review.record.runRef ? { runRef: review.record.runRef } : {}),
      roleRef: review.record.roleRef,
      ...(review.record.runName ? { runName: review.record.runName } : {}),
      startedAt: review.record.startedAt,
      finishedAt: review.record.finishedAt,
    };
    const store = defaultArtifactStore(cwd);
    const ref = goalReviewArtifactRef(active.goal.goalId);
    const recordedAt = nowIso();
    const reviewPacket = {
      ...(input.projectRef ? { projectRef: input.projectRef } : {}),
      ...(input.projectStatus ? { projectStatus: input.projectStatus } : {}),
      evidenceRefs: input.evidenceRefs,
    };
    const previous = await store.tryGet(ref);
    const reviews = [
      ...goalReviewHistoryEntries(previous?.body).slice(-9),
      { verdict, reviewerRun, reviewPacket, recordedAt } as unknown as JsonValue,
    ];
    return store.put({
      ref,
      kind: "review",
      title: `Goal review for ${active.goal.scope} goal: ${compactInline(active.goal.objective)}`,
      format: "json",
      body: {
        goalId: active.goal.goalId,
        scope: active.goal.scope,
        ...(input.projectRef ? { projectRef: input.projectRef } : {}),
        objective: active.goal.objective,
        reviewPacket,
        verdict,
        reviewerRun,
        reviews,
        recordedAt,
      } as unknown as JsonValue,
      provenance: {
        producer: "review",
        projectRef: input.projectRef,
        roleRef: review.record.roleRef,
        runRef: review.record.runRef,
      },
      links: input.projectRef ? [{ to: input.projectRef, relation: "review-of" }] : undefined,
    });
  }

  function goalReviewArtifactRef(goalId: string): ArtifactRef {
    return `artifact:goal-review-${goalId.replace(/[^a-zA-Z0-9_-]/gu, "-")}` as ArtifactRef;
  }

  function goalReviewHistoryEntries(value: unknown): JsonValue[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const reviews = (value as { reviews?: unknown }).reviews;
    return Array.isArray(reviews) ? (reviews as JsonValue[]) : [];
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
      instructions.loopReviewerOwnership,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  function renderForegroundGoalTickStatus(
    graph: TaskGraph | null | undefined,
    project: SparkProjectLike | undefined,
    language: SparkLanguage,
  ): string | undefined {
    if (!graph || !project) return undefined;
    const tasks = graph.tasks(project.ref);
    const unfinished = tasks.filter((task) => isUnfinishedTaskStatus(task.status));
    const ready = graph.readyTasks(project.ref);
    const readyHead = ready.slice(0, 3).map((task) => task.title);
    return goalContextStrings(language).projectStatus(unfinished.length, ready.length, readyHead);
  }

  function foregroundGoalLoopKey(cwd: string, ctx: SparkToolContext): string {
    return `${cwd}:${sparkSessionOwnerKey(ctx)}`;
  }

  function compactInline(value: string): string {
    const normalized = value.replace(/\s+/gu, " ").trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }
}

async function pauseActiveGoalForSessionReset(
  ctx: SparkGoalLoopContext,
  event: unknown,
): Promise<void> {
  const reason = shutdownReason(event);
  if (!isGoalResetShutdownReason(reason)) return;
  const existing = await loadSessionGoal(ctx.cwd, ctx);
  if (!existing || existing.status !== "active") return;
  await updateSessionGoalStatus(ctx.cwd, ctx, "paused", {
    reason: `Auto-paused before session ${reason}; restart /goal explicitly to continue after the reset.`,
    retryState: null,
  });
}

function isGoalResetShutdownReason(reason: string): boolean {
  return (
    reason === "reload" ||
    reason === "resume" ||
    reason === "new" ||
    reason === "fork" ||
    reason === "revert" ||
    reason === "reset"
  );
}

function shutdownReason(event: unknown): string {
  return event &&
    typeof event === "object" &&
    typeof (event as { reason?: unknown }).reason === "string"
    ? (event as { reason: string }).reason
    : "unknown";
}

function reportGoalLoopError(error: unknown): void {
  console.warn(
    `Spark foreground goal loop failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
