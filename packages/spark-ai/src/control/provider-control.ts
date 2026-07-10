import { resolve } from "node:path";

import type { OAuthProviderInterface } from "@earendil-works/pi-ai/oauth";

import {
  SparkProviderRegistry,
  type ProviderConfig,
  type ProviderModelDefinition,
  type SparkActiveSelection,
} from "../provider-registry.ts";
import {
  SparkAuthStore,
  SparkProviderAuthResolver,
  defaultSparkAuthPath,
  listOAuthProviderSummaries,
  normalizeProviderAuthRef,
  type SparkAuthStoreOptions,
  type SparkProviderAuthStatus,
} from "./auth.ts";
import { SparkOAuthFlowBroker, type SparkOAuthFlowSnapshot } from "./oauth-flow.ts";
import {
  defaultSparkProviderConfigPath,
  loadSparkProviderCatalog,
  readSparkProviderConfig,
  writeSparkDefaultModel,
  type SparkProviderImporter,
  type SparkProviderLoadOutcome,
} from "./provider-catalog.ts";

export interface CreateSparkProviderControlOptions {
  sparkHome?: string;
  authPath?: string;
  configPath?: string;
  providerSpecs?: readonly string[];
  importer?: SparkProviderImporter;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  completedOAuthFlowTtlMs?: number;
  authStore?: SparkAuthStore;
}

export type SparkProviderCredentialSource =
  | "none"
  | "environment"
  | "literal"
  | "stored_api_key"
  | "oauth"
  | "missing";

export interface SparkProviderControlAuthSnapshot extends SparkProviderAuthStatus {
  source: SparkProviderCredentialSource;
  oauthProviderId?: string;
  apiKeySupported: boolean;
}

export interface SparkProviderControlProviderSnapshot {
  id: string;
  name: string;
  auth: SparkProviderControlAuthSnapshot;
  modelCount: number;
}

export interface SparkProviderControlModelSnapshot {
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  active: boolean;
  available: boolean;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
}

export interface SparkProviderControlSnapshot {
  activeModelId?: string;
  configuredModelId?: string;
  configError?: string;
  providers: SparkProviderControlProviderSnapshot[];
  models: SparkProviderControlModelSnapshot[];
  oauthProviders: Array<{ id: string; name: string; configured: boolean }>;
  loadOutcomes: SparkProviderLoadOutcome[];
}

export interface SparkProviderControl {
  snapshot(): Promise<SparkProviderControlSnapshot>;
  setDefaultModel(modelRef: string): Promise<void>;
  setApiKey(providerId: string, apiKey: string): Promise<void>;
  logout(providerId: string): Promise<boolean>;
  startOAuth(providerId: string): Promise<SparkOAuthFlowSnapshot>;
  oauthStatus(flowId: string): SparkOAuthFlowSnapshot | undefined;
  respondOAuth(flowId: string, promptId: string, value: string): SparkOAuthFlowSnapshot;
  cancelOAuth(flowId: string): SparkOAuthFlowSnapshot;
  resolveApiKey(provider: ProviderConfig): string | undefined;
  resolveApiKeyAsync(provider: ProviderConfig): Promise<string | undefined>;
  /** Refresh/validate credentials for the selected model before starting a turn. */
  prepareModel(modelRef: string): Promise<void>;
}

interface LoadedControlState {
  registry: SparkProviderRegistry;
  config: Awaited<ReturnType<typeof readSparkProviderConfig>>;
  outcomes: SparkProviderLoadOutcome[];
}

export function createSparkProviderControl(
  options: CreateSparkProviderControlOptions = {},
): SparkProviderControl {
  return new LocalSparkProviderControl(options);
}

class LocalSparkProviderControl implements SparkProviderControl {
  readonly #authStore: SparkAuthStore;
  readonly #authResolver: SparkProviderAuthResolver;
  readonly #oauthFlows: SparkOAuthFlowBroker;
  readonly #configPath: string;
  readonly #providerSpecs: readonly string[] | undefined;
  readonly #importer: SparkProviderImporter | undefined;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: CreateSparkProviderControlOptions) {
    const authOptions: SparkAuthStoreOptions = {
      path: options.authPath ?? defaultSparkAuthPath(options.sparkHome),
      ...(options.now ? { now: options.now } : {}),
    };
    this.#authStore = options.authStore ?? new SparkAuthStore(authOptions);
    this.#env = options.env ?? process.env;
    this.#authResolver = new SparkProviderAuthResolver(this.#authStore, {
      env: this.#env,
      ...(options.now ? { now: () => options.now!().getTime() } : {}),
    });
    this.#oauthFlows = new SparkOAuthFlowBroker({
      store: this.#authStore,
      ...(options.now ? { now: options.now } : {}),
      ...(options.completedOAuthFlowTtlMs !== undefined
        ? { completedFlowTtlMs: options.completedOAuthFlowTtlMs }
        : {}),
    });
    this.#configPath = resolve(
      options.configPath ?? defaultSparkProviderConfigPath(options.sparkHome),
    );
    this.#providerSpecs = options.providerSpecs;
    this.#importer = options.importer;
  }

  async snapshot(): Promise<SparkProviderControlSnapshot> {
    const state = await this.#loadState();
    await this.#reloadAuth();
    const active = resolveEffectiveSelection(state.registry, state.config.activeModelId);
    const activeModelId = active ? selectionValue(active) : undefined;
    const providers = state.registry.listProviders().map((provider) => {
      const auth = this.#authSnapshot(provider);
      return {
        id: provider.name,
        name: provider.label ?? provider.name,
        auth,
        modelCount: provider.models.length,
      };
    });
    const providerAuth = new Map(providers.map((provider) => [provider.id, provider.auth]));
    const models = state.registry
      .listProviders()
      .flatMap((provider) =>
        provider.models.map((model) =>
          modelSnapshot(
            provider.name,
            model,
            activeModelId,
            providerAuth.get(provider.name)?.configured ?? false,
          ),
        ),
      );
    return {
      ...(activeModelId ? { activeModelId } : {}),
      ...(state.config.activeModelId ? { configuredModelId: state.config.activeModelId } : {}),
      ...(state.config.loadError ? { configError: state.config.loadError } : {}),
      providers,
      models,
      oauthProviders: listOAuthProviderSummaries().map((provider) => ({
        ...provider,
        configured: this.#authStore.has(provider.id),
      })),
      loadOutcomes: state.outcomes.map((outcome) => ({ ...outcome })),
    };
  }

  async setDefaultModel(modelRef: string): Promise<void> {
    const state = await this.#loadState();
    const selection = resolveModelSelection(state.registry, modelRef);
    await writeSparkDefaultModel(this.#configPath, selectionValue(selection));
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    const provider = await this.#requireProvider(providerId);
    if (normalizeProviderAuthRef(provider.apiKey).kind === "oauth") {
      throw new Error(`Spark provider "${provider.name}" uses OAuth login`);
    }
    const value = apiKey.trim();
    if (!value) throw new Error("Spark provider API key must be non-empty");
    await this.#authStore.setApiKey(provider.name, value);
  }

  async logout(providerId: string): Promise<boolean> {
    const state = await this.#loadState();
    const provider = state.registry.getProvider(providerId);
    if (!provider) return this.#authStore.remove(providerId);
    const ref = normalizeProviderAuthRef(provider.apiKey);
    const targets = [provider.name];
    if (ref.kind === "oauth") targets.push(ref.provider);
    if (ref.kind === "env") targets.push(ref.name);
    return (await this.#authStore.removeMany(targets)).length > 0;
  }

  async startOAuth(providerId: string): Promise<SparkOAuthFlowSnapshot> {
    const resolvedProviderId = await this.#resolveOAuthProviderId(providerId);
    return this.#oauthFlows.start(resolvedProviderId);
  }

  oauthStatus(flowId: string): SparkOAuthFlowSnapshot | undefined {
    return this.#oauthFlows.status(flowId);
  }

  respondOAuth(flowId: string, promptId: string, value: string): SparkOAuthFlowSnapshot {
    return this.#oauthFlows.respond(flowId, promptId, value);
  }

  cancelOAuth(flowId: string): SparkOAuthFlowSnapshot {
    return this.#oauthFlows.cancel(flowId);
  }

  resolveApiKey(provider: ProviderConfig): string | undefined {
    return this.#authResolver.resolveApiKey(provider);
  }

  resolveApiKeyAsync(provider: ProviderConfig): Promise<string | undefined> {
    return this.#authResolver.resolveApiKeyAsync(provider);
  }

  async prepareModel(modelRef: string): Promise<void> {
    const state = await this.#loadState();
    const selection = resolveModelSelection(state.registry, modelRef);
    const provider = state.registry.getProvider(selection.providerName)!;
    const status = this.#authResolver.status(provider);
    if (status.kind === "none") return;
    const apiKey = await this.#authResolver.resolveApiKeyAsync(provider);
    if (!apiKey) {
      const ref = status.ref ? ` (${status.ref})` : "";
      throw new Error(`No authentication configured for Spark provider "${provider.name}"${ref}`);
    }
  }

  async #loadState(): Promise<LoadedControlState> {
    const config = await readSparkProviderConfig(this.#configPath);
    const loaded = await loadSparkProviderCatalog({
      specifiers: this.#providerSpecs ?? config.providerSpecs,
      ...(this.#importer ? { importer: this.#importer } : {}),
    });
    return { registry: loaded.registry, config, outcomes: loaded.outcomes };
  }

  async #reloadAuth(): Promise<void> {
    await this.#authStore.reload();
    if (this.#authStore.loadError) throw this.#authStore.loadError;
  }

  async #requireProvider(providerId: string): Promise<ProviderConfig> {
    const state = await this.#loadState();
    const provider = state.registry.getProvider(providerId);
    if (!provider) throw new Error(`Unknown Spark provider: ${providerId}`);
    return provider;
  }

  async #resolveOAuthProviderId(providerId: string): Promise<string> {
    const state = await this.#loadState();
    const provider = state.registry.getProvider(providerId);
    const ref = provider ? normalizeProviderAuthRef(provider.apiKey) : undefined;
    const oauthProviderId = ref?.kind === "oauth" ? ref.provider : providerId;
    if (!listOAuthProviderSummaries().some((entry) => entry.id === oauthProviderId)) {
      throw new Error(`Unknown OAuth provider: ${oauthProviderId}`);
    }
    return oauthProviderId;
  }

  #authSnapshot(provider: ProviderConfig): SparkProviderControlAuthSnapshot {
    const status = this.#authResolver.status(provider);
    const ref = normalizeProviderAuthRef(provider.apiKey);
    const stored = this.#authStore.get(provider.name);
    const storedRef = ref.kind === "env" ? this.#authStore.get(ref.name) : undefined;
    let source: SparkProviderCredentialSource;
    if (stored?.type === "api_key" || storedRef?.type === "api_key") source = "stored_api_key";
    else if (!status.configured) source = "missing";
    else if (ref.kind === "oauth") source = "oauth";
    else if (ref.kind === "env") source = "environment";
    else if (ref.kind === "literal") source = "literal";
    else source = "none";
    return {
      ...status,
      source,
      ...(ref.kind === "oauth" ? { oauthProviderId: ref.provider } : {}),
      apiKeySupported: ref.kind !== "oauth" && ref.kind !== "none" && ref.kind !== "literal",
    };
  }
}

function resolveEffectiveSelection(
  registry: SparkProviderRegistry,
  configuredModelId: string | undefined,
): SparkActiveSelection | undefined {
  if (configuredModelId) {
    try {
      return resolveModelSelection(registry, configuredModelId);
    } catch {
      // A removed provider/model should not make the whole settings surface fail.
    }
  }
  const provider = registry.listProviders()[0];
  const model = provider?.models[0];
  return provider && model ? { providerName: provider.name, modelId: model.id } : undefined;
}

function resolveModelSelection(
  registry: SparkProviderRegistry,
  modelRef: string,
): SparkActiveSelection {
  const value = modelRef.trim();
  if (!value) throw new Error("Spark model id must be non-empty");
  const slash = value.indexOf("/");
  if (slash > 0 && slash < value.length - 1) {
    const providerName = value.slice(0, slash);
    const modelId = value.slice(slash + 1);
    return {
      providerName,
      modelId: canonicalModelId(registry, providerName, modelId),
    };
  }
  const matches = registry.listProviders().flatMap((provider) => {
    const model = provider.models.find((candidate) => modelMatches(candidate, value));
    return model ? [{ providerName: provider.name, modelId: model.id }] : [];
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Ambiguous Spark model id "${value}"; use provider/model`);
  }
  throw new Error(`Unknown Spark model: ${value}`);
}

function canonicalModelId(
  registry: SparkProviderRegistry,
  providerName: string,
  modelId: string,
): string {
  const provider = registry.getProvider(providerName);
  if (!provider) throw new Error(`Unknown Spark provider: ${providerName}`);
  const model = provider.models.find((candidate) => modelMatches(candidate, modelId));
  if (!model) throw new Error(`Provider "${providerName}" has no model with id "${modelId}"`);
  return model.id;
}

function modelMatches(model: ProviderModelDefinition, value: string): boolean {
  return model.id === value || (model.aliases ?? []).includes(value);
}

function selectionValue(selection: SparkActiveSelection): string {
  return `${selection.providerName}/${selection.modelId}`;
}

function modelSnapshot(
  providerId: string,
  model: ProviderModelDefinition,
  activeModelId: string | undefined,
  available: boolean,
): SparkProviderControlModelSnapshot {
  const id = `${providerId}/${model.id}`;
  return {
    id,
    providerId,
    modelId: model.id,
    name: model.name,
    active: id === activeModelId,
    available,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

// Keep the dependency on pi-ai's locked OAuth surface visible in this Node-only
// boundary; callers never need to import provider implementations themselves.
export type SparkControlOAuthProvider = OAuthProviderInterface;
