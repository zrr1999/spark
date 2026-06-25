import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeRouteModel,
  resolveSparkModelMessageIdentity,
  retagAssistantMessage,
  retagAssistantMessageEvent,
  retagAssistantMessageStream,
  type ProviderRoute,
  type SparkAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type SparkModelProfile,
  type Usage,
} from "@zendev-lab/spark-ai";

const zeroUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function sampleProfile(): SparkModelProfile {
  return {
    id: "claude-opus-4.8",
    name: "Claude Opus 4.8",
    identity: {
      api: "baidu-oneapi",
      provider: "baidu-oneapi",
      model: "claude-opus-4.8",
    },
    capabilities: {
      input: ["text", "image"],
      reasoning: true,
      toolUse: true,
    },
    cost: {
      input: 5.5,
      output: 27.5,
      cacheRead: 0.55,
      cacheWrite: 6.875,
    },
    contextWindow: 300_000,
    maxTokens: 32_000,
    thinkingLevelMap: {
      low: "low",
      xhigh: "xhigh",
    },
    routes: [
      {
        id: "baidu-anthropic-primary",
        provider: "baidu-oneapi",
        label: "Baidu Anthropic transport",
        priority: 10,
        transportApi: "anthropic-messages",
        transportModelId: "Opus 4.8 Coding Plan",
        baseUrl: "https://gateway.example.test/v1/messages",
        authPoolId: "baidu-primary",
        headers: {
          "x-route": "anthropic",
        },
      },
      {
        id: "baidu-openai-primary",
        provider: "baidu-oneapi",
        priority: 20,
        transportApi: "openai-responses",
        transportModelId: "gpt-5.5-coding-plan",
        baseUrl: "https://gateway.example.test/v1/responses",
        authPoolId: "baidu-primary",
      },
    ],
    authPools: [
      {
        id: "baidu-primary",
        slots: [
          {
            id: "baidu-main",
            priority: 10,
            authRef: { kind: "env", name: "BAIDU_ONEAPI_API_KEY" },
          },
        ],
      },
    ],
  };
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "Opus 4.8 Coding Plan",
    usage: zeroUsage,
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function fakeStream(
  events: AssistantMessageEvent[],
  result: AssistantMessage,
): SparkAssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    async result() {
      return result;
    },
  };
}

function assertApi<TApi extends Api>(model: Model<TApi>, expected: TApi): void {
  if (model.api !== expected) throw new Error(`Mismatched api: ${model.api} expected ${expected}`);
}

void test("materializeRouteModel uses the route transport API and model id", () => {
  const profile = sampleProfile();
  const route = profile.routes[0] as ProviderRoute<"anthropic-messages">;

  const model = materializeRouteModel(profile, route);

  assert.equal(model.id, "Opus 4.8 Coding Plan");
  assert.equal(model.name, "Claude Opus 4.8 (Baidu Anthropic transport)");
  assert.equal(model.api, "anthropic-messages");
  assert.equal(model.provider, "baidu-oneapi");
  assert.equal(model.baseUrl, "https://gateway.example.test/v1/messages");
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 300_000);
  assert.equal(model.maxTokens, 32_000);
  assert.deepEqual(model.cost, profile.cost);
  assert.deepEqual(model.thinkingLevelMap, profile.thinkingLevelMap);
  assert.deepEqual(model.headers, { "x-route": "anthropic" });
  assert.doesNotThrow(() => assertApi(model, "anthropic-messages"));
});

void test("materializeRouteModel supports openai-responses routes", () => {
  const profile = sampleProfile();
  const route = profile.routes[1] as ProviderRoute<"openai-responses">;

  const model = materializeRouteModel(profile, route);

  assert.equal(model.id, "gpt-5.5-coding-plan");
  assert.equal(model.api, "openai-responses");
  assert.equal(model.provider, "baidu-oneapi");
  assert.equal(model.baseUrl, "https://gateway.example.test/v1/responses");
  assert.doesNotThrow(() => assertApi(model, "openai-responses"));
});

void test("materializeRouteModel rejects routes that are not in the profile", () => {
  const profile = sampleProfile();
  const route: ProviderRoute<"anthropic-messages"> = {
    id: "foreign-route",
    provider: "baidu-oneapi",
    priority: 1,
    transportApi: "anthropic-messages",
    transportModelId: "foreign-model",
    baseUrl: "https://gateway.example.test/v1/messages",
    authPoolId: "baidu-primary",
  };

  assert.throws(
    () => materializeRouteModel(profile, route),
    /route foreign-route does not belong to Spark model profile: claude-opus-4\.8/u,
  );
});

void test("retag helpers restore Spark-facing assistant identity", async () => {
  const profile = sampleProfile();
  const identity = resolveSparkModelMessageIdentity(profile);
  const transportMessage = assistantMessage();

  assert.deepEqual(identity, {
    api: "baidu-oneapi",
    provider: "baidu-oneapi",
    model: "claude-opus-4.8",
  });
  assert.deepEqual(retagAssistantMessage(transportMessage, identity), {
    ...transportMessage,
    api: "baidu-oneapi",
    provider: "baidu-oneapi",
    model: "claude-opus-4.8",
  });

  const startEvent: AssistantMessageEvent = { type: "start", partial: transportMessage };
  const doneEvent: AssistantMessageEvent = {
    type: "done",
    reason: "stop",
    message: transportMessage,
  };
  const errorEvent: AssistantMessageEvent = {
    type: "error",
    reason: "error",
    error: assistantMessage({ stopReason: "error", errorMessage: "No API key for provider" }),
  };

  const retaggedStart = retagAssistantMessageEvent(startEvent, identity);
  const retaggedDone = retagAssistantMessageEvent(doneEvent, identity);
  const retaggedError = retagAssistantMessageEvent(errorEvent, identity);
  assert.equal(retaggedStart.type, "start");
  assert.equal(retaggedStart.partial.api, "baidu-oneapi");
  assert.equal(retaggedDone.type, "done");
  assert.equal(retaggedDone.message.provider, "baidu-oneapi");
  assert.equal(retaggedError.type, "error");
  assert.equal(retaggedError.error.model, "claude-opus-4.8");

  const stream = retagAssistantMessageStream(
    fakeStream([startEvent, doneEvent], transportMessage),
    identity,
  );
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);

  const first = events[0];
  const second = events[1];
  assert.equal(first?.type, "start");
  if (first?.type === "start") assert.equal(first.partial.api, "baidu-oneapi");
  assert.equal(second?.type, "done");
  if (second?.type === "done") assert.equal(second.message.model, "claude-opus-4.8");
  assert.equal((await stream.result()).provider, "baidu-oneapi");
});

void test("default retag identity is model-only spark-ai", () => {
  const profile = sampleProfile();
  delete profile.identity;

  assert.deepEqual(resolveSparkModelMessageIdentity(profile), {
    api: "spark-ai",
    provider: "spark-ai",
    model: "claude-opus-4.8",
  });
});
