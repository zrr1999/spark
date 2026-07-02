import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const boundaryScriptPath = resolve("scripts/check-pi-boundaries.mjs");
const docTerminologyScriptPath = resolve("scripts/check-doc-terminology.mjs");
const piTuiSpecifier = "@earendil-works/" + "pi-tui";

void test("boundary checker rejects pi package imports from Spark and cockpit packages", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "packages/pi-sample", {
    name: "@zendev-lab/pi-sample",
    dependencies: { "@zendev-lab/spark-cockpit-db": "workspace:*" },
    source: 'import { runSparkTask } from "@zendev-lab/spark-runtime";\n',
  });

  const result = runBoundaryCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pi-\* packages must not depend on cockpit packages/u);
  assert.match(
    result.stderr,
    /pi-\* packages may depend only on renamed Spark foundation packages/u,
  );
});

void test("boundary checker rejects Spark packages importing cockpit packages", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "packages/spark-sample", {
    name: "@zendev-lab/spark-sample",
    source: 'import { readCockpitDb } from "@zendev-lab/spark-cockpit-db";\n',
  });

  const result = runBoundaryCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Spark core\/runtime packages must not depend on cockpit or daemon adapter packages/u,
  );
});

void test("boundary checker rejects cockpit packages importing Spark CLI host internals", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "apps/spark-cockpit", {
    name: "@zendev-lab/spark-cockpit",
    source: 'import { createSparkCliHostServices } from "@zendev-lab/spark-tui-app/host";\n',
  });

  const result = runBoundaryCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cockpit packages must not import Spark CLI host internals/u);
});

void test("boundary checker rejects pi-extension imports from app host internals", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "packages/pi-extension", {
    name: "@zendev-lab/pi-extension",
    source: 'import { createSparkCliHostServices } from "@zendev-lab/spark-tui-app/host";\n',
  });

  const result = runBoundaryCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Spark shared packages must not import Spark app host internals/u);
});

void test("boundary checker rejects unqualified legacy Navia package names in active docs", async () => {
  const root = await fixtureRoot();
  await writeFile(
    join(root, "README.md"),
    "# Example\n\nUse @zendev-lab/navia-db as the product database package.\n",
  );

  const boundaryResult = runBoundaryCheck(root);
  const terminologyResult = runDocTerminologyCheck(root);

  assert.equal(boundaryResult.status, 0, boundaryResult.stderr);
  assert.notEqual(terminologyResult.status, 0);
  assert.match(terminologyResult.stderr, /legacy navia-\* package name must be marked as legacy/u);
});

void test("documentation terminology checker rejects retired Navia web names in active docs", async () => {
  const root = await fixtureRoot();
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs/tools.md"), "# Tools\n\nUse apps/navia-web for the web app.\n");

  const boundaryResult = runBoundaryCheck(root);
  const terminologyResult = runDocTerminologyCheck(root);

  assert.equal(boundaryResult.status, 0, boundaryResult.stderr);
  assert.notEqual(terminologyResult.status, 0);
  assert.match(
    terminologyResult.stderr,
    /retired Navia web package\/path name in active documentation/u,
  );
});

void test("boundary checker allows shared Spark system/database packages", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "packages/spark-db", {
    name: "@zendev-lab/spark-db",
    dependencies: { "@zendev-lab/spark-system": "workspace:*" },
    source: 'import { resolveSparkPaths } from "@zendev-lab/spark-system";\n',
  });

  const result = runBoundaryCheck(root);

  assert.equal(result.status, 0, result.stderr);
});

void test("boundary checker treats spark-daemon as the daemon/cockpit adapter", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "apps/spark-daemon", {
    name: "@zendev-lab/spark-daemon",
    dependencies: {
      "@zendev-lab/spark-host": "workspace:^",
      "@zendev-lab/spark-protocol": "workspace:*",
      "@zendev-lab/spark-runtime": "workspace:^",
    },
    source:
      'import { runtimeMessageSchema } from "@zendev-lab/spark-protocol";\n' +
      'import { loadSparkHeadlessSessionModule } from "@zendev-lab/spark-host/headless-loader";\n',
  });

  const result = runBoundaryCheck(root);

  assert.equal(result.status, 0, result.stderr);
});

void test("boundary checker rejects spark-daemon imports from spark-tui-app", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "apps/spark-daemon", {
    name: "@zendev-lab/spark-daemon",
    dependencies: {
      "@zendev-lab/spark-tui-app": "workspace:^",
    },
    source:
      'import { createSparkHeadlessSessionExecutor } from "@zendev-lab/spark-tui-app/headless-role-executor";\n',
  });

  const result = runBoundaryCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /spark-daemon must use @zendev-lab\/spark-host\/headless-loader instead of @zendev-lab\/spark-tui-app/u,
  );
});

void test("boundary checker keeps direct pi-tui usage behind spark-tui", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "packages/spark-tui", {
    name: "@zendev-lab/spark-tui",
    dependencies: { [piTuiSpecifier]: "^0.80.3" },
    source: `export { visibleWidth } from "${piTuiSpecifier}";\n`,
  });
  await writePackage(root, "packages/pi-sample", {
    name: "@zendev-lab/pi-sample",
    dependencies: { [piTuiSpecifier]: "^0.80.3" },
    source: `import { visibleWidth } from "${piTuiSpecifier}";\n`,
  });

  const result = runBoundaryCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /direct pi-tui dependency must stay behind @zendev-lab\/spark-tui/u);
  assert.match(result.stderr, /direct pi-tui imports must go through @zendev-lab\/spark-tui/u);
});

void test("boundary checker rejects direct pi-tui imports from the removed Spark app adapter path", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "apps/spark", {
    name: "@zendev-lab/spark-cli",
    source: undefined,
  });
  await mkdir(join(root, "apps/spark/src/tui"), { recursive: true });
  await writeFile(
    join(root, "apps/spark/src/tui/pi-tui-adapter.ts"),
    `export { visibleWidth } from "${piTuiSpecifier}";\n`,
  );

  const result = runBoundaryCheck(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /direct pi-tui imports must go through @zendev-lab\/spark-tui/u);
});

void test("boundary checker allows pi packages to use the spark-tui boundary", async () => {
  const root = await fixtureRoot();
  await writePackage(root, "packages/spark-tui", {
    name: "@zendev-lab/spark-tui",
    dependencies: { [piTuiSpecifier]: "^0.80.3" },
    source: `export { visibleWidth } from "${piTuiSpecifier}";\n`,
  });
  await writePackage(root, "packages/pi-sample", {
    name: "@zendev-lab/pi-sample",
    dependencies: { "@zendev-lab/spark-tui": "workspace:^" },
    source: 'import { visibleWidth } from "@zendev-lab/spark-tui/text";\n',
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
  return spawnSync(process.execPath, [boundaryScriptPath], {
    cwd: resolve("."),
    env: { ...process.env, SPARK_BOUNDARY_ROOT: root },
    encoding: "utf8",
  });
}

function runDocTerminologyCheck(root: string) {
  return spawnSync(process.execPath, [docTerminologyScriptPath], {
    cwd: resolve("."),
    env: { ...process.env, SPARK_DOC_TERMINOLOGY_ROOT: root },
    encoding: "utf8",
  });
}
