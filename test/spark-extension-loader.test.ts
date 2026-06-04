import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SPARK_EXTENSION_SPECS,
  SparkExtensionLoader,
  SparkHostRuntime,
  SparkProviderRegistry,
  createSparkExtensionImporter,
  loadBuiltinExtensionFactories,
  loadPlugins,
  loadSparkExtensions,
} from "../packages/spark-cli/src/host/index.ts";

void test("loadBuiltinExtensionFactories exposes the retained Spark CLI builtin extension set", () => {
  assert.deepEqual(
    loadBuiltinExtensionFactories().map((entry) => entry.specifier),
    [
      "pi-ask/extension",
      "pi-cue/extension",
      "pi-roles/extension",
      "pi-graft/extension",
      "spark/extension",
    ],
  );
  assert.deepEqual(
    [...DEFAULT_SPARK_EXTENSION_SPECS],
    [
      "pi-ask/extension",
      "pi-cue/extension",
      "pi-roles/extension",
      "pi-graft/extension",
      "spark/extension",
    ],
  );
});

void test("SparkExtensionLoader loads builtin factories through explicit imports", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-extension-loader-test", hasUI: true });
  const result = await new SparkExtensionLoader({
    api: host,
    extensions: [
      "pi-ask/extension",
      "pi-cue/extension",
      "pi-roles/extension",
      "pi-graft/extension",
      "spark/extension",
    ],
  }).load();

  assert.equal(
    result.outcomes.every((outcome) => outcome.ok && outcome.builtin),
    true,
  );
  const tools = host.getAllTools().map((tool) => tool.name);
  assert.ok(tools.includes("ask_user"));
  assert.ok(tools.includes("cue_exec"));
  assert.ok(tools.includes("list_roles"));
  assert.ok(tools.includes("graft_status"));
  assert.ok(tools.includes("spark_status"));
  const commands = host.listCommands().map((command) => command.name);
  assert.ok(commands.includes("spark"));
  assert.ok(commands.includes("graft-attach"));
});

void test("SparkExtensionLoader isolates one extension failure and continues loading later extensions", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-extension-loader-failure" });
  const result = await loadSparkExtensions({
    api: host,
    extensions: ["bad-extension", "pi-ask/extension"],
    importer: async () => ({
      default: () => {
        throw new Error("boom");
      },
    }),
  });

  assert.equal(result.outcomes.length, 2);
  assert.equal(result.outcomes[0]!.ok, false);
  assert.match(result.outcomes[0]!.error ?? "", /boom/);
  assert.equal(result.outcomes[1]!.ok, true);
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "ask_user"),
    true,
  );
});

void test("createSparkExtensionImporter resolves builtins without calling fallback importer", async () => {
  const importer = createSparkExtensionImporter(async () => {
    throw new Error("fallback should not be used for builtins");
  });
  const mod = await importer("pi-ask/extension");
  assert.equal(typeof (mod as { default?: unknown }).default, "function");
});

void test("loadPlugins default importer is wired to builtin extension imports while providers stay dynamic", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-plugin-builtin-importer" });
  const registry = new SparkProviderRegistry();
  const result = await loadPlugins({
    extensionApi: host,
    providerApi: registry,
    extensions: ["pi-ask/extension"],
    providers: [],
  });

  assert.equal(result.outcomes[0]!.ok, true);
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "ask_flow"),
    true,
  );
});
