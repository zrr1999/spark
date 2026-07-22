/**
 * Shared helpers for SparkAgentLoop turn execution (timeouts, abort, terminal assistants).
 */
import type {
  AssistantMessage,
  Message,
  Model,
  ToolResultMessage,
  UserMessage,
} from "@zendev-lab/spark-ai";
import {
  sparkPromptItemFromProviderMessage,
  sparkRuntimePromptItem,
  type SparkPromptItem,
  type SparkPromptProviderMessage,
} from "./prompt-items.ts";
import { isPlainRecord } from "./tool-dispatch.ts";

export function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 0;
}

export function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

export async function orderedParallelMap<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(values[index]!, index);
    }
  };
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => await worker()));
  return results;
}

export async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: (error: Error) => void,
): Promise<T> {
  if (timeoutMs <= 0) return await promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          error.name = "SparkAgentLoopTimeoutError";
          onTimeout?.(error);
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfSignalAborted(signal);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortSignalError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function throwIfSignalAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortSignalError(signal);
}

export function abortSignalError(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" && reason ? reason : "operation aborted");
  error.name = "AbortError";
  return error;
}

export function relayAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort((source as { reason?: unknown }).reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

export function beforeAgentStartPromptItems(result: unknown): SparkPromptItem[] {
  if (!result || typeof result !== "object") return [];
  const record = result as { message?: unknown; messages?: unknown };
  const messages = Array.isArray(record.messages) ? record.messages : [record.message];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const content = (message as { content?: unknown }).content;
    if (typeof content !== "string" || !content.trim()) return [];
    const authorityValue = (message as { authority?: unknown }).authority;
    const trustValue = (message as { trust?: unknown }).trust;
    const controlIsExplicitlyTrusted =
      authorityValue === "runtime_control" && trustValue === "trusted";
    const authority = controlIsExplicitlyTrusted ? "runtime_control" : "runtime_data";
    const trust =
      controlIsExplicitlyTrusted || (authorityValue === "runtime_data" && trustValue === "trusted")
        ? "trusted"
        : "untrusted";
    const customType = (message as { customType?: unknown }).customType;
    const details = (message as { details?: unknown }).details;
    return [
      sparkRuntimePromptItem({
        authority,
        trust,
        visibility: (message as { display?: unknown }).display === false ? "hidden" : "visible",
        // before_agent_start is regenerated from current host state on every turn.
        persistence: "transient",
        content,
        ...(typeof customType === "string" && customType ? { customType } : {}),
        ...(isPlainRecord(details) ? { details } : {}),
        timestamp: Date.now(),
      }),
    ];
  });
}

export function loopTerminalAssistant(
  previous: { api: string; provider: string; model: string } | undefined,
  model: Model<string> | undefined,
  stopReason: "error" | "aborted",
  errorMessage: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: previous?.api ?? model?.api ?? "unknown",
    provider: previous?.provider ?? model?.provider ?? "spark",
    model: previous?.model ?? model?.id ?? "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

export function asProviderMessageItem(
  message: Message | AssistantMessage | ToolResultMessage | UserMessage,
): SparkPromptItem {
  return sparkPromptItemFromProviderMessage(message as unknown as SparkPromptProviderMessage);
}

export function safeGetModel(getModel: () => Model<string>): Model<string> | undefined {
  try {
    return getModel();
  } catch {
    return undefined;
  }
}

export function numberField(value: object, field: string): number | undefined {
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}
