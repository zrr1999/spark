import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getDatabase } from "../src/lib/server/db.js";
import { attachRuntimeWebSocket, authenticateRuntimeToken } from "../src/lib/server/runtime-ws.js";
import { WebSocketServer } from "ws";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "5173");
process.env.ORIGIN ??= `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

type SvelteKitHandler = (request: IncomingMessage, response: ServerResponse) => void;
const buildHandlerUrl = new URL("../build/handler.js", import.meta.url);
const { handler } = (await import(buildHandlerUrl.href)) as { handler: SvelteKitHandler };

const server = createServer((request, response) => {
  handler(request, response);
});

const wss = new WebSocketServer({ noServer: true });
const runtimeWsPattern = /^\/api\/v1\/runtime\/runtimes\/(rt_[a-f0-9]{32})\/ws$/;

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
  const runtimeId = url.pathname.match(runtimeWsPattern)?.[1];

  if (!runtimeId) {
    socket.destroy();
    return;
  }

  const db = getDatabase();
  const tokenId = authenticateRuntimeToken(db, runtimeId, request.headers.authorization);
  if (!tokenId) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    attachRuntimeWebSocket(ws, { db, runtimeId, remoteAddress: request.socket.remoteAddress });
  });
});

server.listen(port, host, () => {
  console.log(`Spark Cockpit server listening on http://${host}:${port}`);
});
