import assert from "node:assert/strict";
import { test } from "vitest";

import type {
  Project,
  ProjectRef,
  RoleRef,
  RunRef,
  Task,
  TaskRef,
  TaskRun,
} from "@zendev-lab/spark-core";
import { TaskGraph } from "@zendev-lab/spark-tasks";

import { buildSparkRoleRunRegistry } from "../packages/pi-extension/src/extension/spark-role-run-observability.ts";
import { roleRunTaskInfoByRefForTests } from "../packages/pi-extension/src/extension/spark-role-run-tui-controller.ts";
import {
  formatSparkRoleRunStatusSummary,
  renderSparkRoleRunBoardLines,
} from "../packages/pi-extension/src/ui/spark-role-run-tui.ts";

const projectRef = "proj:terminal-role-tui" as ProjectRef;
const taskRef = "task:terminal-role-tui" as TaskRef;
const roleRef = "role:builtin-worker" as RoleRef;

function graphWithRun(run: TaskRun): TaskGraph {
  const now = "2026-06-17T00:00:00.000Z";
  const project: Project = {
    ref: projectRef,
    title: "Terminal role TUI project",
    description: "terminal role tui",
    roadmap: {
      ref: "roadmap:terminal-role-tui",
      title: "Terminal role TUI project",
      items: [],
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
  const task: Task = {
    ref: taskRef,
    projectRef,
    name: "terminal-role-tui-task",
    title: "Render terminal role runs",
    description: "render terminal role runs",
    kind: "implement",
    status: "running",
    roleRef,
    supersededBy: [],
    inputArtifacts: [],
    outputArtifacts: [],
    createdAt: now,
    updatedAt: now,
  };
  return TaskGraph.fromSnapshot({
    projects: [project],
    tasks: [task],
    dependencies: [],
    runs: [run],
  });
}

test("Spark role-run TUI ages failed and cancelled runs out of the active board", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const run: TaskRun = {
      ref: `run:${status === "failed" ? "ffffffff" : "eeeeeeee"}66666666` as RunRef,
      projectRef,
      taskRef,
      roleRef,
      runName: "worker-terminal",
      ownerSessionId: "session:test",
      status,
      startedAt: "2026-06-17T00:00:01.000Z",
      finishedAt: "2026-06-17T00:00:02.000Z",
      outputArtifacts: [],
      errorMessage: status === "failed" ? "historical loader failure" : undefined,
    };
    const snapshot = buildSparkRoleRunRegistry({
      graph: graphWithRun(run),
      now: "2026-06-17T00:30:00.000Z",
    });

    assert.equal(formatSparkRoleRunStatusSummary(snapshot), undefined);
    assert.deepEqual(
      renderSparkRoleRunBoardLines(
        snapshot,
        roleRunTaskInfoByRefForTests([{ ref: taskRef, name: "terminal-role-tui-task" }]),
        { width: 100, now: snapshot.generatedAt },
      ),
      [],
    );
    assert.equal(snapshot.entries[0]?.status, status);
  }
});
