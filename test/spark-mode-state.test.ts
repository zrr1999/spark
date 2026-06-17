import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProjectRef } from "@zendev-lab/pi-extension-api";
import {
  clearSparkMode,
  loadCurrentProjectState,
  loadSparkMode,
  nextSparkSessionMode,
  saveSparkMode,
  SPARK_SESSION_MODE_CYCLE,
} from "../packages/spark/src/extension/session-state.ts";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "spark-mode-state-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test("loadSparkMode defaults to research with no persisted state", async () => {
  await withTempDir(async (dir) => {
    const state = await loadSparkMode(dir, undefined);
    assert.deepEqual(state, { mode: "research" });
  });
});

void test("saveSparkMode persists only current project ref", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-research" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "implement", projectRef, focus: "ship" });

    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "research", projectRef });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), { version: 1, projectRef });
  });
});

void test("legacy executionMode and planningMode blocks are ignored by loadSparkMode", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-legacy" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "implement", projectRef });
    const statePath = join(dir, ".spark", "sessions", "session-ephemeral.json");
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          version: 1,
          projectRef,
          planningMode: { invalid: true },
          executionMode: { invalid: true },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "research", projectRef });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), { version: 1, projectRef });
    assert.match(await readFile(statePath, "utf8"), /executionMode/);
  });
});

void test("clearSparkMode removes current project selection", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-clear" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "plan", projectRef });
    await clearSparkMode(dir, undefined);
    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "research" });
    assert.equal(await loadCurrentProjectState(dir, undefined), undefined);
  });
});

void test("saveSparkMode without projectRef clears current project selection", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-clear-empty" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "research", projectRef });
    await saveSparkMode(dir, undefined, { mode: "plan" });
    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "research" });
  });
});

void test("nextSparkSessionMode walks the canonical cycle", () => {
  assert.deepEqual(SPARK_SESSION_MODE_CYCLE, ["research", "plan", "implement"]);
  assert.equal(nextSparkSessionMode("research"), "plan");
  assert.equal(nextSparkSessionMode("plan"), "implement");
  assert.equal(nextSparkSessionMode("implement"), "research");
});
