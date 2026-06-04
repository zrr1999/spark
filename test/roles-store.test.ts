import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RoleRegistry,
  MarkdownRoleStore,
  createDefaultRoleRegistry,
  createRoleRef,
  createRoleSpec,
  createBuiltinRoles,
  registerBuiltinRoleProvider,
  unregisterBuiltinRoleProvider,
  type RoleSpec,
} from "pi-roles";

void test("builtin Spark roles are instructed to implement concrete repo behavior feedback", () => {
  const roles = createBuiltinRoles();
  const planner = roles.find((role) => role.id === "planner");
  const worker = roles.find((role) => role.id === "worker");
  assert.match(planner?.systemPrompt ?? "", /implementation work rather than memory-only updates/);
  assert.match(
    worker?.systemPrompt ?? "",
    /fix the implementation instead of only recording a preference/,
  );
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

void test("registered builtin role providers participate in default role registries", () => {
  const providerId = "roles-store-test";
  const now = "2026-06-04T00:00:00.000Z";
  const role: RoleSpec = {
    ref: createRoleRef("builtin", "provider-test"),
    id: "provider-test",
    source: "builtin",
    description: "Test-provided builtin role.",
    systemPrompt: "You are a test-provided builtin role.",
    origin: { kind: "builtin", note: "test provider" },
    createdAt: now,
    updatedAt: now,
  };
  registerBuiltinRoleProvider(providerId, () => [role]);
  try {
    const registry = createDefaultRoleRegistry({ now });
    const loaded = registry.select("provider-test");

    assert.equal(loaded.ref, "role:builtin-provider-test");
    assert.equal(loaded.origin?.note, "test provider");
  } finally {
    unregisterBuiltinRoleProvider(providerId);
  }
});
