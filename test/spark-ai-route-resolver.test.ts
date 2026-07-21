import assert from "node:assert/strict";
import { test } from "vitest";

import {
  SparkModelRegistry,
  SparkRouteExecutionError,
  SparkRouteResolutionError,
  SparkRouteResolver,
  type SparkModelProfile,
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
    capabilities: {
      input: ["text", "image"],
      reasoning: true,
      toolUse: true,
    },
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: 300_000,
    maxTokens: 32_000,
    routes: [
      {
        id: "primary",
        provider: "baidu-oneapi",
        priority: 100,
        transportApi: "anthropic-messages",
        transportModelId: "Opus 4.8 Coding Plan",
        baseUrl: "https://gateway.example.test/v1/messages",
        authPoolId: "baidu-primary",
      },
      {
        id: "secondary",
        provider: "baidu-oneapi",
        priority: 10,
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
          { id: "main", priority: 100, authRef: { kind: "env", name: "BAIDU_ONEAPI_API_KEY" } },
          {
            id: "backup",
            priority: 10,
            authRef: { kind: "secret", id: "secret://backup-key" },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function resolverFor(profile = sampleProfile()): SparkRouteResolver {
  return new SparkRouteResolver(new SparkModelRegistry([profile]), { clock: new FakeClock() });
}

test("SparkRouteResolver resolves highest-priority capable route", () => {
  const resolver = resolverFor();

  const decision = resolver.resolve({ sparkModelId: "claude-opus-4.8" });

  assert.equal(decision.routeId, "primary");
  assert.equal(decision.authSlotId, "main");
  assert.equal(decision.reason, "ordered_available");
  assert.equal(decision.route.transportApi, "anthropic-messages");
  assert.equal(decision.trace.events[0]?.type, "CANDIDATE_POOL");
  assert.equal(decision.trace.events.at(-1)?.type, "CANDIDATE_START");
});

test("SparkRouteResolver honors sticky session route", () => {
  const resolver = resolverFor();

  const first = resolver.resolve({ sparkModelId: "claude-opus-4.8", sessionId: "s1" });
  const second = resolver.resolve({ sparkModelId: "claude-opus-4.8", sessionId: "s1" });

  assert.equal(first.routeId, "primary");
  assert.equal(second.routeId, "primary");
  assert.equal(second.reason, "sticky_available");
  assert.equal(second.sticky, true);
});

test("SparkRouteResolver executeWithFailover advances on transient failure", async () => {
  const resolver = resolverFor();
  const attempts: string[] = [];

  const result = await resolver.executeWithFailover(
    { sparkModelId: "claude-opus-4.8", sessionId: "s1" },
    ({ decision, model }) => {
      attempts.push(`${decision.routeId}:${model.api}`);
      if (decision.routeId === "primary") throw new Error("ECONNRESET socket hang up");
      return "ok";
    },
  );

  assert.equal(result.result, "ok");
  assert.deepEqual(attempts, ["primary:anthropic-messages", "secondary:openai-responses"]);
  assert.equal(result.decision.routeId, "secondary");
  assert.equal(result.trace.events.at(-1)?.reason, "ok");
});

test("SparkRouteResolver stops on provider_mismatch without failover", async () => {
  const resolver = resolverFor();

  await assert.rejects(
    () =>
      resolver.executeWithFailover({ sparkModelId: "claude-opus-4.8" }, () => {
        throw new Error("Mismatched api: baidu-oneapi expected anthropic-messages");
      }),
    (error: unknown) =>
      error instanceof SparkRouteExecutionError &&
      error.classification.failureClass === "provider_mismatch" &&
      /provider_mismatch/u.test(error.message),
  );
});

test("SparkRouteResolver fails loudly on capability mismatch", () => {
  const resolver = resolverFor(
    sampleProfile({
      capabilities: {
        input: ["text"],
        reasoning: false,
        toolUse: false,
      },
    }),
  );

  assert.throws(
    () =>
      resolver.resolve({
        sparkModelId: "claude-opus-4.8",
        capabilities: { input: ["image"], reasoning: true, toolUse: true },
      }),
    (error: unknown) =>
      error instanceof SparkRouteResolutionError &&
      error.trace.events.some((event) => event.reason === "capability_mismatch:input:image"),
  );
});

test("SparkRouteResolver trace is bounded and secret-free", async () => {
  const resolver = resolverFor();

  const result = await resolver.executeWithFailover(
    { sparkModelId: "claude-opus-4.8", traceMaxEvents: 3 },
    ({ decision }) => {
      if (decision.routeId === "primary") throw new Error("429 rate limit");
      return "ok";
    },
  );

  const serialized = JSON.stringify(result.trace);
  assert.equal(result.trace.maxEvents, 3);
  assert.equal(result.trace.events.length, 3);
  assert.doesNotMatch(serialized, /BAIDU_ONEAPI_API_KEY/u);
  assert.doesNotMatch(serialized, /secret:\/\/backup-key/u);
});
