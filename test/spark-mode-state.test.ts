import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import type { ProjectRef } from "@zendev-lab/spark-core";
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

test("loadSparkPhase defaults to plan with no persisted state", async () => {
  await withTempDir(async (dir) => {
    const state = await loadSparkPhase(dir, undefined);
    assert.deepEqual(state, { phase: "plan" });
  });
});

test("loadSparkPhase exposes current host active lens without changing persisted phase", async () => {
  await withTempDir(async (dir) => {
    await saveSparkPhase(dir, undefined, { phase: "plan" });
    const state = await loadSparkPhase(dir, { sparkActiveLens: { phase: "implement" } });

    assert.deepEqual(state, { phase: "implement" });
    assert.deepEqual(await loadSparkPhase(dir, undefined), { phase: "plan" });
  });
});

test("loadSparkPhase normalizes a legacy research active lens to plan", async () => {
  await withTempDir(async (dir) => {
    await saveSparkPhase(dir, undefined, { phase: "implement" });
    const legacyContext = { sparkActiveLens: { phase: "research" } } as unknown as NonNullable<
      Parameters<typeof loadSparkPhase>[1]
    >;

    assert.deepEqual(await loadSparkPhase(dir, legacyContext), { phase: "plan" });
    assert.deepEqual(await loadSparkPhase(dir, undefined), { phase: "implement" });
  });
});

test("saveSparkPhase persists the current session phase and optional project ref", async () => {
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

test("legacy executionMode and planningMode blocks are ignored by loadSparkPhase", async () => {
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

test("clearSparkPhase removes current project selection but preserves session phase", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-clear" as ProjectRef;
    await saveSparkPhase(dir, undefined, { phase: "plan", projectRef });
    await clearSparkPhase(dir, undefined);
    assert.deepEqual(await loadSparkPhase(dir, undefined), { phase: "plan" });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), { version: 1, phase: "plan" });
  });
});

test("saveSparkPhase without projectRef preserves existing current project selection", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-clear-empty" as ProjectRef;
    await saveSparkPhase(dir, undefined, { phase: "implement", projectRef });
    await saveSparkPhase(dir, undefined, { phase: "plan" });
    assert.deepEqual(await loadSparkPhase(dir, undefined), { phase: "plan", projectRef });
  });
});

test("legacy persisted research phase normalizes one-way to plan", async () => {
  await withTempDir(async (dir) => {
    const statePath = join(dir, ".spark", "sessions", "session-ephemeral.json");
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await writeFile(statePath, '{"version":1,"phase":"research"}\n', "utf8");

    assert.deepEqual(await loadSparkPhase(dir, undefined), { phase: "plan" });
    await saveSparkPhase(dir, undefined, { phase: "plan" });
    assert.doesNotMatch(await readFile(statePath, "utf8"), /"phase": "research"/u);
  });
});

test("nextSparkSessionPhase walks the canonical cycle", () => {
  assert.deepEqual(SPARK_SESSION_PHASE_CYCLE, ["plan", "implement"]);
  assert.equal(nextSparkSessionPhase("plan"), "implement");
  assert.equal(nextSparkSessionPhase("implement"), "plan");
});
