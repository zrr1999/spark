import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { builtinRoleIds, createBuiltinRoles } from "@zendev-lab/pi-roles";
import { PI_GRAFT_PATCHER_ROLE_REF, registerPiGraftExtension } from "@zendev-lab/pi-graft";
import { createSparkRoleRegistry } from "../packages/spark-extension/src/extension/spark-role-registry.ts";

interface MinimalPiGraftApi {
  on(event: "session_start", handler: (event: unknown, ctx: { cwd?: string }) => unknown): void;
  registerTool(tool: { name: string }): void;
}

function minimalPiGraftApi(): MinimalPiGraftApi {
  return {
    on() {},
    registerTool() {},
  };
}

void test("Spark role registries keep patcher out of builtin roles", async () => {
  const staticPiRoles = createBuiltinRoles("2026-06-04T00:00:00.000Z");
  assert.equal(
    staticPiRoles.some(
      (role) => role.ref === "role:builtin-spark-patcher" || role.id === "patcher",
    ),
    false,
  );

  const dir = await mkdtemp(join(tmpdir(), "spark-role-registry-"));
  try {
    const registry = await createSparkRoleRegistry(dir);

    assert.deepEqual(
      registry.list({ source: "builtin" }).map((role) => role.id),
      [...builtinRoleIds].sort(),
    );
    assert.throws(() => registry.select("patcher"), /no role matches: patcher/);
    assert.throws(() => registry.select("role:builtin-spark-patcher"), /unknown role/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark role registries include pi-graft patcher only as an extension role", async () => {
  registerPiGraftExtension(minimalPiGraftApi());
  const dir = await mkdtemp(join(tmpdir(), "spark-role-registry-extension-"));
  try {
    const registry = await createSparkRoleRegistry(dir);
    const patcher = registry.select("patcher", { source: "extension" });

    assert.equal(patcher.ref, PI_GRAFT_PATCHER_ROLE_REF);
    assert.equal(patcher.source, "extension");
    assert.deepEqual(
      registry.list({ source: "builtin" }).map((role) => role.id),
      [...builtinRoleIds].sort(),
    );
    assert.throws(() => registry.select("role:builtin-spark-patcher"), /unknown role/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
