import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { join } from "node:path";
import { resolveSparkPaths, type SparkPaths } from "./paths.ts";

export interface SparkDaemonLocalRpcClientOptions {
  paths?: Pick<SparkPaths, "runtimeDir">;
  socketPath?: string;
  env?: Record<string, string | undefined>;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface SparkDaemonLocalRpcWireRequest {
  id: string;
  method: string;
  params?: unknown;
}

export class SparkDaemonLocalRpcUnavailableError extends Error {
  override readonly name: string = "SparkDaemonLocalRpcUnavailableError";
}

export class SparkDaemonLocalRpcError extends Error {
  override readonly name: string = "SparkDaemonLocalRpcError";
}

export class SparkDaemonLocalRpcRemoteError extends SparkDaemonLocalRpcError {
  override readonly name = "SparkDaemonLocalRpcRemoteError";
  readonly payload: unknown;

  constructor(message: string, payload: unknown) {
    super(message);
    this.payload = payload;
  }
}

/** Small transport-only client used by non-daemon packages. Domain methods and
 * result validation stay with their callers; this module only owns the socket. */
export async function requestSparkDaemonLocalRpc<T>(
  method: string,
  params?: unknown,
  options: SparkDaemonLocalRpcClientOptions = {},
): Promise<T> {
  return await requestSparkDaemonLocalRpcWire<T>(
    {
      id: `local-${randomUUID()}`,
      method,
      ...(params === undefined ? {} : { params }),
    },
    options,
  );
}

/** Send one newline-delimited local-RPC request. Callers retain ownership of
 * domain-specific request fields and result validation. */
export async function requestSparkDaemonLocalRpcWire<T>(
  request: SparkDaemonLocalRpcWireRequest,
  options: SparkDaemonLocalRpcClientOptions = {},
): Promise<T> {
  const socketPath =
    options.socketPath ??
    join(
      (
        options.paths ??
        resolveSparkPaths({
          app: "daemon",
          ...(options.env ? { env: options.env } : {}),
        })
      ).runtimeDir,
      "daemon.sock",
    );
  const maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;

  if (options.signal?.aborted) throw abortError();

  return await new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let responseBytes = 0;
    let settled = false;

    const finish = (result: { ok: true; value: T } | { ok: false; error: Error }) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (result.ok) resolve(result.value);
      else reject(result.error);
    };
    const onAbort = () => finish({ ok: false, error: abortError() });

    options.signal?.addEventListener("abort", onAbort, { once: true });

    socket.setTimeout(options.connectTimeoutMs ?? 1_000, () => {
      finish({
        ok: false,
        error: new SparkDaemonLocalRpcUnavailableError(`Timed out connecting to ${socketPath}`),
      });
    });
    socket.once("error", (error) => {
      finish({ ok: false, error: new SparkDaemonLocalRpcUnavailableError(error.message) });
    });
    socket.once("connect", () => {
      socket.setTimeout(options.responseTimeoutMs ?? 30_000, () => {
        finish({
          ok: false,
          error: new SparkDaemonLocalRpcUnavailableError(
            `Timed out waiting for daemon RPC response from ${socketPath}`,
          ),
        });
      });
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.once("close", () => {
      if (!settled) {
        finish({
          ok: false,
          error: new SparkDaemonLocalRpcError(
            "Spark daemon local RPC connection closed before a response.",
          ),
        });
      }
    });
    socket.on("data", (chunk) => {
      responseBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (responseBytes > maxResponseBytes) {
        finish({
          ok: false,
          error: new SparkDaemonLocalRpcError(
            `Spark daemon local RPC response exceeded ${maxResponseBytes} bytes.`,
          ),
        });
        return;
      }
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as unknown;
        if (!isRecord(response) || typeof response.ok !== "boolean") {
          throw new SparkDaemonLocalRpcError("Invalid local RPC response.");
        }
        const remoteMessage =
          isRecord(response.error) && typeof response.error.message === "string"
            ? response.error.message
            : undefined;
        if (response.id !== request.id) {
          if (
            response.id === "unknown" &&
            response.ok === false &&
            remoteMessage?.startsWith("Unknown local RPC method:")
          ) {
            throw new SparkDaemonLocalRpcUnavailableError(
              `The running Spark daemon does not support ${request.method}; restart or upgrade it. ${remoteMessage}`,
            );
          }
          throw new SparkDaemonLocalRpcError("Invalid local RPC response.");
        }
        if (response.ok !== true) {
          finish({
            ok: false,
            error: new SparkDaemonLocalRpcRemoteError(
              remoteMessage ?? "Local RPC failed.",
              response.error,
            ),
          });
          return;
        }
        finish({ ok: true, value: response.result as T });
      } catch (error) {
        finish({
          ok: false,
          error: error instanceof Error ? error : new SparkDaemonLocalRpcError(String(error)),
        });
      }
    });
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
