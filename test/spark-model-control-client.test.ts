import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createSparkDaemonModelAuthClient,
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

test("daemon model picker exposes only available models and preserves the default", () => {
  const state = daemonSnapshotToPickerState(snapshot);

  assert.deepEqual(
    state.items.map((item) => item.value),
    ["provider-a/model-a", "provider-b/model-a"],
  );
  assert.equal(state.activeModelId, "provider-a/model-a");
  assert.equal(state.items[0]?.active, true);
});

test("daemon model picker prefers the persisted session model over the global default", () => {
  const state = daemonSnapshotToPickerState({
    ...snapshot,
    session: {
      sessionId: "sess_model",
      model: { providerName: "provider-b", modelId: "model-a" },
    },
  });

  assert.equal(state.activeModelId, "provider-b/model-a");
  assert.equal(state.items[0]?.active, false);
  assert.equal(state.items[1]?.active, true);
});

test("daemon model resolution requires provider when a model id is ambiguous", () => {
  assert.deepEqual(resolveDaemonModelSelection(snapshot, "provider-b/model-a"), {
    providerName: "provider-b",
    modelId: "model-a",
  });
  assert.throws(() => resolveDaemonModelSelection(snapshot, "model-a"), /Ambiguous Spark model/u);
});

test("bound daemon model control keeps session and global model RPCs distinct", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const lifecycle: string[] = [];
  let ensureCalls = 0;
  const client = createSparkDaemonModelAuthClient(
    {
      daemonStatus: async () => ({
        observedAt: "2026-07-13T00:00:00.000Z",
        servers: [],
        invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
      }),
      controlRequest: async (method, params) => {
        lifecycle.push(method);
        calls.push({ method, params });
        if (method === "session.model.set") {
          return {
            sessionId: "sess_model",
            scope: { kind: "workspace", workspaceId: "ws_model" },
            workspaceId: "ws_model",
            status: "ready",
            bindings: [],
            model: { providerName: "provider-b", modelId: "model-a" },
            createdAt: "2026-07-13T00:00:00.000Z",
            updatedAt: "2026-07-13T00:01:00.000Z",
          };
        }
        return snapshot;
      },
    },
    {
      sessionId: "sess_model",
      ensureSession: async () => {
        ensureCalls += 1;
        lifecycle.push("ensure-session");
      },
    },
  );

  await client.snapshot();
  await client.setSessionModel({ providerName: "provider-b", modelId: "model-a" });
  await client.setDefaultModel({ providerName: "provider-a", modelId: "model-a" });

  assert.equal(ensureCalls, 1);
  assert.deepEqual(lifecycle, [
    "ensure-session",
    "model.catalog",
    "session.model.set",
    "model.default.set",
  ]);
  assert.deepEqual(calls, [
    { method: "model.catalog", params: { sessionId: "sess_model" } },
    {
      method: "session.model.set",
      params: {
        sessionId: "sess_model",
        model: { providerName: "provider-b", modelId: "model-a" },
      },
    },
    {
      method: "model.default.set",
      params: { model: { providerName: "provider-a", modelId: "model-a" } },
    },
  ]);
});
