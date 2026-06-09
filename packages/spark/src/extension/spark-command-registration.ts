import { defaultArtifactStore } from "pi-artifacts";
import { isActiveSessionTodo, type TaskGraph } from "pi-tasks";
import { nowIso, type JsonValue, type RoleRef } from "pi-extension-api";
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
    await scheduleForegroundGoalLoopIfActive(pi, ctx);
  });
  pi.on?.("session_shutdown", async (event, ctx) => {
    clearForegroundGoalLoop(ctx.cwd, ctx);
    await pauseActiveGoalForSessionReset(ctx, event);
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
          const visible = `Spark goal active${projectLabel} · goal: ${compactInline(goal.objective)}`;
          ctx.ui?.notify?.(
            "Spark goal replaced a stale completed-project goal with the new objective.",
            "info",
          );
          queueForegroundGoalStartInstruction(piApi, ctx, project?.title, goal, visible);
          return;
        }
        await clearSessionGoal(ctx.cwd, ctx);
        await deps.refreshSparkWidget(ctx.cwd, ctx);
        ctx.ui?.notify?.(
          `Cleared stale Spark goal for completed project: ${compactInline(completedProject.title)}`,
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
      const visible = `Spark goal already active${projectLabel} · continuing existing goal: ${compactInline(goal.objective)}`;
      ctx.ui?.notify?.(
        objective
          ? "Spark goal already exists; /goal does not overwrite active or paused goals. Continuing the existing goal."
          : "Spark goal already exists; continuing the existing goal.",
        "info",
      );
      queueForegroundGoalStartInstruction(piApi, ctx, project?.title, goal, visible, {
        alreadyExisting: true,
      });
      return;
    }
    if (!objective) {
      const visible = "Spark goal needs a specific objective; /goal did not infer a template goal.";
      ctx.ui?.notify?.(
        "Spark goal needs a specific objective. /goal will not infer or overwrite a template goal.",
        "warning",
      );
      deps.queueSparkAgentInstruction(
        ctx,
        [
          "Spark /goal was invoked without a concrete objective.",
          project ? `Current project: ${project.title}` : undefined,
          "Do not infer or generate a default project-completion goal template.",
          'Ask concise context-specific clarification questions to determine the user\'s real goal. Once clarified, start it with /goal <objective> or goal({ action: "start", objective: ... }).',
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      );
      piApi.sendMessage(
        { customType: "spark-goal-request", content: visible, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return;
    }
    const goal = await startOrInferSessionGoal(ctx.cwd, ctx, graph, objective);
    if (!goal) return;
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    const projectLabel = project ? ` · project: ${project.title}` : "";
    const visible = `Spark goal active${projectLabel} · goal: ${compactInline(goal.objective)}`;
    ctx.ui?.notify?.(visible, "info");
    queueForegroundGoalStartInstruction(piApi, ctx, project?.title, goal, visible);
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

  function queueForegroundGoalStartInstruction(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    projectTitle: string | undefined,
    goal: SparkSessionGoal,
    visible: string,
    options: { alreadyExisting?: boolean } = {},
  ): void {
    deps.queueSparkAgentInstruction(
      ctx,
      [
        options.alreadyExisting
          ? "Spark session goal is already active; /goal did not overwrite the existing objective."
          : "Spark session goal is active.",
        projectTitle ? `Current project: ${projectTitle}` : undefined,
        `Goal: ${goal.objective}`,
        'Spark has started the foreground goal loop for this session. It waits until the main agent has been idle for the goal interval before each tick. Goal completion is reviewer-owned: the main agent cannot mark goals complete. The Spark reviewer loop will mark the goal complete internally only after an achieved verdict. A session goal with active session TODOs is never complete; finish or disposition those TODOs first. Use task({ action: "status" }) when the task graph is relevant. If all tasks are complete but the objective is not achieved, create new concrete tasks with task({ action: "plan" }) instead of completing or pausing just because the task list is empty. Goal mode is non-interactive: do not call ask/ask_flow. If task decomposition is wrong or missing, create or revise concrete tasks with task({ action: "plan" }); if the goal itself is ambiguous or blocked, stop and report or pause the goal with goal({ action: "pause" }).',
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      { goalId: goal.goalId },
    );
    piApi.sendMessage(
      { customType: "spark-goal-request", content: visible, display: true },
      { deliverAs: "followUp", triggerTurn: true },
    );
    markForegroundGoalAwaitingTurn(piApi, ctx);
    if (!piApi.on) scheduleForegroundGoalLoop(piApi, ctx);
  }

  async function handleSparkPauseGoalCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    reason: string,
  ): Promise<void> {
    const result = await reviewedPauseCurrentSessionGoal(ctx.cwd, ctx, deps, reason || undefined);
    if (!result.goal) {
      ctx.ui?.notify?.("No session goal is set.", "warning");
      return;
    }
    if (!result.approved) {
      const visible = `Spark goal pause blocked by reviewer · goal: ${compactInline(result.goal.objective)}`;
      ctx.ui?.notify?.(visible, "warning");
      piApi.sendMessage({ customType: "spark-goal-request", content: visible, display: true });
      return;
    }
    clearForegroundGoalLoop(ctx.cwd, ctx);
    const visible = `Spark goal paused · goal: ${compactInline(result.goal.objective)}`;
    ctx.ui?.notify?.(visible, "info");
    piApi.sendMessage({ customType: "spark-goal-request", content: visible, display: true });
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

  function clearForegroundGoalLoop(cwd: string, ctx: SparkGoalLoopContext): void {
    const key = foregroundGoalLoopKey(cwd, ctx);
    const timer = foregroundGoalTimers.get(key);
    if (timer) clearTimeout(timer);
    foregroundGoalTimers.delete(key);
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
    if (ctx.isIdle?.() === false) {
      scheduleForegroundGoalLoop(piApi, ctx);
      return;
    }
    if (!ctx.isIdle && ctx.waitForIdle && !options.idleGateSatisfied) {
      await ctx.waitForIdle();
      if (await loadActiveForegroundGoal(ctx)) {
        scheduleForegroundGoalLoop(piApi, ctx, FOREGROUND_GOAL_LOOP_INTERVAL_MS, {
          idleGateSatisfied: true,
        });
      }
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
    const visible = `Spark goal tick${projectLabel} · goal: ${compactInline(goal.objective)}`;
    deps.queueSparkAgentInstruction(
      ctx,
      renderForegroundGoalTickInstruction(project?.title, goal.objective),
      { goalId: goal.goalId },
    );
    piApi.sendMessage(
      { customType: "spark-goal-request", content: visible, display: false },
      { deliverAs: "nextTurn", triggerTurn: true },
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
    for (const [key, awaiting] of pending) {
      foregroundGoalAwaitingTurns.delete(key);
      const agentOutcome = foregroundGoalAgentOutcome(event);
      const failure =
        agentOutcome.failure ?? (!agentOutcome.hasAssistantMessage ? awaiting.failure : undefined);
      if (failure) {
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
      ctx.ui?.notify?.(
        `Spark goal paused after retry budget exhausted: ${compactInline(failure)}`,
        "warning",
      );
      return { paused: true, delayMs: retryState.nextDelayMs };
    }
    ctx.ui?.notify?.(
      `Spark goal turn failed; retry ${consecutiveFailures}/${FOREGROUND_GOAL_RETRY_BUDGET} in ${Math.round(retryState.nextDelayMs / 1000)}s: ${compactInline(failure)}`,
      "warning",
    );
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
      ctx.ui?.notify?.(
        `Cleared stale Spark goal for completed project: ${compactInline(completedProject.title)}`,
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
    const todoBlocker = await sessionTodoGoalBlocker(ctx, active.goal);
    if (todoBlocker) {
      await updateSessionGoalStatus(ctx.cwd, ctx, "active", { review: todoBlocker });
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      return true;
    }
    const reviewerRunner = await deps.createReviewerRunner?.(ctx.cwd, ctx);
    if (!reviewerRunner) return true;
    const reviewInput: GoalReviewInput = {
      targetKind: "goal",
      cwd: ctx.cwd,
      projectRef: active.goal.scope === "project" ? active.goal.projectRef : active.project?.ref,
      goalId: active.goal.goalId,
      objective: active.goal.objective,
      status: active.goal.status,
      requestedStatus: "complete",
      evidenceRefs: goalReviewEvidenceRefs(active),
      sessionKey: active.goal.sessionKey,
      forkFromSession: ctx.sessionManager?.getSessionFile?.(),
    };
    const leasedReview = await withSparkReviewerLease(ctx.cwd, ctx, () =>
      runGoalReviewer(reviewerRunner, reviewInput),
    );
    if (!leasedReview.acquired || !leasedReview.result) return false;
    const review = leasedReview.result;
    const verdict = review.verdict as GoalReviewVerdict;
    const artifact = await recordGoalReviewArtifact(ctx.cwd, active, review);
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
      ctx.ui?.notify?.(
        `Spark goal completed by reviewer: ${compactInline(verdict.summary)}`,
        "info",
      );
      return false;
    }
    await updateSessionGoalStatus(ctx.cwd, ctx, "active", { review: reviewSummary });
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    return true;
  }

  async function sessionTodoGoalBlocker(
    ctx: SparkGoalLoopContext,
    goal: SparkSessionGoal,
  ): Promise<SparkSessionGoal["lastReview"] | undefined> {
    if (goal.scope !== "session") return undefined;
    const activeTodos = (await loadIndependentTodos(ctx.cwd, ctx)).filter(isActiveSessionTodo);
    if (activeTodos.length === 0) return undefined;
    const labels = activeTodos
      .slice(0, 5)
      .map((todo) => `${todo.status}: ${compactInline(todo.content)}`);
    return {
      achieved: false,
      confidence: "deterministic-session-todos",
      reason: `Session goal cannot complete while ${activeTodos.length} active session TODO(s) remain.`,
      remainingWork: `Finish or explicitly disposition active session TODOs before completing the session goal: ${labels.join("; ")}`,
      blockers: labels,
      reviewedAt: nowIso(),
    };
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

  function goalReviewEvidenceRefs(
    active: NonNullable<Awaited<ReturnType<typeof loadActiveForegroundGoal>>>,
  ) {
    if (!active.graph || !active.project) return [];
    return active.graph
      .tasks(active.project.ref)
      .flatMap((task) => task.outputArtifacts)
      .slice(-20);
  }

  async function recordGoalReviewArtifact(
    cwd: string,
    active: NonNullable<Awaited<ReturnType<typeof loadActiveForegroundGoal>>>,
    review: ReviewerRunResult,
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
        ...(active.goal.projectRef ? { projectRef: active.goal.projectRef } : {}),
        objective: active.goal.objective,
        verdict,
        reviewerRun,
        recordedAt: nowIso(),
      } as unknown as JsonValue,
      provenance: {
        producer: "review",
        projectRef: active.goal.projectRef ?? active.project?.ref,
        roleRef: review.record.roleRef,
        runRef: review.record.runRef,
      },
      links: active.goal.projectRef
        ? [{ to: active.goal.projectRef, relation: "review-of" }]
        : undefined,
    });
  }

  function renderForegroundGoalTickInstruction(
    projectTitle: string | undefined,
    objective: string,
  ): string {
    return [
      "Spark foreground goal loop tick.",
      projectTitle ? `Current project: ${projectTitle}` : undefined,
      `Goal: ${objective}`,
      'Goal completion is reviewer-owned: the main agent cannot mark goals complete. The Spark reviewer loop already checked whether the objective is achieved before sending this continuation; if it was achieved, this prompt would not be sent. A session goal with active session TODOs is never complete; finish or disposition those TODOs first. Use task({ action: "status" }) when the task graph is relevant. If all existing tasks are complete but the objective is not achieved, create new concrete tasks with task({ action: "plan" }) instead of completing or pausing just because the task list is empty. If a concrete ready task is obvious, claim and complete one verified task in the foreground, then finish it with evidence. Goal mode is non-interactive: do not call ask/ask_flow. If task decomposition is wrong, missing, empty, or blocks the goal, create or revise concrete tasks with task({ action: "plan" }) and continue from the updated ready work. If no ready path remains because of a real blocker, validation fails, or the goal itself is ambiguous, stop and report or pause the goal with goal({ action: "pause" }). Do not spawn background workflow execution from the goal loop.',
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
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
