import assert from "node:assert/strict";
import test from "node:test";

import { newRef, refId, isRef } from "spark-core";
import { builtinAgentRef } from "spark-agents";
import { TaskGraph } from "spark-tasks";

void test("refs carry kind and id", () => {
  const ref = newRef("task", "abc");
  assert.equal(ref, "task:abc");
  assert.equal(refId(ref), "abc");
  assert.equal(isRef(ref, "task"), true);
  assert.equal(isRef(ref, "agent"), false);
});

void test("task graph rejects cycles", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const a = graph.createTask({
    threadRef: thread.ref,
    title: "A",
    description: "a",
    agentRef: builtinAgentRef("planner"),
  });
  const b = graph.createTask({
    threadRef: thread.ref,
    title: "B",
    description: "b",
    agentRef: builtinAgentRef("worker"),
  });
  graph.addDependency(b.ref, a.ref);
  assert.throws(() => graph.addDependency(a.ref, b.ref), /cyclic task dependency/);
});

void test("ready tasks require agent and completed dependencies", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const a = graph.createTask({
    threadRef: thread.ref,
    title: "A",
    description: "a",
    agentRef: builtinAgentRef("planner"),
  });
  const b = graph.createTask({
    threadRef: thread.ref,
    title: "B",
    description: "b",
    agentRef: builtinAgentRef("worker"),
  });
  graph.addDependency(b.ref, a.ref);
  assert.deepEqual(
    graph.readyTasks(thread.ref).map((task) => task.ref),
    [a.ref],
  );
});

void test("task graph maintains per-task todos and a current interaction task", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const interaction = graph.ensureContextTask(thread.ref);
  assert.equal(graph.currentTask(thread.ref)?.ref, interaction.ref);
  assert.equal(graph.todoSummary(interaction.ref).inProgress, 1);

  const task = graph.createTask({
    threadRef: thread.ref,
    title: "Plan",
    description: "plan",
    kind: "plan",
    agentRef: builtinAgentRef("planner"),
    todos: [{ content: "Read inputs" }, { content: "Draft graph" }],
  });
  graph.applyTodoOps(task.ref, [
    { op: "done", item: "Read inputs" },
    { op: "start", item: "Draft graph" },
    { op: "note", item: "Draft graph", text: "Need explicit deps" },
  ]);

  const summary = graph.todoSummary(task.ref);
  assert.equal(summary.done, 1);
  assert.equal(summary.inProgress, 1);
  assert.equal(summary.active, "Draft graph");
  assert.equal(graph.threadTodoSummary(thread.ref).tasksWithTodos, 2);
});
