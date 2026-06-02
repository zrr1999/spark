import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type AnthropicEffort, streamAnthropic } from "@earendil-works/pi-ai/anthropic";

const BAIDU_ONEAPI_PROVIDER = "baidu-oneapi";
const BAIDU_ONEAPI_BASE_URL = "https://oneapi-comate.baidu-int.com";

const GATEWAY_MODEL_BY_ID: Record<string, string> = {
  "claude-opus-4.6": "Claude Opus 4.6",
  "claude-opus-4.7": "Claude Opus 4.7",
  "claude-opus-4.8": "Claude Opus 4.8",
};

export interface ProviderRegistrationAPI {
  registerProvider(name: string, config: unknown): void;
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

  return streamAnthropic(model as Model<"anthropic-messages">, context, {
    ...options,
    apiKey,
    thinkingEnabled: options?.reasoning !== undefined,
    effort: mapThinkingEffort(model, options?.reasoning),
    async onPayload(payload, payloadModel) {
      const remapped = remapBaiduOneApiPayload(
        payload,
        gatewayModel,
        mapThinkingEffort(model, options?.reasoning),
      );
      return (await options?.onPayload?.(remapped, payloadModel)) ?? remapped;
    },
  });
}

export default function registerBaiduOneApiProvider(pi: ProviderRegistrationAPI): void {
  pi.registerProvider(BAIDU_ONEAPI_PROVIDER, {
    name: "Baidu OneAPI",
    baseUrl: process.env.BAIDU_ONEAPI_BASE_URL ?? BAIDU_ONEAPI_BASE_URL,
    apiKey: "BAIDU_ONEAPI_API_KEY",
    api: "anthropic-messages",
    streamSimple: streamBaiduOneApiAnthropic,
    models: [
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6 (Baidu OneAPI)",
        reasoning: true,
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "max",
        },
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
      {
        id: "claude-opus-4.7",
        name: "Claude Opus 4.7 (Baidu OneAPI)",
        reasoning: true,
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
      {
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8 (Baidu OneAPI)",
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: "xhigh",
        },
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
    ],
  });
}
