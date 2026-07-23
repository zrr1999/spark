import assert from "node:assert/strict";
import { test } from "vitest";

import { SparkForegroundDriveSubstrate } from "../packages/spark-extension/src/extension/spark-drive-substrate.ts";
import { isGoalToolDeactivationEvent } from "../packages/spark-extension/src/extension/spark-command-tool-events.ts";
import { createSparkNativeTuiHarness } from "./support/spark-native-tui-harness.ts";

test("approved goal completion stops foreground goal ticks without exiting TUI session", async () => {
  const substrate = new SparkForegroundDriveSubstrate();
  const baseKey = "cwd:session";
  let tickRan = false;
  const generation = substrate.schedule({
    drive: "goal",
    baseKey,
    delayMs: 5,
    run: () => {
      tickRan = true;
    },
  });
  assert.equal(substrate.currentGeneration("goal", baseKey), generation);

  const harness = createSparkNativeTuiHarness({
    cols: 180,
    workspaceSession: {
      mode: "attached",
      workspaceDir: "/workspaces/current",
      workspaceHash: "hash-current",
      controlPlaneSessionId: "client-current",
      attachTarget: "session:attached",
    },
  });

  const event = { toolName: "goal", isError: false, params: { action: "complete" } };
  assert.equal(isGoalToolDeactivationEvent(event), true);
  substrate.clearTimer("goal", baseKey);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(tickRan, false);
  assert.equal(harness.state.exited, false);
  assert.match(harness.render(), /Spark session attached/);
  assert.match(harness.render(), /attach target: session:attached/);
});
