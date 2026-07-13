import type { SparkMessageView } from "@zendev-lab/spark-protocol";
import {
  conversationPartsFromMessage,
  conversationPartText,
  textConversationPart,
} from "./components/conversation/conversation-view";
import type {
  ConversationMessageView,
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
};

export type SessionTimelineItem = ConversationMessageView & {
  order: number;
};

export function buildSessionTimeline(input: {
  messages: SparkMessageView[];
  commands: SessionTimelineCommand[];
  reports: SessionTimelineReport[];
  fallbackTimestamp: string;
}): SessionTimelineItem[] {
  const items: SessionTimelineItem[] = [];
  const canonicalMessageIds = new Set<string>();

  for (const [messageIndex, message] of input.messages.entries()) {
    if (message.display === false || message.role === "system") continue;
    const actor = message.role === "user" ? "user" : "spark";
    const displayText = actor === "user" ? displayUserMessage(message.text) : message.text;
    const parts = conversationPartsFromMessage(message, displayText);
    if (parts.length === 0) continue;
    canonicalMessageIds.add(message.id);
    items.push({
      id: `message:${message.id}`,
      actor,
      body: conversationPartText(parts) || displayText,
      title: null,
      status: message.status === "done" ? null : message.status,
      timestamp: message.createdAt ?? input.fallbackTimestamp,
      meta: message.role === "assistant" || message.role === "user" ? null : message.role,
      senderLabel: actor === "user" ? channelSenderLabel(message.metadata) : null,
      order: messageIndex,
      parts,
    });
  }

  // Assignment commands predate the daemon-owned native transcript. They do not
  // carry a canonical message ID, so they cannot be reconciled safely once a
  // session snapshot exists. Keep them only as an empty-snapshot compatibility
  // fallback; the activity panel still exposes them as internal run details.
  const legacySubmittedMessages = new Set<string>();
  if (canonicalMessageIds.size === 0) {
    for (const [commandIndex, command] of input.commands.entries()) {
      const body = command.goal?.trim() || command.title?.trim() || command.id;
      legacySubmittedMessages.add(normalizeMessage(body));
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

  for (const [reportIndex, report] of input.reports.entries()) {
    if (report.kind === "daemon.task.lifecycle" || report.role === "tool") continue;
    const sourceMessageId = sessionMessageId(report);
    if (sourceMessageId && canonicalMessageIds.has(sourceMessageId)) continue;
    const actor = isUserRole(report.role) ? "user" : "spark";
    if (
      canonicalMessageIds.size === 0 &&
      actor === "user" &&
      legacySubmittedMessages.has(normalizeMessage(report.text))
    ) {
      continue;
    }
    items.push({
      id: sourceMessageId ? `message:${sourceMessageId}` : `report:${report.id}`,
      actor,
      body: report.text,
      title: actor === "user" ? null : report.title,
      status: report.status,
      timestamp: report.createdAt,
      meta: report.role && !["assistant", "user"].includes(report.role) ? report.role : null,
      senderLabel: null,
      order: input.messages.length + input.commands.length + reportIndex,
      parts: [textConversationPart(report.text, report.status === "running")],
    });
  }

  const sortedItems = items.sort((left, right) => {
    const time = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    if (Number.isFinite(time) && time !== 0) return time;
    const lexical = left.timestamp.localeCompare(right.timestamp);
    return lexical || left.order - right.order || left.id.localeCompare(right.id);
  });
  return mergeTimelineToolParts(sortedItems);
}

function channelSenderLabel(metadata: SparkMessageView["metadata"]): string | null {
  const channel = isRecord(metadata.channel) ? metadata.channel : undefined;
  if (!channel) return null;
  const senderName = nonEmptyString(channel.senderName);
  if (senderName) return senderName;
  return nonEmptyString(channel.senderId);
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
        summary: part.summary || previous.summary,
      };
      owner.item.body = conversationPartText(owner.item.parts) || owner.item.body;
    }
    item.parts = retainedParts;
  }

  return result.filter((item) => item.parts.length > 0);
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

const LEGACY_INFOFLOW_TURN_PREFIX = "You are handling an Infoflow (如流) channel conversation.";
const LEGACY_INFOFLOW_MESSAGE_MARKER = "\nMessage:\n";

function displayUserMessage(text: string) {
  if (!text.startsWith(LEGACY_INFOFLOW_TURN_PREFIX)) return text;
  const marker = text.indexOf(LEGACY_INFOFLOW_MESSAGE_MARKER);
  if (marker < 0) return text;
  return text.slice(marker + LEGACY_INFOFLOW_MESSAGE_MARKER.length).trim() || text;
}

function sessionMessageId(report: SessionTimelineReport) {
  if (report.kind !== "session.message" || !report.id.startsWith("message:")) return null;
  const id = report.id.slice("message:".length).trim();
  return id || null;
}

function normalizeMessage(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isUserRole(role: string | null) {
  return role === "user" || role === "human" || role === "operator";
}
