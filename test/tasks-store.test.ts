import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RoleRegistry, builtinRoleRef } from "pi-roles";
import { ArtifactStore } from "spark-artifacts";
import { newRef, type RoleRef } from "spark-core";
import {
  RoleRunTimeoutError,
  buildRoleRunArgs,
  createRoleRunName,
  createRoleRunClaimId,
  findResumableBackgroundRoleRunTasks,
  killActiveSparkRoleRunProcesses,
  listActiveSparkRoleRunProcesses,
  defaultSparkDagRunStore,
  runReadySparkTasks,
  runSparkTask,
  sweepExpiredTaskClaims,
} from "spark-runtime";
import {
  TaskGraph,
  TaskGraphStore,
  TaskGraphStoreConflictError,
  TaskGraphStoreLockTimeoutError,
  TaskTodoStore,
} from "spark-tasks";

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
      roleRef: builtinRoleRef("planner"),
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
    roleRef: builtinRoleRef("planner"),
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
      description: "Move runtime behavior out of role registry.",
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

void test("task graph store update reports lock timeout without stealing active locks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-lock-timeout-"));
  try {
    const file = join(dir, "thread.json");
    const store = new TaskGraphStore(file);
    const graph = new TaskGraph();
    graph.createThread({ title: "Demo", description: "demo" });
    await store.save(graph);

    let releaseHolder!: () => void;
    const holder = store.withLock(
      () =>
        new Promise<void>((resolve) => {
          releaseHolder = resolve;
        }),
    );
    const lockPath = `${file}.lock`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await stat(lockPath);
        break;
      } catch (error) {
        if (attempt === 49 || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    const contender = new TaskGraphStore(file);
    await assert.rejects(
      () => contender.update(() => undefined, { timeoutMs: 10, retryIntervalMs: 1 }),
      TaskGraphStoreLockTimeoutError,
    );

    releaseHolder();
    await holder;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task graph store stale lock cleanup follows owner heartbeat, not lock directory mtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-lock-heartbeat-"));
  try {
    const file = join(dir, "thread.json");
    const store = new TaskGraphStore(file);
    const graph = new TaskGraph();
    graph.createThread({ title: "Demo", description: "demo" });
    await store.save(graph);

    const lockPath = `${file}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ ownerId: "active", heartbeatAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);

    await assert.rejects(
      () => store.update(() => undefined, { timeoutMs: 10, retryIntervalMs: 1, staleMs: 60_000 }),
      TaskGraphStoreLockTimeoutError,
    );
    await stat(lockPath);
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
        kind: "role-run",
        claimedBy: "role:fresh",
        sessionId: "session:parent",
        runName: "fresh",
        now: "2026-05-19T00:00:00.000Z",
        leaseMs: 60_000,
      });
    });

    stale.updateTask(task.ref, { description: "stale overwrite" });
    await assert.rejects(() => store.save(stale), TaskGraphStoreConflictError);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(task.ref).claim?.claimedBy, "role:fresh");
    assert.equal(loaded.getTask(task.ref).description, "claim me");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task graph store merges task progress from stale snapshots under lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-merge-progress-"));
  try {
    const store = new TaskGraphStore(join(dir, "thread.json"));
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      threadRef: thread.ref,
      name: "role-task",
      title: "Role task",
      description: "role task",
    });
    const other = graph.createTask({
      threadRef: thread.ref,
      name: "other-task",
      title: "Other task",
      description: "other task",
    });
    await store.save(graph);

    const stale = await store.load();
    assert.ok(stale);
    await store.update((locked) => {
      locked.updateTask(other.ref, { description: "fresh update" });
    });

    stale.recordRun({
      ref: "run:role-task",
      threadRef: thread.ref,
      taskRef: task.ref,
      status: "succeeded",
      finishedAt: "2026-05-20T00:00:00.000Z",
      outputArtifacts: [],
    });
    stale.setTaskStatus(task.ref, "done");

    await store.update((locked) => {
      locked.mergeTaskProgressFrom(stale, [task.ref]);
    });

    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(task.ref).status, "done");
    assert.equal(
      loaded.runs(thread.ref).find((run) => run.ref === "run:role-task")?.status,
      "succeeded",
    );
    assert.equal(loaded.getTask(other.ref).description, "fresh update");
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
          kind: "role-run",
          claimedBy,
          sessionId: "session:parent",
          runName: claimedBy.replace(/^role:/, ""),
          now: "2026-05-19T00:00:00.000Z",
          leaseMs: 60_000,
        });
      });

    const results = await Promise.allSettled([claim("role:a"), claim("role:b")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.match(loaded.getTask(task.ref).claim?.claimedBy ?? "", /^role:[ab]$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task graph blocks claim and assignment until dependencies are done", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const prerequisite = graph.createTask({
    threadRef: thread.ref,
    title: "Prerequisite",
    description: "prerequisite",
  });
  const dependent = graph.createTask({
    threadRef: thread.ref,
    title: "Dependent",
    description: "dependent",
  });
  graph.addDependency(dependent.ref, prerequisite.ref);

  assert.throws(
    () => graph.bindRole(dependent.ref, builtinRoleRef("worker")),
    /unmet dependencies/,
  );
  assert.throws(
    () =>
      graph.claimTask(dependent.ref, {
        kind: "main",
        claimedBy: "session:a",
        sessionId: "session:a",
        leaseMs: 60_000,
      }),
    /unmet dependencies/,
  );

  graph.setTaskStatus(prerequisite.ref, "done");
  const assigned = graph.bindRole(dependent.ref, builtinRoleRef("worker"));
  assert.equal(assigned.roleRef, builtinRoleRef("worker"));
  const claimed = graph.claimTask(dependent.ref, {
    kind: "main",
    claimedBy: "session:a",
    sessionId: "session:a",
    leaseMs: 60_000,
  });
  assert.equal(claimed.status, "running");
});

void test("task graph enforces one unfinished main claim per session", () => {
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
    claimedBy: "leaf:a",
    sessionId: "session:a",
    now: "2026-05-18T00:00:00.000Z",
    leaseMs: 1_000,
  });
  assert.throws(
    () =>
      graph.claimTask(second.ref, {
        kind: "main",
        claimedBy: "leaf:b",
        sessionId: "session:a",
        now: "2026-05-18T00:00:00.500Z",
        leaseMs: 1_000,
      }),
    /session session:a already has an unfinished claimed task/,
  );

  graph.expireTaskClaims("2026-05-18T00:00:01.000Z");
  const claimed = graph.claimTask(second.ref, {
    kind: "main",
    claimedBy: "leaf:b",
    sessionId: "session:a",
    now: "2026-05-18T00:00:01.000Z",
    leaseMs: 1_000,
  });
  assert.equal(claimed.ref, second.ref);
});

void test("task graph rejects duplicate task names on update", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const first = graph.createTask({
    threadRef: thread.ref,
    name: "first",
    title: "First",
    description: "first",
  });
  const second = graph.createTask({
    threadRef: thread.ref,
    name: "second",
    title: "Second",
    description: "second",
  });

  assert.equal(graph.updateTask(first.ref, { name: "first" }).name, "first");
  assert.throws(
    () => graph.updateTask(second.ref, { name: "first" }),
    /task name already exists in thread: first/,
  );
});

void test("task graph allows one main claim and multiple distinct role-run claims per session", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const main = graph.createTask({
    threadRef: thread.ref,
    title: "Main",
    description: "main",
  });
  const worker = graph.createTask({
    threadRef: thread.ref,
    title: "Worker",
    description: "worker",
  });
  const reviewer = graph.createTask({
    threadRef: thread.ref,
    title: "Reviewer",
    description: "reviewer",
  });

  const mainClaim = graph.claimTask(main.ref, {
    kind: "main",
    claimedBy: "leaf:a",
    sessionId: "session:a",
    leaseMs: 60_000,
  });
  const workerClaim = graph.claimTask(worker.ref, {
    kind: "role-run",
    claimedBy: "session:a+worker-1",
    sessionId: "session:a",
    runName: "worker-1",
    leaseMs: 60_000,
  });
  const reviewerClaim = graph.claimTask(reviewer.ref, {
    kind: "role-run",
    claimedBy: "session:a+reviewer-1",
    sessionId: "session:a",
    runName: "reviewer-1",
    leaseMs: 60_000,
  });

  assert.equal(mainClaim.claim?.kind, "main");
  assert.equal(workerClaim.claim?.runName, "worker-1");
  assert.equal(reviewerClaim.claim?.runName, "reviewer-1");
});

void test("task graph enforces one unfinished role-run claim per session and role name", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const first = graph.createTask({
    threadRef: thread.ref,
    title: "First worker",
    description: "first worker",
  });
  const second = graph.createTask({
    threadRef: thread.ref,
    title: "Second worker",
    description: "second worker",
  });
  const otherSession = graph.createTask({
    threadRef: thread.ref,
    title: "Other session worker",
    description: "other session worker",
  });

  graph.claimTask(first.ref, {
    kind: "role-run",
    claimedBy: "run:one",
    sessionId: "session:a",
    runName: "worker-1",
    leaseMs: 60_000,
  });
  assert.throws(
    () =>
      graph.claimTask(second.ref, {
        kind: "role-run",
        claimedBy: "run:two",
        sessionId: "session:a",
        runName: "worker-1",
        leaseMs: 60_000,
      }),
    /role-run session:a\/worker-1 already has an unfinished claimed task/,
  );

  const claimedByOtherSession = graph.claimTask(otherSession.ref, {
    kind: "role-run",
    claimedBy: "run:three",
    sessionId: "session:b",
    runName: "worker-1",
    leaseMs: 60_000,
  });
  assert.equal(claimedByOtherSession.claim?.sessionId, "session:b");
});

void test("task graph requires concrete claim identities", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const main = graph.createTask({
    threadRef: thread.ref,
    title: "Main",
    description: "main",
  });
  const roleRun = graph.createTask({
    threadRef: thread.ref,
    title: "Role-run",
    description: "role-run",
  });

  assert.throws(
    () =>
      graph.claimTask(main.ref, {
        kind: "main",
        claimedBy: "session:a",
        leaseMs: 60_000,
      }),
    /main task claim sessionId is required/,
  );
  assert.throws(
    () =>
      graph.claimTask(roleRun.ref, {
        kind: "role-run",
        claimedBy: "session:a+worker-1",
        sessionId: "session:a",
        leaseMs: 60_000,
      }),
    /role-run task claim runName is required/,
  );
});

void test("finished tasks retain unified attribution after claims clear", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const mainTask = graph.createTask({
    threadRef: thread.ref,
    title: "Main attributed",
    description: "main attributed",
  });
  const roleRunTask = graph.createTask({
    threadRef: thread.ref,
    title: "Role-run attributed",
    description: "role-run attributed",
  });

  graph.claimTask(mainTask.ref, {
    kind: "main",
    claimedBy: "session:a",
    sessionId: "session:a",
    runName: "executor",
    leaseMs: 60_000,
  });
  const mainDone = graph.setTaskStatus(mainTask.ref, "done");
  assert.equal(mainDone.claim, undefined);
  assert.equal(mainDone.claimedBySession, undefined);
  assert.deepEqual(mainDone.finishedBy, { sessionId: "session:a", runName: undefined });

  graph.claimTask(roleRunTask.ref, {
    kind: "role-run",
    claimedBy: "session:a+worker-1234",
    sessionId: "session:a",
    runName: "worker-1234",
    leaseMs: 60_000,
  });
  const roleRunDone = graph.setTaskStatus(roleRunTask.ref, "done");
  assert.deepEqual(roleRunDone.finishedBy, {
    sessionId: "session:a",
    runName: "worker-1234",
  });

  const restored = TaskGraph.fromSnapshot(graph.snapshot());
  assert.deepEqual(restored.getTask(mainTask.ref).finishedBy, {
    sessionId: "session:a",
    runName: undefined,
  });
  assert.deepEqual(restored.getTask(roleRunTask.ref).finishedBy, {
    sessionId: "session:a",
    runName: "worker-1234",
  });
});

void test("claims without expiresAt are dropped while loading legacy snapshots", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    threadRef: thread.ref,
    name: "legacy-claim",
    title: "Legacy claim",
    description: "Legacy stale claim without expiry.",
    status: "running",
  });
  const snapshot = graph.snapshot();
  const [snapshotTask] = snapshot.tasks;
  assert.ok(snapshotTask);
  snapshotTask.claimedBySession = "session:legacy";
  snapshotTask.claim = {
    kind: "main",
    claimedBy: "session:legacy",
    sessionId: "session:legacy",
    claimedAt: "2026-05-18T00:00:00.000Z",
    heartbeatAt: "2026-05-18T00:00:00.000Z",
  } as (typeof snapshotTask)["claim"];

  const restored = TaskGraph.fromSnapshot(snapshot);
  const restoredTask = restored.getTask(task.ref);
  assert.equal(restoredTask.claim, undefined);
  assert.equal(restoredTask.claimedBySession, undefined);
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
      kind: "role-run",
      claimedBy: "role:b",
      sessionId: "session:a",
      runName: "role-b",
      now: "2026-05-18T00:00:01.000Z",
      leaseMs: 1_000,
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
      roleRef: builtinRoleRef("worker"),
      status: "running",
      startedAt: "2026-05-18T00:00:00.000Z",
      outputArtifacts: [],
    });
    graph.claimTask(task.ref, {
      kind: "role-run",
      claimedBy: "role:worker",
      roleRef: builtinRoleRef("worker"),
      runName: "worker-1",
      sessionId: "session:parent",
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

void test("role run names and role-run claim ids are stable and attributable", () => {
  assert.equal(
    createRoleRunName(builtinRoleRef("worker"), newRef("run", "abcdef123456")),
    "worker-abcdef12",
  );
  assert.equal(
    createRoleRunClaimId("session:parent", "worker-abcdef12"),
    "session:parent+worker-abcdef12",
  );
});

void test("resumable background role-runs include owned stale claims", () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const owned = graph.createTask({
    threadRef: thread.ref,
    title: "Owned background",
    description: "owned",
    roleRef: builtinRoleRef("worker"),
    status: "running",
  });
  graph.claimTask(owned.ref, {
    kind: "role-run",
    claimedBy: "worker-run",
    runName: "worker-run",
    roleRef: builtinRoleRef("worker"),
    sessionId: "session:parent",
    now: "2026-05-18T00:00:00.000Z",
    leaseMs: 1_000,
  });
  const other = graph.createTask({
    threadRef: thread.ref,
    title: "Other background",
    description: "other",
    roleRef: builtinRoleRef("reviewer"),
    status: "running",
  });
  graph.claimTask(other.ref, {
    kind: "role-run",
    claimedBy: "reviewer-run",
    runName: "reviewer-run",
    roleRef: builtinRoleRef("reviewer"),
    sessionId: "session:other",
    leaseMs: 60_000,
  });

  const resumable = findResumableBackgroundRoleRunTasks(graph, "session:parent");
  assert.deepEqual(
    resumable.map((task) => task.ref),
    [owned.ref],
  );
});

void test("Spark runtime Pi command args use current CLI flags and explicit session directory", () => {
  const args = buildRoleRunArgs({
    roleRef: builtinRoleRef("worker"),
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
  assert.equal(args.includes("--fork"), false);
  assert.equal(args.includes("role:builtin-worker"), false);
  assert.equal(args.at(-2), "You are a worker.");
  assert.equal(args.at(-1)?.includes("Spark role-run ask policy:"), true);
  assert.equal(args.at(-1)?.includes("use the available Spark ask tools"), true);
  assert.equal(args.at(-1)?.includes("Spark naming quality policy:"), true);
  assert.equal(args.at(-1)?.includes("placeholder, generic, stale"), true);
  assert.equal(args.at(-1)?.includes("Stable refs must remain unchanged"), true);
  assert.equal(args.at(-1)?.includes("Instruction:\n\nImplement the task."), true);
  assert.throws(
    () =>
      buildRoleRunArgs({
        roleRef: builtinRoleRef("worker"),
        systemPrompt: "You are a worker.",
        instruction: "Implement the task.",
        mode: "forked",
      }),
    /forked role run requires forkFromSession/,
  );
});

void test("runSparkTask keeps timed-out real role-run claims in background", async () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    threadRef: thread.ref,
    title: "Plan",
    description: "plan",
    roleRef: builtinRoleRef("planner"),
  });
  const dir = await mkdtemp(join(tmpdir(), "spark-timeout-pi-"));
  const fakePi = join(dir, "fake-pi.mjs");
  await writeFile(
    fakePi,
    "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10_000);\n",
    "utf8",
  );
  const registry = new RoleRegistry();
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
    if (error instanceof RoleRunTimeoutError) throw error;
    throw error;
  });

  assert.equal(run.status, "running");
  assert.equal(run.failureKind, "runtime_timeout");
  assert.equal(graph.getTask(task.ref).status, "running");
  const claim = graph.getTask(task.ref).claim;
  assert.equal(claim?.kind, "role-run");
  assert.equal(claim?.sessionId, "session:parent");
  assert.match(claim?.claimedBy ?? "", /^session:parent\+planner-/);
  assert.match(claim?.runName ?? "", /^planner-/);
  assert.equal(claim?.roleRef, builtinRoleRef("planner"));
  assert.equal(run.runName, claim?.runName);
  assert.equal(run.ownerSessionId, "session:parent");
  assert.equal(claim?.claimedBy, createRoleRunClaimId("session:parent", claim?.runName ?? ""));
  assert.equal(
    listActiveSparkRoleRunProcesses().some((entry) => entry.runName === run.runName),
    true,
  );
  const killed = await killActiveSparkRoleRunProcesses({
    runName: run.runName,
    waitMs: 1_000,
  });
  assert.equal(killed.length, 1);
  assert.equal(
    listActiveSparkRoleRunProcesses().some((entry) => entry.runName === run.runName),
    false,
  );
  await rm(dir, { recursive: true, force: true });
});

void test("tracked Spark role-run processes can be killed after timeout", async () => {
  const graph = new TaskGraph();
  const thread = graph.createThread({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    threadRef: thread.ref,
    title: "Plan",
    description: "plan",
    roleRef: builtinRoleRef("planner"),
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
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: process.execPath,
      timeoutMs: 1,
      claim: { sessionId: "session:parent" },
    });

    assert.equal(run.status, "running");
    assert.equal(
      listActiveSparkRoleRunProcesses().some((entry) => entry.runRef === run.ref),
      true,
    );
    const killed = await killActiveSparkRoleRunProcesses({ runRef: run.ref, waitMs: 1_000 });
    assert.equal(killed.length, 1);
    assert.equal(killed[0]?.closed, true);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((entry) => entry.runRef === run.ref),
      false,
    );
  } finally {
    await killActiveSparkRoleRunProcesses();
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store persists manager lifecycle and task progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-store-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const threadRef = newRef("thread");
    const taskRef = newRef("task");
    const taskRunRef = newRef("run");
    const dagRun = await store.startRun({
      threadRef,
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 2,
      timeoutMs: 1234,
    });

    await store.recordSchedule(dagRun.ref, { taskRef, runRef: taskRunRef, scheduled: 1 });
    await store.recordProgress(dagRun.ref, {
      taskRef,
      completed: 1,
      run: {
        ref: taskRunRef,
        threadRef,
        taskRef,
        status: "succeeded",
        outputArtifacts: [],
      },
    });
    const followUp = await store.finishRun(dagRun.ref, {
      scheduled: 1,
      completed: 1,
      timedOut: false,
    });

    assert.ok(followUp);
    assert.equal(followUp.summary, `Spark DAG ${dagRun.ref} succeeded: scheduled 1, completed 1.`);
    assert.deepEqual(followUp.nextActions, [
      "Review task outputs and continue with newly unblocked ready tasks if any.",
    ]);

    const status = await store.status();
    assert.equal(status.manager.status, "idle");
    assert.equal(status.lastRun?.ref, dagRun.ref);
    assert.equal(status.succeeded, 1);
    assert.equal(status.running, 0);
    assert.equal(status.failed, 0);
    assert.equal(status.timedOut, 0);
    assert.deepEqual(
      status.recentRuns.map((run) => run.ref),
      [dagRun.ref],
    );

    const snapshot = await store.load();
    assert.equal(snapshot.manager.status, "idle");
    assert.equal(snapshot.manager.activeRunRef, undefined);
    assert.equal(snapshot.manager.lastRunRef, dagRun.ref);
    const [record] = snapshot.runs;
    assert.ok(record);
    assert.equal(record.status, "succeeded");
    assert.equal(record.ownerSessionId, "session:parent");
    assert.equal(record.maxConcurrency, 2);
    assert.equal(record.timeoutMs, 1234);
    assert.deepEqual(record.scheduledTaskRefs, [taskRef]);
    assert.deepEqual(record.completedTaskRefs, [taskRef]);
    assert.deepEqual(record.taskRunRefs, [taskRunRef]);
    assert.deepEqual(record.completionFollowUp, followUp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store can clear inactive manager records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-clear-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const finished = await store.startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    await store.finishRun(finished.ref, { scheduled: 0, completed: 0, timedOut: false });
    const running = await store.startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });

    const snapshot = await store.clearInactiveRuns();
    assert.deepEqual(
      snapshot.runs.map((run) => run.ref),
      [running.ref],
    );
    assert.equal(snapshot.manager.status, "running");
    assert.equal(snapshot.manager.activeRunRef, running.ref);
    assert.equal(snapshot.manager.lastRunRef, running.ref);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store reconciles stale running manager records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-reconcile-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      threadRef: thread.ref,
      title: "Finished elsewhere",
      description: "done",
    });
    const dagRun = await store.startRun({
      threadRef: thread.ref,
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    const taskRunRef = newRef("run");
    await store.recordSchedule(dagRun.ref, { taskRef: task.ref, runRef: taskRunRef, scheduled: 1 });
    graph.recordRun({
      ref: taskRunRef,
      threadRef: thread.ref,
      taskRef: task.ref,
      status: "succeeded",
      outputArtifacts: [],
    });

    const snapshot = await store.reconcile({ graph, activeRunRefs: [] });
    assert.equal(snapshot.manager.status, "idle");
    assert.equal(snapshot.manager.activeRunRef, undefined);
    const [record] = snapshot.runs;
    assert.ok(record);
    assert.equal(record.status, "succeeded");
    assert.equal(record.completed, 1);
    assert.match(record.errorMessage ?? "", /reconciled as succeeded/);
    assert.match(record.completionFollowUp?.summary ?? "", /succeeded/);

    const status = await store.status();
    assert.equal(status.succeeded, 1);
    assert.equal(status.running, 0);
  } finally {
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
        roleRef: builtinRoleRef("worker"),
      }),
    );
    const secondWave = graph.createTask({
      threadRef: thread.ref,
      title: "Wave 2",
      description: "ok",
      roleRef: builtinRoleRef("reviewer"),
    });
    for (const task of firstWave) graph.addDependency(secondWave.ref, task.ref);
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write(JSON.stringify({ type: 'done' }) + '\\n'); process.exit(0); }, 50);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const startedAt = Date.now();
    const result = await runReadySparkTasks({
      graph,
      registry: new RoleRegistry(),
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
    await killActiveSparkRoleRunProcesses();
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
      roleRef: builtinRoleRef("worker"),
    });
    const pendingTask = graph.createTask({
      threadRef: thread.ref,
      title: "Still pending",
      description: "pending",
      roleRef: builtinRoleRef("reviewer"),
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
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      maxConcurrency: 4,
      timeoutMs: 20,
      claim: { sessionId: "session:parent" },
    });

    const backgroundRuns = result.runs.filter(
      (run) => run.status === "running" && run.failureKind === "runtime_timeout",
    );
    assert.equal(result.maxConcurrency, 4);
    assert.equal(result.timedOut, true);
    assert.equal(result.scheduled, 1);
    assert.equal(graph.getTask(slowTask.ref).status, "running");
    assert.equal(graph.getTask(slowTask.ref).claim?.kind, "role-run");
    assert.equal(graph.getTask(pendingTask.ref).status, "pending");
    assert.equal(backgroundRuns.length, 1);
    assert.equal(backgroundRuns[0]?.taskRef, slowTask.ref);
    assert.match(backgroundRuns[0]?.errorMessage ?? "", /keeping role-run claim in background/);
    assert.equal(listActiveSparkRoleRunProcesses().length, 1);
  } finally {
    await killActiveSparkRoleRunProcesses();
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkTask does not complete real tasks when the role run never starts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-not-started-"));
  try {
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      threadRef: thread.ref,
      title: "Plan",
      description: "plan",
      roleRef: builtinRoleRef("planner"),
    });
    const artifactStore = new ArtifactStore({
      rootDir: join(dir, "artifacts"),
    });

    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(fakePi, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
    await chmod(fakePi, 0o755);

    const run = await runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      artifactStore,
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      claim: { sessionId: "session:parent" },
    });

    assert.equal(run.status, "failed");
    assert.equal(run.failureKind, "runtime_error");
    assert.match(run.errorMessage ?? "", /without producing output/);
    assert.equal(graph.getTask(task.ref).status, "failed");
    assert.equal(graph.getTask(task.ref).claim, undefined);
    const [artifact] = await artifactStore.list({ kind: "role-run" });
    assert.ok(artifact);
    const body = artifact.body as {
      record?: { status?: string };
      stdout?: string;
      stderr?: string;
      jsonEvents?: unknown[];
    };
    assert.equal(body.record?.status, "succeeded");
    assert.equal(body.stdout, "");
    assert.equal(body.stderr, "");
    assert.deepEqual(body.jsonEvents, []);
  } finally {
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
      roleRef: builtinRoleRef("planner"),
    });
    const artifactStore = new ArtifactStore({
      rootDir: join(dir, "artifacts"),
    });
    const run = await runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      artifactStore,
      cwd: dir,
      dryRun: true,
    });
    assert.equal(run.status, "succeeded");
    assert.match(run.runName ?? "", /^planner-/);
    assert.equal(graph.getTask(task.ref).status, "pending");
    assert.equal(graph.getTask(task.ref).claim, undefined);
    assert.equal(graph.getTask(task.ref).outputArtifacts.length, 1);
    assert.deepEqual(run.outputArtifacts, graph.getTask(task.ref).outputArtifacts);
    const [artifact] = await artifactStore.list({ kind: "role-run" });
    assert.ok(artifact);
    assert.equal(artifact.ref, run.outputArtifacts[0]);
    assert.match(artifact.title, /^Role run planner-/);
    assert.equal(artifact.provenance.producer, "task");
    assert.equal(artifact.provenance.threadRef, thread.ref);
    assert.equal(artifact.provenance.taskRef, task.ref);
    assert.equal(artifact.provenance.roleRef, builtinRoleRef("planner"));
    assert.match(artifact.provenance.note ?? "", /^runName=planner-/);
    const body = artifact.body as {
      record?: { ref?: string; runName?: string; status?: string; instruction?: string };
      stdout?: string;
      stderr?: string;
      jsonEvents?: unknown[];
    };
    assert.equal(body.record?.ref, run.ref);
    assert.equal(body.record?.runName, run.runName);
    assert.equal(body.record?.status, "not_started");
    assert.equal(body.record?.instruction, "plan");
    assert.equal(body.stdout, "");
    assert.equal(body.stderr, "");
    assert.deepEqual(body.jsonEvents, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkTask can request explicit forked Pi mode when a parent session is provided", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-forked-run-"));
  try {
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      threadRef: thread.ref,
      title: "Forked spec implementation",
      description: "implement project spec behavior with parent context",
      roleRef: builtinRoleRef("reviewer"),
    });
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "const forkIndex = args.indexOf('--fork');",
        "if (forkIndex < 0) process.exit(12);",
        "if (args[forkIndex + 1] !== 'parent-session.json') process.exit(13);",
        "process.stdout.write(JSON.stringify({ type: 'forked', parent: args[forkIndex + 1] }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const run = await runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      mode: "forked",
      forkFromSession: "parent-session.json",
      claim: { sessionId: "session:parent" },
    });

    assert.equal(run.status, "succeeded");
    assert.equal(run.roleRef, builtinRoleRef("reviewer"));
    assert.match(run.runName ?? "", /^reviewer-/);
    assert.equal(run.ownerSessionId, "session:parent");
    assert.equal(graph.getTask(task.ref).status, "done");
  } finally {
    await killActiveSparkRoleRunProcesses();
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkTask attributes real project role spec run claims and completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-attribution-"));
  try {
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const roleRef = "role:project-test-worker" as RoleRef;
    const task = graph.createTask({
      threadRef: thread.ref,
      title: "Project spec implementation",
      description: "implement project spec behavior",
      roleRef,
    });
    const registry = new RoleRegistry();
    registry.add({
      ref: roleRef,
      id: "test-worker",
      source: "project",
      description: "Project test worker",
      systemPrompt: "You are a project test worker.",
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
    });
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args.includes('--fork')) process.exit(12);",
        "if (!args.includes('--session-dir')) process.exit(13);",
        "process.stdout.write(JSON.stringify({ type: 'done', ok: true }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const run = await runSparkTask({
      graph,
      taskRef: task.ref,
      registry,
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      sessionDir: join(dir, "sessions"),
      claim: { sessionId: "session:parent" },
    });

    const finishedTask = graph.getTask(task.ref);
    assert.equal(run.status, "succeeded");
    assert.equal(run.roleRef, roleRef);
    assert.match(run.runName ?? "", /^test-worker-/);
    assert.equal(run.ownerSessionId, "session:parent");
    assert.equal(finishedTask.status, "done");
    assert.equal(finishedTask.claim, undefined);
    assert.equal(finishedTask.claimedBySession, undefined);
    assert.deepEqual(finishedTask.finishedBy, {
      sessionId: "session:parent",
      runName: run.runName,
    });
    assert.equal(graph.runs(thread.ref).at(-1)?.ref, run.ref);
    assert.equal(graph.runs(thread.ref).at(-1)?.ownerSessionId, "session:parent");
    assert.equal(graph.runs(thread.ref).at(-1)?.runName, run.runName);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((entry) => entry.runRef === run.ref),
      false,
    );
  } finally {
    await killActiveSparkRoleRunProcesses();
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkTask timeout cleanup only leaves the timed-out role-run process tracked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-timeout-cleanup-"));
  try {
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Demo", description: "demo" });
    const fast = graph.createTask({
      threadRef: thread.ref,
      title: "Fast task",
      description: "fast",
      roleRef: builtinRoleRef("worker"),
    });
    const slow = graph.createTask({
      threadRef: thread.ref,
      title: "Slow task",
      description: "reviewer",
      roleRef: builtinRoleRef("reviewer"),
    });
    const fakePi = join(dir, "fake-pi.sh");
    await writeFile(
      fakePi,
      [
        "#!/bin/sh",
        'case "$*" in',
        "  *reviewer*) trap '' TERM; while :; do sleep 1; done ;;",
        "  *) exit 0 ;;",
        "esac",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const result = await runReadySparkTasks({
      graph,
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      maxConcurrency: 2,
      taskTimeoutMs: 30,
      timeoutMs: 5_000,
      claim: { sessionId: "session:parent" },
    });

    assert.equal(result.timedOut, false);
    assert.equal(result.scheduled, 2);
    const fastRuns = graph.runs(thread.ref).filter((run) => run.taskRef === fast.ref);
    const slowRuns = graph.runs(thread.ref).filter((run) => run.taskRef === slow.ref);
    assert.equal(fastRuns.length, 1);
    assert.equal(slowRuns.length, 1);
    const slowRun = slowRuns.find((run) => run.status === "running") ?? slowRuns[0];
    assert.equal(slowRun?.status, "running");
    assert.equal(slowRun?.failureKind, "runtime_timeout");
    assert.ok(["done", "running"].includes(graph.getTask(fast.ref).status));
    assert.equal(graph.getTask(slow.ref).status, "running");
    assert.equal(graph.getTask(slow.ref).claim?.kind, "role-run");
    const active = listActiveSparkRoleRunProcesses();
    assert.ok(active.length >= 1);
    const slowActive = active.find(
      (entry) => entry.runRef === graph.getTask(slow.ref).claim?.runRef,
    );
    assert.ok(slowActive);
    assert.equal(slowActive.runName, graph.getTask(slow.ref).claim?.runName);
    await killActiveSparkRoleRunProcesses({
      runRef: slowActive.runRef,
      forceAfterMs: 0,
      waitMs: 1_000,
    });
    assert.equal(
      listActiveSparkRoleRunProcesses().some((entry) => entry.runRef === slowActive.runRef),
      false,
    );
  } finally {
    await killActiveSparkRoleRunProcesses();
    await rm(dir, { recursive: true, force: true });
  }
});
