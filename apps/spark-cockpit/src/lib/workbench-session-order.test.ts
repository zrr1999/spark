import { describe, expect, it } from "vitest";
import {
  orderWorkbenchSessionsByAttention,
  workbenchSessionNeedsAttention,
  type WorkbenchSessionOrderLike,
} from "./workbench-session-order";

describe("workbench session attention ordering", () => {
  it("puts every attention state ahead of newer ordinary history", () => {
    const ordered = orderWorkbenchSessionsByAttention([
      session("idle-newest", "ready", "2026-07-13T10:00:00.000Z"),
      session("running", "running", "2026-07-13T06:00:00.000Z"),
      session("failed", "failed", "2026-07-13T07:00:00.000Z"),
      session("completed", "completed", "2026-07-13T09:00:00.000Z"),
      session("blocked", "blocked", "2026-07-13T08:00:00.000Z"),
      session("queued", "queued", "2026-07-13T08:30:00.000Z"),
    ]);

    expect(ordered.map((item) => item.sessionId)).toEqual([
      "queued",
      "blocked",
      "failed",
      "running",
      "idle-newest",
      "completed",
    ]);
  });

  it("uses rolled-up activity instead of treating session availability as task progress", () => {
    const reusableSession = session("reusable", "running", "2026-07-13T10:00:00.000Z", {
      activityStatus: "completed",
    });
    const blockedSession = session("blocked", "ready", "2026-07-13T08:00:00.000Z", {
      activityStatus: "needs-input",
    });

    expect(workbenchSessionNeedsAttention(reusableSession)).toBe(false);
    expect(workbenchSessionNeedsAttention(blockedSession)).toBe(true);
    expect(
      orderWorkbenchSessionsByAttention([reusableSession, blockedSession]).map(
        (item) => item.sessionId,
      ),
    ).toEqual(["blocked", "reusable"]);
  });

  it("uses the latest activity timestamp and does not mutate server order", () => {
    const sessions = [
      session("newer-session", "ready", "2026-07-13T09:00:00.000Z"),
      session("older-session-new-activity", "ready", "2026-07-13T07:00:00.000Z", {
        activityUpdatedAt: "2026-07-13T10:00:00.000Z",
      }),
    ];

    const ordered = orderWorkbenchSessionsByAttention(sessions);

    expect(ordered.map((item) => item.sessionId)).toEqual([
      "older-session-new-activity",
      "newer-session",
    ]);
    expect(sessions.map((item) => item.sessionId)).toEqual([
      "newer-session",
      "older-session-new-activity",
    ]);
    expect(ordered).not.toBe(sessions);
  });
});

function session(
  sessionId: string,
  activityStatus: string,
  updatedAt: string,
  overrides: Partial<WorkbenchSessionOrderLike> = {},
): WorkbenchSessionOrderLike {
  return {
    sessionId,
    status: "ready",
    activityStatus,
    updatedAt,
    ...overrides,
  };
}
