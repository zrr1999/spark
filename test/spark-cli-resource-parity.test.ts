import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SparkAgentSession,
  SparkHostRuntime,
  formatSparkResourceResult,
  handleSparkRpcLine,
  runSparkResourceCommand,
} from "../apps/spark-tui/src/index.ts";
import { loadSparkConfig } from "../apps/spark-tui/src/host/config.ts";

void test("Spark resource manager installs, lists, updates, and removes local packages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-resource-parity-"));
  const configPath = join(dir, "config.json");
  const packageRoot = join(dir, "packages");
  const source = join(dir, "source-skill");
  try {
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: review-skill\ndescription: Review local packages\n---\n# v1\n",
      "utf8",
    );

    const installed = await runSparkResourceCommand("install", source, {
      configPath,
      packageRoot,
      kind: "skill",
      local: true,
    });
    assert.equal(installed.changed, true);
    const installedEntry = installed.entries.find((entry) => entry.kind === "skill");
    assert.ok(installedEntry?.installedPath);
    assert.equal(installedEntry.enabled, true);
    assert.equal(installedEntry.installed, true);
    assert.match(await readFile(join(installedEntry.installedPath, "SKILL.md"), "utf8"), /# v1/);

    const config = await loadSparkConfig(configPath);
    assert.deepEqual(config.skills, [installedEntry.specifier]);

    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: review-skill\ndescription: Review local packages\n---\n# v2\n",
      "utf8",
    );
    const updated = await runSparkResourceCommand("update", source, { configPath, packageRoot });
    assert.equal(updated.changed, true);
    assert.match(await readFile(join(installedEntry.installedPath, "SKILL.md"), "utf8"), /# v2/);

    const listed = await runSparkResourceCommand("list", undefined, { configPath, packageRoot });
    assert.equal(
      listed.entries.some(
        (entry) => entry.specifier === installedEntry.specifier && entry.installed,
      ),
      true,
    );
    assert.match(formatSparkResourceResult(listed), /packages:/);

    const removed = await runSparkResourceCommand("remove", source, {
      configPath,
      packageRoot,
      kind: "skill",
    });
    assert.equal(removed.changed, true);
    const after = JSON.parse(await readFile(configPath, "utf8")) as { skills?: string[] };
    assert.deepEqual(after.skills, []);
    await assert.rejects(stat(installedEntry.installedPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark resource manager records npm and git installs through explicit command runners", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-resource-package-runners-"));
  const configPath = join(dir, "config.json");
  const packageRoot = join(dir, "packages");
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  try {
    const commandRunner = async (command: string, args: string[], options: { cwd: string }) => {
      calls.push({ command, args, cwd: options.cwd });
      if (command === "git") {
        const destination = args.at(-1);
        assert.ok(destination);
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "index.js"), "export default () => {};\n", "utf8");
      } else if (command === "npm") {
        await writeFile(join(options.cwd, "package-lock.json"), "{}\n", "utf8");
      }
    };

    const npm = await runSparkResourceCommand("install", "npm:@scope/fake-extension@1.0.0", {
      configPath,
      packageRoot,
      kind: "extension",
      commandRunner,
    });
    assert.equal(
      npm.entries.some((entry) => entry.sourceType === "npm"),
      true,
    );

    const git = await runSparkResourceCommand("install", "https://example.com/fake-provider.git", {
      configPath,
      packageRoot,
      kind: "provider",
      commandRunner,
    });
    assert.equal(
      git.entries.some((entry) => entry.sourceType === "git"),
      true,
    );
    assert.deepEqual(
      calls.map((call) => call.command),
      ["npm", "git"],
    );

    const config = await loadSparkConfig(configPath);
    assert.equal(
      config.extensions.some((entry) => entry.includes("fake-extension")),
      true,
    );
    assert.equal(
      config.providers.some((entry) => entry.includes("fake-provider")),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark-tui app exports native SDK building blocks", () => {
  assert.equal(typeof SparkHostRuntime, "function");
  assert.equal(typeof SparkAgentSession, "function");
  assert.equal(typeof handleSparkRpcLine, "function");
});
