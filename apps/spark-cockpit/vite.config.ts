import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const runtimeWsPattern = /^\/api\/v1\/runtime\/runtimes\/(rt_[a-f0-9]{32})\/ws$/;

export default defineConfig({
  plugins: [runtimeWebSocketDevServer(), sveltekit()],
  ssr: {
    // Lucide publishes Svelte source that must pass through the Svelte
    // transform before Rolldown parses the SSR graph.
    noExternal: ["@lucide/svelte"],
  },
});

function runtimeWebSocketDevServer(): Plugin {
  return {
    name: "spark-cockpit-runtime-websocket-dev-server",
    configureServer(server) {
      const httpServer = server.httpServer;
      if (!httpServer) {
        return;
      }

      const wss = new WebSocketServer({ noServer: true });
      httpServer.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
        const runtimeId = url.pathname.match(runtimeWsPattern)?.[1];
        if (!runtimeId) {
          return;
        }

        void handleRuntimeWebSocketUpgrade(server, wss, request, socket, head, runtimeId);
      });
    },
  };
}

async function handleRuntimeWebSocketUpgrade(
  server: ViteDevServer,
  wss: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  runtimeId: string,
) {
  let releasePin: (() => void) | undefined;
  try {
    const [
      { getDatabase, pinDatabase, unpinDatabase },
      { attachRuntimeWebSocket, authenticateRuntimeToken },
    ] = await Promise.all([
      server.ssrLoadModule("/src/lib/server/db.ts"),
      server.ssrLoadModule("@zendev-lab/spark-cockpit-coordination/runtime-ws"),
    ]);

    pinDatabase();
    let pinHeld = true;
    releasePin = () => {
      if (!pinHeld) return;
      pinHeld = false;
      unpinDatabase();
    };

    const db = getDatabase();
    const tokenId = authenticateRuntimeToken(db, runtimeId, request.headers.authorization);
    if (!tokenId) {
      releasePin();
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("close", releasePin!);
      attachRuntimeWebSocket(ws, {
        db,
        runtimeId,
        remoteAddress: request.socket.remoteAddress,
      });
    });
  } catch (error) {
    releasePin?.();
    server.config.logger.error(
      `Runtime WebSocket upgrade failed: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    rejectUpgrade(socket, "500 Internal Server Error");
  }
}

function rejectUpgrade(socket: Duplex, status: string) {
  if (socket.destroyed) {
    return;
  }

  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
