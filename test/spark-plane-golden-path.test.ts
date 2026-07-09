import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskGraph } from "@zendev-lab/spark-tasks";

import { handleSparkServerCliCommand } from "../apps/spark-tui/src/cli/server.ts";
import { sparkTuiCliStrings } from "../packages/spark-i18n/src/cli.ts";
import {
  evaluateDaemonStabilityChecks,
  extractDaemonStatusContract,
  extractServerStatusContract,
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

void test("daemon/server/tui golden path stays contract-focused and credential-free", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "spark-plane-golden-"));
  try {
    const daemonBefore = daemonStatus(workspace, { inbox: 0, processed: 4, failed: 0 });
    const daemonAfter = daemonStatus(workspace, { inbox: 0, processed: 5, failed: 0 });
    const daemon = extractDaemonStatusContract(daemonAfter);
    assert.equal(daemon.running, true);
    assert.deepEqual(daemon.queue, { inbox: 0, processed: 5, failed: 0 });
    assert.equal(daemon.workspaceCount, 1);
    assert.equal(daemon.websocketState, "connected");
    assert.deepEqual(daemon.diagnostics, []);

    const stability = evaluateDaemonStabilityChecks(daemonBefore, daemonAfter);
    assert.deepEqual(stability, {
      daemonRunningBefore: true,
      daemonRunningAfter: true,
      runtimeStable: true,
      workspaceCountStable: true,
      queueCountersMonotonic: true,
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

    const server = await handleSparkServerCliCommand(
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
    assert.equal(server.action, "status");
    const serverContract = extractServerStatusContract({ action: "status", result: server.result });
    assert.deepEqual(serverContract.diagnostics, []);
    assert.equal(server.result.plane, "server");
    assert.equal(server.result.resource, "status");
    assert.equal(server.result.currentProjectRef, project.ref);
    assert.equal(server.result.readyTasks[0]?.taskRef, ready.ref);
    assert.deepEqual(server.result.scope, {
      selectedWorkspace: workspace,
      selectedSessionKey: "session:golden",
      selectedProjectRef: project.ref,
      goalSource: "current-project",
    });

    const tuiHelp = sparkTuiCliStrings().helpText;
    assert.match(tuiHelp, /spark daemon\s+daemon execution plane/u);
    assert.match(tuiHelp, /spark server\s+server coordination plane/u);
    assert.match(tuiHelp, /spark tui\s+tui local control plane/u);
    assert.doesNotMatch(tuiHelp, /task claim/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function daemonStatus(
  workspace: string,
  queue: { inbox: number; processed: number; failed: number },
): unknown {
  return {
    action: "status",
    daemon: {
      running: true,
      pid: 4242,
      socketPath: join(workspace, "daemon.sock"),
      startedAt: "2030-01-01T00:00:00.000Z",
      queue,
      servers: [{ url: "http://127.0.0.1:5173/", workspaceCount: 1, wsConnected: true }],
    },
  };
}
