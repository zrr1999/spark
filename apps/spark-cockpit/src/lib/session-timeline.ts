import type { SparkMessageView } from "@zendev-lab/spark-protocol";
import { shortenOpaqueChannelId } from "./channel-session-title";
import { isInternalExecutionTransportFailure } from "./components/conversation/internal-execution-detail";
import {
  conversationPartsFromMessage,
  conversationPartText,
  groupThinkingChainParts,
  preferToolSummary,
  textConversationPart,
} from "./components/conversation/conversation-view";
import type {
  ConversationApprovalState,
  ConversationMessageView,
  ConversationPart,
  ConversationTaskState,
  ConversationToolState,
} from "./components/conversation/types";

export type SessionTimelineCommand = {
  id: string;
  title: string | null;
  goal: string | null;
  status: string;
  deliveryStatus: string | null;
  invocationStatus: string | null;
  createdAt: string;
};

export type SessionTimelineReport = {
  id: string;
  kind: string;
  title: string;
  text: string;
  role: string | null;
  status: string | null;
  createdAt: string;
  runKind?: string;
  message?: SparkMessageView;
  interaction?: {
    requestId: string | null;
    kind: string | null;
  };
};

export type SessionTimelineItem = ConversationMessageView & {
  order: number;
};

export const SESSION_TIMELINE_PAGE_SIZE = 32;

/**
 * Bound the amount of historical conversation UI mounted at once. Session
 * snapshots remain complete; this only windows the expensive Markdown and
 * tool-chain component tree, and callers can reveal older pages on demand.
 */
export function sessionTimelineWindow(
  items: readonly SessionTimelineItem[],
  requestedLimit: number,
): { items: SessionTimelineItem[]; hiddenCount: number } {
  const limit = Math.max(1, Math.floor(requestedLimit));
  let start = Math.max(0, items.length - limit);

  // Avoid opening a window on an assistant reply when its user prompt is the
  // immediately preceding item. The extra item keeps turn context intact.
  if (start > 0 && items[start]?.actor === "spark" && items[start - 1]?.actor !== "spark") {
    start -= 1;
  }

  return {
    items: items.slice(start),
    hiddenCount: start,
  };
}

export type SessionRetryCandidate = {
  prompt: string;
  failureMessageId: string;
};

/**
 * Select retry from the canonical daemon transcript. Activity reports are
 * deliberately excluded: a failed run projection is not necessarily a failed
 * conversation turn, and a later task/artifact report must not hide a genuine
 * turn failure.
 */
export function latestSessionRetryCandidate(
  messages: readonly SparkMessageView[],
): SessionRetryCandidate | null {
  const promptsByInvocation = new Map<string, string>();
  let latestUserPrompt: string | null = null;
  let candidate: SessionRetryCandidate | null = null;

  for (const message of messages) {
    if (
      message.display === false ||
      (message.role === "system" && !conversationSystemMessageVisible(message))
    ) {
      continue;
    }

    const invocationId = nonEmptyString(message.metadata.invocationId);
    if (message.role === "user") {
      const prompt = displayUserMessage(message.text).trim();
      if (prompt) {
        latestUserPrompt = prompt;
        if (invocationId) promptsByInvocation.set(invocationId, prompt);
      }
      candidate = null;
      continue;
    }

    // Tool failures are execution detail. A retry becomes available only when
    // the turn itself ends in a visible assistant/system failure.
    if (message.role === "tool") continue;

    const parts = conversationPartsFromMessage(message);
    if (
      isFailedTerminalStatus(message.status) &&
      parts.some((part) => part.type === "error" || part.type === "notice")
    ) {
      const prompt =
        (invocationId ? promptsByInvocation.get(invocationId) : null) ?? latestUserPrompt;
      candidate = prompt ? { prompt, failureMessageId: message.id } : null;
      continue;
    }

    // A displayable final assistant response closes the latest turn. Process-
    // only assistant messages do not, because their final outcome may follow.
    if (
      message.role === "assistant" &&
      parts.some((part) => part.type === "text" && part.text.trim())
    ) {
      candidate = null;
    }
  }

  return candidate;
}

export function latestSessionRetryPrompt(messages: readonly SparkMessageView[]): string | null {
  return latestSessionRetryCandidate(messages)?.prompt ?? null;
}

export function activeSessionTimelineProcessItemId(
  items: readonly SessionTimelineItem[],
  hasActiveTurn: boolean,
): string | null {
  if (!hasActiveTurn) return null;
  return (
    items.findLast(
      (item) =>
        item.actor === "spark" &&
        item.parts.some((part) => part.type === "chain" && part.state === "streaming"),
    )?.id ?? null
  );
}

export function buildSessionTimeline(input: {
  messages: SparkMessageView[];
  commands: SessionTimelineCommand[];
  reports: SessionTimelineReport[];
  fallbackTimestamp: string;
}): SessionTimelineItem[] {
  const items: SessionTimelineItem[] = [];
  const canonicalMessageIds = new Set<string>();
  const canonicalUserInvocationIds = new Set<string>();
  const canonicalFallbackMatches = new Map<string, number>();
  for (const [messageIndex, message] of input.messages.entries()) {
    if (
      message.display === false ||
      (message.role === "system" && !conversationSystemMessageVisible(message))
    ) {
      continue;
    }
    const actor = messageActor(message);
    const displayText = actor === "spark" ? message.text : displayUserMessage(message.text);
    const parts = conversationPartsFromMessage(message, displayText);
    if (parts.length === 0) continue;
    canonicalMessageIds.add(message.id);
    const invocationId = userMessageInvocationId(message);
    if (invocationId) canonicalUserInvocationIds.add(invocationId);
    if (message.role === "user" || isFailedTerminalStatus(message.status)) {
      incrementCount(canonicalFallbackMatches, fallbackMatchKey(actor, displayText));
    }
    items.push({
      id: `message:${message.id}`,
      actor,
      body: conversationItemBody(parts, displayText),
      title: null,
      status: conversationItemStatus(message.status, message.role, parts),
      timestamp: message.createdAt ?? input.fallbackTimestamp,
      meta: conversationRoleMeta(message.role),
      senderLabel:
        actor === "session"
          ? sessionSenderLabel(message.metadata)
          : actor === "user"
            ? channelSenderLabel(message.metadata)
            : null,
      order: messageIndex,
      parts,
    });
  }

  // Assignment commands predate the daemon-owned native transcript. They do not
  // carry a canonical message ID, so they cannot be reconciled safely once a
  // session snapshot exists. Keep them only as an empty-snapshot compatibility
  // fallback; the activity panel still exposes them as internal run details.
  const legacySubmittedMessages = new Map<string, number>();
  if (canonicalMessageIds.size === 0) {
    for (const [commandIndex, command] of input.commands.entries()) {
      const body = command.goal?.trim() || command.title?.trim() || command.id;
      incrementCount(legacySubmittedMessages, normalizeMessage(body));
      items.push({
        id: `command:${command.id}`,
        actor: "user",
        body,
        title: null,
        status: command.invocationStatus ?? command.deliveryStatus ?? command.status,
        timestamp: command.createdAt,
        meta: null,
        senderLabel: null,
        order: input.messages.length + commandIndex,
        parts: [textConversationPart(body)],
      });
    }
  }

  for (const [reportIndex, report] of latestStableReports(input.reports).entries()) {
    if (
      report.kind === "daemon.task.lifecycle" ||
      (report.kind === "run.update" && report.runKind === "session") ||
      report.role === "tool" ||
      isInternalExecutionFailureReport(report) ||
      (report.role === "system" && report.message?.metadata.conversationVisible !== true)
    ) {
      continue;
    }
    const sourceMessageId = sessionMessageId(report);
    if (sourceMessageId && canonicalMessageIds.has(sourceMessageId)) continue;
    const reportInvocationId = report.message ? userMessageInvocationId(report.message) : null;
    if (reportInvocationId && canonicalUserInvocationIds.has(reportInvocationId)) continue;
    const actor = report.message
      ? messageActor(report.message)
      : isUserRole(report.role)
        ? "user"
        : "spark";
    if (
      isDirectTurnFallback(report) &&
      consumeCount(canonicalFallbackMatches, fallbackMatchKey(actor, report.text))
    ) {
      continue;
    }
    if (
      canonicalMessageIds.size === 0 &&
      actor === "user" &&
      isDirectTurnFallback(report) &&
      consumeCount(legacySubmittedMessages, normalizeMessage(report.text))
    ) {
      continue;
    }
    const parts = report.message
      ? conversationPartsFromMessage(
          report.message,
          actor === "spark" ? report.message.text : displayUserMessage(report.message.text),
        )
      : conversationPartsFromReport(report);
    const hasStructuredReportPart = parts.some(
      (part) =>
        part.type === "task" ||
        part.type === "approval" ||
        part.type === "artifact" ||
        part.type === "error",
    );
    items.push({
      id: sourceMessageId ? `message:${sourceMessageId}` : `report:${report.id}`,
      actor,
      body: conversationItemBody(parts, report.text),
      title: actor !== "spark" || hasStructuredReportPart ? null : report.title,
      status: conversationItemStatus(report.status, report.message?.role, parts),
      timestamp: report.createdAt,
      meta: conversationRoleMeta(report.role),
      senderLabel:
        actor === "session" && report.message
          ? sessionSenderLabel(report.message.metadata)
          : actor === "user" && report.message
            ? channelSenderLabel(report.message.metadata)
            : null,
      order: input.messages.length + input.commands.length + reportIndex,
      parts,
    });
  }

  const sortedItems = items.sort((left, right) => {
    const time = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    if (Number.isFinite(time) && time !== 0) return time;
    const lexical = left.timestamp.localeCompare(right.timestamp);
    return lexical || left.order - right.order || left.id.localeCompare(right.id);
  });
  return mergeTimelineThinkingChains(
    mergeConsecutiveSparkMessages(
      mergeTimelineInteractionParts(mergeTimelineToolParts(sortedItems)),
    ),
  );
}

function isInternalExecutionFailureReport(report: SessionTimelineReport): boolean {
  if (report.kind !== "run.update" && report.kind !== "task.update") return false;
  if (!isFailedTerminalStatus(report.status)) return false;
  return isInternalExecutionTransportFailure(`${report.title}\n${report.text}`);
}

function conversationSystemMessageVisible(message: SparkMessageView): boolean {
  return message.metadata.conversationVisible === true;
}

/** Raw protocol roles like `tool` / `thinking` are process noise, not user-facing meta. */
function conversationRoleMeta(role: string | null | undefined): string | null {
  if (!role) return null;
  if (role === "assistant" || role === "user" || role === "tool" || role === "thinking") {
    return null;
  }
  return role;
}

function conversationItemStatus(
  status: string | null | undefined,
  role: SparkMessageView["role"] | undefined,
  parts: readonly ConversationPart[],
): string | null {
  if (!status || status === "done" || role === "tool") return null;
  // These parts already communicate the outcome. Repeating an Error badge in
  // the message header adds no information and mislabels incomplete work.
  if (parts.some((part) => part.type === "error" || part.type === "notice")) return null;
  return status;
}

function conversationItemBody(parts: readonly ConversationPart[], fallback: string): string {
  // Notice copy is localized at render time. Never leak the provider/internal
  // diagnostic used to classify that notice into copy, announcements, or keys.
  if (parts.some((part) => part.type === "notice")) return "";
  return conversationPartText(parts) || fallback;
}

function channelSenderLabel(metadata: SparkMessageView["metadata"]): string | null {
  const channel = isRecord(metadata.channel) ? metadata.channel : undefined;
  if (!channel) return null;
  const senderName = nonEmptyString(channel.senderName);
  if (senderName) return senderName;
  const senderId = nonEmptyString(channel.senderId);
  return senderId ? shortenOpaqueChannelId(senderId) : null;
}

function messageActor(message: SparkMessageView): ConversationMessageView["actor"] {
  if (message.role !== "user") return "spark";
  const origin = isRecord(message.metadata.origin) ? message.metadata.origin : undefined;
  return origin?.kind === "session" ? "session" : "user";
}

function sessionSenderLabel(metadata: SparkMessageView["metadata"]): string | null {
  const mail = isRecord(metadata.sessionMail) ? metadata.sessionMail : undefined;
  const origin = isRecord(metadata.origin) ? metadata.origin : undefined;
  const sessionId = nonEmptyString(mail?.fromSessionId) ?? nonEmptyString(origin?.sessionId);
  if (!sessionId) return null;
  const compact = sessionId.startsWith("session:") ? sessionId.slice("session:".length) : sessionId;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(compact)) return `${compact.slice(0, 8)}…`;
  return compact.length > 24 ? `${compact.slice(0, 12)}…` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mergeTimelineToolParts(items: SessionTimelineItem[]) {
  const result = items.map((item) => ({ ...item, parts: [...item.parts] }));
  const toolOwners = new Map<string, { item: SessionTimelineItem; partIndex: number }>();

  for (const item of result) {
    const retainedParts: ConversationMessageView["parts"] = [];
    for (const part of item.parts) {
      if (part.type !== "tool") {
        retainedParts.push(part);
        continue;
      }

      const owner = toolOwners.get(part.callId);
      if (!owner) {
        toolOwners.set(part.callId, { item, partIndex: retainedParts.length });
        retainedParts.push(part);
        continue;
      }

      const previous = owner.item.parts[owner.partIndex];
      if (previous?.type !== "tool") continue;
      owner.item.parts[owner.partIndex] = {
        ...previous,
        name: part.name || previous.name,
        state: laterToolState(previous.state, part.state),
        summary: preferToolSummary(previous.summary, part.summary, previous.state, part.state),
      };
      owner.item.body = conversationPartText(owner.item.parts) || owner.item.body;
    }
    item.parts = retainedParts;
  }

  return result.filter((item) => item.parts.length > 0);
}

/**
 * Fold consecutive daemon transcript messages into one assistant turn, like Pi/Codex.
 * Only merge when the turn involves tool/thinking process — keep plain text replies
 * separate so report projections with new IDs are not collapsed by equal text.
 */
function mergeConsecutiveSparkMessages(items: SessionTimelineItem[]) {
  const result: SessionTimelineItem[] = [];
  for (const item of items) {
    const previous = result.at(-1);
    if (previous && shouldMergeSparkTurn(previous, item)) {
      const mergedParts = mergeToolsInParts([...previous.parts, ...item.parts]);
      previous.parts = mergedParts;
      previous.body = conversationPartText(mergedParts) || previous.body;
      previous.status = laterMessageStatus(previous.status, item.status);
      previous.timestamp = item.timestamp || previous.timestamp;
      // Drop tool/thinking-only meta once folded into the turn.
      if (previous.meta && !item.meta) previous.meta = null;
      continue;
    }
    result.push({ ...item, parts: [...item.parts] });
  }
  return result;
}

function shouldMergeSparkTurn(previous: SessionTimelineItem, next: SessionTimelineItem): boolean {
  if (previous.actor !== "spark" || next.actor !== "spark") return false;
  if (!previous.id.startsWith("message:") || !next.id.startsWith("message:")) return false;
  // Fold tool/thinking process into the surrounding assistant turn.
  return hasProcessParts(previous.parts) || hasProcessParts(next.parts);
}

function hasProcessParts(parts: readonly ConversationPart[]): boolean {
  return parts.some(
    (part) =>
      part.type === "tool" ||
      part.type === "reasoning" ||
      part.type === "commentary" ||
      part.type === "chain",
  );
}

function mergeTimelineThinkingChains(items: SessionTimelineItem[]) {
  return items.map((item) => {
    const parts = groupThinkingChainParts(item.parts);
    return {
      ...item,
      parts,
      body: conversationPartText(parts) || item.body,
    };
  });
}

function mergeToolsInParts(parts: ConversationPart[]) {
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

function laterMessageStatus(previous: string | null, next: string | null): string | null {
  if (!previous) return next;
  if (!next) return previous;
  const rank = (value: string) => {
    const normalized = value.toLocaleLowerCase();
    if (["failed", "error", "errored"].includes(normalized)) return 4;
    if (["cancelled", "canceled"].includes(normalized)) return 3;
    if (["done", "completed", "complete", "succeeded", "success"].includes(normalized)) return 2;
    if (["running", "streaming", "pending", "queued"].includes(normalized)) return 1;
    return 0;
  };
  return rank(next) >= rank(previous) ? next : previous;
}

function laterToolState(
  previous: ConversationToolState,
  next: ConversationToolState,
): ConversationToolState {
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

function mergeTimelineInteractionParts(items: SessionTimelineItem[]) {
  const result = items.map((item) => ({ ...item, parts: [...item.parts] }));
  const interactionOwners = new Map<string, { item: SessionTimelineItem; partIndex: number }>();

  for (const item of result) {
    const retainedParts: ConversationMessageView["parts"] = [];
    for (const part of item.parts) {
      if (part.type !== "approval") {
        retainedParts.push(part);
        continue;
      }

      const owner = interactionOwners.get(part.requestId);
      if (!owner) {
        interactionOwners.set(part.requestId, { item, partIndex: retainedParts.length });
        retainedParts.push(part);
        continue;
      }

      const previous = owner.item.parts[owner.partIndex];
      if (previous?.type !== "approval") continue;
      owner.item.parts[owner.partIndex] = {
        ...previous,
        title: previous.title || part.title,
        state: laterApprovalState(previous.state, part.state),
        kind: previous.kind || part.kind,
        summary: previous.summary || part.summary,
      };
      owner.item.body = conversationPartText(owner.item.parts) || owner.item.body;
    }
    item.parts = retainedParts;
  }

  return result.filter((item) => item.parts.length > 0);
}

function laterApprovalState(
  previous: ConversationApprovalState,
  next: ConversationApprovalState,
): ConversationApprovalState {
  if (previous === "requested") return next;
  return previous;
}

const LEGACY_INFOFLOW_TURN_PREFIX = "You are handling an Infoflow (如流) channel conversation.";
const LEGACY_INFOFLOW_MESSAGE_MARKER = "\nMessage:\n";

function displayUserMessage(text: string) {
  if (!text.startsWith(LEGACY_INFOFLOW_TURN_PREFIX)) return text;
  const marker = text.indexOf(LEGACY_INFOFLOW_MESSAGE_MARKER);
  if (marker < 0) return text;
  return text.slice(marker + LEGACY_INFOFLOW_MESSAGE_MARKER.length).trim() || text;
}

function sessionMessageId(report: SessionTimelineReport) {
  if (report.kind === "session.message" && report.message?.id) return report.message.id;
  if (report.kind !== "session.message" || !report.id.startsWith("message:")) return null;
  const id = report.id.slice("message:".length).trim();
  return id || null;
}

function userMessageInvocationId(message: SparkMessageView): string | null {
  if (message.role !== "user") return null;
  return nonEmptyString(message.metadata.invocationId);
}

function normalizeMessage(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isDirectTurnFallback(report: SessionTimelineReport): boolean {
  return report.kind === "turn.submit.prompt" || report.kind === "turn.submit.failure";
}

function fallbackMatchKey(actor: ConversationMessageView["actor"], text: string): string {
  return `${actor}:${normalizeMessage(text)}`;
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function consumeCount(counts: Map<string, number>, key: string): boolean {
  const count = counts.get(key) ?? 0;
  if (count <= 0) return false;
  if (count === 1) counts.delete(key);
  else counts.set(key, count - 1);
  return true;
}

function isUserRole(role: string | null) {
  return role === "user" || role === "human" || role === "operator";
}

function conversationPartsFromReport(report: SessionTimelineReport): ConversationPart[] {
  if (report.kind === "run.update" && isFailedTerminalStatus(report.status)) {
    return [
      {
        type: "error",
        title: report.title,
        message: report.text.trim() || report.title,
      },
    ];
  }

  if (report.kind === "run.update") {
    return [
      {
        type: "task",
        taskRef: report.id,
        title: report.title,
        state: taskReportState(report.status),
        summary: report.text.trim() ? report.text : undefined,
      },
    ];
  }

  if (report.kind === "task.update") {
    return [
      {
        type: "task",
        taskRef: report.id,
        title: report.title,
        state: taskReportState(report.status),
        summary: report.text.trim() ? report.text : undefined,
      },
    ];
  }

  if (report.kind === "daemon.interaction.request") {
    const interactionKind = report.interaction?.kind ?? "";
    const requestId = report.interaction?.requestId ?? report.id;
    if (isAskInteractionKind(interactionKind)) {
      return [
        {
          type: "tool",
          callId: requestId,
          name: "ask",
          state: "running",
          summary: report.text.trim() ? report.text : report.title,
        },
      ];
    }
    return [
      {
        type: "approval",
        requestId,
        title: report.title,
        state: "requested",
        kind: interactionKind || undefined,
        summary: report.text.trim() ? report.text : undefined,
      },
    ];
  }

  if (report.kind === "daemon.interaction.response") {
    const interactionKind = report.interaction?.kind ?? "";
    const requestId = report.interaction?.requestId ?? report.id;
    if (isAskInteractionKind(interactionKind)) {
      return [
        {
          type: "tool",
          callId: requestId,
          name: "ask",
          state: interactionResponseToolState(report.status),
          summary: report.text.trim() ? report.text : report.title,
        },
      ];
    }
    return [
      {
        type: "approval",
        requestId,
        title: report.title,
        state: interactionResponseState(report.status),
        kind: interactionKind || undefined,
        summary: report.text.trim() ? report.text : undefined,
      },
    ];
  }

  if (report.kind.startsWith("artifact.") || report.kind === "artifact.update") {
    const kind =
      report.kind === "artifact.update" ? "artifact" : report.kind.slice("artifact.".length).trim();
    return [
      {
        type: "artifact",
        artifactRef: report.id.startsWith("artifact:") ? report.id : `artifact:${report.id}`,
        title: report.title,
        kind: kind || undefined,
        state: report.status ?? undefined,
        summary: report.text.trim() ? report.text : undefined,
      },
    ];
  }

  if (isFailedTerminalStatus(report.status)) {
    return [
      {
        type: "error",
        title: report.title,
        message: report.text.trim() || report.title,
      },
    ];
  }

  return [textConversationPart(report.text, report.status === "running")];
}

function latestStableReports(reports: SessionTimelineReport[]) {
  const latest = new Map<string, SessionTimelineReport>();
  for (const report of reports) {
    const key = stableReportKey(report);
    if (!key) continue;
    const previous = latest.get(key);
    if (!previous || report.createdAt > previous.createdAt) latest.set(key, report);
  }

  return reports.filter((report) => {
    const key = stableReportKey(report);
    return !key || latest.get(key) === report;
  });
}

function stableReportKey(report: SessionTimelineReport) {
  if (
    report.kind !== "run.update" &&
    report.kind !== "task.update" &&
    report.kind !== "artifact.update"
  ) {
    return null;
  }
  return `${report.kind}:${report.id}`;
}

function taskReportState(status: string | null): ConversationTaskState {
  const normalized = normalizedStatus(status);
  if (["completed", "complete", "done", "succeeded", "success"].includes(normalized)) {
    return "completed";
  }
  if (["failed", "error", "errored", "rejected"].includes(normalized)) return "failed";
  if (normalized === "blocked") return "blocked";
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["running", "in_progress", "claimed"].includes(normalized)) return "running";
  return "pending";
}

function isAskInteractionKind(kind: string): boolean {
  const normalized = kind.trim().toLocaleLowerCase().replaceAll("-", "_");
  return (
    normalized === "ask" ||
    normalized === "ask_user" ||
    normalized === "askflow" ||
    normalized === "ask_flow"
  );
}

function interactionResponseToolState(status: string | null): ConversationToolState {
  const normalized = normalizedStatus(status);
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["blocked", "error", "failed", "rejected", "denied"].includes(normalized)) {
    return "failed";
  }
  return "completed";
}

function interactionResponseState(status: string | null): ConversationApprovalState {
  const normalized = normalizedStatus(status);
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["blocked", "error", "failed", "rejected", "denied"].includes(normalized)) {
    return "rejected";
  }
  return "resolved";
}

function normalizedStatus(status: string | null) {
  return status?.trim().toLocaleLowerCase().replaceAll("-", "_") ?? "";
}

function isFailedTerminalStatus(status: string | null) {
  const normalized = normalizedStatus(status);
  return [
    "failed",
    "error",
    "errored",
    "rejected",
    "denied",
    "lost",
    "timeout",
    "timed_out",
  ].includes(normalized);
}
