import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentRegistry, builtinAgentRef } from "spark-agents";
import { ArtifactStore } from "spark-artifacts";
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

void test("runTask dry-runs through registered agents and writes artifact", async () => {
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
    const run = await graph.runTask({
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
