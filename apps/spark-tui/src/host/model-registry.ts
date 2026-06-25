import type {
  ProviderConfig,
  ProviderModelDefinition,
  SparkProviderRegistry,
} from "./provider-registry.ts";

export interface SparkHostRegistryModel {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
}

export interface SparkHostModelRegistryLike {
  getAvailable(): SparkHostRegistryModel[] | Promise<SparkHostRegistryModel[]>;
  getAll(): SparkHostRegistryModel[];
  hasConfiguredAuth(model: SparkHostRegistryModel): boolean;
  getError?(): string | undefined;
}

export interface SparkHostModelAuthResolver {
  hasConfiguredAuth(provider: ProviderConfig): boolean;
}

export interface SparkHostModelRegistryOptions {
  env?: NodeJS.ProcessEnv;
  authResolver?: SparkHostModelAuthResolver;
  getError?: () => string | undefined;
}

export class SparkHostModelRegistry implements SparkHostModelRegistryLike {
  readonly #registry: SparkProviderRegistry;
  readonly #env: NodeJS.ProcessEnv;
  readonly #authResolver: SparkHostModelAuthResolver | undefined;
  readonly #getError: (() => string | undefined) | undefined;

  constructor(registry: SparkProviderRegistry, options: SparkHostModelRegistryOptions = {}) {
    this.#registry = registry;
    this.#env = options.env ?? process.env;
    this.#authResolver = options.authResolver;
    this.#getError = options.getError;
  }

  getAvailable(): SparkHostRegistryModel[] {
    return this.getAll().filter((model) => this.hasConfiguredAuth(model));
  }

  getAll(): SparkHostRegistryModel[] {
    return this.#registry
      .listProviders()
      .flatMap((provider) => provider.models.map((model) => toRegistryModel(provider.name, model)));
  }

  hasConfiguredAuth(model: SparkHostRegistryModel): boolean {
    const provider = this.#registry.getProvider(model.provider);
    if (!provider) return false;
    return (
      this.#authResolver?.hasConfiguredAuth(provider) ??
      isProviderAuthConfigured(provider, this.#env)
    );
  }

  getError(): string | undefined {
    return this.#getError?.();
  }
}

function toRegistryModel(
  providerName: string,
  model: ProviderModelDefinition,
): SparkHostRegistryModel {
  return {
    provider: providerName,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: [...model.input],
  };
}

function isProviderAuthConfigured(provider: ProviderConfig, env: NodeJS.ProcessEnv): boolean {
  const authRef = provider.apiKey;
  if (authRef === undefined || authRef.length === 0) return true;
  if (authRef.startsWith("oauth:")) return false;
  if (/^[A-Z0-9_]+$/u.test(authRef)) return Boolean(env[authRef]);
  return true;
}
