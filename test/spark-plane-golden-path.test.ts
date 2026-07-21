import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { TaskGraph } from "@zendev-lab/spark-tasks";

import { handleSparkCockpitCliCommand } from "../apps/spark-cockpit/src/cli/coordination.ts";
import {
  evaluateDaemonStabilityChecks,
  extractDaemonStatusContract,
  extractCockpitStatusContract,
} from "../test/support/spark-plane-contracts.mts";

const PLAN = {
  objective: "Exercise the plane golden path.",
  successCriteria: ["Plane contracts expose stable ids and statuses."],
  evidenceRequired: ["Unit assertion output."],
  steps: ["Build deterministic fixtures."],
  constraints: ["Do not call model providers."],
  contextRefs: [],
  nonGoals: [],
  openQuestions: [],
  askRefs: [],
};

test("daemon/Cockpit/TUI golden path stays contract-focused and credential-free", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "spark-plane-golden-"));
  try {
    const daemonBefore = daemonStatus(workspace, {
      queued: 0,
      running: 0,
      succeeded: 4,
      failed: 0,
      cancelled: 0,
    });
    const daemonAfter = daemonStatus(workspace, {
      queued: 0,
      running: 0,
      succeeded: 5,
      failed: 0,
      cancelled: 0,
    });
    const daemon = extractDaemonStatusContract(daemonAfter);
    assert.equal(daemon.running, true);
    assert.deepEqual(daemon.invocations, {
      queued: 0,
      running: 0,
      succeeded: 5,
      failed: 0,
      cancelled: 0,
    });
    assert.equal(daemon.workspaceCount, 1);
    assert.equal(daemon.websocketState, "connected");
    assert.deepEqual(daemon.diagnostics, []);

    const stability = evaluateDaemonStabilityChecks(daemonBefore, daemonAfter);
    assert.deepEqual(stability, {
      daemonRunningBefore: true,
      daemonRunningAfter: true,
      runtimeStable: true,
      workspaceCountStable: true,
      invocationTerminalCountsMonotonic: true,
      mismatches: [],
    });

    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Golden path project", description: "Fixture" });
    const done = graph.createTask({
      projectRef: project.ref,
      name: "done",
      title: "Done dependency",
      description: "Done dependency",
      status: "done",
      kind: "implement",
      plan: PLAN,
    });
    const ready = graph.createTask({
      projectRef: project.ref,
      name: "ready",
      title: "Ready work",
      description: "Ready work",
      status: "ready",
      kind: "implement",
      plan: PLAN,
    });
    graph.addDependency(ready.ref, done.ref);

    const cockpit = await handleSparkCockpitCliCommand(
      { resource: "status", verb: "show", json: true },
      {
        cwd: workspace,
        graph,
        currentProjectRef: project.ref,
        currentSessionKey: "session:golden",
        goal: {
          status: "active",
          objective: "finish golden path",
          goalId: "goal:golden",
          sessionKey: "session:golden",
          projectRef: project.ref,
        },
        artifacts: [],
        reviews: [],
        workflows: [],
      },
    );
    assert.equal(cockpit.action, "status");
    const cockpitContract = extractCockpitStatusContract({
      action: "status",
      result: cockpit.result,
    });
    assert.deepEqual(cockpitContract.diagnostics, []);
    assert.equal(cockpit.result.plane, "cockpit");
    assert.equal(cockpit.result.resource, "status");
    assert.equal(cockpit.result.currentProjectRef, project.ref);
    assert.equal(cockpit.result.readyTasks[0]?.taskRef, ready.ref);
    assert.deepEqual(cockpit.result.scope, {
      selectedWorkspace: workspace,
      selectedSessionKey: "session:golden",
      selectedProjectRef: project.ref,
      goalSource: "current-project",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function daemonStatus(
  workspace: string,
  invocations: {
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
  },
): unknown {
  return {
    action: "status",
    daemon: {
      running: true,
      pid: 4242,
      socketPath: join(workspace, "daemon.sock"),
      startedAt: "2030-01-01T00:00:00.000Z",
      invocations,
      servers: [{ url: "http://127.0.0.1:5173/", workspaceCount: 1, wsConnected: true }],
    },
  };
}
