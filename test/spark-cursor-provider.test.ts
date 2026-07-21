import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { FALLBACK_CURSOR_MODEL_ITEMS } from "../packages/spark-ai/src/cursor-fallback-models.ts";
import {
  SparkProviderRegistry,
  buildCursorPrompt,
  convertCursorModelItems,
  createCursorStreamFunction,
  createProviderRegistryStreamFunction,
  discoverCursorModels,
  fingerprintCursorApiKey,
  getCursorModelMetadata,
  registerCursorProvider,
  saveCursorModelCache,
  type CursorCatalogFallbackIssue,
  type CursorSdkRuntime,
  type ProviderConfig,
} from "../packages/spark-ai/src/index.ts";

type CursorAgentOptions = Parameters<CursorSdkRuntime["Agent"]["create"]>[0];
type CursorSdkAgent = Awaited<ReturnType<CursorSdkRuntime["Agent"]["create"]>>;
type CursorSendMessage = Parameters<CursorSdkAgent["send"]>[0];
type CursorSendOptions = NonNullable<Parameters<CursorSdkAgent["send"]>[1]>;
type CursorRun = Awaited<ReturnType<CursorSdkAgent["send"]>>;
type CursorRunResult = Awaited<ReturnType<CursorRun["wait"]>>;
type CursorInteractionUpdate = Parameters<NonNullable<CursorSendOptions["onDelta"]>>[0]["update"];
type CursorModelListItem = Parameters<typeof convertCursorModelItems>[0][number];

const CATALOG_FIXTURE: CursorModelListItem[] = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    aliases: ["composer-2-5"],
    parameters: [
      { id: "context", values: [{ value: "272k" }, { value: "1m" }] },
      {
        id: "reasoning",
        values: [{ value: "none" }, { value: "low" }, { value: "medium" }, { value: "high" }],
      },
      {
        id: "effort",
        values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }],
      },
      { id: "fast", values: [{ value: "false" }, { value: "true" }] },
    ],
    variants: [
      {
        displayName: "Composer 2.5",
        isDefault: true,
        params: [
          { id: "context", value: "272k" },
          { id: "fast", value: "false" },
        ],
      },
    ],
  },
];

test("Cursor provider registers the exact host-neutral provider contract with fallback models", async () => {
  let registeredName: string | undefined;
  let registeredConfig: ProviderConfig | undefined;
  let fallback: CursorCatalogFallbackIssue | undefined;
  await registerCursorProvider(
    {
      registerProvider(name, config) {
        registeredName = name;
        registeredConfig = config;
      },
    },
    { apiKey: "", onCatalogFallback: (issue) => (fallback = issue) },
  );

  assert.equal(registeredName, "cursor");
  assert.equal(registeredConfig?.name, "Cursor");
  assert.equal(registeredConfig?.api, "cursor-sdk");
  assert.equal(registeredConfig?.baseUrl, "https://cursor.com");
  assert.equal(registeredConfig?.apiKey, "CURSOR_API_KEY");
  assert.equal(typeof registeredConfig?.streamSimple, "function");
  assert.ok((registeredConfig?.models.length ?? 0) > 0);
  assert.equal(fallback?.reason, "missing-api-key");
});

test("Cursor local stream runs through the provider registry with ordered pi-ai events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-cursor-stream-"));
  let createdOptions: CursorAgentOptions | undefined;
  let sentOptions: CursorSendOptions | undefined;
  const streamSimple = createCursorStreamFunction({
    cwd: () => "/tmp/spark-cursor-workspace",
    loadSdk: async () =>
      mockCursorRuntime({
        updates: [
          { type: "thinking-delta", text: "considering" },
          { type: "thinking-completed", thinkingDurationMs: 3 },
          { type: "text-delta", text: "hello" },
          {
            type: "turn-ended",
            usage: {
              inputTokens: 11,
              outputTokens: 5,
              cacheReadTokens: 2,
              cacheWriteTokens: 0,
            },
          },
        ],
        result: { id: "run-1", status: "finished", result: "hello" },
        onCreate: (value) => (createdOptions = value),
        onSend: (_message, value) => (sentOptions = value),
      }),
  });
  try {
    const registry = new SparkProviderRegistry();
    await registerCursorProvider(registry, {
      apiKey: "catalog-key",
      cachePath: join(directory, "models.json"),
      forceRefresh: true,
      loadModels: async () => CATALOG_FIXTURE,
      streamSimple,
    });
    registry.setActive({ providerName: "cursor", modelId: "composer-2.5@1m:fast" });
    const providerStream = createProviderRegistryStreamFunction(registry, {
      resolveApiKey: () => "runtime-key",
    });
    const stream = providerStream(
      registry.buildActiveModel() as never,
      {
        systemPrompt: "Be precise.",
        messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
        tools: [],
      },
      { reasoning: "high" } as never,
    );
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);
    const message = await stream.result();

    assert.deepEqual(eventTypes, [
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    assert.equal(message.content.find((part) => part.type === "text")?.text, "hello");
    assert.equal(message.usage.input, 11);
    assert.equal(message.usage.output, 5);
    assert.deepEqual(createdOptions?.local, {
      cwd: "/tmp/spark-cursor-workspace",
      settingSources: [],
      sandboxOptions: { enabled: true },
    });
    assert.equal(createdOptions?.cloud, undefined);
    assert.equal(createdOptions?.mcpServers, undefined);
    assert.equal("customTools" in (createdOptions?.local ?? {}), false);
    assert.deepEqual(sentOptions?.model, {
      id: "composer-2.5",
      params: [
        { id: "context", value: "1m" },
        { id: "fast", value: "true" },
        { id: "effort", value: "high" },
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cursor local stream maps slow/xhigh selection and scrubs runtime credentials", async () => {
  convertCursorModelItems(CATALOG_FIXTURE);
  let sentOptions: CursorSendOptions | undefined;
  const streamFunction = createCursorStreamFunction({
    loadSdk: async () =>
      mockCursorRuntime({
        onSend: (_message, options) => (sentOptions = options),
        result: {
          id: "run-error",
          status: "error",
          error: { message: "Bearer runtime-secret api_key=runtime-secret" },
        },
      }),
  });
  // Fixture default is fast=false, so the bare @272k id is the slow variant.
  const stream = streamFunction(
    cursorModel("composer-2.5@272k"),
    { messages: [{ role: "user", content: "test", timestamp: 1 }], tools: [] },
    { apiKey: "runtime-secret", reasoning: "xhigh" },
  );
  const message = await stream.result();
  assert.deepEqual(sentOptions?.model, {
    id: "composer-2.5",
    params: [
      { id: "context", value: "272k" },
      { id: "fast", value: "false" },
      { id: "effort", value: "xhigh" },
    ],
  });
  assert.equal(message.stopReason, "error");
  assert.doesNotMatch(message.errorMessage ?? "", /runtime-secret/u);
  assert.match(message.errorMessage ?? "", /\[redacted\]/u);
});

test("Cursor local stream reports missing auth without loading the SDK", async () => {
  const previous = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
  let loaded = false;
  try {
    const stream = createCursorStreamFunction({
      loadSdk: async () => {
        loaded = true;
        throw new Error("must not load");
      },
    })(cursorModel("composer-2.5@272k"), { messages: [], tools: [] }, { apiKey: "CURSOR_API_KEY" });
    const message = await stream.result();
    assert.equal(loaded, false);
    assert.equal(message.provider, "cursor");
    assert.equal(message.api, "cursor-sdk");
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage ?? "", /API key is missing/u);
  } finally {
    if (previous === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previous;
  }
});

test("Cursor local stream cancels an aborted SDK run exactly once", async () => {
  convertCursorModelItems(CATALOG_FIXTURE);
  let cancelCount = 0;
  let markSent: (() => void) | undefined;
  const sent = new Promise<void>((resolve) => (markSent = resolve));
  const waiting = new Promise<CursorRunResult>(() => undefined);
  const streamFunction = createCursorStreamFunction({
    loadSdk: async () =>
      mockCursorRuntime({
        wait: () => waiting,
        onWait: () => markSent?.(),
        onCancel: () => {
          cancelCount += 1;
        },
      }),
  });
  const controller = new AbortController();
  const stream = streamFunction(
    cursorModel("composer-2.5@272k"),
    { messages: [{ role: "user", content: "wait", timestamp: 1 }], tools: [] },
    { apiKey: "runtime-key", signal: controller.signal },
  );
  await sent;
  controller.abort();
  const message = await stream.result();
  assert.equal(cancelCount, 1);
  assert.equal(message.stopReason, "aborted");
  assert.match(message.errorMessage ?? "", /aborted/u);
});

test("Cursor prompt forwards only latest-user images and marks historical images", () => {
  const prompt = buildCursorPrompt({
    systemPrompt: "System rules",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "old" },
          { type: "image", data: "old-data", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "seen" }],
        api: "cursor-sdk",
        provider: "cursor",
        model: "composer-2.5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "new" },
          { type: "image", data: "new-data", mimeType: "image/jpeg" },
        ],
        timestamp: 3,
      },
    ],
    tools: [],
  });
  assert.match(prompt.text, /\[historical image omitted\]/u);
  assert.match(prompt.text, /\[image attached\]/u);
  assert.deepEqual(prompt.images, [{ data: "new-data", mimeType: "image/jpeg" }]);
});

test("Cursor catalog expands context and non-default fast variants without alias duplicates", () => {
  const models = convertCursorModelItems(CATALOG_FIXTURE);
  const ids = models.map((model) => model.id);
  assert.deepEqual(ids, [
    "composer-2.5@272k",
    "composer-2.5@272k:fast",
    "composer-2.5@1m",
    "composer-2.5@1m:fast",
  ]);
  assert.equal(models.length, 4);

  // Alias ids stay resolvable for selection, but are not listed as separate picker models.
  assert.equal(getCursorModelMetadata("composer-2-5@1m:fast")?.selectionModelId, "composer-2-5");
  assert.equal(getCursorModelMetadata("composer-2-5@1m:fast")?.baseModelId, "composer-2.5");
  assert.equal(
    models.some((model) => model.id.startsWith("composer-2-5")),
    false,
  );

  const short = models.find((model) => model.id === "composer-2.5@272k")!;
  const long = models.find((model) => model.id === "composer-2.5@1m:fast")!;
  assert.equal(short.contextWindow, 272_000);
  assert.equal(long.contextWindow, 1_000_000);
  assert.equal(short.maxTokens, 16_384);
  assert.deepEqual(short.input, ["text", "image"]);
  assert.deepEqual(short.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(short.thinkingLevelMap, {
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  });
  assert.deepEqual(getCursorModelMetadata("composer-2.5@1m:fast")?.defaultParams, [
    { id: "context", value: "1m" },
    { id: "fast", value: "true" },
  ]);
});

test("Cursor catalog skips the fast qualifier that matches the default variant", () => {
  const models = convertCursorModelItems([
    {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      aliases: ["composer", "composer-2-5"],
      parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
      variants: [
        {
          displayName: "Composer 2.5",
          isDefault: true,
          params: [{ id: "fast", value: "true" }],
        },
      ],
    },
  ]);
  assert.deepEqual(
    models.map((model) => model.id),
    ["composer-2.5", "composer-2.5:slow"],
  );
  // Redundant :fast stays resolvable for previously saved selections.
  assert.equal(getCursorModelMetadata("composer-2.5:fast")?.fastOverride, true);
  assert.equal(getCursorModelMetadata("composer")?.selectionModelId, "composer");
  assert.equal(getCursorModelMetadata("composer")?.baseModelId, "composer-2.5");
});

test("Cursor fallback catalog includes Grok and only one Composer family", () => {
  const models = convertCursorModelItems(FALLBACK_CURSOR_MODEL_ITEMS);
  const ids = models.map((model) => model.id);
  assert.ok(ids.includes("composer-2.5"));
  assert.ok(ids.includes("composer-2.5:slow"));
  assert.ok(ids.includes("grok-4.5"));
  assert.ok(ids.includes("grok-4.5:slow"));
  assert.equal(ids.filter((id) => id.startsWith("composer")).length, 2);
  assert.equal(
    ids.some((id) => id.startsWith("composer-2-5") || id.startsWith("composer-latest")),
    false,
  );
  assert.equal(getCursorModelMetadata("composer-2-5:slow")?.selectionModelId, "composer-2-5");
  assert.equal(getCursorModelMetadata("composer-latest")?.baseModelId, "composer-2.5");
});

test("Cursor catalog maps boolean thinking parameters", () => {
  const [model] = convertCursorModelItems([
    {
      id: "thinking-model",
      displayName: "Thinking Model",
      parameters: [{ id: "thinking", values: [{ value: "false" }, { value: "true" }] }],
    },
  ]);
  assert.deepEqual(model?.thinkingLevelMap, {
    off: "false",
    minimal: null,
    low: null,
    medium: null,
    high: "true",
    xhigh: null,
  });
});

test("Cursor discovery falls back for empty and failed live catalogs without leaking keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-cursor-discovery-"));
  try {
    const issues: CursorCatalogFallbackIssue[] = [];
    const emptyModels = await discoverCursorModels({
      apiKey: "cursor-test-secret",
      cachePath: join(directory, "empty.json"),
      forceRefresh: true,
      loadModels: async () => [],
      onFallback: (issue) => issues.push(issue),
    });
    assert.ok(emptyModels.length > 0);
    assert.equal(issues[0]?.reason, "empty-model-list");

    const failedModels = await discoverCursorModels({
      apiKey: "cursor-test-secret",
      cachePath: join(directory, "failed.json"),
      forceRefresh: true,
      loadModels: async () => {
        throw new Error("Bearer cursor-test-secret api_key=cursor-test-secret");
      },
      onFallback: (issue) => issues.push(issue),
    });
    assert.ok(failedModels.length > 0);
    assert.equal(issues[1]?.reason, "discovery-failed");
    assert.doesNotMatch(issues[1]?.message ?? "", /cursor-test-secret/u);
    assert.match(issues[1]?.message ?? "", /\[redacted\]/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cursor model cache contains a fingerprint and public metadata but never the raw key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-cursor-cache-"));
  const path = join(directory, "models.json");
  const apiKey = "cursor-cache-secret";
  try {
    await saveCursorModelCache({
      path,
      keyFingerprint: fingerprintCursorApiKey(apiKey),
      models: CATALOG_FIXTURE,
      now: new Date("2026-07-10T00:00:00.000Z"),
    });
    const serialized = await readFile(path, "utf8");
    assert.doesNotMatch(serialized, new RegExp(apiKey, "u"));
    assert.match(serialized, new RegExp(fingerprintCursorApiKey(apiKey), "u"));
    assert.match(serialized, /composer-2\.5/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function cursorModel(id: string): ReturnType<SparkProviderRegistry["buildModel"]> {
  return {
    id,
    name: "Composer 2.5",
    api: "cursor-sdk",
    provider: "cursor",
    baseUrl: "https://cursor.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: id.includes("1m") ? 1_000_000 : 272_000,
    maxTokens: 16_384,
  };
}

interface MockCursorRuntimeOptions {
  updates?: CursorInteractionUpdate[];
  result?: CursorRunResult;
  wait?: () => Promise<CursorRunResult>;
  onCreate?: (options: CursorAgentOptions) => void;
  onSend?: (message: CursorSendMessage, options?: CursorSendOptions) => void;
  onWait?: () => void;
  onCancel?: () => void;
}

function mockCursorRuntime(options: MockCursorRuntimeOptions): CursorSdkRuntime {
  return {
    Agent: {
      async create(createOptions) {
        options.onCreate?.(createOptions);
        const run = {
          id: options.result?.id ?? "run-mock",
          agentId: "agent-mock",
          supports: () => true,
          unsupportedReason: () => undefined,
          async *stream() {},
          conversation: async () => [],
          wait: async () => {
            options.onWait?.();
            return options.wait
              ? options.wait()
              : (options.result ?? { id: "run-mock", status: "finished" });
          },
          cancel: async () => options.onCancel?.(),
          status: "running",
          onDidChangeStatus: () => () => undefined,
        } as unknown as CursorRun;
        return {
          agentId: "agent-mock",
          model: createOptions.model,
          async send(message, sendOptions) {
            options.onSend?.(message, sendOptions);
            for (const update of options.updates ?? []) {
              await sendOptions?.onDelta?.({ update });
            }
            return run;
          },
          close() {},
          async reload() {},
          async [Symbol.asyncDispose]() {},
          async listArtifacts() {
            return [];
          },
          async downloadArtifact() {
            return Buffer.alloc(0);
          },
        } as CursorSdkAgent;
      },
    },
  };
}

test("Cursor provider materializes a Spark profile with CURSOR_API_KEY auth", async () => {
  const registry = new SparkProviderRegistry();
  await registerCursorProvider(registry, { apiKey: "" });
  const model = registry.listModelsFor("cursor")[0]!;
  const profile = registry.buildProfile("cursor", model.id);
  assert.equal(profile.id, `cursor/${model.id}`);
  assert.equal(profile.identity?.provider, "cursor");
  assert.equal(profile.identity?.api, "cursor-sdk");
  assert.equal(profile.routes[0]?.transportApi, "cursor-sdk");
  assert.equal(profile.routes[0]?.transportModelId, model.id);
  assert.equal(profile.routes[0]?.transportModelId, model.id);
  assert.deepEqual(profile.authPools?.[0]?.slots[0]?.authRef, {
    kind: "env",
    name: "CURSOR_API_KEY",
  });
});
