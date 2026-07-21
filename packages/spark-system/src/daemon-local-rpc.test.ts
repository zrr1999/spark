import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  requestSparkDaemonLocalRpcWire,
  SparkDaemonLocalRpcError,
  SparkDaemonLocalRpcRemoteError,
  SparkDaemonLocalRpcUnavailableError,
} from "./daemon-local-rpc.js";

describe("Spark daemon local RPC transport", () => {
  it("uses the response timeout after connecting instead of retaining the connect timeout", async () => {
    const connectTimeoutMs = 1_000;
    const fixture = await rpcFixture((request, socket) => {
      setTimeout(() => {
        socket.end(`${JSON.stringify({ id: request.id, ok: true, result: "ready" })}\n`);
      }, connectTimeoutMs + 250);
    });

    try {
      await expect(
        requestSparkDaemonLocalRpcWire<string>(
          { id: "delayed-response", method: "daemon.status" },
          {
            socketPath: fixture.socketPath,
            connectTimeoutMs,
            responseTimeoutMs: 5_000,
          },
        ),
      ).resolves.toBe("ready");
    } finally {
      await fixture.close();
    }
  });

  it("reports response-phase timeouts without reusing the connect-timeout error", async () => {
    const fixture = await rpcFixture(() => {});

    try {
      const error = await requestSparkDaemonLocalRpcWire(
        { id: "response-timeout", method: "daemon.status" },
        {
          socketPath: fixture.socketPath,
          connectTimeoutMs: 1_000,
          responseTimeoutMs: 20,
        },
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SparkDaemonLocalRpcUnavailableError);
      expect(error).toMatchObject({
        message: `Timed out waiting for daemon RPC response from ${fixture.socketPath}`,
      });
    } finally {
      await fixture.close();
    }
  });

  it("reports a connection closed before its response as unavailable", async () => {
    const fixture = await rpcFixture((_request, socket) => socket.end());

    try {
      const error = await requestSparkDaemonLocalRpcWire(
        { id: "closed-response", method: "daemon.status" },
        { socketPath: fixture.socketPath },
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SparkDaemonLocalRpcUnavailableError);
      expect(error).toMatchObject({
        message: "Spark daemon local RPC connection closed before a response.",
      });
    } finally {
      await fixture.close();
    }
  });

  it("preserves caller-owned wire fields and exposes remote error details", async () => {
    const fixture = await rpcFixture((request, socket) => {
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: false,
          error: { message: String(request.marker), code: "example" },
        })}\n`,
      );
    });
    const request = {
      id: "wire-fields",
      method: "daemon.status",
      marker: "preserved",
    };

    try {
      const error = await requestSparkDaemonLocalRpcWire(request, {
        socketPath: fixture.socketPath,
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SparkDaemonLocalRpcRemoteError);
      expect(error).toMatchObject({
        message: "preserved",
        payload: { message: "preserved", code: "example" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("reports an old daemon that rejects a new method as unavailable", async () => {
    const fixture = await rpcFixture((_request, socket) => {
      socket.end(
        `${JSON.stringify({
          id: "unknown",
          ok: false,
          error: { message: "Unknown local RPC method: session.list" },
        })}\n`,
      );
    });

    try {
      const error = await requestSparkDaemonLocalRpcWire(
        { id: "new-method", method: "session.list", params: {} },
        { socketPath: fixture.socketPath },
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SparkDaemonLocalRpcUnavailableError);
      expect(error).toMatchObject({
        message:
          "The running Spark daemon does not support session.list; restart or upgrade it. Unknown local RPC method: session.list",
      });
    } finally {
      await fixture.close();
    }
  });

  it("surfaces remote parse errors even when the daemon replies with id unknown", async () => {
    const fixture = await rpcFixture((_request, socket) => {
      socket.end(
        `${JSON.stringify({
          id: "unknown",
          ok: false,
          error: { message: "ingress.on_unbound must be reject or create" },
        })}\n`,
      );
    });

    try {
      const error = await requestSparkDaemonLocalRpcWire(
        { id: "configure", method: "channel.configure", params: {} },
        { socketPath: fixture.socketPath },
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SparkDaemonLocalRpcRemoteError);
      expect(error).toMatchObject({
        message: "ingress.on_unbound must be reject or create",
        payload: { message: "ingress.on_unbound must be reject or create" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("decodes a response when a UTF-8 character is split across socket chunks", async () => {
    const fixture = await rpcFixture((request, socket) => {
      const response = Buffer.from(
        `${JSON.stringify({ id: request.id, ok: true, result: "你好" })}\n`,
        "utf8",
      );
      const characterStart = response.indexOf(Buffer.from("你", "utf8"));
      socket.write(response.subarray(0, characterStart + 1));
      setTimeout(() => socket.end(response.subarray(characterStart + 1)), 5);
    });

    try {
      await expect(
        requestSparkDaemonLocalRpcWire<string>(
          { id: "split-utf8", method: "daemon.status" },
          { socketPath: fixture.socketPath },
        ),
      ).resolves.toBe("你好");
    } finally {
      await fixture.close();
    }
  });

  it("bounds a response before accumulating an unbounded line", async () => {
    const fixture = await rpcFixture((_request, socket) => {
      socket.end("x".repeat(128));
    });

    try {
      const error = await requestSparkDaemonLocalRpcWire(
        { id: "oversized", method: "daemon.status" },
        { socketPath: fixture.socketPath, maxResponseBytes: 64 },
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SparkDaemonLocalRpcError);
      expect(error).toMatchObject({
        message: "Spark daemon local RPC response exceeded 64 bytes.",
      });
    } finally {
      await fixture.close();
    }
  });

  it("honors an already-aborted signal and invalid JSON payloads", async () => {
    const fixture = await rpcFixture((_request, socket) => {
      socket.end("{not-json}\n");
    });
    const aborted = new AbortController();
    aborted.abort();

    try {
      const abortedError = await requestSparkDaemonLocalRpcWire(
        { id: "aborted", method: "daemon.status" },
        { socketPath: fixture.socketPath, signal: aborted.signal },
      ).catch((cause: unknown) => cause);
      expect(abortedError).toMatchObject({ name: "AbortError" });

      const invalid = await requestSparkDaemonLocalRpcWire(
        { id: "invalid-json", method: "daemon.status" },
        { socketPath: fixture.socketPath },
      ).catch((cause: unknown) => cause);
      expect(invalid).toBeInstanceOf(Error);
      expect(String(invalid)).toMatch(/JSON|Unexpected|property/i);
    } finally {
      await fixture.close();
    }
  });

  it("rejects mismatched response ids that are not unknown parse failures", async () => {
    const fixture = await rpcFixture((_request, socket) => {
      socket.end(`${JSON.stringify({ id: "other-id", ok: true, result: "nope" })}\n`);
    });

    try {
      const error = await requestSparkDaemonLocalRpcWire(
        { id: "expected-id", method: "daemon.status" },
        { socketPath: fixture.socketPath },
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SparkDaemonLocalRpcError);
      expect(String(error)).toMatch(/id/i);
    } finally {
      await fixture.close();
    }
  });
});

async function rpcFixture(
  respond: (request: Record<string, unknown>, socket: import("node:net").Socket) => void,
): Promise<{ socketPath: string; close(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "spark-local-rpc-"));
  const socketPath = join(root, "daemon.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      respond(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>, socket);
    });
  });
  await listen(server, socketPath);
  return {
    socketPath,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
