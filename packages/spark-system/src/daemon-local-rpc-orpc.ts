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

export interface SparkDaemonOrpcClientHandle {
  // RouterClient typing is owned by the daemon router; callers use nested
  // procedure calls (client.daemon.status(...)) for live methods.
  client: {
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
    };
    uplink: {
      status: (input?: Record<string, never>) => Promise<{
        origins: Array<{ serverUrl: string; preferred?: boolean; parked?: boolean }>;
      }>;
    };
    model: {
      catalog: (input?: { sessionId?: string }) => Promise<unknown>;
    };
    turn: {
      status: (input: { invocationId: string }) => Promise<unknown>;
      result: (input: { invocationId: string }) => Promise<unknown>;
    };
    invocation: {
      list: (input?: Record<string, unknown>) => Promise<unknown>;
    };
    session: {
      list: (input?: Record<string, unknown>) => Promise<unknown>;
    };
    channel: {
      status: (input: { workspaceId: string }) => Promise<unknown>;
    };
  };
  port: SocketMessagePortLike;
  close(): void;
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
  const client = createORPCClient(link) as SparkDaemonOrpcClientHandle["client"];

  return {
    client,
    port,
    close: () => {
      port.close();
      socket.destroy();
    },
  };
}
