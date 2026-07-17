import {
  sparkSessionSnapshotPageSchema,
  type SparkSessionSnapshotHistory,
  type SparkSessionSnapshotPage,
} from "@zendev-lab/spark-protocol";

export const SESSION_SNAPSHOT_PAGE_SIZE = 32;
export const SESSION_SNAPSHOT_MAX_MESSAGES = 10_000;

export type SessionSnapshotHistory = SparkSessionSnapshotHistory;
export type SessionSnapshotWindow = SparkSessionSnapshotPage;

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
  return sparkSessionSnapshotPageSchema.parse(value);
}

/** Merge one cursor-addressed older page into the cumulative browser window. */
export function mergeEarlierSessionSnapshotWindow(
  current: SessionSnapshotWindow,
  earlierPage: SessionSnapshotWindow,
): SessionSnapshotWindow {
  if (current.snapshot.sessionId !== earlierPage.snapshot.sessionId) {
    throw new Error("cannot merge session snapshot pages from different sessions");
  }
  if (current.history.laterMessages !== 0) {
    throw new Error("current session snapshot window is not a cumulative latest window");
  }
  const pageEnd = earlierPage.history.totalMessages - earlierPage.history.laterMessages;
  if (pageEnd !== current.history.earlierMessages) {
    throw new Error("session snapshot pages are not contiguous");
  }
  if (earlierPage.snapshot.messages.length === 0) {
    throw new Error("session snapshot cursor did not advance");
  }
  if (
    earlierPage.history.hasEarlierMessages &&
    earlierPage.history.nextBeforeMessageId === current.history.nextBeforeMessageId
  ) {
    throw new Error("session snapshot continuation cursor did not advance");
  }
  const currentNativeSuffixMessages = earlierPage.history.laterMessages;
  if (current.snapshot.messages.length < currentNativeSuffixMessages) {
    throw new Error("current session snapshot is missing newer transcript messages");
  }
  const overlayMessages = current.snapshot.messages.length - currentNativeSuffixMessages;
  const messages = uniqueById([...earlierPage.snapshot.messages, ...current.snapshot.messages]);
  const expectedLoadedMessages =
    earlierPage.history.loadedMessages + current.snapshot.messages.length;
  if (messages.length !== expectedLoadedMessages) {
    throw new Error("session snapshot pages overlap");
  }
  const tools = uniqueById([...earlierPage.snapshot.tools, ...current.snapshot.tools]);
  const earlierMessages = earlierPage.history.earlierMessages;
  return sparkSessionSnapshotPageSchema.parse({
    snapshot: { ...current.snapshot, messages, tools },
    history: {
      totalMessages: earlierPage.history.totalMessages + overlayMessages,
      loadedMessages: messages.length,
      hiddenMessages: earlierMessages,
      earlierMessages,
      laterMessages: 0,
      hasEarlierMessages: earlierMessages > 0,
      ...(earlierMessages > 0 && earlierPage.history.nextBeforeMessageId
        ? { nextBeforeMessageId: earlierPage.history.nextBeforeMessageId }
        : {}),
    },
  });
}

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}
