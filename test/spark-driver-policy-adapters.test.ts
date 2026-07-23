import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { ProjectRef } from "@zendev-lab/spark-core";
import type { SparkDriverStartRequest } from "@zendev-lab/spark-protocol";
import { sparkImplementDriverPolicy } from "@zendev-lab/spark-tasks";
import { defaultWorkflowRunStore, sparkWorkflowDriverPolicy } from "@zendev-lab/spark-workflows";
import type { SparkDaemonDriverControl } from "../packages/spark-extension/src/extension/spark-daemon-driver-client.ts";
import { SparkWorkflowRunManagerController } from "../packages/spark-extension/src/extension/spark-workflow-run-manager.ts";
import { registerSparkWorkflowDriverTool } from "../packages/spark-extension/src/extension/spark-workflow-driver-tool-registration.ts";
import type {
  SparkRegisteredToolConfig,
  SparkToolContext,
} from "../packages/spark-extension/src/extension/spark-tool-registration.ts";

test("implement and workflow require an explicit successful-tick continuation decision", () => {
  assert.deepEqual(sparkImplementDriverPolicy.success, { status: "dormant" });
  assert.deepEqual(sparkWorkflowDriverPolicy.success, { status: "dormant" });
});

test("workflow driver schedules one second only while manager work remains", async () => {
  const scheduled: unknown[] = [];
  const stopped: unknown[] = [];
  const tool = workflowDriverTool(true);
  const ctx = workflowContext(scheduled, stopped);

  const result = await tool.execute(
    "workflow-tick",
    { action: "tick" },
    new AbortController().signal,
    () => undefined,
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.deepEqual(scheduled, [
    { delayMs: 1_000, reason: "workflow still has active or detached work" },
  ]);
  assert.deepEqual(stopped, []);
});

test("workflow driver stops when the manager reaches idle or terminal state", async () => {
  const scheduled: unknown[] = [];
  const stopped: unknown[] = [];
  const tool = workflowDriverTool(false);

  await tool.execute(
    "workflow-tick",
    { action: "tick" },
    new AbortController().signal,
    () => undefined,
    workflowContext(scheduled, stopped),
  );

  assert.deepEqual(scheduled, []);
  assert.deepEqual(stopped, [{ reason: "workflow reached a terminal or idle state" }]);
});

test("workflow manager starts a daemon driver only for a running control record", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-workflow-driver-control-"));
  const starts: SparkDriverStartRequest[] = [];
  try {
    await mkdir(join(cwd, ".spark"));
    const manager = new SparkWorkflowRunManagerController({
      refreshSparkWidget: async () => undefined,
      driverControl: recordingDriverControl(starts),
    });
    const ctx: SparkToolContext = { cwd, sessionId: "owner-session" };

    await manager.ensure(cwd, ctx);
    assert.equal(starts.length, 0);

    await defaultWorkflowRunStore(cwd).setControl({
      projectRef: "project:workflow" as ProjectRef,
      status: "running",
      policy: { maxConcurrency: 2, timeoutMs: 60_000 },
    });
    await manager.ensure(cwd, ctx);
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.kind, "workflow");
    assert.equal(starts[0]?.ownerSessionId, "owner-session");
    assert.match(starts[0]?.driverId ?? "", /^workflow:/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function workflowDriverTool(continuePolling: boolean): SparkRegisteredToolConfig {
  let registered: SparkRegisteredToolConfig | undefined;
  registerSparkWorkflowDriverTool(
    (config) => {
      registered = config;
    },
    {
      workflowRunManager: {
        runOnce: async () => ({ continuePolling }),
      },
    },
  );
  assert.ok(registered);
  return registered;
}

function workflowContext(scheduled: unknown[], stopped: unknown[]): SparkToolContext {
  return {
    cwd: "/workspace",
    sessionId: "owner",
    driver: {
      driverId: "workflow",
      kind: "workflow",
      generation: 1,
      ownerSessionId: "owner",
      stateOwnerSessionId: "owner",
      schedule: async (input) => {
        scheduled.push(input);
      },
      stop: async (input) => {
        stopped.push(input);
      },
    },
  };
}

function recordingDriverControl(starts: SparkDriverStartRequest[]): SparkDaemonDriverControl {
  return {
    async start(input) {
      starts.push(input);
      const observedAt = new Date().toISOString();
      return {
        driver: {
          driverId: input.driverId ?? `driver:${starts.length}`,
          kind: input.kind,
          ownerSessionId: input.ownerSessionId,
          status: "scheduled",
          continuity: input.continuity,
          dueAt: input.dueAt ?? observedAt,
          attempt: 0,
          reason: input.reason,
        },
        observedAt,
      };
    },
    async list() {
      return { drivers: [], observedAt: new Date().toISOString() };
    },
    async stop() {
      throw new Error("unexpected driver.stop");
    },
    async restart() {
      throw new Error("unexpected driver.restart");
    },
    async wake() {
      throw new Error("unexpected driver.wake");
    },
    async schedule() {
      throw new Error("unexpected driver.schedule");
    },
  };
}
