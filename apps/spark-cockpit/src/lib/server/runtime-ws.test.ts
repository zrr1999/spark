import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/navia-db";
import {
  createWorkspaceWithOwnerBinding,
  queueCommandForWorkspaceOwner,
  recordHumanRequestFromRuntime,
  recordHumanResponse,
} from "./projection-services";
import { hashSecret } from "./auth";
import { attachRuntimeWebSocket, authenticateRuntimeToken } from "./runtime-ws";
import type { DatabaseSync } from "node:sqlite";
import type { RawData } from "ws";

class FakeRuntimeSocket extends EventEmitter {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | undefined;

  send(data: string): void {
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

  it("accepts hello and heartbeat messages and updates connection state", () => {
    const { db, ws, now, runtimeId, runtimeSessionId, workspaceBindingId } = setupRuntime();

    const helloAck = ws.sent
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "server.hello_ack");
    const reconcileRequest = ws.sent
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "runtime.reconcile.request");
    expect(helloAck.type).toBe("server.hello_ack");
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
      .prepare("SELECT display_name FROM runtime_workspace_bindings WHERE id = ?")
      .get(workspaceBindingId) as {
      display_name: string;
    };
    expect(binding.display_name).toBe("Local default");
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
        `SELECT id, display_name AS displayName
         FROM runtime_workspace_bindings
         WHERE runtime_id = ? AND local_workspace_key = ?`,
      )
      .all(runtimeId, "local-default") as Array<{ id: string; displayName: string }>;
    const ownerBinding = db
      .prepare(
        `SELECT runtime_workspace_binding_id AS runtimeWorkspaceBindingId
         FROM workspace_owner_bindings
         WHERE workspace_id = ?`,
      )
      .get(workspace.id) as { runtimeWorkspaceBindingId: string };

    expect(bindingRows).toEqual([
      { id: workspaceBindingId, displayName: "Local default after reconnect" },
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
            options: [{ id: "mvp", label: "MVP" }],
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

    expect(binding.displayName).toBe("Local default renamed");
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
