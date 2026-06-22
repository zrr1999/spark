import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@zendev-lab/spark-tui/text";
import type { Component } from "../apps/spark-tui/src/tui/pi-tui-adapter.ts";

import {
  SparkKeybindings,
  SparkModelSelector,
  SparkProviderRegistry,
  registerSparkModelSelectorKeybindings,
  type ProviderConfig,
  type ProviderModelDefinition,
  type SparkConfig,
} from "../apps/spark-tui/src/host/index.ts";
import {
  createSparkModelPickerFromCustomUi,
  createSparkModelSelectorComponent,
  type SparkModelSelectorCustomUi,
  type SparkModelSelectorTheme,
  type SparkModelSelectorTuiLike,
} from "../apps/spark-tui/src/tui/model-selector.ts";

const fakeStream: ProviderConfig["streamSimple"] = () => ({}) as unknown;

function model(id: string, name = id): ProviderModelDefinition {
  return {
    id,
    name,
    reasoning: id.endsWith("b"),
    input: ["text"],
    cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}

function provider(name: string, models: ProviderModelDefinition[]): ProviderConfig {
  return {
    name,
    baseUrl: `https://${name}.test`,
    apiKey: `${name.toUpperCase()}_KEY`,
    api: "anthropic-messages",
    streamSimple: fakeStream,
    models,
  };
}

function configSeed(): SparkConfig {
  return { extensions: ["@zendev-lab/spark-extension/extension"], providers: ["fake-provider"] };
}

function cloneConfig(config: SparkConfig): SparkConfig {
  return JSON.parse(JSON.stringify(config)) as SparkConfig;
}

function registryWithModels(): SparkProviderRegistry {
  const registry = new SparkProviderRegistry();
  registry.registerProvider(
    "fake",
    provider("fake", [model("model-a"), model("model-b"), model("model-c")]),
  );
  registry.registerProvider("other", provider("other", [model("model-z")]));
  return registry;
}

void test("SparkModelSelector cycles next/prev within the active provider with wraparound", async () => {
  const registry = registryWithModels();
  registry.setActive({ providerName: "fake", modelId: "model-a" });
  const saved: SparkConfig[] = [];
  const selector = new SparkModelSelector({
    registry,
    config: configSeed(),
    saveConfig: (config) => void saved.push(cloneConfig(config)),
  });

  assert.deepEqual(await selector.cycle("next"), { providerName: "fake", modelId: "model-b" });
  assert.deepEqual(await selector.cycle("next"), { providerName: "fake", modelId: "model-c" });
  assert.deepEqual(await selector.cycle("next"), { providerName: "fake", modelId: "model-a" });
  assert.deepEqual(await selector.cycle("prev"), { providerName: "fake", modelId: "model-c" });

  assert.deepEqual(registry.getActive(), { providerName: "fake", modelId: "model-c" });
  assert.deepEqual(
    saved.map((entry) => `${entry.activeProvider}/${entry.activeModel}`),
    ["fake/model-b", "fake/model-c", "fake/model-a", "fake/model-c"],
  );
});

void test("SparkModelSelector select validates through registry and persists SparkConfig", async () => {
  const registry = registryWithModels();
  const config = configSeed();
  const saved: SparkConfig[] = [];
  const selector = new SparkModelSelector({
    registry,
    config,
    saveConfig: (nextConfig) => void saved.push(cloneConfig(nextConfig)),
  });

  await assert.rejects(
    () => selector.select({ providerName: "missing", modelId: "model-a" }),
    /Unknown provider: missing/,
  );

  const selection = await selector.select({ providerName: "other", modelId: "model-z" });
  assert.deepEqual(selection, { providerName: "other", modelId: "model-z" });
  assert.deepEqual(registry.getActive(), selection);
  assert.equal(config.activeProvider, "other");
  assert.equal(config.activeModel, "model-z");
  assert.deepEqual(saved, [
    {
      extensions: ["@zendev-lab/spark-extension/extension"],
      providers: ["fake-provider"],
      activeProvider: "other",
      activeModel: "model-z",
    },
  ]);
});

void test("SparkModelSelector includes model pricing in picker state", () => {
  const registry = registryWithModels();
  const selector = new SparkModelSelector({ registry, config: configSeed() });

  const item = selector.getPickerState().items.find((entry) => entry.modelId === "model-a");

  assert.equal(item?.modelLabel.startsWith("[$0.5/$3/M] "), true);
  assert.equal(item?.description.includes("$0.5 in / $3 out / $0.05 read / $0 write per 1M"), true);
});

void test("SparkModelSelector openPicker passes active state and persists the chosen model", async () => {
  const registry = registryWithModels();
  registry.setActive({ providerName: "fake", modelId: "model-a" });
  const saved: SparkConfig[] = [];
  let sawActive = false;
  const selector = new SparkModelSelector({
    registry,
    config: configSeed(),
    saveConfig: (config) => void saved.push(cloneConfig(config)),
    picker: (state) => {
      sawActive =
        state.active?.providerName === "fake" &&
        state.active.modelId === "model-a" &&
        state.providers.some(
          (provider) =>
            provider.providerName === "fake" &&
            provider.active &&
            provider.models.map((item) => item.modelId).join(",") === "model-a,model-b,model-c",
        ) &&
        state.items.some((item) => item.modelId === "model-a" && item.active);
      return { providerName: "fake", modelId: "model-b" };
    },
  });

  const selection = await selector.openPicker({ hasUI: true });
  assert.equal(sawActive, true);
  assert.deepEqual(selection, { providerName: "fake", modelId: "model-b" });
  assert.deepEqual(
    saved.map((entry) => entry.activeModel),
    ["model-b"],
  );
});

void test("registerSparkModelSelectorKeybindings wires picker and cycle actions", async () => {
  const registry = registryWithModels();
  registry.setActive({ providerName: "fake", modelId: "model-a" });
  const saved: SparkConfig[] = [];
  const selector = new SparkModelSelector({
    registry,
    config: configSeed(),
    saveConfig: (config) => void saved.push(cloneConfig(config)),
    picker: () => ({ providerName: "fake", modelId: "model-c" }),
  });
  const keybindings = new SparkKeybindings();
  registerSparkModelSelectorKeybindings(keybindings, selector);

  assert.equal(keybindings.keyFor("app.modelPicker"), "ctrl+l");
  assert.equal(keybindings.keyFor("app.modelCycle.next"), "ctrl+p");
  assert.equal(keybindings.keyFor("app.modelCycle.prev"), "shift+ctrl+p");

  assert.equal(await keybindings.executeKey("ctrl+l", {}), true);
  assert.deepEqual(registry.getActive(), { providerName: "fake", modelId: "model-c" });

  assert.equal(await keybindings.executeKey("ctrl+p", {}), true);
  assert.deepEqual(registry.getActive(), { providerName: "fake", modelId: "model-a" });

  assert.equal(await keybindings.executeKey("shift+ctrl+p", {}), true);
  assert.deepEqual(registry.getActive(), { providerName: "fake", modelId: "model-c" });
  assert.deepEqual(
    saved.map((entry) => entry.activeModel),
    ["model-c", "model-a", "model-c"],
  );
});

void test("Spark model selector TUI wrapper renders bounded SelectList rows", () => {
  const registry = registryWithModels();
  registry.setActive({ providerName: "fake", modelId: "model-b" });
  const selector = new SparkModelSelector({ registry, config: configSeed() });
  const component = createSparkModelSelectorComponent({
    state: selector.getPickerState(),
    onSelect: () => undefined,
  });

  const lines = component.render(48);
  assert.equal(
    lines.some((line) => line.includes("Select Model")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("$0.5/$3/M") && line.includes("model-b")),
    true,
  );
  assert.equal(
    lines.every((line) => visibleWidth(line) <= 48),
    true,
  );
});

void test("createSparkModelPickerFromCustomUi mounts a SelectList overlay picker", async () => {
  const registry = registryWithModels();
  registry.setActive({ providerName: "fake", modelId: "model-a" });
  const selector = new SparkModelSelector({ registry, config: configSeed() });
  let factoryRendered = false;
  let overlayEnabled = false;
  const customUi: SparkModelSelectorCustomUi = {
    custom<T>(
      factory: (
        tui: SparkModelSelectorTuiLike,
        theme: SparkModelSelectorTheme,
        keybindings: unknown,
        done: (value: T) => void,
      ) => Component,
      options?: unknown,
    ): T {
      overlayEnabled =
        typeof options === "object" &&
        options !== null &&
        (options as { overlay?: unknown }).overlay === true;
      const component = factory(
        { requestRender: () => undefined },
        {},
        undefined,
        (_value: T) => undefined,
      );
      factoryRendered = component.render(48).some((line: string) => line.includes("Select Model"));
      return { providerName: "fake", modelId: "model-b" } as T;
    },
  };
  const picker = createSparkModelPickerFromCustomUi(customUi);

  const selection = await picker(selector.getPickerState());
  assert.equal(factoryRendered, true);
  assert.equal(overlayEnabled, true);
  assert.deepEqual(selection, { providerName: "fake", modelId: "model-b" });
});
