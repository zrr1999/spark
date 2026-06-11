import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SPARK_CONFIG } from "../packages/spark-cli/src/host/config.ts";

interface PackageJson {
  dependencies?: Record<string, string>;
  files?: string[];
  pi?: {
    extensions?: string[];
    skills?: string[];
  };
}

async function readPackageJson(path: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path, "utf8")) as PackageJson;
}

void test("root Pi manifest exposes vendored pi-btw without enabling it in spark-cli defaults", async () => {
  const root = await readPackageJson("package.json");

  assert.equal(root.dependencies?.["pi-btw"], "file:packages/pi-btw");
  assert.ok(root.pi?.extensions?.includes("./packages/pi-btw/extensions/btw.ts"));
  assert.ok(root.pi?.skills?.includes("./packages/pi-btw/skills"));
  assert.ok(!DEFAULT_SPARK_CONFIG.extensions.includes("pi-btw/extension"));
  assert.ok(!DEFAULT_SPARK_CONFIG.extensions.includes("./packages/pi-btw/extensions/btw.ts"));
});

void test("pi-btw package keeps upstream extension, skill, and host-specific dependency boundary explicit", async () => {
  const pkg = await readPackageJson("packages/pi-btw/package.json");

  assert.deepEqual(pkg.pi?.extensions, ["./extensions/btw.ts"]);
  assert.deepEqual(pkg.pi?.skills, ["./skills"]);
  assert.ok(pkg.files?.includes("skills"));
  assert.equal(pkg.dependencies?.["@earendil-works/pi-coding-agent"], "0.74.1");
});

void test("pi-btw side sessions do not hardcode bash as an enabled tool", async () => {
  const source = await readFile("packages/pi-btw/extensions/btw.ts", "utf8");

  assert.doesNotMatch(source, /tools:\s*\[[^\]]*["']bash["']/u);
});
