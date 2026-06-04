import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProjectRef } from "spark-core";
import {
  clearSparkMode,
  loadSparkMode,
  nextSparkSessionMode,
  saveSparkExecutionMode,
  saveSparkMode,
  saveSparkPlanningMode,
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

void test("loadSparkMode defaults to auto with no persisted state", async () => {
  await withTempDir(async (dir) => {
    const state = await loadSparkMode(dir, undefined);
    assert.deepEqual(state, { mode: "auto" });
  });
});

void test("saveSparkMode round-trips research mode", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-research" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "research", projectRef, focus: "audit" });
    const state = await loadSparkMode(dir, undefined);
    assert.equal(state.mode, "research");
    assert.equal(state.projectRef, projectRef);
    assert.equal(state.focus, "audit");
    assert.equal(state.executeStrategy, undefined);
    assert.ok(state.enteredAt, "enteredAt should be populated by saveSparkExecutionMode");
  });
});

void test("saveSparkMode round-trips plan mode and records planningSource", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-plan" as ProjectRef;
    await saveSparkMode(dir, undefined, {
      mode: "plan",
      projectRef,
      focus: "scope review",
      planningSource: "direct",
    });
    const state = await loadSparkMode(dir, undefined);
    assert.equal(state.mode, "plan");
    assert.equal(state.projectRef, projectRef);
    assert.equal(state.focus, "scope review");
    assert.equal(state.planningSource, "direct");
  });
});

void test("saveSparkMode round-trips execute(workflow) with selector", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-execute" as ProjectRef;
    await saveSparkMode(dir, undefined, {
      mode: "execute",
      projectRef,
      executeStrategy: "workflow",
      workflowSelector: "workspace:release-check",
      focus: "ship feature",
    });
    const state = await loadSparkMode(dir, undefined);
    assert.equal(state.mode, "execute");
    assert.equal(state.executeStrategy, "workflow");
    assert.equal(state.workflowSelector, "workspace:release-check");
    assert.equal(state.focus, "ship feature");
  });
});

void test("legacy saveSparkExecutionMode is readable via loadSparkMode", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-legacy-exec" as ProjectRef;
    await saveSparkExecutionMode(dir, undefined, projectRef, "do it", "execute", "goal");
    const state = await loadSparkMode(dir, undefined);
    assert.equal(state.mode, "execute");
    assert.equal(state.projectRef, projectRef);
    assert.equal(state.executeStrategy, "goal");
    assert.equal(state.focus, "do it");
  });
});

void test("legacy saveSparkPlanningMode is readable via loadSparkMode", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-legacy-plan" as ProjectRef;
    await saveSparkPlanningMode(dir, undefined, projectRef, "plan it", "auto");
    const state = await loadSparkMode(dir, undefined);
    assert.equal(state.mode, "plan");
    assert.equal(state.projectRef, projectRef);
    assert.equal(state.planningSource, "auto");
  });
});

void test("clearSparkMode preserves projectRef but resets to auto", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-clear" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "plan", projectRef });
    await clearSparkMode(dir, undefined);
    const state = await loadSparkMode(dir, undefined);
    assert.equal(state.mode, "auto");
    assert.equal(state.projectRef, projectRef);
  });
});

void test("saveSparkMode rejects non-auto mode without projectRef", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => saveSparkMode(dir, undefined, { mode: "plan" }),
      /projectRef is required/,
    );
  });
});

void test("nextSparkSessionMode walks the canonical cycle", () => {
  assert.deepEqual(SPARK_SESSION_MODE_CYCLE, ["auto", "research", "plan", "execute"]);
  assert.equal(nextSparkSessionMode("auto"), "research");
  assert.equal(nextSparkSessionMode("research"), "plan");
  assert.equal(nextSparkSessionMode("plan"), "execute");
  assert.equal(nextSparkSessionMode("execute"), "auto");
});
