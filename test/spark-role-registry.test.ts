import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  builtinRoleIds,
  createBuiltinRoles,
  createSparkRoleRegistry,
} from "@zendev-lab/spark-roles";
import { SPARK_GRAFT_PATCHER_ROLE_REF, registerSparkGraftExtension } from "@zendev-lab/spark-graft";

interface MinimalSparkGraftApi {
  on(event: "session_start", handler: (event: unknown, ctx: { cwd?: string }) => unknown): void;
  registerTool(tool: { name: string }): void;
}

function minimalSparkGraftApi(): MinimalSparkGraftApi {
  return {
    on() {},
    registerTool() {},
  };
}

test("Spark role registries keep patcher out of builtin roles", async () => {
  const staticSparkRoles = createBuiltinRoles("2026-06-04T00:00:00.000Z");
  assert.equal(
    staticSparkRoles.some(
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

test("Spark role registries include spark-graft patcher only as an extension role", async () => {
  registerSparkGraftExtension(minimalSparkGraftApi());
  const dir = await mkdtemp(join(tmpdir(), "spark-role-registry-extension-"));
  try {
    const registry = await createSparkRoleRegistry(dir);
    const patcher = registry.select("patcher", { source: "extension" });

    assert.equal(patcher.ref, SPARK_GRAFT_PATCHER_ROLE_REF);
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
