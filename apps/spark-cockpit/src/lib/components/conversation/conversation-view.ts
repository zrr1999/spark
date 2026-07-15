import type { SparkMessageView } from "@zendev-lab/spark-protocol";
import type {
  ConversationApprovalState,
  ConversationChainStep,
  ConversationPart,
  ConversationTaskState,
  ConversationToolState,
} from "./types";

type UnknownRecord = Record<string, unknown>;

export function conversationPartsFromMessage(
  message: SparkMessageView,
  displayText = message.text,
): ConversationPart[] {
  const messageRecord = message as SparkMessageView & { parts?: unknown };
  const rawParts = Array.isArray(messageRecord.parts) ? messageRecord.parts : [];
  let parts = mergeMessageToolParts(
    rawParts.flatMap((part, index) => normalizePart(part, message, index)),
  );

  if (displayText !== message.text) {
    const matchingTextParts = parts.filter(
      (part) => part.type === "text" && part.text === message.text,
    );
    if (matchingTextParts.length === 1) {
      parts = parts.map((part) =>
        part.type === "text" && part.text === message.text ? { ...part, text: displayText } : part,
      );
    }
  }

  if (parts.length === 0) return fallbackParts(message, displayText);

  // Keep tools flat here so timeline merge can attach results. Chain grouping
  // happens after cross-message merges in buildSessionTimeline.
  return parts;
}

/**
 * Fold model reasoning, provider commentary, and tool process into one execution chain.
 * Answer text and other interaction parts stay outside the chain.
 */
export function groupThinkingChainParts(parts: readonly ConversationPart[]): ConversationPart[] {
  const chainSteps: ConversationChainStep[] = [];
  const rest: ConversationPart[] = [];

  for (const part of parts) {
    if (part.type === "reasoning" || part.type === "commentary" || part.type === "tool") {
      chainSteps.push(part);
      continue;
    }
    if (part.type === "chain") {
      chainSteps.push(...part.steps);
      continue;
    }
    rest.push(part);
  }

  if (chainSteps.length === 0) return [...rest];

  const chain: ConversationPart = {
    type: "chain",
    state: chainSteps.some(
      (step) =>
        ((step.type === "reasoning" || step.type === "commentary") && step.state === "streaming") ||
        (step.type === "tool" &&
          (step.state === "pending" ||
            step.state === "running" ||
            step.state === "awaiting-approval")),
    )
      ? "streaming"
      : "complete",
    steps: chainSteps,
  };

  const firstTextIndex = rest.findIndex((part) => part.type === "text");
  if (firstTextIndex < 0) return [chain, ...rest];
  return [...rest.slice(0, firstTextIndex), chain, ...rest.slice(firstTextIndex)];
}

/** Keep the execution chain in history; its component controls expanded/collapsed state. */
export function visibleConversationParts(parts: readonly ConversationPart[]): ConversationPart[] {
  return [...parts];
}

/** Copy and live-region text intentionally excludes internal execution detail. */
export function visibleConversationPartText(parts: readonly ConversationPart[]) {
  return conversationPartText(parts.filter((part) => part.type !== "chain"));
}

export function conversationPartText(parts: readonly ConversationPart[]) {
  return parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "reasoning") return [part.summary];
      if (part.type === "commentary") return [part.summary];
      if (part.type === "tool") return [part.summary || part.name];
      if (part.type === "chain") {
        return part.steps.flatMap((step) => {
          if (step.type === "reasoning" || step.type === "commentary") return [step.summary];
          return [step.summary || step.name];
        });
      }
      if (part.type === "task" || part.type === "approval") return [part.summary || part.title];
      if (part.type === "artifact") return [part.summary || part.title];
      if (part.type === "error") return [part.message || part.title];
      return [];
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function textConversationPart(text: string, streaming = false): ConversationPart {
  return { type: "text", text, streaming };
}

function normalizePart(
  value: unknown,
  message: SparkMessageView,
  index: number,
): ConversationPart[] {
  if (!isRecord(value)) return [];
  const type = stringField(value, "type");
  if (!type) return [];

  if (type === "text") {
    const text = stringField(value, "text");
    const streaming =
      stringField(value, "status") === "streaming" || message.status === "streaming";
    if (text?.trim() && stringField(value, "phase") === "commentary") {
      return [{ type: "commentary", summary: text, state: streaming ? "streaming" : "complete" }];
    }
    return text?.trim()
      ? [
          {
            type: "text",
            text,
            streaming,
          },
        ]
      : [];
  }

  if (type === "thinking" || type === "reasoning") {
    const redacted = value.redacted === true;
    const summary = redacted ? "" : (stringField(value, "summary") ?? stringField(value, "text"));
    return summary?.trim() || redacted
      ? [
          {
            type: "reasoning",
            summary: summary ?? "",
            state:
              stringField(value, "status") === "streaming" || message.status === "streaming"
                ? "streaming"
                : "complete",
            redacted,
          },
        ]
      : [];
  }

  if (type === "tool-call" || type === "tool-result" || type === "tool") {
    const callId =
      stringField(value, "callId") ??
      stringField(value, "toolCallId") ??
      message.toolCallId ??
      `${message.id}:tool:${index}`;
    const name =
      stringField(value, "name") ?? stringField(value, "toolName") ?? message.toolName ?? "tool";
    const summary =
      stringField(value, "summary") ??
      stringField(value, "text") ??
      (message.role === "tool" && message.text.trim() ? message.text.trim() : undefined) ??
      (type === "tool-result" && message.text.trim() ? message.text.trim() : undefined);
    return [
      {
        type: "tool",
        callId,
        name,
        state: toolState(stringField(value, "status") ?? message.status, type),
        ...(summary ? { summary } : {}),
      },
    ];
  }

  if (type === "task") {
    const taskRef = stringField(value, "taskRef") ?? `${message.id}:task:${index}`;
    return [
      {
        type: "task",
        taskRef,
        title: stringField(value, "title") ?? taskRef,
        state: taskState(stringField(value, "status")),
        summary: stringField(value, "summary"),
      },
    ];
  }

  if (type === "approval") {
    const requestId = stringField(value, "requestId") ?? `${message.id}:approval:${index}`;
    return [
      {
        type: "approval",
        requestId,
        title: stringField(value, "title") ?? requestId,
        state: approvalState(stringField(value, "status")),
        kind: stringField(value, "kind"),
        summary: stringField(value, "summary"),
      },
    ];
  }

  if (type === "artifact") {
    const artifactRef =
      stringField(value, "artifactRef") ??
      stringField(value, "artifactId") ??
      stringField(value, "ref") ??
      `${message.id}:artifact:${index}`;
    return [
      {
        type: "artifact",
        artifactRef,
        title: stringField(value, "title") ?? artifactRef,
        kind: stringField(value, "kind"),
        state: stringField(value, "state") ?? stringField(value, "status"),
        summary: stringField(value, "summary"),
      },
    ];
  }

  if (type === "error") {
    const title = stringField(value, "title") ?? "Error";
    return [
      {
        type: "error",
        title,
        message:
          stringField(value, "message") ??
          stringField(value, "summary") ??
          stringField(value, "text") ??
          title,
        code: stringField(value, "code"),
      },
    ];
  }

  return [{ type: "unknown", label: boundedLabel(type) }];
}

function fallbackParts(message: SparkMessageView, displayText: string): ConversationPart[] {
  if (!displayText.trim()) return [];
  if (message.role === "thinking") {
    return [
      {
        type: "reasoning",
        summary: displayText,
        state: message.status === "streaming" ? "streaming" : "complete",
      },
    ];
  }
  if (message.role === "tool") {
    return [
      {
        type: "tool",
        callId: message.toolCallId ?? message.id,
        name: message.toolName ?? "tool",
        state: toolState(message.status, "tool-result"),
        summary: displayText,
      },
    ];
  }
  return [{ type: "text", text: displayText, streaming: message.status === "streaming" }];
}

function toolState(value: string | undefined, partType: string): ConversationToolState {
  if (value === "awaiting-approval") return "awaiting-approval";
  if (["completed", "complete", "done", "succeeded", "success"].includes(value ?? "")) {
    return "completed";
  }
  if (["failed", "error"].includes(value ?? "")) return "failed";
  if (["denied", "rejected"].includes(value ?? "")) return "denied";
  if (["cancelled", "canceled"].includes(value ?? "")) return "cancelled";
  if (["running", "streaming"].includes(value ?? "")) return "running";
  if (partType === "tool-result") return "completed";
  return "pending";
}

function taskState(value: string | undefined): ConversationTaskState {
  if (["completed", "complete", "done", "succeeded", "success"].includes(value ?? "")) {
    return "completed";
  }
  if (["failed", "error"].includes(value ?? "")) return "failed";
  if (value === "blocked") return "blocked";
  if (["cancelled", "canceled"].includes(value ?? "")) return "cancelled";
  if (["running", "in_progress", "claimed"].includes(value ?? "")) return "running";
  return "pending";
}

function approvalState(value: string | undefined): ConversationApprovalState {
  if (["approved", "accepted"].includes(value ?? "")) return "approved";
  if (["answered", "resolved", "completed", "complete", "done"].includes(value ?? "")) {
    return "resolved";
  }
  if (["rejected", "denied"].includes(value ?? "")) return "rejected";
  if (["cancelled", "canceled"].includes(value ?? "")) return "cancelled";
  return "requested";
}

function mergeMessageToolParts(parts: ConversationPart[]) {
  const result: ConversationPart[] = [];
  const toolIndexes = new Map<string, number>();

  for (const part of parts) {
    if (part.type !== "tool") {
      result.push(part);
      continue;
    }
    const previousIndex = toolIndexes.get(part.callId);
    const previous = previousIndex === undefined ? undefined : result[previousIndex];
    if (previousIndex === undefined || previous?.type !== "tool") {
      toolIndexes.set(part.callId, result.length);
      result.push(part);
      continue;
    }
    result[previousIndex] = {
      ...previous,
      name: part.name || previous.name,
      state: laterToolState(previous.state, part.state),
      summary: preferToolSummary(previous.summary, part.summary, previous.state, part.state),
    };
  }

  return result;
}

/** Prefer completed/failed result text over call-argument previews. */
export function preferToolSummary(
  previous: string | undefined,
  next: string | undefined,
  previousState: ConversationToolState,
  nextState: ConversationToolState,
): string | undefined {
  const nextIsResult =
    nextState === "completed" ||
    nextState === "failed" ||
    nextState === "denied" ||
    nextState === "cancelled";
  const previousIsResult =
    previousState === "completed" ||
    previousState === "failed" ||
    previousState === "denied" ||
    previousState === "cancelled";
  if (nextIsResult && next?.trim()) return next.trim();
  if (previousIsResult && previous?.trim()) return previous.trim();
  if (next?.trim()) return next.trim();
  if (previous?.trim()) return previous.trim();
  return undefined;
}

function laterToolState(previous: ConversationToolState, next: ConversationToolState) {
  const rank: Record<ConversationToolState, number> = {
    pending: 0,
    "awaiting-approval": 1,
    running: 2,
    completed: 3,
    denied: 3,
    cancelled: 3,
    failed: 4,
  };
  return rank[next] >= rank[previous] ? next : previous;
}

function stringField(value: UnknownRecord, key: string) {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function boundedLabel(value: string) {
  return value.length <= 80 ? value : `${value.slice(0, 77)}…`;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
