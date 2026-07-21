import type { Api, Model, Provider } from "@earendil-works/pi-ai";

import type {
  ProviderConfig,
  ProviderModelDefinition,
  ProviderRegistrationAPI,
} from "./provider-registry.ts";

export interface SparkProviderAdapterOptions<TApi extends Api> {
  authRef: string;
  api?: TApi;
  baseUrl?: string;
}

/** Adapt a pi-ai provider without transferring auth or selection ownership. */
export function registerSparkAiProvider<TApi extends Api>(
  api: ProviderRegistrationAPI,
  provider: Provider<TApi>,
  options: SparkProviderAdapterOptions<TApi>,
): void {
  api.registerProvider(provider.id, piAiProviderConfig(provider, options));
}

export function piAiProviderConfig<TApi extends Api>(
  provider: Provider<TApi>,
  options: SparkProviderAdapterOptions<TApi>,
): ProviderConfig {
  const models = [...provider.getModels()];
  const defaultApi = options.api ?? models[0]?.api;
  if (!defaultApi) throw new Error(`pi-ai provider "${provider.id}" has no model API`);
  return {
    name: provider.name,
    baseUrl: options.baseUrl ?? provider.baseUrl ?? models[0]?.baseUrl ?? "",
    apiKey: options.authRef,
    api: defaultApi,
    streamSimple: (model, context, streamOptions) =>
      provider.streamSimple(model as Model<TApi>, context, streamOptions),
    models: models.map(toSparkModelDefinition),
  };
}

function toSparkModelDefinition<TApi extends Api>(model: Model<TApi>): ProviderModelDefinition {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap !== undefined ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: [...model.input],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}
