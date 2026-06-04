import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBuiltinRoles } from "pi-roles";
import {
  SPARK_PATCHER_ROLE_REF,
  createSparkPredefinedRoles,
  createSparkRoleRegistry,
} from "../packages/spark/src/extension/spark-role-registry.ts";

void test("Spark patcher role is Spark-owned and available through Spark registries", async () => {
  const staticPiRoles = createBuiltinRoles("2026-06-04T00:00:00.000Z");
  assert.equal(
    staticPiRoles.some((role) => role.ref === SPARK_PATCHER_ROLE_REF || role.id === "patcher"),
    false,
  );

  const sparkRoles = createSparkPredefinedRoles("2026-06-04T00:00:00.000Z");
  const patcher = sparkRoles.find((role) => role.id === "patcher");
  assert.equal(patcher?.ref, "role:builtin-spark-patcher");
  assert.match(patcher?.description ?? "", /code patches/);
  assert.doesNotMatch(patcher?.systemPrompt ?? "", /graft/i);

  const dir = await mkdtemp(join(tmpdir(), "spark-role-registry-"));
  try {
    const registry = await createSparkRoleRegistry(dir);
    const loadedById = registry.select("patcher");
    const loadedByRef = registry.select("role:builtin-spark-patcher");

    assert.equal(loadedById.ref, SPARK_PATCHER_ROLE_REF);
    assert.equal(loadedByRef.id, "patcher");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
