import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { NaviaPaths } from "@zendev-lab/navia-system";
import {
  attachWorkspace,
  listWorkspaces,
  planWorkspaceRegistration,
  registerWorkspace,
  runnerServerStatusSummaries,
  type RegisterWorkspaceOptions,
  stopWorkspace,
  type RunnerWorkspace,
  WorkspacePathConflictError,
} from "./store/workspaces.js";
import {
  ensureLocalServiceRegistrationForWorkspace,
  RegistrationGrantRefusedError,
  verifyLocalServiceWorkspaceConnection,
} from "./registration.js";

export interface LocalRpcServer {
  socketPath: string;
  close(): Promise<void>;
}

export interface WorkspaceListResult {
  workspaces: RunnerWorkspace[];
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
  ensureLocalServiceRegistrationForWorkspace?: typeof ensureLocalServiceRegistrationForWorkspace;
  verifyLocalServiceWorkspaceConnection?: typeof verifyLocalServiceWorkspaceConnection;
}

type LocalRpcRequest =
  | { id: string; method: "daemon.status" }
  | { id: string; method: "daemon.stop" }
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
  return join(paths.runtimeDir, "runner.sock");
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

export async function requestWorkspaceRegister(
  paths: NaviaPaths,
  params: LocalWorkspaceRegisterRequest,
): Promise<RunnerWorkspace> {
  return localRpcRequest(
    paths,
    {
      id: localRequestId(),
      method: "workspace.register",
      params: localWorkspaceRegisterParams(params),
    },
    runnerWorkspace,
  );
}

export async function requestWorkspaceAttach(
  paths: NaviaPaths,
  id: string,
): Promise<RunnerWorkspace> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "workspace.attach", params: { id } },
    runnerWorkspace,
  );
}

export async function requestWorkspaceStop(
  paths: NaviaPaths,
  id: string,
): Promise<RunnerWorkspace> {
  return localRpcRequest(
    paths,
    { id: localRequestId(), method: "workspace.stop", params: { id } },
    runnerWorkspace,
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
    options.ensureLocalServiceRegistrationForWorkspace ??
    ensureLocalServiceRegistrationForWorkspace;
  const verifyWorkspaceConnection =
    options.verifyLocalServiceWorkspaceConnection ?? verifyLocalServiceWorkspaceConnection;
  try {
    const request = parseLocalRpcRequest(line);
    requestId = request.id;
    switch (request.method) {
      case "daemon.status":
        return {
          id: request.id,
          ok: true,
          result: {
            servers: runnerServerStatusSummaries(db),
            observedAt: new Date().toISOString(),
          },
        };
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

type LocalWorkspaceRegisterParams = {
  serverUrl: string;
  localPath: string;
  registrationToken?: string;
  localWorkspaceKey?: string;
  displayName?: string;
  profile?: NonNullable<RunnerWorkspace["profile"]>;
};

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
    workspaces: value.workspaces.map(runnerWorkspace),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
  };
}

function daemonStatus(value: unknown): LocalDaemonStatusResult {
  if (!isRecord(value) || !Array.isArray(value.servers)) {
    throw new Error("Invalid local RPC daemon status result.");
  }
  return {
    servers: value.servers.map(daemonServerSummary),
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

function runnerWorkspace(value: unknown): RunnerWorkspace {
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

  const workspace: RunnerWorkspace = {
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
      ? { recentSessions: value.recentSessions.map(runnerWorkspaceRecentSession) }
      : {}),
    updatedAt: value.updatedAt,
  };
  const profile = workspaceProfile(value.profile);
  return profile ? { ...workspace, profile } : workspace;
}

function runnerWorkspaceRecentSession(
  value: unknown,
): NonNullable<RunnerWorkspace["recentSessions"]>[number] {
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

function workspaceProfile(value: unknown): RunnerWorkspace["profile"] | undefined {
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

function isWorkspaceStatus(value: unknown): value is RunnerWorkspace["status"] {
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
