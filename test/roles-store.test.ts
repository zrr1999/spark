import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RoleRegistry,
  MarkdownRoleStore,
  createRoleSpec,
  createBuiltinRoles,
  builtinRoleIds,
} from "@zendev-lab/pi-roles";

void test("builtin Pi roles are instructed to implement concrete repo behavior feedback", () => {
  const roles = createBuiltinRoles();
  const planner = roles.find((role) => role.id === "planner");
  const worker = roles.find((role) => role.id === "worker");
  assert.match(planner?.systemPrompt ?? "", /implementation work rather than memory-only updates/);
  assert.match(
    worker?.systemPrompt ?? "",
    /fix the implementation instead of only recording a preference/,
  );
});

void test("builtin Pi roles expose minimal sufficient tool profiles", () => {
  const roles = createBuiltinRoles("2026-06-04T00:00:00.000Z");
  assert.deepEqual(
    roles.map((role) => role.id),
    [...builtinRoleIds],
  );

  const byId = new Map(roles.map((role) => [role.id, role]));

  for (const id of ["scout", "planner", "oracle"]) {
    assert.deepEqual(byId.get(id)?.allowedTools, [
      "context",
      "learning",
      "artifact",
      "task",
      "ask",
    ]);
  }

  assert.deepEqual(byId.get("worker")?.allowedTools, [
    "context",
    "learning",
    "artifact",
    "task",
    "ask",
    "cue_exec",
    "cue_run",
    "cue_script",
    "script_run",
    "script_eval",
    "cue_jobs",
  ]);

  assert.deepEqual(byId.get("reviewer")?.allowedTools, [
    "context",
    "learning",
    "artifact",
    "task",
    "cue_exec",
    "cue_run",
    "cue_script",
    "script_run",
    "script_eval",
    "cue_jobs",
  ]);
});

void test("project role spec store persists and hydrates registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-"));
  try {
    const store = new MarkdownRoleStore(dir);
    const spec = createRoleSpec({
      id: "svg-assembler",
      description: "Creates SVG assembly animation plans.",
      systemPrompt: "You are a specialist in SVG animation planning.",
      rationale: "We need a narrow reusable planner for SVG animation tasks.",
      expectedUses: ["svg assembly planning", "animation decomposition"],
    });
    await store.save(spec);

    const registry = new RoleRegistry();
    await store.hydrate(registry);
    const loaded = registry.select("svg-assembler");

    assert.equal(loaded.source, "project");
    assert.equal(loaded.id, "svg-assembler");
    assert.match(loaded.ref, /^role:project-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
