import assert from "node:assert/strict";
import { test } from "vitest";

import { isGoalToolDeactivationEvent } from "../packages/spark-extension/src/extension/spark-command-tool-events.ts";
import { createSparkNativeTuiHarness } from "./support/spark-native-tui-harness.ts";

test("approved goal completion remains a control event without exiting TUI session", () => {
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

  assert.equal(harness.state.exited, false);
  assert.match(harness.render(), /Spark session attached/);
  assert.match(harness.render(), /attach target: session:attached/);
});
