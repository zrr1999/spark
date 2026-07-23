import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SparkDaemonDriverTickTask } from "../core/types.ts";
import { SparkDriverStore } from "./drivers.ts";
import { SparkInvocationStore } from "./invocations.ts";
import { migrateSparkDaemonDatabase } from "./schema.ts";

describe("SparkDriverStore", () => {
  it("coalesces an overdue wake while the owner session is busy", () => {
    const harness = createHarness();
    try {
      harness.drivers.start({
        driverId: "loop-one",
        kind: "loop",
        ownerSessionId: "session-one",
        cwd: "/workspace",
        prompt: "tick",
        dueAt: "2026-07-23T00:00:00.000Z",
      });
      const busy = harness.invocations.submit({
        sessionId: "session-one",
        prompt: "foreground",
        now: "2026-07-23T00:00:00.000Z",
      });
      expect(harness.drivers.materializeDue("2026-07-23T00:00:01.000Z")).toBeUndefined();
      expect(harness.drivers.require("loop-one")).toMatchObject({
        status: "scheduled",
        dueAt: "2026-07-23T00:00:00.000Z",
      });
      harness.invocations.requestCancellation(
        busy.invocationId,
        "done",
        "2026-07-23T00:00:02.000Z",
      );

      const tick = harness.drivers.materializeDue("2026-07-23T00:00:03.000Z");
      expect(tick?.task).toMatchObject({
        type: "driver.tick",
        driverId: "loop-one",
        ownerSessionId: "session-one",
      });
      expect(harness.drivers.materializeDue("2026-07-23T00:00:04.000Z")).toBeUndefined();
      expect(harness.drivers.require("loop-one").status).toBe("running");
    } finally {
      harness.close();
    }
  });

  it("does not let one busy owner starve another owner's due driver", () => {
    const harness = createHarness();
    try {
      harness.drivers.start({
        driverId: "busy-owner-loop",
        kind: "loop",
        ownerSessionId: "busy-owner",
        cwd: "/workspace",
        prompt: "busy tick",
        dueAt: "2026-07-23T00:00:00.000Z",
      });
      harness.drivers.start({
        driverId: "free-owner-loop",
        kind: "loop",
        ownerSessionId: "free-owner",
        cwd: "/workspace",
        prompt: "free tick",
        dueAt: "2026-07-23T00:00:01.000Z",
      });
      harness.invocations.submit({
        sessionId: "busy-owner",
        prompt: "foreground",
        now: "2026-07-23T00:00:00.000Z",
      });

      const tick = harness.drivers.materializeDue("2026-07-23T00:00:02.000Z");
      expect(tick?.sourceRef).toBe("free-owner-loop");
      expect(harness.drivers.require("busy-owner-loop")).toMatchObject({
        status: "scheduled",
        dueAt: "2026-07-23T00:00:00.000Z",
      });
    } finally {
      harness.close();
    }
  });

  it("keeps an explicit generation schedule when the old tick completes", () => {
    const harness = createHarness();
    try {
      harness.drivers.start({
        driverId: "loop-cas",
        kind: "loop",
        ownerSessionId: "session-cas",
        cwd: "/workspace",
        prompt: "tick",
        now: "2026-07-23T00:00:00.000Z",
      });
      harness.drivers.materializeDue("2026-07-23T00:00:00.000Z");
      const invocation = harness.invocations.claimNext("worker", "2026-07-23T00:00:01.000Z")!;
      const task = invocation.task as SparkDaemonDriverTickTask;
      const scheduled = harness.drivers.schedule(
        { driverId: task.driverId, generation: task.generation, delayMs: 5_000 },
        "2026-07-23T00:00:02.000Z",
      );
      expect(scheduled).toMatchObject({
        generation: 2,
        status: "scheduled",
        dueAt: "2026-07-23T00:00:07.000Z",
      });

      const completed = harness.drivers.completeTick(invocation, task, {
        status: "succeeded",
        now: "2026-07-23T00:00:03.000Z",
      });
      expect(completed.driver).toMatchObject({
        generation: 2,
        status: "scheduled",
        dueAt: "2026-07-23T00:00:07.000Z",
      });
      expect(() =>
        harness.drivers.schedule(
          { driverId: task.driverId, generation: task.generation, delayMs: 1_000 },
          "2026-07-23T00:00:04.000Z",
        ),
      ).toThrow(/DRIVER_GENERATION_CONFLICT/u);
    } finally {
      harness.close();
    }
  });

  it("clears retry attempts when a recovered tick explicitly schedules success", () => {
    const harness = createHarness();
    try {
      harness.drivers.start({
        driverId: "loop-recovered",
        kind: "loop",
        ownerSessionId: "session-recovered",
        cwd: "/workspace",
        prompt: "tick",
        initialStatus: "retry_wait",
        initialAttempt: 2,
      });
      harness.drivers.materializeDue();
      const invocation = harness.invocations.claimNext("worker")!;
      const task = invocation.task as SparkDaemonDriverTickTask;
      expect(harness.drivers.require(task.driverId).attempt).toBe(2);

      expect(
        harness.drivers.schedule(
          { driverId: task.driverId, generation: task.generation, delayMs: 5_000 },
          "2026-07-23T00:00:00.000Z",
        ),
      ).toMatchObject({ status: "scheduled", attempt: 0 });
    } finally {
      harness.close();
    }
  });

  it("advances generation before materializing policy continuations and retries", () => {
    const harness = createHarness();
    try {
      const first = runningTick(harness, "goal-repeat", "goal", "session-repeat");
      const continued = harness.drivers.completeTick(first.invocation, first.task, {
        status: "succeeded",
        now: "2026-07-23T00:00:00.000Z",
      }).driver;
      expect(continued).toMatchObject({
        generation: 2,
        status: "scheduled",
        dueAt: "2026-07-23T00:00:30.000Z",
      });
      const second = harness.drivers.materializeDue("2026-07-23T00:00:30.000Z");
      expect(second?.invocationId).not.toBe(first.invocation.invocationId);
      expect(second?.task).toMatchObject({ generation: 2 });

      harness.drivers.stop("goal-repeat", "finish continuation assertion");
      const retryTick = runningTick(harness, "goal-retry", "goal", "session-retry");
      const retry = harness.drivers.completeTick(retryTick.invocation, retryTick.task, {
        status: "failed",
        errorCode: "EXECUTOR_TIMEOUT",
        now: "2026-07-23T00:01:00.000Z",
      }).driver;
      expect(retry).toMatchObject({
        generation: 2,
        status: "retry_wait",
        dueAt: "2026-07-23T00:01:30.000Z",
      });
      const retried = harness.drivers.materializeDue("2026-07-23T00:01:30.000Z");
      expect(retried?.invocationId).not.toBe(retryTick.invocation.invocationId);
      expect(retried?.task).toMatchObject({ generation: 2 });
    } finally {
      harness.close();
    }
  });

  it("keeps a running wake attached to the same invocation across resume", () => {
    const harness = createHarness();
    try {
      const tick = runningTick(harness, "goal-resume", "goal", "session-resume");
      const resumed = harness.invocations.requeueForResume(
        tick.invocation.invocationId,
        "2026-07-23T00:00:00.000Z",
      );
      expect(resumed).toMatchObject({
        invocationId: tick.invocation.invocationId,
        status: "queued",
        task: {
          type: "driver.tick",
          driverId: "goal-resume",
          generation: 1,
          resumeFromInterrupt: true,
        },
      });
      expect(harness.drivers.require("goal-resume")).toMatchObject({
        status: "running",
        lastInvocationId: tick.invocation.invocationId,
      });
      expect(harness.drivers.materializeDue("2026-07-23T00:00:01.000Z")).toBeUndefined();
    } finally {
      harness.close();
    }
  });

  it("reconciles a terminal invocation left beside an unsettled running wake", () => {
    const harness = createHarness();
    try {
      const tick = runningTick(harness, "goal-terminal", "goal", "session-terminal");
      harness.invocations.complete(tick.invocation.invocationId, {
        status: "succeeded",
        now: "2026-07-23T00:00:00.000Z",
      });

      expect(harness.drivers.reconcileTerminalTicks("2026-07-23T00:00:01.000Z")).toEqual([
        expect.objectContaining({
          driverId: "goal-terminal",
          generation: 2,
          status: "scheduled",
          dueAt: "2026-07-23T00:00:31.000Z",
        }),
      ]);
    } finally {
      harness.close();
    }
  });

  it("applies policy backoff, manual-abort blocking, and fail-closed unknown errors", () => {
    const harness = createHarness();
    try {
      const workflow = runningTick(harness, "workflow-one", "workflow", "session-workflow");
      const retry = harness.drivers.completeTick(workflow.invocation, workflow.task, {
        status: "failed",
        errorCode: "EXECUTOR_TIMEOUT",
        errorMessage: "temporary",
        now: "2026-07-23T00:00:00.000Z",
      }).driver;
      expect(retry).toMatchObject({
        status: "retry_wait",
        attempt: 1,
        dueAt: "2026-07-23T00:00:01.000Z",
      });
      expect(() => harness.invocations.retry(workflow.invocation.invocationId)).toThrow(
        /driver tick/u,
      );
      harness.drivers.stop("workflow-one", "test finished workflow retry assertion");

      const unknown = runningTick(harness, "goal-unknown", "goal", "session-unknown");
      expect(
        harness.drivers.completeTick(unknown.invocation, unknown.task, {
          status: "failed",
          errorMessage: "outcome unknown",
        }).driver,
      ).toMatchObject({ status: "blocked", attempt: 0 });

      const cancelled = runningTick(harness, "repro-abort", "repro", "session-abort");
      expect(
        harness.drivers.completeTick(cancelled.invocation, cancelled.task, {
          status: "cancelled",
          cancelReason: "user abort",
        }).driver,
      ).toMatchObject({ status: "blocked", reason: "manual abort" });
    } finally {
      harness.close();
    }
  });

  it("uses capped retry sequences for foreground and workflow drivers", () => {
    for (const [kind, delays] of [
      ["goal", [30_000, 60_000, 120_000, 120_000]],
      ["workflow", [1_000, 2_000, 5_000, 10_000, 30_000, 30_000]],
    ] as const) {
      const harness = createHarness();
      try {
        let nowMs = Date.parse("2026-07-23T00:00:00.000Z");
        harness.drivers.start({
          driverId: `retry-${kind}`,
          kind,
          ownerSessionId: `owner-${kind}`,
          cwd: "/workspace",
          prompt: "tick",
          now: new Date(nowMs).toISOString(),
        });
        for (const [index, delayMs] of delays.entries()) {
          harness.drivers.materializeDue(new Date(nowMs).toISOString());
          const invocation = harness.invocations.claimNext(`worker-${index}`)!;
          const task = invocation.task as SparkDaemonDriverTickTask;
          const retried = harness.drivers.completeTick(invocation, task, {
            status: "failed",
            errorCode: "EXECUTOR_TIMEOUT",
            now: new Date(nowMs).toISOString(),
          }).driver;
          nowMs += delayMs;
          expect(retried).toMatchObject({
            status: "retry_wait",
            attempt: index + 1,
            dueAt: new Date(nowMs).toISOString(),
          });
        }
      } finally {
        harness.close();
      }
    }
  });

  it("builds fresh ticks against a hidden reset session while retaining owner state", () => {
    const harness = createHarness();
    try {
      harness.drivers.start({
        driverId: "loop-fresh",
        kind: "loop",
        ownerSessionId: "owner-session",
        continuity: "fresh",
        cwd: "/workspace",
        prompt: "fresh tick",
        now: "2026-07-23T00:00:00.000Z",
      });
      const invocation = harness.drivers.materializeDue();
      expect(invocation?.task).toMatchObject({
        type: "driver.tick",
        sessionId: "owner-session",
        ownerSessionId: "owner-session",
        stateOwnerSessionId: "owner-session",
        executionSessionId: expect.stringMatching(/^driver_[0-9a-f]{24}_1$/u),
        reset: true,
      });
      const executionSessionId = (invocation?.task as SparkDaemonDriverTickTask)
        .executionSessionId!;
      expect(
        harness.db
          .prepare(
            `SELECT status, invocation_id FROM driver_hidden_sessions
             WHERE execution_session_id = ?`,
          )
          .get(executionSessionId),
      ).toMatchObject({
        status: "active",
        invocation_id: invocation?.invocationId,
      });
      const running = harness.invocations.claimNext("fresh-worker")!;
      harness.drivers.completeTick(running, running.task as SparkDaemonDriverTickTask, {
        status: "succeeded",
        result: {
          sessionPath: `/daemon/private/${executionSessionId}.jsonl`,
          assistantText: "done",
        },
        now: "2026-07-23T00:00:00.000Z",
      });
      expect(
        harness.db
          .prepare(
            `SELECT status, session_path, gc_after FROM driver_hidden_sessions
             WHERE execution_session_id = ?`,
          )
          .get(executionSessionId),
      ).toMatchObject({
        status: "archived",
        session_path: `/daemon/private/${executionSessionId}.jsonl`,
        gc_after: "2026-07-24T00:00:00.000Z",
      });
    } finally {
      harness.close();
    }
  });

  it("consumes a manual wake prompt exactly once and retains the base driver prompt", () => {
    const harness = createHarness();
    try {
      harness.drivers.start({
        driverId: "loop-wake-prompt",
        kind: "loop",
        ownerSessionId: "owner-wake-prompt",
        cwd: "/workspace",
        prompt: "base loop objective",
      });
      harness.drivers.stop("loop-wake-prompt", "wait for a manual wake");
      harness.drivers.wake("loop-wake-prompt", {
        prompt: "one-shot operator instruction",
        now: "2026-07-23T00:00:00.000Z",
      });

      const first = harness.drivers.materializeDue("2026-07-23T00:00:00.000Z")!;
      expect(first.task).toMatchObject({
        type: "driver.tick",
        prompt: "one-shot operator instruction",
      });
      expect(harness.drivers.require("loop-wake-prompt")).toMatchObject({
        prompt: "base loop objective",
      });
      expect(harness.drivers.require("loop-wake-prompt").wakePrompt).toBeUndefined();

      const running = harness.invocations.claimNext("wake-worker")!;
      harness.drivers.completeTick(running, running.task as SparkDaemonDriverTickTask, {
        status: "succeeded",
        now: "2026-07-23T00:00:01.000Z",
      });
      harness.drivers.wake("loop-wake-prompt", {
        now: "2026-07-23T00:00:02.000Z",
      });
      expect(harness.drivers.materializeDue("2026-07-23T00:00:02.000Z")?.task).toMatchObject({
        type: "driver.tick",
        prompt: "base loop objective",
      });
    } finally {
      harness.close();
    }
  });

  it("garbage-collects expired fresh sessions and retains failed removals", async () => {
    const harness = createHarness();
    try {
      harness.drivers.start({
        driverId: "loop-fresh-gc",
        kind: "loop",
        ownerSessionId: "owner-fresh-gc",
        continuity: "fresh",
        cwd: "/workspace",
        prompt: "fresh tick",
        now: "2026-07-23T00:00:00.000Z",
      });
      harness.drivers.materializeDue("2026-07-23T00:00:00.000Z");
      const running = harness.invocations.claimNext("fresh-gc-worker")!;
      const executionSessionId = (running.task as SparkDaemonDriverTickTask).executionSessionId!;
      harness.drivers.completeTick(running, running.task as SparkDaemonDriverTickTask, {
        status: "succeeded",
        result: { sessionPath: `/daemon/private/${executionSessionId}.jsonl` },
        now: "2026-07-23T00:00:00.000Z",
      });

      expect(
        await harness.drivers.gcHiddenSessions("2026-07-23T23:59:59.999Z", async () => {
          throw new Error("not due");
        }),
      ).toEqual({ examined: 0, deleted: 0, errors: [] });

      const failed = await harness.drivers.gcHiddenSessions(
        "2026-07-24T00:00:00.000Z",
        async () => {
          throw new Error("filesystem busy");
        },
      );
      expect(failed).toEqual({
        examined: 1,
        deleted: 0,
        errors: [
          {
            executionSessionId,
            message: "filesystem busy",
          },
        ],
      });

      const removedPaths: string[] = [];
      expect(
        await harness.drivers.gcHiddenSessions("2026-07-24T00:00:01.000Z", async (path) => {
          removedPaths.push(path);
        }),
      ).toEqual({ examined: 1, deleted: 1, errors: [] });
      expect(removedPaths).toEqual([`/daemon/private/${executionSessionId}.jsonl`]);
      expect(
        harness.db
          .prepare(
            `SELECT execution_session_id FROM driver_hidden_sessions
             WHERE execution_session_id = ?`,
          )
          .get(executionSessionId),
      ).toBeUndefined();
    } finally {
      harness.close();
    }
  });

  it("uses capability success policies without spinning implement or workflow", () => {
    for (const [index, expected] of [
      ["goal", { status: "scheduled", dueAt: "2026-07-23T00:00:30.000Z" }],
      ["repro", { status: "scheduled", dueAt: "2026-07-23T00:00:30.000Z" }],
      ["loop", { status: "dormant" }],
      ["implement", { status: "dormant" }],
      ["workflow", { status: "dormant" }],
      ["session_todo", { status: "dormant" }],
    ] as const) {
      const harness = createHarness();
      try {
        const tick = runningTick(harness, `policy-${index}`, index, `session-${index}`);
        expect(
          harness.drivers.completeTick(tick.invocation, tick.task, {
            status: "succeeded",
            now: "2026-07-23T00:00:00.000Z",
          }).driver,
        ).toMatchObject(expected);
      } finally {
        harness.close();
      }
    }
  });

  it("atomically replaces the foreground lane while preserving workflow background work", () => {
    const harness = createHarness();
    try {
      harness.drivers.start({
        driverId: "fallback",
        kind: "session_todo",
        ownerSessionId: "owner",
        cwd: "/workspace",
        prompt: "todo",
      });
      harness.drivers.start({
        driverId: "workflow",
        kind: "workflow",
        ownerSessionId: "owner",
        cwd: "/workspace",
        prompt: "workflow",
      });
      harness.drivers.start({
        driverId: "goal",
        kind: "goal",
        ownerSessionId: "owner",
        cwd: "/workspace",
        prompt: "goal",
      });
      expect(harness.drivers.require("fallback").status).toBe("stopped");
      expect(harness.drivers.require("workflow").status).toBe("scheduled");
      expect(harness.drivers.require("goal").status).toBe("scheduled");

      harness.drivers.start({
        driverId: "loop",
        kind: "loop",
        ownerSessionId: "owner",
        cwd: "/workspace",
        prompt: "loop",
      });
      expect(harness.drivers.require("goal").status).toBe("stopped");
      expect(harness.drivers.require("loop").status).toBe("scheduled");
      expect(harness.drivers.require("workflow").status).toBe("scheduled");
    } finally {
      harness.close();
    }
  });

  it("prevents fallback races and makes wake replace the foreground lane", () => {
    const harness = createHarness();
    try {
      harness.drivers.start({
        driverId: "goal-old",
        kind: "goal",
        ownerSessionId: "owner-lane",
        cwd: "/workspace",
        prompt: "old goal",
      });
      expect(() =>
        harness.drivers.start({
          driverId: "todo-race",
          kind: "session_todo",
          ownerSessionId: "owner-lane",
          cwd: "/workspace",
          prompt: "todo",
        }),
      ).toThrow(/DRIVER_FOREGROUND_LANE_ACTIVE/u);

      harness.drivers.stop("goal-old", "switch to loop");
      harness.drivers.start({
        driverId: "loop-current",
        kind: "loop",
        ownerSessionId: "owner-lane",
        cwd: "/workspace",
        prompt: "current loop",
      });
      const woken = harness.drivers.wake("goal-old", { reason: "resume old goal" });
      expect(woken.status).toBe("scheduled");
      expect(harness.drivers.require("loop-current").status).toBe("stopped");
    } finally {
      harness.close();
    }
  });

  it("requests cancellation for a running tick when its driver is stopped", () => {
    const harness = createHarness();
    try {
      const tick = runningTick(harness, "goal-stop", "goal", "owner-stop");
      harness.drivers.stop("goal-stop", "user stopped the goal");
      expect(harness.drivers.require("goal-stop").status).toBe("stopped");
      expect(harness.invocations.require(tick.invocation.invocationId)).toMatchObject({
        status: "running",
        cancelReason: "user stopped the goal",
      });
    } finally {
      harness.close();
    }
  });

  it("lets the current tick stop its driver without aborting its own invocation", () => {
    const harness = createHarness();
    try {
      const tick = runningTick(harness, "goal-complete", "goal", "owner-complete");
      harness.drivers.stop(
        "goal-complete",
        "goal completion approved",
        "2026-07-23T00:00:00.000Z",
        { cancelInvocation: false },
      );
      expect(harness.drivers.require("goal-complete").status).toBe("stopped");
      const activeInvocation = harness.invocations.require(tick.invocation.invocationId);
      expect(activeInvocation.status).toBe("running");
      expect(activeInvocation.cancelReason).toBeUndefined();
      const completed = harness.drivers.completeTick(tick.invocation, tick.task, {
        status: "succeeded",
        now: "2026-07-23T00:00:01.000Z",
      });
      expect(completed.driver.status).toBe("stopped");
    } finally {
      harness.close();
    }
  });

  it("cancels the current tick when the same driver is started or restarted", () => {
    const harness = createHarness();
    try {
      const started = runningTick(harness, "goal-restart", "goal", "owner-restart");
      harness.drivers.start({
        driverId: "goal-restart",
        kind: "goal",
        ownerSessionId: "owner-restart",
        cwd: "/workspace",
        prompt: "replacement tick",
      });
      expect(harness.invocations.require(started.invocation.invocationId)).toMatchObject({
        status: "running",
        cancelReason: "driver restarted by driver.start",
      });
      harness.invocations.complete(started.invocation.invocationId, {
        status: "cancelled",
        cancelReason: "driver restarted by driver.start",
      });
      const replacement = harness.drivers.materializeDue();
      expect(replacement?.sourceRef).toBe("goal-restart");
      const runningReplacement = harness.invocations.claimNext("replacement-worker")!;

      harness.drivers.restart("goal-restart", "restart again");
      expect(harness.invocations.require(runningReplacement.invocationId)).toMatchObject({
        status: "running",
        cancelReason: "restart again",
      });
    } finally {
      harness.close();
    }
  });
});

function runningTick(
  harness: ReturnType<typeof createHarness>,
  driverId: string,
  kind: "goal" | "loop" | "repro" | "implement" | "workflow" | "session_todo",
  ownerSessionId: string,
) {
  harness.drivers.start({
    driverId,
    kind,
    ownerSessionId,
    cwd: "/workspace",
    prompt: "tick",
  });
  harness.drivers.materializeDue();
  const invocation = harness.invocations.claimNext("worker")!;
  return { invocation, task: invocation.task as SparkDaemonDriverTickTask };
}

function createHarness() {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  const invocations = new SparkInvocationStore(db);
  return {
    db,
    invocations,
    drivers: new SparkDriverStore(db, invocations),
    close: () => db.close(),
  };
}
