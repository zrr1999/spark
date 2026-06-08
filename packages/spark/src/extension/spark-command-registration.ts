import { type SparkEntryIntent } from "./spark-entry.ts";
import {
  applySparkEntryResolution,
  type SparkEntryApplicationDeps,
} from "./spark-entry-application.ts";
import { detectSparkProjectState, resolveSparkEntry } from "./spark-entry-resolution.ts";
import { currentSparkProject, loadSparkGraph, sparkSessionOwnerKey } from "./session-state.ts";
import {
  pauseCurrentSessionGoal,
  startOrInferSessionGoal,
} from "./spark-goal-tool-registration.ts";
import { loadSessionGoal, updateSessionGoalStatus } from "./spark-session-goals.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkCommandContext extends SparkToolContext {
  waitForIdle?: () => Promise<void>;
  setEditorText?: (text: string) => void;
}

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

interface SparkCommandRegistrationDeps extends SparkEntryApplicationDeps {}

const FOREGROUND_GOAL_LOOP_INTERVAL_MS = 30_000;
const foregroundGoalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const foregroundGoalAwaitingTurns = new Map<string, ForegroundGoalAwaitingTurn>();

interface ForegroundGoalAwaitingTurn {
  piApi: SparkCommandApi;
  ctx: SparkCommandContext;
  failure?: string;
}

export function registerSparkCommands(
  pi: SparkCommandApi,
  deps: SparkCommandRegistrationDeps,
): void {
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
    if (!graph && !objective) {
      ctx.ui?.notify?.(
        "Spark goal mode needs an explicit objective when no Spark state exists.",
        "warning",
      );
      return;
    }
    const goal = await startOrInferSessionGoal(ctx.cwd, ctx, graph, objective || undefined);
    if (!goal) return;
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    const projectLabel = project ? ` · project: ${project.title}` : "";
    const visible = `Spark goal active${projectLabel} · goal: ${compactInline(goal.objective)}`;
    ctx.ui?.notify?.(visible, "info");
    deps.queueSparkAgentInstruction(
      ctx,
      [
        "Spark session goal is active.",
        project ? `Current project: ${project.title}` : undefined,
        `Goal: ${goal.objective}`,
        'Spark has started the foreground goal loop for this session. It will wait for the main agent to become idle, then continue at the goal interval. Use task({ action: "status" }) and goal({ action: "status" }) to inspect current work. Goal mode is non-interactive: do not call ask/ask_flow. If task decomposition is wrong or missing, create or revise concrete tasks with task({ action: "plan" }); if the goal itself is ambiguous, stop and report or pause the goal with goal.',
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
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
    const goal = await pauseCurrentSessionGoal(ctx.cwd, ctx, reason || undefined);
    if (!goal) {
      ctx.ui?.notify?.("No session goal is set.", "warning");
      return;
    }
    clearForegroundGoalLoop(ctx.cwd, ctx);
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    const visible = `Spark goal paused · goal: ${compactInline(goal.objective)}`;
    ctx.ui?.notify?.(visible, "info");
    piApi.sendMessage({ customType: "spark-goal-request", content: visible, display: true });
  }

  function scheduleForegroundGoalLoop(piApi: SparkCommandApi, ctx: SparkCommandContext): void {
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    clearForegroundGoalLoop(ctx.cwd, ctx);
    const timer = setTimeout(() => {
      foregroundGoalTimers.delete(key);
      void runForegroundGoalLoopTick(piApi, ctx).catch(reportGoalLoopError);
    }, FOREGROUND_GOAL_LOOP_INTERVAL_MS);
    timer.unref?.();
    foregroundGoalTimers.set(key, timer);
  }

  function clearForegroundGoalLoop(cwd: string, ctx: SparkCommandContext): void {
    const key = foregroundGoalLoopKey(cwd, ctx);
    const timer = foregroundGoalTimers.get(key);
    if (timer) clearTimeout(timer);
    foregroundGoalTimers.delete(key);
    foregroundGoalAwaitingTurns.delete(key);
  }

  function markForegroundGoalAwaitingTurn(piApi: SparkCommandApi, ctx: SparkCommandContext): void {
    const key = foregroundGoalLoopKey(ctx.cwd, ctx);
    const timer = foregroundGoalTimers.get(key);
    if (timer) clearTimeout(timer);
    foregroundGoalTimers.delete(key);
    foregroundGoalAwaitingTurns.set(key, { piApi, ctx });
  }

  async function runForegroundGoalLoopTick(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
  ): Promise<void> {
    const initial = await loadActiveForegroundGoal(ctx);
    if (!initial) return;
    await ctx.waitForIdle?.();
    const active = await loadActiveForegroundGoal(ctx);
    if (!active) return;
    const { project, goal } = active;
    const projectLabel = project ? ` · project: ${project.title}` : "";
    const visible = `Spark goal tick${projectLabel} · goal: ${compactInline(goal.objective)}`;
    deps.queueSparkAgentInstruction(
      ctx,
      renderForegroundGoalTickInstruction(project?.title, goal.objective),
    );
    piApi.sendMessage(
      { customType: "spark-goal-request", content: visible, display: true },
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
    for (const [key, awaiting] of pending) {
      foregroundGoalAwaitingTurns.delete(key);
      const agentOutcome = foregroundGoalAgentOutcome(event);
      const failure =
        agentOutcome.failure ?? (!agentOutcome.hasAssistantMessage ? awaiting.failure : undefined);
      if (failure) {
        await pauseForegroundGoalAfterFailedTurn(awaiting.ctx, failure);
        continue;
      }
      const active = await loadActiveForegroundGoal(awaiting.ctx);
      if (!active) continue;
      scheduleForegroundGoalLoop(awaiting.piApi ?? piApi, awaiting.ctx);
    }
  }

  function foregroundGoalAwaitingTurnsForSession(
    ctx: SparkToolContext,
  ): Array<[string, ForegroundGoalAwaitingTurn]> {
    const currentKey = foregroundGoalLoopKey(ctx.cwd, ctx);
    return [...foregroundGoalAwaitingTurns.entries()].filter(([key]) => key === currentKey);
  }

  async function pauseForegroundGoalAfterFailedTurn(
    ctx: SparkCommandContext,
    failure: string,
  ): Promise<void> {
    const reason = `Foreground goal loop paused after agent turn failed: ${failure}`;
    const goal = await updateSessionGoalStatus(ctx.cwd, ctx, "paused", { reason });
    if (!goal) return;
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    ctx.ui?.notify?.(`Spark goal paused after failed turn: ${compactInline(failure)}`, "warning");
  }

  function foregroundGoalAgentOutcome(event: unknown): {
    failure?: string;
    hasAssistantMessage: boolean;
  } {
    if (!event || typeof event !== "object") return { hasAssistantMessage: false };
    const messages = (event as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return { hasAssistantMessage: false };
    const assistantMessages = messages.filter(
      (message): message is Record<string, unknown> =>
        !!message &&
        typeof message === "object" &&
        (message as { role?: unknown }).role === "assistant",
    );
    const message = assistantMessages.at(-1);
    return {
      failure: message ? assistantMessageFailure(message) : undefined,
      hasAssistantMessage: assistantMessages.length > 0,
    };
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

  async function loadActiveForegroundGoal(ctx: SparkCommandContext): Promise<
    | {
        project?: NonNullable<Awaited<ReturnType<typeof currentSparkProject>>>;
        goal: NonNullable<Awaited<ReturnType<typeof loadSessionGoal>>>;
      }
    | undefined
  > {
    const goal = await loadSessionGoal(ctx.cwd, ctx);
    if (!goal || goal.status !== "active") return undefined;
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const project = graph ? await currentSparkProject(ctx.cwd, ctx, graph) : undefined;
    return { project, goal };
  }

  function renderForegroundGoalTickInstruction(
    projectTitle: string | undefined,
    objective: string,
  ): string {
    return [
      "Spark foreground goal loop tick.",
      projectTitle ? `Current project: ${projectTitle}` : undefined,
      `Goal: ${objective}`,
      'Inspect current work with task({ action: "status" }) and goal({ action: "status" }). If a concrete ready task is obvious, claim and complete one verified task in the foreground, then finish it with evidence. Goal mode is non-interactive: do not call ask/ask_flow. If task decomposition is wrong, missing, or blocks the goal, create or revise concrete tasks with task({ action: "plan" }) and continue from the updated ready work. If no ready path remains, validation fails, or the goal itself is ambiguous, stop and report or pause the goal with goal. Do not spawn background workflow execution from the goal loop.',
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

function reportGoalLoopError(error: unknown): void {
  console.warn(
    `Spark foreground goal loop failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
