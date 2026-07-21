import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  SparkMemorySecretError,
  defaultSparkMemoryStore,
  renderSparkMemoryCheckpoint,
  renderSparkMemoryPolicy,
} from "../packages/spark-memory/src/index.ts";
import sparkMemoryExtension from "../packages/spark-memory/src/extension.ts";
import type { ToolConfig } from "../packages/spark-core/src/index.ts";

test("spark memory stores, searches, and forgets explicit scoped entries", async () => {
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

test("spark memory rejects likely secrets before persistence", async () => {
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

test("spark memory extension registers policy-only memory tool", async () => {
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

    const compactEventResult = await api.handlers.get("session_before_compact")?.({}, { cwd: dir });
    assert.equal(api.messages[1]?.message.customType, "spark-memory-checkpoint");
    // The checkpoint must ride the next real user prompt, not trigger its own
    // post-compaction turn/request.
    assert.equal(api.messages[1]?.options?.deliverAs, "nextTurn");
    assert.notEqual(api.messages[1]?.options?.triggerTurn, true);
    assert.equal(
      (compactEventResult as { message?: { customType?: string } } | undefined)?.message
        ?.customType,
      "spark-memory-checkpoint",
    );
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

test("spark memory extension covers pi-memory compatibility workflows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-compat-"));
  try {
    const compatDir = join(dir, "legacy-memory");
    const api = new FakeApi();
    sparkMemoryExtension(api, {
      compatMemoryDir: compatDir,
      storePaths: { workspace: join(dir, "spark-memory.json") },
    });

    for (const toolName of [
      "memory",
      "memory_write",
      "memory_read",
      "scratchpad",
      "memory_search",
      "memory_status",
    ]) {
      assert.ok(api.tools.has(toolName), `${toolName} should be registered`);
    }
    for (const toolName of ["memory_read", "memory_status"]) {
      assert.deepEqual(api.tools.get(toolName)?.policy, {
        effect: "read",
        executionMode: "parallel",
        domains: ["memory"],
        phases: ["plan", "implement"],
        approval: "none",
      });
    }
    assert.deepEqual(api.tools.get("memory_search")?.policy, {
      effect: "read",
      executionMode: "sequential",
      domains: ["memory"],
      phases: ["plan", "implement"],
      approval: "none",
    });

    const memoryWrite = api.tools.get("memory_write")!;
    await memoryWrite.execute(
      "write-long",
      { target: "long_term", content: "# Durable\nUser prefers focused Spark checks." },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    await memoryWrite.execute(
      "write-daily",
      { target: "daily", content: "Validated replacement smoke." },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    assert.match(await readFile(join(compatDir, "MEMORY.md"), "utf8"), /focused Spark checks/);

    const memoryRead = api.tools.get("memory_read")!;
    const longTerm = await memoryRead.execute(
      "read-long",
      { target: "long_term" },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    assert.match(longTerm.content[0]?.text ?? "", /focused Spark checks/);
    const dailyList = await memoryRead.execute(
      "read-list",
      { target: "list" },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    assert.match(dailyList.content[0]?.text ?? "", /Daily logs/);

    const scratchpad = api.tools.get("scratchpad")!;
    await scratchpad.execute(
      "scratch-add",
      { action: "add", text: "finish replacement docs" },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    const scratchDone = await scratchpad.execute(
      "scratch-done",
      { action: "done", text: "replacement docs" },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    assert.match(scratchDone.content[0]?.text ?? "", /\[x\] finish replacement docs/);

    const memorySearch = api.tools.get("memory_search")!;
    const search = await memorySearch.execute(
      "search",
      { query: "replacement smoke", mode: "deep" },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    assert.match(search.content[0]?.text ?? "", /could not run the memory-reranker leaf/);
    assert.equal((search.details as { degraded?: boolean }).degraded, true);
    assert.equal((search.details as { leafDegraded?: boolean }).leafDegraded, true);
    assert.equal(
      (search.details as { leafReasonCode?: string }).leafReasonCode,
      "host-unsupported",
    );

    const memory = api.tools.get("memory")!;
    const preview = await memory.execute(
      "import-preview",
      { action: "import_legacy", apply: false, scope: "workspace" },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    assert.match(preview.content[0]?.text ?? "", /import preview/);
    const imported = await memory.execute(
      "import-apply",
      { action: "import_legacy", apply: true, scope: "workspace", reason: "Explicit test import." },
      new AbortController().signal,
      () => {},
      { cwd: dir },
    );
    assert.match(imported.content[0]?.text ?? "", /Imported/);

    const status = await api.tools
      .get("memory_status")!
      .execute("status", {}, new AbortController().signal, () => {}, { cwd: dir });
    assert.match(status.content[0]?.text ?? "", /pi-memory compatibility/);
    assert.ok(
      (
        await defaultSparkMemoryStore(dir, "workspace", {
          workspace: join(dir, "spark-memory.json"),
        }).status()
      ).active > 0,
    );

    await assert.rejects(
      () =>
        memoryWrite.execute(
          "secret",
          { target: "long_term", content: "api_key = sk_1234567890abcdef1234567890abcdef" },
          new AbortController().signal,
          () => {},
          { cwd: dir },
        ),
      SparkMemorySecretError,
    );

    await writeFile(join(compatDir, "README.txt"), "ignored", "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory_search semantic/deep use one listwise rerank leaf over keyword candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-rerank-"));
  try {
    const compatDir = join(dir, "legacy-memory");
    const dailyDir = join(compatDir, "daily");
    await mkdir(dailyDir, { recursive: true });
    await writeFile(join(compatDir, "MEMORY.md"), "alpha memory baseline", "utf8");
    for (let index = 1; index <= 55; index += 1) {
      const special = index === 17 ? " special semantic target" : "";
      await writeFile(
        join(dailyDir, `2026-07-${String(index).padStart(2, "0")}.md`),
        `alpha candidate ${index}${special}`,
        "utf8",
      );
    }

    const api = new FakeApi();
    sparkMemoryExtension(api, { compatMemoryDir: compatDir });
    const memorySearch = api.tools.get("memory_search")!;

    let keywordLeafCalls = 0;
    const keyword = await memorySearch.execute(
      "keyword",
      { query: "alpha", mode: "keyword", limit: 3 },
      new AbortController().signal,
      () => {},
      {
        cwd: dir,
        runLeaf: async () => {
          keywordLeafCalls += 1;
          return { degraded: false, text: "should not run", model: "fake/model" };
        },
      },
    );
    assert.equal(keywordLeafCalls, 0);
    assert.equal((keyword.details as { degraded?: boolean }).degraded, false);
    assert.equal((keyword.details as { candidateWindow?: number }).candidateWindow, 3);

    const leafCalls: Array<{ role: string; input: string }> = [];
    const runLeaf = async (request: { role: string; input: string }) => {
      leafCalls.push({ role: request.role, input: request.input });
      return { degraded: false, text: "[17, 1, 2]", model: "fake/model" };
    };

    const semantic = await memorySearch.execute(
      "semantic",
      { query: "alpha", mode: "semantic", limit: 3 },
      new AbortController().signal,
      () => {},
      { cwd: dir, runLeaf },
    );
    assert.equal(leafCalls.length, 1);
    assert.equal(leafCalls[0]?.role, "memory-reranker");
    assert.match(leafCalls[0]?.input ?? "", /20\. daily\/2026-07-20\.md/);
    assert.equal((semantic.details as { candidateWindow?: number }).candidateWindow, 20);
    assert.equal((semantic.details as { leafDegraded?: boolean }).leafDegraded, false);
    assert.equal((semantic.details as { reranked?: boolean }).reranked, true);
    assert.match(semantic.content[0]?.text ?? "", /daily\/2026-07-17\.md/);

    const deep = await memorySearch.execute(
      "deep",
      { query: "alpha", mode: "deep", limit: 3 },
      new AbortController().signal,
      () => {},
      { cwd: dir, runLeaf },
    );
    assert.equal(leafCalls.length, 2);
    assert.match(leafCalls[1]?.input ?? "", /50\. daily\/2026-07-50\.md/);
    assert.equal((deep.details as { candidateWindow?: number }).candidateWindow, 50);

    let degradedCalls = 0;
    const degraded = await memorySearch.execute(
      "degraded",
      { query: "alpha", mode: "semantic", limit: 3 },
      new AbortController().signal,
      () => {},
      {
        cwd: dir,
        runLeaf: async () => {
          degradedCalls += 1;
          return { degraded: true, text: "", reasonCode: "model-call-failed" as const };
        },
      },
    );
    assert.equal(degradedCalls, 1);
    assert.equal((degraded.details as { leafDegraded?: boolean }).leafDegraded, true);
    assert.equal(
      (degraded.details as { leafReasonCode?: string }).leafReasonCode,
      "model-call-failed",
    );
    assert.match(degraded.content[0]?.text ?? "", /keyword candidate order/);
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

  getAllTools(): Array<{ name: string }> {
    return Array.from(this.tools.keys()).map((name) => ({ name }));
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
