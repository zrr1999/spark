import assert from "node:assert/strict";
import { test } from "vitest";

import {
  SparkHostRuntime,
  SparkProviderRegistry,
  loadPlugins,
} from "../apps/spark-tui/src/host/index.ts";

test("loadPlugins invokes extension default factory with the host runtime", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-plugin-loader-test" });
  const registry = new SparkProviderRegistry();

  const fakeModule = {
    default: function fakeExtension(pi: SparkHostRuntime): void {
      pi.registerTool({
        name: "fake_tool",
        description: "fake",
        parameters: { type: "object" },
        async execute() {
          return { content: [{ type: "text", text: "ok" }] };
        },
      });
    },
  };

  const result = await loadPlugins({
    extensionApi: host,
    providerApi: registry,
    extensions: ["fake-ext"],
    providers: [],
    importer: async () => fakeModule,
  });
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]!.ok, true);
  assert.equal(
    host.getAllTools().some((t) => t.name === "fake_tool"),
    true,
  );
});

test("loadPlugins invokes provider default factory with the provider registry", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-plugin-loader-test" });
  const registry = new SparkProviderRegistry();

  const fakeModule = {
    default: function fakeProvider(api: SparkProviderRegistry): void {
      api.registerProvider("fake-provider", {
        name: "fake-provider",
        baseUrl: "https://fake.test",
        api: "openai-completions",
        streamSimple: () => undefined as unknown,
        models: [
          {
            id: "fake-model",
            name: "Fake Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4096,
            maxTokens: 1024,
          },
        ],
      });
    },
  };

  const result = await loadPlugins({
    extensionApi: host,
    providerApi: registry,
    extensions: [],
    providers: ["fake-provider-pkg"],
    importer: async () => fakeModule,
  });
  assert.equal(result.outcomes[0]!.ok, true);
  assert.equal(registry.hasProvider("fake-provider"), true);
});

test("loadPlugins isolates failures: one bad plugin does not stop the rest", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-plugin-loader-test" });
  const registry = new SparkProviderRegistry();

  const goodExtension = {
    default: function goodExt(pi: SparkHostRuntime): void {
      pi.registerTool({
        name: "good_tool",
        description: "ok",
        parameters: { type: "object" },
        async execute() {
          return { content: [{ type: "text", text: "ok" }] };
        },
      });
    },
  };
  const badExtension = {
    default: function badExt(): void {
      throw new Error("boom");
    },
  };

  const result = await loadPlugins({
    extensionApi: host,
    providerApi: registry,
    extensions: ["good-ext", "bad-ext"],
    providers: [],
    importer: async (specifier) => (specifier === "good-ext" ? goodExtension : badExtension),
  });
  assert.equal(result.outcomes.length, 2);
  assert.equal(result.outcomes[0]!.ok, true);
  assert.equal(result.outcomes[1]!.ok, false);
  assert.match(result.outcomes[1]!.error ?? "", /boom/);
  // Good plugin still registered its tool
  assert.equal(
    host.getAllTools().some((t) => t.name === "good_tool"),
    true,
  );
});

test("loadPlugins reports a clear error for modules without a default factory", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-plugin-loader-test" });
  const registry = new SparkProviderRegistry();

  const result = await loadPlugins({
    extensionApi: host,
    providerApi: registry,
    extensions: ["malformed"],
    providers: [],
    importer: async () => ({
      /* no default */
    }),
  });
  assert.equal(result.outcomes[0]!.ok, false);
  assert.match(
    result.outcomes[0]!.error ?? "",
    /must default-export a function\(api: SparkHostAPI\)/,
  );
});

test("loadPlugins waits for async default factories to settle", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-plugin-loader-test" });
  const registry = new SparkProviderRegistry();

  const asyncModule = {
    default: async function asyncFactory(pi: SparkHostRuntime): Promise<void> {
      await new Promise((r) => setTimeout(r, 5));
      pi.registerTool({
        name: "async_tool",
        description: "async",
        parameters: { type: "object" },
        async execute() {
          return { content: [{ type: "text", text: "ok" }] };
        },
      });
    },
  };

  const result = await loadPlugins({
    extensionApi: host,
    providerApi: registry,
    extensions: ["async-ext"],
    providers: [],
    importer: async () => asyncModule,
  });
  assert.equal(result.outcomes[0]!.ok, true);
  assert.equal(
    host.getAllTools().some((t) => t.name === "async_tool"),
    true,
  );
});
