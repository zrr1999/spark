import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SparkMemorySecretError,
  defaultSparkMemoryStore,
  renderSparkMemoryCheckpoint,
  renderSparkMemoryPolicy,
} from "../packages/spark-memory/src/index.ts";
import sparkMemoryExtension from "../packages/spark-memory/src/extension.ts";
import type { ToolConfig } from "../packages/spark-extension-api/src/index.ts";

void test("spark memory stores, searches, and forgets explicit scoped entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-store-"));
  try {
    const store = defaultSparkMemoryStore(dir, "workspace");
    const entry = await store.remember({
      scope: "workspace",
      category: "preference",
      text: "User prefers pnpm for Spark workspace package management.",
      reason: "User stated a durable package-manager preference.",
      tags: ["package-manager", "spark"],
    });

    const results = await store.search("pnpm package");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.entry.id, entry.id);
    assert.equal(results[0]?.score, 4);

    const status = await store.status();
    assert.equal(status.active, 1);
    assert.equal(status.byCategory.preference, 1);

    const checkpoint = await store.checkpoint();
    assert.equal(checkpoint.entries[0]?.id, entry.id);
    assert.match(checkpoint.policy, /policy-only/i);
    assert.match(renderSparkMemoryCheckpoint(checkpoint), /Spark memory checkpoint/);

    const forgotten = await store.forget(entry.id, "superseded by project policy");
    assert.equal(forgotten.status, "forgotten");
    assert.deepEqual(await store.search("pnpm"), []);
    assert.equal((await store.status()).forgotten, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark memory rejects likely secrets before persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-secret-"));
  try {
    const store = defaultSparkMemoryStore(dir, "workspace");
    await assert.rejects(
      () =>
        store.remember({
          scope: "workspace",
          category: "insight",
          text: "api_key = sk_1234567890abcdef1234567890abcdef",
          reason: "should be rejected",
        }),
      SparkMemorySecretError,
    );
    assert.equal((await store.status()).total, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark memory extension registers policy-only memory tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-tool-"));
  try {
    const api = new FakeApi();
    sparkMemoryExtension(api, { storePaths: { workspace: join(dir, "memory.json") } });
    const tool = api.tools.get("memory");
    assert.ok(tool);
    assert.match(tool.promptGuidelines?.join("\n") ?? "", /policy-only/i);
    assert.match(renderSparkMemoryPolicy(), /explicit/);

    const remember = await tool.execute(
      "call-1",
      {
        action: "remember",
        scope: "workspace",
        category: "correction",
        text: "Do not call task finish before validation output is attached.",
        reason: "Corrects a prior workflow mistake.",
      },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    assert.match(remember.content[0]?.text ?? "", /Remembered memory:/);

    const search = await tool.execute(
      "call-2",
      { action: "search", scope: "workspace", query: "validation" },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    assert.match(search.content[0]?.text ?? "", /Memory search results/);

    await api.handlers.get("session_start")?.({}, { cwd: dir });
    assert.equal(api.messages[0]?.message.customType, "spark-memory-policy");
    assert.match(api.messages[0]?.message.content ?? "", /policy-only/);

    await api.handlers.get("session_before_compact")?.({}, { cwd: dir });
    assert.equal(api.messages[1]?.message.customType, "spark-memory-checkpoint");
    assert.match(api.messages[1]?.message.content ?? "", /validation output/);

    const status = await tool.execute(
      "call-3",
      { action: "status", scope: "workspace" },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    assert.equal((status.details?.summary as { active?: number } | undefined)?.active, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

class FakeApi {
  readonly handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  readonly messages: Array<{
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
    };
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean };
  }> = [];
  readonly tools = new Map<string, ToolConfig>();

  registerTool(config: ToolConfig): void {
    this.tools.set(config.name, config);
  }

  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
    this.handlers.set(event, handler);
  }

  sendMessage(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void {
    this.messages.push({ message, options });
  }
}
