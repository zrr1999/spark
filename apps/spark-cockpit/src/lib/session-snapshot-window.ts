import { sparkSessionViewSchema, type SparkSessionView } from "@zendev-lab/spark-protocol";

export const SESSION_SNAPSHOT_PAGE_SIZE = 32;
export const SESSION_SNAPSHOT_MAX_MESSAGES = 10_000;

export interface SessionSnapshotHistory {
  totalMessages: number;
  loadedMessages: number;
  hiddenMessages: number;
}

export interface SessionSnapshotWindow {
  snapshot: SparkSessionView;
  history: SessionSnapshotHistory;
}

/**
 * Keep the initial Cockpit payload bounded while preserving a cumulative,
 * newest-first history window that can be expanded on demand.
 */
export function sessionSnapshotWindow(
  snapshot: SparkSessionView,
  requestedLimit = SESSION_SNAPSHOT_PAGE_SIZE,
): SessionSnapshotWindow {
  const limit = normalizeSessionSnapshotLimit(requestedLimit);
  const totalMessages = snapshot.messages.length;
  const messages = snapshot.messages.slice(Math.max(0, totalMessages - limit));
  const toolCallIds = referencedToolCallIds(messages);
  const tools = snapshot.tools.filter((tool) => toolCallIds.has(tool.id));

  return {
    snapshot: sparkSessionViewSchema.parse({ ...snapshot, messages, tools }),
    history: {
      totalMessages,
      loadedMessages: messages.length,
      hiddenMessages: Math.max(0, totalMessages - messages.length),
    },
  };
}

export function normalizeSessionSnapshotLimit(value: unknown): number {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return SESSION_SNAPSHOT_PAGE_SIZE;
  }
  return Math.min(
    SESSION_SNAPSHOT_MAX_MESSAGES,
    Math.max(SESSION_SNAPSHOT_PAGE_SIZE, Math.floor(parsed)),
  );
}

export function parseSessionSnapshotWindow(value: unknown): SessionSnapshotWindow {
  if (!isRecord(value) || !isRecord(value.history)) {
    throw new Error("invalid session snapshot window");
  }
  const totalMessages = nonNegativeInteger(value.history.totalMessages);
  const loadedMessages = nonNegativeInteger(value.history.loadedMessages);
  const hiddenMessages = nonNegativeInteger(value.history.hiddenMessages);
  if (loadedMessages + hiddenMessages !== totalMessages) {
    throw new Error("invalid session snapshot history counts");
  }
  const snapshot = sparkSessionViewSchema.parse(value.snapshot);
  if (snapshot.messages.length !== loadedMessages) {
    throw new Error("session snapshot history does not match its message window");
  }
  return {
    snapshot,
    history: { totalMessages, loadedMessages, hiddenMessages },
  };
}

function referencedToolCallIds(messages: SparkSessionView["messages"]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.toolCallId) ids.add(message.toolCallId);
    for (const part of message.parts ?? []) {
      if ("toolCallId" in part) ids.add(part.toolCallId);
    }
  }
  return ids;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("invalid session snapshot history count");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
