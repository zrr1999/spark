import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProjectRef } from "@zendev-lab/pi-extension-api";
import {
  clearSparkPhase,
  loadCurrentProjectState,
  loadSparkMode,
  loadSparkPhase,
  nextSparkSessionPhase,
  saveSparkPhase,
  SPARK_SESSION_PHASE_CYCLE,
} from "../packages/spark-extension/src/extension/session-state.ts";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "spark-mode-state-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test("loadSparkPhase defaults to research with no persisted state", async () => {
  await withTempDir(async (dir) => {
    const state = await loadSparkPhase(dir, undefined);
    assert.deepEqual(state, { phase: "research" });
  });
});

void test("loadSparkPhase exposes current host active lens without changing persisted phase", async () => {
  await withTempDir(async (dir) => {
    await saveSparkPhase(dir, undefined, { phase: "plan" });
    const state = await loadSparkPhase(dir, { sparkActiveLens: { phase: "implement" } });

    assert.deepEqual(state, { phase: "implement" });
    assert.deepEqual(await loadSparkPhase(dir, undefined), { phase: "plan" });
  });
});

void test("saveSparkPhase persists the current session phase and optional project ref", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-research" as ProjectRef;
    await saveSparkPhase(dir, undefined, { phase: "implement", projectRef, focus: "ship" });

    assert.deepEqual(await loadSparkPhase(dir, undefined), { phase: "implement", projectRef });
    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "implement", projectRef });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), {
      version: 1,
      projectRef,
      phase: "implement",
    });
  });
});

void test("legacy executionMode and planningMode blocks are ignored by loadSparkPhase", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-legacy" as ProjectRef;
    await saveSparkPhase(dir, undefined, { phase: "implement", projectRef });
    const statePath = join(dir, ".spark", "sessions", "session-ephemeral.json");
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          version: 1,
          projectRef,
          phase: "implement",
          planningMode: { invalid: true },
          executionMode: { invalid: true },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    assert.deepEqual(await loadSparkPhase(dir, undefined), { phase: "implement", projectRef });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), {
      version: 1,
      projectRef,
      phase: "implement",
    });
    assert.match(await readFile(statePath, "utf8"), /executionMode/);
  });
});

void test("clearSparkPhase removes current project selection but preserves session phase", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-clear" as ProjectRef;
    await saveSparkPhase(dir, undefined, { phase: "plan", projectRef });
    await clearSparkPhase(dir, undefined);
    assert.deepEqual(await loadSparkPhase(dir, undefined), { phase: "plan" });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), { version: 1, phase: "plan" });
  });
});

void test("saveSparkPhase without projectRef preserves existing current project selection", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-clear-empty" as ProjectRef;
    await saveSparkPhase(dir, undefined, { phase: "research", projectRef });
    await saveSparkPhase(dir, undefined, { phase: "plan" });
    assert.deepEqual(await loadSparkPhase(dir, undefined), { phase: "plan", projectRef });
  });
});

void test("nextSparkSessionPhase walks the canonical cycle", () => {
  assert.deepEqual(SPARK_SESSION_PHASE_CYCLE, ["research", "plan", "implement"]);
  assert.equal(nextSparkSessionPhase("research"), "plan");
  assert.equal(nextSparkSessionPhase("plan"), "implement");
  assert.equal(nextSparkSessionPhase("implement"), "research");
});
