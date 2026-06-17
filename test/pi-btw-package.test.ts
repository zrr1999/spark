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

  assert.equal(root.dependencies?.["@zendev-lab/pi-btw"], "workspace:^");
  assert.ok(root.pi?.extensions?.includes("./packages/pi-btw/extensions/btw.ts"));
  assert.deepEqual(root.pi?.skills, ["./packages/pi-btw/skills"]);
  assert.ok(!DEFAULT_SPARK_CONFIG.extensions.includes("@zendev-lab/pi-btw/extension"));
  assert.ok(!DEFAULT_SPARK_CONFIG.extensions.includes("./packages/pi-btw/extensions/btw.ts"));
});

void test("pi-btw package keeps upstream extension, skill, and host-specific dependency boundary explicit", async () => {
  const pkg = await readPackageJson("packages/pi-btw/package.json");

  assert.deepEqual(pkg.pi?.extensions, ["./extensions/btw.ts"]);
  assert.deepEqual(pkg.pi?.skills, ["./skills"]);
  assert.ok(pkg.files?.includes("skills"));
  const piVersion = pkg.dependencies?.["@earendil-works/pi-coding-agent"];
  assert.match(piVersion ?? "", /^\d+\.\d+\.\d+$/u);
  assert.equal(pkg.dependencies?.["@earendil-works/pi-ai"], piVersion);
  assert.equal(pkg.dependencies?.["@earendil-works/pi-tui"], piVersion);
});

void test("pi-cue package ships prompt text without registering it as a skill", async () => {
  const pkg = await readPackageJson("packages/pi-cue/package.json");

  assert.deepEqual(pkg.pi?.extensions, ["./src/extension/index.ts"]);
  assert.equal(pkg.pi?.skills, undefined);
  assert.ok(pkg.files?.includes("skills/**/*"));
});

void test("pi-btw side sessions do not hardcode bash as an enabled tool", async () => {
  const source = await readFile("packages/pi-btw/extensions/btw.ts", "utf8");

  assert.doesNotMatch(source, /tools:\s*\[[^\]]*["']bash["']/u);
});
