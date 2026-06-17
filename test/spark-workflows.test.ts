import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  adversarialReviewWorkflowScript,
  deepResearchWorkflowScript,
  fanOutWithBriefWorkflowScript,
  fusionWorkflowScript,
  listSavedWorkflows,
  parseWorkflowScript,
  readSavedWorkflow,
  runWorkflowScript,
} from "../packages/pi-workflows/src/index.ts";
import { createSparkWorkflowRoleRunAdapter } from "../packages/spark-runtime/src/index.ts";

void test("pi-workflows package stays isolated from runtime execution packages", async () => {
  const pkg = JSON.parse(await readFile("packages/pi-workflows/package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };

  assert.equal(pkg.dependencies?.["@zendev-lab/spark-runtime"], undefined);
  assert.equal(pkg.dependencies?.["@zendev-lab/pi-roles"], undefined);
  assert.equal(pkg.dependencies?.["spark-goal"], undefined);

  const sourceFiles = await listTypeScriptFiles("packages/pi-workflows/src");
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /(?:from\s+["']|import\(["'])(?:spark-runtime|pi-roles|spark-goal)["']/u,
      `${file} must not import runtime execution or goal packages`,
    );
  }
});

void test("Spark production code uses generic pi-workflows imports instead of compatibility aliases", async () => {
  const sourceFiles = await listTypeScriptFiles("packages/spark/src");
  const deprecatedPiWorkflowImports =
    /import\s+(?:type\s+)?\{[^}]*\b(?:defaultSparkDagRunStore|defaultWorkflowRunStore|workspaceWorkflowDir|SparkDag\w*|SparkWorkflow\w*|sparkDagRunNextSteps|runReadySparkTasks)\b[^}]*\}\s+from\s+["'](?:@zendev-lab\/)?pi-workflows["']/su;
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      deprecatedPiWorkflowImports,
      `${file} must import generic Workflow* symbols from pi-workflows; Spark-named aliases are compatibility only`,
    );
  }
});

void test("pi-workflows parses metadata without executing expressions", () => {
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
  phases: [
    // braces in comments should not terminate metadata: { }
    { title: 'Scan' },
  ],
}
return 'ok'`);

  assert.equal(parsed.meta.name, "demo { literal }");
  assert.equal(parsed.meta.description, "Demo // workflow");
  assert.deepEqual(parsed.meta.phases, [{ title: "Scan" }]);
  assert.equal(parsed.body, "return 'ok'");
});

void test("pi-workflows parses metadata and runs sandbox primitives with journal", async () => {
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

  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "demo");
  assert.deepEqual(
    parsed.meta.phases?.map((phase) => phase.title),
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
    result.phases.map((phase) => phase.title),
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

void test("pi-workflows lists and reads builtin workflows without frontmatter mode", async () => {
  const listing = await listSavedWorkflows(".", {
    includeUser: false,
    workspaceWorkflowDir: "/definitely/missing/spark-workflows",
  });

  assert.deepEqual(listing.errors, []);
  assert.deepEqual(
    listing.workflows.map((workflow) => workflow.selector),
    [
      "builtin:fusion",
      "builtin:deep-research",
      "builtin:fan-out-with-brief",
      "builtin:adversarial-review",
    ],
  );
  assert.deepEqual(
    listing.workflows.map((workflow) => workflow.mode),
    ["research", "research", "research", "research"],
  );

  const { descriptor, script } = await readSavedWorkflow({
    cwd: ".",
    selector: "builtin:deep-research",
    includeUser: false,
  });
  assert.equal(descriptor.source, "builtin");
  assert.equal(descriptor.mode, "research");
  assert.equal(descriptor.path, "builtin:deep-research");
  assert.deepEqual(descriptor.phases, ["Queries", "Gather", "Verify", "Report"]);
  assert.match(script, /export const meta/);
  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "deep_research");
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

void test("pi-workflows fusion builtin fans out with collected errors and judge synthesis", async () => {
  const { descriptor, script } = await readSavedWorkflow({
    cwd: ".",
    selector: "builtin:fusion",
    includeUser: false,
  });
  assert.equal(descriptor.source, "builtin");
  assert.equal(descriptor.mode, "research");
  assert.deepEqual(descriptor.phases, ["Panel", "Synthesis"]);

  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "fusion");
  assert.equal("mode" in parsed.meta, false);

  const agentCalls: Array<{ prompt: string; label?: string; model?: string; agentType?: string }> =
    [];
  const run = await runWorkflowScript(fusionWorkflowScript(), {
    args: {
      question: "Should Fusion live in workflows?",
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
      if (options.label === "judge synthesis") return "final synthesis";
      return "panel answer from " + options.label;
    },
  });

  assert.equal(run.agentCount, 3);
  assert.deepEqual(
    run.phases.map((phase) => phase.title),
    ["Panel", "Synthesis"],
  );
  assert.deepEqual(
    agentCalls.map((call) => call.label),
    ["fast", "blocked", "judge synthesis"],
  );
  assert.deepEqual(
    agentCalls.map((call) => call.agentType),
    ["model", "model", "model"],
  );
  assert.equal(agentCalls[0]?.model, "provider/fast");
  assert.equal(agentCalls[2]?.model, "provider/judge");
  assert.match(agentCalls[0]?.prompt ?? "", /one expert in a Spark Fusion-style multi-model panel/);
  assert.match(agentCalls[2]?.prompt ?? "", /ERROR: MODEL_BLOCKED/);
  assert.match(agentCalls[2]?.prompt ?? "", /Synthesize a final answer/);
  assert.equal((run.result as { report?: unknown }).report, "final synthesis");
});

void test("pi-workflows exposes and runs workflow script factories", async () => {
  const deep = parseWorkflowScript(deepResearchWorkflowScript());
  assert.equal(deep.meta.name, "deep_research");
  assert.deepEqual(
    deep.meta.phases?.map((phase) => phase.title),
    ["Queries", "Gather", "Verify", "Report"],
  );

  const review = parseWorkflowScript(adversarialReviewWorkflowScript());
  assert.equal(review.meta.name, "adversarial_review");
  assert.deepEqual(
    review.meta.phases?.map((phase) => phase.title),
    ["Investigate", "Refute", "Consensus"],
  );

  const fanOut = parseWorkflowScript(fanOutWithBriefWorkflowScript());
  assert.equal(fanOut.meta.name, "fan_out_with_brief");
  assert.deepEqual(
    fanOut.meta.phases?.map((phase) => phase.title),
    ["Brief", "Fan out", "Fan in"],
  );

  const deepRun = await runWorkflowScript(deepResearchWorkflowScript(), {
    args: { question: "workflow smoke" },
    agent: async (_prompt, options) => options.label ?? "agent",
  });
  assert.equal(deepRun.agentCount, 5);
  assert.deepEqual(
    deepRun.phases.map((phase) => phase.title),
    ["Queries", "Gather", "Verify", "Report"],
  );

  const reviewRun = await runWorkflowScript(adversarialReviewWorkflowScript(), {
    args: { task: "workflow smoke" },
    agent: async (_prompt, options) => options.label ?? "agent",
  });
  assert.equal(reviewRun.agentCount, 4);
  assert.deepEqual(
    reviewRun.phases.map((phase) => phase.title),
    ["Investigate", "Refute", "Consensus"],
  );
});

void test("pi-workflows records explicit phase statuses", async () => {
  const script = `export const meta = {
    name: 'phase status',
    description: 'Phase status workflow',
  }

  phase('Scan')
  await agent('scan work', { label: 'scan' })
  phase('Scan', { status: 'success' })
  phase('Skipped', { status: 'skip' })
  return 'done'`;

  const phaseEvents: Array<{
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
    agent: async (_prompt, options) => options.phase ?? "none",
    onPhase: (event) => phaseEvents.push(event),
  });

  assert.deepEqual(run.phases, [
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
  assert.deepEqual(phaseEvents, [
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

void test("pi-workflows applies phase model defaults and per-agent overrides", async () => {
  const script = `export const meta = {
    name: 'model routing',
    description: 'Model routing workflow',
    phases: [{ title: 'Scan', model: 'provider/phase-model' }],
  }

  phase('Scan')
  await agent('phase default', { label: 'default' })
  await agent('agent override', { label: 'override', model: 'provider/agent-model' })`;

  const models: Array<string | undefined> = [];
  await runWorkflowScript(script, {
    agent: async (_prompt, options) => {
      models.push(options.model);
      return "ok";
    },
  });

  assert.deepEqual(models, ["provider/phase-model", "provider/agent-model"]);
});

void test("pi-workflows role-run adapter sends model agents through model runner hook", async () => {
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
    phase: "Panel",
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
    phase?: string;
    model?: string;
    metadata: Record<string, unknown>;
  };
  assert.equal(request.prompt, "Compare model answers");
  assert.equal(request.label, "panel 1");
  assert.equal(request.phase, "Panel");
  assert.equal(request.model, "provider/model");
  assert.equal(request.metadata.workflowAgent, true);
  assert.equal(request.metadata.agentType, "model");
  assert.equal(request.metadata.index, 1);
  assert.equal(request.metadata.timeoutMs, 250);
  assert.equal(request.metadata.artifactRef, "artifact:brief-456");
});

void test("pi-workflows role-run adapter fails model agents when model hook is missing", async () => {
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

void test("pi-workflows role-run adapter maps workflow agents to Spark dependency boundary", async () => {
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
    artifactRef: "artifact:brief-123",
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
  assert.equal(request.metadata.artifactRef, "artifact:brief-123");
  assert.match(request.instruction, /Spark workflow child run/);
  assert.match(request.instruction, /Inspect auth routes/);
  assert.match(request.instruction, /Phase: Review/);
  assert.match(request.instruction, /Isolation: worktree/);
  assert.match(request.instruction, /Briefing artifact: artifact:brief-123/);
});

void test("pi-workflows fan_out_with_brief records one brief and fans out with artifactRef", async () => {
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
    run.phases.map((phase) => `${phase.title}:${phase.status ?? "open"}`),
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

void test("pi-workflows fan_out_with_brief requires artifact recorder", async () => {
  await assert.rejects(
    () =>
      runWorkflowScript(fanOutWithBriefWorkflowScript(), {
        args: { briefBody: "brief", agents: [{ name: "one", prompt: "work" }] },
        agent: async () => "unused",
      }),
    /artifactRecord adapter is required/,
  );
});

void test("pi-workflows rejects unsupported workflow agent isolation", async () => {
  const script = `export const meta = { name: 'isolation', description: 'isolation test' }
await agent('check isolation', { isolation: 'container' })`;

  await assert.rejects(
    () =>
      runWorkflowScript(script, {
        agent: async () => "should not run",
      }),
    /workflow agent isolation must be 'worktree'/,
  );
});

void test("pi-workflows parallel limits concurrency", async () => {
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

void test("pi-workflows parallel retries failures and can collect rejected results", async () => {
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

void test("pi-workflows agent artifactRef prepends context bundle prompt", async () => {
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

void test("pi-workflows rejects empty child delivery instead of journaling success", async () => {
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
