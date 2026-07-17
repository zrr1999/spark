import {
  createId,
  runtimeProtocolVersion,
  type ArtifactProjectionPayload,
  type DaemonEventPayload,
  type InvocationLogChunkPayload,
  type InvocationUpdatePayload,
  type RuntimeCommandAckPayload,
  type RuntimeCommandRejectPayload,
  type RuntimeCommandResultPayload,
  type RuntimeReconcileReportPayload,
  type TaskGraphSnapshotPayload,
  type WorkspaceSnapshotPayload,
} from "@zendev-lab/spark-protocol";

export interface RouteContext {
  runtimeId: string;
  workspaceBindingId?: string | undefined;
  workspaceId?: string | undefined;
  projectId?: string | undefined;
  commandId?: string | undefined;
  humanRequestId?: string | undefined;
  humanResponseId?: string | undefined;
  invocationId?: string | undefined;
  sessionId?: string | undefined;
  ackOf?: string | undefined;
}

export function runtimeEnvelope(
  type: string,
  payload: unknown,
  route: RouteContext,
  options: { messageId?: string } = {},
) {
  return {
    protocolVersion: runtimeProtocolVersion,
    messageId: options.messageId ?? createId("msg"),
    type,
    sentAt: new Date().toISOString(),
    runtimeId: route.runtimeId,
    workspaceBindingId: route.workspaceBindingId,
    workspaceId: route.workspaceId,
    projectId: route.projectId,
    commandId: route.commandId,
    humanRequestId: route.humanRequestId,
    humanResponseId: route.humanResponseId,
    invocationId: route.invocationId,
    sessionId: route.sessionId,
    ackOf: route.ackOf,
    payload,
  };
}

export function commandAck(payload: RuntimeCommandAckPayload, route: RouteContext) {
  return runtimeEnvelope("runtime.command.ack", payload, route);
}

export function commandReject(payload: RuntimeCommandRejectPayload, route: RouteContext) {
  return runtimeEnvelope("runtime.command.reject", payload, route);
}

export function commandResult(
  payload: RuntimeCommandResultPayload,
  route: RouteContext,
  options: { messageId?: string } = {},
) {
  return runtimeEnvelope("runtime.command.result", payload, route, options);
}

export function invocationUpdated(
  payload: InvocationUpdatePayload,
  route: RouteContext,
  options: { messageId?: string } = {},
) {
  return runtimeEnvelope("invocation.updated", payload, route, options);
}

export function invocationLogChunk(
  payload: InvocationLogChunkPayload,
  route: RouteContext,
  options: { messageId?: string } = {},
) {
  return runtimeEnvelope("invocation.log_chunk", payload, route, options);
}

export function taskGraphSnapshot(payload: TaskGraphSnapshotPayload, route: RouteContext) {
  return runtimeEnvelope("task_graph.snapshot", payload, route);
}

export function workspaceSnapshot(payload: WorkspaceSnapshotPayload, route: RouteContext) {
  return runtimeEnvelope("workspace.snapshot", payload, route);
}

export function daemonEvent(payload: DaemonEventPayload, route: RouteContext) {
  return runtimeEnvelope("daemon.event", payload, route);
}

export function artifactProjected(payload: ArtifactProjectionPayload, route: RouteContext) {
  return runtimeEnvelope("artifact.projected", payload, route);
}

export function reconcileReport(payload: RuntimeReconcileReportPayload, route: RouteContext) {
  return runtimeEnvelope("runtime.reconcile.report", payload, route);
}
