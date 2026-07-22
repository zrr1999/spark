import { createConnection, createServer, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

/**
 * MessagePort-like surface compatible with oRPC's MessagePortMainLike
 * (`on` + `postMessage`). Bridges Unix-domain sockets into
 * `@orpc/server/message-port` / `@orpc/client/message-port`.
 */
export interface SocketMessagePortLike {
  on(event: "message", callback: (event: { data: unknown }) => void): void;
  on(event: "close", callback: () => void): void;
  on(event: "error", callback: (error: Error) => void): void;
  postMessage(data: unknown): void;
  close(): void;
}

type MessageListener = (event: { data: unknown }) => void;
type CloseListener = () => void;
type ErrorListener = (error: Error) => void;

/**
 * Wrap a connected `net.Socket` as an oRPC-compatible MessagePort.
 * Frames are newline-delimited JSON `{ "data": ... }` so string/object
 * payloads from oRPC's default (non-transfer) codec survive the socket.
 */
export function createSocketMessagePort(socket: Socket): SocketMessagePortLike {
  const messageListeners = new Set<MessageListener>();
  const closeListeners = new Set<CloseListener>();
  const errorListeners = new Set<ErrorListener>();
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let closed = false;

  const emitClose = () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };

  const emitError = (error: Error) => {
    for (const listener of errorListeners) listener(error);
  };

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (cause) {
      emitError(
        cause instanceof Error
          ? cause
          : new Error("Socket MessagePort received invalid JSON frame."),
      );
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("data" in parsed) ||
      Array.isArray(parsed)
    ) {
      emitError(new Error("Socket MessagePort frame must be an object with a data field."));
      return;
    }
    const event = { data: (parsed as { data: unknown }).data };
    for (const listener of messageListeners) listener(event);
  };

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("end", emitClose);
  socket.on("close", emitClose);
  socket.on("error", (error) => {
    emitError(error);
    emitClose();
  });

  return {
    on(
      event: "message" | "close" | "error",
      callback: MessageListener | CloseListener | ErrorListener,
    ): void {
      if (event === "message") {
        messageListeners.add(callback as MessageListener);
        return;
      }
      if (event === "close") {
        closeListeners.add(callback as CloseListener);
        return;
      }
      errorListeners.add(callback as ErrorListener);
    },
    postMessage(data: unknown): void {
      if (closed || socket.destroyed) {
        throw new Error("Cannot postMessage on a closed Socket MessagePort.");
      }
      socket.write(`${JSON.stringify({ data })}\n`);
    },
    close(): void {
      if (closed) return;
      socket.end();
      emitClose();
    },
  };
}

export interface UnixSocketMessagePortPair {
  client: SocketMessagePortLike;
  server: SocketMessagePortLike;
  socketPath: string;
  close: () => Promise<void>;
}

/**
 * Create a temporary Unix-domain socket pair of MessagePort-like ends.
 * Useful for spike / unit tests without a live daemon.
 */
export async function createUnixSocketMessagePortPair(
  socketPath: string,
): Promise<UnixSocketMessagePortPair> {
  const server = createServer();
  await listenUnix(server, socketPath);

  const serverSocketPromise = new Promise<Socket>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("connection", onConnection);
      reject(error);
    };
    const onConnection = (socket: Socket) => {
      server.off("error", onError);
      resolve(socket);
    };
    server.once("error", onError);
    server.once("connection", onConnection);
  });

  const clientSocket = await connectUnix(socketPath);
  const serverSocket = await serverSocketPromise;

  const client = createSocketMessagePort(clientSocket);
  const serverPort = createSocketMessagePort(serverSocket);

  return {
    client,
    server: serverPort,
    socketPath,
    close: async () => {
      client.close();
      serverPort.close();
      await closeServer(server);
    },
  };
}

function listenUnix(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
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
}

function connectUnix(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
