import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SparkAuthStore,
  createSparkProviderControl,
  registerSparkOAuthProvider,
  resetSparkOAuthProviders,
  type SparkOAuthProviderInterface,
} from "../packages/spark-ai/src/control/index.ts";
import type { ProviderRegistrationAPI } from "../packages/spark-ai/src/index.ts";

const future = Date.parse("2030-01-01T00:00:00.000Z");

function providerImporter(specifier: string): Promise<unknown> {
  const factories: Record<string, (api: ProviderRegistrationAPI) => void> = {
    "env-plugin": (api) => {
      api.registerProvider("env-provider", {
        name: "env-provider",
        baseUrl: "https://env.test",
        apiKey: "ENV_PROVIDER_KEY",
        api: "openai-completions",
        streamSimple: () => ({}),
        models: [model("model-a", ["alias-a"])],
      });
    },
    "oauth-plugin": (api) => {
      api.registerProvider("oauth-provider", {
        name: "oauth-provider",
        baseUrl: "https://oauth.test",
        apiKey: "oauth:test-oauth-control",
        api: "openai-completions",
        streamSimple: () => ({}),
        models: [model("model-oauth")],
      });
    },
  };
  const factory = factories[specifier];
  if (!factory) return Promise.reject(new Error(`unknown fixture: ${specifier}`));
  return Promise.resolve({ default: factory });
}

function model(id: string, aliases?: string[]) {
  return {
    id,
    ...(aliases ? { aliases } : {}),
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}

async function withSparkHome(fn: (sparkHome: string) => Promise<void>): Promise<void> {
  const sparkHome = await mkdtemp(join(tmpdir(), "spark-provider-control-"));
  try {
    await fn(sparkHome);
  } finally {
    await rm(sparkHome, { recursive: true, force: true });
    resetSparkOAuthProviders();
  }
}

void test("Spark auth mutations reload and merge across store instances", async () => {
  await withSparkHome(async (sparkHome) => {
    const path = join(sparkHome, "auth.json");
    const first = new SparkAuthStore({ path });
    const second = new SparkAuthStore({ path });

    await Promise.all([first.setApiKey("first", "one"), second.setApiKey("second", "two")]);

    const reloaded = new SparkAuthStore({ path });
    await reloaded.reload();
    assert.deepEqual(reloaded.listProviders(), ["first", "second"]);
    assert.equal(reloaded.get("first")?.type, "api_key");
    assert.equal(reloaded.get("second")?.type, "api_key");
  });
});

void test("provider control lists auth safely and patches only the default model fields", async () => {
  await withSparkHome(async (sparkHome) => {
    const configPath = join(sparkHome, "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        providers: ["env-plugin"],
        extensions: ["keep-extension"],
        activeProvider: "env-provider",
        activeModel: "alias-a",
        futureField: { keep: true },
      })}\n`,
    );
    const control = createSparkProviderControl({
      sparkHome,
      providerSpecs: ["env-plugin"],
      importer: providerImporter,
      env: {},
    });

    const before = await control.snapshot();
    assert.equal(before.activeModelId, "env-provider/model-a");
    assert.equal(before.providers[0]?.auth.configured, false);
    assert.equal(before.providers[0]?.auth.source, "missing");
    assert.doesNotMatch(JSON.stringify(before), /ENV_PROVIDER_KEY=.*|api[_-]?key\s*:/iu);

    await control.setApiKey("env-provider", "stored-secret");
    await control.setDefaultModel("env-provider/alias-a");
    const after = await control.snapshot();
    assert.equal(after.providers[0]?.auth.configured, true);
    assert.equal(after.providers[0]?.auth.source, "stored_api_key");
    assert.equal(after.models[0]?.available, true);
    assert.doesNotMatch(JSON.stringify(after), /stored-secret/u);

    const persisted = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(persisted.futureField, { keep: true });
    assert.deepEqual(persisted.extensions, ["keep-extension"]);
    assert.equal(persisted.activeModelId, "env-provider/model-a");
    assert.equal("activeProvider" in persisted, false);
    assert.equal("activeModel" in persisted, false);
  });
});

void test("legacy provider config still exposes the bundled OpenAI Codex catalog", async () => {
  await withSparkHome(async (sparkHome) => {
    await writeFile(
      join(sparkHome, "config.json"),
      `${JSON.stringify({
        providers: ["@zendev-lab/spark-ai/baidu-oneapi-provider"],
        activeModelId: "baidu-oneapi/gpt-5.5",
      })}\n`,
    );
    const control = createSparkProviderControl({ sparkHome, env: {} });

    const snapshot = await control.snapshot();
    const codex = snapshot.providers.find((provider) => provider.id === "openai-codex");
    assert.equal(codex?.name, "OpenAI Codex");
    assert.equal(codex?.modelCount, 7);
    assert.equal(codex?.auth.kind, "oauth");
    assert.equal(codex?.auth.configured, false);
    assert.equal(snapshot.models.filter((model) => model.providerId === "openai-codex").length, 7);
    assert.equal(
      snapshot.models
        .filter((model) => model.providerId === "openai-codex")
        .every((model) => !model.available),
      true,
    );
    assert.equal(
      snapshot.loadOutcomes.find(
        (outcome) => outcome.specifier === "@zendev-lab/spark-ai/openai-codex-provider",
      )?.ok,
      true,
    );
  });
});

void test("provider control reports malformed config and refuses a destructive patch", async () => {
  await withSparkHome(async (sparkHome) => {
    const configPath = join(sparkHome, "config.json");
    await writeFile(configPath, "{broken-json\n");
    const control = createSparkProviderControl({
      sparkHome,
      providerSpecs: ["env-plugin"],
      importer: providerImporter,
    });

    assert.match((await control.snapshot()).configError ?? "", /Invalid Spark config JSON/u);
    await assert.rejects(
      control.setDefaultModel("env-provider/model-a"),
      /Refusing to overwrite unreadable Spark config/u,
    );
    assert.equal(await readFile(configPath, "utf8"), "{broken-json\n");
  });
});

void test("OAuth broker exposes only interaction state and prepareModel refreshes durably", async () => {
  await withSparkHome(async (sparkHome) => {
    let refreshCount = 0;
    const oauthProvider: SparkOAuthProviderInterface = {
      id: "test-oauth-control",
      name: "Test OAuth Control",
      async login(callbacks) {
        callbacks.onAuth({
          url: "https://oauth.test/authorize",
          instructions: "Continue in your browser",
        });
        const account = await callbacks.onPrompt({
          message: "Account name",
          placeholder: "name",
        });
        callbacks.onProgress?.(`selected ${account}`);
        return { refresh: "refresh-secret", access: "expired-secret", expires: 1 };
      },
      async refreshToken(credentials) {
        refreshCount += 1;
        return { ...credentials, access: "fresh-secret", expires: future };
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    };
    registerSparkOAuthProvider(oauthProvider);
    const control = createSparkProviderControl({
      sparkHome,
      providerSpecs: ["oauth-plugin"],
      importer: providerImporter,
      env: {},
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });

    const started = await control.startOAuth("oauth-provider");
    assert.equal(started.providerId, "test-oauth-control");
    assert.equal(started.phase, "waiting_for_input");
    assert.equal(started.auth?.url, "https://oauth.test/authorize");
    assert.equal(started.prompt?.kind, "text");
    assert.doesNotMatch(JSON.stringify(started), /refresh-secret|expired-secret/u);

    control.respondOAuth(started.id, started.prompt!.id, "fixture-account");
    const complete = await waitForTerminal(control, started.id);
    assert.equal(complete.phase, "complete");
    assert.doesNotMatch(JSON.stringify(complete), /refresh-secret|expired-secret/u);
    assert.equal(
      (await control.snapshot()).oauthProviders.find((entry) => entry.id === oauthProvider.id)
        ?.configured,
      true,
    );

    await control.prepareModel("oauth-provider/model-oauth");
    assert.equal(refreshCount, 1);
    await control.prepareModel("oauth-provider/model-oauth");
    assert.equal(refreshCount, 1);

    const authFile = JSON.parse(await readFile(join(sparkHome, "auth.json"), "utf8")) as {
      credentials: Record<string, { credentials?: { access?: string } }>;
    };
    assert.equal(authFile.credentials[oauthProvider.id]?.credentials?.access, "fresh-secret");

    assert.equal(await control.logout("oauth-provider"), true);
    const cancelled = await control.startOAuth("oauth-provider");
    assert.equal(control.cancelOAuth(cancelled.id).phase, "cancelled");
    assert.equal((await waitForTerminal(control, cancelled.id)).phase, "cancelled");
    assert.equal(
      (await control.snapshot()).oauthProviders.find((entry) => entry.id === oauthProvider.id)
        ?.configured,
      false,
    );
    await assert.rejects(
      control.prepareModel("oauth-provider/model-oauth"),
      /No authentication configured for Spark provider "oauth-provider"/u,
    );
  });
});

async function waitForTerminal(
  control: ReturnType<typeof createSparkProviderControl>,
  flowId: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = control.oauthStatus(flowId);
    if (snapshot && ["complete", "failed", "cancelled"].includes(snapshot.phase)) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`OAuth flow ${flowId} did not finish`);
}
