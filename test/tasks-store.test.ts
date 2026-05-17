import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentRegistry, builtinAgentRef } from "spark-agents";
import { ArtifactStore } from "spark-artifacts";
import { TaskGraph, TaskGraphStore } from "spark-tasks";

void test("task graph store persists snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tasks-"));
  try {
    const file = join(dir, "thread.json");
    const store = new TaskGraphStore(file);
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    graph.ensureContextTask(thread.ref);
    graph.createTask({
      threadRef: thread.ref,
      title: "Plan",
      description: "plan",
      agentRef: builtinAgentRef("planner"),
      todos: [{ content: "Read inputs" }, { content: "Draft plan" }],
    });
    await store.save(graph);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded.threads()[0]?.title, "Demo");
    assert.equal(loaded.tasks(thread.ref).length, 2);
    assert.equal(loaded.currentTask(thread.ref)?.kind, "interaction");
    assert.equal(loaded.tasks(thread.ref)[1]?.todos.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
