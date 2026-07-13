import {
  parseSparkAuthFlow,
  parseSparkModelControlSnapshot,
  parseSparkSessionRegistryRecord,
  type SparkAuthFlow,
  type SparkModelControlSnapshot,
  type SparkModelRef,
  type SparkSessionRegistryRecord,
  type SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import type { SparkModelPickerState } from "../host/model-selector.ts";
import type { SparkActiveSelection } from "../host/provider-registry.ts";
import { requestSparkDaemonControl, type SparkDaemonClientOptions } from "./daemon.ts";

export interface SparkDaemonModelAuthClient {
  readonly sessionId?: string;
  snapshot(): Promise<SparkModelControlSnapshot>;
  setSessionModel(model: SparkModelRef): Promise<SparkSessionRegistryRecord>;
  setSessionThinkingLevel(thinkingLevel: SparkThinkingLevel): Promise<SparkSessionRegistryRecord>;
  setDefaultModel(model: SparkModelRef): Promise<SparkModelControlSnapshot>;
  setApiKey(providerName: string, apiKey: string): Promise<SparkModelControlSnapshot>;
  logout(providerName: string): Promise<boolean>;
  startOAuth(providerName: string): Promise<SparkAuthFlow>;
  oauthStatus(flowId: string): Promise<SparkAuthFlow>;
  respondOAuth(flowId: string, promptId: string, value: string): Promise<SparkAuthFlow>;
  cancelOAuth(flowId: string): Promise<SparkAuthFlow>;
}

export interface SparkDaemonModelAuthClientOptions {
  sessionId?: string;
  ensureSession?: () => Promise<void>;
}

export function createSparkDaemonModelAuthClient(
  daemon: SparkDaemonClientOptions = {},
  options: SparkDaemonModelAuthClientOptions = {},
): SparkDaemonModelAuthClient {
  const sessionId = options.sessionId?.trim() || undefined;
  let sessionReady: Promise<void> | undefined;
  const ensureSession = async () => {
    if (!options.ensureSession) return;
    sessionReady ??= options.ensureSession().catch((error) => {
      sessionReady = undefined;
      throw error;
    });
    await sessionReady;
  };
  return {
    ...(sessionId ? { sessionId } : {}),
    snapshot: async () => {
      if (sessionId) await ensureSession();
      return parseSparkModelControlSnapshot(
        await requestSparkDaemonControl("model.catalog", sessionId ? { sessionId } : {}, daemon),
      );
    },
    setSessionModel: async (model) => {
      if (!sessionId) throw new Error("Session-scoped model control requires a session id.");
      await ensureSession();
      return parseSparkSessionRegistryRecord(
        await requestSparkDaemonControl("session.model.set", { sessionId, model }, daemon),
      );
    },
    setSessionThinkingLevel: async (thinkingLevel) => {
      if (!sessionId) throw new Error("Session-scoped thinking control requires a session id.");
      await ensureSession();
      return parseSparkSessionRegistryRecord(
        await requestSparkDaemonControl(
          "session.thinking.set",
          { sessionId, thinkingLevel },
          daemon,
        ),
      );
    },
    setDefaultModel: async (model) =>
      parseSparkModelControlSnapshot(
        await requestSparkDaemonControl("model.default.set", { model }, daemon),
      ),
    setApiKey: async (providerName, apiKey) =>
      parseSparkModelControlSnapshot(
        await requestSparkDaemonControl(
          "provider.auth.api-key.set",
          { providerName, apiKey },
          daemon,
        ),
      ),
    logout: async (providerName) => {
      const result = await requestSparkDaemonControl<unknown>(
        "provider.auth.logout",
        { providerName },
        daemon,
      );
      return isRecord(result) && result.removed === true;
    },
    startOAuth: async (providerName) =>
      parseSparkAuthFlow(
        await requestSparkDaemonControl("provider.auth.login.start", { providerName }, daemon),
      ),
    oauthStatus: async (flowId) =>
      parseSparkAuthFlow(
        await requestSparkDaemonControl("provider.auth.login.status", { flowId }, daemon),
      ),
    respondOAuth: async (flowId, promptId, value) =>
      parseSparkAuthFlow(
        await requestSparkDaemonControl(
          "provider.auth.login.respond",
          { flowId, promptId, value },
          daemon,
        ),
      ),
    cancelOAuth: async (flowId) =>
      parseSparkAuthFlow(
        await requestSparkDaemonControl("provider.auth.login.cancel", { flowId }, daemon),
      ),
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
          value: modelValue(entry.model),
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
    ...(active && effectiveModel ? { active, activeModelId: modelValue(effectiveModel) } : {}),
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
  const exact = entries.find((entry) => modelValue(entry.model) === value);
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

function modelValue(model: SparkModelRef): string {
  return `${model.providerName}/${model.modelId}`;
}

function modelEquals(left: SparkModelRef, right: SparkModelRef | undefined): boolean {
  return Boolean(
    right && left.providerName === right.providerName && left.modelId === right.modelId,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
