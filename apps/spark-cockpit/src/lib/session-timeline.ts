import type { SparkMessageView } from "@zendev-lab/spark-protocol";

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

export type SessionTimelineItem = {
  id: string;
  actor: "user" | "spark";
  body: string;
  title: string | null;
  status: string | null;
  timestamp: string;
  meta: string | null;
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
    if (
      message.display === false ||
      !message.text.trim() ||
      ["system", "tool", "thinking"].includes(message.role)
    ) {
      continue;
    }
    const actor = message.role === "user" ? "user" : "spark";
    canonicalMessageIds.add(message.id);
    items.push({
      id: `message:${message.id}`,
      actor,
      body: actor === "user" ? displayUserMessage(message.text) : message.text,
      title: null,
      status: message.status === "done" ? null : message.status,
      timestamp: message.createdAt ?? input.fallbackTimestamp,
      meta: message.role === "assistant" || message.role === "user" ? null : message.role,
      order: messageIndex,
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
        order: input.messages.length + commandIndex,
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
      order: input.messages.length + input.commands.length + reportIndex,
    });
  }

  return items.sort((left, right) => {
    const time = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    if (Number.isFinite(time) && time !== 0) return time;
    const lexical = left.timestamp.localeCompare(right.timestamp);
    return lexical || left.order - right.order || left.id.localeCompare(right.id);
  });
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
