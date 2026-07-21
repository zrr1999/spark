import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import {
  createWorkspaceWithOwnerBinding,
  queueCommandForWorkspaceOwner,
  recordHumanRequestFromRuntime,
  recordHumanResponse,
  unbindWorkspaceOwner,
} from "./projection-services";
import { requireRuntimeControlCommand, submitRuntimeControlCommand } from "./runtime-control.ts";
import { hashSecret } from "./security.ts";
import { attachRuntimeWebSocket, authenticateRuntimeToken } from "./runtime-ws.ts";
import type { DatabaseSync } from "node:sqlite";
import type { RawData } from "ws";

class FakeRuntimeSocket extends EventEmitter {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | undefined;
  failNextType: string | undefined;

  send(data: string): void {
    const type = (JSON.parse(data) as { type?: unknown }).type;
    if (type === this.failNextType) {
      this.failNextType = undefined;
      throw new Error(`simulated ${String(type)} send failure`);
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }

  emitMessage(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)) as RawData);
  }
}

function setupRuntime() {
  const db = openMemoryDatabase();
  migrate(db);

  const now = new Date().toISOString();
  const runtimeId = createId("rt");
  const workspaceBindingId = createId("rtwb");
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
     VALUES (?, ?, ?, 'offline', ?, '{}', '{}', ?, ?)`,
  ).run(runtimeId, "install-test", "Test runtime", runtimeProtocolVersion, now, now);

  const ws = new FakeRuntimeSocket();
  attachRuntimeWebSocket(ws, { db, runtimeId, remoteAddress: "127.0.0.1" });

  ws.emitMessage({
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "runtime.hello",
    sentAt: now,
    payload: {
      runtimeId,
      runtimeVersion: "0.0.0-test",
      supportedFeatures: [
        "ws-control-v1",
        "multi-workspace-runtime-v1",
        "workspace-snapshot-v1",
        "command-routing-v1",
        "human-request-v1",
        "logs-v1",
        "artifact-ref-v1",
        "reconcile-v1",
      ],
      workspaceBindings: [
        {
          bindingId: workspaceBindingId,
          localWorkspaceKey: "local-default",
          localPath: "/Users/test/workspaces/local-default",
          displayName: "Local default",
          status: "available",
          capabilities: {},
          diagnostics: {},
        },
      ],
    },
  });

  const helloAck = ws.sent
    .map((message) => JSON.parse(message))
    .find((message) => message.type === "server.hello_ack");
  return {
    db,
    ws,
    now,
    runtimeId,
    runtimeSessionId: helloAck.payload.runtimeSessionId,
    workspaceBindingId,
  };
}

function createWorkspace(db: DatabaseSync, workspaceBindingId: string, now: string) {
  return createWorkspaceWithOwnerBinding(db, {
    slug: "local-default",
    name: "Local default",
    runtimeWorkspaceBindingId: workspaceBindingId,
    createdAt: now,
  });
}

describe("runtime WebSocket handling", () => {
  it("authenticates only unexpired runtime access tokens", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-05-25T00:00:00.000Z";
    const runtimeId = createId("rt");
    const accessToken = "spark_rt_access_00000000000000000000000000000000";
    const refreshToken = "spark_rt_refresh_000000000000000000000000000000";
    const expiredToken = "spark_rt_expired_000000000000000000000000000000";
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, ?, ?, 'offline', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, "install-test", "Test runtime", runtimeProtocolVersion, now, now);
    for (const token of [
      {
        id: "rttok_access",
        secret: accessToken,
        scopes: ["runtime:connect"],
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
      {
        id: "rttok_refresh",
        secret: refreshToken,
        scopes: ["runtime:refresh"],
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
      {
        id: "rttok_expired",
        secret: expiredToken,
        scopes: ["runtime:connect"],
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    ]) {
      db.prepare(
        `INSERT INTO runtime_tokens
          (id, runtime_id, token_hash, label, scopes_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        token.id,
        runtimeId,
        hashSecret(token.secret),
        token.id,
        JSON.stringify(token.scopes),
        now,
        token.expiresAt,
      );
    }

    expect(authenticateRuntimeToken(db, runtimeId, `Bearer ${accessToken}`)).toBe("rttok_access");
    expect(authenticateRuntimeToken(db, runtimeId, `Bearer ${refreshToken}`)).toBeNull();
    expect(authenticateRuntimeToken(db, runtimeId, `Bearer ${expiredToken}`)).toBeNull();
    db.close();
  });

  it("ingests daemon.event envelopes into typed Cockpit events", () => {
    const { db, ws, now, runtimeId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const messageId = createId("msg");

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId,
      type: "daemon.event",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      payload: {
        type: "daemon.view_event",
        source: "daemon",
        sessionId: "session-daemon",
        view: {
          type: "session.message",
          sessionId: "session-daemon",
          message: { id: "m1", role: "assistant", text: "hello from daemon" },
        },
      },
    });

    const ack = JSON.parse(ws.sent.at(-1) ?? "{}");
    expect(ack.type).toBe("server.ingest_ack");
    expect(ack.ackOf).toBe(messageId);

    const row = db
      .prepare(
        `SELECT kind,
                subject_kind AS subjectKind,
                subject_id AS subjectId,
                payload_json AS payloadJson
         FROM events
         WHERE workspace_id = ? AND kind = 'daemon.view_event'
         LIMIT 1`,
      )
      .get(workspace.id) as {
      kind: string;
      subjectKind: string;
      subjectId: string;
      payloadJson: string;
    };
    expect(row.kind).toBe("daemon.view_event");
    expect(row.subjectKind).toBe("view_model");
    expect(row.subjectId).toBe("session-daemon");
    expect(JSON.parse(row.payloadJson)).toMatchObject({
      type: "daemon.view_event",
      view: { type: "session.message", sessionId: "session-daemon" },
    });
    db.close();
  });

  it("rejects stale runtime routes after their Cockpit owner binding is ended", () => {
    const { db, ws, now, runtimeId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    unbindWorkspaceOwner(db, {
      workspaceId: workspace.id,
      expectedRuntimeWorkspaceBindingId: workspaceBindingId,
      endedAt: "2026-07-20T00:01:00.000Z",
    });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "daemon.event",
      sentAt: "2026-07-20T00:01:01.000Z",
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      payload: {
        type: "daemon.view_event",
        source: "daemon",
        sessionId: "session-stale",
        view: {
          type: "session.message",
          sessionId: "session-stale",
          message: { id: "m-stale", role: "assistant", text: "must not project" },
        },
      },
    });

    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "server.error",
      payload: { code: "workspace_owner_binding_mismatch" },
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE workspace_id = ? AND kind = 'daemon.view_event'",
        )
        .get(workspace.id),
    ).toEqual({ count: 0 });
    db.close();
  });

  it("ingests daemon-routable interaction request and response events", () => {
    const { db, ws, now, runtimeId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const requestId = "ask-flow-runtime-1";
    const requestMessageId = createId("msg");
    const responseMessageId = createId("msg");

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: requestMessageId,
      type: "daemon.event",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      payload: {
        type: "daemon.interaction.request",
        source: "daemon",
        sessionId: "session-daemon",
        request: {
          kind: "askFlow",
          requestId,
          title: "Choose next action",
          mode: "decision",
          questions: [{ id: "next", prompt: "What should Spark do next?", type: "single" }],
        },
      },
    });
    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: responseMessageId,
      type: "daemon.event",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      payload: {
        type: "daemon.interaction.response",
        source: "web",
        sessionId: "session-daemon",
        response: {
          kind: "askFlow",
          requestId,
          status: "answered",
          answers: { next: "continue" },
          nextAction: "resume",
        },
      },
    });

    const rows = db
      .prepare(
        `SELECT kind,
                subject_kind AS subjectKind,
                subject_id AS subjectId,
                payload_json AS payloadJson
         FROM events
         WHERE workspace_id = ? AND kind LIKE 'daemon.interaction.%'
         ORDER BY kind`,
      )
      .all(workspace.id) as Array<{
      kind: string;
      subjectKind: string;
      subjectId: string;
      payloadJson: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.kind, row.subjectKind, row.subjectId])).toEqual([
      ["daemon.interaction.request", "daemon_event", "session-daemon"],
      ["daemon.interaction.response", "daemon_event", "session-daemon"],
    ]);
    expect(JSON.parse(rows[0]!.payloadJson)).toMatchObject({
      type: "daemon.interaction.request",
      request: { kind: "askFlow", requestId, questions: [{ id: "next" }] },
    });
    expect(JSON.parse(rows[1]!.payloadJson)).toMatchObject({
      type: "daemon.interaction.response",
      response: { kind: "askFlow", requestId, status: "answered", answers: { next: "continue" } },
    });
    db.close();
  });

  it("accepts hello and heartbeat messages and updates connection state", () => {
    const { db, ws, now, runtimeId, runtimeSessionId, workspaceBindingId } = setupRuntime();

    const helloAck = ws.sent
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "server.hello_ack");
    const reconcileRequest = ws.sent
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "runtime.reconcile.request");
    expect(helloAck.type).toBe("server.hello_ack");
    expect(helloAck.payload.workspaceBindingAssignments).toEqual([
      { bindingId: workspaceBindingId, state: "unbound" },
    ]);
    expect(reconcileRequest.payload.scopes).toContain("workspace_bindings");

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeSessionId,
        sequence: 1,
        observedAt: now,
      },
    });

    const heartbeatAck = JSON.parse(ws.sent.at(-1) ?? "{}");
    expect(heartbeatAck.type).toBe("server.heartbeat_ack");
    expect(heartbeatAck.payload.sequence).toBe(1);

    const runtime = db
      .prepare("SELECT status FROM runtime_connections WHERE id = ?")
      .get(runtimeId) as {
      status: string;
    };
    expect(runtime.status).toBe("online");

    const binding = db
      .prepare(
        "SELECT display_name, local_path AS localPath FROM runtime_workspace_bindings WHERE id = ?",
      )
      .get(workspaceBindingId) as {
      display_name: string;
      localPath: string | null;
    };
    expect(binding.display_name).toBe("local-default");
    expect(binding.localPath).toBe("/Users/test/workspaces/local-default");
    db.close();
  });

  it("preserves workspace binding identity when a Spark daemon reconnects with the same local key", () => {
    const { db, ws, now, runtimeId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    ws.close(1000, "reconnect");

    const reconnectSocket = new FakeRuntimeSocket();
    attachRuntimeWebSocket(reconnectSocket, { db, runtimeId, remoteAddress: "127.0.0.1" });
    reconnectSocket.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.hello",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeVersion: "0.0.0-test",
        supportedFeatures: ["ws-control-v1", "multi-workspace-runtime-v1", "reconcile-v1"],
        workspaceBindings: [
          {
            bindingId: createId("rtwb"),
            localWorkspaceKey: "local-default",
            displayName: "Local default after reconnect",
            status: "available",
            capabilities: {},
            diagnostics: {},
          },
        ],
      },
    });

    const bindingRows = db
      .prepare(
        `SELECT id, display_name AS displayName, local_path AS localPath
         FROM runtime_workspace_bindings
         WHERE runtime_id = ? AND local_workspace_key = ?`,
      )
      .all(runtimeId, "local-default") as Array<{
      id: string;
      displayName: string;
      localPath: string | null;
    }>;
    const ownerBinding = db
      .prepare(
        `SELECT runtime_workspace_binding_id AS runtimeWorkspaceBindingId
         FROM workspace_owner_bindings
         WHERE workspace_id = ?`,
      )
      .get(workspace.id) as { runtimeWorkspaceBindingId: string };

    expect(bindingRows).toEqual([
      {
        id: workspaceBindingId,
        displayName: "local-default",
        localPath: "/Users/test/workspaces/local-default",
      },
    ]);
    expect(ownerBinding.runtimeWorkspaceBindingId).toBe(workspaceBindingId);
    db.close();
  });

  it("flushes queued commands and records command acknowledgements", () => {
    const { db, ws, now, runtimeId, runtimeSessionId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const command = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      idempotencyKey: createId("idem"),
      payload: { kind: "task.start.request", title: "Start task" },
      createdAt: now,
    });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeSessionId,
        sequence: 2,
        observedAt: now,
      },
    });

    const routedCommand = JSON.parse(ws.sent.at(-1) ?? "{}");
    expect(routedCommand.type).toBe("server.command");
    expect(routedCommand.commandId).toBe(command.id);

    const invocationId = createId("inv");
    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.command.ack",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      commandId: command.id,
      invocationId,
      ackOf: routedCommand.messageId,
      payload: { accepted: true, invocationId },
    });

    const delivery = db
      .prepare("SELECT status FROM command_deliveries WHERE command_id = ?")
      .get(command.id) as { status: string };
    const invocation = db
      .prepare("SELECT status FROM mirrored_invocations WHERE runtime_invocation_id = ?")
      .get(invocationId) as { status: string };

    expect(JSON.parse(ws.sent.at(-1) ?? "{}").type).toBe("server.ingest_ack");
    expect(delivery.status).toBe("acked");
    expect(invocation.status).toBe("queued");
    db.close();
  });

  it("ingests one bounded daemon command result and rejects invalid result routes", () => {
    const { db, ws, now, runtimeId, runtimeSessionId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const command = submitRuntimeControlCommand(db, {
      runtimeId,
      idempotencyKey: createId("idem"),
      payload: { kind: "daemon.status.request", scope: "daemon" },
      createdAt: now,
    });
    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: { runtimeId, runtimeSessionId, sequence: 2, observedAt: now },
    });
    const routedCommand = ws.sent
      .map((message) => JSON.parse(message))
      .findLast((message) => message.type === "server.command");
    expect(routedCommand).toMatchObject({
      runtimeId,
      commandId: command.commandId,
      payload: { kind: "daemon.status.request", scope: "daemon" },
    });
    expect(routedCommand).not.toHaveProperty("workspaceBindingId");

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.command.ack",
      sentAt: now,
      runtimeId,
      commandId: command.commandId,
      ackOf: routedCommand.messageId,
      payload: { accepted: true },
    });
    const resultMessageId = createId("msg");
    const result = {
      protocolVersion: runtimeProtocolVersion,
      messageId: resultMessageId,
      type: "runtime.command.result",
      sentAt: now,
      runtimeId,
      commandId: command.commandId,
      ackOf: routedCommand.messageId,
      payload: {
        status: "succeeded",
        result: { invocations: { running: 0 } },
        projection: { kind: "daemon.status", data: { online: true } },
        completedAt: now,
      },
    };
    ws.emitMessage(result);
    ws.emitMessage(result);

    expect(requireRuntimeControlCommand(db, command.commandId)).toMatchObject({
      status: "succeeded",
      attemptCount: 1,
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM events
           WHERE kind = 'runtime.control.result' AND subject_id = ?`,
        )
        .get(command.commandId),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          `SELECT replay_count AS replayCount FROM runtime_message_receipts
           WHERE runtime_id = ? AND message_id = ? AND message_type = 'runtime.command.result'`,
        )
        .get(runtimeId, resultMessageId),
    ).toEqual({ replayCount: 1 });

    const invalid = submitRuntimeControlCommand(db, {
      runtimeId,
      payload: { kind: "daemon.status.request", scope: "daemon" },
      createdAt: now,
    });
    const secretMarker = "RUNTIME_CONTROL_SECRET_MARKER_MUST_NOT_PERSIST";
    for (const payload of [
      {
        status: "succeeded",
        result: { content: "x".repeat(65_536) },
        completedAt: now,
      },
      {
        status: "succeeded",
        result: { accessToken: secretMarker },
        completedAt: now,
      },
    ]) {
      ws.emitMessage({
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "runtime.command.result",
        sentAt: now,
        runtimeId,
        commandId: invalid.commandId,
        payload,
      });
    }
    ws.emitMessage({
      ...result,
      messageId: createId("msg"),
      commandId: invalid.commandId,
      workspaceBindingId,
      workspaceId: workspace.id,
    });
    expect(requireRuntimeControlCommand(db, invalid.commandId).status).toBe("queued");
    expect(
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM runtime_control_commands
              WHERE result_json LIKE ?) AS commandMatches,
             (SELECT COUNT(*) FROM events
              WHERE payload_json LIKE ?) AS eventMatches`,
        )
        .get(`%${secretMarker}%`, `%${secretMarker}%`),
    ).toEqual({ commandMatches: 0, eventMatches: 0 });
    expect(JSON.stringify(ws.sent)).not.toContain(secretMarker);
    expect(
      ws.sent
        .map((message) => JSON.parse(message))
        .filter((message) => message.type === "server.error")
        .map((message) => message.payload.code),
    ).toEqual(
      expect.arrayContaining([
        "unsupported_runtime_message",
        "unsupported_runtime_message",
        "command_route_mismatch",
      ]),
    );
    db.close();
  });

  it("keeps a command pending when the WebSocket write fails", () => {
    const { db, ws, now, runtimeId, runtimeSessionId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const command = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      idempotencyKey: createId("idem"),
      payload: { kind: "task.start.request", title: "Retry task" },
      createdAt: now,
    });
    ws.failNextType = "server.command";

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeSessionId,
        sequence: 2,
        observedAt: now,
      },
    });

    expect(
      db
        .prepare(
          `SELECT cd.status AS deliveryStatus,
                  cd.attempt_count AS attemptCount,
                  c.status AS commandStatus
           FROM command_deliveries cd
           JOIN commands c ON c.id = cd.command_id
           WHERE c.id = ?`,
        )
        .get(command.id),
    ).toEqual({ deliveryStatus: "pending", attemptCount: 1, commandStatus: "queued" });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeSessionId,
        sequence: 3,
        observedAt: now,
      },
    });

    expect(
      db
        .prepare(
          `SELECT cd.status AS deliveryStatus,
                  cd.attempt_count AS attemptCount,
                  c.status AS commandStatus
           FROM command_deliveries cd
           JOIN commands c ON c.id = cd.command_id
           WHERE c.id = ?`,
        )
        .get(command.id),
    ).toEqual({ deliveryStatus: "sent", attemptCount: 2, commandStatus: "delivered" });
    db.close();
  });

  it("recovers an unacknowledged command when the runtime reconnects", () => {
    const { db, ws, now, runtimeId, runtimeSessionId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const command = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      idempotencyKey: createId("idem"),
      payload: { kind: "task.start.request", title: "Reconnect task" },
      createdAt: now,
    });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeSessionId,
        sequence: 2,
        observedAt: now,
      },
    });
    const firstDelivery = ws.sent
      .map((message) => JSON.parse(message))
      .findLast((message) => message.type === "server.command");
    expect(firstDelivery.commandId).toBe(command.id);
    ws.close(1006, "transport lost before ack");

    const reconnectSocket = new FakeRuntimeSocket();
    attachRuntimeWebSocket(reconnectSocket, { db, runtimeId, remoteAddress: "127.0.0.1" });
    reconnectSocket.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.hello",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeVersion: "0.0.0-test",
        supportedFeatures: [
          "ws-control-v1",
          "multi-workspace-runtime-v1",
          "command-routing-v1",
          "reconcile-v1",
        ],
        workspaceBindings: [
          {
            bindingId: workspaceBindingId,
            localWorkspaceKey: "local-default",
            displayName: "Local default",
            status: "available",
            capabilities: {},
            diagnostics: {},
          },
        ],
      },
    });

    const redelivery = reconnectSocket.sent
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "server.command");
    expect(redelivery).toMatchObject({ commandId: command.id });
    expect(redelivery.messageId).not.toBe(firstDelivery.messageId);
    expect(
      db
        .prepare(
          `SELECT status, attempt_count AS attemptCount
           FROM command_deliveries
           WHERE command_id = ?`,
        )
        .get(command.id),
    ).toEqual({ status: "sent", attemptCount: 2 });

    const invocationId = createId("inv");
    reconnectSocket.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.command.ack",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      commandId: command.id,
      invocationId,
      ackOf: redelivery.messageId,
      payload: { accepted: true, invocationId },
    });
    expect(
      db.prepare("SELECT status FROM command_deliveries WHERE command_id = ?").get(command.id),
    ).toEqual({ status: "acked" });
    db.close();
  });

  it("routes daemon control acknowledgements and results without workspace context", () => {
    const { db, ws, now, runtimeId, runtimeSessionId, workspaceBindingId } = setupRuntime();
    const command = submitRuntimeControlCommand(db, {
      runtimeId,
      idempotencyKey: createId("idem"),
      payload: { kind: "daemon.status.request", scope: "daemon" },
      createdAt: now,
    });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeSessionId,
        sequence: 2,
        observedAt: now,
      },
    });

    const delivery = ws.sent
      .map((message) => JSON.parse(message))
      .findLast(
        (message) => message.type === "server.command" && message.commandId === command.commandId,
      );
    expect(delivery).toMatchObject({
      runtimeId,
      commandId: command.commandId,
      payload: { kind: "daemon.status.request", scope: "daemon" },
    });
    expect(delivery).not.toHaveProperty("workspaceBindingId");
    expect(delivery).not.toHaveProperty("workspaceId");
    expect(requireRuntimeControlCommand(db, command.commandId)).toMatchObject({
      status: "delivered",
      attemptCount: 1,
    });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.command.ack",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      commandId: command.commandId,
      ackOf: delivery.messageId,
      payload: { accepted: true },
    });
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "server.error",
      payload: { code: "command_route_mismatch" },
    });
    expect(requireRuntimeControlCommand(db, command.commandId).status).toBe("delivered");

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.command.ack",
      sentAt: now,
      runtimeId,
      commandId: command.commandId,
      ackOf: delivery.messageId,
      payload: { accepted: true },
    });
    expect(requireRuntimeControlCommand(db, command.commandId).status).toBe("accepted");
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "server.ingest_ack",
      payload: { receivedType: "runtime.command.ack" },
    });

    const resultMessageId = createId("msg");
    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: resultMessageId,
      type: "runtime.command.result",
      sentAt: now,
      runtimeId,
      commandId: command.commandId,
      ackOf: delivery.messageId,
      payload: {
        status: "succeeded",
        result: { activeInvocationCount: 0 },
        projection: { kind: "daemon.status", data: { online: true } },
        completedAt: now,
      },
    });
    expect(requireRuntimeControlCommand(db, command.commandId)).toMatchObject({
      status: "succeeded",
      result: {
        status: "succeeded",
        projection: { kind: "daemon.status", data: { online: true } },
      },
    });
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "server.ingest_ack",
      ackOf: resultMessageId,
      payload: { receivedType: "runtime.command.result" },
    });
    db.close();
  });

  it("routes workspace control responses through the persisted workspace owner", () => {
    const { db, ws, now, runtimeId, runtimeSessionId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const completedCommand = submitRuntimeControlCommand(db, {
      runtimeId,
      workspaceId: workspace.id,
      payload: { kind: "workspace.snapshot.request", scope: "workspace" },
      createdAt: now,
    });
    const rejectedCommand = submitRuntimeControlCommand(db, {
      runtimeId,
      workspaceId: workspace.id,
      payload: { kind: "diagnostics.request", scope: "workspace" },
      createdAt: now,
    });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeSessionId,
        sequence: 2,
        observedAt: now,
      },
    });
    const completedDelivery = ws.sent
      .map((message) => JSON.parse(message))
      .findLast(
        (message) =>
          message.type === "server.command" && message.commandId === completedCommand.commandId,
      );
    const rejectedDelivery = ws.sent
      .map((message) => JSON.parse(message))
      .findLast(
        (message) =>
          message.type === "server.command" && message.commandId === rejectedCommand.commandId,
      );
    expect(completedDelivery).toMatchObject({
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      commandId: completedCommand.commandId,
      payload: { kind: "workspace.snapshot.request", scope: "workspace" },
    });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.command.ack",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      commandId: completedCommand.commandId,
      ackOf: completedDelivery.messageId,
      payload: { accepted: true },
    });
    const resultMessageId = createId("msg");
    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: resultMessageId,
      type: "runtime.command.result",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      commandId: completedCommand.commandId,
      ackOf: completedDelivery.messageId,
      payload: {
        status: "succeeded",
        result: { unresolvedInboxCount: 0 },
        projection: {
          kind: "workspace.snapshot",
          data: { workspaceId: workspace.id, unresolvedInboxCount: 0 },
        },
        completedAt: now,
      },
    });
    expect(requireRuntimeControlCommand(db, completedCommand.commandId)).toMatchObject({
      status: "succeeded",
      workspaceId: workspace.id,
      runtimeWorkspaceBindingId: workspaceBindingId,
    });
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "server.ingest_ack",
      ackOf: resultMessageId,
      payload: { receivedType: "runtime.command.result" },
    });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.command.reject",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      commandId: rejectedCommand.commandId,
      ackOf: rejectedDelivery.messageId,
      payload: {
        reasonCode: "WORKSPACE_BUSY",
        message: "Workspace executor is busy.",
        retryable: true,
      },
    });
    expect(requireRuntimeControlCommand(db, rejectedCommand.commandId)).toMatchObject({
      status: "rejected",
      workspaceId: workspace.id,
      runtimeWorkspaceBindingId: workspaceBindingId,
    });
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "server.ingest_ack",
      payload: { receivedType: "runtime.command.reject" },
    });
    db.close();
  });

  it("keeps failed runtime control writes queued and redelivers unacknowledged writes", () => {
    const { db, ws, now, runtimeId, runtimeSessionId, workspaceBindingId } = setupRuntime();
    const command = submitRuntimeControlCommand(db, {
      runtimeId,
      idempotencyKey: createId("idem"),
      payload: { kind: "daemon.status.request", scope: "daemon" },
      createdAt: now,
    });
    ws.failNextType = "server.command";

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeSessionId,
        sequence: 2,
        observedAt: now,
      },
    });
    expect(requireRuntimeControlCommand(db, command.commandId)).toMatchObject({
      status: "queued",
      attemptCount: 1,
    });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeSessionId,
        sequence: 3,
        observedAt: now,
      },
    });
    const firstDelivery = ws.sent
      .map((message) => JSON.parse(message))
      .findLast(
        (message) => message.type === "server.command" && message.commandId === command.commandId,
      );
    expect(requireRuntimeControlCommand(db, command.commandId)).toMatchObject({
      status: "delivered",
      attemptCount: 2,
    });
    ws.close(1006, "transport lost before runtime control ack");

    const reconnectSocket = new FakeRuntimeSocket();
    attachRuntimeWebSocket(reconnectSocket, { db, runtimeId, remoteAddress: "127.0.0.1" });
    reconnectSocket.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.hello",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeVersion: "0.0.0-test",
        supportedFeatures: ["ws-control-v1", "multi-workspace-runtime-v1"],
        workspaceBindings: [
          {
            bindingId: workspaceBindingId,
            localWorkspaceKey: "local-default",
            displayName: "Local default",
            status: "available",
            capabilities: {},
            diagnostics: {},
          },
        ],
      },
    });

    const redelivery = reconnectSocket.sent
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "server.command");
    expect(redelivery).toMatchObject({ commandId: command.commandId });
    expect(redelivery.messageId).not.toBe(firstDelivery.messageId);
    expect(requireRuntimeControlCommand(db, command.commandId)).toMatchObject({
      status: "delivered",
      attemptCount: 3,
    });
    db.close();
  });

  it("does not flush queued commands for unavailable workspace bindings", () => {
    const { db, ws, now, runtimeId, runtimeSessionId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const command = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      idempotencyKey: createId("idem"),
      payload: { kind: "task.start.request", title: "Start task" },
      createdAt: now,
    });
    db.prepare(
      `UPDATE runtime_workspace_bindings
       SET status = 'unavailable', diagnostics_json = ?
       WHERE id = ?`,
    ).run(JSON.stringify({ userDetached: true }), workspaceBindingId);

    const sentBeforeHeartbeat = ws.sent.length;
    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeSessionId,
        sequence: 2,
        observedAt: now,
      },
    });

    expect(
      ws.sent
        .slice(sentBeforeHeartbeat)
        .map((message) => JSON.parse(message))
        .some((message) => message.type === "server.command"),
    ).toBe(false);
    const delivery = db
      .prepare("SELECT status FROM command_deliveries WHERE command_id = ?")
      .get(command.id) as { status: string };
    expect(delivery.status).toBe("pending");
    db.close();
  });

  it("flushes human responses with auditable delivery attempts until runtime ack", () => {
    const { db, ws, now, runtimeId, runtimeSessionId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const request = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId: workspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId: "runtime-ask-1",
      payload: {
        kind: "ask_user",
        title: "Choose scope",
        prompt: "Which scope?",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: now,
    });
    const response = recordHumanResponse(db, {
      humanRequestId: request.humanRequestId,
      payload: {
        status: "answered",
        answers: { response: "Ship the MVP slice." },
        responseArtifactRefs: [],
      },
      createdAt: now,
    });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeSessionId,
        sequence: 3,
        observedAt: now,
      },
    });

    const delivered = JSON.parse(ws.sent.at(-1) ?? "{}");
    expect(delivered.type).toBe("human.response.deliver");
    expect(delivered.humanRequestId).toBe(request.humanRequestId);
    expect(delivered.humanResponseId).toBe(response.humanResponseId);

    const delivery = db
      .prepare(
        `SELECT status, delivery_attempt_count AS deliveryAttemptCount, last_delivery_at AS lastDeliveryAt
         FROM human_responses
         WHERE id = ?`,
      )
      .get(response.humanResponseId) as {
      status: string;
      deliveryAttemptCount: number;
      lastDeliveryAt: string | null;
    };
    const deliveryEvent = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM events
         WHERE kind = 'human.response.delivery_attempted' AND subject_id = ?`,
      )
      .get(response.humanResponseId) as { count: number };

    expect(delivery.status).toBe("delivering");
    expect(delivery.deliveryAttemptCount).toBe(1);
    expect(delivery.lastDeliveryAt).not.toBeNull();
    expect(deliveryEvent.count).toBe(1);

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "human.response.ack",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      humanRequestId: request.humanRequestId,
      humanResponseId: response.humanResponseId,
      ackOf: delivered.messageId,
      payload: { returnedToTool: true },
    });

    const acked = db
      .prepare("SELECT status, acked_at AS ackedAt FROM human_responses WHERE id = ?")
      .get(response.humanResponseId) as { status: string; ackedAt: string | null };
    expect(acked.status).toBe("acked");
    expect(acked.ackedAt).not.toBeNull();
    db.close();
  });

  it("ingests channel responses as accepted facts and deduplicates response-id replays", () => {
    const { db, ws, now, runtimeId, runtimeSessionId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const request = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId: workspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId: "runtime-channel-ask-1",
      payload: {
        kind: "ask_user",
        title: "Choose scope",
        prompt: "Which scope?",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: now,
    });
    const humanResponseId = createId("hres");
    const firstMessageId = createId("msg");
    const channelResponse = {
      protocolVersion: runtimeProtocolVersion,
      messageId: firstMessageId,
      type: "human.response.recorded",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      humanRequestId: request.humanRequestId,
      humanResponseId,
      payload: {
        source: "channel",
        status: "answered",
        answers: { scope: "mvp" },
        responseArtifactRefs: [],
      },
    };

    ws.emitMessage(channelResponse);

    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "server.ingest_ack",
      ackOf: firstMessageId,
      payload: { accepted: true, receivedType: "human.response.recorded" },
    });
    const projection = db
      .prepare(
        `SELECT hr.status AS requestStatus,
                ii.status AS inboxStatus,
                ii.resolved_as AS resolvedAs,
                hres.status AS responseStatus,
                hres.delivery_attempt_count AS deliveryAttemptCount,
                hres.acked_at AS ackedAt,
                hres.answer_json AS answerJson
         FROM human_requests hr
         JOIN inbox_items ii ON ii.human_request_id = hr.id
         JOIN human_responses hres ON hres.human_request_id = hr.id
         WHERE hres.id = ?`,
      )
      .get(humanResponseId) as {
      requestStatus: string;
      inboxStatus: string;
      resolvedAs: string | null;
      responseStatus: string;
      deliveryAttemptCount: number;
      ackedAt: string | null;
      answerJson: string;
    };
    expect(projection).toMatchObject({
      requestStatus: "answered",
      inboxStatus: "resolved",
      resolvedAs: "answered",
      responseStatus: "acked",
      deliveryAttemptCount: 0,
      ackedAt: now,
    });
    expect(JSON.parse(projection.answerJson)).toEqual(channelResponse.payload);

    const replayMessageId = createId("msg");
    ws.emitMessage({ ...channelResponse, messageId: replayMessageId });
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "server.ingest_ack",
      ackOf: replayMessageId,
    });

    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM human_responses WHERE id = ?) AS responses,
                (SELECT COUNT(*) FROM events WHERE kind = 'human.response.recorded' AND subject_id = ?) AS events,
                (SELECT COUNT(*) FROM runtime_message_receipts WHERE message_type = 'human.response.recorded') AS receipts`,
      )
      .get(humanResponseId, humanResponseId) as {
      responses: number;
      events: number;
      receipts: number;
    };
    expect(counts).toEqual({ responses: 1, events: 1, receipts: 2 });

    const sentBeforeHeartbeat = ws.sent.length;
    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.heartbeat",
      sentAt: now,
      payload: {
        runtimeId,
        runtimeSessionId,
        sequence: 4,
        observedAt: now,
      },
    });
    expect(
      ws.sent
        .slice(sentBeforeHeartbeat)
        .map((message) => JSON.parse(message))
        .some((message) => message.type === "human.response.deliver"),
    ).toBe(false);
    db.close();
  });

  it("rejects channel response routes that do not match the binding, workspace, request, or response", () => {
    const { db, ws, now, runtimeId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const otherBindingId = createId("rtwb");
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'other-local', 'Other local', 'available', '{}', '{}', ?, ?)`,
    ).run(otherBindingId, runtimeId, now, now);
    const otherWorkspace = createWorkspaceWithOwnerBinding(db, {
      slug: "other-local",
      name: "Other local",
      runtimeWorkspaceBindingId: otherBindingId,
      createdAt: now,
    });
    const request = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId: workspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId: "runtime-route-ask-1",
      payload: {
        kind: "ask_user",
        title: "Choose scope",
        prompt: "Which scope?",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: now,
    });
    const otherRequest = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId: workspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId: "runtime-route-ask-2",
      payload: {
        kind: "ask_user",
        title: "Choose another scope",
        prompt: "Which other scope?",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: now,
    });
    const reusedResponseId = createId("hres");
    recordHumanResponse(db, {
      humanRequestId: otherRequest.humanRequestId,
      humanResponseId: reusedResponseId,
      payload: { status: "answered", answers: { scope: "other" }, responseArtifactRefs: [] },
      createdAt: now,
    });

    const baseEnvelope = {
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "human.response.recorded",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      humanRequestId: request.humanRequestId,
      humanResponseId: createId("hres"),
      payload: {
        source: "channel",
        status: "answered",
        answers: { scope: "mvp" },
        responseArtifactRefs: [],
      },
    };
    const invalidRoutes = [
      {
        envelope: {
          ...baseEnvelope,
          messageId: createId("msg"),
          workspaceBindingId: otherBindingId,
        },
        code: "workspace_owner_binding_mismatch",
      },
      {
        envelope: { ...baseEnvelope, messageId: createId("msg"), workspaceId: otherWorkspace.id },
        code: "workspace_owner_binding_mismatch",
      },
      {
        envelope: { ...baseEnvelope, messageId: createId("msg"), humanRequestId: createId("hreq") },
        code: "unknown_human_request",
      },
      {
        envelope: {
          ...baseEnvelope,
          messageId: createId("msg"),
          humanResponseId: reusedResponseId,
        },
        code: "human_response_route_mismatch",
      },
    ];

    for (const testCase of invalidRoutes) {
      ws.emitMessage(testCase.envelope);
      expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
        type: "server.error",
        payload: { code: testCase.code },
      });
    }

    const receiptCount = db
      .prepare(
        "SELECT COUNT(*) AS count FROM runtime_message_receipts WHERE message_type = 'human.response.recorded'",
      )
      .get() as { count: number };
    expect(receiptCount.count).toBe(0);
    db.close();
  });

  it("ingests human, task graph, invocation, log, artifact, and workspace projection messages", () => {
    const { db, ws, now, runtimeId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const projectId = createId("proj");
    db.prepare(
      `INSERT INTO projects
        (id, workspace_id, slug, name, status, metadata_json, created_at, updated_at)
       VALUES (?, ?, 'mvp', 'MVP', 'running', '{}', ?, ?)`,
    ).run(projectId, workspace.id, now, now);

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "workspace.snapshot",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      payload: {
        displayName: "Local default renamed",
        status: "available",
        projects: [{ projectId, title: "MVP", status: "running" }],
        unresolvedInboxCount: 1,
        activeInvocationCount: 1,
        latestArtifactIds: [],
      },
    });

    const humanRequestId = createId("hreq");
    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "human.request.created",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      projectId,
      humanRequestId,
      payload: {
        kind: "ask_user",
        toolCallId: "tool-call-1",
        title: "Choose scope",
        prompt: "Which scope?",
        questions: [
          {
            id: "scope",
            type: "single",
            prompt: "Scope?",
            required: true,
            options: [{ value: "mvp", label: "MVP" }],
          },
        ],
        contextArtifactRefs: [],
      },
    });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "task_graph.snapshot",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      projectId,
      payload: {
        runtimeSnapshotId: "snap-1",
        snapshotVersion: 1,
        clusters: [{ runtimeClusterId: "cluster-main", title: "Main", status: "running" }],
        tasks: [{ runtimeTaskId: "task-a", title: "A", status: "running" }],
        dependencies: [],
      },
    });

    const invocationId = createId("inv");
    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "invocation.updated",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      projectId,
      invocationId,
      payload: {
        runtimeInvocationId: invocationId,
        taskRuntimeId: "task-a",
        agentName: "pi",
        status: "running",
        startedAt: now,
      },
    });

    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "invocation.log_chunk",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      projectId,
      invocationId,
      payload: {
        runtimeInvocationId: invocationId,
        stream: "stdout",
        sequence: 1,
        content: "hello\n",
      },
    });

    const artifactId = createId("art");
    ws.emitMessage({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "artifact.projected",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      projectId,
      invocationId,
      payload: {
        artifactId,
        scope: "project",
        kind: "report",
        title: "MVP report",
        format: "markdown",
        source: "runtime",
        contentRef: { runtimePathRef: "artifact://local/mvp.md" },
        provenance: { runtimeInvocationId: invocationId },
        links: [{ targetKind: "task", targetId: "task-a", relation: "output" }],
      },
    });

    const binding = db
      .prepare(
        "SELECT display_name AS displayName, last_snapshot_at AS lastSnapshotAt FROM runtime_workspace_bindings WHERE id = ?",
      )
      .get(workspaceBindingId) as { displayName: string; lastSnapshotAt: string | null };
    const inboxCount = db.prepare("SELECT COUNT(*) AS count FROM inbox_items").get() as {
      count: number;
    };
    const taskCount = db.prepare("SELECT COUNT(*) AS count FROM task_graph_tasks").get() as {
      count: number;
    };
    const logCount = db.prepare("SELECT COUNT(*) AS count FROM invocation_log_chunks").get() as {
      count: number;
    };
    const artifact = db.prepare("SELECT title FROM artifacts WHERE id = ?").get(artifactId) as {
      title: string;
    };

    expect(binding.displayName).toBe("local-default");
    expect(binding.lastSnapshotAt).not.toBeNull();
    expect(inboxCount.count).toBe(1);
    expect(taskCount.count).toBe(1);
    expect(logCount.count).toBe(1);
    expect(artifact.title).toBe("MVP report");
    expect(JSON.parse(ws.sent.at(-1) ?? "{}").type).toBe("server.ingest_ack");
    db.close();
  });

  it("deduplicates replayed projection messages across reconnects by runtime message id", () => {
    const { db, now, runtimeId, workspaceBindingId } = setupRuntime();
    const workspace = createWorkspace(db, workspaceBindingId, now);
    const messageId = createId("msg");
    const projection = {
      protocolVersion: runtimeProtocolVersion,
      messageId,
      type: "task_graph.snapshot",
      sentAt: now,
      runtimeId,
      workspaceBindingId,
      workspaceId: workspace.id,
      payload: {
        runtimeSnapshotId: "snap-replayed",
        snapshotVersion: 1,
        clusters: [{ runtimeClusterId: "cluster-main", title: "Main", status: "running" }],
        tasks: [{ runtimeTaskId: "task-a", title: "A", status: "running" }],
        dependencies: [],
      },
    };

    const firstSocket = new FakeRuntimeSocket();
    attachRuntimeWebSocket(firstSocket, { db, runtimeId, remoteAddress: "127.0.0.1" });
    firstSocket.emitMessage(projection);

    const reconnectedSocket = new FakeRuntimeSocket();
    attachRuntimeWebSocket(reconnectedSocket, { db, runtimeId, remoteAddress: "127.0.0.1" });
    reconnectedSocket.emitMessage(projection);

    const snapshotCount = db
      .prepare("SELECT COUNT(*) AS count FROM task_graph_snapshots")
      .get() as {
      count: number;
    };
    const taskCount = db.prepare("SELECT COUNT(*) AS count FROM task_graph_tasks").get() as {
      count: number;
    };
    const receipt = db
      .prepare(
        `SELECT replay_count AS replayCount
         FROM runtime_message_receipts
         WHERE runtime_id = ? AND message_id = ? AND message_type = 'task_graph.snapshot'`,
      )
      .get(runtimeId, messageId) as { replayCount: number };

    expect(snapshotCount.count).toBe(1);
    expect(taskCount.count).toBe(1);
    expect(receipt.replayCount).toBe(1);
    expect(JSON.parse(reconnectedSocket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "server.ingest_ack",
      ackOf: messageId,
    });
    db.close();
  });
});
