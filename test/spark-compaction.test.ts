import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CURRENT_SPARK_COMPACTION_SUMMARY_VERSION,
  DEFAULT_SPARK_COMPACTION_SETTINGS,
  type SparkCompactionOutcomeMetadata,
  normalizeSparkCompactionOutcomeMetadata,
  SparkHostRuntime,
  SparkSessionStore,
  compactSparkSessionRecord,
  compactSparkVisibleTranscript,
  deterministicSparkCompactionSummary,
  entriesToMessages,
  estimateSparkContextTokens,
  estimateSparkTokens,
  navigateSparkSessionBranchWithSummary,
  prepareSparkCompaction,
  sessionEntriesToAgentMessages,
  shouldSparkCompact,
  type SparkCompactionSettings,
  type SparkCliHostServices,
  type SparkSessionRecord,
} from "../apps/spark-tui/src/host/index.ts";
import { createSparkPiParitySlashCommands } from "../apps/spark-tui/src/cli/pi-parity-commands.ts";
import { SparkNativeSession } from "../apps/spark-tui/src/native-tui.ts";
import { defaultSparkMemoryStore } from "../packages/spark-memory/src/index.ts";
import sparkMemoryExtension from "../packages/spark-memory/src/extension.ts";
import { SPARK_PROMPT_ITEM_METADATA_KEY } from "../packages/spark-turn/src/agent-loop.ts";

function compactableRecord(store: SparkSessionStore): SparkSessionRecord {
  const record = store.createSession({ id: "compact", timestamp: "2026-06-03T06:00:00.000Z" });
  store.appendMessage(record, { role: "user", content: "a".repeat(400) });
  store.appendMessage(record, { role: "assistant", content: "b".repeat(400) });
  store.appendMessage(record, { role: "user", content: "recent request" });
  store.appendMessage(record, { role: "assistant", content: "recent answer" });
  return record;
}

function testContentText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

const tinyKeepSettings: SparkCompactionSettings = {
  ...DEFAULT_SPARK_COMPACTION_SETTINGS,
  keepRecentTokens: 1,
};

void test("Spark Compact V2 defaults and outcome metadata are stable", () => {
  assert.equal(DEFAULT_SPARK_COMPACTION_SETTINGS.targetReduction, 0.4);
  assert.equal(DEFAULT_SPARK_COMPACTION_SETTINGS.compactModel, "current");
  assert.equal(
    DEFAULT_SPARK_COMPACTION_SETTINGS.microThreshold <
      DEFAULT_SPARK_COMPACTION_SETTINGS.fullThreshold,
    true,
  );

  const metadata: SparkCompactionOutcomeMetadata = normalizeSparkCompactionOutcomeMetadata({
    tokenSource: "reported",
    measuredReductionRatio: 0.4,
    fallbackReason: "model_error",
  });
  assert.deepEqual(metadata, {
    summaryVersion: CURRENT_SPARK_COMPACTION_SUMMARY_VERSION,
    tokenSource: "reported",
    measuredReductionRatio: 0.4,
    fallbackReason: "model_error",
  });
  assert.equal(
    normalizeSparkCompactionOutcomeMetadata({
      tokenSource: "bogus" as never,
      measuredReductionRatio: 9,
      fallbackReason: "bogus" as never,
    }).tokenSource,
    "estimated",
  );
});

void test("Spark compaction uses Pi default trigger settings", () => {
  assert.deepEqual(DEFAULT_SPARK_COMPACTION_SETTINGS, {
    enabled: true,
    microThreshold: 0.75,
    fullThreshold: 0.9,
    targetReduction: 0.4,
    minUsefulReduction: 0.05,
    compactModel: "current",
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

    const entry = await compactSparkSessionRecord(
      record,
      preparation,
      async (input) => ({
        summary: `summary:${input.messagesToSummarize.length}:${input.turnPrefixMessages.length}`,
        details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
      }),
      {
        tokenSource: "reported",
        measuredReductionRatio: 0.4,
      },
    );

    assert.equal(entry.type, "compaction");
    assert.equal(entry.parentId, previousLeafId);
    assert.equal(entry.firstKeptEntryId, preparation.firstKeptEntryId);
    assert.equal(entry.tokensBefore, preparation.tokensBefore);
    assert.equal(entry.summary, "summary:2:1");
    assert.deepEqual(entry.details, { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
    assert.deepEqual(entry.metadata, {
      summaryVersion: CURRENT_SPARK_COMPACTION_SUMMARY_VERSION,
      tokenSource: "reported",
      measuredReductionRatio: 0.4,
    });
    assert.equal(record.entries.at(-1), entry);
    await store.save(record);
    const reloaded = await store.loadByRef(record.header.id);
    const persisted = reloaded.entries.at(-1);
    assert.equal(persisted?.type, "compaction");
    assert.deepEqual(
      persisted?.type === "compaction" ? persisted.metadata : undefined,
      entry.metadata,
    );
    assert.equal(prepareSparkCompaction(record, undefined, tinyKeepSettings), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("deterministic compaction preserves signals across the whole summarized history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-compaction-coverage-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = store.createSession({ id: "coverage" });
    for (let index = 0; index < 40; index += 1) {
      const marker = String(index).padStart(2, "0");
      store.appendMessage(record, { role: "user", content: `request-${marker}` });
      store.appendMessage(record, { role: "assistant", content: `decision-${marker}` });
    }
    store.appendMessage(record, { role: "user", content: "recent request" });
    store.appendMessage(record, { role: "assistant", content: "recent answer" });
    const preparation = prepareSparkCompaction(record, undefined, tinyKeepSettings)!;

    const summary = deterministicSparkCompactionSummary(preparation).summary;

    assert.match(summary, /request-00/u);
    assert.match(summary, /decision-20/u);
    assert.match(summary, /request-39/u);
    assert.match(summary, /Turn Context \(split turn\):/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("sessionEntriesToAgentMessages rebuilds compacted context with summary and kept messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-compaction-session-context-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = compactableRecord(store);
    const preparation = prepareSparkCompaction(record, undefined, tinyKeepSettings)!;
    await compactSparkSessionRecord(record, preparation, async () => ({
      summary: "Older conversation summary.",
    }));

    const messages = sessionEntriesToAgentMessages(record.entries);
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.match(
      testContentText(messages[0]?.content),
      /<spark_runtime_data trust="untrusted" custom_type="spark-compaction-summary">/u,
    );
    assert.match(testContentText(messages[0]?.content), /&lt;summary&gt;/u);
    assert.match(testContentText(messages[0]?.content), /Older conversation summary\./u);
    assert.deepEqual(messages[1]?.content, [{ type: "text", text: "recent answer" }]);
    assert.doesNotMatch(JSON.stringify(messages), /a{20}|b{20}|recent request/);

    store.appendMessage(record, { role: "user", content: "after compact" });
    const resumed = sessionEntriesToAgentMessages(record.entries);
    assert.deepEqual(
      resumed.map((message) => message.role),
      ["user", "assistant", "user"],
    );
    assert.equal(resumed[2]?.content, "after compact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("compactSparkVisibleTranscript persists a compaction entry and returns kept messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-visible-compact-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const result = await compactSparkVisibleTranscript(store, [
      { role: "system", text: "welcome banner", display: false },
      { role: "user", text: "Original request " + "a".repeat(200) },
      { role: "assistant", text: "Early work " + "b".repeat(200) },
      { role: "user", text: "Recent request" },
      { role: "assistant", text: "Recent answer" },
    ]);

    assert.ok(result);
    assert.equal(result.entry.type, "compaction");
    assert.match(result.entry.summary, /Conversation summary:/);
    assert.match(result.entry.summary, /Original request/);
    assert.equal(result.keptMessages.at(-1)?.content, "Recent answer");

    const saved = await store.loadByRef(result.record.header.id);
    assert.equal(saved.entries.at(-1)?.type, "compaction");
    const context = sessionEntriesToAgentMessages(saved.entries);
    assert.equal(context[0]?.role, "user");
    assert.match(
      testContentText(context[0]?.content),
      /conversation history before this point was compacted/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("navigateSparkSessionBranchWithSummary appends Pi-style branch summary at target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-branch-summary-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = store.createSession({ id: "branchy", timestamp: "2026-06-03T08:00:00.000Z" });
    store.appendMessage(record, { role: "user", content: "root request" });
    const baseId = store.appendMessage(record, { role: "assistant", content: "base answer" });
    const targetId = "target-answer";
    record.entries.push({
      type: "message",
      id: "target-user",
      parentId: baseId,
      timestamp: "2026-06-03T08:00:01.000Z",
      message: { role: "user", content: "target branch request" },
    });
    record.entries.push({
      type: "message",
      id: targetId,
      parentId: "target-user",
      timestamp: "2026-06-03T08:00:02.000Z",
      message: { role: "assistant", content: "target branch answer" },
    });
    record.entries.push({
      type: "message",
      id: "old-branch-user",
      parentId: baseId,
      timestamp: "2026-06-03T08:00:03.000Z",
      message: { role: "user", content: "old branch request" },
    });
    record.entries.push({
      type: "message",
      id: "old-branch-answer",
      parentId: "old-branch-user",
      timestamp: "2026-06-03T08:00:04.000Z",
      message: { role: "assistant", content: "old branch answer" },
    });

    const result = navigateSparkSessionBranchWithSummary(record, targetId, {
      summarize: true,
      customInstructions: "focus on abandoned work",
    });

    assert.ok(result.summaryEntry);
    assert.equal(result.summaryEntry.parentId, targetId);
    assert.equal(result.activeLeafId, result.summaryEntry.id);
    assert.match(result.summaryEntry.summary, /old branch request/);
    assert.match(result.summaryEntry.summary, /Custom focus: focus on abandoned work/);
    assert.doesNotMatch(result.summaryEntry.summary, /target branch answer/);
    const context = sessionEntriesToAgentMessages(record.entries);
    assert.deepEqual(
      context.map((message) => message.role),
      ["user", "assistant", "user", "assistant", "user"],
    );
    assert.match(testContentText(context.at(-1)?.content), /summary of a branch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native /compact and /tree summarize commands use persisted compaction helpers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-compact-slash-"));
  try {
    const cwd = join(dir, "repo");
    const store = new SparkSessionStore({ cwd, sparkHome: join(dir, ".spark") });
    const runtime = new SparkHostRuntime({ cwd });
    sparkMemoryExtension(runtime);
    await defaultSparkMemoryStore(cwd, "workspace").remember({
      scope: "workspace",
      category: "insight",
      text: "Compact handoff should preserve Spark memory checkpoints.",
      reason: "Validate /compact integration with session_before_compact memory handoff.",
    });
    const services = {
      cwd,
      runtime,
      sessionStore: store,
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    const session = new SparkNativeSession(async () => "unused");
    session.addSystemMessage("banner");
    session.messages.push({ role: "user", text: "First prompt " + "x".repeat(200) });
    session.appendAssistantChunk("First answer " + "y".repeat(200));
    session.finishAssistantMessage();
    session.messages.push({ role: "user", text: "Recent prompt" });
    session.appendAssistantChunk("Recent answer");
    session.finishAssistantMessage();

    const compacted = await commands.compact!.handler("focus", {
      app: {} as never,
      session,
      exit: () => undefined,
    });
    assert.match(String(compacted), /Compacted visible Spark transcript into session/);
    assert.equal((await store.list()).length, 1);
    const compactedText = session.messages.map((message) => message.text).join("\n");
    assert.match(compactedText, /Compacted visible transcript summary/);
    assert.match(compactedText, /Spark memory checkpoint/);
    assert.match(compactedText, /Compact handoff should preserve Spark memory checkpoints/);
    assert.equal(runtime.peekOutbox().length, 0);

    const record = compactableRecord(store);
    await store.save(record);
    const target = record.entries[1]!.id;
    const tree = await commands.tree!.handler(`${record.header.id} summarize ${target}`, {
      app: {} as never,
      session,
      exit: () => undefined,
    });
    assert.match(String(tree), /Branch summary appended:/);
    const summarized = await store.loadByRef(record.header.id);
    assert.equal(summarized.entries.at(-1)?.type, "branch_summary");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("entriesToMessages includes custom messages and branch summaries but not compaction entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-compaction-messages-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = store.createSession({ id: "messages", timestamp: "2026-06-03T07:00:00.000Z" });
    store.appendCustomMessage(record, "spark", "custom content", false, {
      k: "v",
      [SPARK_PROMPT_ITEM_METADATA_KEY]: {
        authority: "runtime_control",
        trust: "trusted",
        visibility: "hidden",
        persistence: "session",
      },
    });
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

    const messages = entriesToMessages(record.entries);
    assert.deepEqual(
      messages.map((message) => message.role),
      ["custom", "branchSummary"],
    );
    assert.equal(messages[0]?.promptAuthority, "runtime_control");
    assert.equal(messages[0]?.promptTrust, "trusted");
    assert.equal(messages[0]?.promptVisibility, "hidden");
    assert.equal(messages[0]?.promptPersistence, "session");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
