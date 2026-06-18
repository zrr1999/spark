import {
  createId,
  runtimeProtocolVersion,
  type ArtifactProjectionPayload,
  type InvocationLogChunkPayload,
  type InvocationUpdatePayload,
  type RuntimeCommandAckPayload,
  type RuntimeCommandRejectPayload,
  type RuntimeReconcileReportPayload,
  type TaskGraphSnapshotPayload,
  type WorkspaceSnapshotPayload,
} from "@zendev-lab/navia-protocol";

export interface RouteContext {
  runtimeId: string;
  workspaceBindingId?: string | undefined;
  workspaceId?: string | undefined;
  projectId?: string | undefined;
  commandId?: string | undefined;
  invocationId?: string | undefined;
  ackOf?: string | undefined;
}

export function runtimeEnvelope(type: string, payload: unknown, route: RouteContext) {
  return {
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type,
    sentAt: new Date().toISOString(),
    runtimeId: route.runtimeId,
    workspaceBindingId: route.workspaceBindingId,
    workspaceId: route.workspaceId,
    projectId: route.projectId,
    commandId: route.commandId,
    invocationId: route.invocationId,
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

export function invocationUpdated(payload: InvocationUpdatePayload, route: RouteContext) {
  return runtimeEnvelope("invocation.updated", payload, route);
}

export function invocationLogChunk(payload: InvocationLogChunkPayload, route: RouteContext) {
  return runtimeEnvelope("invocation.log_chunk", payload, route);
}

export function taskGraphSnapshot(payload: TaskGraphSnapshotPayload, route: RouteContext) {
  return runtimeEnvelope("task_graph.snapshot", payload, route);
}

export function workspaceSnapshot(payload: WorkspaceSnapshotPayload, route: RouteContext) {
  return runtimeEnvelope("workspace.snapshot", payload, route);
}

export function artifactProjected(payload: ArtifactProjectionPayload, route: RouteContext) {
  return runtimeEnvelope("artifact.projected", payload, route);
}

export function reconcileReport(payload: RuntimeReconcileReportPayload, route: RouteContext) {
  return runtimeEnvelope("runtime.reconcile.report", payload, route);
}
