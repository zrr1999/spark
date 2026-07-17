import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vitest";

import {
  createId,
  runtimeProtocolVersion,
  serverCommandEnvelopeSchema,
  type ServerCommandEnvelope,
  type SparkAssignment,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";

import {
  handleCommand,
  handleServerMessage,
  type MessageContext,
  type ServerSocket,
} from "../../../../spark-daemon/src/daemon.ts";
import {
  acknowledgeRuntimeCommandTerminal,
  runtimeCommandReceipt,
} from "../../../../spark-daemon/src/runtime-command-receipts.ts";
import { createDaemonSessionRegistry } from "../../../../spark-daemon/src/session-registry.ts";
import { SparkInvocationStore } from "../../../../spark-daemon/src/store/invocations.ts";
import { openSparkDaemonDatabase } from "../../../../spark-daemon/src/store/schema.ts";
import { registerWorkspace } from "../../../../spark-daemon/src/store/workspaces.ts";
import { createWorkspaceWithOwnerBinding } from "../../../../../packages/spark-coordination/src/projection-services.ts";
import { migrate, openMemoryDatabase } from "../../../../../packages/spark-db/src/index.ts";
import {
  attachRuntimeWebSocket,
  type RuntimeWebSocketConnection,
} from "../../../../../packages/spark-coordination/src/runtime-ws.ts";
import { createCockpitRuntimeSessionClient } from "./cockpit-runtime-session-client.ts";

const now = "2026-07-15T00:00:00.000Z";

test("remote Cockpit controls both session scopes without a daemon socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-remote-session-control-"));
  const nonexistentSocket = join(root, "cockpit-host", "daemon.sock");
  const paths = resolveSparkPaths({
    app: "daemon",
    env: { HOME: root },
    overrides: {
      dataDir: join(root, "daemon-data"),
      cacheDir: join(root, "daemon-cache"),
      stateDir: join(root, "daemon-state"),
      runtimeDir: join(root, "daemon-runtime"),
    },
  });
  const cockpitDb = openMemoryDatabase();
  const daemonDb = openSparkDaemonDatabase(paths);
  try {
    migrate(cockpitDb);
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    const installationId = "install-remote-session-control";
    cockpitDb
      .prepare(
        `INSERT INTO runtime_connections
          (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
           created_at, updated_at)
         VALUES (?, ?, 'Remote session daemon', 'offline', ?, '{}', '{}', ?, ?)`,
      )
      .run(runtimeId, installationId, runtimeProtocolVersion, now, now);
    cockpitDb
      .prepare(
        `INSERT INTO runtime_workspace_bindings
          (id, runtime_id, local_workspace_key, local_path, display_name, status,
           capabilities_json, diagnostics_json, created_at, updated_at)
         VALUES (?, ?, 'remote-session', ?, 'Remote session workspace', 'available',
                 '{}', '{}', ?, ?)`,
      )
      .run(bindingId, runtimeId, root, now, now);
    const cockpitWorkspace = createWorkspaceWithOwnerBinding(cockpitDb, {
      slug: "remote-session",
      name: "Remote session workspace",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });
    registerWorkspace(daemonDb, {
      serverBindingId: bindingId,
      serverWorkspaceId: cockpitWorkspace.id,
      serverUrl: "https://cockpit.example.test/",
      localWorkspaceKey: "remote-session",
      displayName: "Remote session workspace",
      workspaceName: "Remote session workspace",
      workspaceSlug: "remote-session",
      localPath: root,
      serverStatus: "available",
      now,
    });

    const registry = createDaemonSessionRegistry(join(root, "spark-home"), {
      daemonId: installationId,
      daemonCwd: root,
      resolveWorkspaceCwd: (workspaceId) =>
        workspaceId === cockpitWorkspace.id ? root : undefined,
    });
    const context: MessageContext = {
      paths,
      config: { installationId, displayName: "Remote session daemon", runtimeId },
      db: daemonDb,
      runtimeId,
      runtimeSessionId: undefined,
      setRuntimeSessionId(value) {
        this.runtimeSessionId = value;
      },
      ensureHeartbeat() {},
      runSparkCommand: async () => {
        throw new Error("generic command bridge must not execute session control");
      },
      cancelSparkInvocation: async ({ invocationId }) => ({
        invocationId,
        cancelled: false,
        message: "generic cancellation bridge was not used",
      }),
      sessionRegistry: registry,
      onIngestAck: (ackOf) => {
        acknowledgeRuntimeCommandTerminal(daemonDb, ackOf, now);
      },
    };

    let bridge = connectRuntime(cockpitDb, context, bindingId);
    const bridges = [bridge];
    const client = createCockpitRuntimeSessionClient(cockpitDb);
    const workspaceSessionId = createId("sess");
    const daemonSessionId = createId("sess");
    const workspaceCreate = {
      sessionId: workspaceSessionId,
      scope: { kind: "workspace", workspaceId: cockpitWorkspace.id },
      workspaceId: cockpitWorkspace.id,
      title: "Workspace round",
      idempotencyKey: createId("idem"),
    } as const;
    const workspaceSession = await client.create(workspaceCreate);
    const workspaceSessionReplay = await client.create(workspaceCreate);
    const daemonSession = await client.create({
      runtimeId,
      sessionId: daemonSessionId,
      scope: { kind: "daemon" },
      title: "Daemon round",
    });
    assert.equal(workspaceSession.scope.kind, "workspace");
    assert.deepEqual(workspaceSessionReplay, workspaceSession);
    assert.deepEqual(daemonSession.scope, { kind: "daemon", daemonId: installationId });
    await assert.rejects(
      client.create({
        runtimeId,
        sessionId: createId("sess"),
        scope: { kind: "daemon" },
        cwd: "/tmp/remote-path-injection",
      }),
      /cannot select daemon-local cwd or sessionPath/u,
    );

    const bound = await client.bind({
      sessionId: workspaceSessionId,
      externalKey: "infoflow:user:remote-e2e",
    });
    assert.equal(bound.bindings.length, 1);
    const unbound = await client.unbind({
      sessionId: workspaceSessionId,
      externalKey: "infoflow:user:remote-e2e",
    });
    assert.equal(unbound.bindings.length, 0);
    const listed = await client.list({ includeArchived: true });
    assert.deepEqual(listed.map(({ sessionId }) => sessionId).sort(), [workspaceSessionId]);

    const additionalDaemonSessions = await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        registry.create({
          sessionId: createId("sess"),
          scope: { kind: "daemon" },
          title: `Paged daemon session ${index} ${"x".repeat(400)}`,
        }),
      ),
    );
    const pagedDaemonSessions = await client.list({
      runtimeId,
      scope: { kind: "daemon" },
      includeArchived: true,
    });
    assert.equal(pagedDaemonSessions.length, 102);
    assert.ok(
      additionalDaemonSessions.every(({ sessionId }) =>
        pagedDaemonSessions.some((session) => session.sessionId === sessionId),
      ),
    );

    const workspaceTurn = await client.submit({
      sessionId: workspaceSessionId,
      prompt: "Workspace round one",
      assignment: assignment(workspaceSessionId, "Workspace round one", cockpitWorkspace.id),
      idempotencyKey: createId("idem"),
    });
    const invocationStore = new SparkInvocationStore(daemonDb);
    assert.equal(
      invocationStore.claimNext("remote-e2e", "2026-07-15T00:00:01.000Z")?.invocationId,
      workspaceTurn.invocationId,
    );
    insertInvocationEvents(daemonDb, workspaceTurn.invocationId, 10_000);

    bridge.dropNextTerminalFor("turn.submit.request");
    const daemonTurnPromise = client.submit({
      sessionId: daemonSessionId,
      prompt: "Daemon round two",
      assignment: assignment(daemonSessionId, "Daemon round two"),
      idempotencyKey: createId("idem"),
    });
    const droppedCommand = await waitForCockpitCommand(cockpitDb, {
      kind: "turn.submit.request",
      sessionId: daemonSessionId,
      status: "accepted",
    });
    await waitFor(() =>
      Boolean(runtimeCommandReceipt(daemonDb, droppedCommand.commandId)?.terminal),
    );
    bridge.close(1006, "drop accepted command terminal before Cockpit ingest");
    bridge = connectRuntime(cockpitDb, context, bindingId);
    bridges.push(bridge);
    const daemonTurn = await daemonTurnPromise;

    const replayedReceipt = runtimeCommandReceipt(daemonDb, droppedCommand.commandId);
    assert.equal(replayedReceipt?.deliveryCount, 2);
    assert.equal(
      invocationStore.listPage({ sessionId: daemonSessionId, limit: 100 }).invocations.length,
      1,
    );
    assert.notEqual(daemonTurn.invocationId, workspaceTurn.invocationId);

    const cancel = await client.cancel({
      sessionId: workspaceSessionId,
      invocationId: workspaceTurn.invocationId,
      reason: "Cancelled remotely after reconnect.",
    });
    assert.deepEqual(cancel, {
      invocationId: workspaceTurn.invocationId,
      status: "running",
      cancelRequested: true,
    });
    invocationStore.complete(workspaceTurn.invocationId, {
      status: "cancelled",
      cancelReason: "Cancelled remotely after reconnect.",
      now: "2026-07-15T00:00:05.000Z",
    });
    await registry.recordTurnSettled(workspaceSessionId, new Date("2026-07-15T00:00:05.000Z"));
    const terminalStatus = await client.status({
      sessionId: workspaceSessionId,
      invocationId: workspaceTurn.invocationId,
    });
    assert.equal(terminalStatus.status, "cancelled");
    assert.equal(terminalStatus.eventCursor, 10_000);

    const stream = await client.stream({
      sessionId: workspaceSessionId,
      invocationId: workspaceTurn.invocationId,
      after: 9_998,
      limit: 100,
    });
    const replayedStream = await client.stream({
      sessionId: workspaceSessionId,
      invocationId: workspaceTurn.invocationId,
      after: 9_998,
      limit: 100,
    });
    assert.deepEqual(
      stream.events.map(({ sequence }) => sequence),
      [9_999, 10_000],
    );
    assert.equal(stream.nextCursor, 10_000);
    assert.deepEqual(replayedStream, stream);
    const projectedCursorCount = cockpitDb
      .prepare(
        `SELECT COUNT(*) AS count FROM runtime_invocation_event_projections
         WHERE runtime_invocation_id = ? AND sequence = 10000`,
      )
      .get(workspaceTurn.invocationId) as { count: number };
    assert.equal(Number(projectedCursorCount.count), 1);

    const queuedDaemonCancellation = await client.cancel({
      sessionId: daemonSessionId,
      invocationId: daemonTurn.invocationId,
      reason: "Settle daemon test turn.",
    });
    assert.equal(queuedDaemonCancellation.status, "cancelled");

    const workspaceTranscript = join(root, "workspace-round.jsonl");
    const daemonTranscript = join(root, "daemon-round.jsonl");
    await Promise.all([
      writeTranscript(workspaceTranscript, workspaceSessionId, root, "Workspace round one"),
      writeTranscript(daemonTranscript, daemonSessionId, root, "Daemon round two"),
    ]);
    await Promise.all([
      registry.recordRun({ sessionId: workspaceSessionId, sessionPath: workspaceTranscript }),
      registry.recordRun({ sessionId: daemonSessionId, sessionPath: daemonTranscript }),
    ]);
    const [workspaceSnapshot, daemonSnapshot] = await Promise.all([
      client.snapshot(workspaceSessionId),
      client.snapshot(daemonSessionId),
    ]);
    assert.deepEqual(
      workspaceSnapshot.snapshot.messages.map(({ text }) => text),
      ["Workspace round one", "Workspace round one complete"],
    );
    assert.deepEqual(
      daemonSnapshot.snapshot.messages.map(({ text }) => text),
      ["Daemon round two", "Daemon round two complete"],
    );

    await client.archive(daemonSessionId);

    const terminalProjectionCount = cockpitDb
      .prepare(
        `SELECT COUNT(*) AS count FROM runtime_invocation_event_projections
         WHERE runtime_invocation_id = ? AND kind = 'invocation.cancelled'`,
      )
      .get(workspaceTurn.invocationId) as { count: number };
    const invocationRows = daemonDb
      .prepare(
        `SELECT session_id AS sessionId, COUNT(*) AS count
         FROM invocations
         WHERE session_id IN (?, ?)
         GROUP BY session_id
         ORDER BY session_id`,
      )
      .all(workspaceSessionId, daemonSessionId) as Array<{ sessionId: string; count: number }>;
    assert.deepEqual(
      invocationRows.map(({ count }) => Number(count)),
      [1, 1],
    );
    assert.equal(terminalProjectionCount.count, 1);
    assert.equal(existsSync(nonexistentSocket), false);
    const maxPayloadBytes = Math.max(...bridges.map(({ maxFrameBytes }) => maxFrameBytes));
    assert.ok(maxPayloadBytes < 1024 * 1024);
    assert.deepEqual(
      bridges.flatMap(({ errors }) => errors),
      [],
    );

    console.log(
      "SPARK_REMOTE_SESSION_CONTROL_TRANSCRIPT",
      JSON.stringify({
        transport: { page: "https", runtime: "wss" },
        conversationSurface: {
          path: "/sessions/[sessionId]",
          workspaceSessionCreated: true,
          daemonSessionCreated: true,
          listPaged: true,
          bindUnbindArchived: true,
          turnSubmitted: true,
          turnCancelled: true,
          terminalResultRecoveredAfterReconnect: true,
          transcriptSnapshotLoaded: true,
        },
        runtimeId,
        workspaceId: cockpitWorkspace.id,
        workspaceSessionId,
        daemonSessionId,
        workspaceInvocationId: workspaceTurn.invocationId,
        daemonInvocationId: daemonTurn.invocationId,
        reconnectDeliveryCount: replayedReceipt?.deliveryCount,
        cancelRequested: cancel.cancelRequested,
        cancellationStatus: terminalStatus.status,
        cursor: stream.nextCursor,
        projectedTerminalCount: terminalProjectionCount.count,
        daemonInvocationCounts: invocationRows,
        transcriptMessages:
          workspaceSnapshot.snapshot.messages.length + daemonSnapshot.snapshot.messages.length,
        pagedDaemonSessionCount: pagedDaemonSessions.length,
        maxPayloadBytes,
        daemonSocketUsed: existsSync(nonexistentSocket),
      }),
    );
    bridge.close();
  } finally {
    cockpitDb.close();
    daemonDb.close();
    await rm(root, { recursive: true, force: true });
  }
});

class RuntimeBridge extends EventEmitter implements RuntimeWebSocketConnection {
  readonly errors: Error[] = [];
  maxFrameBytes = 0;
  private droppedTerminalKind?: string;
  private closed = false;
  private readonly context: MessageContext;

  constructor(context: MessageContext) {
    super();
    this.context = context;
  }

  send(data: string): void {
    this.maxFrameBytes = Math.max(this.maxFrameBytes, Buffer.byteLength(data));
    const value = JSON.parse(data) as { type?: string };
    if (value.type === "server.command") {
      const command = serverCommandEnvelopeSchema.parse(value);
      void handleCommand(new DaemonToCockpitSocket(this, command), command, this.context).catch(
        (error: unknown) => this.errors.push(asError(error)),
      );
      return;
    }
    if (value.type === "server.ingest_ack") {
      void handleServerMessage(new NoopSocket(), data, this.context).catch((error: unknown) =>
        this.errors.push(asError(error)),
      );
    }
  }

  close(code = 1000, reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, Buffer.from(reason));
  }

  emitMessage(value: unknown): void {
    if (this.closed) return;
    const encoded = JSON.stringify(value);
    this.maxFrameBytes = Math.max(this.maxFrameBytes, Buffer.byteLength(encoded));
    queueMicrotask(() => {
      if (!this.closed) this.emit("message", Buffer.from(encoded));
    });
  }

  dropNextTerminalFor(kind: string): void {
    this.droppedTerminalKind = kind;
  }

  forwardFromDaemon(command: ServerCommandEnvelope, value: unknown): void {
    const type =
      value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
    if (type === "runtime.command.result" && this.droppedTerminalKind === command.payload.kind) {
      this.droppedTerminalKind = undefined;
      return;
    }
    this.emitMessage(value);
  }
}

class DaemonToCockpitSocket implements ServerSocket {
  private readonly bridge: RuntimeBridge;
  private readonly command: ServerCommandEnvelope;

  constructor(bridge: RuntimeBridge, command: ServerCommandEnvelope) {
    this.bridge = bridge;
    this.command = command;
  }

  send(data: string): void {
    this.bridge.forwardFromDaemon(this.command, JSON.parse(data) as unknown);
  }
}

class NoopSocket implements ServerSocket {
  send(): void {}
}

function connectRuntime(
  db: DatabaseSync,
  context: MessageContext,
  bindingId: string,
): RuntimeBridge {
  const bridge = new RuntimeBridge(context);
  attachRuntimeWebSocket(bridge, { db, runtimeId: context.runtimeId });
  bridge.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "runtime.hello",
        sentAt: now,
        payload: {
          runtimeId: context.runtimeId,
          runtimeVersion: "0.1.0-e2e",
          supportedFeatures: ["ws-control-v1", "command-routing-v1"],
          workspaceBindings: [
            {
              bindingId,
              localWorkspaceKey: "remote-session",
              localPath: context.paths.dataDir,
              displayName: "Remote session workspace",
              status: "available",
              capabilities: {},
              diagnostics: {},
            },
          ],
        },
      }),
    ),
  );
  return bridge;
}

function assignment(sessionId: string, prompt: string, workspaceId?: string): SparkAssignment {
  return {
    goal: prompt,
    title: prompt,
    target: { sessionId, ...(workspaceId ? { workspaceId } : {}) },
    constraints: [],
    evidence: [],
    source: { kind: "cockpit" },
  };
}

function insertInvocationEvents(db: DatabaseSync, invocationId: string, count: number): void {
  const insert = db.prepare(
    `INSERT INTO invocation_events
      (invocation_id, sequence, kind, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let sequence = 1; sequence <= count; sequence += 1) {
      insert.run(
        invocationId,
        sequence,
        sequence === count ? "invocation.cancelled" : "invocation.output",
        JSON.stringify({ sequence }),
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function writeTranscript(
  path: string,
  sessionId: string,
  cwd: string,
  prompt: string,
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const entries = [
    { type: "session", version: 3, id: sessionId, timestamp: now, cwd },
    {
      type: "message",
      id: `${sessionId}-user`,
      parentId: null,
      timestamp: "2026-07-15T00:00:01.000Z",
      message: { role: "user", content: prompt, timestamp: 1_783_987_201_000 },
    },
    {
      type: "message",
      id: `${sessionId}-assistant`,
      parentId: `${sessionId}-user`,
      timestamp: "2026-07-15T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${prompt} complete` }],
        timestamp: 1_783_987_202_000,
      },
    },
  ];
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

async function waitForCockpitCommand(
  db: DatabaseSync,
  input: { kind: string; sessionId: string; status: string },
): Promise<{ commandId: string }> {
  let row: { commandId: string } | undefined;
  await waitFor(() => {
    row = db
      .prepare(
        `SELECT id AS commandId FROM runtime_control_commands
         WHERE kind = ? AND session_id = ? AND status = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.kind, input.sessionId, input.status) as { commandId: string } | undefined;
    return Boolean(row);
  });
  return row!;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for remote session state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
