import { createHash } from "node:crypto";
import {
  artifactProjectionEnvelopeSchema,
  createId,
  humanRequestCreatedEnvelopeSchema,
  humanResponseAckEnvelopeSchema,
  invocationLogChunkEnvelopeSchema,
  invocationUpdateEnvelopeSchema,
  runtimeCommandAckEnvelopeSchema,
  runtimeCommandRejectEnvelopeSchema,
  runtimeHeartbeatEnvelopeSchema,
  runtimeHelloEnvelopeSchema,
  runtimeProtocolVersion,
  runtimeReconcileReportEnvelopeSchema,
  taskGraphSnapshotEnvelopeSchema,
  workspaceSnapshotEnvelopeSchema,
} from "@zendev-lab/navia-protocol";
import { bearerTokenFromAuthorization } from "@zendev-lab/navia-system";
import { hashSecret } from "./auth";
import {
  appendEvent,
  ingestTaskGraphSnapshot,
  recordArtifactProjection,
  recordCommandAck,
  recordCommandReject,
  recordHumanRequestFromRuntime,
  recordHumanResponseAck,
  recordInvocationLogChunk,
  recordInvocationUpdate,
} from "./projection-services";
import type { DatabaseSync } from "node:sqlite";
import type { RawData, WebSocket } from "ws";

export interface RuntimeWebSocketContext {
  db: DatabaseSync;
  runtimeId: string;
  remoteAddress?: string;
}

export interface RuntimeWebSocketConnection {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
}

interface RoutedContext {
  runtimeId?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
  commandId?: string;
  humanRequestId?: string;
  humanResponseId?: string;
  invocationId?: string;
}

export function attachRuntimeWebSocket(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
): void {
  let runtimeSessionId: string | undefined;

  ws.on("message", (data) => {
    const parsed = parseMessage(data);
    if (!parsed.ok) {
      sendError(ws, "invalid_json", parsed.message);
      return;
    }

    const hello = runtimeHelloEnvelopeSchema.safeParse(parsed.value);
    if (hello.success) {
      if (hello.data.payload.runtimeId !== context.runtimeId) {
        sendError(
          ws,
          "runtime_id_mismatch",
          "Runtime hello did not match the WebSocket runtime id.",
        );
        ws.close(1008, "runtime_id_mismatch");
        return;
      }

      runtimeSessionId = handleHello(context, hello.data.payload);
      ws.send(
        JSON.stringify({
          protocolVersion: hello.data.protocolVersion,
          messageId: createId("msg"),
          type: "server.hello_ack",
          sentAt: new Date().toISOString(),
          payload: {
            runtimeSessionId,
            acceptedFeatures: hello.data.payload.supportedFeatures,
            heartbeatIntervalMs: 15_000,
            serverTime: new Date().toISOString(),
          },
        }),
      );
      if (hello.data.payload.supportedFeatures.includes("reconcile-v1")) {
        sendReconcileRequest(ws, hello.data.protocolVersion, context.runtimeId, "startup");
      }
      return;
    }

    const heartbeat = runtimeHeartbeatEnvelopeSchema.safeParse(parsed.value);
    if (heartbeat.success) {
      if (heartbeat.data.payload.runtimeId !== context.runtimeId) {
        sendError(
          ws,
          "runtime_id_mismatch",
          "Runtime heartbeat did not match the WebSocket runtime id.",
        );
        ws.close(1008, "runtime_id_mismatch");
        return;
      }

      runtimeSessionId = handleHeartbeat(
        context,
        runtimeSessionId,
        heartbeat.data.payload.runtimeSessionId,
      );
      if (heartbeat.data.payload.workspaceBindings) {
        upsertWorkspaceBindings(
          context.db,
          context.runtimeId,
          heartbeat.data.payload.workspaceBindings,
          new Date().toISOString(),
        );
      }
      ws.send(
        JSON.stringify({
          protocolVersion: heartbeat.data.protocolVersion,
          messageId: createId("msg"),
          type: "server.heartbeat_ack",
          sentAt: new Date().toISOString(),
          payload: {
            runtimeSessionId,
            sequence: heartbeat.data.payload.sequence,
            serverTime: new Date().toISOString(),
          },
        }),
      );
      flushPendingRuntimeDeliveries(ws, context);
      return;
    }

    if (handleMvpRuntimeMessage(ws, context, parsed.value)) {
      return;
    }

    sendError(ws, "unsupported_runtime_message", "Unsupported runtime WebSocket message.");
  });

  ws.on("close", (_code, reason) => {
    if (runtimeSessionId) {
      markSessionClosed(context.db, runtimeSessionId, reason.toString("utf8") || null);
    }
  });
}

export function authenticateRuntimeToken(
  db: DatabaseSync,
  runtimeId: string,
  authorization: string | undefined,
): string | null {
  const token = bearerTokenFromAuthorization(authorization);
  if (!token) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT id,
              scopes_json AS scopesJson,
              expires_at AS expiresAt
       FROM runtime_tokens
       WHERE runtime_id = ? AND token_hash = ? AND revoked_at IS NULL
       LIMIT 1`,
    )
    .get(runtimeId, hashSecret(token)) as
    | { id: string; scopesJson: string; expiresAt: string | null }
    | undefined;

  if (!row || !runtimeTokenScopes(row.scopesJson).includes("runtime:connect")) {
    return null;
  }

  if (row.expiresAt && row.expiresAt <= new Date().toISOString()) {
    return null;
  }

  return row.id;
}

type RuntimeHelloPayload = ReturnType<typeof runtimeHelloEnvelopeSchema.parse>["payload"];
type RuntimeHeartbeatPayload = ReturnType<typeof runtimeHeartbeatEnvelopeSchema.parse>["payload"];

function handleMvpRuntimeMessage(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
  value: unknown,
): boolean {
  const reconcileReport = runtimeReconcileReportEnvelopeSchema.safeParse(value);
  if (reconcileReport.success) {
    if (reconcileReport.data.runtimeId && reconcileReport.data.runtimeId !== context.runtimeId) {
      sendError(
        ws,
        "runtime_id_mismatch",
        "Runtime reconcile did not match the WebSocket runtime id.",
      );
      ws.close(1008, "runtime_id_mismatch");
      return true;
    }

    if (acknowledgeProcessedRuntimeMessage(ws, context, reconcileReport.data)) {
      return true;
    }
    upsertWorkspaceBindings(
      context.db,
      context.runtimeId,
      reconcileReport.data.payload.workspaceBindings,
      new Date().toISOString(),
    );
    rememberProcessedRuntimeMessage(context, reconcileReport.data);
    sendIngestAck(
      ws,
      reconcileReport.data.protocolVersion,
      reconcileReport.data.messageId,
      reconcileReport.data.type,
    );
    return true;
  }

  const workspaceSnapshot = workspaceSnapshotEnvelopeSchema.safeParse(value);
  if (workspaceSnapshot.success) {
    const routed = requireRoutedContext(ws, context, workspaceSnapshot.data, {
      workspaceBinding: true,
      workspace: true,
    });
    if (!routed) {
      return true;
    }

    if (acknowledgeProcessedRuntimeMessage(ws, context, workspaceSnapshot.data)) {
      return true;
    }
    handleWorkspaceSnapshot(
      context,
      routed.workspaceBindingId,
      routed.workspaceId,
      workspaceSnapshot.data.payload,
    );
    rememberProcessedRuntimeMessage(context, workspaceSnapshot.data);
    sendIngestAck(
      ws,
      workspaceSnapshot.data.protocolVersion,
      workspaceSnapshot.data.messageId,
      workspaceSnapshot.data.type,
    );
    return true;
  }

  const commandAck = runtimeCommandAckEnvelopeSchema.safeParse(value);
  if (commandAck.success) {
    const routed = requireRoutedContext(ws, context, commandAck.data, {
      workspaceBinding: true,
      workspace: true,
      command: true,
    });
    if (!routed) {
      return true;
    }

    if (acknowledgeProcessedRuntimeMessage(ws, context, commandAck.data)) {
      return true;
    }
    recordCommandAck(context.db, {
      runtimeWorkspaceBindingId: routed.workspaceBindingId,
      workspaceId: routed.workspaceId,
      projectId: routed.projectId ?? null,
      commandId: routed.commandId,
      payload: commandAck.data.payload,
    });
    rememberProcessedRuntimeMessage(context, commandAck.data);
    sendIngestAck(
      ws,
      commandAck.data.protocolVersion,
      commandAck.data.messageId,
      commandAck.data.type,
    );
    return true;
  }

  const commandReject = runtimeCommandRejectEnvelopeSchema.safeParse(value);
  if (commandReject.success) {
    const routed = requireRoutedContext(ws, context, commandReject.data, {
      workspaceBinding: true,
      workspace: true,
      command: true,
    });
    if (!routed) {
      return true;
    }

    if (acknowledgeProcessedRuntimeMessage(ws, context, commandReject.data)) {
      return true;
    }
    recordCommandReject(context.db, {
      runtimeWorkspaceBindingId: routed.workspaceBindingId,
      workspaceId: routed.workspaceId,
      projectId: routed.projectId ?? null,
      commandId: routed.commandId,
      payload: commandReject.data.payload,
    });
    rememberProcessedRuntimeMessage(context, commandReject.data);
    sendIngestAck(
      ws,
      commandReject.data.protocolVersion,
      commandReject.data.messageId,
      commandReject.data.type,
    );
    return true;
  }

  const humanRequest = humanRequestCreatedEnvelopeSchema.safeParse(value);
  if (humanRequest.success) {
    const routed = requireRoutedContext(ws, context, humanRequest.data, {
      workspaceBinding: true,
      workspace: true,
      humanRequest: true,
    });
    if (!routed) {
      return true;
    }

    if (acknowledgeProcessedRuntimeMessage(ws, context, humanRequest.data)) {
      return true;
    }
    recordHumanRequestFromRuntime(context.db, {
      runtimeWorkspaceBindingId: routed.workspaceBindingId,
      workspaceId: routed.workspaceId,
      projectId: routed.projectId ?? null,
      commandId: routed.commandId || null,
      invocationId: routed.invocationId || null,
      humanRequestId: routed.humanRequestId,
      runtimeRequestId: routed.humanRequestId,
      payload: humanRequest.data.payload,
    });
    rememberProcessedRuntimeMessage(context, humanRequest.data);
    sendIngestAck(
      ws,
      humanRequest.data.protocolVersion,
      humanRequest.data.messageId,
      humanRequest.data.type,
    );
    return true;
  }

  const humanResponseAck = humanResponseAckEnvelopeSchema.safeParse(value);
  if (humanResponseAck.success) {
    const routed = requireRoutedContext(ws, context, humanResponseAck.data, {
      workspaceBinding: true,
      humanRequest: true,
      humanResponse: true,
    });
    if (!routed) {
      return true;
    }

    if (acknowledgeProcessedRuntimeMessage(ws, context, humanResponseAck.data)) {
      return true;
    }
    recordHumanResponseAck(context.db, {
      runtimeWorkspaceBindingId: routed.workspaceBindingId,
      workspaceId: routed.workspaceId ?? null,
      projectId: routed.projectId ?? null,
      humanRequestId: routed.humanRequestId,
      humanResponseId: routed.humanResponseId,
      payload: humanResponseAck.data.payload,
    });
    rememberProcessedRuntimeMessage(context, humanResponseAck.data);
    sendIngestAck(
      ws,
      humanResponseAck.data.protocolVersion,
      humanResponseAck.data.messageId,
      humanResponseAck.data.type,
    );
    return true;
  }

  const taskGraphSnapshot = taskGraphSnapshotEnvelopeSchema.safeParse(value);
  if (taskGraphSnapshot.success) {
    const routed = requireRoutedContext(ws, context, taskGraphSnapshot.data, {
      workspaceBinding: true,
      workspace: true,
    });
    if (!routed) {
      return true;
    }

    if (acknowledgeProcessedRuntimeMessage(ws, context, taskGraphSnapshot.data)) {
      return true;
    }
    ingestTaskGraphSnapshot(context.db, {
      runtimeWorkspaceBindingId: routed.workspaceBindingId,
      workspaceId: routed.workspaceId,
      projectId: routed.projectId ?? null,
      payload: taskGraphSnapshot.data.payload,
    });
    rememberProcessedRuntimeMessage(context, taskGraphSnapshot.data);
    sendIngestAck(
      ws,
      taskGraphSnapshot.data.protocolVersion,
      taskGraphSnapshot.data.messageId,
      taskGraphSnapshot.data.type,
    );
    return true;
  }

  const invocationUpdate = invocationUpdateEnvelopeSchema.safeParse(value);
  if (invocationUpdate.success) {
    const routed = requireRoutedContext(ws, context, invocationUpdate.data, {
      workspaceBinding: true,
      workspace: true,
    });
    if (!routed) {
      return true;
    }

    if (acknowledgeProcessedRuntimeMessage(ws, context, invocationUpdate.data)) {
      return true;
    }
    recordInvocationUpdate(context.db, {
      runtimeWorkspaceBindingId: routed.workspaceBindingId,
      workspaceId: routed.workspaceId,
      projectId: routed.projectId ?? null,
      commandId: routed.commandId || null,
      invocationId: routed.invocationId || null,
      payload: invocationUpdate.data.payload,
    });
    rememberProcessedRuntimeMessage(context, invocationUpdate.data);
    sendIngestAck(
      ws,
      invocationUpdate.data.protocolVersion,
      invocationUpdate.data.messageId,
      invocationUpdate.data.type,
    );
    return true;
  }

  const invocationLogChunk = invocationLogChunkEnvelopeSchema.safeParse(value);
  if (invocationLogChunk.success) {
    const routed = requireRoutedContext(ws, context, invocationLogChunk.data, {
      workspaceBinding: true,
      workspace: true,
    });
    if (!routed) {
      return true;
    }

    if (acknowledgeProcessedRuntimeMessage(ws, context, invocationLogChunk.data)) {
      return true;
    }
    recordInvocationLogChunk(context.db, {
      runtimeWorkspaceBindingId: routed.workspaceBindingId,
      workspaceId: routed.workspaceId,
      projectId: routed.projectId ?? null,
      commandId: routed.commandId || null,
      payload: invocationLogChunk.data.payload,
    });
    rememberProcessedRuntimeMessage(context, invocationLogChunk.data);
    sendIngestAck(
      ws,
      invocationLogChunk.data.protocolVersion,
      invocationLogChunk.data.messageId,
      invocationLogChunk.data.type,
    );
    return true;
  }

  const artifactProjection = artifactProjectionEnvelopeSchema.safeParse(value);
  if (artifactProjection.success) {
    const routed = requireRoutedContext(ws, context, artifactProjection.data, {
      workspaceBinding: true,
      workspace: true,
    });
    if (!routed) {
      return true;
    }

    if (acknowledgeProcessedRuntimeMessage(ws, context, artifactProjection.data)) {
      return true;
    }
    recordArtifactProjection(context.db, {
      runtimeWorkspaceBindingId: routed.workspaceBindingId,
      workspaceId: routed.workspaceId,
      projectId: routed.projectId ?? null,
      invocationId: routed.invocationId || null,
      humanRequestId: routed.humanRequestId || null,
      payload: artifactProjection.data.payload,
    });
    rememberProcessedRuntimeMessage(context, artifactProjection.data);
    sendIngestAck(
      ws,
      artifactProjection.data.protocolVersion,
      artifactProjection.data.messageId,
      artifactProjection.data.type,
    );
    return true;
  }

  return false;
}

function sendReconcileRequest(
  ws: WebSocket | RuntimeWebSocketConnection,
  protocolVersion: typeof runtimeProtocolVersion,
  runtimeId: string,
  reason: "startup" | "heartbeat" | "manual" | "server_request",
): void {
  ws.send(
    JSON.stringify({
      protocolVersion,
      messageId: createId("msg"),
      type: "runtime.reconcile.request",
      sentAt: new Date().toISOString(),
      runtimeId,
      payload: {
        reason,
        requestedAt: new Date().toISOString(),
        scopes: ["workspace_bindings", "commands"],
      },
    }),
  );
}

function handleHello(context: RuntimeWebSocketContext, payload: RuntimeHelloPayload): string {
  const now = new Date().toISOString();
  const runtimeSessionId = createId("rtsn");

  context.db.exec("BEGIN");
  try {
    context.db
      .prepare(
        `UPDATE runtime_connections
         SET status = 'online', last_heartbeat_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, payload.runtimeId);

    context.db
      .prepare(
        `INSERT INTO runtime_sessions
          (id, runtime_id, transport, status, connected_at, last_seen_at, remote_addr_hash)
         VALUES (?, ?, 'websocket', 'connected', ?, ?, ?)`,
      )
      .run(runtimeSessionId, payload.runtimeId, now, now, hashOptional(context.remoteAddress));

    upsertWorkspaceBindings(context.db, payload.runtimeId, payload.workspaceBindings, now);
    context.db.exec("COMMIT");
  } catch (error) {
    context.db.exec("ROLLBACK");
    throw error;
  }

  return runtimeSessionId;
}

function handleHeartbeat(
  context: RuntimeWebSocketContext,
  currentRuntimeSessionId: string | undefined,
  payloadRuntimeSessionId: string | undefined,
): string {
  const now = new Date().toISOString();
  const runtimeSessionId = payloadRuntimeSessionId ?? currentRuntimeSessionId ?? createId("rtsn");

  context.db.exec("BEGIN");
  try {
    context.db
      .prepare(
        `UPDATE runtime_connections
         SET status = 'online', last_heartbeat_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, context.runtimeId);

    const sessionExists = context.db
      .prepare("SELECT id FROM runtime_sessions WHERE id = ? LIMIT 1")
      .get(runtimeSessionId);
    if (sessionExists) {
      context.db
        .prepare("UPDATE runtime_sessions SET status = 'connected', last_seen_at = ? WHERE id = ?")
        .run(now, runtimeSessionId);
    } else {
      context.db
        .prepare(
          `INSERT INTO runtime_sessions
            (id, runtime_id, transport, status, connected_at, last_seen_at, remote_addr_hash)
           VALUES (?, ?, 'websocket', 'connected', ?, ?, ?)`,
        )
        .run(runtimeSessionId, context.runtimeId, now, now, hashOptional(context.remoteAddress));
    }

    context.db.exec("COMMIT");
  } catch (error) {
    context.db.exec("ROLLBACK");
    throw error;
  }

  return runtimeSessionId;
}

function handleWorkspaceSnapshot(
  context: RuntimeWebSocketContext,
  runtimeWorkspaceBindingId: string,
  workspaceId: string,
  payload: ReturnType<typeof workspaceSnapshotEnvelopeSchema.parse>["payload"],
): void {
  const now = new Date().toISOString();

  context.db.exec("BEGIN");
  try {
    context.db
      .prepare(
        `UPDATE runtime_workspace_bindings
         SET display_name = ?, status = ?, last_snapshot_at = ?, updated_at = ?
         WHERE id = ? AND runtime_id = ?`,
      )
      .run(
        payload.displayName,
        payload.status,
        now,
        now,
        runtimeWorkspaceBindingId,
        context.runtimeId,
      );

    appendEvent(context.db, {
      workspaceId,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "workspace.snapshot.received",
      subjectKind: "runtime_workspace_binding",
      subjectId: runtimeWorkspaceBindingId,
      payload,
      createdAt: now,
    });

    context.db.exec("COMMIT");
  } catch (error) {
    context.db.exec("ROLLBACK");
    throw error;
  }
}

function upsertWorkspaceBindings(
  db: DatabaseSync,
  runtimeId: string,
  bindings: RuntimeHelloPayload["workspaceBindings"] | RuntimeHeartbeatPayload["workspaceBindings"],
  now: string,
): void {
  if (!bindings) {
    return;
  }

  const findExisting = db.prepare(
    `SELECT id
     FROM runtime_workspace_bindings
     WHERE runtime_id = ? AND (local_workspace_key = ? OR id = ?)
     ORDER BY CASE WHEN local_workspace_key = ? THEN 0 ELSE 1 END
     LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE runtime_workspace_bindings
     SET local_workspace_key = ?,
         display_name = ?,
         status = ?,
         capabilities_json = ?,
         diagnostics_json = ?,
         updated_at = ?
     WHERE id = ? AND runtime_id = ?`,
  );

  for (const binding of bindings) {
    const existing = findExisting.get(
      runtimeId,
      binding.localWorkspaceKey,
      binding.bindingId,
      binding.localWorkspaceKey,
    ) as { id: string } | undefined;
    if (existing) {
      update.run(
        binding.localWorkspaceKey,
        binding.displayName,
        binding.status,
        JSON.stringify(binding.capabilities),
        JSON.stringify(binding.diagnostics),
        now,
        existing.id,
        runtimeId,
      );
      continue;
    }

    insert.run(
      binding.bindingId,
      runtimeId,
      binding.localWorkspaceKey,
      binding.displayName,
      binding.status,
      JSON.stringify(binding.capabilities),
      JSON.stringify(binding.diagnostics),
      now,
      now,
    );
  }
}

function requireRoutedContext(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
  envelope: RoutedContext,
  required: {
    workspaceBinding?: boolean;
    workspace?: boolean;
    command?: boolean;
    humanRequest?: boolean;
    humanResponse?: boolean;
  },
): {
  workspaceBindingId: string;
  workspaceId: string;
  projectId?: string;
  commandId: string;
  humanRequestId: string;
  humanResponseId: string;
  invocationId?: string;
} | null {
  if (envelope.runtimeId && envelope.runtimeId !== context.runtimeId) {
    sendError(ws, "runtime_id_mismatch", "Runtime message did not match the WebSocket runtime id.");
    ws.close(1008, "runtime_id_mismatch");
    return null;
  }

  if (required.workspaceBinding && !envelope.workspaceBindingId) {
    sendError(ws, "missing_workspace_binding_id", "Runtime message requires workspaceBindingId.");
    return null;
  }

  if (
    envelope.workspaceBindingId &&
    !bindingBelongsToRuntime(context.db, context.runtimeId, envelope.workspaceBindingId)
  ) {
    sendError(
      ws,
      "unknown_workspace_binding",
      "Workspace binding does not belong to this runtime.",
    );
    return null;
  }

  if (required.workspace && !envelope.workspaceId) {
    sendError(ws, "missing_workspace_id", "Runtime message requires workspaceId.");
    return null;
  }

  if (envelope.workspaceId && !workspaceExists(context.db, envelope.workspaceId)) {
    sendError(ws, "unknown_workspace", "Runtime message referenced an unknown workspace.");
    return null;
  }

  if (required.command && !envelope.commandId) {
    sendError(ws, "missing_command_id", "Runtime message requires commandId.");
    return null;
  }

  if (required.humanRequest && !envelope.humanRequestId) {
    sendError(ws, "missing_human_request_id", "Runtime message requires humanRequestId.");
    return null;
  }

  if (required.humanResponse && !envelope.humanResponseId) {
    sendError(ws, "missing_human_response_id", "Runtime message requires humanResponseId.");
    return null;
  }

  return {
    workspaceBindingId: envelope.workspaceBindingId ?? "",
    workspaceId: envelope.workspaceId ?? "",
    projectId: envelope.projectId,
    commandId: envelope.commandId ?? "",
    humanRequestId: envelope.humanRequestId ?? "",
    humanResponseId: envelope.humanResponseId ?? "",
    invocationId: envelope.invocationId,
  };
}

function flushPendingRuntimeDeliveries(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
): void {
  flushPendingCommands(ws, context);
  flushPendingHumanResponses(ws, context);
}

function flushPendingCommands(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
): void {
  const now = new Date().toISOString();
  const rows = context.db
    .prepare(
      `SELECT cd.id AS deliveryId,
              cd.runtime_workspace_binding_id AS workspaceBindingId,
              c.id AS commandId,
              c.workspace_id AS workspaceId,
              c.project_id AS projectId,
              c.idempotency_key AS idempotencyKey,
              c.payload_json AS payloadJson
       FROM command_deliveries cd
       JOIN commands c ON c.id = cd.command_id
       JOIN runtime_workspace_bindings rb ON rb.id = cd.runtime_workspace_binding_id
       WHERE rb.runtime_id = ? AND cd.status = 'pending' AND c.status IN ('queued', 'delivered')
         AND rb.status = 'available'
       ORDER BY cd.created_at ASC
       LIMIT 10`,
    )
    .all(context.runtimeId) as Array<{
    deliveryId: string;
    workspaceBindingId: string;
    commandId: string;
    workspaceId: string;
    projectId: string | null;
    idempotencyKey: string | null;
    payloadJson: string;
  }>;

  for (const row of rows) {
    const messageId = createId("msg");
    context.db.exec("BEGIN");
    try {
      context.db
        .prepare(
          `UPDATE command_deliveries
           SET status = 'sent', attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, row.deliveryId);
      context.db
        .prepare("UPDATE commands SET status = 'delivered', updated_at = ? WHERE id = ?")
        .run(now, row.commandId);
      context.db.exec("COMMIT");
    } catch (error) {
      context.db.exec("ROLLBACK");
      throw error;
    }

    ws.send(
      JSON.stringify({
        protocolVersion: runtimeProtocolVersion,
        messageId,
        type: "server.command",
        sentAt: now,
        runtimeId: context.runtimeId,
        workspaceBindingId: row.workspaceBindingId,
        workspaceId: row.workspaceId,
        projectId: row.projectId ?? undefined,
        commandId: row.commandId,
        idempotencyKey: row.idempotencyKey ?? undefined,
        payload: JSON.parse(row.payloadJson),
      }),
    );
  }
}

function flushPendingHumanResponses(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
): void {
  const now = new Date().toISOString();
  const rows = context.db
    .prepare(
      `SELECT hres.id AS humanResponseId,
              hres.answer_json AS answerJson,
              hreq.id AS humanRequestId,
              hreq.workspace_id AS workspaceId,
              hreq.project_id AS projectId,
              hreq.runtime_workspace_binding_id AS workspaceBindingId
       FROM human_responses hres
       JOIN human_requests hreq ON hreq.id = hres.human_request_id
       JOIN runtime_workspace_bindings rb ON rb.id = hreq.runtime_workspace_binding_id
       WHERE rb.runtime_id = ? AND hres.status = 'delivering'
       ORDER BY hres.created_at ASC
       LIMIT 10`,
    )
    .all(context.runtimeId) as Array<{
    humanResponseId: string;
    answerJson: string;
    humanRequestId: string;
    workspaceId: string;
    projectId: string | null;
    workspaceBindingId: string;
  }>;

  for (const row of rows) {
    const messageId = createId("msg");
    context.db.exec("BEGIN");
    try {
      context.db
        .prepare(
          `UPDATE human_responses
           SET delivery_attempt_count = delivery_attempt_count + 1, last_delivery_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, row.humanResponseId);
      appendEvent(context.db, {
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        actorKind: "server",
        kind: "human.response.delivery_attempted",
        subjectKind: "human_response",
        subjectId: row.humanResponseId,
        payload: {
          humanRequestId: row.humanRequestId,
          runtimeWorkspaceBindingId: row.workspaceBindingId,
        },
        createdAt: now,
      });
      context.db.exec("COMMIT");
    } catch (error) {
      context.db.exec("ROLLBACK");
      throw error;
    }

    ws.send(
      JSON.stringify({
        protocolVersion: runtimeProtocolVersion,
        messageId,
        type: "human.response.deliver",
        sentAt: now,
        runtimeId: context.runtimeId,
        workspaceBindingId: row.workspaceBindingId,
        workspaceId: row.workspaceId,
        projectId: row.projectId ?? undefined,
        humanRequestId: row.humanRequestId,
        humanResponseId: row.humanResponseId,
        payload: JSON.parse(row.answerJson),
      }),
    );
  }
}

function bindingBelongsToRuntime(
  db: DatabaseSync,
  runtimeId: string,
  runtimeWorkspaceBindingId: string,
): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM runtime_workspace_bindings WHERE id = ? AND runtime_id = ? LIMIT 1")
      .get(runtimeWorkspaceBindingId, runtimeId),
  );
}

function workspaceExists(db: DatabaseSync, workspaceId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1").get(workspaceId));
}

function markSessionClosed(
  db: DatabaseSync,
  runtimeSessionId: string,
  reason: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE runtime_sessions SET status = 'closed', closed_at = ?, close_reason = ? WHERE id = ?",
  ).run(now, reason, runtimeSessionId);
}

interface RuntimeMessageIdentity {
  protocolVersion: string;
  messageId: string;
  type: string;
}

function acknowledgeProcessedRuntimeMessage(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
  message: RuntimeMessageIdentity,
): boolean {
  const seen = context.db
    .prepare(
      `SELECT id FROM runtime_message_receipts
       WHERE runtime_id = ? AND message_id = ? AND message_type = ?
       LIMIT 1`,
    )
    .get(context.runtimeId, message.messageId, message.type) as { id: string } | undefined;
  if (!seen) {
    return false;
  }

  context.db
    .prepare(
      `UPDATE runtime_message_receipts
       SET last_seen_at = ?, replay_count = replay_count + 1
       WHERE id = ?`,
    )
    .run(new Date().toISOString(), seen.id);
  sendIngestAck(ws, message.protocolVersion, message.messageId, message.type);
  return true;
}

function rememberProcessedRuntimeMessage(
  context: RuntimeWebSocketContext,
  message: RuntimeMessageIdentity,
): void {
  const timestamp = new Date().toISOString();
  const result = context.db
    .prepare(
      `INSERT OR IGNORE INTO runtime_message_receipts
        (id, runtime_id, message_id, message_type, first_seen_at, last_seen_at, replay_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      runtimeMessageReceiptId(context.runtimeId, message.messageId, message.type),
      context.runtimeId,
      message.messageId,
      message.type,
      timestamp,
      timestamp,
    );
  if (result.changes === 0) {
    context.db
      .prepare(
        `UPDATE runtime_message_receipts
         SET last_seen_at = ?, replay_count = replay_count + 1
         WHERE runtime_id = ? AND message_id = ? AND message_type = ?`,
      )
      .run(timestamp, context.runtimeId, message.messageId, message.type);
  }
}

function runtimeMessageReceiptId(
  runtimeId: string,
  messageId: string,
  messageType: string,
): string {
  return `rmr_${createHash("sha256").update(`${runtimeId}:${messageId}:${messageType}`).digest("hex").slice(0, 32)}`;
}

function sendIngestAck(
  ws: WebSocket | RuntimeWebSocketConnection,
  protocolVersion: string,
  ackOf: string,
  receivedType: string,
): void {
  ws.send(
    JSON.stringify({
      protocolVersion,
      messageId: createId("msg"),
      type: "server.ingest_ack",
      sentAt: new Date().toISOString(),
      ackOf,
      payload: { accepted: true, receivedType },
    }),
  );
}

function sendError(
  ws: WebSocket | RuntimeWebSocketConnection,
  code: string,
  message: string,
): void {
  ws.send(
    JSON.stringify({
      protocolVersion: "navia.runtime.v1alpha1",
      messageId: createId("msg"),
      type: "server.error",
      sentAt: new Date().toISOString(),
      payload: { code, message },
    }),
  );
}

function parseMessage(
  data: RawData,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: "Runtime WebSocket message must be valid JSON." };
  }
}

function hashOptional(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  return createHash("sha256").update(value).digest("hex");
}

function runtimeTokenScopes(scopesJson: string): string[] {
  try {
    const scopes = JSON.parse(scopesJson) as unknown;
    return Array.isArray(scopes)
      ? scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
  } catch {
    return [];
  }
}
