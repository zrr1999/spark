import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskGraph, defaultTaskGraphStore } from "@zendev-lab/spark-tasks";

import { saveCurrentProjectRef } from "../packages/pi-extension/src/extension/current-project-state.ts";
import {
  currentSparkProject,
  loadSparkGraph,
} from "../packages/pi-extension/src/extension/session-state.ts";
import {
  sparkSessionKey,
  sparkStateCwd,
} from "../packages/pi-extension/src/extension/session-identity.ts";
import { sparkSessionKey as sparkLoopSessionKey } from "../packages/spark-loop/src/session-identity.ts";

void test("sparkSessionKey accepts fully-qualified session manager leaf keys", () => {
  assert.equal(
    sparkSessionKey({ sessionManager: { getLeafId: () => "session:5ad35e499eafe941" } }),
    "session:5ad35e499eafe941",
  );
  assert.equal(sparkSessionKey({ sessionManager: { getLeafId: () => "leaf:abc" } }), "leaf:abc");
  assert.equal(
    sparkSessionKey({ sessionManager: { getLeafId: () => "raw-leaf" } }),
    "leaf:raw-leaf",
  );
});

void test("spark-loop session identity accepts fully-qualified session manager leaf keys", () => {
  assert.equal(
    sparkLoopSessionKey({ sessionManager: { getLeafId: () => "session:5ad35e499eafe941" } }),
    "session:5ad35e499eafe941",
  );
  assert.equal(
    sparkLoopSessionKey({ sessionManager: { getLeafId: () => "leaf:abc" } }),
    "leaf:abc",
  );
  assert.equal(
    sparkLoopSessionKey({ sessionManager: { getLeafId: () => "raw-leaf" } }),
    "leaf:raw-leaf",
  );
});

void test("Spark state helpers honor explicit sparkStateRoot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-state-root-context-"));
  try {
    const repo = join(dir, "repo");
    const stateOwner = join(dir, "state-owner");
    const stateRoot = join(stateOwner, ".spark");
    await mkdir(repo, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Explicit state root", description: "state" });
    await defaultTaskGraphStore(stateOwner).save(graph);
    const ctx = {
      sparkStateRoot: stateRoot,
      sessionManager: { getLeafId: () => "session:explicit" },
    };
    await saveCurrentProjectRef(repo, ctx, project.ref);

    const loaded = await loadSparkGraph(repo, ctx);
    assert.ok(loaded);
    assert.equal(loaded.projects()[0]?.title, "Explicit state root");
    assert.equal((await currentSparkProject(repo, ctx, loaded))?.ref, project.ref);
    assert.equal(sparkStateCwd(repo, ctx), stateOwner);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
