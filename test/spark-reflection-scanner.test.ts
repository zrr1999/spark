import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  emptyReflectionScanCursor,
  loadReflectionScanCursor,
  reflectionScanCursorPath,
  saveReflectionScanCursor,
  scanSparkSessionHistory,
  summarizeReflectionScan,
} from "../packages/spark-memory/src/reflection-session-scanner.ts";

test("reflection scanner extracts user/custom/summary observations and tolerates malformed lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reflection-scan-"));
  try {
    const sessionDir = join(dir, "--Users-zhanrongrui-workspace-demo--");
    await mkdir(sessionDir, { recursive: true });
    const file = join(sessionDir, "2026-06-18T00-00-00-000Z_session-one.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "session",
          id: "session-one",
          cwd: "/Users/zhanrongrui/workspace/demo",
        }),
        JSON.stringify({
          type: "message",
          id: "u1",
          timestamp: "2026-06-18T00:00:00.000Z",
          message: { role: "user", content: "TODO: implement scanner cursor" },
        }),
        JSON.stringify({
          type: "message",
          id: "u2",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "blocked by missing tests; remaining validation is unfinished",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "custom_message",
          id: "c1",
          customType: "spark-mode-context",
          content: "Spark context: Unfinished tasks: candidate inbox",
        }),
        JSON.stringify({
          type: "compaction",
          id: "s1",
          summary: "## Goal\n后续补上 docs validation",
        }),
        "{ bad json",
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await scanSparkSessionHistory({
      sessionRoot: dir,
      cursor: emptyReflectionScanCursor("2026-06-18T00:00:00.000Z"),
    });
    assert.equal(result.stats.filesSeen, 1);
    assert.equal(result.stats.userMessages, 2);
    assert.equal(result.stats.customMessages, 1);
    assert.equal(result.stats.summaryHints, 1);
    assert.equal(result.stats.parseErrors, 1);
    assert.equal(result.observations.length, 4);
    assert.ok(result.observations.some((observation) => observation.kind === "summary_hint"));
    assert.ok(result.observations.some((observation) => observation.signals.includes("blocker")));
    assert.match(summarizeReflectionScan(result), /Reflection session scan report/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reflection scanner cursor prevents duplicate scans and recovers appended lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reflection-cursor-"));
  try {
    const sessionDir = join(dir, "--Users-zhanrongrui-workspace-demo--");
    await mkdir(sessionDir, { recursive: true });
    const file = join(sessionDir, "2026-06-18T00-00-00-000Z_session-one.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        type: "session",
        id: "session-one",
        cwd: "/Users/zhanrongrui/workspace/demo",
      }) +
        "\n" +
        JSON.stringify({
          type: "message",
          id: "u1",
          message: { role: "user", content: "TODO: first scan" },
        }) +
        "\n",
      "utf8",
    );

    const first = await scanSparkSessionHistory({
      sessionRoot: dir,
      cursor: emptyReflectionScanCursor(),
    });
    assert.equal(first.observations.length, 1);

    const cursorPath = reflectionScanCursorPath(dir);
    await saveReflectionScanCursor(cursorPath, first.cursor);
    const loaded = await loadReflectionScanCursor(cursorPath);
    const second = await scanSparkSessionHistory({ sessionRoot: dir, cursor: loaded });
    assert.equal(second.observations.length, 0);
    assert.equal(second.stats.linesScanned, 0);

    await writeFile(
      file,
      (await readFile(file, "utf8")) +
        JSON.stringify({
          type: "message",
          id: "u2",
          message: { role: "user", content: "follow-up: add appended line handling" },
        }) +
        "\n",
      "utf8",
    );
    const third = await scanSparkSessionHistory({ sessionRoot: dir, cursor: second.cursor });
    assert.equal(third.observations.length, 1);
    assert.equal(third.observations[0]?.source.entryId, "u2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
