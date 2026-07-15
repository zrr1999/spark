import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SPARK_CHANNEL_ALLOWED_TOOLS } from "@zendev-lab/spark-host/system-prompt";
import {
  DEFAULT_SPARK_EXTENSION_SPECS,
  SparkExtensionLoader,
  SparkHostRuntime,
  SparkProviderRegistry,
  createSparkExtensionImporter,
  loadBuiltinExtensionFactories,
  loadPlugins,
  loadSparkExtensions,
} from "../apps/spark-tui/src/host/index.ts";

void test("loadBuiltinExtensionFactories exposes the retained Spark CLI builtin extension set", () => {
  const expected = [
    "@zendev-lab/spark-ask/extension",
    "@zendev-lab/spark-cue/extension",
    "@zendev-lab/spark-files/extension",
    "@zendev-lab/spark-ai/models-extension",
    "@zendev-lab/spark-memory/extension",
    "@zendev-lab/spark-roles/extension",
    "@zendev-lab/spark-session/extension",
    "@zendev-lab/spark-web/extension",
    "@zendev-lab/spark-graft/extension",
    "@zendev-lab/pi-extension/extension",
  ];
  assert.deepEqual(
    loadBuiltinExtensionFactories().map((entry) => entry.specifier),
    expected,
  );
  assert.deepEqual([...DEFAULT_SPARK_EXTENSION_SPECS], expected);
});

void test("root Pi extension list and native builtins both expose self-extension tools", async () => {
  const rootPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    pi?: { extensions?: string[] };
  };
  assert.ok(rootPackage.pi?.extensions?.includes("./packages/spark-memory/src/extension-entry.ts"));
  assert.ok(
    rootPackage.pi?.extensions?.includes("./packages/spark-session/src/extension-entry.ts"),
  );
  assert.ok(rootPackage.pi?.extensions?.includes("./packages/spark-web/src/extension-entry.ts"));
  assert.ok([...DEFAULT_SPARK_EXTENSION_SPECS].includes("@zendev-lab/spark-memory/extension"));
  assert.ok([...DEFAULT_SPARK_EXTENSION_SPECS].includes("@zendev-lab/spark-session/extension"));
  assert.ok([...DEFAULT_SPARK_EXTENSION_SPECS].includes("@zendev-lab/spark-web/extension"));
});

void test("published Spark TUI resolves builtins through declared package exports", async () => {
  const tuiPackage = JSON.parse(
    await readFile(new URL("../apps/spark-tui/package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const loaderSource = await readFile(
    new URL("../apps/spark-tui/src/host/extension-loader.ts", import.meta.url),
    "utf8",
  );

  for (const specifier of DEFAULT_SPARK_EXTENSION_SPECS) {
    const packageName = specifier.split("/").slice(0, 2).join("/");
    assert.ok(
      tuiPackage.dependencies?.[packageName],
      `${packageName} must be a runtime dependency of the published TUI`,
    );
    assert.match(loaderSource, new RegExp(`from ["']${specifier.replaceAll("/", "\\/")}["']`, "u"));
  }
  assert.doesNotMatch(loaderSource, /packages\/[^/]+\/src\//u);
});

void test("Spark command policy is owned by pi-extension, not spark-host", async () => {
  const piPackage = JSON.parse(
    await readFile(new URL("../packages/pi-extension/package.json", import.meta.url), "utf8"),
  ) as { exports?: Record<string, string> };
  const hostPackage = JSON.parse(
    await readFile(new URL("../packages/spark-host/package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string>; exports?: Record<string, string> };

  assert.equal(piPackage.exports?.["./host-support"], "./src/host-support.ts");
  assert.equal(hostPackage.dependencies?.["@zendev-lab/pi-extension"], undefined);
  assert.equal(hostPackage.exports?.["./spark-command-registration"], undefined);
  assert.equal(hostPackage.exports?.["./spark-command-workflow-registration"], undefined);
});

void test("SparkExtensionLoader loads builtin factories through explicit imports", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-extension-loader-test", hasUI: true });
  const result = await new SparkExtensionLoader({
    api: host,
    extensions: [
      "@zendev-lab/spark-ask/extension",
      "@zendev-lab/spark-cue/extension",
      "@zendev-lab/spark-files/extension",
      "@zendev-lab/spark-ai/models-extension",
      "@zendev-lab/spark-memory/extension",
      "@zendev-lab/spark-roles/extension",
      "@zendev-lab/spark-session/extension",
      "@zendev-lab/spark-web/extension",
      "@zendev-lab/spark-graft/extension",
      "@zendev-lab/pi-extension/extension",
    ],
  }).load();

  assert.equal(
    result.outcomes.every((outcome) => outcome.ok && outcome.builtin),
    true,
  );
  const tools = host.getAllTools().map((tool) => tool.name);
  assert.ok(tools.includes("ask"));
  assert.ok(!tools.includes("ask_user"));
  assert.ok(!tools.includes("ask_flow"));
  assert.ok(tools.includes("cue_exec"));
  assert.ok(tools.includes("read"));
  assert.ok(tools.includes("models"));
  assert.ok(tools.includes("memory"));
  assert.ok(tools.includes("role"));
  assert.ok(tools.includes("session"));
  assert.ok(tools.includes("web_search"));
  assert.ok(tools.includes("fetch_content"));
  assert.ok(tools.includes("get_search_content"));
  assert.ok(!tools.includes("list_roles"));
  assert.ok(tools.includes("graft_status"));
  assert.ok(!tools.includes("graft_patch"));
  assert.ok(!tools.includes("patch"));
  assert.ok(!tools.includes("task"));
  assert.ok(tools.includes("task_read"));
  assert.ok(tools.includes("task_write"));
  assert.ok(tools.includes("assign"));
  assert.equal(
    tools.some((tool) => tool.startsWith("spark_")),
    false,
  );
  const commands = host.listCommands().map((command) => command.name);
  assert.ok(!commands.includes("spark"));
  assert.ok(!commands.includes("research"));
  assert.ok(commands.includes("workflow:research"));
  assert.ok(!commands.some((command) => command.startsWith("graft-")));
});

void test("channel host keeps only explicitly allowed tools active after extension handlers", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-extension-loader-channel",
    sessionSurface: "channel",
    allowedTools: SPARK_CHANNEL_ALLOWED_TOOLS,
  });
  const result = await new SparkExtensionLoader({ api: host }).load();
  assert.equal(
    result.outcomes.every((outcome) => outcome.ok),
    true,
  );

  await host.emit("session_start", { reason: "channel-turn" });
  assert.deepEqual(host.getActiveTools().sort(), ["ask", "context", "session", "todo"]);
});

void test("SparkExtensionLoader isolates one extension failure and continues loading later extensions", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-extension-loader-failure" });
  const result = await loadSparkExtensions({
    api: host,
    extensions: ["bad-extension", "@zendev-lab/spark-ask/extension"],
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
    host.getAllTools().some((tool) => tool.name === "ask"),
    true,
  );
});

void test("createSparkExtensionImporter resolves builtins without calling fallback importer", async () => {
  const importer = createSparkExtensionImporter(async () => {
    throw new Error("fallback should not be used for builtins");
  });
  const mod = await importer("@zendev-lab/spark-ask/extension");
  assert.equal(typeof (mod as { default?: unknown }).default, "function");
});

void test("loadPlugins default importer is wired to builtin extension imports while providers stay dynamic", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-plugin-builtin-importer" });
  const registry = new SparkProviderRegistry();
  const result = await loadPlugins({
    extensionApi: host,
    providerApi: registry,
    extensions: ["@zendev-lab/spark-ask/extension"],
    providers: [],
  });

  assert.equal(result.outcomes[0]!.ok, true);
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "ask"),
    true,
  );
});
