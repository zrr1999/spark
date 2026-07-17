import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SparkDaemonLocalRpcError,
  SparkDaemonLocalRpcRemoteError,
  SparkDaemonLocalRpcUnavailableError,
} from "@zendev-lab/spark-system/daemon-local-rpc";
import { parseSparkDaemonEvent, parseSparkInteractionRequest } from "@zendev-lab/spark-protocol";

import {
  handleSparkRpcLine,
  parseSparkCliCommand,
  runSparkCli,
} from "../apps/spark-tui/src/cli.ts";
import { SparkKeybindings } from "../apps/spark-tui/src/host/keybindings.ts";
import type { SparkCliHostServices } from "../apps/spark-tui/src/host/bootstrap.ts";
import { SparkHostRuntime } from "../apps/spark-tui/src/host/runtime.ts";
import { SparkSessionMailStore } from "../apps/spark-tui/src/host/session-mail-store.ts";
import { SparkSessionStore } from "../apps/spark-tui/src/host/session-store.ts";
import { createSparkNativeTuiHarness } from "./support/spark-native-tui-harness.ts";
import {
  clientRespondHumanInteraction,
  createSparkDaemonNativeResponder,
  handleSparkDaemonHumanInteractionRequest,
  handleSparkDaemonCliCommand,
  parseSparkDaemonCliArgs,
  runSparkDaemonCliCommand,
  type ManagedSessionRegistryResult,
  type SparkDaemonClientOptions,
} from "../apps/spark-tui/src/cli/daemon.ts";
import { loadSparkHeadlessSessionModule } from "../apps/spark-daemon/src/spark/session-run.ts";
import { CREATE_SPARK_SESSION_SELECTION } from "../apps/spark-tui/src/tui/session-selector.ts";

void test("Spark daemon loads headless session executor from workspace package source", async () => {
  const module = await loadSparkHeadlessSessionModule();
  assert.equal(typeof module.createSparkHeadlessSessionExecutor, "function");
});

void test("native TUI client delivers daemon-owned human interaction responses", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const result = await clientRespondHumanInteraction(
    {
      interactionRequestId: "interaction-1",
      sessionId: "session-1",
      invocationId: "invocation-1",
      humanResponseId: `hres_${"1".repeat(32)}`,
      status: "answered",
      answers: { approval: true },
      responseArtifactRefs: ["artifact-1"],
    },
    {
      daemonStatus: async () => runningDaemonStatus(),
      controlRequest: async (method, params) => {
        requests.push({ method, params });
        return {
          outcome: "accepted",
          retryable: false,
          returnedToTool: true,
          message: "Response accepted.",
        };
      },
    },
  );

  assert.deepEqual(requests, [
    {
      method: "human.interaction.respond",
      params: {
        interactionRequestId: "interaction-1",
        sessionId: "session-1",
        invocationId: "invocation-1",
        humanResponseId: `hres_${"1".repeat(32)}`,
        status: "answered",
        answers: { approval: true },
        responseArtifactRefs: ["artifact-1"],
      },
    },
  ]);
  assert.equal(result.outcome, "accepted");
  assert.equal(result.returnedToTool, true);
});

void test("a not-found Ask race retries the same answer without reopening the interaction", async () => {
  const request = parseSparkInteractionRequest({
    requestId: "interaction-race",
    kind: "askFlow",
    title: "Continue?",
    questions: [{ id: "decision", prompt: "Continue?", options: [] }],
  });
  const event = parseSparkDaemonEvent({
    type: "daemon.interaction.request",
    source: "daemon",
    sessionId: "session-race",
    invocationId: "invocation-race",
    request,
    metadata: {},
  });
  if (event.type !== "daemon.interaction.request") throw new Error("expected interaction event");
  let presentations = 0;
  let rpcAttempts = 0;
  const sleeps: number[] = [];
  const responseIds: string[] = [];

  await handleSparkDaemonHumanInteractionRequest(request, event, {
    currentSessionId: "session-race",
    interaction: async () => {
      presentations += 1;
      return {
        version: 1,
        kind: "askFlow",
        requestId: request.requestId,
        status: "answered",
        answers: { decision: "continue" },
        nextAction: "resume",
        metadata: {},
      };
    },
    notify: () => undefined,
    client: {
      daemonStatus: async () => runningDaemonStatus(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      controlRequest: async (_method, params) => {
        rpcAttempts += 1;
        responseIds.push((params as { humanResponseId: string }).humanResponseId);
        if (rpcAttempts === 1) {
          throw Object.assign(
            new Error("No pending daemon-owned human interaction matched interaction-race."),
            { code: "human_interaction_not_found" },
          );
        }
        return {
          outcome: "accepted",
          retryable: false,
          returnedToTool: true,
          message: "Response accepted.",
        };
      },
    },
  });

  assert.equal(presentations, 1);
  assert.equal(rpcAttempts, 2);
  assert.deepEqual(sleeps, [50]);
  assert.equal(new Set(responseIds).size, 1);
});

void test("a persistently undelivered Ask stays visible and reopens after bounded retries", async () => {
  const request = parseSparkInteractionRequest({
    requestId: "interaction-reopen",
    kind: "askFlow",
    title: "Continue?",
    questions: [{ id: "decision", prompt: "Continue?", options: [] }],
  });
  const event = parseSparkDaemonEvent({
    type: "daemon.interaction.request",
    source: "daemon",
    sessionId: "session-reopen",
    invocationId: "invocation-reopen",
    request,
    metadata: {},
  });
  if (event.type !== "daemon.interaction.request") throw new Error("expected interaction event");
  let presentations = 0;
  let rpcAttempts = 0;
  const sleeps: number[] = [];
  const notifications: string[] = [];
  const responseIds: string[] = [];

  await handleSparkDaemonHumanInteractionRequest(request, event, {
    currentSessionId: "session-reopen",
    interaction: async () => {
      presentations += 1;
      return {
        version: 1,
        kind: "askFlow",
        requestId: request.requestId,
        status: "answered",
        answers: { decision: "continue" },
        nextAction: "resume",
        metadata: {},
      };
    },
    notify: (message) => notifications.push(message),
    client: {
      daemonStatus: async () => runningDaemonStatus(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      controlRequest: async (_method, params) => {
        rpcAttempts += 1;
        responseIds.push((params as { humanResponseId: string }).humanResponseId);
        if (rpcAttempts <= 4) {
          throw Object.assign(
            new Error("No pending daemon-owned human interaction matched interaction-reopen."),
            { code: "human_interaction_not_found" },
          );
        }
        return {
          outcome: "accepted",
          retryable: false,
          returnedToTool: true,
          message: "Response accepted.",
        };
      },
    },
  });

  assert.equal(presentations, 2);
  assert.equal(rpcAttempts, 5);
  assert.deepEqual(sleeps, [50, 100, 200, 250]);
  assert.equal(new Set(responseIds).size, 1);
  assert.match(notifications[0] ?? "", /keeping it open for retry/u);
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
        registry: false,
        includeArchived: false,
        workspaceId: undefined,
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
      registry: false,
      includeArchived: false,
      workspaceId: undefined,
    },
  });
  assert.deepEqual(parseSparkCliCommand(["session", "replay", "--session", "s1"]), {
    kind: "daemon",
    command: { action: "sessions", subcommand: "replay", json: false, sessionId: "s1" },
  });
  assert.throws(
    () => parseSparkCliCommand(["daemon", "session", "mailto"]),
    /unknown spark daemon session command: mailto/u,
  );
  assert.deepEqual(
    parseSparkCliCommand([
      "daemon",
      "session",
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
  assert.deepEqual(
    parseSparkCliCommand(["daemon", "channel", "status", "--workspace", "ws_demo", "--json"]),
    {
      kind: "daemon",
      command: {
        action: "channel",
        subcommand: "status",
        json: true,
        workspaceId: "ws_demo",
      },
    },
  );
  assert.deepEqual(
    parseSparkCliCommand(["daemon", "channel", "reload", "--workspace", "ws_demo", "--json"]),
    {
      kind: "daemon",
      command: {
        action: "channel",
        subcommand: "reload",
        json: true,
        workspaceId: "ws_demo",
      },
    },
  );
});

void test("daemon channel status is read from daemon local RPC client", async () => {
  let calls = 0;
  const result = await handleSparkDaemonCliCommand(
    { action: "channel", subcommand: "status", json: true, workspaceId: "ws_demo" },
    {
      channelStatus: async () => {
        calls += 1;
        return {
          plane: "daemon",
          resource: "channel",
          workspaceId: "ws_demo",
          configPath: "/tmp/spark/workspaces/ws_demo/channels/config.json",
          available: true,
          configured: true,
          ingressEnabled: true,
          state: "running",
          adapters: [{ id: "feishu", type: "feishu", running: true }],
          routes: [{ name: "ops", adapter: "feishu", recipient: "oc_ops" }],
          observedAt: "2026-07-10T00:00:00.000Z",
          text: "channels workspace=ws_demo running adapters=1/1 routes=1 ingress=on\n",
        };
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.action, "channel");
  assert.ok("adapters" in result.result);
  assert.equal(result.result.adapters[0]?.running, true);
  assert.match(result.result.text, /channels workspace=ws_demo running/u);
});

void test("daemon channel reload is an explicit daemon local RPC operation", async () => {
  let workspaceId = "";
  const result = await handleSparkDaemonCliCommand(
    { action: "channel", subcommand: "reload", json: true, workspaceId: "ws_demo" },
    {
      channelReload: async (_paths, requestedWorkspaceId) => {
        workspaceId = requestedWorkspaceId;
        return {
          plane: "daemon",
          resource: "channel",
          workspaceId: requestedWorkspaceId,
          configPath: "/tmp/spark/workspaces/ws_demo/channels/config.json",
          available: true,
          configured: true,
          ingressEnabled: true,
          state: "running",
          adapters: [{ id: "infoflow", type: "infoflow", running: true }],
          routes: [],
          observedAt: "2026-07-17T00:00:00.000Z",
          text: "channels workspace=ws_demo running connected=1/1 routes=0 ingress=on\n",
        };
      },
    },
  );

  assert.equal(workspaceId, "ws_demo");
  assert.equal(result.action, "channel");
  assert.ok("state" in result.result);
  assert.equal(result.result.state, "running");
});

void test("daemon managed session commands wait for the daemon-owned RPC client", async () => {
  const calls: string[] = [];
  const session = {
    sessionId: "sess_rpc",
    scope: { kind: "workspace" as const, workspaceId: "ws_rpc" },
    workspaceId: "ws_rpc",
    title: "RPC session",
    status: "ready" as const,
    bindings: [],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
  const managedSessions: NonNullable<SparkDaemonClientOptions["managedSessions"]> = {
    create: async (input) => {
      calls.push(`create:${input.workspaceId}`);
      return session;
    },
    list: async (options) => {
      const workspaceId =
        options?.scope?.kind === "workspace"
          ? options.scope.workspaceId
          : options && "workspaceId" in options
            ? options.workspaceId
            : undefined;
      calls.push(`list:${workspaceId ?? "all"}`);
      return [session];
    },
    get: async (sessionId) => {
      calls.push(`get:${sessionId}`);
      return session;
    },
    bind: async (sessionId, externalKey) => {
      calls.push(`bind:${sessionId}:${externalKey}`);
      return session;
    },
    unbind: async (sessionId, externalKey) => {
      calls.push(`unbind:${sessionId}:${externalKey}`);
      return session;
    },
    archive: async (sessionId) => {
      calls.push(`archive:${sessionId}`);
      return { ...session, status: "archived" };
    },
  };
  const client = { managedSessions } satisfies SparkDaemonClientOptions;

  const created = await handleSparkDaemonCliCommand(
    {
      action: "sessions",
      subcommand: "create",
      json: true,
      workspaceId: "ws_rpc",
      sessionId: "sess_rpc",
    },
    client,
  );
  assert.equal(created.action, "sessions");
  if (created.action !== "sessions") throw new Error("expected sessions result");
  assert.equal((created.result as ManagedSessionRegistryResult).session?.sessionId, "sess_rpc");
  await handleSparkDaemonCliCommand(
    {
      action: "sessions",
      subcommand: "bind",
      json: true,
      sessionId: "sess_rpc",
      externalKey: "feishu:chat:oc_rpc",
    },
    client,
  );
  await handleSparkDaemonCliCommand(
    {
      action: "sessions",
      subcommand: "list",
      registry: true,
      json: true,
      workspaceId: "ws_rpc",
    },
    client,
  );
  await handleSparkDaemonCliCommand(
    {
      action: "sessions",
      subcommand: "archive",
      json: true,
      sessionId: "sess_rpc",
    },
    client,
  );

  assert.deepEqual(calls, [
    "create:ws_rpc",
    "bind:sess_rpc:feishu:chat:oc_rpc",
    "list:ws_rpc",
    "archive:sess_rpc",
  ]);
});

void test("daemon managed session mutation fails explicitly when daemon RPC is unavailable", async () => {
  const managedSessions: NonNullable<SparkDaemonClientOptions["managedSessions"]> = {
    create: async () => {
      throw new Error("Spark daemon is offline");
    },
    list: async () => [],
    get: async () => {
      throw new Error("Spark daemon is offline");
    },
    bind: async () => {
      throw new Error("Spark daemon is offline");
    },
    unbind: async () => {
      throw new Error("Spark daemon is offline");
    },
    archive: async () => {
      throw new Error("Spark daemon is offline");
    },
  };

  await assert.rejects(
    handleSparkDaemonCliCommand(
      {
        action: "sessions",
        subcommand: "create",
        json: true,
        workspaceId: "ws_rpc",
      },
      { managedSessions },
    ),
    /Spark daemon is offline/u,
  );
});

void test("spark daemon session inbox lists, reads, and acknowledges durable mail", async () => {
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
    } satisfies SparkDaemonClientOptions;
    const sent = await new SparkSessionMailStore({ sparkHome, now: client.now }).send({
      toSessionId: "session-b",
      fromSessionId: "session-a",
      kind: "request",
      body: "hello",
    });

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
    assert.equal(listResult.messages[0]?.id, sent.message.id);
    assert.equal(listResult.messages[0]?.status, "pending");
    assert.equal(listResult.messages[0]?.preview, "hello");

    const read = await handleSparkDaemonCliCommand(
      {
        action: "sessions",
        subcommand: "inbox",
        inboxAction: "read",
        json: true,
        sessionId: "session-b",
        messageId: sent.message.id,
      },
      client,
    );
    assert.equal(read.action, "sessions");
    const readResult = (
      read as {
        result: { message: { id: string; toSessionId: string; body: string; status: string } };
      }
    ).result;
    assert.equal(readResult.message.id, sent.message.id);
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
        messageId: sent.message.id,
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
          invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
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
    registry: false,
    includeArchived: false,
    workspaceId: undefined,
  });
  assert.deepEqual(parseSparkDaemonCliArgs(["session", "list", "--history", "--json"]), {
    action: "sessions",
    subcommand: "list",
    json: true,
    allWorkspaces: false,
    history: true,
    registry: false,
    includeArchived: false,
    workspaceId: undefined,
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
      runList: async () => ({
        plane: "daemon" as const,
        resource: "run" as const,
        runs: [
          {
            runKey: "run:inv_a",
            id: "inv_a",
            state: "queued" as const,
            sessionKey: "session:fixture-a",
            prompt: "do work",
          },
          {
            runKey: "run:inv_b",
            id: "inv_b",
            state: "succeeded" as const,
            sessionKey: "session:fixture-b",
            prompt: "done",
          },
        ],
        text: "run:inv_a queued\nrun:inv_b succeeded\n",
        observedAt: "2026-07-08T00:03:00.000Z",
      }),
      turnCancel: async (_paths, input) => ({
        invocationId: input.invocationId,
        status: "running" as const,
        cancelRequested: true,
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
    assert.deepEqual(listResult.runs.map((run) => run.runKey).sort(), ["run:inv_a", "run:inv_b"]);
    assert.equal(
      listResult.runs.find((run) => run.runKey === "run:inv_a")?.sessionKey,
      "session:fixture-a",
    );

    const show = await handleSparkDaemonCliCommand(
      { action: "runs", subcommand: "show", json: true, runId: "inv_a" },
      client,
    );
    assert.equal(show.action, "runs");
    const showResult = show.result as { runKey: string; run?: { state: string } };
    assert.equal(showResult.runKey, "run:inv_a");
    assert.equal(showResult.run?.state, "queued");

    const cancel = await handleSparkDaemonCliCommand(
      { action: "runs", subcommand: "cancel", json: true, runId: "inv_a" },
      client,
    );
    assert.equal(cancel.action, "runs");
    assert.equal((cancel.result as { cancelRequested: boolean }).cancelRequested, true);

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
  assert.deepEqual(
    parseSparkDaemonCliArgs([
      "submit",
      "--session",
      "s1",
      "--prompt",
      "hello",
      "--idempotency-key",
      "native-submit-1",
    ]),
    {
      action: "submit",
      json: false,
      reset: false,
      sessionId: "s1",
      prompt: "hello",
      idempotencyKey: "native-submit-1",
    },
  );
  assert.deepEqual(parseSparkDaemonCliArgs(["invocation", "status", "inv_1"]), {
    action: "invocation",
    subcommand: "status",
    invocationId: "inv_1",
    json: false,
  });
  assert.deepEqual(
    parseSparkDaemonCliArgs(["invocation", "stream", "inv_1", "--after", "10", "--limit", "2"]),
    {
      action: "invocation",
      subcommand: "stream",
      invocationId: "inv_1",
      after: 10,
      limit: 2,
      json: false,
    },
  );
  assert.throws(() => parseSparkDaemonCliArgs(["queue"]), /unknown spark daemon command: queue/u);
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
  assert.throws(
    () => parseSparkDaemonCliArgs(["session", "export"]),
    /spark daemon session export requires --session <id\|path>/u,
  );
  assert.throws(
    () => parseSparkDaemonCliArgs(["session", "mailto"]),
    /unknown spark daemon session command: mailto/u,
  );
  assert.throws(
    () => parseSparkDaemonCliArgs(["session", "inbox"]),
    /spark daemon session inbox requires --session <session-id>/u,
  );
  assert.throws(
    () => parseSparkDaemonCliArgs(["session", "wat"]),
    /unknown spark daemon session command: wat/u,
  );
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
  assert.match(daemonHelp.text, /spark daemon invocation status/u);
  assert.doesNotMatch(daemonHelp.text, /spark daemon queue/u);
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

void test("parseSparkDaemonCliArgs normalizes bounded relative invocation windows", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-07-15T12:00:00.000Z");
  try {
    assert.deepEqual(
      parseSparkDaemonCliArgs([
        "invocation",
        "list",
        "--status",
        "failed",
        "--since",
        "24h",
        "--limit",
        "50",
        "--json",
      ]),
      {
        action: "invocation",
        subcommand: "list",
        json: true,
        status: "failed",
        sessionId: undefined,
        since: "2026-07-14T12:00:00.000Z",
        limit: 50,
        offset: undefined,
      },
    );
    assert.deepEqual(
      parseSparkDaemonCliArgs([
        "invocation",
        "retention",
        "--before",
        "2026-07-01T00:00:00Z",
        "--limit",
        "100",
      ]),
      {
        action: "invocation",
        subcommand: "retention",
        before: "2026-07-01T00:00:00.000Z",
        limit: 100,
        json: false,
      },
    );
    assert.throws(
      () => parseSparkDaemonCliArgs(["invocation", "list", "--since", "0h"]),
      /duration must be between 1s and 365d/u,
    );
    assert.throws(
      () => parseSparkDaemonCliArgs(["invocation", "list", "--since", "366d"]),
      /duration must be between 1s and 365d/u,
    );
  } finally {
    Date.now = originalNow;
  }
});

void test("daemon CLI handlers use invocation-based Spark daemon local IPC", async () => {
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
        invocations: { queued: 1, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
      }),
      turnSubmit: async () => ({
        invocationId: "inv_queued",
        status: "queued" as const,
        acceptedAt: "2026-06-19T00:00:00.000Z",
      }),
      turnStatus: async () => ({
        invocationId: "inv_queued",
        sessionId: "session-a",
        status: "queued" as const,
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:00.000Z",
        eventCursor: 0,
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
    assert.equal(submit.result.invocationId, "inv_queued");

    const status = await handleSparkDaemonCliCommand({ action: "status", json: true }, client);
    assert.equal(status.action, "status");
    assert.equal(status.daemon.running, true);

    const invocation = await handleSparkDaemonCliCommand(
      { action: "invocation", subcommand: "status", invocationId: "inv_queued", json: true },
      client,
    );
    assert.equal(invocation.action, "invocation");
    assert.equal("invocationId" in invocation.result, true);
    if (!("invocationId" in invocation.result)) assert.fail("missing invocation id");
    assert.equal(invocation.result.invocationId, "inv_queued");

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

type CapturedLocalRpcRequest = {
  id: string;
  method: string;
  params?: { idempotencyKey?: string; [key: string]: unknown };
  sparkCommand?: unknown;
};

void test("turn submit retries an ambiguous local RPC close with one stable idempotency key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-turn-admission-retry-"));
  const paths = testDaemonPaths(dir);
  const requests: CapturedLocalRpcRequest[] = [];
  const retryDelays: number[] = [];
  const server = createServer((socket) => {
    readLocalRpcRequest(socket, (request) => {
      requests.push(request);
      if (requests.length < 9) {
        socket.destroy();
        return;
      }
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            invocationId: "inv_recovered_admission",
            status: "queued",
            acceptedAt: "2026-07-15T00:00:00.000Z",
          },
        })}\n`,
      );
    });
  });
  try {
    await mkdir(paths.runtimeDir, { recursive: true });
    await listenLocalRpcServer(server, paths.socketPath);
    const result = await handleSparkDaemonCliCommand(
      { action: "submit", json: true, sessionId: "stable-session", prompt: "run once" },
      {
        paths,
        daemonStatus: async () => runningDaemonStatus(),
        random: () => 0,
        sleep: async (ms) => {
          retryDelays.push(ms);
        },
      },
    );

    assert.equal(result.action, "submit");
    assert.equal(result.result.invocationId, "inv_recovered_admission");
    assert.equal(requests.length, 9);
    for (const request of requests) assert.deepEqual(request, requests[0]);
    assert.equal(requests[0]?.params?.idempotencyKey, `turn.submit:${requests[0]?.id}`);
    assert.deepEqual(retryDelays, [50, 100, 200, 400, 800, 1_600, 2_500, 2_500]);
  } finally {
    await closeLocalRpcServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

void test("turn submit periodically recovers daemon service without changing the request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-turn-admission-recovery-"));
  const paths = testDaemonPaths(dir);
  const inputs: Array<{ idempotencyKey?: string }> = [];
  const retryEvents: Array<{
    failureCount: number;
    recoveryAttempted: boolean;
    nextRetryMs: number;
  }> = [];
  let submitAttempts = 0;
  let serviceStarts = 0;
  try {
    const result = await handleSparkDaemonCliCommand(
      { action: "submit", json: true, sessionId: "recovery-session", prompt: "run once" },
      {
        paths,
        startService: () => {
          serviceStarts += 1;
        },
        daemonStatus: async () => runningDaemonStatus(),
        turnSubmit: async (_paths, input) => {
          submitAttempts += 1;
          inputs.push(input);
          if (submitAttempts <= 4) {
            throw new SparkDaemonLocalRpcUnavailableError("connect ENOENT");
          }
          return {
            invocationId: "inv_recovered_service",
            status: "queued" as const,
            acceptedAt: "2026-07-15T00:00:00.000Z",
          };
        },
        random: () => 0,
        sleep: async () => undefined,
        turnTransportRecoveryInterval: 4,
        onTurnTransportRetry: (event) => retryEvents.push(event),
      },
    );

    assert.equal(result.action, "submit");
    assert.equal(result.result.invocationId, "inv_recovered_service");
    assert.equal(serviceStarts, 2, "initial ensure plus periodic recovery");
    assert.equal(submitAttempts, 5);
    assert.equal(new Set(inputs.map((input) => input.idempotencyKey)).size, 1);
    assert.deepEqual(
      retryEvents.map(({ failureCount, recoveryAttempted, nextRetryMs }) => ({
        failureCount,
        recoveryAttempted,
        nextRetryMs,
      })),
      [
        { failureCount: 1, recoveryAttempted: false, nextRetryMs: 50 },
        { failureCount: 2, recoveryAttempted: false, nextRetryMs: 100 },
        { failureCount: 3, recoveryAttempted: false, nextRetryMs: 200 },
        { failureCount: 4, recoveryAttempted: true, nextRetryMs: 400 },
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("turn submit retries a bound successor's starting response with the same request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-turn-start-"));
  const paths = testDaemonPaths(dir);
  const requests: CapturedLocalRpcRequest[] = [];
  const retryDelays: number[] = [];
  const server = createServer((socket) => {
    readLocalRpcRequest(socket, (request) => {
      requests.push(request);
      if (requests.length < 4) {
        socket.end(
          `${JSON.stringify({
            id: request.id,
            ok: false,
            error: {
              code: "daemon_starting",
              message: "Spark daemon is still starting; retry after readiness.",
            },
          })}\n`,
        );
        return;
      }
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            invocationId: "inv_successor_ready",
            status: "queued",
            acceptedAt: "2026-07-15T00:00:00.000Z",
          },
        })}\n`,
      );
    });
  });
  try {
    await mkdir(paths.runtimeDir, { recursive: true });
    await listenLocalRpcServer(server, paths.socketPath);
    const result = await handleSparkDaemonCliCommand(
      { action: "submit", json: true, sessionId: "successor-session", prompt: "run once" },
      {
        paths,
        daemonStatus: async () => runningDaemonStatus(),
        random: () => 0,
        sleep: async (ms) => {
          retryDelays.push(ms);
        },
      },
    );

    assert.equal(result.action, "submit");
    assert.equal(result.result.invocationId, "inv_successor_ready");
    assert.equal(requests.length, 4);
    for (const request of requests) assert.deepEqual(request, requests[0]);
    assert.deepEqual(retryDelays, [50, 100, 200]);
  } finally {
    await closeLocalRpcServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

void test("turn submit does not retry a daemon validation error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-turn-admission-validation-"));
  const paths = testDaemonPaths(dir);
  const requests: CapturedLocalRpcRequest[] = [];
  const retryDelays: number[] = [];
  const server = createServer((socket) => {
    readLocalRpcRequest(socket, (request) => {
      requests.push(request);
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: false,
          error: { message: "turn validation rejected" },
        })}\n`,
      );
    });
  });
  try {
    await mkdir(paths.runtimeDir, { recursive: true });
    await listenLocalRpcServer(server, paths.socketPath);
    await assert.rejects(
      handleSparkDaemonCliCommand(
        { action: "submit", json: true, sessionId: "invalid-session", prompt: "invalid" },
        {
          paths,
          daemonStatus: async () => runningDaemonStatus(),
          sleep: async (ms) => {
            retryDelays.push(ms);
          },
        },
      ),
      /turn validation rejected/u,
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(retryDelays, []);
  } finally {
    await closeLocalRpcServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native responder can cancel turn admission during retry backoff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-turn-admission-cancel-"));
  const paths = testDaemonPaths(dir);
  const requests: CapturedLocalRpcRequest[] = [];
  const controller = new AbortController();
  const reason = new Error("cancel admission retry");
  const server = createServer((socket) => {
    readLocalRpcRequest(socket, (request) => {
      requests.push(request);
      socket.destroy();
    });
  });
  try {
    await mkdir(paths.runtimeDir, { recursive: true });
    await listenLocalRpcServer(server, paths.socketPath);
    const responder = createSparkDaemonNativeResponder(
      {
        paths,
        daemonStatus: async () => runningDaemonStatus(),
        random: () => 0,
        sleep: async (_ms, signal) => {
          assert.equal(signal, controller.signal);
          controller.abort(reason);
        },
      },
      { sessionId: "cancel-admission" },
    );

    await assert.rejects(
      responder("cancel this admission", { signal: controller.signal }),
      (error) => error === reason,
    );
    assert.equal(requests.length, 1);
  } finally {
    await closeLocalRpcServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

function readLocalRpcRequest(
  socket: Socket,
  onRequest: (request: CapturedLocalRpcRequest) => void,
): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    socket.removeAllListeners("data");
    onRequest(JSON.parse(buffer.slice(0, newline)) as CapturedLocalRpcRequest);
  });
}

async function listenLocalRpcServer(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolvePromise();
    });
  });
}

async function closeLocalRpcServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function runningDaemonStatus() {
  return {
    observedAt: "2026-07-15T00:00:00.000Z",
    servers: [],
    invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
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
          invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
        }),
        turnSubmit: async () => ({
          invocationId: "inv_turn",
          status: "queued" as const,
          acceptedAt: "2026-06-19T00:00:00.000Z",
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
          invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
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
      (writes[0]?.data as { result?: { invocationId?: string } } | undefined)?.result?.invocationId,
      "inv_turn",
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
    const registeredSessions: Array<{
      sessionId: string;
      workspaceId: string;
      cwd?: string;
    }> = [];
    const managedSessionRecords: Array<{
      sessionId: string;
      scope: { kind: "workspace"; workspaceId: string };
      workspaceId: string;
      status: "ready";
      bindings: [];
      createdAt: string;
      updatedAt: string;
      cwd?: string;
    }> = [];
    const daemonClient: SparkDaemonClientOptions = {
      paths,
      startService: () => ({ kind: "detached" as const, alreadyRunning: false, detail: "started" }),
      daemonStatus: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        servers: [],
        invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
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
      managedSessions: {
        list: async () => managedSessionRecords,
        create: async (input) => {
          assert.equal(input.scope?.kind, "workspace");
          if (input.scope?.kind !== "workspace") throw new Error("expected workspace session");
          const scope = input.scope;
          const sessionId = input.sessionId ?? `generated-${managedSessionRecords.length + 1}`;
          registeredSessions.push({
            sessionId,
            workspaceId: scope.workspaceId,
            cwd: input.cwd,
          });
          const record = {
            sessionId,
            scope,
            workspaceId: scope.workspaceId,
            status: "ready" as const,
            bindings: [] as [],
            createdAt: "2026-06-19T00:00:00.000Z",
            updatedAt: "2026-06-19T00:00:00.000Z",
            ...(input.cwd ? { cwd: input.cwd } : {}),
          };
          managedSessionRecords.push(record);
          return record;
        },
        get: async (sessionId) => {
          const record = managedSessionRecords.find((session) => session.sessionId === sessionId);
          if (!record) throw new Error(`unknown session: ${sessionId}`);
          return record;
        },
        bind: async () => {
          throw new Error("not used");
        },
        unbind: async () => {
          throw new Error("not used");
        },
        archive: async () => {
          throw new Error("not used");
        },
      },
      controlRequest: async (method, params) => {
        assert.equal(method, "session.snapshot");
        assert.deepEqual(params, { sessionId: "generated-3" });
        return {
          version: 1,
          sessionId: "generated-3",
          status: "idle",
          cwd: dir,
          gitBranch: "main",
          model: { providerName: "daemon-provider", modelId: "daemon-model" },
          thinkingLevel: "high",
          messages: [],
          tools: [],
          runs: [],
          tasks: [],
          artifacts: [],
          metadata: {},
        };
      },
      turnSubmit: async (_paths, input) => {
        submitted.push(input);
        return {
          invocationId: "inv_turn",
          status: "queued" as const,
          acceptedAt: "2026-06-19T00:00:00.000Z",
        };
      },
      turnStream: async () => ({
        invocationId: "inv_turn",
        events: [
          {
            invocationId: "inv_turn",
            sequence: 1,
            kind: "daemon.view_event",
            payload: {
              version: 1,
              type: "daemon.view_event",
              source: "daemon",
              emittedAt: "2026-06-19T00:00:01.000Z",
              sessionId: "generated-3",
              invocationId: "inv_turn",
              view: {
                version: 1,
                type: "session.message",
                sessionId: "generated-3",
                message: {
                  id: "assistant-plan",
                  role: "assistant",
                  text: "daemon-visible-plan-response",
                  status: "streaming",
                },
              },
            },
            createdAt: "2026-06-19T00:00:01.000Z",
          },
        ],
        nextCursor: 1,
        hasMore: false,
      }),
      turnStatus: async () => ({
        invocationId: "inv_turn",
        sessionId: "generated-3",
        status: "succeeded" as const,
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:01.000Z",
        finishedAt: "2026-06-19T00:00:01.000Z",
        eventCursor: 1,
      }),
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
      handler: async (_args, ctx) => {
        await ctx.sendUserMessage?.("runtime-plan-instruction");
      },
    });
    let capturedTuiOptions: unknown;
    let capturedTuiRendered = "";
    assert.equal(
      await runSparkCli([], {
        daemonClient,
        terminal: { stdinIsTTY: true, stdoutIsTTY: true },
        createHostServices: async () =>
          ({
            cwd: dir,
            runtime,
            config: { extensions: [], providers: [], activeThinkingLevel: "medium" },
            providerRegistry: { listProviders: () => [], listModelsFor: () => [] },
            modelSelector: {
              getActive: () => ({ providerName: "openai-codex", modelId: "gpt-5.4" }),
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
        selectSession: async (options) => {
          assert.equal(options.workspaceLabel, `Workspace • ${dir}`);
          assert.equal(options.sessions.length, 2);
          return CREATE_SPARK_SESSION_SELECTION;
        },
        runTui: async (input) => {
          capturedTuiOptions = input;
          assert.equal(typeof input, "object");
          assert.notEqual(input, null);
          const options = input as Exclude<typeof input, string | undefined>;
          const harness = createSparkNativeTuiHarness({
            autocompleteBasePath: options.autocompleteBasePath,
            responder: options.responder,
            slashCommands: options.slashCommands,
            statusContext: options.statusContext,
            workspaceSession: options.workspaceSession,
          });
          await options.configureApp?.(harness.app, harness.session);
          await harness.submit("/plan");
          await harness.flush();
          capturedTuiRendered = harness.render(140);
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
    const statusContext = (
      capturedTuiOptions as {
        statusContext?: {
          activeProvider?: () => string | undefined;
          activeModel?: () => string | undefined;
          thinkingLevel?: () => string | undefined;
        };
      }
    ).statusContext;
    assert.equal(statusContext?.activeProvider?.(), "daemon-provider");
    assert.equal(statusContext?.activeModel?.(), "daemon-model");
    assert.equal(statusContext?.thinkingLevel?.(), "high");
    assert.match(capturedTuiRendered, /\(main\)/u);
    assert.match(capturedTuiRendered, /daemon-visible-plan-response/u);
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
    assert.deepEqual(
      registeredSessions.map((session) => ({
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
      })),
      [
        { sessionId: submitted[0]?.sessionId, workspaceId: workspace.id },
        { sessionId: "json-s1", workspaceId: workspace.id },
        { sessionId: "generated-3", workspaceId: workspace.id },
      ],
    );
    assert.equal(submitted[0]?.prompt, "headless prompt");
    assert.equal(submitted.at(-1)?.prompt, "runtime-plan-instruction");
    assert.match(logs.join("\n"), /inv_turn/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native TUI session gate exits without creating an implicit session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-session-cancel-"));
  try {
    const base = createWorkspaceAttachTestDeps(dir, { existingSessionIds: new Set() });
    let ranTui = false;
    let created = 0;
    const daemonClient: SparkDaemonClientOptions = {
      ...base.daemonClient,
      managedSessions: {
        list: async () => [],
        create: async () => {
          created += 1;
          throw new Error("cancelled selection must not create a session");
        },
        get: async () => {
          throw new Error("not used");
        },
        bind: async () => {
          throw new Error("not used");
        },
        unbind: async () => {
          throw new Error("not used");
        },
        archive: async () => {
          throw new Error("not used");
        },
      },
    };

    assert.equal(
      await runSparkCli([], {
        daemonClient,
        createHostServices: base.createHostServices,
        terminal: { stdinIsTTY: true, stdoutIsTTY: true },
        selectSession: async () => null,
        runTui: async () => {
          ranTui = true;
        },
      }),
      0,
    );
    assert.equal(ranTui, false);
    assert.equal(created, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native TUI selects an existing daemon session and restores its snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-session-select-"));
  try {
    const base = createWorkspaceAttachTestDeps(dir, { existingSessionIds: new Set() });
    const now = "2026-07-13T00:00:00.000Z";
    const existing = {
      sessionId: "daemon-session-1",
      title: "Existing conversation",
      scope: { kind: "workspace" as const, workspaceId: "workspace-current" },
      workspaceId: "workspace-current",
      status: "ready" as const,
      bindings: [],
      createdAt: now,
      updatedAt: now,
      cwd: dir,
    };
    const daemonClient: SparkDaemonClientOptions = {
      ...base.daemonClient,
      managedSessions: {
        list: async () => [existing],
        create: async () => {
          throw new Error("existing selection must not create a session");
        },
        get: async () => existing,
        bind: async () => existing,
        unbind: async () => existing,
        archive: async () => ({ ...existing, status: "archived" as const }),
      },
      controlRequest: async (method, params) => {
        assert.equal(method, "session.snapshot");
        assert.deepEqual(params, { sessionId: existing.sessionId });
        return {
          version: 1,
          sessionId: existing.sessionId,
          title: existing.title,
          status: "idle",
          cwd: dir,
          gitBranch: "main",
          model: { providerName: "session-provider", modelId: "session-model" },
          thinkingLevel: "xhigh",
          messages: [
            {
              version: 1,
              id: "message-1",
              role: "assistant",
              text: "Restored from daemon",
              status: "done",
              createdAt: now,
              metadata: {},
            },
          ],
          tools: [],
          runs: [],
          tasks: [],
          artifacts: [],
          metadata: {},
        };
      },
    };
    let selectedOptions: { sessions: Array<{ sessionId: string }> } | undefined;
    let rendered = "";

    assert.equal(
      await runSparkCli([], {
        daemonClient,
        createHostServices: base.createHostServices,
        terminal: { stdinIsTTY: true, stdoutIsTTY: true },
        selectSession: async (options) => {
          selectedOptions = options;
          return existing.sessionId;
        },
        runTui: async (input) => {
          assert.equal(typeof input, "object");
          assert.notEqual(input, null);
          const options = input as Exclude<typeof input, string | undefined>;
          assert.equal(options.workspaceSession?.attachTarget, existing.sessionId);
          assert.equal(options.statusContext?.activeProvider?.(), "session-provider");
          assert.equal(options.statusContext?.activeModel?.(), "session-model");
          assert.equal(options.statusContext?.thinkingLevel?.(), "xhigh");
          const harness = createSparkNativeTuiHarness({
            workspaceSession: options.workspaceSession,
          });
          await options.configureApp?.(harness.app, harness.session);
          rendered = harness.render(140);
        },
      }),
      0,
    );

    assert.deepEqual(
      selectedOptions?.sessions.map((session) => session.sessionId),
      [existing.sessionId],
    );
    assert.match(rendered, /Restored from daemon/u);
    assert.match(rendered, /Existing conversation/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native /sessions reopens the startup selector and attaches the selected session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-session-reselect-"));
  try {
    const base = createWorkspaceAttachTestDeps(dir, { existingSessionIds: new Set() });
    const now = "2026-07-13T00:00:00.000Z";
    const sessions = [
      {
        sessionId: "session-first",
        title: "First conversation",
        scope: { kind: "workspace" as const, workspaceId: "workspace-current" },
        workspaceId: "workspace-current",
        cwd: dir,
        status: "ready" as const,
        bindings: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        sessionId: "session-second",
        title: "Second conversation",
        scope: { kind: "workspace" as const, workspaceId: "workspace-current" },
        workspaceId: "workspace-current",
        cwd: dir,
        status: "ready" as const,
        bindings: [],
        createdAt: now,
        updatedAt: now,
      },
    ];
    const daemonClient: SparkDaemonClientOptions = {
      ...base.daemonClient,
      managedSessions: {
        list: async () => sessions,
        create: async () => {
          throw new Error("existing selection must not create a session");
        },
        get: async (sessionId) => {
          const selected = sessions.find((session) => session.sessionId === sessionId);
          if (!selected) throw new Error(`unknown session: ${sessionId}`);
          return selected;
        },
        bind: async () => sessions[0]!,
        unbind: async () => sessions[0]!,
        archive: async () => ({ ...sessions[0]!, status: "archived" as const }),
      },
      controlRequest: async (method, params) => {
        assert.equal(method, "session.snapshot");
        const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
        const selected = sessions.find((session) => session.sessionId === sessionId);
        assert.ok(selected, `snapshot requested for an unknown session: ${sessionId}`);
        return {
          version: 1,
          sessionId: selected.sessionId,
          title: selected.title,
          status: "idle",
          cwd: selected.cwd,
          messages: [],
          tools: [],
          runs: [],
          tasks: [],
          artifacts: [],
          metadata: {},
        };
      },
    };
    const selectorCalls: Array<{
      workspaceId: string;
      workspaceLabel: string;
      sessionIds: string[];
    }> = [];
    const attachedSessionIds: string[] = [];

    assert.equal(
      await runSparkCli([], {
        daemonClient,
        createHostServices: base.createHostServices,
        terminal: { stdinIsTTY: true, stdoutIsTTY: true },
        selectSession: async (options) => {
          selectorCalls.push({
            workspaceId: options.workspaceId,
            workspaceLabel: options.workspaceLabel,
            sessionIds: options.sessions.map((session) => session.sessionId),
          });
          return selectorCalls.length === 1 ? sessions[0]!.sessionId : sessions[1]!.sessionId;
        },
        runTui: async (input) => {
          assert.equal(typeof input, "object");
          assert.notEqual(input, null);
          const options = input as Exclude<typeof input, string | undefined>;
          attachedSessionIds.push(options.workspaceSession?.attachTarget ?? "missing");
          if (attachedSessionIds.length > 1) return;

          const harness = createSparkNativeTuiHarness({
            slashCommands: options.slashCommands,
            workspaceSession: options.workspaceSession,
          });
          await options.configureApp?.(harness.app, harness.session);
          assert.equal(await harness.submit("/sessions"), "command");
          assert.equal(harness.app.actionBarSnapshot()?.selectedActionId, "select-session");
          const focused = harness.state.focused as { handleInput?: (input: string) => void };
          assert.equal(typeof focused.handleInput, "function");
          focused.handleInput?.("\r");
          await harness.flush();
          assert.equal(harness.state.exited, true);
        },
      }),
      0,
    );

    assert.deepEqual(attachedSessionIds, [sessions[0]!.sessionId, sessions[1]!.sessionId]);
    assert.equal(selectorCalls.length, 2);
    assert.deepEqual(selectorCalls[1], selectorCalls[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native TUI lists all daemon sessions and routes a cross-workspace selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-all-sessions-"));
  try {
    const base = createWorkspaceAttachTestDeps(dir, { existingSessionIds: new Set() });
    const now = "2026-07-13T00:00:00.000Z";
    const otherDir = join(dir, "other-workspace");
    const current = {
      sessionId: "session-current",
      title: "Current workspace",
      scope: { kind: "workspace" as const, workspaceId: "workspace-current" },
      workspaceId: "workspace-current",
      cwd: dir,
      status: "ready" as const,
      bindings: [],
      createdAt: now,
      updatedAt: now,
    };
    const other = {
      sessionId: "session-other",
      title: "Other workspace channel",
      scope: { kind: "workspace" as const, workspaceId: "workspace-other" },
      workspaceId: "workspace-other",
      cwd: otherDir,
      status: "ready" as const,
      bindings: [
        { kind: "channel" as const, adapter: "feishu" as const, externalKey: "feishu:chat:other" },
      ],
      createdAt: now,
      updatedAt: now,
    };
    const listRequests: unknown[] = [];
    const daemonClient: SparkDaemonClientOptions = {
      ...base.daemonClient,
      managedSessions: {
        list: async (options) => {
          listRequests.push(options);
          return [current, other];
        },
        create: async () => {
          throw new Error("existing selection must not create a session");
        },
        get: async (sessionId) => (sessionId === other.sessionId ? other : current),
        bind: async () => other,
        unbind: async () => other,
        archive: async () => ({ ...other, status: "archived" as const }),
      },
      workspaceList: async () => ({
        workspaces: [
          {
            id: "workspace-current",
            serverUrl: "",
            localWorkspaceKey: "spark",
            displayName: "spark",
            localPath: dir,
            status: "active",
          },
          {
            id: "workspace-other-binding",
            serverWorkspaceId: "workspace-other",
            serverUrl: "http://127.0.0.1:5173/",
            localWorkspaceKey: "spore",
            displayName: "spore",
            localPath: otherDir,
            status: "active",
          },
        ],
        observedAt: now,
      }),
      controlRequest: async (method, params) => {
        assert.equal(method, "session.snapshot");
        assert.deepEqual(params, { sessionId: other.sessionId });
        return {
          version: 1,
          sessionId: other.sessionId,
          title: other.title,
          status: "idle",
          messages: [],
          tools: [],
          runs: [],
          tasks: [],
          artifacts: [],
          metadata: {},
        };
      },
    };
    let selectorSessionIds: string[] = [];

    assert.equal(
      await runSparkCli([], {
        daemonClient,
        createHostServices: base.createHostServices,
        terminal: { stdinIsTTY: true, stdoutIsTTY: true },
        selectSession: async (options) => {
          assert.equal(options.workspaceId, "workspace-current");
          selectorSessionIds = options.sessions.map((session) => session.sessionId);
          assert.deepEqual(
            options.workspaces?.find((workspace) => workspace.id === "workspace-other"),
            {
              id: "workspace-other",
              canonicalId: "workspace-other-binding",
              displayName: "spore",
              localPath: otherDir,
            },
          );
          return other.sessionId;
        },
        runTui: async (input) => {
          assert.equal(typeof input, "object");
          assert.notEqual(input, null);
          const options = input as Exclude<typeof input, string | undefined>;
          assert.equal(options.workspaceSession?.attachTarget, other.sessionId);
          assert.equal(options.workspaceSession?.workspaceDir, otherDir);
          assert.equal(options.autocompleteBasePath, otherDir);
        },
      }),
      0,
    );

    assert.deepEqual(listRequests, [{}]);
    assert.deepEqual(selectorSessionIds, [current.sessionId, other.sessionId]);
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
          await harness.submit("/sessions list");
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
      invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
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
    managedSessions: {
      list: async () => {
        throw new Error("registry unavailable in durable-session fallback fixture");
      },
      create: async () => {
        throw new Error("not used");
      },
      get: async () => {
        throw new Error("registry unavailable in durable-session fallback fixture");
      },
      bind: async () => {
        throw new Error("not used");
      },
      unbind: async () => {
        throw new Error("not used");
      },
      archive: async () => {
        throw new Error("not used");
      },
    },
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
  options: {
    existingSessionIds: Set<string>;
    clientId?: string;
    pathSession?: { path: string; id: string };
  },
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
      invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
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
        loadByRef: async (sessionRef: string) => {
          if (options.pathSession?.path === sessionRef) {
            return {
              path: options.pathSession.path,
              header: {
                type: "session" as const,
                version: 3,
                id: options.pathSession.id,
                timestamp: now,
                cwd: dir,
              },
              entries: [],
            };
          }
          throw new Error(`session not found: ${sessionRef}`);
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

void test("native TUI model selection and following turn share one managed session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-session-model-"));
  try {
    const sessionPath = join(
      dir,
      "sessions",
      "workspace-hash-current",
      "2026-07-13T00-00-00-000Z_same-session.jsonl",
    );
    await mkdir(join(dir, "sessions", "workspace-hash-current"), { recursive: true });
    await writeFile(sessionPath, "{}\n", "utf8");
    const base = createWorkspaceAttachTestDeps(dir, {
      existingSessionIds: new Set(),
      pathSession: { path: sessionPath, id: "same-session" },
    });
    const managedSessions: Array<{
      sessionId: string;
      scope: { kind: "workspace"; workspaceId: string };
      workspaceId: string;
      status: "ready";
      bindings: [];
      createdAt: string;
      updatedAt: string;
      cwd?: string;
      model?: { providerName: string; modelId: string };
    }> = [];
    const controlCalls: Array<{ method: string; params: unknown }> = [];
    const submitted: Array<{
      invocationId: string;
      input: { sessionId: string; prompt: string; idempotencyKey?: string };
    }> = [];
    const daemonClient: SparkDaemonClientOptions = {
      ...base.daemonClient,
      managedSessions: {
        list: async () => managedSessions,
        create: async (input) => {
          assert.deepEqual(input.scope, {
            kind: "workspace",
            workspaceId: "workspace-current",
          });
          const record = {
            sessionId: input.sessionId!,
            scope: input.scope as { kind: "workspace"; workspaceId: string },
            workspaceId: "workspace-current",
            status: "ready" as const,
            bindings: [] as [],
            createdAt: "2026-07-13T00:00:00.000Z",
            updatedAt: "2026-07-13T00:00:00.000Z",
            ...(input.cwd ? { cwd: input.cwd } : {}),
          };
          managedSessions.push(record);
          return record;
        },
        get: async (sessionId) => managedSessions.find((entry) => entry.sessionId === sessionId)!,
        bind: async () => managedSessions[0]!,
        unbind: async () => managedSessions[0]!,
        archive: async () => ({ ...managedSessions[0]!, status: "archived" as const }),
      },
      controlRequest: async (method, params) => {
        controlCalls.push({ method, params });
        if (method === "model.catalog") {
          const session = managedSessions[0];
          return {
            providers: [
              {
                providerName: "provider-a",
                label: "Provider A",
                auth: { providerName: "provider-a", kind: "none", configured: true },
                models: [
                  {
                    model: { providerName: "provider-a", modelId: "model-a" },
                    reasoning: true,
                    input: ["text"],
                    available: true,
                  },
                  {
                    model: { providerName: "provider-a", modelId: "model-b" },
                    reasoning: true,
                    input: ["text"],
                    available: true,
                  },
                ],
              },
            ],
            defaultModel: { providerName: "provider-a", modelId: "model-a" },
            session: {
              sessionId: "same-session",
              ...(session?.model ? { model: session.model } : {}),
            },
            diagnostics: [],
          };
        }
        if (method === "session.model.set") {
          const request = params as {
            sessionId: string;
            model: { providerName: string; modelId: string };
          };
          assert.equal(request.sessionId, "same-session");
          managedSessions[0] = {
            ...managedSessions[0]!,
            model: request.model,
            updatedAt: "2026-07-13T00:01:00.000Z",
          };
          return managedSessions[0]!;
        }
        throw new Error(`unexpected model control method: ${method}`);
      },
      turnSubmit: async (_paths, input) => {
        const invocationId = `inv_${submitted.length + 1}`;
        submitted.push({ invocationId, input });
        return {
          invocationId,
          status: "queued" as const,
          acceptedAt: "2026-07-13T00:02:00.000Z",
        };
      },
      turnStatus: async (_paths, { invocationId }) => ({
        invocationId,
        status: "succeeded" as const,
        createdAt: "2026-07-13T00:02:00.000Z",
        updatedAt: "2026-07-13T00:02:01.000Z",
        finishedAt: "2026-07-13T00:02:01.000Z",
        eventCursor: 0,
      }),
      turnStream: async (_paths, { invocationId }) => ({
        invocationId,
        events: [],
        nextCursor: 0,
        hasMore: false,
      }),
    };

    assert.equal(
      await runSparkCli(["--session", sessionPath], {
        daemonClient,
        createHostServices: base.createHostServices,
        terminal: { stdinIsTTY: true, stdoutIsTTY: true },
        runTui: async (input) => {
          assert.equal(typeof input, "object");
          assert.notEqual(input, null);
          const options = input as Exclude<typeof input, string | undefined>;
          assert.equal(options.workspaceSession?.attachTarget, "same-session");
          const modelCommand = options.slashCommands?.model as {
            handler: (args: string, context: never) => Promise<unknown>;
          };
          await modelCommand.handler("provider-a/model-b", {} as never);
          assert.match(
            (await options.responder?.("after model switch", { messages: [] })) ?? "",
            /completed session same-session: inv_1/u,
          );
        },
      }),
      0,
    );

    assert.equal(managedSessions.length, 1);
    assert.equal(managedSessions[0]?.sessionId, "same-session");
    assert.deepEqual(managedSessions[0]?.model, {
      providerName: "provider-a",
      modelId: "model-b",
    });
    assert.deepEqual(controlCalls, [
      { method: "session.snapshot", params: { sessionId: "same-session" } },
      { method: "model.catalog", params: { sessionId: "same-session" } },
      {
        method: "session.model.set",
        params: {
          sessionId: "same-session",
          model: { providerName: "provider-a", modelId: "model-b" },
        },
      },
    ]);
    assert.match(submitted[0]?.input.idempotencyKey ?? "", /^turn\.submit:spark_cli_/u);
    assert.deepEqual(
      submitted.map(({ input: { idempotencyKey: _, ...input } }) => input),
      [
        {
          sessionId: "same-session",
          prompt: "after model switch",
          messageMetadata: {
            origin: { kind: "user", host: "tui", surface: "local" },
          },
        },
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark native responder retries an ACK loss with the same idempotency key", async () => {
  const submissions: Array<{ sessionId: string; prompt: string; idempotencyKey?: string }> = [];
  const responder = createSparkDaemonNativeResponder(
    {
      startService: () => ({ kind: "detached" as const, alreadyRunning: false, detail: "started" }),
      daemonStatus: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        servers: [],
        invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
      }),
      turnSubmit: async (_paths, input) => {
        submissions.push(input);
        if (submissions.length === 1) {
          throw new SparkDaemonLocalRpcUnavailableError("connection closed before ACK");
        }
        return {
          invocationId: "inv_ackloss",
          status: "queued" as const,
          acceptedAt: "2026-06-19T00:00:00.000Z",
        };
      },
    },
    { sessionId: "native-session", waitForCompletion: false },
  );

  await responder("one prompt", { submissionId: "idem_native_submit_1" });

  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions[0], submissions[1]);
  assert.equal(submissions[0]?.idempotencyKey, "idem_native_submit_1");
});

void test("production TUI Shift+Tab overrides extension shortcut and updates session thinking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-session-thinking-"));
  try {
    const base = createWorkspaceAttachTestDeps(dir, { existingSessionIds: new Set() });
    const sessionId = "thinking-session";
    let thinkingLevel: "high" | "xhigh" = "high";
    const managedSession = {
      sessionId,
      scope: { kind: "workspace" as const, workspaceId: "workspace-current" },
      workspaceId: "workspace-current",
      cwd: dir,
      status: "ready" as const,
      bindings: [],
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      thinkingLevel: thinkingLevel as "high" | "xhigh",
    };
    const controlCalls: Array<{ method: string; params: unknown }> = [];
    const daemonClient: SparkDaemonClientOptions = {
      ...base.daemonClient,
      managedSessions: {
        list: async () => [managedSession],
        create: async () => {
          throw new Error("existing selection must not create a session");
        },
        get: async (requestedSessionId) => {
          assert.equal(requestedSessionId, sessionId);
          return managedSession;
        },
        bind: async () => managedSession,
        unbind: async () => managedSession,
        archive: async () => ({ ...managedSession, status: "archived" as const }),
      },
      controlRequest: async (method, params) => {
        controlCalls.push({ method, params });
        if (method === "session.snapshot") {
          return {
            version: 1,
            sessionId,
            status: "idle",
            cwd: dir,
            thinkingLevel,
            messages: [],
            tools: [],
            runs: [],
            tasks: [],
            artifacts: [],
            metadata: {},
          };
        }
        if (method === "model.catalog") {
          return {
            providers: [],
            session: { sessionId, thinkingLevel },
            diagnostics: [],
          };
        }
        if (method === "session.thinking.set") {
          const request = params as { sessionId: string; thinkingLevel: "xhigh" };
          assert.deepEqual(request, { sessionId, thinkingLevel: "xhigh" });
          thinkingLevel = request.thinkingLevel;
          managedSession.thinkingLevel = thinkingLevel;
          return managedSession;
        }
        throw new Error(`unexpected thinking control method: ${method}`);
      },
    };
    const keybindings = new SparkKeybindings();
    let extensionShortcutCalls = 0;
    const createHostServices = async () => {
      const services = (await base.createHostServices()) as unknown as SparkCliHostServices;
      const runtime = new SparkHostRuntime({ cwd: dir, hasUI: true, keybindings });
      runtime.registerShortcut("shift+tab", {
        description: "Extension shortcut competing with session thinking",
        handler: () => {
          extensionShortcutCalls += 1;
        },
      });
      return { ...services, runtime, keybindings };
    };

    assert.equal(
      await runSparkCli([], {
        daemonClient,
        createHostServices,
        terminal: { stdinIsTTY: true, stdoutIsTTY: true },
        selectSession: async () => sessionId,
        runTui: async (input) => {
          assert.equal(typeof input, "object");
          assert.notEqual(input, null);
          const options = input as Exclude<typeof input, string | undefined>;
          const harness = createSparkNativeTuiHarness({
            keybindings: options.keybindings,
            statusContext: options.statusContext,
            workspaceSession: options.workspaceSession,
          });
          await options.configureApp?.(harness.app, harness.session);
          assert.equal(options.statusContext?.thinkingLevel?.(), "high");

          await harness.press("\x1b[Z");

          assert.equal(options.statusContext?.thinkingLevel?.(), "xhigh");
        },
      }),
      0,
    );

    assert.equal(extensionShortcutCalls, 0);
    assert.deepEqual(controlCalls, [
      { method: "session.snapshot", params: { sessionId } },
      { method: "model.catalog", params: { sessionId } },
      {
        method: "session.thinking.set",
        params: { sessionId, thinkingLevel: "xhigh" },
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark native responder streams daemon view events as assistant chunks", async () => {
  const chunks: string[] = [];
  const viewEvents: unknown[] = [];
  const responder = createSparkDaemonNativeResponder(
    {
      startService: () => ({ kind: "detached" as const, alreadyRunning: false, detail: "started" }),
      daemonStatus: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        servers: [],
        invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
      }),
      turnSubmit: async () => ({
        invocationId: "inv_stream",
        status: "queued" as const,
        acceptedAt: "2026-06-19T00:00:00.000Z",
      }),
      turnStream: async () => ({
        invocationId: "inv_stream",
        events: ["hel", "hello"].map((text, index) => ({
          invocationId: "inv_stream",
          sequence: index + 1,
          kind: "daemon.view_event",
          payload: {
            version: 1,
            type: "daemon.view_event",
            source: "daemon",
            emittedAt: "2026-06-19T00:00:00.000Z",
            sessionId: "native-session",
            invocationId: "inv_stream",
            view: {
              version: 1,
              type: "session.message",
              sessionId: "native-session",
              message: { id: "assistant", role: "assistant", text, status: "streaming" },
            },
          },
          createdAt: "2026-06-19T00:00:00.000Z",
        })),
        nextCursor: 2,
        hasMore: false,
      }),
      turnStatus: async () => ({
        invocationId: "inv_stream",
        sessionId: "native-session",
        status: "succeeded" as const,
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:01.000Z",
        finishedAt: "2026-06-19T00:00:01.000Z",
        eventCursor: 2,
      }),
    },
    {
      sessionId: "native-session",
      onViewEvent: (event) => viewEvents.push(event),
    },
  );

  const output = await responder("hello", {
    appendAssistantChunk: (chunk) => chunks.push(chunk),
  });

  assert.equal(output, "");
  assert.deepEqual(chunks, ["hel", "lo"]);
  assert.deepEqual(
    viewEvents.map((event: any) => event.message.text),
    ["hel", "hello"],
  );
});

void test("Spark native responder pauses event polling for a visible interaction handler", async () => {
  const requests: string[] = [];
  let interactionFinished = false;
  const responder = createSparkDaemonNativeResponder(
    {
      turnSubmit: async () => ({
        invocationId: "inv_interaction",
        status: "queued" as const,
        acceptedAt: "2026-07-17T00:00:00.000Z",
      }),
      turnStream: async () => ({
        invocationId: "inv_interaction",
        events: [
          {
            invocationId: "inv_interaction",
            sequence: 1,
            kind: "daemon.interaction.request",
            payload: {
              version: 1,
              type: "daemon.interaction.request",
              source: "daemon",
              sessionId: "native-interaction-session",
              invocationId: "inv_interaction",
              request: {
                version: 1,
                requestId: "ask-visible",
                kind: "askFlow",
                title: "Choose a path",
                mode: "decision",
                questions: [
                  {
                    id: "path",
                    prompt: "Which path?",
                    type: "single",
                    required: true,
                    defaultValues: [],
                    options: [
                      { value: "a", label: "Path A" },
                      { value: "b", label: "Path B" },
                    ],
                  },
                ],
                metadata: {},
              },
              metadata: {},
            },
            createdAt: "2026-07-17T00:00:00.000Z",
          },
        ],
        nextCursor: 1,
        hasMore: false,
      }),
      turnStatus: async () => ({
        invocationId: "inv_interaction",
        sessionId: "native-interaction-session",
        status: "succeeded" as const,
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:01.000Z",
        finishedAt: "2026-07-17T00:00:01.000Z",
        eventCursor: 1,
      }),
    },
    {
      sessionId: "native-interaction-session",
      onInteractionRequest: async (request) => {
        requests.push(request.requestId);
        await Promise.resolve();
        interactionFinished = true;
      },
    },
  );

  await responder("ask me");
  assert.deepEqual(requests, ["ask-visible"]);
  assert.equal(interactionFinished, true);
});

void test("Spark native responder retries completion status transport failures without resubmitting", async () => {
  let submitCalls = 0;
  const statusInvocationIds: string[] = [];
  const retryDelays: number[] = [];
  const failures: Error[] = [
    new SparkDaemonLocalRpcUnavailableError("connect ENOENT"),
    new SparkDaemonLocalRpcUnavailableError("Timed out waiting for daemon RPC response"),
    new SparkDaemonLocalRpcError("Spark daemon local RPC connection closed before a response."),
  ];
  const responder = createSparkDaemonNativeResponder(
    {
      turnSubmit: async () => {
        submitCalls += 1;
        return {
          invocationId: "inv_status_retry",
          status: "queued" as const,
          acceptedAt: "2026-07-15T00:00:00.000Z",
        };
      },
      turnStatus: async (_paths, input) => {
        statusInvocationIds.push(input.invocationId);
        const failure = failures.shift();
        if (failure) throw failure;
        return {
          invocationId: input.invocationId,
          status: "succeeded" as const,
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:01.000Z",
          finishedAt: "2026-07-15T00:00:01.000Z",
          eventCursor: 0,
        };
      },
      random: () => 0,
      sleep: async (ms) => {
        retryDelays.push(ms);
      },
    },
    { sessionId: "status-retry-session" },
  );

  assert.match(
    await responder("wait through restart"),
    /completed session status-retry-session: inv_status_retry/u,
  );
  assert.equal(submitCalls, 1);
  assert.deepEqual(statusInvocationIds, Array(4).fill("inv_status_retry"));
  assert.deepEqual(retryDelays, [50, 100, 200]);
});

void test("Spark native responder retries stream and terminal status from stable invocation state", async () => {
  let submitCalls = 0;
  const streamCursors: number[] = [];
  const statusInvocationIds: string[] = [];
  const retryDelays: number[] = [];
  let streamFailures = 4;
  let statusFailures = 4;
  const transientFailure = (remaining: number): Error => {
    if (remaining === 4) {
      return new SparkDaemonLocalRpcRemoteError(
        "Spark daemon is still starting; retry after readiness.",
        {
          code: "daemon_starting",
          message: "Spark daemon is still starting; retry after readiness.",
        },
      );
    }
    if (remaining === 3) return new SparkDaemonLocalRpcUnavailableError("connect ENOENT");
    if (remaining === 2) {
      return new SparkDaemonLocalRpcUnavailableError("Timed out waiting for daemon RPC response");
    }
    return new SparkDaemonLocalRpcError(
      "Spark daemon local RPC connection closed before a response.",
    );
  };
  const responder = createSparkDaemonNativeResponder(
    {
      turnSubmit: async () => {
        submitCalls += 1;
        return {
          invocationId: "inv_stream_transport_retry",
          status: "queued" as const,
          acceptedAt: "2026-07-15T00:00:00.000Z",
        };
      },
      turnStream: async (_paths, input) => {
        streamCursors.push(input.after ?? 0);
        if (streamFailures > 0) throw transientFailure(streamFailures--);
        return {
          invocationId: "inv_stream_transport_retry",
          events: [
            {
              invocationId: "inv_stream_transport_retry",
              sequence: 1,
              kind: "daemon.view_event",
              payload: {
                version: 1,
                type: "daemon.view_event",
                source: "daemon",
                emittedAt: "2026-07-15T00:00:00.000Z",
                sessionId: "stream-transport-retry-session",
                invocationId: "inv_stream_transport_retry",
                view: {
                  version: 1,
                  type: "session.message",
                  sessionId: "stream-transport-retry-session",
                  message: {
                    id: "assistant",
                    role: "assistant",
                    text: "done",
                    status: "streaming",
                  },
                },
              },
              createdAt: "2026-07-15T00:00:00.000Z",
            },
          ],
          nextCursor: 1,
          hasMore: false,
        };
      },
      turnStatus: async (_paths, input) => {
        statusInvocationIds.push(input.invocationId);
        if (statusFailures > 0) throw transientFailure(statusFailures--);
        return {
          invocationId: input.invocationId,
          status: "succeeded" as const,
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:01.000Z",
          finishedAt: "2026-07-15T00:00:01.000Z",
          eventCursor: 1,
        };
      },
      random: () => 0,
      sleep: async (ms) => {
        retryDelays.push(ms);
      },
    },
    { sessionId: "stream-transport-retry-session" },
  );
  const chunks: string[] = [];

  assert.equal(
    await responder("stream through restart", {
      appendAssistantChunk: (chunk) => chunks.push(chunk),
    }),
    "",
  );
  assert.equal(submitCalls, 1);
  assert.deepEqual(streamCursors, [0, 0, 0, 0, 0]);
  assert.deepEqual(statusInvocationIds, Array(6).fill("inv_stream_transport_retry"));
  assert.deepEqual(retryDelays, [50, 100, 200, 400, 50, 100, 200, 400]);
  assert.deepEqual(chunks, ["done"]);
});

void test("Spark native responder does not retry remote or protocol read failures", async () => {
  let remoteStatusCalls = 0;
  let remoteSubmitCalls = 0;
  const remoteRetryDelays: number[] = [];
  const remoteResponder = createSparkDaemonNativeResponder(
    {
      turnSubmit: async () => {
        remoteSubmitCalls += 1;
        return {
          invocationId: "inv_remote_failure",
          status: "queued" as const,
          acceptedAt: "2026-07-15T00:00:00.000Z",
        };
      },
      turnStatus: async () => {
        remoteStatusCalls += 1;
        throw new SparkDaemonLocalRpcRemoteError("turn validation rejected", {
          code: "INVALID_ARGUMENT",
        });
      },
      sleep: async (ms) => {
        remoteRetryDelays.push(ms);
      },
    },
    { sessionId: "remote-failure-session" },
  );

  await assert.rejects(() => remoteResponder("remote failure"), /turn validation rejected/u);
  assert.equal(remoteSubmitCalls, 1);
  assert.equal(remoteStatusCalls, 1);
  assert.deepEqual(remoteRetryDelays, []);

  let protocolStreamCalls = 0;
  let protocolStatusCalls = 0;
  const protocolRetryDelays: number[] = [];
  const protocolResponder = createSparkDaemonNativeResponder(
    {
      turnSubmit: async () => ({
        invocationId: "inv_protocol_failure",
        status: "queued" as const,
        acceptedAt: "2026-07-15T00:00:00.000Z",
      }),
      turnStream: async () => {
        protocolStreamCalls += 1;
        throw new SparkDaemonLocalRpcError("Invalid local RPC response.");
      },
      turnStatus: async () => {
        protocolStatusCalls += 1;
        throw new Error("status must not be reached");
      },
      sleep: async (ms) => {
        protocolRetryDelays.push(ms);
      },
    },
    { sessionId: "protocol-failure-session" },
  );

  await assert.rejects(
    () => protocolResponder("protocol failure", { appendAssistantChunk: () => undefined }),
    /Invalid local RPC response/u,
  );
  assert.equal(protocolStreamCalls, 1);
  assert.equal(protocolStatusCalls, 0);
  assert.deepEqual(protocolRetryDelays, []);
});

void test("Spark native responder bounds completion read retries by deadline and abort signal", async () => {
  let clock = 0;
  let deadlineSubmitCalls = 0;
  let deadlineStatusCalls = 0;
  const deadlineRetryDelays: number[] = [];
  const deadlineResponder = createSparkDaemonNativeResponder(
    {
      turnSubmit: async () => {
        deadlineSubmitCalls += 1;
        return {
          invocationId: "inv_read_deadline",
          status: "queued" as const,
          acceptedAt: "2026-07-15T00:00:00.000Z",
        };
      },
      turnStatus: async () => {
        deadlineStatusCalls += 1;
        throw new SparkDaemonLocalRpcUnavailableError("connect ENOENT");
      },
      now: () => clock,
      random: () => 0,
      sleep: async (ms) => {
        deadlineRetryDelays.push(ms);
        clock += ms;
      },
    },
    { sessionId: "read-deadline-session", timeoutMs: 149 },
  );

  assert.match(
    await deadlineResponder("deadline"),
    /queued for Spark daemon session read-deadline-session/u,
  );
  assert.equal(deadlineSubmitCalls, 1);
  assert.equal(deadlineStatusCalls, 2);
  assert.deepEqual(deadlineRetryDelays, [50, 99]);

  const controller = new AbortController();
  const abortReason = new Error("cancel completion retry");
  let abortSubmitCalls = 0;
  let abortStatusCalls = 0;
  const abortResponder = createSparkDaemonNativeResponder(
    {
      turnSubmit: async () => {
        abortSubmitCalls += 1;
        return {
          invocationId: "inv_read_abort",
          status: "queued" as const,
          acceptedAt: "2026-07-15T00:00:00.000Z",
        };
      },
      turnStatus: async () => {
        abortStatusCalls += 1;
        throw new SparkDaemonLocalRpcUnavailableError("connect ENOENT");
      },
      sleep: async (_ms, signal) => {
        assert.equal(signal, controller.signal);
        controller.abort(abortReason);
      },
    },
    { sessionId: "read-abort-session" },
  );

  await assert.rejects(
    () => abortResponder("abort", { signal: controller.signal }),
    (error) => error === abortReason,
  );
  assert.equal(abortSubmitCalls, 1);
  assert.equal(abortStatusCalls, 1);
});

void test("Spark native responder accepts an empty terminal page and ignores non-daemon payloads", async () => {
  const chunks: string[] = [];
  let streamCalls = 0;
  const responder = createSparkDaemonNativeResponder(
    {
      turnSubmit: async () => ({
        invocationId: "inv_empty_terminal",
        status: "queued" as const,
        acceptedAt: "2026-06-19T00:00:00.000Z",
      }),
      turnStream: async () => {
        streamCalls += 1;
        return {
          invocationId: "inv_empty_terminal",
          events: [
            {
              invocationId: "inv_empty_terminal",
              sequence: 1,
              kind: "diagnostic",
              payload: { type: "not-a-daemon-event", detail: "ignore me" },
              createdAt: "2026-06-19T00:00:00.000Z",
            },
          ],
          nextCursor: 1,
          hasMore: false,
        };
      },
      turnStatus: async () => ({
        invocationId: "inv_empty_terminal",
        sessionId: "native-empty-terminal",
        status: "succeeded" as const,
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:01.000Z",
        finishedAt: "2026-06-19T00:00:01.000Z",
        eventCursor: 1,
      }),
    },
    { sessionId: "native-empty-terminal" },
  );

  const output = await responder("empty terminal", {
    appendAssistantChunk: (chunk) => chunks.push(chunk),
  });

  assert.match(output, /completed session native-empty-terminal: inv_empty_terminal/u);
  assert.equal(streamCalls, 1);
  assert.deepEqual(chunks, []);
});

void test("Spark native responder aborts before polling the invocation stream", async () => {
  const controller = new AbortController();
  controller.abort(new Error("user stopped"));
  let streamCalls = 0;
  const responder = createSparkDaemonNativeResponder(
    {
      turnSubmit: async () => ({
        invocationId: "inv_aborted",
        status: "queued" as const,
        acceptedAt: "2026-06-19T00:00:00.000Z",
      }),
      turnStream: async () => {
        streamCalls += 1;
        return {
          invocationId: "inv_aborted",
          events: [],
          nextCursor: 0,
          hasMore: false,
        };
      },
      turnStatus: async () => ({
        invocationId: "inv_aborted",
        sessionId: "native-aborted",
        status: "running" as const,
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:01.000Z",
        eventCursor: 0,
      }),
    },
    { sessionId: "native-aborted" },
  );

  await assert.rejects(
    () =>
      responder("abort", {
        signal: controller.signal,
        appendAssistantChunk: () => undefined,
      }),
    /user stopped/u,
  );
  assert.equal(streamCalls, 0);
});

void test("Spark native responder enforces the stream deadline after a live page", async () => {
  const responder = createSparkDaemonNativeResponder(
    {
      turnSubmit: async () => ({
        invocationId: "inv_deadline",
        status: "queued" as const,
        acceptedAt: "2026-06-19T00:00:00.000Z",
      }),
      turnStream: async () => ({
        invocationId: "inv_deadline",
        events: [],
        nextCursor: 0,
        hasMore: false,
      }),
      turnStatus: async () => ({
        invocationId: "inv_deadline",
        sessionId: "native-deadline",
        status: "running" as const,
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:01.000Z",
        eventCursor: 0,
      }),
    },
    { sessionId: "native-deadline", timeoutMs: 0 },
  );

  await assert.rejects(
    () => responder("deadline", { appendAssistantChunk: () => undefined }),
    /Timed out while streaming invocation inv_deadline/u,
  );
});

void test("Spark native responder reconnects from its durable cursor without duplicate terminal rendering", async () => {
  const chunks: string[] = [];
  const cursors: number[] = [];
  let streamAttempt = 0;
  let terminalRenderCount = 0;
  const event = (sequence: number, text: string) => ({
    invocationId: "inv_reconnect",
    sequence,
    kind: "daemon.view_event",
    payload: {
      version: 1,
      type: "daemon.view_event",
      source: "daemon",
      emittedAt: "2026-06-19T00:00:00.000Z",
      sessionId: "native-reconnect",
      invocationId: "inv_reconnect",
      view: {
        version: 1,
        type: "session.message",
        sessionId: "native-reconnect",
        message: { id: "assistant", role: "assistant", text, status: "streaming" },
      },
    },
    createdAt: "2026-06-19T00:00:00.000Z",
  });
  const responder = createSparkDaemonNativeResponder(
    {
      startService: () => ({ kind: "detached" as const, alreadyRunning: false, detail: "started" }),
      daemonStatus: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        servers: [],
        invocations: { queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
      }),
      turnSubmit: async () => ({
        invocationId: "inv_reconnect",
        status: "queued" as const,
        acceptedAt: "2026-06-19T00:00:00.000Z",
      }),
      turnStream: async (_paths, input) => {
        cursors.push(input.after ?? 0);
        streamAttempt += 1;
        if (streamAttempt === 1) {
          return {
            invocationId: "inv_reconnect",
            events: [event(1, "a"), event(2, "ab")],
            nextCursor: 2,
            hasMore: false,
          };
        }
        if (streamAttempt === 2) {
          throw new SparkDaemonLocalRpcUnavailableError("daemon socket disconnected");
        }
        return {
          invocationId: "inv_reconnect",
          events: [event(3, "abc")],
          nextCursor: 3,
          hasMore: false,
        };
      },
      turnStatus: async () => ({
        invocationId: "inv_reconnect",
        sessionId: "native-reconnect",
        status: streamAttempt >= 3 ? ("succeeded" as const) : ("running" as const),
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:01.000Z",
        eventCursor: 3,
      }),
    },
    { sessionId: "native-reconnect" },
  );

  const output = await responder("reconnect", {
    appendAssistantChunk: (chunk) => chunks.push(chunk),
    finishAssistantMessage: () => {
      terminalRenderCount += 1;
    },
  });

  assert.equal(output, "");
  assert.deepEqual(cursors, [0, 2, 2]);
  assert.deepEqual(chunks, ["a", "b", "c"]);
  assert.equal(terminalRenderCount, 1);
  console.info(
    "SPARK_TUI_INVOCATION_RECONNECT_TRANSCRIPT",
    JSON.stringify({
      invocationId: "inv_reconnect",
      cursors,
      eventSequences: [1, 2, 3],
      duplicateEventCount: 0,
      terminalRenderCount,
    }),
  );
});

void test("Spark native responder drains 10,000 bounded invocation events without status arrays", async () => {
  const invocationId = "inv_0123456789abcdef0123456789abcdef";
  const events = Array.from({ length: 10_000 }, (_, index) => ({
    invocationId,
    sequence: index + 1,
    kind: "daemon.task.lifecycle",
    payload: {
      version: 1,
      type: "daemon.task.lifecycle",
      source: "daemon",
      emittedAt: "2026-06-19T00:00:00.000Z",
      invocationId,
      taskType: "session.run",
      status: "running",
      metadata: {},
    },
    createdAt: "2026-06-19T00:00:00.000Z",
  }));
  let maxPageBytes = 0;
  let statusBytes = 0;
  let statusCallCount = 0;
  const responder = createSparkDaemonNativeResponder(
    {
      startService: () => ({ kind: "detached" as const, alreadyRunning: false, detail: "started" }),
      daemonStatus: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        servers: [],
        invocations: { queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
      }),
      turnSubmit: async () => ({
        invocationId,
        status: "queued" as const,
        acceptedAt: "2026-06-19T00:00:00.000Z",
      }),
      turnStream: async (_paths, input) => {
        const after = input.after ?? 0;
        const limit = input.limit ?? 100;
        const pageEvents = events.slice(after, after + limit);
        const page = {
          invocationId,
          events: pageEvents,
          nextCursor: pageEvents.at(-1)?.sequence ?? after,
          hasMore: after + pageEvents.length < events.length,
        };
        maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page)));
        assert.ok(page.events.length <= 100);
        assert.ok(maxPageBytes < 1024 * 1024);
        return page;
      },
      turnStatus: async () => {
        statusCallCount += 1;
        const status = {
          invocationId,
          status: "succeeded" as const,
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:01.000Z",
          finishedAt: "2026-06-19T00:00:01.000Z",
          eventCursor: events.length,
        };
        statusBytes = Buffer.byteLength(JSON.stringify(status));
        assert.equal("events" in status, false);
        assert.ok(statusBytes < 1024 * 1024);
        return status;
      },
    },
    { sessionId: "native-large-stream" },
  );

  const output = await responder("large stream", { appendAssistantChunk: () => undefined });
  assert.match(output, /completed session native-large-stream/u);
  assert.equal(statusCallCount, 101);
  assert.ok(maxPageBytes < 1024 * 1024);
  assert.ok(statusBytes < 1024 * 1024);
  console.info(
    "SPARK_TUI_INVOCATION_LARGE_STREAM_TRANSCRIPT",
    JSON.stringify({
      invocationId,
      eventCount: events.length,
      pageLimit: 100,
      statusCallCount,
      maxPageBytes,
      statusBytes,
      statusContainsEvents: false,
    }),
  );
});

void test("Spark native responder ensures its workspace session once before submission", async () => {
  const calls: string[] = [];
  const sessions: Array<{
    sessionId: string;
    scope: { kind: "workspace"; workspaceId: string };
    workspaceId: string;
    status: "ready";
    bindings: [];
    createdAt: string;
    updatedAt: string;
    cwd?: string;
  }> = [];
  const responder = createSparkDaemonNativeResponder(
    {
      startService: () => ({ kind: "detached" as const, alreadyRunning: false, detail: "started" }),
      daemonStatus: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        servers: [],
        invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
      }),
      managedSessions: {
        list: async () => {
          calls.push("list");
          return sessions;
        },
        create: async (input) => {
          assert.deepEqual(input.scope, { kind: "workspace", workspaceId: "ws-native" });
          assert.equal(input.cwd, "/workspace/native");
          calls.push(`create:${input.sessionId}`);
          const record = {
            sessionId: input.sessionId!,
            scope: input.scope as { kind: "workspace"; workspaceId: string },
            workspaceId: "ws-native",
            status: "ready" as const,
            bindings: [] as [],
            createdAt: "2026-06-19T00:00:00.000Z",
            updatedAt: "2026-06-19T00:00:00.000Z",
            cwd: input.cwd,
          };
          sessions.push(record);
          return record;
        },
        get: async () => sessions[0]!,
        bind: async () => sessions[0]!,
        unbind: async () => sessions[0]!,
        archive: async () => ({ ...sessions[0]!, status: "archived" as const }),
      },
      turnSubmit: async (_paths, input) => {
        calls.push(`submit:${input.sessionId}:${input.prompt}`);
        return {
          invocationId: `inv_${input.prompt}`,
          status: "queued" as const,
          acceptedAt: "2026-06-19T00:00:00.000Z",
        };
      },
      turnStatus: async (_paths, { invocationId }) => ({
        invocationId,
        status: "succeeded" as const,
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:01.000Z",
        finishedAt: "2026-06-19T00:00:01.000Z",
        eventCursor: 0,
      }),
    },
    {
      sessionId: "native-session",
      workspaceId: "ws-native",
      cwd: "/workspace/native",
    },
  );

  assert.match(await responder("one"), /completed session native-session: inv_one/u);
  assert.match(await responder("two"), /completed session native-session: inv_two/u);
  assert.deepEqual(calls, [
    "list",
    "create:native-session",
    "submit:native-session:one",
    "submit:native-session:two",
  ]);
});

void test("Spark native responder submits prompts through daemon IPC", async () => {
  const calls: Array<{ sessionId: string; prompt: string }> = [];
  const idempotencyKeys: string[] = [];
  const responder = createSparkDaemonNativeResponder(
    {
      startService: () => ({ kind: "detached" as const, alreadyRunning: false, detail: "started" }),
      daemonStatus: async () => ({
        observedAt: "2026-06-19T00:00:00.000Z",
        servers: [],
        invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
      }),
      turnSubmit: async (_paths, input) => {
        calls.push({ sessionId: input.sessionId, prompt: input.prompt });
        idempotencyKeys.push(input.idempotencyKey ?? "");
        return {
          invocationId: `inv_${calls.length}`,
          status: "queued" as const,
          acceptedAt: "2026-06-19T00:00:00.000Z",
        };
      },
      turnStatus: async (_paths, { invocationId }) => ({
        invocationId,
        status: "succeeded" as const,
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:01.000Z",
        finishedAt: "2026-06-19T00:00:01.000Z",
        eventCursor: 0,
      }),
    },
    { sessionId: "native-session" },
  );

  const firstOutput = await responder("hello through daemon");
  const secondOutput = await responder("follow-up through daemon");
  assert.match(firstOutput, /completed session native-session: inv_1/u);
  assert.match(secondOutput, /completed session native-session: inv_2/u);
  assert.deepEqual(calls, [
    { sessionId: "native-session", prompt: "hello through daemon" },
    { sessionId: "native-session", prompt: "follow-up through daemon" },
  ]);
  assert.match(idempotencyKeys[0] ?? "", /^turn\.submit:spark_cli_/u);
  assert.match(idempotencyKeys[1] ?? "", /^turn\.submit:spark_cli_/u);
  assert.notEqual(idempotencyKeys[0], idempotencyKeys[1]);
});
