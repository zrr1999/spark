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
import type { RuntimeEphemeralSecretRequestContext } from "@zendev-lab/spark-coordination/runtime-model-channel-control";
import { createCockpitRuntimeModelChannelClient } from "./cockpit-runtime-model-channel-client.ts";

export interface CockpitModelControlClient {
  request(method: string, params?: unknown): Promise<unknown>;
}

export interface CockpitModelControlState {
  available: boolean;
  snapshot: SparkModelControlSnapshot;
  error?: string;
}

const runtimeClient = createCockpitRuntimeModelChannelClient();
const daemonModelControlClient: CockpitModelControlClient = {
  request: async (method, params) => {
    const input = isRecord(params) ? params : {};
    switch (method) {
      case "model.catalog":
        return await runtimeClient.catalog({
          ...(typeof input.runtimeId === "string" ? { runtimeId: input.runtimeId } : {}),
          ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
        });
      case "model.default.set":
        return await runtimeClient.setDefault({ model: input.model as SparkModelRef });
      case "session.model.set":
        return await runtimeClient.setSessionModel({
          sessionId: String(input.sessionId ?? ""),
          model: input.model as SparkModelRef,
        });
      case "session.thinking.set":
        return await runtimeClient.setSessionThinking({
          sessionId: String(input.sessionId ?? ""),
          thinkingLevel: input.thinkingLevel as SparkThinkingLevel,
        });
      case "provider.auth.api-key.set":
        return await runtimeClient.setProviderApiKey({
          providerName: String(input.providerName ?? ""),
          apiKey: String(input.apiKey ?? ""),
          context: input.context as RuntimeEphemeralSecretRequestContext,
        });
      case "provider.auth.logout":
        return await runtimeClient.logoutProvider({
          providerName: String(input.providerName ?? ""),
        });
      case "provider.auth.login.start":
        return await runtimeClient.startOAuth({
          providerName: String(input.providerName ?? ""),
        });
      case "provider.auth.login.status":
        return await runtimeClient.oauthStatus({ flowId: String(input.flowId ?? "") });
      case "provider.auth.login.respond":
        return await runtimeClient.respondOAuth({
          flowId: String(input.flowId ?? ""),
          promptId: String(input.promptId ?? ""),
          value: String(input.value ?? ""),
          context: input.context as RuntimeEphemeralSecretRequestContext,
        });
      case "provider.auth.login.cancel":
        return await runtimeClient.cancelOAuth({ flowId: String(input.flowId ?? "") });
      default:
        throw new Error(`Unsupported Cockpit runtime model control method: ${method}`);
    }
  },
};

const emptySnapshot: SparkModelControlSnapshot = {
  providers: [],
  diagnostics: [],
};

export async function loadModelControlForCockpit(
  sessionId?: string,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<CockpitModelControlState> {
  try {
    const snapshot = parseSparkModelControlSnapshot(
      await client.request("model.catalog", sessionId ? { sessionId } : {}),
    );
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

export async function setDefaultModelForCockpit(
  model: SparkModelRef,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkModelControlSnapshot> {
  return parseSparkModelControlSnapshot(await client.request("model.default.set", { model }));
}

export async function setSessionModelForCockpit(
  sessionId: string,
  model: SparkModelRef,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkSessionRegistryRecord> {
  return parseSparkSessionRegistryRecord(
    await client.request("session.model.set", { sessionId, model }),
  );
}

export async function setSessionThinkingLevelForCockpit(
  sessionId: string,
  thinkingLevel: SparkThinkingLevel,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkSessionRegistryRecord> {
  return parseSparkSessionRegistryRecord(
    await client.request("session.thinking.set", { sessionId, thinkingLevel }),
  );
}

export async function setProviderApiKeyForCockpit(
  providerName: string,
  apiKey: string,
  context: RuntimeEphemeralSecretRequestContext,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkModelControlSnapshot> {
  return parseSparkModelControlSnapshot(
    await client.request("provider.auth.api-key.set", { providerName, apiKey, context }),
  );
}

export async function logoutProviderForCockpit(
  providerName: string,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<{ removed: boolean; snapshot: SparkModelControlSnapshot }> {
  const value = await client.request("provider.auth.logout", { providerName });
  if (!isRecord(value) || typeof value.removed !== "boolean") {
    throw new Error("Invalid Spark daemon provider logout response.");
  }
  return {
    removed: value.removed,
    snapshot: parseSparkModelControlSnapshot(value.snapshot),
  };
}

export async function startProviderOAuthForCockpit(
  providerName: string,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkAuthFlow> {
  return parseSparkAuthFlow(await client.request("provider.auth.login.start", { providerName }));
}

export async function getProviderOAuthFlowForCockpit(
  flowId: string,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkAuthFlow> {
  return parseSparkAuthFlow(await client.request("provider.auth.login.status", { flowId }));
}

export async function respondProviderOAuthForCockpit(
  flowId: string,
  promptId: string,
  value: string,
  context: RuntimeEphemeralSecretRequestContext,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkAuthFlow> {
  return parseSparkAuthFlow(
    await client.request("provider.auth.login.respond", { flowId, promptId, value, context }),
  );
}

export async function cancelProviderOAuthForCockpit(
  flowId: string,
  client: CockpitModelControlClient = daemonModelControlClient,
): Promise<SparkAuthFlow> {
  return parseSparkAuthFlow(await client.request("provider.auth.login.cancel", { flowId }));
}

export function parseModelValue(value: string): SparkModelRef {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error("Select a valid provider/model.");
  }
  return { providerName: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function parseThinkingLevelValue(value: string): SparkThinkingLevel {
  const trimmed = value.trim().toLowerCase();
  if (!(THINKING_LEVELS as readonly string[]).includes(trimmed)) {
    throw new Error("Select a valid thinking level.");
  }
  return trimmed as SparkThinkingLevel;
}

export function modelValue(model: SparkModelRef): string {
  return `${model.providerName}/${model.modelId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
