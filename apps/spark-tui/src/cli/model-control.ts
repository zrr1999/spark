import {
  createSparkModelControlClient,
  sparkModelValue,
  type SparkModelControlClient,
  type SparkModelControlSnapshot,
  type SparkModelRef,
} from "@zendev-lab/spark-protocol";
import type { SparkModelPickerState } from "../host/model-selector.ts";
import type { SparkActiveSelection } from "../host/provider-registry.ts";
import { requestSparkDaemonControl, type SparkDaemonClientOptions } from "./daemon.ts";

export type SparkDaemonModelAuthClient = Omit<SparkModelControlClient, "logout"> & {
  logout(providerName: string): Promise<boolean>;
};

export interface SparkDaemonModelAuthClientOptions {
  sessionId?: string;
  ensureSession?: () => Promise<void>;
}

export function createSparkDaemonModelAuthClient(
  daemon: SparkDaemonClientOptions = {},
  options: SparkDaemonModelAuthClientOptions = {},
): SparkDaemonModelAuthClient {
  const client = createSparkModelControlClient(
    async (method, params) => requestSparkDaemonControl(method, params ?? {}, daemon),
    options,
  );
  return {
    ...client,
    logout: async (providerName) => (await client.logout(providerName)).removed,
  };
}

export function daemonSnapshotToPickerState(
  snapshot: SparkModelControlSnapshot,
): SparkModelPickerState {
  const effectiveModel = snapshot.session?.model ?? snapshot.defaultModel;
  const active = effectiveModel ? selection(effectiveModel) : undefined;
  const providers = snapshot.providers
    .map((provider) => ({
      providerName: provider.providerName,
      providerLabel: provider.label,
      active: active?.providerName === provider.providerName,
      models: provider.models
        .filter((entry) => entry.available)
        .map((entry) => ({
          value: sparkModelValue(entry.model),
          providerName: entry.model.providerName,
          providerLabel: entry.model.providerLabel ?? provider.label,
          modelId: entry.model.modelId,
          modelLabel: entry.model.modelLabel ?? entry.model.modelId,
          description:
            entry.description ??
            `${entry.reasoning ? "reasoning" : "standard"} · ${entry.contextWindow ?? "?"} ctx`,
          active: modelEquals(entry.model, effectiveModel),
          reasoning: entry.reasoning,
        })),
    }))
    .filter((provider) => provider.models.length > 0);
  return {
    providers,
    items: providers.flatMap((provider) => provider.models),
    ...(active && effectiveModel ? { active, activeModelId: sparkModelValue(effectiveModel) } : {}),
  };
}

export function resolveDaemonModelSelection(
  snapshot: SparkModelControlSnapshot,
  query: string,
): SparkActiveSelection {
  const value = query.trim();
  if (!value) throw new Error("Spark model id must be non-empty");
  const entries = snapshot.providers.flatMap((provider) =>
    provider.models.filter((entry) => entry.available),
  );
  const exact = entries.find((entry) => sparkModelValue(entry.model) === value);
  if (exact) return selection(exact.model);
  const matches = entries.filter(
    (entry) =>
      entry.model.modelId === value ||
      entry.model.modelLabel?.toLocaleLowerCase() === value.toLocaleLowerCase(),
  );
  if (matches.length === 1) return selection(matches[0]!.model);
  if (matches.length > 1) throw new Error(`Ambiguous Spark model "${value}"; use provider/model.`);
  throw new Error(`Unknown Spark model: ${value}`);
}

function selection(model: SparkModelRef): SparkActiveSelection {
  return { providerName: model.providerName, modelId: model.modelId };
}

function modelEquals(left: SparkModelRef, right: SparkModelRef | undefined): boolean {
  return Boolean(
    right && left.providerName === right.providerName && left.modelId === right.modelId,
  );
}
