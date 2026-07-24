import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  cancelSparkDaemonRestartSuccessor,
  clearSparkDaemonProcessOwnership,
  completeSparkDaemonRestartSuccessor,
  isSparkDaemonRestartHelperDefinitelyDead,
  isSparkDaemonRestartPredecessorAlive,
  isSparkDaemonRestartArmed,
  isSparkDaemonSupervisorRegistered,
  matchesSparkDaemonRestartReplacement,
  prepareSparkDaemonRestartAwareStart,
  publishSparkDaemonProcessOwnership,
  readSparkDaemonActiveRestart,
  readSparkDaemonProcessOwnership,
  readSparkDaemonRestartSuccessorContext,
  releaseSparkDaemonProcessOwnership,
  rotateSparkDaemonServiceLogs,
  runSparkDaemonRestartSuccessor,
  scheduleSparkDaemonRestartSuccessor,
  stopSparkDaemonLaunchdLabel,
  stopSparkDaemonPidFileProcess,
  stopSparkDaemonRestartStartedService,
  writeSparkDaemonLaunchdPlist,
} from "./service.ts";

const paths = resolveSparkPaths({ app: "daemon", env: { HOME: "/tmp/spark-service-test" } });

function readRestartTerminal(runtimeDir: string): Record<string, unknown> {
  const name = readdirSync(runtimeDir).find(
    (candidate) => candidate.startsWith("restart.terminal.") && candidate.endsWith(".json"),
  );
  if (!name) throw new Error("restart terminal record was not written");
  return JSON.parse(readFileSync(join(runtimeDir, name), "utf8")) as Record<string, unknown>;
}

describe("Spark daemon service logs", () => {
  it("retains a bounded tail and rotates prior backups", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-logs-"));
    const logDir = join(root, "logs");
    mkdirSync(logDir, { recursive: true });
    const stderrPath = join(logDir, "service.stderr.log");
    try {
      writeFileSync(`${stderrPath}.1`, "older");
      writeFileSync(stderrPath, "0123456789");

      rotateSparkDaemonServiceLogs({ logDir }, { maxBytes: 4, backups: 2 });

      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(readFileSync(`${stderrPath}.1`, "utf8")).toBe("6789");
      expect(readFileSync(`${stderrPath}.2`, "utf8")).toBe("older");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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
          supervisorManaged: true,
          targetVersion: "0.1.1",
          targetBuildFingerprint: `sha256:${"b".repeat(64)}`,
        },
      );

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
      expect(JSON.parse(readFileSync(intentPath, "utf8"))).toMatchObject({
        restartId: schedule.restartId,
        targetInstanceId: schedule.targetInstanceId,
        targetGeneration: schedule.targetGeneration,
        supervisorManaged: true,
        targetVersion: "0.1.1",
        targetBuildFingerprint: `sha256:${"b".repeat(64)}`,
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
      expect(readRestartTerminal(exitPaths.runtimeDir)).toMatchObject({ state: "cancelled" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only kills an exactly owned spawned child during revoked handoff cleanup", () => {
    const kill = vi.fn();
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
      { kill },
    );
    expect(kill).toHaveBeenCalledOnce();
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
        { lifecycle: { ...status.lifecycle, state: "starting" } },
        expected,
      ),
    ).toBe(false);
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

  it("starts an unmanaged detached successor without waiting for a stale supervisor", async () => {
    let started = false;
    const sleeps: number[] = [];
    const startService = vi.fn(() => {
      started = true;
      return {
        kind: "detached" as const,
        alreadyRunning: false,
        detail: "started unmanaged replacement",
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
      // A stale label alone must not delay an unmanaged predecessor.
      supervisorRegistered: () => true,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    expect(result?.detail).toBe("started unmanaged replacement");
    expect(startService).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([]);
  });

  it("detects supervisor ownership from the live launchd registration", () => {
    const run = vi.fn((args: string[]) => ({
      status: args[0] === "print" ? 0 : 1,
      stdout: "",
      stderr: "",
    }));

    expect(isSparkDaemonSupervisorRegistered({ platform: "darwin", uid: 501, run })).toBe(true);
    expect(run).toHaveBeenCalledWith(["print", "gui/501/dev.spark.daemon"]);
    expect(
      isSparkDaemonSupervisorRegistered({
        platform: "darwin",
        uid: 501,
        run: () => ({ status: 1, stdout: "", stderr: "not found" }),
      }),
    ).toBe(false);
    expect(isSparkDaemonSupervisorRegistered({ platform: "linux", uid: 501, run })).toBe(false);
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

  it("retries detached successor startup indefinitely with capped backoff until cancelled", async () => {
    let startAttempts = 0;
    const retryDelays: number[] = [];
    const startService = vi.fn(() => {
      startAttempts += 1;
      return {
        kind: "detached" as const,
        alreadyRunning: false,
        detail: `short-lived replacement ${startAttempts}`,
      };
    });
    const stopStartedService = vi.fn();

    const result = await runSparkDaemonRestartSuccessor(paths, 101, {
      processAlive: () => false,
      runningPid: () => null,
      startService,
      stopStartedService,
      restartIntentActive: () => true,
      claimRestartIntent: () => true,
      // The ninth failed launch is followed by the explicit cancellation
      // fence that alone terminates the otherwise-unbounded watchdog loop.
      restartClaimActive: () => startAttempts < 9,
      restartCompleted: () => false,
      replacementReady: async () => false,
      sleep: async (delayMs) => {
        retryDelays.push(delayMs);
      },
      supervisorGraceMs: 0,
    });

    expect(result).toBeNull();
    expect(startService).toHaveBeenCalledTimes(9);
    expect(retryDelays).toEqual([100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000]);
    expect(stopStartedService).toHaveBeenCalledTimes(9);
  });

  it("restarts an exactly-owned child that stays alive without becoming RPC-ready", async () => {
    let clock = 0;
    let startAttempts = 0;
    const failures: Array<{ phase: string; error: Error }> = [];
    const startService = vi.fn(() => {
      startAttempts += 1;
      return {
        kind: "detached" as const,
        alreadyRunning: false,
        detail: `owned replacement ${startAttempts}`,
        ownership: "spawned" as const,
        pid: 303,
        processStartToken: `token-${startAttempts}`,
      };
    });
    const stopStartedService = vi.fn();

    const result = await runSparkDaemonRestartSuccessor(paths, 101, {
      processAlive: () => false,
      runningPid: () => (startAttempts > 0 ? 303 : null),
      startService,
      stopStartedService,
      startedServiceAlive: () => true,
      restartIntentActive: () => true,
      claimRestartIntent: () => true,
      restartClaimActive: () => true,
      completeRestartIntent: vi.fn(),
      replacementReady: async () => startAttempts >= 2,
      replacementReadinessTimeoutMs: 3,
      pollIntervalMs: 1,
      supervisorGraceMs: 0,
      startRetryBaseMs: 0,
      startRetryMaxMs: 0,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      onRetryFailure: (failure) => failures.push(failure),
    });

    expect(result?.detail).toBe("owned replacement 2");
    expect(startService).toHaveBeenCalledTimes(2);
    expect(stopStartedService).toHaveBeenCalledOnce();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      phase: "readiness",
      error: expect.objectContaining({ message: expect.stringContaining("without RPC readiness") }),
    });
  });

  it("reports service start failures before retrying the same claimed fence", async () => {
    let startAttempts = 0;
    let started = false;
    const failures: Array<{ phase: string; error: Error }> = [];
    const result = await runSparkDaemonRestartSuccessor(paths, 101, {
      processAlive: () => false,
      runningPid: () => (started ? 404 : null),
      startService: () => {
        startAttempts += 1;
        if (startAttempts === 1) throw new Error("launch service unavailable");
        started = true;
        return { kind: "detached", alreadyRunning: false, detail: "recovered start" };
      },
      restartIntentActive: () => true,
      claimRestartIntent: () => true,
      restartClaimActive: () => true,
      completeRestartIntent: vi.fn(),
      replacementReady: async () => true,
      supervisorGraceMs: 0,
      startRetryBaseMs: 0,
      startRetryMaxMs: 0,
      sleep: async () => undefined,
      onRetryFailure: (failure) => failures.push(failure),
    });

    expect(result?.detail).toBe("recovered start");
    expect(startAttempts).toBe(2);
    expect(failures).toMatchObject([
      { phase: "start", error: { message: "launch service unavailable" } },
    ]);
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
        return claimChecks <= 3;
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
        supervisorManaged: false,
      }),
    );
    let started = false;
    const sleeps: number[] = [];
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
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
        },
      });

      expect(result?.detail).toBe("started fenced replacement");
      expect(startService).toHaveBeenCalledWith("restart-real");
      expect(sleeps).toEqual([]);
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
      expect(prepareSparkDaemonRestartAwareStart(stalePaths, "restart-old")).toEqual({
        start: false,
        reason: "superseded",
      });
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

  it("lets a disconnected helper take over only an exact durable Armed record", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-disconnect-takeover-"));
    const takeoverPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run") },
    });
    mkdirSync(takeoverPaths.runtimeDir, { recursive: true });
    writeFileSync(
      join(takeoverPaths.runtimeDir, "restart.intent.json"),
      JSON.stringify({
        state: "armed",
        restartId: "restart-parent-crash",
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
    try {
      expect(isSparkDaemonRestartArmed(takeoverPaths, 101, "restart-parent-crash")).toBe(true);
      expect(isSparkDaemonRestartArmed(takeoverPaths, 101, "restart-other")).toBe(false);
      expect(isSparkDaemonRestartArmed(takeoverPaths, 202, "restart-parent-crash")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets an exact RPC-ready successor complete a Claimed fence after helper crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-claimed-self-heal-"));
    const claimedPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run") },
    });
    mkdirSync(claimedPaths.runtimeDir, { recursive: true });
    writeFileSync(
      join(claimedPaths.runtimeDir, "restart.starting.json"),
      JSON.stringify({
        state: "claimed",
        restartId: "restart-helper-crash",
        previousPid: 999_999,
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
    const startService = vi.fn();
    try {
      expect(prepareSparkDaemonRestartAwareStart(claimedPaths, "restart-helper-crash")).toEqual({
        start: true,
        successorContext: {
          acceptedRestartId: "restart-helper-crash",
          instanceId: "target-instance",
          generation: "target-generation",
          predecessorInstanceId: "previous-instance",
          predecessorGeneration: "previous-generation",
        },
      });
      expect(
        completeSparkDaemonRestartSuccessor(claimedPaths, {
          acceptedRestartId: "restart-helper-crash",
          instanceId: "target-instance",
          generation: "target-generation",
        }),
      ).toBe(true);
      expect(existsSync(join(claimedPaths.runtimeDir, "restart.starting.json"))).toBe(false);
      expect(readRestartTerminal(claimedPaths.runtimeDir)).toMatchObject({
        state: "completed",
        restartId: "restart-helper-crash",
      });
      expect(prepareSparkDaemonRestartAwareStart(claimedPaths, "restart-helper-crash")).toEqual({
        start: false,
        reason: "completed",
      });
      await expect(
        runSparkDaemonRestartSuccessor(claimedPaths, 999_999, {
          expectedRestartId: "restart-helper-crash",
          processAlive: () => false,
          startService,
        }),
      ).resolves.toBeNull();
      expect(startService).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes a durable Cancelled tombstone win the stop-to-late-start race", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-cancelled-race-"));
    const cancelledPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run") },
    });
    mkdirSync(cancelledPaths.runtimeDir, { recursive: true });
    writeFileSync(
      join(cancelledPaths.runtimeDir, "restart.intent.json"),
      JSON.stringify({
        state: "armed",
        restartId: "restart-cancelled",
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
    const startService = vi.fn();
    try {
      expect(cancelSparkDaemonRestartSuccessor(cancelledPaths)).toBe(true);
      expect(readRestartTerminal(cancelledPaths.runtimeDir)).toMatchObject({
        state: "cancelled",
        restartId: "restart-cancelled",
      });
      expect(prepareSparkDaemonRestartAwareStart(cancelledPaths, "restart-cancelled")).toEqual({
        start: false,
        reason: "cancelled",
      });
      await expect(
        runSparkDaemonRestartSuccessor(cancelledPaths, 101, {
          expectedRestartId: "restart-cancelled",
          processAlive: () => false,
          startService,
        }),
      ).resolves.toBeNull();
      expect(startService).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed instead of killing a reused or legacy pidfile process", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-stop-pid-reuse-"));
    const stopPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run") },
    });
    mkdirSync(stopPaths.runtimeDir, { recursive: true });
    writeFileSync(stopPaths.pidFile, `${process.pid}\n`);
    const ownership = publishSparkDaemonProcessOwnership(stopPaths, {
      pid: process.pid,
      instanceId: "owned-instance",
      generation: "owned-generation",
    });
    const kill = vi.fn();
    try {
      expect(
        stopSparkDaemonPidFileProcess(stopPaths, {
          readProcessStartToken: () => "reused-process-token",
          kill,
        }),
      ).toBeNull();
      expect(kill).not.toHaveBeenCalled();

      expect(
        stopSparkDaemonPidFileProcess(stopPaths, {
          readProcessStartToken: () => ownership.processStartToken,
          kill,
        }),
      ).toMatchObject({ kind: "detached" });
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");

      clearSparkDaemonProcessOwnership(stopPaths, {
        pid: process.pid,
        instanceId: "owned-instance",
        generation: "owned-generation",
      });
      writeFileSync(stopPaths.pidFile, `${process.pid}\n`);
      kill.mockClear();
      expect(stopSparkDaemonPidFileProcess(stopPaths, { kill })).toBeNull();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps exact process ownership published through daemon lock release", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-ownership-release-"));
    const ownershipPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run") },
    });
    mkdirSync(ownershipPaths.runtimeDir, { recursive: true });
    writeFileSync(ownershipPaths.pidFile, `${process.pid}\n`);
    const identity = {
      pid: process.pid,
      instanceId: "old-instance",
      generation: "old-generation",
    };
    publishSparkDaemonProcessOwnership(ownershipPaths, identity);
    let lockReleased = false;
    try {
      await releaseSparkDaemonProcessOwnership(ownershipPaths, identity, async () => {
        expect(existsSync(ownershipPaths.pidFile)).toBe(true);
        expect(readSparkDaemonProcessOwnership(ownershipPaths)).toMatchObject(identity);
        lockReleased = true;
      });

      expect(lockReleased).toBe(true);
      expect(existsSync(ownershipPaths.pidFile)).toBe(false);
      expect(readSparkDaemonProcessOwnership(ownershipPaths)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cannot clear successor ownership published immediately after lock release", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-ownership-successor-"));
    const ownershipPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run") },
    });
    mkdirSync(ownershipPaths.runtimeDir, { recursive: true });
    writeFileSync(ownershipPaths.pidFile, `${process.pid}\n`);
    const predecessor = {
      pid: process.pid,
      instanceId: "predecessor-instance",
      generation: "predecessor-generation",
    };
    const successor = {
      pid: process.pid,
      instanceId: "successor-instance",
      generation: "successor-generation",
    };
    publishSparkDaemonProcessOwnership(ownershipPaths, predecessor);
    try {
      await releaseSparkDaemonProcessOwnership(ownershipPaths, predecessor, async () => {
        publishSparkDaemonProcessOwnership(ownershipPaths, successor);
      });

      expect(existsSync(ownershipPaths.pidFile)).toBe(true);
      expect(readSparkDaemonProcessOwnership(ownershipPaths)).toMatchObject(successor);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes launchd keepalive as restart-on-failure instead of an unconditional loop", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-launchd-plist-"));
    const launchdPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run"), stateDir: join(root, "state") },
    });
    try {
      const plist = readFileSync(
        writeSparkDaemonLaunchdPlist(launchdPaths, { home: root }),
        "utf8",
      );
      expect(plist).toContain(
        "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>",
      );
      expect(plist).not.toContain("<key>KeepAlive</key>\n  <true/>");
      expect(plist).toContain("<string>__service-start</string>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins launchd to the version-independent managed launcher", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-stable-launcher-"));
    const launchdPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run"), stateDir: join(root, "state") },
    });
    const previousLauncher = process.env.SPARK_STABLE_LAUNCHER;
    const previousWatchPath = process.env.SPARK_DEPLOYMENT_WATCH_PATH;
    process.env.SPARK_STABLE_LAUNCHER = join(root, ".local", "bin", "spark");
    process.env.SPARK_DEPLOYMENT_WATCH_PATH = join(root, "versions", "current", "build-info.json");
    try {
      const plist = readFileSync(
        writeSparkDaemonLaunchdPlist(launchdPaths, { home: root }),
        "utf8",
      );
      expect(plist).toContain(`<string>${process.env.SPARK_STABLE_LAUNCHER}</string>`);
      expect(plist).toContain("<string>daemon</string>");
      expect(plist).toContain("<string>__service-start</string>");
      expect(plist).toContain("<key>SPARK_DEPLOYMENT_WATCH_PATH</key>");
    } finally {
      if (previousLauncher === undefined) delete process.env.SPARK_STABLE_LAUNCHER;
      else process.env.SPARK_STABLE_LAUNCHER = previousLauncher;
      if (previousWatchPath === undefined) delete process.env.SPARK_DEPLOYMENT_WATCH_PATH;
      else process.env.SPARK_DEPLOYMENT_WATCH_PATH = previousWatchPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails stop when launchd still reports the label after bootout", () => {
    const run = vi.fn((args: string[]) => ({
      status: args[0] === "print" ? 0 : 1,
      stdout: "",
      stderr: args[0] === "bootout" ? "permission denied" : "",
    }));

    expect(() => stopSparkDaemonLaunchdLabel({ uid: 501, run })).toThrow(
      "launchd label remains registered",
    );
    expect(run).toHaveBeenNthCalledWith(1, ["bootout", "gui/501/dev.spark.daemon"]);
    expect(run).toHaveBeenNthCalledWith(2, ["print", "gui/501/dev.spark.daemon"]);
  });

  it("distinguishes an already absent launchd label from a successful bootout", () => {
    const absent = stopSparkDaemonLaunchdLabel({
      uid: 501,
      run: () => ({ status: 1, stdout: "", stderr: "not found" }),
    });
    expect(absent.detail).toContain("was not registered");

    let call = 0;
    const stopped = stopSparkDaemonLaunchdLabel({
      uid: 501,
      run: () => ({ status: call++ === 0 ? 0 : 1, stdout: "", stderr: "" }),
    });
    expect(stopped.detail).toContain("Stopped Spark daemon");
  });

  it("isolates terminal tombstones and cancellation by restart id", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-service-terminal-generation-"));
    const generationPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run") },
    });
    mkdirSync(generationPaths.runtimeDir, { recursive: true });
    const record = {
      state: "cancelled",
      restartId: "restart-old",
      previousPid: 101,
      previousInstanceId: "old-instance",
      previousGeneration: "old-generation",
      previousStartedAt: "2026-07-15T00:00:00.000Z",
      previousProcessStartToken: "test:old",
      targetInstanceId: "old-target-instance",
      targetGeneration: "old-target-generation",
      protocolVersion: 1,
      requestedAt: "2026-07-15T00:01:00.000Z",
    };
    writeFileSync(
      join(generationPaths.runtimeDir, "restart.terminal.restart-old.json"),
      JSON.stringify(record),
    );
    writeFileSync(
      join(generationPaths.runtimeDir, "restart.intent.json"),
      JSON.stringify({
        ...record,
        state: "armed",
        restartId: "restart-new",
        previousPid: 202,
        previousInstanceId: "new-instance",
        previousGeneration: "new-generation",
        previousProcessStartToken: "test:new",
        targetInstanceId: "new-target-instance",
        targetGeneration: "new-target-generation",
        requestedAt: "2026-07-15T00:02:00.000Z",
      }),
    );
    try {
      expect(
        cancelSparkDaemonRestartSuccessor(generationPaths, {
          previousPid: 101,
          restartId: "restart-old",
        }),
      ).toBe(true);
      expect(isSparkDaemonRestartArmed(generationPaths, 202, "restart-new")).toBe(true);

      expect(cancelSparkDaemonRestartSuccessor(generationPaths)).toBe(true);
      expect(prepareSparkDaemonRestartAwareStart(generationPaths, "restart-new")).toEqual({
        start: false,
        reason: "cancelled",
      });
      const terminals = readdirSync(generationPaths.runtimeDir).filter((name) =>
        name.startsWith("restart.terminal."),
      );
      expect(terminals).toContain("restart.terminal.restart-old.json");
      expect(terminals).toContain("restart.terminal.restart-new.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("suppresses stale active restart files once the exact terminal fence exists", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-restart-projection-fence-"));
    const fencedPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { runtimeDir: join(root, "run") },
    });
    mkdirSync(fencedPaths.runtimeDir, { recursive: true });
    const record = {
      restartId: "restart-completed",
      previousPid: 101,
      previousInstanceId: "old-instance",
      previousGeneration: "old-generation",
      previousStartedAt: "2026-07-17T00:00:00.000Z",
      previousProcessStartToken: "test:old",
      targetInstanceId: "new-instance",
      targetGeneration: "new-generation",
      protocolVersion: 1,
      requestedAt: "2026-07-17T00:01:00.000Z",
    };
    writeFileSync(
      join(fencedPaths.runtimeDir, "restart.intent.json"),
      JSON.stringify({ ...record, state: "armed" }),
    );
    writeFileSync(
      join(fencedPaths.runtimeDir, "restart.terminal.restart-completed.json"),
      JSON.stringify({ ...record, state: "completed" }),
    );
    try {
      expect(readSparkDaemonActiveRestart(fencedPaths)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
