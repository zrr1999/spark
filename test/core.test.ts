import assert from "node:assert/strict";
import test from "node:test";

import { newRef, refId, isRef } from "spark-core";
import { builtinAgentRef, createBuiltinAgents } from "spark-agents";
import { TaskGraph } from "spark-tasks";
import { renderSparkActiveSystemPrompt } from "../packages/spark/src/extension/index.ts";

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

void test("task graph can update placeholder thread titles", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "「自定义输入」", description: "demo" });
  const updated = graph.updateThread(thread.ref, { title: "Concrete Spark workflow" });
  assert.equal(updated.title, "Concrete Spark workflow");
  assert.equal(graph.getThread(thread.ref).title, "Concrete Spark workflow");
});

void test("task graph plans multiple tasks without claiming them", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const result = graph.planTasks(thread.ref, [
    {
      title: "Inspect ask flow",
      description: "Compare current ask flow with references.",
      kind: "research",
      agentRef: builtinAgentRef("scout"),
    },
    {
      title: "Design claim registry",
      description: "Plan one-active-task claim semantics.",
      kind: "plan",
      agentRef: builtinAgentRef("planner"),
      dependsOn: ["Inspect ask flow"],
    },
  ]);

  assert.equal(result.created.length, 2);
  assert.equal(result.dependencies.length, 1);
  assert.equal(graph.tasks(thread.ref).filter((task) => task.claimedBySession).length, 0);
  assert.deepEqual(
    graph.readyTasks(thread.ref).map((task) => task.title),
    ["Inspect ask flow"],
  );
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

void test("active Spark prompt encodes delegation and cue-shell guardrails", () => {
  const prompt = renderSparkActiveSystemPrompt("", "SPARK.md");
  assert.match(prompt, /spark_use_thread/);
  assert.match(prompt, /spark_plan_tasks/);
  assert.match(prompt, /spark_list_agents\/spark_get_agent/);
  assert.match(prompt, /spark_run_ready_tasks/);
  assert.match(prompt, /agentName/);
  assert.match(prompt, /Do not spawn nested pi CLI sessions as pseudo-agents/);
  assert.match(prompt, /prefer direct-exec commands and Pi file tools over \/bin\/sh/);
  assert.match(prompt, /timeout or no-selection/);
});

void test("builtin Spark agents are instructed to use ask tools for blockers", () => {
  for (const agent of createBuiltinAgents()) {
    assert.match(agent.systemPrompt, /use Spark ask tools/i);
    assert.match(agent.systemPrompt, /block|ambigu/i);
  }
});

void test("task graph maintains todos alongside a claimed current task", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  assert.equal(graph.currentTask(thread.ref), undefined);

  const task = graph.createTask({
    threadRef: thread.ref,
    title: "Plan",
    description: "plan",
    kind: "plan",
    agentRef: builtinAgentRef("planner"),
    todos: [{ content: "Read inputs" }, { content: "Draft graph" }],
  });
  graph.setCurrentTask(thread.ref, task.ref);
  graph.applyTodoOps(task.ref, [
    { op: "done", item: "Read inputs" },
    { op: "start", item: "Draft graph" },
    { op: "note", item: "Draft graph", text: "Need explicit deps" },
  ]);

  const summary = graph.todoSummary(task.ref);
  assert.equal(summary.done, 1);
  assert.equal(summary.inProgress, 1);
  assert.equal(summary.active, "Draft graph");
  assert.equal(graph.taskTodos(task.ref).length, 2);
});
