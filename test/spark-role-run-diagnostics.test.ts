import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSparkHeadlessRoleExecutor } from "../apps/spark-tui/src/headless-role-executor.ts";
import {
  createSparkCliHostServices,
  type SparkCliHostServicesOptions,
  type SparkConfig,
} from "../apps/spark-tui/src/host/index.ts";
import { buildRoleRunFailureDiagnostic } from "../packages/spark-runtime/src/index.ts";

type AssistantMessage = any;

void test("empty-output anonymous role run failure records diagnostic artifact", () => {
  const diagnostic = buildRoleRunFailureDiagnostic({
    result: {
      record: {
        ref: "run:empty-output" as any,
        roleRef: "role:builtin-reviewer" as any,
        instruction: "review",
        status: "failed",
        launch: "fresh",
        model: "fake/model",
        noSession: true,
        sessionPersistence: "anonymous",
      },
      stdout: "",
      stderr: "",
      jsonEvents: [],
    },
    executorKind: "daemon-native",
    modelSelector: "fake/model",
    exitOrTimeout: "exit 1",
  });

  assert.equal(diagnostic.failureCategory, "empty_output");
  assert.equal(diagnostic.executorKind, "daemon-native");
  assert.equal(diagnostic.modelSelector, "fake/model");
  assert.equal(diagnostic.launch, "fresh");
  assert.equal(diagnostic.exitOrTimeout, "exit 1");
  assert.equal(diagnostic.sessionPersistence, "anonymous");
  assert.match(diagnostic.nextAction, /executor produced no stdout/);
});

void test("native model parity diagnostic reports provider mismatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-model-parity-diagnostic-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
    });

    const result = await executeRole({
      role: { ref: "role:builtin-reviewer", id: "reviewer", systemPrompt: "You are a reviewer." },
      instruction: { roleRef: "role:builtin-reviewer", instruction: "model mismatch" },
      record: {
        ref: "run:model-mismatch",
        roleRef: "role:builtin-reviewer",
        instruction: "model mismatch",
        status: "queued",
        noSession: true,
      },
      cwd,
      timeoutMs: 1_000,
      noSession: true,
      model: "openai-codex/gpt-5.5",
    });

    assert.equal(result.record.status, "failed");
    const eventText = JSON.stringify(result.jsonEvents);
    assert.match(eventText, /provider_resolution_failed/);
    assert.match(eventText, /openai-codex\/gpt-5\.5/);
    assert.match(eventText, /native Spark provider registry/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("role-run diagnostic output redacts secrets", () => {
  const diagnostic = buildRoleRunFailureDiagnostic({
    result: {
      record: {
        ref: "run:secret" as any,
        roleRef: "role:builtin-reviewer" as any,
        instruction: "review",
        status: "failed",
        launch: "fresh",
        sessionPersistence: "anonymous",
      },
      stdout: "",
      stderr: "",
      jsonEvents: [],
    },
    executorKind: "daemon-native",
    modelSelector: "api_key=sk-test-secret token=tok-secret bearer=Bearer abc123",
    exitOrTimeout: "token=tok-secret",
  });
  const text = JSON.stringify(diagnostic);
  assert.doesNotMatch(text, /sk-test-secret|tok-secret|Bearer abc123/);
  assert.match(text, /<redacted>/);
});

void test("anonymous diagnostics do not add persistent session selector entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-anon-diagnostics-selector-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const services = await makeFakeServices({ cwd, sparkHome });
    const before = await listSessionFileNames(services.sessionStore.sessionDir);
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
    });

    await executeRole({
      role: { ref: "role:builtin-reviewer", id: "reviewer", systemPrompt: "You are a reviewer." },
      instruction: { roleRef: "role:builtin-reviewer", instruction: "diagnostic mismatch" },
      record: {
        ref: "run:diagnostic-anonymous",
        roleRef: "role:builtin-reviewer",
        instruction: "diagnostic mismatch",
        status: "queued",
        noSession: true,
      },
      cwd,
      timeoutMs: 1_000,
      noSession: true,
      model: "openai-codex/gpt-5.5",
    });

    const after = await listSessionFileNames(services.sessionStore.sessionDir);
    assert.deepEqual(after, before);
    assert.deepEqual(await services.sessionStore.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function listSessionFileNames(sessionDir: string): Promise<string[]> {
  try {
    return (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function makeFakeServices(options: SparkCliHostServicesOptions) {
  const config: SparkConfig = {
    extensions: [],
    providers: ["fake-provider"],
  };
  if (options.sparkHome) {
    await mkdir(options.sparkHome, { recursive: true });
    await writeFile(join(options.sparkHome, "config.json"), `${JSON.stringify(config)}\n`, "utf8");
  }
  return await createSparkCliHostServices({
    ...options,
    config,
    extensions: [],
    providers: ["fake-provider"],
    providerImporter: async () => fakeProviderModule(),
  });
}

function fakeProviderModule() {
  return {
    default(api: { registerProvider(name: string, config: unknown): void }) {
      api.registerProvider("fake-provider", {
        name: "Fake Provider",
        baseUrl: "https://fake.test",
        api: "openai-completions",
        streamSimple: (_model: unknown, context: { messages?: unknown[] }) => {
          const message = assistant(`count:${context.messages?.length ?? 0}`);
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "done", reason: "stop", message };
            },
            result: async () => message,
          };
        },
        models: [
          {
            id: "fake-model",
            name: "Fake Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 4096,
          },
        ],
      });
    },
  };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake-provider",
    model: "fake-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
