import type { SparkCommandApi } from "./spark-command-types.ts";

export function sendSparkRuntimeInstruction(
  piApi: SparkCommandApi,
  customType: "spark-goal-request" | "spark-loop-request" | "spark-repro-request",
  instruction: string,
  visible: string,
  details: Record<string, unknown> = {},
): void {
  piApi.sendMessage(
    {
      customType,
      content: instruction,
      display: false,
      authority: "runtime_control",
      trust: "trusted",
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
  return action === "pause" || action === "clear" || action === "complete";
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

export function isReproToolDeactivationEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const toolEvent = event as { toolName?: unknown; isError?: unknown; params?: unknown };
  if (toolEvent.toolName !== "repro" || toolEvent.isError === true) return false;
  if (!toolEvent.params || typeof toolEvent.params !== "object") return false;
  return (toolEvent.params as { action?: unknown }).action === "stop";
}

export function isReproToolProgressEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const toolEvent = event as { toolName?: unknown; isError?: unknown; params?: unknown };
  if (toolEvent.toolName !== "repro" || toolEvent.isError === true) return false;
  if (!toolEvent.params || typeof toolEvent.params !== "object") return false;
  const action = (toolEvent.params as { action?: unknown }).action;
  return action === "start" || action === "satisfy" || action === "gate" || action === "advance";
}

export function isDriveToolReproStartEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const toolEvent = event as { toolName?: unknown; isError?: unknown; params?: unknown };
  if (toolEvent.toolName !== "drive" || toolEvent.isError === true) return false;
  if (!toolEvent.params || typeof toolEvent.params !== "object") return false;
  const params = toolEvent.params as { action?: unknown; drive?: unknown };
  const isStart = params.action === "start" || params.action === "switch";
  return isStart && params.drive === "repro";
}

export function isDriveToolReproStopEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const toolEvent = event as { toolName?: unknown; isError?: unknown; params?: unknown };
  if (toolEvent.toolName !== "drive" || toolEvent.isError === true) return false;
  if (!toolEvent.params || typeof toolEvent.params !== "object") return false;
  const params = toolEvent.params as { action?: unknown; drive?: unknown };
  if (params.action === "stop" && params.drive === "repro") return true;
  // Switching to a non-repro drive or explicit assist stops any active repro tick.
  const switchesAway =
    (params.action === "start" || params.action === "switch") &&
    params.drive !== undefined &&
    params.drive !== "repro";
  return switchesAway;
}
