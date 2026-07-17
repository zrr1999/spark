import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import { registerPiArtifactTool } from "@zendev-lab/spark-artifacts/extension";
import { evaluateSparkBehavior } from "@zendev-lab/spark-turn/behavior-eval";
import {
  SparkAgentLoop,
  SparkHostRuntime,
  type SparkAgentLoopEvent,
  type SparkAgentStreamFunction,
  type SparkRunOutcome,
} from "../apps/spark-tui/src/host/index.ts";
import {
  lowerSparkPromptItem,
  resolveSparkPromptCache,
  sparkPromptItemFromProviderMessage,
  sparkRuntimePromptItem,
  splitSparkSystemPrompt,
} from "../packages/spark-turn/src/agent-loop.ts";
import { compactToolResultContent } from "../packages/spark-turn/src/tool-result-compaction.ts";

type AssistantMessage = any;
type AssistantMessageEvent = any;
type Context = any;
type Model = any;
type Message = any;
type ToolCall = any;

const TEST_MODEL: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8000,
  maxTokens: 4000,
};

void test("Spark prompt IR retains runtime authority until provider lowering", () => {
  const item = sparkRuntimePromptItem({
    authority: "runtime_data",
    trust: "untrusted",
    visibility: "hidden",
    persistence: "session",
    content: "page data <not-an-instruction>",
    customType: "browser-evidence",
  });

  assert.equal(item.authority, "runtime_data");
  assert.equal(item.trust, "untrusted");
  assert.equal(item.visibility, "hidden");
  const lowered = lowerSparkPromptItem(item);
  assert.equal(lowered.role, "user");
  assert.match(String(lowered.content), /<spark_runtime_data trust="untrusted"/u);
  assert.match(String(lowered.content), /&lt;not-an-instruction&gt;/u);
  assert.doesNotMatch(String(lowered.content), /page data <not-an-instruction>/u);

  const developer = sparkRuntimePromptItem({
    authority: "developer",
    trust: "trusted",
    visibility: "hidden",
    persistence: "session",
    content: "provider-neutral developer policy",
  });
  assert.match(String(lowerSparkPromptItem(developer).content), /<spark_developer_context/u);
  const replayedDeveloper = sparkPromptItemFromProviderMessage({
    role: "developer",
    content: "replayed developer policy",
  });
  const loweredDeveloper = lowerSparkPromptItem(replayedDeveloper);
  assert.equal(loweredDeveloper.role, "user");
  assert.match(String(loweredDeveloper.content), /<spark_developer_context/u);

  const mixedRuntimeData = sparkRuntimePromptItem({
    authority: "runtime_data",
    trust: "untrusted",
    visibility: "hidden",
    persistence: "session",
    content: [
      { type: "text", text: "browser caption" },
      { type: "image", source: "browser://evidence" },
    ],
  });
  const loweredMixed = String(lowerSparkPromptItem(mixedRuntimeData).content);
  assert.match(loweredMixed, /browser caption/u);
  assert.match(loweredMixed, /"type":"image"/u);
  assert.match(loweredMixed, /browser:\/\/evidence/u);
});

interface FakeStreamPlan {
  /** Each entry is one round-trip's events. The loop enqueues another round whenever
   *  the produced AssistantMessage has stopReason "toolUse" with toolCalls. */
  rounds: AssistantMessageEvent[][];
}

function buildAssistant(
  parts: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: parts,
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function makeFakeStream(plan: FakeStreamPlan): SparkAgentStreamFunction {
  let round = 0;
  const fake: SparkAgentStreamFunction = (_model: Model, _context: Context) => {
    const events = plan.rounds[round] ?? [];
    round += 1;
    let resolveResult: (value: AssistantMessage) => void = () => undefined;
    const resultPromise = new Promise<AssistantMessage>((resolve) => {
      resolveResult = resolve;
    });
    const iterable: AsyncIterable<AssistantMessageEvent> & {
      result(): Promise<AssistantMessage>;
    } = {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
          if (event.type === "done") resolveResult(event.message);
          if (event.type === "error") resolveResult(event.error);
        }
      },
      result: () => resultPromise,
    };
    return iterable;
  };
  return fake;
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

void test("compactToolResultContent normalizes status whitespace with details", () => {
  const result = compactToolResultContent({
    toolName: "goal",
    content: [{ type: "text", text: "\n\nalpha\n\n\nbeta\n\n" }],
    level: "full",
  });

  assert.equal(result.content[0]?.text, "alpha\n\nbeta");
  assert.deepEqual(result.details, {
    profile: "status",
    level: "full",
    originalChars: 16,
    compactedChars: 11,
    trimmedLeadingBlankLines: 2,
    trimmedTrailingBlankLines: 2,
    collapsedBlankLines: 1,
    collapsedBlankRuns: 1,
    collapsedRepeatedLines: 0,
    collapsedRepeatedRuns: 0,
  });
});

void test("compactToolResultContent supports diagnostic profile", () => {
  const result = compactToolResultContent({
    toolName: "spark_diagnostic",
    content: [{ type: "text", text: `error${"\n".repeat(80)}next` }],
    level: "full",
  });

  assert.equal(result.content[0]?.text, "error\n\n[78 blank lines collapsed]\nnext");
  assert.equal(result.details?.profile, "diagnostic");
  assert.equal(result.details?.collapsedBlankLines, 78);
  assert.equal(result.details?.collapsedRepeatedLines, 0);
});

void test("compactToolResultContent collapses repeated log lines", () => {
  const result = compactToolResultContent({
    toolName: "cue_exec",
    content: [{ type: "text", text: `${"warning: noisy dependency\n".repeat(30)}done` }],
    level: "full",
  });

  assert.equal(
    result.content[0]?.text,
    "warning: noisy dependency\n[previous line repeated 29×]\ndone",
  );
  assert.equal(result.details?.collapsedRepeatedLines, 29);
  assert.equal(result.details?.collapsedRepeatedRuns, 1);
});

void test("compactToolResultContent treats memory as compact status output", () => {
  const result = compactToolResultContent({
    toolName: "memory",
    content: [{ type: "text", text: "Memory status\n\n\n\n- active=1" }],
    level: "full",
  });

  assert.equal(result.content[0]?.text, "Memory status\n\n- active=1");
  assert.equal(result.details?.profile, "status");
});

void test("compactToolResultContent preserves unknown tools by default", () => {
  const output = "alpha\n\n\n\nbeta";
  const result = compactToolResultContent({
    toolName: "third_party_tool",
    content: [{ type: "text", text: output }],
    level: "ultra",
  });

  assert.equal(result.content[0]?.text, output);
  assert.equal(result.details, undefined);
});

void test("compactToolResultContent respects off level and never-worse fallback", () => {
  const output = "a\n\n\n\nb";
  assert.equal(
    compactToolResultContent({
      toolName: "cue_exec",
      content: [{ type: "text", text: output }],
      level: "off",
    }).content[0]?.text,
    output,
  );
  assert.equal(
    compactToolResultContent({
      toolName: "cue_exec",
      content: [{ type: "text", text: output }],
      level: "full",
    }).content[0]?.text,
    output,
  );
});

void test("Spark prompt cache splits stable/dynamic prompt sections and honors disable switches", () => {
  const split = splitSparkSystemPrompt(
    [
      "Stable Spark operating rules.",
      "Current date: 2026-07-03\nCurrent working directory: /repo",
      "Dynamic context checkpoint: task-state-v2",
    ].join("\n\n"),
  );
  assert.equal(split.stablePrompt, "Stable Spark operating rules.");
  assert.match(split.dynamicPrompt, /Current date/);
  assert.match(split.dynamicPrompt, /task-state-v2/);

  const enabled = resolveSparkPromptCache({
    systemPrompt: [split.stablePrompt, split.dynamicPrompt].join("\n\n"),
    sessionId: "session:abc",
    checkpoint: "manual refresh",
    env: {},
  });
  assert.match(enabled.promptCacheKey ?? "", /^spark:[0-9a-f]{16}:[0-9a-f]{16}:manual-refresh$/);
  assert.ok((enabled.promptCacheKey?.length ?? Infinity) <= 64);
  assert.equal(enabled.disabledReason, undefined);

  const disabled = resolveSparkPromptCache({
    systemPrompt: split.stablePrompt,
    sessionId: "session:abc",
    env: { SPARK_PROMPT_CACHE_KEY: "off" },
  });
  assert.equal(disabled.promptCacheKey, undefined);
  assert.equal(disabled.disabledReason, "env");
});

void test("Spark prompt cache hashes long session ids without losing the stable fingerprint", () => {
  const systemPrompt = "Stable Spark operating rules.";
  const sharedSessionPrefix = `session:${"shared-segment-".repeat(20)}`;
  const first = resolveSparkPromptCache({
    systemPrompt,
    sessionId: `${sharedSessionPrefix}first`,
    checkpoint: "manual refresh",
    env: {},
  });
  const second = resolveSparkPromptCache({
    systemPrompt,
    sessionId: `${sharedSessionPrefix}second`,
    checkpoint: "manual refresh",
    env: {},
  });

  for (const snapshot of [first, second]) {
    assert.ok((snapshot.promptCacheKey?.length ?? Infinity) <= 64);
    assert.match(
      snapshot.promptCacheKey ?? "",
      new RegExp(`^spark:[0-9a-f]{16}:${snapshot.stableHash.slice(0, 16)}:manual-refresh$`),
    );
  }
  assert.notEqual(first.promptCacheKey, second.promptCacheKey);
});

void test("SparkAgentLoop passes prompt_cache_key and reports cache usage summaries", async () => {
  const viewEvents: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-cache-key-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const finalAssistant = buildAssistant([{ type: "text", text: "cached" }]);
  finalAssistant.usage.input = 40;
  finalAssistant.usage.output = 8;
  finalAssistant.usage.cacheRead = 128;
  finalAssistant.usage.cacheWrite = 32;
  finalAssistant.usage.totalTokens = 208;
  finalAssistant.usage.cost.total = 0.125;
  const calls: Array<{ context: Context; options: any }> = [];
  const loopEvents: SparkAgentLoopEvent[] = [];
  host.registerTool({
    name: "read_manifest_probe",
    description: "read-only manifest probe",
    parameters: { type: "object" },
    policy: {
      effect: "read",
      executionMode: "parallel",
      domains: ["files"],
      phases: ["implement"],
      approval: "none",
    },
    async execute() {
      return { content: [{ type: "text", text: "unused" }] };
    },
  });
  host.registerTool({
    name: "inactive_write_probe",
    description: "inactive write manifest probe",
    parameters: { type: "object" },
    policy: { effect: "local_write", executionMode: "sequential", approval: "required" },
    async execute() {
      return { content: [{ type: "text", text: "unused" }] };
    },
  });
  host.setActiveTools(["read_manifest_probe"]);
  const streamFunction: SparkAgentStreamFunction = (_model, context, options) => {
    calls.push({ context, options });
    return makeFakeStream({
      rounds: [[{ type: "done", reason: "stop", message: finalAssistant }]],
    })(_model, context, options);
  };
  const loop = new SparkAgentLoop({
    host,
    streamFunction,
    getModel: () => TEST_MODEL,
    systemPrompt: [
      "Stable Spark operating rules.",
      "Current date: 2026-07-03\nCurrent working directory: /repo",
    ].join("\n\n"),
    promptCache: { checkpoint: "session-start", env: {} },
    promptManifest: {
      promptVersion: "agent-loop-test-v1",
      getSelectedSkills: () => ["files", "testing", "files"],
    },
  });
  loop.setViewSessionId("session:cache-test");
  loop.onEvent((event) => loopEvents.push(event));

  const outcome = await loop.submitWithOutcome("use cache");

  assert.match(calls[0]?.context.promptCacheKey ?? "", /^spark:[0-9a-f]{16}:[0-9a-f]{16}:/);
  assert.ok((calls[0]?.context.promptCacheKey?.length ?? Infinity) <= 64);
  assert.equal(calls[0]?.context.systemPromptStable, "Stable Spark operating rules.");
  assert.match(calls[0]?.context.systemPromptDynamic ?? "", /Current date/);
  assert.equal(calls[0]?.options?.prompt_cache_key, calls[0]?.context.promptCacheKey);
  assert.equal(calls[0]?.options?.promptCacheKey, calls[0]?.context.promptCacheKey);
  assert.equal(
    viewEvents.some(
      (event) =>
        (event as { type?: string; run?: { summary?: string } }).type === "run.update" &&
        /cache read=128 write=32/.test(
          (event as { run?: { summary?: string } }).run?.summary ?? "",
        ),
    ),
    true,
  );
  const completedRun = viewEvents.find(
    (event: any) => event.type === "run.update" && event.run.status === "succeeded",
  ) as any;
  assert.deepEqual(completedRun.run.metadata.usageTotals, {
    inputTokens: 40,
    outputTokens: 8,
    cacheReadTokens: 128,
    cacheWriteTokens: 32,
    costUsd: 0.125,
    latestCacheHitPercent: 64,
    contextTokens: 208,
    contextWindow: 8000,
  });
  const manifestEvents = loopEvents.filter(
    (event): event is Extract<SparkAgentLoopEvent, { type: "prompt_manifest" }> =>
      event.type === "prompt_manifest",
  );
  assert.equal(manifestEvents.length, 1);
  const manifest = manifestEvents[0]!.manifest;
  assert.equal(loop.getLastPromptManifest(), manifest);
  assert.equal(manifest.promptVersion, "agent-loop-test-v1");
  assert.deepEqual(manifest.selectedSkills, ["files", "testing"]);
  assert.deepEqual(manifest.tools, [
    {
      name: "read_manifest_probe",
      effect: "read",
      executionMode: "parallel",
      approval: "none",
      domains: ["files"],
      phases: ["implement"],
    },
  ]);
  assert.equal(manifest.roundtrip.index, 1);
  assert.equal(manifest.roundtrip.remaining, 15);
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /session:cache-test|Stable Spark operating rules|Current date: 2026-07-03/u,
  );
  const baseline = evaluateSparkBehavior(
    {
      id: "answer-only-runtime-baseline",
      allowedTools: [],
      expectedOutcomes: ["completed"],
      maxToolCalls: 0,
      maxRoundtrips: 1,
    },
    {
      manifest,
      toolCalls: [],
      outcome: outcome.status,
      roundtrips: outcome.roundtrips,
    },
  );
  assert.equal(baseline.passed, true);
  assert.equal(outcome.roundtrips, 1);
});

void test("SparkAgentLoop applies one phase profile to schemas, manifests, and dispatch", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-phase-profile-test" });
  const lifecycleSources: unknown[] = [];
  host.on("before_agent_start", (event) => {
    lifecycleSources.push((event as { source?: unknown }).source);
  });
  let implementExecutions = 0;
  host.registerTool({
    name: "plan_probe",
    description: "available only while planning",
    parameters: { type: "object" },
    policy: { effect: "read", executionMode: "parallel", phases: ["plan"], approval: "none" },
    async execute() {
      return { content: [{ type: "text", text: "plan" }] };
    },
  });
  host.registerTool({
    name: "implement_action",
    description: "available only while implementing",
    parameters: { type: "object" },
    policy: {
      effect: "local_write",
      executionMode: "sequential",
      phases: ["implement"],
      approval: "none",
    },
    async execute() {
      implementExecutions += 1;
      return { content: [{ type: "text", text: "implemented" }] };
    },
  });
  host.registerTool({
    name: "unphased_probe",
    description: "available in every phase",
    parameters: { type: "object" },
    policy: { effect: "read", executionMode: "parallel", approval: "none" },
    async execute() {
      return { content: [{ type: "text", text: "unphased" }] };
    },
  });

  const schemaToolNames: string[][] = [];
  const manifestToolNames: string[][] = [];
  const forgedPlanCall: ToolCall = {
    type: "toolCall",
    id: "tc-phase-forged",
    name: "implement_action",
    arguments: {},
  };
  const allowedImplementCall: ToolCall = {
    type: "toolCall",
    id: "tc-phase-allowed",
    name: "implement_action",
    arguments: {},
  };
  let modelCall = 0;
  const streamFunction: SparkAgentStreamFunction = (model, context, options) => {
    schemaToolNames.push((context.tools ?? []).map((tool: { name: string }) => tool.name));
    const call = modelCall;
    modelCall += 1;
    const message =
      call === 0
        ? buildAssistant([forgedPlanCall], "toolUse")
        : call === 2
          ? buildAssistant([allowedImplementCall], "toolUse")
          : buildAssistant([{ type: "text", text: `phase complete ${call}` }]);
    return makeFakeStream({
      rounds: [[{ type: "done", reason: message.stopReason, message }]],
    })(model, context, options);
  };
  const loop = new SparkAgentLoop({ host, streamFunction, getModel: () => TEST_MODEL });
  loop.onEvent((event) => {
    if (event.type === "prompt_manifest") {
      manifestToolNames.push(event.manifest.tools.map((tool) => tool.name));
    }
  });

  assert.equal(loop.getCurrentPhase(), undefined);
  loop.setCurrentPhase("plan");
  assert.equal(loop.getCurrentPhase(), "plan");
  await loop.submit("plan without writes");

  assert.equal(implementExecutions, 0);
  assert.deepEqual(schemaToolNames[0], ["plan_probe", "unphased_probe"]);
  const rejected = loop
    .getMessages()
    .find((message) => message.role === "toolResult" && message.toolCallId === "tc-phase-forged");
  assert.equal(rejected?.isError, true);
  assert.match(rejected?.content[0]?.text ?? "", /phase-inactive tool: implement_action/u);

  loop.setCurrentPhase("implement");
  assert.equal(loop.getCurrentPhase(), "implement");
  await loop.submit("implement now");

  assert.equal(implementExecutions, 1);
  assert.deepEqual(schemaToolNames[2], ["implement_action", "unphased_probe"]);
  const allowed = loop
    .getMessages()
    .find((message) => message.role === "toolResult" && message.toolCallId === "tc-phase-allowed");
  assert.equal(allowed?.isError, false);
  assert.deepEqual(manifestToolNames, schemaToolNames);
  assert.deepEqual(lifecycleSources, ["agentLoop", "agentLoop", "agentLoop", "agentLoop"]);
});

void test("SparkAgentLoop rechecks phase availability after async approval", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-phase-approval-test" });
  let executions = 0;
  host.registerTool({
    name: "approved_implement_action",
    description: "phase may change while approval is pending",
    parameters: { type: "object" },
    policy: {
      effect: "local_write",
      executionMode: "sequential",
      phases: ["implement"],
      approval: "required",
    },
    async execute() {
      executions += 1;
      return { content: [{ type: "text", text: "must not run" }] };
    },
  });
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "tc-phase-after-approval",
    name: "approved_implement_action",
    arguments: {},
  };
  let loop!: SparkAgentLoop;
  loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [
        [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
        [
          {
            type: "done",
            reason: "stop",
            message: buildAssistant([{ type: "text", text: "phase changed" }]),
          },
        ],
      ],
    }),
    getModel: () => TEST_MODEL,
    approvalMethod: "auto",
    reviewToolApproval: async () => {
      loop.setCurrentPhase("plan");
      return { outcome: "approved", summary: "approved before phase transition" };
    },
  });
  loop.setCurrentPhase("implement");

  await loop.submit("approve then switch phase");

  assert.equal(executions, 0);
  const result = loop
    .getMessages()
    .find((message) => message.role === "toolResult" && message.toolCallId === toolCall.id);
  assert.equal(result?.isError, true);
  assert.match(result?.content[0]?.text ?? "", /phase-inactive tool: approved_implement_action/u);
});

void test("SparkAgentLoop forwards getReasoning into stream options.reasoning", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-reasoning-test" });
  const calls: Array<{ options: any }> = [];
  const streamFunction: SparkAgentStreamFunction = (_model, _context, options) => {
    calls.push({ options });
    return makeFakeStream({
      rounds: [
        [
          {
            type: "done",
            reason: "stop",
            message: buildAssistant([{ type: "text", text: "ok" }]),
          },
        ],
      ],
    })(_model, _context, options);
  };
  const loop = new SparkAgentLoop({
    host,
    streamFunction,
    getModel: () => TEST_MODEL,
    getReasoning: () => "high",
  });

  await loop.submit("think carefully");

  assert.equal(calls[0]?.options?.reasoning, "high");
});

void test("SparkAgentLoop runs a single-turn stop with one streamed text chunk", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  const events: SparkAgentLoopEvent[] = [];
  const finalMessage = buildAssistant([{ type: "text", text: "hello world" }]);
  const fake = makeFakeStream({
    rounds: [
      [
        { type: "start", partial: finalMessage },
        { type: "text_delta", contentIndex: 0, delta: "hello world", partial: finalMessage },
        { type: "done", reason: "stop", message: finalMessage },
      ],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  loop.onEvent((event) => events.push(event));

  const result = await loop.submit("hi");
  assert.equal(result?.stopReason, "stop");
  assert.equal(loop.getState(), "idle");
  assert.equal(host.isIdle(), true);
  assert.equal(loop.getMessages().length, 2, "user + assistant");
  const types = events.filter((event) => event.type !== "view_event").map((event) => event.type);
  assert.deepEqual(types.slice(0, 3), ["user_message", "prompt_manifest", "stream_event"]);
  assert.equal(events.find((event) => event.type === "turn_complete") !== undefined, true);
});

void test("SparkAgentLoop times out a never-resolving model stream", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-stream-timeout-test" });
  const agentEndEvents: unknown[] = [];
  host.on("agent_end", (event) => agentEndEvents.push(event));
  const fake: SparkAgentStreamFunction = () =>
    ({
      async *[Symbol.asyncIterator]() {
        await new Promise<never>(() => undefined);
        yield undefined as never;
      },
      result: async () => await new Promise<never>(() => undefined),
    }) as ReturnType<SparkAgentStreamFunction>;
  const loop = new SparkAgentLoop({
    host,
    streamFunction: fake,
    getModel: () => TEST_MODEL,
    streamTimeoutMs: 10,
  });

  await loop.submit("hang stream");

  assert.equal(loop.getState(), "idle");
  assert.match(
    (agentEndEvents[0] as { errorMessage?: string }).errorMessage ?? "",
    /Spark agent model stream timed out after 10ms/u,
  );
});

void test("SparkAgentLoop projects user, streaming, final, and run updates to view-model events", async () => {
  const viewEvents: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-view-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const events: SparkAgentLoopEvent[] = [];
  const finalMessage = buildAssistant([{ type: "text", text: "hello protocol" }]);
  const fake = makeFakeStream({
    rounds: [
      [
        { type: "start", partial: finalMessage },
        { type: "text_delta", contentIndex: 0, delta: "hello protocol", partial: finalMessage },
        { type: "done", reason: "stop", message: finalMessage },
      ],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  loop.setViewSessionId("session-view-loop");
  loop.onEvent((event) => events.push(event));

  await loop.submit("hi");

  const protocolEvents = events.filter((event) => event.type === "view_event");
  assert.equal(protocolEvents.length, viewEvents.length);
  assert.equal(
    viewEvents.some((event: any) => event.type === "run.update" && event.run.status === "running"),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event: any) => event.type === "run.update" && event.run.status === "succeeded",
    ),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event: any) =>
        event.type === "session.message" &&
        event.sessionId === "session-view-loop" &&
        event.message.role === "assistant" &&
        event.message.status === "done" &&
        event.message.text === "hello protocol",
    ),
    true,
  );
});

void test("SparkAgentLoop projects an empty provider error as a visible terminal message", async () => {
  const viewEvents: any[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-visible-error-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const errorAssistant = {
    ...buildAssistant([], "error"),
    errorMessage: "provider unavailable",
  };
  const loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [[{ type: "done", reason: "error", message: errorAssistant }]],
    }),
    getModel: () => TEST_MODEL,
  });
  loop.setViewSessionId("session-visible-error");

  await loop.submit("hello");

  assert.equal(
    viewEvents.some(
      (event) =>
        event.type === "session.message" &&
        event.message.role === "assistant" &&
        event.message.status === "error" &&
        event.message.text === "provider unavailable" &&
        event.message.metadata.errorMessage === "provider unavailable",
    ),
    true,
  );
});

void test("SparkAgentLoop appends multi-roundtrip assistant messages in order without overwriting", async () => {
  const viewEvents: any[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-order-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  host.registerTool({
    name: "noop",
    description: "noop",
    parameters: { type: "object" },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-order",
    name: "noop",
    arguments: {},
  };
  const firstAssistant = buildAssistant(
    [{ type: "text", text: "before tool" }, toolCallEnvelope],
    "toolUse",
  );
  const secondAssistant = buildAssistant([{ type: "text", text: "after tool" }]);
  const fake = makeFakeStream({
    rounds: [
      [
        { type: "start", partial: firstAssistant },
        { type: "done", reason: "toolUse", message: firstAssistant },
      ],
      [
        { type: "start", partial: secondAssistant },
        { type: "done", reason: "stop", message: secondAssistant },
      ],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  loop.setViewSessionId("session-order-loop");

  await loop.submit("do it");

  const assistantMessages = viewEvents.filter(
    (event) => event.type === "session.message" && event.message.role === "assistant",
  );
  const distinctIds = new Set(assistantMessages.map((event) => event.message.id));
  assert.equal(distinctIds.size, 2, "each roundtrip's assistant message gets its own view id");
  const doneTexts = assistantMessages
    .filter((event) => event.message.status === "done")
    .map((event) => event.message.text);
  assert.deepEqual(doneTexts, ["before tool", "after tool"]);
});

void test("SparkAgentLoop projects thinking deltas on the stable assistant message", async () => {
  const viewEvents: any[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-thinking-stream-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const started = buildAssistant([]);
  const thinking = buildAssistant([{ type: "thinking", thinking: "checking constraints" }]);
  const final = buildAssistant([
    { type: "thinking", thinking: "checking constraints" },
    { type: "text", text: "done" },
  ]);
  const loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [
        [
          { type: "start", partial: started },
          { type: "thinking_start", contentIndex: 0, partial: thinking },
          {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "checking constraints",
            partial: thinking,
          },
          {
            type: "thinking_end",
            contentIndex: 0,
            content: "checking constraints",
            partial: thinking,
          },
          { type: "done", reason: "stop", message: final },
        ],
      ],
    }),
    getModel: () => TEST_MODEL,
  });

  await loop.submit("think first");

  const assistantMessages = viewEvents.filter(
    (event) => event.type === "session.message" && event.message.role === "assistant",
  );
  const thinkingUpdate = assistantMessages.find(
    (event) =>
      event.message.status === "streaming" &&
      event.message.parts?.some(
        (part: { type: string; text?: string }) =>
          part.type === "thinking" && part.text === "checking constraints",
      ),
  );
  assert.ok(thinkingUpdate, "thinking deltas should be projected before the final answer");
  const doneMessage = assistantMessages.find((event) => event.message.status === "done");
  assert.equal(doneMessage?.message.id, thinkingUpdate.message.id);
});

void test("SparkAgentLoop terminalizes a partial assistant bubble when the stream throws", async () => {
  const viewEvents: any[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-partial-error-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const partial = buildAssistant([{ type: "text", text: "partial answer" }]);
  const loop = new SparkAgentLoop({
    host,
    streamFunction: () =>
      ({
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial };
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "partial answer",
            partial,
          };
          throw new Error("provider disconnected");
        },
        result: async () => partial,
      }) as ReturnType<SparkAgentStreamFunction>,
    getModel: () => TEST_MODEL,
  });

  await loop.submit("stream then fail");

  const assistantMessages = viewEvents.filter(
    (event) => event.type === "session.message" && event.message.role === "assistant",
  );
  assert.equal(new Set(assistantMessages.map((event) => event.message.id)).size, 1);
  assert.equal(assistantMessages.at(-1)?.message.status, "error");
  assert.equal(assistantMessages.at(-1)?.message.text, "partial answer");
  assert.equal(
    viewEvents.some((event) => event.type === "run.update" && event.run.status === "failed"),
    true,
  );
});

void test("SparkAgentLoop emits exactly one agent_end for terminal outcomes", async () => {
  const stopAssistant = buildAssistant([{ type: "text", text: "done" }]);
  const toolUseAssistant = buildAssistant(
    [{ type: "toolCall", id: "tc-max", name: "missing", arguments: {} }],
    "toolUse",
  );
  const cases: Array<{
    name: string;
    streamFunction: SparkAgentStreamFunction;
    maxRoundtrips?: number;
    expectedError?: RegExp;
    expectedStopReason?: AssistantMessage["stopReason"];
    expectedStatus: SparkRunOutcome["status"];
  }> = [
    {
      name: "normal stop",
      streamFunction: makeFakeStream({
        rounds: [[{ type: "done", reason: "stop", message: stopAssistant }]],
      }),
      expectedStatus: "completed",
    },
    {
      name: "provider abort",
      streamFunction: makeFakeStream({
        rounds: [
          [
            {
              type: "done",
              reason: "aborted",
              message: buildAssistant([], "aborted"),
            },
          ],
        ],
      }),
      expectedStatus: "aborted",
      expectedStopReason: "aborted",
    },
    {
      name: "stream throws",
      streamFunction: () =>
        ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw new Error("stream boom");
              },
            };
          },
          result: async () => stopAssistant,
        }) as ReturnType<SparkAgentStreamFunction>,
      expectedError: /stream boom/,
      expectedStopReason: "error",
      expectedStatus: "failed",
    },
    {
      name: "no assistant",
      streamFunction: () =>
        ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => ({ done: true, value: undefined as AssistantMessageEvent }),
            };
          },
          result: async () => undefined as AssistantMessage,
        }) as ReturnType<SparkAgentStreamFunction>,
      expectedError: /stream produced no assistant message/,
      expectedStopReason: "error",
      expectedStatus: "failed",
    },
    {
      name: "empty response",
      streamFunction: makeFakeStream({
        rounds: [[{ type: "done", reason: "stop", message: buildAssistant([]) }]],
      }),
      expectedError: /model completed without a displayable response/,
      expectedStopReason: "error",
      expectedStatus: "failed",
    },
    {
      name: "max roundtrips",
      streamFunction: makeFakeStream({
        rounds: [[{ type: "done", reason: "toolUse", message: toolUseAssistant }]],
      }),
      maxRoundtrips: 1,
      expectedError: /agent loop hit maxRoundtrips=1; stopping/,
      expectedStopReason: "error",
      expectedStatus: "budget_exhausted",
    },
    {
      name: "zero max roundtrips",
      streamFunction: () => {
        assert.fail("maxRoundtrips=0 must not start a model stream");
      },
      maxRoundtrips: 0,
      expectedError: /agent loop hit maxRoundtrips=0; stopping/,
      expectedStopReason: "error",
      expectedStatus: "budget_exhausted",
    },
  ];

  for (const entry of cases) {
    const host = new SparkHostRuntime({ cwd: `/tmp/spark-agent-loop-test-${entry.name}` });
    const agentEndEvents: unknown[] = [];
    const loopEvents: SparkAgentLoopEvent[] = [];
    host.on("agent_end", (event) => agentEndEvents.push(event));
    const loop = new SparkAgentLoop({
      host,
      streamFunction: entry.streamFunction,
      getModel: () => TEST_MODEL,
      maxRoundtrips: entry.maxRoundtrips,
    });
    loop.onEvent((event) => loopEvents.push(event));

    const outcome = await loop.submitWithOutcome(entry.name);
    const result = outcome.assistant;

    assert.equal(agentEndEvents.length, 1, `${entry.name} should emit agent_end exactly once`);
    assert.equal(loop.getState(), "idle", `${entry.name} should leave the loop idle`);
    assert.equal(outcome.status, entry.expectedStatus, `${entry.name} should classify its outcome`);
    assert.equal(loop.getLastOutcome()?.status, entry.expectedStatus);
    assert.equal(
      loopEvents.filter((event) => event.type === "run_outcome").length,
      1,
      `${entry.name} should publish exactly one explicit outcome`,
    );
    if (entry.expectedStopReason) {
      assert.equal(
        result?.stopReason,
        entry.expectedStopReason,
        `${entry.name} should return its terminal stop reason`,
      );
      assert.equal(
        loop.getMessages().at(-1)?.stopReason,
        entry.expectedStopReason,
        `${entry.name} should persist its terminal stop reason`,
      );
      assert.equal(
        (agentEndEvents[0] as { messages?: AssistantMessage[] }).messages?.[0]?.stopReason,
        entry.expectedStopReason,
        `${entry.name} should expose its terminal stop reason on agent_end`,
      );
      if (entry.expectedError) {
        assert.match(
          result?.errorMessage ?? "",
          entry.expectedError,
          `${entry.name} should return the terminal error detail`,
        );
      }
    }
    if (entry.expectedError) {
      assert.match(
        (agentEndEvents[0] as { errorMessage?: string }).errorMessage ?? "",
        entry.expectedError,
        `${entry.name} should expose the terminal error on agent_end`,
      );
      assert.equal(
        loopEvents.some(
          (event) => event.type === "error" && entry.expectedError?.test(event.message),
        ),
        true,
        `${entry.name} should publish the terminal error`,
      );
    }
  }
});

void test("SparkAgentLoop dispatches tool calls and feeds tool results back into the next turn", async () => {
  const viewEvents: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  let toolCalls = 0;
  let toolSessionId: string | undefined;
  host.registerTool({
    name: "echo",
    description: "echo input",
    parameters: { type: "object" },
    async execute(_id, params, _signal, onUpdate, ctx) {
      toolCalls += 1;
      toolSessionId = ctx.sessionId;
      onUpdate({ content: [{ type: "text", text: "echo is running" }] });
      return {
        content: [{ type: "text", text: `echoed:${(params as { x?: string }).x ?? ""}` }],
        details: {
          task: {
            ref: "task:echo-1",
            title: "Echo task",
            status: "running",
            projectRef: "proj:echo",
            outputArtifacts: ["artifact:echo-1"],
          },
          artifact: {
            ref: "artifact:echo-1",
            title: "Echo artifact",
            kind: "record",
            format: "json",
            producer: "task",
          },
        },
      };
    },
  });

  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-1",
    name: "echo",
    arguments: { x: "ping" },
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after echo" }]);
  const fake = makeFakeStream({
    rounds: [
      [
        { type: "start", partial: firstAssistant },
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: toolCallEnvelope,
          partial: firstAssistant,
        },
        { type: "done", reason: "toolUse", message: firstAssistant },
      ],
      [
        { type: "start", partial: finalAssistant },
        { type: "done", reason: "stop", message: finalAssistant },
      ],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  loop.setViewSessionId("session:tool-context");
  const events: SparkAgentLoopEvent[] = [];
  loop.onEvent((event) => events.push(event));

  await loop.submit("call the echo tool");
  assert.equal(toolCalls, 1);
  assert.equal(toolSessionId, "session:tool-context");
  assert.equal(host.makeContext().sessionId, "session:tool-context");
  const messages = loop.getMessages();
  assert.equal(messages.length, 4, "user + asst toolUse + toolResult + asst stop");
  assert.equal(messages[2]!.role, "toolResult");
  assert.equal((messages[2] as { isError?: boolean }).isError, false);
  assert.equal(loop.getState(), "idle");
  const toolResultEvent = events.find((event) => event.type === "tool_result");
  assert.equal(toolResultEvent !== undefined, true);
  assert.equal(
    viewEvents.some(
      (event: any) =>
        event.type === "session.message" &&
        event.message.role === "tool" &&
        event.message.status === "pending" &&
        event.message.toolName === "echo",
    ),
    true,
  );
  const echoToolMessages = viewEvents.filter(
    (event: any) =>
      event.type === "session.message" &&
      event.message.role === "tool" &&
      event.message.toolCallId === "tc-1",
  );
  assert.deepEqual(
    [...new Set(echoToolMessages.map((event: any) => event.message.id))],
    ["tool-call:tc-1"],
  );
  assert.equal(
    viewEvents.some(
      (event: any) =>
        event.type === "session.message" &&
        event.message.role === "tool" &&
        event.message.status === "streaming" &&
        event.message.text === "echo is running" &&
        event.message.toolName === "echo",
    ),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event: any) =>
        event.type === "session.message" &&
        event.message.role === "tool" &&
        event.message.status === "done" &&
        event.message.toolName === "echo",
    ),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event: any) =>
        event.type === "task.update" &&
        event.task.ref === "task:echo-1" &&
        event.task.status === "running" &&
        event.task.artifactRefs.includes("artifact:echo-1") &&
        event.task.metadata.sourceTool === "echo",
    ),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event: any) =>
        event.type === "artifact.update" &&
        event.artifact.ref === "artifact:echo-1" &&
        event.artifact.kind === "record" &&
        event.artifact.metadata.sourceTool === "echo",
    ),
    true,
  );
});

void test("SparkAgentLoop runs an explicitly safe read batch concurrently and commits results in source order", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-parallel-read-test" });
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const events: SparkAgentLoopEvent[] = [];
  for (const name of ["read_alpha", "read_beta"]) {
    host.registerTool({
      name,
      description: name,
      parameters: { type: "object" },
      policy: { effect: "read", executionMode: "parallel", approval: "none" },
      async execute(toolCallId) {
        started.push(toolCallId);
        await new Promise<void>((resolve) => releases.set(toolCallId, resolve));
        return { content: [{ type: "text", text: `result:${toolCallId}` }] };
      },
    });
  }
  const toolCalls: ToolCall[] = [
    { type: "toolCall", id: "tc-alpha", name: "read_alpha", arguments: {} },
    { type: "toolCall", id: "tc-beta", name: "read_beta", arguments: {} },
  ];
  const firstAssistant = buildAssistant(toolCalls, "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "reads complete" }]);
  const loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [
        [{ type: "done", reason: "toolUse", message: firstAssistant }],
        [{ type: "done", reason: "stop", message: finalAssistant }],
      ],
    }),
    getModel: () => TEST_MODEL,
  });
  loop.onEvent((event) => events.push(event));

  const run = loop.submit("read two files");
  await waitForCondition(
    () => started.length === 2,
    "both explicitly safe reads should start before either one completes",
  );
  releases.get("tc-beta")!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releases.get("tc-alpha")!();
  await run;

  assert.deepEqual(started, ["tc-alpha", "tc-beta"]);
  const results = loop.getMessages().filter((message) => message.role === "toolResult");
  assert.deepEqual(
    results.map((message) => message.toolCallId),
    ["tc-alpha", "tc-beta"],
  );
  assert.deepEqual(
    results.map((message) => message.content[0]?.text),
    ["result:tc-alpha", "result:tc-beta"],
  );
  assert.deepEqual(
    events
      .filter(
        (event): event is Extract<SparkAgentLoopEvent, { type: "tool_result" }> =>
          event.type === "tool_result",
      )
      .map((event) => event.message.toolCallId),
    ["tc-alpha", "tc-beta"],
  );
});

void test("SparkAgentLoop treats a mixed read/write batch as one sequential barrier", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-mixed-tool-test" });
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  host.registerTool({
    name: "parallel_read",
    description: "explicitly safe read",
    parameters: { type: "object" },
    effect: "read",
    executionMode: "parallel",
    async execute(toolCallId) {
      started.push(toolCallId);
      await new Promise<void>((resolve) => releases.set(toolCallId, resolve));
      return { content: [{ type: "text", text: toolCallId }] };
    },
  });
  host.registerTool({
    name: "write_barrier",
    description: "stateful write",
    parameters: { type: "object" },
    effect: "local_write",
    executionMode: "sequential",
    async execute(toolCallId) {
      started.push(toolCallId);
      return { content: [{ type: "text", text: toolCallId }] };
    },
  });
  const toolCalls: ToolCall[] = [
    { type: "toolCall", id: "tc-read-a", name: "parallel_read", arguments: {} },
    { type: "toolCall", id: "tc-read-b", name: "parallel_read", arguments: {} },
    { type: "toolCall", id: "tc-write", name: "write_barrier", arguments: {} },
  ];
  const loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [
        [{ type: "done", reason: "toolUse", message: buildAssistant(toolCalls, "toolUse") }],
        [
          {
            type: "done",
            reason: "stop",
            message: buildAssistant([{ type: "text", text: "done" }]),
          },
        ],
      ],
    }),
    getModel: () => TEST_MODEL,
  });

  const run = loop.submit("read then write");
  await waitForCondition(() => started.length === 1, "the first read should start");
  assert.deepEqual(started, ["tc-read-a"]);
  releases.get("tc-read-a")!();
  await waitForCondition(
    () => started.length === 2,
    "the second read should start after the first",
  );
  assert.deepEqual(started, ["tc-read-a", "tc-read-b"]);
  releases.get("tc-read-b")!();
  await run;

  assert.deepEqual(started, ["tc-read-a", "tc-read-b", "tc-write"]);
});

void test("SparkAgentLoop keeps tools without explicit execution metadata sequential", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-unknown-policy-test" });
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  for (const name of ["unknown_a", "unknown_b"]) {
    host.registerTool({
      name,
      description: name,
      parameters: { type: "object" },
      async execute(toolCallId) {
        started.push(toolCallId);
        await new Promise<void>((resolve) => releases.set(toolCallId, resolve));
        return { content: [{ type: "text", text: toolCallId }] };
      },
    });
  }
  const toolCalls: ToolCall[] = [
    { type: "toolCall", id: "tc-unknown-a", name: "unknown_a", arguments: {} },
    { type: "toolCall", id: "tc-unknown-b", name: "unknown_b", arguments: {} },
  ];
  const loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [
        [{ type: "done", reason: "toolUse", message: buildAssistant(toolCalls, "toolUse") }],
        [
          {
            type: "done",
            reason: "stop",
            message: buildAssistant([{ type: "text", text: "done" }]),
          },
        ],
      ],
    }),
    getModel: () => TEST_MODEL,
  });

  const run = loop.submit("call unknown-policy tools");
  await waitForCondition(() => started.length === 1, "the first unknown-policy tool should start");
  assert.deepEqual(started, ["tc-unknown-a"]);
  releases.get("tc-unknown-a")!();
  await waitForCondition(
    () => started.length === 2,
    "the second unknown-policy tool should wait for the first",
  );
  releases.get("tc-unknown-b")!();
  await run;

  assert.deepEqual(started, ["tc-unknown-a", "tc-unknown-b"]);
});

void test("SparkAgentLoop bounds parallel read batches to four calls by default", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-parallel-bound-test" });
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  let active = 0;
  let maxActive = 0;
  host.registerTool({
    name: "bounded_read",
    description: "bounded parallel read",
    parameters: { type: "object" },
    effect: "read",
    executionMode: "parallel",
    async execute(toolCallId) {
      started.push(toolCallId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) =>
        releases.set(toolCallId, () => {
          releases.delete(toolCallId);
          resolve();
        }),
      );
      active -= 1;
      return { content: [{ type: "text", text: toolCallId }] };
    },
  });
  const toolCalls: ToolCall[] = Array.from({ length: 6 }, (_, index) => ({
    type: "toolCall",
    id: `tc-bounded-${index}`,
    name: "bounded_read",
    arguments: {},
  }));
  const loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [
        [{ type: "done", reason: "toolUse", message: buildAssistant(toolCalls, "toolUse") }],
        [
          {
            type: "done",
            reason: "stop",
            message: buildAssistant([{ type: "text", text: "done" }]),
          },
        ],
      ],
    }),
    getModel: () => TEST_MODEL,
  });

  const run = loop.submit("run bounded reads");
  await waitForCondition(() => started.length === 4, "the first four reads should fill the pool");
  assert.equal(active, 4);
  assert.equal(maxActive, 4);
  for (const release of [...releases.values()]) release();
  await waitForCondition(
    () => started.length === 6,
    "the final reads should start after capacity frees",
  );
  assert.equal(active, 2);
  for (const release of [...releases.values()]) release();
  await run;

  assert.equal(maxActive, 4);
  assert.deepEqual(
    loop
      .getMessages()
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolCallId),
    toolCalls.map((toolCall) => toolCall.id),
  );
});

void test("SparkAgentLoop isolates failures inside a parallel read batch", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-parallel-error-test" });
  const executed: string[] = [];
  host.registerTool({
    name: "fallible_read",
    description: "read with one failing call",
    parameters: { type: "object" },
    effect: "read",
    executionMode: "parallel",
    async execute(toolCallId) {
      executed.push(toolCallId);
      if (toolCallId === "tc-fail") throw new Error("read failed independently");
      return { content: [{ type: "text", text: `ok:${toolCallId}` }] };
    },
  });
  const toolCalls: ToolCall[] = [
    { type: "toolCall", id: "tc-fail", name: "fallible_read", arguments: {} },
    { type: "toolCall", id: "tc-ok", name: "fallible_read", arguments: {} },
  ];
  const loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [
        [{ type: "done", reason: "toolUse", message: buildAssistant(toolCalls, "toolUse") }],
        [
          {
            type: "done",
            reason: "stop",
            message: buildAssistant([{ type: "text", text: "done" }]),
          },
        ],
      ],
    }),
    getModel: () => TEST_MODEL,
  });

  await loop.submit("run fallible reads");

  assert.deepEqual(executed, ["tc-fail", "tc-ok"]);
  const results = loop.getMessages().filter((message) => message.role === "toolResult");
  assert.deepEqual(
    results.map((message) => [message.toolCallId, message.isError]),
    [
      ["tc-fail", true],
      ["tc-ok", false],
    ],
  );
  assert.match(results[0]?.content[0]?.text ?? "", /read failed independently/);
  assert.equal(results[1]?.content[0]?.text, "ok:tc-ok");
});

void test("SparkAgentLoop publishes ordered display-safe conversation parts without tool payloads", async () => {
  const viewEvents: any[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-display-safe-view-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  host.registerTool({
    name: "inspect_secret",
    description: "exercise display-safe tool projection",
    parameters: { type: "object" },
    async execute() {
      return {
        content: [{ type: "text", text: "public-tool-output" }],
        details: { token: "secret-tool-details" },
      };
    },
  });

  const toolCall: ToolCall = {
    type: "toolCall",
    id: "tc-display-safe",
    name: "inspect_secret",
    arguments: { token: "secret-tool-argument" },
  };
  const firstAssistant = buildAssistant(
    [
      { type: "thinking", thinking: "Check the safe public state." },
      {
        type: "thinking",
        thinking: "secret-redacted-thinking",
        thinkingSignature: "secret-thinking-signature",
        redacted: true,
      },
      { type: "text", text: "Inspecting now." },
      toolCall,
    ],
    "toolUse",
  );
  const finalAssistant = buildAssistant([{ type: "text", text: "Inspection complete." }]);
  const loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [
        [
          { type: "start", partial: firstAssistant },
          { type: "toolcall_end", contentIndex: 3, toolCall, partial: firstAssistant },
          { type: "done", reason: "toolUse", message: firstAssistant },
        ],
        [
          { type: "start", partial: finalAssistant },
          { type: "done", reason: "stop", message: finalAssistant },
        ],
      ],
    }),
    getModel: () => TEST_MODEL,
  });
  loop.setViewSessionId("session-display-safe-view");

  await loop.submit("inspect safely");

  const assistantMessage = viewEvents.find(
    (event) =>
      event.type === "session.message" &&
      event.message.role === "assistant" &&
      event.message.status === "done" &&
      event.message.text === "Inspecting now.",
  )?.message;
  assert.ok(assistantMessage);
  assert.deepEqual(
    assistantMessage.parts.map((part: { type: string }) => part.type),
    ["thinking", "thinking", "text", "tool-call"],
  );
  assert.deepEqual(assistantMessage.parts[1], {
    id: `${assistantMessage.id}:part:1`,
    type: "thinking",
    text: "",
    status: "complete",
    redacted: true,
    metadata: {},
  });
  assert.deepEqual(assistantMessage.parts[2], {
    id: `${assistantMessage.id}:part:2`,
    type: "text",
    text: "Inspecting now.",
    status: "complete",
    metadata: {},
  });
  assert.deepEqual(assistantMessage.parts[3], {
    id: `${assistantMessage.id}:part:3`,
    type: "tool-call",
    toolCallId: "tc-display-safe",
    toolName: "inspect_secret",
    status: "pending",
    metadata: {},
  });

  const toolCallMessage = viewEvents.find(
    (event) => event.type === "session.message" && event.message.id === "tool-call:tc-display-safe",
  )?.message;
  assert.deepEqual(toolCallMessage.parts, [
    {
      id: "tool-call:tc-display-safe:part:0",
      type: "tool-call",
      toolCallId: "tc-display-safe",
      toolName: "inspect_secret",
      status: "pending",
      metadata: {},
    },
  ]);
  assert.deepEqual(toolCallMessage.metadata, { kind: "tool_call" });

  const toolResultMessage = viewEvents.find(
    (event) =>
      event.type === "session.message" &&
      event.message.id === "tool-call:tc-display-safe" &&
      event.message.status === "done",
  )?.message;
  assert.equal(toolResultMessage.text, "public-tool-output");
  assert.deepEqual(toolResultMessage.parts, [
    {
      id: "tool-call:tc-display-safe:part:0",
      type: "tool-result",
      toolCallId: "tc-display-safe",
      toolName: "inspect_secret",
      status: "complete",
      summary: "public-tool-output",
      metadata: {},
    },
  ]);
  assert.deepEqual(toolResultMessage.metadata, { kind: "tool_result" });

  assert.doesNotMatch(
    JSON.stringify(viewEvents),
    /secret-tool-argument|secret-tool-details|secret-redacted-thinking|secret-thinking-signature/u,
  );
});

void test("SparkAgentLoop keeps text phases without projecting commentary as assistant prose", async () => {
  const viewEvents: any[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-text-phase-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const assistant = buildAssistant([
    {
      type: "text",
      text: "Checking the repository.",
      textSignature: JSON.stringify({
        v: 1,
        phase: "commentary",
        providerSecret: "commentary-text-signature-secret",
      }),
    },
    {
      type: "text",
      text: "The check passed.",
      textSignature: JSON.stringify({
        phase: "final_answer",
        providerSecret: "final-text-signature-secret",
      }),
    },
    { type: "text", text: "Legacy detail." },
    {
      type: "text",
      text: "Unknown phase stays visible.",
      textSignature: JSON.stringify({ phase: "future_phase" }),
    },
    {
      type: "text",
      text: "Malformed signature stays visible.",
      textSignature: "not-json-signature-secret",
    },
  ]);
  const loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [[{ type: "done", reason: "stop", message: assistant }]],
    }),
    getModel: () => TEST_MODEL,
  });
  loop.setViewSessionId("session-text-phase-view");

  await loop.submit("check phases");

  const message = viewEvents.find(
    (event) =>
      event.type === "session.message" &&
      event.message.role === "assistant" &&
      event.message.status === "done",
  )?.message;
  assert.ok(message);
  assert.equal(
    message.text,
    "The check passed.\nLegacy detail.\nUnknown phase stays visible.\nMalformed signature stays visible.",
  );
  assert.deepEqual(
    message.parts.map((part: { phase?: string }) => part.phase),
    ["commentary", "final_answer", undefined, undefined, undefined],
  );
  assert.doesNotMatch(
    JSON.stringify(viewEvents),
    /commentary-text-signature-secret|final-text-signature-secret|not-json-signature-secret/u,
  );
});

void test("SparkAgentLoop compacts blank runs for log-like tool results", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-compaction-test" });
  const noisyOutput = `alpha${"\n".repeat(61)}omega`;
  host.registerTool({
    name: "cue_exec",
    description: "fake cue output",
    parameters: { type: "object" },
    async execute() {
      return { content: [{ type: "text", text: noisyOutput }] };
    },
  });

  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-compact",
    name: "cue_exec",
    arguments: { command: "fake" },
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after compaction" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });

  await loop.submit("call compacting tool");

  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(
    (toolResult as { content: Array<{ text?: string }> }).content[0]?.text,
    "alpha\n\n[58 blank lines collapsed]\n\nomega",
  );
  const compaction = (toolResult as { details?: { toolResultCompaction?: any } }).details
    ?.toolResultCompaction;
  assert.equal(compaction.profile, "log");
  assert.equal(compaction.level, "full");
  assert.equal(compaction.trimmedLeadingBlankLines, 0);
  assert.equal(compaction.trimmedTrailingBlankLines, 0);
  assert.equal(compaction.collapsedBlankLines, 58);
  assert.equal(compaction.collapsedBlankRuns, 1);
  assert.equal(compaction.collapsedRepeatedLines, 0);
  assert.equal(compaction.collapsedRepeatedRuns, 0);
  assert.equal(compaction.originalChars > compaction.compactedChars, true);
});

void test("SparkAgentLoop records raw trace artifact for large lossy compacted tool output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-loop-raw-recovery-"));
  try {
    const host = new SparkHostRuntime({ cwd: dir });
    registerPiArtifactTool({
      registerTool: (config) =>
        host.registerTool(config as Parameters<typeof host.registerTool>[0]),
    });
    const noisyOutput = `alpha${"\n".repeat(4_500)}omega`;
    host.registerTool({
      name: "cue_exec",
      description: "fake cue output",
      parameters: { type: "object" },
      async execute() {
        return { content: [{ type: "text", text: noisyOutput }] };
      },
    });

    const toolCallEnvelope: ToolCall = {
      type: "toolCall",
      id: "tc-raw-recovery",
      name: "cue_exec",
      arguments: { command: "fake" },
    };
    const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
    const finalAssistant = buildAssistant([{ type: "text", text: "after raw recovery" }]);
    const fake = makeFakeStream({
      rounds: [
        [{ type: "done", reason: "toolUse", message: firstAssistant }],
        [{ type: "done", reason: "stop", message: finalAssistant }],
      ],
    });
    const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });

    await loop.submit("call compacting tool");

    const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
    const text = (toolResult as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
    assert.match(text, /\[4497 blank lines collapsed\]/);
    assert.match(text, /\[recovery\] Full raw tool output saved as artifact:/);
    assert.match(
      text,
      /artifact\(\{ action: "read", artifactRef: "artifact:[^"]+", maxChars: 20000 \}\)/,
    );
    const recovery = (toolResult as { details?: { toolResultRawRecovery?: any } }).details
      ?.toolResultRawRecovery;
    assert.match(recovery.artifactRef, /^artifact:/);
    assert.equal(recovery.reason, "lossy_compaction");
    assert.equal(recovery.bodyChars, noisyOutput.length);
    assert.deepEqual(recovery.recoveryPath, {
      kind: "artifact",
      artifactRef: recovery.artifactRef,
      readTool: "artifact",
      readArgs: { action: "read", artifactRef: recovery.artifactRef, maxChars: 20_000 },
    });

    const store = defaultArtifactStore(dir);
    const artifact = await store.get(recovery.artifactRef);
    assert.equal(artifact.kind, "trace");
    assert.equal(artifact.format, "text");
    assert.equal(artifact.curation?.status, "raw");
    assert.equal(artifact.curation?.retention, "ephemeral");
    assert.equal(artifact.provenance.producer, "cue");
    assert.equal(
      artifact.provenance.note,
      "Raw recoverable tool result for cue_exec (lossy_compaction)",
    );
    assert.equal(await store.getBody(recovery.artifactRef), noisyOutput);

    const artifactTool = host.getTool("artifact");
    assert.ok(artifactTool);
    const readResult = await artifactTool.config.execute(
      "read-raw-output",
      { action: "read", artifactRef: recovery.artifactRef, maxChars: noisyOutput.length + 200 },
      new AbortController().signal,
      () => undefined,
      host.makeContext(),
    );
    const readText = readResult.content
      .map((part: { text?: string }) => part.text ?? "")
      .join("\n");
    assert.match(
      readText,
      new RegExp(`${recovery.artifactRef} \\[trace\\] Raw tool output for cue_exec`),
    );
    assert.match(readText, /alpha/);
    assert.match(readText, /omega/);

    const defaultList = await artifactTool.config.execute(
      "list-default-raw-hidden",
      { action: "list", limit: 5 },
      new AbortController().signal,
      () => undefined,
      host.makeContext(),
    );
    const defaultListText = defaultList.content
      .map((part: { text?: string }) => part.text ?? "")
      .join("\n");
    assert.doesNotMatch(defaultListText, new RegExp(recovery.artifactRef));

    const explicitRawList = await artifactTool.config.execute(
      "list-explicit-raw",
      { action: "list", includeRaw: true, limit: 5 },
      new AbortController().signal,
      () => undefined,
      host.makeContext(),
    );
    const explicitRawListText = explicitRawList.content
      .map((part: { text?: string }) => part.text ?? "")
      .join("\n");
    assert.match(explicitRawListText, new RegExp(recovery.artifactRef));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test(
  "SparkAgentLoop aborts a hanging raw recovery and keeps the compacted tool result paired",
  { timeout: 2_000 },
  async () => {
    const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-raw-recovery-abort" });
    let artifactCalls = 0;
    let artifactStarted = false;
    let artifactAborted = false;
    host.registerTool({
      name: "artifact",
      description: "raw recovery sink that deliberately never resolves",
      parameters: { type: "object" },
      policy: { effect: "local_write", executionMode: "sequential", approval: "none" },
      async execute(_toolCallId, _args, signal) {
        artifactCalls += 1;
        artifactStarted = true;
        if (signal.aborted) artifactAborted = true;
        signal.addEventListener(
          "abort",
          () => {
            artifactAborted = true;
          },
          { once: true },
        );
        return await new Promise<never>(() => undefined);
      },
    });
    const noisyOutput = `alpha${"\n".repeat(4_500)}omega`;
    host.registerTool({
      name: "cue_exec",
      description: "compactable read-like output",
      parameters: { type: "object" },
      policy: { effect: "read", executionMode: "parallel", approval: "none" },
      async execute() {
        return { content: [{ type: "text", text: noisyOutput }] };
      },
    });
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "tc-hanging-raw-recovery",
      name: "cue_exec",
      arguments: {},
    };
    const loop = new SparkAgentLoop({
      host,
      streamFunction: makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
        ],
      }),
      getModel: () => TEST_MODEL,
      toolTimeoutMs: 60_000,
    });

    const running = loop.submitWithOutcome("produce a large compactable result");
    await waitForCondition(() => artifactStarted, "raw artifact recovery should start");
    loop.abort("switch_session");
    const outcome = await running;

    assert.equal(outcome.status, "aborted");
    assert.equal(loop.getState(), "idle");
    assert.equal(artifactCalls, 1, "raw recovery must not recursively persist itself");
    assert.equal(artifactAborted, true);
    const results = loop.getMessages().filter((message) => message.role === "toolResult");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.toolCallId, toolCall.id);
    assert.equal(results[0]?.isError, false);
    assert.match(results[0]?.content[0]?.text ?? "", /\[4497 blank lines collapsed\]/u);
    assert.doesNotMatch(results[0]?.content[0]?.text ?? "", /\[recovery\]/u);
  },
);

void test("SparkAgentLoop preserves exact-content tool results", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-exact-compaction-test" });
  const exactOutput = "line1\n\n\n\n\nline2";
  host.registerTool({
    name: "read",
    description: "fake read output",
    parameters: { type: "object" },
    async execute() {
      return { content: [{ type: "text", text: exactOutput }] };
    },
  });

  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-read-exact",
    name: "read",
    arguments: { path: "file.txt" },
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after read" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });

  await loop.submit("call read tool");

  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal((toolResult as { content: Array<{ text?: string }> }).content[0]?.text, exactOutput);
  assert.equal(
    (toolResult as { details?: { toolResultCompaction?: unknown } }).details?.toolResultCompaction,
    undefined,
  );
});

void test("SparkAgentLoop times out a never-resolving tool execution", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-tool-timeout-test" });
  host.registerTool({
    name: "hang_tool",
    description: "never returns",
    parameters: { type: "object" },
    async execute() {
      return await new Promise<never>(() => undefined);
    },
  });
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-tool-timeout",
    name: "hang_tool",
    arguments: {},
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after timeout" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    streamFunction: fake,
    getModel: () => TEST_MODEL,
    toolTimeoutMs: 10,
  });

  await loop.submit("call hanging tool");

  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.equal(
    (toolResult as { content: Array<{ text?: string }> }).content[0]?.text,
    'Spark tool "hang_tool" timed out after 10ms',
  );
  assert.equal(loop.getState(), "idle");
});

void test("SparkAgentLoop times out a never-resolving tool approval interaction", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-timeout-test",
    ui: {
      interaction: async () => await new Promise<never>(() => undefined),
    },
  });
  let toolCalls = 0;
  host.registerTool({
    name: "approval_hang",
    description: "requires approval that never arrives",
    parameters: { type: "object" },
    requiresApproval: true,
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "should not run" }] };
    },
  } as never);
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval-timeout",
    name: "approval_hang",
    arguments: {},
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after approval timeout" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    streamFunction: fake,
    getModel: () => TEST_MODEL,
    interactionTimeoutMs: 10,
  });

  await loop.submit("call approval hanging tool");

  assert.equal(toolCalls, 0);
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.equal(
    (toolResult as { content: Array<{ text?: string }> }).content[0]?.text,
    'Spark tool approval for "approval_hang" timed out after 10ms',
  );
  assert.equal(loop.getState(), "idle");
});

void test("SparkAgentLoop blocks approval-required tools without explicit approval", async () => {
  const interactionRequests: unknown[] = [];
  const daemonEvents: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-test",
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: 1,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "blocked",
          approved: false,
          message: "approval unavailable",
          metadata: {},
        };
      },
    },
  });
  host.onDaemonEvent((event) => daemonEvents.push(event));
  let toolCalls = 0;
  host.registerTool({
    name: "dangerous",
    description: "requires approval",
    parameters: { type: "object" },
    policy: { effect: "destructive", executionMode: "sequential", approval: "required" },
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "should not run" }] };
    },
  } as never);

  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval",
    name: "dangerous",
    arguments: { path: "important.txt" },
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after blocked tool" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });

  await loop.submit("try dangerous tool");

  assert.equal(toolCalls, 0);
  assert.equal((interactionRequests[0] as { kind?: string }).kind, "toolApproval");
  assert.equal(
    daemonEvents.some(
      (event: any) =>
        event.type === "daemon.interaction.request" &&
        event.request.kind === "toolApproval" &&
        event.request.toolName === "dangerous",
    ),
    true,
  );
  assert.equal(
    daemonEvents.some(
      (event: any) =>
        event.type === "daemon.interaction.response" &&
        event.response.kind === "toolApproval" &&
        event.response.status === "blocked",
    ),
    true,
  );
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(toolResult), /approval unavailable/);
});

void test("SparkAgentLoop skip approvalMethod executes requiresApproval tools without interaction", async () => {
  const interactionRequests: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-skip-test",
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: 1,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "blocked",
          approved: false,
          message: "should not be asked",
          metadata: {},
        };
      },
    },
  });
  let toolCalls = 0;
  host.registerTool({
    name: "dangerous_skip",
    description: "requires approval but session skips",
    parameters: { type: "object" },
    requiresApproval: true,
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "ran" }] };
    },
  } as never);
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval-skip",
    name: "dangerous_skip",
    arguments: {},
  };
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: buildAssistant([toolCallEnvelope], "toolUse") }],
      [
        {
          type: "done",
          reason: "stop",
          message: buildAssistant([{ type: "text", text: "done" }]),
        },
      ],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    streamFunction: fake,
    getModel: () => TEST_MODEL,
    approvalMethod: "skip",
  });

  await loop.submit("try skip approval");

  assert.equal(toolCalls, 1);
  assert.equal(interactionRequests.length, 0);
});

void test("SparkAgentLoop auto approvalMethod executes when reviewer approves", async () => {
  const interactionRequests: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-auto-ok-test",
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: 1,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "blocked",
          approved: false,
          message: "should not be asked",
          metadata: {},
        };
      },
    },
  });
  let toolCalls = 0;
  const reviewCalls: unknown[] = [];
  host.registerTool({
    name: "dangerous_auto_ok",
    description: "requires approval",
    parameters: { type: "object" },
    requiresApproval: true,
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "ran" }] };
    },
  } as never);
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval-auto-ok",
    name: "dangerous_auto_ok",
    arguments: { cmd: "echo hi" },
  };
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: buildAssistant([toolCallEnvelope], "toolUse") }],
      [
        {
          type: "done",
          reason: "stop",
          message: buildAssistant([{ type: "text", text: "done" }]),
        },
      ],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    streamFunction: fake,
    getModel: () => TEST_MODEL,
    approvalMethod: "auto",
    reviewToolApproval: async (request) => {
      reviewCalls.push(request);
      return { outcome: "approved", summary: "safe" };
    },
  });

  await loop.submit("try auto approve");

  assert.equal(toolCalls, 1);
  assert.equal(reviewCalls.length, 1);
  assert.equal((reviewCalls[0] as { toolName?: string }).toolName, "dangerous_auto_ok");
  assert.equal(interactionRequests.length, 0);
});

void test("SparkAgentLoop auto approvalMethod escalates to ask when reviewer rejects", async () => {
  const interactionRequests: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-auto-ask-test",
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: 1,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "answered",
          approved: true,
          metadata: {},
        };
      },
    },
  });
  let toolCalls = 0;
  host.registerTool({
    name: "dangerous_auto_ask",
    description: "requires approval",
    parameters: { type: "object" },
    requiresApproval: true,
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "ran after ask" }] };
    },
  } as never);
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval-auto-ask",
    name: "dangerous_auto_ask",
    arguments: {},
  };
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: buildAssistant([toolCallEnvelope], "toolUse") }],
      [
        {
          type: "done",
          reason: "stop",
          message: buildAssistant([{ type: "text", text: "done" }]),
        },
      ],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    streamFunction: fake,
    getModel: () => TEST_MODEL,
    approvalMethod: "auto",
    approvalRejectAction: "ask",
    reviewToolApproval: async () => ({ outcome: "blocked", summary: "too risky" }),
  });

  await loop.submit("try auto then ask");

  assert.equal(toolCalls, 1);
  assert.equal((interactionRequests[0] as { kind?: string }).kind, "toolApproval");
});

void test("SparkAgentLoop auto approvalMethod can deny without ask", async () => {
  const interactionRequests: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-auto-deny-test",
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: 1,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "answered",
          approved: true,
          metadata: {},
        };
      },
    },
  });
  let toolCalls = 0;
  host.registerTool({
    name: "dangerous_auto_deny",
    description: "requires approval",
    parameters: { type: "object" },
    requiresApproval: true,
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "should not run" }] };
    },
  } as never);
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval-auto-deny",
    name: "dangerous_auto_deny",
    arguments: {},
  };
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: buildAssistant([toolCallEnvelope], "toolUse") }],
      [
        {
          type: "done",
          reason: "stop",
          message: buildAssistant([{ type: "text", text: "done" }]),
        },
      ],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    streamFunction: fake,
    getModel: () => TEST_MODEL,
    approvalMethod: "auto",
    approvalRejectAction: "deny",
    reviewToolApproval: async () => ({
      outcome: "needs_changes",
      summary: "needs a safer command",
    }),
  });

  await loop.submit("try auto deny");

  assert.equal(toolCalls, 0);
  assert.equal(interactionRequests.length, 0);
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(toolResult), /needs a safer command/);
});

void test("SparkAgentLoop preserves tool-returned isError results", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  host.registerTool({
    name: "business_error",
    description: "returns an explicit tool error",
    parameters: { type: "object" },
    async execute() {
      return {
        content: [{ type: "text", text: "business rule failed" }],
        details: { error: "business_rule_failed" },
        isError: true,
      };
    },
  });
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-business-error",
    name: "business_error",
    arguments: {},
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "handled" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });

  await loop.submit("trigger business error");

  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(toolResult), /business_rule_failed/);
});

void test("SparkAgentLoop unknown tool returns an isError tool result without throwing", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-2",
    name: "missing",
    arguments: {},
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "fallback" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  await loop.submit("trigger missing tool");
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(toolResult), /unknown tool: missing/);
});

void test("SparkAgentLoop refuses a model call to a registered but inactive tool", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-inactive-tool-test" });
  let executed = false;
  host.registerTool({
    name: "inactive_write",
    description: "must remain behind the active-tool boundary",
    parameters: { type: "object" },
    policy: { effect: "local_write", executionMode: "sequential", approval: "none" },
    async execute() {
      executed = true;
      return { content: [{ type: "text", text: "should not execute" }] };
    },
  });
  host.setActiveTools([]);
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "tc-inactive",
    name: "inactive_write",
    arguments: {},
  };
  const loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [
        [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
        [
          {
            type: "done",
            reason: "stop",
            message: buildAssistant([{ type: "text", text: "inactive call rejected" }]),
          },
        ],
      ],
    }),
    getModel: () => TEST_MODEL,
  });

  await loop.submit("attempt inactive tool");

  assert.equal(executed, false);
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal((toolResult as { isError?: boolean } | undefined)?.isError, true);
  assert.match(JSON.stringify(toolResult), /inactive tool: inactive_write/u);
});

void test("SparkAgentLoop drainOutboxIntoMessages turns sendUserMessage envelopes into next-turn user messages", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  const firstAssistant = buildAssistant([{ type: "text", text: "first turn" }]);
  const secondAssistant = buildAssistant([{ type: "text", text: "after outbox" }]);
  let calls = 0;
  const fake: SparkAgentStreamFunction = (_model, _context) => {
    calls += 1;
    if (calls === 1) {
      // After turn 1, push a user message into the outbox so the loop runs again.
      host.sendUserMessage("follow up", { deliverAs: "steer" });
    }
    const message = calls === 1 ? firstAssistant : secondAssistant;
    let resolve!: (value: AssistantMessage) => void;
    const resultPromise = new Promise<AssistantMessage>((r) => {
      resolve = r;
    });
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message };
        resolve(message);
      },
      result: () => resultPromise,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({
    host,
    streamFunction: fake,
    getModel: () => TEST_MODEL,
    maxRoundtrips: 4,
  });
  await loop.submit("start");
  // Expected message log: user("start"), asst1, user("follow up"), asst2
  const messages = loop.getMessages();
  assert.equal(messages.length, 4);
  assert.equal(messages[2]!.role, "user");
  assert.match(JSON.stringify(messages[2]!.content), /follow up/);
  assert.equal((messages[3] as AssistantMessage).content[0]!.type, "text");
});

void test("SparkAgentLoop triggerTurn queues hidden custom messages without visible user echo", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-trigger-turn-custom-test" });
  const finalAssistant = buildAssistant([{ type: "text", text: "goal tick executed" }]);
  let streamCalls = 0;
  let contextMessages: Message[] = [];
  const eventTypes: string[] = [];
  const fake: SparkAgentStreamFunction = (_model, context) => {
    streamCalls += 1;
    contextMessages = [...context.messages];
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message: finalAssistant };
      },
      result: async () => finalAssistant,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  const completed = new Promise<void>((resolve) => {
    loop.onEvent((event) => {
      eventTypes.push(event.type);
      if (event.type === "turn_complete") resolve();
    });
  });

  host.sendMessage(
    {
      customType: "spark-goal-request",
      content: "queued goal instruction",
      display: false,
      authority: "runtime_control",
      trust: "trusted",
    },
    { deliverAs: "followUp", triggerTurn: true },
  );

  await completed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(streamCalls, 1);
  assert.equal(loop.getState(), "idle");
  assert.equal(contextMessages.length, 1);
  assert.equal(contextMessages[0]?.role, "user");
  assert.match(String(contextMessages[0]?.content), /<spark_runtime_control trust="trusted"/);
  assert.match(String(contextMessages[0]?.content), /custom_type="spark-goal-request"/);
  assert.match(String(contextMessages[0]?.content), /queued goal instruction/);
  assert.match(JSON.stringify(loop.getMessages()), /spark-goal-request/);
  assert.equal(eventTypes.includes("user_message"), false);
});

void test("SparkAgentLoop defaults extension custom messages to untrusted runtime data", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-untrusted-custom-test" });
  const finalAssistant = buildAssistant([{ type: "text", text: "observed" }]);
  let contextMessages: Message[] = [];
  const loop = new SparkAgentLoop({
    host,
    streamFunction: (_model, context) => {
      contextMessages = [...context.messages];
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: "stop", message: finalAssistant };
        },
        result: async () => finalAssistant,
      } as ReturnType<SparkAgentStreamFunction>;
    },
    getModel: () => TEST_MODEL,
  });
  const completed = new Promise<void>((resolve) => {
    loop.onEvent((event) => {
      if (event.type === "turn_complete") resolve();
    });
  });

  host.sendMessage(
    { customType: "spark-role-result", content: "model-authored result", display: false },
    { deliverAs: "followUp", triggerTurn: true },
  );

  await completed;
  assert.match(String(contextMessages[0]?.content), /<spark_runtime_data trust="untrusted"/u);
  const item = loop.getPromptItems().find((entry) => entry.customType === "spark-role-result");
  assert.equal(item?.authority, "runtime_data");
  assert.equal(item?.trust, "untrusted");
});

void test("SparkAgentLoop retains nextTurn runtime data in its originating session", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-next-turn-test" });
  const contexts: Message[][] = [];
  const loop = new SparkAgentLoop({
    host,
    streamFunction: (_model, context) => {
      contexts.push([...context.messages]);
      const message = buildAssistant([{ type: "text", text: "ok" }]);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: "stop", message };
        },
        result: async () => message,
      } as ReturnType<SparkAgentStreamFunction>;
    },
    getModel: () => TEST_MODEL,
  });

  loop.setViewSessionId("session-a");
  host.sendMessage(
    { customType: "spark-memory-checkpoint", content: "checkpoint payload", display: false },
    { deliverAs: "nextTurn", triggerTurn: false },
  );
  loop.setViewSessionId("session-b");
  await loop.submit("session b prompt");

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.length, 1);
  assert.equal(contexts[0]?.[0]?.content, "session b prompt");

  loop.replaceMessages([]);
  loop.setViewSessionId("session-a");
  await loop.submit("session a prompt");

  assert.equal(contexts.length, 2);
  assert.equal(contexts[1]?.length, 2);
  assert.match(String(contexts[1]?.[0]?.content), /spark-memory-checkpoint/u);
  assert.match(String(contexts[1]?.[0]?.content), /checkpoint payload/u);
  assert.equal(contexts[1]?.[1]?.content, "session a prompt");
});

void test("SparkAgentLoop triggerTurn uses queued user instruction without duplicate custom", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-trigger-turn-user-test" });
  const finalAssistant = buildAssistant([{ type: "text", text: "goal tick executed" }]);
  let contextMessages: Message[] = [];
  const fake: SparkAgentStreamFunction = (_model, context) => {
    contextMessages = [...context.messages];
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message: finalAssistant };
      },
      result: async () => finalAssistant,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  const completed = new Promise<void>((resolve) => {
    loop.onEvent((event) => {
      if (event.type === "turn_complete") resolve();
    });
  });

  host.sendUserMessage("queued goal instruction", { deliverAs: "followUp" });
  host.sendMessage(
    { customType: "spark-goal-request", content: "queued goal instruction", display: false },
    { deliverAs: "nextTurn", triggerTurn: true },
  );

  await completed;
  assert.equal(contextMessages.length, 1);
  assert.equal(contextMessages[0]?.content, "queued goal instruction");
  assert.doesNotMatch(JSON.stringify(loop.getMessages()), /spark-goal-request/);
});

void test("SparkAgentLoop triggerTurn runs hidden before_agent_start context without visible user echo", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-trigger-turn-test" });
  const finalAssistant = buildAssistant([{ type: "text", text: "goal tick executed" }]);
  let streamCalls = 0;
  let contextMessages: Message[] = [];
  const eventTypes: string[] = [];
  const lifecycleSources: unknown[] = [];
  host.on("before_agent_start", (event) => {
    lifecycleSources.push((event as { source?: unknown }).source);
    return {
      message: {
        customType: "spark-mode-context",
        content: "hidden context payload",
        display: false,
        authority: "runtime_control",
        trust: "trusted",
      },
    };
  });
  const fake: SparkAgentStreamFunction = (_model, context) => {
    streamCalls += 1;
    contextMessages = [...context.messages];
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message: finalAssistant };
      },
      result: async () => finalAssistant,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  const completed = new Promise<void>((resolve) => {
    loop.onEvent((event) => {
      eventTypes.push(event.type);
      if (event.type === "turn_complete") resolve();
    });
  });

  host.sendMessage(
    { customType: "spark-goal-request", content: "queued goal instruction", display: false },
    { deliverAs: "nextTurn", triggerTurn: true },
  );

  await completed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(streamCalls, 1);
  assert.equal(loop.getState(), "idle");
  assert.equal(contextMessages.length, 1);
  assert.equal(contextMessages[0]?.role, "user");
  assert.match(String(contextMessages[0]?.content), /<spark_runtime_control trust="trusted"/);
  assert.match(String(contextMessages[0]?.content), /custom_type="spark-mode-context"/);
  assert.match(String(contextMessages[0]?.content), /hidden context payload/);
  assert.doesNotMatch(JSON.stringify(loop.getMessages()), /spark-goal-request/);
  assert.equal(eventTypes.includes("user_message"), false);
  assert.deepEqual(lifecycleSources, ["triggerTurn"]);
  const runtimeItem = loop
    .getPromptItems()
    .find((item) => item.customType === "spark-mode-context");
  assert.equal(runtimeItem?.authority, "runtime_control");
  assert.equal(runtimeItem?.trust, "trusted");
  assert.equal(runtimeItem?.visibility, "hidden");
  assert.equal(runtimeItem?.persistence, "transient");
});

void test("SparkAgentLoop abort cancels the in-flight stream and returns to idle", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  let aborted = false;
  const fake: SparkAgentStreamFunction = (_model, _context, options) => {
    let resolve!: (value: AssistantMessage) => void;
    const resultPromise = new Promise<AssistantMessage>((r) => {
      resolve = r;
    });
    options?.signal?.addEventListener("abort", () => {
      aborted = true;
      resolve(buildAssistant([{ type: "text", text: "aborted" }], "aborted"));
    });
    return {
      async *[Symbol.asyncIterator]() {
        // Wait forever until aborted
        await new Promise<void>((r) => {
          options?.signal?.addEventListener("abort", () => r());
        });
        yield {
          type: "error",
          reason: "aborted",
          error: buildAssistant([], "aborted"),
        };
      },
      result: () => resultPromise,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  const promise = loop.submitWithOutcome("hang");
  // Abort after a microtask to ensure the loop entered streaming
  await new Promise<void>((resolve) => setImmediate(resolve));
  loop.abort("test_abort");
  const outcome = await promise;
  assert.equal(aborted, true, "abort signal fired");
  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.assistant.stopReason, "aborted");
  if (outcome.status === "aborted") assert.equal(outcome.reason, "test_abort");
  assert.equal(loop.getState(), "idle");
});

void test("SparkAgentLoop classifies a provider AbortError caused by user abort as aborted", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-abort-throw-test" });
  const fake: SparkAgentStreamFunction = (_model, _context, options) =>
    ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            await new Promise<void>((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            const error = new Error("provider cancelled request");
            error.name = "AbortError";
            throw error;
          },
        };
      },
      result: async () => buildAssistant([], "aborted"),
    }) as ReturnType<SparkAgentStreamFunction>;
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });

  const running = loop.submitWithOutcome("hang then throw");
  await new Promise<void>((resolve) => setImmediate(resolve));
  loop.abort("switch_session");
  const outcome = await running;

  assert.equal(outcome.status, "aborted");
  if (outcome.status === "aborted") assert.equal(outcome.reason, "switch_session");
  assert.equal(loop.getState(), "idle");
});

void test("SparkAgentLoop abort releases a pending human tool approval", async () => {
  let toolCalls = 0;
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-abort-test",
    ui: {
      interaction: async () => await new Promise<never>(() => undefined),
    },
  });
  host.registerTool({
    name: "approval_wait",
    description: "wait for human approval",
    parameters: { type: "object" },
    policy: { effect: "local_write", approval: "required" },
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "must not run" }] };
    },
  } as never);
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "tc-approval-abort",
    name: "approval_wait",
    arguments: {},
  };
  const loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [
        [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
      ],
    }),
    getModel: () => TEST_MODEL,
    approvalMethod: "human",
    interactionTimeoutMs: 60_000,
  });

  const running = loop.submitWithOutcome("ask then cancel");
  await new Promise<void>((resolve) => setImmediate(resolve));
  loop.abort("switch_session");
  const outcome = await running;

  assert.equal(outcome.status, "aborted");
  assert.equal(toolCalls, 0);
  assert.equal(loop.getState(), "idle");
});

void test("SparkAgentLoop pairs every sequential tool call with an aborted result", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-sequential-abort-test" });
  let firstStarted = false;
  let secondExecutions = 0;
  host.registerTool({
    name: "slow_sequential_tool",
    description: "waits until the run is aborted",
    parameters: { type: "object" },
    policy: { effect: "local_write", executionMode: "sequential", approval: "none" },
    async execute(_toolCallId, _params, signal) {
      firstStarted = true;
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { content: [{ type: "text", text: "unreachable" }] };
    },
  });
  host.registerTool({
    name: "later_sequential_tool",
    description: "must be paired but not executed after abort",
    parameters: { type: "object" },
    policy: { effect: "local_write", executionMode: "sequential", approval: "none" },
    async execute() {
      secondExecutions += 1;
      return { content: [{ type: "text", text: "must not run" }] };
    },
  });
  const toolCalls: ToolCall[] = [
    { type: "toolCall", id: "tc-abort-first", name: "slow_sequential_tool", arguments: {} },
    { type: "toolCall", id: "tc-abort-later", name: "later_sequential_tool", arguments: {} },
  ];
  const loop = new SparkAgentLoop({
    host,
    streamFunction: makeFakeStream({
      rounds: [
        [{ type: "done", reason: "toolUse", message: buildAssistant(toolCalls, "toolUse") }],
      ],
    }),
    getModel: () => TEST_MODEL,
  });

  const running = loop.submitWithOutcome("start then abort sequential tools");
  await waitForCondition(() => firstStarted, "the first sequential tool should start");
  loop.abort("switch_session");
  const outcome = await running;

  assert.equal(outcome.status, "aborted");
  assert.equal(secondExecutions, 0);
  const results = loop.getMessages().filter((message) => message.role === "toolResult");
  assert.deepEqual(
    results.map((message) => message.toolCallId),
    ["tc-abort-first", "tc-abort-later"],
  );
  assert.deepEqual(
    results.map((message) => message.isError),
    [true, true],
  );
  assert.match(results[1]?.content[0]?.text ?? "", /skipped because the agent was aborted/u);
});

void test("SparkAgentLoop refuses concurrent submit while in flight", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  let resolveStream!: (message: AssistantMessage) => void;
  const fake: SparkAgentStreamFunction = () => {
    const resultPromise = new Promise<AssistantMessage>((r) => {
      resolveStream = r;
    });
    return {
      async *[Symbol.asyncIterator]() {
        const message = await resultPromise;
        yield { type: "done", reason: "stop", message };
      },
      result: () => resultPromise,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  const first = loop.submit("first");
  await new Promise<void>((r) => setImmediate(r));
  await assert.rejects(loop.submit("second"), /not idle/);
  resolveStream(buildAssistant([{ type: "text", text: "ok" }]));
  await first;
  assert.equal(loop.getState(), "idle");
});
