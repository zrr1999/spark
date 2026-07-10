import type {
  AgentOptions,
  InteractionUpdate,
  Run,
  SDKAgent,
  SDKImage,
  SDKUserMessage,
  SendOptions,
  TokenUsage,
} from "@cursor/sdk";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
} from "@earendil-works/pi-ai";

import { CURSOR_PROVIDER_API, CURSOR_PROVIDER_ID } from "./cursor-constants.ts";
import { buildCursorModelSelection } from "./cursor-model-catalog.ts";
import { sanitizeCursorDiscoveryError } from "./cursor-model-discovery.ts";

export interface CursorSdkRuntime {
  Agent: {
    create(options: AgentOptions): Promise<SDKAgent>;
  };
}

export interface CursorStreamDependencies {
  loadSdk?: () => Promise<CursorSdkRuntime>;
  cwd?: () => string;
}

/**
 * Create a local-only Cursor SDK stream adapter.
 *
 * Spark tools are not exposed to Cursor: no custom tools, MCP bridge, cloud options,
 * or ambient Cursor setting sources are supplied. Cursor's own local-agent tools are
 * still SDK-owned and are not represented as Spark tool calls; this constraint must
 * remain visible until Cursor-native tool/MCP semantics receive a separate safety review.
 */
export function createCursorStreamFunction(dependencies: CursorStreamDependencies = {}) {
  return (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      void runCursorStream(stream, model, context, options, dependencies);
    });
    return stream;
  };
}

export const streamCursor = createCursorStreamFunction();

async function loadCursorSdk(): Promise<CursorSdkRuntime> {
  const { Agent } = await import("@cursor/sdk");
  return { Agent };
}

export function buildCursorPrompt(context: Context): SDKUserMessage {
  const latestUserIndex = findLatestUserIndex(context.messages);
  const transcript: string[] = [
    "Spark is invoking a local Cursor SDK agent runtime.",
    "Spark tools and Spark MCP bridges are unavailable in this runtime.",
    "Do not modify files or perform side effects unless the user's request explicitly requires it.",
  ];
  if (context.systemPrompt?.trim()) {
    transcript.push("", "<system>", context.systemPrompt.trim(), "</system>");
  }

  const images: SDKImage[] = [];
  context.messages.forEach((message, index) => {
    transcript.push(
      "",
      `<${message.role}>`,
      messageText(message, index === latestUserIndex, images),
    );
    transcript.push(`</${message.role}>`);
  });
  return {
    text: transcript.join("\n").trim(),
    ...(images.length > 0 ? { images } : {}),
  };
}

async function runCursorStream(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  dependencies: CursorStreamDependencies,
): Promise<void> {
  const partial = createInitialMessage(model);
  let agent: SDKAgent | undefined;
  let run: Run | undefined;
  const abortedMarker = Symbol("cursor-stream-aborted");
  let resolveAbort: ((value: typeof abortedMarker) => void) | undefined;
  const abortPromise = new Promise<typeof abortedMarker>((resolve) => (resolveAbort = resolve));
  let cancelRequested = false;
  let cancelPromise: Promise<void> | undefined;
  let terminal = false;
  const cancelRun = (): void => {
    cancelRequested = true;
    resolveAbort?.(abortedMarker);
    if (run && !cancelPromise) cancelPromise = run.cancel().catch(() => undefined);
  };
  const signal = options?.signal;
  signal?.addEventListener("abort", cancelRun, { once: true });

  try {
    stream.push({ type: "start", partial });
    throwIfAborted(signal);
    const apiKey = resolveCursorApiKey(options?.apiKey);
    if (!apiKey)
      throw new Error("Cursor SDK API key is missing; configure CURSOR_API_KEY or Spark auth.");
    const sdk = await (dependencies.loadSdk ?? loadCursorSdk)();
    throwIfAborted(signal);
    const selection = buildCursorModelSelection(model.id, options?.reasoning ?? "off");
    const createOptions: AgentOptions = {
      apiKey,
      model: selection,
      mode: "agent",
      local: {
        cwd: dependencies.cwd?.() ?? process.cwd(),
        settingSources: [],
        sandboxOptions: { enabled: true },
      },
    };
    const createdAgent = await sdk.Agent.create(createOptions);
    agent = createdAgent;
    throwIfAborted(signal);

    const state = new CursorDeltaState(stream, partial);
    const sendOptions: SendOptions = {
      model: selection,
      mode: "agent",
      onDelta: ({ update }) => state.consume(update),
    };
    run = await createdAgent.send(buildCursorPrompt(context), sendOptions);
    if (cancelRequested || signal?.aborted) {
      cancelRun();
      await cancelPromise;
      throw new CursorStreamAbortError();
    }
    const resultOrAbort = await Promise.race([run.wait(), abortPromise]);
    if (resultOrAbort === abortedMarker) {
      await cancelPromise;
      throw new CursorStreamAbortError();
    }
    const result = resultOrAbort;
    if (cancelRequested || signal?.aborted || result.status === "cancelled") {
      cancelRun();
      await cancelPromise;
      throw new CursorStreamAbortError(result.error?.message);
    }
    state.complete(result.result);
    applyCursorUsage(partial, result.usage ?? run.usage);
    if (result.status === "error") {
      throw new Error(result.error?.message ?? "Cursor SDK run failed.");
    }
    partial.stopReason = "stop";
    stream.push({ type: "done", reason: "stop", message: partial });
    terminal = true;
  } catch (error) {
    if (!terminal) {
      const aborted = error instanceof CursorStreamAbortError || signal?.aborted === true;
      partial.stopReason = aborted ? "aborted" : "error";
      partial.errorMessage = aborted
        ? "Cursor SDK run was aborted."
        : sanitizeCursorProviderError(error, options?.apiKey);
      stream.push({
        type: "error",
        reason: aborted ? "aborted" : "error",
        error: partial,
      });
    }
  } finally {
    signal?.removeEventListener("abort", cancelRun);
    await cancelPromise;
    if (agent) {
      try {
        await agent[Symbol.asyncDispose]();
      } catch {
        agent.close();
      }
    }
  }
}

class CursorDeltaState {
  readonly #stream: AssistantMessageEventStream;
  readonly #partial: AssistantMessage;
  #textIndex: number | undefined;
  #thinkingIndex: number | undefined;
  #textOpen = false;
  #thinkingOpen = false;
  #usage: TokenUsage | undefined;

  constructor(stream: AssistantMessageEventStream, partial: AssistantMessage) {
    this.#stream = stream;
    this.#partial = partial;
  }

  consume(update: InteractionUpdate): void {
    switch (update.type) {
      case "text-delta":
        this.appendText(update.text);
        break;
      case "thinking-delta":
        this.appendThinking(update.text);
        break;
      case "thinking-completed":
        this.closeThinking();
        break;
      case "turn-ended":
        if (update.usage) {
          const { reasoningTokens, ...usage } = update.usage;
          this.#usage = {
            ...usage,
            totalTokens: update.usage.inputTokens + update.usage.outputTokens,
            ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
          };
        }
        break;
      default:
        break;
    }
  }

  complete(resultText?: string): void {
    if (!this.textContent().trim() && resultText?.trim()) this.appendText(resultText);
    this.closeThinking();
    this.closeText();
    if (this.#usage) applyCursorUsage(this.#partial, this.#usage);
  }

  private appendText(delta: string): void {
    if (!delta) return;
    if (this.#textIndex === undefined) {
      this.#textIndex = this.#partial.content.length;
      this.#partial.content.push({ type: "text", text: "" });
    }
    if (!this.#textOpen) {
      this.#textOpen = true;
      this.#stream.push({
        type: "text_start",
        contentIndex: this.#textIndex,
        partial: this.#partial,
      });
    }
    const block = this.#partial.content[this.#textIndex] as TextContent;
    block.text += delta;
    this.#stream.push({
      type: "text_delta",
      contentIndex: this.#textIndex,
      delta,
      partial: this.#partial,
    });
  }

  private appendThinking(delta: string): void {
    if (!delta) return;
    if (this.#thinkingIndex === undefined) {
      this.#thinkingIndex = this.#partial.content.length;
      this.#partial.content.push({ type: "thinking", thinking: "" });
    }
    if (!this.#thinkingOpen) {
      this.#thinkingOpen = true;
      this.#stream.push({
        type: "thinking_start",
        contentIndex: this.#thinkingIndex,
        partial: this.#partial,
      });
    }
    const block = this.#partial.content[this.#thinkingIndex] as ThinkingContent;
    block.thinking += delta;
    this.#stream.push({
      type: "thinking_delta",
      contentIndex: this.#thinkingIndex,
      delta,
      partial: this.#partial,
    });
  }

  private closeText(): void {
    if (!this.#textOpen || this.#textIndex === undefined) return;
    this.#textOpen = false;
    this.#stream.push({
      type: "text_end",
      contentIndex: this.#textIndex,
      content: this.textContent(),
      partial: this.#partial,
    });
  }

  private closeThinking(): void {
    if (!this.#thinkingOpen || this.#thinkingIndex === undefined) return;
    this.#thinkingOpen = false;
    const block = this.#partial.content[this.#thinkingIndex] as ThinkingContent;
    this.#stream.push({
      type: "thinking_end",
      contentIndex: this.#thinkingIndex,
      content: block.thinking,
      partial: this.#partial,
    });
  }

  private textContent(): string {
    if (this.#textIndex === undefined) return "";
    return (this.#partial.content[this.#textIndex] as TextContent).text;
  }
}

class CursorStreamAbortError extends Error {
  constructor(message = "Cursor SDK run was aborted.") {
    super(message);
    this.name = "CursorStreamAbortError";
  }
}

function createInitialMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: CURSOR_PROVIDER_API,
    provider: CURSOR_PROVIDER_ID,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function applyCursorUsage(message: AssistantMessage, usage: TokenUsage | undefined): void {
  if (!usage) return;
  message.usage = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    ...(usage.reasoningTokens !== undefined ? { reasoning: usage.reasoningTokens } : {}),
    totalTokens: usage.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function resolveCursorApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey || apiKey === "CURSOR_API_KEY") return process.env.CURSOR_API_KEY;
  return apiKey;
}

function sanitizeCursorProviderError(error: unknown, apiKey?: string): string {
  const sanitized = sanitizeCursorDiscoveryError(error, resolveCursorApiKey(apiKey));
  return sanitized || "Cursor SDK run failed.";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CursorStreamAbortError();
}

function findLatestUserIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function messageText(message: Message, isLatestUser: boolean, images: SDKImage[]): string {
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((content) => {
        if (content.type === "text") return content.text;
        if (isLatestUser) {
          images.push(toCursorImage(content));
          return "[image attached]";
        }
        return "[historical image omitted]";
      })
      .join("\n");
  }
  if (message.role === "toolResult") {
    return [
      `tool: ${message.toolName}`,
      `toolCallId: ${message.toolCallId}`,
      `status: ${message.isError ? "error" : "success"}`,
      ...message.content.map((content) =>
        content.type === "text" ? content.text : "[tool-result image omitted]",
      ),
    ].join("\n");
  }
  return message.content
    .map((content) => {
      if (content.type === "text") return content.text;
      if (content.type === "thinking") return `<thinking>${content.thinking}</thinking>`;
      return `<tool-call name="${content.name}">${JSON.stringify(content.arguments)}</tool-call>`;
    })
    .join("\n");
}

function toCursorImage(image: ImageContent): SDKImage {
  return { data: image.data, mimeType: image.mimeType };
}
