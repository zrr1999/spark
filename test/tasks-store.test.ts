import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentRegistry, builtinAgentRef } from "spark-agents";
import { ArtifactStore } from "spark-artifacts";
import { newRef } from "spark-core";
import {
  AgentRunTimeoutError,
  buildPiAgentArgs,
  createAgentRunName,
  createSubagentClaimId,
  findResumableBackgroundSubagentTasks,
  killActiveSparkSubagentProcesses,
  listActiveSparkSubagentProcesses,
  runReadySparkTasks,
  runSparkTask,
  sweepExpiredTaskClaims,
} from "spark-runtime";
import { TaskGraph, TaskGraphStore, TaskGraphStoreConflictError, TaskTodoStore } from "spark-tasks";

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

void test("task graph store serializes read-modify-write updates with a filesystem lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-lock-"));
  try {
    const store = new TaskGraphStore(join(dir, "thread.json"));
    const graph = new TaskGraph();
    graph.createThread({ title: "Demo", description: "demo" });
    await store.save(graph);

    const first = store.update(async (locked) => {
      const [thread] = locked.threads();
      assert.ok(thread);
      await new Promise((resolve) => setTimeout(resolve, 50));
      locked.createTask({
        threadRef: thread.ref,
        name: "first",
        title: "First",
        description: "first",
      });
    });
    const second = store.update(async (locked) => {
      const [thread] = locked.threads();
      assert.ok(thread);
      locked.createTask({
        threadRef: thread.ref,
        name: "second",
        title: "Second",
        description: "second",
      });
    });

    await Promise.all([first, second]);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.deepEqual(
      loaded
        .tasks()
        .map((task) => task.name)
        .sort(),
      ["first", "second"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task graph store direct save rejects stale loaded snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-stale-save-"));
  try {
    const store = new TaskGraphStore(join(dir, "thread.json"));
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      threadRef: thread.ref,
      name: "claim-me",
      title: "Claim me",
      description: "claim me",
    });
    await store.save(graph);

    const stale = await store.load();
    assert.ok(stale);
    await store.update((locked) => {
      locked.claimTask(task.ref, {
        kind: "subagent",
        claimedBy: "agent:fresh",
        now: "2026-05-19T00:00:00.000Z",
        leaseMs: 60_000,
      });
    });

    stale.updateTask(task.ref, { description: "stale overwrite" });
    await assert.rejects(() => store.save(stale), TaskGraphStoreConflictError);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(task.ref).claim?.claimedBy, "agent:fresh");
    assert.equal(loaded.getTask(task.ref).description, "claim me");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task graph store rejects concurrent claims under lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-lock-"));
  try {
    const store = new TaskGraphStore(join(dir, "thread.json"));
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      threadRef: thread.ref,
      name: "claim-me",
      title: "Claim me",
      description: "claim me",
    });
    await store.save(graph);

    const claim = (claimedBy: string) =>
      store.update(async (locked) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        locked.claimTask(task.ref, {
          kind: "subagent",
          claimedBy,
          now: "2026-05-19T00:00:00.000Z",
          leaseMs: 60_000,
        });
      });

    const results = await Promise.allSettled([claim("agent:a"), claim("agent:b")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.match(loaded.getTask(task.ref).claim?.claimedBy ?? "", /^agent:[ab]$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task graph enforces one unfinished active task per claimant", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const first = graph.createTask({
    threadRef: thread.ref,
    title: "First",
    description: "first",
  });
  const second = graph.createTask({
    threadRef: thread.ref,
    title: "Second",
    description: "second",
  });

  graph.claimTask(first.ref, {
    kind: "main",
    claimedBy: "session:a",
    sessionId: "session:a",
    now: "2026-05-18T00:00:00.000Z",
    leaseMs: 1_000,
  });
  assert.throws(() =>
    graph.claimTask(second.ref, {
      kind: "main",
      claimedBy: "session:a",
      sessionId: "session:a",
      now: "2026-05-18T00:00:00.500Z",
      leaseMs: 1_000,
    }),
  );

  graph.expireTaskClaims("2026-05-18T00:00:01.000Z");
  const claimed = graph.claimTask(second.ref, {
    kind: "main",
    claimedBy: "session:a",
    sessionId: "session:a",
    now: "2026-05-18T00:00:01.000Z",
    leaseMs: 1_000,
  });
  assert.equal(claimed.ref, second.ref);
});

void test("finished tasks retain completed-by attribution after claims clear", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    threadRef: thread.ref,
    title: "Attributed",
    description: "attributed",
  });

  graph.claimTask(task.ref, {
    kind: "main",
    claimedBy: "session:a",
    sessionId: "session:a",
    agentName: "executor",
  });
  const done = graph.setTaskStatus(task.ref, "done");

  assert.equal(done.claim, undefined);
  assert.equal(done.claimedBySession, undefined);
  assert.equal(done.completedBySession, "session:a");
  assert.equal(done.completedByAgentName, "executor");
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
    const runRef = newRef("run");
    graph.recordRun({
      ref: runRef,
      threadRef: thread.ref,
      taskRef: task.ref,
      agentRef: builtinAgentRef("worker"),
      status: "running",
      startedAt: "2026-05-18T00:00:00.000Z",
      outputArtifacts: [],
    });
    graph.claimTask(task.ref, {
      kind: "subagent",
      claimedBy: "agent:worker",
      agentRef: builtinAgentRef("worker"),
      runRef,
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
    assert.equal(loaded.runs(thread.ref)[0]?.status, "cancelled");
    assert.equal(loaded.runs(thread.ref)[0]?.failureKind, "claim_stale");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("agent run names and subagent claim ids are stable and attributable", () => {
  assert.equal(
    createAgentRunName(builtinAgentRef("worker"), newRef("run", "abcdef123456")),
    "worker-abcdef12",
  );
  assert.equal(
    createSubagentClaimId("session:parent", "worker-abcdef12"),
    "session:parent+worker-abcdef12",
  );
});

void test("resumable background subagents include owned stale claims", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const owned = graph.createTask({
    threadRef: thread.ref,
    title: "Owned background",
    description: "owned",
    agentRef: builtinAgentRef("worker"),
    status: "running",
  });
  graph.claimTask(owned.ref, {
    kind: "subagent",
    claimedBy: "worker-run",
    agentName: "worker-run",
    agentRef: builtinAgentRef("worker"),
    sessionId: "session:parent",
    now: "2026-05-18T00:00:00.000Z",
    leaseMs: 1_000,
  });
  const other = graph.createTask({
    threadRef: thread.ref,
    title: "Other background",
    description: "other",
    agentRef: builtinAgentRef("reviewer"),
    status: "running",
  });
  graph.claimTask(other.ref, {
    kind: "subagent",
    claimedBy: "reviewer-run",
    agentName: "reviewer-run",
    agentRef: builtinAgentRef("reviewer"),
    sessionId: "session:other",
  });

  const resumable = findResumableBackgroundSubagentTasks(graph, "session:parent");
  assert.deepEqual(
    resumable.map((task) => task.ref),
    [owned.ref],
  );
});

void test("Pi agent command args use current CLI flags", () => {
  const args = buildPiAgentArgs({
    systemPrompt: "You are a worker.",
    instruction: "Implement the task.",
    sessionDir: "/tmp/sessions",
  });
  assert.deepEqual(args.slice(0, 6), [
    "--print",
    "--mode",
    "json",
    "--session-dir",
    "/tmp/sessions",
    "--append-system-prompt",
  ]);
  assert.equal(args.includes("--prompt"), false);
  assert.equal(args.at(-2), "You are a worker.");
  assert.equal(args.at(-1)?.includes("Spark subagent ask policy:"), true);
  assert.equal(args.at(-1)?.includes("use the available Spark ask tools"), true);
  assert.equal(args.at(-1)?.includes("Instruction:\nImplement the task."), true);
});

void test("runSparkTask keeps timed-out real subagent claims in background", async () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    threadRef: thread.ref,
    title: "Plan",
    description: "plan",
    agentRef: builtinAgentRef("planner"),
  });
  const dir = await mkdtemp(join(tmpdir(), "spark-timeout-pi-"));
  const fakePi = join(dir, "fake-pi.mjs");
  await writeFile(
    fakePi,
    "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10_000);\n",
    "utf8",
  );
  const registry = new AgentRegistry();
  const run = await runSparkTask({
    graph,
    taskRef: task.ref,
    registry,
    cwd: dir,
    dryRun: false,
    piCommand: process.execPath,
    timeoutMs: 1,
    claim: { sessionId: "session:parent" },
  }).catch((error: unknown) => {
    if (error instanceof AgentRunTimeoutError) throw error;
    throw error;
  });

  assert.equal(run.status, "running");
  assert.equal(run.failureKind, "runtime_timeout");
  assert.equal(graph.getTask(task.ref).status, "running");
  const claim = graph.getTask(task.ref).claim;
  assert.equal(claim?.kind, "subagent");
  assert.equal(claim?.sessionId, "session:parent");
  assert.match(claim?.claimedBy ?? "", /^session:parent\+planner-/);
  assert.match(claim?.agentName ?? "", /^planner-/);
  assert.equal(claim?.agentRef, builtinAgentRef("planner"));
  assert.equal(run.agentName, claim?.agentName);
  assert.equal(run.ownerSessionId, "session:parent");
  assert.equal(claim?.claimedBy, createSubagentClaimId("session:parent", claim?.agentName ?? ""));
  assert.equal(
    listActiveSparkSubagentProcesses().some((entry) => entry.agentName === run.agentName),
    true,
  );
  const killed = await killActiveSparkSubagentProcesses({
    agentName: run.agentName,
    waitMs: 1_000,
  });
  assert.equal(killed.length, 1);
  assert.equal(
    listActiveSparkSubagentProcesses().some((entry) => entry.agentName === run.agentName),
    false,
  );
  await rm(dir, { recursive: true, force: true });
});

void test("tracked Spark subagent processes can be killed after timeout", async () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    threadRef: thread.ref,
    title: "Plan",
    description: "plan",
    agentRef: builtinAgentRef("planner"),
  });
  const dir = await mkdtemp(join(tmpdir(), "spark-kill-pi-"));
  try {
    await writeFile(
      join(dir, "fake-pi.mjs"),
      "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10_000);\n",
      "utf8",
    );
    const run = await runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new AgentRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: process.execPath,
      timeoutMs: 1,
      claim: { sessionId: "session:parent" },
    });

    assert.equal(run.status, "running");
    assert.equal(
      listActiveSparkSubagentProcesses().some((entry) => entry.runRef === run.ref),
      true,
    );
    const killed = await killActiveSparkSubagentProcesses({ runRef: run.ref, waitMs: 1_000 });
    assert.equal(killed.length, 1);
    assert.equal(killed[0]?.closed, true);
    assert.equal(
      listActiveSparkSubagentProcesses().some((entry) => entry.runRef === run.ref),
      false,
    );
  } finally {
    await killActiveSparkSubagentProcesses();
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runReadySparkTasks schedules DAG waves with maxConcurrency 4", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-parallel-"));
  try {
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const firstWave = Array.from({ length: 4 }, (_, index) =>
      graph.createTask({
        threadRef: thread.ref,
        title: `Wave 1-${index}`,
        description: "ok",
        agentRef: builtinAgentRef("worker"),
      }),
    );
    const secondWave = graph.createTask({
      threadRef: thread.ref,
      title: "Wave 2",
      description: "ok",
      agentRef: builtinAgentRef("reviewer"),
    });
    for (const task of firstWave) graph.addDependency(secondWave.ref, task.ref);
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 50);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const startedAt = Date.now();
    const result = await runReadySparkTasks({
      graph,
      registry: new AgentRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      maxConcurrency: 4,
      timeoutMs: 5_000,
      claim: { sessionId: "session:parent" },
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.maxConcurrency, 4);
    assert.equal(result.scheduled, 5);
    assert.equal(result.runs.length, 5);
    assert.equal(result.timedOut, false);
    assert.equal(graph.getTask(secondWave.ref).status, "done");
    const firstWaveFinishedAt = firstWave.map((task) => graph.getTask(task.ref).updatedAt).sort();
    const spanMs =
      Date.parse(firstWaveFinishedAt.at(-1) ?? "") - Date.parse(firstWaveFinishedAt[0] ?? "");
    assert.ok(
      spanMs < 120,
      `expected parallel first wave, span=${spanMs}ms elapsed=${elapsedMs}ms`,
    );
  } finally {
    await killActiveSparkSubagentProcesses();
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runReadySparkTasks uses DAG-level timeout instead of per-task timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-timeout-"));
  try {
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const slowTask = graph.createTask({
      threadRef: thread.ref,
      title: "Slow task",
      description: "slow",
      agentRef: builtinAgentRef("worker"),
    });
    const pendingTask = graph.createTask({
      threadRef: thread.ref,
      title: "Still pending",
      description: "pending",
      agentRef: builtinAgentRef("reviewer"),
    });
    graph.addDependency(pendingTask.ref, slowTask.ref);
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); setTimeout(() => {}, 10_000);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const result = await runReadySparkTasks({
      graph,
      registry: new AgentRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      maxConcurrency: 4,
      timeoutMs: 20,
      claim: { sessionId: "session:parent" },
    });

    const cancelledRuns = result.runs.filter((run) => run.status === "cancelled");
    assert.equal(result.maxConcurrency, 4);
    assert.equal(result.timedOut, true);
    assert.equal(result.scheduled, 1);
    assert.equal(graph.getTask(slowTask.ref).status, "pending");
    assert.equal(graph.getTask(slowTask.ref).claim, undefined);
    assert.equal(graph.getTask(pendingTask.ref).status, "pending");
    assert.equal(cancelledRuns.length, 1);
    assert.equal(cancelledRuns[0]?.taskRef, slowTask.ref);
    assert.equal(
      graph.runs(thread.ref).filter((run) => run.ref === cancelledRuns[0]?.ref).length,
      1,
    );
    assert.equal(listActiveSparkSubagentProcesses().length, 0);
  } finally {
    await killActiveSparkSubagentProcesses();
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkTask dry-run records validation without completing the task", async () => {
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
    assert.match(run.agentName ?? "", /^planner-/);
    assert.equal(graph.getTask(task.ref).status, "pending");
    assert.equal(graph.getTask(task.ref).claim, undefined);
    const [artifact] = await artifactStore.list({ kind: "agent-run" });
    assert.ok(artifact);
    assert.match(artifact.title, /^Agent run planner-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
