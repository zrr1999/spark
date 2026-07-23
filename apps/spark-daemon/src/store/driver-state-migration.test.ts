import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  sessionGoalStorePathV2,
  sessionLoopStorePathV2,
  sessionStateStorePath,
} from "@zendev-lab/spark-loop";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";
import { migrateLegacyDriverState } from "./driver-state-migration.ts";
import { SparkDriverStore } from "./drivers.ts";
import { SparkInvocationStore } from "./invocations.ts";
import { migrateSparkDaemonDatabase } from "./schema.ts";

describe("legacy autonomous driver migration", () => {
  it("imports legacy cadence once, strips frontend runtime fields, and repairs a missing wake", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "spark-driver-migration-"));
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const drivers = new SparkDriverStore(db, new SparkInvocationStore(db));
    const session = localSession("session-migrate", cwd);
    const ctx = { sessionId: session.sessionId };
    const goalPath = sessionGoalStorePathV2(cwd, ctx);
    const loopPath = sessionLoopStorePathV2(cwd, ctx);
    const statePath = sessionStateStorePath(cwd, ctx);
    writeJson(goalPath, {
      version: 1,
      goal: {
        version: 1,
        goalId: "goal-migrate",
        sessionKey: "session:session-migrate",
        originalObjective: "Ship it",
        objective: "Ship it",
        status: "active",
        source: "explicit",
        retryState: {
          consecutiveFailures: 1,
          lastFailureAt: "2026-07-23T00:00:00.000Z",
          nextDelayMs: 60_000,
        },
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-23T00:00:00.000Z",
      },
    });
    writeJson(loopPath, {
      version: 1,
      loop: {
        version: 1,
        loopId: "loop-migrate",
        sessionKey: "session:session-migrate",
        objective: "Observe it",
        status: "active",
        source: "explicit",
        schedule: {
          nextRunAt: "2026-07-23T00:00:30.000Z",
          delayMs: 30_000,
          scheduledAt: "2026-07-23T00:00:00.000Z",
        },
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-23T00:00:00.000Z",
      },
    });
    writeJson(statePath, { version: 1, phase: "implement" });

    try {
      const report = await migrateLegacyDriverState({
        db,
        driverStore: drivers,
        sessionRegistry: { list: async () => [session] },
        now: "2026-07-23T00:00:10.000Z",
      });
      expect(report).toMatchObject({
        imported: { goal: 1, loop: 1, implement: 1 },
        strippedLegacyRuntimeFields: 2,
      });
      expect(drivers.require("goal-migrate")).toMatchObject({
        status: "retry_wait",
        attempt: 1,
        dueAt: "2026-07-23T00:01:00.000Z",
      });
      expect(drivers.require("loop-migrate").status).toBe("stopped");
      expect(drivers.require("implement:session-migrate").status).toBe("stopped");
      expect(readJson(goalPath).goal).not.toHaveProperty("retryState");
      expect(readJson(loopPath).loop).not.toHaveProperty("schedule");

      db.prepare("DELETE FROM driver_wakeups WHERE driver_id = ?").run("goal-migrate");
      await expect(
        migrateLegacyDriverState({
          db,
          driverStore: drivers,
          sessionRegistry: { list: async () => [session] },
          now: "2026-07-23T01:00:00.000Z",
        }),
      ).resolves.toBeUndefined();
      expect(drivers.require("goal-migrate").status).toBe("scheduled");
    } finally {
      db.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function localSession(sessionId: string, cwd: string): SparkSessionRegistryRecord {
  return {
    sessionId,
    status: "ready",
    cwd,
    scope: { kind: "workspace", workspaceId: "workspace-one" },
    workspaceId: "workspace-one",
    bindings: [],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
