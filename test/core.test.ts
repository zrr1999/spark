import assert from "node:assert/strict";
import test from "node:test";

import { newRef, refId, isRef } from "spark-core";
import { builtinAgentRef, createBuiltinAgents } from "spark-agents";
import { TaskGraph } from "spark-tasks";
import {
  deriveTaskAgentLabel,
  isGenericTaskNameForTitle,
  isPlaceholderThreadTitle,
  renderSparkActiveSystemPrompt,
} from "../packages/spark/src/extension/index.ts";

void test("refs carry kind and id", () => {
  const ref = newRef("task", "abc");
  assert.equal(ref, "task:abc");
  assert.equal(refId(ref), "abc");
  assert.equal(isRef(ref, "task"), true);
  assert.equal(isRef(ref, "agent"), false);
});

void test("task graph rejects cycles and cross-thread dependencies", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const otherThread = graph.createThread({ title: "Other", description: "other" });
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
  const other = graph.createTask({
    threadRef: otherThread.ref,
    title: "Other task",
    description: "other task",
    agentRef: builtinAgentRef("worker"),
  });
  graph.addDependency(b.ref, a.ref);
  assert.throws(() => graph.addDependency(a.ref, b.ref), /cyclic task dependency/);
  assert.throws(
    () => graph.addDependency(b.ref, other.ref),
    /task dependencies cannot cross threads/,
  );
});

void test("task graph can update placeholder thread titles", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "「自定义输入」", description: "demo" });
  const updated = graph.updateThread(thread.ref, { title: "Concrete Spark workflow" });
  assert.equal(updated.ref, thread.ref);
  assert.equal(updated.title, "Concrete Spark workflow");
  assert.equal(graph.getThread(thread.ref).title, "Concrete Spark workflow");
  assert.equal(isPlaceholderThreadTitle("Spark thread"), true);
  assert.equal(isPlaceholderThreadTitle("Hypha v0"), false);
});

void test("generic task names are detectable and intentionally named tasks are preserved", () => {
  assert.equal(isGenericTaskNameForTitle("capture-project-intent", "Capture project intent"), true);
  assert.equal(isGenericTaskNameForTitle("task-deadbeefcafebabe", "整理一下"), true);
  assert.equal(isGenericTaskNameForTitle("hypha-v0", "Capture project intent"), false);
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

void test("task agent labels prefer active claim, finished attribution, then latest run", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const current = "session:current";
  const main = graph.createTask({ threadRef: thread.ref, title: "Main", description: "main" });
  const subagent = graph.createTask({ threadRef: thread.ref, title: "Sub", description: "sub" });
  const legacy = graph.createTask({
    threadRef: thread.ref,
    title: "Legacy",
    description: "legacy",
  });

  graph.claimTask(main.ref, {
    kind: "main",
    claimedBy: current,
    sessionId: current,
    leaseMs: 60_000,
  });
  graph.claimTask(subagent.ref, {
    kind: "subagent",
    claimedBy: `${current}+worker-1234`,
    sessionId: current,
    agentName: "worker-1234",
    leaseMs: 60_000,
  });
  graph.setTaskStatus(main.ref, "done");
  graph.setTaskStatus(subagent.ref, "done");
  graph.setTaskStatus(legacy.ref, "done");

  assert.equal(
    deriveTaskAgentLabel({ task: graph.getTask(main.ref), currentSessionKey: current }),
    "me",
  );
  assert.equal(
    deriveTaskAgentLabel({ task: graph.getTask(subagent.ref), currentSessionKey: current }),
    "me/worker-1234",
  );
  assert.equal(
    deriveTaskAgentLabel({
      task: graph.getTask(legacy.ref),
      currentSessionKey: current,
      latestRun: {
        ref: newRef("run"),
        threadRef: thread.ref,
        taskRef: legacy.ref,
        agentName: "reviewer-9999",
        status: "succeeded",
        outputArtifacts: [],
      },
    }),
    "me/reviewer-9999",
  );
  assert.equal(
    deriveTaskAgentLabel({
      task: graph.getTask(legacy.ref),
      currentSessionKey: current,
    }),
    "me",
  );
});

void test("active Spark prompt keeps only the active workflow contract", () => {
  const prompt = renderSparkActiveSystemPrompt("", "SPARK.md");
  assert.match(prompt, /Spark is active for this workspace/);
  assert.match(prompt, /Active Spark context/);
  assert.match(prompt, /claim at most one unfinished session task/);
  assert.match(prompt, /Spark ask tools/);
  assert.match(prompt, /fix concrete repo behavior feedback/);
  assert.doesNotMatch(prompt, /spark_use_thread/);
  assert.doesNotMatch(prompt, /spark_list_agents\/spark_get_agent/);
  assert.doesNotMatch(prompt, /Do not spawn nested pi CLI sessions/);
  assert.ok(prompt.length < 700);
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
