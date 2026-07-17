import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "./schema.ts";
import { MAX_INVOCATION_EVENT_PAGE_LIMIT, SparkInvocationStore } from "./invocations.ts";

function createStore(): { db: DatabaseSync; store: SparkInvocationStore } {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  return { db, store: new SparkInvocationStore(db) };
}

describe("SparkInvocationStore", () => {
  it("reports session activity from durable queued and running invocations", () => {
    const { db, store } = createStore();
    try {
      const queued = store.submit({
        sessionId: "session-active",
        prompt: "queued",
        now: "2026-07-15T00:00:00.000Z",
      });
      expect(store.sessionActivity("session-active")).toEqual({
        active: true,
        updatedAt: "2026-07-15T00:00:00.000Z",
      });

      store.claimNext("worker", "2026-07-15T00:00:01.000Z");
      expect(store.sessionActivity("session-active")).toEqual({
        active: true,
        updatedAt: "2026-07-15T00:00:01.000Z",
      });

      store.complete(queued.invocationId, {
        status: "succeeded",
        now: "2026-07-15T00:00:02.000Z",
      });
      expect(store.sessionActivity("session-active")).toEqual({
        active: false,
        updatedAt: "2026-07-15T00:00:02.000Z",
      });
      expect(store.sessionActivity("session-missing")).toEqual({ active: false });
      expect(
        Object.fromEntries(
          store.sessionActivities(["session-active", "session-missing", "session-active"]),
        ),
      ).toEqual({
        "session-active": {
          active: false,
          updatedAt: "2026-07-15T00:00:02.000Z",
        },
        "session-missing": { active: false },
      });
      expect(store.sessionActivities([])).toEqual(new Map());
    } finally {
      db.close();
    }
  });

  it("persists independent ids and enforces valid terminal transitions", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({
        commandId: "command-1",
        sessionId: "session-1",
        idempotencyKey: "idem-1",
        prompt: "hello",
        now: "2026-07-14T00:00:00.000Z",
      });
      expect(invocation.invocationId).toMatch(/^inv_/u);
      expect(invocation.invocationId).not.toContain(".json");
      expect(invocation.status).toBe("queued");

      expect(store.claimNext("worker-a", "2026-07-14T00:00:01.000Z")).toMatchObject({
        invocationId: invocation.invocationId,
        status: "running",
        workerId: "worker-a",
      });
      expect(
        store.complete(invocation.invocationId, {
          status: "succeeded",
          now: "2026-07-14T00:00:02.000Z",
        }),
      ).toMatchObject({ status: "succeeded", finishedAt: "2026-07-14T00:00:02.000Z" });
      expect(() => store.complete(invocation.invocationId, { status: "failed" })).toThrow(
        /Invalid Spark invocation transition/u,
      );
    } finally {
      db.close();
    }
  });

  it("makes duplicate idempotent submits stable and rejects conflicting retries", () => {
    const { db, store } = createStore();
    try {
      const first = store.submit({
        sessionId: "session-1",
        prompt: "same",
        idempotencyKey: "idem-stable",
        commandId: "command-1",
      });
      expect(
        store.submit({
          sessionId: "session-1",
          prompt: "same",
          idempotencyKey: "idem-stable",
          commandId: "command-1",
        }),
      ).toEqual(first);
      expect(() =>
        store.submit({
          sessionId: "session-1",
          prompt: "different",
          idempotencyKey: "idem-stable",
          commandId: "command-1",
        }),
      ).toThrow(/idempotency conflict/u);
    } finally {
      db.close();
    }
  });

  it("fences concurrent invocations for the same session and sequences bounded events", () => {
    const { db, store } = createStore();
    try {
      const first = store.submit({ sessionId: "session-1", prompt: "first" });
      const second = store.submit({ sessionId: "session-1", prompt: "second" });
      expect(store.claimNext("worker-a")?.invocationId).toBe(first.invocationId);
      expect(store.claimNext("worker-b")).toBeUndefined();
      store.complete(first.invocationId, { status: "succeeded" });
      expect(store.claimNext("worker-b")?.invocationId).toBe(second.invocationId);

      for (let index = 0; index < 10_000; index += 1) {
        store.appendEvent(first.invocationId, "delta", { index });
      }
      const page = store.eventPage(first.invocationId, 0, 10_000);
      expect(page.events).toHaveLength(MAX_INVOCATION_EVENT_PAGE_LIMIT);
      expect(page.hasMore).toBe(true);
      expect(page.events[0]?.sequence).toBe(1);
      expect(page.events.at(-1)?.sequence).toBe(MAX_INVOCATION_EVENT_PAGE_LIMIT);
      const serializedStatus = JSON.stringify(store.get(first.invocationId));
      expect(serializedStatus).not.toContain("delta");
      expect(Buffer.byteLength(serializedStatus)).toBeLessThan(2_048);
    } finally {
      db.close();
    }
  });

  it("replays only unacknowledged invocation events for each delivery destination", () => {
    const { db, store } = createStore();
    try {
      const invocation = store.submit({ sessionId: "session-delivery", prompt: "deliver" });
      store.appendEvent(invocation.invocationId, "daemon.task.lifecycle", { status: "running" });
      store.appendEvent(invocation.invocationId, "daemon.view_event", { text: "hello" });
      store.appendEvent(invocation.invocationId, "daemon.task.lifecycle", {
        status: "succeeded",
      });

      expect(
        store.pendingDeliveries("cockpit:runtime-a").map(({ event }) => event.sequence),
      ).toEqual([1, 2, 3]);
      store.acknowledgeDelivery("cockpit:runtime-a", invocation.invocationId, 2);
      expect(
        store.pendingDeliveries("cockpit:runtime-a").map(({ event }) => event.sequence),
      ).toEqual([3]);
      expect(
        store.pendingDeliveries("cockpit:runtime-b").map(({ event }) => event.sequence),
      ).toEqual([1, 2, 3]);
      store.acknowledgeDelivery("cockpit:runtime-a", invocation.invocationId, 1);
      expect(
        store.pendingDeliveries("cockpit:runtime-a").map(({ event }) => event.sequence),
      ).toEqual([3]);
    } finally {
      db.close();
    }
  });

  it("records cancellation and failure metadata", () => {
    const { db, store } = createStore();
    try {
      const cancelled = store.submit({ sessionId: "session-cancel", prompt: "cancel" });
      expect(
        store.complete(cancelled.invocationId, {
          status: "cancelled",
          cancelReason: "user requested",
        }),
      ).toMatchObject({ status: "cancelled", cancelReason: "user requested" });

      const failed = store.submit({ sessionId: "session-fail", prompt: "fail" });
      expect(
        store.complete(failed.invocationId, {
          status: "failed",
          errorCode: "TIMEOUT",
          errorMessage: "deadline exceeded",
        }),
      ).toMatchObject({
        status: "failed",
        errorCode: "TIMEOUT",
        errorMessage: "deadline exceeded",
      });
    } finally {
      db.close();
    }
  });

  it("returns bounded filtered pages without loading unrelated history", () => {
    const { db, store } = createStore();
    try {
      for (let index = 0; index < 125; index += 1) {
        const sessionId = index % 2 === 0 ? "session-selected" : "session-other";
        const invocation = store.submit({
          sessionId,
          prompt: `prompt-${index}`,
          now: `2026-07-14T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        });
        if (index % 3 === 0) {
          store.complete(invocation.invocationId, {
            status: "failed",
            errorCode: "EXECUTION_FAILED",
            errorMessage: `failure-${index}`,
            now: `2026-07-14T01:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
          });
        }
      }

      const page = store.listPage({
        status: "failed",
        sessionId: "session-selected",
        since: "2026-07-14T00:00:30.000Z",
        limit: 7,
        offset: 2,
      });
      expect(page).toMatchObject({ limit: 7, offset: 2 });
      expect(page.invocations).toHaveLength(7);
      expect(page.total).toBe(16);
      expect(page.invocations.every((entry) => entry.status === "failed")).toBe(true);
      expect(page.invocations.every((entry) => entry.sessionId === "session-selected")).toBe(true);
      expect(page.invocations.every((entry) => entry.createdAt >= "2026-07-14T00:00:30.000Z")).toBe(
        true,
      );
      expect(store.listPage({ limit: 10_000 }).invocations).toHaveLength(100);
    } finally {
      db.close();
    }
  });

  it("admits only one idle-gated question while allowing asynchronous work to queue", () => {
    const { db, store } = createStore();
    try {
      const first = store.submitIfSessionIdle({
        sessionId: "session-question",
        idempotencyKey: "question:first",
        prompt: "first question",
      });
      expect(
        store.submitIfSessionIdle({
          sessionId: "session-question",
          idempotencyKey: "question:first",
          prompt: "first question",
        }),
      ).toEqual(first);
      expect(() =>
        store.submitIfSessionIdle({
          sessionId: "session-question",
          idempotencyKey: "question:second",
          prompt: "second question",
        }),
      ).toThrow(/SESSION_NOT_IDLE/u);

      const request = store.submit({
        sessionId: "session-question",
        idempotencyKey: "request:queued",
        prompt: "asynchronous request",
      });
      expect(
        store.listPendingForSession("session-question").map((entry) => entry.invocationId),
      ).toEqual([first.invocationId, request.invocationId]);
    } finally {
      db.close();
    }
  });

  it("retries terminal transient failures as new durable invocations with explicit ancestry", () => {
    const { db, store } = createStore();
    try {
      const original = store.submit({
        sessionId: "session-retry",
        prompt: "retry me",
        task: { type: "session.run", sessionId: "session-retry", prompt: "retry me" },
      });
      store.complete(original.invocationId, {
        status: "failed",
        errorCode: "EXECUTOR_TIMEOUT",
        errorMessage: "deadline exceeded",
        now: "2026-07-14T00:00:01.000Z",
      });

      const retried = store.retry(original.invocationId, "2026-07-14T00:00:02.000Z");
      expect(retried).toMatchObject({
        status: "queued",
        sourceKind: "invocation.retry",
        sourceRef: original.invocationId,
        retryOfInvocationId: original.invocationId,
        attemptCount: 0,
      });
      expect(retried.invocationId).not.toBe(original.invocationId);
      expect(store.retry(original.invocationId)).toEqual(retried);
      expect(store.require(original.invocationId)).toMatchObject({
        status: "failed",
        errorCode: "EXECUTOR_TIMEOUT",
        finishedAt: "2026-07-14T00:00:01.000Z",
      });

      const permanent = store.submit({
        prompt: "invalid",
        task: { type: "session.run", sessionId: "session-permanent", prompt: "invalid" },
      });
      store.complete(permanent.invocationId, {
        status: "failed",
        errorCode: "INVALID_TASK",
        errorMessage: "correction required",
      });
      expect(() => store.retry(permanent.invocationId)).toThrow(/INVOCATION_NOT_RETRYABLE/u);
    } finally {
      db.close();
    }
  });

  it("previews retention only for terminal history whose known delivery cursors are complete", () => {
    const { db, store } = createStore();
    try {
      const eligible = store.submit({ prompt: "eligible" });
      expect(store.claimNext("worker-eligible")?.invocationId).toBe(eligible.invocationId);
      store.appendEvent(eligible.invocationId, "lifecycle", { status: "succeeded" });
      store.complete(eligible.invocationId, {
        status: "succeeded",
        now: "2026-07-13T00:00:00.000Z",
      });
      store.acknowledgeDelivery("cockpit:runtime-a", eligible.invocationId, 1);
      store.acknowledgeDelivery("cockpit:runtime-b", eligible.invocationId, 1);

      const blocked = store.submit({ prompt: "blocked" });
      expect(store.claimNext("worker-blocked")?.invocationId).toBe(blocked.invocationId);
      store.appendEvent(blocked.invocationId, "lifecycle", { status: "running" });
      store.appendEvent(blocked.invocationId, "lifecycle", { status: "succeeded" });
      store.complete(blocked.invocationId, {
        status: "succeeded",
        now: "2026-07-13T00:01:00.000Z",
      });
      store.acknowledgeDelivery("cockpit:runtime-a", blocked.invocationId, 1);
      expect(store.pendingDeliveries("cockpit:runtime-b").length).toBeGreaterThan(0);

      const recent = store.submit({ prompt: "recent" });
      store.complete(recent.invocationId, {
        status: "failed",
        errorCode: "EXECUTION_FAILED",
        errorMessage: "recent failure",
        now: "2026-07-15T00:00:00.000Z",
      });

      expect(store.retentionPreview("2026-07-14T00:00:00.000Z", 100)).toEqual({
        before: "2026-07-14T00:00:00.000Z",
        invocationIds: [eligible.invocationId],
        eventCount: 1,
        blockedByDeliveryCount: 1,
      });
    } finally {
      db.close();
    }
  });

  it("loads only queued and running invocations for one session", () => {
    const { db, store } = createStore();
    try {
      const terminal = store.submit({
        sessionId: "session-selected",
        prompt: "already complete",
        now: "2026-07-14T00:00:00.000Z",
      });
      store.claimNext("worker-terminal", "2026-07-14T00:00:01.000Z");
      store.complete(terminal.invocationId, {
        status: "succeeded",
        result: { output: "large terminal results are not part of this projection" },
        now: "2026-07-14T00:00:02.000Z",
      });
      const running = store.submit({
        sessionId: "session-selected",
        prompt: "running",
        now: "2026-07-14T00:00:03.000Z",
      });
      store.claimNext("worker-running", "2026-07-14T00:00:04.000Z");
      const queued = store.submit({
        sessionId: "session-selected",
        prompt: "queued",
        now: "2026-07-14T00:00:05.000Z",
      });
      store.submit({
        sessionId: "session-other",
        prompt: "unrelated",
        now: "2026-07-14T00:00:06.000Z",
      });

      expect(
        store.listPendingForSession("session-selected").map((invocation) => ({
          invocationId: invocation.invocationId,
          status: invocation.status,
        })),
      ).toEqual([
        { invocationId: running.invocationId, status: "running" },
        { invocationId: queued.invocationId, status: "queued" },
      ]);
      expect(store.listPendingForSession(" ")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
