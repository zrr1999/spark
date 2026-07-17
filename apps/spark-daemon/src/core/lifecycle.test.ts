import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { SparkDaemonLifecycle, SparkDaemonRestartRequestedError } from "./lifecycle.ts";

describe("SparkDaemonLifecycle", () => {
  it("publishes starting until startup admission is synchronously activated", () => {
    const lifecycle = new SparkDaemonLifecycle(
      {
        pid: 101,
        instanceId: "instance-starting",
        generation: "generation-starting",
        startedAt: "2026-07-15T00:00:00.000Z",
      },
      { initiallyServing: false },
    );

    expect(lifecycle.isServing).toBe(false);
    expect(lifecycle.snapshot()).toMatchObject({ state: "starting", phase: "initializing" });

    lifecycle.activate();

    expect(lifecycle.isServing).toBe(true);
    expect(lifecycle.snapshot()).toMatchObject({ state: "running", phase: "serving" });

    lifecycle.deactivate();

    expect(lifecycle.isServing).toBe(false);
    expect(lifecycle.snapshot()).toMatchObject({ state: "starting", phase: "initializing" });
  });

  it("turns repeated restart requests into one observable draining intent", async () => {
    const lifecycle = new SparkDaemonLifecycle({
      pid: 101,
      instanceId: "instance-1",
      generation: "generation-1",
      startedAt: "2026-07-15T00:00:00.000Z",
    });

    expect(lifecycle.snapshot()).toEqual({
      state: "running",
      phase: "serving",
      process: {
        pid: 101,
        instanceId: "instance-1",
        generation: "generation-1",
        protocolVersion: 1,
        startedAt: "2026-07-15T00:00:00.000Z",
      },
    });
    expect(lifecycle.drainSignal.aborted).toBe(false);
    expect(lifecycle.restartSignal.aborted).toBe(false);
    expect(
      lifecycle.requestRestart("2026-07-15T00:00:00.000Z", "restart-1", {
        instanceId: "target-instance-1",
        generation: "target-generation-1",
      }),
    ).toEqual({
      accepted: true,
      state: "draining",
      restartId: "restart-1",
      processInstanceId: "instance-1",
      processGeneration: "generation-1",
      targetInstanceId: "target-instance-1",
      targetGeneration: "target-generation-1",
      requestedAt: "2026-07-15T00:00:00.000Z",
    });
    expect(
      lifecycle.requestRestart("2026-07-15T00:01:00.000Z", "restart-2", {
        instanceId: "target-instance-2",
        generation: "target-generation-2",
      }),
    ).toEqual({
      accepted: true,
      state: "draining",
      restartId: "restart-1",
      processInstanceId: "instance-1",
      processGeneration: "generation-1",
      targetInstanceId: "target-instance-1",
      targetGeneration: "target-generation-1",
      requestedAt: "2026-07-15T00:00:00.000Z",
    });
    expect(lifecycle.snapshot()).toEqual({
      state: "draining",
      phase: "draining-active-work",
      process: {
        pid: 101,
        instanceId: "instance-1",
        generation: "generation-1",
        protocolVersion: 1,
        startedAt: "2026-07-15T00:00:00.000Z",
      },
      restartId: "restart-1",
      targetInstanceId: "target-instance-1",
      targetGeneration: "target-generation-1",
      restartRequestedAt: "2026-07-15T00:00:00.000Z",
    });
    expect(lifecycle.drainSignal.aborted).toBe(true);
    expect(lifecycle.drainSignal.reason).toBeInstanceOf(SparkDaemonRestartRequestedError);
    expect(lifecycle.restartSignal.aborted).toBe(false);

    await delay(0);
    expect(lifecycle.restartSignal.aborted).toBe(true);
    expect(lifecycle.restartSignal.reason).toBeInstanceOf(SparkDaemonRestartRequestedError);
  });

  it("closes readiness synchronously and exposes the owner of stop teardown", () => {
    const lifecycle = new SparkDaemonLifecycle({
      pid: 202,
      instanceId: "instance-stop",
      generation: "generation-stop",
      startedAt: "2026-07-17T00:00:00.000Z",
    });

    lifecycle.requestStop("local-rpc-stop", "2026-07-17T00:01:00.000Z");
    lifecycle.requestStop("signal:SIGTERM", "2026-07-17T00:02:00.000Z");

    expect(lifecycle.isServing).toBe(false);
    expect(lifecycle.drainSignal.aborted).toBe(true);
    expect(lifecycle.restartSignal.aborted).toBe(false);
    expect(lifecycle.snapshot()).toEqual({
      state: "stopping",
      phase: "stopping",
      process: {
        pid: 202,
        instanceId: "instance-stop",
        generation: "generation-stop",
        protocolVersion: 1,
        startedAt: "2026-07-17T00:00:00.000Z",
      },
      stopRequestedAt: "2026-07-17T00:01:00.000Z",
      stopReason: "local-rpc-stop",
    });
    expect(() => lifecycle.requestRestart()).toThrow(
      "Spark daemon is stopping and cannot restart.",
    );
  });

  it("lets an explicit stop supersede an already-requested restart", () => {
    const lifecycle = new SparkDaemonLifecycle({
      pid: 303,
      instanceId: "instance-restart-then-stop",
      generation: "generation-restart-then-stop",
      startedAt: "2026-07-17T00:00:00.000Z",
    });

    lifecycle.requestRestart("2026-07-17T00:01:00.000Z", "restart-before-stop");
    lifecycle.requestStop("signal:SIGTERM", "2026-07-17T00:02:00.000Z");

    expect(lifecycle.isServing).toBe(false);
    expect(lifecycle.snapshot()).toMatchObject({
      state: "stopping",
      phase: "stopping",
      stopRequestedAt: "2026-07-17T00:02:00.000Z",
      stopReason: "signal:SIGTERM",
    });
  });
});
