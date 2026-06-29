export type ProjectChatCommand = {
  id: string;
  kind: string;
  title: string | null;
  payloadJson: string;
  status: string;
  deliveryStatus: string | null;
  createdAt: string;
};

export type ProjectChatInvocation = {
  id: string;
  runtimeInvocationId: string;
  taskRuntimeId: string | null;
  agentName: string | null;
  status: string;
  updatedAt: string;
};

export type ProjectChatLogChunk = {
  id: string;
  runtimeInvocationId: string;
  agentName: string | null;
  stream: string;
  sequence: number;
  content: string;
  createdAt: string;
};

export type ProjectChatTurnStatus = "waiting" | "running" | "completed" | "error" | "cancelled";

export type ProjectChatTranscriptTurn = {
  id: string;
  command: ProjectChatCommand;
  prompt: string;
  runtimeTaskId: string | null;
  invocations: ProjectChatInvocation[];
  logs: ProjectChatLogChunk[];
  status: ProjectChatTurnStatus;
  answer: string;
  currentActivity: string | null;
};

export type ProjectChatTranscriptLabels = {
  waitingAnswer: string;
  runningAnswer: string;
  completedAnswer: string;
  errorAnswer: string;
  cancelledAnswer: string;
  latestOutputPrefix: string;
};

export const defaultProjectChatTranscriptLabels: ProjectChatTranscriptLabels = {
  waitingAnswer: "Waiting for Spark to start.",
  runningAnswer: "Spark is working.",
  completedAnswer: "Spark finished this run.",
  errorAnswer: "Spark reported a problem.",
  cancelledAnswer: "This run was cancelled.",
  latestOutputPrefix: "Latest assistant output:",
};

export function buildProjectChatTranscriptTurns(
  sourceCommands: ProjectChatCommand[],
  sourceInvocations: ProjectChatInvocation[],
  sourceLogs: ProjectChatLogChunk[],
  labels: ProjectChatTranscriptLabels = defaultProjectChatTranscriptLabels,
) {
  return sourceCommands
    .filter((command) => command.kind === "task.start.request")
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((command): ProjectChatTranscriptTurn => {
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
        currentActivity,
      };
    });
}

export function parseCommandPayload(command: ProjectChatCommand) {
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

export function activityKind(log: ProjectChatLogChunk) {
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

export function latestActivity(logs: ProjectChatLogChunk[]) {
  const latest = logs.at(-1);
  if (!latest) return null;
  return oneLine(latest.content) || latest.stream;
}

function turnStatus(
  command: ProjectChatCommand,
  relatedInvocations: ProjectChatInvocation[],
  relatedLogs: ProjectChatLogChunk[],
): ProjectChatTurnStatus {
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
  status: ProjectChatTurnStatus,
  logs: ProjectChatLogChunk[],
  labels: ProjectChatTranscriptLabels,
) {
  if (status === "error") return labels.errorAnswer;
  if (status === "cancelled") return labels.cancelledAnswer;
  const output = latestReadableOutput(logs);
  if (output) return `${labels.latestOutputPrefix}\n${output}`;
  if (status === "completed") return labels.completedAnswer;
  if (status === "running") return labels.runningAnswer;
  return labels.waitingAnswer;
}

function latestReadableOutput(logs: ProjectChatLogChunk[]) {
  const content = logs
    .slice()
    .reverse()
    .find((log) => log.stream.toLowerCase() !== "stderr" && readableContent(log.content))
    ?.content.trim();
  if (!content) return null;
  return content.length > 520 ? `${content.slice(0, 517)}…` : content;
}

function readableContent(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return false;
  return true;
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
