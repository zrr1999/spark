/**
 * oRPC client for the parallel daemon-orpc.sock MessagePort transport.
 * Prefer this for methods in `sparkLocalRpcOrpcLiveMethods`; fall back to
 * legacy `requestSparkDaemonLocalRpc` for everything else.
 */
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import {
  sparkLocalRpcOrpcLiveMethods,
  sparkLocalRpcOrpcMethodPaths,
  type SparkLocalRpcOrpcLiveMethod,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { resolveSparkPaths, type SparkPaths } from "./paths.ts";
import { createSocketMessagePort, type SocketMessagePortLike } from "./socket-message-port.ts";

export interface SparkDaemonOrpcClientOptions {
  paths?: Pick<SparkPaths, "runtimeDir">;
  socketPath?: string;
  env?: Record<string, string | undefined>;
  connectTimeoutMs?: number;
}

export function sparkDaemonOrpcSocketPath(
  paths: Pick<SparkPaths, "runtimeDir"> = resolveSparkPaths({ app: "daemon" }),
): string {
  return join(paths.runtimeDir, "daemon-orpc.sock");
}

export function isSparkDaemonOrpcLiveMethod(method: string): method is SparkLocalRpcOrpcLiveMethod {
  return (sparkLocalRpcOrpcLiveMethods as readonly string[]).includes(method);
}

/** Nested oRPC client surface; prefer `invokeSparkDaemonOrpcLiveMethod` for dotted methods. */
export type SparkDaemonOrpcClient = {
  daemon: {
    status: (input?: Record<string, never>) => Promise<{
      lifecycle: { state: "starting" | "running" | "draining" | "stopping" };
      observedAt: string;
    }>;
    stop: (input?: Record<string, never>) => Promise<{ stopping: true; observedAt: string }>;
    restart: (input?: Record<string, never>) => Promise<unknown>;
  };
  workspace: {
    list: (input?: Record<string, never>) => Promise<{
      workspaces: Array<{ id: string; localPath: string }>;
      observedAt: string;
    }>;
    ensureLocal: (input: {
      localPath: string;
      displayName?: string;
      localWorkspaceKey?: string;
    }) => Promise<unknown>;
    [key: string]: unknown;
  };
  uplink: {
    status: (input?: Record<string, never>) => Promise<{
      origins: Array<{ serverUrl: string; preferred?: boolean; parked?: boolean }>;
    }>;
    [key: string]: unknown;
  };
  model: {
    catalog: (input?: { sessionId?: string }) => Promise<unknown>;
    [key: string]: unknown;
  };
  turn: {
    status: (input: { invocationId: string }) => Promise<unknown>;
    result: (input: { invocationId: string }) => Promise<unknown>;
    [key: string]: unknown;
  };
  invocation: {
    list: (input?: Record<string, unknown>) => Promise<unknown>;
    [key: string]: unknown;
  };
  session: {
    list: (input?: Record<string, unknown>) => Promise<unknown>;
    [key: string]: unknown;
  };
  channel: {
    status: (input: { workspaceId: string }) => Promise<unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export interface SparkDaemonOrpcClientHandle {
  client: SparkDaemonOrpcClient;
  port: SocketMessagePortLike;
  close(): void;
}

export async function invokeSparkDaemonOrpcLiveMethod(
  client: SparkDaemonOrpcClient,
  method: SparkLocalRpcOrpcLiveMethod,
  params: unknown = {},
): Promise<unknown> {
  const path = sparkLocalRpcOrpcMethodPaths[method];
  let current: unknown = client;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      throw new Error(`oRPC client missing path segment "${segment}" for ${method}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current !== "function") {
    throw new Error(`oRPC client path for ${method} is not callable`);
  }
  return await (current as (input: unknown) => Promise<unknown>)(params ?? {});
}

export async function createSparkDaemonOrpcClient(
  options: SparkDaemonOrpcClientOptions = {},
): Promise<SparkDaemonOrpcClientHandle> {
  const paths =
    options.paths ??
    resolveSparkPaths({
      app: "daemon",
      ...(options.env ? { env: options.env } : {}),
    });
  const socketPath = options.socketPath ?? sparkDaemonOrpcSocketPath(paths);
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;

  const socket: Socket = await new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`Timed out connecting to Spark daemon oRPC socket: ${socketPath}`));
    }, connectTimeoutMs);
    conn.once("connect", () => {
      clearTimeout(timer);
      resolve(conn);
    });
    conn.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const port = createSocketMessagePort(socket);
  const link = new RPCLink({ port });
  const client = createORPCClient(link) as SparkDaemonOrpcClient;

  return {
    client,
    port,
    close: () => {
      port.close();
      socket.destroy();
    },
  };
}
