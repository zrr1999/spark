import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultArtifactStore } from "@zendev-lab/pi-artifacts";
import { TaskGraph, defaultTaskGraphStore } from "@zendev-lab/pi-tasks";
import {
  handleSparkInput,
  injectSparkHints,
  type SparkInputModeRouter,
} from "../packages/spark-extension/src/extension/spark-active-injection.ts";
import { analyzeSparkEntryMode } from "../packages/spark-extension/src/extension/spark-entry.ts";
import {
  loadSparkMode,
  saveCurrentProjectRef,
} from "../packages/spark-extension/src/extension/session-state.ts";
import { setSessionGoal } from "../packages/spark-extension/src/extension/spark-session-goals.ts";
import type { SparkToolContext } from "../packages/spark-extension/src/extension/spark-tool-registration.ts";

interface TestSparkInputContext extends SparkToolContext {
  editorText?: string;
  notifications: Array<{ message: string; level?: string }>;
  selectCalls: Array<{ title: string; options: string[] }>;
  selectedPrefix?: string;
}

async function withActiveSparkInputProject<T>(
  run: (input: {
    dir: string;
    ctx: TestSparkInputContext;
    router: SparkInputModeRouter;
    customMessages: Array<{
      message: Parameters<SparkInputModeRouter["piApi"]["sendMessage"]>[0];
      options: Parameters<SparkInputModeRouter["piApi"]["sendMessage"]>[1];
    }>;
    queuedInstructions: string[];
  }) => Promise<T>,
  options: { withTasks?: boolean } = {},
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "spark-active-input-"));
  try {
    const ctx = testSparkInputContext(dir);
    const { router, customMessages, queuedInstructions } = testInputRouter();
    await writeActiveProject(dir, ctx, options);
    return await run({ dir, ctx, router, customMessages, queuedInstructions });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
}

void test("injectSparkHints injects default research lens without initialized Spark graph", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-active-input-no-graph-"));
  try {
    const ctx = testSparkInputContext(dir);
    const result = await injectSparkHints({ systemPrompt: "Base prompt." }, ctx);

    assert.equal(typeof result, "object");
    const prompt = (result as { systemPrompt?: string }).systemPrompt ?? "";
    assert.match(prompt, /Spark default research lens\./);
    assert.match(prompt, /<base_system_prompts>/);
    assert.doesNotMatch(prompt, /# Spark/);
    assert.match(prompt, /# pi-cue/);
    assert.match(prompt, /# pi-graft/);
    assert.doesNotMatch(prompt, /Use the read tool to load a skill's file/);
    assert.doesNotMatch(prompt, /Active Spark context/);
    assert.equal((await loadSparkMode(dir, ctx)).mode, "research");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("handleSparkInput lets ordinary research-like input continue without canned route ask", async () => {
  await withActiveSparkInputProject(
    async ({ dir, ctx, router, customMessages, queuedInstructions }) => {
      const result = await handleSparkInput(
        { text: "research X 的实现", source: "interactive" },
        ctx,
        router,
      );

      assert.deepEqual(result, { action: "continue" });
      assert.equal(ctx.selectCalls.length, 0);
      assert.equal(customMessages.length, 0);
      assert.equal(queuedInstructions.length, 0);
      assert.equal((await defaultArtifactStore(dir).list({ producer: "ask" })).length, 0);
      assert.equal((await loadSparkMode(dir, ctx)).mode, "research");
    },
  );
});

void test("handleSparkInput does not turn until-done input into a template ask", async () => {
  await withActiveSparkInputProject(
    async ({ dir, ctx, router, customMessages, queuedInstructions }) => {
      const result = await handleSparkInput(
        { text: "把 ready 任务都跑完", source: "interactive" },
        ctx,
        router,
      );

      assert.deepEqual(result, { action: "continue" });
      assert.equal(ctx.selectCalls.length, 0);
      assert.equal(customMessages.length, 0);
      assert.equal(queuedInstructions.length, 0);
      assert.equal((await defaultArtifactStore(dir).list({ producer: "ask" })).length, 0);
      assert.equal((await loadSparkMode(dir, ctx)).mode, "research");
    },
  );
});

void test("handleSparkInput lets active goal input bypass research route ask", async () => {
  await withActiveSparkInputProject(
    async ({ dir, ctx, router, customMessages, queuedInstructions }) => {
      await setSessionGoal(dir, ctx, {
        objective: "Finish the active goal without interactive routing asks.",
        source: "explicit",
        status: "active",
      });

      const result = await handleSparkInput(
        { text: "这个恶性 bug 需要修复一下", source: "interactive" },
        ctx,
        router,
      );

      assert.deepEqual(result, { action: "continue" });
      assert.equal(ctx.selectCalls.length, 0);
      assert.equal(customMessages.length, 0);
      assert.equal(queuedInstructions.length, 0);
      assert.equal((await defaultArtifactStore(dir).list({ producer: "ask" })).length, 0);
      assert.equal((await loadSparkMode(dir, ctx)).mode, "research");
    },
  );
});

void test("analyzeSparkEntryMode treats stack-trace bugfix with no tasks as planning work", () => {
  const graph = new TaskGraph();
  const project = graph.createProject({
    title: "Stack trace project",
    description: "Project for stack trace mode analysis.",
  });
  const analysis = analyzeSparkEntryMode(
    graph,
    {
      kind: "initialized",
      hasCurrentProject: true,
      unfinishedTaskCount: 0,
    },
    [
      "TypeError: factory is not a function",
      "    at Object.execute (/tmp/tool.js:12:3)",
      "这个恶性 bug 需要修复一下",
    ].join("\n"),
    project,
  );

  assert.equal(analysis.recommendation, "plan");
  assert.match(analysis.reasons.join("\n"), /no pending\/ready project task exists/);
});

void test("handleSparkInput lets slash commands bypass default research routing", async () => {
  await withActiveSparkInputProject(
    async ({ dir, ctx, router, customMessages, queuedInstructions }) => {
      ctx.selectedPrefix = "Research";

      const result = await handleSparkInput(
        { text: "/plan X 的实现", source: "interactive" },
        ctx,
        router,
      );

      assert.deepEqual(result, { action: "continue" });
      assert.equal(ctx.selectCalls.length, 0);
      assert.equal(customMessages.length, 0);
      assert.equal(queuedInstructions.length, 0);
      assert.equal((await defaultArtifactStore(dir).list({ producer: "ask" })).length, 0);
      assert.equal((await loadSparkMode(dir, ctx)).mode, "research");
    },
  );
});

function testSparkInputContext(cwd: string): TestSparkInputContext {
  const sessionFile = join(cwd, ".pi-sessions", "active-input.json");
  const ctx: TestSparkInputContext = {
    cwd,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getLeafId: () => "active-input-leaf",
    },
    notifications: [],
    selectCalls: [],
    ui: {
      notify(message, level) {
        ctx.notifications.push({ message, level });
      },
      setEditorText(text) {
        ctx.editorText = text;
      },
      select: async (title, options) => {
        ctx.selectCalls.push({ title, options });
        const prefix = ctx.selectedPrefix;
        if (!prefix) return undefined;
        return options.find((option) => option.startsWith(prefix));
      },
    },
  };
  return ctx;
}

function testInputRouter(): {
  router: SparkInputModeRouter;
  customMessages: Array<{
    message: Parameters<SparkInputModeRouter["piApi"]["sendMessage"]>[0];
    options: Parameters<SparkInputModeRouter["piApi"]["sendMessage"]>[1];
  }>;
  queuedInstructions: string[];
} {
  const customMessages: Array<{
    message: Parameters<SparkInputModeRouter["piApi"]["sendMessage"]>[0];
    options: Parameters<SparkInputModeRouter["piApi"]["sendMessage"]>[1];
  }> = [];
  const queuedInstructions: string[] = [];
  return {
    customMessages,
    queuedInstructions,
    router: {
      piApi: {
        sendMessage(message, options) {
          customMessages.push({ message, options });
        },
      },
      deps: {
        queueSparkAgentInstruction: (_ctx, instruction) => queuedInstructions.push(instruction),
        refreshSparkWidget: async () => undefined,
        ensureWorkflowRunManager: () => undefined,
      },
    },
  };
}

async function writeActiveProject(
  dir: string,
  ctx: SparkToolContext,
  options: { withTasks?: boolean } = {},
): Promise<void> {
  const graph = new TaskGraph();
  const project = graph.createProject({
    title: "Auto route project",
    description: "Project for active input routing tests.",
  });
  if (options.withTasks !== false) {
    graph.createTask({
      projectRef: project.ref,
      name: "ready-task",
      title: "Ready task",
      description: "Ready task for execute routing.",
      status: "ready",
    });
    graph.createTask({
      projectRef: project.ref,
      name: "pending-task",
      title: "Pending task",
      description: "Pending task for plan routing.",
      status: "pending",
    });
  }
  await mkdir(join(dir, ".spark"), { recursive: true });
  await defaultTaskGraphStore(dir).save(graph);
  await saveCurrentProjectRef(dir, ctx, project.ref);
}
