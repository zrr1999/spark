import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import {
  parseSparkAssignment,
  SPARK_PROTOCOL_VERSION,
  parseSparkDefaultModelSetRequest,
  parseSparkSessionView,
  sparkInvocationListRequestSchema,
  sparkInvocationListResultSchema,
  sparkInvocationRetentionPreviewRequestSchema,
  sparkInvocationRetentionPreviewResultSchema,
  sparkInvocationRetryRequestSchema,
  sparkInvocationRetryResultSchema,
  sparkTurnCancelRequestSchema,
  sparkTurnCancelResultSchema,
  sparkTurnResultSchema,
  sparkTurnStatusRequestSchema,
  sparkTurnStatusResultSchema,
  sparkTurnStreamPageSchema,
  sparkTurnStreamRequestSchema,
  sparkTurnSubmitRequestSchema,
  sparkTurnSubmitResultSchema,
  parseSparkSessionSetModelRequest,
  parseSparkSessionSetThinkingRequest,
  sparkSessionArchiveRequestSchema,
  sparkSessionBindRequestSchema,
  sparkSessionCreateRequestSchema,
  sparkSessionGetRequestSchema,
  sparkSessionListRequestSchema,
  sparkSessionUnbindRequestSchema,
  type SparkAssignment,
  type SparkCommand,
  type SparkDaemonEvent,
  type SparkInvocationListResult,
  type SparkInvocationRetentionPreviewResult,
  type SparkInvocationRetryResult,
  type SparkInvocationStatus,
  type SparkSessionArchiveRequest,
  type SparkSessionBindRequest,
  type SparkSessionCreateRequest,
  type SparkSessionGetRequest,
  type SparkSessionListRequest,
  type SparkSessionRegistryRecord,
  type SparkSessionView,
  type SparkSessionUnbindRequest,
  type SparkTurnCancelResult,
  type SparkTurnResult,
  type SparkTurnStatusResult,
  type SparkTurnStreamPage,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import {
  parseChannelsConfig,
  type ChannelNotifyInput,
  type ChannelsConfig,
} from "@zendev-lab/spark-channels";
import {
  loadSparkSessionSnapshot,
  SparkSessionMailStore,
  SparkSessionRegistryError,
} from "@zendev-lab/spark-session";
import type { SparkPaths } from "@zendev-lab/spark-system";
import {
  requestSparkDaemonLocalRpcWire,
  SparkDaemonLocalRpcError,
  SparkDaemonLocalRpcRemoteError,
  SparkDaemonLocalRpcUnavailableError,
} from "@zendev-lab/spark-system/daemon-local-rpc";
import { sparkCommandFromLocalRpcRequest } from "./command-dispatcher.ts";
import { readSparkDaemonConfig } from "./config.ts";
import type {
  DaemonChannelIngressRuntime,
  DaemonChannelIngressStatus,
} from "./channels/ingress.ts";
import {
  deliverSessionNotification,
  type SessionNotificationDeliveryResult,
} from "./session-notification-delivery.ts";
import {
  validateSparkDaemonTask,
  type SparkDaemonLifecycleSnapshot,
  type SparkDaemonRestartRequestResult,
  type SparkDaemonTask,
} from "./core/index.ts";
import {
  SparkInvocationStore,
  isRetryableInvocationError,
  type SparkInvocationSessionActivity,
} from "./store/invocations.ts";
import {
  attachWorkspace,
  attachWorkspaceClient,
  ensureLocalWorkspace,
  ensureWorkspaceExecutorClient,
  heartbeatWorkspaceClient,
  listWorkspaces,
  planWorkspaceRegistration,
  registerWorkspace,
  sparkDaemonServerStatusSummaries,
  type RegisterWorkspaceOptions,
  releaseWorkspaceClient,
  stopWorkspace,
  type SparkDaemonWorkspace,
  type SparkDaemonWorkspaceClient,
  WorkspacePathConflictError,
  resolveWorkspaceLocalPath,
} from "./store/workspaces.js";
import {
  ensureSparkDaemonRegistrationForWorkspace,
  RegistrationGrantRefusedError,
  verifySparkDaemonWorkspaceConnection,
} from "./registration.js";
import { createDaemonSessionRegistry, type DaemonSessionRegistry } from "./session-registry.ts";
import type { SparkDaemonModelControl } from "./model-control.ts";

export {
  createDaemonSessionRegistry,
  createSerializedDaemonSessionRegistry,
  type DaemonSessionRegistry,
} from "./session-registry.ts";

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
  lifecycle: SparkDaemonLifecycleSnapshot;
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

type LocalRpcMailStore = Pick<SparkSessionMailStore, "list"> &
  Partial<Pick<SparkSessionMailStore, "get" | "recordChannelDelivery">>;

interface LocalRpcHandlerOptions {
  ensureSparkDaemonRegistrationForWorkspace?: typeof ensureSparkDaemonRegistrationForWorkspace;
  verifySparkDaemonWorkspaceConnection?: typeof verifySparkDaemonWorkspaceConnection;
  channelIngress?: Pick<DaemonChannelIngressRuntime, "status" | "configure" | "reload" | "notify">;
  sessionRegistry?: DaemonSessionRegistry;
  modelControl?: SparkDaemonModelControl;
  mailStore?: LocalRpcMailStore;
  onStopRequested?: () => void;
  onRestart?: () => LocalDaemonRestartResult | Promise<LocalDaemonRestartResult>;
  getLifecycle?: () => SparkDaemonLifecycleSnapshot;
}

type LocalRpcRequest =
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
      params: SparkSessionGetRequest;
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

type LocalRpcWireRequest = {
  id: string;
  method: string;
  params?: unknown;
  sparkCommand?: SparkCommand;
};

type LocalTurnCancelParams = LocalTurnCancelRequest;

type LocalRpcErrorPayload = {
  message: string;
  code?: string;
  kind?: WorkspacePathConflictError["kind"];
};

type LocalRpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: LocalRpcErrorPayload };

export class LocalRpcUnavailableError extends Error {}

export function localRpcSocketPath(paths: SparkPaths): string {
  return join(paths.runtimeDir, "daemon.sock");
}

export async function startLocalRpcServer(options: {
  paths: SparkPaths;
  sparkHome: string;
  db: DatabaseSync;
  forceCloseTimeoutMs?: number;
  onStop?: () => void | Promise<void>;
  onStopRequested?: () => void;
  onRestart?: () => LocalDaemonRestartResult | Promise<LocalDaemonRestartResult>;
  getLifecycle?: () => SparkDaemonLifecycleSnapshot;
  eventBus?: SparkDaemonLocalEventBus;
  channelIngress?: DaemonChannelIngressRuntime;
  sessionRegistry?: DaemonSessionRegistry;
  modelControl?: SparkDaemonModelControl;
  mailStore?: LocalRpcMailStore;
}): Promise<LocalRpcServer> {
  const socketPath = localRpcSocketPath(options.paths);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });
  const sockets = new Map<Socket, { pending: number; closeWhenIdle: boolean }>();
  // Transport shutdown may time out, but handlers still own daemon resources
  // until they settle. Keep that lifetime independent from socket lifetime.
  const inFlightRequests = new Set<Promise<void>>();
  let closePromise: Promise<void> | undefined;
  let closing = false;

  const config = readSparkDaemonConfig(options.paths);
  const sessionRegistry =
    options.sessionRegistry ??
    createDaemonSessionRegistry(options.sparkHome, {
      daemonId: config.installationId,
      daemonCwd: process.cwd(),
      resolveWorkspaceCwd: (workspaceId) => resolveWorkspaceLocalPath(options.db, workspaceId),
    });
  const mailStore =
    options.mailStore ?? new SparkSessionMailStore({ sparkHome: options.sparkHome });
  const server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    const state = { pending: 0, closeWhenIdle: false };
    sockets.set(socket, state);
    socket.once("close", () => sockets.delete(socket));
    handleLocalRpcSocket(
      socket,
      options.paths,
      options.db,
      options.onStop,
      options.eventBus,
      {
        sessionRegistry,
        mailStore,
        ...(options.channelIngress ? { channelIngress: options.channelIngress } : {}),
        ...(options.modelControl ? { modelControl: options.modelControl } : {}),
        ...(options.onStopRequested ? { onStopRequested: options.onStopRequested } : {}),
        ...(options.onRestart ? { onRestart: options.onRestart } : {}),
        ...(options.getLifecycle ? { getLifecycle: options.getLifecycle } : {}),
      },
      {
        onRequestStart: (request) => {
          state.pending += 1;
          inFlightRequests.add(request);
          void request.then(
            () => inFlightRequests.delete(request),
            () => inFlightRequests.delete(request),
          );
        },
        onRequestSettled: () => {
          state.pending -= 1;
          if (state.closeWhenIdle && state.pending === 0) socket.end();
        },
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

  return {
    socketPath,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      const transportClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          rmSync(socketPath, { force: true });
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      for (const [socket, state] of sockets) {
        state.closeWhenIdle = true;
        // Freeze request admission before snapshotting in-flight work below.
        socket.pause();
        if (state.pending === 0) socket.end();
      }
      const forceClose = setTimeout(() => {
        for (const socket of sockets.keys()) socket.destroy();
      }, options.forceCloseTimeoutMs ?? 5_000);
      forceClose.unref();
      const requestsSettled = Promise.allSettled([...inFlightRequests]);
      closePromise = Promise.allSettled([transportClosed, requestsSettled])
        .then(([transport]) => {
          if (transport.status === "rejected") throw transport.reason;
        })
        .finally(() => clearTimeout(forceClose));
      return closePromise;
    },
  };
}

export async function requestWorkspaceList(paths: SparkPaths): Promise<WorkspaceListResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "workspace.list" }, workspaceList);
}

export async function requestDaemonStatus(paths: SparkPaths): Promise<LocalDaemonStatusResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "daemon.status" }, daemonStatus);
}

export async function requestDaemonStop(paths: SparkPaths): Promise<LocalDaemonStopResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "daemon.stop" }, daemonStop);
}

export async function requestDaemonRestart(paths: SparkPaths): Promise<LocalDaemonRestartResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "daemon.restart" }, daemonRestart);
}

export async function requestChannelStatus(
  paths: SparkPaths,
  workspaceId: string,
): Promise<DaemonChannelIngressStatus> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "channel.status",
      params: { workspaceId },
    },
    channelIngressStatus,
  );
}

export async function requestChannelConfigure(
  paths: SparkPaths,
  workspaceId: string,
  config: ChannelsConfig,
): Promise<DaemonChannelIngressStatus> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "channel.configure",
      params: { workspaceId, config },
    },
    channelIngressStatus,
  );
}

export async function requestChannelReload(
  paths: SparkPaths,
  workspaceId: string,
): Promise<DaemonChannelIngressStatus> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "channel.reload",
      params: { workspaceId },
    },
    channelIngressStatus,
  );
}

export async function requestChannelNotify(
  paths: SparkPaths,
  params: ChannelNotifyInput & { workspaceId: string },
): Promise<unknown> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "channel.notify", params },
    (value) => value,
  );
}

export async function requestTurnSubmit(
  paths: SparkPaths,
  params: LocalTurnSubmitParams,
): Promise<LocalTurnSubmitResult> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "turn.submit", params: localTurnSubmitParams(params) },
    turnSubmit,
  );
}

export async function requestTurnStatus(
  paths: SparkPaths,
  invocationId: string,
): Promise<LocalTurnStatusResult> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "turn.status", params: { invocationId } },
    (value) => sparkTurnStatusResultSchema.parse(value),
  );
}

export async function requestTurnStream(
  paths: SparkPaths,
  params: { invocationId: string; after?: number; limit?: number },
): Promise<LocalTurnStreamResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "turn.stream", params }, (value) =>
    sparkTurnStreamPageSchema.parse(value),
  );
}

export async function requestTurnCancel(
  paths: SparkPaths,
  params: LocalTurnCancelParams,
): Promise<LocalTurnCancelResult> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "turn.cancel", params: localTurnCancelParams(params) },
    (value) => sparkTurnCancelResultSchema.parse(value),
  );
}

export async function requestWorkspaceRegister(
  paths: SparkPaths,
  params: LocalWorkspaceRegisterRequest,
): Promise<SparkDaemonWorkspace> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "workspace.register",
      params: localWorkspaceRegisterParams(params),
    },
    sparkDaemonWorkspace,
  );
}

export async function requestWorkspaceEnsureLocal(
  paths: SparkPaths,
  params: LocalWorkspaceEnsureLocalRequest,
): Promise<SparkDaemonWorkspace> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "workspace.ensure-local",
      params: localWorkspaceEnsureLocalParams(params),
    },
    sparkDaemonWorkspace,
  );
}

export async function requestWorkspaceAttach(
  paths: SparkPaths,
  id: string,
): Promise<SparkDaemonWorkspace> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "workspace.attach", params: { id } },
    sparkDaemonWorkspace,
  );
}

export async function requestWorkspaceStop(
  paths: SparkPaths,
  id: string,
): Promise<SparkDaemonWorkspace> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "workspace.stop", params: { id } },
    sparkDaemonWorkspace,
  );
}

export async function requestWorkspaceClientAttach(
  paths: SparkPaths,
  params: LocalWorkspaceClientAttachRequest,
): Promise<LocalWorkspaceClientResult> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "workspace.client.attach",
      params: localWorkspaceClientAttachParams(params),
    },
    localWorkspaceClientResult,
  );
}

export async function requestWorkspaceClientHeartbeat(
  paths: SparkPaths,
  params: LocalWorkspaceClientHeartbeatRequest,
): Promise<LocalWorkspaceClientResult> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "workspace.client.heartbeat",
      params: localWorkspaceClientHeartbeatParams(params),
    },
    localWorkspaceClientResult,
  );
}

export async function requestWorkspaceClientRelease(
  paths: SparkPaths,
  clientId: string,
): Promise<LocalWorkspaceClientResult> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "workspace.client.release", params: { clientId } },
    localWorkspaceClientResult,
  );
}

export async function requestWorkspaceExecutorEnsure(
  paths: SparkPaths,
  params: LocalWorkspaceExecutorEnsureRequest,
): Promise<LocalWorkspaceClientResult> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "workspace.executor.ensure",
      params: localWorkspaceExecutorEnsureParams(params),
    },
    localWorkspaceClientResult,
  );
}

export async function requestSessionSnapshot(
  paths: SparkPaths,
  sessionId: string,
): Promise<SparkSessionView> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "session.snapshot", params: { sessionId } },
    parseSparkSessionView,
  );
}

async function localRpcRequest<T>(
  paths: SparkPaths,
  request: LocalRpcWireRequest,
  parseResult: (value: unknown) => T,
): Promise<T> {
  const socketPath = localRpcSocketPath(paths);
  try {
    const result = await requestSparkDaemonLocalRpcWire<unknown>(request, { socketPath });
    return parseResult(result);
  } catch (error) {
    if (error instanceof SparkDaemonLocalRpcUnavailableError) {
      throw new LocalRpcUnavailableError(error.message);
    }
    if (error instanceof SparkDaemonLocalRpcRemoteError) {
      throw localRpcResponseError(error.payload);
    }
    if (error instanceof SparkDaemonLocalRpcError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

function handleLocalRpcSocket(
  socket: Socket,
  paths: SparkPaths,
  db: DatabaseSync,
  onStop: (() => void | Promise<void>) | undefined,
  eventBus: SparkDaemonLocalEventBus | undefined,
  handlerOptions: LocalRpcHandlerOptions,
  lifecycle: { onRequestStart(request: Promise<void>): void; onRequestSettled(): void },
): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  socket.on("error", () => {
    // Clients may time out or disconnect before a long-running request writes
    // its response. Treat broken local RPC pipes as per-client failures rather
    // than daemon-fatal uncaught Socket errors.
  });
  socket.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const request = handleLocalRpcLine(line, paths, db, onStop, handlerOptions).then(
        async (response) => {
          await writeLocalRpcResponse(socket, response);
        },
      );
      lifecycle.onRequestStart(request);
      void request.then(
        () => lifecycle.onRequestSettled(),
        () => lifecycle.onRequestSettled(),
      );
      newline = buffer.indexOf("\n");
    }
  });
}

function writeLocalRpcResponse(socket: Socket, response: LocalRpcResponse): Promise<void> {
  if (socket.destroyed || !socket.writable) return Promise.resolve();
  return new Promise<void>((resolve) => {
    socket.write(`${JSON.stringify(response)}\n`, (error) => {
      if (error) socket.destroy();
      resolve();
    });
  });
}

export async function handleLocalRpcLine(
  line: string,
  paths: SparkPaths,
  db: DatabaseSync,
  onStop: (() => void | Promise<void>) | undefined,
  options: LocalRpcHandlerOptions = {},
): Promise<LocalRpcResponse> {
  let requestId = "unknown";
  const ensureRegistration =
    options.ensureSparkDaemonRegistrationForWorkspace ?? ensureSparkDaemonRegistrationForWorkspace;
  const verifyWorkspaceConnection =
    options.verifySparkDaemonWorkspaceConnection ?? verifySparkDaemonWorkspaceConnection;
  try {
    // Capture the caller id before full request parsing so validation failures
    // (e.g. channel.configure schema errors) still round-trip the same id.
    // Otherwise the client sees id "unknown" and reports a generic
    // "Invalid local RPC response" instead of the real parse error.
    try {
      const raw = JSON.parse(line) as unknown;
      if (isRecord(raw) && typeof raw.id === "string" && raw.id.trim()) {
        requestId = raw.id;
      }
    } catch {
      // parseLocalRpcRequest below owns the JSON/shape error message.
    }
    const request = parseLocalRpcRequest(line);
    requestId = request.id;
    switch (request.method) {
      case "daemon.status": {
        const store = new SparkInvocationStore(db);
        const oldestActive = store.oldestActive();
        return {
          id: request.id,
          ok: true,
          result: {
            servers: sparkDaemonServerStatusSummaries(db),
            invocations: store.counts(),
            invocationHealth: {
              ...(oldestActive.queued ? { oldestQueuedAt: oldestActive.queued } : {}),
              ...(oldestActive.running ? { oldestRunningAt: oldestActive.running } : {}),
            },
            lifecycle: options.getLifecycle?.() ?? { state: "running" },
            observedAt: new Date().toISOString(),
          },
        };
      }
      case "daemon.stop":
        options.onStopRequested?.();
        setTimeout(() => {
          void onStop?.();
        }, 0);
        return {
          id: request.id,
          ok: true,
          result: {
            stopping: true,
            observedAt: new Date().toISOString(),
          },
        };
      case "daemon.restart": {
        if (!options.onRestart) {
          throw new Error("Spark daemon restart control is not available.");
        }
        return {
          id: request.id,
          ok: true,
          result: await options.onRestart(),
        };
      }
      case "channel.status": {
        const channelIngress = requireChannelIngress(options);
        return {
          id: request.id,
          ok: true,
          result: channelIngress.status(request.params.workspaceId),
        };
      }
      case "channel.configure": {
        const channelIngress = requireChannelIngress(options);
        const result = await channelIngress.configure(
          request.params.workspaceId,
          request.params.config,
        );
        return { id: request.id, ok: true, result };
      }
      case "channel.reload": {
        const channelIngress = requireChannelIngress(options);
        const result = await channelIngress.reload(request.params.workspaceId);
        return { id: request.id, ok: true, result };
      }
      case "channel.notify": {
        const channelIngress = requireChannelIngress(options);
        const { workspaceId, ...notifyInput } = request.params;
        const result = await channelIngress.notify(workspaceId, notifyInput);
        return { id: request.id, ok: true, result };
      }
      case "session.notification.deliver": {
        const result = await deliverSessionNotificationFromLocalRpc(options, request.params);
        return { id: request.id, ok: true, result };
      }
      case "turn.submit": {
        const model = await effectiveTurnModel(options, request.params.sessionId);
        const thinkingLevel = await effectiveTurnThinkingLevel(options, request.params.sessionId);
        const route = await sessionTurnRoute(
          options,
          db,
          request.params.sessionId,
          request.params.assignment,
        );
        const result = await enqueueManagedSessionTurn(
          options,
          request.params.sessionId,
          async () =>
            submitInvocationTask(
              db,
              {
                type: "session.run",
                sessionId: request.params.sessionId,
                prompt: request.params.prompt,
                ...(model ? { model } : {}),
                ...(thinkingLevel ? { thinkingLevel } : {}),
                ...(request.params.reset !== undefined ? { reset: request.params.reset } : {}),
                ...(route.cwd ? { cwd: route.cwd } : {}),
                ...(route.workspaceId ? { workspaceId: route.workspaceId } : {}),
                ...(request.params.assignment ? { assignment: request.params.assignment } : {}),
                ...(request.params.messageMetadata
                  ? { messageMetadata: request.params.messageMetadata }
                  : {}),
                actor: "spark-daemon-local-rpc",
              },
              request.params.idempotencyKey,
              invocationSource(request.params.messageMetadata),
            ),
        );
        const submittedInvocation = new SparkInvocationStore(db).require(result.invocationId);
        if (isTerminalInvocationStatus(submittedInvocation.status)) {
          await settleManagedSessionTurn(options.sessionRegistry, request.params.sessionId);
        }
        return { id: request.id, ok: true, result };
      }
      case "turn.status": {
        return {
          id: request.id,
          ok: true,
          result: invocationStatusResult(new SparkInvocationStore(db), request.params.invocationId),
        };
      }
      case "turn.result": {
        return {
          id: request.id,
          ok: true,
          result: invocationResult(new SparkInvocationStore(db), request.params.invocationId),
        };
      }
      case "invocation.list": {
        return {
          id: request.id,
          ok: true,
          result: invocationListResult(new SparkInvocationStore(db), request.params),
        };
      }
      case "invocation.retry": {
        const store = new SparkInvocationStore(db);
        const retryKey = `invocation.retry:${request.params.invocationId}`;
        const existing = store.findByIdempotencyKey(retryKey);
        const original = store.require(request.params.invocationId);
        if (!existing && original.sessionId) {
          await options.sessionRegistry?.recordTurnQueued(original.sessionId);
        }
        let retried;
        try {
          retried = store.retry(request.params.invocationId);
        } catch (error) {
          if (!existing && original.sessionId) {
            await settleManagedSessionTurn(options.sessionRegistry, original.sessionId);
          }
          throw error;
        }
        return {
          id: request.id,
          ok: true,
          result: sparkInvocationRetryResultSchema.parse({
            invocationId: retried.invocationId,
            retryOfInvocationId: request.params.invocationId,
            status: "queued",
            acceptedAt: retried.createdAt,
          }),
        };
      }
      case "invocation.retention.preview": {
        const preview = new SparkInvocationStore(db).retentionPreview(
          request.params.before,
          request.params.limit,
        );
        return {
          id: request.id,
          ok: true,
          result: sparkInvocationRetentionPreviewResultSchema.parse({
            ...preview,
            dryRun: true,
            observedAt: new Date().toISOString(),
          }),
        };
      }
      case "turn.stream": {
        return {
          id: request.id,
          ok: true,
          result: sparkTurnStreamPageSchema.parse(
            new SparkInvocationStore(db).eventPage(
              request.params.invocationId,
              request.params.after,
              request.params.limit,
            ),
          ),
        };
      }
      case "turn.cancel": {
        const reason = request.params.reason ?? "Spark local RPC turn cancellation requested.";
        const result = await cancelManagedTurn(
          new SparkInvocationStore(db),
          request.params.invocationId,
          reason,
          options.sessionRegistry,
        );
        return {
          id: request.id,
          ok: true,
          result,
        };
      }
      case "workspace.list":
        return {
          id: request.id,
          ok: true,
          result: {
            workspaces: listWorkspaces(db),
            observedAt: new Date().toISOString(),
          },
        };
      case "workspace.ensure-local":
        return {
          id: request.id,
          ok: true,
          result: ensureLocalWorkspace(db, request.params),
        };
      case "workspace.register":
        const planned = planWorkspaceRegistration(db, request.params);
        const serviceRegistration = await ensureRegistration(paths, {
          serverUrl: planned.serverUrl,
          ...(request.params.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
          workspaceRegistration: {
            localWorkspaceKey: planned.localWorkspaceKey,
            localPath: planned.localPath,
            displayName: planned.displayName,
            workspaceName: planned.workspaceName,
            workspaceSlug: planned.workspaceSlug,
          },
          ...(request.params.registrationToken
            ? { registrationToken: request.params.registrationToken }
            : {}),
        });
        if (!serviceRegistration.workspaceBinding) {
          throw new Error("Workspace registration did not return a server workspace connection.");
        }
        await verifyWorkspaceConnection({
          config: serviceRegistration.config,
          workspaceBinding: serviceRegistration.workspaceBinding,
          localPath: planned.localPath,
        });
        return {
          id: request.id,
          ok: true,
          result: registerWorkspace(db, {
            ...request.params,
            ...(request.params.registrationToken
              ? { consumedRegistrationToken: request.params.registrationToken }
              : {}),
            ...(serviceRegistration.config.runtimeId && serviceRegistration.config.runtimeToken
              ? {
                  serverCredential: {
                    runtimeId: serviceRegistration.config.runtimeId,
                    runtimeToken: serviceRegistration.config.runtimeToken,
                    ...(serviceRegistration.config.runtimeTokenExpiresAt
                      ? { runtimeTokenExpiresAt: serviceRegistration.config.runtimeTokenExpiresAt }
                      : {}),
                    ...(serviceRegistration.config.refreshToken
                      ? { refreshToken: serviceRegistration.config.refreshToken }
                      : {}),
                    ...(serviceRegistration.config.refreshTokenExpiresAt
                      ? { refreshTokenExpiresAt: serviceRegistration.config.refreshTokenExpiresAt }
                      : {}),
                  },
                }
              : {}),
            ...(serviceRegistration.workspaceBinding
              ? {
                  serverWorkspaceId: serviceRegistration.workspaceBinding.workspaceId,
                  serverBindingId: serviceRegistration.workspaceBinding.bindingId,
                  serverStatus: serviceRegistration.workspaceBinding.status,
                }
              : {}),
          }),
        };
      case "workspace.attach":
        return { id: request.id, ok: true, result: attachWorkspace(db, { id: request.params.id }) };
      case "workspace.stop":
        return { id: request.id, ok: true, result: stopWorkspace(db, { id: request.params.id }) };
      case "workspace.client.attach": {
        const client = attachWorkspaceClient(db, request.params);
        return { id: request.id, ok: true, result: workspaceClientResult(db, client) };
      }
      case "workspace.client.heartbeat": {
        const client = heartbeatWorkspaceClient(db, request.params);
        return { id: request.id, ok: true, result: workspaceClientResult(db, client) };
      }
      case "workspace.client.release": {
        const client = releaseWorkspaceClient(db, request.params);
        return { id: request.id, ok: true, result: workspaceClientResult(db, client) };
      }
      case "workspace.executor.ensure": {
        const client = ensureWorkspaceExecutorClient(db, request.params);
        return { id: request.id, ok: true, result: workspaceClientResult(db, client) };
      }
      case "session.list": {
        const sessions = await requireSessionRegistry(options).list(request.params);
        const activities = new SparkInvocationStore(db).sessionActivities(
          sessions.map((session) => session.sessionId),
        );
        return {
          id: request.id,
          ok: true,
          result: sessions.map((session) =>
            projectSessionInvocationState(session, activities.get(session.sessionId)),
          ),
        };
      }
      case "session.get": {
        const session = await requireSessionRegistry(options).get(request.params.sessionId);
        if (!session) {
          throw new SparkSessionRegistryError(
            "session_not_found",
            `unknown session: ${request.params.sessionId}`,
          );
        }
        return {
          id: request.id,
          ok: true,
          result: projectSessionInvocationState(
            session,
            new SparkInvocationStore(db).sessionActivity(session.sessionId),
          ),
        };
      }
      case "session.snapshot": {
        const registeredSession = await requireSessionRegistry(options).get(
          request.params.sessionId,
        );
        if (!registeredSession) {
          throw new SparkSessionRegistryError(
            "session_not_found",
            `unknown session: ${request.params.sessionId}`,
          );
        }
        const session = projectSessionInvocationState(
          registeredSession,
          new SparkInvocationStore(db).sessionActivity(registeredSession.sessionId),
        );
        if (!paths.piAgentDir) {
          throw new Error("Spark daemon native session storage is not available.");
        }
        const snapshot = await loadSparkSessionSnapshot({
          sessionsRoot: join(paths.piAgentDir, "sessions"),
          session,
        });
        const projected = projectPendingSessionTurns(db, snapshot);
        return {
          id: request.id,
          ok: true,
          result: await projectSessionMailbox(options, projected),
        };
      }
      case "session.create": {
        const session = await requireSessionRegistry(options).create(request.params);
        return { id: request.id, ok: true, result: session };
      }
      case "session.bind": {
        const session = await requireSessionRegistry(options).bind(request.params);
        return { id: request.id, ok: true, result: session };
      }
      case "session.unbind": {
        const session = await requireSessionRegistry(options).unbind(
          request.params.sessionId,
          request.params.externalKey,
        );
        return { id: request.id, ok: true, result: session };
      }
      case "session.archive": {
        const session = await requireSessionRegistry(options).archive(request.params.sessionId);
        return { id: request.id, ok: true, result: session };
      }
      case "session.model.set": {
        const session = await requireModelControl(options).setSessionModel(
          request.params.sessionId,
          request.params.model,
        );
        return { id: request.id, ok: true, result: session };
      }
      case "session.thinking.set": {
        const session = await requireModelControl(options).setSessionThinkingLevel(
          request.params.sessionId,
          request.params.thinkingLevel,
        );
        return { id: request.id, ok: true, result: session };
      }
      case "model.catalog": {
        const snapshot = await requireModelControl(options).snapshot(request.params.sessionId);
        return { id: request.id, ok: true, result: snapshot };
      }
      case "model.default.set": {
        const snapshot = await requireModelControl(options).setDefaultModel(request.params.model);
        return { id: request.id, ok: true, result: snapshot };
      }
      case "provider.auth.api-key.set": {
        const snapshot = await requireModelControl(options).setApiKey(
          request.params.providerName,
          request.params.apiKey,
        );
        return { id: request.id, ok: true, result: snapshot };
      }
      case "provider.auth.logout": {
        const result = await requireModelControl(options).logout(request.params.providerName);
        return { id: request.id, ok: true, result };
      }
      case "provider.auth.login.start": {
        const flow = await requireModelControl(options).startOAuth(request.params.providerName);
        return { id: request.id, ok: true, result: flow };
      }
      case "provider.auth.login.status": {
        const flow = await requireModelControl(options).oauthStatus(request.params.flowId);
        return { id: request.id, ok: true, result: flow };
      }
      case "provider.auth.login.respond": {
        const flow = await requireModelControl(options).respondOAuth(
          request.params.flowId,
          request.params.promptId,
          request.params.value,
        );
        return { id: request.id, ok: true, result: flow };
      }
      case "provider.auth.login.cancel": {
        const flow = await requireModelControl(options).cancelOAuth(request.params.flowId);
        return { id: request.id, ok: true, result: flow };
      }
    }
  } catch (error) {
    return {
      id: requestId,
      ok: false,
      error: localRpcError(error),
    };
  }
}

function workspaceClientResult(
  db: DatabaseSync,
  client: SparkDaemonWorkspaceClient,
): LocalWorkspaceClientResult {
  const workspace = listWorkspaces(db).find((candidate) => candidate.id === client.workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace connection: ${client.workspaceId}`);
  }
  return { client, workspace, observedAt: new Date().toISOString() };
}

function localRpcError(error: unknown): LocalRpcErrorPayload {
  if (error instanceof SparkSessionRegistryError) {
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
  return { message: error instanceof Error ? error.message : String(error) };
}

function requireSessionRegistry(options: LocalRpcHandlerOptions): DaemonSessionRegistry {
  if (!options.sessionRegistry) {
    throw new Error("Spark daemon session registry is not available.");
  }
  return options.sessionRegistry;
}

function requireModelControl(options: LocalRpcHandlerOptions): SparkDaemonModelControl {
  if (!options.modelControl) {
    throw new Error("Spark daemon model/auth control is not available.");
  }
  return options.modelControl;
}

async function effectiveTurnModel(
  options: LocalRpcHandlerOptions,
  sessionId: string,
): Promise<string | undefined> {
  if (!options.modelControl) return undefined;
  const model = await options.modelControl.effectiveModel(sessionId);
  await options.modelControl.prepareModel(model);
  return `${model.providerName}/${model.modelId}`;
}

async function effectiveTurnThinkingLevel(
  options: LocalRpcHandlerOptions,
  sessionId: string,
): Promise<string | undefined> {
  if (!options.modelControl) return undefined;
  return await options.modelControl.effectiveThinkingLevel(sessionId);
}

async function sessionTurnRoute(
  options: LocalRpcHandlerOptions,
  db: DatabaseSync,
  sessionId: string,
  assignment?: SparkAssignment,
): Promise<{ cwd?: string; workspaceId?: string }> {
  if (!options.sessionRegistry) {
    // Lightweight test/embedding callers may omit registry ownership. The
    // production local server always supplies it.
    return assignment?.target.workspaceId ? { workspaceId: assignment.target.workspaceId } : {};
  }
  const session = await options.sessionRegistry.get(sessionId);
  if (!session) {
    throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
  }
  if (session.scope.kind === "daemon") {
    if (assignment?.target.workspaceId) {
      throw new SparkSessionRegistryError(
        "session_scope_mismatch",
        `daemon-global session ${sessionId} cannot target a workspace`,
      );
    }
    const cwd = session.cwd?.trim();
    if (!cwd) {
      throw new SparkSessionRegistryError(
        "session_cwd_unavailable",
        `daemon-global session ${sessionId} has no execution directory`,
      );
    }
    return { cwd };
  }
  const workspaceId = session.scope.workspaceId;
  if (assignment?.target.workspaceId && assignment.target.workspaceId !== workspaceId) {
    throw new SparkSessionRegistryError(
      "session_scope_mismatch",
      `session ${sessionId} belongs to workspace ${workspaceId}, not ${assignment.target.workspaceId}`,
    );
  }
  const sessionCwd = session.cwd?.trim();
  const cwd =
    sessionCwd && sessionCwd !== "/" ? sessionCwd : resolveWorkspaceLocalPath(db, workspaceId);
  if (!cwd?.trim() || cwd.trim() === "/") {
    throw new SparkSessionRegistryError(
      "session_cwd_unavailable",
      `workspace session ${sessionId} has no daemon-local execution directory`,
    );
  }
  return { workspaceId, cwd: cwd.trim() };
}

function projectPendingSessionTurns(
  db: DatabaseSync,
  snapshot: SparkSessionView,
): SparkSessionView {
  const pending = new SparkInvocationStore(db).listPendingForSession(snapshot.sessionId);
  if (pending.length === 0) {
    return snapshot.status === "idle"
      ? snapshot
      : parseSparkSessionView({ ...snapshot, status: "idle" });
  }

  const messages = pending.map((invocation) => ({
    id: `invocation:${invocation.invocationId}`,
    role: "user" as const,
    text: validateSparkDaemonTask(invocation.task).prompt,
    status: "done" as const,
    createdAt: invocation.createdAt,
    metadata: {
      source: "daemon.invocation",
      invocationId: invocation.invocationId,
    },
  }));
  const pendingUpdatedAt = messages.at(-1)!.createdAt;
  return parseSparkSessionView({
    ...snapshot,
    status: "running",
    messages: [...snapshot.messages, ...messages],
    updatedAt:
      snapshot.updatedAt && snapshot.updatedAt > pendingUpdatedAt
        ? snapshot.updatedAt
        : pendingUpdatedAt,
  });
}

/**
 * Reconcile the registry's convenience status with durable invocation truth at
 * the daemon boundary. A daemon crash can leave registry.json at `running`
 * after SQLite has already recovered every invocation to a terminal state.
 */
function projectSessionInvocationState(
  session: SparkSessionRegistryRecord,
  activity: SparkInvocationSessionActivity = { active: false },
): SparkSessionRegistryRecord {
  if (session.status === "archived") return session;
  const status = activity.active ? "running" : "ready";
  const updatedAt =
    activity.updatedAt && activity.updatedAt > session.updatedAt
      ? activity.updatedAt
      : session.updatedAt;
  if (status === session.status && updatedAt === session.updatedAt) return session;
  return { ...session, status, updatedAt };
}

async function projectSessionMailbox(
  options: LocalRpcHandlerOptions,
  snapshot: SparkSessionView,
): Promise<SparkSessionView> {
  if (!options.mailStore) return snapshot;
  const messages = await options.mailStore.list(snapshot.sessionId, { includeAcked: true });
  const mailbox = messages.slice(-50).map((message) => ({
    id: message.id,
    fromSessionId: message.fromSessionId,
    kind: message.kind,
    intent: message.intent,
    subject: message.subject,
    body: message.body,
    createdAt: message.createdAt,
    readAt: message.readAt,
    ackedAt: message.ackedAt,
  }));
  return parseSparkSessionView({ ...snapshot, mailbox });
}

function submitInvocationTask(
  db: DatabaseSync,
  task: SparkDaemonTask,
  idempotencyKey?: string,
  source?: { kind: string; ref?: string },
): LocalTurnSubmitResult {
  const invocation = new SparkInvocationStore(db).submit({
    sessionId: task.sessionId,
    workspaceBindingId: task.workspaceBindingId,
    idempotencyKey,
    prompt: task.prompt,
    task,
    ...(source ? { sourceKind: source.kind, sourceRef: source.ref } : {}),
  });
  return sparkTurnSubmitResultSchema.parse({
    invocationId: invocation.invocationId,
    status: "queued",
    acceptedAt: invocation.createdAt,
  });
}

function invocationSource(
  messageMetadata: Record<string, unknown> | undefined,
): { kind: string; ref?: string } | undefined {
  const mail = messageMetadata?.sessionMail;
  if (!isRecord(mail)) return undefined;
  const kind = mail.kind;
  if (kind !== "request" && kind !== "question") return undefined;
  const messageId = typeof mail.messageId === "string" ? mail.messageId.trim() : "";
  return { kind: `session.${kind}`, ...(messageId ? { ref: messageId } : {}) };
}

function invocationStatusResult(
  store: SparkInvocationStore,
  invocationId: string,
): LocalTurnStatusResult {
  const invocation = store.require(invocationId);
  const eventCursor = store.latestEventSequence(invocationId);
  return sparkTurnStatusResultSchema.parse({
    invocationId,
    sessionId: invocation.sessionId,
    retryOfInvocationId: invocation.retryOfInvocationId,
    status: invocation.status,
    createdAt: invocation.createdAt,
    updatedAt: invocation.updatedAt,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
    cancelReason: invocation.cancelReason,
    ...(invocation.errorMessage
      ? { error: { code: invocation.errorCode, message: invocation.errorMessage } }
      : {}),
    eventCursor,
  });
}

function invocationResult(store: SparkInvocationStore, invocationId: string): LocalTurnResult {
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

function boundedAssistantText(result: unknown): string | undefined {
  if (!isRecord(result) || typeof result.assistantText !== "string") return undefined;
  const text = result.assistantText.trim();
  return text ? text.slice(0, 262_144) : undefined;
}

function invocationListResult(
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

async function enqueueManagedSessionTurn<T>(
  options: LocalRpcHandlerOptions,
  sessionId: string,
  enqueue: () => Promise<T>,
): Promise<T> {
  await options.sessionRegistry?.recordTurnQueued(sessionId);
  try {
    return await enqueue();
  } catch (error) {
    try {
      await options.sessionRegistry?.recordTurnSettled(sessionId);
    } catch (settleError) {
      console.error("[spark-daemon] failed to settle rejected session turn", settleError);
    }
    throw error;
  }
}

async function cancelManagedTurn(
  store: SparkInvocationStore,
  invocationId: string,
  reason: string,
  sessionRegistry?: DaemonSessionRegistry,
): Promise<LocalTurnCancelResult> {
  const invocation = store.require(invocationId);
  const outcome = store.requestCancellation(invocationId, reason);
  if (outcome === "cancelled" && invocation.sessionId) {
    await settleManagedSessionTurn(sessionRegistry, invocation.sessionId);
  }
  const current = store.require(invocationId);
  return sparkTurnCancelResultSchema.parse({
    invocationId,
    status: current.status,
    cancelRequested: outcome === "cancelled" || outcome === "requested",
  });
}

function isTerminalInvocationStatus(status: SparkInvocationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

async function settleManagedSessionTurn(
  sessionRegistry: DaemonSessionRegistry | undefined,
  sessionId: string,
): Promise<void> {
  try {
    await sessionRegistry?.recordTurnSettled(sessionId);
  } catch (error) {
    console.error(`[spark-daemon] failed to settle session turn ${sessionId}`, error);
  }
}

async function deliverSessionNotificationFromLocalRpc(
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
  });
}
function requireChannelIngress(
  options: LocalRpcHandlerOptions,
): NonNullable<LocalRpcHandlerOptions["channelIngress"]> {
  if (!options.channelIngress) {
    throw new Error("Spark daemon channel runtime is not available.");
  }
  return options.channelIngress;
}

function parseLocalRpcRequest(line: string): LocalRpcRequest {
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
      params: sparkSessionGetRequestSchema.parse(value.params),
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

function withSparkCommand<T extends { id: string; method: string; params?: unknown }>(
  request: T,
): T & { sparkCommand: SparkCommand } {
  return {
    ...request,
    sparkCommand: sparkCommandFromLocalRpcRequest(request),
  };
}

type LocalTurnSubmitParams = {
  sessionId: string;
  prompt: string;
  idempotencyKey?: string;
  reset?: boolean;
  assignment?: SparkAssignment;
  messageMetadata?: Record<string, unknown>;
};

type LocalWorkspaceRegisterParams = {
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

type LocalWorkspaceEnsureLocalParams = LocalWorkspaceEnsureLocalRequest;
type LocalWorkspaceClientAttachParams = LocalWorkspaceClientAttachRequest;
type LocalWorkspaceClientHeartbeatParams = LocalWorkspaceClientHeartbeatRequest;
type LocalWorkspaceExecutorEnsureParams = LocalWorkspaceExecutorEnsureRequest;

function localTurnSubmitParams(params: LocalTurnSubmitParams): LocalTurnSubmitParams {
  return {
    sessionId: params.sessionId,
    prompt: params.prompt,
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.reset !== undefined ? { reset: params.reset } : {}),
    ...(params.assignment ? { assignment: params.assignment } : {}),
    ...(params.messageMetadata ? { messageMetadata: params.messageMetadata } : {}),
  };
}

function localWorkspaceRegisterParams(
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

function localTurnCancelParams(params: LocalTurnCancelRequest): LocalTurnCancelParams {
  return sparkTurnCancelRequestSchema.parse(params);
}

function localWorkspaceEnsureLocalParams(
  params: LocalWorkspaceEnsureLocalRequest,
): LocalWorkspaceEnsureLocalParams {
  return {
    localPath: params.localPath,
    ...(params.displayName ? { displayName: params.displayName } : {}),
    ...(params.localWorkspaceKey ? { localWorkspaceKey: params.localWorkspaceKey } : {}),
  };
}

function localWorkspaceClientAttachParams(
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

function localWorkspaceClientHeartbeatParams(
  params: LocalWorkspaceClientHeartbeatRequest,
): LocalWorkspaceClientHeartbeatParams {
  return {
    clientId: params.clientId,
    ...(params.leaseTtlMs !== undefined ? { leaseTtlMs: params.leaseTtlMs } : {}),
  };
}

function localWorkspaceExecutorEnsureParams(
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

function parseLocalChannelWorkspaceParams(value: unknown): { workspaceId: string } {
  if (!isRecord(value) || typeof value.workspaceId !== "string" || !value.workspaceId.trim()) {
    throw new Error("channel.status/reload requires workspaceId.");
  }
  return { workspaceId: value.workspaceId.trim() };
}

function parseLocalChannelConfigureParams(value: unknown): {
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

function parseLocalChannelNotifyParams(
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
  return {
    workspaceId: value.workspaceId.trim(),
    action,
    ...(typeof value.adapter === "string" ? { adapter: value.adapter } : {}),
    ...(typeof value.route === "string" ? { route: value.route } : {}),
    ...(typeof value.recipient === "string" ? { recipient: value.recipient } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
  };
}

function parseLocalSessionNotificationDeliverParams(value: unknown): {
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

function parseLocalTurnSubmitParams(value: unknown): LocalTurnSubmitParams {
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

function parseLocalMessageMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("turn.submit messageMetadata must be an object.");
  return value;
}

function parseLocalTurnCancelParams(value: unknown): LocalTurnCancelParams {
  return sparkTurnCancelRequestSchema.parse(value);
}

function parseOptionalSessionId(value: unknown): { sessionId?: string } {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Invalid model.catalog params.");
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  return sessionId ? { sessionId } : {};
}

function parseProviderNameParams(value: unknown): { providerName: string } {
  if (!isRecord(value) || typeof value.providerName !== "string") {
    throw new Error("Provider auth request requires providerName.");
  }
  const providerName = value.providerName.trim();
  if (!providerName) throw new Error("Provider auth request requires providerName.");
  return { providerName };
}

function parseProviderApiKeyParams(value: unknown): { providerName: string; apiKey: string } {
  const { providerName } = parseProviderNameParams(value);
  if (!isRecord(value) || typeof value.apiKey !== "string" || !value.apiKey.trim()) {
    throw new Error("Provider API key request requires apiKey.");
  }
  return { providerName, apiKey: value.apiKey };
}

function parseOAuthFlowIdParams(value: unknown): { flowId: string } {
  if (!isRecord(value) || typeof value.flowId !== "string" || !value.flowId.trim()) {
    throw new Error("OAuth flow request requires flowId.");
  }
  return { flowId: value.flowId.trim() };
}

function parseOAuthFlowResponseParams(value: unknown): {
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

function parseLocalWorkspaceRegisterParams(value: unknown): LocalWorkspaceRegisterParams {
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

function parseLocalWorkspaceEnsureLocalParams(value: unknown): LocalWorkspaceEnsureLocalParams {
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

function parseLocalWorkspaceClientAttachParams(value: unknown): LocalWorkspaceClientAttachParams {
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

function parseLocalWorkspaceClientHeartbeatParams(
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

function parseLocalWorkspaceExecutorEnsureParams(
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

function localRpcResponseError(value: unknown): Error {
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

function workspaceList(value: unknown): WorkspaceListResult {
  if (!isRecord(value) || !Array.isArray(value.workspaces)) {
    throw new Error("Invalid local RPC workspace list result.");
  }
  return {
    workspaces: value.workspaces.map(sparkDaemonWorkspace),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
  };
}

function daemonStatus(value: unknown): LocalDaemonStatusResult {
  if (!isRecord(value) || !Array.isArray(value.servers)) {
    throw new Error("Invalid local RPC daemon status result.");
  }
  return {
    servers: value.servers.map(daemonServerSummary),
    invocations: invocationCountsResult(value.invocations),
    invocationHealth: invocationHealthResult(value.invocationHealth),
    lifecycle: daemonLifecycle(value.lifecycle),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
  };
}

function daemonLifecycle(value: unknown): SparkDaemonLifecycleSnapshot {
  if (!isRecord(value) || (value.state !== "running" && value.state !== "draining")) {
    return { state: "running" };
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
  return {
    state: value.state,
    ...(value.phase === "serving" || value.phase === "draining-active-work"
      ? { phase: value.phase }
      : {}),
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
  };
}

function channelIngressStatus(value: unknown): DaemonChannelIngressStatus {
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

function isChannelRuntimeState(value: unknown): value is DaemonChannelIngressStatus["state"] {
  return (
    value === "unconfigured" || value === "running" || value === "stopped" || value === "degraded"
  );
}

function channelAdapterStatus(value: unknown): DaemonChannelIngressStatus["adapters"][number] {
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

function isChannelConnectionState(
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

function channelRouteStatus(value: unknown): DaemonChannelIngressStatus["routes"][number] {
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

function turnSubmit(value: unknown): LocalTurnSubmitResult {
  return sparkTurnSubmitResultSchema.parse(value);
}

function daemonStop(value: unknown): LocalDaemonStopResult {
  if (!isRecord(value) || value.stopping !== true) {
    throw new Error("Invalid local RPC daemon stop result.");
  }
  return {
    stopping: true,
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
  };
}

function daemonRestart(value: unknown): LocalDaemonRestartResult {
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

function localWorkspaceClientResult(value: unknown): LocalWorkspaceClientResult {
  if (!isRecord(value) || !isRecord(value.client)) {
    throw new Error("Invalid local RPC workspace client result.");
  }
  return {
    client: sparkDaemonWorkspaceClient(value.client),
    workspace: sparkDaemonWorkspace(value.workspace),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
  };
}

function invocationCountsResult(value: unknown): LocalDaemonStatusResult["invocations"] {
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

function invocationHealthResult(value: unknown): LocalDaemonStatusResult["invocationHealth"] {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.oldestQueuedAt === "string" ? { oldestQueuedAt: value.oldestQueuedAt } : {}),
    ...(typeof value.oldestRunningAt === "string"
      ? { oldestRunningAt: value.oldestRunningAt }
      : {}),
  };
}

function daemonServerSummary(value: unknown): LocalDaemonStatusResult["servers"][number] {
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

function sparkDaemonWorkspace(value: unknown): SparkDaemonWorkspace {
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
    serverUrl: value.serverUrl,
    localWorkspaceKey: value.localWorkspaceKey,
    displayName: value.displayName,
    localPath: value.localPath,
    status: value.status,
    capabilities: value.capabilities,
    diagnostics: value.diagnostics,
    ...(isRecord(value.borrowed)
      ? {
          borrowed: {
            borrowed: value.borrowed.borrowed === true,
            interactiveClientCount:
              typeof value.borrowed.interactiveClientCount === "number"
                ? value.borrowed.interactiveClientCount
                : 0,
            borrowedByClientIds: Array.isArray(value.borrowed.borrowedByClientIds)
              ? value.borrowed.borrowedByClientIds.filter(
                  (clientId): clientId is string => typeof clientId === "string",
                )
              : [],
            ...(typeof value.borrowed.since === "string" ? { since: value.borrowed.since } : {}),
          },
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
    ...(Array.isArray(value.recentSessions)
      ? { recentSessions: value.recentSessions.map(sparkDaemonWorkspaceRecentSession) }
      : {}),
    updatedAt: value.updatedAt,
  };
  const profile = workspaceProfile(value.profile);
  return profile ? { ...workspace, profile } : workspace;
}

function sparkDaemonWorkspaceClient(value: unknown): SparkDaemonWorkspaceClient {
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

function workspaceClientProjection(
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
    ...(typeof value.attachedAt === "string" ? { attachedAt: value.attachedAt } : {}),
    ...(typeof value.lastSeenAt === "string" ? { lastSeenAt: value.lastSeenAt } : {}),
  };
}

function sparkDaemonWorkspaceRecentSession(
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

function workspaceProfile(value: unknown): SparkDaemonWorkspace["profile"] | undefined {
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

function isWorkspaceStatus(value: unknown): value is SparkDaemonWorkspace["status"] {
  return (
    value === "available" ||
    value === "indexing" ||
    value === "degraded" ||
    value === "unavailable" ||
    value === "archived"
  );
}

function localRequestId(): string {
  return `local_${Date.now().toString(36)}_${randomUUID()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
