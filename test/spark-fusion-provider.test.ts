import assert from "node:assert/strict";
import test from "node:test";

import {
  SPARK_FUSION_MODEL,
  SPARK_FUSION_PROVIDER,
  SparkProviderRegistry,
  registerSparkFusionProvider,
  resolveSparkFusionRunConfig,
  streamSparkFusion,
  type ProviderConfig,
  type ProviderModelDefinition,
  type SparkConfig,
} from "../packages/spark-cli/src/host/index.ts";

type AssistantMessage = any;
type Context = any;
type Model = any;
type SimpleStreamOptions = any;

function model(id: string): ProviderModelDefinition {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_000,
    maxTokens: 4_000,
  };
}

function assistant(modelId: string, text: string, outputTokens = 1): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: modelId,
    usage: {
      input: 1,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1 + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamMessage(message: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: "stop", message };
    },
    result: async () => message,
  };
}

function registryWithFakeProvider(captured: { judgePrompt?: string; panelPrompts: string[] }) {
  const registry = new SparkProviderRegistry();
  const provider: ProviderConfig = {
    name: "fake",
    baseUrl: "https://fake.test",
    api: "openai-completions",
    streamSimple: (selectedModel: Model, context: Context, _options?: SimpleStreamOptions) => {
      const last = context.messages.at(-1);
      const prompt = typeof last?.content === "string" ? last.content : "";
      if (selectedModel.id === "judge") {
        captured.judgePrompt = prompt;
        return streamMessage(assistant("judge", `JUDGE:${prompt.includes("PANEL-B")}`));
      }
      captured.panelPrompts.push(prompt);
      const suffix = selectedModel.id === "a" ? "A" : "B";
      return streamMessage(assistant(selectedModel.id, `PANEL-${suffix}`));
    },
    models: [model("a"), model("b"), model("judge")],
  };
  registry.registerProvider("fake", provider);
  return registry;
}

function fusionModel(): Model {
  return {
    id: SPARK_FUSION_MODEL,
    name: "Spark Fusion",
    api: "spark-fusion",
    provider: SPARK_FUSION_PROVIDER,
    baseUrl: "spark://fusion",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_000,
    maxTokens: 4_000,
  };
}

const baseConfig: SparkConfig = { extensions: [], providers: [] };

void test("registerSparkFusionProvider adds a selectable virtual model without hiding real models", () => {
  const captured = { panelPrompts: [] as string[] };
  const registry = registryWithFakeProvider(captured);
  registerSparkFusionProvider(registry, baseConfig);

  assert.equal(registry.hasProvider(SPARK_FUSION_PROVIDER), true);
  assert.deepEqual(
    registry.listModelsFor(SPARK_FUSION_PROVIDER).map((entry) => entry.id),
    [SPARK_FUSION_MODEL],
  );
  assert.deepEqual(
    registry.listModelsFor("fake").map((entry) => entry.id),
    ["a", "b", "judge"],
  );
});

void test("resolveSparkFusionRunConfig honors explicit panel and judge selections", () => {
  const captured = { panelPrompts: [] as string[] };
  const registry = registryWithFakeProvider(captured);
  registerSparkFusionProvider(registry, baseConfig);

  const runConfig = resolveSparkFusionRunConfig(registry, {
    extensions: [],
    providers: [],
    fusion: {
      analysisModels: [
        { provider: "fake", model: "b" },
        { provider: "fake", model: "a" },
      ],
      judgeModel: { provider: "fake", model: "judge" },
    },
  });

  assert.deepEqual(runConfig.analysisModels, [
    { provider: "fake", model: "b" },
    { provider: "fake", model: "a" },
  ]);
  assert.deepEqual(runConfig.judgeModel, { provider: "fake", model: "judge" });
});

void test("streamSparkFusion runs panel models in parallel and sends their output to the judge", async () => {
  const captured = { panelPrompts: [] as string[], judgePrompt: undefined as string | undefined };
  const registry = registryWithFakeProvider(captured);
  const config: SparkConfig = {
    extensions: [],
    providers: [],
    fusion: {
      analysisModels: [
        { provider: "fake", model: "a" },
        { provider: "fake", model: "b" },
      ],
      judgeModel: { provider: "fake", model: "judge" },
    },
  };
  registerSparkFusionProvider(registry, config);

  const stream = streamSparkFusion(
    registry,
    config,
    fusionModel(),
    { messages: [{ role: "user", content: "compare approaches", timestamp: Date.now() }] },
    {},
  );

  const events: string[] = [];
  for await (const event of stream) events.push(event.type);
  const result = await stream.result();

  assert.deepEqual(captured.panelPrompts, ["compare approaches", "compare approaches"]);
  assert.match(captured.judgePrompt ?? "", /PANEL-A/);
  assert.match(captured.judgePrompt ?? "", /PANEL-B/);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, "JUDGE:true");
  assert.deepEqual(events, ["start", "text_start", "text_delta", "text_end", "done"]);
  assert.equal(result.usage.input, 3, "two panel calls plus one judge call are accounted");
});
