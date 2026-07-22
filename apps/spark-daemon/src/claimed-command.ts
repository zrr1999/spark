import {
  createId,
  normalizeServerCommandForExecution,
  serverCommandEnvelopeSchema,
  type RuntimeCommandResultPayload,
  type SparkCommand,
  type SparkProtocolJsonValue,
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
import { executeSparkDaemonSideThreadControl } from "./side-thread-control.ts";
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

type ClaimedCommand = ReturnType<typeof serverCommandEnvelopeSchema.parse>;

interface ClaimedCommandExecution {
  ws: ServerSocket;
  command: ClaimedCommand;
  context: MessageContext;
  route: ReturnType<typeof commandRoute>;
  commandWorkspace: ReturnType<typeof getWorkspaceById>;
  sparkCommand: SparkCommand;
}

export async function executeClaimedCommand(
  ws: ServerSocket,
  command: ClaimedCommand,
  context: MessageContext,
): Promise<void> {
  const admitted = admitClaimedCommand({ ws, command, context });
  if (!admitted) return;
  await executeAcceptedClaimedCommand(admitted);
}

function admitClaimedCommand(input: {
  ws: ServerSocket;
  command: ClaimedCommand;
  context: MessageContext;
}): ClaimedCommandExecution | undefined {
  const { ws, command, context } = input;
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
  const sparkCommand = sparkCommandFromServerCommandEnvelope(command);
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

  return { ws, command, context, route, commandWorkspace, sparkCommand };
}

async function executeAcceptedClaimedCommand(input: ClaimedCommandExecution): Promise<void> {
  const { sparkCommand } = input;
  switch (sparkCommand.kind) {
    case "daemon.status.request":
      sendDaemonStatusResult(input);
      return;
    case "workspace.snapshot.request":
      sendWorkspaceSnapshotResult(input);
      return;
    case "workspace.client.attach.request":
    case "workspace.client.heartbeat.request":
    case "workspace.client.release.request":
      await handleWorkspaceClientOccupancyCommand(input);
      return;
    case "diagnostics.request":
      sendDiagnosticsResult(input);
      return;
    case "invocation.cancel.request":
      await handleInvocationCancelCommand(input);
      return;
  }

  if (isSparkDaemonModelChannelPublicKind(sparkCommand.kind)) {
    await handleModelChannelCommand(input);
    return;
  }

  if (isRuntimeSessionControlKind(sparkCommand.kind)) {
    await handleRuntimeSessionControlCommand(input);
    return;
  }

  if (isRuntimeSideThreadControlKind(sparkCommand.kind)) {
    await handleRuntimeSideThreadControlCommand(input);
    return;
  }

  await handleTaskOrAssignmentCommand(input);
}

function sendDaemonStatusResult({ ws, context, route }: ClaimedCommandExecution): void {
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
}

function sendWorkspaceSnapshotResult({
  ws,
  command,
  context,
  route,
}: ClaimedCommandExecution): void {
  const workspace = command.workspaceBindingId
    ? getWorkspaceById(context.db, command.workspaceBindingId)
    : null;
  sendJson(ws, commandAck({ accepted: true }, route));
  if (workspace && command.workspaceId) {
    sendJson(
      ws,
      workspaceSnapshot(workspaceSnapshotPayloadForDaemon(context.db, workspace), {
        ...route,
        workspaceBindingId: workspace.serverBindingId ?? workspace.id,
      }),
    );
  }
  const workspaceBindingId = workspace?.id ?? command.workspaceBindingId;
  sendJson(
    ws,
    commandResult(
      {
        status: "succeeded",
        result: { refreshed: Boolean(workspace) },
        projection: {
          kind: "workspace.snapshot",
          data: workspaceBindingId ? { workspaceBindingId } : {},
        },
        completedAt: new Date().toISOString(),
      },
      route,
    ),
  );
}

async function handleModelChannelCommand(input: ClaimedCommandExecution): Promise<void> {
  const { ws, command, context, route, sparkCommand } = input;
  if (!isSparkDaemonModelChannelPublicKind(sparkCommand.kind)) return;
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
}

async function handleRuntimeSessionControlCommand(input: ClaimedCommandExecution): Promise<void> {
  const { ws, command, context, route, sparkCommand } = input;
  if (!isRuntimeSessionControlKind(sparkCommand.kind)) return;
  const executed = await executeSparkDaemonSessionControl(
    daemonSessionControlDependencies(context),
    {
      kind: sparkCommand.kind,
      scope: daemonControlScope(command),
      workspaceId: command.workspaceId,
      workspaceBindingId: command.workspaceBindingId,
      sessionId: command.sessionId,
      idempotencyKey: command.idempotencyKey,
      payload: sparkCommand.payload,
    },
  );
  sendControlledCommandResult({ ws, command, route, executed, includeProjection: true });
}

async function handleRuntimeSideThreadControlCommand(
  input: ClaimedCommandExecution,
): Promise<void> {
  const { ws, command, context, route, sparkCommand } = input;
  if (!isRuntimeSideThreadControlKind(sparkCommand.kind)) return;
  const executed = await executeSparkDaemonSideThreadControl(
    daemonSessionControlDependencies(context),
    {
      kind: sparkCommand.kind,
      scope: daemonControlScope(command),
      workspaceId: command.workspaceId,
      workspaceBindingId: command.workspaceBindingId,
      payload: sparkCommand.payload,
    },
  );
  sendControlledCommandResult({ ws, command, route, executed, includeProjection: false });
}

function daemonSessionControlDependencies(context: MessageContext) {
  return {
    paths: context.paths,
    db: context.db,
    sessionRegistry: context.sessionRegistry,
    modelControl: context.modelControl,
    actor: "spark-daemon-runtime-ws" as const,
  };
}

function daemonControlScope(command: ClaimedCommand): "workspace" | "daemon" {
  return command.workspaceBindingId ? "workspace" : "daemon";
}

function sendControlledCommandResult(input: {
  ws: ServerSocket;
  command: ClaimedCommand;
  route: ReturnType<typeof commandRoute>;
  executed: {
    result: Record<string, SparkProtocolJsonValue>;
    invocationId?: string;
    projection?: RuntimeCommandResultPayload["projection"];
  };
  includeProjection: boolean;
}): void {
  const { ws, command, route, executed, includeProjection } = input;
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
        ...(includeProjection && executed.projection ? { projection: executed.projection } : {}),
        completedAt: new Date().toISOString(),
      },
      resultRoute,
    ),
  );
}

function sendDiagnosticsResult({
  ws,
  context,
  route,
  sparkCommand,
}: ClaimedCommandExecution): void {
  const invocationId = createId("inv");
  const invocationRoute = { ...route, invocationId };
  sendJson(ws, commandAck({ accepted: true, invocationId }, invocationRoute));
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
      invocationRoute,
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
      invocationRoute,
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
      invocationRoute,
    ),
  );
}

async function handleInvocationCancelCommand(input: ClaimedCommandExecution): Promise<void> {
  const { ws, command, context, route, sparkCommand } = input;
  const invocationId = runtimeInvocationIdForCancel(sparkCommand.payload);
  if (!invocationId) {
    sendJson(ws, commandRejectForUnknownInvocation(route, command.messageId));
    return;
  }
  const cancelReason = "Spark daemon invocation cancellation requested by server command.";
  const registryCancelled = context.invocationRegistry?.cancel(invocationId, cancelReason) ?? false;
  const result = await context.cancelSparkInvocation({ invocationId, reason: cancelReason });
  if (!result.cancelled && !registryCancelled) {
    sendJson(ws, commandRejectForUnknownInvocation(route, command.messageId));
    return;
  }
  const invocationRoute = { ...route, invocationId };
  sendJson(ws, commandAck({ accepted: true, invocationId }, invocationRoute));
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
      invocationRoute,
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
      invocationRoute,
    ),
  );
}

async function handleTaskOrAssignmentCommand(input: ClaimedCommandExecution): Promise<void> {
  const { ws, command, context, route } = input;
  const commandForBridge = normalizeTaskCommandForExecution(input);
  if (!commandForBridge) return;
  const sparkCommand = sparkCommandFromServerCommandEnvelope(commandForBridge);
  if (isDaemonDraining(context)) {
    sendDaemonDrainingReject(ws, route);
    return;
  }
  const workspace = command.workspaceBindingId
    ? getWorkspaceById(context.db, command.workspaceBindingId)
    : null;
  if (!workspace) {
    sendUnknownWorkspaceReject(ws, route);
    return;
  }
  const selectedModel = await prepareTaskModel(input, sparkCommand);
  if (selectedModel === null) return;
  // Model preparation is asynchronous, so restart draining may have begun after admission.
  if (isDaemonDraining(context)) {
    sendDaemonDrainingReject(ws, route);
    return;
  }
  await runTaskCommand({
    ws,
    context,
    commandForBridge,
    sparkCommand,
    workspace,
    route,
    selectedModel,
  });
}

function normalizeTaskCommandForExecution(
  input: ClaimedCommandExecution,
): ClaimedCommand | undefined {
  const { ws, command, route, sparkCommand } = input;
  if (sparkCommand.kind === "task.start.request") return command;
  if (sparkCommand.kind !== "assignment.create.request") {
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
    return undefined;
  }
  const normalized = normalizeServerCommandForExecution(command);
  if (normalized.ok) return normalized.envelope;
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
  return undefined;
}

function isDaemonDraining(context: MessageContext): boolean {
  return context.invocationRegistry?.draining === true;
}

function sendDaemonDrainingReject(ws: ServerSocket, route: ReturnType<typeof commandRoute>): void {
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
}

function sendUnknownWorkspaceReject(
  ws: ServerSocket,
  route: ReturnType<typeof commandRoute>,
): void {
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
}

async function prepareTaskModel(
  input: ClaimedCommandExecution,
  sparkCommand: SparkCommand,
): Promise<Awaited<ReturnType<SparkDaemonModelControl["effectiveModel"]>> | null | undefined> {
  const { ws, context, route } = input;
  if (!context.modelControl) return undefined;
  try {
    const model = await context.modelControl.effectiveModel(sessionIdForModel(sparkCommand));
    await context.modelControl.prepareModel(model);
    return model;
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
    return null;
  }
}

async function runTaskCommand(input: {
  ws: ServerSocket;
  context: MessageContext;
  commandForBridge: ClaimedCommand;
  sparkCommand: SparkCommand;
  workspace: NonNullable<ReturnType<typeof getWorkspaceById>>;
  route: ReturnType<typeof commandRoute>;
  selectedModel: Awaited<ReturnType<SparkDaemonModelControl["effectiveModel"]>> | undefined;
}): Promise<void> {
  const { ws, context, commandForBridge, sparkCommand, workspace, route, selectedModel } = input;
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

function isRuntimeSideThreadControlKind(
  kind: SparkCommand["kind"],
): kind is Parameters<typeof executeSparkDaemonSideThreadControl>[1]["kind"] {
  return (
    kind === "side-thread.ensure.request" ||
    kind === "side-thread.snapshot.request" ||
    kind === "side-thread.submit.request" ||
    kind === "side-thread.reset.request" ||
    kind === "side-thread.configure.request" ||
    kind === "side-thread.handoff.request"
  );
}

async function handleWorkspaceClientOccupancyCommand(
  input: ClaimedCommandExecution,
): Promise<void> {
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
    const client = applyWorkspaceClientOccupancyCommand(context, commandWorkspace.id, sparkCommand);

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

function applyWorkspaceClientOccupancyCommand(
  context: MessageContext,
  workspaceId: string,
  sparkCommand: SparkCommand,
) {
  switch (sparkCommand.kind) {
    case "workspace.client.attach.request":
      return attachWorkspaceClient(
        context.db,
        parseWorkspaceClientAttachPayload(sparkCommand.payload, workspaceId),
      );
    case "workspace.client.heartbeat.request":
      return heartbeatWorkspaceClient(
        context.db,
        parseWorkspaceClientHeartbeatPayload(sparkCommand.payload),
      );
    case "workspace.client.release.request":
      return releaseWorkspaceClient(
        context.db,
        parseWorkspaceClientReleasePayload(sparkCommand.payload),
      );
    default:
      throw new Error(`Unsupported workspace client occupancy command: ${sparkCommand.kind}`);
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
  const sessionId = workspaceClientSessionId(payload, baseMetadata, clientId);
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

function workspaceClientSessionId(
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
  clientId: string | undefined,
): string {
  const explicitSessionId = trimmedString(payload.sessionId);
  if (explicitSessionId) return explicitSessionId;
  const metadataSessionId = trimmedString(metadata.sessionId);
  if (metadataSessionId) return metadataSessionId;
  return clientId ?? `wcl_${createId("msg").slice(4)}`;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
