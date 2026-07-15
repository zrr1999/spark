import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionRoleRunner } from "@zendev-lab/spark-extension-api";

import {
  listSavedWorkflows,
  defaultSparkDynamicWorkflowEventStore,
  defaultSparkDynamicWorkflowManager,
  defaultSparkDynamicWorkflowRunStore,
  parseWorkflowScript,
  projectWorkflowRunEvents,
  readSavedWorkflow,
  runWorkflowScript,
  type SparkDynamicWorkflowEventInput,
  type WorkflowRunEvent,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "../packages/spark-workflows/src/index.ts";
import {
  fanOutWithBriefWorkflowScript,
  researchWorkflowScript,
  reviewWorkflowScript,
} from "../packages/spark-workflows/src/builtins.ts";
import {
  createSparkWorkflowRoleRunAdapter,
  SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS,
  type SparkRoleRunResult,
  type SparkWorkflowGraftAgentResult,
  type SparkWorkflowRoleRunRequest,
} from "../packages/spark-runtime/src/index.ts";
import {
  registerSparkWorkflowRunTool,
  workflowAgentTelemetryFromRoleRun,
} from "../packages/pi-extension/src/extension/spark-workflow-run-tool-registration.ts";
import {
  buildSparkDynamicWorkflowDashboardView,
  formatSparkDynamicWorkflowRunLine,
  renderSparkDynamicWorkflowDashboardText,
} from "../packages/pi-extension/src/extension/spark-dynamic-workflow-run-rendering.ts";

void test("spark-workflows package stays isolated from runtime execution packages", async () => {
  const pkg = JSON.parse(await readFile("packages/spark-workflows/package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };

  assert.equal(pkg.dependencies?.["@zendev-lab/spark-runtime"], undefined);
  assert.equal(pkg.dependencies?.["@zendev-lab/spark-roles"], undefined);
  assert.equal(pkg.dependencies?.["spark-goal"], undefined);

  const sourceFiles = await listTypeScriptFiles("packages/spark-workflows/src");
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /(?:from\s+["']|import\(["'])(?:spark-runtime|spark-roles|spark-goal)["']/u,
      `${file} must not import runtime execution or goal packages`,
    );
  }
});

void test("Spark production code uses generic spark-workflows imports instead of removed aliases", async () => {
  const sourceFiles = await listTypeScriptFiles("packages/pi-extension/src");
  const removedPiWorkflowImports =
    /import\s+(?:type\s+)?\{[^}]*\b(?:defaultSparkDagRunStore|defaultWorkflowRunStore|workspaceWorkflowDir|SparkDag\w*|SparkWorkflow\w*|sparkDagRunNextSteps|runReadySparkTasks)\b[^}]*\}\s+from\s+["'](?:@zendev-lab\/)?spark-workflows["']/su;
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      removedPiWorkflowImports,
      `${file} must import generic Workflow* symbols from spark-workflows; Spark-named aliases are removed`,
    );
  }
});

void test("spark-workflows parses metadata without executing expressions", () => {
  assert.throws(
    () =>
      parseWorkflowScript(`export const meta = {
  name: (() => { throw new Error('meta executed') })(),
  description: 'Demo workflow',
}`),
    /unsupported identifier|expected identifier/,
  );

  const parsed = parseWorkflowScript(`export const meta = {
  name: 'demo { literal }',
  description: "Demo // workflow",
  stages: [
    // braces in comments should not terminate metadata: { }
    { title: 'Scan' },
  ],
}
return 'ok'`);

  assert.equal(parsed.meta.name, "demo { literal }");
  assert.equal(parsed.meta.description, "Demo // workflow");
  assert.deepEqual(parsed.meta.stages, [{ title: "Scan" }]);
  assert.deepEqual(parsed.meta.phases, [{ title: "Scan" }]);
  assert.equal(parsed.body, "return 'ok'");
});

void test("spark-workflows parses metadata and runs sandbox primitives with journal", async () => {
  const script = `export const meta = {
  name: 'demo',
  description: 'Demo workflow',
  stages: [{ title: 'Scan' }, { title: 'Report' }],
}

stage('Scan')
const scan = await agent('scan repo', { label: 'scan' })
stage('Report')
const [a, b] = await parallel([
  () => agent('check a', { label: 'a' }),
  () => agent('check b', { label: 'b' }),
])
return { scan, a, b }`;

  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "demo");
  assert.deepEqual(
    parsed.meta.stages?.map((stage) => stage.title),
    ["Scan", "Report"],
  );

  const prompts: string[] = [];
  const result = await runWorkflowScript(script, {
    agent: async (prompt) => {
      prompts.push(prompt);
      return "result: " + prompt;
    },
  });
  assert.deepEqual(prompts, ["scan repo", "check a", "check b"]);
  assert.deepEqual(
    result.stages?.map((stage) => stage.title),
    ["Scan", "Report"],
  );
  assert.deepEqual(
    result.phases.map((stage) => stage.title),
    ["Scan", "Report"],
  );
  assert.equal(result.agentCount, 3);
  assert.equal(result.journal.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    scan: "result: scan repo",
    a: "result: check a",
    b: "result: check b",
  });

  const replayPrompts: string[] = [];
  const replay = await runWorkflowScript(script, {
    resumeJournal: new Map(result.journal.map((entry) => [entry.index, entry])),
    agent: async (prompt) => {
      replayPrompts.push(prompt);
      return "rerun: " + prompt;
    },
  });
  assert.deepEqual(replayPrompts, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(replay.result)),
    JSON.parse(JSON.stringify(result.result)),
  );
});

void test("spark-workflows lists and reads builtin workflows without frontmatter mode", async () => {
  const listing = await listSavedWorkflows(".", {
    includeUser: false,
    workspaceWorkflowDir: "/definitely/missing/spark-workflows",
  });

  assert.deepEqual(listing.errors, []);
  assert.deepEqual(
    listing.workflows.map((workflow) => workflow.selector),
    ["builtin:research", "builtin:review"],
  );
  assert.deepEqual(
    listing.workflows.map((workflow) => workflow.mode),
    ["plan", "plan"],
  );

  const { descriptor, script } = await readSavedWorkflow({
    cwd: ".",
    selector: "builtin:research",
    includeUser: false,
  });
  assert.equal(descriptor.source, "builtin");
  assert.equal(descriptor.mode, "plan");
  assert.equal(descriptor.path, "builtin:research");
  assert.deepEqual(descriptor.stages, ["Plan", "Search", "Fetch", "Verify", "Report"]);
  assert.deepEqual(descriptor.phases, ["Plan", "Search", "Fetch", "Verify", "Report"]);
  assert.match(script, /export const meta/);
  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "research");
  assert.equal("mode" in parsed.meta, false);

  await assert.rejects(
    () => readSavedWorkflow({ cwd: ".", selector: "builtin:missing", includeUser: false }),
    /unknown builtin workflow: missing/,
  );
  await assert.rejects(
    () => readSavedWorkflow({ cwd: ".", selector: "inline:demo", includeUser: false }),
    /workflow selector must be builtin:<id>, workspace:<id>, or user:<id>/,
  );
});

void test("spark-workflows research builtin fans out with collected errors and report synthesis", async () => {
  const { descriptor, script } = await readSavedWorkflow({
    cwd: ".",
    selector: "builtin:research",
    includeUser: false,
  });
  assert.equal(descriptor.source, "builtin");
  assert.equal(descriptor.mode, "plan");
  assert.deepEqual(descriptor.stages, ["Plan", "Search", "Fetch", "Verify", "Report"]);
  assert.deepEqual(descriptor.phases, ["Plan", "Search", "Fetch", "Verify", "Report"]);

  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "research");
  assert.equal("mode" in parsed.meta, false);

  const agentCalls: Array<{ prompt: string; label?: string; model?: string; agentType?: string }> =
    [];
  const run = await runWorkflowScript(researchWorkflowScript(), {
    args: {
      question: "Should research live in workflows?",
      panelModels: [
        { label: "fast", model: "provider/fast" },
        { label: "blocked", model: "provider/blocked" },
      ],
      judgeModel: "provider/judge",
    },
    agent: async (prompt, options) => {
      agentCalls.push({
        prompt,
        label: options.label,
        model: options.model,
        agentType: options.agentType,
      });
      if (options.label === "blocked") throw new Error("MODEL_BLOCKED");
      if (options.label === "write cited report") return "final synthesis";
      return "panel answer from " + options.label;
    },
    webSearch: (request) => ({
      answer: "search answer for " + (request.query ?? ""),
      results: [{ title: "source", url: "https://example.test/source" }],
    }),
    fetchContent: (request) => ({ url: request.url, text: "source facts" }),
  });

  assert.equal(run.agentCount, 5);
  assert.deepEqual(
    run.stages?.map((stage) => stage.title),
    ["Plan", "Search", "Fetch", "Verify", "Report"],
  );
  assert.deepEqual(
    agentCalls.map((call) => call.label),
    ["research plan", "fast", "blocked", "cross-check sources", "write cited report"],
  );
  assert.deepEqual(
    agentCalls.map((call) => call.agentType),
    [undefined, "model", "model", undefined, "model"],
  );
  assert.equal(agentCalls[1]?.model, "provider/fast");
  assert.equal(agentCalls[4]?.model, "provider/judge");
  assert.match(agentCalls[1]?.prompt ?? "", /Assess the source evidence/);
  assert.match(agentCalls[3]?.prompt ?? "", /MODEL_BLOCKED/);
  assert.match(agentCalls[4]?.prompt ?? "", /final user-facing deep research report/);
  assert.equal((run.result as { report?: unknown }).report, "final synthesis");
});

void test("spark-workflows exposes and runs workflow script factories", async () => {
  const research = parseWorkflowScript(researchWorkflowScript());
  assert.equal(research.meta.name, "research");
  assert.deepEqual(
    research.meta.stages?.map((stage) => stage.title),
    ["Plan", "Search", "Fetch", "Verify", "Report"],
  );

  const review = parseWorkflowScript(reviewWorkflowScript());
  assert.equal(review.meta.name, "review");
  assert.deepEqual(
    review.meta.stages?.map((stage) => stage.title),
    ["Investigate", "Critique", "Rebut", "Verdict"],
  );

  const fanOut = parseWorkflowScript(fanOutWithBriefWorkflowScript());
  assert.equal(fanOut.meta.name, "fan_out_with_brief");
  assert.deepEqual(
    fanOut.meta.stages?.map((stage) => stage.title),
    ["Brief", "Fan out", "Fan in"],
  );

  const researchRun = await runWorkflowScript(researchWorkflowScript(), {
    args: { question: "workflow smoke" },
    agent: async (_prompt, options) => options.label ?? "agent",
  });
  assert.equal(researchRun.agentCount, 5);
  assert.deepEqual(
    researchRun.stages?.map((stage) => stage.title),
    ["Plan", "Search", "Fetch", "Verify", "Report"],
  );

  const reviewRun = await runWorkflowScript(reviewWorkflowScript(), {
    args: { task: "workflow smoke" },
    agent: async (_prompt, options) => options.label ?? "agent",
  });
  assert.equal(reviewRun.agentCount, 5);
  assert.deepEqual(
    reviewRun.stages?.map((stage) => stage.title),
    ["Investigate", "Critique", "Rebut", "Verdict"],
  );
});

void test("spark-workflows records explicit stage statuses", async () => {
  const script = `export const meta = {
    name: 'stage status',
    description: 'Stage status workflow',
  }

  stage('Scan')
  await agent('scan work', { label: 'scan' })
  stage('Scan', { status: 'success' })
  stage('Skipped', { status: 'skip' })
  return 'done'`;

  const stageEvents: Array<{
    title: string;
    status?: string;
    startedAt: string;
    finishedAt?: string;
  }> = [];
  const run = await runWorkflowScript(script, {
    now: (() => {
      let tick = 0;
      return () => `2026-06-09T00:00:0${tick++}.000Z`;
    })(),
    agent: async (_prompt, options) => options.stage ?? "none",
    onStage: (event) => stageEvents.push(event),
  });

  assert.deepEqual(run.stages, [
    {
      title: "Scan",
      status: "success",
      startedAt: "2026-06-09T00:00:00.000Z",
      finishedAt: "2026-06-09T00:00:01.000Z",
    },
    {
      title: "Skipped",
      status: "skip",
      startedAt: "2026-06-09T00:00:02.000Z",
      finishedAt: "2026-06-09T00:00:02.000Z",
    },
  ]);
  assert.deepEqual(stageEvents, [
    { title: "Scan", startedAt: "2026-06-09T00:00:00.000Z" },
    {
      title: "Scan",
      status: "success",
      startedAt: "2026-06-09T00:00:00.000Z",
      finishedAt: "2026-06-09T00:00:01.000Z",
    },
    {
      title: "Skipped",
      status: "skip",
      startedAt: "2026-06-09T00:00:02.000Z",
      finishedAt: "2026-06-09T00:00:02.000Z",
    },
  ]);
});

void test("spark-workflows emits typed run events and projects snapshots", async () => {
  const script = `export const meta = { name: 'eventful', description: 'eventful workflow' }
stage('Plan')
const web = await webSearch({ query: 'events' })
const values = await parallel([
  () => agent('first', { label: 'first' }),
  () => fetchContent({ url: 'https://example.test/source' }),
], { concurrency: 2 })
stage('Plan', { status: 'success' })
return { web, values }`;
  const events: WorkflowRunEvent[] = [];

  const run = await runWorkflowScript(script, {
    agent: async (_prompt, options) => ({ label: options.label, ok: true }),
    webSearch: (request) => ({ query: request.query, results: [] }),
    fetchContent: (request) => ({ url: request.url, text: "content" }),
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(run.result && typeof run.result === "object", true);
  assert.deepEqual(
    events.map((event) => event.type).filter((type) => type !== "parallel_item_succeeded"),
    [
      "run_started",
      "stage_started",
      "tool_started",
      "tool_succeeded",
      "parallel_group_started",
      "parallel_item_started",
      "agent_started",
      "parallel_item_started",
      "tool_started",
      "tool_succeeded",
      "agent_succeeded",
      "parallel_group_succeeded",
      "stage_finished",
      "run_succeeded",
    ],
  );
  assert.ok(events.some((event) => event.type === "parallel_item_succeeded"));
  const snapshot = projectWorkflowRunEvents(events);
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.meta?.name, "eventful");
  assert.deepEqual(
    snapshot.nodes.map((node) => [node.kind, node.label, node.status]),
    [
      ["run", "eventful", "succeeded"],
      ["stage", "Plan", "succeeded"],
      ["tool", "webSearch", "succeeded"],
      ["parallel_group", "parallel group 1", "succeeded"],
      ["parallel_item", "parallel item 1", "succeeded"],
      ["agent", "first", "succeeded"],
      ["parallel_item", "parallel item 2", "succeeded"],
      ["tool", "fetchContent", "succeeded"],
    ],
  );
  assert.deepEqual(
    snapshot.stages.map((stage) => stage.id),
    ["stage:Plan"],
  );
  assert.deepEqual(
    snapshot.phases.map((stage) => stage.id),
    ["stage:Plan"],
  );
  assert.deepEqual(snapshot.nodesById["parallel:0"]?.children, [
    "parallel:0:item:0",
    "parallel:0:item:1",
  ]);
  assert.equal(snapshot.nodesById["parallel:0"]?.parentId, "stage:Plan");
  assert.equal(snapshot.nodesById["agent:0"]?.parentId, "parallel:0:item:0");
  assert.equal(snapshot.nodesById["tool:1"]?.parentId, "parallel:0:item:1");
});

void test("spark-workflows projects zero-agent parallel helper work into dashboard tree", async () => {
  const script = `export const meta = { name: 'zero agent fanout', description: 'zero agent fanout workflow' }
stage('Fanout')
const results = await parallel([
  () => webSearch({ query: 'fanout' }),
  () => fetchContent({ url: 'https://example.test/facts' }),
  () => artifactRecord({ title: 'Brief', body: 'Body' }),
  () => workflow('child', { marker: 'nested' }),
], { concurrency: 2 })
stage('Fanout', { status: 'success' })
return results`;
  const child = `export const meta = { name: 'child', description: 'child workflow' }
return { child: true }`;
  const events: WorkflowRunEvent[] = [];
  const run = await runWorkflowScript(script, {
    agent: async () => assert.fail("zero-agent fanout should not call agent"),
    artifactRecord: async () => ({ ref: "artifact:fanout-brief" }),
    webSearch: (request) => ({ searched: request.query }),
    fetchContent: (request) => ({ fetched: request.url }),
    loadWorkflowScript: (name) => (name === "child" ? child : undefined),
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(run.agentCount, 0);
  const snapshot = projectWorkflowRunEvents(events);
  assert.equal(snapshot.nodesById["parallel:0"]?.kind, "parallel_group");
  assert.deepEqual(snapshot.nodesById["parallel:0"]?.children, [
    "parallel:0:item:0",
    "parallel:0:item:1",
    "parallel:0:item:2",
    "parallel:0:item:3",
  ]);
  assert.equal(snapshot.nodesById["tool:0"]?.parentId, "parallel:0:item:0");
  assert.equal(snapshot.nodesById["tool:1"]?.parentId, "parallel:0:item:1");
  assert.equal(snapshot.nodesById["tool:2"]?.parentId, "parallel:0:item:2");
  assert.equal(snapshot.nodesById["artifact:artifact:fanout-brief"]?.parentId, "tool:2");
  assert.equal(snapshot.nodesById["workflow:0"]?.parentId, "parallel:0:item:3");

  const dir = await mkdtemp(join(tmpdir(), "spark-zero-agent-fanout-dashboard-"));
  try {
    const store = defaultSparkDynamicWorkflowEventStore(dir);
    const meta = parseWorkflowScript(script).meta;
    const runRef = "run:zero-agent-fanout" as const;
    await store.startRun({
      runRef,
      source: { kind: "inline", label: "zero-agent fanout dashboard" },
      script,
      meta,
      options: { concurrency: 2 },
      now: "2026-06-23T00:00:00.000Z",
    });
    for (const event of events.filter((candidate) => candidate.type !== "run_started")) {
      const { id: _id, sequence: _sequence, timestamp, type, ...input } = event;
      await store.appendEvent(runRef, {
        ...(input as SparkDynamicWorkflowEventInput),
        type,
        timestamp,
      });
    }
    const dashboard = renderSparkDynamicWorkflowDashboardText(
      buildSparkDynamicWorkflowDashboardView({
        action: "inspect",
        runs: await store.listRuns(),
        includeHistory: true,
        detailed: true,
        targetRunRef: runRef,
      }),
    );
    assert.match(dashboard, /parallel_group parallel group 1 \[succeeded\]/);
    assert.match(dashboard, /parallel_item parallel item 1 \[succeeded\]/);
    assert.match(dashboard, /tool webSearch \[succeeded\]/);
    assert.match(dashboard, /tool fetchContent \[succeeded\]/);
    assert.match(dashboard, /artifact artifact:fanout-brief \[succeeded\]/);
    assert.match(dashboard, /nested_workflow child \[succeeded\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark-workflows projects failed run and node events", async () => {
  const script = `export const meta = { name: 'failed events', description: 'failed event workflow' }
stage('Work')
await agent('explode', { label: 'boom' })`;
  const events: WorkflowRunEvent[] = [];

  await assert.rejects(
    () =>
      runWorkflowScript(script, {
        agent: async () => {
          throw new Error("agent exploded");
        },
        onEvent: (event) => {
          events.push(event);
        },
      }),
    /agent exploded/,
  );

  const snapshot = projectWorkflowRunEvents(events);
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.errorMessage, "agent exploded");
  assert.equal(snapshot.nodesById["agent:0"]?.status, "failed");
  assert.equal(snapshot.nodesById["agent:0"]?.errorMessage, "agent exploded");
});

void test("spark-workflows projects status-only, artifact, log, nested, cached, and helper error events", async () => {
  const statusOnlyEvents: WorkflowRunEvent[] = [];
  await runWorkflowScript(
    `export const meta = { name: 'status only', description: 'status-only stage' }
stage('Skipped', { status: 'skip' })
log('note from workflow')
return 'ok'`,
    {
      agent: async () => "unused",
      onEvent: (event) => {
        statusOnlyEvents.push(event);
      },
    },
  );
  const statusOnly = projectWorkflowRunEvents(statusOnlyEvents);
  assert.equal(statusOnly.nodesById["stage:Skipped"]?.status, "skipped");
  assert.ok(
    statusOnly.eventTail.some(
      (event) => event.type === "log" && event.message === "note from workflow",
    ),
  );

  const artifactEvents: WorkflowRunEvent[] = [];
  await runWorkflowScript(
    `export const meta = { name: 'artifact events', description: 'artifact event workflow' }
return await artifactRecord({ title: 'Brief', body: 'Body' })`,
    {
      agent: async () => "unused",
      artifactRecord: async () => ({ ref: "artifact:brief" }),
      onEvent: (event) => {
        artifactEvents.push(event);
      },
    },
  );
  const artifactSnapshot = projectWorkflowRunEvents(artifactEvents);
  assert.equal(artifactSnapshot.nodesById["artifact:artifact:brief"]?.kind, "artifact");
  assert.equal(artifactSnapshot.nodesById["artifact:artifact:brief"]?.status, "succeeded");

  const child = `export const meta = { name: 'child', description: 'child workflow' }
stage('Child')
return { child: true }`;
  const nestedEvents: WorkflowRunEvent[] = [];
  await runWorkflowScript(
    `export const meta = { name: 'parent', description: 'parent workflow' }
const child = await workflow('child')
return child`,
    {
      agent: async () => "unused",
      loadWorkflowScript: (name) => (name === "child" ? child : undefined),
      onEvent: (event) => {
        nestedEvents.push(event);
      },
    },
  );
  assert.deepEqual(
    nestedEvents
      .filter((event) => event.type.startsWith("nested_workflow"))
      .map((event) => event.type),
    ["nested_workflow_started", "nested_workflow_succeeded"],
  );
  assert.equal(new Set(nestedEvents.map((event) => event.sequence)).size, nestedEvents.length);
  assert.equal(projectWorkflowRunEvents(nestedEvents).nodesById["workflow:0"]?.status, "succeeded");

  const initial = await runWorkflowScript(
    `export const meta = { name: 'cache source', description: 'cache source workflow' }
return await agent('cached', { label: 'cached agent' })`,
    { agent: async () => "cached-result" },
  );
  const cachedEvents: WorkflowRunEvent[] = [];
  await runWorkflowScript(
    `export const meta = { name: 'cache source', description: 'cache source workflow' }
return await agent('cached', { label: 'cached agent' })`,
    {
      resumeJournal: new Map(initial.journal.map((entry) => [entry.index, entry])),
      agent: async () => assert.fail("cached agent should not run"),
      onEvent: (event) => {
        cachedEvents.push(event);
      },
    },
  );
  assert.equal(projectWorkflowRunEvents(cachedEvents).nodesById["agent:0"]?.status, "cached");

  const helperErrorEvents: WorkflowRunEvent[] = [];
  await assert.rejects(
    () =>
      runWorkflowScript(
        `export const meta = { name: 'helper error', description: 'helper error workflow' }
return await webSearch({ query: 'boom' })`,
        {
          agent: async () => "unused",
          webSearch: () => {
            throw new Error("search exploded");
          },
          onEvent: (event) => {
            helperErrorEvents.push(event);
          },
        },
      ),
    /search exploded/,
  );
  const helperError = projectWorkflowRunEvents(helperErrorEvents);
  assert.equal(helperError.status, "failed");
  assert.equal(helperError.nodesById["tool:0"]?.status, "failed");
  assert.equal(helperError.nodesById["tool:0"]?.errorMessage, "search exploded");
});

void test("spark-workflows applies stage model defaults and per-agent overrides", async () => {
  const script = `export const meta = {
    name: 'model routing',
    description: 'Model routing workflow',
    stages: [{ title: 'Scan', model: 'provider/stage-model' }],
  }

  stage('Scan')
  await agent('stage default', { label: 'default' })
  await agent('agent override', { label: 'override', model: 'provider/agent-model' })`;

  const models: Array<string | undefined> = [];
  await runWorkflowScript(script, {
    agent: async (_prompt, options) => {
      models.push(options.model);
      return "ok";
    },
  });

  assert.deepEqual(models, ["provider/stage-model", "provider/agent-model"]);
});

void test("spark-workflows role-run adapter sends model agents through model runner hook", async () => {
  const roleRequests: unknown[] = [];
  const modelRequests: unknown[] = [];
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-worker",
    async runRoleInstruction(request) {
      roleRequests.push(request);
      return { text: "role result" };
    },
    async runModelInstruction(request) {
      modelRequests.push(request);
      return { text: "model result" };
    },
  });

  const result = await agent("Compare model answers", {
    index: 1,
    label: "panel 1",
    stage: "Panel",
    model: "provider/model",
    agentType: "model",
    timeoutMs: 250,
    artifactRef: "artifact:brief-456",
  });

  assert.equal(result, "model result");
  assert.equal(roleRequests.length, 0);
  assert.equal(modelRequests.length, 1);
  const request = modelRequests[0] as {
    prompt: string;
    label: string;
    stage?: string;
    phase?: string;
    model?: string;
    metadata: Record<string, unknown>;
  };
  assert.equal(request.prompt, "Compare model answers");
  assert.equal(request.label, "panel 1");
  assert.equal(request.stage, "Panel");
  assert.equal(request.phase, "Panel");
  assert.equal(request.model, "provider/model");
  assert.equal(request.metadata.workflowAgent, true);
  assert.equal(request.metadata.agentType, "model");
  assert.equal(request.metadata.index, 1);
  assert.equal(request.metadata.timeoutMs, 250);
  assert.equal(request.metadata.artifactRef, "artifact:brief-456");
});

void test("spark-workflows role-run adapter forwards child usage telemetry", async () => {
  const reported: unknown[] = [];
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-worker",
    async runRoleInstruction() {
      return {
        text: "role result",
        telemetry: {
          runRef: "run:child-telemetry",
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, costUsd: 0.004 },
        },
      };
    },
  });

  const result = await agent("Inspect usage", {
    index: 0,
    reportTelemetry: (telemetry) => reported.push(telemetry),
  });

  assert.equal(result, "role result");
  assert.deepEqual(reported, [
    {
      runRef: "run:child-telemetry",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, costUsd: 0.004 },
      metadata: {},
    },
  ]);
});

void test("Spark workflow_run extracts provider usage from role-run JSON events", () => {
  const roleResult: SparkRoleRunResult = {
    record: {
      ref: "run:child-json" as `run:${string}`,
      roleRef: "role:builtin-worker" as `role:${string}`,
      runName: "usage child",
      instruction: "report usage",
      status: "succeeded",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:00:05.000Z",
      model: "fallback-model",
    },
    stdout: "",
    stderr: "",
    jsonEvents: [
      {
        type: "done",
        message: {
          role: "assistant",
          model: "provider/model",
          provider: "provider",
          timestamp: 1_782_086_400_000,
          usage: {
            input: 100,
            output: 40,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 155,
            cost: { total: 0.0123 },
          },
        },
      },
    ],
  };

  assert.deepEqual(workflowAgentTelemetryFromRoleRun(roleResult), {
    runRef: "run:child-json",
    lastActivityAt: "2026-06-22T00:00:00.000Z",
    metadata: { runRef: "run:child-json", roleStatus: "succeeded" },
    usage: {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 155,
      costUsd: 0.0123,
      model: "provider/model",
      provider: "provider",
    },
  });
});

void test("spark-workflows role-run adapter fails model agents when model hook is missing", async () => {
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-worker",
    async runRoleInstruction() {
      return { text: "role result" };
    },
  });

  await assert.rejects(
    () =>
      agent("model prompt", {
        index: 0,
        agentType: "model",
      }),
    /workflow model agent runner is not configured/,
  );
});

void test("spark-workflows role-run adapter maps workflow agents to Spark dependency boundary", async () => {
  const requests: unknown[] = [];
  const telemetryReports: unknown[] = [];
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-worker",
    graftBaseRef: "tree:isolated",
    async runRoleInstruction(request) {
      requests.push(request);
      return { text: "adapter result with scratch:abc candidate:def patch:ghi" };
    },
  });

  const result = (await agent("Inspect auth routes", {
    index: 2,
    label: "auth reviewer",
    stage: "Review",
    model: "provider/model",
    agentType: "reviewer",
    isolation: "graft",
    timeoutMs: 123,
    artifactRef: "artifact:brief-123",
    reportTelemetry: (telemetry) => {
      telemetryReports.push(telemetry);
    },
  })) as SparkWorkflowGraftAgentResult;

  assert.equal(result.text, "adapter result with scratch:abc candidate:def patch:ghi");
  assert.deepEqual(result.graftRefs, {
    scratchRefs: ["scratch:abc"],
    candidateRefs: ["candidate:def"],
    patchRefs: ["patch:ghi"],
  });
  assert.deepEqual(telemetryReports, [
    {
      metadata: {
        graftRefs: {
          scratchRefs: ["scratch:abc"],
          candidateRefs: ["candidate:def"],
          patchRefs: ["patch:ghi"],
        },
      },
    },
  ]);
  assert.equal(requests.length, 1);
  const request = requests[0] as SparkWorkflowRoleRunRequest;
  assert.equal(request.label, "auth reviewer");
  assert.equal(request.stage, "Review");
  assert.equal(request.phase, "Review");
  assert.equal(request.model, "provider/model");
  assert.equal(request.metadata.workflowAgent, true);
  assert.equal(request.metadata.index, 2);
  assert.equal(request.metadata.isolation, "graft");
  assert.equal(request.metadata.artifactRef, "artifact:brief-123");
  assert.deepEqual(request.metadata.envKeys, ["GRAFT_BASE_REF"]);
  assert.deepEqual(request.metadata.allowedTools, SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS);
  assert.equal(request.env?.GRAFT_BASE_REF, "tree:isolated");
  assert.deepEqual(request.allowedTools, SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS);
  assert.equal(request.allowedTools?.includes("read"), false);
  assert.equal(request.allowedTools?.includes("write"), false);
  assert.equal(request.allowedTools?.includes("edit"), false);
  assert.match(request.instruction, /Spark workflow child run/);
  assert.match(request.instruction, /Inspect auth routes/);
  assert.match(request.instruction, /Stage: Review/);
  assert.match(request.instruction, /Isolation: graft/);
  assert.match(request.instruction, /Briefing artifact: artifact:brief-123/);
  assert.match(request.instruction, /Environment keys: GRAFT_BASE_REF/);
  assert.match(request.instruction, /Allowed tools: graft_help,graft_status/);
  assert.match(request.instruction, /Graft isolation is active/);
  assert.match(request.instruction, /graft_candidate_from_scratch/);
});

void test("Spark dynamic workflow dashboard renders isolated Graft agent provenance", async () => {
  const script = `export const meta = { name: 'graft ui', description: 'graft UI workflow' }
stage('Edit')
const result = await agent('edit file', { label: 'isolated editor', isolation: 'graft' })
stage('Edit', { status: 'success' })
return result`;
  const events: WorkflowRunEvent[] = [];
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-worker",
    graftBaseRef: "tree:base",
    async runRoleInstruction() {
      return {
        text: "created scratch:edit candidate:edit patch:edit",
        metadata: { validation: "passed", candidateRef: "candidate:edit", patchRef: "patch:edit" },
      };
    },
  });
  await runWorkflowScript(script, {
    agent,
    onEvent: (event) => {
      events.push(event);
    },
  });
  const snapshot = projectWorkflowRunEvents(events);
  assert.deepEqual(snapshot.nodesById["agent:0"]?.telemetry?.metadata?.graftRefs, {
    scratchRefs: ["scratch:edit"],
    candidateRefs: ["candidate:edit"],
    patchRefs: ["patch:edit"],
  });

  const dir = await mkdtemp(join(tmpdir(), "spark-graft-provenance-dashboard-"));
  try {
    const store = defaultSparkDynamicWorkflowEventStore(dir);
    const meta = parseWorkflowScript(script).meta;
    const runRef = "run:graft-provenance" as const;
    await store.startRun({
      runRef,
      source: { kind: "inline", label: "graft provenance dashboard" },
      script,
      meta,
      options: {},
      base: {
        baseRef: "tree:base",
        baseState: "state:base",
        baseTree: "tree:base",
        capturedAt: "2026-06-23T00:00:00.000Z",
      },
      now: "2026-06-23T00:00:00.000Z",
    });
    for (const event of events.filter((candidate) => candidate.type !== "run_started")) {
      const { id: _id, sequence: _sequence, timestamp, type, ...input } = event;
      await store.appendEvent(runRef, {
        ...(input as SparkDynamicWorkflowEventInput),
        type,
        timestamp,
      });
    }
    const dashboard = renderSparkDynamicWorkflowDashboardText(
      buildSparkDynamicWorkflowDashboardView({
        action: "inspect",
        runs: await store.listRuns(),
        includeHistory: true,
        detailed: true,
        targetRunRef: runRef,
      }),
    );
    assert.match(dashboard, /agent isolated editor \[succeeded\]/);
    assert.match(dashboard, /Graft: status=admitted/);
    assert.match(dashboard, /scratch=scratch:edit/);
    assert.match(dashboard, /candidate=candidate:edit/);
    assert.match(dashboard, /patch=patch:edit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark-workflows fan_out_with_brief records one brief and fans out with artifactRef", async () => {
  const prompts: string[] = [];
  const artifactInputs: Array<{ title: string; body: string; kind?: string; format?: string }> = [];

  const run = await runWorkflowScript(fanOutWithBriefWorkflowScript(), {
    args: {
      briefTitle: "Audit brief",
      briefBody: "Shared context for all workers.",
      agents: [
        { name: "task", prompt: "audit task output", label: "Task auditor" },
        { name: "artifact", prompt: "audit artifact output" },
      ],
      concurrency: 1,
    },
    artifactRecord: async (input) => {
      artifactInputs.push(input);
      return { ref: "artifact:brief-xyz" };
    },
    agent: async (prompt, options) => {
      prompts.push(prompt);
      assert.equal(options.artifactRef, "artifact:brief-xyz");
      return "result:" + options.label;
    },
  });

  assert.deepEqual(artifactInputs, [
    {
      title: "Audit brief",
      body: "Shared context for all workers.",
      kind: "research",
      format: "markdown",
    },
  ]);
  assert.equal(run.agentCount, 2);
  assert.deepEqual(
    run.stages?.map((stage) => `${stage.title}:${stage.status ?? "open"}`),
    ["Brief:success", "Fan out:success", "Fan in:open"],
  );
  assert.match(prompts[0] ?? "", /CONTEXT_BUNDLE: read artifact ref artifact:brief-xyz/);
  assert.match(prompts[0] ?? "", /audit task output/);
  assert.match(prompts[1] ?? "", /audit artifact output/);
  assert.deepEqual(JSON.parse(JSON.stringify(run.result)), {
    briefRef: "artifact:brief-xyz",
    outputs: [
      { name: "task", label: "Task auditor", result: "result:Task auditor" },
      { name: "artifact", label: "artifact", result: "result:artifact" },
    ],
  });
});

void test("spark-workflows fan_out_with_brief requires artifact recorder", async () => {
  await assert.rejects(
    () =>
      runWorkflowScript(fanOutWithBriefWorkflowScript(), {
        args: { briefBody: "brief", agents: [{ name: "one", prompt: "work" }] },
        agent: async () => "unused",
      }),
    /artifactRecord adapter is required/,
  );
});

void test("Spark workflow role-run adapter refuses graft isolation without a base", async () => {
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-worker",
    async runRoleInstruction() {
      return { text: "should not run" };
    },
  });

  await assert.rejects(
    () => agent("edit files", { index: 0, isolation: "graft" }),
    /workflow graft isolation requires persisted workflow base metadata/,
  );
});

void test("spark-workflows rejects unsupported workflow agent isolation", async () => {
  for (const isolation of ["container", "worktree"]) {
    const script = `export const meta = { name: 'isolation', description: 'isolation test' }
await agent('check isolation', { isolation: '${isolation}' })`;

    await assert.rejects(
      () =>
        runWorkflowScript(script, {
          agent: async () => "should not run",
        }),
      /workflow agent isolation must be 'graft'/,
    );
  }
});

void test("spark-workflows graft isolation smoke keeps parallel same-path edits in separate refs", async () => {
  const requests: SparkWorkflowRoleRunRequest[] = [];
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-worker",
    graftBaseRef: "tree:base-smoke",
    async runRoleInstruction(request) {
      requests.push(request);
      const suffix = request.label.endsWith("A") ? "a" : "b";
      return {
        text: `edited shared.txt through scratch:${suffix} candidate:${suffix}`,
      };
    },
  });
  const script = `export const meta = { name: 'graft isolation smoke', description: 'parallel isolated edit smoke' }
return await parallel([
  () => agent('edit shared.txt to say A', { label: 'worker A', isolation: 'graft' }),
  () => agent('edit shared.txt to say B', { label: 'worker B', isolation: 'graft' }),
], { concurrency: 2 })`;

  const run = await runWorkflowScript(script, { agent });

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => request.env?.GRAFT_BASE_REF),
    ["tree:base-smoke", "tree:base-smoke"],
  );
  for (const request of requests) {
    assert.deepEqual(request.allowedTools, SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS);
    assert.match(request.instruction, /Graft isolation is active/);
    assert.match(request.instruction, /shared\.txt/);
  }
  const results = run.result as SparkWorkflowGraftAgentResult[];
  assert.deepEqual(
    results.map((result) => result.graftRefs.candidateRefs[0]),
    ["candidate:a", "candidate:b"],
  );
  assert.deepEqual(
    results.map((result) => result.graftRefs.scratchRefs[0]),
    ["scratch:a", "scratch:b"],
  );
});

void test("spark-workflows parallel limits concurrency", async () => {
  const script = `export const meta = { name: 'parallel limit', description: 'limit test' }
let active = 0
let maxActive = 0
const output = await parallel([1, 2, 3, 4].map((value) => async () => {
  active += 1
  maxActive = Math.max(maxActive, active)
  await new Promise((resolve) => setTimeout(resolve, 5))
  active -= 1
  return value
}), { concurrency: 2 })
return { output, maxActive }`;

  const run = await runWorkflowScript(script, { agent: async () => "unused" });

  assert.deepEqual(JSON.parse(JSON.stringify(run.result)), {
    output: [1, 2, 3, 4],
    maxActive: 2,
  });
});

void test("spark-workflows parallel retries failures and can collect rejected results", async () => {
  const script = `export const meta = { name: 'parallel retry', description: 'retry test' }
const attempts = { flaky: 0, bad: 0 }
const retried = await parallel([
  async () => {
    attempts.flaky += 1
    if (attempts.flaky < 2) throw new Error('not yet')
    return 'ok'
  },
], { retry: { attempts: 2 } })
const collected = await parallel([
  async () => 'good',
  async () => {
    attempts.bad += 1
    throw new Error('bad')
  },
], { retry: { attempts: 2 }, onError: 'collect' })
return { attempts, retried, collected }`;

  const run = await runWorkflowScript(script, { agent: async () => "unused" });
  const result = JSON.parse(JSON.stringify(run.result)) as {
    attempts: { flaky: number; bad: number };
    retried: string[];
    collected: Array<{ status: string; value?: string; attempts: number }>;
  };

  assert.equal(result.attempts.flaky, 2);
  assert.equal(result.attempts.bad, 2);
  assert.deepEqual(result.retried, ["ok"]);
  assert.equal(result.collected[0]?.status, "fulfilled");
  assert.equal(result.collected[0]?.value, "good");
  assert.equal(result.collected[1]?.status, "rejected");
  assert.equal(result.collected[1]?.attempts, 2);
});

void test("spark-workflows agent artifactRef prepends context bundle prompt", async () => {
  const script = `export const meta = { name: 'brief', description: 'artifact ref test' }
return await agent('do the work', { label: 'worker', artifactRef: 'artifact:brief-123' })`;
  const prompts: string[] = [];

  const run = await runWorkflowScript(script, {
    agent: async (prompt, options) => {
      prompts.push(prompt);
      assert.equal(options.artifactRef, "artifact:brief-123");
      return "done";
    },
  });

  assert.match(prompts[0] ?? "", /CONTEXT_BUNDLE: read artifact ref artifact:brief-123/);
  assert.match(prompts[0] ?? "", /Workflow agent request:\ndo the work/);
  assert.equal(run.result, "done");
});

void test("spark-workflows rejects empty child delivery instead of journaling success", async () => {
  const script = `export const meta = { name: 'empty delivery', description: 'empty delivery test' }
await agent('child', { label: 'child' })`;

  await assert.rejects(
    () =>
      runWorkflowScript(script, {
        agent: async () => ({
          delivery: { status: "empty", message: "No final assistant message found" },
        }),
      }),
    /workflow agent child produced empty delivery: No final assistant message found/,
  );
});

void test("spark-workflows requires metadata as the first executable workflow statement", () => {
  assert.throws(
    () =>
      parseWorkflowScript(`const hidden = true
export const meta = { name: 'late', description: 'late meta' }
return hidden`),
    /must start with export const meta/,
  );

  const parsed = parseWorkflowScript(`// leading comments are allowed
export const meta = { name: 'first', description: 'first meta' }
return 'ok'`);
  assert.equal(parsed.meta.name, "first");
});

void test("spark-workflows runtime hardens deterministic resume against wall-clock randomness", async () => {
  await assert.rejects(
    () =>
      runWorkflowScript(
        `export const meta = { name: 'nondeterministic', description: 'nondeterministic test' }
return Date.now()`,
        { agent: async () => "unused" },
      ),
    /Date\.now\(\) is unavailable/,
  );

  await assert.rejects(
    () =>
      runWorkflowScript(
        `export const meta = { name: 'random', description: 'random test' }
return Math.random()`,
        { agent: async () => "unused" },
      ),
    /Math\.random\(\) is unavailable/,
  );
});

void test("spark-workflows resume replays only the unchanged prefix", async () => {
  const script = `export const meta = { name: 'resume prefix', description: 'resume prefix test' }
await agent(args && args.changed ? 'changed first' : 'original first', { label: 'first' })
await agent('static second', { label: 'second' })
return 'done'`;
  const initial = await runWorkflowScript(script, {
    args: { changed: false },
    agent: async (_prompt, options) => options.label,
  });

  const livePrompts: string[] = [];
  const replay = await runWorkflowScript(script, {
    args: { changed: true },
    resumeJournal: new Map(initial.journal.map((entry) => [entry.index, entry])),
    agent: async (prompt, options) => {
      livePrompts.push(`${options.label}:${prompt}`);
      return `live ${options.label}`;
    },
  });

  assert.deepEqual(livePrompts, ["first:changed first", "second:static second"]);
  assert.deepEqual(
    replay.journal.map((entry) => entry.result),
    ["live first", "live second"],
  );
});

void test("spark-workflows exposes quality helpers, item pipelines, retry, and gate", async () => {
  const script = `export const meta = { name: 'quality helpers', description: 'quality helpers test' }
const verdict = await verify('claim', { reviewers: 3, threshold: 0.66 })
const best = await judgePanel(['weak', 'strong'], { judges: 2, rubric: 'test rubric' })
const found = await loopUntilDry({
  round: (index) => index === 0 ? ['a', 'a', 'b'] : [],
  maxRounds: 4,
})
const piped = await pipeline([1, 2], (value) => value * 2, (value) => value + 1)
const retried = await retry((index) => index, { attempts: 3, until: (value) => value === 2 })
const gated = await gate(
  (feedback) => feedback || 'draft',
  (value) => value === 'fixed' ? { ok: true } : { ok: false, feedback: 'fixed' },
  { attempts: 2 },
)
return { verdict, best, found, piped, retried, gated }`;

  const events: WorkflowRunEvent[] = [];
  const run = await runWorkflowScript(script, {
    agent: async (_prompt, options) => {
      if (options.label?.startsWith("verify ")) return { real: options.label !== "verify 1" };
      if (options.label?.startsWith("judge 2.")) return { score: 0.9 };
      if (options.label?.startsWith("judge ")) return { score: 0.1 };
      return "unused";
    },
    onEvent: (event) => {
      events.push(event);
    },
  });
  const result = JSON.parse(JSON.stringify(run.result)) as {
    verdict: { real: boolean; realCount: number; total: number };
    best: { index: number; score: number; attempt: string };
    found: string[];
    piped: number[];
    retried: number;
    gated: { ok: boolean; value: string; attempts: number };
  };

  assert.deepEqual(result.verdict, {
    real: true,
    realCount: 2,
    total: 3,
    votes: [{ real: false }, { real: true }, { real: true }],
  });
  assert.equal(result.best.index, 1);
  assert.equal(result.best.attempt, "strong");
  assert.equal(result.best.score, 0.9);
  assert.deepEqual(result.found, ["a", "b"]);
  assert.deepEqual(result.piped, [3, 5]);
  assert.equal(result.retried, 2);
  assert.deepEqual(result.gated, { ok: true, value: "fixed", attempts: 2 });
  const snapshot = projectWorkflowRunEvents(events);
  const verifyNode = snapshot.nodes.find((node) => node.kind === "tool" && node.label === "verify");
  const judgePanelNode = snapshot.nodes.find(
    (node) => node.kind === "tool" && node.label === "judgePanel",
  );
  assert.ok(verifyNode, "expected verify helper node");
  assert.ok(judgePanelNode, "expected judgePanel helper node");
  assert.ok(
    verifyNode.children.some((childId) => snapshot.nodesById[childId]?.kind === "parallel_group"),
    "expected verify helper fan-out under the verify node",
  );
  assert.ok(
    judgePanelNode.children.some(
      (childId) => snapshot.nodesById[childId]?.kind === "parallel_group",
    ),
    "expected judgePanel helper fan-out under the judgePanel node",
  );
});

void test("spark-workflows enforces run and stage token budgets between agent calls", async () => {
  const runBudgetScript = `export const meta = { name: 'run budget', description: 'run budget test' }
await agent('first', { label: 'first' })
await agent('second', { label: 'second' })`;
  await assert.rejects(
    () =>
      runWorkflowScript(runBudgetScript, {
        tokenBudget: 1,
        agent: async () => "a long enough output",
      }),
    /workflow token budget exhausted/,
  );

  const stageBudgetScript = `export const meta = { name: 'stage budget', description: 'stage budget test' }
stage('Scan', { budget: 1 })
await agent('first', { label: 'first' })
await agent('second', { label: 'second' })`;
  await assert.rejects(
    () => runWorkflowScript(stageBudgetScript, { agent: async () => "a long enough output" }),
    /workflow stage budget exhausted: Scan/,
  );
});

void test("spark-workflows records real agent telemetry and uses it for token budgets", async () => {
  const script = `export const meta = { name: 'real usage', description: 'real usage budget' }
await agent('first', { label: 'first' })
await agent('second', { label: 'second' })`;
  const tokenEvents: Array<{ tokens: number; spent: number; source: string; costUsd?: number }> =
    [];
  const telemetryStatuses: string[] = [];

  await assert.rejects(
    () =>
      runWorkflowScript(script, {
        tokenBudget: 2,
        agent: async (_prompt, options) => {
          options.reportTelemetry?.({
            runRef: `run:child-${options.index}`,
            lastActivityAt: "2026-06-22T00:00:01.000Z",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              costUsd: 0.01,
              model: "fake-model",
            },
          });
          return "this output is intentionally much longer than two estimated tokens";
        },
        onTokenUsage: (usage) => {
          tokenEvents.push({
            tokens: usage.tokens,
            spent: usage.spent,
            source: usage.usage.source,
            costUsd: usage.usage.costUsd,
          });
        },
        onAgentTelemetry: (telemetry) => {
          telemetryStatuses.push(`${telemetry.index}:${telemetry.status}`);
        },
      }),
    /workflow token budget exhausted/,
  );

  assert.deepEqual(tokenEvents, [{ tokens: 2, spent: 2, source: "actual", costUsd: 0.01 }]);
  assert.deepEqual(telemetryStatuses, ["0:running", "0:succeeded"]);
});

void test("spark-workflows marks usage as estimated when agents do not report real usage", async () => {
  const script = `export const meta = { name: 'estimated usage', description: 'estimated usage fallback' }
return await agent('short', { label: 'short' })`;
  const tokenSources: string[] = [];

  await runWorkflowScript(script, {
    agent: async () => "fallback output",
    onTokenUsage: (usage) => {
      tokenSources.push(usage.usage.source);
    },
  });

  assert.deepEqual(tokenSources, ["estimated"]);
});

void test("spark-workflows composes one-level nested workflows through a controlled resolver", async () => {
  const parent = `export const meta = { name: 'parent', description: 'parent workflow' }
const child = await workflow('child', { value: 'ok' })
return { child }`;
  const child = `export const meta = { name: 'child', description: 'child workflow' }
return await agent('child ' + args.value, { label: 'child agent' })`;

  const prompts: string[] = [];
  const run = await runWorkflowScript(parent, {
    loadWorkflowScript: (name) => (name === "child" ? child : undefined),
    agent: async (prompt) => {
      prompts.push(prompt);
      return `result:${prompt}`;
    },
  });

  assert.deepEqual(prompts, ["child ok"]);
  assert.deepEqual(JSON.parse(JSON.stringify(run.result)), { child: "result:child ok" });
});

void test("Spark dynamic workflow event store appends, tails, lists, and compacts snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dynamic-workflow-event-store-"));
  try {
    const store = defaultSparkDynamicWorkflowEventStore(dir);
    const script = `export const meta = { name: 'event store', description: 'event store workflow' }
return 'ok'`;
    const meta = parseWorkflowScript(script).meta;
    const runRef = "run:event-store" as const;

    const started = await store.startRun({
      runRef,
      source: { kind: "inline", label: "inline workflow" },
      script,
      meta,
      options: { concurrency: 2 },
      now: "2026-06-23T00:00:00.000Z",
    });
    assert.equal(started.status, "running");
    await store.appendEvent(runRef, {
      type: "stage_started",
      nodeId: "stage:Plan",
      parentId: "run",
      nodeKind: "stage",
      title: "Plan",
      stage: "Plan",
      timestamp: "2026-06-23T00:00:01.000Z",
    });
    await store.appendEvent(runRef, {
      type: "stage_finished",
      nodeId: "stage:Plan",
      nodeKind: "stage",
      title: "Plan",
      stage: "Plan",
      status: "succeeded",
      timestamp: "2026-06-23T00:00:02.000Z",
    });
    const terminal = await store.appendEvent(runRef, {
      type: "run_succeeded",
      nodeId: "run",
      nodeKind: "run",
      result: { ok: true },
      timestamp: "2026-06-23T00:00:03.000Z",
    });

    assert.equal(terminal.status, "succeeded");
    assert.equal(terminal.runRef, runRef);
    assert.equal((await store.getSnapshot(runRef))?.nodesById["stage:Plan"]?.status, "succeeded");
    assert.deepEqual(
      (await store.tailEvents(runRef, 2)).map((event) => event.type),
      ["stage_finished", "run_succeeded"],
    );
    assert.deepEqual(
      (await store.listSnapshots()).map((snapshot) => snapshot.runRef),
      [runRef],
    );
    assert.equal((await store.compact(runRef))?.status, "succeeded");
    assert.deepEqual(
      (await store.readEvents(runRef)).map((event) => event.sequence),
      [0, 1, 2, 3],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark production dynamic workflow surfaces are cut over to v2 event store", async () => {
  const sourceFiles = await listTypeScriptFiles("packages/pi-extension/src/extension");
  const offenders: string[] = [];
  for (const file of sourceFiles) {
    if (file.endsWith("spark-dynamic-workflow-run-store.ts")) continue;
    const source = await readFile(file, "utf8");
    if (/defaultSparkDynamicWorkflowRunStore\s*\(/u.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

void test("Spark dynamic workflow event store migrates v1 dynamic records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dynamic-workflow-event-migrate-"));
  try {
    const oldStore = defaultSparkDynamicWorkflowRunStore(dir);
    const eventStore = defaultSparkDynamicWorkflowEventStore(dir);
    const script = `export const meta = { name: 'legacy', description: 'legacy workflow' }
return 'ok'`;
    const meta = parseWorkflowScript(script).meta;
    const legacyRun = await oldStore.start({
      source: { kind: "inline", label: "legacy inline" },
      script,
      meta,
      options: {},
      now: "2026-06-23T00:00:00.000Z",
    });
    await oldStore.recordPhase(legacyRun.ref, {
      title: "Legacy phase",
      status: "success",
      startedAt: "2026-06-23T00:00:01.000Z",
      finishedAt: "2026-06-23T00:00:02.000Z",
    });
    await oldStore.recordJournal(legacyRun.ref, {
      index: 0,
      hash: "hash-0",
      result: "legacy agent result",
    });
    await oldStore.finish(legacyRun.ref, {
      meta,
      result: { migrated: true },
      phases: [
        {
          title: "Legacy phase",
          status: "success",
          startedAt: "2026-06-23T00:00:01.000Z",
          finishedAt: "2026-06-23T00:00:02.000Z",
        },
      ],
      agentCount: 1,
      journal: [{ index: 0, hash: "hash-0", result: "legacy agent result" }],
    });
    await oldStore.acknowledge(legacyRun.ref);
    await oldStore.saveAsWorkspaceWorkflow({
      cwd: dir,
      runRef: legacyRun.ref,
      workflowId: "legacy-migrated",
    });

    const pausedRun = await oldStore.start({
      source: { kind: "inline", label: "paused inline" },
      script,
      meta,
      options: {},
      now: "2026-06-23T00:01:00.000Z",
    });
    await oldStore.pause(pausedRun.ref, "pause migration");
    const stoppedRun = await oldStore.start({
      source: { kind: "inline", label: "stopped inline" },
      script,
      meta,
      options: {},
      now: "2026-06-23T00:02:00.000Z",
    });
    await oldStore.stop(stoppedRun.ref, "stop migration");
    const staleRun = await oldStore.start({
      source: { kind: "inline", label: "stale inline" },
      script,
      meta,
      options: {},
      now: "2026-06-23T00:03:00.000Z",
    });
    await oldStore.reconcileStale({ now: "2026-06-23T00:03:10.000Z", staleAfterMs: 1 });

    const migrated = await eventStore.migrateFromV1Snapshot(await oldStore.load());
    assert.equal(migrated.length, 4);
    const snapshot = migrated.find((candidate) => candidate.runRef === legacyRun.ref);
    assert.ok(snapshot);
    assert.equal(snapshot.status, "succeeded");
    assert.equal(snapshot.nodesById["phase:Legacy phase"]?.status, "succeeded");
    assert.equal(snapshot.nodesById["agent:0"]?.result, "legacy agent result");
    assert.deepEqual(snapshot.result, { migrated: true });
    assert.equal((await eventStore.getSnapshot(pausedRun.ref))?.status, "paused");
    assert.equal((await eventStore.getSnapshot(stoppedRun.ref))?.status, "stopped");
    assert.equal((await eventStore.getSnapshot(staleRun.ref))?.status, "stale");
    assert.deepEqual(
      (await eventStore.readEvents(legacyRun.ref)).map((event) => event.type),
      ["run_started", "phase_started", "phase_finished", "agent_succeeded", "run_succeeded"],
    );
    assert.deepEqual(
      (await eventStore.readEvents(pausedRun.ref)).map((event) => event.type),
      ["run_started", "run_paused"],
    );
    assert.deepEqual(
      (await eventStore.readEvents(stoppedRun.ref)).map((event) => event.type),
      ["run_started", "run_stopped"],
    );
    assert.deepEqual(
      (await eventStore.readEvents(staleRun.ref)).map((event) => event.type),
      ["run_started", "run_stale"],
    );
    const metadata = await eventStore.getMetadata(legacyRun.ref);
    assert.ok(metadata?.acknowledgedAt);
    assert.equal(metadata.savedWorkflow?.selector, "workspace:legacy-migrated");
    const compatible = await eventStore.toDynamicWorkflowRunRecord(legacyRun.ref);
    assert.ok(compatible);
    assert.equal(compatible.acknowledgedAt, metadata.acknowledgedAt);
    assert.equal(compatible.savedWorkflow?.selector, "workspace:legacy-migrated");
    assert.match(formatSparkDynamicWorkflowRunLine(compatible), /legacy/);
    const statuses = new Set(
      (await eventStore.listDynamicWorkflowRunRecords()).map((record) => record.status),
    );
    assert.deepEqual(statuses, new Set(["succeeded", "paused", "stopped", "stale"]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark workflow_run tool routes default agents through ctx.runRole", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dynamic-workflow-native-role-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: {
          cwd: string;
          model?: { provider: string; id: string; api?: string };
          runRole?: ExtensionRoleRunner;
        },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    registerSparkWorkflowRunTool((config) =>
      tools.set(config.name, config as unknown as TestWorkflowRunTool),
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const nativeInputs: Parameters<ExtensionRoleRunner>[0][] = [];
    const runRole: ExtensionRoleRunner = async (input) => {
      nativeInputs.push(input);
      return {
        record: { ...input.record, status: "succeeded", finishedAt: "2026-06-22T00:00:00.000Z" },
        stdout: "native workflow agent output",
        stderr: "",
        jsonEvents: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "native workflow agent output" }],
            },
          },
        ],
      };
    };

    const script = `export const meta = { name: 'native role', description: 'native role workflow' }
return await agent('use native role', { label: 'native-agent', model: 'test/model' })`;
    const result = await tool.execute(
      "tool-call",
      { script, wait: true },
      new AbortController().signal,
      () => undefined,
      { cwd: dir, model: { provider: "test", id: "model", api: "openai-responses" }, runRole },
    );

    assert.match(result.content[0]?.text ?? "", /Workflow run completed/);
    assert.equal(nativeInputs.length, 1);
    assert.equal(nativeInputs[0]?.role.ref, "role:builtin-worker");
    assert.match(nativeInputs[0]?.instruction.instruction ?? "", /use native role/);
    assert.equal(nativeInputs[0]?.model, "test/model");
    assert.equal(nativeInputs[0]?.cwd, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark dynamic workflow run store reconciles stale running records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dynamic-workflow-stale-"));
  try {
    const store = defaultSparkDynamicWorkflowRunStore(dir);
    const script = `export const meta = { name: 'stale', description: 'stale workflow' }
return 'stale'`;
    const run = await store.start({
      source: { kind: "inline", label: "inline workflow" },
      script,
      meta: parseWorkflowScript(script).meta,
      options: {},
      now: "2026-06-22T00:00:00.000Z",
    });
    assert.equal(run.status, "running");

    const reconciled = await store.reconcileStale({
      now: "2026-06-22T00:00:05.000Z",
      staleAfterMs: 1_000,
    });
    assert.equal(reconciled.runs[0]?.status, "stale");
    assert.match(reconciled.runs[0]?.errorMessage ?? "", /became stale/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark workflow_run tool persists, resumes, and keeps original base metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dynamic-workflow-run-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    const agentPrompts: string[] = [];
    const agentRunnerBases: Array<string | undefined> = [];
    let baseCaptures = 0;
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: (input) => {
          agentRunnerBases.push(input.base?.baseTree);
          return async (prompt) => {
            agentPrompts.push(prompt);
            return `result:${prompt}`;
          };
        },
        captureBase: () => {
          baseCaptures += 1;
          return {
            baseRef: "graft:test-base",
            baseState: `state-${baseCaptures}`,
            baseTree: `tree-${baseCaptures}`,
            capturedAt: "2026-06-22T00:00:00.000Z",
          };
        },
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const script = `export const meta = { name: 'persistent inline', description: 'persistent inline workflow' }
return await agent('hello ' + args.suffix, { label: 'hello' })`;
    const first = await tool.execute(
      "tool-call",
      { script, args: { suffix: "one" }, wait: true },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const firstDetails = first.details as {
      workflow: {
        runRef: string;
        status: string;
        journalEntries: number;
        base?: { baseState?: string };
      };
    };
    assert.equal(firstDetails.workflow.status, "succeeded");
    assert.equal(firstDetails.workflow.journalEntries, 1);
    assert.equal(firstDetails.workflow.base?.baseState, "state-1");
    assert.deepEqual(agentPrompts, ["hello one"]);

    const store = defaultSparkDynamicWorkflowEventStore(dir);
    const stored = await store.get(firstDetails.workflow.runRef as `run:${string}`);
    assert.ok(stored);
    assert.equal(stored.script, script);
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.journal.length, 1);
    assert.equal(stored.result, "result:hello one");
    assert.equal(stored.base?.baseState, "state-1");
    const eventsBeforeResume = await store.readEvents(stored.ref);
    assert.deepEqual(
      eventsBeforeResume.map((event) => event.type),
      [
        "run_started",
        "agent_started",
        "agent_succeeded",
        "run_succeeded",
        "agent_succeeded",
        "run_succeeded",
      ],
    );
    const metadataBeforeResume = await store.getMetadata(stored.ref);
    assert.ok(metadataBeforeResume);
    assert.equal((await defaultSparkDynamicWorkflowRunStore(dir).load()).runs.length, 0);
    assert.deepEqual(agentRunnerBases, ["tree-1"]);

    agentPrompts.length = 0;
    const resumed = await tool.execute(
      "tool-call",
      { runRef: firstDetails.workflow.runRef, wait: true },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const resumedDetails = resumed.details as {
      workflow: {
        runRef: string;
        status: string;
        journalEntries: number;
        base?: { baseState?: string };
      };
    };
    assert.equal(resumedDetails.workflow.runRef, firstDetails.workflow.runRef);
    assert.equal(resumedDetails.workflow.status, "succeeded");
    assert.equal(resumedDetails.workflow.journalEntries, 1);
    assert.equal(resumedDetails.workflow.base?.baseState, "state-1");
    assert.deepEqual(agentPrompts, []);
    const eventsAfterResume = await store.readEvents(stored.ref);
    assert.deepEqual(
      eventsAfterResume.slice(0, eventsBeforeResume.length).map((event) => event.type),
      eventsBeforeResume.map((event) => event.type),
    );
    assert.ok(
      eventsAfterResume
        .slice(eventsBeforeResume.length)
        .some((event) => event.type === "agent_cached"),
      "expected resume to append cached-agent event without replacing prior events",
    );
    assert.equal((await store.getMetadata(stored.ref))?.createdAt, metadataBeforeResume.createdAt);
    assert.deepEqual(agentRunnerBases, ["tree-1", "tree-1"]);
    assert.equal(baseCaptures, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark workflow_run streams live onUpdate events before wait=true completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-live-onupdate-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    const updates: string[] = [];
    let refreshes = 0;
    let releaseAgent!: (value: string) => void;
    const agentGate = new Promise<string>((resolve) => {
      releaseAgent = resolve;
    });
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: () => async () => agentGate,
        refreshSparkWidget: async () => {
          refreshes += 1;
        },
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const script = `export const meta = { name: 'live updates', description: 'live update workflow' }
stage('Live')
return await agent('wait for update', { label: 'live-child' })`;
    let completed = false;
    const running = tool
      .execute(
        "tool-call",
        { script, wait: true },
        new AbortController().signal,
        (update) => updates.push(update.content.map((part) => part.text).join("\n")),
        { cwd: dir },
      )
      .finally(() => {
        completed = true;
      });

    for (
      let attempt = 0;
      attempt < 50 && !updates.some((update) => /agent_started/.test(update));
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(
      completed,
      false,
      "wait=true call should still be open while the agent is blocked",
    );
    assert.ok(
      updates.some((update) => /stage_started Live/.test(update)),
      updates.join("\n---\n"),
    );
    assert.ok(
      updates.some((update) => /agent_started live-child/.test(update)),
      updates.join("\n---\n"),
    );
    assert.equal(refreshes >= 2, true);

    releaseAgent("live result");
    const result = await running;
    assert.match(result.content[0].text, /Workflow run completed: inline workflow/);
    assert.equal(completed, true);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("Spark workflow_run returns before background DynamicWorkflowManager completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-background-manager-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    let releaseAgent!: (value: string) => void;
    const agentGate = new Promise<string>((resolve) => {
      releaseAgent = resolve;
    });
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      { createAgentRunner: () => async () => agentGate },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const script = `export const meta = { name: 'background', description: 'background workflow' }
return await agent('slow child', { label: 'slow-child' })`;
    const publishedViews: unknown[] = [];
    const result = await tool.execute(
      "tool-call",
      { script },
      new AbortController().signal,
      () => undefined,
      {
        cwd: dir,
        ui: { publishView: (event: unknown) => publishedViews.push(event) },
      } as { cwd: string },
    );
    const details = result.details as { workflow: { runRef: `run:${string}`; status: string } };
    assert.equal(details.workflow.status, "running");
    assert.match(result.content[0].text, /Workflow run started: inline workflow/);
    assert.match(result.content[0].text, /background DynamicWorkflowManager/);
    assert.match(JSON.stringify(publishedViews), new RegExp(details.workflow.runRef));
    assert.match(JSON.stringify(publishedViews), /"dynamicStatus":"running"/);

    const store = defaultSparkDynamicWorkflowEventStore(dir);
    assert.equal((await store.get(details.workflow.runRef))?.status, "running");
    releaseAgent("background result");
    let completed = await store.get(details.workflow.runRef);
    let events = await store.readEvents(details.workflow.runRef);
    for (
      let attempt = 0;
      attempt < 50 && (completed?.status !== "succeeded" || events.length < 6);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = await store.get(details.workflow.runRef);
      events = await store.readEvents(details.workflow.runRef);
    }
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.result, "background result");
    assert.match(JSON.stringify(publishedViews), /"dynamicStatus":"succeeded"/);
    assert.deepEqual(events.map((event) => event.type).slice(0, 4), [
      "run_started",
      "agent_started",
      "agent_succeeded",
      "run_succeeded",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("Spark DynamicWorkflowManager applies pause, resume, stop, and restart to active runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-real-controls-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const manager = defaultSparkDynamicWorkflowManager();
    const tools = new Map<string, TestWorkflowRunTool>();
    let firstAgentStarted = false;
    let secondAgentStarted = false;
    let releaseFirstAgent!: () => void;
    const firstAgentGate = new Promise<void>((resolve) => {
      releaseFirstAgent = resolve;
    });
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: () => {
          let calls = 0;
          return async () => {
            calls += 1;
            if (calls === 1) {
              firstAgentStarted = true;
              await firstAgentGate;
              return "first";
            }
            secondAgentStarted = true;
            return "second";
          };
        },
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");
    const script = `export const meta = { name: 'controls', description: 'pause resume workflow' }
const first = await agent('first', { label: 'first' })
const second = await agent('second', { label: 'second' })
return { first, second }`;
    const started = await tool.execute(
      "tool-call",
      { script },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const runRef = (started.details as { workflow: { runRef: `run:${string}` } }).workflow.runRef;
    const store = defaultSparkDynamicWorkflowEventStore(dir);
    for (let attempt = 0; attempt < 50 && !firstAgentStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(firstAgentStarted, true);
    await manager.pause(store, runRef);
    assert.equal((await store.get(runRef))?.status, "paused");
    releaseFirstAgent();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(secondAgentStarted, false, "pause should block the next agent checkpoint");
    await manager.resume(store, runRef);
    let completed = await store.get(runRef);
    for (let attempt = 0; attempt < 50 && completed?.status !== "succeeded"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = await store.get(runRef);
    }
    assert.equal(secondAgentStarted, true);
    assert.equal(completed?.status, "succeeded");
    assert.deepEqual(completed?.result, { first: "first", second: "second" });
    assert.ok(
      (await store.readEvents(runRef)).some(
        (event) => event.type === "control_applied" && event.data && typeof event.data === "object",
      ),
      "expected pause/resume controls to record control_applied events",
    );

    const stopTools = new Map<string, TestWorkflowRunTool>();
    let stopSignal: AbortSignal | undefined;
    let stopAgentStarted = false;
    registerSparkWorkflowRunTool(
      (config) => stopTools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: ({ signal }) => {
          stopSignal = signal;
          return async () => {
            stopAgentStarted = true;
            await new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
            );
          };
        },
      },
    );
    const stopTool = stopTools.get("workflow_run");
    assert.ok(stopTool, "missing workflow_run tool");
    const stopStarted = await stopTool.execute(
      "tool-call",
      {
        script: `export const meta = { name: 'stop control', description: 'stop workflow' }
return await agent('never finishes', { label: 'blocked' })`,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const stopRunRef = (stopStarted.details as { workflow: { runRef: `run:${string}` } }).workflow
      .runRef;
    for (let attempt = 0; attempt < 50 && !stopAgentStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(stopAgentStarted, true);
    await manager.stop(store, stopRunRef);
    assert.equal(stopSignal?.aborted, true);
    assert.equal((await store.get(stopRunRef))?.status, "stopped");

    const restartTools = new Map<string, TestWorkflowRunTool>();
    let restartFactoryCalls = 0;
    let restartAgentCalls = 0;
    let firstRestartSignal: AbortSignal | undefined;
    registerSparkWorkflowRunTool(
      (config) => restartTools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: ({ signal }) => {
          restartFactoryCalls += 1;
          if (!firstRestartSignal) firstRestartSignal = signal;
          return async () => {
            restartAgentCalls += 1;
            if (restartAgentCalls === 1) {
              await new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(new Error("restart abort")), {
                  once: true,
                }),
              );
            }
            return `restart-result-${restartAgentCalls}`;
          };
        },
      },
    );
    const restartTool = restartTools.get("workflow_run");
    assert.ok(restartTool, "missing workflow_run tool");
    const restartStarted = await restartTool.execute(
      "tool-call",
      {
        script: `export const meta = { name: 'restart control', description: 'restart workflow' }
return await agent('restart me', { label: 'restart-child' })`,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const restartRunRef = (restartStarted.details as { workflow: { runRef: `run:${string}` } })
      .workflow.runRef;
    for (let attempt = 0; attempt < 50 && restartAgentCalls < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(restartAgentCalls, 1);
    await manager.restart(store, restartRunRef);
    assert.equal(firstRestartSignal?.aborted, true);
    let restartedRun = await store.get(restartRunRef);
    for (let attempt = 0; attempt < 50 && restartedRun?.status !== "succeeded"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      restartedRun = await store.get(restartRunRef);
    }
    assert.equal(restartFactoryCalls >= 2, true);
    assert.equal(restartAgentCalls >= 2, true);
    assert.equal(restartedRun?.status, "succeeded");
    assert.equal(restartedRun?.result, "restart-result-2");
    assert.ok(
      (await store.readEvents(restartRunRef)).some(
        (event) =>
          event.type === "control_applied" &&
          Boolean(event.data) &&
          typeof event.data === "object" &&
          !Array.isArray(event.data) &&
          (event.data as { action?: unknown }).action === "restart",
      ),
      "expected restart to record control_applied action",
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("Spark workflow_run persists and renders real workflow agent telemetry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-telemetry-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: () => async (_prompt, options) => {
          options.reportTelemetry?.({
            runRef: "run:child-usage",
            lastActivityAt: "2026-06-22T00:00:02.000Z",
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
              costUsd: 0.025,
              model: "fake-model",
              provider: "fake-provider",
            },
          });
          return "telemetry result";
        },
        now: () => "2026-06-22T00:00:00.000Z",
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const script = `export const meta = { name: 'telemetry', description: 'telemetry workflow' }
return await agent('collect usage', { label: 'usage-agent' })`;
    const result = await tool.execute(
      "tool-call",
      { script, wait: true },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const runRef = (result.details as { workflow: { runRef: string } }).workflow.runRef;
    const stored = await defaultSparkDynamicWorkflowEventStore(dir).get(runRef as `run:${string}`);
    assert.ok(stored);
    assert.deepEqual(stored.usageTotals, {
      actualTokens: 15,
      estimatedTokens: 0,
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.025,
    });
    assert.equal(stored.spentTokens, 15);
    assert.equal(stored.agentTelemetry?.[0]?.label, "usage-agent");
    assert.equal(stored.agentTelemetry?.[0]?.usage?.source, "actual");
    assert.equal(stored.agentTelemetry?.[0]?.runRef, "run:child-usage");
    assert.match(formatSparkDynamicWorkflowRunLine(stored), /tokens=15 cost=\$0\.0250/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark workflow_run tool executes inline and saved workflow scripts through injected runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-run-tool-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    const seen: Array<{
      script: string;
      args: unknown;
      tokenBudget?: number;
      concurrency?: number;
      hasWebSearch: boolean;
      hasFetchContent: boolean;
      hasLoadWorkflowScript: boolean;
    }> = [];
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: () => async () => "agent output",
        resolveScript: async ({ selector }) => ({
          label: selector,
          script: `export const meta = { name: 'saved', description: 'saved workflow' }
return 'saved-result'`,
        }),
        async runWorkflow<T = unknown>(
          script: string,
          options: WorkflowRunOptions,
        ): Promise<WorkflowRunResult<T>> {
          seen.push({
            script,
            args: options.args,
            tokenBudget: options.tokenBudget ?? undefined,
            concurrency: options.concurrency,
            hasWebSearch: typeof options.webSearch === "function",
            hasFetchContent: typeof options.fetchContent === "function",
            hasLoadWorkflowScript: typeof options.loadWorkflowScript === "function",
          });
          const stages = [
            { title: "Done", startedAt: "2026-06-18T00:00:00.000Z", status: "success" },
          ] as WorkflowRunResult<T>["phases"];
          return {
            meta: parseWorkflowScript(script).meta,
            result: { ok: true, args: options.args } as T,
            stages,
            phases: stages,
            agentCount: 2,
            journal: [],
          };
        },
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const inline = await tool.execute(
      "tool-call",
      {
        script: `export const meta = { name: 'inline', description: 'inline workflow' }
return 'inline-result'`,
        args: { focus: "demo" },
        tokenBudget: 50,
        concurrency: 3,
        wait: true,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    assert.match(inline.content[0].text, /Workflow run completed: inline workflow/);
    assert.match(inline.content[0].text, /╭─ Workflow inline \[succeeded\]/);
    assert.match(inline.content[0].text, /│ stages\s+✓ Done/);
    assert.match(inline.content[0].text, /│ controls\s+inspect: task_read/);
    assert.match(
      inline.content[0].text,
      /╰─ Result \(compact JSON; complete value is in details\.workflow\.result\)/,
    );
    const inlineDetails = inline.details as { workflow: { agentCount: number } };
    assert.equal(inlineDetails.workflow.agentCount, 2);
    assert.equal(seen[0]?.tokenBudget, 50);
    assert.equal(seen[0]?.concurrency, 3);
    assert.equal(seen[0]?.hasWebSearch, true);
    assert.equal(seen[0]?.hasFetchContent, true);
    assert.equal(seen[0]?.hasLoadWorkflowScript, true);

    await tool.execute(
      "tool-call",
      { selector: "builtin:research", args: { question: "demo" }, wait: true },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    assert.match(seen[1]?.script ?? "", /name: 'saved'/);
    assert.deepEqual(seen[1]?.args, { question: "demo" });
    const persisted = await defaultSparkDynamicWorkflowEventStore(dir).load();
    assert.deepEqual(
      persisted.runs.map((run) => run.source.kind),
      ["inline", "selector"],
    );
    assert.equal(persisted.runs[1]?.source.selector, "builtin:research");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark workflow_run blocks risky workflows until approved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-approval-deny-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    let createdAgent = false;
    let ranWorkflow = false;
    let approvalRiskFlags: string[] = [];
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        approveRun: ({ summary }) => {
          approvalRiskFlags = summary.riskFlags;
          return { approved: false, reason: "test denied" };
        },
        createAgentRunner: () => {
          createdAgent = true;
          return async () => "agent output";
        },
        async runWorkflow<T = unknown>(): Promise<WorkflowRunResult<T>> {
          ranWorkflow = true;
          throw new Error("should not execute");
        },
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const script = `export const meta = { name: 'needs approval', description: 'web workflow' }
return await webSearch({ query: 'approval smoke' })`;
    await assert.rejects(
      () =>
        tool.execute("tool-call", { script }, new AbortController().signal, () => undefined, {
          cwd: dir,
        }),
      /workflow_run approval denied: test denied/,
    );
    assert.deepEqual(approvalRiskFlags, ["web_or_fetch"]);
    assert.equal(createdAgent, false);
    assert.equal(ranWorkflow, false);
    const persisted = await defaultSparkDynamicWorkflowEventStore(dir).load();
    assert.equal(persisted.runs.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark workflow_run records scoped approval provenance for risky workflows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-approval-allow-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    let approvalSource = "";
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        approveRun: ({ summary }) => {
          approvalSource = summary.source;
          assert.deepEqual(summary.riskFlags, ["web_or_fetch"]);
          assert.equal(summary.resources.stageCount, 0);
          assert.equal(summary.resources.phaseCount, 0);
          return { approved: true, method: "reviewer", reason: "safe bounded web lookup" };
        },
        createAgentRunner: () => async () => "agent output",
        webSearch: ({ request }) => ({ searched: request.query, url: "https://example.test" }),
        now: () => "2026-06-22T12:00:00.000Z",
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const result = await tool.execute(
      "tool-call",
      {
        script: `export const meta = { name: 'approved web', description: 'web workflow' }
return await webSearch({ query: args.query })`,
        args: { query: "approval smoke" },
        wait: true,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );

    assert.equal(approvalSource, "inline workflow");
    const runRef = (result.details as { workflow: { runRef: string } }).workflow.runRef;
    const stored = await defaultSparkDynamicWorkflowEventStore(dir).get(runRef as `run:${string}`);
    assert.ok(stored);
    assert.equal(stored.approval?.status, "approved");
    assert.equal(stored.approval?.method, "reviewer");
    assert.equal(stored.approval?.reason, "safe bounded web lookup");
    assert.deepEqual(stored.approval?.summary.riskFlags, ["web_or_fetch"]);
    assert.match(formatSparkDynamicWorkflowRunLine(stored), /approval=reviewer:web_or_fetch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark workflow_run executes an ultracode-style generated workflow script", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-ultracode-smoke-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    let approvedRiskFlags: string[] = [];
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        approveRun: ({ summary }) => {
          approvedRiskFlags = summary.riskFlags;
          return { approved: true, method: "reviewer", reason: "bounded ultracode smoke" };
        },
        createAgentRunner: () => async (_prompt, options) => {
          if (options.label === "planner") return "draft execution plan";
          if (options.label?.startsWith("verify ")) return { real: true };
          if (options.label === "completeness critic") return { complete: true };
          return "agent output";
        },
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const result = await tool.execute(
      "tool-call",
      {
        script: `export const meta = { name: 'ultracode smoke', description: 'bounded generated workflow', stages: [{ title: 'Plan' }, { title: 'Verify' }, { title: 'Synthesize' }] }
stage('Plan')
const draft = await agent('Draft a short execution plan for ' + args.focus, { label: 'planner' })
stage('Verify')
const verdict = await verify(draft, { reviewers: 2, threshold: 0.5 })
const complete = await completenessCheck(args, { draft, verdict })
stage('Synthesize', { status: 'success' })
return { draft, verdict, complete }`,
        args: { focus: "workflow parity" },
        concurrency: 2,
        maxAgents: 6,
        tokenBudget: 1000,
        wait: true,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );

    assert.deepEqual(approvedRiskFlags, ["fan_out"]);
    const details = result.details as {
      workflow: {
        status: string;
        result: { draft: string; verdict: { real: boolean }; complete: { complete: boolean } };
      };
    };
    assert.equal(details.workflow.status, "succeeded");
    assert.equal(details.workflow.result.draft, "draft execution plan");
    assert.equal(details.workflow.result.verdict.real, true);
    assert.equal(details.workflow.result.complete.complete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("dynamic workflow save uses collision-safe workspace selectors that rerun", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-save-reuse-"));
  try {
    const script = `export const meta = { name: 'Reusable Flow', description: 'saved reusable workflow' }
return { reused: true, args }
`;
    const parsed = parseWorkflowScript(script);
    const store = defaultSparkDynamicWorkflowRunStore(dir);
    const run = await store.start({
      source: { kind: "inline", label: "generated reusable workflow" },
      script,
      args: { first: true },
      meta: parsed.meta,
      options: {},
    });
    const first = await store.saveAsWorkflow({ cwd: dir, runRef: run.ref, workflowId: "reuse" });
    const second = await store.saveAsWorkflow({ cwd: dir, runRef: run.ref, workflowId: "reuse" });
    assert.equal(first?.selector, "workspace:reuse");
    assert.equal(second?.selector, "workspace:reuse-2");

    const listed = await listSavedWorkflows(dir, { includeUser: false });
    assert.deepEqual(
      listed.workflows
        .map((workflow) => workflow.selector)
        .filter((selector) => selector.startsWith("workspace:reuse"))
        .sort(),
      ["workspace:reuse", "workspace:reuse-2"],
    );
    const saved = await readSavedWorkflow({ cwd: dir, selector: second?.selector ?? "" });
    assert.equal(saved.script, script);

    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      { createAgentRunner: () => async () => "agent output" },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");
    const result = await tool.execute(
      "tool-call",
      { selector: second?.selector, args: { rerun: true }, wait: true },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const details = result.details as { workflow: { result: { reused: boolean; args: unknown } } };
    assert.equal(details.workflow.result.reused, true);
    assert.deepEqual(details.workflow.result.args, { rerun: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark workflow_run tool resolves controlled nested saved workflows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-run-nested-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    await mkdir(join(dir, ".spark", "workflows"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "workflows", "child.js"),
      `export const meta = { name: 'child', description: 'saved child workflow' }
return { marker: 'saved-child', args }
`,
      "utf8",
    );
    const tools = new Map<string, TestWorkflowRunTool>();
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      { createAgentRunner: () => async () => "agent output" },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const result = await tool.execute(
      "tool-call",
      {
        script: `export const meta = { name: 'parent', description: 'parent workflow' }
return await workflow('workspace:child', { focus: args.focus })`,
        args: { focus: "nested-demo" },
        wait: true,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );

    assert.match(result.content[0].text, /Workflow run completed: inline workflow/);
    const details = result.details as { workflow: { result: { marker: string; args: unknown } } };
    assert.equal(details.workflow.result.marker, "saved-child");
    assert.deepEqual(details.workflow.result.args, { focus: "nested-demo" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(path)));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}
