import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import {
  SparkInvocationScheduler,
  type SparkInvocationSchedulerOptions,
} from "./invocation-scheduler.ts";
import type { SparkDaemonTaskExecutor } from "./types.ts";

function harness(
  executeTask: SparkDaemonTaskExecutor,
  options: Partial<SparkInvocationSchedulerOptions> = {},
) {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  const store = new SparkInvocationStore(db);
  const scheduler = new SparkInvocationScheduler({ store, executeTask, ...options });
  return { db, store, scheduler };
}

describe("SparkInvocationScheduler", () => {
  it("fails uncertain running rows closed while continuing queued work after restart", async () => {
    const executions: string[] = [];
    const executeTask: SparkDaemonTaskExecutor = async (task) => {
      executions.push(task.prompt);
      return { ok: true };
    };
    const { db, store, scheduler } = harness(executeTask);
    try {
      const interrupted = store.submit({
        sessionId: "interrupted-session",
        prompt: "recover me",
        task: { type: "session.run", sessionId: "interrupted-session", prompt: "recover me" },
      });
      const queued = store.submit({
        sessionId: "queued-session",
        prompt: "already queued",
        task: { type: "session.run", sessionId: "queued-session", prompt: "already queued" },
      });
      expect(store.claimNext("dead-worker")?.invocationId).toBe(interrupted.invocationId);
      expect(scheduler.recover("2026-07-14T00:00:00.000Z")).toBe(1);
      expect(store.require(interrupted.invocationId)).toMatchObject({
        status: "failed",
        attemptCount: 1,
        errorCode: "DAEMON_EXECUTION_INTERRUPTED",
        errorMessage: expect.stringContaining("inspect them before retrying manually"),
      });
      expect(store.require(queued.invocationId).status).toBe("queued");

      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();
      expect(executions).toEqual(["already queued"]);
      expect(store.require(interrupted.invocationId)).toMatchObject({
        status: "failed",
        attemptCount: 1,
      });
      expect(store.require(queued.invocationId)).toMatchObject({
        status: "succeeded",
        attemptCount: 1,
      });

      const retry = store.retry(interrupted.invocationId, "2026-07-14T00:00:30.000Z");
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();
      expect(executions).toEqual(["already queued", "recover me"]);
      expect(store.require(retry.invocationId)).toMatchObject({
        status: "succeeded",
        attemptCount: 1,
        sourceKind: "invocation.retry",
        sourceRef: interrupted.invocationId,
      });
      const terminalRows = store.list();
      expect(scheduler.recover("2026-07-14T00:01:00.000Z")).toBe(0);
      expect(scheduler.processBatch()).toBe(false);
      expect(store.list()).toEqual(terminalRows);
    } finally {
      db.close();
    }
  });

  it("fails malformed recovered tasks without blocking later valid work", async () => {
    const executions: string[] = [];
    const { db, store, scheduler } = harness(async (task) => {
      executions.push(task.prompt);
      return { ok: true };
    });
    try {
      const malformed = store.submit({ prompt: "missing durable task" });
      const valid = store.submit({
        sessionId: "valid-session",
        prompt: "run valid task",
        task: { type: "session.run", sessionId: "valid-session", prompt: "run valid task" },
      });

      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();

      expect(store.require(malformed.invocationId)).toMatchObject({
        status: "failed",
        errorCode: "INVALID_TASK",
        errorMessage: "daemon task must be an object",
      });
      expect(store.eventPage(malformed.invocationId).events.at(-1)?.payload).toMatchObject({
        type: "daemon.task.lifecycle",
        taskType: "invalid",
        status: "failed",
      });
      expect(store.require(valid.invocationId).status).toBe("succeeded");
      expect(executions).toEqual(["run valid task"]);
    } finally {
      db.close();
    }
  });

  it("serializes the same session while allowing bounded unrelated work", async () => {
    const gate = deferred<void>();
    const launched: string[] = [];
    const executeTask: SparkDaemonTaskExecutor = async (task) => {
      launched.push(task.prompt);
      if (task.prompt === "first") await gate.promise;
      return { ok: true };
    };
    const { db, store, scheduler } = harness(executeTask, { concurrency: 2 });
    try {
      for (const [sessionId, prompt] of [
        ["same", "first"],
        ["same", "second"],
        ["other", "third"],
      ] as const) {
        store.submit({
          sessionId,
          prompt,
          task: { type: "session.run", sessionId, prompt },
        });
      }
      expect(scheduler.processBatch()).toBe(true);
      expect(launched.sort()).toEqual(["first", "third"]);
      gate.resolve();
      await scheduler.wait();
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait();
      expect(launched.sort()).toEqual(["first", "second", "third"]);
      for (const invocation of store.list()) {
        const sequences = store
          .eventPage(invocation.invocationId)
          .events.map((event) => event.sequence);
        expect(sequences.length).toBeGreaterThanOrEqual(2);
        expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
        expect(new Set(sequences).size).toBe(sequences.length);
      }
    } finally {
      gate.resolve();
      db.close();
    }
  });

  it("reserves one overflow slot for blocking session questions", async () => {
    const regularGate = deferred<void>();
    const firstQuestionGate = deferred<void>();
    const secondQuestionGate = deferred<void>();
    const launched: string[] = [];
    const { db, store, scheduler } = harness(
      async (task) => {
        launched.push(task.prompt);
        if (task.prompt === "regular") await regularGate.promise;
        if (task.prompt === "question-one") await firstQuestionGate.promise;
        if (task.prompt === "question-two") await secondQuestionGate.promise;
        return { prompt: task.prompt };
      },
      { concurrency: 1 },
    );
    try {
      const regular = store.submit({
        sessionId: "caller",
        prompt: "regular",
        task: { type: "session.run", sessionId: "caller", prompt: "regular" },
      });
      expect(scheduler.processBatch()).toBe(true);
      expect(store.require(regular.invocationId).status).toBe("running");

      const firstQuestion = store.submit({
        sessionId: "target-one",
        prompt: "question-one",
        task: { type: "session.run", sessionId: "target-one", prompt: "question-one" },
        sourceKind: "session.question",
      });
      const secondQuestion = store.submit({
        sessionId: "target-two",
        prompt: "question-two",
        task: { type: "session.run", sessionId: "target-two", prompt: "question-two" },
        sourceKind: "session.question",
      });

      expect(scheduler.processBatch()).toBe(true);
      expect(store.require(firstQuestion.invocationId).status).toBe("running");
      expect(store.require(secondQuestion.invocationId).status).toBe("queued");
      expect(scheduler.snapshot()).toHaveLength(2);
      expect(scheduler.processBatch()).toBe(false);

      firstQuestionGate.resolve();
      await eventually(() => store.require(firstQuestion.invocationId).status === "succeeded");
      expect(scheduler.processBatch()).toBe(true);
      expect(store.require(secondQuestion.invocationId).status).toBe("running");
      expect(scheduler.snapshot()).toHaveLength(2);

      secondQuestionGate.resolve();
      regularGate.resolve();
      await scheduler.wait();
      expect(launched).toEqual(["regular", "question-one", "question-two"]);
    } finally {
      regularGate.resolve();
      firstQuestionGate.resolve();
      secondQuestionGate.resolve();
      db.close();
    }
  });

  it("drains active work without claiming durable queued invocations", async () => {
    const gate = deferred<void>();
    const launched: string[] = [];
    const { db, store, scheduler } = harness(
      async (task) => {
        launched.push(task.prompt);
        if (task.prompt === "active") await gate.promise;
        return { ok: true };
      },
      { concurrency: 1 },
    );
    try {
      const active = store.submit({
        sessionId: "active-session",
        prompt: "active",
        task: { type: "session.run", sessionId: "active-session", prompt: "active" },
      });
      const queued = store.submit({
        sessionId: "queued-session",
        prompt: "queued",
        task: { type: "session.run", sessionId: "queued-session", prompt: "queued" },
      });

      expect(scheduler.processBatch()).toBe(true);
      expect(scheduler.beginDrain()).toBe(1);
      expect(scheduler.draining).toBe(true);
      expect(scheduler.processBatch()).toBe(false);
      expect(store.require(queued.invocationId).status).toBe("queued");

      gate.resolve();
      await scheduler.wait();

      expect(store.require(active.invocationId).status).toBe("succeeded");
      expect(store.require(queued.invocationId).status).toBe("queued");
      expect(scheduler.processBatch()).toBe(false);
      expect(launched).toEqual(["active"]);
    } finally {
      gate.resolve();
      db.close();
    }
  });

  it("records queued cancellation and running timeout as terminal states", async () => {
    const gate = deferred<void>();
    const executeTask: SparkDaemonTaskExecutor = async () => {
      await gate.promise;
      return { late: true };
    };
    const { db, store, scheduler } = harness(executeTask, {
      concurrency: 1,
      taskTimeoutMs: 10,
      abortDrainMs: 1,
    });
    try {
      const cancelled = store.submit({
        sessionId: "cancelled",
        prompt: "cancel",
        task: { type: "session.run", sessionId: "cancelled", prompt: "cancel" },
      });
      expect(scheduler.cancel(cancelled.invocationId, "operator cancel")).toBe(true);
      expect(store.require(cancelled.invocationId)).toMatchObject({
        status: "cancelled",
        cancelReason: "operator cancel",
      });

      const timedOut = store.submit({
        sessionId: "timeout",
        prompt: "timeout",
        task: { type: "session.run", sessionId: "timeout", prompt: "timeout" },
      });
      expect(scheduler.processBatch()).toBe(true);
      await eventually(() => store.require(timedOut.invocationId).status === "failed");
      expect(store.require(timedOut.invocationId)).toMatchObject({
        status: "failed",
        errorCode: "EXECUTOR_TIMEOUT",
      });
      await expect(scheduler.wait({ timeoutMs: 20 })).rejects.toThrow(
        "timed out waiting for Spark daemon invocations",
      );
      gate.resolve();
      await scheduler.wait({ timeoutMs: 500 });
    } finally {
      gate.resolve();
      db.close();
    }
  });

  it("pauses the invocation timeout while awaiting human input", async () => {
    const { db, store, scheduler } = harness(
      async (_task, context) => {
        await context.withPausedTimeout?.(async () => {
          await delay(30);
        });
        return { answered: true };
      },
      { taskTimeoutMs: 10 },
    );
    try {
      const invocation = store.submit({
        sessionId: "human-wait",
        prompt: "wait",
        task: { type: "session.run", sessionId: "human-wait", prompt: "wait" },
      });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });
      expect(store.require(invocation.invocationId)).toMatchObject({
        status: "succeeded",
        result: { answered: true },
      });
    } finally {
      db.close();
    }
  });

  it("keeps a session fence until an abort-ignoring executor settles", async () => {
    const gate = deferred<void>();
    const launched: string[] = [];
    const { db, store, scheduler } = harness(
      async (task) => {
        launched.push(task.prompt);
        if (task.prompt === "first") await gate.promise;
        return { prompt: task.prompt };
      },
      { concurrency: 2, taskTimeoutMs: 10, abortDrainMs: 1 },
    );
    try {
      const first = store.submit({
        sessionId: "same-session",
        prompt: "first",
        task: { type: "session.run", sessionId: "same-session", prompt: "first" },
      });
      const second = store.submit({
        sessionId: "same-session",
        prompt: "second",
        task: { type: "session.run", sessionId: "same-session", prompt: "second" },
      });
      expect(scheduler.processBatch()).toBe(true);
      await eventually(() => store.require(first.invocationId).status === "failed");
      expect(store.require(first.invocationId).status).toBe("failed");
      await expect(scheduler.wait({ timeoutMs: 20 })).rejects.toThrow(
        "timed out waiting for Spark daemon invocations",
      );
      expect(scheduler.processBatch()).toBe(false);
      expect(launched).toEqual(["first"]);

      gate.resolve();
      await scheduler.wait({ timeoutMs: 500 });
      expect(scheduler.processBatch()).toBe(true);
      await scheduler.wait({ timeoutMs: 500 });
      expect(store.require(second.invocationId).status).toBe("succeeded");
      expect(launched).toEqual(["first", "second"]);
    } finally {
      gate.resolve();
      db.close();
    }
  });
});

async function eventually(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for scheduler state");
    await delay(1);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
