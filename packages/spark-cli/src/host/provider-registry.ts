/**
 * SparkProviderRegistry — host-side registry for `pi.registerProvider(...)` style
 * provider plugins.
 *
 * Background: pi-ai exposes `registerApiProvider({api, stream, streamSimple})`
 * for installing a custom *API* family, but Spark/baidu-oneapi-style
 * **provider plugins** want a higher-level surface that bundles
 * `{name, baseUrl, apiKey-source, api, streamSimple, models[]}` per provider.
 * That higher-level surface is owned here, by SparkProviderRegistry, and is
 * consumed from `packages/spark-cli/src/baidu-oneapi-provider.ts` (as the
 * canonical example) plus any future user-supplied provider plugins listed
 * in `~/.spark/config.json#providers[]`.
 *
 * Design rules:
 *   - Provider *plugins* speak `ProviderRegistrationAPI`, NOT `ExtensionAPI`.
 *     Plugins are loaded via the same import-default mechanism as extensions
 *     but receive a different surface, keeping ExtensionAPI clean for the
 *     dual-host (pi-coding-agent / spark-cli) contract.
 *   - The registry caches `ProviderConfig` records; selecting an active
 *     provider/model is the host's job. `setActive(...)` validates that the
 *     requested provider/model exists.
 *   - `buildModel(providerName, modelId)` materializes a `Model<Api>`
 *     compatible with pi-ai's stream functions, so the SparkAgentLoop can
 *     consume it without knowing about ProviderConfig at all.
 */

import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export interface ProviderModelDefinition {
  id: string;
  name: string;
  api?: Api;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderConfig {
  name: string;
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

/**
 * Provider-plugin entry point shape. baidu-oneapi-provider.ts already exports
 * `default function registerBaiduOneApiProvider(pi: ProviderRegistrationAPI)`.
 * Future provider plugins follow the same convention.
 */
export interface ProviderRegistrationAPI {
  registerProvider(name: string, config: ProviderConfig): void;
}

export interface SparkActiveSelection {
  providerName: string;
  modelId: string;
}

export class SparkProviderRegistry implements ProviderRegistrationAPI {
  private readonly providers = new Map<string, ProviderConfig>();
  private active: SparkActiveSelection | undefined;

  registerProvider(name: string, config: ProviderConfig): void {
    if (!name) throw new Error("SparkProviderRegistry.registerProvider requires a provider name");
    if (!config?.streamSimple) {
      throw new Error(
        `Provider plugin "${name}" must expose a streamSimple function (Model, Context, options) => stream`,
      );
    }
    if (!Array.isArray(config.models) || config.models.length === 0) {
      throw new Error(`Provider plugin "${name}" must declare at least one model`);
    }
    this.providers.set(name, { ...config, name });
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  getProvider(name: string): ProviderConfig | undefined {
    return this.providers.get(name);
  }

  listProviders(): ProviderConfig[] {
    return [...this.providers.values()];
  }

  listModelsFor(name: string): ProviderModelDefinition[] {
    return this.providers.get(name)?.models ?? [];
  }

  /**
   * Select the active provider/model. Throws when the provider or model is
   * unknown so callers can surface the error in the TUI without silently
   * picking the wrong target.
   */
  setActive(selection: SparkActiveSelection): void {
    const provider = this.providers.get(selection.providerName);
    if (!provider) {
      throw new Error(`Unknown provider: ${selection.providerName}`);
    }
    const model = provider.models.find((m) => m.id === selection.modelId);
    if (!model) {
      throw new Error(
        `Provider "${selection.providerName}" has no model with id "${selection.modelId}"`,
      );
    }
    this.active = { ...selection };
  }

  getActive(): SparkActiveSelection | undefined {
    return this.active ? { ...this.active } : undefined;
  }

  /** Produce a pi-ai `Model<Api>` for the active selection, if any. */
  buildActiveModel(): Model<Api> | undefined {
    if (!this.active) return undefined;
    return this.buildModel(this.active.providerName, this.active.modelId);
  }

  buildModel(providerName: string, modelId: string): Model<Api> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerName}`);
    }
    const def = provider.models.find((m) => m.id === modelId);
    if (!def) {
      throw new Error(`Provider "${providerName}" has no model with id "${modelId}"`);
    }
    return {
      id: def.id,
      name: def.name,
      api: def.api ?? provider.api,
      provider: providerName,
      baseUrl: def.baseUrl ?? provider.baseUrl,
      reasoning: def.reasoning,
      thinkingLevelMap: def.thinkingLevelMap,
      input: def.input,
      cost: def.cost,
      contextWindow: def.contextWindow,
      maxTokens: def.maxTokens,
    } as Model<Api>;
  }
}
