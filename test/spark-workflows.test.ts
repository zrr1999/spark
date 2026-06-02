import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adversarialReviewWorkflowScript,
  createSparkWorkflowRoleRunAdapter,
  deepResearchWorkflowScript,
  goalWorkflowScript,
  parseSparkWorkflowScript,
  readyWorkflowScript,
  runSparkWorkflowScript,
} from "../packages/spark-workflows/src/index.ts";

void test("spark-workflows parses metadata and runs sandbox primitives with journal", async () => {
  const script = `export const meta = {
  name: 'demo',
  description: 'Demo workflow',
  phases: [{ title: 'Scan' }, { title: 'Report' }],
}

phase('Scan')
const scan = await agent('scan repo', { label: 'scan' })
phase('Report')
const [a, b] = await parallel([
  () => agent('check a', { label: 'a' }),
  () => agent('check b', { label: 'b' }),
])
return { scan, a, b }`;

  const parsed = parseSparkWorkflowScript(script);
  assert.equal(parsed.meta.name, "demo");
  assert.deepEqual(
    parsed.meta.phases?.map((phase) => phase.title),
    ["Scan", "Report"],
  );

  const prompts: string[] = [];
  const result = await runSparkWorkflowScript(script, {
    agent: async (prompt) => {
      prompts.push(prompt);
      return "result: " + prompt;
    },
  });
  assert.deepEqual(prompts, ["scan repo", "check a", "check b"]);
  assert.deepEqual(result.phases, ["Scan", "Report"]);
  assert.equal(result.agentCount, 3);
  assert.equal(result.journal.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    scan: "result: scan repo",
    a: "result: check a",
    b: "result: check b",
  });

  const replayPrompts: string[] = [];
  const replay = await runSparkWorkflowScript(script, {
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

void test("spark-workflows exposes and runs builtin workflow script factories", async () => {
  const goal = await runSparkWorkflowScript(goalWorkflowScript(), {
    agent: async () => "unused",
  });
  assert.equal(goal.meta.name, "goal");
  assert.deepEqual(goal.phases, ["Inspect"]);
  assert.equal(goal.agentCount, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(goal.result)), {
    backend: "goal",
    contract:
      "Inspect the current Spark project/task plan, claim one ready task at a time, finish it with evidence, and continue until complete or blocked.",
  });

  const ready = await runSparkWorkflowScript(readyWorkflowScript(), {
    agent: async () => "unused",
  });
  assert.equal(ready.meta.name, "ready");
  assert.deepEqual(ready.phases, ["Preflight"]);
  assert.equal(ready.agentCount, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(ready.result)), {
    backend: "ready-frontier",
    contract:
      "Preflight ready tasks, then dispatch with spark_run_ready_tasks when approved and reconcile workflow-run state afterward.",
  });

  const deep = parseSparkWorkflowScript(deepResearchWorkflowScript());
  assert.equal(deep.meta.name, "deep_research");
  assert.deepEqual(
    deep.meta.phases?.map((phase) => phase.title),
    ["Queries", "Gather", "Verify", "Report"],
  );

  const review = parseSparkWorkflowScript(adversarialReviewWorkflowScript());
  assert.equal(review.meta.name, "adversarial_review");
  assert.deepEqual(
    review.meta.phases?.map((phase) => phase.title),
    ["Investigate", "Refute", "Consensus"],
  );

  const deepRun = await runSparkWorkflowScript(deepResearchWorkflowScript(), {
    args: { question: "workflow smoke" },
    agent: async (_prompt, options) => options.label ?? "agent",
  });
  assert.equal(deepRun.agentCount, 5);
  assert.deepEqual(deepRun.phases, ["Queries", "Gather", "Verify", "Report"]);

  const reviewRun = await runSparkWorkflowScript(adversarialReviewWorkflowScript(), {
    args: { task: "workflow smoke" },
    agent: async (_prompt, options) => options.label ?? "agent",
  });
  assert.equal(reviewRun.agentCount, 4);
  assert.deepEqual(reviewRun.phases, ["Investigate", "Refute", "Consensus"]);
});

void test("spark-workflows applies phase model defaults and per-agent overrides", async () => {
  const script = `export const meta = {
    name: 'model routing',
    description: 'Model routing workflow',
    phases: [{ title: 'Scan', model: 'provider/phase-model' }],
  }

  phase('Scan')
  await agent('phase default', { label: 'default' })
  await agent('agent override', { label: 'override', model: 'provider/agent-model' })`;

  const models: Array<string | undefined> = [];
  await runSparkWorkflowScript(script, {
    agent: async (_prompt, options) => {
      models.push(options.model);
      return "ok";
    },
  });

  assert.deepEqual(models, ["provider/phase-model", "provider/agent-model"]);
});

void test("spark-workflows role-run adapter maps workflow agents to Spark dependency boundary", async () => {
  const requests: unknown[] = [];
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-worker",
    async runRoleInstruction(request) {
      requests.push(request);
      return { text: "adapter result" };
    },
  });

  const result = await agent("Inspect auth routes", {
    index: 2,
    label: "auth reviewer",
    phase: "Review",
    model: "provider/model",
    agentType: "reviewer",
    isolation: "worktree",
    timeoutMs: 123,
  });

  assert.equal(result, "adapter result");
  assert.equal(requests.length, 1);
  const request = requests[0] as {
    instruction: string;
    label: string;
    phase?: string;
    model?: string;
    metadata: Record<string, unknown>;
  };
  assert.equal(request.label, "auth reviewer");
  assert.equal(request.phase, "Review");
  assert.equal(request.model, "provider/model");
  assert.equal(request.metadata.workflowAgent, true);
  assert.equal(request.metadata.index, 2);
  assert.equal(request.metadata.isolation, "worktree");
  assert.match(request.instruction, /Spark workflow child role-run/);
  assert.match(request.instruction, /Inspect auth routes/);
  assert.match(request.instruction, /Phase: Review/);
  assert.match(request.instruction, /Isolation: worktree/);
});

void test("spark-workflows rejects unsupported workflow agent isolation", async () => {
  const script = `export const meta = { name: 'isolation', description: 'isolation test' }
await agent('check isolation', { isolation: 'container' })`;

  await assert.rejects(
    () =>
      runSparkWorkflowScript(script, {
        agent: async () => "should not run",
      }),
    /Spark workflow agent isolation must be 'worktree'/,
  );
});
