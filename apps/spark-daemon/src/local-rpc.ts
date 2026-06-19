import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { NaviaPaths } from "@zendev-lab/navia-system";
import {
  SparkDaemonQueue,
  type SparkDaemonQueueEntry,
  type SparkDaemonQueueState,
  type SparkDaemonTask,
} from "./core/index.ts";
import {
  attachWorkspace,
  listWorkspaces,
  planWorkspaceRegistration,
  registerWorkspace,
  sparkDaemonServerStatusSummaries,
  type RegisterWorkspaceOptions,
  stopWorkspace,
  type SparkDaemonWorkspace,
  WorkspacePathConflictError,
} from "./store/workspaces.js";
import {
  ensureSparkDaemonRegistrationForWorkspace,
  RegistrationGrantRefusedError,
  verifySparkDaemonWorkspaceConnection,
} from "./registration.js";

export interface LocalRpcServer {
  socketPath: string;
  close(): Promise<void>;
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
  queue: Record<SparkDaemonQueueState, number>;
  observedAt: string;
}

export interface LocalDaemonQueueResult {
  state: SparkDaemonQueueState | "all";
  entries?: SparkDaemonQueueEntry[];
  byState?: Partial<Record<SparkDaemonQueueState, SparkDaemonQueueEntry[]>>;
  observedAt: string;
}

export interface LocalTurnSubmitResult {
  fileName: string;
  filePath: string;
  task: SparkDaemonTask;
  observedAt: string;
}

export interface LocalDaemonStopResult {
  stopping: true;
  observedAt: string;
}

export interface LocalWorkspaceRegisterRequest extends RegisterWorkspaceOptions {
  registrationToken?: string;
}

interface LocalRpcHandlerOptions {
  ensureSparkDaemonRegistrationForWorkspace?: typeof ensureSparkDaemonRegistrationForWorkspace;
  verifySparkDaemonWorkspaceConnection?: typeof verifySparkDaemonWorkspaceConnection;
}

type LocalRpcRequest =
  | { id: string; method: "daemon.status" }
  | { id: string; method: "daemon.stop" }
  | { id: string; method: "daemon.queue"; params: LocalDaemonQueueParams }
  | { id: string; method: "turn.submit"; params: LocalTurnSubmitParams }
  | { id: string; method: "workspace.list" }
  | { id: string; method: "workspace.register"; params: LocalWorkspaceRegisterParams }
  | { id: string; method: "workspace.attach" | "workspace.stop"; params: { id: string } };

type LocalRpcErrorPayload = {
  message: string;
  code?: "workspace_path_conflict" | "registration_grant_refused";
  kind?: WorkspacePathConflictError["kind"];
};

type LocalRpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: LocalRpcErrorPayload };

export class LocalRpcUnavailableError extends Error {}

export function localRpcSocketPath(paths: NaviaPaths): string {
  return join(paths.runtimeDir, "daemon.sock");
}

export async function startLocalRpcServer(options: {
  paths: NaviaPaths;
  db: DatabaseSync;
  onStop?: () => void | Promise<void>;
}): Promise<LocalRpcServer> {
  const socketPath = localRpcSocketPath(options.paths);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });

  const server = createServer((socket) => {
    handleLocalRpcSocket(socket, options.paths, options.db, options.onStop);
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          rmSync(socketPath, { force: true });
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export async function requestWorkspaceList(paths: NaviaPaths): Promise<WorkspaceListResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "workspace.list" }, workspaceList);
}

export async function requestDaemonStatus(paths: NaviaPaths): Promise<LocalDaemonStatusResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "daemon.status" }, daemonStatus);
}

export async function requestDaemonStop(paths: NaviaPaths): Promise<LocalDaemonStopResult> {
  return localRpcRequest(paths, { id: localRequestId(), method: "daemon.stop" }, daemonStop);
}

export async function requestDaemonQueue(
  paths: NaviaPaths,
  params: Partial<LocalDaemonQueueParams> = {},
): Promise<LocalDaemonQueueResult> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "daemon.queue",
      params: localDaemonQueueParams(params),
    },
    daemonQueue,
  );
}

export async function requestTurnSubmit(
  paths: NaviaPaths,
  params: LocalTurnSubmitParams,
): Promise<LocalTurnSubmitResult> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "turn.submit", params: localTurnSubmitParams(params) },
    turnSubmit,
  );
}

export async function requestWorkspaceRegister(
  paths: NaviaPaths,
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

export async function requestWorkspaceAttach(
  paths: NaviaPaths,
  id: string,
): Promise<SparkDaemonWorkspace> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "workspace.attach", params: { id } },
    sparkDaemonWorkspace,
  );
}

export async function requestWorkspaceStop(
  paths: NaviaPaths,
  id: string,
): Promise<SparkDaemonWorkspace> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "workspace.stop", params: { id } },
    sparkDaemonWorkspace,
  );
}

async function localRpcRequest<T>(
  paths: NaviaPaths,
  request: LocalRpcRequest,
  parseResult: (value: unknown) => T,
): Promise<T> {
  const socketPath = localRpcSocketPath(paths);
  return await new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";

    const fail = (error: Error) => {
      socket.destroy();
      reject(new LocalRpcUnavailableError(error.message));
    };

    socket.setTimeout(1_000, () => {
      fail(new Error(`Timed out connecting to ${socketPath}`));
    });
    socket.once("error", fail);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }

      const line = buffer.slice(0, newline);
      socket.end();
      try {
        const response = parseLocalRpcResponse(line, request.id);
        if (!response.ok) {
          reject(new Error(response.error.message));
          return;
        }
        resolve(parseResult(response.result));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function handleLocalRpcSocket(
  socket: Socket,
  paths: NaviaPaths,
  db: DatabaseSync,
  onStop: (() => void | Promise<void>) | undefined,
): void {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void handleLocalRpcLine(line, paths, db, onStop).then((response) => {
        socket.write(`${JSON.stringify(response)}\n`);
      });
      newline = buffer.indexOf("\n");
    }
  });
}

export async function handleLocalRpcLine(
  line: string,
  paths: NaviaPaths,
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
    const request = parseLocalRpcRequest(line);
    requestId = request.id;
    switch (request.method) {
      case "daemon.status": {
        const queue = new SparkDaemonQueue({ paths });
        return {
          id: request.id,
          ok: true,
          result: {
            servers: sparkDaemonServerStatusSummaries(db),
            queue: await queueCounts(queue),
            observedAt: new Date().toISOString(),
          },
        };
      }
      case "daemon.stop":
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
      case "daemon.queue": {
        const queue = new SparkDaemonQueue({ paths });
        const result = await queueList(queue, request.params);
        return { id: request.id, ok: true, result };
      }
      case "turn.submit": {
        const queue = new SparkDaemonQueue({ paths });
        const entry = await queue.enqueue({
          type: "session.run",
          sessionId: request.params.sessionId,
          prompt: request.params.prompt,
          ...(request.params.reset !== undefined ? { reset: request.params.reset } : {}),
          actor: "spark-daemon-local-rpc",
        });
        return {
          id: request.id,
          ok: true,
          result: {
            fileName: entry.fileName,
            filePath: entry.filePath,
            task: entry.payload.task,
            observedAt: new Date().toISOString(),
          },
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
      case "workspace.register":
        const planned = planWorkspaceRegistration(db, request.params);
        const serviceRegistration = await ensureRegistration(paths, {
          serverUrl: planned.serverUrl,
          workspaceRegistration: {
            localWorkspaceKey: planned.localWorkspaceKey,
            displayName: planned.displayName,
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
    }
  } catch (error) {
    return {
      id: requestId,
      ok: false,
      error: localRpcError(error),
    };
  }
}

function localRpcError(error: unknown): LocalRpcErrorPayload {
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

function parseLocalRpcRequest(line: string): LocalRpcRequest {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Invalid local RPC request.");
  }
  if (value.method === "daemon.status") {
    return { id: value.id, method: value.method };
  }
  if (value.method === "daemon.stop") {
    return { id: value.id, method: value.method };
  }
  if (value.method === "daemon.queue") {
    return {
      id: value.id,
      method: value.method,
      params: parseLocalDaemonQueueParams(value.params),
    };
  }
  if (value.method === "turn.submit") {
    return { id: value.id, method: value.method, params: parseLocalTurnSubmitParams(value.params) };
  }
  if (value.method === "workspace.list") {
    return { id: value.id, method: value.method };
  }
  if (value.method === "workspace.register") {
    return {
      id: value.id,
      method: value.method,
      params: parseLocalWorkspaceRegisterParams(value.params),
    };
  }
  if (value.method === "workspace.attach" || value.method === "workspace.stop") {
    if (!isRecord(value.params) || typeof value.params.id !== "string") {
      throw new Error(`Missing workspace id for local RPC method: ${value.method}`);
    }
    return { id: value.id, method: value.method, params: { id: value.params.id } };
  }
  if (typeof value.method !== "string") {
    throw new Error("Invalid local RPC request.");
  }
  throw new Error(`Unknown local RPC method: ${value.method}`);
}

type LocalDaemonQueueParams = {
  state: SparkDaemonQueueState | "all";
  limit?: number;
};

type LocalTurnSubmitParams = {
  sessionId: string;
  prompt: string;
  reset?: boolean;
};

type LocalWorkspaceRegisterParams = {
  serverUrl: string;
  localPath: string;
  registrationToken?: string;
  localWorkspaceKey?: string;
  displayName?: string;
  profile?: NonNullable<SparkDaemonWorkspace["profile"]>;
};

function localDaemonQueueParams(
  params: Partial<LocalDaemonQueueParams> = {},
): LocalDaemonQueueParams {
  return {
    state: params.state ?? "inbox",
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
  };
}

function localTurnSubmitParams(params: LocalTurnSubmitParams): LocalTurnSubmitParams {
  return {
    sessionId: params.sessionId,
    prompt: params.prompt,
    ...(params.reset !== undefined ? { reset: params.reset } : {}),
  };
}

function localWorkspaceRegisterParams(
  params: LocalWorkspaceRegisterRequest,
): LocalWorkspaceRegisterParams {
  return {
    serverUrl: params.serverUrl ?? "",
    localPath: params.localPath,
    ...(params.registrationToken ? { registrationToken: params.registrationToken } : {}),
    ...(params.localWorkspaceKey ? { localWorkspaceKey: params.localWorkspaceKey } : {}),
    ...(params.displayName ? { displayName: params.displayName } : {}),
    ...(params.profile ? { profile: params.profile } : {}),
  };
}

function parseLocalDaemonQueueParams(value: unknown): LocalDaemonQueueParams {
  if (value === undefined) {
    return { state: "inbox" };
  }
  if (!isRecord(value)) {
    throw new Error("Invalid local RPC daemon queue params.");
  }
  const rawState = typeof value.state === "string" ? value.state : "inbox";
  if (
    rawState !== "inbox" &&
    rawState !== "processed" &&
    rawState !== "failed" &&
    rawState !== "all"
  ) {
    throw new Error(`Invalid daemon queue state: ${rawState}`);
  }
  const params: LocalDaemonQueueParams = { state: rawState };
  if (typeof value.limit === "number" && Number.isFinite(value.limit)) {
    params.limit = Math.max(0, Math.floor(value.limit));
  }
  return params;
}

function parseLocalTurnSubmitParams(value: unknown): LocalTurnSubmitParams {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.prompt !== "string") {
    throw new Error("Invalid local RPC turn submit params.");
  }
  const sessionId = value.sessionId.trim();
  const prompt = value.prompt.trim();
  if (!sessionId) throw new Error("turn.submit requires sessionId.");
  if (!prompt) throw new Error("turn.submit requires prompt.");
  return {
    sessionId,
    prompt: value.prompt,
    ...(typeof value.reset === "boolean" ? { reset: value.reset } : {}),
  };
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
  if (typeof value.localWorkspaceKey === "string") {
    params.localWorkspaceKey = value.localWorkspaceKey;
  }
  if (typeof value.registrationToken === "string") {
    params.registrationToken = value.registrationToken;
  }
  if (typeof value.displayName === "string") {
    params.displayName = value.displayName;
  }
  const profile = workspaceProfile(value.profile);
  if (profile) {
    params.profile = profile;
  }
  return params;
}

function parseLocalRpcResponse(line: string, expectedId: string): LocalRpcResponse {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value) || value.id !== expectedId || typeof value.ok !== "boolean") {
    throw new Error("Invalid local RPC response.");
  }
  if (value.ok === false) {
    const message =
      isRecord(value.error) && typeof value.error.message === "string"
        ? value.error.message
        : "Local RPC failed.";
    const code =
      isRecord(value.error) && value.error.code === "workspace_path_conflict"
        ? value.error.code
        : isRecord(value.error) && value.error.code === "registration_grant_refused"
          ? value.error.code
          : undefined;
    const kind =
      isRecord(value.error) &&
      (value.error.kind === "same-path" ||
        value.error.kind === "same-key" ||
        value.error.kind === "nested")
        ? value.error.kind
        : undefined;
    if (code === "workspace_path_conflict" && kind) {
      throw new WorkspacePathConflictError(message, kind);
    }
    if (code === "registration_grant_refused") {
      throw new RegistrationGrantRefusedError(message);
    }
    return { id: value.id, ok: false, error: { message } };
  }
  return { id: value.id, ok: true, result: value.result };
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
    queue: queueCountsResult(value.queue),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
  };
}

function daemonQueue(value: unknown): LocalDaemonQueueResult {
  if (!isRecord(value) || !isDaemonQueueState(value.state)) {
    throw new Error("Invalid local RPC daemon queue result.");
  }
  return {
    state: value.state,
    ...(Array.isArray(value.entries)
      ? { entries: value.entries.map((entry) => queueEntry(entry)) }
      : {}),
    ...(isRecord(value.byState) ? { byState: queueEntriesByState(value.byState) } : {}),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
  };
}

function turnSubmit(value: unknown): LocalTurnSubmitResult {
  if (
    !isRecord(value) ||
    typeof value.fileName !== "string" ||
    typeof value.filePath !== "string"
  ) {
    throw new Error("Invalid local RPC turn submit result.");
  }
  return {
    fileName: value.fileName,
    filePath: value.filePath,
    task: validateTurnSubmitTask(value.task),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
  };
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

async function queueCounts(
  queue: SparkDaemonQueue,
): Promise<Record<SparkDaemonQueueState, number>> {
  return {
    inbox: (await queue.list("inbox")).length,
    processed: (await queue.list("processed")).length,
    failed: (await queue.list("failed")).length,
  };
}

async function queueList(
  queue: SparkDaemonQueue,
  params: LocalDaemonQueueParams,
): Promise<LocalDaemonQueueResult> {
  const observedAt = new Date().toISOString();
  if (params.state === "all") {
    return {
      state: "all",
      byState: {
        inbox: limitEntries(await queue.listEntries("inbox"), params.limit),
        processed: limitEntries(await queue.listEntries("processed"), params.limit),
        failed: limitEntries(await queue.listEntries("failed"), params.limit),
      },
      observedAt,
    };
  }
  return {
    state: params.state,
    entries: limitEntries(await queue.listEntries(params.state), params.limit),
    observedAt,
  };
}

function limitEntries<T>(entries: T[], limit: number | undefined): T[] {
  if (limit === undefined) return entries;
  return entries.slice(0, Math.max(0, Math.floor(limit)));
}

function queueCountsResult(value: unknown): Record<SparkDaemonQueueState, number> {
  if (!isRecord(value)) return { inbox: 0, processed: 0, failed: 0 };
  return {
    inbox: typeof value.inbox === "number" ? value.inbox : 0,
    processed: typeof value.processed === "number" ? value.processed : 0,
    failed: typeof value.failed === "number" ? value.failed : 0,
  };
}

function queueEntriesByState(
  value: Record<string, unknown>,
): Partial<Record<SparkDaemonQueueState, SparkDaemonQueueEntry[]>> {
  const byState: Partial<Record<SparkDaemonQueueState, SparkDaemonQueueEntry[]>> = {};
  if (Array.isArray(value.inbox)) byState.inbox = value.inbox.map((entry) => queueEntry(entry));
  if (Array.isArray(value.processed)) {
    byState.processed = value.processed.map((entry) => queueEntry(entry));
  }
  if (Array.isArray(value.failed)) byState.failed = value.failed.map((entry) => queueEntry(entry));
  return byState;
}

function queueEntry(value: unknown): SparkDaemonQueueEntry {
  if (
    !isRecord(value) ||
    typeof value.fileName !== "string" ||
    typeof value.filePath !== "string"
  ) {
    throw new Error("Invalid local RPC daemon queue entry.");
  }
  if (!isRecord(value.payload) || typeof value.payload.enqueuedAt !== "string") {
    throw new Error("Invalid local RPC daemon queue payload.");
  }
  return {
    fileName: value.fileName,
    filePath: value.filePath,
    payload: {
      enqueuedAt: value.payload.enqueuedAt,
      task: validateTurnSubmitTask(value.payload.task),
    },
  };
}

function validateTurnSubmitTask(value: unknown): SparkDaemonTask {
  if (!isRecord(value) || value.type !== "session.run") {
    throw new Error("Invalid local RPC daemon task.");
  }
  if (typeof value.sessionId !== "string" || typeof value.prompt !== "string") {
    throw new Error("Invalid local RPC daemon session task.");
  }
  return {
    type: "session.run",
    sessionId: value.sessionId,
    prompt: value.prompt,
    ...(typeof value.reset === "boolean" ? { reset: value.reset } : {}),
    ...(typeof value.actor === "string" ? { actor: value.actor } : {}),
    ...(typeof value.note === "string" ? { note: value.note } : {}),
    ...(typeof value.input === "string" ? { input: value.input } : {}),
  };
}

function isDaemonQueueState(value: unknown): value is SparkDaemonQueueState | "all" {
  return value === "inbox" || value === "processed" || value === "failed" || value === "all";
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
