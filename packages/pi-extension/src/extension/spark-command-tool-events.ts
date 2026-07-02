import type { SparkCommandApi } from "./spark-command-types.ts";

export function sendSparkRuntimeInstruction(
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

export function isGoalToolDeactivationEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const toolEvent = event as { toolName?: unknown; isError?: unknown; params?: unknown };
  if (toolEvent.toolName !== "goal" || toolEvent.isError === true) return false;
  if (!toolEvent.params || typeof toolEvent.params !== "object") return false;
  const action = (toolEvent.params as { action?: unknown }).action;
  return action === "pause" || action === "clear";
}

export function isLoopToolDeactivationEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const toolEvent = event as { toolName?: unknown; isError?: unknown; params?: unknown };
  if (toolEvent.toolName !== "loop" || toolEvent.isError === true) return false;
  if (!toolEvent.params || typeof toolEvent.params !== "object") return false;
  return (toolEvent.params as { action?: unknown }).action === "clear";
}

export function isLoopToolScheduleEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const toolEvent = event as { toolName?: unknown; isError?: unknown; params?: unknown };
  if (toolEvent.toolName !== "loop" || toolEvent.isError === true) return false;
  if (!toolEvent.params || typeof toolEvent.params !== "object") return false;
  return (toolEvent.params as { action?: unknown }).action === "schedule";
}
