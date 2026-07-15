import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  cancelSparkDaemonRestartSuccessor,
  isSparkDaemonRestartHelperDefinitelyDead,
  isSparkDaemonRestartPredecessorAlive,
  matchesSparkDaemonRestartReplacement,
  readSparkDaemonRestartSuccessorContext,
  runSparkDaemonRestartSuccessor,
  scheduleSparkDaemonRestartSuccessor,
  stopSparkDaemonRestartStartedService,
} from "./service.ts";

const paths = resolveSparkPaths({ app: "daemon", env: { HOME: "/tmp/spark-service-test" } });

describe("Spark daemon restart successor", () => {
  it("publishes intent and waits for the helper to validate the exact committed fence", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-helper-handshake-"));
    const handshakePaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run"), stateDir: join(root, "state") },
    });
    const intentPath = join(handshakePaths.runtimeDir, "restart.intent.json");
    const helper = `
      const fs = require("node:fs");
      const restartId = process.argv.at(-1);
      process.send({ type: "spark-daemon-restart-helper-ready", restartId });
      process.on("message", (message) => {
        if (message?.type !== "spark-daemon-restart-intent-committed") return;
        const intent = JSON.parse(fs.readFileSync(process.env.SPARK_TEST_RESTART_INTENT, "utf8"));
        if (intent.restartId !== restartId) process.exit(17);
        setTimeout(() => process.send({
          type: "spark-daemon-restart-helper-armed",
          restartId,
          targetInstanceId: intent.targetInstanceId,
          targetGeneration: intent.targetGeneration,
        }), 25);
      });
      setInterval(() => {}, 1000);
    `;
    const startedAt = Date.now();
    try {
      const schedule = await scheduleSparkDaemonRestartSuccessor(
        handshakePaths,
        process.pid,
        {
          instanceId: "predecessor-instance",
          generation: "predecessor-generation",
          startedAt: "2026-07-15T00:00:00.000Z",
        },
        "2026-07-15T00:01:00.000Z",
        {
          helperCommand: [process.execPath, "-e", helper],
          helperEnv: { SPARK_TEST_RESTART_INTENT: intentPath },
        },
      );

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
      expect(JSON.parse(readFileSync(intentPath, "utf8"))).toMatchObject({
        restartId: schedule.restartId,
        targetInstanceId: schedule.targetInstanceId,
        targetGeneration: schedule.targetGeneration,
      });
      if (schedule.helperPid) process.kill(schedule.helperPid, "SIGTERM");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("revokes a newly published fence when the helper exits before final armed ack", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-helper-exit-"));
    const exitPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run"), stateDir: join(root, "state") },
    });
    const helper = `
      const restartId = process.argv.at(-1);
      process.send({ type: "spark-daemon-restart-helper-ready", restartId });
      process.on("message", () => process.exit(23));
      setInterval(() => {}, 1000);
    `;
    try {
      await expect(
        scheduleSparkDaemonRestartSuccessor(
          exitPaths,
          process.pid,
          {
            instanceId: "predecessor-instance",
            generation: "predecessor-generation",
            startedAt: "2026-07-15T00:00:00.000Z",
          },
          "2026-07-15T00:01:00.000Z",
          { helperCommand: [process.execPath, "-e", helper] },
        ),
      ).rejects.toThrow("exited before readiness");
      expect(existsSync(join(exitPaths.runtimeDir, "restart.intent.json"))).toBe(false);
      expect(existsSync(join(exitPaths.runtimeDir, "restart.starting.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only kills an exactly owned spawned child during revoked handoff cleanup", () => {
    const kill = vi.fn();
    const stopLaunchd = vi.fn();
    const spawned = {
      kind: "detached" as const,
      alreadyRunning: false,
      detail: "spawned",
      ownership: "spawned" as const,
      pid: 303,
      processStartToken: "linux:owned",
    };

    stopSparkDaemonRestartStartedService(paths, spawned, {
      readProcessStartToken: () => "linux:reused",
      kill,
    });
    stopSparkDaemonRestartStartedService(
      paths,
      { ...spawned, ownership: "observed" },
      { readProcessStartToken: () => "linux:owned", kill },
    );
    expect(kill).not.toHaveBeenCalled();

    stopSparkDaemonRestartStartedService(paths, spawned, {
      readProcessStartToken: () => "linux:owned",
      kill,
    });
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(303, "SIGTERM");

    stopSparkDaemonRestartStartedService(
      paths,
      { kind: "launchd", alreadyRunning: false, detail: "launchd" },
      { stopLaunchd },
    );
    expect(stopLaunchd).toHaveBeenCalledWith(paths);
  });

  it("heals a watchdog only when its death or PID reuse is verifiable", () => {
    const schedule = { helperPid: 404, helperProcessStartToken: "linux:original" };
    expect(
      isSparkDaemonRestartHelperDefinitelyDead(schedule, {
        readProcessStartToken: () => "linux:original",
        processAlive: () => true,
      }),
    ).toBe(false);
    expect(
      isSparkDaemonRestartHelperDefinitelyDead(schedule, {
        readProcessStartToken: () => null,
        processAlive: () => true,
      }),
    ).toBe(false);
    expect(
      isSparkDaemonRestartHelperDefinitelyDead(schedule, {
        readProcessStartToken: () => "linux:reused",
        processAlive: () => true,
      }),
    ).toBe(true);
    expect(
      isSparkDaemonRestartHelperDefinitelyDead(schedule, {
        readProcessStartToken: () => null,
        processAlive: () => false,
      }),
    ).toBe(true);
  });

  it("waits conservatively when the predecessor token is temporarily unavailable", () => {
    const intent = {
      previousPid: 101,
      previousProcessStartToken: "linux:original-start",
    };

    expect(
      isSparkDaemonRestartPredecessorAlive(intent, {
        readProcessStartToken: () => null,
        processAlive: () => true,
      }),
    ).toBe(true);
    expect(
      isSparkDaemonRestartPredecessorAlive(intent, {
        readProcessStartToken: () => null,
        processAlive: () => false,
      }),
    ).toBe(false);
    expect(
      isSparkDaemonRestartPredecessorAlive(intent, {
        readProcessStartToken: () => "linux:reused-pid",
        processAlive: () => true,
      }),
    ).toBe(false);
  });

  it("accepts readiness only from the exact fenced target identity and protocol", () => {
    const expected = {
      expectedPid: 202,
      expectedRestartId: "restart-1",
      targetInstanceId: "target-instance",
      targetGeneration: "target-generation",
    };
    const status = {
      lifecycle: {
        state: "running",
        process: {
          pid: 202,
          instanceId: "target-instance",
          generation: "target-generation",
          protocolVersion: 1,
          acceptedRestartId: "restart-1",
        },
      },
    };

    expect(matchesSparkDaemonRestartReplacement(status, expected)).toBe(true);
    expect(
      matchesSparkDaemonRestartReplacement(
        { lifecycle: { ...status.lifecycle, process: { ...status.lifecycle.process, pid: 101 } } },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesSparkDaemonRestartReplacement(
        {
          lifecycle: {
            ...status.lifecycle,
            process: { ...status.lifecycle.process, generation: "stale-generation" },
          },
        },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesSparkDaemonRestartReplacement(
        {
          lifecycle: {
            ...status.lifecycle,
            process: { ...status.lifecycle.process, acceptedRestartId: "restart-stale" },
          },
        },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesSparkDaemonRestartReplacement(
        {
          lifecycle: {
            ...status.lifecycle,
            process: { ...status.lifecycle.process, protocolVersion: 2 },
          },
        },
        expected,
      ),
    ).toBe(false);
  });
  it("lets an existing supervisor replacement win without starting another daemon", async () => {
    let aliveChecks = 0;
    const startService = vi.fn();

    const result = await runSparkDaemonRestartSuccessor(paths, 101, {
      processAlive: () => {
        aliveChecks += 1;
        return aliveChecks < 2;
      },
      runningPid: () => 202,
      startService,
      restartIntentActive: () => true,
      claimRestartIntent: () => true,
      restartClaimActive: () => true,
      completeRestartIntent: vi.fn(),
      replacementReady: async () => true,
      pollIntervalMs: 0,
      supervisorGraceMs: 10,
    });

    expect(result).toMatchObject({ alreadyRunning: true });
    expect(result?.detail).toContain("replacement process 202");
    expect(startService).not.toHaveBeenCalled();
  });

  it("starts exactly one replacement when no supervisor appears", async () => {
    let started = false;
    const startService = vi.fn(() => {
      started = true;
      return {
        kind: "detached" as const,
        alreadyRunning: false,
        detail: "started replacement",
      };
    });

    const result = await runSparkDaemonRestartSuccessor(paths, 101, {
      processAlive: () => false,
      runningPid: () => (started ? 202 : null),
      startService,
      restartIntentActive: () => true,
      claimRestartIntent: () => true,
      restartClaimActive: () => true,
      completeRestartIntent: vi.fn(),
      replacementReady: async () => true,
      supervisorGraceMs: 0,
    });

    expect(result?.detail).toBe("started replacement");
    expect(startService).toHaveBeenCalledOnce();
  });

  it("fails instead of overlapping a predecessor that does not exit", async () => {
    await expect(
      runSparkDaemonRestartSuccessor(paths, 101, {
        processAlive: () => true,
        restartIntentActive: () => true,
        previousExitTimeoutMs: 0,
      }),
    ).rejects.toThrow("did not exit for restart handoff");
  });

  it("does not start after an explicit stop cancels the restart intent", async () => {
    const startService = vi.fn();
    const result = await runSparkDaemonRestartSuccessor(paths, 101, {
      processAlive: () => false,
      restartIntentActive: () => false,
      startService,
    });

    expect(result).toBeNull();
    expect(startService).not.toHaveBeenCalled();
  });

  it("stops a just-spawned replacement when stop revokes the starting fence", async () => {
    let claimChecks = 0;
    const startService = vi.fn(() => ({
      kind: "detached" as const,
      alreadyRunning: false,
      detail: "started replacement",
      pid: 303,
    }));
    const stopStartedService = vi.fn();
    const result = await runSparkDaemonRestartSuccessor(paths, 101, {
      processAlive: () => false,
      runningPid: () => null,
      restartIntentActive: () => true,
      claimRestartIntent: () => true,
      restartClaimActive: () => {
        claimChecks += 1;
        return claimChecks <= 2;
      },
      completeRestartIntent: vi.fn(),
      startService,
      stopStartedService,
      supervisorGraceMs: 0,
    });

    expect(result).toBeNull();
    expect(startService).toHaveBeenCalledOnce();
    expect(stopStartedService).toHaveBeenCalledWith(expect.objectContaining({ pid: 303 }));
  });

  it("consumes the real restart fence before starting a detached successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-fence-"));
    const fencedPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run") },
    });
    const intentPath = join(fencedPaths.runtimeDir, "restart.intent.json");
    mkdirSync(fencedPaths.runtimeDir, { recursive: true });
    writeFileSync(
      intentPath,
      JSON.stringify({
        restartId: "restart-real",
        previousPid: 101,
        previousInstanceId: "previous-instance",
        previousGeneration: "previous-generation",
        previousStartedAt: "2026-07-15T00:00:00.000Z",
        previousProcessStartToken: "test:previous",
        targetInstanceId: "target-instance",
        targetGeneration: "target-generation",
        protocolVersion: 1,
        requestedAt: "2026-07-15T00:01:00.000Z",
      }),
    );
    let started = false;
    const startService = vi.fn(() => {
      started = true;
      return {
        kind: "detached" as const,
        alreadyRunning: false,
        detail: "started fenced replacement",
      };
    });

    try {
      const result = await runSparkDaemonRestartSuccessor(fencedPaths, 101, {
        processAlive: () => false,
        runningPid: () => (started ? 202 : null),
        startService,
        replacementReady: async () => true,
        supervisorGraceMs: 0,
      });

      expect(result?.detail).toBe("started fenced replacement");
      expect(existsSync(intentPath)).toBe(false);
      expect(cancelSparkDaemonRestartSuccessor(fencedPaths)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for a long-running predecessor while the restart intent remains active", async () => {
    let checks = 0;
    let started = false;
    const now = vi.spyOn(Date, "now").mockImplementation(() => checks * 31_000);
    try {
      const result = await runSparkDaemonRestartSuccessor(paths, 101, {
        processAlive: () => {
          checks += 1;
          return checks < 4;
        },
        runningPid: () => (started ? 202 : null),
        startService: () => {
          started = true;
          return { kind: "detached", alreadyRunning: false, detail: "started after long drain" };
        },
        restartIntentActive: () => true,
        claimRestartIntent: () => true,
        restartClaimActive: () => true,
        replacementReady: async () => true,
        pollIntervalMs: 0,
        supervisorGraceMs: 0,
      });

      expect(result?.detail).toBe("started after long drain");
      expect(checks).toBe(4);
    } finally {
      now.mockRestore();
    }
  });

  it("ignores a stale helper when a newer restart id owns the same predecessor pid", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-stale-helper-"));
    const stalePaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run") },
    });
    mkdirSync(stalePaths.runtimeDir, { recursive: true });
    writeFileSync(
      join(stalePaths.runtimeDir, "restart.intent.json"),
      JSON.stringify({
        restartId: "restart-new",
        previousPid: 101,
        previousInstanceId: "instance-new",
        previousGeneration: "generation-new",
        previousStartedAt: "2026-07-15T00:00:00.000Z",
        previousProcessStartToken: "test:new",
        targetInstanceId: "target-new",
        targetGeneration: "target-generation-new",
        protocolVersion: 1,
        requestedAt: "2026-07-15T00:01:00.000Z",
      }),
    );
    const startService = vi.fn();
    try {
      await expect(
        runSparkDaemonRestartSuccessor(stalePaths, 101, {
          expectedRestartId: "restart-old",
          processAlive: () => false,
          startService,
        }),
      ).resolves.toBeNull();
      expect(startService).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mistake a reused live pid for the fenced predecessor process", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-pid-reuse-"));
    const reusedPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run") },
    });
    mkdirSync(reusedPaths.runtimeDir, { recursive: true });
    writeFileSync(
      join(reusedPaths.runtimeDir, "restart.intent.json"),
      JSON.stringify({
        restartId: "restart-reused-pid",
        previousPid: process.pid,
        previousInstanceId: "old-instance",
        previousGeneration: "old-generation",
        previousStartedAt: "2026-07-15T00:00:00.000Z",
        previousProcessStartToken: "linux:definitely-not-this-process",
        targetInstanceId: "target-instance",
        targetGeneration: "target-generation",
        protocolVersion: 1,
        requestedAt: "2026-07-15T00:01:00.000Z",
      }),
    );
    try {
      expect(readSparkDaemonRestartSuccessorContext(reusedPaths)).toEqual({
        acceptedRestartId: "restart-reused-pid",
        instanceId: "target-instance",
        generation: "target-generation",
        predecessorInstanceId: "old-instance",
        predecessorGeneration: "old-generation",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
