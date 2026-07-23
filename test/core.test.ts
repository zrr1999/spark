import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { ArtifactStore, validateArtifact } from "@zendev-lab/spark-artifacts";
import {
  formatJsonFile,
  newRef,
  readJsonFileOptional,
  refKind,
  refId,
  isRef,
  isRefKind,
  writeJsonFileAtomic,
  writeTextFileAtomic,
  type TaskPlan,
} from "@zendev-lab/spark-core";
import { builtinRoleRef, createBuiltinRoles } from "@zendev-lab/spark-roles";
import { TaskGraph } from "@zendev-lab/spark-tasks";
import { renderSparkActiveSystemPrompt } from "../packages/spark-extension/src/extension/spark-active-injection.ts";
import { isGenericTaskNameForTitle } from "../packages/spark-extension/src/extension/spark-claim-task-tool-registration.ts";
import { isPlaceholderProjectTitle } from "../packages/spark-extension/src/extension/spark-graph-invariants.ts";
import { deriveTaskRoleLabel } from "../packages/spark-extension/src/extension/task-ownership.ts";

function executionReadyPlan(objective: string): TaskPlan {
  return {
    objective,
    contextRefs: [],
    constraints: [],
    nonGoals: [],
    successCriteria: [`Validation command for ${objective} passes with exit code 0.`],
    evidenceRequired: [
      `Validation artifact records command output, exit code, and changed-file summary for ${objective}.`,
    ],
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

test("refs carry kind and id", () => {
  const ref = newRef("task", "abc");
  assert.equal(ref, "task:abc");
  assert.equal(refId(ref), "abc");
  assert.equal(isRef(ref, "task"), true);
  assert.equal(isRef(ref, "role"), false);
  assert.equal(isRef("agent:builtin-worker"), false);
  assert.throws(() => refKind("agent:builtin-worker"), /unknown ref kind/);

  // evidence is a first-class RefKind (ArtifactRef may be evidence:…); isRefKind must accept it
  assert.equal(isRefKind("evidence"), true);
  const evidenceRef = newRef("evidence", "proof");
  assert.equal(evidenceRef, "evidence:proof");
  assert.equal(isRef(evidenceRef), true);
  assert.equal(isRef(evidenceRef, "evidence"), true);
  assert.equal(isRef("evidence:proof", "artifact"), false);
  assert.equal(refKind(evidenceRef), "evidence");
});

test("artifact contract validates persisted metadata shape", () => {
  const ref = newRef("artifact", "contract");
  const projectRef = newRef("proj", "contract-project");
  const artifact = {
    ref,
    kind: "record",
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
    curation: { status: "curated", retention: "durable", reason: "contract test" },
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
  assert.throws(
    () => validateArtifact({ ...artifact, curation: { status: "kept" } }),
    /curation.status must be valid/,
  );
});

test("artifact store defaults and filters curation lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-artifact-curation-"));
  try {
    const store = new ArtifactStore({ rootDir: dir });
    const trace = await store.put({
      kind: "trace",
      title: "Noisy run trace",
      format: "text",
      body: "trace",
      provenance: { producer: "task" },
    });
    const document = await store.put({
      kind: "document",
      title: "Task essence",
      format: "markdown",
      body: "# Essence",
      provenance: { producer: "task" },
    });

    assert.equal(trace.curation?.status, "raw");
    assert.equal(trace.curation?.retention, "ephemeral");
    assert.equal(document.curation?.status, "candidate");
    assert.deepEqual(
      (await store.list()).map((artifact) => artifact.ref),
      [trace.ref, document.ref],
    );
    assert.deepEqual(
      (await store.list({ includeRaw: false })).map((artifact) => artifact.ref),
      [document.ref],
    );

    await store.update(document.ref, {
      curation: { status: "curated", retention: "durable", reason: "final task essence" },
    });
    await store.update(trace.ref, {
      curation: { status: "superseded", retention: "task", supersededBy: [document.ref] },
    });
    assert.deepEqual(
      (await store.list({ curationStatus: "curated" })).map((artifact) => artifact.ref),
      [document.ref],
    );
    assert.deepEqual(
      (await store.list({ includeRaw: true, includeArchived: true })).map(
        (artifact) => artifact.ref,
      ),
      [trace.ref, document.ref],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JSON and text file helpers keep optional read, formatting, and parse error semantics", async () => {
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

test("task graph rejects cycles and cross-project dependencies", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  const otherProject = graph.createProject({ title: "Other", description: "other" });
  const a = graph.createTask({
    projectRef: project.ref,
    title: "A",
    description: "a",
    roleRef: builtinRoleRef("worker"),
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

test("task graph bootstraps one roadmap per project", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo", purpose: "Ship v0" });
  assert.equal(project.purpose, "Ship v0");
  assert.equal(project.roadmap.ref, "roadmap:main");
  assert.equal(project.roadmap.items.length, 0);
  const reloaded = TaskGraph.fromSnapshot(graph.snapshot());
  assert.equal(reloaded.getProject(project.ref).roadmap.ref, "roadmap:main");
});

test("task graph can update placeholder project titles without project lifecycle status", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "「自定义输入」", description: "demo" });
  const updated = graph.updateProject(project.ref, {
    title: "Concrete Spark workflow",
  });
  assert.equal(updated.ref, project.ref);
  assert.equal(updated.title, "Concrete Spark workflow");
  assert.equal(graph.getProject(project.ref).title, "Concrete Spark workflow");
  assert.equal(isPlaceholderProjectTitle("Spark project"), true);
  assert.equal(isPlaceholderProjectTitle("Hypha v0"), false);
});

test("generic task names are detectable and intentionally named tasks are preserved", () => {
  assert.equal(isGenericTaskNameForTitle("capture-project-intent", "Capture project intent"), true);
  assert.equal(isGenericTaskNameForTitle("task-deadbeefcafebabe", "整理一下"), true);
  assert.equal(isGenericTaskNameForTitle("hypha-v0", "Capture project intent"), false);
});

test("task graph plans multiple tasks without claiming them", () => {
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
      roleRef: builtinRoleRef("worker"),
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

test("ready tasks require completed dependencies and execution-ready plans", () => {
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

test("task role labels prefer active claim, finished attribution, then latest run", () => {
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

test("Spark prompt stays short and tool-scoped", () => {
  const prompt = renderSparkActiveSystemPrompt("");
  assert.equal(prompt.includes("\n"), false);
  for (const tool of ["task_read", "task_write", "assign", "artifact", "ask", "role"]) {
    assert.match(prompt, new RegExp(`\\b${tool}\\b`));
  }
  assert.doesNotMatch(prompt, /workflow, patch/);
  assert.doesNotMatch(prompt, /no guessing: ask unless user says infer\/research/);
  assert.doesNotMatch(prompt, /Spark active/);
  assert.doesNotMatch(prompt, /read SPARK\.md or the spark skill/);
  assert.doesNotMatch(prompt, /spark skill/);
  assert.doesNotMatch(prompt, /standing project state/);
  assert.doesNotMatch(prompt, /Active Spark context/);
  assert.doesNotMatch(prompt, /spark_use_project/);
  assert.doesNotMatch(prompt, /Do not spawn nested pi CLI sessions/);
  assert.ok(prompt.length < 260, `expected short standing prompt, got ${prompt.length}`);
});

test("Spark prompt defaults to plan and changes for implementation mode", () => {
  const defaultPrompt = renderSparkActiveSystemPrompt("");
  const planPrompt = renderSparkActiveSystemPrompt("", "plan");
  const implementPrompt = renderSparkActiveSystemPrompt("", "implement");
  assert.equal(planPrompt, defaultPrompt);
  assert.notEqual(implementPrompt, planPrompt);
  assert.match(planPrompt, /\bplan\b/);
  assert.match(implementPrompt, /\bimplement\b/);
});

test("builtin Pi roles report blockers upward instead of asking interactively", () => {
  for (const role of createBuiltinRoles()) {
    assert.equal((role.allowedTools ?? []).includes("ask"), false);
    if (role.id === "reviewer") {
      assert.match(role.systemPrompt, /Do not ask interactively/);
      assert.match(role.systemPrompt, /findings\/blockers/);
    } else {
      assert.match(role.systemPrompt, /upward/i);
      assert.doesNotMatch(role.systemPrompt, /available ask tool/i);
    }
    assert.match(role.systemPrompt, /block|ambigu/i);
    assert.doesNotMatch(role.systemPrompt, /Spark ask tools/i);
  }
});

test("task graph maintains todos alongside a claimed current task", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Demo", description: "demo" });
  assert.equal(graph.currentTask(project.ref), undefined);

  const task = graph.createTask({
    projectRef: project.ref,
    title: "Plan",
    description: "plan",
    kind: "plan",
    roleRef: builtinRoleRef("worker"),
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
