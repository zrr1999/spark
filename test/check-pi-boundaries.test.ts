import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const scriptPath = resolve("scripts/check-pi-boundaries.mjs");

void test("boundary checker rejects pi package imports from Spark and Navia", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "packages/pi-sample", {
    name: "@zendev-lab/pi-sample",
    dependencies: { "@zendev-lab/navia-protocol": "workspace:*" },
    source: 'import { runSparkTask } from "@zendev-lab/spark-runtime";\n',
  });

  const result = runBoundaryCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pi-\* packages must not depend on Navia packages/u);
  assert.match(result.stderr, /pi-\* packages must not depend on Spark packages/u);
});

void test("boundary checker rejects Spark packages importing Navia packages", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "packages/spark-sample", {
    name: "@zendev-lab/spark-sample",
    source: 'import { runtimeMessageSchema } from "@zendev-lab/navia-protocol";\n',
  });

  const result = runBoundaryCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Spark core\/runtime packages must not depend on Navia packages/u);
});

void test("boundary checker rejects Navia packages importing Spark CLI host internals", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "apps/navia-web", {
    name: "@zendev-lab/navia-web",
    source: 'import { createSparkCliHostServices } from "@zendev-lab/spark-cli/host";\n',
  });

  const result = runBoundaryCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Navia packages must not import Spark CLI host internals/u);
});

void test("boundary checker allows isolated Navia package dependencies", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "packages/navia-db", {
    name: "@zendev-lab/navia-db",
    dependencies: { "@zendev-lab/navia-system": "workspace:*" },
    source: 'import { resolveNaviaPath } from "@zendev-lab/navia-system";\n',
  });

  const result = runBoundaryCheck(root);

  assert.equal(result.status, 0, result.stderr);
});

void test("boundary checker treats spark-daemon as the daemon/cockpit adapter", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "apps/spark-daemon", {
    name: "@zendev-lab/spark-daemon",
    dependencies: {
      "@zendev-lab/navia-protocol": "workspace:*",
      "@zendev-lab/spark-cli": "workspace:^",
      "@zendev-lab/spark-runtime": "workspace:^",
    },
    source:
      'import { runtimeMessageSchema } from "@zendev-lab/navia-protocol";\n' +
      'import { createSparkHeadlessRoleExecutor, createSparkHeadlessSessionExecutor } from "@zendev-lab/spark-cli/headless-role-executor";\n',
  });

  const result = runBoundaryCheck(root);

  assert.equal(result.status, 0, result.stderr);
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "spark-boundaries-"));
  await mkdir(join(root, "packages"), { recursive: true });
  return root;
}

async function writePackage(
  root: string,
  relativePath: string,
  options: { name: string; dependencies?: Record<string, string>; source?: string },
) {
  const packageDir = join(root, relativePath);
  await mkdir(join(packageDir, "src"), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify(
      { name: options.name, type: "module", dependencies: options.dependencies },
      null,
      2,
    ),
  );
  if (options.source) await writeFile(join(packageDir, "src/index.ts"), options.source);
}

function runBoundaryCheck(root: string) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: resolve("."),
    env: { ...process.env, SPARK_BOUNDARY_ROOT: root },
    encoding: "utf8",
  });
}
