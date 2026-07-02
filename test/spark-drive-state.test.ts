import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveSparkDriveMode,
  normalizeSparkDriveMode,
  renderSparkDriveMode,
  SPARK_DRIVE_MODES,
  SparkDriveRegistry,
  sparkDriveRegistry,
  type SparkDriveDescriptor,
} from "../packages/pi-extension/src/extension/spark-drive-state.ts";

void test("Spark drive registry centralizes modes, aliases, and rendering", () => {
  assert.deepEqual(SPARK_DRIVE_MODES, ["assist", "loop", "goal", "repro", "workflow"]);
  assert.deepEqual(sparkDriveRegistry.modes(), SPARK_DRIVE_MODES);
  assert.equal(normalizeSparkDriveMode("interactive"), "assist");
  assert.equal(normalizeSparkDriveMode("repro"), "repro");
  assert.equal(normalizeSparkDriveMode("unknown"), undefined);
  assert.equal(renderSparkDriveMode("workflow"), "workflow");
});

void test("Spark drive registry derives priority workflow > repro > goal > loop > assist", () => {
  assert.equal(deriveSparkDriveMode({}), "assist");
  assert.equal(deriveSparkDriveMode({ loop: { status: "active" } as never }), "loop");
  assert.equal(
    deriveSparkDriveMode({
      loop: { status: "active" } as never,
      goal: { status: "active" } as never,
      repro: { status: "active" } as never,
    }),
    "repro",
  );
  assert.equal(
    deriveSparkDriveMode({
      workflowActive: true,
      repro: { status: "active" } as never,
      goal: { status: "active" } as never,
      loop: { status: "active" } as never,
    }),
    "workflow",
  );
});

void test("explicit active lens drive overrides derived session state", () => {
  assert.equal(
    deriveSparkDriveMode({
      activeLens: { drive: "goal" },
      workflowActive: true,
      repro: { status: "active" } as never,
    }),
    "goal",
  );
});

void test("new drives register through one descriptor object and one register call", () => {
  type DemoDriveMode = "assist" | "demo";
  const demoDescriptor = {
    id: "demo",
    label: "demo",
    priority: 10,
    aliases: ["demo-alias"],
    isActive: (input) => input.workflowActive === true,
  } satisfies SparkDriveDescriptor<"demo">;

  const registry = new SparkDriveRegistry<DemoDriveMode>();
  registry.register({ id: "assist", priority: 0, isActive: () => true });
  registry.register(demoDescriptor);

  assert.equal(registry.normalize("demo-alias"), "demo");
  assert.equal(registry.derive({ workflowActive: true }), "demo");
  assert.equal(registry.render("demo"), "demo");
});
