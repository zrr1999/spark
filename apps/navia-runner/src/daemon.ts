import { existsSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import {
  createId,
  humanResponseDeliverEnvelopeSchema,
  runtimeProtocolVersion,
  runtimeReconcileRequestEnvelopeSchema,
  serverCommandEnvelopeSchema,
  serverHelloAckEnvelopeSchema,
  type RuntimeFeature,
} from "@zendev-lab/navia-protocol";
import { writePrivateFile, type NaviaPaths } from "@zendev-lab/navia-system";
import { readRunnerConfig, type RunnerConfig } from "./config.js";
import { decideCommandPolicy } from "./policy.js";
import {
  commandAck,
  commandReject,
  invocationLogChunk,
  invocationUpdated,
  reconcileReport,
  runtimeEnvelope,
  workspaceSnapshot,
  type RouteContext,
} from "./protocol/outbound.js";
import {
  getWorkspaceById,
  isUserDetachedWorkspace,
  listWorkspaces,
  markRunnerServerConnected,
  markServerWorkspacesDisconnected,
  reconcileWorkspaces,
  workspaceSummaries,
} from "./store/workspaces.js";
import {
  commandRejectForUnknownInvocation,
  runNaviaCommandThroughSpark,
  cancelNaviaSparkInvocation,
  type RunSparkCommandFn,
  type CancelSparkInvocationFn,
} from "./spark/bridge.js";
import {
  nextRunnerTokenRefreshDelayMs,
  refreshRunnerCredentials,
  shouldRefreshRunnerToken,
  tokenRefreshRetryDelayMs,
} from "./token-refresh.js";

export const runnerVersion = "0.1.0";

export const runnerSupportedFeatures: RuntimeFeature[] = [
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
];

/**
 * Minimal WebSocket-like surface used by command handlers. Production wires the
 * real `ws` library; tests pass a tiny stub that just records `send` calls.
 */
export interface ServerSocket {
  send(data: string): void;
}

export interface StartRunnerDaemonOptions {
  paths: NaviaPaths;
  config: RunnerConfig;
  db: DatabaseSync;
  once?: boolean;
  signal?: AbortSignal;
  drainTimeoutMs?: number;
  /**
   * Optional override for Spark-backed command execution. Production callers can
   * leave this unset to use the real Spark runtime bridge; tests inject a fake
   * to assert the streamed envelope sequence without spawning a real role-run.
   */
  runSparkCommand?: RunSparkCommandFn;
  cancelSparkInvocation?: CancelSparkInvocationFn;
}

export async function startRunnerDaemon(options: StartRunnerDaemonOptions): Promise<void> {
  writePrivateFile(options.paths.pidFile, `${process.pid}\n`);
  try {
    if (options.once) {
      if (!options.signal?.aborted && canAttemptServerConnection(options.config)) {
        await runRunnerServerConnection(options);
      }
      return;
    }

    while (!options.signal?.aborted) {
      const config = readRunnerConfig(options.paths);
      if (!canAttemptServerConnection(config)) {
        await delayUnlessAborted(500, options.signal);
        continue;
      }

      try {
        await runRunnerServerConnection({ ...options, config });
      } catch (error) {
        sendErrorLog(options.db, config.runtimeId ?? "unknown", error);
        await delayUnlessAborted(1_000, options.signal);
      }
    }
  } finally {
    if (existsSync(options.paths.pidFile)) {
      rmSync(options.paths.pidFile, { force: true });
    }
  }
}

async function runRunnerServerConnection(options: StartRunnerDaemonOptions): Promise<void> {
  let config = shouldRefreshRunnerToken(options.config)
    ? await refreshRunnerCredentials({ paths: options.paths, config: options.config })
    : options.config;
  const runtimeId = requireConfig(config.runtimeId, "runtimeId");
  const runtimeToken = requireConfig(config.runtimeToken, "runtimeToken");
  const webSocketUrl = resolveWebSocketUrl(config);
  const serverUrl = serverUrlForConfig(config);

  await new Promise<void>((resolvePromise, reject) => {
    let runtimeSessionId: string | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let tokenRefresh: NodeJS.Timeout | undefined;
    let intentionalClose = false;
    let settled = false;
    const activeHandlers = new Set<Promise<void>>();
    const scheduleTokenRefresh = (delayMs = nextRunnerTokenRefreshDelayMs(config)) => {
      if (delayMs === undefined) {
        return;
      }
      tokenRefresh = setTimeout(() => {
        void refreshAndRescheduleToken();
      }, delayMs);
    };
    const refreshAndRescheduleToken = async () => {
      try {
        config = await refreshRunnerCredentials({ paths: options.paths, config });
        scheduleTokenRefresh();
      } catch (error) {
        sendErrorLog(options.db, runtimeId, error);
        scheduleTokenRefresh(tokenRefreshRetryDelayMs());
      }
    };
    scheduleTokenRefresh();

    const settle = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", requestShutdown);
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    };

    const markDisconnected = (reason: string) => {
      if (serverUrl) {
        markServerWorkspacesDisconnected(options.db, serverUrl, reason);
      }
    };

    const drainActiveHandlers = async () => {
      if (activeHandlers.size === 0) {
        return;
      }
      await Promise.race([
        Promise.allSettled([...activeHandlers]),
        delay(options.drainTimeoutMs ?? 30_000),
      ]);
    };

    const requestShutdown = () => {
      intentionalClose = true;
      clearRuntimeTimers();
      void drainActiveHandlers()
        .catch((error: unknown) => {
          sendErrorLog(options.db, runtimeId, error);
        })
        .finally(() => {
          ws.close(1000, "daemon stop");
          if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
            settle();
          }
        });
    };

    const ws = new WebSocket(webSocketUrl, {
      headers: { Authorization: `Bearer ${runtimeToken}` },
    });
    if (options.signal?.aborted) {
      requestShutdown();
      return;
    }
    options.signal?.addEventListener("abort", requestShutdown, { once: true });

    const clearRuntimeTimers = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      if (tokenRefresh) {
        clearTimeout(tokenRefresh);
        tokenRefresh = undefined;
      }
    };

    ws.on("open", () => {
      if (serverUrl) {
        markRunnerServerConnected(options.db, serverUrl);
      }
      sendJson(ws, {
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "runtime.hello",
        sentAt: new Date().toISOString(),
        payload: {
          runtimeId,
          runtimeVersion: runnerVersion,
          supportedFeatures: runnerSupportedFeatures,
          workspaceBindings: reconcileWorkspaces(options.db).map(workspaceSummary),
        },
      });
    });

    ws.on("message", (data: RawData) => {
      if (intentionalClose) {
        return;
      }
      const handler = handleServerMessage(ws, rawDataToText(data), {
        paths: options.paths,
        config,
        db: options.db,
        runtimeId,
        runSparkCommand: options.runSparkCommand ?? runNaviaCommandThroughSpark,
        cancelSparkInvocation: options.cancelSparkInvocation ?? cancelNaviaSparkInvocation,
        get runtimeSessionId() {
          return runtimeSessionId;
        },
        setRuntimeSessionId(value) {
          runtimeSessionId = value;
        },
        ensureHeartbeat(intervalMs) {
          if (heartbeat) {
            return;
          }
          heartbeat = setInterval(() => {
            sendHeartbeat(ws, options.db, runtimeId, runtimeSessionId);
          }, intervalMs);
          sendHeartbeat(ws, options.db, runtimeId, runtimeSessionId);
        },
      }).catch((error: unknown) => {
        sendErrorLog(options.db, runtimeId, error);
      });
      activeHandlers.add(handler);
      void handler.finally(() => {
        activeHandlers.delete(handler);
      });
    });

    ws.on("error", (error) => {
      if (settled) {
        return;
      }
      clearRuntimeTimers();
      if (!intentionalClose) {
        markDisconnected("server.unreachable");
      }
      ws.terminate();
      settle(intentionalClose ? undefined : error);
    });

    ws.on("close", () => {
      if (settled) {
        return;
      }
      clearRuntimeTimers();
      if (!intentionalClose) {
        markDisconnected("server.unreachable");
      }
      settle();
    });
  });
}

async function delayUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  try {
    await delay(ms, undefined, signal ? { signal } : undefined);
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function canAttemptServerConnection(config: RunnerConfig): boolean {
  return Boolean(
    config.runtimeId &&
    (config.runtimeToken || config.refreshToken) &&
    (config.webSocketUrl || config.serverUrl),
  );
}

export interface MessageContext {
  paths: NaviaPaths;
  config: RunnerConfig;
  db: DatabaseSync;
  runtimeId: string;
  runtimeSessionId: string | undefined;
  setRuntimeSessionId(value: string): void;
  ensureHeartbeat(intervalMs: number): void;
  runSparkCommand: RunSparkCommandFn;
  cancelSparkInvocation: CancelSparkInvocationFn;
}

export async function handleServerMessage(
  ws: ServerSocket,
  raw: string,
  context: MessageContext,
): Promise<void> {
  const value = JSON.parse(raw) as unknown;

  const helloAck = serverHelloAckEnvelopeSchema.safeParse(value);
  if (helloAck.success) {
    context.setRuntimeSessionId(helloAck.data.payload.runtimeSessionId);
    context.ensureHeartbeat(helloAck.data.payload.heartbeatIntervalMs);
    return;
  }

  const command = serverCommandEnvelopeSchema.safeParse(value);
  if (command.success) {
    await handleCommand(ws, command.data, context);
    return;
  }

  const humanResponse = humanResponseDeliverEnvelopeSchema.safeParse(value);
  if (humanResponse.success) {
    sendJson(
      ws,
      runtimeEnvelope(
        "human.response.ack",
        {
          returnedToTool: false,
          message: "No active Pi tool wait is attached in this runner slice.",
        },
        {
          runtimeId: context.runtimeId,
          workspaceBindingId: humanResponse.data.workspaceBindingId,
          workspaceId: humanResponse.data.workspaceId,
          projectId: humanResponse.data.projectId,
          ackOf: humanResponse.data.messageId,
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

export async function handleCommand(
  ws: ServerSocket,
  command: ReturnType<typeof serverCommandEnvelopeSchema.parse>,
  context: MessageContext,
): Promise<void> {
  const knownWorkspaceBindingIds = new Set(
    listWorkspaces(context.db).map((workspace) => workspace.id),
  );
  const commandWorkspace = command.workspaceBindingId
    ? getWorkspaceById(context.db, command.workspaceBindingId)
    : null;
  if (
    commandWorkspace &&
    isUserDetachedWorkspace(commandWorkspace) &&
    command.payload.kind !== "invocation.cancel.request"
  ) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "WORKSPACE_DETACHED",
          message: "Workspace is paused and is not accepting new commands.",
          retryable: true,
        },
        {
          runtimeId: context.runtimeId,
          workspaceBindingId: command.workspaceBindingId,
          workspaceId: command.workspaceId,
          projectId: command.projectId,
          commandId: command.commandId,
          ackOf: command.messageId,
        },
      ),
    );
    return;
  }
  const policy = decideCommandPolicy({
    command: command.payload,
    workspaceBindingId: command.workspaceBindingId,
    knownWorkspaceBindingIds,
    allowMutation: true,
  });
  const route: RouteContext = {
    runtimeId: context.runtimeId,
    workspaceBindingId: command.workspaceBindingId,
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    commandId: command.commandId,
    ackOf: command.messageId,
  };

  if (!policy.accepted) {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: policy.reasonCode ?? "COMMAND_REJECTED",
          message: policy.message ?? "Runner rejected the command.",
          retryable: false,
        },
        route,
      ),
    );
    return;
  }

  if (command.payload.kind === "workspace.snapshot.request") {
    sendJson(ws, commandAck({ accepted: true }, route));
    const workspace = command.workspaceBindingId
      ? getWorkspaceById(context.db, command.workspaceBindingId)
      : null;
    if (workspace && command.workspaceId) {
      sendJson(
        ws,
        workspaceSnapshot(
          {
            displayName: workspace.displayName,
            status: workspace.status,
            projects: [],
            unresolvedInboxCount: 0,
            activeInvocationCount: 0,
            latestArtifactIds: [],
            resources: [],
          },
          { ...route, workspaceBindingId: workspace.id },
        ),
      );
    }
    return;
  }

  if (command.payload.kind === "diagnostics.request") {
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
            workspaces: workspaceSummaries(context.db),
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
          payload: { commandKind: command.payload.kind },
        },
        { ...route, invocationId },
      ),
    );
    return;
  }

  if (command.payload.kind === "invocation.cancel.request") {
    const invocationId = runtimeInvocationIdForCancel(command.payload.payload);
    if (!invocationId) {
      sendJson(ws, commandRejectForUnknownInvocation(route, command.messageId));
      return;
    }
    const result = await context.cancelSparkInvocation({
      invocationId,
      reason: "Navia invocation cancellation requested by server command.",
    });
    if (!result.cancelled) {
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
          terminalReason: result.message,
          payload: { commandKind: command.payload.kind },
        },
        { ...route, invocationId },
      ),
    );
    return;
  }

  if (command.payload.kind !== "task.start.request") {
    sendJson(
      ws,
      commandReject(
        {
          reasonCode: "COMMAND_KIND_UNIMPLEMENTED",
          message: `Runner does not execute ${command.payload.kind} yet.`,
          retryable: false,
        },
        route,
      ),
    );
    return;
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
          message: "Runner has no local workspace for this command.",
          retryable: false,
        },
        route,
      ),
    );
    return;
  }

  await context.runSparkCommand({
    command,
    workspace,
    route,
    paths: context.paths,
    db: context.db,
    emit(message) {
      sendJson(ws, message);
    },
  });
}

function runtimeInvocationIdForCancel(payload: Record<string, unknown> | undefined): string | null {
  const value = payload?.runtimeInvocationId ?? payload?.invocationId;
  return typeof value === "string" && value.startsWith("inv_") ? value : null;
}

function sendHeartbeat(
  ws: WebSocket,
  db: DatabaseSync,
  runtimeId: string,
  runtimeSessionId: string | undefined,
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
      workspaceBindings: reconcileWorkspaces(db).map(workspaceSummary),
    },
  });
}

function buildReconcileReport(context: MessageContext) {
  const activeInvocationCount = context.db
    .prepare("SELECT COUNT(*) AS count FROM invocations WHERE status IN ('queued', 'running')")
    .get() as { count: number };
  const pendingOutboxCount = context.db
    .prepare("SELECT COUNT(*) AS count FROM outbox WHERE status = 'pending'")
    .get() as { count: number };

  return reconcileReport(
    {
      observedAt: new Date().toISOString(),
      workspaceBindings: reconcileWorkspaces(context.db).map(workspaceSummary),
      pendingOutboxCount: pendingOutboxCount.count,
      activeInvocationCount: activeInvocationCount.count,
      artifacts: { availableCount: 0, missingCount: 0 },
      diagnostics: {},
    },
    { runtimeId: context.runtimeId },
  );
}

function workspaceSummary(workspace: ReturnType<typeof reconcileWorkspaces>[number]) {
  return {
    bindingId: workspace.id,
    localWorkspaceKey: workspace.localWorkspaceKey,
    displayName: workspace.displayName,
    status: workspace.status,
    capabilities: workspace.capabilities,
    diagnostics: workspace.diagnostics,
  };
}

function resolveWebSocketUrl(config: RunnerConfig): string {
  if (config.webSocketUrl) {
    return toWebSocketUrl(config.webSocketUrl);
  }
  const runtimeId = requireConfig(config.runtimeId, "runtimeId");
  const serverUrl = requireConfig(config.serverUrl, "serverUrl");
  return toWebSocketUrl(new URL(`/api/v1/runtime/runtimes/${runtimeId}/ws`, serverUrl).toString());
}

function serverUrlForConfig(config: RunnerConfig): string | null {
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

function toWebSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  return url.toString();
}

function requireConfig(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Local service config is missing ${name}. Run navia ws register first.`);
  }
  return value;
}

function rawDataToText(data: RawData): string {
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

function sendJson(ws: ServerSocket, value: unknown): void {
  ws.send(JSON.stringify(value));
}

function sendErrorLog(db: DatabaseSync, runtimeId: string, error: unknown): void {
  db.prepare(
    `INSERT INTO outbox (id, kind, payload_json, status, created_at, updated_at)
     VALUES (?, 'daemon.error', ?, 'pending', ?, ?)`,
  ).run(
    createId("evt"),
    JSON.stringify({ runtimeId, error: error instanceof Error ? error.message : String(error) }),
    new Date().toISOString(),
    new Date().toISOString(),
  );
}
