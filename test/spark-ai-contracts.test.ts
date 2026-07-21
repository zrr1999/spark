import assert from "node:assert/strict";
import { test } from "vitest";

import {
  SparkModelRegistry,
  SparkModelValidationError,
  collectSparkModelProfileIssues,
  validateSparkModelProfile,
  type SparkModelProfile,
} from "@zendev-lab/spark-ai";

function sampleProfile(overrides: Partial<SparkModelProfile> = {}): SparkModelProfile {
  return {
    id: "claude-opus-4.8",
    name: "Claude Opus 4.8",
    capabilities: {
      input: ["text"],
      reasoning: true,
      toolUse: true,
    },
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    },
    contextWindow: 200_000,
    maxTokens: 32_000,
    routes: [
      {
        id: "baidu-anthropic-primary",
        provider: "baidu-oneapi",
        priority: 10,
        transportApi: "anthropic-messages",
        transportModelId: "Opus 4.8 Coding Plan",
        baseUrl: "https://gateway.example.test/v1/messages",
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
    ...overrides,
  };
}

test("spark-ai validates a complete SparkModelProfile", () => {
  const profile = sampleProfile();

  assert.equal(validateSparkModelProfile(profile), profile);
  assert.deepEqual(collectSparkModelProfileIssues(profile), []);
});

test("spark-ai registry stores validated profiles and rejects duplicate ids", () => {
  const registry = new SparkModelRegistry([sampleProfile()]);

  assert.equal(registry.size, 1);
  assert.equal(registry.has("claude-opus-4.8"), true);
  assert.equal(registry.require("claude-opus-4.8").routes[0]?.transportApi, "anthropic-messages");

  assert.throws(
    () => registry.add(sampleProfile()),
    (error: unknown) =>
      error instanceof SparkModelValidationError &&
      error.issues.includes("duplicate Spark model profile id: claude-opus-4.8"),
  );
});

test("spark-ai rejects profiles without routes", () => {
  assert.throws(
    () => validateSparkModelProfile(sampleProfile({ routes: [] })),
    /profile\.routes must be a non-empty array/u,
  );
});

test("spark-ai rejects routes without a transport API", () => {
  const profile = sampleProfile({
    routes: [
      {
        id: "baidu-anthropic-primary",
        provider: "baidu-oneapi",
        priority: 10,
        transportApi: "" as "anthropic-messages",
        transportModelId: "Opus 4.8 Coding Plan",
        baseUrl: "https://gateway.example.test/v1/messages",
        authPoolId: "baidu-primary",
      },
    ],
  });

  assert.throws(
    () => validateSparkModelProfile(profile),
    /profile\.routes\[0\]\.transportApi must be a non-empty string/u,
  );
});

test("spark-ai rejects routes when auth pools are absent or empty", () => {
  const missingPools = collectSparkModelProfileIssues(sampleProfile({ authPools: undefined }));
  assert.ok(
    missingPools.includes(
      "profile.routes[0].authPoolId references unknown auth pool: baidu-primary",
    ),
  );

  const emptyPools = collectSparkModelProfileIssues(sampleProfile({ authPools: [] }));
  assert.ok(
    emptyPools.includes("profile.routes[0].authPoolId references unknown auth pool: baidu-primary"),
  );
});

test("spark-ai rejects duplicate route ids and unknown auth pools", () => {
  const profile = sampleProfile({
    routes: [
      {
        id: "duplicate-route",
        provider: "baidu-oneapi",
        priority: 10,
        transportApi: "anthropic-messages",
        transportModelId: "Opus 4.8 Coding Plan",
        baseUrl: "https://gateway.example.test/v1/messages",
        authPoolId: "missing-pool",
      },
      {
        id: "duplicate-route",
        provider: "baidu-oneapi",
        priority: 20,
        transportApi: "openai-responses",
        transportModelId: "gpt-5.5-coding-plan",
        baseUrl: "https://gateway.example.test/v1/responses",
        authPoolId: "missing-pool",
      },
    ],
  });

  const issues = collectSparkModelProfileIssues(profile);
  assert.ok(issues.includes("duplicate route id in profile.routes: duplicate-route"));
  assert.ok(
    issues.includes("profile.routes[0].authPoolId references unknown auth pool: missing-pool"),
  );
  assert.ok(
    issues.includes("profile.routes[1].authPoolId references unknown auth pool: missing-pool"),
  );
});

test("spark-ai rejects malformed auth slots without exposing secrets", () => {
  const profile = sampleProfile({
    authPools: [
      {
        id: "baidu-primary",
        slots: [
          {
            id: "baidu-main",
            priority: 10,
            authRef: { kind: "env", name: "" },
          },
        ],
      },
    ],
  });

  assert.throws(
    () => validateSparkModelProfile(profile),
    /profile\.authPools\[0\]\.slots\[0\]\.authRef\.name must be a non-empty string/u,
  );
});
