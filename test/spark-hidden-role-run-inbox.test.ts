import assert from "node:assert/strict";
import { test } from "vitest";

import type { TaskRun, TaskRunCompletionSummary } from "../packages/spark-core/src/index.ts";
import { projectHiddenRoleRunInboxEntry } from "../packages/spark-extension/src/extension/role-run-completions.ts";

const now = "2026-07-07T12:00:00.000Z";
const recentCutoffMs = Date.parse("2026-07-01T00:00:00.000Z");

function summary(status: TaskRunCompletionSummary["status"]): TaskRunCompletionSummary {
  return {
    runRef: "run:14d81710-fce7-4c1a-a261-b9d598b32043",
    taskRef: "task:historical",
    roleRef: "role:builtin-worker",
    runName: "worker-14d81710",
    status,
    summary: "role run finished with status failed",
    artifactRefs: ["artifact:ba6fa906-bf0a-4b21-acaa-77142a753451"],
    createdAt: now,
  };
}

function run(ownerSessionId = "session:current"): TaskRun {
  return {
    ref: "run:14d81710-fce7-4c1a-a261-b9d598b32043",
    projectRef: "proj:demo",
    taskRef: "task:historical",
    roleRef: "role:builtin-worker",
    runName: "worker-14d81710",
    ownerSessionId,
    status: "failed",
    startedAt: now,
    finishedAt: now,
    outputArtifacts: ["artifact:ba6fa906-bf0a-4b21-acaa-77142a753451"],
    completionSummary: summary("failed"),
  };
}

test("background inbox hides acknowledged superseded failures on workspace startup", () => {
  const projection = projectHiddenRoleRunInboxEntry({
    run: run(),
    summary: summary("failed"),
    taskStatus: "cancelled",
    workspaceHash: "workspace-current",
    sessionKey: "session:current",
    acknowledged: true,
    recentCutoffMs,
  });

  assert.equal(projection.workspaceHash, "workspace-current");
  assert.equal(projection.sessionKey, "session:current");
  assert.equal(projection.acknowledged, true);
  assert.equal(projection.historical, true);
  assert.equal(projection.actionable, false);
  assert.equal(projection.suppressedFromStartup, true);
});

test("background inbox still surfaces unacknowledged active failure for attached workspace session", () => {
  const projection = projectHiddenRoleRunInboxEntry({
    run: run(),
    summary: summary("failed"),
    taskStatus: "running",
    workspaceHash: "workspace-current",
    sessionKey: "session:current",
    acknowledged: false,
    recentCutoffMs,
  });

  assert.equal(projection.historical, false);
  assert.equal(projection.actionable, true);
  assert.equal(projection.suppressedFromStartup, false);
});

test("background inbox excludes different workspace session from startup projection", () => {
  const projection = projectHiddenRoleRunInboxEntry({
    run: run("session:different"),
    summary: summary("failed"),
    taskStatus: "running",
    workspaceHash: "workspace-current",
    sessionKey: "session:current",
    acknowledged: false,
    recentCutoffMs,
  });

  assert.equal(projection.actionable, false);
  assert.equal(projection.suppressedFromStartup, true);
});

test("run_status includeHistory preserves acknowledged historical failures", () => {
  const projection = projectHiddenRoleRunInboxEntry({
    run: run(),
    summary: summary("failed"),
    taskStatus: "cancelled",
    workspaceHash: "workspace-current",
    sessionKey: "session:current",
    acknowledged: true,
    recentCutoffMs,
  });

  assert.equal(projection.summary.runRef, "run:14d81710-fce7-4c1a-a261-b9d598b32043");
  assert.deepEqual(projection.summary.artifactRefs, [
    "artifact:ba6fa906-bf0a-4b21-acaa-77142a753451",
  ]);
  assert.equal(projection.taskStatus, "cancelled");
});
