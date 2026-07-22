/**
 * Bridge oRPC procedure calls onto the legacy local-rpc dispatch so every
 * contracted method can share one implementation.
 */
import type { DatabaseSync } from "node:sqlite";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { handleLocalRpcLine } from "./dispatch.ts";
import type { LocalRpcHandlerOptions } from "./types.ts";

export interface InvokeLegacyLocalRpcOptions {
  paths: SparkPaths;
  db: DatabaseSync;
  onStop?: () => void | Promise<void>;
  handlerOptions?: LocalRpcHandlerOptions;
}

/** Read a legacy error code without treating it as safe for a new transport. */
export function legacyLocalRpcErrorCode(error: unknown): string | undefined {
  return error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

export async function invokeLegacyLocalRpc(
  method: string,
  params: unknown,
  options: InvokeLegacyLocalRpcOptions,
): Promise<unknown> {
  const response = await handleLocalRpcLine(
    JSON.stringify({
      id: `orpc:${method}`,
      method,
      params: params ?? {},
    }),
    options.paths,
    options.db,
    options.onStop,
    options.handlerOptions ?? {},
  );
  if (!response.ok) {
    const message =
      typeof response.error?.message === "string" && response.error.message.trim()
        ? response.error.message
        : `${method} failed`;
    const error = new Error(message) as Error & { code?: string; kind?: string };
    if (typeof response.error?.code === "string") error.code = response.error.code;
    if (typeof response.error?.kind === "string") error.kind = response.error.kind;
    throw error;
  }
  return response.result;
}
