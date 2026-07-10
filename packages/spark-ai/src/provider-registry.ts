import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { SparkAuthRef, SparkModelProfile } from "./index.ts";

export interface ProviderModelDefinition {
  id: string;
  /** Alternate ids accepted for selection/config migration but hidden from model lists. */
  aliases?: string[];
  name: string;
  api?: Api;
  baseUrl?: string;
  transportApi?: Api;
  transportModelId?: string;
  transportBaseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderConfig {
  /** Stable provider id inside the registry. */
  name: string;
  /** Human-readable name supplied by the provider plugin. */
  label?: string;
  baseUrl: string;
  /**
   * API key sentinel. May be:
   *   - a literal value
   *   - the string name of an environment variable (e.g. "BAIDU_ONEAPI_API_KEY")
   *   - a `oauth:<provider>` reference (deferred)
   */
  apiKey?: string;
  api: Api;
  streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => unknown;
  models: ProviderModelDefinition[];
}

export interface ProviderRegistrationAPI {
  registerProvider(name: string, config: ProviderConfig): void;
}

export interface SparkActiveSelection {
  providerName: string;
  modelId: string;
}

export class SparkProviderRegistry implements ProviderRegistrationAPI {
  readonly #providers = new Map<string, ProviderConfig>();
  #active: SparkActiveSelection | undefined;

  registerProvider(name: string, config: ProviderConfig): void {
    if (!name) throw new Error("SparkProviderRegistry.registerProvider requires a provider name");
    if (typeof config?.streamSimple !== "function") {
      throw new Error(
        `Provider plugin "${name}" must expose a streamSimple function (Model, Context, options) => stream`,
      );
    }
    if (!Array.isArray(config.models) || config.models.length === 0) {
      throw new Error(`Provider plugin "${name}" must declare at least one model`);
    }
    this.#providers.set(name, { ...config, name, label: config.label ?? config.name });
  }

  hasProvider(name: string): boolean {
    return this.#providers.has(name);
  }

  getProvider(name: string): ProviderConfig | undefined {
    return this.#providers.get(name);
  }

  listProviders(): ProviderConfig[] {
    return [...this.#providers.values()];
  }

  listModelsFor(name: string): ProviderModelDefinition[] {
    return this.#providers.get(name)?.models ?? [];
  }

  setActive(selection: SparkActiveSelection): void {
    const { def } = this.#requireProviderModel(selection.providerName, selection.modelId);
    this.#active = { providerName: selection.providerName, modelId: def.id };
  }

  getActive(): SparkActiveSelection | undefined {
    return this.#active ? { ...this.#active } : undefined;
  }

  buildActiveModel(): Model<Api> | undefined {
    if (!this.#active) return undefined;
    return this.buildModel(this.#active.providerName, this.#active.modelId);
  }

  buildModel(providerName: string, modelId: string): Model<Api> {
    const { provider, def } = this.#requireProviderModel(providerName, modelId);
    return {
      id: def.id,
      name: def.name,
      api: def.api ?? provider.api,
      provider: providerName,
      baseUrl: def.baseUrl ?? provider.baseUrl,
      reasoning: def.reasoning,
      input: [...def.input],
      cost: { ...def.cost },
      contextWindow: def.contextWindow,
      maxTokens: def.maxTokens,
      ...(def.thinkingLevelMap !== undefined ? { thinkingLevelMap: def.thinkingLevelMap } : {}),
    };
  }

  buildProfile(providerName: string, modelId: string): SparkModelProfile {
    const { provider, def } = this.#requireProviderModel(providerName, modelId);
    const authPoolId = `${providerName}:auth`;
    return {
      id: `${providerName}/${def.id}`,
      name: def.name,
      capabilities: {
        input: [...def.input],
        reasoning: def.reasoning,
      },
      cost: { ...def.cost },
      contextWindow: def.contextWindow,
      maxTokens: def.maxTokens,
      ...(def.thinkingLevelMap !== undefined ? { thinkingLevelMap: def.thinkingLevelMap } : {}),
      identity: {
        api: provider.api,
        provider: providerName,
        model: def.id,
      },
      routes: [
        {
          id: `${providerName}/${def.id}`,
          provider: providerName,
          priority: 0,
          transportApi: def.transportApi ?? def.api ?? provider.api,
          transportModelId: def.transportModelId ?? def.id,
          baseUrl: def.transportBaseUrl ?? def.baseUrl ?? provider.baseUrl,
          authPoolId,
        },
      ],
      authPools: [
        {
          id: authPoolId,
          slots: [
            {
              id: `${providerName}:default`,
              priority: 0,
              authRef: providerAuthRef(provider),
            },
          ],
        },
      ],
    };
  }

  #requireProviderModel(
    providerName: string,
    modelId: string,
  ): {
    provider: ProviderConfig;
    def: ProviderModelDefinition;
  } {
    const provider = this.#providers.get(providerName);
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);
    const def = provider.models.find((candidate) => modelIdMatches(candidate, modelId));
    if (!def) throw new Error(`Provider "${providerName}" has no model with id "${modelId}"`);
    return { provider, def };
  }
}

function modelIdMatches(model: ProviderModelDefinition, modelId: string): boolean {
  return model.id === modelId || (model.aliases ?? []).includes(modelId);
}

function providerAuthRef(provider: ProviderConfig): SparkAuthRef {
  const ref = provider.apiKey ?? provider.name;
  if (/^[A-Z0-9_]+$/u.test(ref)) return { kind: "env", name: ref };
  return { kind: "provider", id: `${provider.name}:auth` };
}
