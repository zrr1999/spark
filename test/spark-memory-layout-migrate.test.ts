import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  migrateSparkMemoryLayout,
  resetSparkMemoryLayoutMigrationCache,
} from "../packages/spark-memory/src/migrate-layout.ts";

test("migrateSparkMemoryLayout moves user and workspace legacy trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-memory-migrate-"));
  const previous = process.env.SPARK_HOME;
  process.env.SPARK_HOME = root;
  resetSparkMemoryLayoutMigrationCache();
  try {
    await mkdir(join(root, "learnings"), { recursive: true });
    await writeFile(join(root, "learnings", "one.json"), '{"id":"one"}\n', "utf8");
    await writeFile(
      join(root, "recall-candidates.json"),
      '{"version":1,"candidates":[]}\n',
      "utf8",
    );

    await mkdir(join(root, "workspace", ".learnings"), { recursive: true });
    await writeFile(
      join(root, "workspace", ".learnings", "legacy.json"),
      '{"id":"legacy"}\n',
      "utf8",
    );
    await mkdir(join(root, "workspace", ".spark", "reflections"), { recursive: true });
    await writeFile(
      join(root, "workspace", ".spark", "reflections", "latest-report.md"),
      "# old\n",
      "utf8",
    );
    await writeFile(
      join(root, "workspace", ".spark", "recall-candidates.json"),
      '{"version":1,"candidates":[{"id":"recall:1"}]}\n',
      "utf8",
    );

    const first = await migrateSparkMemoryLayout({ cwd: join(root, "workspace"), sparkHome: root });
    assert.ok(first.ops.some((op) => op.status === "moved" || op.status === "copied"));

    assert.equal(
      await readFile(join(root, "memory", "learnings", "one.json"), "utf8"),
      '{"id":"one"}\n',
    );
    assert.equal(
      await readFile(join(root, "memory", "recall-candidates.json"), "utf8"),
      '{"version":1,"candidates":[]}\n',
    );
    assert.equal(
      await readFile(
        join(root, "workspace", ".spark", "memory", "learnings", "legacy.json"),
        "utf8",
      ),
      '{"id":"legacy"}\n',
    );
    assert.equal(
      await readFile(join(root, "workspace", ".spark", "memory", "recall-candidates.json"), "utf8"),
      '{"version":1,"candidates":[{"id":"recall:1"}]}\n',
    );
    assert.equal(
      await readFile(
        join(root, "workspace", ".spark", "memory", "reflections", "latest-report.md"),
        "utf8",
      ),
      "# old\n",
    );

    await assert.rejects(() => readFile(join(root, "learnings", "one.json"), "utf8"), {
      code: "ENOENT",
    });
    await assert.rejects(
      () => readFile(join(root, "workspace", ".learnings", "legacy.json"), "utf8"),
      { code: "ENOENT" },
    );

    const second = await migrateSparkMemoryLayout({
      cwd: join(root, "workspace"),
      sparkHome: root,
    });
    assert.deepEqual(second.ops, []);
  } finally {
    if (previous === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previous;
    resetSparkMemoryLayoutMigrationCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("migrateSparkMemoryLayout skips conflicting target files and merges directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-memory-migrate-merge-"));
  resetSparkMemoryLayoutMigrationCache();
  try {
    await mkdir(join(root, ".learnings"), { recursive: true });
    await writeFile(join(root, ".learnings", "a.json"), "a\n", "utf8");
    await writeFile(join(root, ".learnings", "shared.json"), "old\n", "utf8");
    await mkdir(join(root, ".spark", "memory", "learnings"), { recursive: true });
    await writeFile(join(root, ".spark", "memory", "learnings", "shared.json"), "new\n", "utf8");

    const report = await migrateSparkMemoryLayout({
      cwd: root,
      skipUser: true,
      env: { HOME: root },
    });
    const learningOp = report.ops.find((op) => op.from.endsWith(".learnings"));
    assert.equal(learningOp?.status, "merged");
    assert.equal(
      await readFile(join(root, ".spark", "memory", "learnings", "a.json"), "utf8"),
      "a\n",
    );
    assert.equal(
      await readFile(join(root, ".spark", "memory", "learnings", "shared.json"), "utf8"),
      "new\n",
    );
  } finally {
    resetSparkMemoryLayoutMigrationCache();
    await rm(root, { recursive: true, force: true });
  }
});
