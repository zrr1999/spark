import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import WebSocket, { type RawData } from "ws";
import {
  createId,
  humanResponseDeliverEnvelopeSchema,
  parseSparkDaemonEvent,
  runtimeCommandResultEnvelopeSchema,
  runtimeEphemeralSecretResultEnvelopeSchema,
  serverEphemeralSecretRequestEnvelopeSchema,
  runtimeProtocolVersion,
  sparkProtocolJsonObjectSchema,
  runtimeReconcileRequestEnvelopeSchema,
  serverCommandEnvelopeSchema,
  serverHeartbeatAckEnvelopeSchema,
  serverHelloAckEnvelopeSchema,
  type SparkDaemonEvent,
  type SparkJsonObject,
  type RuntimeFeature,
  type RuntimeWorkspaceBindingSummary,
} from "@zendev-lab/spark-protocol";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { type SparkDaemonConfig } from "./config.js";
import type { DaemonChannelIngressRuntime } from "./channels/ingress.ts";
import {
  SparkDaemonInvocationRegistry,
  type SparkDaemonDrainProgress,
  type SparkDaemonEventSink,
  type SparkDaemonHumanInteractionResponder,
  type SparkDaemonTaskExecutor,
} from "./core/index.ts";
import {
  SparkDaemonHumanWaitRegistry,
  type SparkDaemonHumanWaitDeliveryResult,
  type SparkDaemonHumanWaitInput,
  type SparkDaemonHumanWaitRecord,
  type SparkDaemonHumanWaitRegistration,
} from "./core/human-waits.ts";
import type { SparkDaemonModelControl } from "./model-control.ts";
import { executeSparkDaemonEphemeralSecretControl } from "./model-channel-control.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import {
  commandReject,
  commandResult,
  invocationLogChunk,
  invocationUpdated,
  reconcileReport,
  runtimeEnvelope,
  type RouteContext,
} from "./protocol/outbound.js";
import {
  acknowledgeRuntimeCommandTerminalForRoute,
  claimRuntimeCommandReceipt,
  pendingRuntimeCommandTerminalsForRoute,
  recordRuntimeCommandAck,
  recordRuntimeCommandTerminal,
} from "./runtime-command-receipts.ts";
import { runtimeCommandFailure } from "./runtime-command-error.ts";
import { SparkChannelDeliveryStore } from "./store/channel-deliveries.ts";
import {
  SparkInvocationStore,
  type SparkInvocationEvent,
  type SparkInvocationPendingDelivery,
} from "./store/invocations.ts";
import {
  applyCockpitWorkspaceBindingAssignments,
  getWorkspaceById,
  isMutationBlockingBorrowedWorkspace,
  listWorkspaces,
  reconcileWorkspaces,
  reconcileWorkspacesForServer,
  sparkDaemonServerStatusSummaries,
  workspaceBindingBelongsToServer,
} from "./store/workspaces.js";
import type { RunSparkCommandFn, CancelSparkInvocationFn } from "./spark/bridge.js";
import { executeClaimedCommand } from "./claimed-command.ts";
export { startSparkDaemon } from "./daemon-start.ts";

export const sparkDaemonVersion = "0.1.0";

export const sparkDaemonSupportedFeatures: RuntimeFeature[] = [
  "ws-control-v1",
  "multi-workspace-runtime-v1",
  "workspace-snapshot-v1",
  "command-routing-v1",
  "human-request-v1",
  "logs-v1",
  "artifact-ref-v1",
  "artifact-cache-upload-v1",
  "cancellation-v1",
  "reconcile-v1",
  "ephemeral-secret-v1",
];

/**
 * Minimal WebSocket-like surface used by command handlers. Production wires the
 * real `ws` library; tests pass a tiny stub that just records `send` calls.
 */
export interface ServerSocket {
  send(data: string): void;
}

export interface SparkDaemonUplinkControl {
  requestReconfigure(serverUrl?: string): void;
  subscribe(listener: (serverUrl?: string) => void): () => void;
}

export function createSparkDaemonUplinkControl(): SparkDaemonUplinkControl {
  const listeners = new Set<(serverUrl?: string) => void>();
  return {
    requestReconfigure(serverUrl) {
      for (const listener of listeners) listener(serverUrl);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface StartSparkDaemonOptions {
  paths: SparkPaths;
  /** Global Spark provider/auth control root. */
  sparkHome?: string;
  modelControl?: SparkDaemonModelControl;
  sessionRegistry?: DaemonSessionRegistry;
  config: SparkDaemonConfig;
  db: DatabaseSync;
  once?: boolean;
  signal?: AbortSignal;
  /** Immediate restart admission gate: stop accepting/claiming new work. */
  drainSignal?: AbortSignal;
  /** Graceful restart exit gate: exit after already-active work settles. */
  restartSignal?: AbortSignal;
  drainTimeoutMs?: number;
  /**
   * Optional override for Spark-backed command execution. Production callers can
   * leave this unset to use the real Spark runtime bridge; tests inject a fake
   * to assert the streamed envelope sequence without spawning a real role-run.
   */
  runSparkCommand?: RunSparkCommandFn;
  cancelSparkInvocation?: CancelSparkInvocationFn;
  executeInvocation?: SparkDaemonTaskExecutor;
  runScheduler?: boolean;
  schedulerPollIntervalMs?: number;
  schedulerConcurrency?: number;
  invocationTimeoutMs?: number;
  /** Retry delay for the optional Cockpit projection connection. */
  serverReconnectDelayMs?: number;
  /** Uplink-only reconfiguration signal; never stops local execution loops. */
  uplinkControl?: SparkDaemonUplinkControl;
  invocationRegistry?: SparkDaemonInvocationRegistry;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  localEventSink?: SparkDaemonEventSink;
  channelIngress?: DaemonChannelIngressRuntime;
  mailStore?: SparkSessionMailStore;
  notificationReconcileIntervalMs?: number;
  channelDeliveryReconcileIntervalMs?: number;
  /** Bind readiness transport while externally observable work admission is still closed. */
  onReady?: (runtime: {
    channelIngress: DaemonChannelIngressRuntime | null;
    respondHumanInteraction: SparkDaemonHumanInteractionResponder;
    flushHumanRequestOutbox: () => void;
  }) => void | Promise<void>;
  /** Publish process-local execution fences while a restart is draining. */
  onDrainProgress?: (progress: SparkDaemonDrainProgress) => void;
  /** Commit the serving/restart fence after all synchronous admission gates and loops are ready. */
  onServing?: () => void;
  /** Production CLI owns pid publication through lock release. */
  managePidFile?: boolean;
}

export interface MessageContext {
  paths: SparkPaths;
  config: SparkDaemonConfig;
  db: DatabaseSync;
  runtimeId: string;
  serverUrl?: string;
  sparkHome?: string;
  controlSparkHome?: string;
  runtimeSessionId: string | undefined;
  setRuntimeSessionId(value: string): void;
  ensureHeartbeat(intervalMs: number): void;
  runSparkCommand: RunSparkCommandFn;
  cancelSparkInvocation: CancelSparkInvocationFn;
  invocationRegistry?: SparkDaemonInvocationRegistry;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  modelControl?: SparkDaemonModelControl;
  channelIngress?: DaemonChannelIngressRuntime;
  sessionRegistry?: DaemonSessionRegistry;
  onRuntimeReady?(): void;
  onIngestAck?(ackOf: string): void;
}

export function createDaemonHumanWait(
  ws: ServerSocket,
  context: MessageContext,
  input: SparkDaemonHumanWaitInput,
): SparkDaemonHumanWaitRegistration {
  if (!context.humanWaits) {
    throw new Error("Spark daemon human wait registry is not attached.");
  }
  const humanRequestId = input.humanRequestId ?? createId("hreq");
  const envelope = runtimeEnvelope(
    "human.request.created",
    {
      kind: input.kind,
      delivery: input.delivery ?? "blocking",
      interactionRequestId: input.interactionRequestId || undefined,
      sessionId: input.sessionId || undefined,
      toolCallId: input.toolCallId || undefined,
      title: input.title,
      prompt: input.prompt,
      questions: input.questions ?? [],
      context: input.context ?? {},
      contextArtifactRefs: input.contextArtifactRefs ?? [],
    },
    {
      runtimeId: context.runtimeId,
      workspaceBindingId: input.workspaceBindingId || undefined,
      workspaceId: input.workspaceId || undefined,
      projectId: input.projectId || undefined,
      humanRequestId,
      invocationId: input.invocationId || undefined,
    },
  );
  const registration = context.humanWaits.register(
    { ...input, humanRequestId },
    { messageId: envelope.messageId, kind: "human.request.created", envelope },
  );
  if (outboundEnvelopeMatchesServer(context.db, envelope, context.serverUrl ?? null)) {
    sendJson(ws, envelope);
  }
  return registration;
}

export async function handleServerMessage(
  ws: ServerSocket,
  raw: string,
  context: MessageContext,
): Promise<void> {
  const value = JSON.parse(raw) as unknown;

  const helloAck = serverHelloAckEnvelopeSchema.safeParse(value);
  if (helloAck.success) {
    if (context.serverUrl) {
      applyCockpitWorkspaceBindingAssignments(
        context.db,
        context.serverUrl,
        helloAck.data.payload.workspaceBindingAssignments,
      );
    }
    context.setRuntimeSessionId(helloAck.data.payload.runtimeSessionId);
    context.ensureHeartbeat(helloAck.data.payload.heartbeatIntervalMs);
    context.onRuntimeReady?.();
    return;
  }

  const heartbeatAck = serverHeartbeatAckEnvelopeSchema.safeParse(value);
  if (heartbeatAck.success) {
    if (context.serverUrl) {
      applyCockpitWorkspaceBindingAssignments(
        context.db,
        context.serverUrl,
        heartbeatAck.data.payload.workspaceBindingAssignments,
      );
    }
    return;
  }

  if (isServerIngestAck(value)) {
    const route = { runtimeId: context.runtimeId, serverUrl: context.serverUrl ?? null };
    context.humanWaits?.acknowledgeOutboxForRoute(value.ackOf, route);
    acknowledgeRuntimeCommandTerminalForRoute(context.db, value.ackOf, route);
    context.onIngestAck?.(value.ackOf);
    return;
  }

  const ephemeralSecret = serverEphemeralSecretRequestEnvelopeSchema.safeParse(value);
  if (ephemeralSecret.success) {
    await handleEphemeralSecretRequest(ws, ephemeralSecret.data, context);
    return;
  }

  const command = serverCommandEnvelopeSchema.safeParse(value);
  if (command.success) {
    await handleCommand(ws, command.data, context);
    return;
  }

  const humanResponse = humanResponseDeliverEnvelopeSchema.safeParse(value);
  if (humanResponse.success) {
    const wait = humanResponse.data.humanRequestId
      ? context.humanWaits?.get(humanResponse.data.humanRequestId)
      : null;
    const routeFailure = wait
      ? humanResponseRouteFailure(humanResponse.data, wait, context)
      : undefined;
    const delivery: SparkDaemonHumanWaitDeliveryResult = routeFailure
      ? {
          outcome: "unknown_request",
          retryable: false,
          returnedToTool: false,
          message: routeFailure,
        }
      : (context.humanWaits?.deliver({
          humanRequestId: humanResponse.data.humanRequestId,
          humanResponseId: humanResponse.data.humanResponseId,
          status: humanResponse.data.payload.status,
          answers: humanResponse.data.payload.answers,
          responseArtifactRefs: humanResponse.data.payload.responseArtifactRefs,
        }) ?? {
          outcome: "unknown_request",
          retryable: false,
          returnedToTool: false,
          message: "No daemon-owned human wait registry is attached in this Spark daemon slice.",
        });
    sendJson(
      ws,
      runtimeEnvelope(
        "human.response.ack",
        {
          returnedToTool: delivery.returnedToTool,
          outcome: delivery.outcome,
          retryable: delivery.retryable,
          winnerResponseId: delivery.winnerResponseId,
          message: delivery.message,
        },
        {
          runtimeId: context.runtimeId,
          workspaceBindingId: humanResponse.data.workspaceBindingId,
          workspaceId: humanResponse.data.workspaceId,
          projectId: humanResponse.data.projectId,
          humanRequestId: humanResponse.data.humanRequestId,
          humanResponseId: humanResponse.data.humanResponseId,
          ackOf: humanResponse.data.messageId,
          invocationId: delivery.wait?.invocationId || humanResponse.data.invocationId,
        },
      ),
    );
    return;
  }

  const reconcileRequest = runtimeReconcileRequestEnvelopeSchema.safeParse(value);
  if (reconcileRequest.success) {
    sendJson(ws, buildReconcileReport(context));
  }
}

function humanResponseRouteFailure(
  response: ReturnType<typeof humanResponseDeliverEnvelopeSchema.parse>,
  wait: SparkDaemonHumanWaitRecord,
  context: Pick<MessageContext, "db" | "runtimeId" | "serverUrl">,
): string | undefined {
  if (response.runtimeId !== context.runtimeId) {
    return "Human response runtime does not match this daemon uplink.";
  }
  if (
    wait.workspaceBindingId &&
    (!context.serverUrl ||
      !workspaceBindingBelongsToServer(context.db, wait.workspaceBindingId, context.serverUrl) ||
      !daemonWorkspaceRouteMatches(
        context.db,
        wait.workspaceBindingId,
        wait.workspaceId,
        wait.workspaceBindingId,
      ))
  ) {
    return "Human response was delivered through a Cockpit that does not own this wait.";
  }
  if (
    (response.workspaceBindingId ?? "") !== wait.workspaceBindingId ||
    (response.workspaceId ?? "") !== wait.workspaceId ||
    (response.projectId ?? "") !== wait.projectId ||
    (response.invocationId !== undefined && response.invocationId !== wait.invocationId)
  ) {
    return "Human response route does not match the daemon-owned wait.";
  }
  return undefined;
}

async function handleEphemeralSecretRequest(
  ws: ServerSocket,
  request: ReturnType<typeof serverEphemeralSecretRequestEnvelopeSchema.parse>,
  context: MessageContext,
): Promise<void> {
  if (request.runtimeId !== context.runtimeId) {
    sendEphemeralSecretFailure(ws, request, "RUNTIME_ID_MISMATCH");
    return;
  }
  if (request.csrfVerified !== true || !request.actorUserId || !request.browserRequestId) {
    sendEphemeralSecretFailure(ws, request, "SECRET_BROWSER_CONTEXT_INVALID");
    return;
  }
  if (Date.parse(request.expiresAt) <= Date.now()) {
    sendEphemeralSecretFailure(ws, request, "SECRET_REQUEST_EXPIRED");
    return;
  }
  if (request.payload.operation === "channel.configure") {
    const workspace = request.workspaceBindingId
      ? getWorkspaceById(context.db, request.workspaceBindingId)
      : null;
    if (
      !workspace ||
      !context.serverUrl ||
      !workspaceBindingBelongsToServer(context.db, workspace.id, context.serverUrl) ||
      !daemonWorkspaceRouteMatches(
        context.db,
        workspace.id,
        request.workspaceId,
        request.workspaceBindingId,
      ) ||
      request.payload.workspaceId !== request.workspaceId
    ) {
      sendEphemeralSecretFailure(ws, request, "SECRET_ROUTE_INVALID");
      return;
    }
  }

  const result = await executeSparkDaemonEphemeralSecretControl(
    {
      modelControl: context.modelControl,
      channelIngress: context.channelIngress,
      sparkHome: context.sparkHome,
    },
    request.payload,
  );
  sendJson(
    ws,
    runtimeEphemeralSecretResultEnvelopeSchema.parse({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.ephemeral_secret.result",
      sentAt: new Date().toISOString(),
      runtimeId: context.runtimeId,
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      ...(request.workspaceBindingId ? { workspaceBindingId: request.workspaceBindingId } : {}),
      ephemeralRequestId: request.ephemeralRequestId,
      payload: result,
    }),
  );
}

export function daemonWorkspaceRouteMatches(
  db: DatabaseSync,
  localWorkspaceId: string,
  serverWorkspaceId: string | undefined,
  serverBindingId: string | undefined,
): boolean {
  if (!serverWorkspaceId || !serverBindingId) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM daemon_workspaces
         WHERE (id = ? OR server_binding_id = ?)
           AND server_workspace_id = ?
           AND server_binding_id = ?
         LIMIT 1`,
      )
      .get(localWorkspaceId, localWorkspaceId, serverWorkspaceId, serverBindingId),
  );
}

function sendEphemeralSecretFailure(
  ws: ServerSocket,
  request: ReturnType<typeof serverEphemeralSecretRequestEnvelopeSchema.parse>,
  reasonCode: string,
): void {
  sendJson(
    ws,
    runtimeEphemeralSecretResultEnvelopeSchema.parse({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.ephemeral_secret.result",
      sentAt: new Date().toISOString(),
      runtimeId: request.runtimeId,
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      ...(request.workspaceBindingId ? { workspaceBindingId: request.workspaceBindingId } : {}),
      ephemeralRequestId: request.ephemeralRequestId,
      payload: {
        operation: request.payload.operation,
        status: "failed",
        reasonCode,
        message: "Spark daemon rejected the ephemeral secret request.",
        completedAt: new Date().toISOString(),
      },
    }),
  );
}

export async function handleCommand(
  ws: ServerSocket,
  command: ReturnType<typeof serverCommandEnvelopeSchema.parse>,
  context: MessageContext,
): Promise<void> {
  if (command.runtimeId !== context.runtimeId) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "RUNTIME_ID_MISMATCH",
          message: "Command was routed to a different Spark daemon runtime.",
          retryable: false,
        },
        commandRoute(context.runtimeId, command),
      ),
    );
    return;
  }

  if (!command.commandId) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "COMMAND_ID_REQUIRED",
          message: "Runtime command requires a command id.",
          retryable: false,
        },
        commandRoute(context.runtimeId, command),
      ),
    );
    return;
  }
  if (
    command.workspaceBindingId &&
    context.serverUrl &&
    !workspaceBindingBelongsToServer(context.db, command.workspaceBindingId, context.serverUrl)
  ) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "WORKSPACE_ROUTE_MISMATCH",
          message: "Command workspace route does not belong to this Cockpit uplink.",
          retryable: false,
        },
        commandRoute(context.runtimeId, command),
      ),
    );
    return;
  }
  const commandId = command.commandId;
  const claim = claimRuntimeCommandReceipt(context.db, command);
  if (claim.kind === "conflict") {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "COMMAND_REPLAY_CONFLICT",
          message: "Command id was replayed with a different typed payload.",
          retryable: false,
        },
        commandRoute(context.runtimeId, command),
      ),
    );
    return;
  }
  if (claim.kind === "replay") {
    if (claim.ack) sendJson(ws, claim.ack);
    if (claim.terminal) sendJson(ws, markCommandResultReplayed(claim.terminal));
    return;
  }

  const durableSocket = runtimeCommandReceiptSocket(ws, context.db, commandId, claim.claimToken);
  try {
    await executeClaimedCommand(durableSocket, command, context);
  } catch (error) {
    const failure = runtimeCommandFailure(error);
    const failed = commandResult(
      {
        status: "failed",
        result: failure,
        completedAt: new Date().toISOString(),
      },
      commandRoute(context.runtimeId, command),
    );
    durableSocket.send(JSON.stringify(failed));
  }
}

export function workspaceSnapshotPayloadForDaemon(
  db: DatabaseSync,
  workspace: NonNullable<ReturnType<typeof getWorkspaceById>>,
) {
  const mutationBlocked = isMutationBlockingBorrowedWorkspace(db, workspace.id);
  return {
    displayName: workspace.displayName,
    status: workspace.status,
    projects: [],
    unresolvedInboxCount: 0,
    activeInvocationCount: workspace.executor?.activeInvocationCount ?? 0,
    activeAgentCount: workspace.executor?.activeAgentCount ?? 0,
    ...(workspace.borrowed ? { borrowed: workspace.borrowed } : {}),
    workspaceClients: workspace.workspaceClients ?? [],
    ...(workspace.executor ? { executor: workspace.executor } : {}),
    control: {
      mode: mutationBlocked ? ("snapshot_only" as const) : ("full" as const),
      ...(mutationBlocked ? { reason: "borrowed" } : {}),
      serverMutationAllowed: !mutationBlocked,
    },
    latestArtifactIds: [],
    resources: [],
  };
}

export function runtimeEnvelopeForInvocationEvent(
  pending: SparkInvocationPendingDelivery,
  context: {
    store: SparkInvocationStore;
    db: DatabaseSync;
    runtimeId: string;
    serverUrl: string | null;
  },
): ReturnType<typeof runtimeEnvelope> | null {
  let event: SparkDaemonEvent;
  try {
    event = parseSparkDaemonEvent(pending.event.payload);
  } catch {
    return null;
  }
  const route = routeForDaemonEvent(event, context);
  if (!route) {
    console.error(
      `[spark-daemon] dropping unroutable invocation event ${pending.event.kind}; no workspace route was available`,
    );
    return null;
  }
  const messageId = invocationEventMessageId(pending.event);
  if (event.type === "daemon.task.lifecycle") {
    return invocationUpdated(
      {
        runtimeInvocationId: pending.event.invocationId,
        sequence: pending.event.sequence,
        status: event.status,
        ...(event.status === "running" ? { startedAt: event.emittedAt } : {}),
        ...(event.status === "succeeded" ||
        event.status === "failed" ||
        event.status === "cancelled"
          ? { completedAt: event.emittedAt }
          : {}),
        ...(event.summary ? { terminalReason: event.summary } : {}),
        payload: invocationEventMetadata(event),
      },
      route,
      { messageId },
    );
  }
  const assistantDelta = assistantDeltaFromInvocationEvent(pending.event, event, context.store);
  if (assistantDelta !== undefined) {
    return invocationLogChunk(
      {
        runtimeInvocationId: pending.event.invocationId,
        stream: "assistant",
        sequence: pending.event.sequence,
        content: assistantDelta,
        metadata: invocationEventMetadata(event),
      },
      route,
      { messageId },
    );
  }
  return runtimeEnvelope("daemon.event", event, route, { messageId });
}

function invocationEventMessageId(event: SparkInvocationEvent): string {
  const digest = createHash("sha256")
    .update(`${event.invocationId}:${event.sequence}`)
    .digest("hex")
    .slice(0, 32);
  return `msg_${digest}`;
}

function invocationEventMetadata(event: SparkDaemonEvent): SparkJsonObject {
  return {
    ...event.metadata,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    eventType: event.type,
  };
}

function assistantDeltaFromInvocationEvent(
  persisted: SparkInvocationEvent,
  event: SparkDaemonEvent,
  store: SparkInvocationStore,
): string | undefined {
  const current = assistantMessage(event);
  if (!current) return undefined;
  let beforeSequence = persisted.sequence;
  while (beforeSequence > 1) {
    const previous = store.previousEvent(
      persisted.invocationId,
      beforeSequence,
      "daemon.view_event",
    );
    if (!previous) return current.text;
    beforeSequence = previous.sequence;
    try {
      const previousMessage = assistantMessage(parseSparkDaemonEvent(previous.payload));
      if (!previousMessage || previousMessage.id !== current.id) continue;
      return current.text.startsWith(previousMessage.text)
        ? current.text.slice(previousMessage.text.length)
        : current.text;
    } catch {
      continue;
    }
  }
  return current.text;
}

function assistantMessage(event: SparkDaemonEvent): { id: string; text: string } | undefined {
  if (event.type !== "daemon.view_event" || event.view.type !== "session.message") return undefined;
  const message = event.view.message;
  if (message.role !== "assistant" || typeof message.text !== "string") return undefined;
  return { id: message.id, text: message.text };
}

function routeForDaemonEvent(
  event: SparkDaemonEvent,
  context: { db: DatabaseSync; runtimeId: string; serverUrl: string | null },
): RouteContext | null {
  const metadata = event.metadata;
  let workspaceBindingId = stringMetadata(metadata, "workspaceBindingId");
  let workspaceId = event.workspaceId ?? stringMetadata(metadata, "workspaceId");
  if (
    workspaceBindingId &&
    context.serverUrl &&
    !workspaceBindingBelongsToServer(context.db, workspaceBindingId, context.serverUrl)
  ) {
    return null;
  }
  if (!workspaceBindingId || !workspaceId) {
    const inferred = inferDaemonEventWorkspaceRoute(context.db, context.serverUrl, {
      workspaceBindingId,
      workspaceId,
    });
    workspaceBindingId ??= inferred?.workspaceBindingId;
    workspaceId ??= inferred?.workspaceId;
  }
  if (!workspaceBindingId || !workspaceId) {
    return null;
  }
  return {
    runtimeId: context.runtimeId,
    workspaceBindingId,
    workspaceId,
    projectId: event.projectId,
    invocationId: event.invocationId,
    sessionId: event.sessionId,
  };
}

function inferDaemonEventWorkspaceRoute(
  db: DatabaseSync,
  serverUrl: string | null,
  hints: { workspaceBindingId?: string; workspaceId?: string },
): { workspaceBindingId: string; workspaceId: string } | null {
  if (!serverUrl) {
    return null;
  }
  const rows = db
    .prepare(
      `SELECT w.id AS workspaceBindingId,
              dw.server_workspace_id AS workspaceId
       FROM workspaces w
       JOIN daemon_workspaces dw ON dw.id = w.id
       WHERE w.server_url = ?
         AND dw.server_workspace_id IS NOT NULL
         AND (? IS NULL OR w.id = ?)
         AND (? IS NULL OR dw.server_workspace_id = ?)
       ORDER BY w.updated_at DESC
       LIMIT 2`,
    )
    .all(
      serverUrl,
      hints.workspaceBindingId ?? null,
      hints.workspaceBindingId ?? null,
      hints.workspaceId ?? null,
      hints.workspaceId ?? null,
    ) as Array<{ workspaceBindingId: string; workspaceId: string }>;
  return rows.length === 1 ? rows[0]! : null;
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function flushPendingHumanRequests(
  ws: WebSocket,
  waits: SparkDaemonHumanWaitRegistry,
  runtimeId: string,
  serverUrl: string | null,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  for (const entry of waits.listPendingOutboxForRoute({ runtimeId, serverUrl })) {
    sendJson(ws, entry.envelope);
  }
}

function outboundEnvelopeMatchesServer(
  db: DatabaseSync,
  envelope: unknown,
  serverUrl: string | null,
): boolean {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;
  const workspaceBindingId = (envelope as Record<string, unknown>).workspaceBindingId;
  if (typeof workspaceBindingId !== "string" || !workspaceBindingId.trim() || !serverUrl) {
    return true;
  }
  return workspaceBindingBelongsToServer(db, workspaceBindingId, serverUrl);
}

function isServerIngestAck(value: unknown): value is { type: "server.ingest_ack"; ackOf: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "server.ingest_ack" &&
    typeof record.ackOf === "string" &&
    record.ackOf.trim().length > 0
  );
}

export function flushPendingRuntimeCommandTerminals(
  ws: ServerSocket,
  db: DatabaseSync,
  runtimeId: string,
  serverUrl: string | null,
): void {
  for (const terminal of pendingRuntimeCommandTerminalsForRoute(db, { runtimeId, serverUrl })) {
    sendJson(ws, markCommandResultReplayed(terminal));
  }
}

function runtimeCommandReceiptSocket(
  ws: ServerSocket,
  db: DatabaseSync,
  commandId: string,
  claimToken: string,
): ServerSocket {
  return {
    send(data) {
      const value = JSON.parse(data) as { type?: unknown };
      if (value.type === "runtime.command.ack") {
        if (recordRuntimeCommandAck(db, commandId, value, undefined, claimToken)) {
          trySendJsonString(ws, data);
        }
        return;
      }
      if (value.type === "runtime.command.reject") {
        if (
          recordRuntimeCommandTerminal(db, {
            commandId,
            status: "rejected",
            envelope: value,
            claimToken,
          })
        ) {
          trySendJsonString(ws, data);
        }
        return;
      }
      if (value.type === "runtime.command.result") {
        const parsed = runtimeCommandResultEnvelopeSchema.safeParse(value);
        const terminal = parsed.success
          ? parsed.data
          : runtimeCommandResultEnvelopeSchema.parse(
              commandResult(
                {
                  status: "failed",
                  result: {
                    reasonCode: "COMMAND_RESULT_INVALID",
                    message:
                      "Runtime command result exceeded its schema or public payload boundary.",
                  },
                  completedAt: new Date().toISOString(),
                },
                commandRouteFromUnknown(value),
              ),
            );
        if (
          recordRuntimeCommandTerminal(db, {
            commandId,
            status: terminal.payload.status,
            envelope: terminal,
            claimToken,
          })
        ) {
          trySendJsonString(ws, JSON.stringify(terminal));
        }
        return;
      }
      ws.send(data);
    },
  };
}

function trySendJsonString(ws: ServerSocket, data: string): void {
  try {
    ws.send(data);
  } catch {
    // The durable receipt is replayed when this runtime WebSocket reconnects.
  }
}

function markCommandResultReplayed(value: unknown): unknown {
  const parsed = runtimeCommandResultEnvelopeSchema.safeParse(value);
  if (!parsed.success) return value;
  return {
    ...parsed.data,
    payload: { ...parsed.data.payload, replayed: true },
  };
}

export function commandRoute(
  runtimeId: string,
  command: ReturnType<typeof serverCommandEnvelopeSchema.parse>,
): RouteContext {
  return {
    runtimeId,
    workspaceBindingId: command.workspaceBindingId,
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    commandId: command.commandId,
    sessionId: command.sessionId,
    ackOf: command.messageId,
  };
}

function commandRouteFromUnknown(value: unknown): RouteContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime command result route is missing.");
  }
  const route = value as Record<string, unknown>;
  if (typeof route.runtimeId !== "string" || typeof route.commandId !== "string") {
    throw new Error("Runtime command result route is incomplete.");
  }
  return {
    runtimeId: route.runtimeId,
    commandId: route.commandId,
    ...(typeof route.workspaceBindingId === "string"
      ? { workspaceBindingId: route.workspaceBindingId }
      : {}),
    ...(typeof route.workspaceId === "string" ? { workspaceId: route.workspaceId } : {}),
    ...(typeof route.projectId === "string" ? { projectId: route.projectId } : {}),
    ...(typeof route.invocationId === "string" ? { invocationId: route.invocationId } : {}),
    ...(typeof route.sessionId === "string" ? { sessionId: route.sessionId } : {}),
    ...(typeof route.ackOf === "string" ? { ackOf: route.ackOf } : {}),
  };
}

export function daemonStatusProjection(context: MessageContext) {
  const store = new SparkInvocationStore(context.db);
  return sparkProtocolJsonObjectSchema.parse({
    runtimeId: context.runtimeId,
    servers: sparkDaemonServerStatusSummaries(context.db),
    invocations: store.counts(),
    invocationHealth: store.oldestActive(),
    channelDeliveries: new SparkChannelDeliveryStore(context.db).summary(),
    workspaceCount: listWorkspaces(context.db).length,
    observedAt: new Date().toISOString(),
  });
}

export function sendHeartbeat(
  ws: WebSocket,
  db: DatabaseSync,
  runtimeId: string,
  runtimeSessionId: string | undefined,
  serverUrl: string | null,
): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  sendJson(ws, {
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "runtime.heartbeat",
    sentAt: new Date().toISOString(),
    payload: {
      runtimeId,
      runtimeSessionId,
      sequence: Date.now(),
      observedAt: new Date().toISOString(),
      workspaceBindings: serverUrl
        ? reconcileWorkspacesForServer(db, serverUrl).map(workspaceSummary)
        : [],
    },
  });
}

export function buildReconcileReport(context: MessageContext) {
  const activeInvocationCount = context.db
    .prepare("SELECT COUNT(*) AS count FROM invocations WHERE status IN ('queued', 'running')")
    .get() as { count: number };
  const pendingOutboxCount = context.db
    .prepare("SELECT COUNT(*) AS count FROM outbox WHERE status = 'pending'")
    .get() as { count: number };

  return reconcileReport(
    {
      observedAt: new Date().toISOString(),
      workspaceBindings: context.serverUrl
        ? reconcileWorkspacesForServer(context.db, context.serverUrl).map(workspaceSummary)
        : [],
      pendingOutboxCount: pendingOutboxCount.count,
      activeInvocationCount: activeInvocationCount.count,
      activeAgentCount: activeInvocationCount.count,
      artifacts: { availableCount: 0, missingCount: 0 },
      diagnostics: {},
    },
    { runtimeId: context.runtimeId },
  );
}

export function workspaceSummary(
  workspace: ReturnType<typeof reconcileWorkspaces>[number],
): RuntimeWorkspaceBindingSummary {
  return {
    bindingId: workspace.serverBindingId ?? workspace.id,
    localWorkspaceKey: workspace.localWorkspaceKey,
    localPath: workspace.localPath,
    displayName: workspace.displayName,
    status: workspace.status,
    capabilities: workspace.capabilities,
    diagnostics: workspace.diagnostics,
    ...(workspace.borrowed ? { borrowed: workspace.borrowed } : {}),
    workspaceClients: workspace.workspaceClients ?? [],
    ...(workspace.executor ? { executor: workspace.executor } : {}),
  };
}

export function resolveWebSocketUrl(config: SparkDaemonConfig): string {
  if (config.webSocketUrl) {
    return toWebSocketUrl(config.webSocketUrl);
  }
  const runtimeId = requireConfig(config.runtimeId, "runtimeId");
  const serverUrl = requireConfig(config.serverUrl, "serverUrl");
  return toWebSocketUrl(new URL(`/api/v1/runtime/runtimes/${runtimeId}/ws`, serverUrl).toString());
}

export function serverUrlForConfig(config: SparkDaemonConfig): string | null {
  if (config.serverUrl) {
    return new URL(config.serverUrl).toString();
  }
  if (config.webSocketUrl) {
    const url = new URL(config.webSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  return null;
}

export function toWebSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  return url.toString();
}

export function requireConfig(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `Spark daemon config is missing ${name}. Run spark daemon workspace register first.`,
    );
  }
  return value;
}

export function rawDataToText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

export function sendJson(ws: ServerSocket, value: unknown): void {
  ws.send(JSON.stringify(value));
}

export function logDaemonError(runtimeId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[spark-daemon:${runtimeId}] ${message}`);
}
