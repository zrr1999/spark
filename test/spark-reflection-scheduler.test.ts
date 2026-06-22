import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  REFLECTION_MIN_INTERVAL_MS,
  reflectionSchedulerStatus,
  registerSparkReflectionCommands,
  runReflectionOnce,
  stopReflectionScheduler,
} from "../packages/spark-extension/src/extension/reflection-in-session-scheduler.ts";
import type {
  SparkCommandApi,
  SparkCommandContext,
} from "../packages/spark-extension/src/extension/spark-command-registration.ts";

void test("runReflectionOnce scans incrementally, writes cursor/candidates/report, and avoids duplicate observations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reflection-run-"));
  try {
    const sessionRoot = join(dir, "sessions");
    const sessionDir = join(sessionRoot, "--Users-zhanrongrui-workspace-demo--");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "2026-06-18T00-00-00-000Z_session-one.jsonl"),
      [
        JSON.stringify({
          type: "session",
          id: "session-one",
          cwd: "/Users/zhanrongrui/workspace/demo",
        }),
        JSON.stringify({
          type: "message",
          id: "u1",
          message: { role: "user", content: "TODO: add scheduled reflection report" },
        }),
        JSON.stringify({
          type: "message",
          id: "u2",
          message: {
            role: "user",
            content: "blocked by missing docs; remaining validation is unfinished",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const ctx = { cwd: dir } satisfies Pick<SparkCommandContext, "cwd">;
    const first = await runReflectionOnce(ctx, {
      sessionRoot,
      maxCandidates: 10,
      maxObservations: 10,
    });
    assert.equal(first.observations, 2);
    assert.equal(first.candidatesCreated, 2);
    await stat(first.cursorPath);
    await stat(first.candidateStorePath);
    await stat(first.reportPath);
    assert.match(await readFile(first.reportPath, "utf8"), /Reflection synthesis report/);

    const second = await runReflectionOnce(ctx, {
      sessionRoot,
      maxCandidates: 10,
      maxObservations: 10,
    });
    assert.equal(second.observations, 0);
    assert.equal(second.candidatesCreated, 0);
    assert.equal(second.candidatesStored, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("/reflect command runs once and session-local scheduler starts/stops safely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reflection-command-"));
  try {
    const sessionRoot = join(dir, "sessions");
    const sessionDir = join(sessionRoot, "--Users-zhanrongrui-workspace-demo--");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "2026-06-18T00-00-00-000Z_session-one.jsonl"),
      JSON.stringify({
        type: "session",
        id: "session-one",
        cwd: "/Users/zhanrongrui/workspace/demo",
      }) +
        "\n" +
        JSON.stringify({
          type: "message",
          id: "u1",
          message: { role: "user", content: "TODO: command reflection" },
        }) +
        "\n",
      "utf8",
    );
    const pi = new FakePi();
    registerSparkReflectionCommands(pi);
    const reflect = pi.commands.get("reflect");
    assert.ok(reflect);
    const ctx = { cwd: dir } as SparkCommandContext;

    await reflect(`run --session-root ${sessionRoot} --max-candidates 5`, ctx);
    assert.equal(pi.messages.at(-1)?.customType, "spark-reflection-report");
    assert.match(pi.messages.at(-1)?.content ?? "", /Reflection run complete/);

    await reflect(`start --session-root ${sessionRoot} --interval-ms 1`, ctx);
    const status = reflectionSchedulerStatus(ctx);
    assert.equal(status.running, true);
    if (status.running) assert.equal(status.intervalMs, REFLECTION_MIN_INTERVAL_MS);
    await reflect(`start --session-root ${sessionRoot} --interval-ms 60000`, ctx);
    const restarted = reflectionSchedulerStatus(ctx);
    assert.equal(restarted.running, true);
    if (restarted.running) assert.equal(restarted.intervalMs, 60000);
    await reflect("status", ctx);
    assert.match(pi.messages.at(-1)?.content ?? "", /running every/);
    pi.events.get("session_reload")?.({}, ctx);
    assert.deepEqual(reflectionSchedulerStatus(ctx), { running: false });
    await reflect(`start --session-root ${sessionRoot} --interval-ms 60000`, ctx);
    pi.events.get("session_fork")?.({}, ctx);
    assert.deepEqual(reflectionSchedulerStatus(ctx), { running: false });
    await reflect(`start --session-root ${sessionRoot} --interval-ms 60000`, ctx);
    await reflect("stop", ctx);
    assert.deepEqual(reflectionSchedulerStatus(ctx), { running: false });
    assert.equal(stopReflectionScheduler(ctx), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("reflection run lock skips overlapping runs for the same workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reflection-lock-"));
  try {
    const sessionRoot = join(dir, "sessions");
    const sessionDir = join(sessionRoot, "--Users-zhanrongrui-workspace-demo--");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "2026-06-18T00-00-00-000Z_session-one.jsonl"),
      JSON.stringify({
        type: "session",
        id: "session-one",
        cwd: "/Users/zhanrongrui/workspace/demo",
      }) +
        "\n" +
        JSON.stringify({
          type: "message",
          id: "u1",
          message: { role: "user", content: "TODO: prove lock" },
        }) +
        "\n",
      "utf8",
    );
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = { cwd: dir } satisfies Pick<SparkCommandContext, "cwd">;
    const first = runReflectionOnce(ctx, { sessionRoot, testHookBeforeScan: () => blocker });
    const second = await runReflectionOnce(ctx, { sessionRoot });
    assert.equal(second.skippedReason, "already_running");
    release();
    assert.equal((await first).observations, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

class FakePi implements SparkCommandApi {
  commands = new Map<string, (args: string, ctx: SparkCommandContext) => Promise<void> | void>();
  events = new Map<string, (event: unknown, ctx: SparkCommandContext) => unknown>();
  messages: Array<{
    customType: string;
    content: string;
    display?: boolean;
    details?: Record<string, unknown>;
  }> = [];
  registerCommand(
    name: string,
    config: {
      description: string;
      handler: (args: string, ctx: SparkCommandContext) => Promise<void> | void;
    },
  ): void {
    this.commands.set(name, config.handler);
  }
  on(event: string, handler: (event: unknown, ctx: SparkCommandContext) => unknown): void {
    this.events.set(event, handler);
  }
  sendMessage(message: {
    customType: string;
    content: string;
    display?: boolean;
    details?: Record<string, unknown>;
  }): void {
    this.messages.push(message);
  }
}
