import {
  type AnthropicEffort,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
  streamAnthropic,
  streamSimpleOpenAIResponses,
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
  "claude-fable-5": "Fable 5",
  "gpt-5.5": "gpt-5.5-coding-plan",
  "gpt-5.5-coding-plan": "gpt-5.5-coding-plan",
};
const BAIDU_ONEAPI_OPENAI_RESPONSES_MODEL_IDS = new Set(["gpt-5.5", "gpt-5.5-coding-plan"]);

type BaiduOneApiTransportApi = "anthropic-messages" | "openai-responses";
type BaiduOneApiStream = AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

const GPT_5_5_COST = { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 };
const GPT_5_5_THINKING_LEVEL_MAP = { minimal: "low", xhigh: "xhigh" };
const CLAUDE_FABLE_5_COST = { input: 1.1, output: 5.5, cacheRead: 0.11, cacheWrite: 1.375 };
const CLAUDE_OPUS_4_6_COST = {
  input: 5.5,
  output: 27.5,
  cacheRead: 0.55,
  cacheWrite: 6.875,
};

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

function retagBaiduOneApiMessage(message: AssistantMessage): AssistantMessage {
  return { ...message, api: BAIDU_ONEAPI_API, provider: BAIDU_ONEAPI_PROVIDER };
}

function retagBaiduOneApiEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  if (event.type === "done") return { ...event, message: retagBaiduOneApiMessage(event.message) };
  if (event.type === "error") return { ...event, error: retagBaiduOneApiMessage(event.error) };
  return { ...event, partial: retagBaiduOneApiMessage(event.partial) };
}

function retagBaiduOneApiStream(stream: BaiduOneApiStream): BaiduOneApiStream {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) yield retagBaiduOneApiEvent(event);
    },
    async result() {
      return retagBaiduOneApiMessage(await stream.result());
    },
  };
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

  return retagBaiduOneApiStream(
    streamAnthropic(transportModel, context, {
      ...options,
      ...(apiKey !== undefined ? { apiKey } : {}),
      thinkingEnabled: options?.reasoning !== undefined,
      ...(effort !== undefined ? { effort } : {}),
      async onPayload(payload) {
        const remapped = remapBaiduOneApiPayload(payload, gatewayModel, effort);
        return (await options?.onPayload?.(remapped, model)) ?? remapped;
      },
    }),
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

  return retagBaiduOneApiStream(
    streamSimpleOpenAIResponses(transportModel, context, {
      ...options,
      ...(apiKey !== undefined ? { apiKey } : {}),
      async onPayload(payload) {
        const remapped = remapOpenAIResponsesModel(payload, gatewayModel);
        return (await options?.onPayload?.(remapped, model)) ?? remapped;
      },
    }),
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
        id: "gpt-5.5",
        aliases: ["gpt-5.5-coding-plan"],
        name: "GPT-5.5",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? BAIDU_ONEAPI_OPENAI_BASE_URL,
        transportApi: "openai-responses",
        transportModelId: "gpt-5.5-coding-plan",
        reasoning: true,
        thinkingLevelMap: GPT_5_5_THINKING_LEVEL_MAP,
        input: ["text", "image"],
        cost: GPT_5_5_COST,
        contextWindow: 258000,
        maxTokens: 32768,
      },
    ],
  });
}
