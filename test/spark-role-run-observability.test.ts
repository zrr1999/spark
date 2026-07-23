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
import type { ActiveSparkRoleRunProcess } from "@zendev-lab/spark-runtime";
import {
  buildSparkRoleRunRegistry,
  findSparkRoleRunRegistryEntry,
  serializeSparkRoleRunRegistry,
} from "../packages/spark-extension/src/extension/spark-role-run-observability.ts";

const projectRef = "proj:observability" as ProjectRef;
const taskRef = "task:role-run" as TaskRef;
const roleRef = "role:builtin-research" as RoleRef;

function graphWithRuns(runs: TaskRun[]): TaskGraph {
  const now = "2026-06-17T00:00:00.000Z";
  const project: Project = {
    ref: projectRef,
    title: "observability",
    description: "observe role runs",
    roadmap: {
      ref: "roadmap:observability",
      title: "observability",
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
    name: "role-run",
    title: "role run",
    description: "run a role",
    kind: "implement",
    status: "running",
    roleRef,
    supersededBy: [],
    inputArtifacts: [],
    outputArtifacts: [],
    createdAt: now,
    updatedAt: now,
  };
  return TaskGraph.fromSnapshot({ projects: [project], tasks: [task], dependencies: [], runs });
}

function taskRun(input: Partial<TaskRun> & { ref: RunRef }): TaskRun {
  const { ref, ...overrides } = input;
  return {
    ref,
    projectRef,
    taskRef,
    roleRef,
    runName: "research-1",
    ownerSessionId: "session:test",
    status: "running",
    startedAt: "2026-06-17T00:00:01.000Z",
    outputArtifacts: [],
    ...overrides,
  };
}

test("Spark role-run registry reconstructs ordered lifecycle events from task runs", () => {
  const run = taskRun({
    ref: "run:finished" as RunRef,
    status: "succeeded",
    finishedAt: "2026-06-17T00:00:05.000Z",
    outputArtifacts: ["artifact:trace"],
  });
  const snapshot = buildSparkRoleRunRegistry({ graph: graphWithRuns([run]) });
  const entry = findSparkRoleRunRegistryEntry(snapshot, run.ref);

  assert.equal(entry?.status, "done");
  assert.equal(entry?.activeProcess, false);
  assert.deepEqual(
    entry?.events.map((event) => event.type),
    ["started", "completed"],
  );
  assert.deepEqual(
    entry?.events.map((event) => event.status),
    ["running", "done"],
  );
  assert.deepEqual(entry?.events.at(-1)?.artifactRefs, ["artifact:trace"]);
  assert.equal(entry?.events.at(-1)?.provenance.source, "task-graph");
  assert.equal(snapshot.counts.done, 1);
});

test("Spark role-run registry serialization is reload-safe JSON data", () => {
  const run = taskRun({
    ref: "run:failed" as RunRef,
    status: "failed",
    finishedAt: "2026-06-17T00:00:09.000Z",
    failureKind: "runtime_error",
    errorMessage: "boom",
  });
  const snapshot = buildSparkRoleRunRegistry({
    graph: graphWithRuns([run]),
    now: "2026-06-17T00:01:00.000Z",
  });
  const serialized = serializeSparkRoleRunRegistry(snapshot);

  assert.deepEqual(JSON.parse(JSON.stringify(serialized)), serialized);
  const entry = serialized.entries[0];
  assert.equal(entry.status, "failed");
  assert.equal(entry.events.at(-1)?.failureKind, "runtime_error");
  assert.equal(entry.events.at(-1)?.message, "boom");
  entry.events[0].provenance.source = "recovery";
  assert.equal(snapshot.entries[0].events[0].provenance.source, "task-graph");
});

test("Spark role-run protocol carries parent links, usage, activity, and stopped events", () => {
  const run = taskRun({
    ref: "run:child" as RunRef,
    status: "cancelled",
    finishedAt: "2026-06-17T00:00:12.000Z",
    outputArtifacts: ["artifact:trace"],
  });
  const snapshot = buildSparkRoleRunRegistry({
    graph: graphWithRuns([run]),
    parentChildLinks: [{ parentRunRef: "run:workflow" as RunRef, childRunRef: run.ref }],
    usageByRunRef: {
      [run.ref]: { model: "test-model", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
    activityEvents: [
      {
        runRef: run.ref,
        type: "message_activity",
        at: "2026-06-17T00:00:02.000Z",
        messageRole: "assistant",
        message: "thinking",
      },
      {
        runRef: run.ref,
        type: "tool_activity",
        at: "2026-06-17T00:00:03.000Z",
        toolName: "artifact.record",
      },
      {
        runRef: run.ref,
        type: "waiting_for_user",
        at: "2026-06-17T00:00:04.000Z",
        message: "needs decision",
      },
      {
        runRef: run.ref,
        type: "replied",
        at: "2026-06-17T00:00:05.000Z",
        messageRole: "user",
      },
    ],
  });
  const entry = findSparkRoleRunRegistryEntry(snapshot, run.ref);

  assert.deepEqual(entry?.parentRunRefs, ["run:workflow"]);
  assert.deepEqual(entry?.childRunRefs, []);
  assert.deepEqual(entry?.usage, {
    model: "test-model",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
  assert.deepEqual(
    entry?.events.map((event) => event.type),
    ["started", "message_activity", "tool_activity", "waiting_for_user", "replied", "stopped"],
  );
  assert.equal(entry?.events[1].provenance.parentRunRefs?.[0], "run:workflow");
  assert.equal(entry?.events[2].toolName, "artifact.record");
  assert.equal(entry?.status, "cancelled");
});

test("Spark role-run registry distinguishes active, interrupted, and stale non-terminal runs", () => {
  const active = taskRun({ ref: "run:active" as RunRef });
  const interrupted = taskRun({
    ref: "run:interrupted" as RunRef,
    startedAt: "2026-06-17T00:00:20.000Z",
  });
  const stale = taskRun({
    ref: "run:stale" as RunRef,
    startedAt: "2026-06-17T00:00:00.000Z",
  });
  const queued = taskRun({
    ref: "run:queued" as RunRef,
    status: "queued",
    startedAt: undefined,
  });
  const activeProcesses: ActiveSparkRoleRunProcess[] = [
    {
      runRef: active.ref,
      roleRef,
      runName: active.runName,
      cwd: "/tmp/spark",
      pid: 123,
      startedAt: active.startedAt ?? "2026-06-17T00:00:01.000Z",
      inputControl: "stdin",
    },
  ];
  const snapshot = buildSparkRoleRunRegistry({
    graph: graphWithRuns([active, interrupted, stale, queued]),
    activeProcesses,
    now: "2026-06-17T00:00:30.000Z",
    staleAfterMs: 20_000,
  });

  assert.equal(findSparkRoleRunRegistryEntry(snapshot, active.ref)?.status, "running");
  assert.equal(findSparkRoleRunRegistryEntry(snapshot, active.ref)?.activeProcess, true);
  assert.equal(findSparkRoleRunRegistryEntry(snapshot, active.ref)?.pid, 123);

  const interruptedEntry = findSparkRoleRunRegistryEntry(snapshot, interrupted.ref);
  assert.equal(interruptedEntry?.status, "interrupted");
  assert.equal(interruptedEntry?.recoveryKind, "interrupted_without_process");
  assert.equal(interruptedEntry?.events.at(-1)?.type, "interrupted");

  const staleEntry = findSparkRoleRunRegistryEntry(snapshot, stale.ref);
  assert.equal(staleEntry?.status, "stale");
  assert.equal(staleEntry?.recoveryKind, "stale_without_process");
  assert.equal(staleEntry?.events.at(-1)?.type, "recovered_stale");

  const queuedEntry = findSparkRoleRunRegistryEntry(snapshot, queued.ref);
  assert.equal(queuedEntry?.status, "waiting");
  assert.deepEqual(
    queuedEntry?.events.map((event) => event.type),
    ["queued", "waiting"],
  );
  assert.equal(snapshot.counts.running, 1);
  assert.equal(snapshot.counts.interrupted, 1);
  assert.equal(snapshot.counts.stale, 1);
  assert.equal(snapshot.counts.waiting, 1);
});
