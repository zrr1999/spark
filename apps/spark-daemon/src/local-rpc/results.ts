import { SPARK_PROTOCOL_VERSION, sparkTurnSubmitResultSchema } from "@zendev-lab/spark-protocol";
import type { DaemonChannelIngressStatus } from "../channels/ingress.ts";
import type { SparkDaemonLifecycleSnapshot } from "../core/index.ts";
import type { SparkChannelDeliverySummary } from "../store/channel-deliveries.ts";
import { RegistrationGrantRefusedError } from "../registration.js";
import {
  WorkspacePathConflictError,
  type SparkDaemonWorkspace,
  type SparkDaemonWorkspaceClient,
} from "../store/workspaces.js";
import { isRecord } from "./is-record.ts";
import type {
  LocalDaemonRestartResult,
  LocalDaemonStatusResult,
  LocalDaemonStopResult,
  LocalTurnSubmitResult,
  LocalWorkspaceClientResult,
  WorkspaceListResult,
} from "./types.ts";

export function localRpcResponseError(value: unknown): Error {
  const message =
    isRecord(value) && typeof value.message === "string" ? value.message : "Local RPC failed.";
  const code =
    isRecord(value) && value.code === "workspace_path_conflict"
      ? value.code
      : isRecord(value) && value.code === "registration_grant_refused"
        ? value.code
        : undefined;
  const kind =
    isRecord(value) &&
    (value.kind === "same-path" || value.kind === "same-key" || value.kind === "nested")
      ? value.kind
      : undefined;
  if (code === "workspace_path_conflict" && kind) {
    return new WorkspacePathConflictError(message, kind);
  }
  if (code === "registration_grant_refused") {
    return new RegistrationGrantRefusedError(message);
  }
  return new Error(message);
}

export function workspaceList(value: unknown): WorkspaceListResult {
  if (!isRecord(value) || !Array.isArray(value.workspaces)) {
    throw new Error("Invalid local RPC workspace list result.");
  }
  return {
    workspaces: value.workspaces.map(sparkDaemonWorkspace),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
  };
}

export function daemonStatus(value: unknown): LocalDaemonStatusResult {
  if (!isRecord(value) || !Array.isArray(value.servers)) {
    throw new Error("Invalid local RPC daemon status result.");
  }
  return {
    servers: value.servers.map(daemonServerSummary),
    invocations: invocationCountsResult(value.invocations),
    invocationHealth: invocationHealthResult(value.invocationHealth),
    channelDeliveries: channelDeliverySummary(value.channelDeliveries),
    lifecycle: parseSparkDaemonLifecycleSnapshot(value.lifecycle),
    ...(typeof value.buildFingerprint === "string"
      ? { buildFingerprint: value.buildFingerprint }
      : {}),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
  };
}

export function channelDeliverySummary(value: unknown): SparkChannelDeliverySummary {
  if (!isRecord(value)) return { pending: 0, retrying: 0, inFlight: 0, delivered: 0, uncertain: 0 };
  return {
    pending: typeof value.pending === "number" ? value.pending : 0,
    retrying: typeof value.retrying === "number" ? value.retrying : 0,
    inFlight: typeof value.inFlight === "number" ? value.inFlight : 0,
    delivered: typeof value.delivered === "number" ? value.delivered : 0,
    uncertain: typeof value.uncertain === "number" ? value.uncertain : 0,
    ...(typeof value.oldestPendingAt === "string"
      ? { oldestPendingAt: value.oldestPendingAt }
      : {}),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
    ...(typeof value.lastErrorAt === "string" ? { lastErrorAt: value.lastErrorAt } : {}),
  };
}

export function parseSparkDaemonLifecycleSnapshot(value: unknown): SparkDaemonLifecycleSnapshot {
  if (
    !isRecord(value) ||
    (value.state !== "starting" &&
      value.state !== "running" &&
      value.state !== "draining" &&
      value.state !== "stopping")
  ) {
    throw new Error("Invalid local RPC daemon lifecycle result.");
  }
  const processIdentity = isRecord(value.process) ? value.process : undefined;
  const validProcessIdentity =
    processIdentity &&
    Number.isInteger(processIdentity.pid) &&
    Number(processIdentity.pid) > 0 &&
    typeof processIdentity.instanceId === "string" &&
    processIdentity.instanceId.length > 0 &&
    typeof processIdentity.generation === "string" &&
    processIdentity.generation.length > 0 &&
    processIdentity.protocolVersion === SPARK_PROTOCOL_VERSION &&
    typeof processIdentity.startedAt === "string";
  if (value.process !== undefined && !validProcessIdentity) {
    throw new Error("Invalid local RPC daemon process identity.");
  }
  const phase = isSparkDaemonLifecyclePhase(value.phase) ? value.phase : undefined;
  if (value.phase !== undefined && !phase) {
    throw new Error("Invalid local RPC daemon lifecycle phase.");
  }
  const drain = daemonDrainProgress(value.drain);
  return {
    state: value.state,
    ...(phase ? { phase } : {}),
    ...(validProcessIdentity
      ? {
          process: {
            pid: Number(processIdentity.pid),
            instanceId: processIdentity.instanceId as string,
            generation: processIdentity.generation as string,
            protocolVersion: SPARK_PROTOCOL_VERSION,
            startedAt: processIdentity.startedAt as string,
            ...(typeof processIdentity.acceptedRestartId === "string"
              ? { acceptedRestartId: processIdentity.acceptedRestartId }
              : {}),
            ...(typeof processIdentity.predecessorInstanceId === "string"
              ? { predecessorInstanceId: processIdentity.predecessorInstanceId }
              : {}),
            ...(typeof processIdentity.predecessorGeneration === "string"
              ? { predecessorGeneration: processIdentity.predecessorGeneration }
              : {}),
          },
        }
      : {}),
    ...(typeof value.restartId === "string" ? { restartId: value.restartId } : {}),
    ...(typeof value.targetInstanceId === "string"
      ? { targetInstanceId: value.targetInstanceId }
      : {}),
    ...(typeof value.targetGeneration === "string"
      ? { targetGeneration: value.targetGeneration }
      : {}),
    ...(typeof value.restartRequestedAt === "string"
      ? { restartRequestedAt: value.restartRequestedAt }
      : {}),
    ...(drain ? { drain } : {}),
    ...(typeof value.stopRequestedAt === "string"
      ? { stopRequestedAt: value.stopRequestedAt }
      : {}),
    ...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}),
  };
}

export function isSparkDaemonLifecyclePhase(
  value: unknown,
): value is NonNullable<SparkDaemonLifecycleSnapshot["phase"]> {
  return (
    value === "initializing" ||
    value === "serving" ||
    value === "draining-active-work" ||
    value === "draining-channel-ingress" ||
    value === "stopping"
  );
}

export function daemonDrainProgress(value: unknown): SparkDaemonLifecycleSnapshot["drain"] {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.observedAt !== "string" ||
    value.observedAt.length === 0 ||
    !Array.isArray(value.scheduler) ||
    !Array.isArray(value.direct) ||
    (value.stage !== undefined &&
      value.stage !== "active-work" &&
      value.stage !== "channel-ingress")
  ) {
    throw new Error("Invalid local RPC daemon drain progress.");
  }
  const work = (entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.invocationId !== "string" ||
      entry.invocationId.length === 0 ||
      typeof entry.kind !== "string" ||
      entry.kind.length === 0 ||
      typeof entry.startedAt !== "string" ||
      entry.startedAt.length === 0 ||
      (entry.sessionId !== undefined &&
        (typeof entry.sessionId !== "string" || entry.sessionId.length === 0))
    ) {
      throw new Error("Invalid local RPC daemon drain work item.");
    }
    return {
      invocationId: entry.invocationId,
      kind: entry.kind,
      startedAt: entry.startedAt,
      ...(typeof entry.sessionId === "string" ? { sessionId: entry.sessionId } : {}),
    };
  };
  return {
    observedAt: value.observedAt,
    // Old daemons did not publish a stage. Treat only that precise omission as
    // the compatible active-work phase; malformed explicit values fail closed.
    stage: value.stage === "channel-ingress" ? "channel-ingress" : "active-work",
    scheduler: value.scheduler.map(work),
    direct: value.direct.map(work),
  };
}

export function channelIngressStatus(value: unknown): DaemonChannelIngressStatus {
  if (
    !isRecord(value) ||
    value.plane !== "daemon" ||
    value.resource !== "channel" ||
    value.available !== true ||
    typeof value.workspaceId !== "string" ||
    typeof value.configPath !== "string" ||
    typeof value.configured !== "boolean" ||
    typeof value.ingressEnabled !== "boolean" ||
    !isChannelRuntimeState(value.state) ||
    !Array.isArray(value.adapters) ||
    !Array.isArray(value.routes) ||
    typeof value.text !== "string"
  ) {
    throw new Error("Invalid local RPC channel status result.");
  }
  return {
    plane: "daemon",
    resource: "channel",
    workspaceId: value.workspaceId,
    configPath: value.configPath,
    available: true,
    configured: value.configured,
    ingressEnabled: value.ingressEnabled,
    state: value.state,
    adapters: value.adapters.map((adapter) => channelAdapterStatus(adapter)),
    routes: value.routes.map((route) => channelRouteStatus(route)),
    ...(typeof value.lastReloadedAt === "string" ? { lastReloadedAt: value.lastReloadedAt } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
    text: value.text,
  };
}

export function isChannelRuntimeState(
  value: unknown,
): value is DaemonChannelIngressStatus["state"] {
  return (
    value === "unconfigured" || value === "running" || value === "stopped" || value === "degraded"
  );
}

export function channelAdapterStatus(
  value: unknown,
): DaemonChannelIngressStatus["adapters"][number] {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    typeof value.running !== "boolean"
  ) {
    throw new Error("Invalid local RPC channel adapter status.");
  }
  const state = isChannelConnectionState(value.state)
    ? value.state
    : value.running
      ? "connected"
      : "stopped";
  return {
    id: value.id,
    type: value.type,
    running: value.running,
    state,
    ...(typeof value.error === "string" && value.error.trim() ? { error: value.error } : {}),
  };
}

export function isChannelConnectionState(
  value: unknown,
): value is DaemonChannelIngressStatus["adapters"][number]["state"] {
  return (
    value === "stopped" ||
    value === "connecting" ||
    value === "connected" ||
    value === "reconnecting" ||
    value === "degraded"
  );
}

export function channelRouteStatus(value: unknown): DaemonChannelIngressStatus["routes"][number] {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.adapter !== "string" ||
    typeof value.recipient !== "string"
  ) {
    throw new Error("Invalid local RPC channel route status.");
  }
  return { name: value.name, adapter: value.adapter, recipient: value.recipient };
}

export function turnSubmit(value: unknown): LocalTurnSubmitResult {
  return sparkTurnSubmitResultSchema.parse(value);
}

export function daemonStop(value: unknown): LocalDaemonStopResult {
  if (!isRecord(value) || value.stopping !== true) {
    throw new Error("Invalid local RPC daemon stop result.");
  }
  return {
    stopping: true,
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
  };
}

export function daemonRestart(value: unknown): LocalDaemonRestartResult {
  if (
    !isRecord(value) ||
    value.accepted !== true ||
    value.state !== "draining" ||
    typeof value.restartId !== "string" ||
    typeof value.processInstanceId !== "string" ||
    typeof value.processGeneration !== "string" ||
    typeof value.targetInstanceId !== "string" ||
    typeof value.targetGeneration !== "string" ||
    typeof value.requestedAt !== "string"
  ) {
    throw new Error("Invalid local RPC daemon restart result.");
  }
  return {
    accepted: true,
    state: "draining",
    restartId: value.restartId,
    processInstanceId: value.processInstanceId,
    processGeneration: value.processGeneration,
    targetInstanceId: value.targetInstanceId,
    targetGeneration: value.targetGeneration,
    requestedAt: value.requestedAt,
  };
}

export function localWorkspaceClientResult(value: unknown): LocalWorkspaceClientResult {
  if (!isRecord(value) || !isRecord(value.client)) {
    throw new Error("Invalid local RPC workspace client result.");
  }
  return {
    client: sparkDaemonWorkspaceClient(value.client),
    workspace: sparkDaemonWorkspace(value.workspace),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
  };
}

export function invocationCountsResult(value: unknown): LocalDaemonStatusResult["invocations"] {
  if (!isRecord(value)) {
    return { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  }
  return {
    queued: typeof value.queued === "number" ? value.queued : 0,
    running: typeof value.running === "number" ? value.running : 0,
    succeeded: typeof value.succeeded === "number" ? value.succeeded : 0,
    failed: typeof value.failed === "number" ? value.failed : 0,
    cancelled: typeof value.cancelled === "number" ? value.cancelled : 0,
  };
}

export function invocationHealthResult(
  value: unknown,
): LocalDaemonStatusResult["invocationHealth"] {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.oldestQueuedAt === "string" ? { oldestQueuedAt: value.oldestQueuedAt } : {}),
    ...(typeof value.oldestRunningAt === "string"
      ? { oldestRunningAt: value.oldestRunningAt }
      : {}),
  };
}

export function daemonServerSummary(value: unknown): LocalDaemonStatusResult["servers"][number] {
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    typeof value.workspaceCount !== "number" ||
    typeof value.wsConnected !== "boolean"
  ) {
    throw new Error("Invalid local RPC daemon server summary.");
  }
  return {
    url: value.url,
    workspaceCount: value.workspaceCount,
    wsConnected: value.wsConnected,
    ...(typeof value.lastHeartbeatAt === "string"
      ? { lastHeartbeatAt: value.lastHeartbeatAt }
      : {}),
    ...(typeof value.lastDisconnectReason === "string"
      ? { lastDisconnectReason: value.lastDisconnectReason }
      : {}),
  };
}

export function sparkDaemonWorkspace(value: unknown): SparkDaemonWorkspace {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.serverUrl !== "string" ||
    typeof value.localWorkspaceKey !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.localPath !== "string" ||
    !isWorkspaceStatus(value.status) ||
    !isRecord(value.capabilities) ||
    !isRecord(value.diagnostics) ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Invalid local RPC workspace result.");
  }

  const workspace: SparkDaemonWorkspace = {
    id: value.id,
    ...(typeof value.serverWorkspaceId === "string"
      ? { serverWorkspaceId: value.serverWorkspaceId }
      : {}),
    ...(typeof value.serverBindingId === "string"
      ? { serverBindingId: value.serverBindingId }
      : {}),
    ...(value.cockpitBindingState === "bound" || value.cockpitBindingState === "unbound"
      ? { cockpitBindingState: value.cockpitBindingState }
      : {}),
    serverUrl: value.serverUrl,
    localWorkspaceKey: value.localWorkspaceKey,
    displayName: value.displayName,
    localPath: value.localPath,
    status: value.status,
    capabilities: value.capabilities,
    diagnostics: value.diagnostics,
    ...(isRecord(value.borrowed)
      ? {
          borrowed: parseBorrowedState(value.borrowed),
        }
      : {}),
    ...(Array.isArray(value.workspaceClients)
      ? { workspaceClients: value.workspaceClients.map(workspaceClientProjection) }
      : {}),
    ...(isRecord(value.executor)
      ? {
          executor: {
            state:
              value.executor.state === "starting" ||
              value.executor.state === "online" ||
              value.executor.state === "unhealthy"
                ? value.executor.state
                : "none",
            ...(typeof value.executor.clientId === "string"
              ? { clientId: value.executor.clientId }
              : {}),
            activeInvocationCount:
              typeof value.executor.activeInvocationCount === "number"
                ? value.executor.activeInvocationCount
                : 0,
            activeAgentCount:
              typeof value.executor.activeAgentCount === "number"
                ? value.executor.activeAgentCount
                : 0,
            ...(typeof value.executor.lastSeenAt === "string"
              ? { lastSeenAt: value.executor.lastSeenAt }
              : {}),
            ...(typeof value.executor.unhealthyReason === "string"
              ? { unhealthyReason: value.executor.unhealthyReason }
              : {}),
          },
        }
      : {}),
    ...(typeof value.sessionCount === "number" ? { sessionCount: value.sessionCount } : {}),
    ...(typeof value.lastSessionAt === "string" ? { lastSessionAt: value.lastSessionAt } : {}),
    ...(isRecord(value.workspaceAuthorization) &&
    typeof value.workspaceAuthorization.workspaceId === "string" &&
    typeof value.workspaceAuthorization.workspaceSlug === "string" &&
    typeof value.workspaceAuthorization.oneTimeToken === "string" &&
    typeof value.workspaceAuthorization.expiresAt === "string"
      ? {
          workspaceAuthorization: {
            workspaceId: value.workspaceAuthorization.workspaceId,
            workspaceSlug: value.workspaceAuthorization.workspaceSlug,
            oneTimeToken: value.workspaceAuthorization.oneTimeToken,
            expiresAt: value.workspaceAuthorization.expiresAt,
          },
        }
      : {}),
    ...(Array.isArray(value.recentSessions)
      ? { recentSessions: value.recentSessions.map(sparkDaemonWorkspaceRecentSession) }
      : {}),
    updatedAt: value.updatedAt,
  };
  const profile = workspaceProfile(value.profile);
  return profile ? { ...workspace, profile } : workspace;
}

export function parseBorrowedState(
  value: Record<string, unknown>,
): NonNullable<SparkDaemonWorkspace["borrowed"]> {
  const borrowedByClientIds = Array.isArray(value.borrowedByClientIds)
    ? value.borrowedByClientIds.filter(
        (clientId): clientId is string => typeof clientId === "string",
      )
    : [];
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.flatMap((item): NonNullable<SparkDaemonWorkspace["borrowed"]>["sessions"] => {
        if (!isRecord(item)) return [];
        const clientId = typeof item.clientId === "string" ? item.clientId : null;
        const sessionId =
          typeof item.sessionId === "string" && item.sessionId.trim()
            ? item.sessionId.trim()
            : clientId;
        if (!clientId || !sessionId) return [];
        const surface =
          item.surface === "tui" || item.surface === "cockpit" || item.surface === "unknown"
            ? item.surface
            : ("tui" as const);
        const kind =
          item.kind === "interactive" || item.kind === "headless" || item.kind === "executor"
            ? item.kind
            : ("interactive" as const);
        return [
          {
            sessionId,
            clientId,
            kind,
            surface,
            ...(typeof item.displayName === "string" ? { displayName: item.displayName } : {}),
            ...(typeof item.attachedAt === "string" ? { attachedAt: item.attachedAt } : {}),
            ...(typeof item.lastSeenAt === "string" ? { lastSeenAt: item.lastSeenAt } : {}),
            ...(typeof item.leaseExpiresAt === "string"
              ? { leaseExpiresAt: item.leaseExpiresAt }
              : {}),
          },
        ];
      })
    : borrowedByClientIds.map((clientId) => ({
        sessionId: clientId,
        clientId,
        kind: "interactive" as const,
        surface: "tui" as const,
      }));
  const occupied =
    value.occupied === true ||
    value.borrowed === true ||
    sessions.length > 0 ||
    borrowedByClientIds.length > 0;
  return {
    borrowed: occupied,
    occupied,
    interactiveClientCount:
      typeof value.interactiveClientCount === "number"
        ? value.interactiveClientCount
        : sessions.length,
    borrowedByClientIds,
    sessions,
    ...(typeof value.since === "string" ? { since: value.since } : {}),
  };
}

export function sparkDaemonWorkspaceClient(value: unknown): SparkDaemonWorkspaceClient {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    (value.kind !== "interactive" && value.kind !== "headless" && value.kind !== "executor") ||
    (value.status !== "connected" && value.status !== "disconnected") ||
    typeof value.attachedAt !== "string" ||
    typeof value.lastSeenAt !== "string"
  ) {
    throw new Error("Invalid local RPC workspace client.");
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    kind: value.kind,
    ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
    status: value.status,
    attachedAt: value.attachedAt,
    lastSeenAt: value.lastSeenAt,
    ...(typeof value.leaseExpiresAt === "string" ? { leaseExpiresAt: value.leaseExpiresAt } : {}),
    ...(typeof value.releasedAt === "string" ? { releasedAt: value.releasedAt } : {}),
    metadata: isRecord(value.metadata) ? value.metadata : {},
  };
}

export function workspaceClientProjection(
  value: unknown,
): NonNullable<SparkDaemonWorkspace["workspaceClients"]>[number] {
  if (
    !isRecord(value) ||
    typeof value.clientId !== "string" ||
    (value.kind !== "interactive" && value.kind !== "headless" && value.kind !== "executor") ||
    (value.status !== "connected" && value.status !== "disconnected")
  ) {
    throw new Error("Invalid local RPC workspace client projection.");
  }
  return {
    clientId: value.clientId,
    kind: value.kind,
    status: value.status,
    ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
    ...(value.surface === "tui" || value.surface === "cockpit" || value.surface === "unknown"
      ? { surface: value.surface }
      : {}),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(typeof value.attachedAt === "string" ? { attachedAt: value.attachedAt } : {}),
    ...(typeof value.lastSeenAt === "string" ? { lastSeenAt: value.lastSeenAt } : {}),
    ...(typeof value.leaseExpiresAt === "string" ? { leaseExpiresAt: value.leaseExpiresAt } : {}),
  };
}

export function sparkDaemonWorkspaceRecentSession(
  value: unknown,
): NonNullable<SparkDaemonWorkspace["recentSessions"]>[number] {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.project !== "string" ||
    typeof value.model !== "string" ||
    typeof value.lastActivityAt !== "string" ||
    typeof value.state !== "string"
  ) {
    throw new Error("Invalid local RPC workspace recent session.");
  }
  return {
    id: value.id,
    project: value.project,
    model: value.model,
    lastActivityAt: value.lastActivityAt,
    state: value.state,
  };
}

export function workspaceProfile(value: unknown): SparkDaemonWorkspace["profile"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    (value.sourceKind !== "builtin" && value.sourceKind !== "git") ||
    typeof value.ref !== "string" ||
    typeof value.importedAt !== "string"
  ) {
    return undefined;
  }
  return {
    sourceKind: value.sourceKind,
    ref: value.ref,
    ...(typeof value.commit === "string" ? { commit: value.commit } : {}),
    importedAt: value.importedAt,
  };
}

export function isWorkspaceStatus(value: unknown): value is SparkDaemonWorkspace["status"] {
  return (
    value === "available" ||
    value === "indexing" ||
    value === "degraded" ||
    value === "unavailable" ||
    value === "archived"
  );
}
