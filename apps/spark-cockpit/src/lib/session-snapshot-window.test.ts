import { describe, expect, it } from "vitest";
import {
  hydrateSessionConversationWindow,
  mergeEarlierSessionSnapshotWindow,
  parseSessionSnapshotWindow,
  sessionConversationAnchorCount,
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

  it("keeps latest lifetime telemetry while older transcript pages are merged", () => {
    const latest = page({ total: 70, start: 38, end: 70 });
    latest.snapshot.usage = {
      inputTokens: 19_000_000,
      outputTokens: 820_000,
      cacheReadTokens: 230_000_000,
      cacheWriteTokens: 16,
      costUsd: 23.509,
      contextTokens: 262_632,
    };
    latest.snapshot.gitBranch = "main";
    const older = page({ total: 70, start: 6, end: 38 });
    older.snapshot.usage = {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };

    const merged = mergeEarlierSessionSnapshotWindow(latest, older);

    expect(merged.snapshot.gitBranch).toBe("main");
    expect(merged.snapshot.usage).toEqual(latest.snapshot.usage);
  });

  it("crosses process-heavy pages until several human turns anchor the conversation", async () => {
    const userAnchors = new Set([10, 18, 30]);
    const initial = processHeavyPage({ total: 48, start: 40, end: 48, userAnchors });
    const pages = new Map([
      ["msg_40", processHeavyPage({ total: 48, start: 32, end: 40, userAnchors })],
      ["msg_32", processHeavyPage({ total: 48, start: 24, end: 32, userAnchors })],
      ["msg_24", processHeavyPage({ total: 48, start: 16, end: 24, userAnchors })],
      ["msg_16", processHeavyPage({ total: 48, start: 8, end: 16, userAnchors })],
    ]);
    const requestedCursors: string[] = [];

    const hydrated = await hydrateSessionConversationWindow(initial, {
      minimumAnchors: 3,
      loadEarlier: async (cursor) => {
        requestedCursors.push(cursor);
        const earlier = pages.get(cursor);
        if (!earlier) throw new Error(`unexpected cursor ${cursor}`);
        return earlier;
      },
    });

    expect(requestedCursors).toEqual(["msg_40", "msg_32", "msg_24", "msg_16"]);
    expect(sessionConversationAnchorCount(hydrated)).toBe(3);
    expect(hydrated.snapshot.messages.map(({ id }) => id)).toEqual(messageIds(8, 48));
    expect(hydrated.history).toMatchObject({
      loadedMessages: 40,
      earlierMessages: 8,
      hasEarlierMessages: true,
      nextBeforeMessageId: "msg_8",
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

function processHeavyPage(input: {
  total: number;
  start: number;
  end: number;
  userAnchors: ReadonlySet<number>;
}): SessionSnapshotWindow {
  const messages = Array.from({ length: input.end - input.start }, (_, offset) =>
    processHeavyMessage(input.start + offset, input.userAnchors),
  );
  return parseSessionSnapshotWindow({
    snapshot: { sessionId: "sess_process_heavy", messages },
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

function processHeavyMessage(index: number, userAnchors: ReadonlySet<number>) {
  if (userAnchors.has(index)) {
    return {
      version: 1 as const,
      id: `msg_${index}`,
      role: "user" as const,
      text: `prompt ${index}`,
      status: "done" as const,
      metadata: {},
    };
  }
  const toolCallId = `call_${Math.floor(index / 2)}`;
  if (index % 2 === 0) {
    return {
      version: 1 as const,
      id: `msg_${index}`,
      role: "assistant" as const,
      text: "",
      status: "done" as const,
      parts: [
        {
          id: `msg_${index}:call`,
          type: "tool-call" as const,
          status: "complete" as const,
          toolCallId,
          toolName: "session",
          summary: "Check delegated session",
          metadata: {},
        },
      ],
      metadata: {},
    };
  }
  return {
    version: 1 as const,
    id: `msg_${index}`,
    role: "tool" as const,
    text: "Delegated session is still running.",
    status: "done" as const,
    toolCallId,
    toolName: "session",
    parts: [
      {
        id: `msg_${index}:result`,
        type: "tool-result" as const,
        status: "complete" as const,
        toolCallId,
        toolName: "session",
        summary: "Delegated session is still running.",
        metadata: {},
      },
    ],
    metadata: {},
  };
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
