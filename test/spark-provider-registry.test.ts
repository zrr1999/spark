import assert from "node:assert/strict";
import test from "node:test";

import { SparkHostModelRegistry } from "../apps/spark-tui/src/host/model-registry.ts";
import {
  SparkProviderRegistry,
  createProviderRegistryStreamFunction,
  registerBaiduOneApiProvider,
  type ProviderConfig,
} from "../packages/spark-ai/src/index.ts";

function fakeStream(_model: unknown, _context: unknown, _options?: unknown) {
  return {} as unknown;
}

const fakeProvider: ProviderConfig = {
  name: "fake",
  baseUrl: "https://fake.test",
  apiKey: "FAKE_KEY",
  api: "anthropic-messages",
  streamSimple: fakeStream,
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
    {
      id: "model-b",
      name: "Model B",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 2048,
    },
  ],
};

void test("SparkProviderRegistry registerProvider validates name + streamSimple + models", () => {
  const registry = new SparkProviderRegistry();
  assert.throws(() => registry.registerProvider("", fakeProvider), /requires a provider name/);
  assert.throws(
    () =>
      registry.registerProvider("missing-stream", {
        ...fakeProvider,
        streamSimple: undefined as unknown as ProviderConfig["streamSimple"],
      }),
    /must expose a streamSimple function/,
  );
  assert.throws(
    () => registry.registerProvider("no-models", { ...fakeProvider, models: [] }),
    /must declare at least one model/,
  );
});

void test("SparkProviderRegistry registers, lists, and looks up providers/models", () => {
  const registry = new SparkProviderRegistry();
  registry.registerProvider("fake", fakeProvider);
  assert.equal(registry.hasProvider("fake"), true);
  assert.equal(registry.hasProvider("missing"), false);
  assert.equal(registry.listProviders().length, 1);
  assert.equal(registry.getProvider("fake")?.baseUrl, "https://fake.test");
  assert.deepEqual(
    registry.listModelsFor("fake").map((m) => m.id),
    ["model-a", "model-b"],
  );
});

void test("SparkProviderRegistry setActive validates provider + model existence", () => {
  const registry = new SparkProviderRegistry();
  registry.registerProvider("fake", fakeProvider);
  assert.throws(
    () => registry.setActive({ providerName: "missing", modelId: "model-a" }),
    /Unknown provider: missing/,
  );
  assert.throws(
    () => registry.setActive({ providerName: "fake", modelId: "missing" }),
    /no model with id "missing"/,
  );
  registry.setActive({ providerName: "fake", modelId: "model-b" });
  assert.deepEqual(registry.getActive(), { providerName: "fake", modelId: "model-b" });
});

void test("SparkHostModelRegistry adapts provider models and filters env-auth availability", () => {
  const registry = new SparkProviderRegistry();
  registry.registerProvider("fake", fakeProvider);

  const withoutEnv = new SparkHostModelRegistry(registry, { env: {} });
  assert.deepEqual(
    withoutEnv.getAll().map((model) => `${model.provider}/${model.id}`),
    ["fake/model-a", "fake/model-b"],
  );
  assert.deepEqual(withoutEnv.getAvailable(), []);
  assert.equal(withoutEnv.hasConfiguredAuth(withoutEnv.getAll()[0]!), false);

  const withEnv = new SparkHostModelRegistry(registry, { env: { FAKE_KEY: "secret" } });
  assert.deepEqual(
    withEnv.getAvailable().map((model) => `${model.provider}/${model.id}`),
    ["fake/model-a", "fake/model-b"],
  );
  assert.equal(withEnv.hasConfiguredAuth(withEnv.getAll()[0]!), true);
});

void test("SparkProviderRegistry buildModel returns a pi-ai compatible Model<Api>", () => {
  const registry = new SparkProviderRegistry();
  registry.registerProvider("fake", fakeProvider);
  const model = registry.buildModel("fake", "model-b");
  assert.equal(model.id, "model-b");
  assert.equal(model.api, "anthropic-messages");
  assert.equal(model.provider, "fake");
  assert.equal(model.baseUrl, "https://fake.test");
  assert.equal(model.reasoning, true);
  assert.equal(model.contextWindow, 8192);
  assert.deepEqual(model.input, ["text", "image"]);
});

void test("SparkProviderRegistry supports model-level API overrides", () => {
  const registry = new SparkProviderRegistry();
  registry.registerProvider("fake", {
    ...fakeProvider,
    models: [
      {
        ...fakeProvider.models[0]!,
        api: "openai-responses",
        baseUrl: "https://fake.test/v1",
      },
    ],
  });
  const model = registry.buildModel("fake", "model-a");
  assert.equal(model.api, "openai-responses");
  assert.equal(model.baseUrl, "https://fake.test/v1");
});

void test("SparkProviderRegistry buildActiveModel reuses the active selection", () => {
  const registry = new SparkProviderRegistry();
  registry.registerProvider("fake", fakeProvider);
  assert.equal(registry.buildActiveModel(), undefined);
  registry.setActive({ providerName: "fake", modelId: "model-a" });
  const model = registry.buildActiveModel();
  assert.equal(model?.id, "model-a");
});

void test("createProviderRegistryStreamFunction normalizes bare async provider streams", async () => {
  const registry = new SparkProviderRegistry();
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "normalized" }],
    stopReason: "stop",
  };
  registry.registerProvider("fake", {
    ...fakeProvider,
    streamSimple: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message: assistant };
      },
    }),
  });
  registry.setActive({ providerName: "fake", modelId: "model-a" });

  const stream = createProviderRegistryStreamFunction(registry)(
    registry.buildActiveModel() as never,
    { messages: [], tools: [] } as never,
  );
  const events = [];
  for await (const event of stream) events.push(event);

  const retaggedAssistant = {
    ...assistant,
    api: "anthropic-messages",
    provider: "fake",
    model: "model-a",
  };
  assert.deepEqual(events, [{ type: "done", reason: "stop", message: retaggedAssistant }]);
  assert.deepEqual(await stream.result(), retaggedAssistant);
});

void test("createProviderRegistryStreamFunction rejects non-stream provider outputs", () => {
  const registry = new SparkProviderRegistry();
  registry.registerProvider("fake", fakeProvider);
  registry.setActive({ providerName: "fake", modelId: "model-a" });

  assert.throws(
    () =>
      createProviderRegistryStreamFunction(registry)(
        registry.buildActiveModel() as never,
        { messages: [], tools: [] } as never,
      ),
    /non-async-iterable stream/,
  );
});

void test("SparkProviderRegistry accepts the production baidu-oneapi-provider plugin", () => {
  const registry = new SparkProviderRegistry();
  // Provider plugins follow the same contract as ExtensionAPI plugins:
  //   default function(pi: ProviderRegistrationAPI): void
  registerBaiduOneApiProvider(registry);
  assert.equal(registry.hasProvider("baidu-oneapi"), true);
  const provider = registry.getProvider("baidu-oneapi")!;
  assert.equal(provider.api, "baidu-oneapi");
  assert.equal(provider.models.length >= 6, true);
  assert.equal(
    provider.models.some((m) => m.id === "claude-opus-4.8"),
    true,
  );
  assert.equal(
    provider.models.some((m) => m.id === "claude-fable-5"),
    true,
  );
  assert.equal(
    provider.models.some((m) => m.id === "gpt-5.5"),
    true,
  );

  const model = registry.buildModel("baidu-oneapi", "claude-opus-4.6");
  assert.equal(model.provider, "baidu-oneapi");
  assert.equal(model.contextWindow, 200_000);
  const opus48Model = registry.buildModel("baidu-oneapi", "claude-opus-4.8");
  assert.equal(opus48Model.contextWindow, 300_000);
  const fableModel = registry.buildModel("baidu-oneapi", "claude-fable-5");
  assert.equal(fableModel.name, "Fable 5 (Baidu OneAPI)");
  assert.equal(fableModel.contextWindow, 300_000);
  assert.equal(fableModel.maxTokens, 32_000);
  const gptModel = registry.buildModel("baidu-oneapi", "gpt-5.5");
  assert.equal(gptModel.api, "baidu-oneapi");
  assert.equal(gptModel.baseUrl, "https://oneapi-comate.baidu-int.com/v1");
  assert.equal(gptModel.contextWindow, 258_000);
  assert.equal(gptModel.maxTokens, 32_768);

  const opusProfile = registry.buildProfile("baidu-oneapi", "claude-opus-4.8");
  assert.equal(opusProfile.id, "baidu-oneapi/claude-opus-4.8");
  assert.equal(opusProfile.identity?.api, "baidu-oneapi");
  assert.equal(opusProfile.identity?.model, "claude-opus-4.8");
  assert.equal(opusProfile.routes[0]?.transportApi, "anthropic-messages");
  assert.equal(opusProfile.routes[0]?.transportModelId, "Opus 4.8 Coding Plan");

  const gptProfile = registry.buildProfile("baidu-oneapi", "gpt-5.5");
  assert.equal(gptProfile.routes[0]?.transportApi, "openai-responses");
  assert.equal(gptProfile.routes[0]?.transportModelId, "gpt-5.5-coding-plan");
});
