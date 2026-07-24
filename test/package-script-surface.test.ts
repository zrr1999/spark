import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "vitest";

const canonicalRootScripts = [
  "audit",
  "build",
  "check",
  "check:static",
  "check:test-quality",
  "check:test-quality:update",
  "fix",
  "prepare",
  "preview",
  "release:pack",
  "report:hygiene",
  "smoke",
  "test",
  "test:browser:cockpit",
  "test:mutation",
  "test:process:source",
  "test:unit",
  "typecheck",
];
const ignoredTestSearchDirectories = new Set([
  ".svelte-kit",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const testFilePattern = /\.(?:spec|test)\.(?:[cm]?[jt]sx?|svelte)$/u;

test("root package exposes one compact validation and release surface", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = manifest.scripts ?? {};

  assert.deepEqual(Object.keys(scripts).toSorted(), canonicalRootScripts.toSorted());
  assert.equal(scripts.smoke, "node scripts/smoke-npm-product.mjs");
  assert.equal(scripts["release:pack"], "node scripts/pack-release.mjs");
  assert.equal(scripts.test, "vp test run --config vitest.root.config.ts");
  assert.equal(scripts["check:test-quality"], "node scripts/check-test-quality.mjs");
  assert.equal(
    scripts["check:test-quality:update"],
    "node scripts/check-test-quality.mjs --update",
  );
  assert.equal(
    scripts["test:browser:cockpit"],
    "pnpm --filter @zendev-lab/spark-cockpit run test:browser",
  );
  assert.equal(
    scripts.check,
    "pnpm run check:static && pnpm run test:unit && pnpm run test:process:source",
  );
  assert.equal(scripts["test:process:source"], "vp test run --config vitest.process.config.ts");
  assert.match(
    scripts.fix ?? "",
    /^pnpm --filter @zendev-lab\/spark-cockpit exec svelte-kit sync/u,
  );
  for (const requiredCheckPhase of [
    "node scripts/check-architecture-ratchets.mjs",
    "node scripts/check-npm-product.mjs",
    "depcruise --config .dependency-cruiser.cjs apps packages test",
    "pnpm run check:test-quality",
    "node scripts/check-doc-terminology.mjs",
    "vp fmt . --check",
    "vp lint --quiet",
    "pnpm run typecheck",
  ]) {
    assert.ok(
      scripts["check:static"]?.includes(requiredCheckPhase),
      `check:static must run ${requiredCheckPhase}`,
    );
  }
  for (const requiredUnitPhase of [
    "pnpm --filter @zendev-lab/spark-cockpit exec svelte-kit sync",
    "vp test run --config vitest.root.config.ts",
    "pnpm -r --filter './packages/*' --if-present run check",
    "pnpm --filter @zendev-lab/spark-cockpit run test",
    "pnpm --filter @zendev-lab/spark-daemon run test",
  ]) {
    assert.ok(
      scripts["test:unit"]?.includes(requiredUnitPhase),
      `test:unit must run ${requiredUnitPhase}`,
    );
  }
  assert.match(
    scripts["test:unit"] ?? "",
    /^pnpm --filter @zendev-lab\/spark-cockpit exec svelte-kit sync/u,
  );
  for (const requiredFixPhase of [
    "vp fmt . --write",
    "vp lint --fix --quiet",
    "pnpm run typecheck",
  ]) {
    assert.ok(scripts.fix?.includes(requiredFixPhase), `fix must run ${requiredFixPhase}`);
  }
  assert.match(scripts.typecheck ?? "", /^pnpm --filter @zendev-lab\/spark-cockpit run check/u);
  assert.match(scripts.typecheck ?? "", /vp check --no-fmt --no-lint/u);
  assert.match(scripts.typecheck ?? "", /@zendev-lab\/spark-daemon run check$/u);
  assert.doesNotMatch(
    Object.keys(scripts).join("\n"),
    /(?:test:file|(?:build|check|test|publish):npm-product|check:(?:architecture|boundaries|distribution))/u,
  );
});

test("workspace scripts contain package-local behavior instead of root boilerplate", async () => {
  for (const workspaceRoot of ["apps", "packages"]) {
    const entries = await readdir(resolve(workspaceRoot), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = resolve(workspaceRoot, entry.name, "package.json");
      let source: string;
      try {
        source = await readFile(manifestPath, "utf8");
      } catch {
        continue;
      }
      const manifest = JSON.parse(source) as {
        scripts?: Record<string, string>;
      };
      const workspace = `${workspaceRoot}/${entry.name}`;
      if (workspace !== "apps/spark-daemon") {
        assert.notEqual(
          manifest.scripts?.check,
          "vp check --no-fmt --no-lint .",
          `${workspace} should rely on the root typecheck`,
        );
      }
      assert.notEqual(
        manifest.scripts?.["test:mutation"],
        "stryker run",
        `${workspace} should rely on the root mutation runner`,
      );
      if (workspaceRoot === "packages" && (await hasTestFiles(resolve(workspace)))) {
        assert.ok(manifest.scripts?.test, `${workspace} must expose its tests`);
        assert.match(
          manifest.scripts.check ?? "",
          /vp test run/u,
          `${workspace} check must retain its package-local tests`,
        );
      }
      if (workspace === "packages/spark-i18n") {
        assert.match(manifest.scripts?.check ?? "", /pnpm run generate/u);
      }
      if (workspace === "packages/spark-cockpit-db") {
        assert.match(manifest.scripts?.check ?? "", /check-schema-types\.mjs/u);
      }
    }
  }
});

test("CI and prek consume the canonical package scripts", async () => {
  const [verifyWorkflow, hygieneWorkflow, prek] = await Promise.all([
    readFile(resolve(".github/workflows/ci-verify.yml"), "utf8"),
    readFile(resolve(".github/workflows/ce-hygiene.yml"), "utf8"),
    readFile(resolve("prek.toml"), "utf8"),
  ]);

  assert.match(verifyWorkflow, /pnpm run check:static/u);
  assert.match(verifyWorkflow, /pnpm run test:unit/u);
  assert.match(verifyWorkflow, /pnpm run test:process:source/u);
  assert.match(verifyWorkflow, /pnpm run smoke/u);
  assert.match(verifyWorkflow, /pnpm run test:browser:cockpit/u);
  assert.match(verifyWorkflow, /name: verify/u);
  assert.doesNotMatch(verifyWorkflow, /test:npm-product/u);
  assert.match(hygieneWorkflow, /pnpm run report:hygiene/u);
  assert.doesNotMatch(hygieneWorkflow, /pnpm exec (?:knip|jscpd)/u);
  assert.match(prek, /id = "spark-check-fix"/u);
  assert.match(prek, /entry = "pnpm run fix"/u);
  assert.doesNotMatch(prek, /pnpm run check:/u);
});

async function hasTestFiles(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && testFilePattern.test(entry.name)) return true;
    if (
      entry.isDirectory() &&
      !ignoredTestSearchDirectories.has(entry.name) &&
      (await hasTestFiles(resolve(directory, entry.name)))
    ) {
      return true;
    }
  }
  return false;
}
