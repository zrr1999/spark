import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_SPARK_COMPACTION_SETTINGS,
  SparkSessionStore,
  compactSparkSessionRecord,
  entriesToMessages,
  estimateSparkContextTokens,
  estimateSparkTokens,
  prepareSparkCompaction,
  shouldSparkCompact,
  type SparkCompactionSettings,
  type SparkSessionRecord,
} from "../packages/spark-cli/src/host/index.ts";

function compactableRecord(store: SparkSessionStore): SparkSessionRecord {
  const record = store.createSession({ id: "compact", timestamp: "2026-06-03T06:00:00.000Z" });
  store.appendMessage(record, { role: "user", content: "a".repeat(400) });
  store.appendMessage(record, { role: "assistant", content: "b".repeat(400) });
  store.appendMessage(record, { role: "user", content: "recent request" });
  store.appendMessage(record, { role: "assistant", content: "recent answer" });
  return record;
}

const tinyKeepSettings: SparkCompactionSettings = {
  ...DEFAULT_SPARK_COMPACTION_SETTINGS,
  keepRecentTokens: 1,
};

void test("Spark compaction uses Pi default trigger settings", () => {
  assert.deepEqual(DEFAULT_SPARK_COMPACTION_SETTINGS, {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
  });
  assert.equal(shouldSparkCompact(90_000, 100_000), true);
  assert.equal(shouldSparkCompact(80_000, 100_000), false);
  assert.equal(
    shouldSparkCompact(90_000, 100_000, { ...DEFAULT_SPARK_COMPACTION_SETTINGS, enabled: false }),
    false,
  );
});

void test("Spark compaction token estimates follow chars/4 heuristic for native messages", () => {
  assert.equal(estimateSparkTokens({ role: "user", content: "12345678" }), 2);
  assert.equal(
    estimateSparkTokens({
      role: "assistant",
      content: [
        { type: "text", text: "1234" },
        { type: "thinking", thinking: "1234" },
        { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
      ],
    }),
    7,
  );
  assert.equal(estimateSparkContextTokens([{ role: "user", content: "1234" }]).tokens, 1);
});

void test("prepareSparkCompaction finds first kept entry and split-turn prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-compaction-prepare-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = compactableRecord(store);
    const preparation = prepareSparkCompaction(record, undefined, tinyKeepSettings)!;

    assert.equal(preparation.firstKeptEntryId, record.entries[3]!.id);
    assert.equal(preparation.isSplitTurn, true);
    assert.deepEqual(
      preparation.messagesToSummarize.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.deepEqual(
      preparation.turnPrefixMessages.map((message) => message.content),
      ["recent request"],
    );
    assert.equal(preparation.tokensBefore > preparation.settings.keepRecentTokens, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("compactSparkSessionRecord appends Pi-compatible compaction entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-compaction-append-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = compactableRecord(store);
    const preparation = prepareSparkCompaction(record, undefined, tinyKeepSettings)!;
    const previousLeafId = record.entries.at(-1)!.id;

    const entry = await compactSparkSessionRecord(record, preparation, async (input) => ({
      summary: `summary:${input.messagesToSummarize.length}:${input.turnPrefixMessages.length}`,
      details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
    }));

    assert.equal(entry.type, "compaction");
    assert.equal(entry.parentId, previousLeafId);
    assert.equal(entry.firstKeptEntryId, preparation.firstKeptEntryId);
    assert.equal(entry.tokensBefore, preparation.tokensBefore);
    assert.equal(entry.summary, "summary:2:1");
    assert.deepEqual(entry.details, { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
    assert.equal(record.entries.at(-1), entry);
    assert.equal(prepareSparkCompaction(record, undefined, tinyKeepSettings), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("entriesToMessages includes custom messages and branch summaries but not compaction entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-compaction-messages-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = store.createSession({ id: "messages", timestamp: "2026-06-03T07:00:00.000Z" });
    store.appendCustomMessage(record, "spark", "custom content", true, { k: "v" });
    record.entries.push({
      type: "branch_summary",
      id: "branch-summary",
      parentId: record.entries.at(-1)!.id,
      timestamp: "2026-06-03T07:00:01.000Z",
      fromId: "root",
      summary: "branch context",
    });
    record.entries.push({
      type: "compaction",
      id: "compaction",
      parentId: "branch-summary",
      timestamp: "2026-06-03T07:00:02.000Z",
      summary: "already compacted",
      firstKeptEntryId: "branch-summary",
      tokensBefore: 100,
    });

    assert.deepEqual(
      entriesToMessages(record.entries).map((message) => message.role),
      ["custom", "branchSummary"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
