import * as piAi from "@earendil-works/pi-ai";
import type {
  AnthropicEffort,
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type { ProviderRegistrationAPI } from "./provider-registry.ts";

const BAIDU_ONEAPI_PROVIDER = "baidu-oneapi";
const BAIDU_ONEAPI_API = "baidu-oneapi";
const BAIDU_ONEAPI_BASE_URL = "https://oneapi-comate.baidu-int.com";
const BAIDU_ONEAPI_OPENAI_BASE_URL = `${BAIDU_ONEAPI_BASE_URL}/v1`;

const GATEWAY_MODEL_BY_ID: Record<string, string> = {
  "claude-opus-4.6": "Claude Opus 4.6",
  "claude-opus-4.7": "Claude Opus 4.7",
  "claude-opus-4.8": "Opus 4.8 Coding Plan",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-fable-5": "Fable 5",
  "gpt-5.6-luna": "gpt-5.6-luna",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5.6-terra": "gpt-5.6-terra",
};
const BAIDU_ONEAPI_OPENAI_RESPONSES_MODEL_IDS = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

type BaiduOneApiTransportApi = "anthropic-messages" | "openai-responses";
export type BaiduOneApiStream = AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};
type BaiduOneApiTransportStreams = {
  stream(model: Model<Api>, context: Context, options?: unknown): BaiduOneApiStream;
  streamSimple(model: Model<Api>, context: Context, options?: unknown): BaiduOneApiStream;
};
type PiAiRuntimeApi = typeof piAi & {
  lazyApi?: (load: () => Promise<BaiduOneApiTransportStreams>) => BaiduOneApiTransportStreams;
  anthropicMessagesApi?: () => BaiduOneApiTransportStreams;
  openAIResponsesApi?: () => BaiduOneApiTransportStreams;
};

const piAiRuntime = piAi as PiAiRuntimeApi;
const baiduOneApiAnthropicMessagesApi =
  piAiRuntime.anthropicMessagesApi?.() ??
  lazyBaiduOneApiApi(() =>
    import("@earendil-works/pi-ai/api/anthropic-messages").then(asTransportStreams),
  );
const baiduOneApiOpenAIResponsesApi =
  piAiRuntime.openAIResponsesApi?.() ??
  lazyBaiduOneApiApi(() =>
    import("@earendil-works/pi-ai/api/openai-responses").then(asTransportStreams),
  );

const GPT_5_6_LUNA_COST = { input: 0.1, output: 0.6, cacheRead: 0.01, cacheWrite: 0.125 };
const GPT_5_6_TERRA_COST = { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.3125 };
const GPT_5_6_SOL_COST = { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 };
const GPT_THINKING_LEVEL_MAP = { minimal: "low", xhigh: "xhigh" };
const CLAUDE_FABLE_5_COST = { input: 1.1, output: 5.5, cacheRead: 0.11, cacheWrite: 1.375 };
const CLAUDE_SONNET_5_COST = { input: 1.1, output: 5.5, cacheRead: 0.11, cacheWrite: 1.375 };
const CLAUDE_OPUS_4_6_COST = {
  input: 5.5,
  output: 27.5,
  cacheRead: 0.55,
  cacheWrite: 6.875,
};

function asTransportStreams(module: unknown): BaiduOneApiTransportStreams {
  return module as BaiduOneApiTransportStreams;
}

function lazyBaiduOneApiApi(
  load: () => Promise<BaiduOneApiTransportStreams>,
): BaiduOneApiTransportStreams {
  if (typeof piAiRuntime.lazyApi === "function") return piAiRuntime.lazyApi(load);

  return {
    stream: (model, context, options) =>
      lazyBaiduOneApiStream(model, async () => (await load()).stream(model, context, options)),
    streamSimple: (model, context, options) =>
      lazyBaiduOneApiStream(model, async () =>
        (await load()).streamSimple(model, context, options),
      ),
  };
}

function lazyBaiduOneApiStream(
  model: Model<Api>,
  setup: () => Promise<BaiduOneApiStream>,
): BaiduOneApiStream {
  const stream = piAi.createAssistantMessageEventStream();
  setup()
    .then(async (inner) => {
      for await (const event of inner) stream.push(event);
      stream.end();
    })
    .catch((error: unknown) => {
      stream.push({ type: "error", reason: "error", error: createSetupErrorMessage(model, error) });
    });
  return stream;
}

function createSetupErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function mapThinkingEffort(
  model: Model<Api>,
  reasoning: SimpleStreamOptions["reasoning"],
): AnthropicEffort | undefined {
  const mapped = reasoning ? model.thinkingLevelMap?.[reasoning] : undefined;
  if (typeof mapped === "string") return mapped as AnthropicEffort;
  if (mapped === null) return undefined;
  switch (reasoning) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withBaiduOneApiTransportApi<TApi extends BaiduOneApiTransportApi>(
  model: Model<Api>,
  api: TApi,
): Model<TApi> {
  return { ...model, api } as Model<TApi>;
}

const BAIDU_CONTEXT_OVERFLOW_SEMANTIC = "context_length_exceeded";
const BAIDU_CONTEXT_OVERFLOW_PATTERNS = [
  /\bcontext (?:window|length) (?:is )?(?:full|exceeded)\b/iu,
  /\bmaximum context (?:window|length)(?: size)?(?: is| has been)? exceeded\b/iu,
  /\bprompt (?:is )?too long for (?:the )?context window\b/iu,
  /\bcontext[_ -]length[_ -]exceeded\b/iu,
] as const;

function isBaiduContextOverflowMessage(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || typeof message.errorMessage !== "string") return false;
  return BAIDU_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message.errorMessage!));
}

export function normalizeBaiduOneApiMessage(message: AssistantMessage): AssistantMessage {
  const errorMessage =
    isBaiduContextOverflowMessage(message) &&
    !message.errorMessage?.includes(BAIDU_CONTEXT_OVERFLOW_SEMANTIC)
      ? `${BAIDU_CONTEXT_OVERFLOW_SEMANTIC}: ${message.errorMessage}`
      : message.errorMessage;
  return {
    ...message,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    api: BAIDU_ONEAPI_API,
    provider: BAIDU_ONEAPI_PROVIDER,
  };
}

export function isNormalizedBaiduContextOverflow(message: AssistantMessage): boolean {
  return piAi.isContextOverflow(message);
}

function retagBaiduOneApiMessage(message: AssistantMessage): AssistantMessage {
  return normalizeBaiduOneApiMessage(message);
}

export function normalizeBaiduOneApiEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  if (event.type === "done")
    return { ...event, message: normalizeBaiduOneApiMessage(event.message) };
  if (event.type === "error") return { ...event, error: normalizeBaiduOneApiMessage(event.error) };
  return { ...event, partial: normalizeBaiduOneApiMessage(event.partial) };
}

function retagBaiduOneApiEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  return normalizeBaiduOneApiEvent(event);
}

export function normalizeBaiduOneApiStream(stream: BaiduOneApiStream): BaiduOneApiStream {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) yield retagBaiduOneApiEvent(event);
    },
    async result() {
      return retagBaiduOneApiMessage(await stream.result());
    },
  };
}

function startBaiduOneApiStream(
  model: Model<Api>,
  factory: () => BaiduOneApiStream,
): BaiduOneApiStream {
  try {
    return normalizeBaiduOneApiStream(factory());
  } catch (error) {
    return normalizeBaiduOneApiStream(baiduOneApiErrorStream(model, error));
  }
}

function baiduOneApiErrorStream(model: Model<Api>, error: unknown): BaiduOneApiStream {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: BAIDU_ONEAPI_API,
    provider: BAIDU_ONEAPI_PROVIDER,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
  const stream = piAi.createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "error", error: message });
  return stream;
}

export function resolveBaiduOneApiKey(apiKey: string | undefined): string | undefined {
  if (apiKey === undefined || apiKey === "BAIDU_ONEAPI_API_KEY") {
    return process.env.BAIDU_ONEAPI_API_KEY;
  }
  if (apiKey === "OPENAI_API_KEY") {
    throw new Error("baidu-oneapi does not accept OPENAI_API_KEY; use BAIDU_ONEAPI_API_KEY.");
  }
  return apiKey;
}

export function remapBaiduOneApiPayload(
  payload: unknown,
  gatewayModel: string,
  effort?: AnthropicEffort,
): unknown {
  if (!isRecord(payload)) return payload;

  const remapped: Record<string, unknown> = { ...payload, model: gatewayModel };
  const thinking = remapped.thinking;
  if (isRecord(thinking) && thinking.type === "enabled") {
    remapped.thinking = {
      type: "adaptive",
      display: typeof thinking.display === "string" ? thinking.display : "summarized",
    };
    if (effort) {
      remapped.output_config = {
        ...(isRecord(remapped.output_config) ? remapped.output_config : {}),
        effort,
      };
    }
  }

  return remapped;
}

export function streamBaiduOneApiAnthropic(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const gatewayModel = GATEWAY_MODEL_BY_ID[model.id] ?? model.id;
  const apiKey = resolveBaiduOneApiKey(options?.apiKey);
  const transportModel = withBaiduOneApiTransportApi(model, "anthropic-messages");
  const effort = mapThinkingEffort(model, options?.reasoning);

  return startBaiduOneApiStream(
    model,
    () =>
      baiduOneApiAnthropicMessagesApi.stream(transportModel, context, {
        ...options,
        ...(apiKey !== undefined ? { apiKey } : {}),
        thinkingEnabled: options?.reasoning !== undefined,
        ...(effort !== undefined ? { effort } : {}),
        async onPayload(payload: unknown) {
          const remapped = remapBaiduOneApiPayload(payload, gatewayModel, effort);
          return (await options?.onPayload?.(remapped, model)) ?? remapped;
        },
      } as Parameters<typeof baiduOneApiAnthropicMessagesApi.stream>[2]) as BaiduOneApiStream,
  );
}

export function streamBaiduOneApi(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  if (BAIDU_ONEAPI_OPENAI_RESPONSES_MODEL_IDS.has(model.id)) {
    return streamBaiduOneApiOpenAIResponses(model, context, options);
  }
  return streamBaiduOneApiAnthropic(model, context, options);
}

export function streamBaiduOneApiOpenAIResponses(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const gatewayModel = GATEWAY_MODEL_BY_ID[model.id] ?? model.id;
  const apiKey = resolveBaiduOneApiKey(options?.apiKey);
  const transportModel = withBaiduOneApiTransportApi(model, "openai-responses");

  return startBaiduOneApiStream(
    model,
    () =>
      baiduOneApiOpenAIResponsesApi.streamSimple(transportModel, context, {
        ...options,
        ...(apiKey !== undefined ? { apiKey } : {}),
        async onPayload(payload: unknown) {
          const remapped = remapOpenAIResponsesModel(payload, gatewayModel);
          return (await options?.onPayload?.(remapped, model)) ?? remapped;
        },
      }) as BaiduOneApiStream,
  );
}

function remapOpenAIResponsesModel(payload: unknown, gatewayModel: string): unknown {
  return isRecord(payload) ? { ...payload, model: gatewayModel } : payload;
}

export default function registerBaiduOneApiProvider(pi: ProviderRegistrationAPI): void {
  pi.registerProvider(BAIDU_ONEAPI_PROVIDER, {
    name: "Baidu OneAPI",
    baseUrl: process.env.BAIDU_ONEAPI_BASE_URL ?? BAIDU_ONEAPI_BASE_URL,
    apiKey: "BAIDU_ONEAPI_API_KEY",
    api: BAIDU_ONEAPI_API,
    streamSimple: streamBaiduOneApi,
    models: [
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        transportApi: "anthropic-messages",
        transportModelId: "Claude Opus 4.6",
        reasoning: true,
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "max",
        },
        input: ["text", "image"],
        cost: CLAUDE_OPUS_4_6_COST,
        contextWindow: 200000,
        maxTokens: 32000,
      },
      {
        id: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        transportApi: "anthropic-messages",
        transportModelId: "Claude Opus 4.7",
        reasoning: true,
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        input: ["text", "image"],
        cost: CLAUDE_OPUS_4_6_COST,
        contextWindow: 200000,
        maxTokens: 32000,
      },
      {
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        transportApi: "anthropic-messages",
        transportModelId: "Opus 4.8 Coding Plan",
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: "xhigh",
        },
        input: ["text", "image"],
        cost: CLAUDE_OPUS_4_6_COST,
        contextWindow: 300000,
        maxTokens: 32000,
      },
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        transportApi: "anthropic-messages",
        transportModelId: "Claude Sonnet 5",
        reasoning: true,
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        input: ["text", "image"],
        cost: CLAUDE_SONNET_5_COST,
        contextWindow: 200000,
        maxTokens: 32000,
      },
      {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        transportApi: "anthropic-messages",
        transportModelId: "Fable 5",
        reasoning: true,
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        input: ["text", "image"],
        cost: CLAUDE_FABLE_5_COST,
        contextWindow: 300000,
        maxTokens: 32000,
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? BAIDU_ONEAPI_OPENAI_BASE_URL,
        transportApi: "openai-responses",
        transportModelId: "gpt-5.6-sol",
        reasoning: true,
        thinkingLevelMap: GPT_THINKING_LEVEL_MAP,
        input: ["text", "image"],
        cost: GPT_5_6_SOL_COST,
        contextWindow: 258000,
        maxTokens: 32768,
      },
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? BAIDU_ONEAPI_OPENAI_BASE_URL,
        transportApi: "openai-responses",
        transportModelId: "gpt-5.6-luna",
        reasoning: true,
        thinkingLevelMap: GPT_THINKING_LEVEL_MAP,
        input: ["text", "image"],
        cost: GPT_5_6_LUNA_COST,
        contextWindow: 258000,
        maxTokens: 32768,
      },
      {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? BAIDU_ONEAPI_OPENAI_BASE_URL,
        transportApi: "openai-responses",
        transportModelId: "gpt-5.6-terra",
        reasoning: true,
        thinkingLevelMap: GPT_THINKING_LEVEL_MAP,
        input: ["text", "image"],
        cost: GPT_5_6_TERRA_COST,
        contextWindow: 258000,
        maxTokens: 32768,
      },
    ],
  });
}
