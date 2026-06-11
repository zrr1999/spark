import assert from "node:assert/strict";
import { test } from "node:test";

import registerBaiduOneApiProvider, {
  remapBaiduOneApiPayload,
  resolveBaiduOneApiKey,
  streamBaiduOneApi,
} from "../packages/spark-cli/src/baidu-oneapi-provider.ts";
import { parseSparkCliArgs } from "../packages/spark-cli/src/cli.ts";
import { SparkNativeSession } from "../packages/spark-cli/src/native-tui.ts";
import sparkCliHostExtension from "../packages/spark-cli/src/spark-host-extension.ts";

void test("parseSparkCliArgs treats positional args as the initial message", () => {
  assert.deepEqual(parseSparkCliArgs(["hello", "spark"]), {
    help: false,
    initialMessage: "hello spark",
  });
});

void test("parseSparkCliArgs recognizes help", () => {
  assert.deepEqual(parseSparkCliArgs(["--help"]), { help: true });
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
      reasoning: boolean;
      api?: string;
      baseUrl?: string;
      thinkingLevelMap?: Record<string, string | null>;
    }>;
    streamSimple: unknown;
  };

  assert.equal(registeredName, "baidu-oneapi");
  assert.equal(config.api, "anthropic-messages");
  assert.equal(config.streamSimple, streamBaiduOneApi);
  assert.deepEqual(
    config.models.map((model) => [model.id, model.reasoning, model.api]),
    [
      ["claude-opus-4.6", true, undefined],
      ["claude-opus-4.7", true, undefined],
      ["claude-opus-4.8", true, undefined],
      ["claude-fable-5", true, undefined],
      ["gpt-5.5", true, "openai-responses"],
      ["gpt-5.5-coding-plan", true, "openai-responses"],
    ],
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
  assert.equal(
    config.models.find((model) => model.id === "gpt-5.5")?.baseUrl,
    "https://oneapi-comate.baidu-int.com/v1",
  );
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

void test("Spark CLI host routes ordinary input through /spark with follow-up queueing", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sent: Array<{ content: string; options: unknown }> = [];
  sparkCliHostExtension({
    on: (event, handler) => handlers.set(event, handler),
    sendUserMessage: (content, options) => sent.push({ content, options }),
    isIdle: () => true,
  });

  const result = handlers.get("input")?.({ text: "build the CLI", source: "interactive" }, {});

  assert.deepEqual(result, { action: "handled" });
  assert.deepEqual(sent, [
    {
      content: "/spark build the CLI",
      options: { deliverAs: "followUp", streamingBehavior: "followUp" },
    },
  ]);
});

void test("Spark native session queues follow-ups while processing", async () => {
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
  assert.deepEqual(calls, ["first", "second"]);
});

void test("Spark CLI host preserves slash commands and shell input", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sent: string[] = [];
  sparkCliHostExtension({
    on: (event, handler) => handlers.set(event, handler),
    sendUserMessage: (content) => sent.push(content),
    isIdle: () => true,
  });

  assert.deepEqual(handlers.get("input")?.({ text: "/plan x", source: "interactive" }, {}), {
    action: "continue",
  });
  assert.deepEqual(handlers.get("input")?.({ text: "!git status", source: "interactive" }, {}), {
    action: "continue",
  });
  assert.deepEqual(sent, []);
});
