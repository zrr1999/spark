import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

const configPath = resolve(".dependency-cruiser.cjs");
const docTerminologyScriptPath = resolve("scripts/check-doc-terminology.mjs");

test("dependency-cruiser config loads and encodes required boundary rules", async () => {
  const source = await readFile(configPath, "utf8");
  for (const ruleName of [
    "no-direct-pi-ai",
    "no-direct-pi-tui",
    "no-workspace-package-src-specifier",
    "no-app-relative-packages-src-deep-link",
    "no-cross-package-relative-src-deep-link",
    "pi-no-product-adapters",
    "pi-only-foundation-spark",
    "spark-extension-no-spark-tui",
    "spark-foundation-no-spark-extension",
    "spark-fusion-foundation-only",
    "spark-repro-no-host-or-product",
    "fusion-repro-no-circular",
    "spark-extension-no-product-adapters",
    "daemon-no-tui-app",
    "cockpit-no-app-internals",
  ]) {
    assert.match(source, new RegExp(`name:\\s*"${ruleName}"`, "u"));
  }
  assert.match(source, /pi-parity-commands/u);
  assert.match(source, /Dynamic import/u);
});

test("dependency-cruiser reports clean on the workspace", () => {
  const result = spawnSync(
    "pnpm",
    ["exec", "depcruise", "--config", configPath, "apps", "packages", "test"],
    { cwd: resolve("."), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /no dependency violations found/u);
});

test("documentation terminology checker rejects retired product package names in active docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-doc-term-"));
  const retiredProduct = ["na", "via"].join("");
  await writeFile(
    join(root, "README.md"),
    `# Example\n\nUse @zendev-lab/${retiredProduct}-db as the product database package.\n`,
  );

  const terminologyResult = spawnSync(process.execPath, [docTerminologyScriptPath], {
    cwd: resolve("."),
    env: { ...process.env, SPARK_DOC_TERMINOLOGY_ROOT: root },
    encoding: "utf8",
  });

  assert.notEqual(terminologyResult.status, 0);
  assert.match(terminologyResult.stderr, /retired product terminology/u);
});

test("documentation terminology checker rejects retired product app names in active docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-doc-term-"));
  const retiredProduct = ["na", "via"].join("");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "docs/tools.md"),
    `# Tools\n\nUse apps/${retiredProduct}-web for the web app.\n`,
  );

  const terminologyResult = spawnSync(process.execPath, [docTerminologyScriptPath], {
    cwd: resolve("."),
    env: { ...process.env, SPARK_DOC_TERMINOLOGY_ROOT: root },
    encoding: "utf8",
  });

  assert.notEqual(terminologyResult.status, 0);
  assert.match(terminologyResult.stderr, /retired product terminology/u);
});
