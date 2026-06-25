import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSparkPiParitySlashCommands } from "../apps/spark-tui/src/cli/pi-parity-commands.ts";
import {
  BUILTIN_SPARK_THEMES,
  loadSparkThemeCatalog,
  saveSparkConfig,
  type SparkCliHostServices,
  type SparkConfig,
  type SparkTheme,
} from "../apps/spark-tui/src/host/index.ts";
import { SparkNativeSession } from "../apps/spark-tui/src/native-tui.ts";
import { createSparkNativeTuiHarness } from "./support/spark-native-tui-harness.ts";

const ESC = String.fromCharCode(27);

const testTheme: SparkTheme = {
  id: "test",
  label: "Test Theme",
  mode: "dark",
  colors: {
    foreground: "#111111",
    muted: "#222222",
    border: "#333333",
    accent: "#010203",
    success: "#040506",
    warning: "#070809",
    error: "#0a0b0c",
    user: "#0d0e0f",
    assistant: "#101112",
    system: "#131415",
    tool: "#161718",
    thinking: "#191a1b",
    custom: "#1c1d1e",
    markdownHeading: "#1f2021",
    markdownCode: "#222324",
    markdownQuote: "#252627",
    diffAdd: "#010203",
    diffRemove: "#040506",
    diffHunk: "#070809",
  },
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spark-theme-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test("loadSparkThemeCatalog loads builtin and user themes with active fallback", async () => {
  await withTempDir(async (dir) => {
    const sparkHome = join(dir, ".spark");
    await mkdir(join(sparkHome, "themes"), { recursive: true });
    await writeFile(
      join(sparkHome, "themes", "solar.json"),
      JSON.stringify({
        id: "solar",
        label: "Solar Test",
        extends: "light",
        colors: { accent: "#123456", diffAdd: "#abcdef" },
      }),
      "utf8",
    );

    const catalog = await loadSparkThemeCatalog({ cwd: dir, sparkHome, activeThemeId: "solar" });
    assert.equal(catalog.active.id, "solar");
    assert.equal(catalog.active.colors.accent, "#123456");
    assert.equal(catalog.active.colors.diffAdd, "#abcdef");
    assert.equal(
      catalog.themes.some((theme) => theme.id === "dark"),
      true,
    );
    assert.equal(
      catalog.themes.some((theme) => theme.id === "light"),
      true,
    );
    assert.equal(
      catalog.themes.some((theme) => theme.id === "solar"),
      true,
    );

    const fallback = await loadSparkThemeCatalog({ cwd: dir, sparkHome, activeThemeId: "missing" });
    assert.equal(fallback.active.id, "dark");
    assert.match(fallback.diagnostics.map((item) => item.message).join("\n"), /Unknown active/);
  });
});

void test("Spark native renderer applies theme colors to markdown and diff/tool output", () => {
  const harness = createSparkNativeTuiHarness({ cols: 100, theme: testTheme });
  harness.session.appendAssistantChunk("# Heading\n\nHere is `code`.");
  harness.session.finishAssistantMessage();
  harness.session.addToolMessage({
    toolName: "edit",
    status: "success",
    text: "@@ file.ts @@\n+added line\n-removed line",
  });
  harness.app.toggleTools();

  const rendered = harness.render();
  assert.match(rendered, /spark> .*Heading/);
  assert.match(rendered, /Here is .*code/);
  assert.match(rendered, /tool:edit \[success\]>/);
  assert.equal(rendered.includes(`${ESC}[38;2;1;2;3m+added line${ESC}[0m`), true);
  assert.equal(rendered.includes(`${ESC}[38;2;4;5;6m-removed line${ESC}[0m`), true);
  assert.equal(rendered.includes(`${ESC}[38;2;7;8;9m@@ file.ts @@${ESC}[0m`), true);
});

void test("/settings set theme persists activeTheme through Spark config", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json");
    const config: SparkConfig = {
      extensions: [],
      providers: [],
      activeTheme: "dark",
    };
    const services = {
      cwd: dir,
      config,
      saveConfig: (nextConfig: SparkConfig) => saveSparkConfig(nextConfig, path),
      theme: BUILTIN_SPARK_THEMES[0],
      themeCatalog: {
        themes: [...BUILTIN_SPARK_THEMES],
        active: BUILTIN_SPARK_THEMES[0]!,
        diagnostics: [],
      },
      modelSelector: { getActive: () => undefined },
      providerRegistry: { listProviders: () => [] },
      keybindings: { snapshot: () => ({ bindings: [] }) },
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    const result = await commands.settings!.handler("set theme light", {
      app: {} as never,
      session: new SparkNativeSession(async () => "unused"),
      exit: () => undefined,
    });

    assert.match(String(result), /Spark theme set: light/);
    const saved = JSON.parse(await readFile(path, "utf8")) as SparkConfig;
    assert.equal(saved.activeTheme, "light");
  });
});
