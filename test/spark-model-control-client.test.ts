import assert from "node:assert/strict";
import test from "node:test";

import {
  daemonSnapshotToPickerState,
  resolveDaemonModelSelection,
} from "../apps/spark-tui/src/cli/model-control.ts";
import type { SparkModelControlSnapshot } from "../packages/spark-protocol/src/index.ts";

const snapshot: SparkModelControlSnapshot = {
  defaultModel: { providerName: "provider-a", modelId: "model-a" },
  diagnostics: [],
  providers: [
    {
      providerName: "provider-a",
      label: "Provider A",
      auth: {
        providerName: "provider-a",
        kind: "api_key",
        configured: true,
        source: "stored",
      },
      models: [
        {
          model: {
            providerName: "provider-a",
            modelId: "model-a",
            modelLabel: "Model A",
          },
          reasoning: true,
          input: ["text"],
          available: true,
          contextWindow: 32_000,
        },
        {
          model: { providerName: "provider-a", modelId: "model-locked" },
          reasoning: false,
          input: ["text"],
          available: false,
          unavailableReason: "Login required",
        },
      ],
    },
    {
      providerName: "provider-b",
      label: "Provider B",
      auth: { providerName: "provider-b", kind: "none", configured: true },
      models: [
        {
          model: { providerName: "provider-b", modelId: "model-a" },
          reasoning: false,
          input: ["text"],
          available: true,
        },
      ],
    },
  ],
};

void test("daemon model picker exposes only available models and preserves the default", () => {
  const state = daemonSnapshotToPickerState(snapshot);

  assert.deepEqual(
    state.items.map((item) => item.value),
    ["provider-a/model-a", "provider-b/model-a"],
  );
  assert.equal(state.activeModelId, "provider-a/model-a");
  assert.equal(state.items[0]?.active, true);
});

void test("daemon model resolution requires provider when a model id is ambiguous", () => {
  assert.deepEqual(resolveDaemonModelSelection(snapshot, "provider-b/model-a"), {
    providerName: "provider-b",
    modelId: "model-a",
  });
  assert.throws(() => resolveDaemonModelSelection(snapshot, "model-a"), /Ambiguous Spark model/u);
});
