import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { defaultTaskTodoStore } from "@zendev-lab/spark-tasks";
import { describe, expect, it } from "vitest";
import type { SparkDaemonDriverTickTask } from "./core/types.ts";
import { reconcileIdleSessionTodos, sessionTodoStateDigest } from "./session-todo-auto-runner.ts";
import { SparkDriverStore } from "./store/drivers.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";

describe("daemon session TODO drivers", () => {
  it("creates one fallback wake and becomes dormant without progress", async () => {
    const harness = createHarness();
    const session = localSession("sess_todo", harness.cwd);
    const todos = [
      { id: "todo-a", content: "Implement the fix", status: "in_progress" as const },
      { id: "todo-b", content: "Verify it", status: "pending" as const },
    ];
    await saveTodos(harness.cwd, session.sessionId, todos);
    const sessionRegistry = { list: async () => [session] };

    try {
      await expect(
        reconcileIdleSessionTodos({ driverStore: harness.drivers, sessionRegistry }),
      ).resolves.toEqual({ examined: 1, submitted: 1, errors: [] });
      const driver = harness.drivers.get(`session-todo:${session.sessionId}`);
      expect(driver).toMatchObject({
        kind: "session_todo",
        lane: "fallback",
        status: "scheduled",
        domainStateDigest: sessionTodoStateDigest(session.sessionId, todos),
      });
      expect(driver?.prompt).toContain("[in_progress] Implement the fix");

      const invocation = harness.drivers.materializeDue();
      const running = harness.invocations.claimNext("worker");
      expect(running?.invocationId).toBe(invocation?.invocationId);
      harness.drivers.completeTick(running!, running!.task as SparkDaemonDriverTickTask, {
        status: "succeeded",
      });
      expect(harness.drivers.get(driver!.driverId)?.status).toBe("dormant");

      await expect(
        reconcileIdleSessionTodos({ driverStore: harness.drivers, sessionRegistry }),
      ).resolves.toEqual({ examined: 1, submitted: 0, errors: [] });
      expect(harness.invocations.listPage({ sessionId: session.sessionId }).total).toBe(1);
    } finally {
      harness.close();
    }
  });

  it("rearms only after the TODO digest changes and yields to an explicit driver", async () => {
    const harness = createHarness();
    const session = localSession("sess_progress", harness.cwd);
    const sessionRegistry = { list: async () => [session] };
    await saveTodos(harness.cwd, session.sessionId, [
      { id: "todo-a", content: "First", status: "in_progress" },
    ]);

    try {
      await reconcileIdleSessionTodos({ driverStore: harness.drivers, sessionRegistry });
      const first = harness.drivers.require(`session-todo:${session.sessionId}`);
      harness.drivers.stop(first.driverId, "test settled");
      await saveTodos(harness.cwd, session.sessionId, [
        { id: "todo-a", content: "First", status: "done" },
        { id: "todo-b", content: "Second", status: "in_progress" },
      ]);
      await reconcileIdleSessionTodos({ driverStore: harness.drivers, sessionRegistry });
      expect(harness.drivers.require(first.driverId)).toMatchObject({
        status: "scheduled",
      });

      harness.drivers.start({
        driverId: "goal-explicit",
        kind: "goal",
        ownerSessionId: session.sessionId,
        cwd: harness.cwd,
        prompt: "goal",
      });
      await reconcileIdleSessionTodos({ driverStore: harness.drivers, sessionRegistry });
      expect(harness.drivers.require(first.driverId).status).toBe("stopped");

      harness.drivers.materializeDue();
      const goalInvocation = harness.invocations.claimNext("goal-worker")!;
      harness.drivers.completeTick(
        goalInvocation,
        goalInvocation.task as SparkDaemonDriverTickTask,
        {
          status: "cancelled",
          cancelReason: "manual abort",
        },
      );
      expect(harness.drivers.require("goal-explicit").status).toBe("blocked");
      await saveTodos(harness.cwd, session.sessionId, [
        { id: "todo-a", content: "First", status: "done" },
        { id: "todo-b", content: "Second", status: "done" },
        { id: "todo-c", content: "Third", status: "in_progress" },
      ]);
      await reconcileIdleSessionTodos({ driverStore: harness.drivers, sessionRegistry });
      expect(harness.drivers.require(first.driverId).status).toBe("stopped");
    } finally {
      harness.close();
    }
  });
});

function createHarness() {
  const cwd = mkdtempSync(join(tmpdir(), "spark-session-todo-driver-"));
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  const invocations = new SparkInvocationStore(db);
  return {
    cwd,
    db,
    invocations,
    drivers: new SparkDriverStore(db, invocations),
    close() {
      db.close();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

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

async function saveTodos(
  cwd: string,
  sessionId: string,
  todos: Array<{
    id: string;
    content: string;
    status: "pending" | "in_progress" | "done";
  }>,
): Promise<void> {
  const ownerRef = sessionId.startsWith("session:") ? sessionId : `session:${sessionId}`;
  await defaultTaskTodoStore(cwd).saveSessionTodos(ownerRef, todos);
}
