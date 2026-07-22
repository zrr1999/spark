import {
  createId,
  normalizeServerCommandForExecution,
  serverCommandEnvelopeSchema,
  type SparkCommand,
} from "@zendev-lab/spark-protocol";
import { sparkCommandFromServerCommandEnvelope } from "./command-dispatcher.ts";
import {
  commandRoute,
  daemonStatusProjection,
  daemonWorkspaceRouteMatches,
  sendJson,
  workspaceSnapshotPayloadForDaemon,
  type MessageContext,
  type ServerSocket,
} from "./daemon.ts";
import {
  executeSparkDaemonModelChannelPublicControl,
  isSparkDaemonModelChannelPublicKind,
} from "./model-channel-control.ts";
import type { SparkDaemonModelControl } from "./model-control.ts";
import { decideCommandPolicy } from "./policy.js";
import {
  commandAck,
  commandReject,
  commandResult,
  invocationLogChunk,
  invocationUpdated,
  workspaceSnapshot,
} from "./protocol/outbound.js";
import { executeSparkDaemonSessionControl } from "./session-control.ts";
import { commandRejectForUnknownInvocation } from "./spark/bridge.js";
import {
  attachWorkspaceClient,
  getWorkspaceById,
  heartbeatWorkspaceClient,
  isMutationBlockingBorrowedWorkspace,
  isUserDetachedWorkspace,
  listWorkspaces,
  listWorkspacesForServer,
  releaseWorkspaceClient,
  workspaceSummaries,
} from "./store/workspaces.js";

export async function executeClaimedCommand(
  ws: ServerSocket,
  command: ReturnType<typeof serverCommandEnvelopeSchema.parse>,
  context: MessageContext,
): Promise<void> {
  const knownWorkspaceBindingIds = new Set(
    (context.serverUrl
      ? listWorkspacesForServer(context.db, context.serverUrl)
      : listWorkspaces(context.db)
    ).flatMap((workspace) =>
      workspace.serverBindingId && workspace.serverBindingId !== workspace.id
        ? [workspace.id, workspace.serverBindingId]
        : [workspace.id],
    ),
  );
  const commandWorkspace = command.workspaceBindingId
    ? getWorkspaceById(context.db, command.workspaceBindingId)
    : null;
  const route = commandRoute(context.runtimeId, command);
  if (
    commandWorkspace &&
    !daemonWorkspaceRouteMatches(
      context.db,
      commandWorkspace.id,
      command.workspaceId,
      command.workspaceBindingId,
    )
  ) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "WORKSPACE_ROUTE_MISMATCH",
          message: "Command workspace route does not match this daemon binding.",
          retryable: false,
        },
        route,
      ),
    );
    return;
  }
  let sparkCommand = sparkCommandFromServerCommandEnvelope(command);
  let commandForBridge = command;
  const policy = decideCommandPolicy({
    command: sparkCommand,
    runtimeId: command.runtimeId,
    expectedRuntimeId: context.runtimeId,
    workspaceBindingId: command.workspaceBindingId,
    knownWorkspaceBindingIds,
    allowMutation: true,
    workspaceAccess: commandWorkspace
      ? {
          detached: isUserDetachedWorkspace(commandWorkspace),
          borrowed: isMutationBlockingBorrowedWorkspace(context.db, commandWorkspace.id),
        }
      : undefined,
  });

  if (!policy.accepted) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: policy.reasonCode ?? "COMMAND_REJECTED",
          message: policy.message ?? "Spark daemon rejected the command.",
          retryable: policy.retryable ?? false,
        },
        route,
      ),
    );
    return;
  }

  if (sparkCommand.kind === "daemon.status.request") {
    const completedAt = new Date().toISOString();
    const result = daemonStatusProjection(context);
    sendJson(ws, commandAck({ accepted: true }, route));
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result,
          projection: { kind: "daemon.status", data: result },
          completedAt,
        },
        route,
      ),
    );
    return;
  }

  if (sparkCommand.kind === "workspace.snapshot.request") {
    sendJson(ws, commandAck({ accepted: true }, route));
    const workspace = command.workspaceBindingId
      ? getWorkspaceById(context.db, command.workspaceBindingId)
      : null;
    if (workspace && command.workspaceId) {
      sendJson(
        ws,
        workspaceSnapshot(workspaceSnapshotPayloadForDaemon(context.db, workspace), {
          ...route,
          workspaceBindingId: workspace.serverBindingId ?? workspace.id,
        }),
      );
    }
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result: { refreshed: Boolean(workspace) },
          projection: {
            kind: "workspace.snapshot",
            data: {
              ...(workspace?.id || command.workspaceBindingId
                ? { workspaceBindingId: workspace?.id ?? command.workspaceBindingId }
                : {}),
            },
          },
          completedAt: new Date().toISOString(),
        },
        route,
      ),
    );
    return;
  }

  if (isWorkspaceClientOccupancyKind(sparkCommand.kind)) {
    await handleWorkspaceClientOccupancyCommand({
      ws,
      context,
      command,
      sparkCommand,
      route,
      commandWorkspace,
    });
    return;
  }

  if (isSparkDaemonModelChannelPublicKind(sparkCommand.kind)) {
    const executed = await executeSparkDaemonModelChannelPublicControl(
      {
        modelControl: context.modelControl,
        channelIngress: context.channelIngress,
        sessionRegistry: context.sessionRegistry,
        sparkHome: context.sparkHome,
      },
      {
        kind: sparkCommand.kind,
        scope: command.workspaceBindingId ? "workspace" : "daemon",
        workspaceId: command.workspaceId,
        payload: sparkCommand.payload,
      },
    );
    sendJson(ws, commandAck({ accepted: true }, route));
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result: executed.result,
          ...(executed.projection ? { projection: executed.projection } : {}),
          completedAt: new Date().toISOString(),
        },
        route,
      ),
    );
    return;
  }

  if (isRuntimeSessionControlKind(sparkCommand.kind)) {
    const scope = command.workspaceBindingId ? "workspace" : "daemon";
    const executed = await executeSparkDaemonSessionControl(
      {
        paths: context.paths,
        db: context.db,
        sessionRegistry: context.sessionRegistry,
        modelControl: context.modelControl,
        actor: "spark-daemon-runtime-ws",
      },
      {
        kind: sparkCommand.kind,
        scope,
        workspaceId: command.workspaceId,
        workspaceBindingId: command.workspaceBindingId,
        sessionId: command.sessionId,
        idempotencyKey: command.idempotencyKey,
        payload: sparkCommand.payload,
      },
    );
    const resultRoute = {
      ...route,
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      ...(executed.invocationId ? { invocationId: executed.invocationId } : {}),
    };
    sendJson(
      ws,
      commandAck(
        {
          accepted: true,
          ...(executed.invocationId ? { invocationId: executed.invocationId } : {}),
        },
        resultRoute,
      ),
    );
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result: executed.result,
          ...(executed.projection ? { projection: executed.projection } : {}),
          completedAt: new Date().toISOString(),
        },
        resultRoute,
      ),
    );
    return;
  }

  if (sparkCommand.kind === "diagnostics.request") {
    const invocationId = createId("inv");
    sendJson(ws, commandAck({ accepted: true, invocationId }, { ...route, invocationId }));
    sendJson(
      ws,
      invocationLogChunk(
        {
          runtimeInvocationId: invocationId,
          stream: "system",
          sequence: 1,
          content: JSON.stringify({
            paths: context.paths,
            workspaces: workspaceSummaries(context.db, context.serverUrl),
          }),
        },
        { ...route, invocationId },
      ),
    );
    sendJson(
      ws,
      invocationUpdated(
        {
          runtimeInvocationId: invocationId,
          status: "succeeded",
          completedAt: new Date().toISOString(),
          payload: { commandKind: sparkCommand.kind },
        },
        { ...route, invocationId },
      ),
    );
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result: { invocationId },
          completedAt: new Date().toISOString(),
        },
        { ...route, invocationId },
      ),
    );
    return;
  }

  if (sparkCommand.kind === "invocation.cancel.request") {
    const invocationId = runtimeInvocationIdForCancel(sparkCommand.payload);
    if (!invocationId) {
      sendJson(ws, commandRejectForUnknownInvocation(route, command.messageId));
      return;
    }
    const cancelReason = "Spark daemon invocation cancellation requested by server command.";
    const registryCancelled =
      context.invocationRegistry?.cancel(invocationId, cancelReason) ?? false;
    const result = await context.cancelSparkInvocation({
      invocationId,
      reason: cancelReason,
    });
    if (!result.cancelled && !registryCancelled) {
      sendJson(ws, commandRejectForUnknownInvocation(route, command.messageId));
      return;
    }
    sendJson(ws, commandAck({ accepted: true, invocationId }, { ...route, invocationId }));
    sendJson(
      ws,
      invocationUpdated(
        {
          runtimeInvocationId: invocationId,
          status: "cancelled",
          completedAt: new Date().toISOString(),
          terminalReason: result.cancelled ? result.message : cancelReason,
          payload: { commandKind: sparkCommand.kind },
        },
        { ...route, invocationId },
      ),
    );
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result: { invocationId, cancelled: true, message: result.message },
          completedAt: new Date().toISOString(),
        },
        { ...route, invocationId },
      ),
    );
    return;
  }

  if (
    sparkCommand.kind !== "task.start.request" &&
    sparkCommand.kind !== "assignment.create.request"
  ) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "COMMAND_KIND_UNIMPLEMENTED",
          message: `Spark daemon does not execute ${sparkCommand.kind} yet.`,
          retryable: false,
        },
        route,
      ),
    );
    return;
  }

  if (context.invocationRegistry?.draining) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "DAEMON_DRAINING",
          message: "Spark daemon is draining for restart; retry after the new daemon is ready.",
          retryable: true,
        },
        route,
      ),
    );
    return;
  }

  if (sparkCommand.kind === "assignment.create.request") {
    const normalized = normalizeServerCommandForExecution(command);
    if (!normalized.ok) {
      sendJson(
        ws,
        commandReject(
          {
            reasonCode: normalized.reasonCode,
            message: normalized.message,
            retryable: normalized.retryable,
          },
          route,
        ),
      );
      return;
    }

    commandForBridge = normalized.envelope;
    sparkCommand = sparkCommandFromServerCommandEnvelope(commandForBridge);
  }

  const workspace = command.workspaceBindingId
    ? getWorkspaceById(context.db, command.workspaceBindingId)
    : null;
  if (!workspace) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "UNKNOWN_WORKSPACE_BINDING",
          message: "Spark daemon has no local workspace for this command.",
          retryable: false,
        },
        route,
      ),
    );
    return;
  }

  let selectedModel: Awaited<ReturnType<SparkDaemonModelControl["effectiveModel"]>> | undefined;
  if (context.modelControl) {
    try {
      selectedModel = await context.modelControl.effectiveModel(sessionIdForModel(sparkCommand));
      await context.modelControl.prepareModel(selectedModel);
    } catch (error) {
      sendJson(
        ws,
        commandReject(
          {
            reasonCode: "MODEL_UNAVAILABLE",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
          route,
        ),
      );
      return;
    }
  }

  // Model preparation is asynchronous, so restart draining may have begun
  // after the first admission check above.
  if (context.invocationRegistry?.draining) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "DAEMON_DRAINING",
          message: "Spark daemon is draining for restart; retry after the new daemon is ready.",
          retryable: true,
        },
        route,
      ),
    );
    return;
  }

  const invocation = context.invocationRegistry?.start({
    invocationId: createId("inv"),
    kind: sparkCommand.kind,
  });
  try {
    const result = await context.runSparkCommand({
      command: commandForBridge,
      workspace,
      route: invocation ? { ...route, invocationId: invocation.invocationId } : route,
      paths: context.paths,
      ...(selectedModel ? { model: `${selectedModel.providerName}/${selectedModel.modelId}` } : {}),
      ...((context.controlSparkHome ?? context.sparkHome)
        ? { controlSparkHome: context.controlSparkHome ?? context.sparkHome }
        : {}),
      db: context.db,
      ...(invocation ? { invocationId: invocation.invocationId, signal: invocation.signal } : {}),
      emit(message) {
        sendJson(ws, message);
      },
    });
    sendJson(
      ws,
      commandResult(
        {
          status: result.status === "succeeded" ? "succeeded" : "failed",
          result: {
            invocationId: result.invocationId,
            taskRuntimeId: result.taskRuntimeId,
            status: result.status,
            outputArtifactIds: result.outputArtifactIds,
          },
          completedAt: new Date().toISOString(),
        },
        { ...route, invocationId: result.invocationId },
      ),
    );
  } finally {
    invocation?.finish();
  }
}

function isRuntimeSessionControlKind(
  kind: SparkCommand["kind"],
): kind is Parameters<typeof executeSparkDaemonSessionControl>[1]["kind"] {
  return (
    kind === "session.list.request" ||
    kind === "session.get.request" ||
    kind === "session.snapshot.request" ||
    kind === "session.create.request" ||
    kind === "session.bind.request" ||
    kind === "session.unbind.request" ||
    kind === "session.archive.request" ||
    kind === "turn.submit.request" ||
    kind === "turn.cancel.request" ||
    kind === "turn.status.request" ||
    kind === "turn.stream.subscribe"
  );
}

function isWorkspaceClientOccupancyKind(
  kind: SparkCommand["kind"],
): kind is
  | "workspace.client.attach.request"
  | "workspace.client.heartbeat.request"
  | "workspace.client.release.request" {
  return (
    kind === "workspace.client.attach.request" ||
    kind === "workspace.client.heartbeat.request" ||
    kind === "workspace.client.release.request"
  );
}

async function handleWorkspaceClientOccupancyCommand(input: {
  ws: ServerSocket;
  context: MessageContext;
  command: ReturnType<typeof serverCommandEnvelopeSchema.parse>;
  sparkCommand: SparkCommand;
  route: ReturnType<typeof commandRoute>;
  commandWorkspace: ReturnType<typeof getWorkspaceById>;
}): Promise<void> {
  const { ws, context, command, sparkCommand, route, commandWorkspace } = input;
  if (!commandWorkspace) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "UNKNOWN_WORKSPACE_BINDING",
          message: "Workspace client occupancy requires a known workspace binding.",
          retryable: false,
        },
        route,
      ),
    );
    return;
  }

  try {
    const client =
      sparkCommand.kind === "workspace.client.attach.request"
        ? attachWorkspaceClient(
            context.db,
            parseWorkspaceClientAttachPayload(sparkCommand.payload, commandWorkspace.id),
          )
        : sparkCommand.kind === "workspace.client.heartbeat.request"
          ? heartbeatWorkspaceClient(
              context.db,
              parseWorkspaceClientHeartbeatPayload(sparkCommand.payload),
            )
          : releaseWorkspaceClient(
              context.db,
              parseWorkspaceClientReleasePayload(sparkCommand.payload),
            );

    const refreshed = getWorkspaceById(context.db, commandWorkspace.id);
    sendJson(ws, commandAck({ accepted: true }, route));
    if (refreshed && command.workspaceId) {
      sendJson(
        ws,
        workspaceSnapshot(workspaceSnapshotPayloadForDaemon(context.db, refreshed), {
          ...route,
          workspaceBindingId: refreshed.serverBindingId ?? refreshed.id,
        }),
      );
    }
    sendJson(
      ws,
      commandResult(
        {
          status: "succeeded",
          result: {
            clientId: client.id,
            workspaceId: client.workspaceId,
            kind: client.kind,
            status: client.status,
            ...(client.displayName ? { displayName: client.displayName } : {}),
            attachedAt: client.attachedAt,
            lastSeenAt: client.lastSeenAt,
            ...(client.leaseExpiresAt ? { leaseExpiresAt: client.leaseExpiresAt } : {}),
          },
          completedAt: new Date().toISOString(),
        },
        route,
      ),
    );
  } catch (error) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "WORKSPACE_CLIENT_OCCUPANCY_FAILED",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
        route,
      ),
    );
  }
}

function parseWorkspaceClientAttachPayload(
  payload: Record<string, unknown>,
  workspaceId: string,
): Parameters<typeof attachWorkspaceClient>[1] {
  const kind =
    payload.kind === "interactive" || payload.kind === "headless" || payload.kind === "executor"
      ? payload.kind
      : "interactive";
  const clientId = typeof payload.clientId === "string" ? payload.clientId : undefined;
  const displayName = typeof payload.displayName === "string" ? payload.displayName : undefined;
  const leaseTtlMs =
    typeof payload.leaseTtlMs === "number" && Number.isFinite(payload.leaseTtlMs)
      ? Math.max(0, Math.floor(payload.leaseTtlMs))
      : undefined;
  const baseMetadata =
    typeof payload.metadata === "object" &&
    payload.metadata !== null &&
    !Array.isArray(payload.metadata)
      ? { ...(payload.metadata as Record<string, unknown>) }
      : {};
  const sessionId =
    typeof payload.sessionId === "string" && payload.sessionId.trim()
      ? payload.sessionId.trim()
      : typeof baseMetadata.sessionId === "string" && baseMetadata.sessionId.trim()
        ? baseMetadata.sessionId.trim()
        : (clientId ?? `wcl_${createId("msg").slice(4)}`);
  // Runtime WSS occupancy is always a Cockpit browser session unit.
  const metadata = {
    ...baseMetadata,
    surface: "cockpit",
    sessionId,
  };
  return {
    workspaceId,
    ...(clientId ? { clientId } : { clientId: sessionId }),
    kind,
    ...(displayName ? { displayName } : { displayName: "Cockpit workbench" }),
    ...(leaseTtlMs !== undefined ? { leaseTtlMs } : {}),
    metadata,
  };
}

function parseWorkspaceClientHeartbeatPayload(
  payload: Record<string, unknown>,
): Parameters<typeof heartbeatWorkspaceClient>[1] {
  if (typeof payload.clientId !== "string" || !payload.clientId.trim()) {
    throw new Error("workspace.client.heartbeat.request requires clientId.");
  }
  return {
    clientId: payload.clientId.trim(),
    ...(typeof payload.leaseTtlMs === "number" && Number.isFinite(payload.leaseTtlMs)
      ? { leaseTtlMs: Math.max(0, Math.floor(payload.leaseTtlMs)) }
      : {}),
  };
}

function parseWorkspaceClientReleasePayload(
  payload: Record<string, unknown>,
): Parameters<typeof releaseWorkspaceClient>[1] {
  if (typeof payload.clientId !== "string" || !payload.clientId.trim()) {
    throw new Error("workspace.client.release.request requires clientId.");
  }
  return { clientId: payload.clientId.trim() };
}

function sessionIdForModel(command: SparkCommand): string | undefined {
  if (command.route.sessionId) return command.route.sessionId;
  const target = recordField(command.payload, "target");
  const sessionId = target?.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
}

function recordField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const field = value[key];
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined;
}

function runtimeInvocationIdForCancel(payload: Record<string, unknown> | undefined): string | null {
  const value = payload?.runtimeInvocationId ?? payload?.invocationId;
  return typeof value === "string" && value.startsWith("inv_") ? value : null;
}
