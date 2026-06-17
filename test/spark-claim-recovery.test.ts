import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RoleRef, RunRef } from "@zendev-lab/pi-extension-api";
import { defaultArtifactStore } from "@zendev-lab/pi-artifacts";
import type { WorkflowRunStatusSummary } from "@zendev-lab/pi-workflows";
import type { ActiveSparkRoleRunProcess } from "@zendev-lab/spark-runtime";
import { TaskGraph } from "@zendev-lab/pi-tasks";
import { evaluateSparkTaskClaimRecovery } from "../packages/spark/src/extension/task-claim-recovery.ts";
import { sanitizeStoreScope } from "../packages/spark/src/extension/session-identity.ts";

const IDLE_WORKFLOW_STATUS: WorkflowRunStatusSummary = {
  manager: { status: "idle", updatedAt: "2026-06-17T00:00:00.000Z" },
  recentRuns: [],
  running: 0,
  succeeded: 0,
  failed: 0,
  stale: 0,
  timedOut: 0,
  acknowledged: 0,
  actionable: 0,
  nextSteps: [],
};

function plannedTaskGraph() {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Claim recovery", description: "Claim recovery" });
  const task = graph.createTask({
    projectRef: project.ref,
    name: "claimed-task",
    title: "Claimed task",
    description: "Claimed task",
    kind: "implement",
    status: "ready",
    plan: {
      objective: "Exercise claim recovery.",
      successCriteria: ["Decision is deterministic."],
      evidenceRequired: ["Unit assertion."],
      steps: ["Evaluate recovery."],
      constraints: ["Do not steal active work."],
      contextRefs: [],
      nonGoals: [],
      openQuestions: [],
      askRefs: [],
    },
  });
  return { graph, project, task };
}

void test("stale claim recovery refuses current-session claims", async () => {
  const { graph, project, task } = plannedTaskGraph();
  const currentSession = "session:current";
  const claimed = graph.claimTask(task.ref, {
    kind: "main",
    claimedBy: currentSession,
    sessionId: currentSession,
    now: "2026-06-17T00:00:00.000Z",
    leaseMs: 60_000,
  });

  const decision = await evaluateSparkTaskClaimRecovery({
    cwd: process.cwd(),
    task: claimed,
    projectRef: project.ref,
    currentSessionKey: currentSession,
    workflowRunStatus: IDLE_WORKFLOW_STATUS,
    activeRoleRunProcesses: [],
    now: "2026-06-17T00:00:01.000Z",
  });

  assert.equal(decision.recoverable, false);
  assert.equal(decision.reason, "current_session_claim");
});

void test("stale claim recovery refuses while an active role-run process exists", async () => {
  const { graph, project, task } = plannedTaskGraph();
  const claimed = graph.claimTask(task.ref, {
    kind: "main",
    claimedBy: "session:owner",
    sessionId: "session:owner",
    now: "2026-01-01T00:00:00.000Z",
    leaseMs: 1_000,
  });
  const activeProcess: ActiveSparkRoleRunProcess = {
    runRef: "run:active" as RunRef,
    roleRef: "role:builtin-worker" as RoleRef,
    runName: "worker-active",
    cwd: process.cwd(),
    startedAt: "2026-06-17T00:00:00.000Z",
    pid: 12345,
  };

  const decision = await evaluateSparkTaskClaimRecovery({
    cwd: process.cwd(),
    task: claimed,
    projectRef: project.ref,
    currentSessionKey: "session:current",
    workflowRunStatus: IDLE_WORKFLOW_STATUS,
    activeRoleRunProcesses: [activeProcess],
    now: "2026-06-17T00:00:01.000Z",
  });

  assert.equal(decision.recoverable, false);
  assert.equal(decision.reason, "active_role_run_process");
  assert.deepEqual(decision.evidence.activeRoleRunRefs, ["run:active"]);
});

void test("stale claim recovery allows needs_changes recovery when owner is inactive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-recovery-owner-inactive-"));
  try {
    const { graph, project, task } = plannedTaskGraph();
    const claimed = graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: "session:owner",
      sessionId: "session:owner",
      now: "2026-06-17T00:00:00.000Z",
      leaseMs: 24 * 60 * 60 * 1_000,
    });
    await defaultArtifactStore(dir).put({
      kind: "record",
      title: "Task finish review for @claimed-task",
      format: "json",
      body: { verdict: { outcome: "needs_changes", summary: "Needs changes." } },
      provenance: { producer: "review", projectRef: project.ref, taskRef: task.ref },
    });

    const decision = await evaluateSparkTaskClaimRecovery({
      cwd: dir,
      task: claimed,
      projectRef: project.ref,
      currentSessionKey: "session:current",
      workflowRunStatus: IDLE_WORKFLOW_STATUS,
      activeRoleRunProcesses: [],
      now: "2026-06-17T00:00:01.000Z",
    });

    assert.equal(decision.recoverable, true);
    assert.equal(decision.reason, "review_needs_changes_owner_inactive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("stale claim recovery refuses when owner activity is newer than needs_changes review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-recovery-owner-recent-"));
  try {
    const { graph, project, task } = plannedTaskGraph();
    const claimed = graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: "session:owner",
      sessionId: "session:owner",
      now: "2026-06-17T00:00:00.000Z",
      leaseMs: 24 * 60 * 60 * 1_000,
    });
    await defaultArtifactStore(dir).put({
      kind: "record",
      title: "Task finish review for @claimed-task",
      format: "json",
      body: { verdict: { outcome: "needs_changes", summary: "Needs changes." } },
      provenance: { producer: "review", projectRef: project.ref, taskRef: task.ref },
    });
    await mkdir(join(dir, ".spark", "session-goals"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "session-goals", `${sanitizeStoreScope("session:owner")}.json`),
      `${JSON.stringify({ goal: { updatedAt: "2999-01-01T00:00:00.000Z" } }, null, 2)}\n`,
      "utf8",
    );

    const decision = await evaluateSparkTaskClaimRecovery({
      cwd: dir,
      task: claimed,
      projectRef: project.ref,
      currentSessionKey: "session:current",
      workflowRunStatus: IDLE_WORKFLOW_STATUS,
      activeRoleRunProcesses: [],
      now: "2026-06-17T00:00:01.000Z",
    });

    assert.equal(decision.recoverable, false);
    assert.equal(decision.reason, "owner_session_recent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
