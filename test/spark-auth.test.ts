import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSparkPiParitySlashCommands } from "../apps/spark-tui/src/cli/pi-parity-commands.ts";
import { SparkNativeSession } from "../apps/spark-tui/src/native-tui.ts";
import {
  SparkAuthStore,
  SparkHostModelRegistry,
  SparkHostRuntime,
  SparkProviderAuthResolver,
  SparkProviderRegistry,
  registerSparkOAuthProvider,
  resetSparkOAuthProviders,
  type ProviderConfig,
  type SparkCliHostServices,
  type SparkOAuthProviderInterface,
} from "../apps/spark-tui/src/host/index.ts";
import { createProviderRegistryStreamFunction } from "../packages/spark-ai/src/index.ts";

const oauthCredentials = { refresh: "refresh-token", access: "access-token", expires: 9_999 };

function fakeStream(messageText = "ok") {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: messageText }],
    stopReason: "stop",
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: "stop", message };
    },
    result: async () => message,
  };
}

function providerConfig(apiKey?: string): ProviderConfig {
  return {
    name: "oauth-provider",
    baseUrl: "https://oauth.test",
    apiKey,
    api: "openai-completions",
    streamSimple: () => fakeStream(),
    models: [
      {
        id: "model-a",
        name: "Model A",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      },
    ],
  };
}

function testOAuthProvider(): SparkOAuthProviderInterface {
  return {
    id: "test-oauth",
    name: "Test OAuth",
    async login(callbacks) {
      callbacks.onDeviceCode({
        userCode: "ABCD-EFGH",
        verificationUri: "https://oauth.test/device",
        intervalSeconds: 1,
        expiresInSeconds: 600,
      });
      callbacks.onProgress?.("authorized");
      return oauthCredentials;
    },
    async refreshToken(credentials) {
      return credentials;
    },
    getApiKey(credentials) {
      return credentials.access;
    },
  };
}

async function withAuthDir(fn: (dir: string, authPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spark-auth-"));
  try {
    await mkdir(dir, { recursive: true });
    await fn(dir, join(dir, "auth.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    resetSparkOAuthProviders();
  }
}

void test("SparkAuthStore persists OAuth credentials with restrictive file mode", async () => {
  await withAuthDir(async (_dir, authPath) => {
    const store = new SparkAuthStore({
      path: authPath,
      now: () => new Date("2026-01-02T03:04:05Z"),
    });
    await store.reload();
    assert.deepEqual(store.listProviders(), []);

    await store.setOAuth("test-oauth", oauthCredentials);
    assert.deepEqual(store.listProviders(), ["test-oauth"]);
    assert.equal(store.get("test-oauth")?.type, "oauth");

    const onDisk = JSON.parse(await readFile(authPath, "utf8")) as {
      version: number;
      credentials: Record<string, unknown>;
    };
    assert.equal(onDisk.version, 1);
    assert.equal(typeof onDisk.credentials["test-oauth"], "object");
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);

    const reloaded = new SparkAuthStore({ path: authPath });
    await reloaded.reload();
    assert.equal(reloaded.get("test-oauth")?.type, "oauth");
  });
});

void test("SparkProviderAuthResolver handles env, stored API key, literal, and OAuth provider refs", async () => {
  await withAuthDir(async (_dir, authPath) => {
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const resolver = new SparkProviderAuthResolver(store, { env: { ENV_KEY: "env-secret" } });

    assert.equal(resolver.hasConfiguredAuth(providerConfig("ENV_KEY")), true);
    assert.equal(resolver.resolveApiKey(providerConfig("ENV_KEY")), "env-secret");
    assert.equal(resolver.hasConfiguredAuth(providerConfig("MISSING_KEY")), false);
    await store.set("oauth-provider", {
      type: "api_key",
      provider: "oauth-provider",
      apiKey: "stored-provider-secret",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    assert.equal(resolver.hasConfiguredAuth(providerConfig("MISSING_KEY")), true);
    assert.equal(resolver.resolveApiKey(providerConfig("MISSING_KEY")), "stored-provider-secret");
    assert.equal(resolver.hasConfiguredAuth(providerConfig("literal-secret")), true);
    assert.equal(resolver.resolveApiKey(providerConfig("literal-secret")), "literal-secret");
    assert.equal(resolver.hasConfiguredAuth(providerConfig("oauth:test-oauth")), false);

    registerSparkOAuthProvider(testOAuthProvider());
    await store.setOAuth("test-oauth", oauthCredentials);
    assert.equal(resolver.hasConfiguredAuth(providerConfig("oauth:test-oauth")), true);
    assert.equal(resolver.resolveApiKey(providerConfig("oauth:test-oauth")), "access-token");
  });
});

void test("native /login and /logout mutate Spark auth store and model availability", async () => {
  await withAuthDir(async (dir, authPath) => {
    registerSparkOAuthProvider(testOAuthProvider());
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const authResolver = new SparkProviderAuthResolver(store);
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("oauth-provider", providerConfig("oauth:test-oauth"));
    const modelRegistry = new SparkHostModelRegistry(providerRegistry, { authResolver });
    assert.deepEqual(modelRegistry.getAvailable(), []);

    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime: new SparkHostRuntime({ cwd: dir }),
      providerRegistry,
      authStore: store,
      authResolver,
      modelRegistry,
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    const session = new SparkNativeSession(async () => "unused");
    const context = { app: {} as never, session, exit: () => undefined };

    const loginResult = await commands.login!.handler("test-oauth", context);
    assert.match(String(loginResult), /Logged in OAuth provider: test-oauth/);
    assert.equal(store.has("test-oauth"), true);
    assert.equal(modelRegistry.getAvailable().length, 1);
    assert.match(session.messages.map((message) => message.text).join("\n"), /ABCD-EFGH/);
    assert.doesNotMatch(String(loginResult), /access-token|refresh-token/);

    const logoutResult = await commands.logout!.handler("test-oauth", context);
    assert.match(String(logoutResult), /Removed stored Spark credential/);
    assert.equal(store.has("test-oauth"), false);
    assert.deepEqual(modelRegistry.getAvailable(), []);
  });
});

void test("provider runner injects resolved apiKey without spark-ai depending on auth store", async () => {
  await withAuthDir(async (_dir, authPath) => {
    registerSparkOAuthProvider(testOAuthProvider());
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    await store.setOAuth("test-oauth", oauthCredentials);
    const authResolver = new SparkProviderAuthResolver(store);

    let capturedApiKey: unknown;
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("oauth-provider", {
      ...providerConfig("oauth:test-oauth"),
      streamSimple: (_model, _context, options) => {
        capturedApiKey = options?.apiKey;
        return fakeStream("authed");
      },
    });
    providerRegistry.setActive({ providerName: "oauth-provider", modelId: "model-a" });

    const stream = createProviderRegistryStreamFunction(providerRegistry, {
      resolveApiKey: (provider) => authResolver.resolveApiKey(provider),
    })(providerRegistry.buildActiveModel() as never, { messages: [], tools: [] } as never, {});
    const result = await stream.result();
    assert.equal(capturedApiKey, "access-token");
    assert.deepEqual(result.content[0], { type: "text", text: "authed" });
  });
});
