import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseSparkCliCommand } from "../apps/spark-tui/src/cli.ts";
import {
  createSparkDaemonNativeResponder,
  handleSparkDaemonCliCommand,
  parseSparkDaemonCliArgs,
  runSparkDaemonCliCommand,
} from "../apps/spark-tui/src/cli/daemon.ts";

void test("parseSparkCliCommand routes daemon and print commands without changing default TUI parsing", () => {
  assert.deepEqual(parseSparkCliCommand(["build", "this"]), {
    kind: "tui",
    initialMessage: "build this",
  });
  assert.deepEqual(parseSparkCliCommand(["--help"]), { kind: "help" });
  assert.deepEqual(parseSparkCliCommand(["--print", "hello", "daemon"]), {
    kind: "print",
    prompt: "hello daemon",
  });
  assert.deepEqual(parseSparkCliCommand(["daemon", "status", "--json"]), {
    kind: "daemon",
    command: { action: "status", json: true },
  });
  assert.deepEqual(parseSparkCliCommand(["daemon", "workspace", "ls", "--json"]), {
    kind: "daemon",
    command: { action: "service", argv: ["workspace", "ls", "--json"] },
  });
});

void test("parseSparkDaemonCliArgs parses daemon IPC commands", () => {
  assert.deepEqual(parseSparkDaemonCliArgs([]), { action: "service", argv: [] });
  assert.deepEqual(parseSparkDaemonCliArgs(["--help"]), { action: "help" });
  assert.deepEqual(parseSparkDaemonCliArgs(["submit", "--session", "s1", "-p", "hello"]), {
    action: "submit",
    json: false,
    reset: false,
    sessionId: "s1",
    prompt: "hello",
  });
  assert.deepEqual(
    parseSparkDaemonCliArgs(["submit", "--json", "--session", "s1", "trailing", "prompt"]),
    {
      action: "submit",
      json: true,
      reset: false,
      sessionId: "s1",
      prompt: "trailing prompt",
    },
  );
  assert.deepEqual(parseSparkDaemonCliArgs(["queue", "--state", "all", "--limit", "2"]), {
    action: "queue",
    json: false,
    state: "all",
    limit: 2,
  });
  assert.deepEqual(parseSparkDaemonCliArgs(["start", "--json"]), {
    action: "start",
    json: true,
  });
  assert.deepEqual(parseSparkDaemonCliArgs(["stop", "--yes"]), {
    action: "service",
    argv: ["stop", "--yes"],
  });
  assert.deepEqual(parseSparkDaemonCliArgs(["restart", "--yes"]), {
    action: "service",
    argv: ["daemon", "restart", "--yes"],
  });
});

void test("daemon CLI handlers use Spark daemon local IPC instead of direct queue execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-cli-"));
  try {
    const paths = testDaemonPaths(dir);
    let started = false;
    const client = {
      paths,
      startService: () => {
        started = true;
        return { kind: "detached" as const, alreadyRunning: false, detail: "started" };
      },
      daemonStatus: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        servers: [],
        queue: { inbox: 1, processed: 0, failed: 0 },
      }),
      daemonQueue: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        state: "inbox" as const,
        entries: [
          {
            fileName: "queued.json",
            filePath: join(dir, "queued.json"),
            payload: {
              enqueuedAt: "2026-06-19T00:00:00.000Z",
              task: { type: "session.run" as const, sessionId: "session-a", prompt: "hello" },
            },
          },
        ],
      }),
      turnSubmit: async (_paths: typeof paths, input: { sessionId: string; prompt: string }) => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        fileName: "queued.json",
        filePath: join(dir, "queued.json"),
        task: { type: "session.run" as const, sessionId: input.sessionId, prompt: input.prompt },
      }),
      sleep: async () => undefined,
    };

    const submit = await handleSparkDaemonCliCommand(
      { action: "submit", json: true, sessionId: "session-a", prompt: "hello daemon" },
      client,
    );
    assert.equal(started, true);
    assert.equal(submit.action, "submit");
    assert.equal(submit.result.task.sessionId, "session-a");

    const status = await handleSparkDaemonCliCommand({ action: "status", json: true }, client);
    assert.equal(status.action, "status");
    assert.equal(status.daemon.running, true);

    const queue = await handleSparkDaemonCliCommand(
      { action: "queue", json: true, state: "inbox" },
      client,
    );
    assert.equal(queue.action, "queue");
    assert.equal(queue.result.entries?.[0]?.payload.task.prompt, "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkDaemonCliCommand delegates service commands", async () => {
  const calls: string[][] = [];
  const code = await runSparkDaemonCliCommand(
    { action: "service", argv: ["workspace", "ls", "--json"] },
    { write: () => undefined },
    {
      serviceCommand: async (argv) => {
        calls.push(argv);
        return 7;
      },
    },
  );

  assert.equal(code, 7);
  assert.deepEqual(calls, [["workspace", "ls", "--json"]]);
});

void test("runSparkDaemonCliCommand prints JSON when requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-cli-output-"));
  try {
    const paths = testDaemonPaths(dir);
    const writes: string[] = [];
    await runSparkDaemonCliCommand(
      { action: "status", json: true },
      { write: (text) => writes.push(text) },
      { paths },
    );
    const parsed = JSON.parse(writes[0] ?? "{}") as {
      action?: string;
      daemon?: { running?: boolean };
    };
    assert.equal(parsed.action, "status");
    assert.equal(parsed.daemon?.running, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function testDaemonPaths(root: string) {
  const runtimeDir = join(root, "run");
  return {
    runtimeDir,
    socketPath: join(runtimeDir, "daemon.sock"),
    pidFile: join(runtimeDir, "daemon.pid"),
    lockPath: join(runtimeDir, "daemon.lock"),
  };
}

void test("Spark native responder submits prompts through daemon IPC", async () => {
  const calls: Array<{ sessionId: string; prompt: string }> = [];
  const responder = createSparkDaemonNativeResponder(
    {
      startService: () => ({ kind: "detached" as const, alreadyRunning: false, detail: "started" }),
      daemonStatus: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        servers: [],
        queue: { inbox: 0, processed: 0, failed: 0 },
      }),
      turnSubmit: async (_paths, input) => {
        calls.push({ sessionId: input.sessionId, prompt: input.prompt });
        return {
          observedAt: "2026-06-19T00:00:00.000Z",
          fileName: "turn.json",
          filePath: "/tmp/turn.json",
          task: { type: "session.run" as const, sessionId: input.sessionId, prompt: input.prompt },
        };
      },
      sleep: async () => undefined,
    },
    { sessionId: "native-session" },
  );

  const firstOutput = await responder("hello through daemon");
  const secondOutput = await responder("follow-up through daemon");
  assert.match(firstOutput, /queued for Spark daemon session native-session: turn\.json/);
  assert.match(secondOutput, /queued for Spark daemon session native-session: turn\.json/);
  assert.deepEqual(calls, [
    { sessionId: "native-session", prompt: "hello through daemon" },
    { sessionId: "native-session", prompt: "follow-up through daemon" },
  ]);
});
