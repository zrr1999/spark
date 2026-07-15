import { describe, expect, it } from "vitest";
import { parseSparkSessionView } from "@zendev-lab/spark-protocol";
import {
  normalizeSessionSnapshotLimit,
  parseSessionSnapshotWindow,
  sessionSnapshotWindow,
} from "./session-snapshot-window";

describe("sessionSnapshotWindow", () => {
  it("keeps a bounded cumulative message window and only referenced tools", () => {
    const snapshot = parseSparkSessionView({
      sessionId: "sess_window",
      messages: Array.from({ length: 40 }, (_, index) => ({
        id: `msg_${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        text: `message ${index}`,
        ...(index === 39
          ? {
              parts: [
                {
                  id: "part_recent",
                  type: "tool-call",
                  toolCallId: "call_recent",
                  toolName: "recent",
                  status: "complete",
                },
              ],
            }
          : {}),
      })),
      tools: [
        { id: "call_old", name: "old", status: "succeeded" },
        { id: "call_recent", name: "recent", status: "succeeded" },
      ],
    });

    const window = sessionSnapshotWindow(snapshot);

    expect(window.snapshot.messages).toHaveLength(32);
    expect(window.snapshot.messages[0]?.id).toBe("msg_8");
    expect(window.snapshot.tools.map((tool) => tool.id)).toEqual(["call_recent"]);
    expect(window.history).toEqual({
      totalMessages: 40,
      loadedMessages: 32,
      hiddenMessages: 8,
    });
    expect(parseSessionSnapshotWindow(window)).toEqual(window);
  });

  it("normalizes invalid, small, and excessive limits", () => {
    expect(normalizeSessionSnapshotLimit(undefined)).toBe(32);
    expect(normalizeSessionSnapshotLimit("16")).toBe(32);
    expect(normalizeSessionSnapshotLimit("64")).toBe(64);
    expect(normalizeSessionSnapshotLimit(Number.POSITIVE_INFINITY)).toBe(32);
    expect(normalizeSessionSnapshotLimit(20_000)).toBe(10_000);
  });

  it("rejects response counts that do not match the projected view", () => {
    expect(() =>
      parseSessionSnapshotWindow({
        snapshot: { sessionId: "sess_bad", messages: [] },
        history: { totalMessages: 2, loadedMessages: 1, hiddenMessages: 1 },
      }),
    ).toThrow(/does not match/u);
  });
});
