import { Type } from "typebox";
import {
  clearSessionLoop,
  loadSessionLoop,
  normalizeLoopDelayMs,
  scheduleSessionLoopTick,
  type SparkSessionLoop,
} from "./spark-session-loops.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

export type SparkLoopToolAction = "status" | "schedule" | "clear";

interface SparkLoopToolDeps {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

export function registerSparkLoopTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkLoopToolDeps,
): void {
  registerSparkTool({
    name: "loop",
    label: "Spark Loop",
    description:
      'Manage the current session\'s open-ended /loop driver. Actions: status, schedule, clear. During a /loop foreground tick, call loop({ action: "schedule", delayMs, reason }) before ending the turn to choose the next tick time; if the right cadence depends on user preference, call ask first.',
    promptGuidelines: [
      "Use loop action=schedule inside /loop driver turns to choose the next tick delay instead of relying on a fixed interval.",
      "Choose delayMs from the objective and current context: short for active monitoring, longer for periodic checks, and ask the user when cadence affects cost, latency, or priority.",
      "Do not use loop for reviewer-gated completion; /goal and the goal tool own completion policy.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description:
            "status | schedule | clear. Defaults to status. schedule selects the next /loop tick time.",
        }),
      ),
      delayMs: Type.Optional(
        Type.Number({
          description:
            "Required for action=schedule. Delay before the next loop tick in milliseconds (minimum 1000, maximum 604800000).",
        }),
      ),
      reason: Type.Optional(
        Type.String({
          description:
            "Short reason for the schedule/clear decision. For schedule, explain why this cadence fits the objective.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = normalizeSparkLoopAction(params.action);
      const cwd = ctx.cwd;
      let existing = await loadSessionLoop(cwd, ctx);
      if (existing?.status === "paused") {
        await clearSessionLoop(cwd, ctx);
        await deps.refreshSparkWidget(cwd, ctx);
        existing = undefined;
      }

      if (action === "status") {
        return loopToolResult(existing, action, renderLoopStatus(existing));
      }

      if (!existing) {
        return {
          content: [{ type: "text" as const, text: "No Spark loop is set." }],
          details: { found: false, action, error: "no_loop" },
        };
      }

      if (action === "clear") {
        await clearSessionLoop(cwd, ctx);
        await deps.refreshSparkWidget(cwd, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: `Cleared Spark loop: ${oneLine(existing.objective)}`,
            },
          ],
          details: { found: true, action, clearedLoop: existing, loop: null },
        };
      }

      const delayResult = normalizeLoopScheduleDelay(params.delayMs);
      if (!delayResult.ok) {
        return {
          content: [{ type: "text" as const, text: delayResult.message }],
          details: { found: true, action, error: "invalid_delay_ms", loop: existing },
          isError: true,
        };
      }
      const scheduled = await scheduleSessionLoopTick(cwd, ctx, {
        delayMs: delayResult.delayMs,
        reason: normalizeOptionalString(params.reason),
        expectedLoopId: existing.loopId,
      });
      await deps.refreshSparkWidget(cwd, ctx);
      return loopToolResult(
        scheduled ?? existing,
        action,
        scheduled
          ? `Scheduled Spark loop next tick in ${formatDuration(delayResult.delayMs)} at ${scheduled.schedule?.nextRunAt}. Reason: ${scheduled.schedule?.reason ?? "not specified"}.`
          : "Spark loop schedule was not updated because the active loop changed.",
      );
    },
  });
}

export function normalizeSparkLoopAction(value: unknown): SparkLoopToolAction {
  if (value === undefined || value === null || value === "") return "status";
  if (value === "status" || value === "schedule" || value === "clear") return value;
  throw new Error("loop action must be status, schedule, or clear");
}

function normalizeLoopScheduleDelay(
  value: unknown,
): { ok: true; delayMs: number } | { ok: false; message: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: false, message: "loop action=schedule requires delayMs." };
  }
  try {
    return { ok: true, delayMs: normalizeLoopDelayMs(value) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "loop delayMs is invalid",
    };
  }
}

function loopToolResult(
  loop: SparkSessionLoop | undefined,
  action: SparkLoopToolAction,
  message: string,
) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { found: Boolean(loop), action, loop: loop ?? null },
  };
}

function renderLoopStatus(loop: SparkSessionLoop | undefined): string {
  if (!loop) return "No Spark loop is set.";
  const lines = [
    `Spark loop ${loop.status}.`,
    `Objective: ${oneLine(loop.objective)}`,
    loop.schedule
      ? `Next tick: ${loop.schedule.nextRunAt} (${formatDuration(loop.schedule.delayMs)}; reason: ${loop.schedule.reason ?? "not specified"})`
      : 'Next tick: not scheduled. Active /loop turns should call loop({ action: "schedule", delayMs, reason }).',
    loop.retryState?.consecutiveFailures
      ? `Retry state: ${loop.retryState.consecutiveFailures} failure(s), nextDelayMs=${loop.retryState.nextDelayMs ?? "none"}`
      : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("loop reason must be a string");
  return value.trim() || undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function formatDuration(delayMs: number): string {
  if (delayMs % 3_600_000 === 0) return `${delayMs / 3_600_000}h`;
  if (delayMs % 60_000 === 0) return `${delayMs / 60_000}m`;
  if (delayMs % 1_000 === 0) return `${delayMs / 1_000}s`;
  return `${delayMs}ms`;
}
