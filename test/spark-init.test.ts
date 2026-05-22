import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskGraph, defaultTaskGraphStore, defaultTaskTodoStore } from "spark-tasks";
import sparkExtension, {
  detectSparkActivation,
  initializeSparkIdea,
  renderActiveSparkContextSummary,
  renderSparkActiveSystemPrompt,
  shouldMaterializeSparkMd,
} from "../packages/spark/src/extension/index.ts";

type SparkExtensionApiForTest = Parameters<typeof sparkExtension>[0];
type SparkToolConfig = Parameters<NonNullable<SparkExtensionApiForTest["registerTool"]>>[0];
type SparkToolContextForTest = Parameters<SparkToolConfig["execute"]>[4];

void test("Spark activation requires a local .spark directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-no-local-state-"));
  try {
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "SPARK.md"), "# Existing intent\n", "utf8");

    assert.deepEqual(await detectSparkActivation(dir), { active: false, reason: "no .spark" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("workspace-like cwd keeps Spark state under .spark without root SPARK.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workspace-"));
  try {
    assert.equal(await shouldMaterializeSparkMd(dir), false);
    const result = await initializeSparkIdea(dir, "Build a new idea from workspace root");
    assert.equal(result.sparkMdPath, undefined);
    const threadJson = await readFile(join(dir, ".spark", "thread.json"), "utf8");
    assert.doesNotMatch(threadJson, /Maintain current interaction context/);
    assert.match(threadJson, /Analyze project intent/);
    assert.match(threadJson, /do not start with a broad intake form/);
    assert.doesNotMatch(threadJson, /"currentTaskRef"/);
    assert.doesNotMatch(threadJson, /"todos"/);
    await assert.rejects(() => readFile(join(dir, ".spark", "todos.json"), "utf8"));
    await assert.rejects(() => readFile(join(dir, "SPARK.md"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("repo-like cwd materializes root SPARK.md as well", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repo-"));
  try {
    await mkdir(join(dir, ".git"));
    assert.equal(await shouldMaterializeSparkMd(dir), true);
    const result = await initializeSparkIdea(dir, "Build a repo-local spark thread");
    assert.ok(result.sparkMdPath);
    const rootSpark = await readFile(result.sparkMdPath!, "utf8");
    assert.match(rootSpark, /Build a repo-local spark thread/);
    assert.match(rootSpark, /## Working title/);
    assert.doesNotMatch(rootSpark, /## Delivery expectation/);
    assert.doesNotMatch(rootSpark, /待确认/);
    assert.doesNotMatch(rootSpark, /To be confirmed/);
    assert.doesNotMatch(rootSpark, /## 生态关系/);
    const threadJson = await readFile(join(dir, ".spark", "thread.json"), "utf8");
    assert.match(threadJson, /Review initial direction/);
    assert.doesNotMatch(threadJson, /Maintain current interaction context/);
    assert.doesNotMatch(threadJson, /"currentTaskRef"/);
    assert.doesNotMatch(threadJson, /"todos"/);
    await assert.rejects(() => readFile(join(dir, ".spark", "todos.json"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("initializeSparkIdea does not overwrite an existing initialized thread", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-no-overwrite-"));
  try {
    await mkdir(join(dir, ".git"));
    const first = await initializeSparkIdea(dir, "Original project intent");
    const firstSpark = await readFile(join(dir, "SPARK.md"), "utf8");
    const second = await initializeSparkIdea(dir, "New accidental request");
    const secondSpark = await readFile(join(dir, "SPARK.md"), "utf8");
    assert.equal(second.threadRef, first.threadRef);
    assert.equal(secondSpark, firstSpark);
    assert.doesNotMatch(secondSpark, /New accidental request/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("active Spark prompt preserves base prompt and avoids repeated Spark docs", () => {
  const prompt = renderSparkActiveSystemPrompt("Base prompt", "SPARK.md");
  assert.match(prompt, /^Base prompt\n\nSpark is active for this workspace/);
  assert.match(prompt, /standing project state/);
  assert.match(prompt, /Spark tools for thread\/task\/TODO\/DAG\/ask state/);
  assert.match(prompt, /fix concrete repo behavior feedback in code\/docs\/tests/);
  assert.doesNotMatch(prompt, /Do not auto-create placeholder tasks or threads/);
  assert.doesNotMatch(prompt, /Before launching multiple roles or parallel workstreams/);
  assert.doesNotMatch(prompt, /prefer direct-exec commands and Pi file tools over \/bin\/sh/);
  assert.doesNotMatch(prompt, /Do not satisfy such feedback by only storing memory or preferences/);
});

void test("active Spark context can summarize a sole thread without persisting current selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-no-current-before-activation-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    graph.createThread({ title: "Dormant thread", description: "Not active yet" });
    await defaultTaskGraphStore(dir).save(graph);

    const summary = await renderActiveSparkContextSummary(dir, {
      cwd: dir,
      sessionManager: {
        getSessionFile: () => join(dir, ".pi-sessions", "default.json"),
        getLeafId: () => "default-leaf",
      },
    });

    assert.match(summary ?? "", /Dormant thread/);
    await assert.rejects(() => stat(join(dir, ".spark", "current-thread")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("active Spark context keeps strict limits for intent, claimed tasks, and TODOs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-active-context-limits-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    await writeFile(
      join(dir, "SPARK.md"),
      [
        "# Spark intent",
        "",
        ...Array.from({ length: 40 }, (_, index) => `Intent line ${index}`),
      ].join("\n"),
      "utf8",
    );
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Compact limits", description: "Compact limits" });
    const task = graph.createTask({
      threadRef: thread.ref,
      name: "claimed-0",
      title: "Claimed task 0",
      description: "Trim active prompt context.",
      status: "running",
      todos: Array.from({ length: 5 }, (_, todoIndex) => ({
        content: `Visible bounded TODO 0-${todoIndex}`,
        status: "pending" as const,
      })),
    });
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: "leaf:test-leaf",
      sessionId: "leaf:test-leaf",
      leaseMs: 60_000,
    });
    graph.createTask({
      threadRef: thread.ref,
      name: "other-claimed",
      title: "Other claimed task",
      description: "Belongs to another session.",
      status: "running",
      claimedBySession: "leaf:other-leaf",
    });
    await defaultTaskGraphStore(dir).save(graph);
    await defaultTaskTodoStore(dir, "leaf:test-leaf").save(graph);
    const ctx = { cwd: dir, sessionManager: { getLeafId: () => "test-leaf" } };
    await executeSparkToolInTest("spark_status", ctx, {});

    const summary = await renderActiveSparkContextSummary(dir, ctx);
    assert.ok(summary);
    assert.match(summary, /Intent line 17/);
    assert.doesNotMatch(summary, /Intent line 18/);
    assert.match(summary, /read SPARK\.md for full intent/);
    assert.match(summary, /Claimed task 0/);
    assert.doesNotMatch(summary, /Other claimed task/);
    assert.match(summary, /Visible bounded TODO 0-2/);
    assert.doesNotMatch(summary, /Visible bounded TODO 0-3/);
    assert.match(summary, /2 more active TODOs/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("active Spark context omits finished history and finished TODOs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-active-context-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    await writeFile(
      join(dir, "SPARK.md"),
      [
        "# Spark intent",
        "",
        "## Goal",
        "Keep the active prompt compact.",
        "",
        "## Revision history",
        "- Finished historical note that should not be injected.",
      ].join("\n"),
      "utf8",
    );
    const graph = new TaskGraph();
    const thread = graph.createThread({ title: "Compact context", description: "Compact context" });
    const active = graph.createTask({
      threadRef: thread.ref,
      name: "compact-context",
      title: "Compact active context",
      description: "Trim active prompt context.",
      status: "running",
      todos: [
        { content: "Keep active TODO", status: "in_progress" },
        { content: "Finished child TODO", status: "done" },
        { content: "Blocked child TODO", status: "blocked" },
      ],
    });
    graph.claimTask(active.ref, {
      kind: "main",
      claimedBy: "leaf:test-leaf",
      sessionId: "leaf:test-leaf",
      leaseMs: 60_000,
    });
    graph.createTask({
      threadRef: thread.ref,
      name: "finished-history",
      title: "Finished task history",
      description: "Historical task that should stay out of active context.",
      status: "done",
      todos: [{ content: "Finished history TODO", status: "done" }],
    });
    await defaultTaskGraphStore(dir).save(graph);
    await defaultTaskTodoStore(dir, "leaf:test-leaf").save(graph);
    await mkdir(join(dir, ".spark", "session-todos"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "session-todos", "leaf-test-leaf.json"),
      JSON.stringify(
        {
          version: 1,
          todos: [
            { id: "todo-active", content: "Independent active TODO", status: "pending" },
            { id: "todo-done", content: "Independent finished TODO", status: "done" },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const ctx = {
      cwd: dir,
      sessionManager: { getLeafId: () => "test-leaf" },
    };
    await executeSparkToolInTest("spark_status", ctx, {});
    const summary = await renderActiveSparkContextSummary(dir, ctx);

    assert.ok(summary);
    assert.match(summary, /SPARK\.md \(active intent excerpt\)/);
    assert.match(summary, /Keep the active prompt compact/);
    assert.doesNotMatch(summary, /Finished historical note/);
    assert.match(summary, /Active Spark context/);
    assert.match(summary, /Unfinished tasks: 1 \/ claimed: 1 \/ claimed_by_session: 1 \(2 total\)/);
    assert.match(summary, /My claimed task: \[running\] @compact-context: Compact active context/);
    assert.match(summary, /Keep active TODO/);
    assert.match(summary, /Blocked child TODO/);
    assert.match(summary, /Independent active TODO/);
    assert.doesNotMatch(summary, /Finished task history/);
    assert.doesNotMatch(summary, /Finished child TODO/);
    assert.doesNotMatch(summary, /Finished history TODO/);
    assert.doesNotMatch(summary, /Independent finished TODO/);
    assert.ok(summary.length < 2_000, `active summary too large: ${summary.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("initializeSparkIdea preserves clarified title and trace ask refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-clarified-"));
  try {
    await mkdir(join(dir, ".git"));
    const result = await initializeSparkIdea(dir, "Build a language service", {
      threadTitle: "Hypha v0: VS Code-first IDE experience for Spore",
      clarification: {
        workingTitle: "Hypha v0: VS Code-first IDE experience for Spore",
        outputLanguage: "en",
        objective: "Clarify the next IDE slice and continue into implementation planning.",
        targetUser: "Spore language contributors",
        smallestSlice: "A documented next-step plan for diagnostics and editor UX.",
        successSignal: "The next tasks are explicit and implementation-ready.",
        nonGoals: "Do not broaden into full plugin architecture yet.",
        deliveryMode: "document_and_execute",
        nextAction: "continue_tasking",
      },
      askArtifactRefs: ["artifact:ask-test"],
      askRefs: ["ask:ask-test"],
    });
    assert.equal(result.threadTitle, "Hypha v0: VS Code-first IDE experience for Spore");
    assert.deepEqual(result.askArtifactRefs, ["artifact:ask-test"]);
    const threadJson = await readFile(join(dir, ".spark", "thread.json"), "utf8");
    assert.match(threadJson, /Hypha v0: VS Code-first IDE experience for Spore/);
    assert.doesNotMatch(threadJson, /Maintain current interaction context/);
    const artifactFiles = await readdir(join(dir, ".spark", "artifacts"));
    let traceBody: unknown;
    for (const file of artifactFiles.filter((entry) => entry.endsWith(".json"))) {
      const content = JSON.parse(
        await readFile(join(dir, ".spark", "artifacts", file), "utf8"),
      ) as { kind?: string; body?: unknown };
      if (content.kind === "run-trace") {
        traceBody = content.body;
        break;
      }
    }
    assert.deepEqual((traceBody as { askRefs?: string[] }).askRefs, ["ask:ask-test"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function executeSparkToolInTest(
  name: string,
  ctx: SparkToolContextForTest,
  params: Record<string, unknown>,
): Promise<void> {
  const tools = new Map<string, SparkToolConfig>();
  sparkExtension({
    registerCommand: () => undefined,
    registerTool: (config) => {
      tools.set(config.name, config);
    },
    on: () => undefined,
    sendUserMessage: () => undefined,
  });
  const tool = tools.get(name);
  assert.ok(tool, `missing Spark tool: ${name}`);
  await tool.execute(`call-${name}`, params, new AbortController().signal, () => undefined, ctx);
}
