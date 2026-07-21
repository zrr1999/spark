import assert from "node:assert/strict";
import { test } from "vitest";

import {
  runSparkLeaf,
  resolveLeafModelId,
  SparkModelRegistry,
  SparkRouteResolver,
  type SparkLeafModelBinding,
  type SparkLeafRequest,
  type SparkModelProfile,
  type SparkProviderStreamFunction,
} from "@zendev-lab/spark-ai";

class FakeClock {
  value = 1_700_000_000_000;
  now(): number {
    return this.value;
  }
}

function sampleProfile(overrides: Partial<SparkModelProfile> = {}): SparkModelProfile {
  return {
    id: "claude-opus-4.8",
    name: "Claude Opus 4.8",
    capabilities: { input: ["text"], reasoning: true, toolUse: true },
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: 300_000,
    maxTokens: 32_000,
    routes: [
      {
        id: "primary",
        provider: "baidu-oneapi",
        priority: 100,
        transportApi: "anthropic-messages",
        transportModelId: "opus-4.8",
        baseUrl: "https://gateway.example.test/v1/messages",
        authPoolId: "baidu-primary",
      },
      {
        id: "secondary",
        provider: "baidu-oneapi",
        priority: 10,
        transportApi: "openai-responses",
        transportModelId: "gpt-5.5",
        baseUrl: "https://gateway.example.test/v1/responses",
        authPoolId: "baidu-primary",
      },
    ],
    authPools: [
      {
        id: "baidu-primary",
        slots: [
          { id: "main", priority: 100, authRef: { kind: "env", name: "BAIDU_ONEAPI_API_KEY" } },
        ],
      },
    ],
    ...overrides,
  };
}

interface StreamCall {
  systemPrompt: string | undefined;
  userContent: unknown;
  maxTokens: number | undefined;
  hasTools: boolean;
}

function stubStream(text: string, calls: StreamCall[]): SparkProviderStreamFunction {
  return ((_model, context, options) => {
    calls.push({
      systemPrompt: context.systemPrompt,
      userContent: context.messages[0]?.content,
      maxTokens: (options as { maxTokens?: number } | undefined)?.maxTokens,
      hasTools: (context.tools?.length ?? 0) > 0,
    });
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      stopReason: "endTurn" as const,
      timestamp: 0,
      api: "anthropic-messages",
      provider: "baidu-oneapi",
      model: "opus-4.8",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    async function* iterate() {
      yield { type: "done" as const, message };
    }
    const stream = iterate() as unknown as AsyncIterable<never> & {
      result(): Promise<typeof message>;
    };
    stream.result = async () => message;
    return stream as unknown as ReturnType<SparkProviderStreamFunction>;
  }) as SparkProviderStreamFunction;
}

function throwingStream(error: Error, calls: { count: number }): SparkProviderStreamFunction {
  return ((_model, _context, _options) => {
    calls.count += 1;
    async function* iterate() {
      yield { type: "start" as const };
    }
    const stream = iterate() as unknown as AsyncIterable<never> & { result(): Promise<never> };
    stream.result = async () => {
      throw error;
    };
    return stream as unknown as ReturnType<SparkProviderStreamFunction>;
  }) as SparkProviderStreamFunction;
}

function bindingFor(
  stream: SparkProviderStreamFunction,
  profile = sampleProfile(),
): SparkLeafModelBinding {
  return {
    sparkModelId: profile.id,
    resolver: new SparkRouteResolver(new SparkModelRegistry([profile]), { clock: new FakeClock() }),
    stream,
  };
}

const baseRequest: SparkLeafRequest = {
  role: "web-researcher",
  brief: "Synthesize a concise answer from the provided results.",
  input: "candidate text",
  sessionModel: "baidu-oneapi/claude-opus-4.8",
};

test("resolveLeafModelId prefers override, then session model, else undefined", () => {
  assert.equal(resolveLeafModelId({ ...baseRequest, model: "override/model" }), "override/model");
  assert.equal(resolveLeafModelId(baseRequest), "baidu-oneapi/claude-opus-4.8");
  assert.equal(resolveLeafModelId({ role: "r", brief: "b", input: "i" }), undefined);
});

test("runSparkLeaf issues exactly one bounded completion with no tools", async () => {
  const calls: StreamCall[] = [];
  let bindingCalls = 0;
  const result = await runSparkLeaf(baseRequest, {
    resolveBinding: () => {
      bindingCalls += 1;
      return bindingFor(stubStream("synthesized answer", calls));
    },
  });

  assert.equal(result.degraded, false);
  assert.equal(result.text, "synthesized answer");
  assert.equal(result.model, "claude-opus-4.8");
  assert.equal(bindingCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.hasTools, false);
  assert.equal(calls[0]?.maxTokens, 2048);
  assert.equal(calls[0]?.userContent, "candidate text");
  assert.match(calls[0]?.systemPrompt ?? "", /bounded Spark leaf capability/);
});

test("runSparkLeaf resolves and reports the session-default model id", async () => {
  const seen: Array<string | undefined> = [];
  const result = await runSparkLeaf(baseRequest, {
    resolveBinding: (_request, modelId) => {
      seen.push(modelId);
      return bindingFor(stubStream("ok", []));
    },
  });

  assert.deepEqual(seen, ["baidu-oneapi/claude-opus-4.8"]);
  assert.equal(result.degraded, false);
  assert.equal(result.model, "claude-opus-4.8");
});

test("runSparkLeaf resolves and reports an explicit override model id", async () => {
  const seen: Array<string | undefined> = [];
  const overrideProfile = sampleProfile({ id: "gpt-5.5" });
  const result = await runSparkLeaf(
    { ...baseRequest, model: "baidu-oneapi/gpt-5.5" },
    {
      resolveBinding: (_request, modelId) => {
        seen.push(modelId);
        return bindingFor(stubStream("ok", []), overrideProfile);
      },
    },
  );

  assert.deepEqual(seen, ["baidu-oneapi/gpt-5.5"]);
  assert.equal(result.degraded, false);
  assert.equal(result.model, "gpt-5.5");
});

test("runSparkLeaf is single-shot even when the model call fails with a failover-eligible error", async () => {
  // "ECONNRESET socket hang up" classifies as transient, which the resolver
  // would normally fail over on. The leaf must still call the stream once.
  const streamCalls = { count: 0 };
  const result = await runSparkLeaf(baseRequest, {
    resolveBinding: () =>
      bindingFor(throwingStream(new Error("ECONNRESET socket hang up"), streamCalls)),
  });

  assert.equal(result.degraded, true);
  assert.equal(result.reasonCode, "model-call-failed");
  assert.equal(streamCalls.count, 1);
});

test("runSparkLeaf records a failed call as a route/auth-slot failure on the shared resolver", async () => {
  const streamCalls = { count: 0 };
  const binding = bindingFor(throwingStream(new Error("ECONNRESET socket hang up"), streamCalls));

  const result = await runSparkLeaf(baseRequest, { resolveBinding: () => binding });

  assert.equal(result.degraded, true);
  assert.equal(result.reasonCode, "model-call-failed");
  assert.equal(streamCalls.count, 1);

  // The shared resolver must account the failure, not a success.
  const pools = binding.resolver.authPoolSnapshots();
  const mainSlot = pools.flatMap((pool) => pool.slots).find((slot) => slot.id === "main");
  assert.ok(mainSlot, "expected the primary auth slot to be tracked");
  assert.equal(mainSlot?.consecutiveFailures, 1);
  assert.notEqual(mainSlot?.health, "ok");
});

test("runSparkLeaf records a successful call as a route/auth-slot success on the shared resolver", async () => {
  const binding = bindingFor(stubStream("ok", []));

  const first = await runSparkLeaf(baseRequest, { resolveBinding: () => binding });
  assert.equal(first.degraded, false);

  const pools = binding.resolver.authPoolSnapshots();
  const mainSlot = pools.flatMap((pool) => pool.slots).find((slot) => slot.id === "main");
  assert.ok(mainSlot, "expected the primary auth slot to be tracked");
  assert.equal(mainSlot?.consecutiveFailures, 0);
  assert.equal(mainSlot?.health, "ok");
});

test("runSparkLeaf degrades without throwing when no model is resolvable", async () => {
  let bindingCalls = 0;
  const result = await runSparkLeaf(
    { role: "r", brief: "b", input: "i" },
    {
      resolveBinding: () => {
        bindingCalls += 1;
        return bindingFor(stubStream("unused", []));
      },
    },
  );

  assert.equal(result.degraded, true);
  assert.equal(result.reasonCode, "no-model");
  assert.equal(bindingCalls, 0);
});

test("runSparkLeaf degrades when the model binding is unavailable", async () => {
  const result = await runSparkLeaf(baseRequest, { resolveBinding: () => undefined });
  assert.equal(result.degraded, true);
  assert.equal(result.reasonCode, "model-binding-unavailable");
});

test("runSparkLeaf degrade reasons are stable codes that never echo provider error text", async () => {
  const secret = "sk-super-secret-key-value";
  const streamCalls = { count: 0 };
  const result = await runSparkLeaf(baseRequest, {
    resolveBinding: () =>
      bindingFor(throwingStream(new Error(`401 unauthorized apiKey=${secret}`), streamCalls)),
  });

  assert.equal(result.degraded, true);
  assert.equal(result.reasonCode, "model-call-failed");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.text, "");
});

test("runSparkLeaf degrades when aborted before execution", async () => {
  const controller = new AbortController();
  controller.abort();
  let bindingCalls = 0;
  const result = await runSparkLeaf(
    { ...baseRequest, signal: controller.signal },
    {
      resolveBinding: () => {
        bindingCalls += 1;
        return bindingFor(stubStream("unused", []));
      },
    },
  );

  assert.equal(result.degraded, true);
  assert.equal(result.reasonCode, "aborted");
  assert.equal(bindingCalls, 0);
});
