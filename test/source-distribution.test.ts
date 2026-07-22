import assert from "node:assert/strict";
import { test } from "vitest";

import { validateSourceDistribution } from "../scripts/check-source-distribution.mjs";

function workspace(manifest: Record<string, unknown>) {
  const name = String(manifest.name);
  return {
    directory: `/workspace/${name}`,
    manifest,
    manifestPath: `/workspace/${name}/package.json`,
  };
}

const rootManifest = {
  private: true,
  scripts: { "test:source-distribution": "node scripts/smoke-source-distribution.mjs" },
};

test("source distribution accepts private workspaces without registry metadata", async () => {
  const failures = await validateSourceDistribution(
    [workspace({ name: "@zendev-lab/spark-core", private: true })],
    rootManifest,
  );
  assert.deepEqual(failures, []);
});

test("source distribution rejects accidental public packages and publish commands", async () => {
  const failures = await validateSourceDistribution(
    [
      workspace({
        name: "@zendev-lab/spark-core",
        publishConfig: { access: "public" },
      }),
    ],
    { ...rootManifest, scripts: { ...rootManifest.scripts, publish: "pnpm -r publish" } },
  );
  assert.ok(failures.some((failure) => failure.includes("must be private")));
  assert.ok(failures.some((failure) => failure.includes("must not declare publishConfig")));
  assert.ok(failures.some((failure) => failure.includes("publish script must remain absent")));
});

test("source distribution defers declared build outputs but requires them after build", async () => {
  const buildOutput = workspace({
    name: "@zendev-lab/spark-daemon",
    private: true,
    bin: "./dist/cli.js",
    scripts: { build: "node scripts/build-cli.mjs" },
  });

  assert.deepEqual(await validateSourceDistribution([buildOutput], rootManifest), []);
  const failures = await validateSourceDistribution([buildOutput], rootManifest, {
    requireBuiltBins: true,
  });
  assert.ok(failures.some((failure) => failure.includes("bin target does not exist")));
});
