import assert from "node:assert/strict";
import test from "node:test";

import {
  SparkProviderRegistry,
  createProviderRegistryStreamFunction,
  openAiCompatiblePromptCachePayload,
  type ProviderConfig,
} from "../packages/spark-ai/src/index.ts";

const fakeProvider: ProviderConfig = {
  name: "fake",
  baseUrl: "https://fake.test",
  apiKey: "FAKE_KEY",
  api: "openai-responses",
  streamSimple: () => ({ async *[Symbol.asyncIterator]() {} }),
  models: [
    {
      id: "model-a",
      name: "Model A",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024,
    },
  ],
};

void test("provider registry stream path forwards prompt_cache_key to OpenAI-compatible options", () => {
  const registry = new SparkProviderRegistry();
  let capturedOptions: any;
  registry.registerProvider("fake", {
    ...fakeProvider,
    streamSimple: (_model, _context, options) => {
      capturedOptions = options;
      return { async *[Symbol.asyncIterator]() {} };
    },
  });
  registry.setActive({ providerName: "fake", modelId: "model-a" });

  createProviderRegistryStreamFunction(registry)(
    registry.buildActiveModel() as never,
    { messages: [], tools: [] } as never,
    { prompt_cache_key: "spark:cache:key" } as never,
  );

  assert.equal(capturedOptions.prompt_cache_key, "spark:cache:key");
  assert.equal(capturedOptions.metadata.prompt_cache_key, "spark:cache:key");
  assert.deepEqual(openAiCompatiblePromptCachePayload(capturedOptions), {
    prompt_cache_key: "spark:cache:key",
  });
});
