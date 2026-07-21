import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILURE_CLASS_POLICIES,
  classifyProviderFailure,
  type FailureClass,
} from "@zendev-lab/spark-ai";

const cases: Array<{
  name: string;
  input: unknown;
  expected: FailureClass;
  status?: number;
}> = [
  {
    name: "401 maps to auth",
    input: { status: 401, message: "Unauthorized" },
    expected: "auth",
    status: 401,
  },
  {
    name: "403 maps to auth",
    input: { response: { status: 403 }, message: "Forbidden" },
    expected: "auth",
    status: 403,
  },
  {
    name: "missing API key maps to auth",
    input: new Error("No API key for provider: baidu-oneapi"),
    expected: "auth",
  },
  {
    name: "429 maps to rate_limit",
    input: { statusCode: 429, message: "Too many requests" },
    expected: "rate_limit",
    status: 429,
  },
  {
    name: "quota text maps to rate_limit",
    input: "quota exceeded for this account",
    expected: "rate_limit",
  },
  {
    name: "context overflow text maps to context_overflow",
    input: { errorMessage: "maximum context length exceeded" },
    expected: "context_overflow",
  },
  {
    name: "Chinese context overflow maps to context_overflow",
    input: {
      errorMessage:
        'OpenAI API error (400): {"message":"请精简对话历史或缩小工具/文件输出后重试。(Context window is full)"}',
    },
    expected: "context_overflow",
  },
  {
    name: "overloaded text maps to transient",
    input: "Our servers are currently overloaded. Please try again later.",
    expected: "transient",
  },
  {
    name: "Mismatched api maps to provider_mismatch",
    input: new Error("Mismatched api: baidu-oneapi expected openai-responses"),
    expected: "provider_mismatch",
  },
  {
    name: "5xx maps to transient",
    input: { response: { status: 502 }, message: "Bad Gateway" },
    expected: "transient",
    status: 502,
  },
  {
    name: "network text maps to transient",
    input: { error: new Error("ECONNRESET socket hang up") },
    expected: "transient",
  },
  {
    name: "aborted stopReason maps to aborted",
    input: { stopReason: "aborted", errorMessage: "user cancelled" },
    expected: "aborted",
  },
  {
    name: "unknown error maps to fatal",
    input: { stopReason: "error", errorMessage: "model produced invalid JSON" },
    expected: "fatal",
  },
];

for (const entry of cases) {
  void test(`classifyProviderFailure: ${entry.name}`, () => {
    const result = classifyProviderFailure(entry.input);
    assert.equal(result.failureClass, entry.expected);
    assert.deepEqual(result.policy, FAILURE_CLASS_POLICIES[entry.expected]);
    if (entry.status !== undefined) assert.equal(result.status, entry.status);
  });
}

void test("classifyProviderFailure gives provider_mismatch non-retry policy", () => {
  const result = classifyProviderFailure(
    "Mismatched api: baidu-oneapi expected anthropic-messages",
  );

  assert.equal(result.failureClass, "provider_mismatch");
  assert.deepEqual(result.policy, {
    retriable: false,
    cooldown: false,
    failover: false,
  });
});

void test("classifyProviderFailure gives auth a cooldown+failover policy but not transient retry", () => {
  const result = classifyProviderFailure({ status: 401, message: "invalid api key" });

  assert.equal(result.failureClass, "auth");
  assert.deepEqual(result.policy, {
    retriable: false,
    cooldown: true,
    failover: true,
  });
});
