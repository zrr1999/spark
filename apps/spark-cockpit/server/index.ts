import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { configureCockpitPublicUrl } from "../src/lib/server/public-url.js";
import { closeDatabase, getDatabase, pinDatabase, unpinDatabase } from "../src/lib/server/db.js";
import { attachRuntimeWebSocket, authenticateRuntimeToken } from "../src/lib/server/runtime-ws.js";
import { startWebPushEventDispatcher } from "../src/lib/server/web-push.js";
import { WebSocketServer } from "ws";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "5173");
const publicUrl = configureCockpitPublicUrl(process.env, { host, port });

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

  pinDatabase();
  let pinHeld = true;
  const releasePin = () => {
    if (!pinHeld) return;
    pinHeld = false;
    unpinDatabase();
  };

  try {
    const db = getDatabase();
    const tokenId = authenticateRuntimeToken(db, runtimeId, request.headers.authorization);
    if (!tokenId) {
      releasePin();
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("close", releasePin);
      attachRuntimeWebSocket(ws, {
        db,
        runtimeId,
        remoteAddress: request.socket.remoteAddress,
        secureTransport: runtimeUpgradeIsSecure(request, publicUrl.trustedProxy),
      });
    });
  } catch (error) {
    releasePin();
    throw error;
  }
});

function runtimeUpgradeIsSecure(request: IncomingMessage, trustedProxy: boolean): boolean {
  const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;
  if (encrypted) return true;
  if (!trustedProxy) return false;
  const forwarded = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return protocol?.trim().toLowerCase() === "https";
}

const stopWebPushDispatcher = startWebPushEventDispatcher({});
server.on("close", () => {
  stopWebPushDispatcher();
  closeDatabase();
});

let shuttingDown = false;
const requestShutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.close();
};
process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);
server.on("error", () => {
  process.exitCode = 1;
  stopWebPushDispatcher();
  closeDatabase();
});

server.listen(port, host, () => {
  console.log(`Spark Cockpit server listening on http://${host}:${port}`);
  if (publicUrl.mode === "fixed") {
    console.log(`Spark Cockpit public URL: ${publicUrl.publicUrl}`);
  } else if (publicUrl.mode === "proxy") {
    console.log("Spark Cockpit public URL is derived from its trusted loopback proxy.");
  }
  if (host === "0.0.0.0" || publicUrl.mode !== "local") {
    console.log(
      "Spark Cockpit remote browser access requires a Cockpit one-time key (/login), then a workspace key (/{slug}/login).",
    );
  }
});
