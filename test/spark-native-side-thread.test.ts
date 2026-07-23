import assert from "node:assert/strict";
import { test } from "vitest";

import type { SparkSideThreadSnapshot } from "../packages/spark-protocol/src/index.ts";
import {
  createSparkNativeSideThreadSlashCommands,
  type SparkNativeSideThreadClient,
} from "../apps/spark-tui/src/native-tui.ts";

const baseSnapshot = (): SparkSideThreadSnapshot => ({
  parentSessionId: "session:parent",
  sessionId: "session:parent:side",
  generation: 2,
  mode: "contextual",
  status: "idle",
  pendingTurns: [],
  exchanges: [
    {
      id: "exchange:1",
      user: "Check the concurrency boundary",
      assistant: "It is read-only and daemon-owned.",
      createdAt: "2026-07-22T00:00:00.000Z",
    },
  ],
  headExchangeId: "exchange:1",
  hasMore: false,
  projectionTruncated: false,
  effectiveModel: { providerName: "openai", modelId: "gpt-5" },
  effectiveThinkingLevel: "high",
});

function clientFixture(
  calls: Array<{ method: string; input: Record<string, unknown> }>,
): SparkNativeSideThreadClient {
  const snapshot = baseSnapshot();
  return {
    ensure: async (input) => {
      calls.push({ method: "ensure", input });
      return snapshot;
    },
    snapshot: async (input) => {
      calls.push({ method: "snapshot", input });
      return snapshot;
    },
    submit: async (input) => {
      calls.push({ method: "submit", input });
      return { snapshot: { ...snapshot, status: "queued" } };
    },
    reset: async (input) => {
      calls.push({ method: "reset", input });
      return { ...snapshot, generation: snapshot.generation + 1, mode: input.mode, exchanges: [] };
    },
    configure: async (input) => {
      calls.push({ method: "configure", input });
      return {
        ...snapshot,
        ...(input.modelOverride === null ? { modelOverride: undefined } : {}),
        ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
        ...(input.thinkingOverride === null ? { thinkingOverride: undefined } : {}),
        ...(input.thinkingOverride ? { thinkingOverride: input.thinkingOverride } : {}),
      };
    },
    handoff: async (input) => {
      calls.push({ method: "handoff", input });
      return { snapshot: { ...snapshot, generation: snapshot.generation + 1, exchanges: [] } };
    },
  };
}

test("native /btw remains one command while sending, configuring, resetting, and handing off via daemon client", async () => {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const commands = createSparkNativeSideThreadSlashCommands({
    parentSessionId: () => "session:parent",
    client: clientFixture(calls),
  });
  const btw = commands.btw;
  assert.ok(btw);
  assert.equal(btw?.metadata?.canonicalCliTarget, "spark tui /btw <subcommand>");

  const context = {} as never;
  const opened = await btw!.handler("", context);
  assert.match(opened ?? "", /readonly: enforced/u);
  assert.equal(calls[0]?.method, "ensure");

  await btw!.handler("ask inspect this", context);
  assert.equal(calls.at(-1)?.method, "submit");
  assert.equal(calls.at(-1)?.input.prompt, "inspect this");
  assert.equal(calls.at(-1)?.input.expectedGeneration, 2);
  assert.match(String(calls.at(-1)?.input.idempotencyKey), /^idem_[a-f0-9]{32}$/u);

  await btw!.handler("model openai/gpt-5-mini", context);
  assert.deepEqual(calls.at(-1), {
    method: "configure",
    input: {
      parentSessionId: "session:parent",
      expectedGeneration: 2,
      modelOverride: { providerName: "openai", modelId: "gpt-5-mini" },
    },
  });

  await btw!.handler("thinking inherit", context);
  assert.equal(calls.at(-1)?.input.thinkingOverride, null);

  await btw!.handler("reset tangent", context);
  assert.deepEqual(calls.at(-1), {
    method: "reset",
    input: { parentSessionId: "session:parent", expectedGeneration: 2, mode: "tangent" },
  });

  const handoff = await btw!.handler("handoff summary continue with tests", context);
  assert.match(handoff ?? "", /handoff accepted/u);
  assert.equal(calls.at(-1)?.method, "handoff");
  assert.equal(calls.at(-1)?.input.expectedHeadExchangeId, "exchange:1");
  assert.equal(calls.at(-1)?.input.instructions, "continue with tests");
});

test("native /btw reports invalid subcommands without making a daemon mutation", async () => {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const btw = createSparkNativeSideThreadSlashCommands({
    parentSessionId: () => "session:parent",
    client: clientFixture(calls),
  }).btw!;
  const result = await btw.handler("handoff unsupported", {} as never);
  assert.match(result ?? "", /handoff kind must be full or summary/u);
  assert.equal(calls.length, 0);
});

test("native /btw rejects inherited object names as unknown subcommands", async () => {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const btw = createSparkNativeSideThreadSlashCommands({
    parentSessionId: () => "session:parent",
    client: clientFixture(calls),
  }).btw!;

  for (const command of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const result = await btw.handler(command, {} as never);
    assert.match(result ?? "", new RegExp(`unknown subcommand: ${command.toLowerCase()}`, "u"));
  }
  assert.equal(calls.length, 0);
});

test("native /btw splits a long whitespace-delimited prompt without a backtracking regex", async () => {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const btw = createSparkNativeSideThreadSlashCommands({
    parentSessionId: () => "session:parent",
    client: clientFixture(calls),
  }).btw!;
  const prompt = "inspect the daemon boundary";

  await btw.handler(`ask${" \t".repeat(20_000)}${prompt}`, {} as never);

  assert.equal(calls.at(-1)?.method, "submit");
  assert.equal(calls.at(-1)?.input.prompt, prompt);
});

test("native /btw reuses an unresolved submit key after a lost response", async () => {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const originalClient = clientFixture(calls);
  let attempt = 0;
  const client = {
    ...originalClient,
    submit: async (input: Parameters<typeof originalClient.submit>[0]) => {
      calls.push({ method: "submit-attempt", input });
      attempt += 1;
      if (attempt === 1) throw new Error("connection closed after dispatch");
      return await originalClient.submit(input);
    },
  };
  const btw = createSparkNativeSideThreadSlashCommands({
    parentSessionId: () => "session:parent",
    client,
  }).btw!;

  await assert.rejects(
    async () => await btw.handler("ask inspect this", {} as never),
    /connection closed/u,
  );
  await btw.handler("ask inspect this", {} as never);

  const attempts = calls.filter((call) => call.method === "submit-attempt");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.input.idempotencyKey, attempts[1]?.input.idempotencyKey);
});
