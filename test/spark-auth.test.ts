import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderSparkFirstRunOnboarding } from "../apps/spark-tui/src/cli/onboarding.ts";
import { createSparkPiParitySlashCommands } from "../apps/spark-tui/src/cli/pi-parity-commands.ts";
import type { SparkDaemonModelAuthClient } from "../apps/spark-tui/src/cli/model-control.ts";
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
import {
  createProviderRegistryStreamFunction,
  registerCursorProvider,
} from "../packages/spark-ai/src/index.ts";
import type {
  SparkAuthFlow,
  SparkModelControlSnapshot,
} from "../packages/spark-protocol/src/index.ts";

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

function daemonAuthClient(
  snapshot: SparkModelControlSnapshot,
  overrides: Partial<SparkDaemonModelAuthClient> = {},
): SparkDaemonModelAuthClient {
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected daemon auth call");
  };
  return {
    snapshot: async () => snapshot,
    setDefaultModel: async () => snapshot,
    setApiKey: async () => snapshot,
    logout: async () => false,
    startOAuth: unsupported,
    oauthStatus: unsupported,
    respondOAuth: unsupported,
    cancelOAuth: unsupported,
    ...overrides,
  };
}

function authSnapshot(
  provider: SparkModelControlSnapshot["providers"][number],
): SparkModelControlSnapshot {
  return { providers: [provider], diagnostics: [] };
}

function authFlow(input: Partial<SparkAuthFlow> & Pick<SparkAuthFlow, "status">): SparkAuthFlow {
  const { status, ...rest } = input;
  return {
    id: "flow-1",
    providerName: "test-oauth",
    status,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    progress: [],
    ...rest,
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

void test("SparkProviderAuthResolver resolves Cursor env and stored API keys without status leakage", async () => {
  await withAuthDir(async (_dir, authPath) => {
    const registry = new SparkProviderRegistry();
    await registerCursorProvider(registry, { apiKey: "" });
    const provider = registry.getProvider("cursor")!;
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();

    const envResolver = new SparkProviderAuthResolver(store, {
      env: { CURSOR_API_KEY: "cursor-env-fixture-value" },
    });
    assert.deepEqual(envResolver.status(provider), {
      provider: "cursor",
      kind: "env",
      configured: true,
      ref: "CURSOR_API_KEY",
    });
    assert.equal(envResolver.resolveApiKey(provider), "cursor-env-fixture-value");
    assert.doesNotMatch(JSON.stringify(envResolver.status(provider)), /cursor-env-fixture-value/u);

    const storedResolver = new SparkProviderAuthResolver(store, { env: {} });
    assert.equal(storedResolver.status(provider).configured, false);
    await store.set("cursor", {
      type: "api_key",
      provider: "cursor",
      apiKey: "cursor-stored-fixture-value",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    assert.equal(storedResolver.resolveApiKey(provider), "cursor-stored-fixture-value");
    assert.deepEqual(storedResolver.status(provider), {
      provider: "cursor",
      kind: "env",
      configured: true,
      ref: "CURSOR_API_KEY",
    });
    assert.doesNotMatch(
      JSON.stringify(storedResolver.status(provider)),
      /cursor-stored-fixture-value/u,
    );
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

void test("native /login api-key stores a provider key without echoing the secret", async () => {
  await withAuthDir(async (dir, authPath) => {
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const authResolver = new SparkProviderAuthResolver(store);
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("oauth-provider", providerConfig("MISSING_KEY"));
    providerRegistry.setActive({ providerName: "oauth-provider", modelId: "model-a" });
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
    const context = { app: {} as never, session: new SparkNativeSession(), exit: () => undefined };

    const loginResult = await commands.login!.handler(
      "api-key oauth-provider stored-secret",
      context,
    );
    assert.match(String(loginResult), /Stored API key for Spark provider: oauth-provider/);
    assert.doesNotMatch(String(loginResult), /stored-secret/);
    assert.equal(store.get("oauth-provider")?.type, "api_key");
    assert.equal(authResolver.resolveApiKey(providerConfig("MISSING_KEY")), "stored-secret");
    assert.equal(modelRegistry.getAvailable().length, 1);
  });
});

void test("first-run onboarding renders a no-credential setup guide", async () => {
  await withAuthDir(async (dir, authPath) => {
    const store = new SparkAuthStore({ path: authPath });
    await store.reload();
    const authResolver = new SparkProviderAuthResolver(store);
    const providerRegistry = new SparkProviderRegistry();
    providerRegistry.registerProvider("oauth-provider", providerConfig("MISSING_KEY"));
    providerRegistry.setActive({ providerName: "oauth-provider", modelId: "model-a" });
    const services = {
      cwd: dir,
      config: { extensions: [], providers: [] },
      runtime: new SparkHostRuntime({ cwd: dir }),
      providerRegistry,
      authStore: store,
      authResolver,
      diagnostics: [],
    } as unknown as SparkCliHostServices;

    const message = renderSparkFirstRunOnboarding(services);
    assert.match(message ?? "", /Spark first-run setup/);
    assert.match(message ?? "", /Missing credentials for oauth-provider/);
    assert.match(message ?? "", /\/login api-key <provider> <key>/);
    assert.match(message ?? "", /\/model \[provider\/model\]/);

    await store.set("oauth-provider", {
      type: "api_key",
      provider: "oauth-provider",
      apiKey: "stored-secret",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    assert.equal(renderSparkFirstRunOnboarding(services), undefined);
  });
});

void test("daemon-backed /login stores API keys without exposing them in the transcript", async () => {
  const snapshot = authSnapshot({
    providerName: "cursor",
    label: "Cursor",
    auth: { providerName: "cursor", kind: "api_key", configured: false },
    models: [],
  });
  const stored: Array<{ providerName: string; apiKey: string }> = [];
  const client = daemonAuthClient(snapshot, {
    setApiKey: async (providerName, apiKey) => {
      stored.push({ providerName, apiKey });
      return snapshot;
    },
  });
  const runtime = new SparkHostRuntime({
    cwd: "/tmp/spark-daemon-api-key-login",
    hasUI: true,
    ui: { input: async () => "daemon-api-key-secret" },
  });
  const services = {
    cwd: runtime.cwd,
    runtime,
    diagnostics: [],
  } as unknown as SparkCliHostServices;
  const commands = createSparkPiParitySlashCommands(services, client);
  const session = new SparkNativeSession(async () => "unused");
  const result = await commands.login!.handler("cursor", {
    app: {} as never,
    session,
    exit: () => undefined,
  });

  assert.deepEqual(stored, [{ providerName: "cursor", apiKey: "daemon-api-key-secret" }]);
  assert.match(String(result), /Stored API key for Cursor/);
  assert.doesNotMatch(String(result), /daemon-api-key-secret/);
  assert.doesNotMatch(
    session.messages.map((message) => message.text).join("\n"),
    /daemon-api-key-secret/,
  );
});

void test("daemon-backed /login drives OAuth status and prompts through daemon RPC", async () => {
  const snapshot = authSnapshot({
    providerName: "oauth-models",
    label: "OAuth Models",
    auth: {
      providerName: "oauth-models",
      kind: "oauth",
      configured: false,
      reference: "test-oauth",
    },
    models: [],
  });
  const statusCalls: string[] = [];
  const responses: Array<{ flowId: string; promptId: string; value: string }> = [];
  const client = daemonAuthClient(snapshot, {
    startOAuth: async (providerName) => {
      assert.equal(providerName, "test-oauth");
      return authFlow({
        status: "pending",
        authorization: { url: "https://oauth.test/authorize" },
        deviceCode: {
          userCode: "ABCD-EFGH",
          verificationUri: "https://oauth.test/device",
        },
        progress: ["waiting for authorization"],
      });
    },
    oauthStatus: async (flowId) => {
      statusCalls.push(flowId);
      return authFlow({
        status: "waiting_for_user",
        prompt: {
          id: "prompt-1",
          kind: "select",
          message: "Choose an account",
          options: [
            { id: "work", label: "Work" },
            { id: "personal", label: "Personal" },
          ],
        },
        progress: ["waiting for authorization", "authorization accepted"],
      });
    },
    respondOAuth: async (flowId, promptId, value) => {
      responses.push({ flowId, promptId, value });
      return authFlow({ status: "succeeded", progress: ["authorization accepted"] });
    },
  });
  const runtime = new SparkHostRuntime({
    cwd: "/tmp/spark-daemon-oauth-login",
    hasUI: true,
    ui: { select: async () => "Work (work)" },
  });
  const services = {
    cwd: runtime.cwd,
    runtime,
    diagnostics: [],
  } as unknown as SparkCliHostServices;
  const commands = createSparkPiParitySlashCommands(services, client);
  const session = new SparkNativeSession(async () => "unused");
  const result = await commands.login!.handler("oauth-models", {
    app: {} as never,
    session,
    exit: () => undefined,
  });

  assert.deepEqual(statusCalls, ["flow-1"]);
  assert.deepEqual(responses, [{ flowId: "flow-1", promptId: "prompt-1", value: "work" }]);
  assert.match(String(result), /Logged in OAuth provider: OAuth Models/);
  const transcript = session.messages.map((message) => message.text).join("\n");
  assert.match(transcript, /https:\/\/oauth\.test\/authorize/);
  assert.match(transcript, /ABCD-EFGH/);
  assert.match(transcript, /authorization accepted/);
});

void test("daemon-backed /login cancels OAuth when interactive input is dismissed", async () => {
  const snapshot = authSnapshot({
    providerName: "test-oauth",
    label: "Test OAuth",
    auth: {
      providerName: "test-oauth",
      kind: "oauth",
      configured: false,
      reference: "test-oauth",
    },
    models: [],
  });
  const cancelled: string[] = [];
  const client = daemonAuthClient(snapshot, {
    startOAuth: async () =>
      authFlow({
        status: "waiting_for_user",
        prompt: {
          id: "prompt-1",
          kind: "manual_code",
          message: "Paste the authorization code",
        },
      }),
    cancelOAuth: async (flowId) => {
      cancelled.push(flowId);
      return authFlow({ status: "cancelled" });
    },
  });
  const runtime = new SparkHostRuntime({
    cwd: "/tmp/spark-daemon-oauth-cancel",
    hasUI: true,
    ui: { input: async () => undefined },
  });
  const services = {
    cwd: runtime.cwd,
    runtime,
    diagnostics: [],
  } as unknown as SparkCliHostServices;
  const commands = createSparkPiParitySlashCommands(services, client);
  const session = new SparkNativeSession(async () => "unused");
  const result = await commands.login!.handler("test-oauth", {
    app: {} as never,
    session,
    exit: () => undefined,
  });

  assert.deepEqual(cancelled, ["flow-1"]);
  assert.match(String(result), /OAuth login cancelled for Test OAuth/);
});

void test("daemon-backed /logout removes the OAuth credential reference", async () => {
  const snapshot = authSnapshot({
    providerName: "oauth-models",
    label: "OAuth Models",
    auth: {
      providerName: "oauth-models",
      kind: "oauth",
      configured: true,
      source: "stored",
      reference: "test-oauth",
    },
    models: [],
  });
  const removed: string[] = [];
  const client = daemonAuthClient(snapshot, {
    logout: async (providerName) => {
      removed.push(providerName);
      return true;
    },
  });
  const services = {
    cwd: "/tmp/spark-daemon-oauth-logout",
    runtime: new SparkHostRuntime({ cwd: "/tmp/spark-daemon-oauth-logout" }),
    diagnostics: [],
  } as unknown as SparkCliHostServices;
  const commands = createSparkPiParitySlashCommands(services, client);
  const result = await commands.logout!.handler("oauth-models", {
    app: {} as never,
    session: new SparkNativeSession(async () => "unused"),
    exit: () => undefined,
  });

  assert.deepEqual(removed, ["test-oauth"]);
  assert.match(String(result), /Removed stored Spark credential: test-oauth/);
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
