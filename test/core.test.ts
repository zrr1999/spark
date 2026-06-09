import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateArtifact } from "pi-artifacts";
import {
  formatJsonFile,
  newRef,
  readJsonFileOptional,
  refKind,
  refId,
  isRef,
  writeJsonFileAtomic,
  writeTextFileAtomic,
  type TaskPlan,
} from "pi-extension-api";
import { builtinRoleRef, createBuiltinRoles } from "pi-roles";
import { TaskGraph } from "pi-tasks";
import { renderSparkActiveSystemPrompt } from "../packages/spark/src/extension/spark-active-injection.ts";
import { isGenericTaskNameForTitle } from "../packages/spark/src/extension/spark-claim-task-tool-registration.ts";
import { isPlaceholderProjectTitle } from "../packages/spark/src/extension/spark-graph-invariants.ts";
import { deriveTaskRoleLabel } from "../packages/spark/src/extension/task-ownership.ts";

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

class TestJsonFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`${filePath}: ${message}`);
    this.name = "TestJsonFormatError";
    this.filePath = filePath;
  }
}

void test("refs carry kind and id", () => {
  const ref = newRef("task", "abc");
  assert.equal(ref, "task:abc");
  assert.equal(refId(ref), "abc");
  assert.equal(isRef(ref, "task"), true);
  assert.equal(isRef(ref, "role"), false);
  assert.equal(isRef("agent:builtin-worker"), false);
  assert.throws(() => refKind("agent:builtin-worker"), /unknown ref kind/);
});

void test("artifact contract validates persisted metadata shape", () => {
  const ref = newRef("artifact", "contract");
  const projectRef = newRef("proj", "contract-project");
  const artifact = {
    ref,
    kind: "research",
    title: "Contract artifact",
    format: "json",
    body: { ok: true },
    hash: "abc123",
    blobPath: "blobs/abc123.json",
    links: [
      {
        from: ref,
        to: projectRef,
        relation: "derived-from",
      },
    ],
    provenance: { producer: "spark", projectRef },
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
  };

  assert.doesNotThrow(() => validateArtifact(artifact));
  assert.throws(
    () => validateArtifact({ ...artifact, provenance: undefined }),
    /provenance must be an object/,
  );
  assert.throws(
    () => validateArtifact({ ...artifact, bodyTruncated: true, bodyPreview: "preview" }),
    /bodySize must be a positive number/,
  );
});

void test("JSON and text file helpers keep optional read, formatting, and parse error semantics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-core-json-"));
  try {
    const filePath = join(dir, "nested", "state.json");
    const createError = (path: string, message: string) => new TestJsonFormatError(path, message);

    assert.equal(await readJsonFileOptional(filePath, createError), undefined);

    await writeJsonFileAtomic(filePath, { version: 1, enabled: true });
    assert.equal(await readFile(filePath, "utf8"), formatJsonFile({ version: 1, enabled: true }));
    assert.deepEqual(await readJsonFileOptional(filePath, createError), {
      version: 1,
      enabled: true,
    });

    const textPath = join(dir, "nested", "note.txt");
    await writeTextFileAtomic(textPath, "hello\n");
    assert.equal(await readFile(textPath, "utf8"), "hello\n");
    assert.deepEqual(
      (await readdir(join(dir, "nested"))).filter((entry) => entry.endsWith(".tmp")),
      [],
    );

    await writeFile(filePath, "{not-json", "utf8");
    await assert.rejects(
      () => readJsonFileOptional(filePath, createError),
      (error) =>
        error instanceof TestJsonFormatError &&
        error.filePath === filePath &&
        /not valid JSON/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task graph rejects cycles and cross-project dependencies", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const otherProject = graph.createProject({ title: "Other", description: "other" });
  const a = graph.createTask({
    projectRef: project.ref,
    title: "A",
    description: "a",
    roleRef: builtinRoleRef("planner"),
  });
  const b = graph.createTask({
    projectRef: project.ref,
    title: "B",
    description: "b",
    roleRef: builtinRoleRef("worker"),
  });
  const other = graph.createTask({
    projectRef: otherProject.ref,
    title: "Other task",
    description: "other task",
    roleRef: builtinRoleRef("worker"),
  });
  graph.addDependency(b.ref, a.ref);
  assert.throws(() => graph.addDependency(a.ref, b.ref), /cyclic task dependency/);
  assert.throws(
    () => graph.addDependency(b.ref, other.ref),
    /task dependencies cannot cross projects/,
  );
});

void test("task graph bootstraps one roadmap per project", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo", intent: "Ship v0" });
  assert.equal(project.intent, "Ship v0");
  assert.equal(project.roadmap.ref, "roadmap:main");
  assert.equal(project.roadmap.items.length, 0);
  const reloaded = TaskGraph.fromSnapshot(graph.snapshot());
  assert.equal(reloaded.getProject(project.ref).roadmap.ref, "roadmap:main");
});

void test("task graph can update placeholder project titles and status", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "「自定义输入」", description: "demo" });
  assert.equal(project.status, "active");
  const updated = graph.updateProject(project.ref, {
    title: "Concrete Spark workflow",
    status: "done",
  });
  assert.equal(updated.ref, project.ref);
  assert.equal(updated.title, "Concrete Spark workflow");
  assert.equal(updated.status, "done");
  assert.equal(graph.getProject(project.ref).title, "Concrete Spark workflow");
  assert.equal(graph.getProject(project.ref).status, "done");
  assert.equal(isPlaceholderProjectTitle("Spark project"), true);
  assert.equal(isPlaceholderProjectTitle("Hypha v0"), false);
});

void test("generic task names are detectable and intentionally named tasks are preserved", () => {
  assert.equal(isGenericTaskNameForTitle("capture-project-intent", "Capture project intent"), true);
  assert.equal(isGenericTaskNameForTitle("task-deadbeefcafebabe", "整理一下"), true);
  assert.equal(isGenericTaskNameForTitle("hypha-v0", "Capture project intent"), false);
});

void test("task graph plans multiple tasks without claiming them", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const result = graph.planTasks(project.ref, [
    {
      title: "Inspect ask flow",
      description: "Compare current ask flow with references.",
      kind: "research",
      roleRef: builtinRoleRef("scout"),
      plan: executionReadyPlan("Inspect ask flow"),
    },
    {
      title: "Design claim registry",
      description: "Plan one-active-task claim semantics.",
      kind: "plan",
      roleRef: builtinRoleRef("planner"),
      plan: executionReadyPlan("Design claim registry"),
      dependsOn: ["Inspect ask flow"],
    },
  ]);

  assert.equal(result.created.length, 2);
  assert.equal(result.dependencies.length, 1);
  assert.equal(graph.tasks(project.ref).filter((task) => task.claim).length, 0);
  assert.deepEqual(
    graph.readyTasks(project.ref).map((task) => task.title),
    ["Inspect ask flow"],
  );
});

void test("ready tasks require completed dependencies and execution-ready plans", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const a = graph.createTask({
    projectRef: project.ref,
    title: "A",
    description: "a",
    status: "pending",
    plan: executionReadyPlan("A"),
  });
  const b = graph.createTask({
    projectRef: project.ref,
    title: "B",
    description: "b",
    roleRef: builtinRoleRef("worker"),
    plan: executionReadyPlan("B"),
  });
  graph.addDependency(b.ref, a.ref);
  assert.deepEqual(
    graph.readyTasks(project.ref).map((task) => task.ref),
    [a.ref],
  );
});

void test("task role labels prefer active claim, finished attribution, then latest run", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const current = "session:current";
  const main = graph.createTask({ projectRef: project.ref, title: "Main", description: "main" });
  const roleRun = graph.createTask({
    projectRef: project.ref,
    title: "Sub",
    description: "sub",
    plan: executionReadyPlan("Sub"),
  });
  const legacy = graph.createTask({
    projectRef: project.ref,
    title: "Legacy",
    description: "legacy",
  });

  graph.claimTask(main.ref, {
    kind: "main",
    claimedBy: current,
    sessionId: current,
    leaseMs: 60_000,
  });
  graph.claimTask(roleRun.ref, {
    kind: "role-run",
    claimedBy: `${current}+worker-1234`,
    roleRef: builtinRoleRef("worker"),
    sessionId: current,
    runName: "worker-1234",
    leaseMs: 60_000,
  });
  graph.setTaskStatus(main.ref, "done");
  graph.setTaskStatus(roleRun.ref, "done");
  graph.setTaskStatus(legacy.ref, "done");

  assert.equal(
    deriveTaskRoleLabel({ task: graph.getTask(main.ref), currentSessionKey: current }),
    "me",
  );
  assert.equal(
    deriveTaskRoleLabel({ task: graph.getTask(roleRun.ref), currentSessionKey: current }),
    "me/worker-1234(spec:worker)",
  );
  assert.equal(
    deriveTaskRoleLabel({
      task: graph.getTask(legacy.ref),
      currentSessionKey: current,
      latestRun: {
        ref: newRef("run"),
        projectRef: project.ref,
        taskRef: legacy.ref,
        runName: "reviewer-9999",
        status: "succeeded",
        outputArtifacts: [],
      },
    }),
    "me/reviewer-9999",
  );
  assert.equal(
    deriveTaskRoleLabel({
      task: graph.getTask(legacy.ref),
      currentSessionKey: current,
    }),
    "me",
  );
});

void test("active Spark prompt is a one-line state marker with the current mode", () => {
  const prompt = renderSparkActiveSystemPrompt("", "SPARK.md");
  assert.match(prompt, /^Spark active \(SPARK\.md\); mode: auto\./);
  assert.match(prompt, /Spark is the mode facade/);
  assert.match(prompt, /task, artifact, ask, role, learning, context, recall, workflow, patch/);
  assert.match(prompt, /no guessing: ask unless user says infer\/research/);
  assert.doesNotMatch(prompt, /read SPARK\.md or the spark skill/);
  assert.doesNotMatch(prompt, /spark skill/);
  assert.doesNotMatch(prompt, /standing project state/);
  assert.doesNotMatch(prompt, /Active Spark context/);
  assert.doesNotMatch(prompt, /spark_use_project/);
  assert.doesNotMatch(prompt, /Do not spawn nested pi CLI sessions/);
  assert.ok(prompt.length < 220, `expected short standing prompt, got ${prompt.length}`);
});

void test("active Spark prompt threads the current session mode into the marker", () => {
  const planPrompt = renderSparkActiveSystemPrompt("", ".spark/projects.json", "plan");
  assert.match(planPrompt, /^Spark active \(\.spark\/projects\.json\); mode: plan\./);
  const executePrompt = renderSparkActiveSystemPrompt("", "SPARK.md", "execute");
  assert.match(executePrompt, /mode: execute/);
});

void test("builtin Spark roles are instructed to use ask tools for blockers", () => {
  for (const role of createBuiltinRoles()) {
    assert.match(role.systemPrompt, /use Spark ask tools/i);
    assert.match(role.systemPrompt, /block|ambigu/i);
  }
});

void test("task graph maintains todos alongside a claimed current task", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  assert.equal(graph.currentTask(project.ref), undefined);

  const task = graph.createTask({
    projectRef: project.ref,
    title: "Plan",
    description: "plan",
    kind: "plan",
    roleRef: builtinRoleRef("planner"),
    todos: [{ content: "Read inputs" }, { content: "Draft graph" }],
  });
  graph.setCurrentTask(project.ref, task.ref);
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
