import type { DatabaseSync } from "node:sqlite";
import {
  parseSparkSessionView,
  sparkInvocationListRequestSchema,
  sparkInvocationListResultSchema,
  sparkTurnResultSchema,
  type SparkInvocationStatus,
  type SparkSessionMailChannelDeliveryView,
  type SparkSessionView,
} from "@zendev-lab/spark-protocol";
import {
  SparkSessionRegistryError,
  type SparkSessionMailDeliveryStatus,
  type SparkSessionMailMessage,
} from "@zendev-lab/spark-session";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { isRetryableInvocationError, SparkInvocationStore } from "../store/invocations.ts";
import {
  listWorkspaces,
  WorkspacePathConflictError,
  type SparkDaemonWorkspaceClient,
} from "../store/workspaces.js";
import { RegistrationGrantRefusedError } from "../registration.js";
import type { DaemonSessionRegistry } from "../session-registry.ts";
import type { SparkDaemonModelControl } from "../model-control.ts";
import {
  SparkDaemonHumanWaitLookupError,
  type SparkDaemonHumanWaitRegistry,
} from "../core/human-waits.ts";
import type { SparkDaemonHumanInteractionResponder } from "../core/index.ts";
import { SparkDaemonRelocationError } from "../relocation.ts";
import {
  deliverSessionNotification,
  type SessionNotificationDeliveryResult,
} from "../session-notification-delivery.ts";
import { isRecord } from "./is-record.ts";
import {
  SparkDaemonStillStartingError,
  type LocalInvocationListResult,
  type LocalRpcErrorPayload,
  type LocalRpcHandlerOptions,
  type LocalTurnResult,
  type LocalWorkspaceClientResult,
} from "./types.ts";

export function isLocalRpcSafeWhileAdmissionClosed(method: string): boolean {
  return (
    method === "daemon.status" ||
    method === "daemon.stop" ||
    method === "turn.status" ||
    method === "turn.result" ||
    method === "turn.stream" ||
    method === "turn.cancel" ||
    method === "invocation.list" ||
    method === "human.interaction.respond"
  );
}

export function workspaceClientResult(
  db: DatabaseSync,
  client: SparkDaemonWorkspaceClient,
): LocalWorkspaceClientResult {
  const workspace = listWorkspaces(db).find((candidate) => candidate.id === client.workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace connection: ${client.workspaceId}`);
  }
  return { client, workspace, observedAt: new Date().toISOString() };
}

export function sessionControlOptions(
  paths: SparkPaths,
  db: DatabaseSync,
  options: LocalRpcHandlerOptions,
) {
  return {
    paths,
    db,
    sessionRegistry: options.sessionRegistry,
    modelControl: options.modelControl,
    actor: "spark-daemon-local-rpc" as const,
  };
}

export function localRpcError(error: unknown): LocalRpcErrorPayload {
  if (error instanceof SparkDaemonStillStartingError) {
    return { message: error.message, code: "daemon_starting" };
  }
  if (error instanceof SparkSessionRegistryError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof SparkDaemonHumanWaitLookupError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof WorkspacePathConflictError) {
    return {
      message: error.message,
      code: "workspace_path_conflict",
      kind: error.kind,
    };
  }
  if (error instanceof RegistrationGrantRefusedError) {
    return {
      message: error.message,
      code: "registration_grant_refused",
    };
  }
  if (error instanceof SparkDaemonRelocationError) {
    return { message: error.message, code: error.code.toLowerCase() };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

export function requireSessionRegistry(options: LocalRpcHandlerOptions): DaemonSessionRegistry {
  if (!options.sessionRegistry) {
    throw new Error("Spark daemon session registry is not available.");
  }
  return options.sessionRegistry;
}

export function requireModelControl(options: LocalRpcHandlerOptions): SparkDaemonModelControl {
  if (!options.modelControl) {
    throw new Error("Spark daemon model/auth control is not available.");
  }
  return options.modelControl;
}

export function requireHumanWaitRegistry(
  options: LocalRpcHandlerOptions,
): SparkDaemonHumanWaitRegistry {
  if (!options.humanWaits) {
    throw new Error("Spark daemon human wait registry is not available.");
  }
  return options.humanWaits;
}

export function requireHumanInteractionResponder(
  options: LocalRpcHandlerOptions,
): SparkDaemonHumanInteractionResponder {
  if (!options.respondHumanInteraction) {
    throw new Error("Spark daemon human interaction responder is not available.");
  }
  return options.respondHumanInteraction;
}

export async function projectSessionMailbox(
  options: LocalRpcHandlerOptions,
  snapshot: SparkSessionView,
): Promise<SparkSessionView> {
  if (!options.mailStore) return snapshot;
  const messages = await options.mailStore.list(snapshot.sessionId, { includeAcked: true });
  const mailbox = messages.slice(-50).map((message) => {
    const channelDelivery = projectSessionMailChannelDelivery(message);
    return {
      id: message.id,
      fromSessionId: message.fromSessionId,
      kind: message.kind,
      intent: message.intent,
      subject: message.subject,
      body: message.body,
      createdAt: message.createdAt,
      readAt: message.readAt,
      ackedAt: message.ackedAt,
      ...(channelDelivery ? { channelDelivery } : {}),
    };
  });
  return parseSparkSessionView({ ...snapshot, mailbox });
}

export function projectSessionMailChannelDelivery(
  message: SparkSessionMailMessage,
): SparkSessionMailChannelDeliveryView | undefined {
  if (message.delivery !== "channel" || message.deliveries.length === 0) return undefined;

  const counts: Record<SparkSessionMailDeliveryStatus, number> = {
    pending: 0,
    delivered: 0,
    failed: 0,
    uncertain: 0,
  };
  for (const delivery of message.deliveries) counts[delivery.status] += 1;
  const status: SparkSessionMailDeliveryStatus =
    counts.uncertain > 0
      ? "uncertain"
      : counts.failed > 0
        ? "failed"
        : counts.pending > 0
          ? "pending"
          : "delivered";
  return {
    status,
    total: message.deliveries.length,
    ...counts,
  };
}

export function invocationResult(
  store: SparkInvocationStore,
  invocationId: string,
): LocalTurnResult {
  const invocation = store.require(invocationId);
  if (!isTerminalInvocationStatus(invocation.status)) {
    throw new Error(`INVOCATION_NOT_TERMINAL: ${invocationId} is ${invocation.status}`);
  }
  const assistantText = boundedAssistantText(invocation.result);
  return sparkTurnResultSchema.parse({
    invocationId,
    status: invocation.status,
    ...(assistantText ? { assistantText } : {}),
    ...(invocation.errorMessage
      ? {
          error: {
            code: invocation.errorCode,
            message: invocation.errorMessage,
            retryable: isRetryableInvocationError(invocation.errorCode),
          },
        }
      : {}),
    ...(invocation.finishedAt ? { finishedAt: invocation.finishedAt } : {}),
  });
}

export function boundedAssistantText(result: unknown): string | undefined {
  if (!isRecord(result) || typeof result.assistantText !== "string") return undefined;
  const text = result.assistantText.trim();
  return text ? text.slice(0, 262_144) : undefined;
}

export function invocationListResult(
  store: SparkInvocationStore,
  params: ReturnType<typeof sparkInvocationListRequestSchema.parse>,
): LocalInvocationListResult {
  const page = store.listSummaryPage(params);
  return sparkInvocationListResultSchema.parse({
    invocations: page.invocations.map((invocation) => ({
      ...invocation,
      errorMessage: invocation.errorMessage?.slice(0, 500),
      retryable: isRetryableInvocationError(invocation.errorCode),
    })),
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    observedAt: new Date().toISOString(),
  });
}

export function isTerminalInvocationStatus(status: SparkInvocationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export async function settleManagedSessionTurn(
  sessionRegistry: DaemonSessionRegistry | undefined,
  sessionId: string,
): Promise<void> {
  try {
    await sessionRegistry?.recordTurnSettled(sessionId);
  } catch (error) {
    console.error(`[spark-daemon] failed to settle session turn ${sessionId}`, error);
  }
}

export async function deliverSessionNotificationFromLocalRpc(
  options: LocalRpcHandlerOptions,
  input: { sessionId: string; messageId: string },
): Promise<SessionNotificationDeliveryResult> {
  const mailStore = options.mailStore;
  if (!mailStore?.get || !mailStore.recordChannelDelivery) {
    throw new Error("Spark daemon session mail delivery store is unavailable.");
  }
  return await deliverSessionNotification(input, {
    mailStore: {
      get: mailStore.get.bind(mailStore),
      recordChannelDelivery: mailStore.recordChannelDelivery.bind(mailStore),
    },
    sessionRegistry: requireSessionRegistry(options),
    channelIngress: requireChannelIngress(options),
    ...(options.notificationDeliveryQueue
      ? { deliveryQueue: options.notificationDeliveryQueue }
      : {}),
  });
}
export function requireChannelIngress(
  options: LocalRpcHandlerOptions,
): NonNullable<LocalRpcHandlerOptions["channelIngress"]> {
  if (!options.channelIngress) {
    throw new Error("Spark daemon channel runtime is not available.");
  }
  return options.channelIngress;
}
