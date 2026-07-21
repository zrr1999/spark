/**
 * Shared tool-result shape + context helpers for spark-files tools.
 *
 * Stays free of any host/UI dependency: tools return plain text content and
 * structured `details`, and the host renders them.
 */

import type { SparkHostContext } from "@zendev-lab/spark-core";

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolExecResult {
  content: ToolTextContent[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

export function text(value: string): ToolTextContent {
  return { type: "text", text: value };
}

/** Resolve the working directory for a tool call from the extension context. */
export function resolveToolCwd(ctx: SparkHostContext | undefined): string {
  const cwd = ctx?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
