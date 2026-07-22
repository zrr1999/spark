/**
 * Parallel oRPC MessagePort listener beside the legacy line-delimited local-rpc
 * socket. Live methods round-trip here; everything else stays on daemon.sock.
 */
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { RPCHandler } from "@orpc/server/message-port";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { createSocketMessagePort } from "@zendev-lab/spark-system/socket-message-port";
import { createLocalRpcOrpcRouter, type CreateLocalRpcOrpcRouterOptions } from "./orpc-router.ts";
import type { LocalRpcHandlerOptions } from "./types.ts";

export function localRpcOrpcSocketPath(paths: SparkPaths): string {
  return join(paths.runtimeDir, "daemon-orpc.sock");
}

export interface LocalRpcOrpcServer {
  socketPath: string;
  close(): Promise<void>;
}

export async function startLocalRpcOrpcServer(options: {
  paths: SparkPaths;
  db: DatabaseSync;
  onStop?: () => void | Promise<void>;
  handlerOptions?: LocalRpcHandlerOptions;
}): Promise<LocalRpcOrpcServer> {
  const socketPath = localRpcOrpcSocketPath(options.paths);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });

  const routerInput: CreateLocalRpcOrpcRouterOptions = {
    paths: options.paths,
    db: options.db,
    ...(options.onStop ? { onStop: options.onStop } : {}),
    ...(options.handlerOptions ? { options: options.handlerOptions } : {}),
  };
  const router = createLocalRpcOrpcRouter(routerInput);
  const handler = new RPCHandler(router);
  const sockets = new Set<Socket>();
  let closePromise: Promise<void> | undefined;

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const port = createSocketMessagePort(socket);
    handler.upgrade(port);
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
      closePromise = new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => {
          rmSync(socketPath, { force: true });
          if (error) reject(error);
          else resolve();
        });
      });
      return closePromise;
    },
  };
}
