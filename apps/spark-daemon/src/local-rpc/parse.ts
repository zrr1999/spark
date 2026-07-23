import {
  parseSparkAssignment,
  parseSparkDefaultModelSetRequest,
  parseSparkSessionSetModelRequest,
  parseSparkSessionSetThinkingRequest,
  prefixedIdSchema,
  sparkInvocationListRequestSchema,
  sparkInvocationRetentionPreviewRequestSchema,
  sparkInvocationRetryRequestSchema,
  sparkProtocolJsonObjectSchema,
  sparkTurnCancelRequestSchema,
  sparkTurnStatusRequestSchema,
  sparkTurnStreamRequestSchema,
  sparkTurnSubmitRequestSchema,
  sparkSessionArchiveRequestSchema,
  sparkSessionBindRequestSchema,
  sparkSessionCreateRequestSchema,
  sparkSessionGetRequestSchema,
  sparkSessionListRequestSchema,
  sparkSessionInboxRequestSchema,
  sparkSessionMailMutationRequestSchema,
  sparkSessionSendRequestSchema,
  sparkSessionSnapshotRequestSchema,
  sparkSessionUnbindRequestSchema,
  sparkSideThreadConfigureRequestSchema,
  sparkSideThreadEnsureRequestSchema,
  sparkSideThreadHandoffRequestSchema,
  sparkSideThreadResetRequestSchema,
  sparkSideThreadSnapshotRequestSchema,
  sparkSideThreadSubmitRequestSchema,
  type SparkCommand,
} from "@zendev-lab/spark-protocol";
import {
  parseChannelsConfig,
  type ChannelNotifyInput,
  type ChannelsConfig,
} from "@zendev-lab/spark-channels";
import { sparkCommandFromLocalRpcRequest } from "../command-dispatcher.ts";
import { isRecord } from "./is-record.ts";
import { workspaceProfile } from "./results.ts";
import type {
  LocalHumanInteractionRespondParams,
  LocalRpcRequest,
  LocalTurnCancelParams,
  LocalTurnCancelRequest,
  LocalTurnSubmitParams,
  LocalWorkspaceClientAttachParams,
  LocalWorkspaceClientAttachRequest,
  LocalWorkspaceClientHeartbeatParams,
  LocalWorkspaceClientHeartbeatRequest,
  LocalWorkspaceEnsureLocalParams,
  LocalWorkspaceEnsureLocalRequest,
  LocalWorkspaceExecutorEnsureParams,
  LocalWorkspaceExecutorEnsureRequest,
  LocalWorkspaceRegisterParams,
  LocalWorkspaceRegisterRequest,
  LocalWorkspaceRelocateRequest,
  LocalWorkspaceRelocateResult,
} from "./types.ts";

export function parseLocalRpcRequest(line: string): LocalRpcRequest {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Invalid local RPC request.");
  }
  if (value.method === "daemon.status") {
    return withSparkCommand({ id: value.id, method: value.method });
  }
  if (value.method === "daemon.stop") {
    return withSparkCommand({ id: value.id, method: value.method });
  }
  if (value.method === "daemon.restart") {
    return withSparkCommand({ id: value.id, method: value.method });
  }
  if (value.method === "channel.status" || value.method === "channel.reload") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalChannelWorkspaceParams(value.params),
    });
  }
  if (value.method === "channel.configure") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalChannelConfigureParams(value.params),
    });
  }
  if (value.method === "channel.notify") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalChannelNotifyParams(value.params),
    });
  }
  if (value.method === "session.notification.deliver") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalSessionNotificationDeliverParams(value.params),
    });
  }
  if (value.method === "session.send") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSessionSendRequestSchema.parse(value.params),
    });
  }
  if (value.method === "session.inbox") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSessionInboxRequestSchema.parse(value.params),
    });
  }
  if (value.method === "session.mail.read" || value.method === "session.mail.ack") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSessionMailMutationRequestSchema.parse(value.params),
    });
  }
  if (value.method === "human.interaction.respond") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalHumanInteractionRespondParams(value.params),
    });
  }
  if (value.method === "turn.submit") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalTurnSubmitParams(value.params),
    });
  }
  if (value.method === "turn.status" || value.method === "turn.result") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkTurnStatusRequestSchema.parse(value.params),
    });
  }
  if (value.method === "invocation.list") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkInvocationListRequestSchema.parse(value.params ?? {}),
    });
  }
  if (value.method === "invocation.retry") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkInvocationRetryRequestSchema.parse(value.params),
    });
  }
  if (value.method === "invocation.retention.preview") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkInvocationRetentionPreviewRequestSchema.parse(value.params),
    });
  }
  if (value.method === "turn.stream") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkTurnStreamRequestSchema.parse(value.params),
    });
  }
  if (value.method === "turn.cancel") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalTurnCancelParams(value.params),
    });
  }
  if (value.method === "workspace.list") {
    return withSparkCommand({ id: value.id, method: value.method });
  }
  if (value.method === "workspace.register") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalWorkspaceRegisterParams(value.params),
    });
  }
  if (value.method === "workspace.relocate") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalWorkspaceRelocateParams(value.params),
    });
  }
  if (value.method === "uplink.park" || value.method === "uplink.unpark") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseUplinkServerUrlParams(value.params),
    });
  }
  if (value.method === "uplink.prefer") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseUplinkPreferParams(value.params),
    });
  }
  if (value.method === "uplink.status") {
    return withSparkCommand({ id: value.id, method: value.method });
  }
  if (value.method === "workspace.transfer.pending") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseWorkspaceTransferPendingParams(value.params),
    });
  }
  if (value.method === "workspace.transfer.respond") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseWorkspaceTransferRespondParams(value.params),
    });
  }
  if (value.method === "workspace.ensure-local") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalWorkspaceEnsureLocalParams(value.params),
    });
  }
  if (value.method === "workspace.attach" || value.method === "workspace.stop") {
    if (!isRecord(value.params) || typeof value.params.id !== "string") {
      throw new Error(`Missing workspace id for local RPC method: ${value.method}`);
    }
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: { id: value.params.id },
    });
  }
  if (value.method === "workspace.client.attach") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalWorkspaceClientAttachParams(value.params),
    });
  }
  if (value.method === "workspace.client.heartbeat") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalWorkspaceClientHeartbeatParams(value.params),
    });
  }
  if (value.method === "workspace.client.release") {
    if (!isRecord(value.params) || typeof value.params.clientId !== "string") {
      throw new Error("Missing workspace client id for local RPC release.");
    }
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: { clientId: value.params.clientId },
    });
  }
  if (value.method === "workspace.executor.ensure") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseLocalWorkspaceExecutorEnsureParams(value.params),
    });
  }
  if (value.method === "session.list") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSessionListRequestSchema.parse(value.params ?? {}),
    });
  }
  if (value.method === "session.get") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSessionGetRequestSchema.parse(value.params),
    });
  }
  if (value.method === "session.snapshot") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSessionSnapshotRequestSchema.parse(value.params),
    });
  }
  if (value.method === "session.create") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSessionCreateRequestSchema.parse(value.params),
    });
  }
  if (value.method === "session.bind") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSessionBindRequestSchema.parse(value.params),
    });
  }
  if (value.method === "session.unbind") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSessionUnbindRequestSchema.parse(value.params),
    });
  }
  if (value.method === "session.archive") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSessionArchiveRequestSchema.parse(value.params),
    });
  }
  if (value.method === "side-thread.ensure")
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSideThreadEnsureRequestSchema.parse(value.params),
    });
  if (value.method === "side-thread.snapshot")
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSideThreadSnapshotRequestSchema.parse(value.params),
    });
  if (value.method === "side-thread.submit")
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSideThreadSubmitRequestSchema.parse(value.params),
    });
  if (value.method === "side-thread.reset")
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSideThreadResetRequestSchema.parse(value.params),
    });
  if (value.method === "side-thread.configure")
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSideThreadConfigureRequestSchema.parse(value.params),
    });
  if (value.method === "side-thread.handoff")
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: sparkSideThreadHandoffRequestSchema.parse(value.params),
    });
  if (value.method === "session.model.set") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseSparkSessionSetModelRequest(value.params),
    });
  }
  if (value.method === "session.thinking.set") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseSparkSessionSetThinkingRequest(value.params),
    });
  }
  if (value.method === "model.catalog") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseOptionalSessionId(value.params),
    });
  }
  if (value.method === "model.default.set") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseSparkDefaultModelSetRequest(value.params),
    });
  }
  if (value.method === "provider.auth.api-key.set") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseProviderApiKeyParams(value.params),
    });
  }
  if (value.method === "provider.auth.logout" || value.method === "provider.auth.login.start") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseProviderNameParams(value.params),
    });
  }
  if (
    value.method === "provider.auth.login.status" ||
    value.method === "provider.auth.login.cancel"
  ) {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseOAuthFlowIdParams(value.params),
    });
  }
  if (value.method === "provider.auth.login.respond") {
    return withSparkCommand({
      id: value.id,
      method: value.method,
      params: parseOAuthFlowResponseParams(value.params),
    });
  }
  if (typeof value.method !== "string") {
    throw new Error("Invalid local RPC request.");
  }
  throw new Error(`Unknown local RPC method: ${value.method}`);
}

export function withSparkCommand<T extends { id: string; method: string; params?: unknown }>(
  request: T,
): T & { sparkCommand: SparkCommand } {
  return {
    ...request,
    sparkCommand: sparkCommandFromLocalRpcRequest(request),
  };
}

export function localTurnSubmitParams(params: LocalTurnSubmitParams): LocalTurnSubmitParams {
  return {
    sessionId: params.sessionId,
    prompt: params.prompt,
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.reset !== undefined ? { reset: params.reset } : {}),
    ...(params.assignment ? { assignment: params.assignment } : {}),
    ...(params.messageMetadata ? { messageMetadata: params.messageMetadata } : {}),
  };
}

export function parseLocalWorkspaceRelocateParams(value: unknown): LocalWorkspaceRelocateRequest {
  if (!isRecord(value) || typeof value.toServerUrl !== "string") {
    throw new Error("Workspace relocation requires toServerUrl.");
  }
  return {
    toServerUrl: value.toServerUrl,
    ...(typeof value.fromServerUrl === "string" ? { fromServerUrl: value.fromServerUrl } : {}),
  };
}

export function parseUplinkServerUrlParams(value: unknown): { serverUrl: string } {
  if (!isRecord(value) || typeof value.serverUrl !== "string" || !value.serverUrl.trim()) {
    throw new Error("uplink park/unpark requires serverUrl.");
  }
  return { serverUrl: value.serverUrl.trim() };
}

export function parseUplinkPreferParams(value: unknown): {
  workspace: string;
  serverUrl: string;
  force?: boolean;
} {
  if (
    !isRecord(value) ||
    typeof value.workspace !== "string" ||
    !value.workspace.trim() ||
    typeof value.serverUrl !== "string" ||
    !value.serverUrl.trim()
  ) {
    throw new Error("uplink prefer requires workspace and serverUrl.");
  }
  return {
    workspace: value.workspace.trim(),
    serverUrl: value.serverUrl.trim(),
    ...(value.force === true ? { force: true } : {}),
  };
}

export function parseWorkspaceTransferPendingParams(value: unknown): { workspaceId?: string } {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error("Invalid workspace.transfer.pending params.");
  return typeof value.workspaceId === "string" && value.workspaceId.trim()
    ? { workspaceId: value.workspaceId.trim() }
    : {};
}

export function parseWorkspaceTransferRespondParams(value: unknown): {
  transferId: string;
  decision: "accept" | "reject";
  source?: "tui" | "cli";
} {
  if (
    !isRecord(value) ||
    typeof value.transferId !== "string" ||
    !value.transferId.trim() ||
    (value.decision !== "accept" && value.decision !== "reject")
  ) {
    throw new Error("workspace.transfer.respond requires transferId and decision.");
  }
  return {
    transferId: value.transferId.trim(),
    decision: value.decision,
    ...(value.source === "tui" || value.source === "cli" ? { source: value.source } : {}),
  };
}

export function relocationResult(value: unknown): LocalWorkspaceRelocateResult {
  if (
    !isRecord(value) ||
    value.relocated !== true ||
    typeof value.instanceId !== "string" ||
    typeof value.installationId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.fromServerUrl !== "string" ||
    typeof value.toServerUrl !== "string" ||
    typeof value.webSocketUrl !== "string" ||
    !Array.isArray(value.workspaceBindingIds) ||
    !value.workspaceBindingIds.every((id) => typeof id === "string") ||
    typeof value.workspaceCount !== "number" ||
    typeof value.relocatedAt !== "string"
  ) {
    throw new Error("Invalid workspace relocation response.");
  }
  return value as unknown as LocalWorkspaceRelocateResult;
}

export function localWorkspaceRegisterParams(
  params: LocalWorkspaceRegisterRequest,
): LocalWorkspaceRegisterParams {
  return {
    serverUrl: params.serverUrl ?? "",
    ...(params.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
    localPath: params.localPath,
    ...(params.registrationToken ? { registrationToken: params.registrationToken } : {}),
    ...(params.localWorkspaceKey ? { localWorkspaceKey: params.localWorkspaceKey } : {}),
    ...(params.displayName ? { displayName: params.displayName } : {}),
    ...(params.workspaceName ? { workspaceName: params.workspaceName } : {}),
    ...(params.workspaceSlug ? { workspaceSlug: params.workspaceSlug } : {}),
    ...(params.profile ? { profile: params.profile } : {}),
  };
}

export function localTurnCancelParams(params: LocalTurnCancelRequest): LocalTurnCancelParams {
  return sparkTurnCancelRequestSchema.parse(params);
}

export function localWorkspaceEnsureLocalParams(
  params: LocalWorkspaceEnsureLocalRequest,
): LocalWorkspaceEnsureLocalParams {
  return {
    localPath: params.localPath,
    ...(params.displayName ? { displayName: params.displayName } : {}),
    ...(params.localWorkspaceKey ? { localWorkspaceKey: params.localWorkspaceKey } : {}),
  };
}

export function localWorkspaceClientAttachParams(
  params: LocalWorkspaceClientAttachRequest,
): LocalWorkspaceClientAttachParams {
  return {
    workspaceId: params.workspaceId,
    ...(params.clientId ? { clientId: params.clientId } : {}),
    kind: params.kind,
    ...(params.displayName ? { displayName: params.displayName } : {}),
    ...(params.leaseTtlMs !== undefined ? { leaseTtlMs: params.leaseTtlMs } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
}

export function localWorkspaceClientHeartbeatParams(
  params: LocalWorkspaceClientHeartbeatRequest,
): LocalWorkspaceClientHeartbeatParams {
  return {
    clientId: params.clientId,
    ...(params.leaseTtlMs !== undefined ? { leaseTtlMs: params.leaseTtlMs } : {}),
  };
}

export function localWorkspaceExecutorEnsureParams(
  params: LocalWorkspaceExecutorEnsureRequest,
): LocalWorkspaceExecutorEnsureParams {
  return {
    workspaceId: params.workspaceId,
    ...(params.clientId ? { clientId: params.clientId } : {}),
    ...(params.displayName ? { displayName: params.displayName } : {}),
    ...(params.leaseTtlMs !== undefined ? { leaseTtlMs: params.leaseTtlMs } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
}

export function parseLocalChannelWorkspaceParams(value: unknown): { workspaceId: string } {
  if (!isRecord(value) || typeof value.workspaceId !== "string" || !value.workspaceId.trim()) {
    throw new Error("channel.status/reload requires workspaceId.");
  }
  return { workspaceId: value.workspaceId.trim() };
}

export function parseLocalChannelConfigureParams(value: unknown): {
  workspaceId: string;
  config: ChannelsConfig;
} {
  if (!isRecord(value) || value.config === undefined) {
    throw new Error("Invalid local RPC channel configure params.");
  }
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim()) {
    throw new Error("channel.configure requires workspaceId.");
  }
  return {
    workspaceId: value.workspaceId.trim(),
    config: parseChannelsConfig(value.config),
  };
}

export function parseLocalChannelNotifyParams(
  value: unknown,
): ChannelNotifyInput & { workspaceId: string } {
  if (!isRecord(value) || typeof value.action !== "string") {
    throw new Error("Invalid local RPC channel notify params.");
  }
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim()) {
    throw new Error("channel.notify requires workspaceId.");
  }
  const action = value.action;
  if (action !== "send" && action !== "test" && action !== "list") {
    throw new Error("channel.notify action must be send, test, or list.");
  }
  const image = isRecord(value.image)
    ? {
        ...(typeof value.image.url === "string" ? { url: value.image.url } : {}),
        ...(typeof value.image.data === "string" ? { data: value.image.data } : {}),
        ...(typeof value.image.mediaType === "string" ? { mediaType: value.image.mediaType } : {}),
        ...(typeof value.image.name === "string" ? { name: value.image.name } : {}),
        ...(typeof value.image.size === "number" ? { size: value.image.size } : {}),
      }
    : undefined;
  return {
    workspaceId: value.workspaceId.trim(),
    action,
    ...(typeof value.adapter === "string" ? { adapter: value.adapter } : {}),
    ...(typeof value.route === "string" ? { route: value.route } : {}),
    ...(typeof value.recipient === "string" ? { recipient: value.recipient } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(image ? { image } : {}),
  };
}

export function parseLocalSessionNotificationDeliverParams(value: unknown): {
  sessionId: string;
  messageId: string;
} {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    !value.sessionId.trim() ||
    typeof value.messageId !== "string" ||
    !value.messageId.trim()
  ) {
    throw new Error("session.notification.deliver requires sessionId and messageId.");
  }
  return { sessionId: value.sessionId.trim(), messageId: value.messageId.trim() };
}

export function parseLocalHumanInteractionRespondParams(
  value: unknown,
): LocalHumanInteractionRespondParams {
  if (
    !isRecord(value) ||
    typeof value.interactionRequestId !== "string" ||
    !value.interactionRequestId.trim()
  ) {
    throw new Error("human.interaction.respond requires interactionRequestId.");
  }
  if (value.status !== "answered" && value.status !== "cancelled") {
    throw new Error("human.interaction.respond status must be answered or cancelled.");
  }
  const sessionId = optionalNonEmptyString(value.sessionId, "sessionId");
  const invocationId = optionalNonEmptyString(value.invocationId, "invocationId");
  const humanResponseId =
    value.humanResponseId === undefined
      ? undefined
      : prefixedIdSchema("hres").parse(value.humanResponseId);
  const responseArtifactRefs = value.responseArtifactRefs ?? [];
  if (
    !Array.isArray(responseArtifactRefs) ||
    !responseArtifactRefs.every((item) => typeof item === "string" && item.trim())
  ) {
    throw new Error("human.interaction.respond responseArtifactRefs must be strings.");
  }
  return {
    interactionRequestId: value.interactionRequestId.trim(),
    ...(sessionId ? { sessionId } : {}),
    ...(invocationId ? { invocationId } : {}),
    ...(humanResponseId ? { humanResponseId } : {}),
    status: value.status,
    answers: sparkProtocolJsonObjectSchema.parse(value.answers ?? {}),
    responseArtifactRefs: responseArtifactRefs.map((item) => item.trim()),
  };
}

export function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`human.interaction.respond ${name} must be a non-empty string.`);
  }
  return value.trim();
}

export function parseLocalTurnSubmitParams(value: unknown): LocalTurnSubmitParams {
  if (!isRecord(value)) throw new Error("Invalid local RPC turn submit params.");
  const params = sparkTurnSubmitRequestSchema.parse(value);
  const messageMetadata = parseLocalMessageMetadata(value.messageMetadata);
  return {
    ...params,
    ...(value.assignment === undefined
      ? {}
      : { assignment: parseSparkAssignment(value.assignment) }),
    ...(messageMetadata ? { messageMetadata } : {}),
  };
}

export function parseLocalMessageMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("turn.submit messageMetadata must be an object.");
  return value;
}

export function parseLocalTurnCancelParams(value: unknown): LocalTurnCancelParams {
  return sparkTurnCancelRequestSchema.parse(value);
}

export function parseOptionalSessionId(value: unknown): { sessionId?: string } {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Invalid model.catalog params.");
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  return sessionId ? { sessionId } : {};
}

export function parseProviderNameParams(value: unknown): { providerName: string } {
  if (!isRecord(value) || typeof value.providerName !== "string") {
    throw new Error("Provider auth request requires providerName.");
  }
  const providerName = value.providerName.trim();
  if (!providerName) throw new Error("Provider auth request requires providerName.");
  return { providerName };
}

export function parseProviderApiKeyParams(value: unknown): {
  providerName: string;
  apiKey: string;
} {
  const { providerName } = parseProviderNameParams(value);
  if (!isRecord(value) || typeof value.apiKey !== "string" || !value.apiKey.trim()) {
    throw new Error("Provider API key request requires apiKey.");
  }
  return { providerName, apiKey: value.apiKey };
}

export function parseOAuthFlowIdParams(value: unknown): { flowId: string } {
  if (!isRecord(value) || typeof value.flowId !== "string" || !value.flowId.trim()) {
    throw new Error("OAuth flow request requires flowId.");
  }
  return { flowId: value.flowId.trim() };
}

export function parseOAuthFlowResponseParams(value: unknown): {
  flowId: string;
  promptId: string;
  value: string;
} {
  const { flowId } = parseOAuthFlowIdParams(value);
  if (
    !isRecord(value) ||
    typeof value.promptId !== "string" ||
    !value.promptId.trim() ||
    typeof value.value !== "string"
  ) {
    throw new Error("OAuth flow response requires promptId and value.");
  }
  return { flowId, promptId: value.promptId.trim(), value: value.value };
}

export function parseLocalWorkspaceRegisterParams(value: unknown): LocalWorkspaceRegisterParams {
  if (
    !isRecord(value) ||
    typeof value.serverUrl !== "string" ||
    typeof value.localPath !== "string"
  ) {
    throw new Error("Invalid local RPC workspace register params.");
  }

  const params: LocalWorkspaceRegisterParams = {
    serverUrl: value.serverUrl,
    localPath: value.localPath,
  };
  if (value.allowInsecureHttp === true) {
    params.allowInsecureHttp = true;
  }
  if (typeof value.localWorkspaceKey === "string") {
    params.localWorkspaceKey = value.localWorkspaceKey;
  }
  if (typeof value.registrationToken === "string") {
    params.registrationToken = value.registrationToken;
  }
  if (typeof value.displayName === "string") {
    params.displayName = value.displayName;
  }
  if (typeof value.workspaceName === "string") {
    params.workspaceName = value.workspaceName;
  }
  if (typeof value.workspaceSlug === "string") {
    params.workspaceSlug = value.workspaceSlug;
  }
  const profile = workspaceProfile(value.profile);
  if (profile) {
    params.profile = profile;
  }
  return params;
}

export function parseLocalWorkspaceEnsureLocalParams(
  value: unknown,
): LocalWorkspaceEnsureLocalParams {
  if (!isRecord(value) || typeof value.localPath !== "string") {
    throw new Error("Invalid local RPC workspace ensure-local params.");
  }
  return {
    localPath: value.localPath,
    ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
    ...(typeof value.localWorkspaceKey === "string"
      ? { localWorkspaceKey: value.localWorkspaceKey }
      : {}),
  };
}

export function parseLocalWorkspaceClientAttachParams(
  value: unknown,
): LocalWorkspaceClientAttachParams {
  if (!isRecord(value) || typeof value.workspaceId !== "string") {
    throw new Error("Invalid local RPC workspace client attach params.");
  }
  if (value.kind !== "interactive" && value.kind !== "headless" && value.kind !== "executor") {
    throw new Error("Invalid local RPC workspace client kind.");
  }
  return {
    workspaceId: value.workspaceId,
    ...(typeof value.clientId === "string" ? { clientId: value.clientId } : {}),
    kind: value.kind,
    ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
    ...(typeof value.leaseTtlMs === "number" && Number.isFinite(value.leaseTtlMs)
      ? { leaseTtlMs: Math.max(0, Math.floor(value.leaseTtlMs)) }
      : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

export function parseLocalWorkspaceClientHeartbeatParams(
  value: unknown,
): LocalWorkspaceClientHeartbeatParams {
  if (!isRecord(value) || typeof value.clientId !== "string") {
    throw new Error("Invalid local RPC workspace client heartbeat params.");
  }
  return {
    clientId: value.clientId,
    ...(typeof value.leaseTtlMs === "number" && Number.isFinite(value.leaseTtlMs)
      ? { leaseTtlMs: Math.max(0, Math.floor(value.leaseTtlMs)) }
      : {}),
  };
}

export function parseLocalWorkspaceExecutorEnsureParams(
  value: unknown,
): LocalWorkspaceExecutorEnsureParams {
  if (!isRecord(value) || typeof value.workspaceId !== "string") {
    throw new Error("Invalid local RPC workspace executor ensure params.");
  }
  return {
    workspaceId: value.workspaceId,
    ...(typeof value.clientId === "string" ? { clientId: value.clientId } : {}),
    ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
    ...(typeof value.leaseTtlMs === "number" && Number.isFinite(value.leaseTtlMs)
      ? { leaseTtlMs: Math.max(0, Math.floor(value.leaseTtlMs)) }
      : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}
