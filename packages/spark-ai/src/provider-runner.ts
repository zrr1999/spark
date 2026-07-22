import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";

import {
  materializeRouteModel,
  resolveSparkModelMessageIdentity,
  retagAssistantMessageStream,
  SparkModelRegistry,
  SparkRouteResolver,
} from "./index.ts";
import type {
  ProviderConfig,
  SparkActiveSelection,
  SparkProviderRegistry,
} from "./provider-registry.ts";

export type SparkProviderStreamFunction = (
  model: Model<string>,
  context: Context,
  options?: StreamOptions,
) => AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export interface ProviderRegistryRunnerOptions {
  resolveApiKey?: (provider: ProviderConfig, selection: SparkActiveSelection) => string | undefined;
}

export interface SparkWorkflowModelRunRequest {
  prompt: string;
  label: string;
  phase?: string;
  model?: string;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface SparkWorkflowModelRunResponse {
  text: string;
  structured?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * pi-ai exposes an attempt count rather than an unbounded mode. The enclosing
 * agent-loop signal is the lifetime control (and may itself have an explicit
 * deadline), so this sentinel removes the count limit while preserving
 * operator cancellation.
 */
export const SPARK_PROVIDER_TRANSPORT_MAX_RETRIES = Number.MAX_SAFE_INTEGER;
const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function createProviderRegistryStreamFunction(
  registry: SparkProviderRegistry,
  runnerOptions: ProviderRegistryRunnerOptions = {},
): SparkProviderStreamFunction {
  return (_model: Model<string>, context: Context, options?: StreamOptions) => {
    const active = registry.getActive();
    if (!active) throw new Error("No active Spark model selected");
    return createResolverBackedProviderStream(registry, active, context, options, runnerOptions);
  };
}

function createResolverBackedProviderStream(
  registry: SparkProviderRegistry,
  selection: SparkActiveSelection,
  context: Context,
  options?: StreamOptions,
  runnerOptions: ProviderRegistryRunnerOptions = {},
): AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
  const provider = registry.getProvider(selection.providerName);
  if (!provider) throw new Error(`Unknown provider: ${selection.providerName}`);
  const profile = registry.buildProfile(selection.providerName, selection.modelId);
  const resolver = new SparkRouteResolver(new SparkModelRegistry([profile]));
  const decision = resolver.resolve({
    sparkModelId: profile.id,
    ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  });
  const model = materializeRouteModel(profile, decision.route);
  const streamOptions = withPiAiOpenAiResponsesPromptCacheBridge(
    model.api,
    withOpenAiCompatiblePromptCacheKey(
      withProviderTransportRetries(
        withResolvedApiKey(options, runnerOptions.resolveApiKey?.(provider, selection)),
      ),
    ),
  );
  const stream = normalizeProviderStream(
    provider.streamSimple(model as Model<ProviderConfig["api"]>, context, streamOptions),
    selection.providerName,
  );
  return retagAssistantMessageStream(stream, resolveSparkModelMessageIdentity(profile));
}

function withProviderTransportRetries(
  options: StreamOptions | undefined,
): StreamOptions | undefined {
  // Only install count-unbounded retries when a caller supplies cancellation.
  // Workflow/model calls without a signal retain their provider defaults rather
  // than becoming impossible to stop.
  if (!options?.signal || options.maxRetries !== undefined) return options;
  return { ...options, maxRetries: SPARK_PROVIDER_TRANSPORT_MAX_RETRIES } as StreamOptions;
}

export function createProviderRegistryWorkflowModelRunner(
  registry: SparkProviderRegistry,
  runnerOptions: ProviderRegistryRunnerOptions = {},
): (request: SparkWorkflowModelRunRequest) => Promise<SparkWorkflowModelRunResponse> {
  return async (request) => {
    const selection = resolveWorkflowModelSelection(registry, request.model);
    const context: Context = {
      systemPrompt: [
        "You are a read-only Spark workflow model agent.",
        "Answer the workflow prompt directly. Do not call tools or modify repository state.",
      ].join("\n"),
      messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
      tools: [],
    };
    const stream = createResolverBackedProviderStream(
      registry,
      selection,
      context,
      {
        maxTokens: positiveInteger(request.maxTokens) ?? 4096,
      },
      runnerOptions,
    );
    const message = await stream.result();
    return {
      text: assistantMessageToText(message),
      metadata: {
        provider: selection.providerName,
        model: selection.modelId,
        providerName: selection.providerName,
        modelId: selection.modelId,
        label: request.label,
        ...(request.phase !== undefined ? { phase: request.phase } : {}),
        ...(request.metadata !== undefined ? { requestMetadata: request.metadata } : {}),
      },
    };
  };
}

export function resolveWorkflowModelSelection(
  registry: SparkProviderRegistry,
  model: string | undefined,
): { providerName: string; modelId: string } {
  if (!model) {
    const active = registry.getActive();
    if (active) return active;
    const provider = registry.listProviders()[0];
    const firstModel = provider?.models[0];
    if (!provider || !firstModel) throw new Error("No Spark provider/model is registered yet.");
    return { providerName: provider.name, modelId: firstModel.id };
  }
  const slash = model.indexOf("/");
  if (slash > 0) return { providerName: model.slice(0, slash), modelId: model.slice(slash + 1) };
  const active = registry.getActive();
  if (active && registry.listModelsFor(active.providerName).some((item) => item.id === model)) {
    return { providerName: active.providerName, modelId: model };
  }
  const matches = registry
    .listProviders()
    .filter((provider) => provider.models.some((candidate) => candidate.id === model));
  if (matches.length === 1) return { providerName: matches[0]!.name, modelId: model };
  if (matches.length > 1) {
    throw new Error(`Ambiguous Spark workflow model "${model}"; use provider/model.`);
  }
  throw new Error(`Unknown workflow model: ${model}`);
}

export function openAiCompatiblePromptCachePayload(options: StreamOptions | undefined): {
  prompt_cache_key?: string;
} {
  const key = promptCacheKeyFromOptions(options);
  return key ? { prompt_cache_key: key } : {};
}

export function withOpenAiCompatiblePromptCacheKey(
  options: StreamOptions | undefined,
): StreamOptions | undefined {
  const key = promptCacheKeyFromOptions(options);
  if (!key) return options;
  return {
    ...(options ?? {}),
    prompt_cache_key: key,
    metadata: {
      ...((options as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {}),
      prompt_cache_key: key,
    },
  } as StreamOptions;
}

/**
 * pi-ai 0.80.x does not read Spark's explicit prompt-cache option. Bridge it at
 * the payload boundary without overloading `sessionId`, which also controls
 * provider affinity headers. Keep a caller-supplied session id as the stronger
 * affinity signal, and never leak this workaround to other APIs.
 */
function withPiAiOpenAiResponsesPromptCacheBridge(
  transportApi: ProviderConfig["api"],
  options: StreamOptions | undefined,
): StreamOptions | undefined {
  if (
    transportApi !== "openai-responses" ||
    options?.sessionId !== undefined ||
    options?.cacheRetention === "none"
  ) {
    return options;
  }
  const key = clampOpenAiPromptCacheKey(promptCacheKeyFromOptions(options));
  if (!key) return options;
  const onPayload = options?.onPayload;
  return {
    ...(options ?? {}),
    onPayload: async (payload, model) => {
      const payloadWithKey = isRecord(payload) ? { ...payload, prompt_cache_key: key } : payload;
      const replacement = await onPayload?.(payloadWithKey, model);
      return replacement ?? payloadWithKey;
    },
  } as StreamOptions;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function promptCacheKeyFromOptions(options: StreamOptions | undefined): string | undefined {
  const direct = (options as { prompt_cache_key?: unknown; promptCacheKey?: unknown } | undefined)
    ?.prompt_cache_key;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const camel = (options as { prompt_cache_key?: unknown; promptCacheKey?: unknown } | undefined)
    ?.promptCacheKey;
  if (typeof camel === "string" && camel.trim()) return camel.trim();
  const metadata = (options as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  const metadataKey = metadata?.prompt_cache_key;
  return typeof metadataKey === "string" && metadataKey.trim() ? metadataKey.trim() : undefined;
}

function clampOpenAiPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const chars = Array.from(key);
  return chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH
    ? key
    : chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

function withResolvedApiKey(
  options: StreamOptions | undefined,
  apiKey: string | undefined,
): StreamOptions | undefined {
  if (apiKey === undefined || (options as { apiKey?: unknown } | undefined)?.apiKey !== undefined) {
    return options;
  }
  return { ...options, apiKey } as StreamOptions;
}

export function normalizeProviderStream(
  stream: unknown,
  providerName: string,
): AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
  if (!isAsyncIterable<AssistantMessageEvent>(stream)) {
    throw new Error(`Provider "${providerName}" returned a non-async-iterable stream`);
  }
  const maybeResult = (stream as { result?: unknown }).result;
  if (typeof maybeResult === "function") {
    return stream as AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> };
  }
  let final: AssistantMessage | undefined;
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) {
        if (event.type === "done") final = event.message;
        if (event.type === "error") final = event.error;
        yield event;
      }
    },
    async result() {
      if (final) return final;
      for await (const event of stream) {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
      }
      throw new Error(`Provider "${providerName}" stream ended without a final assistant message`);
    },
  };
}

export function assistantMessageToText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  return message.content.map(contentToText).filter(Boolean).join("\n");
}

function contentToText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const part = content as Partial<TextContent | ThinkingContent | ToolCall>;
  if (part.type === "text" && typeof part.text === "string") return part.text;
  if (part.type === "thinking" && typeof part.thinking === "string") return part.thinking;
  if (part.type === "toolCall" && part.arguments) return JSON.stringify(part.arguments);
  return "";
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}
