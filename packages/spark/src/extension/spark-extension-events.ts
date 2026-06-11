import { defaultTaskGraphStore } from "pi-tasks";
import {
  ensureSparkStateForActiveWorkspace,
  handleSparkInput,
  injectSparkHints,
} from "./spark-active-injection.ts";
import {
  cleanupOwnedBackgroundSubroles,
  resumeOwnedBackgroundSubroles,
} from "./spark-background-subrole-lifecycle.ts";
import { ensureSparkClaimReaper, sweepExpiredSparkClaims } from "./spark-claim-reaper.ts";
import { ensureSparkGraphInvariants } from "./spark-graph-invariants.ts";
import { hasLocalSparkDirectory } from "./spark-activation.ts";
import { loadSparkGraph, saveSparkGraphAndTodos, sparkSessionOwnerKey } from "./session-state.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import {
  collectUnreadHiddenRoleRunInbox,
  formatHiddenRoleRunInbox,
  markHiddenRoleRunInboxDelivered,
} from "./role-run-completions.ts";
import type { SparkModeMessageApi } from "./spark-mode-entry.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

interface SparkExtensionEventApi extends SparkModeMessageApi {
  on?(event: string, handler: (event: unknown, ctx: SparkToolContext) => unknown): void;
  getActiveTools?(): string[];
  setActiveTools?(names: string[]): void;
}

interface SparkExtensionEventDeps {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  ensureDagManager: (cwd: string, ctx: SparkToolContext) => void;
}

export interface SparkExtensionEventHandlers {
  queueSparkAgentInstruction(
    ctx: SparkToolContext,
    instruction: string,
    options?: { goalId?: string },
  ): void;
}

export function registerSparkExtensionEvents(
  pi: SparkExtensionEventApi,
  deps: SparkExtensionEventDeps,
): SparkExtensionEventHandlers {
  const pendingSparkAgentInstructions = new Map<string, { instruction: string; goalId?: string }>();
  const goalToolBaselines = new Map<string, string[]>();

  function queueSparkAgentInstruction(
    ctx: SparkToolContext,
    instruction: string,
    options: { goalId?: string } = {},
  ): void {
    const sessionKey = sparkSessionOwnerKey(ctx);
    pendingSparkAgentInstructions.set(sessionKey, { instruction, goalId: options.goalId });
  }

  pi.on?.("input", async (event: unknown, ctx: SparkToolContext) =>
    handleSparkInput(event, ctx, {
      piApi: pi,
      deps: {
        queueSparkAgentInstruction,
        refreshSparkWidget: deps.refreshSparkWidget,
        ensureDagManager: deps.ensureDagManager,
      },
    }),
  );
  pi.on?.("before_role_start", async (event: unknown, ctx: SparkToolContext) =>
    injectSparkHints(event, ctx),
  );
  pi.on?.("before_agent_start", async (_event: unknown, ctx: SparkToolContext) => {
    await syncGoalInteractiveToolAvailability(pi, ctx, goalToolBaselines);
    const sessionKey = sparkSessionOwnerKey(ctx);
    const pendingEntry = pendingSparkAgentInstructions.get(sessionKey);
    const pendingInstruction = await activePendingInstruction(ctx, pendingEntry);
    if (pendingEntry && !pendingInstruction) pendingSparkAgentInstructions.delete(sessionKey);
    const inbox = await collectUnreadHiddenRoleRunInbox(ctx.cwd, ctx);
    if (!pendingInstruction && inbox.summaries.length === 0) {
      pendingSparkAgentInstructions.delete(sessionKey);
      return undefined;
    }
    const contentParts = pendingInstruction ? [pendingInstruction.instruction] : [];
    if (inbox.summaries.length > 0) contentParts.push(formatHiddenRoleRunInbox(inbox));
    if (inbox.summaries.length > 0)
      await markHiddenRoleRunInboxDelivered(ctx.cwd, ctx, inbox.summaries);
    if (pendingInstruction) pendingSparkAgentInstructions.delete(sessionKey);
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
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
    await syncGoalInteractiveToolAvailability(pi, ctx, goalToolBaselines);
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("session_start", async (_event: unknown, ctx: SparkToolContext) => {
    if (!(await hasLocalSparkDirectory(ctx.cwd))) return;
    ensureSparkClaimReaper(ctx.cwd);
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx, { skipSweep: true });
    await resumeOwnedBackgroundSubroles(ctx.cwd, ctx);
    await sweepExpiredSparkClaims(ctx.cwd, ctx);
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("session_compact", async (_event: unknown, ctx: SparkToolContext) => {
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("session_shutdown", async (event: unknown, ctx: SparkToolContext) => {
    await cleanupOwnedBackgroundSubroles(ctx.cwd, ctx, shutdownReason(event), {
      refreshSparkWidget: deps.refreshSparkWidget,
    });
  });
  pi.on?.("session_tree", async (_event: unknown, ctx: SparkToolContext) => {
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("tool_execution_end", async (event: unknown, ctx: SparkToolContext) => {
    if (isSparkWidgetRefreshToolEvent(event)) await deps.refreshSparkWidget(ctx.cwd, ctx);
    if (isToolExecutionEvent(event, "goal"))
      await syncGoalInteractiveToolAvailability(pi, ctx, goalToolBaselines);
  });
  pi.on?.("session_switch", async (_event: unknown, ctx: SparkToolContext) => {
    if (!(await hasLocalSparkDirectory(ctx.cwd))) return;
    ensureSparkClaimReaper(ctx.cwd);
    await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx, { skipSweep: true });
    await resumeOwnedBackgroundSubroles(ctx.cwd, ctx);
    await sweepExpiredSparkClaims(ctx.cwd, ctx);
    const store = defaultTaskGraphStore(ctx.cwd);
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    if (!graph) return;
    if (ensureSparkGraphInvariants(graph)) await saveSparkGraphAndTodos(ctx.cwd, graph, ctx, store);
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  });

  return { queueSparkAgentInstruction };
}

const GOAL_DISABLED_INTERACTIVE_TOOLS = new Set(["ask", "ask_user", "ask_flow"]);

type PendingSparkAgentInstruction = { instruction: string; goalId?: string };

async function activePendingInstruction(
  ctx: SparkToolContext,
  pending: PendingSparkAgentInstruction | undefined,
): Promise<PendingSparkAgentInstruction | undefined> {
  if (!pending?.goalId) return pending;
  const goal = await loadSessionGoal(ctx.cwd, ctx);
  return goal?.status === "active" && goal.goalId === pending.goalId ? pending : undefined;
}

async function syncGoalInteractiveToolAvailability(
  pi: SparkExtensionEventApi,
  ctx: SparkToolContext,
  baselines: Map<string, string[]>,
): Promise<void> {
  if (!pi.getActiveTools || !pi.setActiveTools) return;
  const key = `${ctx.cwd}:${sparkSessionOwnerKey(ctx)}`;
  const activeGoal = await hasActiveCurrentSessionGoal(ctx);
  if (activeGoal) {
    // Snapshot the currently *active* tools, not every registered tool. Using
    // getAllTools() here would re-activate tools that other extensions disabled
    // on purpose (e.g. pi-cue removes `bash` at session start), silently
    // re-enabling them for the rest of the session when the goal toggles.
    const baseline = baselines.get(key) ?? pi.getActiveTools();
    baselines.set(key, baseline);
    pi.setActiveTools(baseline.filter((name) => !GOAL_DISABLED_INTERACTIVE_TOOLS.has(name)));
    return;
  }
  const baseline = baselines.get(key);
  if (!baseline) return;
  pi.setActiveTools(baseline);
  baselines.delete(key);
}

async function hasActiveCurrentSessionGoal(ctx: SparkToolContext): Promise<boolean> {
  const goal = await loadSessionGoal(ctx.cwd, ctx);
  return goal?.status === "active";
}

function isSparkWidgetRefreshToolEvent(event: unknown): boolean {
  return isToolExecutionEvent(event, "task");
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
