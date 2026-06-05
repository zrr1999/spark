import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RoleRegistry, builtinRoleRef, defaultUserRoleModelBindingStore } from "pi-roles";
import { ArtifactStore } from "pi-artifacts";
import {
  DependencyError,
  newRef,
  nowIso,
  type RoleRef,
  type RunRef,
  type TaskPlan,
  type TaskRef,
} from "pi-extension-api";
import {
  SparkDagRunStoreFormatError,
  defaultSparkDagRunStore,
  runReadySparkTasks,
  type SparkDagRunRecord,
} from "../packages/pi-workflows/src/index.ts";
import {
  buildRoleRunArgs,
  createRoleRunName,
  createRoleRunClaimId,
  findResumableBackgroundRoleRunTasks,
  killActiveSparkRoleRunProcesses,
  listActiveSparkRoleRunProcesses,
  runSparkTask,
  sparkTaskExecutorRoleRef,
  sweepExpiredTaskClaims,
} from "spark-runtime";
import {
  TaskGraph,
  TaskGraphStore,
  TaskGraphStoreConflictError,
  TaskGraphStoreFormatError,
  TaskGraphStoreLockOwnerFormatError,
  TaskGraphStoreLockTimeoutError,
  TaskTodoStoreFormatError,
  TaskTodoStore,
  TASK_PLAN_READINESS_RULES,
  applyIndependentTodoOps,
  collectNonConcreteTaskIssues,
  decideTaskPlanBeforeCreate,
  defaultTaskGraphStore,
  defaultTaskTodoStore,
  normalizeTaskPlan,
  renderNonConcreteTaskIssues,
  renderTaskPlanReadinessRules,
  taskCompletionReadiness,
  taskPlanReadiness,
  type SessionTodoEntry,
} from "pi-tasks";
import {
  cleanupOwnedBackgroundSubroles,
  resumeOwnedBackgroundSubroles,
} from "../packages/spark/src/extension/spark-background-subrole-lifecycle.ts";
import { SparkDagManagerController } from "../packages/spark/src/extension/spark-dag-manager.ts";
import { createSparkRuntimeReadyTaskRunner } from "../packages/spark/src/extension/spark-ready-task-runtime.ts";
import {
  saveCurrentProjectRef,
  sparkSessionOwnerKey,
} from "../packages/spark/src/extension/session-state.ts";

function executionReadyPlan(objective: string): TaskPlan {
  return {
    objective,
    contextRefs: [],
    constraints: [],
    nonGoals: [],
    successCriteria: [`${objective} succeeds`],
    evidenceRequired: [`${objective} evidence is recorded`],
    steps: [objective],
    riskLevel: "normal",
    openQuestions: [],
    askRefs: [],
  };
}

function testDagRunRecord(
  input: Pick<SparkDagRunRecord, "ref" | "status" | "startedAt" | "updatedAt"> &
    Partial<SparkDagRunRecord>,
): SparkDagRunRecord {
  return {
    projectRef: input.projectRef,
    ownerSessionId: input.ownerSessionId,
    dryRun: input.dryRun ?? false,
    maxConcurrency: input.maxConcurrency ?? 1,
    timeoutMs: input.timeoutMs ?? 100,
    finishedAt: input.finishedAt,
    scheduled: input.scheduled ?? 0,
    completed: input.completed ?? 0,
    timedOut: input.timedOut ?? input.status === "timed_out",
    scheduledTaskRefs: input.scheduledTaskRefs ?? [],
    completedTaskRefs: input.completedTaskRefs ?? [],
    taskRunRefs: input.taskRunRefs ?? [],
    errorMessage: input.errorMessage,
    acknowledgedAt: input.acknowledgedAt,
    acknowledgedBySession: input.acknowledgedBySession,
    completionDigest: input.completionDigest ?? [],
    completionFollowUp: input.completionFollowUp,
    ...input,
  };
}

function testSparkContext(cwd: string, sessionName: string) {
  const sessionFile = join(cwd, ".pi-sessions", `${sessionName}.json`);
  return {
    cwd,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getLeafId: () => `${sessionName}-leaf`,
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(await predicate(), "timed out waiting for condition");
}

function assertIndependentTodoStatuses(
  todos: SessionTodoEntry[],
  statuses: Array<SessionTodoEntry["status"]>,
): void {
  assert.deepEqual(
    todos.map((todo) => todo.status),
    statuses,
  );
}

void test("task graph store keeps TODOs out of projects.json and todo store restores them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tasks-"));
  try {
    const file = join(dir, "projects.json");
    const todoFile = join(dir, "todos.json");
    const store = new TaskGraphStore(file);
    const todoStore = new TaskTodoStore(todoFile);
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
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
    assert.equal(loaded.projects()[0]?.title, "Demo");
    assert.equal(loaded.tasks(project.ref).length, 1);
    assert.equal(loaded.currentTask(project.ref), undefined);
    assert.equal(loaded.tasks(project.ref)[0]?.title, "Plan");
    assert.equal(loaded.taskTodos(task.ref).length, 2);
    assert.equal(loaded.todoSummary(task.ref).inProgress, 1);
    assert.doesNotMatch(await readFile(file, "utf8"), /"todos"/);
    assert.match(await readFile(todoFile, "utf8"), /"Read inputs"/);
    assert.deepEqual(
      (await readdir(dir)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("default task TODO store always uses an explicit scoped path", () => {
  const store = defaultTaskTodoStore("/workspace/demo", "leaf:main/session");
  assert.equal(store.filePath, "/workspace/demo/.spark/todos/leaf-main-session.json");
});

void test("independent session TODO reducer preserves one active live item", () => {
  let todos = applyIndependentTodoOps([], [{ op: "init", items: ["Read request", "Patch code"] }]);
  assertIndependentTodoStatuses(todos, ["in_progress", "pending"]);

  const firstId = todos[0]?.id;
  const secondId = todos[1]?.id;
  assert.ok(firstId);
  assert.ok(secondId);

  todos = applyIndependentTodoOps(todos, [
    { op: "start", id: secondId },
    { op: "note", id: secondId, text: "cover behavior, not implementation" },
    { op: "delete", id: firstId },
  ]);
  assertIndependentTodoStatuses(todos, ["deleted", "in_progress"]);
  assert.equal(todos[0]?.deletedAt !== undefined, true);
  assert.deepEqual(todos[1]?.notes, ["cover behavior, not implementation"]);

  todos = applyIndependentTodoOps(todos, [{ op: "restore", id: firstId }]);
  assertIndependentTodoStatuses(todos, ["pending", "in_progress"]);
  assert.equal(todos[0]?.deletedAt, undefined);
  assert.equal(todos.filter((todo) => todo.status === "in_progress").length, 1);
});

void test("task TODO store rejects malformed persisted snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-task-todos-invalid-"));
  try {
    const todoFile = join(dir, "todos.json");
    const todoStore = new TaskTodoStore(todoFile);

    await mkdir(dir, { recursive: true });
    await writeFile(todoFile, "{not-json", "utf8");
    await assert.rejects(
      () => todoStore.load(),
      (error) =>
        error instanceof TaskTodoStoreFormatError &&
        error.filePath === todoFile &&
        /not valid JSON/.test(error.message),
    );

    await writeFile(todoFile, "[]\n", "utf8");
    await assert.rejects(
      () => todoStore.load(),
      (error) =>
        error instanceof TaskTodoStoreFormatError &&
        error.filePath === todoFile &&
        /JSON root must be an object/.test(error.message),
    );

    await writeFile(todoFile, `${JSON.stringify({ version: 2, todos: [] })}\n`, "utf8");
    await assert.rejects(
      () => todoStore.load(),
      (error) =>
        error instanceof TaskTodoStoreFormatError &&
        error.filePath === todoFile &&
        /version must be 1/.test(error.message),
    );

    await writeFile(todoFile, `${JSON.stringify({ version: 1 })}\n`, "utf8");
    await assert.rejects(
      () => todoStore.load(),
      (error) =>
        error instanceof TaskTodoStoreFormatError &&
        error.filePath === todoFile &&
        /todos must be an array/.test(error.message),
    );

    await writeFile(todoFile, `${JSON.stringify({ version: 1, todos: {} })}\n`, "utf8");
    await assert.rejects(
      () => todoStore.load(),
      (error) =>
        error instanceof TaskTodoStoreFormatError &&
        error.filePath === todoFile &&
        /todos must be an array/.test(error.message),
    );

    await writeFile(
      todoFile,
      `${JSON.stringify({
        version: 1,
        todos: [{ taskRef: "task:demo", content: "Plan", status: "unknown" }],
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => todoStore.load(),
      (error) =>
        error instanceof TaskTodoStoreFormatError &&
        error.filePath === todoFile &&
        /todos\[0\]\.status must be a valid TODO status/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task metadata can be updated when a model claims concrete work", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    projectRef: project.ref,
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
  graph.setCurrentTask(project.ref, updated.ref);
  assert.equal(graph.currentTask(project.ref)?.ref, task.ref);
});

void test("todo ops can initialize an empty task and use stable ids", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    projectRef: project.ref,
    title: "Plan",
    description: "plan",
    roleRef: builtinRoleRef("planner"),
    plan: executionReadyPlan("Plan"),
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
  const project = graph.createProject({ title: "Demo", description: "demo" });

  const result = graph.planTasks(project.ref, [
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

void test("task plan readiness distinguishes minimal and execution-ready plans", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const minimal = graph.createTask({
    projectRef: project.ref,
    title: "Minimal",
    description: "minimal task",
    roleRef: builtinRoleRef("worker"),
  });
  const minimalReadiness = graph.taskPlanReadiness(minimal.ref);
  assert.equal(minimalReadiness.ready, false);
  assert.deepEqual(
    minimalReadiness.issues.map((issue) => [issue.kind, issue.remediation]),
    [
      ["missing_success_criteria", "Add at least one observable entry to plan.successCriteria."],
      [
        "missing_evidence_required",
        "Add at least one concrete validation artifact or command to plan.evidenceRequired.",
      ],
    ],
  );

  const blocked = graph.createTask({
    projectRef: project.ref,
    title: "Blocked",
    description: "blocked task",
    roleRef: builtinRoleRef("worker"),
    plan: {
      objective: "Resolve blocked task",
      contextRefs: [],
      constraints: [],
      nonGoals: [],
      successCriteria: ["Decision is made"],
      evidenceRequired: ["Decision artifact is recorded"],
      steps: ["Ask for direction"],
      riskLevel: "normal",
      openQuestions: ["Which direction should we take?"],
      askRefs: [],
    },
  });
  assert.deepEqual(
    graph.taskPlanReadiness(blocked.ref).issues.map((issue) => [issue.kind, issue.remediation]),
    [
      [
        "open_questions",
        "Resolve material questions with ask, then move decisions into askRefs or the plan body.",
      ],
    ],
  );

  const ready = graph.createTask({
    projectRef: project.ref,
    title: "Ready",
    description: "ready task",
    roleRef: builtinRoleRef("worker"),
    plan: {
      objective: "Execute ready task",
      contextRefs: [],
      constraints: [],
      nonGoals: [],
      successCriteria: ["Output is produced"],
      evidenceRequired: ["Test output is attached"],
      steps: ["Run implementation", "Run tests"],
      riskLevel: "normal",
      openQuestions: [],
      askRefs: [],
    },
  });
  assert.deepEqual(graph.taskPlanReadiness(ready.ref), { ready: true, issues: [] });

  const cancelled = graph.createTask({
    projectRef: project.ref,
    title: "Cancelled cleanup",
    description: "cancelled task should not need execution evidence",
    status: "cancelled",
  });
  assert.deepEqual(graph.taskPlanReadiness(cancelled.ref), { ready: true, issues: [] });
});

void test("task plan normalization is a public spark-tasks contract", () => {
  const plan = normalizeTaskPlan(
    {
      objective: "  ",
      contextRefs: [" docs/plan.md ", "docs/plan.md", ""],
      constraints: [" keep scope tight ", "keep scope tight"],
      nonGoals: [" "],
      successCriteria: [" command passes ", "command passes"],
      evidenceRequired: [" focused test output "],
      steps: ["  "],
      decompositionRationale: "  avoid a broad rewrite  ",
      riskLevel: "urgent" as TaskPlan["riskLevel"],
      openQuestions: [" "],
      askRefs: [" ask:decision-1 ", "ask:decision-1"] as TaskPlan["askRefs"],
    },
    "  Implement focused change  ",
    "Fallback title",
  );

  assert.deepEqual(plan, {
    objective: "Implement focused change",
    contextRefs: ["docs/plan.md"],
    constraints: ["keep scope tight"],
    nonGoals: [],
    successCriteria: ["command passes"],
    evidenceRequired: ["focused test output"],
    steps: ["Implement focused change"],
    decompositionRationale: "avoid a broad rewrite",
    riskLevel: "normal",
    openQuestions: [],
    askRefs: ["ask:decision-1"],
  });
});

void test("task plan input rejects standalone design placeholders as a package contract", () => {
  const issues = collectNonConcreteTaskIssues([
    {
      name: "design-results",
      title: "设计 DAG 子 agent 完成结果的可见机制",
      description: "Decide the visibility model.",
      kind: "plan",
      status: "pending",
      plan: executionReadyPlan("Decide result visibility."),
    },
    {
      name: "retire-old-plan",
      title: "Plan legacy cleanup",
      description: "Already cancelled placeholder.",
      kind: "plan",
      status: "cancelled",
    },
    {
      name: "implement-results",
      title: "Implement DAG result visibility",
      description: "Implement the selected visibility model.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Implement result visibility."),
    },
  ]);

  assert.deepEqual(issues, [
    {
      name: "design-results",
      title: "设计 DAG 子 agent 完成结果的可见机制",
      message:
        "kind=plan is reserved for planning logic; create concrete implement/review/research/validation work and put design details in task.plan",
    },
  ]);
  assert.match(renderNonConcreteTaskIssues(issues), /task_not_concrete/);
  assert.match(renderNonConcreteTaskIssues(issues), /embed the chosen design/);
});

void test("task plan decision uses readiness without UI fallback", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const missingPlan = {
    ...graph.createTask({
      projectRef: project.ref,
      title: "Missing plan",
      description: "missing plan task",
      status: "pending",
    }),
    plan: undefined,
  };

  const blocked = decideTaskPlanBeforeCreate(missingPlan);
  assert.equal(blocked.asked, false);
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.plan, undefined);
  assert.deepEqual(
    blocked.issues.map((issue) => issue.kind),
    ["missing_plan"],
  );
  assert.match(blocked.summary ?? "", /fix: Add a concrete plan/);

  const ready = graph.createTask({
    projectRef: project.ref,
    title: "Ready plan",
    description: "ready plan task",
    status: "pending",
    plan: executionReadyPlan("Run focused work"),
  });
  const accepted = decideTaskPlanBeforeCreate(ready);
  assert.equal(accepted.asked, false);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.blocked, false);
  assert.deepEqual(accepted.plan, ready.plan);
  assert.deepEqual(accepted.issues, []);
});

void test("task plan readiness provides remediation for every issue kind", () => {
  const noPlan = taskPlanReadiness({ status: "pending", plan: undefined });
  assert.deepEqual(
    noPlan.issues.map((issue) => [issue.kind, issue.remediation]),
    [
      [
        "missing_plan",
        "Add a concrete plan with objective, success criteria, evidence requirements, and steps.",
      ],
    ],
  );

  const issues = taskPlanReadiness({
    status: "pending",
    plan: {
      objective: "",
      contextRefs: [],
      constraints: [],
      nonGoals: [],
      successCriteria: [],
      evidenceRequired: [],
      steps: [],
      riskLevel: "normal",
      openQuestions: ["Which direction?"],
      askRefs: [],
    },
  }).issues;

  assert.deepEqual(
    issues.map((issue) => [issue.kind, issue.remediation]),
    [
      [
        "missing_objective",
        "Fill plan.objective with the specific outcome this task should achieve.",
      ],
      ["missing_success_criteria", "Add at least one observable entry to plan.successCriteria."],
      [
        "missing_evidence_required",
        "Add at least one concrete validation artifact or command to plan.evidenceRequired.",
      ],
      ["missing_steps", "Add at least one concrete execution step to plan.steps."],
      [
        "open_questions",
        "Resolve material questions with ask, then move decisions into askRefs or the plan body.",
      ],
    ],
  );
  assert.equal(
    issues.every((issue) => issue.remediation.length > 0),
    true,
  );
});

void test("task plan readiness rules render from the public spark-tasks contract", () => {
  const renderedRules = renderTaskPlanReadinessRules();
  const ruleKinds = TASK_PLAN_READINESS_RULES.map((rule) => rule.kind);
  assert.deepEqual(ruleKinds, [
    "missing_plan",
    "missing_objective",
    "missing_success_criteria",
    "missing_evidence_required",
    "missing_steps",
    "open_questions",
  ]);
  for (const rule of TASK_PLAN_READINESS_RULES) {
    assert.equal(rule.severity, "blocking");
    assert.ok(renderedRules.includes(`${rule.kind}:`));
    assert.ok(renderedRules.includes(rule.description));
  }
});

void test("task completion readiness requires output artifacts for declared evidence", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    projectRef: project.ref,
    title: "Needs evidence",
    description: "needs evidence",
    plan: executionReadyPlan("Needs evidence"),
  });

  const missing = taskCompletionReadiness(task);
  assert.equal(missing.ready, false);
  assert.deepEqual(
    missing.issues.map((issue) => issue.kind),
    ["missing_completion_evidence"],
  );
  assert.deepEqual(missing.issues[0]?.evidenceRequired, task.plan?.evidenceRequired);

  const withArtifact = graph.attachOutputArtifact(task.ref, "artifact:evidence" as const);
  assert.deepEqual(taskCompletionReadiness(withArtifact), { ready: true, issues: [] });
});

void test("ready tasks require completed dependencies and execution-ready plan, not stored role", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const prerequisite = graph.createTask({
    projectRef: project.ref,
    title: "Prerequisite",
    description: "prerequisite",
    status: "pending",
    plan: {
      objective: "Complete prerequisite",
      contextRefs: [],
      constraints: [],
      nonGoals: [],
      successCriteria: ["Prerequisite done"],
      evidenceRequired: ["Done status"],
      steps: ["Do prerequisite"],
      riskLevel: "normal",
      openQuestions: [],
      askRefs: [],
    },
  });
  const dependent = graph.createTask({
    projectRef: project.ref,
    title: "Dependent",
    description: "dependent",
    roleRef: builtinRoleRef("worker"),
    plan: {
      objective: "Complete dependent",
      contextRefs: [],
      constraints: [],
      nonGoals: [],
      successCriteria: ["Dependent done"],
      evidenceRequired: ["Done status"],
      steps: ["Do dependent"],
      riskLevel: "normal",
      openQuestions: [],
      askRefs: [],
    },
  });
  const minimal = graph.createTask({
    projectRef: project.ref,
    title: "Minimal",
    description: "minimal",
  });
  graph.addDependency(dependent.ref, prerequisite.ref);

  assert.deepEqual(
    graph.readyTasks().map((task) => task.ref),
    [prerequisite.ref],
  );
  graph.setTaskStatus(prerequisite.ref, "done");
  assert.deepEqual(
    graph.readyTasks().map((task) => task.ref),
    [dependent.ref],
  );
  assert.equal(
    graph.readyTasks().some((task) => task.ref === minimal.ref),
    false,
  );
});

void test("adding unmet dependency moves default-ready task back to pending", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const prerequisite = graph.createTask({
    projectRef: project.ref,
    title: "Prerequisite",
    description: "prerequisite",
    status: "pending",
    plan: executionReadyPlan("Complete prerequisite"),
  });
  const dependent = graph.createTask({
    projectRef: project.ref,
    title: "Dependent",
    description: "dependent",
    plan: executionReadyPlan("Complete dependent"),
  });

  assert.equal(dependent.status, "ready");
  graph.addDependency(dependent.ref, prerequisite.ref);
  assert.equal(graph.getTask(dependent.ref).status, "pending");
  graph.setTaskStatus(prerequisite.ref, "done");
  graph.enqueueReadyTasks(project.ref);
  assert.equal(graph.getTask(dependent.ref).status, "ready");
});

void test("task cancellation is blocked while non-cancelled tasks depend on it", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const prerequisite = graph.createTask({
    projectRef: project.ref,
    title: "Prerequisite",
    description: "Must remain available while depended on.",
    status: "pending",
    plan: executionReadyPlan("Keep prerequisite"),
  });
  const dependent = graph.createTask({
    projectRef: project.ref,
    title: "Dependent",
    description: "Depends on prerequisite.",
    status: "pending",
    plan: executionReadyPlan("Use prerequisite"),
  });
  graph.addDependency(dependent.ref, prerequisite.ref);

  assert.throws(
    () => graph.setTaskStatus(prerequisite.ref, "cancelled"),
    /task has dependent tasks and cannot be cancelled/,
  );
  assert.throws(
    () => graph.updateTask(prerequisite.ref, { supersededBy: [dependent.ref] }),
    DependencyError,
  );
  assert.equal(graph.getTask(prerequisite.ref).status, "pending");

  graph.setTaskStatus(dependent.ref, "cancelled");
  assert.equal(graph.setTaskStatus(prerequisite.ref, "cancelled").status, "cancelled");
});

void test("non-cancelled tasks cannot be made dependent on cancelled tasks", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const cancelled = graph.createTask({
    projectRef: project.ref,
    title: "Cancelled prerequisite",
    description: "Already cancelled.",
    status: "cancelled",
  });
  const dependent = graph.createTask({
    projectRef: project.ref,
    title: "Dependent",
    description: "Should not depend on cancelled work.",
    status: "pending",
    plan: executionReadyPlan("Do dependent"),
  });

  assert.throws(
    () => graph.addDependency(dependent.ref, cancelled.ref),
    /task cannot depend on cancelled task/,
  );
});

void test("task graph store rejects malformed persisted snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-graph-store-invalid-"));
  try {
    const file = join(dir, "projects.json");
    const store = new TaskGraphStore(file);
    assert.equal(await store.load(), null);
    await mkdir(dir, { recursive: true });

    await writeFile(file, "{not-json", "utf8");
    await assert.rejects(
      () => store.load(),
      (error) =>
        error instanceof TaskGraphStoreFormatError &&
        error.filePath === file &&
        /not valid JSON/.test(error.message),
    );

    await writeFile(file, "[]\n", "utf8");
    await assert.rejects(
      () => store.load(),
      (error) =>
        error instanceof TaskGraphStoreFormatError &&
        error.filePath === file &&
        /JSON root must be an object/.test(error.message),
    );

    await writeFile(file, `${JSON.stringify({ tasks: [], dependencies: [] })}\n`, "utf8");
    await assert.rejects(
      () => store.load(),
      (error) =>
        error instanceof TaskGraphStoreFormatError &&
        error.filePath === file &&
        /not valid task graph snapshot/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task graph store serializes read-modify-write updates with a filesystem lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-lock-"));
  try {
    const store = new TaskGraphStore(join(dir, "projects.json"));
    const graph = new TaskGraph();
    graph.createProject({ title: "Demo", description: "demo" });
    await store.save(graph);

    const first = store.update(async (locked) => {
      const [project] = locked.projects();
      assert.ok(project);
      await new Promise((resolve) => setTimeout(resolve, 50));
      locked.createTask({
        projectRef: project.ref,
        name: "first",
        title: "First",
        description: "first",
      });
    });
    const second = store.update(async (locked) => {
      const [project] = locked.projects();
      assert.ok(project);
      locked.createTask({
        projectRef: project.ref,
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
    const file = join(dir, "projects.json");
    const store = new TaskGraphStore(file);
    const graph = new TaskGraph();
    graph.createProject({ title: "Demo", description: "demo" });
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
    const file = join(dir, "projects.json");
    const store = new TaskGraphStore(file);
    const graph = new TaskGraph();
    graph.createProject({ title: "Demo", description: "demo" });
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

void test("task graph store rejects corrupt lock owner metadata instead of using mtime fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-lock-owner-corrupt-"));
  try {
    const file = join(dir, "projects.json");
    const store = new TaskGraphStore(file);
    const graph = new TaskGraph();
    graph.createProject({ title: "Demo", description: "demo" });
    await store.save(graph);

    const lockPath = `${file}.lock`;
    const ownerPath = join(lockPath, "owner.json");
    await mkdir(lockPath);
    await writeFile(ownerPath, "{not-json", "utf8");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    await utimes(ownerPath, old, old);

    await assert.rejects(
      () => store.update(() => undefined, { timeoutMs: 10, retryIntervalMs: 1, staleMs: 60_000 }),
      TaskGraphStoreLockOwnerFormatError,
    );
    await stat(lockPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task graph store direct save rejects stale loaded snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-stale-save-"));
  try {
    const store = new TaskGraphStore(join(dir, "projects.json"));
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "claim-me",
      title: "Claim me",
      description: "claim me",
      plan: executionReadyPlan("Claim me"),
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
    const store = new TaskGraphStore(join(dir, "projects.json"));
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "role-task",
      title: "Role task",
      description: "role task",
    });
    const other = graph.createTask({
      projectRef: project.ref,
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
      projectRef: project.ref,
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
      loaded.runs(project.ref).find((run) => run.ref === "run:role-task")?.status,
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
    const store = new TaskGraphStore(join(dir, "projects.json"));
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "claim-me",
      title: "Claim me",
      description: "claim me",
      plan: executionReadyPlan("Claim me"),
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
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const prerequisite = graph.createTask({
    projectRef: project.ref,
    title: "Prerequisite",
    description: "prerequisite",
  });
  const dependent = graph.createTask({
    projectRef: project.ref,
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

void test("task graph blocks role-run claims until task plan is execution-ready", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    projectRef: project.ref,
    title: "Needs plan",
    description: "needs plan",
  });

  assert.throws(
    () =>
      graph.claimTask(task.ref, {
        kind: "role-run",
        claimedBy: "run:worker",
        roleRef: builtinRoleRef("worker"),
        sessionId: "session:a",
        runName: "worker",
        leaseMs: 60_000,
      }),
    /task plan is not execution-ready.*success criteria.*evidence requirements/i,
  );

  const mainClaim = graph.claimTask(task.ref, {
    kind: "main",
    claimedBy: "session:a",
    sessionId: "session:a",
    leaseMs: 60_000,
  });
  assert.equal(mainClaim.status, "running");
});

void test("task graph enforces one unfinished main claim per session", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const first = graph.createTask({
    projectRef: project.ref,
    title: "First",
    description: "first",
  });
  const second = graph.createTask({
    projectRef: project.ref,
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
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const first = graph.createTask({
    projectRef: project.ref,
    name: "first",
    title: "First",
    description: "first",
  });
  const second = graph.createTask({
    projectRef: project.ref,
    name: "second",
    title: "Second",
    description: "second",
  });

  assert.equal(graph.updateTask(first.ref, { name: "first" }).name, "first");
  assert.throws(
    () => graph.updateTask(second.ref, { name: "first" }),
    /task name already exists in project: first/,
  );
});

void test("task graph allows one main claim and multiple distinct role-run claims per session", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const main = graph.createTask({
    projectRef: project.ref,
    title: "Main",
    description: "main",
  });
  const worker = graph.createTask({
    projectRef: project.ref,
    title: "Worker",
    description: "worker",
    plan: executionReadyPlan("Worker"),
  });
  const reviewer = graph.createTask({
    projectRef: project.ref,
    title: "Reviewer",
    description: "reviewer",
    plan: executionReadyPlan("Reviewer"),
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
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const first = graph.createTask({
    projectRef: project.ref,
    title: "First worker",
    description: "first worker",
    plan: executionReadyPlan("First worker"),
  });
  const second = graph.createTask({
    projectRef: project.ref,
    title: "Second worker",
    description: "second worker",
    plan: executionReadyPlan("Second worker"),
  });
  const otherSession = graph.createTask({
    projectRef: project.ref,
    title: "Other session worker",
    description: "other session worker",
    plan: executionReadyPlan("Other session worker"),
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
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const main = graph.createTask({
    projectRef: project.ref,
    title: "Main",
    description: "main",
  });
  const roleRun = graph.createTask({
    projectRef: project.ref,
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
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const mainTask = graph.createTask({
    projectRef: project.ref,
    title: "Main attributed",
    description: "main attributed",
  });
  const roleRunTask = graph.createTask({
    projectRef: project.ref,
    title: "Role-run attributed",
    description: "role-run attributed",
    plan: executionReadyPlan("Role-run attributed"),
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
  assert.deepEqual(mainDone.finishedBy, { sessionId: "session:a" });

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
  });
  assert.deepEqual(restored.getTask(roleRunTask.ref).finishedBy, {
    sessionId: "session:a",
    runName: "worker-1234",
  });
});

void test("claims without expiresAt are dropped while loading legacy snapshots", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    projectRef: project.ref,
    name: "legacy-claim",
    title: "Legacy claim",
    description: "Legacy stale claim without expiry.",
    status: "running",
  });
  const snapshot = graph.snapshot();
  const [snapshotTask] = snapshot.tasks;
  assert.ok(snapshotTask);
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
});

void test("legacy agent-shaped role fields are rejected at task graph load boundaries", () => {
  function roleSnapshot() {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "role-boundary",
      title: "Role boundary",
      description: "Use current role terminology.",
      status: "running",
    });
    const runRef = newRef("run", "role-boundary-run");
    graph.recordRun({
      ref: runRef,
      projectRef: project.ref,
      taskRef: task.ref,
      roleRef: builtinRoleRef("worker"),
      runName: "worker-current",
      status: "running",
      outputArtifacts: [],
    });
    return { snapshot: graph.snapshot(), runRef };
  }

  const taskSnapshot = roleSnapshot().snapshot;
  (taskSnapshot.tasks[0] as (typeof taskSnapshot.tasks)[number] & { agentRef?: string }).agentRef =
    "agent:builtin-worker";
  assert.throws(() => TaskGraph.fromSnapshot(taskSnapshot), /task uses legacy agentRef/);

  const attributionSnapshot = roleSnapshot().snapshot;
  attributionSnapshot.tasks[0]!.finishedBy = {
    sessionId: "session:legacy",
    agentName: "reviewer-legacy",
  } as unknown as NonNullable<(typeof attributionSnapshot.tasks)[number]["finishedBy"]>;
  assert.throws(
    () => TaskGraph.fromSnapshot(attributionSnapshot),
    /task attribution uses legacy agentName/,
  );

  const claimSnapshot = roleSnapshot();
  claimSnapshot.snapshot.tasks[0]!.claim = {
    kind: "subagent",
    claimedBy: "session:legacy+worker-legacy",
    roleRef: builtinRoleRef("worker"),
    runName: "worker-legacy",
    sessionId: "session:legacy",
    runRef: claimSnapshot.runRef,
    claimedAt: "2026-05-18T00:00:00.000Z",
    heartbeatAt: "2026-05-18T00:00:00.000Z",
    expiresAt: "2026-05-18T00:01:00.000Z",
  } as unknown as NonNullable<(typeof claimSnapshot.snapshot.tasks)[number]["claim"]>;
  assert.throws(
    () => TaskGraph.fromSnapshot(claimSnapshot.snapshot),
    /task claim kind must be main or role-run/,
  );

  const runSnapshot = roleSnapshot().snapshot;
  (runSnapshot.runs[0] as (typeof runSnapshot.runs)[number] & { agentRef?: string }).agentRef =
    "agent:builtin-worker";
  assert.throws(() => TaskGraph.fromSnapshot(runSnapshot), /task run uses legacy agentRef/);
});

void test("task claims use a lease that can expire", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    projectRef: project.ref,
    name: "lease-check",
    title: "Lease check",
    description: "Exercise task claim timeout behavior.",
  });

  const runRef = newRef("run");
  graph.recordRun({
    ref: runRef,
    projectRef: project.ref,
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
  assert.equal(graph.runs(project.ref)[0]?.status, "cancelled");
  assert.equal(graph.runs(project.ref)[0]?.failureKind, "claim_stale");
});

void test("expired claim sweeper persists retryable stale claims", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-sweep-"));
  try {
    const store = new TaskGraphStore(join(dir, "projects.json"));
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "sweep-claim",
      title: "Sweep claim",
      description: "Exercise persisted claim sweeping.",
      plan: executionReadyPlan("Sweep claim"),
    });
    const runRef = newRef("run");
    graph.recordRun({
      ref: runRef,
      projectRef: project.ref,
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
    assert.equal(loaded.runs(project.ref)[0]?.status, "cancelled");
    assert.equal(loaded.runs(project.ref)[0]?.failureKind, "claim_stale");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("expired claim sweeper skips persistence when no claims expire", async () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    projectRef: project.ref,
    name: "fresh-claim",
    title: "Fresh claim",
    description: "Exercise no-op claim sweeping.",
    plan: executionReadyPlan("Fresh claim"),
  });
  graph.claimTask(task.ref, {
    kind: "main",
    claimedBy: "session:active",
    sessionId: "session:active",
    now: "2026-05-18T00:00:00.000Z",
    leaseMs: 10_000,
  });
  let saveCalls = 0;
  const store: Pick<TaskGraphStore, "withLock" | "load" | "save"> = {
    withLock: async (fn) => fn(),
    load: async () => graph,
    save: async () => {
      saveCalls += 1;
    },
  };

  const result = await sweepExpiredTaskClaims(store, "2026-05-18T00:00:01.000Z");
  assert.equal(result.saved, false);
  assert.equal(result.expired.length, 0);
  assert.equal(saveCalls, 0);
  assert.equal(graph.getTask(task.ref).claim?.claimedBy, "session:active");
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

void test("Spark runtime exposes one executor role assignment contract", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const research = graph.createTask({
    projectRef: project.ref,
    title: "Research",
    description: "research",
    kind: "research",
  });
  const plan = graph.createTask({
    projectRef: project.ref,
    title: "Plan",
    description: "plan",
    kind: "plan",
  });
  const review = graph.createTask({
    projectRef: project.ref,
    title: "Review",
    description: "review",
    kind: "review",
  });
  const implementation = graph.createTask({
    projectRef: project.ref,
    title: "Build",
    description: "build",
    kind: "implement",
  });
  const explicit = graph.createTask({
    projectRef: project.ref,
    title: "Explicit",
    description: "explicit",
    kind: "implement",
    roleRef: builtinRoleRef("reviewer"),
  });

  assert.equal(sparkTaskExecutorRoleRef(research), builtinRoleRef("scout"));
  assert.equal(sparkTaskExecutorRoleRef(plan), builtinRoleRef("planner"));
  assert.equal(sparkTaskExecutorRoleRef(review), builtinRoleRef("reviewer"));
  assert.equal(sparkTaskExecutorRoleRef(implementation), builtinRoleRef("worker"));
  assert.equal(
    sparkTaskExecutorRoleRef(implementation, builtinRoleRef("planner")),
    builtinRoleRef("planner"),
  );
  assert.equal(
    sparkTaskExecutorRoleRef(explicit, builtinRoleRef("planner")),
    builtinRoleRef("reviewer"),
  );
});

void test("resumable background role-runs include owned stale claims", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const owned = graph.createTask({
    projectRef: project.ref,
    title: "Owned background",
    description: "owned",
    roleRef: builtinRoleRef("worker"),
    status: "running",
    plan: executionReadyPlan("Owned background"),
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
    projectRef: project.ref,
    title: "Other background",
    description: "other",
    roleRef: builtinRoleRef("reviewer"),
    status: "running",
    plan: executionReadyPlan("Other background"),
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
  assert.equal(args.at(-1)?.includes("use the canonical ask tool"), true);
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

void test("runSparkTask includes plan and a bounded active TODO preview in role instruction", async () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    projectRef: project.ref,
    name: "bounded-preview",
    title: "Implement bounded preview",
    description: "Implement the bounded child prompt preview.",
    roleRef: builtinRoleRef("worker"),
    plan: {
      ...executionReadyPlan("Implement the bounded child prompt preview."),
      constraints: ["Do not dump every TODO into the prompt."],
      nonGoals: ["Do not redesign the role runner."],
    },
  });
  graph.applyTodoOps(task.ref, [
    {
      op: "init",
      items: ["First active TODO", "Second active TODO", "Third hidden TODO"],
    },
  ]);
  const [firstTodo, secondTodo] = graph.taskTodos(task.ref);
  assert.ok(firstTodo);
  assert.ok(secondTodo);
  graph.applyTodoOps(task.ref, [{ op: "start", id: firstTodo.id }]);
  const dir = await mkdtemp(join(tmpdir(), "spark-task-instruction-preview-"));
  try {
    const fakePi = join(dir, "fake-pi.cjs");
    const argsPath = join(dir, "args.json");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
        "process.stdout.write(JSON.stringify({ type: 'done' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    await runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      timeoutMs: 5_000,
      claim: { sessionId: "session:preview" },
    });

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    const prompt = args.at(-1) ?? "";
    assert.match(prompt, /Task plan \(execution contract\):/);
    assert.match(prompt, /- Objective: Implement the bounded child prompt preview\./);
    assert.match(prompt, /- Constraints:\n  - Do not dump every TODO into the prompt\./);
    assert.match(prompt, /Current task TODO preview \(showing 2\/3 active items/);
    assert.match(prompt, new RegExp(`\\[in_progress\\] ${firstTodo.id}: First active TODO`));
    assert.match(prompt, new RegExp(`\\[pending\\] ${secondTodo.id}: Second active TODO`));
    assert.doesNotMatch(prompt, /Third hidden TODO/);
    assert.match(prompt, /1 more TODO\(s\) hidden/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkTask marks child timeout failed and clears the task claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-timeout-pi-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Plan",
      description: "plan",
      roleRef: builtinRoleRef("planner"),
      plan: executionReadyPlan("Plan"),
    });
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);
    const registry = new RoleRegistry();
    const run = await runSparkTask({
      graph,
      taskRef: task.ref,
      registry,
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      timeoutMs: 1,
      claim: { sessionId: "session:parent" },
    });

    assert.equal(run.status, "failed");
    assert.equal(run.failureKind, "runtime_timeout");
    assert.match(run.errorMessage ?? "", /timed out/);
    assert.equal(run.completionSummary?.status, "failed");
    assert.equal(run.completionSummary?.runRef, run.ref);
    assert.equal(graph.getTask(task.ref).status, "failed");
    assert.equal(graph.getTask(task.ref).claim, undefined);
    assert.match(graph.getTask(task.ref).finishedBy?.runName ?? "", /^planner-/);
    assert.match(run.runName ?? "", /^planner-/);
    assert.equal(run.ownerSessionId, "session:parent");
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
  } finally {
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkTask fails loudly when claim heartbeat persistence fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-heartbeat-failure-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Plan",
      description: "plan",
      roleRef: builtinRoleRef("planner"),
      plan: executionReadyPlan("Plan"),
    });
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);

    let heartbeatAttempts = 0;
    await assert.rejects(
      () =>
        runSparkTask({
          graph,
          taskRef: task.ref,
          registry: new RoleRegistry(),
          cwd: dir,
          dryRun: false,
          piCommand: fakePi,
          timeoutMs: 5_000,
          heartbeatIntervalMs: 5,
          onHeartbeat: () => {
            heartbeatAttempts += 1;
            throw new Error("heartbeat persistence failed");
          },
          claim: { sessionId: "session:parent" },
        }),
      /task claim heartbeat failed: heartbeat persistence failed/,
    );

    assert.equal(heartbeatAttempts, 1);
    assert.equal(graph.getTask(task.ref).status, "failed");
    assert.equal(graph.getTask(task.ref).claim, undefined);
    const failedRuns = graph.runs(project.ref).filter((run) => run.taskRef === task.ref);
    assert.equal(failedRuns.length, 1);
    assert.equal(failedRuns[0]?.status, "failed");
    assert.equal(failedRuns[0]?.failureKind, "runtime_error");
    assert.match(failedRuns[0]?.errorMessage ?? "", /task claim heartbeat failed/);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((entry) => entry.runRef === failedRuns[0]?.ref),
      false,
    );
  } finally {
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    await rm(dir, { recursive: true, force: true });
  }
});

void test("timed-out Spark role-run process remains killable after task failure", async () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    projectRef: project.ref,
    title: "Plan",
    description: "plan",
    roleRef: builtinRoleRef("planner"),
    plan: executionReadyPlan("Plan"),
  });
  const dir = await mkdtemp(join(tmpdir(), "spark-kill-pi-"));
  try {
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);\n",
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
      timeoutMs: 1,
      claim: { sessionId: "session:parent" },
    });

    assert.equal(run.status, "failed");
    assert.equal(run.failureKind, "runtime_timeout");
    assert.equal(graph.getTask(task.ref).status, "failed");
    assert.equal(graph.getTask(task.ref).claim, undefined);
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

void test("background cleanup does not kill role-runs without an owned task graph", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-shutdown-scope-"));
  let runRef: RunRef | undefined;
  let runPromise: Promise<unknown> | undefined;
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Plan",
      description: "plan",
      roleRef: builtinRoleRef("planner"),
      plan: executionReadyPlan("Plan"),
    });
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);

    runPromise = runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      timeoutMs: 10_000,
      claim: { sessionId: "session:owner" },
    }).catch((error: unknown) => error);
    await waitFor(() => listActiveSparkRoleRunProcesses().some((entry) => entry.cwd === dir));
    const activeRun = listActiveSparkRoleRunProcesses().find((entry) => entry.cwd === dir);
    assert.ok(activeRun);
    runRef = activeRun.runRef;

    assert.equal(
      listActiveSparkRoleRunProcesses().some((entry) => entry.runRef === runRef),
      true,
    );

    const missingGraphDir = join(dir, "missing-graph");
    await mkdir(missingGraphDir, { recursive: true });
    const killed = await cleanupOwnedBackgroundSubroles(
      missingGraphDir,
      testSparkContext(missingGraphDir, "other"),
      "test",
    );

    assert.equal(killed, 0);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((entry) => entry.runRef === runRef),
      true,
    );
  } finally {
    if (runRef) await killActiveSparkRoleRunProcesses({ runRef, forceAfterMs: 0, waitMs: 1_000 });
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    await runPromise?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

void test("background resume propagates TODO persistence failures without rewriting task status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-resume-persistence-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const ctx = testSparkContext(dir, "resume-owner");
    const ownerSessionId = sparkSessionOwnerKey(ctx);
    const runName = "resume-worker";
    const claimedBy = createRoleRunClaimId(ownerSessionId, runName);
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Plan",
      description: "plan",
      roleRef: builtinRoleRef("worker"),
      plan: executionReadyPlan("Plan"),
    });
    graph.claimTask(task.ref, {
      kind: "role-run",
      claimedBy,
      sessionId: ownerSessionId,
      runName,
      roleRef: builtinRoleRef("worker"),
      leaseMs: 60_000,
    });
    await defaultTaskGraphStore(dir).save(graph);

    let runTaskCalls = 0;
    await assert.rejects(
      () =>
        resumeOwnedBackgroundSubroles(dir, ctx, {
          runTask: async ({ graph: runningGraph, taskRef }) => {
            runTaskCalls += 1;
            const taskAfterClaim = runningGraph.getTask(taskRef);
            const finishedAt = nowIso();
            const run = runningGraph.recordRun({
              ref: newRef("run"),
              projectRef: taskAfterClaim.projectRef,
              taskRef,
              roleRef: taskAfterClaim.roleRef,
              runName,
              ownerSessionId,
              status: "succeeded",
              startedAt: finishedAt,
              finishedAt,
              outputArtifacts: [],
            });
            runningGraph.setTaskStatus(taskRef, "done");
            await writeFile(join(dir, ".spark", "todos"), "not a directory", "utf8");
            return run;
          },
        }),
      (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        assert.ok(code === "EEXIST" || code === "ENOTDIR", `unexpected error code: ${code}`);
        return true;
      },
    );

    assert.equal(runTaskCalls, 1);
    const stored = await defaultTaskGraphStore(dir).load();
    assert.ok(stored);
    assert.equal(stored.getTask(task.ref).status, "done");
    assert.equal(stored.getTask(task.ref).claim, undefined);
    assert.equal(
      stored
        .runs(project.ref)
        .some(
          (run) =>
            run.status === "failed" &&
            /not a directory|EEXIST|ENOTDIR/.test(run.errorMessage ?? ""),
        ),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG manager reports widget refresh failures without failing completed DAG work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-refresh-failure-"));
  const previousPath = process.env.PATH;
  const previousPiRolesHome = process.env.PI_ROLES_HOME;
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const binDir = join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    const fakePi = join(binDir, "pi");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'done', ok: true }) + '\\n');\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);
    process.env.PATH = `${binDir}${previousPath ? `:${previousPath}` : ""}`;
    process.env.PI_ROLES_HOME = dir;
    await defaultUserRoleModelBindingStore(dir).save({
      roleRef: builtinRoleRef("worker"),
      model: "test-model",
      source: "user",
      validatedAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
      validationCommand: "test",
    });

    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Refresh should not fail DAG",
      description: "complete work even if widget refresh fails",
      roleRef: builtinRoleRef("worker"),
      status: "pending",
      plan: executionReadyPlan("Refresh should not fail DAG"),
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "dag-refresh-failure");
    await saveCurrentProjectRef(dir, ctx, project.ref);
    const notifications: Array<{ message: string; level?: string }> = [];
    let refreshCalls = 0;
    const manager = new SparkDagManagerController({
      refreshSparkWidget: async () => {
        refreshCalls += 1;
        throw new Error("widget unavailable");
      },
    });

    const result = await manager.runOnce(dir, {
      ...ctx,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    });

    const stored = await defaultTaskGraphStore(dir).load();
    assert.ok(stored);
    const dagStatus = await defaultSparkDagRunStore(dir).status();
    assert.equal(result.continuePolling, false);
    assert.equal(stored.getTask(task.ref).status, "done");
    assert.equal(dagStatus.lastRun?.status, "succeeded");
    assert.equal(dagStatus.lastRun?.errorMessage, undefined);
    assert.ok(refreshCalls > 0);
    assert.ok(
      notifications.some(
        (entry) =>
          entry.level === "warning" &&
          /Spark widget refresh failed: widget unavailable/.test(entry.message),
      ),
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPiRolesHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousPiRolesHome;
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store persists manager lifecycle and task progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-store-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const projectRef = newRef("proj");
    const taskRef = newRef("task");
    const taskRunRef = newRef("run");
    const dagRun = await store.startRun({
      projectRef,
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
        projectRef,
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
    assert.equal(
      followUp.summary,
      `Spark workflow run: ${dagRun.ref} succeeded: scheduled 1, completed 1.`,
    );
    assert.deepEqual(followUp.nextActions, [
      "Review task outputs and continue with newly unblocked ready tasks if any.",
    ]);

    const status = await store.status();
    assert.equal(status.manager.status, "idle");
    assert.equal(status.lastRun?.ref, dagRun.ref);
    assert.equal(status.succeeded, 1);
    assert.equal(status.running, 0);
    assert.equal(status.failed, 0);
    assert.equal(status.stale, 0);
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

void test("Spark DAG run store serializes concurrent task progress updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-rmw-lock-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const projectRef = newRef("proj");
    const dagRun = await store.startRun({
      projectRef,
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 2,
      timeoutMs: 1_000,
    });
    const firstTaskRef = newRef("task");
    const secondTaskRef = newRef("task");
    const firstRunRef = newRef("run");
    const secondRunRef = newRef("run");

    await Promise.all([
      store.recordSchedule(dagRun.ref, {
        taskRef: firstTaskRef,
        runRef: firstRunRef,
        scheduled: 1,
      }),
      store.recordSchedule(dagRun.ref, {
        taskRef: secondTaskRef,
        runRef: secondRunRef,
        scheduled: 1,
      }),
    ]);

    const snapshot = await store.load();
    const [record] = snapshot.runs;
    assert.ok(record);
    assert.equal(record.ref, dagRun.ref);
    assert.equal(record.scheduled, 2);
    assert.deepEqual(new Set(record.scheduledTaskRefs), new Set([firstTaskRef, secondTaskRef]));
    assert.deepEqual(new Set(record.taskRunRefs), new Set([firstRunRef, secondRunRef]));
    assert.deepEqual(
      (await readdir(join(dir, ".spark"))).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store rejects malformed persisted snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-store-invalid-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    await mkdir(join(dir, ".spark"), { recursive: true });

    await writeFile(store.filePath, "{not-json", "utf8");
    await assert.rejects(
      () => store.load(),
      (error) =>
        error instanceof SparkDagRunStoreFormatError &&
        error.filePath === store.filePath &&
        /not valid JSON/.test(error.message),
    );

    await writeFile(store.filePath, "[]\n", "utf8");
    await assert.rejects(
      () => store.load(),
      (error) =>
        error instanceof SparkDagRunStoreFormatError &&
        error.filePath === store.filePath &&
        /JSON root must be an object/.test(error.message),
    );

    await writeFile(
      store.filePath,
      `${JSON.stringify({ version: 2, manager: { status: "idle" }, runs: [] })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => store.load(),
      (error) =>
        error instanceof SparkDagRunStoreFormatError &&
        error.filePath === store.filePath &&
        /version must be 1/.test(error.message),
    );

    await writeFile(store.filePath, `${JSON.stringify({ version: 1, runs: [] })}\n`, "utf8");
    await assert.rejects(
      () => store.load(),
      (error) =>
        error instanceof SparkDagRunStoreFormatError &&
        error.filePath === store.filePath &&
        /manager must be an object/.test(error.message),
    );

    await writeFile(
      store.filePath,
      `${JSON.stringify({ version: 1, manager: { status: "idle" }, runs: {} })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => store.load(),
      (error) =>
        error instanceof SparkDagRunStoreFormatError &&
        error.filePath === store.filePath &&
        /runs must be an array/.test(error.message),
    );

    await writeFile(
      store.filePath,
      `${JSON.stringify({
        version: 1,
        manager: { status: "idle" },
        runs: [{ ref: newRef("run"), scheduledTaskRefs: "task:one" }],
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => store.load(),
      (error) =>
        error instanceof SparkDagRunStoreFormatError &&
        error.filePath === store.filePath &&
        /runs\[0\]\.scheduledTaskRefs must be a string array/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store keeps foreground-timeout runs active for late progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-foreground-timeout-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const projectRef = newRef("proj");
    const taskRef = newRef("task");
    const taskRunRef = newRef("run");
    const dagRun = await store.startRun({
      projectRef,
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 10,
    });
    await store.recordSchedule(dagRun.ref, {
      taskRef,
      runRef: taskRunRef,
      scheduled: 1,
    });

    const followUp = await store.finishRun(dagRun.ref, {
      scheduled: 1,
      completed: 0,
      timedOut: false,
      foregroundTimedOut: true,
      detached: true,
    });

    assert.equal(followUp, undefined);
    let snapshot = await store.load();
    let record = snapshot.runs.find((run) => run.ref === dagRun.ref);
    assert.ok(record);
    assert.equal(record.status, "running");
    assert.equal(record.timedOut, false);
    assert.equal(snapshot.manager.status, "running");
    assert.equal(snapshot.manager.activeRunRef, dagRun.ref);

    await store.recordProgress(dagRun.ref, {
      taskRef,
      completed: 1,
      run: {
        ref: taskRunRef,
        projectRef,
        taskRef,
        status: "succeeded",
        outputArtifacts: [],
      },
    });
    await store.reconcile({
      graph: TaskGraph.fromSnapshot({
        projects: [
          {
            ref: projectRef,
            title: "Project",
            description: "project",
            status: "active",
            createdAt: "2026-05-28T00:00:00.000Z",
            updatedAt: "2026-05-28T00:00:00.000Z",
          },
        ],
        tasks: [],
        dependencies: [],
        runs: [
          {
            ref: taskRunRef,
            projectRef,
            taskRef,
            status: "succeeded",
            outputArtifacts: [],
          },
        ],
      }),
      activeRunRefs: [],
    });

    snapshot = await store.load();
    record = snapshot.runs.find((run) => run.ref === dagRun.ref);
    assert.ok(record);
    assert.equal(record.status, "succeeded");
    assert.equal(record.completed, 1);
    assert.equal(record.timedOut, false);
    assert.equal(snapshot.manager.status, "idle");
    assert.equal(snapshot.manager.activeRunRef, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store ignores late progress after legacy timeout terminal finish", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-late-progress-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const projectRef = newRef("proj");
    const firstTaskRef = newRef("task");
    const lateTaskRef = newRef("task");
    const firstRunRef = newRef("run");
    const lateRunRef = newRef("run");
    const dagRun = await store.startRun({
      projectRef,
      dryRun: false,
      maxConcurrency: 2,
      timeoutMs: 10,
    });
    await store.recordSchedule(dagRun.ref, {
      taskRef: firstTaskRef,
      runRef: firstRunRef,
      scheduled: 1,
    });
    const followUp = await store.finishRun(dagRun.ref, {
      scheduled: 1,
      completed: 0,
      timedOut: true,
    });

    await store.recordProgress(dagRun.ref, {
      taskRef: lateTaskRef,
      completed: 2,
      run: {
        ref: lateRunRef,
        projectRef,
        taskRef: lateTaskRef,
        status: "succeeded",
        outputArtifacts: [],
      },
    });

    const snapshot = await store.load();
    const record = snapshot.runs.find((run) => run.ref === dagRun.ref);
    assert.ok(record);
    assert.equal(record.status, "timed_out");
    assert.equal(record.scheduled, 1);
    assert.equal(record.completed, 0);
    assert.deepEqual(record.scheduledTaskRefs, [firstTaskRef]);
    assert.deepEqual(record.completedTaskRefs, []);
    assert.deepEqual(record.taskRunRefs, [firstRunRef]);
    assert.deepEqual(record.completionFollowUp, followUp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store derives counters from unique scheduled and completed refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-counter-invariants-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const projectRef = newRef("proj");
    const taskRef = newRef("task");
    const runRef = newRef("run");
    const dagRun = await store.startRun({
      projectRef,
      dryRun: false,
      maxConcurrency: 2,
      timeoutMs: 100,
    });

    await Promise.all([
      store.recordSchedule(dagRun.ref, { taskRef, runRef, scheduled: 1 }),
      store.recordSchedule(dagRun.ref, { taskRef, runRef, scheduled: 99 }),
      store.recordProgress(dagRun.ref, {
        taskRef,
        completed: 99,
        run: { ref: runRef, projectRef, taskRef, status: "succeeded", outputArtifacts: [] },
      }),
    ]);
    await store.finishRun(dagRun.ref, { scheduled: 99, completed: 99, timedOut: false });

    const snapshot = await store.load();
    const record = snapshot.runs.find((run) => run.ref === dagRun.ref);
    assert.ok(record);
    assert.equal(record.scheduled, 1);
    assert.equal(record.completed, 1);
    assert.deepEqual(record.scheduledTaskRefs, [taskRef]);
    assert.deepEqual(record.completedTaskRefs, [taskRef]);
    assert.deepEqual(record.taskRunRefs, [runRef]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store marks finished manager runs failed when child runs fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-child-failed-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const dagRun = await store.startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    const followUp = await store.finishRun(dagRun.ref, {
      scheduled: 1,
      completed: 1,
      failed: 1,
      cancelled: 0,
      timedOut: false,
    });

    assert.ok(followUp);
    assert.equal(
      followUp.summary,
      `Spark workflow run: ${dagRun.ref} failed: scheduled 1, completed 1.`,
    );
    assert.match(followUp.nextActions.join("\n"), /failed: inspect task\(\{ action: "run_status"/);
    assert.match(followUp.nextActions.join("\n"), /rerun ready background work/);
    const status = await store.status();
    assert.equal(status.manager.status, "idle");
    assert.equal(status.succeeded, 0);
    assert.equal(status.failed, 1);
    assert.equal(status.stale, 0);
    assert.equal(status.lastRun?.status, "failed");
    assert.match(status.lastRun?.errorMessage ?? "", /failed=1 cancelled=0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store acknowledges terminal problem records without deleting history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-ack-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const failed = await store.startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    await store.finishRun(failed.ref, {
      scheduled: 1,
      completed: 0,
      failed: 1,
      cancelled: 0,
      timedOut: false,
    });

    const acknowledged = await store.acknowledgeFailures({
      sessionId: "session:reviewer",
      now: "2026-05-27T00:00:00.000Z",
    });
    assert.deepEqual(acknowledged.acknowledged, [failed.ref]);
    assert.deepEqual(acknowledged.alreadyAcknowledged, []);
    assert.equal(acknowledged.snapshot.runs.length, 1);

    const status = await store.status();
    assert.equal(status.failed, 1);
    assert.equal(status.acknowledged, 1);
    assert.equal(status.actionable, 0);
    assert.equal(status.actionableRun, undefined);
    assert.deepEqual(status.nextSteps, []);
    assert.equal(status.lastRun?.acknowledgedAt, "2026-05-27T00:00:00.000Z");
    assert.equal(status.lastRun?.acknowledgedBySession, "session:reviewer");

    const repeated = await store.acknowledgeFailures({
      runRef: failed.ref,
      sessionId: "session:reviewer",
    });
    assert.deepEqual(repeated.acknowledged, []);
    assert.deepEqual(repeated.alreadyAcknowledged, [failed.ref]);
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
    const failed = await store.startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    await store.finishRun(failed.ref, {
      scheduled: 1,
      completed: 0,
      failed: 1,
      cancelled: 0,
      timedOut: false,
    });
    const running = await store.startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });

    const snapshot = await store.clearInactiveRuns();
    assert.deepEqual(
      snapshot.runs.map((run) => run.ref),
      [failed.ref, running.ref],
    );
    assert.equal(snapshot.manager.status, "running");
    assert.equal(snapshot.manager.activeRunRef, running.ref);
    assert.equal(snapshot.manager.lastRunRef, running.ref);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store prunes old succeeded runs with dry-run preview first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-prune-succeeded-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const run = await store.startRun({ dryRun: false, maxConcurrency: 1, timeoutMs: 100 });
    await store.finishRun(run.ref, { scheduled: 0, completed: 0, timedOut: false });

    const preview = await store.pruneRuns({
      dryRun: true,
      now: "2030-01-01T00:00:00.000Z",
      olderThanDays: 30,
      keepRecent: 0,
      keepRecentPerProject: 0,
    });
    assert.deepEqual(
      preview.candidates.map((candidate) => [candidate.ref, candidate.reason]),
      [[run.ref, "old-succeeded"]],
    );
    assert.deepEqual(preview.deleted, []);
    assert.equal((await store.load()).runs.length, 1);

    const applied = await store.pruneRuns({
      dryRun: false,
      now: "2030-01-01T00:00:00.000Z",
      olderThanDays: 30,
      keepRecent: 0,
      keepRecentPerProject: 0,
    });
    assert.deepEqual(
      applied.deleted.map((candidate) => candidate.ref),
      [run.ref],
    );
    assert.equal(applied.after, 0);
    assert.equal((await store.load()).runs.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store keeps unacknowledged failed runs during prune", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-prune-unack-failed-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const failed = await store.startRun({ dryRun: false, maxConcurrency: 1, timeoutMs: 100 });
    await store.finishRun(failed.ref, {
      scheduled: 1,
      completed: 1,
      failed: 1,
      cancelled: 0,
      timedOut: false,
    });

    const pruned = await store.pruneRuns({
      dryRun: false,
      now: "2030-01-01T00:00:00.000Z",
      olderThanDays: 30,
      keepRecent: 0,
      keepRecentPerProject: 0,
    });
    assert.deepEqual(pruned.candidates, []);
    assert.deepEqual(pruned.deleted, []);
    assert.equal(
      pruned.kept.find((run) => run.ref === failed.ref)?.reason,
      "unacknowledged-problem",
    );
    assert.equal((await store.load()).runs.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store prunes acknowledged failed runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-prune-ack-failed-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const failed = await store.startRun({ dryRun: false, maxConcurrency: 1, timeoutMs: 100 });
    await store.finishRun(failed.ref, {
      scheduled: 1,
      completed: 1,
      failed: 1,
      cancelled: 0,
      timedOut: false,
    });
    await store.acknowledgeFailures({
      runRef: failed.ref,
      sessionId: "session:reviewer",
      now: "2026-01-02T00:00:00.000Z",
    });

    const pruned = await store.pruneRuns({
      dryRun: false,
      now: "2030-01-01T00:00:00.000Z",
      olderThanDays: 30,
      keepRecent: 0,
      keepRecentPerProject: 0,
    });
    assert.deepEqual(
      pruned.deleted.map((candidate) => [candidate.ref, candidate.reason]),
      [[failed.ref, "old-acknowledged-problem"]],
    );
    assert.equal((await store.load()).runs.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store keeps active and recent terminal runs during prune", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-prune-active-recent-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const projectA = newRef("proj");
    const projectB = newRef("proj");
    const oldA = newRef("run");
    const recentA = newRef("run");
    const recentB = newRef("run");
    const active = newRef("run");
    await store.save({
      version: 1,
      manager: {
        status: "running",
        activeRunRef: active,
        lastRunRef: active,
        updatedAt: "2026-01-04T00:00:00.000Z",
      },
      runs: [
        testDagRunRecord({
          ref: oldA,
          projectRef: projectA,
          status: "succeeded",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:00.000Z",
        }),
        testDagRunRecord({
          ref: recentA,
          projectRef: projectA,
          status: "succeeded",
          startedAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          finishedAt: "2026-01-02T00:00:00.000Z",
        }),
        testDagRunRecord({
          ref: recentB,
          projectRef: projectB,
          status: "succeeded",
          startedAt: "2026-01-03T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
          finishedAt: "2026-01-03T00:00:00.000Z",
        }),
        testDagRunRecord({
          ref: active,
          status: "running",
          startedAt: "2026-01-04T00:00:00.000Z",
          updatedAt: "2026-01-04T00:00:00.000Z",
        }),
      ],
    });

    const pruned = await store.pruneRuns({
      dryRun: false,
      now: "2030-01-01T00:00:00.000Z",
      olderThanDays: 30,
      keepRecent: 1,
      keepRecentPerProject: 1,
    });
    assert.deepEqual(
      pruned.deleted.map((candidate) => candidate.ref),
      [oldA],
    );
    assert.equal(pruned.kept.find((run) => run.ref === active)?.reason, "active-run");
    assert.equal(pruned.kept.find((run) => run.ref === recentA)?.reason, "project-recent-window");
    assert.equal(pruned.kept.find((run) => run.ref === recentB)?.reason, "global-recent-window");
    assert.deepEqual(
      (await store.load()).runs.map((run) => run.ref),
      [recentA, recentB, active],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run store reconciles stale running manager records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-reconcile-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Finished elsewhere",
      description: "done",
    });
    const dagRun = await store.startRun({
      projectRef: project.ref,
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    const taskRunRef = newRef("run");
    await store.recordSchedule(dagRun.ref, { taskRef: task.ref, runRef: taskRunRef, scheduled: 1 });
    graph.recordRun({
      ref: taskRunRef,
      projectRef: project.ref,
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

void test("Spark DAG run reconcile does not mark the active scheduling window stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-reconcile-scheduling-window-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const dagRun = await store.startRun({
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    const activeChildRunRef = newRef("run");

    const activeSnapshot = await store.reconcile({ activeRunRefs: [activeChildRunRef] });

    assert.equal(activeSnapshot.manager.status, "running");
    assert.equal(activeSnapshot.manager.activeRunRef, dagRun.ref);
    assert.equal(activeSnapshot.runs[0]?.status, "running");
    assert.deepEqual(activeSnapshot.runs[0]?.scheduledTaskRefs, []);
    assert.deepEqual(activeSnapshot.runs[0]?.taskRunRefs, []);

    const staleSnapshot = await store.reconcile({ activeRunRefs: [] });
    assert.equal(staleSnapshot.manager.status, "idle");
    assert.equal(staleSnapshot.runs[0]?.status, "stale");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run reconcile keeps DAG running when a scheduled task has an active child claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-reconcile-active-claim-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Still running elsewhere",
      description: "active child process is still running",
      roleRef: builtinRoleRef("worker"),
      status: "pending",
      plan: executionReadyPlan("Still running elsewhere"),
    });
    const dagRun = await store.startRun({
      projectRef: project.ref,
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    const childRunRef = newRef("run");
    await store.recordSchedule(dagRun.ref, { taskRef: task.ref, scheduled: 1 });
    graph.claimTask(task.ref, {
      kind: "role-run",
      claimedBy: "session:parent+worker",
      roleRef: builtinRoleRef("worker"),
      runName: "worker-active",
      sessionId: "session:parent",
      runRef: childRunRef,
      leaseMs: 60_000,
    });

    const snapshot = await store.reconcile({ graph, activeRunRefs: [childRunRef] });

    assert.equal(snapshot.manager.status, "running");
    assert.equal(snapshot.manager.activeRunRef, dagRun.ref);
    const [record] = snapshot.runs;
    assert.ok(record);
    assert.equal(record.status, "running");
    assert.deepEqual(record.taskRunRefs, [childRunRef]);
    assert.equal(record.finishedAt, undefined);
    assert.equal(record.errorMessage, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark DAG run reconcile revives stale records when a scheduled task still has an active child claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-run-reconcile-revive-active-claim-"));
  try {
    const store = defaultSparkDagRunStore(dir);
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Still running after stale mark",
      description: "active child process is still running after stale reconciliation",
      roleRef: builtinRoleRef("worker"),
      status: "pending",
      plan: executionReadyPlan("Still running after stale mark"),
    });
    const dagRun = await store.startRun({
      projectRef: project.ref,
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    const childRunRef = newRef("run");
    await store.recordSchedule(dagRun.ref, { taskRef: task.ref, scheduled: 1 });

    const staleSnapshot = await store.reconcile({
      graph,
      activeRunRefs: [],
      now: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(staleSnapshot.manager.status, "idle");
    assert.equal(staleSnapshot.manager.activeRunRef, undefined);
    assert.equal(staleSnapshot.runs[0]?.status, "stale");
    assert.equal(staleSnapshot.runs[0]?.finishedAt, "2026-01-01T00:00:00.000Z");
    assert.match(staleSnapshot.runs[0]?.errorMessage ?? "", /no active child process/);
    assert.ok(staleSnapshot.runs[0]?.completionFollowUp);

    graph.claimTask(task.ref, {
      kind: "role-run",
      claimedBy: "session:parent+worker",
      roleRef: builtinRoleRef("worker"),
      runName: "worker-active",
      sessionId: "session:parent",
      runRef: childRunRef,
      leaseMs: 60_000,
    });

    const revivedSnapshot = await store.reconcile({
      graph,
      activeRunRefs: [childRunRef],
      now: "2026-01-01T00:00:01.000Z",
    });

    assert.equal(revivedSnapshot.manager.status, "running");
    assert.equal(revivedSnapshot.manager.activeRunRef, dagRun.ref);
    const [record] = revivedSnapshot.runs;
    assert.ok(record);
    assert.equal(record.status, "running");
    assert.deepEqual(record.taskRunRefs, [childRunRef]);
    assert.equal(record.updatedAt, "2026-01-01T00:00:01.000Z");
    assert.equal(record.finishedAt, undefined);
    assert.equal(record.errorMessage, undefined);
    assert.equal(record.completionFollowUp, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runReadySparkTasks assigns default roles and schedules DAG waves with maxConcurrency 4", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-parallel-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const firstWave = Array.from({ length: 4 }, (_, index) =>
      graph.createTask({
        projectRef: project.ref,
        title: `Wave 1-${index}`,
        description: "ok",
        status: "pending",
        plan: executionReadyPlan(`Wave 1-${index}`),
      }),
    );
    const secondWave = graph.createTask({
      projectRef: project.ref,
      title: "Wave 2",
      description: "ok",
      roleRef: builtinRoleRef("reviewer"),
      plan: executionReadyPlan("Wave 2"),
    });
    for (const task of firstWave) graph.addDependency(secondWave.ref, task.ref);
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write(JSON.stringify({ type: 'done' }) + '\\n'); process.exit(0); }, 50);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const events: Array<
      | { kind: "schedule"; taskRef: TaskRef; running: number; scheduled: number }
      | { kind: "progress"; taskRef: TaskRef; running: number; completed: number }
    > = [];
    const result = await runReadySparkTasks({
      graph,
      ...createSparkRuntimeReadyTaskRunner({
        registry: new RoleRegistry(),
        cwd: dir,
        piCommand: fakePi,
      }),
      dryRun: false,
      maxConcurrency: 4,
      timeoutMs: 5_000,
      claim: { sessionId: "session:parent" },
      onSchedule: (event) => {
        events.push({ kind: "schedule", ...event });
      },
      onProgress: (event) => {
        events.push({ kind: "progress", ...event });
      },
    });

    assert.equal(result.maxConcurrency, 4);
    assert.equal(result.scheduled, 5);
    assert.equal(result.runs.length, 5);
    assert.equal(result.succeeded, 5);
    assert.equal(result.failed, 0);
    assert.equal(result.cancelled, 0);
    assert.equal(result.timedOut, false);
    assert.ok(firstWave.every((task) => graph.getTask(task.ref).roleRef === undefined));
    assert.ok(
      firstWave.every(
        (task) => graph.getTask(task.ref).finishedBy?.roleRef === builtinRoleRef("worker"),
      ),
    );
    assert.equal(graph.getTask(secondWave.ref).finishedBy?.roleRef, builtinRoleRef("reviewer"));
    assert.equal(graph.getTask(secondWave.ref).status, "done");
    const scheduleEvents = events.filter((event) => event.kind === "schedule");
    const firstWaveRefs = new Set(firstWave.map((task) => task.ref));
    assert.deepEqual(
      scheduleEvents
        .slice(0, firstWave.length)
        .map((event) => event.taskRef)
        .sort(),
      [...firstWaveRefs].sort(),
    );
    assert.equal(scheduleEvents[firstWave.length - 1]?.running, firstWave.length);
    const firstProgressIndex = events.findIndex((event) => event.kind === "progress");
    const secondWaveScheduleIndex = events.findIndex(
      (event) => event.kind === "schedule" && event.taskRef === secondWave.ref,
    );
    assert.ok(
      firstProgressIndex >= 0,
      "expected first wave progress before second wave scheduling",
    );
    assert.ok(
      secondWaveScheduleIndex > firstProgressIndex,
      "expected dependent second wave to wait for first wave progress",
    );
  } finally {
    await killActiveSparkRoleRunProcesses();
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runReadySparkTasks propagates schedule hook failures", async () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  graph.createTask({
    projectRef: project.ref,
    title: "Scheduled task",
    description: "scheduled",
    status: "pending",
    plan: executionReadyPlan("Scheduled task"),
  });

  await assert.rejects(
    () =>
      runReadySparkTasks({
        graph,
        ...createSparkRuntimeReadyTaskRunner({ registry: new RoleRegistry() }),
        dryRun: true,
        onSchedule: () => {
          throw new Error("schedule persistence failed");
        },
      }),
    /schedule persistence failed/,
  );
});

void test("runReadySparkTasks aborts launched child work when schedule hook fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-schedule-hook-abort-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Scheduled task",
      description: "scheduled",
      status: "pending",
      plan: executionReadyPlan("Scheduled task"),
    });
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);

    await assert.rejects(
      () =>
        runReadySparkTasks({
          graph,
          ...createSparkRuntimeReadyTaskRunner({
            registry: new RoleRegistry(),
            cwd: dir,
            piCommand: fakePi,
          }),
          dryRun: false,
          timeoutMs: 5_000,
          claim: { sessionId: "session:parent" },
          onSchedule: () => {
            throw new Error("schedule persistence failed");
          },
        }),
      /schedule persistence failed/,
    );

    assert.equal(
      listActiveSparkRoleRunProcesses().some((entry) => entry.cwd === dir),
      false,
    );
    assert.equal(graph.getTask(task.ref).status, "failed");
    assert.equal(graph.getTask(task.ref).claim, undefined);
    const runs = graph.runs(project.ref).filter((run) => run.taskRef === task.ref);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "failed");
    assert.match(runs[0]?.errorMessage ?? "", /Spark ready task scheduler aborted/);
  } finally {
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runReadySparkTasks limits ready frontier to the requested project", async () => {
  const graph = new TaskGraph();
  const selected = graph.createProject({ title: "Selected", description: "selected" });
  const other = graph.createProject({ title: "Other", description: "other" });
  const selectedTask = graph.createTask({
    projectRef: selected.ref,
    title: "Selected ready task",
    description: "selected",
    status: "pending",
    plan: executionReadyPlan("Selected ready task"),
  });
  const otherTask = graph.createTask({
    projectRef: other.ref,
    title: "Other ready task",
    description: "other",
    status: "pending",
    plan: executionReadyPlan("Other ready task"),
  });

  const result = await runReadySparkTasks({
    graph,
    ...createSparkRuntimeReadyTaskRunner({ registry: new RoleRegistry() }),
    dryRun: true,
    projectRef: selected.ref,
  });

  assert.equal(result.scheduled, 1);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0]?.taskRef, selectedTask.ref);
  assert.equal(graph.getTask(otherTask.ref).status, "pending");
});

void test("runReadySparkTasks reports failed child runs in aggregate result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-ready-child-failed-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "No output",
      description: "ok",
      roleRef: builtinRoleRef("worker"),
      plan: executionReadyPlan("No output"),
    });
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(fakePi, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
    await chmod(fakePi, 0o755);

    const result = await runReadySparkTasks({
      graph,
      ...createSparkRuntimeReadyTaskRunner({
        registry: new RoleRegistry(),
        cwd: dir,
        piCommand: fakePi,
      }),
      dryRun: false,
      timeoutMs: 5_000,
      claim: { sessionId: "session:parent" },
    });

    assert.equal(result.scheduled, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.cancelled, 0);
    assert.equal(graph.getTask(task.ref).status, "failed");
  } finally {
    await killActiveSparkRoleRunProcesses();
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runReadySparkTasks returns the recorded failed run when child launch fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-ready-child-launch-failed-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Launch child",
      description: "launch child",
      roleRef: builtinRoleRef("worker"),
      plan: executionReadyPlan("Launch child"),
    });

    const result = await runReadySparkTasks({
      graph,
      ...createSparkRuntimeReadyTaskRunner({
        registry: new RoleRegistry(),
        cwd: dir,
        piCommand: join(dir, "missing-pi"),
      }),
      dryRun: false,
      timeoutMs: 5_000,
      claim: { sessionId: "session:parent" },
    });

    const graphRuns = graph.runs(project.ref);
    assert.equal(result.failed, 1);
    assert.equal(result.runs.length, 1);
    assert.equal(graphRuns.length, 1);
    assert.equal(result.runs[0]?.ref, graphRuns[0]?.ref);
    assert.equal(result.runs[0]?.status, "failed");
    assert.equal(graph.getTask(task.ref).status, "failed");
  } finally {
    await killActiveSparkRoleRunProcesses();
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runReadySparkTasks propagates missing role errors before creating child runs", async () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const task = graph.createTask({
    projectRef: project.ref,
    title: "Missing role",
    description: "missing role",
    roleRef: "role:project-missing" as RoleRef,
    plan: executionReadyPlan("Missing role"),
  });

  await assert.rejects(
    () =>
      runReadySparkTasks({
        graph,
        ...createSparkRuntimeReadyTaskRunner({ registry: new RoleRegistry() }),
        dryRun: false,
        timeoutMs: 5_000,
        claim: { sessionId: "session:parent" },
      }),
    /unknown role: role:project-missing/,
  );

  assert.equal(graph.runs(project.ref).length, 0);
  assert.equal(graph.getTask(task.ref).status, "ready");
  assert.equal(graph.getTask(task.ref).claim, undefined);
});

void test("runReadySparkTasks treats timeoutMs as a foreground wait budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dag-timeout-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const slowTask = graph.createTask({
      projectRef: project.ref,
      title: "Slow task",
      description: "slow",
      roleRef: builtinRoleRef("worker"),
      plan: executionReadyPlan("Slow task"),
    });
    const pendingTask = graph.createTask({
      projectRef: project.ref,
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
      ...createSparkRuntimeReadyTaskRunner({
        registry: new RoleRegistry(),
        cwd: dir,
        piCommand: fakePi,
      }),
      dryRun: false,
      maxConcurrency: 4,
      timeoutMs: 20,
      claim: { sessionId: "session:parent" },
    });

    const backgroundRuns = result.runs.filter(
      (run) =>
        run.status === "running" &&
        /foreground wait expired/.test(run.errorMessage ?? "") &&
        !run.failureKind,
    );
    assert.equal(result.maxConcurrency, 4);
    assert.equal(result.timedOut, false);
    assert.equal(result.foregroundTimedOut, true);
    assert.equal(result.detached, true);
    assert.equal(result.scheduled, 1);
    assert.equal(graph.getTask(slowTask.ref).status, "running");
    assert.equal(graph.getTask(slowTask.ref).claim?.kind, "role-run");
    assert.equal(graph.getTask(pendingTask.ref).status, "pending");
    assert.equal(backgroundRuns.length, 1);
    assert.equal(backgroundRuns[0]?.taskRef, slowTask.ref);
    assert.match(backgroundRuns[0]?.errorMessage ?? "", /foreground wait expired/);
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
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Plan",
      description: "plan",
      roleRef: builtinRoleRef("planner"),
      plan: executionReadyPlan("Plan"),
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
      schemaVersion?: number;
      runRef?: string;
      taskRef?: string;
      roleRef?: string;
      status?: string;
      record?: { status?: string; instruction?: string };
      stdout?: { tail?: string; bytes?: number; truncated?: boolean };
      stderr?: { tail?: string; bytes?: number; truncated?: boolean };
      jsonEvents?: { count?: number; tail?: string[]; truncated?: boolean };
    };
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.runRef, run.ref);
    assert.equal(body.taskRef, task.ref);
    assert.equal(body.roleRef, builtinRoleRef("planner"));
    assert.equal(body.status, "succeeded");
    assert.equal(body.record?.status, "succeeded");
    assert.equal(body.record?.instruction, undefined);
    assert.equal(body.stdout?.tail, "");
    assert.equal(body.stdout?.bytes, 0);
    assert.equal(body.stdout?.truncated, false);
    assert.equal(body.stderr?.tail, "");
    assert.equal(body.stderr?.bytes, 0);
    assert.equal(body.stderr?.truncated, false);
    assert.equal(body.jsonEvents?.count, 0);
    assert.deepEqual(body.jsonEvents?.tail, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkTask writes compact role-run artifacts for large output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-large-role-artifact-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Large output task",
      description: "produce large output",
      roleRef: builtinRoleRef("worker"),
      plan: executionReadyPlan("Large output task"),
    });
    const artifactStore = new ArtifactStore({
      rootDir: join(dir, "artifacts"),
    });
    const fakePi = join(dir, "fake-pi.cjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const payload = 'P'.repeat(100_000);",
        "process.stdout.write('A'.repeat(200_000) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'done', payload }) + '\\n');",
        "process.stderr.write('E'.repeat(80_000));",
      ].join("\n"),
      "utf8",
    );
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

    assert.equal(run.status, "succeeded");
    const [artifact] = await artifactStore.list({ kind: "role-run" });
    assert.ok(artifact);
    const artifactPath = artifactStore.pathFor(artifact.ref);
    const metadata = await readFile(artifactPath, "utf8");
    const metadataStats = await stat(artifactPath);
    const artifactBodyText = await artifactStore.getBody(artifact.ref);
    assert.ok(metadataStats.size < 60_000, `artifact metadata is too large: ${metadataStats.size}`);
    assert.ok(
      Buffer.byteLength(artifactBodyText, "utf8") < 60_000,
      `artifact body is too large: ${Buffer.byteLength(artifactBodyText, "utf8")}`,
    );
    assert.equal(metadata.includes("A".repeat(50_000)), false);
    assert.equal(metadata.includes("P".repeat(50_000)), false);
    assert.equal(metadata.includes("E".repeat(50_000)), false);

    const body = artifact.body as {
      schemaVersion?: number;
      runRef?: string;
      taskRef?: string;
      roleRef?: string;
      status?: string;
      record?: { instruction?: string };
      stdout?: { bytes?: number; tail?: string; tailBytes?: number; truncated?: boolean };
      stderr?: { bytes?: number; tail?: string; tailBytes?: number; truncated?: boolean };
      jsonEvents?: {
        count?: number;
        tail?: string[];
        tailEventCount?: number;
        truncated?: boolean;
      };
    };
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.runRef, run.ref);
    assert.equal(body.taskRef, task.ref);
    assert.equal(body.roleRef, builtinRoleRef("worker"));
    assert.equal(body.status, "succeeded");
    assert.equal(body.record?.instruction, undefined);
    assert.ok((body.stdout?.bytes ?? 0) > 250_000);
    assert.ok((body.stdout?.tailBytes ?? 0) <= 12 * 1024);
    assert.equal(body.stdout?.truncated, true);
    assert.ok((body.stderr?.bytes ?? 0) > 70_000);
    assert.ok((body.stderr?.tailBytes ?? 0) <= 12 * 1024);
    assert.equal(body.stderr?.truncated, true);
    assert.equal(body.jsonEvents?.count, 1);
    assert.equal(body.jsonEvents?.tailEventCount, 1);
    assert.equal(body.jsonEvents?.truncated, true);
    assert.ok((body.jsonEvents?.tail?.[0]?.length ?? 0) <= 1_001);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkTask dry-run records validation without completing the task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-run-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Plan",
      description: "plan",
      kind: "plan",
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
    assert.equal(graph.getTask(task.ref).status, "ready");
    assert.equal(graph.getTask(task.ref).roleRef, undefined);
    assert.equal(graph.getTask(task.ref).claim, undefined);
    assert.equal(graph.getTask(task.ref).outputArtifacts.length, 1);
    assert.deepEqual(run.outputArtifacts, graph.getTask(task.ref).outputArtifacts);
    const [artifact] = await artifactStore.list({ kind: "role-run" });
    assert.ok(artifact);
    assert.equal(artifact.ref, run.outputArtifacts[0]);
    assert.match(artifact.title, /^Role run planner-/);
    assert.equal(artifact.provenance.producer, "task");
    assert.equal(artifact.provenance.projectRef, project.ref);
    assert.equal(artifact.provenance.taskRef, task.ref);
    assert.equal(graph.getTask(task.ref).roleRef, undefined);
    assert.equal(artifact.provenance.roleRef, builtinRoleRef("planner"));
    assert.equal(artifact.provenance.runRef, run.ref);
    assert.match(artifact.provenance.note ?? "", /^runName=planner-/);
    const body = artifact.body as {
      schemaVersion?: number;
      runRef?: string;
      taskRef?: string;
      roleRef?: string;
      status?: string;
      summary?: string;
      record?: { ref?: string; runName?: string; status?: string; instruction?: string };
      stdout?: { tail?: string; bytes?: number; truncated?: boolean };
      stderr?: { tail?: string; bytes?: number; truncated?: boolean };
      jsonEvents?: { count?: number; tail?: string[]; truncated?: boolean };
    };
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.runRef, run.ref);
    assert.equal(body.taskRef, task.ref);
    assert.equal(body.roleRef, builtinRoleRef("planner"));
    assert.equal(body.status, "not_started");
    assert.equal(body.record?.ref, run.ref);
    assert.equal(body.record?.runName, run.runName);
    assert.equal(body.record?.status, "not_started");
    assert.equal(body.record?.instruction, undefined);
    assert.match(body.summary ?? "", /not_started|without summary output/);
    assert.equal(body.stdout?.tail, "");
    assert.equal(body.stdout?.bytes, 0);
    assert.equal(body.stdout?.truncated, false);
    assert.equal(body.stderr?.tail, "");
    assert.equal(body.stderr?.bytes, 0);
    assert.equal(body.stderr?.truncated, false);
    assert.equal(body.jsonEvents?.count, 0);
    assert.deepEqual(body.jsonEvents?.tail, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkTask can request explicit forked Pi mode when a parent session is provided", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-forked-run-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Forked spec implementation",
      description: "implement project spec behavior with parent context",
      roleRef: builtinRoleRef("reviewer"),
      plan: executionReadyPlan("Forked spec implementation"),
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
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const roleRef = "role:project-test-worker" as RoleRef;
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Project spec implementation",
      description: "implement project spec behavior",
      roleRef,
      plan: executionReadyPlan("Project spec implementation"),
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
    assert.deepEqual(finishedTask.finishedBy, {
      sessionId: "session:parent",
      roleRef,
      runName: run.runName,
    });
    assert.equal(graph.runs(project.ref).at(-1)?.ref, run.ref);
    assert.equal(graph.runs(project.ref).at(-1)?.ownerSessionId, "session:parent");
    assert.equal(graph.runs(project.ref).at(-1)?.runName, run.runName);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((entry) => entry.runRef === run.ref),
      false,
    );
  } finally {
    await killActiveSparkRoleRunProcesses();
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task timeout fails the task while leaving only the stuck child process killable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-timeout-cleanup-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Demo", description: "demo" });
    const slow = graph.createTask({
      projectRef: project.ref,
      title: "Slow task",
      description: "reviewer",
      roleRef: builtinRoleRef("reviewer"),
      plan: executionReadyPlan("Slow task"),
    });
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const result = await runReadySparkTasks({
      graph,
      ...createSparkRuntimeReadyTaskRunner({
        registry: new RoleRegistry(),
        cwd: dir,
        piCommand: fakePi,
      }),
      dryRun: false,
      maxConcurrency: 2,
      taskTimeoutMs: 500,
      timeoutMs: 5_000,
      claim: { sessionId: "session:parent" },
    });

    assert.equal(result.timedOut, false);
    assert.equal(result.scheduled, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
    const slowRuns = graph.runs(project.ref).filter((run) => run.taskRef === slow.ref);
    assert.equal(slowRuns.length, 1);
    const slowRun = slowRuns.find((run) => run.status === "failed") ?? slowRuns[0];
    assert.equal(slowRun?.status, "failed");
    assert.equal(slowRun?.failureKind, "runtime_timeout");
    assert.equal(graph.getTask(slow.ref).status, "failed");
    assert.equal(graph.getTask(slow.ref).claim, undefined);
    const active = listActiveSparkRoleRunProcesses().filter((entry) => entry.cwd === dir);
    assert.ok(active.length >= 1);
    const slowActive = active.find((entry) => entry.runRef === slowRun?.ref);
    assert.ok(slowActive);
    assert.equal(slowActive.runName, slowRun?.runName);
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
