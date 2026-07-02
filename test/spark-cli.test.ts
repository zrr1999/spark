import assert from "node:assert/strict";
import { test } from "node:test";

import registerBaiduOneApiProvider, {
  remapBaiduOneApiPayload,
  resolveBaiduOneApiKey,
  streamBaiduOneApi,
  streamBaiduOneApiAnthropic,
  streamBaiduOneApiOpenAIResponses,
} from "../packages/spark-ai/src/baidu-oneapi-provider.ts";
import {
  handleSparkRpcLine,
  parseSparkCliArgs,
  runSparkCli,
  type SparkRpcState,
} from "../apps/spark-tui/src/cli.ts";
import type { SparkDaemonClientOptions } from "../apps/spark-tui/src/cli/daemon.ts";
import { SparkNativeSession } from "../apps/spark-tui/src/native-tui.ts";
import sparkCliHostExtension from "../apps/spark-tui/src/spark-host-extension.ts";

void test("parseSparkCliArgs treats positional args as the initial message", () => {
  assert.deepEqual(parseSparkCliArgs(["hello", "spark"]), {
    help: false,
    initialMessage: "hello spark",
  });
});

void test("runSparkCli rejects implicit TUI launch in non-interactive terminals", async () => {
  const errors: string[] = [];
  const previousError = console.error;
  let ranTui = false;
  try {
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    const code = await runSparkCli([], {
      terminal: { stdinIsTTY: false, stdoutIsTTY: true },
      runTui: async () => {
        ranTui = true;
      },
    });

    assert.equal(code, 2);
    assert.equal(ranTui, false);
    assert.match(errors.join("\n"), /requires an interactive terminal/u);
    assert.match(errors.join("\n"), /spark-tui --print <prompt>/u);
  } finally {
    console.error = previousError;
  }
});

void test("runSparkCli keeps explicit print mode usable without an interactive terminal", async () => {
  const logs: string[] = [];
  const submissions: Array<{ sessionId: string; prompt: string; reset?: boolean }> = [];
  const previousLog = console.log;
  const now = new Date(0).toISOString();
  const workspace = {
    id: "ws_test",
    serverUrl: "http://127.0.0.1:0",
    localWorkspaceKey: "repo",
    displayName: "repo",
    localPath: process.cwd(),
    status: "active",
  };
  const clientLease = {
    id: "client_test",
    workspaceId: workspace.id,
    kind: "headless" as const,
    status: "connected" as const,
    attachedAt: now,
    lastSeenAt: now,
  };
  const daemonClient = {
    daemonStatus: async () => ({
      observedAt: now,
      servers: [],
      queue: { inbox: 0, processed: 0, failed: 0 },
    }),
    workspaceEnsureLocal: async () => workspace,
    workspaceClientAttach: async () => ({ client: clientLease, workspace, observedAt: now }),
    workspaceClientRelease: async () => ({ client: clientLease, workspace, observedAt: now }),
    turnSubmit: async (_paths, input) => {
      submissions.push(input);
      return {
        fileName: "turn.json",
        filePath: "/tmp/turn.json",
        task: {
          type: "session.run" as const,
          sessionId: input.sessionId,
          prompt: input.prompt,
          ...(input.reset === undefined ? {} : { reset: input.reset }),
        },
        observedAt: now,
      };
    },
  } satisfies SparkDaemonClientOptions;

  try {
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    const code = await runSparkCli(["--print", "hello", "spark"], {
      daemonClient,
      terminal: { stdinIsTTY: false, stdoutIsTTY: false },
    });

    assert.equal(code, 0);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.prompt, "hello spark");
    assert.match(logs.join("\n"), /turn\.json/u);
  } finally {
    console.log = previousLog;
  }
});

void test("handleSparkRpcLine abort cancels the last submitted daemon turn", async () => {
  const writes: Record<string, unknown>[] = [];
  const submissions: Array<{ sessionId: string; prompt: string; reset?: boolean }> = [];
  const cancellations: Array<{ invocationId: string; reason?: string }> = [];
  const now = new Date(0).toISOString();
  const daemonClient = {
    daemonStatus: async () => ({
      observedAt: now,
      servers: [],
      queue: { inbox: 0, processed: 0, failed: 0 },
    }),
    turnSubmit: async (_paths, input) => {
      submissions.push(input);
      return {
        fileName: "turn-file.json",
        filePath: "/tmp/turn-file.json",
        task: { type: "session.run" as const, ...input },
        observedAt: now,
      };
    },
    turnCancel: async (_paths, input) => {
      cancellations.push(input);
      return {
        invocationId: input.invocationId,
        cancelled: true,
        message: `Cancellation signalled for ${input.invocationId}`,
        observedAt: now,
      };
    },
  } satisfies SparkDaemonClientOptions;
  const state: SparkRpcState = {};

  await handleSparkRpcLine(
    JSON.stringify({ id: "prompt-1", type: "prompt", message: "do work" }),
    daemonClient,
    { sessionId: "rpc-session" },
    (value) => writes.push(value),
    state,
  );
  await handleSparkRpcLine(
    JSON.stringify({ id: "abort-1", type: "abort" }),
    daemonClient,
    { sessionId: "rpc-session" },
    (value) => writes.push(value),
    state,
  );

  assert.deepEqual(submissions, [
    { sessionId: "rpc-session", prompt: "do work", reset: undefined },
  ]);
  assert.deepEqual(cancellations, [
    { invocationId: "turn-file.json", reason: "Spark RPC abort requested by client." },
  ]);
  assert.equal(writes.at(-1)?.success, true);
  assert.deepEqual(writes.at(-1)?.data, {
    invocationId: "turn-file.json",
    cancelled: true,
    message: "Cancellation signalled for turn-file.json",
    observedAt: now,
  });
});

void test("handleSparkRpcLine abort reports no target without an invocation", async () => {
  const writes: Record<string, unknown>[] = [];
  await handleSparkRpcLine(
    JSON.stringify({ id: "abort-missing", type: "abort" }),
    {},
    undefined,
    (value) => writes.push(value),
  );

  assert.equal(writes[0]?.success, false);
  assert.match(String(writes[0]?.error), /abort requires invocationId/u);
});

void test("Baidu OneAPI provider uses local adaptive-friendly model ids", () => {
  let registeredName: string | undefined;
  let registeredConfig: unknown;

  registerBaiduOneApiProvider({
    registerProvider(name: string, config: unknown) {
      registeredName = name;
      registeredConfig = config;
    },
  });

  const config = registeredConfig as {
    api: string;
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
      api?: string;
      transportModelId?: string;
      baseUrl?: string;
      aliases?: string[];
      thinkingLevelMap?: Record<string, string | null>;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    }>;
    streamSimple: unknown;
  };

  assert.equal(registeredName, "baidu-oneapi");
  assert.equal(config.api, "baidu-oneapi");
  assert.equal(config.streamSimple, streamBaiduOneApi);
  assert.deepEqual(
    config.models.map((model) => [model.id, model.name, model.reasoning, model.api]),
    [
      ["claude-opus-4.6", "Claude Opus 4.6", true, undefined],
      ["claude-opus-4.7", "Claude Opus 4.7", true, undefined],
      ["claude-opus-4.8", "Claude Opus 4.8", true, undefined],
      ["claude-fable-5", "Claude Fable 5", true, undefined],
      ["gpt-5.5", "GPT-5.5", true, undefined],
    ],
  );
  assert.equal(
    config.models.find((model) => model.id === "gpt-5.5")?.transportModelId,
    "gpt-5.5-coding-plan",
  );
  assert.deepEqual(
    config.models.find((model) => model.id === "claude-opus-4.8")?.thinkingLevelMap,
    {
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: "xhigh",
    },
  );
  assert.deepEqual(config.models.find((model) => model.id === "claude-fable-5")?.thinkingLevelMap, {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  });
  assert.deepEqual(config.models.find((model) => model.id === "gpt-5.5")?.thinkingLevelMap, {
    minimal: "low",
    xhigh: "xhigh",
  });
  assert.deepEqual(config.models.find((model) => model.id === "gpt-5.5")?.aliases, [
    "gpt-5.5-coding-plan",
  ]);
  assert.equal(
    config.models.find((model) => model.id === "gpt-5.5")?.baseUrl,
    "https://oneapi-comate.baidu-int.com/v1",
  );
  assert.deepEqual(config.models.find((model) => model.id === "gpt-5.5")?.cost, {
    input: 0.5,
    output: 3,
    cacheRead: 0.05,
    cacheWrite: 0,
  });
  assert.deepEqual(config.models.find((model) => model.id === "claude-fable-5")?.cost, {
    input: 1.1,
    output: 5.5,
    cacheRead: 0.11,
    cacheWrite: 1.375,
  });
  assert.deepEqual(config.models.find((model) => model.id === "claude-opus-4.6")?.cost, {
    input: 5.5,
    output: 27.5,
    cacheRead: 0.55,
    cacheWrite: 6.875,
  });
});

void test("Baidu OneAPI payload keeps gateway model spelling", () => {
  assert.deepEqual(remapBaiduOneApiPayload({ model: "claude-fable-5", x: 1 }, "Fable 5"), {
    model: "Fable 5",
    x: 1,
  });
});

void test("Baidu OneAPI payload forces adaptive thinking for gateway Opus models", () => {
  assert.deepEqual(
    remapBaiduOneApiPayload(
      {
        model: "claude-opus-4.8",
        thinking: { type: "enabled", budget_tokens: 1024, display: "summarized" },
      },
      "Opus 4.8 Coding Plan",
      "xhigh",
    ),
    {
      model: "Opus 4.8 Coding Plan",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    },
  );
});

void test("Baidu OneAPI key resolver uses only dedicated auth identity", () => {
  const previousBaiduKey = process.env.BAIDU_ONEAPI_API_KEY;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  try {
    delete process.env.BAIDU_ONEAPI_API_KEY;
    process.env.OPENAI_API_KEY = "openai-fallback-key";
    assert.equal(resolveBaiduOneApiKey("BAIDU_ONEAPI_API_KEY"), undefined);
    assert.equal(resolveBaiduOneApiKey(undefined), undefined);
    assert.throws(
      () => resolveBaiduOneApiKey("OPENAI_API_KEY"),
      /baidu-oneapi does not accept OPENAI_API_KEY/,
    );

    process.env.BAIDU_ONEAPI_API_KEY = "baidu-key";
    assert.equal(resolveBaiduOneApiKey("BAIDU_ONEAPI_API_KEY"), "baidu-key");
    assert.equal(resolveBaiduOneApiKey("resolved-key"), "resolved-key");
  } finally {
    if (previousBaiduKey === undefined) delete process.env.BAIDU_ONEAPI_API_KEY;
    else process.env.BAIDU_ONEAPI_API_KEY = previousBaiduKey;

    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
  }
});

void test("Baidu OneAPI adapters use upstream transport APIs but report baidu-oneapi", async () => {
  const context = { messages: [], tools: [] };
  const baseModel = {
    name: "Baidu test model",
    api: "baidu-oneapi",
    provider: "baidu-oneapi",
    baseUrl: "https://oneapi-comate.baidu-int.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
  };

  for (const stream of [
    streamBaiduOneApiAnthropic({ ...baseModel, id: "claude-opus-4.8" } as never, context as never, {
      apiKey: "",
    }),
    streamBaiduOneApiOpenAIResponses(
      { ...baseModel, id: "gpt-5.5", baseUrl: "https://oneapi-comate.baidu-int.com/v1" } as never,
      context as never,
      { apiKey: "" },
    ),
  ]) {
    for await (const _event of stream) void _event;
    const result = await stream.result();
    assert.equal(result.api, "baidu-oneapi");
    assert.equal(result.provider, "baidu-oneapi");
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /No API key for provider: baidu-oneapi/);
    assert.doesNotMatch(result.errorMessage ?? "", /Mismatched api/);
  }
});

void test("Spark CLI host lets ordinary input reach the agent without /spark wrapping", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  sparkCliHostExtension({
    on: (event, handler) => handlers.set(event, handler),
  });

  const result = handlers.get("input")?.({ text: "build the CLI", source: "interactive" }, {});

  assert.deepEqual(result, { action: "continue" });
});

void test("Spark native session queues steering updates while processing", async () => {
  let releaseFirst: ((value: string) => void) | undefined;
  const calls: string[] = [];
  const session = new SparkNativeSession(async (input) => {
    calls.push(input);
    if (input === "first") {
      return await new Promise<string>((resolve) => {
        releaseFirst = resolve;
      });
    }
    return `done ${input}`;
  });

  assert.equal(await session.submit("first"), "started");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.isProcessing, true);

  assert.equal(await session.submit("second"), "queued");
  assert.equal(session.queuedCount, 1);
  assert.deepEqual(calls, ["first"]);

  releaseFirst?.("done first");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.isProcessing, false);
  assert.equal(session.queuedCount, 0);
  assert.equal(calls[0], "first");
  assert.match(calls[1] ?? "", /^Steering update for the previous Spark turn\./);
  assert.match(calls[1] ?? "", /Steering 1:\nsecond/);
});

void test("Spark CLI host preserves slash commands and shell input", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  sparkCliHostExtension({
    on: (event, handler) => handlers.set(event, handler),
  });

  assert.deepEqual(handlers.get("input")?.({ text: "/plan x", source: "interactive" }, {}), {
    action: "continue",
  });
  assert.deepEqual(handlers.get("input")?.({ text: "!git status", source: "interactive" }, {}), {
    action: "continue",
  });
});
