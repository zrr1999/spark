import assert from "node:assert/strict";
import { test } from "vitest";

import type { Api, Model } from "@earendil-works/pi-ai";

import { createCursorStreamFunction, type CursorSdkRuntime } from "./cursor-stream.ts";

const model = {
  id: "composer-2",
  name: "Composer 2",
  api: "cursor-sdk",
  provider: "cursor",
  baseUrl: "https://cursor.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
} as Model<Api>;

test("cursor stream retries concurrency rate limits before any deltas", async () => {
  let creates = 0;
  const sdk: CursorSdkRuntime = {
    Agent: {
      async create() {
        creates += 1;
        return {
          async send() {
            return {
              usage: undefined,
              async wait() {
                if (creates === 1) {
                  return {
                    status: "error",
                    error: {
                      message:
                        "rate_limit_exceeded: Concurrency limit exceeded for account, please retry later",
                    },
                  };
                }
                return { status: "success", result: "recovered", usage: undefined };
              },
              async cancel() {},
            };
          },
          async [Symbol.asyncDispose]() {},
          close() {},
        } as never;
      },
    },
  };

  const stream = createCursorStreamFunction({
    loadSdk: async () => sdk,
    cwd: () => "/tmp",
  })(
    model,
    { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
    {
      apiKey: "test-key",
      maxRetries: 2,
      signal: AbortSignal.timeout(5_000),
    },
  );

  const message = await stream.result();
  assert.equal(creates, 2);
  assert.equal(message.stopReason, "stop");
  assert.match(
    message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    /recovered/,
  );
});

test("cursor stream does not retry fatal provider errors", async () => {
  let creates = 0;
  const sdk: CursorSdkRuntime = {
    Agent: {
      async create() {
        creates += 1;
        return {
          async send() {
            return {
              usage: undefined,
              async wait() {
                return {
                  status: "error",
                  error: { message: "model produced invalid JSON" },
                };
              },
              async cancel() {},
            };
          },
          async [Symbol.asyncDispose]() {},
          close() {},
        } as never;
      },
    },
  };

  const stream = createCursorStreamFunction({
    loadSdk: async () => sdk,
    cwd: () => "/tmp",
  })(
    model,
    { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
    {
      apiKey: "test-key",
      maxRetries: 3,
      signal: AbortSignal.timeout(5_000),
    },
  );

  const message = await stream.result();
  assert.equal(creates, 1);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /invalid JSON/);
});
