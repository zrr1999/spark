import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CURRENT_SPARK_SESSION_VERSION,
  SparkSessionStore,
  parseSparkSessionEntries,
  workspaceSessionHash,
} from "../apps/spark/src/host/index.ts";

void test("SparkSessionStore uses ~/.spark-style sessions root and workspace hash, never ~/.pi", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-path-"));
  try {
    const sparkHome = join(dir, ".spark");
    const cwd = join(dir, "workspace");
    const store = new SparkSessionStore({ cwd, sparkHome });

    assert.equal(store.workspaceHash, workspaceSessionHash(cwd));
    assert.equal(store.sessionDir, join(sparkHome, "sessions", store.workspaceHash));
    assert.equal(store.sessionDir.includes(".pi"), false);

    const record = store.createSession({ id: "session-a", timestamp: "2026-06-03T00:00:00.000Z" });
    assert.equal(record.path.endsWith("_session-a.jsonl"), true);
    assert.equal(record.path.includes(join(".spark", "sessions")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkSessionStore save/load round-trips current Pi JSONL header and entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-roundtrip-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = store.createSession({
      id: "session-roundtrip",
      timestamp: "2026-06-03T01:02:03.004Z",
    });
    const userId = store.appendMessage(record, {
      role: "user",
      content: "hello",
      timestamp: Date.parse("2026-06-03T01:02:04.000Z"),
    });
    store.appendModelChange(record, "baidu-oneapi", "claude-opus-4.8");
    store.appendThinkingLevelChange(record, "high");
    store.appendCustomEntry(record, "tools-state", { activeTools: ["read"] });
    store.appendCustomMessage(record, "spark-mode-request", "continue", true, { source: "test" });

    await store.save(record);
    const raw = await readFile(record.path, "utf8");
    const lines = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });
    assert.deepEqual(lines[0], {
      type: "session",
      version: CURRENT_SPARK_SESSION_VERSION,
      id: "session-roundtrip",
      timestamp: "2026-06-03T01:02:03.004Z",
      cwd: store.cwd,
    });
    assert.equal(lines[1]!.type, "message");
    assert.equal(lines[1]!.id, userId);
    assert.equal(lines[1]!.parentId, null);
    assert.equal(lines[2]!.type, "model_change");
    assert.equal(lines[2]!.parentId, userId);
    assert.equal(lines[3]!.type, "thinking_level_change");
    assert.equal(lines[4]!.type, "custom");
    assert.equal(lines[5]!.type, "custom_message");

    const loaded = await store.load(record.path);
    assert.deepEqual(loaded.header, record.header);
    assert.equal(loaded.entries.length, 5);
    assert.equal(loaded.entries.at(-1)?.type, "custom_message");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkSessionStore lists sessions and returns the most recently modified session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-list-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const older = store.createSession({ id: "older", timestamp: "2026-06-03T01:00:00.000Z" });
    store.appendMessage(older, {
      role: "user",
      content: "older first",
      timestamp: Date.parse("2026-06-03T01:00:01.000Z"),
    });
    await store.save(older);

    const newer = store.createSession({ id: "newer", timestamp: "2026-06-03T02:00:00.000Z" });
    store.appendMessage(newer, {
      role: "user",
      content: [{ type: "text", text: "newer first" }],
      timestamp: Date.parse("2026-06-03T02:00:01.000Z"),
    });
    await store.save(newer);

    const listed = await store.list();
    assert.deepEqual(
      listed.map((session) => session.id),
      ["newer", "older"],
    );
    assert.equal(listed[0]!.messageCount, 1);
    assert.equal(listed[0]!.firstMessage, "newer first");
    assert.equal((await store.findMostRecent())?.id, "newer");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkSessionStore atomic save leaves only jsonl session files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-atomic-"));
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "repo"), sparkHome: join(dir, ".spark") });
    const record = store.createSession({ id: "atomic", timestamp: "2026-06-03T03:00:00.000Z" });
    store.appendMessage(record, { role: "assistant", content: "saved" });
    await store.save(record);

    const names = await readdir(store.sessionDir);
    assert.deepEqual(names, ["2026-06-03T03-00-00-000Z_atomic.jsonl"]);
    assert.equal(
      names.some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("parseSparkSessionEntries skips malformed JSONL but requires a valid session header", () => {
  const parsed = parseSparkSessionEntries(
    [
      JSON.stringify({ type: "session", id: "s1", timestamp: "t", cwd: "/tmp" }),
      "{not-json}",
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "t",
        message: { role: "user" },
      }),
    ].join("\n"),
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.type, "session");
  assert.equal(parsed[1]!.type, "message");

  assert.deepEqual(parseSparkSessionEntries(JSON.stringify({ type: "message", id: "m1" })), []);
});
