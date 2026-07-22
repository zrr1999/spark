import {
  createSparkModelControlClient,
  parseSparkModelControlSnapshot,
  parseSparkModelValue,
  parseSparkThinkingLevelValue,
  sparkModelValue,
  type SparkAuthFlow,
  type SparkModelControlSnapshot,
  type SparkModelRef,
  type SparkSessionRegistryRecord,
  type SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import type { RuntimeEphemeralSecretRequestContext } from "@zendev-lab/spark-cockpit-coordination/runtime-model-channel-control";
import { createCockpitRuntimeModelChannelClient } from "./cockpit-runtime-model-channel-client.ts";

export interface CockpitModelControlClient {
  request(method: string, params?: unknown): Promise<unknown>;
  projectedCatalog?(params?: unknown): unknown;
}

export type CockpitModelControlRoute =
  | string
  | { runtimeId?: string; sessionId?: string; workspaceId?: string };

export interface CockpitModelControlState {
  available: boolean;
  snapshot: SparkModelControlSnapshot;
  error?: string;
}

const runtimeClient = createCockpitRuntimeModelChannelClient();
const daemonModelControlClient: CockpitModelControlClient = {
  projectedCatalog: (params) => {
    const input = isRecord(params) ? params : {};
    return runtimeClient.projectedCatalog({
      ...(typeof input.runtimeId === "string" ? { runtimeId: input.runtimeId } : {}),
      ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
      ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
    });
  },
  request: async (method, params) => {
    const input = isRecord(params) ? params : {};
    switch (method) {
      case "model.catalog":
        return await runtimeClient.catalog({
          ...(typeof input.runtimeId === "string" ? { runtimeId: input.runtimeId } : {}),
          ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
          ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
        });
      case "model.default.set":
        return await runtimeClient.setDefault({ model: input.model as SparkModelRef });
      case "session.model.set":
        return await runtimeClient.setSessionModel({
          sessionId: stringParam(input.sessionId),
          model: input.model as SparkModelRef,
        });
      case "session.thinking.set":
        return await runtimeClient.setSessionThinking({
          sessionId: stringParam(input.sessionId),
          thinkingLevel: input.thinkingLevel as SparkThinkingLevel,
        });
      case "provider.auth.api-key.set":
        return await runtimeClient.setProviderApiKey({
          providerName: stringParam(input.providerName),
          apiKey: stringParam(input.apiKey),
          context: input.context as RuntimeEphemeralSecretRequestContext,
        });
      case "provider.auth.logout":
        return await runtimeClient.logoutProvider({
          providerName: stringParam(input.providerName),
        });
      case "provider.auth.login.start":
        return await runtimeClient.startOAuth({
          providerName: stringParam(input.providerName),
        });
      case "provider.auth.login.status":
        return await runtimeClient.oauthStatus({ flowId: stringParam(input.flowId) });
      case "provider.auth.login.respond":
        return await runtimeClient.respondOAuth({
          flowId: stringParam(input.flowId),
          promptId: stringParam(input.promptId),
          value: stringParam(input.value),
          context: input.context as RuntimeEphemeralSecretRequestContext,
        });
      case "provider.auth.login.cancel":
        return await runtimeClient.cancelOAuth({ flowId: stringParam(input.flowId) });
      default:
        throw new Error(`Unsupported Cockpit runtime model control method: ${method}`);
    }
  },
};

function stringParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const emptySnapshot: SparkModelControlSnapshot = {
  providers: [],
  diagnostics: [],
};

export async function loadModelControlForCockpit(
  route: CockpitModelControlRoute = {},
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<CockpitModelControlState> {
  const params = modelCatalogParams(route);
  try {
    const snapshot = parseSparkModelControlSnapshot(await client.request("model.catalog", params));
    return { available: true, snapshot };
  } catch (error) {
    // Model picker is optional chrome on the session page; never 500 the route
    // because catalog RPC / parse failed (daemon restart, stale schema, etc.).
    return {
      available: false,
      snapshot: emptySnapshot,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadProjectedModelControlForCockpit(
  route: CockpitModelControlRoute,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<CockpitModelControlState> {
  try {
    const projection = client.projectedCatalog?.(modelCatalogParams(route));
    if (!projection) return unavailableModelControlState("No cached model catalog is available.");
    return { available: true, snapshot: parseSparkModelControlSnapshot(projection) };
  } catch (error) {
    return unavailableModelControlState(error instanceof Error ? error.message : String(error));
  }
}

function modelCatalogParams(route: CockpitModelControlRoute): Record<string, string> {
  if (typeof route === "string") return route.trim() ? { sessionId: route.trim() } : {};
  return {
    ...(route.runtimeId?.trim() ? { runtimeId: route.runtimeId.trim() } : {}),
    ...(route.sessionId?.trim() ? { sessionId: route.sessionId.trim() } : {}),
    ...(route.workspaceId?.trim() ? { workspaceId: route.workspaceId.trim() } : {}),
  };
}

function unavailableModelControlState(error: string): CockpitModelControlState {
  return { available: false, snapshot: emptySnapshot, error };
}

export async function setDefaultModelForCockpit(
  model: SparkModelRef,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkModelControlSnapshot> {
  return createSparkModelControlClient((method, params) =>
    client.request(method, params),
  ).setDefaultModel(model);
}

export async function setSessionModelForCockpit(
  sessionId: string,
  model: SparkModelRef,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkSessionRegistryRecord> {
  return createSparkModelControlClient((method, params) => client.request(method, params), {
    sessionId,
  }).setSessionModel(model);
}

export async function setSessionThinkingLevelForCockpit(
  sessionId: string,
  thinkingLevel: SparkThinkingLevel,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkSessionRegistryRecord> {
  return createSparkModelControlClient((method, params) => client.request(method, params), {
    sessionId,
  }).setSessionThinkingLevel(thinkingLevel);
}

export async function setProviderApiKeyForCockpit(
  providerName: string,
  apiKey: string,
  context: RuntimeEphemeralSecretRequestContext,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkModelControlSnapshot> {
  return createSparkModelControlClient((method, params) =>
    client.request(method, params),
  ).setApiKey(providerName, apiKey, { context });
}

export async function logoutProviderForCockpit(
  providerName: string,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<{ removed: boolean; snapshot: SparkModelControlSnapshot }> {
  const result = await createSparkModelControlClient((method, params) =>
    client.request(method, params),
  ).logout(providerName);
  return {
    removed: result.removed,
    snapshot: parseSparkModelControlSnapshot(result.snapshot),
  };
}

export async function startProviderOAuthForCockpit(
  providerName: string,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkAuthFlow> {
  return createSparkModelControlClient((method, params) =>
    client.request(method, params),
  ).startOAuth(providerName);
}

export async function getProviderOAuthFlowForCockpit(
  flowId: string,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkAuthFlow> {
  return createSparkModelControlClient((method, params) =>
    client.request(method, params),
  ).oauthStatus(flowId);
}

export async function respondProviderOAuthForCockpit(
  flowId: string,
  promptId: string,
  value: string,
  context: RuntimeEphemeralSecretRequestContext,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkAuthFlow> {
  return createSparkModelControlClient((method, params) =>
    client.request(method, params),
  ).respondOAuth(flowId, promptId, value, { context });
}

export async function cancelProviderOAuthForCockpit(
  flowId: string,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkAuthFlow> {
  return createSparkModelControlClient((method, params) =>
    client.request(method, params),
  ).cancelOAuth(flowId);
}

export const parseModelValue = parseSparkModelValue;
export const parseThinkingLevelValue = parseSparkThinkingLevelValue;
export const modelValue = sparkModelValue;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
