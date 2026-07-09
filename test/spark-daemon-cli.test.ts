import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  handleSparkRpcLine,
  parseSparkCliCommand,
  runSparkCli,
} from "../apps/spark-tui/src/cli.ts";
import { SparkHostRuntime } from "../apps/spark-tui/src/host/runtime.ts";
import { SparkSessionStore } from "../apps/spark-tui/src/host/session-store.ts";
import { createSparkNativeTuiHarness } from "./support/spark-native-tui-harness.ts";
import {
  createSparkDaemonNativeResponder,
  handleSparkDaemonCliCommand,
  parseSparkDaemonCliArgs,
  runSparkDaemonCliCommand,
  type SparkDaemonClientOptions,
} from "../apps/spark-tui/src/cli/daemon.ts";
import { loadSparkHeadlessSessionModule } from "../apps/spark-daemon/src/spark/session-run.ts";

void test("Spark daemon loads headless session executor from workspace package source", async () => {
  const module = await loadSparkHeadlessSessionModule();
  assert.equal(typeof module.createSparkHeadlessSessionExecutor, "function");
});

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
  assert.deepEqual(
    parseSparkCliCommand(["daemon", "sessions", "list", "--all-workspaces", "--json"]),
    {
      kind: "daemon",
      command: {
        action: "sessions",
        subcommand: "list",
        json: true,
        allWorkspaces: true,
        history: true,
      },
    },
  );
  assert.deepEqual(parseSparkCliCommand(["sessions", "list", "--all-workspaces", "--json"]), {
    kind: "daemon",
    command: {
      action: "sessions",
      subcommand: "list",
      json: true,
      allWorkspaces: true,
      history: true,
    },
  });
  assert.deepEqual(parseSparkCliCommand(["session", "replay", "--session", "s1"]), {
    kind: "daemon",
    command: { action: "sessions", subcommand: "replay", json: false, sessionId: "s1" },
  });
  assert.deepEqual(
    parseSparkCliCommand([
      "sessions",
      "mailto",
      "--to",
      "session-b",
      "--message",
      "hello",
      "--json",
    ]),
    {
      kind: "daemon",
      command: {
        action: "sessions",
        subcommand: "mailto",
        json: true,
        toSessionId: "session-b",
        message: "hello",
        fromSessionId: undefined,
        subject: undefined,
      },
    },
  );
  assert.deepEqual(
    parseSparkCliCommand([
      "sessions",
      "inbox",
      "read",
      "mail:1",
      "--session",
      "session-b",
      "--json",
    ]),
    {
      kind: "daemon",
      command: {
        action: "sessions",
        subcommand: "inbox",
        json: true,
        sessionId: "session-b",
        inboxAction: "read",
        all: false,
        messageId: "mail:1",
      },
    },
  );
});

void test("spark sessions mailto and inbox send list read ack without daemon turn execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-mail-"));
  const sparkHome = join(dir, "spark-home");
  try {
    const store = new SparkSessionStore({ cwd: join(dir, "workspace-b"), sparkHome });
    await store.save(
      store.createSession({ id: "session-b", timestamp: "2026-07-08T00:00:00.000Z" }),
    );
    const client = {
      sparkHome,
      now: () => Date.parse("2026-07-08T00:01:00.000Z"),
      turnSubmit: async () => {
        throw new Error("turnSubmit must not be called by mailto");
      },
      turnStream: async () => {
        throw new Error("turnStream must not be called by mailto");
      },
      daemonQueue: async () => {
        throw new Error("daemonQueue must not be called by mailto");
      },
    } satisfies SparkDaemonClientOptions;

    const sent = await handleSparkDaemonCliCommand(
      {
        action: "sessions",
        subcommand: "mailto",
        json: true,
        toSessionId: "session-b",
        message: "hello",
      },
      client,
    );
    assert.equal(sent.action, "sessions");
    const sentResult = sent.result as {
      subcommand: string;
      message: { id: string; toSessionId: string; body: string };
      filePath: string;
    };
    assert.equal(sentResult.subcommand, "mailto");
    assert.match(sentResult.message.id, /^mail:/u);
    assert.equal(sentResult.message.toSessionId, "session-b");
    assert.equal(sentResult.message.body, "hello");
    assert.equal(sentResult.filePath.startsWith(sparkHome), true);

    const listed = await handleSparkDaemonCliCommand(
      {
        action: "sessions",
        subcommand: "inbox",
        inboxAction: "list",
        json: true,
        sessionId: "session-b",
      },
      client,
    );
    assert.equal(listed.action, "sessions");
    const listResult = (
      listed as { result: { messages: Array<{ id: string; status: string; preview: string }> } }
    ).result;
    assert.equal(listResult.messages.length, 1);
    assert.equal(listResult.messages[0]?.id, sentResult.message.id);
    assert.equal(listResult.messages[0]?.status, "pending");
    assert.equal(listResult.messages[0]?.preview, "hello");

    const read = await handleSparkDaemonCliCommand(
      {
        action: "sessions",
        subcommand: "inbox",
        inboxAction: "read",
        json: true,
        sessionId: "session-b",
        messageId: sentResult.message.id,
      },
      client,
    );
    assert.equal(read.action, "sessions");
    const readResult = (
      read as {
        result: { message: { id: string; toSessionId: string; body: string; status: string } };
      }
    ).result;
    assert.equal(readResult.message.id, sentResult.message.id);
    assert.equal(readResult.message.toSessionId, "session-b");
    assert.equal(readResult.message.body, "hello");
    assert.equal(readResult.message.status, "read");

    await handleSparkDaemonCliCommand(
      {
        action: "sessions",
        subcommand: "inbox",
        inboxAction: "ack",
        json: true,
        sessionId: "session-b",
        messageId: sentResult.message.id,
      },
      client,
    );
    const afterAck = await handleSparkDaemonCliCommand(
      {
        action: "sessions",
        subcommand: "inbox",
        inboxAction: "list",
        json: true,
        sessionId: "session-b",
      },
      client,
    );
    assert.equal(afterAck.action, "sessions");
    assert.equal((afterAck as { result: { messages: unknown[] } }).result.messages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("daemon sessions list --all-workspaces shows persistent sessions across workspace dirs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-all-sessions-"));
  const sparkHome = join(dir, "spark-home");
  try {
    const firstStore = new SparkSessionStore({ cwd: join(dir, "workspace-a"), sparkHome });
    const secondStore = new SparkSessionStore({ cwd: join(dir, "workspace-b"), sparkHome });
    await firstStore.save(
      firstStore.createSession({ id: "session-a", timestamp: "2026-01-01T00:00:00.000Z" }),
    );
    await secondStore.save(
      secondStore.createSession({ id: "session-b", timestamp: "2026-01-02T00:00:00.000Z" }),
    );

    const result = await handleSparkDaemonCliCommand(
      { action: "sessions", subcommand: "list", json: false, allWorkspaces: true },
      {
        sparkHome,
        daemonStatus: async () => ({
          observedAt: "2026-01-03T00:00:00.000Z",
          servers: [],
          queue: { inbox: 0, processed: 0, failed: 0 },
        }),
      },
    );

    assert.equal(result.action, "sessions");
    assert.equal("sessions" in result.result, true);
    const list = result.result as {
      sessions: Array<{ id: string; cwd: string }>;
      text: string;
      allWorkspaces?: boolean;
    };
    assert.equal(list.allWorkspaces, true);
    assert.deepEqual(list.sessions.map((session) => session.id).sort(), ["session-a", "session-b"]);
    assert.match(list.text, /session-a/);
    assert.match(list.text, /workspace-a/);
    assert.match(list.text, /session-b/);
    assert.match(list.text, /workspace-b/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("daemon session list defaults to live attachable workspace clients", async () => {
  const client = {
    now: () => Date.parse("2026-07-08T00:02:00.000Z"),
    workspaceList: async () => ({
      observedAt: "2026-07-08T00:02:00.000Z",
      workspaces: [
        {
          id: "ws-a",
          serverUrl: "",
          localWorkspaceKey: "workspace-a",
          displayName: "Workspace A",
          localPath: "/tmp/workspace-a",
          status: "available",
          workspaceClients: [
            {
              clientId: "wcl-live-a",
              kind: "interactive" as const,
              status: "connected" as const,
              displayName: "Spark TUI",
              attachedAt: "2026-07-08T00:00:00.000Z",
              lastSeenAt: "2026-07-08T00:01:00.000Z",
            },
            {
              clientId: "wcl-old-a",
              kind: "interactive" as const,
              status: "disconnected" as const,
              displayName: "Old TUI",
              attachedAt: "2026-07-07T00:00:00.000Z",
              lastSeenAt: "2026-07-07T00:01:00.000Z",
            },
          ],
        },
        {
          id: "ws-b",
          serverUrl: "",
          localWorkspaceKey: "workspace-b",
          displayName: "Workspace B",
          localPath: "/tmp/workspace-b",
          status: "available",
          workspaceClients: [
            {
              clientId: "wcl-live-b",
              kind: "executor" as const,
              status: "connected" as const,
              displayName: "Background executor",
              attachedAt: "2026-07-08T00:00:10.000Z",
              lastSeenAt: "2026-07-08T00:01:10.000Z",
            },
          ],
        },
      ],
    }),
    sessionList: async () => {
      throw new Error("default live list must not read persisted session history");
    },
  } satisfies SparkDaemonClientOptions;

  const result = await handleSparkDaemonCliCommand(
    { action: "sessions", subcommand: "list", json: true },
    client,
  );
  assert.equal(result.action, "sessions");
  const list = result.result as {
    live: boolean;
    history?: boolean;
    sessions: Array<{
      sessionKey: string;
      clientId: string;
      workspaceName: string;
      joinCommand: string;
    }>;
    text: string;
  };
  assert.equal(list.live, true);
  assert.equal(list.history, undefined);
  assert.deepEqual(
    list.sessions.map((session) => session.clientId),
    ["wcl-live-a", "wcl-live-b"],
  );
  assert.equal(
    list.sessions.every((session) => session.joinCommand.includes("spark tui")),
    true,
  );
  assert.match(list.text, /join: cd \/tmp\/workspace-a && spark tui/u);
  assert.doesNotMatch(list.text, /wcl-old-a/u);
});

void test("daemon sessions plural alias routes to live list", () => {
  assert.deepEqual(parseSparkDaemonCliArgs(["sessions", "list", "--json"]), {
    action: "sessions",
    subcommand: "list",
    json: true,
    allWorkspaces: false,
    history: false,
  });
  assert.deepEqual(parseSparkDaemonCliArgs(["session", "list", "--history", "--json"]), {
    action: "sessions",
    subcommand: "list",
    json: true,
    allWorkspaces: false,
    history: true,
  });
});

void test("daemon session list history flag preserves persisted session listing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-plane-sessions-"));
  const sparkHome = join(dir, "spark-home");
  try {
    const store = new SparkSessionStore({ cwd: process.cwd(), sparkHome });
    const fixture = store.createSession({ id: "fixture-a", timestamp: "2026-07-08T00:00:00.000Z" });
    store.appendMessage(fixture, { role: "user", content: "hello daemon", timestamp: 1 });
    store.appendMessage(fixture, { role: "assistant", content: "hello user", timestamp: 2 });
    await store.save(fixture);
    const other = store.createSession({ id: "fixture-b", timestamp: "2026-07-08T00:01:00.000Z" });
    store.appendMessage(other, { role: "user", content: "second", timestamp: 3 });
    await store.save(other);
    const multiline = store.createSession({
      id: "fixture-c",
      timestamp: "2026-07-08T00:01:30.000Z",
    });
    store.appendMessage(multiline, {
      role: "user",
      content: "line one\nline two\n".repeat(80),
      timestamp: 4,
    });
    await store.save(multiline);

    const client = {
      sparkHome,
      now: () => Date.parse("2026-07-08T00:02:00.000Z"),
    } satisfies SparkDaemonClientOptions;

    const list = await handleSparkDaemonCliCommand(
      { action: "sessions", subcommand: "list", json: true, history: true },
      client,
    );
    assert.equal(list.action, "sessions");
    const listResult = list.result as {
      plane: string;
      resource: string;
      history: boolean;
      text: string;
      sessions: Array<{
        sessionKey: string;
        path: string;
        updatedAt: string;
        activeGoal: string | null;
        activeLoop: string | null;
      }>;
    };
    assert.equal(listResult.plane, "daemon");
    assert.equal(listResult.resource, "session");
    assert.equal(listResult.history, true);
    assert.equal(typeof listResult.sessions[0]?.path, "string");
    assert.equal(typeof listResult.sessions[0]?.updatedAt, "string");
    assert.equal(listResult.sessions[0]?.activeGoal, null);
    assert.equal(listResult.sessions[0]?.activeLoop, null);
    assert.deepEqual(listResult.sessions.map((session) => session.sessionKey).sort(), [
      "session:fixture-a",
      "session:fixture-b",
      "session:fixture-c",
    ]);
    assert.equal(
      listResult.text.split("\n").filter((line) => line.trim()).length,
      listResult.sessions.length,
    );
    assert.match(listResult.text, /line one line two/u);
    assert.doesNotMatch(listResult.text, /line one\nline two/u);

    const show = await handleSparkDaemonCliCommand(
      { action: "sessions", subcommand: "show", json: true, sessionId: "session:fixture-a" },
      client,
    );
    assert.equal(show.action, "sessions");
    const showResult = show.result as {
      sessionKey: string;
      entryCount: number;
      messageCount: number;
      currentProjectRef: string | null;
      entries: Array<{ id: string; parentId: string | null }>;
    };
    assert.equal(showResult.sessionKey, "session:fixture-a");
    assert.equal(showResult.currentProjectRef, null);
    assert.equal(showResult.entryCount, 2);
    assert.equal(showResult.messageCount, 2);
    assert.equal(showResult.entries.length, 2);

    const tree = await handleSparkDaemonCliCommand(
      { action: "sessions", subcommand: "tree", json: true, sessionId: "fixture-a" },
      client,
    );
    assert.equal(tree.action, "sessions");
    const treeResult = tree.result as {
      nodes: Array<{
        id: string;
        parentId: string | null;
        type: string;
        depth: number;
        active: boolean;
      }>;
    };
    assert.equal(treeResult.nodes.length, 2);
    assert.equal(treeResult.nodes[0]?.parentId, null);
    assert.equal(treeResult.nodes[0]?.depth, 0);
    assert.equal(treeResult.nodes[0]?.active, false);
    assert.equal(treeResult.nodes[1]?.parentId, treeResult.nodes[0]?.id);
    assert.equal(treeResult.nodes[1]?.depth, 1);
    assert.equal(treeResult.nodes[1]?.active, true);

    const fork = await handleSparkDaemonCliCommand(
      {
        action: "sessions",
        subcommand: "fork",
        json: true,
        sessionId: "fixture-a",
        newSessionId: "fixture-fork",
      },
      client,
    );
    assert.equal(fork.action, "sessions");
    const forkResult = fork.result as {
      sessionKey: string;
      parentSessionKey: string;
      entryCount: number;
    };
    assert.equal(forkResult.sessionKey, "session:fixture-fork");
    assert.equal(forkResult.parentSessionKey, "session:fixture-a");
    assert.equal(forkResult.entryCount, 2);

    const clone = await handleSparkDaemonCliCommand(
      {
        action: "sessions",
        subcommand: "clone",
        json: true,
        sessionId: "fixture-a",
        newSessionId: "fixture-clone",
      },
      client,
    );
    assert.equal(clone.action, "sessions");
    assert.equal((clone.result as { sessionKey: string }).sessionKey, "session:fixture-clone");

    const exported = await handleSparkDaemonCliCommand(
      {
        action: "sessions",
        subcommand: "export",
        json: true,
        sessionId: "fixture-a",
        format: "jsonl",
      },
      client,
    );
    assert.equal(exported.action, "sessions");
    assert.match((exported.result as { text: string }).text, /"type":"session"/u);
    assert.match((exported.result as { text: string }).text, /"type":"message"/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("daemon run and events plane commands expose stable JSON resources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-plane-runs-"));
  try {
    const paths = testDaemonPaths(dir);
    const client = {
      paths,
      daemonQueue: async () => ({
        observedAt: "2026-07-08T00:03:00.000Z",
        state: "all" as const,
        byState: {
          inbox: [
            {
              fileName: "run-a.json",
              filePath: join(dir, "run-a.json"),
              payload: {
                enqueuedAt: "2026-07-08T00:00:00.000Z",
                task: { type: "session.run" as const, sessionId: "fixture-a", prompt: "do work" },
              },
            },
          ],
          processed: [
            {
              fileName: "run-b.json",
              filePath: join(dir, "run-b.json"),
              payload: {
                enqueuedAt: "2026-07-08T00:01:00.000Z",
                processedAt: "2026-07-08T00:02:00.000Z",
                task: { type: "session.run" as const, sessionId: "fixture-b", prompt: "done" },
              },
            },
          ],
        },
      }),
      turnCancel: async (_paths, input) => ({
        invocationId: input.invocationId,
        cancelled: true,
        message: "cancelled",
        observedAt: "2026-07-08T00:04:00.000Z",
      }),
      eventsWatch: async () => ({
        plane: "daemon" as const,
        resource: "events" as const,
        events: [
          daemonViewEventFixture("message-a", "hi"),
          daemonViewEventFixture("message-b", "there"),
        ],
        text: "daemon.view_event session.message\n",
        observedAt: "2026-07-08T00:05:00.000Z",
      }),
    } satisfies SparkDaemonClientOptions;

    const list = await handleSparkDaemonCliCommand(
      { action: "runs", subcommand: "list", json: true, state: "all" },
      client,
    );
    assert.equal(list.action, "runs");
    const listResult = list.result as {
      plane: string;
      resource: string;
      runs: Array<{ runKey: string; sessionKey?: string; state: string }>;
    };
    assert.equal(listResult.plane, "daemon");
    assert.equal(listResult.resource, "run");
    assert.deepEqual(listResult.runs.map((run) => run.runKey).sort(), [
      "run:run-a.json",
      "run:run-b.json",
    ]);
    assert.equal(
      listResult.runs.find((run) => run.runKey === "run:run-a.json")?.sessionKey,
      "session:fixture-a",
    );

    const show = await handleSparkDaemonCliCommand(
      { action: "runs", subcommand: "show", json: true, runId: "run-a.json" },
      client,
    );
    assert.equal(show.action, "runs");
    const showResult = show.result as { runKey: string; run?: { state: string } };
    assert.equal(showResult.runKey, "run:run-a.json");
    assert.equal(showResult.run?.state, "inbox");

    const cancel = await handleSparkDaemonCliCommand(
      { action: "runs", subcommand: "cancel", json: true, runId: "run-a.json" },
      client,
    );
    assert.equal(cancel.action, "runs");
    assert.equal((cancel.result as { cancelled: boolean }).cancelled, true);

    const events = await handleSparkDaemonCliCommand(
      { action: "events", subcommand: "watch", json: true, limit: 1 },
      client,
    );
    assert.equal(events.action, "events");
    const eventsResult = events.result as { plane: string; resource: string; events: unknown[] };
    assert.equal(eventsResult.plane, "daemon");
    assert.equal(eventsResult.resource, "events");
    assert.equal(eventsResult.events.length, 2);

    const ndjson: string[] = [];
    const exitCode = await runSparkDaemonCliCommand(
      { action: "events", subcommand: "watch", json: true, limit: 2 },
      { write: (text) => ndjson.push(text) },
      client,
    );
    assert.equal(exitCode, 0);
    assert.equal(ndjson.length, 2);
    assert.equal(JSON.parse(ndjson[0] ?? "{}").type, "daemon.view_event");
    assert.equal(JSON.parse(ndjson[1] ?? "{}").type, "daemon.view_event");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function daemonViewEventFixture(id: string, text: string) {
  return {
    version: 1 as const,
    source: "test" as const,
    metadata: {},
    type: "daemon.view_event" as const,
    timestamp: "2026-07-08T00:05:00.000Z",
    view: {
      version: 1 as const,
      type: "session.message" as const,
      sessionId: "fixture-a",
      message: {
        version: 1 as const,
        id,
        role: "assistant" as const,
        status: "streaming" as const,
        text,
        metadata: {},
      },
    },
  };
}

void test("parseSparkCliCommand parses Pi-compatible global modes and resource commands", () => {
  assert.deepEqual(parseSparkCliCommand(["--mode", "json", "--print", "hello"]), {
    kind: "print",
    prompt: "hello",
    mode: "json",
    options: { mode: "json" },
  });
  assert.throws(
    () => parseSparkCliCommand(["--unknown", "--print", "hello"]),
    /Unknown spark option: --unknown/,
  );
  assert.deepEqual(parseSparkCliCommand(["--mode", "rpc", "--session-id", "s1"]), {
    kind: "rpc",
    options: { mode: "rpc", sessionId: "s1" },
  });
  assert.deepEqual(parseSparkCliCommand(["--list-models", "opus", "--provider", "p1"]), {
    kind: "list-models",
    query: "opus",
    options: { provider: "p1" },
  });
  assert.deepEqual(parseSparkCliCommand(["install", "./my-skill", "--skill", "--json"]), {
    kind: "resources",
    action: "install",
    source: "./my-skill",
    resourceKind: "skill",
    json: true,
  });
});

void test("parseSparkDaemonCliArgs parses daemon IPC commands", async () => {
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
  assert.deepEqual(
    parseSparkDaemonCliArgs([
      "sessions",
      "export",
      "--session",
      "s1",
      "--format",
      "text",
      "--leaf",
      "root",
    ]),
    {
      action: "sessions",
      json: false,
      subcommand: "export",
      sessionId: "s1",
      format: "text",
      leafId: null,
    },
  );
  assert.deepEqual(parseSparkDaemonCliArgs(["session", "replay", "--json", "--session", "s1"]), {
    action: "sessions",
    json: true,
    subcommand: "replay",
    sessionId: "s1",
  });
  assert.deepEqual(parseSparkDaemonCliArgs(["session", "show", "session:fixture-a", "--json"]), {
    action: "sessions",
    json: true,
    subcommand: "show",
    sessionId: "session:fixture-a",
  });
  assert.deepEqual(parseSparkDaemonCliArgs(["session", "tree", "fixture-a", "--json"]), {
    action: "sessions",
    json: true,
    subcommand: "tree",
    sessionId: "fixture-a",
  });
  assert.deepEqual(
    parseSparkDaemonCliArgs(["session", "fork", "fixture-a", "--id", "fixture-fork", "--json"]),
    {
      action: "sessions",
      json: true,
      subcommand: "fork",
      sessionId: "fixture-a",
      newSessionId: "fixture-fork",
    },
  );
  assert.deepEqual(parseSparkDaemonCliArgs(["run", "list", "--state", "all", "--json"]), {
    action: "runs",
    json: true,
    subcommand: "list",
    state: "all",
    limit: undefined,
  });
  assert.deepEqual(parseSparkDaemonCliArgs(["run", "show", "run-a.json", "--json"]), {
    action: "runs",
    json: true,
    subcommand: "show",
    runId: "run-a.json",
  });
  assert.deepEqual(parseSparkDaemonCliArgs(["events", "watch", "--json", "--limit", "2"]), {
    action: "events",
    json: true,
    subcommand: "watch",
    limit: 2,
  });
  assert.deepEqual(parseSparkDaemonCliArgs(["start", "--json"]), {
    action: "start",
    json: true,
  });
  const daemonHelp = await handleSparkDaemonCliCommand({ action: "help" });
  assert.equal(daemonHelp.action, "help");
  assert.match(daemonHelp.text, /spark daemon queue/u);
  assert.match(daemonHelp.text, /spark daemon events watch/u);
  assert.match(daemonHelp.text, /spark daemon logs/u);
  assert.doesNotMatch(daemonHelp.text, /spark daemon task/u);
  assert.doesNotMatch(daemonHelp.text, /spark daemon goal/u);
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
      workspaceList: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        workspaces: [],
      }),
      sessionList: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        sessions: [],
        text: "No Spark sessions found",
      }),
      sessionExport: async (_paths: typeof paths, input: { sessionId: string }) => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        sessionId: input.sessionId,
        text: "exported jsonl",
      }),
      sessionReplay: async (_paths: typeof paths, input: { sessionId: string }) => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        sessionId: input.sessionId,
        text: "replayed transcript",
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

    const sessions = await handleSparkDaemonCliCommand(
      { action: "sessions", json: false, subcommand: "list" },
      client,
    );
    assert.equal(sessions.action, "sessions");
    assert.match(sessions.result.text, /No live Spark daemon sessions/);

    const exported = await handleSparkDaemonCliCommand(
      { action: "sessions", json: false, subcommand: "export", sessionId: "session-a" },
      client,
    );
    assert.equal(exported.action, "sessions");
    assert.match(exported.result.text, /exported jsonl/);

    const replayed = await handleSparkDaemonCliCommand(
      { action: "sessions", json: false, subcommand: "replay", sessionId: "session-a" },
      client,
    );
    assert.equal(replayed.action, "sessions");
    assert.match(replayed.result.text, /replayed transcript/);
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

void test("handleSparkRpcLine always routes prompt/state through daemon IPC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-rpc-"));
  try {
    const writes: Record<string, unknown>[] = [];
    await handleSparkRpcLine(
      JSON.stringify({ id: "1", type: "prompt", message: "hello rpc" }),
      {
        paths: testDaemonPaths(dir),
        startService: () => ({
          kind: "detached" as const,
          alreadyRunning: false,
          detail: "started",
        }),
        daemonStatus: async () => ({
          observedAt: "2026-06-19T00:00:00.000Z",
          servers: [],
          queue: { inbox: 0, processed: 0, failed: 0 },
        }),
        turnSubmit: async (_paths, input) => ({
          observedAt: "2026-06-19T00:00:00.000Z",
          fileName: "turn.json",
          filePath: "/tmp/turn.json",
          task: { type: "session.run" as const, ...input },
        }),
      },
      { sessionId: "rpc-daemon" },
      (value) => writes.push(value),
    );
    await handleSparkRpcLine(
      JSON.stringify({ id: "2", type: "get_state" }),
      {
        paths: testDaemonPaths(dir),
        daemonStatus: async () => ({
          observedAt: "2026-06-19T00:00:00.000Z",
          servers: [],
          queue: { inbox: 0, processed: 0, failed: 0 },
        }),
      },
      {},
      (value) => writes.push(value),
    );
    await handleSparkRpcLine(
      JSON.stringify({ id: "3", type: "get_messages" }),
      { paths: testDaemonPaths(dir) },
      {},
      (value) => writes.push(value),
    );
    await handleSparkRpcLine(
      JSON.stringify({ id: "4", type: "abort" }),
      { paths: testDaemonPaths(dir) },
      {},
      (value) => writes.push(value),
    );

    assert.equal((writes[0]?.data as { action?: string } | undefined)?.action, "submit");
    assert.equal(
      (writes[0]?.data as { result?: { fileName?: string } } | undefined)?.result?.fileName,
      "turn.json",
    );
    assert.equal((writes[1]?.data as { action?: string } | undefined)?.action, "status");
    assert.deepEqual((writes[2]?.data as { messages?: unknown[] } | undefined)?.messages, []);
    assert.deepEqual(writes[3]?.data, { queuedDaemonMode: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark TUI and headless print attach and release workspace clients", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-workspace-client-"));
  try {
    const paths = testDaemonPaths(dir);
    const workspace = {
      id: "rtwb_local",
      serverUrl: "",
      localWorkspaceKey: "workspace",
      displayName: "Workspace",
      localPath: dir,
      status: "available",
    };
    const ensures: Array<{ localPath: string }> = [];
    const attaches: Array<{ kind: string; workspaceId: string; displayName?: string }> = [];
    const releases: string[] = [];
    const submitted: Array<{ sessionId: string; prompt: string }> = [];
    const daemonClient: SparkDaemonClientOptions = {
      paths,
      startService: () => ({ kind: "detached" as const, alreadyRunning: false, detail: "started" }),
      daemonStatus: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        servers: [],
        queue: { inbox: 0, processed: 0, failed: 0 },
      }),
      workspaceEnsureLocal: async (_paths, input) => {
        ensures.push(input);
        return workspace;
      },
      workspaceClientAttach: async (_paths, input) => {
        attaches.push(input);
        const id = `wcl-${input.kind}-${attaches.length}`;
        return {
          client: {
            id,
            workspaceId: input.workspaceId,
            kind: input.kind,
            status: "connected" as const,
            attachedAt: "2026-06-19T00:00:00.000Z",
            lastSeenAt: "2026-06-19T00:00:00.000Z",
          },
          workspace,
          observedAt: "2026-06-19T00:00:00.000Z",
        };
      },
      workspaceClientRelease: async (_paths, input) => {
        releases.push(input.clientId);
        return {
          client: {
            id: input.clientId,
            workspaceId: workspace.id,
            kind: "interactive" as const,
            status: "disconnected" as const,
            attachedAt: "2026-06-19T00:00:00.000Z",
            lastSeenAt: "2026-06-19T00:00:01.000Z",
          },
          workspace,
          observedAt: "2026-06-19T00:00:01.000Z",
        };
      },
      turnSubmit: async (_paths, input) => {
        submitted.push(input);
        return {
          observedAt: "2026-06-19T00:00:00.000Z",
          fileName: "turn.json",
          filePath: join(dir, "turn.json"),
          task: { type: "session.run" as const, sessionId: input.sessionId, prompt: input.prompt },
        };
      },
    };

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (value?: unknown) => {
      logs.push(String(value));
    };
    try {
      assert.equal(await runSparkCli(["--print", "headless prompt"], { daemonClient }), 0);
      assert.equal(
        await runSparkCli(["--mode", "json", "--print", "json prompt", "--session-id", "json-s1"], {
          daemonClient,
        }),
        0,
      );
    } finally {
      console.log = originalLog;
    }
    const jsonLines = logs.filter((line) => line.startsWith("{"));
    assert.equal(JSON.parse(jsonLines.at(-6) ?? "{}").type, "session");
    assert.equal(JSON.parse(jsonLines.at(-3) ?? "{}").type, "queue_update");
    assert.equal(JSON.parse(jsonLines.at(-3) ?? "{}").followUp[0], "json prompt");

    const runtime = new SparkHostRuntime({ cwd: dir, hasUI: true });
    runtime.registerCommand("plan", {
      description: "Enter Spark plan mode",
      handler: () => undefined,
    });
    let capturedTuiOptions: unknown;
    assert.equal(
      await runSparkCli(["hello tui"], {
        daemonClient,
        createHostServices: async () =>
          ({
            cwd: dir,
            runtime,
            config: { extensions: [], providers: [], activeThinkingLevel: "medium" },
            providerRegistry: { listProviders: () => [] },
            modelSelector: {
              getActive: () => undefined,
              openPicker: async () => undefined,
              select: async () => ({ providerName: "fake", modelId: "model" }),
              getPickerState: () => ({ providers: [], items: [], active: undefined }),
              listProviderGroups: () => [],
            },
            sessionStore: {
              workspaceHash: "workspace-hash-current",
              sessionDir: join(dir, "sessions", "workspace-hash-current"),
              list: async () => [],
              findById: async () => undefined,
              loadByRef: async () => {
                throw new Error("not implemented in test stub");
              },
              load: async () => {
                throw new Error("not implemented in test stub");
              },
              createSession: () => ({
                header: {
                  type: "session" as const,
                  version: 3,
                  id: "stub-session",
                  timestamp: "2026-06-19T00:00:00.000Z",
                  cwd: dir,
                },
                path: join(dir, "stub-session.jsonl"),
                entries: [],
              }),
              appendMessage: () => "entry-1",
              save: async () => undefined,
            },
            keybindings: { snapshot: () => ({ bindings: [] }) },
            diagnostics: [],
          }) as never,
        runTui: async (input) => {
          capturedTuiOptions = input;
        },
      }),
      0,
    );

    assert.equal(
      typeof capturedTuiOptions === "object" && capturedTuiOptions !== null,
      true,
      "TUI should receive structured native options",
    );
    const slashCommands = (capturedTuiOptions as { slashCommands?: Record<string, unknown> })
      .slashCommands;
    assert.equal(Boolean(slashCommands?.plan), true, "runtime /plan command is wired");
    assert.equal(Boolean(slashCommands?.model), true, "native /model command is wired");
    assert.equal(Boolean(slashCommands?.sessions), true, "host /sessions command is wired");
    assert.equal(Boolean(slashCommands?.status), true, "daemon /status command is preserved");
    for (const command of [
      "settings",
      "scoped-models",
      "export",
      "import",
      "share",
      "copy",
      "name",
      "session",
      "changelog",
      "hotkeys",
      "fork",
      "clone",
      "tree",
      "trust",
      "login",
      "logout",
      "new",
      "compact",
      "resume",
    ]) {
      assert.equal(Boolean(slashCommands?.[command]), true, `Pi parity /${command} is wired`);
    }
    assert.equal(Boolean(slashCommands?.reload), false, "system /reload is not extension-owned");
    assert.equal(
      (capturedTuiOptions as { autocompleteBasePath?: string }).autocompleteBasePath,
      dir,
      "native TUI receives cwd for pi-tui file/path autocomplete",
    );

    assert.deepEqual(
      attaches.map((attach) => attach.kind),
      ["headless", "headless", "interactive"],
    );
    assert.deepEqual(
      attaches.map((attach) => attach.workspaceId),
      [workspace.id, workspace.id, workspace.id],
    );
    assert.deepEqual(releases, ["wcl-headless-1", "wcl-headless-2", "wcl-interactive-3"]);
    assert.equal(ensures.length, 3);
    assert.equal(submitted[0]?.prompt, "headless prompt");
    assert.match(logs.join("\n"), /turn\.json/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native TUI explicit session attach requires matching workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-workspace-attach-"));
  try {
    const { daemonClient, createHostServices } = createWorkspaceAttachTestDeps(dir, {
      existingSessionIds: new Set(["same-session"]),
    });
    const captured: unknown[] = [];

    assert.equal(
      await runSparkCli(["--session-id", "same-session"], {
        daemonClient,
        createHostServices,
        terminal: { stdinIsTTY: true, stdoutIsTTY: true },
        runTui: async (input) => {
          captured.push(input);
        },
      }),
      0,
    );
    assert.equal(
      (captured[0] as { workspaceSession?: { mode?: string; attachTarget?: string } })
        .workspaceSession?.mode,
      "attached",
    );
    assert.equal(
      (captured[0] as { workspaceSession?: { attachTarget?: string } }).workspaceSession
        ?.attachTarget,
      "same-session",
    );

    assert.equal(
      await runSparkCli(["--session-id", "other-session"], {
        daemonClient,
        createHostServices,
        terminal: { stdinIsTTY: true, stdoutIsTTY: true },
        runTui: async (input) => {
          captured.push(input);
        },
      }),
      0,
    );
    const mismatch = (
      captured[1] as {
        workspaceSession?: { mode?: string; mismatchDiagnostic?: string };
      }
    ).workspaceSession;
    assert.equal(mismatch?.mode, "mismatch");
    assert.match(mismatch?.mismatchDiagnostic ?? "", /not found in workspace/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native TUI accepts durable session-dir session id and hydrates project cockpit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-durable-attach-"));
  const stateRoot = join(dir, ".spark");
  const now = "2026-06-19T00:00:00.000Z";
  try {
    await mkdir(join(stateRoot, "sessions", "session-durable-session"), { recursive: true });
    await writeFile(
      join(stateRoot, "sessions", "index.json"),
      JSON.stringify(
        {
          version: 1,
          rebuildable: true,
          generatedAt: now,
          source: "per-session-directories",
          legacyImportOnly: [],
          sessions: [
            {
              sessionKey: "session:durable-session",
              path: "sessions/session-durable-session",
              statePath: "sessions/session-durable-session/state.json",
              goalPath: "sessions/session-durable-session/goal.json",
              loopPath: "sessions/session-durable-session/loop.json",
              todoDisplayNumbersPath: "sessions/session-durable-session/todo-display-numbers.json",
              hiddenRoleRunInboxPath: "sessions/session-durable-session/hidden-role-run-inbox.json",
              todoOwnerRef: "session:durable-session",
              currentProjectRef: "proj:current",
              currentTaskRef: "task:current",
              activeGoal: true,
              activeLoop: false,
              updatedAt: now,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const { daemonClient, createHostServices } = createDurableSessionAttachTestDeps(dir, stateRoot);
    let capturedMode: string | undefined;
    let capturedRender = "";

    assert.equal(
      await runSparkCli(["--session-dir", stateRoot, "--session-id", "durable-session"], {
        daemonClient,
        createHostServices,
        terminal: { stdinIsTTY: true, stdoutIsTTY: true },
        runTui: async (input) => {
          assert.equal(typeof input, "object");
          assert.notEqual(input, null);
          const options = input as Exclude<typeof input, string | undefined>;
          capturedMode = options.workspaceSession?.mode;
          const harness = createSparkNativeTuiHarness({
            cols: 180,
            slashCommands: options.slashCommands,
            workspaceSession: options.workspaceSession,
          });
          await options.configureApp?.(harness.app, harness.session);
          assert.equal(harness.app.cockpitSnapshot().tasks, 2);
          harness.app.toggleCockpitPanel("tasks");
          await harness.submit("/sessions");
          capturedRender = harness.render(180);
        },
      }),
      0,
    );

    assert.equal(capturedMode, "attached");
    assert.match(
      capturedRender,
      /Project: Spark daemon-first session UX and Pi\/Codex parity hardening/u,
    );
    assert.match(capturedRender, /task:current \[running\]/u);
    assert.match(capturedRender, /task:ready \[pending\]/u);
    assert.match(capturedRender, /Spark durable sessions:/u);
    assert.doesNotMatch(capturedRender, /No Spark sessions found/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native TUI attach corresponds to daemon workspace client record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-control-plane-attach-"));
  try {
    const { daemonClient, createHostServices, emitted } = createWorkspaceAttachTestDeps(dir, {
      existingSessionIds: new Set(["same-session"]),
      clientId: "control-plane-client-1",
    });
    let capturedControlPlaneSessionId: string | undefined;

    assert.equal(
      await runSparkCli(["--session-id", "same-session"], {
        daemonClient,
        createHostServices,
        terminal: { stdinIsTTY: true, stdoutIsTTY: true },
        runTui: async (input) => {
          assert.equal(typeof input, "object");
          assert.notEqual(input, null);
          const options = input as Exclude<typeof input, string | undefined>;
          capturedControlPlaneSessionId = options.workspaceSession?.controlPlaneSessionId;
          const harness = createSparkNativeTuiHarness({
            workspaceSession: options.workspaceSession,
          });
          await options.configureApp?.(harness.app, harness.session);
        },
      }),
      0,
    );

    assert.equal(capturedControlPlaneSessionId, "control-plane-client-1");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.event, "session_start");
    assert.equal(emitted[0]?.payload?.controlPlaneSessionId, "control-plane-client-1");
    assert.equal(emitted[0]?.payload?.attachTarget, "same-session");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function createDurableSessionAttachTestDeps(dir: string, stateRoot: string) {
  const now = "2026-06-19T00:00:00.000Z";
  const workspace = {
    id: "workspace-current",
    serverUrl: "http://127.0.0.1:0",
    localWorkspaceKey: "repo",
    displayName: "repo",
    localPath: dir,
    status: "active",
  };
  const daemonClient = {
    daemonStatus: async () => ({
      observedAt: now,
      servers: [],
      queue: { inbox: 0, processed: 0, failed: 0 },
    }),
    workspaceEnsureLocal: async () => workspace,
    workspaceClientAttach: async () => ({
      client: {
        id: "control-plane-client-1",
        workspaceId: workspace.id,
        kind: "interactive" as const,
        status: "connected" as const,
        attachedAt: now,
        lastSeenAt: now,
      },
      workspace,
      observedAt: now,
    }),
    workspaceClientRelease: async () => ({
      client: {
        id: "control-plane-client-1",
        workspaceId: workspace.id,
        kind: "interactive" as const,
        status: "disconnected" as const,
        attachedAt: now,
        lastSeenAt: now,
      },
      workspace,
      observedAt: now,
    }),
  } satisfies SparkDaemonClientOptions;
  const createHostServices = async (
    hostOptions: { sessionManager?: unknown; sparkStateRoot?: string } = {},
  ) => {
    const runtime = new SparkHostRuntime({
      cwd: dir,
      sparkStateRoot: hostOptions.sparkStateRoot ?? stateRoot,
      hasUI: true,
      sessionManager: hostOptions.sessionManager as never,
    });
    runtime.registerTool({
      name: "task_read",
      description: "fake task read",
      parameters: {},
      execute: async () => {
        const details = {
          found: true,
          selectedProject: {
            ref: "proj:current",
            title: "Spark daemon-first session UX and Pi/Codex parity hardening",
          },
          currentClaim: {
            ref: "task:current",
            name: "current",
            title: "Current manual fix task",
            status: "running",
            kind: "implement",
            projectRef: "proj:current",
            owner: "me",
            todos: {
              total: 1,
              hidden: 0,
              items: [{ id: "item-1", content: "do it", status: "pending" }],
            },
          },
          ready: [
            {
              ref: "task:ready",
              name: "ready",
              title: "Ready competitor benchmark",
              status: "pending",
              kind: "review",
              projectRef: "proj:current",
              owner: "unassigned",
              todos: { total: 0, hidden: 0, items: [] },
            },
          ],
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    });
    return {
      cwd: dir,
      runtime,
      config: { extensions: [], providers: [], activeThinkingLevel: "medium" },
      providerRegistry: { listProviders: () => [] },
      modelSelector: {
        getActive: () => undefined,
        openPicker: async () => undefined,
        select: async () => ({ providerName: "fake", modelId: "model" }),
        getPickerState: () => ({ providers: [], items: [], active: undefined }),
        listProviderGroups: () => [],
      },
      sessionStore: {
        workspaceHash: "workspace-hash-current",
        sessionDir: join(dir, "jsonl-sessions", "workspace-hash-current"),
        list: async () => [],
        findById: async () => undefined,
        loadByRef: async () => {
          throw new Error("not implemented in test stub");
        },
        load: async () => {
          throw new Error("not implemented in test stub");
        },
        createSession: () => ({
          header: {
            type: "session" as const,
            version: 3,
            id: "stub-session",
            timestamp: now,
            cwd: dir,
          },
          path: join(dir, "stub-session.jsonl"),
          entries: [],
        }),
        appendMessage: () => "entry-1",
        save: async () => undefined,
      },
      keybindings: { snapshot: () => ({ bindings: [] }) },
      diagnostics: [],
    } as never;
  };
  return { daemonClient, createHostServices };
}

function createWorkspaceAttachTestDeps(
  dir: string,
  options: { existingSessionIds: Set<string>; clientId?: string },
) {
  const now = "2026-06-19T00:00:00.000Z";
  const workspace = {
    id: "workspace-current",
    serverUrl: "http://127.0.0.1:0",
    localWorkspaceKey: "repo",
    displayName: "repo",
    localPath: dir,
    status: "active",
  };
  const clientId = options.clientId ?? "workspace-client-current";
  const daemonClient = {
    daemonStatus: async () => ({
      observedAt: now,
      servers: [],
      queue: { inbox: 0, processed: 0, failed: 0 },
    }),
    workspaceEnsureLocal: async () => workspace,
    workspaceClientAttach: async () => ({
      client: {
        id: clientId,
        workspaceId: workspace.id,
        kind: "interactive" as const,
        status: "connected" as const,
        attachedAt: now,
        lastSeenAt: now,
      },
      workspace,
      observedAt: now,
    }),
    workspaceClientRelease: async () => ({
      client: {
        id: clientId,
        workspaceId: workspace.id,
        kind: "interactive" as const,
        status: "disconnected" as const,
        attachedAt: now,
        lastSeenAt: now,
      },
      workspace,
      observedAt: now,
    }),
  } satisfies SparkDaemonClientOptions;
  const emitted: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const createHostServices = async () => {
    const runtime = new SparkHostRuntime({ cwd: dir, hasUI: true });
    runtime.on("session_start", (payload) => {
      emitted.push({ event: "session_start", payload: payload as Record<string, unknown> });
    });
    return {
      cwd: dir,
      runtime,
      config: { extensions: [], providers: [], activeThinkingLevel: "medium" },
      providerRegistry: { listProviders: () => [] },
      modelSelector: {
        getActive: () => undefined,
        openPicker: async () => undefined,
        select: async () => ({ providerName: "fake", modelId: "model" }),
        getPickerState: () => ({ providers: [], items: [], active: undefined }),
        listProviderGroups: () => [],
      },
      sessionStore: {
        workspaceHash: "workspace-hash-current",
        sessionDir: join(dir, "sessions", "workspace-hash-current"),
        list: async () => [],
        findById: async (sessionId: string) =>
          options.existingSessionIds.has(sessionId)
            ? {
                path: join(dir, "sessions", "workspace-hash-current", `${sessionId}.jsonl`),
                header: {
                  type: "session" as const,
                  version: 3,
                  id: sessionId,
                  timestamp: now,
                  cwd: dir,
                },
                entries: [],
              }
            : undefined,
        loadByRef: async () => {
          throw new Error("not implemented in test stub");
        },
        load: async () => {
          throw new Error("not implemented in test stub");
        },
        createSession: () => ({
          header: {
            type: "session" as const,
            version: 3,
            id: "stub-session",
            timestamp: now,
            cwd: dir,
          },
          path: join(dir, "stub-session.jsonl"),
          entries: [],
        }),
        appendMessage: () => "entry-1",
        save: async () => undefined,
      },
      keybindings: { snapshot: () => ({ bindings: [] }) },
      diagnostics: [],
    } as never;
  };
  return { daemonClient, createHostServices, emitted };
}

void test("Spark native responder streams daemon view events as assistant chunks", async () => {
  const chunks: string[] = [];
  const responder = createSparkDaemonNativeResponder(
    {
      startService: () => ({ kind: "detached" as const, alreadyRunning: false, detail: "started" }),
      daemonStatus: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        servers: [],
        queue: { inbox: 0, processed: 0, failed: 0 },
      }),
      turnStream: async (_paths, input, handlers) => {
        for (const text of ["hel", "hello"]) {
          handlers.onEvent?.({
            version: 1,
            type: "daemon.view_event",
            source: "daemon",
            emittedAt: "2026-06-19T00:00:00.000Z",
            sessionId: input.sessionId,
            invocationId: "turn.json",
            taskFileName: "turn.json",
            view: {
              version: 1,
              type: "session.message",
              sessionId: input.sessionId,
              message: { id: "assistant", role: "assistant", text, status: "streaming" },
            },
          } as never);
        }
        return {
          observedAt: "2026-06-19T00:00:00.000Z",
          fileName: "turn.json",
          filePath: "/tmp/turn.json",
          task: { type: "session.run" as const, sessionId: input.sessionId, prompt: input.prompt },
        };
      },
      daemonQueue: async () => ({
        state: "all" as const,
        observedAt: "2026-06-19T00:00:00.000Z",
        byState: {
          processed: [
            {
              fileName: "turn.json",
              filePath: "/tmp/turn.json",
              payload: {
                enqueuedAt: "2026-06-19T00:00:00.000Z",
                processedAt: "2026-06-19T00:00:01.000Z",
                task: {
                  type: "session.run" as const,
                  sessionId: "native-session",
                  prompt: "hello",
                },
                result: { assistantText: "hello", stderr: "" },
              },
            },
          ],
        },
      }),
    },
    { sessionId: "native-session" },
  );

  const output = await responder("hello", {
    appendAssistantChunk: (chunk) => chunks.push(chunk),
  });

  assert.equal(output, "");
  assert.deepEqual(chunks, ["hel", "lo"]);
});

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
          fileName: `turn-${calls.length}.json`,
          filePath: `/tmp/turn-${calls.length}.json`,
          task: { type: "session.run" as const, sessionId: input.sessionId, prompt: input.prompt },
        };
      },
      daemonQueue: async () => ({
        state: "all" as const,
        observedAt: "2026-06-19T00:00:00.000Z",
        byState: {
          processed: calls.map((call, index) => ({
            fileName: `turn-${index + 1}.json`,
            filePath: `/tmp/turn-${index + 1}.json`,
            payload: {
              enqueuedAt: "2026-06-19T00:00:00.000Z",
              processedAt: "2026-06-19T00:00:01.000Z",
              task: { type: "session.run" as const, ...call },
              result: { assistantText: `answer ${index + 1}`, stderr: "" },
            },
          })),
        },
      }),
    },
    { sessionId: "native-session" },
  );

  const firstOutput = await responder("hello through daemon");
  const secondOutput = await responder("follow-up through daemon");
  assert.equal(firstOutput, "answer 1");
  assert.equal(secondOutput, "answer 2");
  assert.deepEqual(calls, [
    { sessionId: "native-session", prompt: "hello through daemon" },
    { sessionId: "native-session", prompt: "follow-up through daemon" },
  ]);
});
