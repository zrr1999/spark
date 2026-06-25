import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  handleSparkRpcLine,
  parseSparkCliCommand,
  runSparkCli,
} from "../apps/spark-tui/src/cli.ts";
import { SparkHostRuntime } from "../apps/spark-tui/src/host/runtime.ts";
import {
  createSparkDaemonNativeResponder,
  handleSparkDaemonCliCommand,
  parseSparkDaemonCliArgs,
  runSparkDaemonCliCommand,
  type SparkDaemonClientOptions,
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

void test("parseSparkCliCommand parses Pi-compatible global modes and resource commands", () => {
  assert.deepEqual(parseSparkCliCommand(["--mode", "json", "--print", "hello"]), {
    kind: "print",
    prompt: "hello",
    mode: "json",
    options: { mode: "json" },
  });
  assert.deepEqual(parseSparkCliCommand(["--direct", "--mode", "json", "--print", "hello"]), {
    kind: "print",
    prompt: "hello",
    mode: "json",
    options: { direct: true, mode: "json" },
  });
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
    assert.match(sessions.result.text, /No Spark sessions/);

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

void test("runSparkCli supports explicit direct --print and JSON lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-direct-print-"));
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (value?: unknown) => {
    logs.push(String(value));
  };
  try {
    assert.equal(
      await runSparkCli(["--direct", "--print", "direct prompt"], {
        createHostServices: async () => fakeDirectCliServices(dir, "direct answer"),
        daemonClient: failIfDaemonClientUsed(),
      }),
      0,
    );
    assert.equal(
      await runSparkCli(["--direct", "--mode", "json", "--print", "json direct"], {
        createHostServices: async () => fakeDirectCliServices(dir, "json answer"),
        daemonClient: failIfDaemonClientUsed(),
      }),
      0,
    );
  } finally {
    console.log = originalLog;
    await rm(dir, { recursive: true, force: true });
  }

  assert.match(logs[0] ?? "", /direct-submit/);
  const jsonLines = logs.filter((line) => line.startsWith("{"));
  const turnEnd = JSON.parse(jsonLines.at(-2) ?? "{}") as {
    type?: string;
    message?: { content?: Array<{ text?: string }> };
  };
  assert.equal(turnEnd.type, "turn_end");
  assert.equal(turnEnd.message?.content?.[0]?.text, "json answer");
});

void test("handleSparkRpcLine supports explicit direct in-process RPC mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-direct-rpc-"));
  try {
    const writes: Record<string, unknown>[] = [];
    const services = fakeDirectCliServices(dir, "rpc answer");
    await handleSparkRpcLine(
      JSON.stringify({ id: "1", type: "prompt", message: "hello rpc" }),
      failIfDaemonClientUsed(),
      { direct: true, sessionId: "rpc-direct" },
      services,
      (value) => writes.push(value),
    );
    await handleSparkRpcLine(
      JSON.stringify({ id: "2", type: "get_state" }),
      failIfDaemonClientUsed(),
      { direct: true },
      services,
      (value) => writes.push(value),
    );
    await handleSparkRpcLine(
      JSON.stringify({ id: "3", type: "get_messages" }),
      failIfDaemonClientUsed(),
      { direct: true },
      services,
      (value) => writes.push(value),
    );
    await handleSparkRpcLine(
      JSON.stringify({ id: "4", type: "abort" }),
      failIfDaemonClientUsed(),
      { direct: true },
      services,
      (value) => writes.push(value),
    );
    await handleSparkRpcLine(
      JSON.stringify({ id: "5", type: "new_session" }),
      failIfDaemonClientUsed(),
      { direct: true },
      services,
      (value) => writes.push(value),
    );

    assert.equal((writes[0]?.data as { action?: string } | undefined)?.action, "direct-submit");
    assert.equal((writes[0]?.data as { text?: string } | undefined)?.text, "rpc answer");
    assert.deepEqual(writes[1]?.data, { mode: "direct", state: "idle" });
    assert.equal(
      ((writes[2]?.data as { messages?: unknown[] } | undefined)?.messages ?? []).length >= 2,
      true,
    );
    assert.deepEqual(writes[3]?.data, { mode: "direct", aborted: true });
    assert.deepEqual((writes[4]?.data as { messages?: unknown[] } | undefined)?.messages, []);
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
              list: async () => [],
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
      "reload",
    ]) {
      assert.equal(Boolean(slashCommands?.[command]), true, `Pi parity /${command} is wired`);
    }
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

function fakeDirectCliServices(dir: string, answer: string) {
  const messages: unknown[] = [];
  return {
    cwd: dir,
    sessionStore: { sessionDir: join(dir, "sessions") },
    agentLoop: {
      async submit(content: string) {
        messages.push({ role: "user", content, timestamp: Date.now() });
        const message = {
          role: "assistant",
          content: [{ type: "text", text: answer }],
          stopReason: "stop",
        };
        messages.push(message);
        return message;
      },
      getMessages: () => messages,
      getState: () => "idle",
      abort: () => undefined,
      replaceMessages: (next: readonly unknown[]) => {
        messages.splice(0, messages.length, ...next);
      },
    },
  } as never;
}

function failIfDaemonClientUsed(): SparkDaemonClientOptions {
  return {
    startService: () => {
      throw new Error("daemon client should not be used in direct mode");
    },
    turnSubmit: async () => {
      throw new Error("daemon submit should not be used in direct mode");
    },
  };
}
