import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentRegistry, builtinAgentRef } from "spark-agents";
import { ArtifactStore } from "spark-artifacts";
import { newRef } from "spark-core";
import { runSparkTask, sweepExpiredTaskClaims } from "spark-runtime";
import { TaskGraph, TaskGraphStore, TaskTodoStore } from "spark-tasks";

void test("task graph store keeps TODOs out of thread.json and todo store restores them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tasks-"));
  try {
    const file = join(dir, "thread.json");
    const todoFile = join(dir, "todos.json");
    const store = new TaskGraphStore(file);
    const todoStore = new TaskTodoStore(todoFile);
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      threadRef: thread.ref,
      title: "Plan",
      description: "plan",
      agentRef: builtinAgentRef("planner"),
      todos: [{ content: "Read inputs" }, { content: "Draft plan" }],
    });
    await store.save(graph);
    await todoStore.save(graph);
    const loaded = await store.load();
    assert.ok(loaded);
    await todoStore.hydrate(loaded);
    assert.equal(loaded.threads()[0]?.title, "Demo");
    assert.equal(loaded.tasks(thread.ref).length, 1);
    assert.equal(loaded.currentTask(thread.ref), undefined);
    assert.equal(loaded.tasks(thread.ref)[0]?.title, "Plan");
    assert.equal(loaded.taskTodos(task.ref).length, 2);
    assert.equal(loaded.todoSummary(task.ref).inProgress, 1);
    assert.doesNotMatch(await readFile(file, "utf8"), /"todos"/);
    assert.match(await readFile(todoFile, "utf8"), /"Read inputs"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task metadata can be updated when a model claims concrete work", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    threadRef: thread.ref,
    title: "Initial",
    description: "initial",
    kind: "interaction",
    status: "running",
  });

  const updated = graph.updateTask(task.ref, {
    title: "Fix Spark prompt injection",
    description: "Inject SPARK.md as standing context.",
    kind: "implement",
  });

  assert.equal(updated.title, "Fix Spark prompt injection");
  assert.equal(updated.description, "Inject SPARK.md as standing context.");
  assert.equal(updated.kind, "implement");
  graph.setCurrentTask(thread.ref, updated.ref);
  assert.equal(graph.currentTask(thread.ref)?.ref, task.ref);
});

void test("todo ops can initialize an empty task and use stable ids", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    threadRef: thread.ref,
    title: "Plan",
    description: "plan",
    agentRef: builtinAgentRef("planner"),
  });

  graph.applyTodoOps(task.ref, [{ op: "init", items: ["Read inputs", "Draft plan"] }]);
  const [first, second] = graph.taskTodos(task.ref);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.taskRef, task.ref);
  assert.match(first.id, /^todo-/);

  graph.applyTodoOps(task.ref, [
    { op: "done", id: first.id },
    { op: "delete", id: second.id },
  ]);

  const summary = graph.todoSummary(task.ref);
  assert.equal(summary.done, 1);
  assert.equal(summary.deleted, 1);
  assert.equal(summary.total, 1);
});

void test("tasks have simple names and can be resolved in plans", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });

  const result = graph.planTasks(thread.ref, [
    {
      name: "inspect",
      title: "Inspect package boundaries",
      description: "Read package responsibilities.",
    },
    {
      name: "implement",
      title: "Implement runtime split",
      description: "Move runtime behavior out of agent registry.",
      dependsOn: ["inspect"],
    },
  ]);

  assert.equal(result.created[0]?.name, "inspect");
  assert.equal(result.created[1]?.name, "implement");
  assert.equal(result.dependencies[0]?.dependsOn, result.created[0]?.ref);
});

void test("task claims use a lease that can expire", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    threadRef: thread.ref,
    name: "lease-check",
    title: "Lease check",
    description: "Exercise task claim timeout behavior.",
  });

  const runRef = newRef("run");
  graph.recordRun({
    ref: runRef,
    threadRef: thread.ref,
    taskRef: task.ref,
    status: "running",
    startedAt: "2026-05-18T00:00:00.000Z",
    outputArtifacts: [],
  });
  const claimed = graph.claimTask(task.ref, {
    kind: "main",
    claimedBy: "session:a",
    sessionId: "session:a",
    runRef,
    now: "2026-05-18T00:00:00.000Z",
    leaseMs: 1_000,
  });

  assert.equal(claimed.status, "running");
  assert.equal(claimed.claim?.expiresAt, "2026-05-18T00:00:01.000Z");
  const heartbeat = graph.heartbeatTaskClaim(task.ref, {
    claimedBy: "session:a",
    now: "2026-05-18T00:00:00.500Z",
    leaseMs: 1_000,
  });
  assert.equal(heartbeat.claim?.heartbeatAt, "2026-05-18T00:00:00.500Z");
  assert.equal(heartbeat.claim?.expiresAt, "2026-05-18T00:00:01.500Z");
  assert.throws(() =>
    graph.claimTask(task.ref, {
      kind: "subagent",
      claimedBy: "agent:b",
      now: "2026-05-18T00:00:01.000Z",
    }),
  );

  const expired = graph.expireTaskClaims("2026-05-18T00:00:01.500Z");
  assert.equal(expired.length, 1);
  assert.equal(graph.getTask(task.ref).status, "pending");
  assert.equal(graph.getTask(task.ref).claim, undefined);
  assert.equal(graph.runs(thread.ref)[0]?.status, "cancelled");
  assert.equal(graph.runs(thread.ref)[0]?.failureKind, "claim_stale");
});

void test("expired claim sweeper persists retryable stale claims", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-sweep-"));
  try {
    const store = new TaskGraphStore(join(dir, "thread.json"));
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      threadRef: thread.ref,
      name: "sweep-claim",
      title: "Sweep claim",
      description: "Exercise persisted claim sweeping.",
    });
    graph.claimTask(task.ref, {
      kind: "subagent",
      claimedBy: "agent:worker",
      now: "2026-05-18T00:00:00.000Z",
      leaseMs: 1_000,
    });
    await store.save(graph);

    const result = await sweepExpiredTaskClaims(store, "2026-05-18T00:00:01.000Z");
    assert.equal(result.saved, true);
    assert.equal(result.expired.length, 1);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(task.ref).status, "pending");
    assert.equal(loaded.getTask(task.ref).claim, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkTask dry-runs through registered agents and writes artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-run-"));
  try {
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      threadRef: thread.ref,
      title: "Plan",
      description: "plan",
      agentRef: builtinAgentRef("planner"),
    });
    const artifactStore = new ArtifactStore({
      rootDir: join(dir, "artifacts"),
    });
    const run = await runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new AgentRegistry(),
      artifactStore,
      cwd: dir,
      dryRun: true,
    });
    assert.equal(run.status, "succeeded");
    assert.equal(graph.getTask(task.ref).status, "done");
    assert.equal((await artifactStore.list({ kind: "agent-run" })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
