import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SparkOAuthFlowSnapshot,
  SparkProviderControl,
  SparkProviderControlSnapshot,
} from "@zendev-lab/spark-ai/control";
import { SparkSessionRegistry, defaultSparkSessionRegistryRoot } from "@zendev-lab/spark-session";
import { createSparkDaemonModelControl } from "./model-control.js";
import { createSerializedDaemonSessionRegistry } from "./session-registry.js";

const roots: string[] = [];
const model = { providerName: "baidu-oneapi", modelId: "ernie-4.5" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon model control", () => {
  it("projects one catalog and persists a conversation-scoped model", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-model-control-"));
    roots.push(root);
    const sessionRegistry = createSerializedDaemonSessionRegistry(
      new SparkSessionRegistry({ rootDir: defaultSparkSessionRegistryRoot(root) }),
    );
    await sessionRegistry.create({ sessionId: "sess_demo", workspaceId: "ws_demo" });
    const prepareModel = vi.fn(async () => undefined);
    const control = createSparkDaemonModelControl({
      providerControl: fakeProviderControl(prepareModel),
      sessionRegistry,
    });

    const initial = await control.snapshot("sess_demo");
    expect(initial.defaultModel).toMatchObject(model);
    expect(initial.providers.map((provider) => provider.providerName)).toEqual([
      "baidu-oneapi",
      "openai-codex",
    ]);
    expect(initial.providers[0]?.auth).toMatchObject({
      kind: "api_key",
      configured: true,
      source: "environment",
      reference: "BAIDU_ONEAPI_API_KEY",
    });

    const selected = await control.setSessionModel("sess_demo", model);
    expect(selected.model).toMatchObject(model);
    expect(await control.effectiveModel("sess_demo")).toMatchObject(model);
    await control.prepareModel(model);
    expect(prepareModel).toHaveBeenCalledWith("baidu-oneapi/ernie-4.5");
  });

  it("maps OAuth interaction state without credential material", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-model-oauth-"));
    roots.push(root);
    const sessionRegistry = createSerializedDaemonSessionRegistry(
      new SparkSessionRegistry({ rootDir: defaultSparkSessionRegistryRoot(root) }),
    );
    const providerControl = fakeProviderControl();
    const control = createSparkDaemonModelControl({ providerControl, sessionRegistry });

    const flow = await control.startOAuth("openai-codex");

    expect(flow).toMatchObject({
      providerName: "openai-codex",
      status: "waiting_for_user",
      prompt: { id: "prompt_1", kind: "manual_code" },
    });
    expect(flow).not.toHaveProperty("credentials");
    expect(flow).not.toHaveProperty("access");
  });
});

function fakeProviderControl(
  prepareModel: (modelRef: string) => Promise<void> = async () => undefined,
): SparkProviderControl {
  const snapshot: SparkProviderControlSnapshot = {
    activeModelId: "baidu-oneapi/ernie-4.5",
    providers: [
      {
        id: "baidu-oneapi",
        name: "Baidu OneAPI",
        auth: {
          provider: "baidu-oneapi",
          kind: "env",
          configured: true,
          ref: "BAIDU_ONEAPI_API_KEY",
          source: "environment",
          apiKeySupported: true,
        },
        modelCount: 1,
      },
    ],
    models: [
      {
        id: "baidu-oneapi/ernie-4.5",
        providerId: "baidu-oneapi",
        modelId: "ernie-4.5",
        name: "ERNIE 4.5",
        active: true,
        available: true,
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
    oauthProviders: [{ id: "openai-codex", name: "OpenAI Codex", configured: false }],
    loadOutcomes: [],
  };
  const flow: SparkOAuthFlowSnapshot = {
    id: "flow_1",
    providerId: "openai-codex",
    phase: "waiting_for_input",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:01.000Z",
    prompt: {
      id: "prompt_1",
      kind: "manual_code",
      message: "Paste the authorization code",
      allowEmpty: false,
    },
    progress: [],
  };
  return {
    snapshot: async () => snapshot,
    setDefaultModel: async () => undefined,
    setApiKey: async () => undefined,
    logout: async () => false,
    startOAuth: async () => flow,
    oauthStatus: () => flow,
    respondOAuth: () => flow,
    cancelOAuth: () => ({ ...flow, phase: "cancelled" }),
    resolveApiKey: () => "key",
    resolveApiKeyAsync: async () => "key",
    prepareModel,
  };
}
