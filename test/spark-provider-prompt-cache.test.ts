import assert from "node:assert/strict";
import test from "node:test";

import {
  SparkProviderRegistry,
  SPARK_PROVIDER_TRANSPORT_MAX_RETRIES,
  createProviderRegistryStreamFunction,
  openAiCompatiblePromptCachePayload,
  registerBaiduOneApiProvider,
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

void test("provider registry stream path forwards prompt_cache_key to OpenAI-compatible options", async () => {
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
  assert.equal(capturedOptions.sessionId, undefined);
  assert.deepEqual(await capturedOptions.onPayload({ model: "model-a" }, {}), {
    model: "model-a",
    prompt_cache_key: "spark:cache:key",
  });
  assert.deepEqual(openAiCompatiblePromptCachePayload(capturedOptions), {
    prompt_cache_key: "spark:cache:key",
  });
});

void test("provider transport retries have no attempt cap inside an abortable turn", () => {
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
    { signal: new AbortController().signal } as never,
  );

  assert.equal(capturedOptions.maxRetries, SPARK_PROVIDER_TRANSPORT_MAX_RETRIES);
});

void test("provider transport preserves an explicit retry policy", () => {
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
    { signal: new AbortController().signal, maxRetries: 2 } as never,
  );

  assert.equal(capturedOptions.maxRetries, 2);
});

void test("provider registry bridge composes an existing OpenAI Responses payload hook", async () => {
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
    {
      prompt_cache_key: "spark:cache:key",
      onPayload: (payload: unknown) => ({ ...(payload as object), caller_marker: true }),
    } as never,
  );

  assert.deepEqual(await capturedOptions.onPayload({ model: "model-a" }, {}), {
    model: "model-a",
    prompt_cache_key: "spark:cache:key",
    caller_marker: true,
  });
});

void test("provider registry bridge preserves an explicit OpenAI Responses sessionId", () => {
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
    { prompt_cache_key: "spark:cache:key", sessionId: "existing-session" } as never,
  );

  assert.equal(capturedOptions.sessionId, "existing-session");
  assert.equal(capturedOptions.onPayload, undefined);
});

void test("provider registry payload bridge honors disabled cache retention", () => {
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
    { prompt_cache_key: "spark:cache:key", cacheRetention: "none" } as never,
  );

  assert.equal(capturedOptions.cacheRetention, "none");
  assert.equal(capturedOptions.onPayload, undefined);
});

void test("provider registry payload bridge preserves the OpenAI cache-key length limit", async () => {
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
    { prompt_cache_key: "x".repeat(80) } as never,
  );

  const payload = (await capturedOptions.onPayload({}, {})) as Record<string, unknown>;
  assert.equal(payload.prompt_cache_key, "x".repeat(64));
});

void test("provider registry payload bridge leaves other transports untouched", () => {
  const registry = new SparkProviderRegistry();
  let capturedOptions: any;
  registry.registerProvider("fake", {
    ...fakeProvider,
    api: "anthropic-messages",
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

  assert.equal(capturedOptions.sessionId, undefined);
  assert.equal(capturedOptions.onPayload, undefined);
});

void test("Spark prompt cache key reaches the real pi-ai OpenAI Responses payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedPayload: Record<string, unknown> | undefined;
  let capturedRequestId: string | null | undefined;
  let fetchCalls = 0;
  globalThis.fetch = (async (input, init) => {
    fetchCalls += 1;
    const request = new Request(input, init);
    capturedRequestId = request.headers.get("x-client-request-id");
    capturedPayload = JSON.parse(await request.text()) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        error: { message: "intentional wire-test response", type: "invalid_request_error" },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const registry = new SparkProviderRegistry();
    registerBaiduOneApiProvider(registry);
    registry.setActive({ providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" });

    const stream = createProviderRegistryStreamFunction(registry, {
      resolveApiKey: () => "wire-test-key",
    })(
      registry.buildActiveModel() as never,
      { messages: [], tools: [] } as never,
      { prompt_cache_key: "spark:wire:cache:key" } as never,
    );
    await stream.result();

    assert.equal(fetchCalls, 1);
    assert.equal(capturedPayload?.prompt_cache_key, "spark:wire:cache:key");
    assert.equal(capturedRequestId, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
