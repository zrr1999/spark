import {
  parseSparkDefaultModelSetRequest,
  parseSparkSessionSetModelRequest,
  parseSparkSessionSetThinkingRequest,
  sparkSideThreadConfigureRequestSchema,
  sparkSideThreadEnsureRequestSchema,
  sparkSideThreadHandoffRequestSchema,
  sparkSideThreadResetRequestSchema,
  sparkSideThreadSnapshotRequestSchema,
  sparkSideThreadSubmitRequestSchema,
  sparkInvocationListRequestSchema,
  sparkInvocationRetentionPreviewRequestSchema,
  sparkInvocationRetryRequestSchema,
  sparkTurnStatusRequestSchema,
  sparkTurnStreamRequestSchema,
  type SparkAssignment,
  type SparkCommand,
  type SparkDaemonEvent,
  type SparkDriverMutationRequest,
  type SparkDriverScheduleRequest,
  type SparkDriverStartRequest,
  type SparkDriverStatusRequest,
  type SparkDriverWakeRequest,
  type SparkInvocationListResult,
  type SparkInvocationRetentionPreviewResult,
  type SparkInvocationRetryResult,
  type SparkSessionArchiveRequest,
  type SparkSessionBindRequest,
  type SparkSessionCreateRequest,
  type SparkSessionGetRequest,
  type SparkSessionListRequest,
  type SparkSessionInboxRequest,
  type SparkSessionMailMutationRequest,
  type SparkSessionSendRequest,
  type SparkSessionSnapshotRequest,
  type SparkSessionUnbindRequest,
  type SparkTurnCancelResult,
  type SparkTurnResult,
  type SparkTurnStatusResult,
  type SparkTurnStreamPage,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import type { ChannelNotifyInput, ChannelsConfig } from "@zendev-lab/spark-channels";
import type { SparkSessionMailStore } from "@zendev-lab/spark-session";
import type { SparkPaths } from "@zendev-lab/spark-system";
import type { DaemonChannelIngressRuntime } from "../channels/ingress.ts";
import type { SessionNotificationDeliveryQueue } from "../session-notification-delivery.ts";
import type {
  SparkDaemonLifecycleSnapshot,
  SparkDaemonHumanInteractionResponder,
  SparkDaemonRestartRequestResult,
} from "../core/index.ts";
import type {
  SparkDaemonHumanWaitDeliveryResult,
  SparkDaemonHumanWaitRegistry,
} from "../core/human-waits.ts";
import type { SparkDaemonLeaseTransferBroker } from "../core/lease-transfer.ts";
import type { SparkChannelDeliverySummary } from "../store/channel-deliveries.ts";
import type {
  RegisterWorkspaceOptions,
  SparkDaemonWorkspace,
  SparkDaemonWorkspaceClient,
  WorkspacePathConflictError,
} from "../store/workspaces.js";
import type { DaemonSessionRegistry } from "../session-registry.ts";
import type { SparkDaemonModelControl } from "../model-control.ts";
import type { SparkDaemonRelocationRequest, SparkDaemonRelocationResult } from "../relocation.ts";
import { join } from "node:path";

type EnsureSparkDaemonRegistrationForWorkspace =
  typeof import("../registration.js").ensureSparkDaemonRegistrationForWorkspace;
type VerifySparkDaemonWorkspaceConnection =
  typeof import("../registration.js").verifySparkDaemonWorkspaceConnection;
type UnbindSparkDaemonWorkspaceFromCockpit =
  typeof import("../registration.js").unbindSparkDaemonWorkspaceFromCockpit;
type RelocateSparkDaemonCockpit = typeof import("../relocation.ts").relocateSparkDaemonCockpit;

export interface LocalRpcServer {
  socketPath: string;
  close(): Promise<void>;
}

export interface SparkDaemonLocalEventBus {
  publish(event: SparkDaemonEvent): void;
  subscribe(listener: (event: SparkDaemonEvent) => void): () => void;
}

export function createSparkDaemonLocalEventBus(): SparkDaemonLocalEventBus {
  const listeners = new Set<(event: SparkDaemonEvent) => void>();
  return {
    publish(event) {
      for (const listener of listeners) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface WorkspaceListResult {
  workspaces: SparkDaemonWorkspace[];
  observedAt: string;
}

export interface LocalDaemonStatusResult {
  servers: Array<{
    url: string;
    workspaceCount: number;
    wsConnected: boolean;
    lastHeartbeatAt?: string;
    lastDisconnectReason?: string;
  }>;
  invocations: Record<"queued" | "running" | "succeeded" | "failed" | "cancelled", number>;
  invocationHealth: { oldestQueuedAt?: string; oldestRunningAt?: string };
  channelDeliveries?: SparkChannelDeliverySummary;
  lifecycle: SparkDaemonLifecycleSnapshot;
  buildFingerprint?: string;
  observedAt: string;
}

export type LocalInvocationListResult = SparkInvocationListResult;
export type LocalInvocationRetryResult = SparkInvocationRetryResult;
export type LocalInvocationRetentionPreviewResult = SparkInvocationRetentionPreviewResult;
export type LocalTurnResult = SparkTurnResult;

export type LocalTurnSubmitResult = SparkTurnSubmitResult;
export type LocalTurnStatusResult = SparkTurnStatusResult;
export type LocalTurnStreamResult = SparkTurnStreamPage;

export interface LocalTurnCancelRequest {
  invocationId: string;
  reason?: string;
}

export type LocalTurnCancelResult = SparkTurnCancelResult;

export interface LocalDaemonStopResult {
  stopping: true;
  observedAt: string;
}

export type LocalDaemonRestartResult = SparkDaemonRestartRequestResult;

export interface LocalWorkspaceRegisterRequest extends RegisterWorkspaceOptions {
  registrationToken?: string;
}

export type LocalWorkspaceRelocateRequest = SparkDaemonRelocationRequest;
export type LocalWorkspaceRelocateResult = SparkDaemonRelocationResult;

export interface LocalWorkspaceEnsureLocalRequest {
  localPath: string;
  displayName?: string;
  localWorkspaceKey?: string;
}

export interface LocalWorkspaceClientAttachRequest {
  workspaceId: string;
  clientId?: string;
  kind: SparkDaemonWorkspaceClient["kind"];
  displayName?: string;
  leaseTtlMs?: number;
  metadata?: Record<string, unknown>;
}

export interface LocalWorkspaceClientHeartbeatRequest {
  clientId: string;
  leaseTtlMs?: number;
}

export interface LocalWorkspaceExecutorEnsureRequest {
  workspaceId: string;
  clientId?: string;
  displayName?: string;
  leaseTtlMs?: number;
  metadata?: Record<string, unknown>;
}

export interface LocalWorkspaceClientResult {
  client: SparkDaemonWorkspaceClient;
  workspace: SparkDaemonWorkspace;
  observedAt: string;
}

export type LocalRpcMailStore = Pick<SparkSessionMailStore, "list"> &
  Partial<
    Pick<
      SparkSessionMailStore,
      "ack" | "get" | "read" | "recordChannelDelivery" | "recordRequestAdmission" | "send"
    >
  >;

export interface LocalRpcHandlerOptions {
  ensureSparkDaemonRegistrationForWorkspace?: EnsureSparkDaemonRegistrationForWorkspace;
  verifySparkDaemonWorkspaceConnection?: VerifySparkDaemonWorkspaceConnection;
  unbindSparkDaemonWorkspaceFromCockpit?: UnbindSparkDaemonWorkspaceFromCockpit;
  channelIngress?: Pick<DaemonChannelIngressRuntime, "status" | "configure" | "reload" | "notify">;
  sessionRegistry?: DaemonSessionRegistry;
  modelControl?: SparkDaemonModelControl;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  respondHumanInteraction?: SparkDaemonHumanInteractionResponder;
  leaseTransfers?: SparkDaemonLeaseTransferBroker;
  onHumanRequestOutboxReady?: () => void;
  getRuntimeIdForServer?: (serverUrl: string) => string | undefined;
  mailStore?: LocalRpcMailStore;
  notificationDeliveryQueue?: SessionNotificationDeliveryQueue;
  onStopRequested?: () => void;
  onRestart?: () => LocalDaemonRestartResult | Promise<LocalDaemonRestartResult>;
  relocateSparkDaemonCockpit?: RelocateSparkDaemonCockpit;
  onUplinkReconfigure?: (serverUrl?: string) => void;
  getLifecycle?: () => SparkDaemonLifecycleSnapshot;
  getBuildFingerprint?: () => string;
  /** Startup fence: before this opens, only readiness/status and stop are admitted. */
  isReady?: () => boolean;
  eventBus?: SparkDaemonLocalEventBus;
}

export type LocalRpcRequest =
  | { id: string; method: "daemon.status"; sparkCommand: SparkCommand }
  | { id: string; method: "daemon.stop"; sparkCommand: SparkCommand }
  | { id: string; method: "daemon.restart"; sparkCommand: SparkCommand }
  | {
      id: string;
      method: "channel.status";
      params: { workspaceId: string };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "channel.reload";
      params: { workspaceId: string };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "channel.configure";
      params: { workspaceId: string; config: ChannelsConfig };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "channel.notify";
      params: ChannelNotifyInput & { workspaceId: string };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.notification.deliver";
      params: { sessionId: string; messageId: string };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "human.interaction.respond";
      params: LocalHumanInteractionRespondParams;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "turn.submit";
      params: LocalTurnSubmitParams;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "turn.status" | "turn.result";
      params: ReturnType<typeof sparkTurnStatusRequestSchema.parse>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "invocation.list";
      params: ReturnType<typeof sparkInvocationListRequestSchema.parse>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "invocation.retry";
      params: ReturnType<typeof sparkInvocationRetryRequestSchema.parse>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "invocation.retention.preview";
      params: ReturnType<typeof sparkInvocationRetentionPreviewRequestSchema.parse>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "driver.start";
      params: SparkDriverStartRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "driver.status";
      params: SparkDriverStatusRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "driver.stop" | "driver.restart";
      params: SparkDriverMutationRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "driver.wake";
      params: SparkDriverWakeRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "driver.schedule";
      params: SparkDriverScheduleRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "turn.stream";
      params: ReturnType<typeof sparkTurnStreamRequestSchema.parse>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "turn.cancel";
      params: LocalTurnCancelParams;
      sparkCommand: SparkCommand;
    }
  | { id: string; method: "workspace.list"; sparkCommand: SparkCommand }
  | {
      id: string;
      method: "workspace.register";
      params: LocalWorkspaceRegisterParams;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "workspace.relocate";
      params: LocalWorkspaceRelocateRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "uplink.park" | "uplink.unpark";
      params: { serverUrl: string };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "uplink.prefer";
      params: { workspace: string; serverUrl: string; force?: boolean };
      sparkCommand: SparkCommand;
    }
  | { id: string; method: "uplink.status"; sparkCommand: SparkCommand }
  | {
      id: string;
      method: "workspace.transfer.pending";
      params: { workspaceId?: string };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "workspace.transfer.respond";
      params: {
        transferId: string;
        decision: "accept" | "reject";
        source?: "tui" | "cli";
      };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "workspace.ensure-local";
      params: LocalWorkspaceEnsureLocalParams;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "workspace.attach" | "workspace.stop";
      params: { id: string };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "workspace.client.attach";
      params: LocalWorkspaceClientAttachParams;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "workspace.client.heartbeat";
      params: LocalWorkspaceClientHeartbeatParams;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "workspace.client.release";
      params: { clientId: string };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "workspace.executor.ensure";
      params: LocalWorkspaceExecutorEnsureParams;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.list";
      params: SparkSessionListRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.get";
      params: SparkSessionGetRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.snapshot";
      params: SparkSessionSnapshotRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.create";
      params: SparkSessionCreateRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.bind";
      params: SparkSessionBindRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.unbind";
      params: SparkSessionUnbindRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.archive";
      params: SparkSessionArchiveRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.send";
      params: SparkSessionSendRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.inbox";
      params: SparkSessionInboxRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.mail.read" | "session.mail.ack";
      params: SparkSessionMailMutationRequest;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.model.set";
      params: ReturnType<typeof parseSparkSessionSetModelRequest>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "session.thinking.set";
      params: ReturnType<typeof parseSparkSessionSetThinkingRequest>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "side-thread.ensure";
      params: ReturnType<typeof sparkSideThreadEnsureRequestSchema.parse>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "side-thread.snapshot";
      params: ReturnType<typeof sparkSideThreadSnapshotRequestSchema.parse>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "side-thread.submit";
      params: ReturnType<typeof sparkSideThreadSubmitRequestSchema.parse>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "side-thread.reset";
      params: ReturnType<typeof sparkSideThreadResetRequestSchema.parse>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "side-thread.configure";
      params: ReturnType<typeof sparkSideThreadConfigureRequestSchema.parse>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "side-thread.handoff";
      params: ReturnType<typeof sparkSideThreadHandoffRequestSchema.parse>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "model.catalog";
      params: { sessionId?: string };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "model.default.set";
      params: ReturnType<typeof parseSparkDefaultModelSetRequest>;
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "provider.auth.api-key.set";
      params: { providerName: string; apiKey: string };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "provider.auth.logout" | "provider.auth.login.start";
      params: { providerName: string };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "provider.auth.login.status" | "provider.auth.login.cancel";
      params: { flowId: string };
      sparkCommand: SparkCommand;
    }
  | {
      id: string;
      method: "provider.auth.login.respond";
      params: { flowId: string; promptId: string; value: string };
      sparkCommand: SparkCommand;
    };

export type LocalRpcWireRequest = {
  id: string;
  method: string;
  params?: unknown;
  sparkCommand?: SparkCommand;
};

export type LocalTurnCancelParams = LocalTurnCancelRequest;

export interface LocalHumanInteractionRespondParams {
  interactionRequestId: string;
  sessionId?: string;
  invocationId?: string;
  humanResponseId?: string;
  status: "answered" | "cancelled";
  answers: Record<string, unknown>;
  responseArtifactRefs: string[];
}

export type LocalHumanInteractionRespondResult = SparkDaemonHumanWaitDeliveryResult;

export type LocalRpcErrorPayload = {
  message: string;
  code?: string;
  kind?: WorkspacePathConflictError["kind"];
};

export type LocalRpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: LocalRpcErrorPayload };

export type LocalTurnSubmitParams = {
  sessionId: string;
  prompt: string;
  idempotencyKey?: string;
  reset?: boolean;
  assignment?: SparkAssignment;
  messageMetadata?: Record<string, unknown>;
};

export type LocalWorkspaceRegisterParams = {
  serverUrl: string;
  allowInsecureHttp?: boolean;
  localPath: string;
  registrationToken?: string;
  localWorkspaceKey?: string;
  displayName?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  profile?: NonNullable<SparkDaemonWorkspace["profile"]>;
};

export type LocalWorkspaceEnsureLocalParams = LocalWorkspaceEnsureLocalRequest;
export type LocalWorkspaceClientAttachParams = LocalWorkspaceClientAttachRequest;
export type LocalWorkspaceClientHeartbeatParams = LocalWorkspaceClientHeartbeatRequest;
export type LocalWorkspaceExecutorEnsureParams = LocalWorkspaceExecutorEnsureRequest;

export class LocalRpcUnavailableError extends Error {}

export class SparkDaemonStillStartingError extends Error {}

export function localRpcSocketPath(paths: SparkPaths): string {
  return join(paths.runtimeDir, "daemon.sock");
}
