import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseSparkCliCommand } from "../packages/spark-cli/src/cli.ts";
import {
  handleSparkDaemonCliCommand,
  parseSparkDaemonCliArgs,
  runSparkDaemonCliCommand,
} from "../packages/spark-cli/src/cli/daemon.ts";
import { readSparkDaemonLock } from "../packages/spark-cli/src/host/index.ts";

void test("parseSparkCliCommand routes daemon subcommands without changing default TUI parsing", () => {
  assert.deepEqual(parseSparkCliCommand(["build", "this"]), {
    kind: "tui",
    initialMessage: "build this",
  });
  assert.deepEqual(parseSparkCliCommand(["--help"]), { kind: "help" });
  assert.deepEqual(parseSparkCliCommand(["daemon", "status", "--json"]), {
    kind: "daemon",
    command: { action: "status", sparkHome: undefined, json: true },
  });
});

void test("parseSparkDaemonCliArgs parses local queue commands", () => {
  assert.deepEqual(parseSparkDaemonCliArgs([]), { action: "help" });
  assert.deepEqual(parseSparkDaemonCliArgs(["enqueue", "--session", "s1", "-p", "hello"]), {
    action: "enqueue",
    sparkHome: undefined,
    json: false,
    sessionId: "s1",
    prompt: "hello",
  });
  assert.deepEqual(
    parseSparkDaemonCliArgs(["enqueue", "--json", "--session", "s1", "trailing", "prompt"]),
    {
      action: "enqueue",
      sparkHome: undefined,
      json: true,
      sessionId: "s1",
      prompt: "trailing prompt",
    },
  );
  assert.deepEqual(parseSparkDaemonCliArgs(["queue", "--state", "all", "--limit", "2"]), {
    action: "queue",
    sparkHome: undefined,
    json: false,
    state: "all",
    limit: 2,
  });
  assert.deepEqual(parseSparkDaemonCliArgs(["run", "--once", "--poll-ms", "10"]), {
    action: "run",
    sparkHome: undefined,
    json: false,
    cwd: undefined,
    once: true,
    pollIntervalMs: 10,
  });
});

void test("daemon CLI handlers enqueue, list, report status, and run once on empty queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-cli-"));
  try {
    const sparkHome = join(dir, ".spark");
    await mkdir(sparkHome, { recursive: true });
    await writeFile(join(sparkHome, "config.json"), '{"extensions":[],"providers":[]}\n', "utf8");
    const enqueue = await handleSparkDaemonCliCommand({
      action: "enqueue",
      sparkHome,
      json: true,
      sessionId: "session-a",
      prompt: "hello daemon",
    });
    if (enqueue.action !== "enqueue") throw new Error("expected enqueue result");
    assert.equal(enqueue.task.sessionId, "session-a");

    const status = await handleSparkDaemonCliCommand({ action: "status", sparkHome, json: true });
    if (status.action !== "status") throw new Error("expected status result");
    assert.equal(status.running, false);
    assert.deepEqual(status.queue, { inbox: 1, processed: 0, failed: 0 });

    const queue = await handleSparkDaemonCliCommand({
      action: "queue",
      sparkHome,
      json: true,
      state: "inbox",
    });
    if (queue.action !== "queue") throw new Error("expected queue result");
    assert.equal(queue.entries?.[0]?.payload.task.prompt, "hello daemon");

    const failedRun = await handleSparkDaemonCliCommand({
      action: "run",
      sparkHome,
      json: true,
      once: true,
    });
    if (failedRun.action !== "run") throw new Error("expected run result");
    assert.equal(failedRun.didWork, true);
    assert.equal(await readSparkDaemonLock(join(sparkHome, "runtime", "daemon.lock")), null);

    const after = await handleSparkDaemonCliCommand({ action: "status", sparkHome, json: true });
    if (after.action !== "status") throw new Error("expected status result");
    assert.deepEqual(after.queue, { inbox: 0, processed: 0, failed: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkDaemonCliCommand prints JSON when requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-cli-output-"));
  try {
    const writes: string[] = [];
    await runSparkDaemonCliCommand(
      { action: "status", sparkHome: join(dir, ".spark"), json: true },
      { write: (text) => writes.push(text) },
    );
    const parsed = JSON.parse(writes[0] ?? "{}") as { action?: string; queue?: unknown };
    assert.equal(parsed.action, "status");
    assert.deepEqual(parsed.queue, { inbox: 0, processed: 0, failed: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
