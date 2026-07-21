import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  CURRENT_SPARK_EXTENSION_PROFILE_VERSION,
  DEFAULT_SPARK_EXTENSION_SPECS,
  DEFAULT_SPARK_CONFIG,
  loadSparkConfig,
  mergeSparkConfigWithDefault,
  saveSparkConfig,
} from "../apps/spark-tui/src/host/index.ts";

test("default Spark providers include shared Baidu OneAPI and OpenAI Codex adapters", () => {
  assert.deepEqual(DEFAULT_SPARK_CONFIG.providers, [
    "@zendev-lab/spark-ai/baidu-oneapi-provider",
    "@zendev-lab/spark-ai/openai-codex-provider",
  ]);
  assert.equal(
    DEFAULT_SPARK_CONFIG.providers.includes("@zendev-lab/spark-ai/cursor-provider"),
    false,
  );
  assert.equal(
    DEFAULT_SPARK_CONFIG.extensions.includes("@zendev-lab/spark-graft/extension"),
    false,
  );
  assert.deepEqual(DEFAULT_SPARK_CONFIG.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS]);
  assert.equal(
    DEFAULT_SPARK_CONFIG.extensionProfileVersion,
    CURRENT_SPARK_EXTENSION_PROFILE_VERSION,
  );
});

test("Compact V2 config defaults to 40% reduction and current session model", () => {
  const compact = DEFAULT_SPARK_CONFIG.compact;
  assert.ok(compact);
  assert.equal(compact.targetReduction, 0.4);
  assert.equal(compact.compactModel, "current");

  const merged = mergeSparkConfigWithDefault({
    compact: {
      targetReduction: 0.25,
      compactModel: " openai/gpt-5-mini ",
      microThreshold: 3,
      fullThreshold: 0.2,
    },
  });
  assert.equal(merged.compact?.targetReduction, 0.25);
  assert.equal(merged.compact?.compactModel, "openai/gpt-5-mini");
  assert.equal(merged.compact?.microThreshold, DEFAULT_SPARK_CONFIG.compact?.microThreshold);
  assert.equal(merged.compact?.fullThreshold, DEFAULT_SPARK_CONFIG.compact?.fullThreshold);

  const oneSided = mergeSparkConfigWithDefault({ compact: { microThreshold: 0.8 } });
  assert.equal(oneSided.compact?.microThreshold, 0.8);
  assert.equal(oneSided.compact?.fullThreshold, DEFAULT_SPARK_CONFIG.compact?.fullThreshold);
});

test("legacy bundled extension profiles migrate to current defaults without Graft", () => {
  const historical = [
    "@zendev-lab/spark-ask/extension",
    "@zendev-lab/spark-cue/extension",
    "@zendev-lab/spark-files/extension",
    "@zendev-lab/spark-ai/models-extension",
    "@zendev-lab/spark-roles/extension",
    "@zendev-lab/spark-graft/extension",
    "@zendev-lab/spark-extension/extension",
    "my-extension",
  ];

  const migrated = mergeSparkConfigWithDefault({ extensions: historical });

  assert.deepEqual(migrated.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS, "my-extension"]);
  assert.equal(migrated.extensions.includes("@zendev-lab/spark-graft/extension"), false);
  assert.equal(migrated.extensionProfileVersion, CURRENT_SPARK_EXTENSION_PROFILE_VERSION);
});

test("legacy singleton facade recovers the canonical default extension profile", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensions: ["@zendev-lab/spark-extension/extension"],
  });

  assert.deepEqual(migrated.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS]);
});

test("legacy facade plus custom extensions restores defaults and preserves custom entries", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensions: ["@zendev-lab/spark-extension/extension", "my-extension"],
  });

  assert.deepEqual(migrated.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS, "my-extension"]);
});

test("standalone Graft remains an explicit opt-in across profile migration", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensions: ["@zendev-lab/spark-graft/extension"],
  });

  assert.deepEqual(migrated.extensions, ["@zendev-lab/spark-graft/extension"]);
});

test("loadSparkConfig returns default config when file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-config-missing-"));
  try {
    const path = join(dir, "config.json");
    const config = await loadSparkConfig(path);
    assert.deepEqual(config.extensions, DEFAULT_SPARK_CONFIG.extensions);
    assert.deepEqual(config.providers, DEFAULT_SPARK_CONFIG.providers);
    assert.equal(config.activeModelId, undefined);
    assert.equal(config.activeProvider, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSparkConfig ignores malformed JSON and returns defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-config-malformed-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, "{ not-json", "utf8");
    const config = await loadSparkConfig(path);
    assert.deepEqual(config.providers, DEFAULT_SPARK_CONFIG.providers);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSparkConfig + saveSparkConfig round-trip preserves user fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-config-roundtrip-"));
  try {
    const path = join(dir, "config.json");
    await saveSparkConfig(
      {
        extensions: ["@zendev-lab/pi-extension/extension", "@zendev-lab/spark-cue", "my-extension"],
        providers: ["@zendev-lab/spark-ai/baidu-oneapi-provider", "my-provider"],
        activeModelId: "baidu-oneapi/claude-opus-4.7",
        activeThinkingLevel: "medium",
        compact: {
          enabled: false,
          microThreshold: 0.7,
          fullThreshold: 0.95,
          targetReduction: 0.4,
          minUsefulReduction: 0.05,
          compactModel: " openai/gpt-5-mini ",
          reserveTokens: 12_000,
          keepRecentTokens: 8_000,
        },
      },
      path,
    );
    const config = await loadSparkConfig(path);
    assert.deepEqual(config.extensions, [
      "@zendev-lab/pi-extension/extension",
      "@zendev-lab/spark-cue",
      "my-extension",
    ]);
    assert.deepEqual(config.providers, [
      "@zendev-lab/spark-ai/baidu-oneapi-provider",
      "@zendev-lab/spark-ai/openai-codex-provider",
      "my-provider",
    ]);
    assert.equal(config.activeModelId, "baidu-oneapi/claude-opus-4.7");
    assert.equal(config.activeProvider, undefined);
    assert.equal(config.activeModel, undefined);
    assert.equal(config.activeThinkingLevel, "medium");
    assert.deepEqual(config.compact, {
      enabled: false,
      microThreshold: 0.7,
      fullThreshold: 0.95,
      targetReduction: 0.4,
      minUsefulReduction: 0.05,
      compactModel: "openai/gpt-5-mini",
      reserveTokens: 12_000,
      keepRecentTokens: 8_000,
    });
    assert.equal("fusion" in config, false);

    // Saved file is JSON with trailing newline
    const onDisk = await readFile(path, "utf8");
    assert.match(onDisk, /\}\n$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeSparkConfigWithDefault restores bundled providers to legacy provider lists", () => {
  const merged = mergeSparkConfigWithDefault({
    providers: ["@zendev-lab/spark-ai/baidu-oneapi-provider", "my-provider"],
  });

  assert.deepEqual(merged.providers, [
    "@zendev-lab/spark-ai/baidu-oneapi-provider",
    "@zendev-lab/spark-ai/openai-codex-provider",
    "my-provider",
  ]);
});

test("mergeSparkConfigWithDefault migrates legacy activeProvider/activeModel to activeModelId", () => {
  const merged = mergeSparkConfigWithDefault({
    activeProvider: "baidu-oneapi",
    activeModel: "claude-opus-4.8",
  });

  assert.equal(merged.activeModelId, "baidu-oneapi/claude-opus-4.8");
  assert.equal(merged.activeProvider, "baidu-oneapi");
  assert.equal(merged.activeModel, "claude-opus-4.8");
});

test("mergeSparkConfigWithDefault tolerates missing keys, partial inputs, and bogus arrays", () => {
  const merged = mergeSparkConfigWithDefault({
    extensions: ["@zendev-lab/spark-cue", 42, ""],
    providers: undefined,
    activeProvider: 7,
    activeModel: "claude-opus-4.6",
    activeThinkingLevel: "fast",
    fusion: {
      analysisModels: [{ provider: "fake", model: "a" }, { provider: "bad" }, null],
      judgeModel: { provider: "fake", model: "judge" },
      panelSize: 99,
    },
  });
  // 42 and "" are filtered out because the schema only accepts non-empty strings
  assert.deepEqual(merged.extensions, ["@zendev-lab/spark-cue"]);
  assert.deepEqual(merged.providers, DEFAULT_SPARK_CONFIG.providers);
  assert.equal(merged.activeModelId, "claude-opus-4.6");
  assert.equal(merged.activeProvider, undefined);
  assert.equal(merged.activeModel, "claude-opus-4.6");
  assert.equal(merged.activeThinkingLevel, undefined);
  assert.equal("fusion" in merged, false);
});
