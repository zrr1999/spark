import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  LeafCapabilityRequest,
  LeafCapabilityResult,
  LeafCapabilityRunner,
} from "@zendev-lab/spark-extension-api";

import {
  normalizeProviderStream,
  retagAssistantMessageStream,
  runSparkLeaf,
  SparkModelRegistry,
  SparkRouteResolver,
  type ResolvedSparkModelIdentity,
  type SparkLeafModelBinding,
  type SparkLeafRequest,
  type SparkProviderStreamFunction,
} from "./index.ts";
import type {
  ProviderConfig,
  SparkActiveSelection,
  SparkProviderRegistry,
} from "./provider-registry.ts";
import type { ProviderRegistryRunnerOptions } from "./provider-runner.ts";

export interface SparkLeafHostRunnerOptions {
  registry: SparkProviderRegistry;
  runnerOptions?: ProviderRegistryRunnerOptions;
}

/**
 * Build the host `ctx.runLeaf` implementation from a Spark provider registry.
 *
 * The returned runner resolves an explicit `provider/model` override or the
 * caller session model to a concrete provider selection, builds a single-model
 * `SparkLeafModelBinding` (a per-call resolver plus a credential-injecting
 * stream bound to that selection), and delegates to `runSparkLeaf`. It never
 * throws for unknown models or provider failures: those degrade to a stable
 * reason code so tools fall back to mechanical output. The binding uses the
 * model materialized by the leaf's own resolver, so it never mutates the host's
 * active model selection and is safe under concurrent leaf calls.
 */
export function createProviderRegistryLeafRunner(
  options: SparkLeafHostRunnerOptions,
): LeafCapabilityRunner {
  return async (request: LeafCapabilityRequest): Promise<LeafCapabilityResult> => {
    const active = options.registry.getActive();
    const defaultSessionModel = active ? `${active.providerName}/${active.modelId}` : undefined;
    const leafRequest: SparkLeafRequest = {
      role: request.role,
      brief: request.brief,
      input: request.input,
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.sessionModel !== undefined
        ? { sessionModel: request.sessionModel }
        : defaultSessionModel !== undefined
          ? { sessionModel: defaultSessionModel }
          : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    };

    const result = await runSparkLeaf(leafRequest, {
      resolveBinding: (_req, modelId) =>
        resolveBinding(options.registry, modelId, options.runnerOptions),
    });

    return {
      degraded: result.degraded,
      text: result.text,
      ...(result.model !== undefined ? { model: result.model } : {}),
      ...(result.reasonCode !== undefined ? { reasonCode: result.reasonCode } : {}),
    };
  };
}

function resolveBinding(
  registry: SparkProviderRegistry,
  modelId: string | undefined,
  runnerOptions: ProviderRegistryRunnerOptions | undefined,
): SparkLeafModelBinding | undefined {
  const selection = resolveSelection(registry, modelId);
  if (!selection) return undefined;
  const provider = registry.getProvider(selection.providerName);
  if (!provider) return undefined;
  let profile;
  try {
    profile = registry.buildProfile(selection.providerName, selection.modelId);
  } catch {
    return undefined;
  }
  return {
    sparkModelId: profile.id,
    resolver: new SparkRouteResolver(new SparkModelRegistry([profile])),
    stream: createSelectionStreamFunction(provider, selection, runnerOptions),
  };
}

/**
 * Stream function bound to one provider selection. It uses the model the leaf
 * resolver already materialized (transport route) and injects the resolved API
 * key without touching registry active state, keeping concurrent leaf calls
 * independent.
 */
function createSelectionStreamFunction(
  provider: ProviderConfig,
  selection: SparkActiveSelection,
  runnerOptions: ProviderRegistryRunnerOptions | undefined,
): SparkProviderStreamFunction {
  const identity: ResolvedSparkModelIdentity = {
    api: provider.api,
    provider: selection.providerName,
    model: selection.modelId,
  };
  return ((model, context, streamOptions) => {
    const apiKey = runnerOptions?.resolveApiKey?.(provider, selection);
    const options =
      apiKey !== undefined &&
      (streamOptions as { apiKey?: unknown } | undefined)?.apiKey === undefined
        ? { ...(streamOptions ?? {}), apiKey }
        : streamOptions;
    const raw = provider.streamSimple(model as Model<Api>, context, options);
    const normalized = normalizeProviderStream(raw, selection.providerName);
    return retagAssistantMessageStream(normalized, identity);
  }) as SparkProviderStreamFunction;
}

function resolveSelection(
  registry: SparkProviderRegistry,
  modelId: string | undefined,
): SparkActiveSelection | undefined {
  if (!modelId) return registry.getActive();
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const providerName = modelId.slice(0, slash);
    const id = modelId.slice(slash + 1);
    if (registry.hasProvider(providerName)) {
      const def = registry.listModelsFor(providerName).find((candidate) => candidate.id === id);
      if (def) return { providerName, modelId: def.id };
    }
    return undefined;
  }
  const active = registry.getActive();
  if (active && registry.listModelsFor(active.providerName).some((item) => item.id === modelId)) {
    return { providerName: active.providerName, modelId };
  }
  for (const provider of registry.listProviders()) {
    if (provider.models.some((candidate) => candidate.id === modelId)) {
      return { providerName: provider.name, modelId };
    }
  }
  return undefined;
}
