import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  sparkSessionOwnerKey,
  sparkStateCwd,
} from "../packages/pi-extension/src/extension/session-identity.ts";
import {
  rebuildSessionIndex as rebuildSparkLoopSessionIndex,
  sessionGoalStorePath,
  sessionIndexStorePath,
  sessionLoopStorePath,
  setSessionGoal,
  setSessionLoop,
  sparkSessionKey as sparkLoopSessionKey,
  sparkStateCwd as sparkLoopStateCwd,
  sparkStateRootPath as sparkLoopStateRootPath,
} from "../packages/spark-loop/src/index.ts";

void test("sparkSessionKey prefers host sessionId over sessionManager stubs", () => {
  assert.equal(
    sparkSessionKey({
      sessionId: "sess_daemon_1",
      sessionManager: {
        getSessionFile: () => "/tmp/local.jsonl",
        getLeafId: () => "leaf:ignored",
      },
    }),
    "session:sess_daemon_1",
  );
  assert.equal(
    sparkSessionOwnerKey({
      sessionId: "session:already-qualified",
      sessionManager: { getSessionFile: () => "/tmp/local.jsonl" },
    }),
    "session:already-qualified",
  );
});

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

void test("spark-loop session identity prefers host sessionId over sessionManager stubs", () => {
  assert.equal(
    sparkLoopSessionKey({
      sessionId: "sess_loop_1",
      sessionManager: {
        getSessionFile: () => "/tmp/local.jsonl",
        getLeafId: () => "leaf:ignored",
      },
    }),
    "session:sess_loop_1",
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

void test("spark-loop state paths default to cwd/.spark", () => {
  const cwd = join("workspace", "repo");
  const defaultRoot = join(cwd, ".spark");

  assert.equal(sparkLoopStateRootPath(cwd), defaultRoot);
  assert.equal(sessionIndexStorePath(cwd), join(defaultRoot, "sessions", "index.json"));
  assert.equal(
    sessionGoalStorePath(cwd),
    join(defaultRoot, "sessions", "session-ephemeral", "goal.json"),
  );
  assert.equal(
    sessionLoopStorePath(cwd),
    join(defaultRoot, "sessions", "session-ephemeral", "loop.json"),
  );
});

void test("spark-loop goal, loop, and rebuilt index share explicit sparkStateRoot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-loop-state-root-context-"));
  try {
    const repo = join(dir, "repo");
    const stateRoot = join(dir, "control-state");
    await mkdir(repo, { recursive: true });
    const ctx = {
      sparkStateRoot: stateRoot,
      sessionManager: { getLeafId: () => "session:explicit-loop" },
    };

    await setSessionGoal(repo, ctx, { objective: "Keep goal state isolated", source: "explicit" });
    await setSessionLoop(repo, ctx, { objective: "Keep loop state isolated", source: "explicit" });
    const rebuilt = await rebuildSparkLoopSessionIndex(repo, ctx);

    assert.equal(sparkLoopStateRootPath(repo, ctx), stateRoot);
    assert.equal(sparkLoopStateCwd(repo, ctx), repo);
    assert.equal(
      sessionGoalStorePath(repo, ctx),
      join(stateRoot, "sessions", "session-explicit-loop", "goal.json"),
    );
    assert.equal(
      sessionLoopStorePath(repo, ctx),
      join(stateRoot, "sessions", "session-explicit-loop", "loop.json"),
    );
    assert.equal(sessionIndexStorePath(repo, ctx), join(stateRoot, "sessions", "index.json"));
    assert.deepEqual(
      rebuilt.sessions.map(({ sessionKey, activeGoal, activeLoop }) => ({
        sessionKey,
        activeGoal,
        activeLoop,
      })),
      [{ sessionKey: "session:explicit-loop", activeGoal: true, activeLoop: true }],
    );

    const persisted = JSON.parse(await readFile(sessionIndexStorePath(repo, ctx), "utf8")) as {
      sessions: unknown[];
    };
    assert.equal(persisted.sessions.length, 1);
    await assert.rejects(readFile(join(repo, ".spark", "sessions", "index.json"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
