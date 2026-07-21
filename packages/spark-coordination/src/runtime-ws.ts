import { createHash } from "node:crypto";
import {
  artifactProjectionEnvelopeSchema,
  createId,
  createServerCommandEnvelope,
  daemonEventEnvelopeSchema,
  humanRequestCreatedEnvelopeSchema,
  humanResponseAckEnvelopeSchema,
  humanResponseRecordedEnvelopeSchema,
  invocationLogChunkEnvelopeSchema,
  invocationUpdateEnvelopeSchema,
  runtimeCommandAckEnvelopeSchema,
  runtimeCommandRejectEnvelopeSchema,
  runtimeCommandResultEnvelopeSchema,
  runtimeEphemeralSecretResultEnvelopeSchema,
  runtimeHeartbeatEnvelopeSchema,
  runtimeHelloEnvelopeSchema,
  runtimeProtocolVersion,
  runtimeReconcileReportEnvelopeSchema,
  parseSparkDaemonEvent,
  serializeServerCommandEnvelope,
  taskGraphSnapshotEnvelopeSchema,
  workspaceSnapshotEnvelopeSchema,
} from "@zendev-lab/spark-protocol";
import { bearerTokenFromAuthorization } from "@zendev-lab/spark-system";
import {
  markRuntimeControlCommandDeliveryAttempt,
  pendingRuntimeControlCommands,
  recordRuntimeControlCommandAck,
  recordRuntimeControlCommandReject,
  recordRuntimeControlCommandResult,
  recoverUnacknowledgedRuntimeControlCommands,
  registerRuntimeControlDispatcher,
  requireRuntimeControlCommand,
} from "./runtime-control.ts";
import { hashSecret } from "./security.ts";
import {
  resolveWorkspaceDirectoryDisplayName,
  syncWorkspaceIdentityFromLocalPath,
} from "./workspace-identity.ts";
import {
  recordRuntimeEphemeralSecretProjection,
  recordRuntimeModelChannelProjection,
  registerRuntimeEphemeralSecretDispatcher,
} from "./runtime-model-channel-control.ts";
import { RuntimeControlCommandError } from "./runtime-control.ts";
import { recordRuntimeSessionControlProjection } from "./runtime-session-control.ts";
import {
  appendEvent,
  ingestTaskGraphSnapshot,
  recordArtifactProjection,
  recordCommandAck,
  recordCommandReject,
  recordHumanRequestFromRuntime,
  recordHumanResponseFromRuntime,
  recordHumanResponseAck,
  recordInvocationLogChunk,
  recordInvocationUpdate,
} from "./projection-services.ts";
import type { DatabaseSync } from "node:sqlite";
import type { RawData, WebSocket } from "ws";

export interface RuntimeWebSocketContext {
  db: DatabaseSync;
  runtimeId: string;
  remoteAddress?: string;
  secureTransport?: boolean;
  heartbeatIntervalMs?: number;
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
  sessionId?: string;
}

export function attachRuntimeWebSocket(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
): void {
  let runtimeSessionId: string | undefined;
  let unregisterControlDispatcher: (() => void) | undefined;
  let unregisterEphemeralSecretDispatcher: (() => void) | undefined;
  const pendingEphemeralSecrets = new Map<
    string,
    {
      envelope: Parameters<
        Parameters<typeof registerRuntimeEphemeralSecretDispatcher>[2]
      >[0]["envelope"];
      resolve: Parameters<
        Parameters<typeof registerRuntimeEphemeralSecretDispatcher>[2]
      >[0]["resolve"];
      reject: Parameters<
        Parameters<typeof registerRuntimeEphemeralSecretDispatcher>[2]
      >[0]["reject"];
    }
  >();

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
      const workspaceBindingAssignments = listWorkspaceBindingAssignments(
        context.db,
        context.runtimeId,
        hello.data.payload.workspaceBindings.map(({ bindingId }) => bindingId),
      );
      ws.send(
        JSON.stringify({
          protocolVersion: hello.data.protocolVersion,
          messageId: createId("msg"),
          type: "server.hello_ack",
          sentAt: new Date().toISOString(),
          payload: {
            runtimeSessionId,
            acceptedFeatures: hello.data.payload.supportedFeatures,
            heartbeatIntervalMs: context.heartbeatIntervalMs ?? 15_000,
            serverTime: new Date().toISOString(),
            workspaceBindingAssignments,
          },
        }),
      );
      if (hello.data.payload.supportedFeatures.includes("reconcile-v1")) {
        sendReconcileRequest(ws, hello.data.protocolVersion, context.runtimeId, "startup");
      }
      unregisterControlDispatcher?.();
      unregisterControlDispatcher = registerRuntimeControlDispatcher(
        context.db,
        context.runtimeId,
        () => flushPendingRuntimeDeliveries(ws, context),
      );
      unregisterEphemeralSecretDispatcher?.();
      unregisterEphemeralSecretDispatcher = undefined;
      if (
        context.secureTransport === true &&
        hello.data.payload.supportedFeatures.includes("ephemeral-secret-v1")
      ) {
        unregisterEphemeralSecretDispatcher = registerRuntimeEphemeralSecretDispatcher(
          context.db,
          context.runtimeId,
          (dispatch) => {
            const { envelope } = dispatch;
            if (pendingEphemeralSecrets.has(envelope.ephemeralRequestId)) {
              dispatch.reject(
                new RuntimeControlCommandError(
                  "Secret request id is already active.",
                  "SECRET_REPLAY_REJECTED",
                ),
              );
              return () => {};
            }
            pendingEphemeralSecrets.set(envelope.ephemeralRequestId, {
              envelope,
              resolve: (result) => dispatch.resolve(result),
              reject: (error) => dispatch.reject(error),
            });
            try {
              ws.send(JSON.stringify(envelope));
            } catch {
              pendingEphemeralSecrets.delete(envelope.ephemeralRequestId);
              dispatch.reject(
                new RuntimeControlCommandError(
                  "Secure runtime connection closed before the secret request was sent.",
                  "SECRET_RUNTIME_DISCONNECTED",
                ),
              );
            }
            return () => {
              pendingEphemeralSecrets.delete(envelope.ephemeralRequestId);
            };
          },
        );
      }
      flushPendingRuntimeDeliveries(ws, context);
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
            workspaceBindingAssignments: listWorkspaceBindingAssignments(
              context.db,
              context.runtimeId,
              heartbeat.data.payload.workspaceBindings?.map(({ bindingId }) => bindingId) ?? [],
            ),
          },
        }),
      );
      flushPendingRuntimeDeliveries(ws, context);
      return;
    }

    const ephemeralSecretResult = runtimeEphemeralSecretResultEnvelopeSchema.safeParse(
      parsed.value,
    );
    if (ephemeralSecretResult.success) {
      const result = ephemeralSecretResult.data;
      const pending = pendingEphemeralSecrets.get(result.ephemeralRequestId);
      if (!pending) {
        sendError(ws, "unknown_ephemeral_secret_request", "Secret result has no active request.");
        return;
      }
      if (
        result.runtimeId !== context.runtimeId ||
        result.payload.operation !== pending.envelope.payload.operation ||
        result.workspaceId !== pending.envelope.workspaceId ||
        result.workspaceBindingId !== pending.envelope.workspaceBindingId
      ) {
        pendingEphemeralSecrets.delete(result.ephemeralRequestId);
        pending.reject(
          new RuntimeControlCommandError(
            "Secret result did not match its in-memory request route.",
            "SECRET_ROUTE_MISMATCH",
          ),
        );
        return;
      }
      pendingEphemeralSecrets.delete(result.ephemeralRequestId);
      try {
        recordRuntimeEphemeralSecretProjection(context.db, {
          runtimeId: context.runtimeId,
          runtimeWorkspaceBindingId: result.workspaceBindingId,
          result: result.payload,
        });
        pending.resolve(result.payload);
      } catch (error) {
        pending.reject(error);
      }
      return;
    }

    if (handleMvpRuntimeMessage(ws, context, parsed.value)) {
      return;
    }

    sendError(ws, "unsupported_runtime_message", "Unsupported runtime WebSocket message.");
  });

  ws.on("close", (_code, reason) => {
    unregisterControlDispatcher?.();
    unregisterControlDispatcher = undefined;
    unregisterEphemeralSecretDispatcher?.();
    unregisterEphemeralSecretDispatcher = undefined;
    for (const pending of pendingEphemeralSecrets.values()) {
      pending.reject(
        new RuntimeControlCommandError(
          "Secure runtime connection closed; the secret request will not be retried.",
          "SECRET_RUNTIME_DISCONNECTED",
        ),
      );
    }
    pendingEphemeralSecrets.clear();
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
    const commandRoute = requireCommandRoutedContext(ws, context, commandAck.data);
    if (!commandRoute) return true;
    const { routed, runtimeControl } = commandRoute;

    if (acknowledgeProcessedRuntimeMessage(ws, context, commandAck.data)) {
      return true;
    }
    if (runtimeControl) {
      recordRuntimeControlCommandAck(context.db, {
        runtimeId: context.runtimeId,
        commandId: routed.commandId,
        payload: commandAck.data.payload,
      });
    } else {
      recordCommandAck(context.db, {
        runtimeWorkspaceBindingId: routed.workspaceBindingId,
        workspaceId: routed.workspaceId,
        projectId: routed.projectId ?? null,
        commandId: routed.commandId,
        payload: commandAck.data.payload,
      });
    }
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
    const commandRoute = requireCommandRoutedContext(ws, context, commandReject.data);
    if (!commandRoute) return true;
    const { routed, runtimeControl } = commandRoute;

    if (acknowledgeProcessedRuntimeMessage(ws, context, commandReject.data)) {
      return true;
    }
    if (runtimeControl) {
      recordRuntimeControlCommandReject(context.db, {
        runtimeId: context.runtimeId,
        commandId: routed.commandId,
        payload: commandReject.data.payload,
      });
    } else {
      recordCommandReject(context.db, {
        runtimeWorkspaceBindingId: routed.workspaceBindingId,
        workspaceId: routed.workspaceId,
        projectId: routed.projectId ?? null,
        commandId: routed.commandId,
        payload: commandReject.data.payload,
      });
    }
    rememberProcessedRuntimeMessage(context, commandReject.data);
    sendIngestAck(
      ws,
      commandReject.data.protocolVersion,
      commandReject.data.messageId,
      commandReject.data.type,
    );
    return true;
  }

  const commandResult = runtimeCommandResultEnvelopeSchema.safeParse(value);
  if (commandResult.success) {
    const commandRoute = requireCommandRoutedContext(ws, context, commandResult.data);
    if (!commandRoute) return true;
    const { routed, runtimeControl } = commandRoute;
    if (!runtimeControl) {
      sendError(
        ws,
        "unknown_runtime_control_command",
        "Runtime result referenced an unknown control command.",
      );
      return true;
    }
    if (acknowledgeProcessedRuntimeMessage(ws, context, commandResult.data)) return true;
    recordRuntimeControlCommandResult(context.db, {
      runtimeId: context.runtimeId,
      commandId: routed.commandId,
      messageId: commandResult.data.messageId,
      payload: commandResult.data.payload,
      project: (command, payload) => {
        recordRuntimeSessionControlProjection(context.db, command, payload);
        recordRuntimeModelChannelProjection(context.db, command, payload);
      },
    });
    rememberProcessedRuntimeMessage(context, commandResult.data);
    sendIngestAck(
      ws,
      commandResult.data.protocolVersion,
      commandResult.data.messageId,
      commandResult.data.type,
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
  const humanResponseRecorded = humanResponseRecordedEnvelopeSchema.safeParse(value);
  if (humanResponseRecorded.success) {
    const routed = requireRoutedContext(ws, context, humanResponseRecorded.data, {
      workspaceBinding: true,
      workspace: true,
      humanRequest: true,
      humanResponse: true,
    });
    if (!routed) {
      return true;
    }
    if (!validateRecordedHumanResponseRoute(ws, context, routed)) {
      return true;
    }

    if (acknowledgeProcessedRuntimeMessage(ws, context, humanResponseRecorded.data)) {
      return true;
    }
    recordHumanResponseFromRuntime(context.db, {
      runtimeWorkspaceBindingId: routed.workspaceBindingId,
      workspaceId: routed.workspaceId,
      humanRequestId: routed.humanRequestId,
      humanResponseId: routed.humanResponseId,
      payload: humanResponseRecorded.data.payload,
      recordedAt: humanResponseRecorded.data.sentAt,
    });
    rememberProcessedRuntimeMessage(context, humanResponseRecorded.data);
    sendIngestAck(
      ws,
      humanResponseRecorded.data.protocolVersion,
      humanResponseRecorded.data.messageId,
      humanResponseRecorded.data.type,
    );
    return true;
  }

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

  const daemonEvent = daemonEventEnvelopeSchema.safeParse(value);
  if (daemonEvent.success) {
    const routed = requireRoutedContext(ws, context, daemonEvent.data, {
      workspaceBinding: true,
      workspace: true,
    });
    if (!routed) {
      return true;
    }

    if (acknowledgeProcessedRuntimeMessage(ws, context, daemonEvent.data)) {
      return true;
    }
    const parsedDaemonEvent = parseSparkDaemonEvent(daemonEvent.data.payload);
    appendEvent(context.db, {
      workspaceId: routed.workspaceId,
      projectId: routed.projectId ?? null,
      actorKind: "runtime",
      actorId: routed.workspaceBindingId,
      kind: parsedDaemonEvent.type,
      subjectKind: parsedDaemonEvent.type === "daemon.view_event" ? "view_model" : "daemon_event",
      subjectId:
        parsedDaemonEvent.eventId ??
        parsedDaemonEvent.sessionId ??
        parsedDaemonEvent.invocationId ??
        daemonEvent.data.messageId,
      payload: parsedDaemonEvent,
    });
    rememberProcessedRuntimeMessage(context, daemonEvent.data);
    sendIngestAck(
      ws,
      daemonEvent.data.protocolVersion,
      daemonEvent.data.messageId,
      daemonEvent.data.type,
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

function validateRecordedHumanResponseRoute(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
  routed: {
    workspaceBindingId: string;
    workspaceId: string;
    projectId?: string;
    humanRequestId: string;
    humanResponseId: string;
  },
): boolean {
  const request = context.db
    .prepare(
      `SELECT runtime_workspace_binding_id AS workspaceBindingId,
              workspace_id AS workspaceId,
              project_id AS projectId,
              status
       FROM human_requests
       WHERE id = ?`,
    )
    .get(routed.humanRequestId) as
    | {
        workspaceBindingId: string;
        workspaceId: string;
        projectId: string | null;
        status: string;
      }
    | undefined;

  if (!request) {
    sendError(ws, "unknown_human_request", "Runtime message referenced an unknown human request.");
    return false;
  }
  if (request.workspaceBindingId !== routed.workspaceBindingId) {
    sendError(
      ws,
      "human_request_binding_mismatch",
      "Human request does not belong to the routed workspace binding.",
    );
    return false;
  }
  if (request.workspaceId !== routed.workspaceId) {
    sendError(
      ws,
      "human_request_workspace_mismatch",
      "Human request does not belong to the routed workspace.",
    );
    return false;
  }
  if (routed.projectId && request.projectId !== routed.projectId) {
    sendError(
      ws,
      "human_request_project_mismatch",
      "Human request does not belong to the routed project.",
    );
    return false;
  }

  const response = context.db
    .prepare(
      `SELECT human_request_id AS humanRequestId, answer_json AS answerJson
       FROM human_responses
       WHERE id = ?`,
    )
    .get(routed.humanResponseId) as { humanRequestId: string; answerJson: string } | undefined;
  if (response) {
    if (
      response.humanRequestId !== routed.humanRequestId ||
      !isRecordedRuntimeAnswer(response.answerJson)
    ) {
      sendError(
        ws,
        "human_response_route_mismatch",
        "Human response id is already bound to another response route.",
      );
      return false;
    }
    return true;
  }

  if (request.status !== "pending") {
    sendError(
      ws,
      "human_request_already_resolved",
      "Human request was already resolved by another response.",
    );
    return false;
  }
  return true;
}

function isRecordedRuntimeAnswer(answerJson: string): boolean {
  try {
    const value = JSON.parse(answerJson) as unknown;
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "source" in value &&
      (value.source === "channel" || value.source === "daemon"),
    );
  } catch {
    return false;
  }
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
    recoverUnacknowledgedCommands(context.db, payload.runtimeId, now);
    recoverUnacknowledgedRuntimeControlCommands(context.db, payload.runtimeId, now);
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
    const binding = context.db
      .prepare(
        `SELECT local_path AS localPath
         FROM runtime_workspace_bindings
         WHERE id = ? AND runtime_id = ?
         LIMIT 1`,
      )
      .get(runtimeWorkspaceBindingId, context.runtimeId) as
      | { localPath: string | null }
      | undefined;
    const displayName = resolveWorkspaceDirectoryDisplayName({
      localPath: binding?.localPath,
      displayName: payload.displayName,
    });
    context.db
      .prepare(
        `UPDATE runtime_workspace_bindings
         SET display_name = ?, status = ?, last_snapshot_at = ?, updated_at = ?
         WHERE id = ? AND runtime_id = ?`,
      )
      .run(displayName, payload.status, now, now, runtimeWorkspaceBindingId, context.runtimeId);
    syncWorkspaceIdentityFromLocalPath(context.db, workspaceId, binding?.localPath, now);

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
    `SELECT id, local_path AS localPath
     FROM runtime_workspace_bindings
     WHERE runtime_id = ? AND (local_workspace_key = ? OR id = ?)
     ORDER BY CASE WHEN local_workspace_key = ? THEN 0 ELSE 1 END
     LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, local_path, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE runtime_workspace_bindings
     SET local_workspace_key = ?,
         local_path = COALESCE(?, local_path),
         display_name = ?,
         status = ?,
         capabilities_json = ?,
         diagnostics_json = ?,
         updated_at = ?
     WHERE id = ? AND runtime_id = ?`,
  );
  const ownerWorkspace = db.prepare(
    `SELECT workspace_id AS workspaceId
     FROM workspace_owner_bindings
     WHERE runtime_workspace_binding_id = ? AND ended_at IS NULL
     LIMIT 1`,
  );

  for (const binding of bindings) {
    const existing = findExisting.get(
      runtimeId,
      binding.localWorkspaceKey,
      binding.bindingId,
      binding.localWorkspaceKey,
    ) as { id: string; localPath: string | null } | undefined;
    const localPath = binding.localPath ?? existing?.localPath ?? null;
    const displayName = resolveWorkspaceDirectoryDisplayName({
      localPath,
      displayName: binding.displayName,
    });
    const bindingId = existing?.id ?? binding.bindingId;
    if (existing) {
      update.run(
        binding.localWorkspaceKey,
        binding.localPath ?? null,
        displayName,
        binding.status,
        JSON.stringify(binding.capabilities),
        JSON.stringify(binding.diagnostics),
        now,
        existing.id,
        runtimeId,
      );
    } else {
      insert.run(
        binding.bindingId,
        runtimeId,
        binding.localWorkspaceKey,
        binding.localPath ?? null,
        displayName,
        binding.status,
        JSON.stringify(binding.capabilities),
        JSON.stringify(binding.diagnostics),
        now,
        now,
      );
    }
    const owner = ownerWorkspace.get(bindingId) as { workspaceId: string } | undefined;
    if (owner) {
      syncWorkspaceIdentityFromLocalPath(db, owner.workspaceId, localPath, now);
    }
  }
}

function listWorkspaceBindingAssignments(
  db: DatabaseSync,
  runtimeId: string,
  bindingIds: string[],
) {
  if (bindingIds.length === 0) return [];
  const read = db.prepare(
    `SELECT wob.workspace_id AS workspaceId
     FROM runtime_workspace_bindings rwb
     LEFT JOIN workspace_owner_bindings wob
       ON wob.runtime_workspace_binding_id = rwb.id
      AND wob.ended_at IS NULL
     WHERE rwb.runtime_id = ? AND rwb.id = ?
     LIMIT 1`,
  );
  return bindingIds.map((bindingId) => {
    const owner = read.get(runtimeId, bindingId) as { workspaceId: string | null } | undefined;
    return owner?.workspaceId
      ? { bindingId, state: "bound" as const, workspaceId: owner.workspaceId }
      : { bindingId, state: "unbound" as const };
  });
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
  sessionId?: string;
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

  if (
    envelope.workspaceBindingId &&
    envelope.workspaceId &&
    !bindingOwnsWorkspace(
      context.db,
      context.runtimeId,
      envelope.workspaceBindingId,
      envelope.workspaceId,
    )
  ) {
    sendError(
      ws,
      "workspace_owner_binding_mismatch",
      "Runtime message did not match the active Cockpit workspace owner binding.",
    );
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
    sessionId: envelope.sessionId,
  };
}

function bindingOwnsWorkspace(
  db: DatabaseSync,
  runtimeId: string,
  workspaceBindingId: string,
  workspaceId: string,
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM runtime_workspace_bindings rwb
         JOIN workspace_owner_bindings wob
           ON wob.runtime_workspace_binding_id = rwb.id
          AND wob.ended_at IS NULL
         WHERE rwb.id = ?
           AND rwb.runtime_id = ?
           AND wob.workspace_id = ?
         LIMIT 1`,
      )
      .get(workspaceBindingId, runtimeId, workspaceId),
  );
}

function requireCommandRoutedContext(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
  envelope: RoutedContext,
): {
  routed: NonNullable<ReturnType<typeof requireRoutedContext>>;
  runtimeControl: boolean;
} | null {
  if (!envelope.commandId) {
    sendError(ws, "missing_command_id", "Runtime command response requires commandId.");
    return null;
  }
  const runtimeControl = isRuntimeControlCommand(context.db, context.runtimeId, envelope.commandId);
  const persisted = runtimeControl
    ? requireRuntimeControlCommand(context.db, envelope.commandId)
    : null;
  const routed = requireRoutedContext(ws, context, envelope, {
    workspaceBinding: persisted?.scope === "workspace" || !runtimeControl,
    workspace: persisted?.scope === "workspace" || !runtimeControl,
    command: true,
  });
  if (!routed) return null;

  if (persisted?.sessionId && persisted.sessionId !== envelope.sessionId) {
    sendError(
      ws,
      "command_route_mismatch",
      "Runtime command response omitted or changed its session route.",
    );
    return null;
  }

  if (persisted?.scope === "daemon") {
    if (envelope.workspaceBindingId || envelope.workspaceId || envelope.projectId) {
      sendError(
        ws,
        "command_route_mismatch",
        "Daemon command response included workspace routing.",
      );
      return null;
    }
  } else if (
    persisted &&
    (persisted.runtimeWorkspaceBindingId !== routed.workspaceBindingId ||
      persisted.workspaceId !== routed.workspaceId ||
      (persisted.projectId ?? undefined) !== routed.projectId)
  ) {
    sendError(
      ws,
      "command_route_mismatch",
      "Runtime command response did not match its persisted workspace route.",
    );
    return null;
  }
  return { routed, runtimeControl };
}

function isRuntimeControlCommand(db: DatabaseSync, runtimeId: string, commandId: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM runtime_control_commands WHERE id = ? AND runtime_id = ? LIMIT 1")
      .get(commandId, runtimeId),
  );
}

function flushPendingRuntimeDeliveries(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
): void {
  flushPendingRuntimeControlCommands(ws, context);
  flushPendingCommands(ws, context);
  flushPendingHumanResponses(ws, context);
}

function flushPendingRuntimeControlCommands(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
): void {
  const now = new Date().toISOString();
  for (const { command, payload } of pendingRuntimeControlCommands(
    context.db,
    context.runtimeId,
    10,
  )) {
    const envelope = serializeServerCommandEnvelope({
      runtimeId: context.runtimeId,
      workspaceBindingId: command.runtimeWorkspaceBindingId,
      workspaceId: command.workspaceId,
      projectId: command.projectId,
      sessionId: command.sessionId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sentAt: now,
      payload,
    });
    try {
      ws.send(envelope);
      markRuntimeControlCommandDeliveryAttempt(context.db, {
        commandId: command.commandId,
        runtimeId: context.runtimeId,
        sent: true,
        attemptedAt: now,
      });
    } catch {
      markRuntimeControlCommandDeliveryAttempt(context.db, {
        commandId: command.commandId,
        runtimeId: context.runtimeId,
        sent: false,
        attemptedAt: now,
      });
      return;
    }
  }
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
       JOIN workspace_owner_bindings wob
         ON wob.runtime_workspace_binding_id = rb.id
        AND wob.workspace_id = c.workspace_id
        AND wob.ended_at IS NULL
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
    const envelope = serializeServerCommandEnvelope({
      runtimeId: context.runtimeId,
      workspaceBindingId: row.workspaceBindingId,
      workspaceId: row.workspaceId,
      projectId: row.projectId ?? undefined,
      commandId: row.commandId,
      idempotencyKey: row.idempotencyKey ?? undefined,
      messageId,
      sentAt: now,
      payload: JSON.parse(row.payloadJson) as Parameters<
        typeof createServerCommandEnvelope
      >[0]["payload"],
    });

    try {
      ws.send(envelope);
    } catch {
      context.db
        .prepare(
          `UPDATE command_deliveries
           SET attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(now, now, row.deliveryId);
      return;
    }

    context.db.exec("BEGIN");
    try {
      context.db
        .prepare(
          `UPDATE command_deliveries
           SET status = 'sent', attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(now, now, row.deliveryId);
      context.db
        .prepare(
          "UPDATE commands SET status = 'delivered', updated_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(now, row.commandId);
      context.db.exec("COMMIT");
    } catch (error) {
      context.db.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * A runtime reconnect is the delivery lease boundary. Any command that was
 * written to the previous socket but never acknowledged becomes eligible for
 * at-least-once redelivery with the same stable command id.
 */
function recoverUnacknowledgedCommands(
  db: DatabaseSync,
  runtimeId: string,
  recoveredAt: string,
): void {
  db.prepare(
    `UPDATE command_deliveries
     SET status = 'pending', updated_at = ?
     WHERE status = 'sent'
       AND runtime_workspace_binding_id IN (
         SELECT id FROM runtime_workspace_bindings WHERE runtime_id = ?
       )`,
  ).run(recoveredAt, runtimeId);
  db.prepare(
    `UPDATE commands
     SET status = 'queued', updated_at = ?
     WHERE status = 'delivered'
       AND EXISTS (
         SELECT 1
         FROM command_deliveries cd
         JOIN runtime_workspace_bindings rb ON rb.id = cd.runtime_workspace_binding_id
         WHERE cd.command_id = commands.id
           AND cd.status = 'pending'
           AND rb.runtime_id = ?
       )`,
  ).run(recoveredAt, runtimeId);
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
       JOIN workspace_owner_bindings wob
         ON wob.runtime_workspace_binding_id = rb.id
        AND wob.workspace_id = hreq.workspace_id
        AND wob.ended_at IS NULL
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
      protocolVersion: runtimeProtocolVersion,
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
