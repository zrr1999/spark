import { describe, expect, it } from "vitest";
import {
  mergeEarlierSessionSnapshotWindow,
  parseSessionSnapshotWindow,
  type SessionSnapshotWindow,
} from "./session-snapshot-window";

describe("session snapshot cursor pages", () => {
  it("merges every contiguous daemon page into one ordered browser window", () => {
    const latest = page({ total: 70, start: 38, end: 70 });
    const middle = page({ total: 70, start: 6, end: 38 });
    const cumulative = mergeEarlierSessionSnapshotWindow(latest, middle);

    expect(cumulative.snapshot.messages.map(({ id }) => id)).toEqual(messageIds(6, 70));
    expect(cumulative.history).toEqual({
      totalMessages: 70,
      loadedMessages: 64,
      hiddenMessages: 6,
      earlierMessages: 6,
      laterMessages: 0,
      hasEarlierMessages: true,
      nextBeforeMessageId: "msg_6",
    });

    const complete = mergeEarlierSessionSnapshotWindow(
      cumulative,
      page({ total: 70, start: 0, end: 6 }),
    );
    expect(complete.snapshot.messages.map(({ id }) => id)).toEqual(messageIds(0, 70));
    expect(complete.history).toEqual({
      totalMessages: 70,
      loadedMessages: 70,
      hiddenMessages: 0,
      earlierMessages: 0,
      laterMessages: 0,
      hasEarlierMessages: false,
    });
  });

  it("loads an older page after live transcript growth without losing the new message or error", () => {
    const initial = page({ total: 70, start: 38, end: 70 });
    const current: SessionSnapshotWindow = {
      snapshot: {
        ...initial.snapshot,
        messages: [
          ...initial.snapshot.messages,
          message(70),
          {
            version: 1,
            id: "invocation:inv_live:failure",
            role: "system",
            text: "The session was interrupted.",
            status: "error",
            metadata: { source: "daemon.invocation" },
          },
        ],
      },
      // Counts intentionally remain at initial hydration until the next daemon page.
      history: initial.history,
    };
    const olderAfterAppend = page({ total: 71, start: 6, end: 38 });

    const merged = mergeEarlierSessionSnapshotWindow(current, olderAfterAppend);

    expect(merged.snapshot.messages.map(({ id }) => id)).toEqual([
      ...messageIds(6, 71),
      "invocation:inv_live:failure",
    ]);
    expect(merged.history).toEqual({
      totalMessages: 72,
      loadedMessages: 66,
      hiddenMessages: 6,
      earlierMessages: 6,
      laterMessages: 0,
      hasEarlierMessages: true,
      nextBeforeMessageId: "msg_6",
    });
  });

  it("rejects a cursor page from a changed branch instead of silently dropping a gap", () => {
    const latest = page({ total: 70, start: 38, end: 70 });
    const changedBranch = page({ total: 71, start: 7, end: 39 });

    expect(() => mergeEarlierSessionSnapshotWindow(latest, changedBranch)).toThrow(
      /not contiguous/u,
    );
  });

  it("rejects malformed daemon counts and continuation cursors at the wire boundary", () => {
    expect(() =>
      parseSessionSnapshotWindow({
        snapshot: { sessionId: "sess_bad", messages: [message(8)] },
        history: {
          totalMessages: 9,
          loadedMessages: 1,
          hiddenMessages: 8,
          earlierMessages: 8,
          laterMessages: 0,
          hasEarlierMessages: true,
          nextBeforeMessageId: "msg_wrong",
        },
      }),
    ).toThrow(/continuation cursor/u);
  });
});

function page(input: { total: number; start: number; end: number }): SessionSnapshotWindow {
  const messages = Array.from({ length: input.end - input.start }, (_, offset) =>
    message(input.start + offset),
  );
  return parseSessionSnapshotWindow({
    snapshot: { sessionId: "sess_pages", messages },
    history: {
      totalMessages: input.total,
      loadedMessages: messages.length,
      hiddenMessages: input.total - messages.length,
      earlierMessages: input.start,
      laterMessages: input.total - input.end,
      hasEarlierMessages: input.start > 0,
      ...(input.start > 0 ? { nextBeforeMessageId: `msg_${input.start}` } : {}),
    },
  });
}

function message(index: number) {
  return {
    version: 1 as const,
    id: `msg_${index}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `message ${index}`,
    status: "done" as const,
    metadata: {},
  };
}

function messageIds(start: number, end: number): string[] {
  return Array.from({ length: end - start }, (_, offset) => `msg_${start + offset}`);
}
