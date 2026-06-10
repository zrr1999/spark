import { defaultArtifactStore } from "pi-artifacts";
import { isActiveSessionTodo, isUnfinishedTaskStatus, type TaskGraph } from "pi-tasks";
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
  reviewedPauseCurrentSessionGoal,
  startOrInferSessionGoal,
} from "./spark-goal-tool-registration.ts";
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
const foregroundGoalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const foregroundGoalAwaitingTurns = new Map<string, ForegroundGoalAwaitingTurn>();

interface ForegroundGoalAwaitingTurn {
  piApi: SparkCommandApi;
  ctx: SparkGoalLoopContext;
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
    const match = /^(?:(workspace|user):)?([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/u.exec(trimmed);
    if (!match) return { focus: trimmed };
    const source = match[1];
    const id = match[2];
    const rest = match[3]?.trim() ?? "";
    if (source) return { selector: source + ":" + id, focus: rest };
    return { focus: trimmed };
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
    objective: string,
  ): Promise<void> {
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
      await runForegroundGoalLoopTick(piApi, ctx, { idleGateSatisfied: true });
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
    markForegroundGoalAwaitingTurn(piApi, ctx);
    if (!piApi.on) scheduleForegroundGoalLoop(piApi, ctx);
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
    scheduleForegroundGoalLoop(piApi, ctx);
  }

  function scheduleForegroundGoalLoop(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
    delayMs = FOREGROUND_GOAL_LOOP_INTERVAL_MS,
    options: { idleGateSatisfied?: boolean } = {},
  ): void {
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    clearForegroundGoalLoop(ctx.cwd, ctx);
    const timer = setTimeout(() => {
      foregroundGoalTimers.delete(key);
      void runForegroundGoalLoopTick(piApi, ctx, options).catch(reportGoalLoopError);
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

  function clearForegroundGoalLoop(cwd: string, ctx: SparkGoalLoopContext): void {
    const key = foregroundGoalLoopKey(cwd, ctx);
    clearForegroundGoalTimer(cwd, ctx);
    foregroundGoalAwaitingTurns.delete(key);
  }

  function markForegroundGoalAwaitingTurn(piApi: SparkCommandApi, ctx: SparkGoalLoopContext): void {
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    const timer = foregroundGoalTimers.get(key);
    if (timer) clearTimeout(timer);
    foregroundGoalTimers.delete(key);
    foregroundGoalAwaitingTurns.set(key, { piApi, ctx });
  }

  async function runForegroundGoalLoopTick(
    piApi: SparkCommandApi,
    ctx: SparkGoalLoopContext,
    options: { idleGateSatisfied?: boolean } = {},
  ): Promise<void> {
    const initial = await loadActiveForegroundGoal(ctx);
    if (!initial) return;
    if (ctx.waitForIdle && !options.idleGateSatisfied) {
      await ctx.waitForIdle();
      if (await loadActiveForegroundGoal(ctx)) {
        scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
          idleGateSatisfied: true,
        });
      }
      return;
    }
    if (ctx.isIdle?.() === false) {
      scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
        idleGateSatisfied: false,
      });
      return;
    }
    const active = await loadActiveForegroundGoal(ctx);
    if (!active) return;
    if (isSparkReviewerLeaseActive(ctx.cwd, ctx)) {
      scheduleForegroundGoalLoop(piApi, ctx);
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
    markForegroundGoalAwaitingTurn(piApi, ctx);
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
      const agentOutcome = foregroundGoalAgentOutcome(event);
      const failure =
        agentOutcome.failure ?? (!agentOutcome.hasAssistantMessage ? awaiting.failure : undefined);
      if (failure) {
        if (isForegroundGoalAbortFailure(failure)) {
          await recordForegroundGoalAbortedTurn(awaiting.ctx, failure);
          continue;
        }
        const retry = await recordForegroundGoalFailedTurn(awaiting.ctx, failure);
        if (!retry.paused)
          scheduleForegroundGoalLoop(awaiting.piApi ?? piApi, awaiting.ctx, retry.delayMs);
        continue;
      }
      const active = await loadActiveForegroundGoal(awaiting.ctx);
      if (!active) continue;
      await resetForegroundGoalRetryState(awaiting.ctx, active.goal);
      scheduleForegroundGoalLoop(awaiting.piApi ?? piApi, awaiting.ctx);
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
    failure: string,
  ): Promise<void> {
    const existing = await loadSessionGoal(ctx.cwd, ctx);
    if (!existing || existing.status !== "active") return;
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
    });
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  }

  async function recordForegroundGoalFailedTurn(
    ctx: SparkGoalLoopContext,
    failure: string,
  ): Promise<{ paused: boolean; delayMs: number }> {
    const existing = await loadSessionGoal(ctx.cwd, ctx);
    if (!existing || existing.status !== "active") {
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

  async function resetForegroundGoalRetryState(
    ctx: SparkGoalLoopContext,
    goal: NonNullable<Awaited<ReturnType<typeof loadSessionGoal>>>,
  ): Promise<void> {
    if (!goal.retryState || goal.retryState.consecutiveFailures === 0) return;
    await updateSessionGoalStatus(ctx.cwd, ctx, "active", { retryState: null });
    await deps.refreshSparkWidget(ctx.cwd, ctx);
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
    const reviewerRunner = await deps.createReviewerRunner?.(ctx.cwd, ctx);
    if (!reviewerRunner) return true;
    const reviewContext = goalReviewContext(active);
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
    const reviewSummary = {
      achieved: verdict.achieved,
      confidence: verdict.confidence,
      reason: verdict.summary,
      remainingWork: verdict.remainingWork,
      blockers: verdict.blockers,
      artifactRef: artifact.ref,
      reviewedAt,
    };
    if (verdict.achieved) {
      await updateSessionGoalStatus(ctx.cwd, ctx, "complete", {
        reason: verdict.summary,
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

  function goalReviewContext(
    active: NonNullable<Awaited<ReturnType<typeof loadActiveForegroundGoal>>>,
  ): {
    projectRef?: ProjectRef;
    projectStatus?: GoalReviewInput["projectStatus"];
    evidenceRefs: ArtifactRef[];
  } {
    const project = goalReviewEvidenceProject(active);
    return {
      projectRef: project?.ref,
      projectStatus:
        project && active.graph ? projectGoalReviewStatus(active.graph, project) : undefined,
      evidenceRefs:
        project && active.graph ? projectTaskEvidenceRefs(active.graph, project.ref) : [],
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
    return defaultArtifactStore(cwd).put({
      kind: "review",
      title: `Goal review for ${active.goal.scope} goal: ${compactInline(active.goal.objective)}`,
      format: "json",
      body: {
        goalId: active.goal.goalId,
        scope: active.goal.scope,
        ...(input.projectRef ? { projectRef: input.projectRef } : {}),
        objective: active.goal.objective,
        reviewPacket: {
          ...(input.projectRef ? { projectRef: input.projectRef } : {}),
          ...(input.projectStatus ? { projectStatus: input.projectStatus } : {}),
          evidenceRefs: input.evidenceRefs,
        },
        verdict,
        reviewerRun,
        recordedAt: nowIso(),
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
