export type CockpitChatCommand = {
  id: string;
  kind: string;
  title: string | null;
  payloadJson: string;
  status: string;
  deliveryStatus: string | null;
  createdAt: string;
};

export type CockpitChatInvocation = {
  id: string;
  runtimeInvocationId: string;
  taskRuntimeId: string | null;
  agentName: string | null;
  status: string;
  updatedAt: string;
};

export type CockpitChatLogChunk = {
  id: string;
  runtimeInvocationId: string;
  agentName: string | null;
  stream: string;
  sequence: number;
  content: string;
  createdAt: string;
};

export type CockpitChatTurnStatus = "waiting" | "running" | "completed" | "error" | "cancelled";

export type CockpitChatTranscriptTurn = {
  id: string;
  command: CockpitChatCommand;
  prompt: string;
  runtimeTaskId: string | null;
  invocations: CockpitChatInvocation[];
  logs: CockpitChatLogChunk[];
  status: CockpitChatTurnStatus;
  answer: string;
  renderSource: string | null;
  currentActivity: string | null;
};

export type CockpitChatTranscriptLabels = {
  waitingAnswer: string;
  runningAnswer: string;
  completedAnswer: string;
  errorAnswer: string;
  cancelledAnswer: string;
  latestOutputPrefix: string;
};

export const defaultCockpitChatTranscriptLabels: CockpitChatTranscriptLabels = {
  waitingAnswer: "Waiting for Spark to start.",
  runningAnswer: "Spark is working.",
  completedAnswer: "Spark finished this run.",
  errorAnswer: "Spark reported a problem.",
  cancelledAnswer: "This run was cancelled.",
  latestOutputPrefix: "Latest assistant output:",
};

export function buildCockpitChatTranscriptTurns(
  sourceCommands: CockpitChatCommand[],
  sourceInvocations: CockpitChatInvocation[],
  sourceLogs: CockpitChatLogChunk[],
  labels: CockpitChatTranscriptLabels = defaultCockpitChatTranscriptLabels,
) {
  return sourceCommands
    .filter((command) => command.kind === "task.start.request")
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((command): CockpitChatTranscriptTurn => {
      const payload = parseCommandPayload(command);
      const relatedInvocations = sourceInvocations
        .filter(
          (invocation) =>
            Boolean(payload.runtimeTaskId) && invocation.taskRuntimeId === payload.runtimeTaskId,
        )
        .slice()
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const relatedLogs = sourceLogs.filter((log) =>
        relatedInvocations.some(
          (invocation) => invocation.runtimeInvocationId === log.runtimeInvocationId,
        ),
      );
      const status = turnStatus(command, relatedInvocations, relatedLogs);
      const currentActivity = latestActivity(relatedLogs);

      return {
        id: command.id,
        command,
        prompt: payload.prompt || command.title || command.kind,
        runtimeTaskId: payload.runtimeTaskId,
        invocations: relatedInvocations,
        logs: relatedLogs,
        status,
        answer: assistantAnswer(status, relatedLogs, labels),
        renderSource: assistantRenderSource(status, relatedLogs),
        currentActivity,
      };
    });
}

export function parseCommandPayload(command: CockpitChatCommand) {
  try {
    const parsed = JSON.parse(command.payloadJson) as unknown;
    const payload = isRecord(parsed) && isRecord(parsed.payload) ? parsed.payload : {};
    return {
      prompt: typeof payload.prompt === "string" ? payload.prompt.trim() : null,
      runtimeTaskId:
        typeof payload.runtimeTaskId === "string" ? payload.runtimeTaskId.trim() : null,
    };
  } catch {
    return { prompt: null, runtimeTaskId: null };
  }
}

export function activityKind(log: CockpitChatLogChunk) {
  const stream = log.stream.toLowerCase();
  const content = log.content.toLowerCase();
  if (stream.includes("stderr") || content.includes("error") || content.includes("failed")) {
    return "error";
  }
  if (content.includes("tool") || content.includes("exec") || content.includes("command")) {
    return "tool";
  }
  if (content.includes("done") || content.includes("success") || content.includes("passed")) {
    return "success";
  }
  return "output";
}

export function latestActivity(logs: CockpitChatLogChunk[]) {
  const latest = logs.at(-1);
  if (!latest) return null;
  return oneLine(latest.content) || latest.stream;
}

function turnStatus(
  command: CockpitChatCommand,
  relatedInvocations: CockpitChatInvocation[],
  relatedLogs: CockpitChatLogChunk[],
): CockpitChatTurnStatus {
  if (command.deliveryStatus === "rejected" || command.deliveryStatus === "failed") return "error";
  if (command.status === "cancelled") return "cancelled";
  if (relatedInvocations.some((invocation) => isErrorStatus(invocation.status))) return "error";
  if (relatedLogs.some((log) => activityKind(log) === "error")) return "error";
  if (relatedInvocations.some((invocation) => isCancelledStatus(invocation.status)))
    return "cancelled";
  if (relatedInvocations.some((invocation) => isRunningStatus(invocation.status))) return "running";
  if (
    relatedInvocations.length > 0 &&
    relatedInvocations.every((invocation) => isCompletedStatus(invocation.status))
  ) {
    return "completed";
  }
  if (command.status === "acked" || command.deliveryStatus === "acked") return "running";
  return "waiting";
}

function assistantAnswer(
  status: CockpitChatTurnStatus,
  logs: CockpitChatLogChunk[],
  labels: CockpitChatTranscriptLabels,
) {
  if (status === "error") return labels.errorAnswer;
  if (status === "cancelled") return labels.cancelledAnswer;
  const output = orderedAssistantOutput(logs) ?? latestReadableOutput(logs);
  if (output) return `${labels.latestOutputPrefix}\n${output}`;
  if (status === "completed") return labels.completedAnswer;
  if (status === "running") return labels.runningAnswer;
  return labels.waitingAnswer;
}

function assistantRenderSource(status: CockpitChatTurnStatus, logs: CockpitChatLogChunk[]) {
  if (status === "error" || status === "cancelled") return null;
  return orderedAssistantRenderSource(logs) ?? latestReadableRenderSource(logs);
}

export function orderedAssistantOutput(logs: CockpitChatLogChunk[]) {
  return boundedOutput(orderedAssistantRenderSource(logs));
}

export function orderedAssistantRenderSource(logs: CockpitChatLogChunk[]) {
  const content = logs
    .filter((log) => log.stream.toLowerCase() === "assistant")
    .slice()
    .sort(compareLogChunks)
    .map((log) => readableLogText(log.content) ?? "")
    .join("");
  const trimmed = content.trim();
  return trimmed || null;
}

function latestReadableOutput(logs: CockpitChatLogChunk[]) {
  return boundedOutput(latestReadableRenderSource(logs));
}

function latestReadableRenderSource(logs: CockpitChatLogChunk[]) {
  const content = logs
    .slice()
    .reverse()
    .filter((log) => log.stream.toLowerCase() !== "stderr")
    .map((log) => readableLogText(log.content))
    .find((text) => Boolean(text));
  return content || null;
}

function boundedOutput(content: string | null) {
  if (!content) return null;
  return content.length > 520 ? `${content.slice(0, 517)}…` : content;
}

function compareLogChunks(left: CockpitChatLogChunk, right: CockpitChatLogChunk) {
  const bySequence = left.sequence - right.sequence;
  if (bySequence !== 0) return bySequence;
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return left.id.localeCompare(right.id);
}

function readableLogText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || isBoilerplateLogText(trimmed)) return null;
  const parsed = parseJson(trimmed);
  if (parsed !== null) return assistantTextFromEvent(parsed);
  return value;
}

function assistantTextFromEvent(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (value.type === "stream_event" && isRecord(value.event)) {
    return assistantTextFromStreamEvent(value.event);
  }
  if (value.type === "turn_complete") return assistantTextFromMessage(value.message);
  if (
    value.type === "view_event" &&
    isRecord(value.event) &&
    value.event.type === "session.message"
  ) {
    return assistantTextFromMessage(value.event.message);
  }
  return assistantTextFromMessage(value.message);
}

function assistantTextFromStreamEvent(event: Record<string, unknown>): string | null {
  if (event.type === "text_delta" && typeof event.delta === "string") return event.delta;
  if (event.type === "text_end" && typeof event.content === "string") return event.content;
  if (event.type === "done") return assistantTextFromMessage(event.message);
  return null;
}

function assistantTextFromMessage(value: unknown): string | null {
  if (!isRecord(value) || value.role !== "assistant") return null;
  return messageContentText(value.content);
}

function messageContentText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((block) => {
      if (!isRecord(block)) return "";
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("")
    .trim();
  return text || null;
}

function parseJson(value: string): unknown | null {
  if (!value.startsWith("{") || !value.endsWith("}")) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isBoilerplateLogText(value: string) {
  return value === "Spark runtime role-run started.";
}

function oneLine(value: string) {
  const first = value.trim().split(/\r?\n/).find(Boolean) ?? "";
  return first.length > 140 ? `${first.slice(0, 137)}…` : first;
}

function normalizeStatus(value: string) {
  return value.toLowerCase().replaceAll("_", "-");
}

function isRunningStatus(value: string) {
  return ["queued", "running", "in-progress", "processing"].includes(normalizeStatus(value));
}

function isCompletedStatus(value: string) {
  return ["done", "completed", "complete", "succeeded", "success", "resolved"].includes(
    normalizeStatus(value),
  );
}

function isCancelledStatus(value: string) {
  return ["cancelled", "canceled"].includes(normalizeStatus(value));
}

function isErrorStatus(value: string) {
  return ["failed", "error", "timed-out", "timeout", "rejected"].includes(normalizeStatus(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
