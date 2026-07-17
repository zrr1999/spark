import {
  parseChannelsConfig,
  type ChannelsConfig,
  type FeishuAdapterConfig,
  type InfoflowAdapterConfig,
  type QqbotAdapterConfig,
} from "@zendev-lab/spark-channels";
import {
  parseSparkChannelControlSnapshot,
  parseSparkDefaultModelSetRequest,
  parseSparkSessionSetModelRequest,
  parseSparkSessionSetThinkingRequest,
  sparkProtocolJsonObjectSchema,
  type RuntimeCommandProjectionKind,
  type RuntimeEphemeralSecretRequestPayload,
  type RuntimeEphemeralSecretResultPayload,
  type SparkAuthFlow,
  type SparkChannelConfigurationProjection,
  type SparkChannelControlSnapshot,
  type SparkModelControlSnapshot,
  type SparkProtocolJsonValue,
  type SparkSessionRegistryRecord,
} from "@zendev-lab/spark-protocol";
import type { DaemonChannelIngressRuntime } from "./channels/ingress.ts";
import { loadDaemonChannelsConfig } from "./channels/ingress.ts";
import type { SparkDaemonModelControl } from "./model-control.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";

export type SparkDaemonModelChannelPublicKind =
  | "session.model.set.request"
  | "session.thinking.set.request"
  | "model.catalog.request"
  | "model.default.set.request"
  | "provider.auth.logout.request"
  | "provider.auth.login.start.request"
  | "provider.auth.login.status.request"
  | "provider.auth.login.cancel.request"
  | "channel.status.request"
  | "channel.reload.request";

export interface SparkDaemonModelChannelPublicResult {
  result: Record<string, SparkProtocolJsonValue>;
  projection?: {
    kind: RuntimeCommandProjectionKind;
    data: Record<string, SparkProtocolJsonValue>;
  };
}

export interface SparkDaemonModelChannelControlOptions {
  modelControl?: SparkDaemonModelControl;
  channelIngress?: Pick<DaemonChannelIngressRuntime, "status" | "configure" | "reload">;
  sessionRegistry?: DaemonSessionRegistry;
  sparkHome?: string;
}

export function isSparkDaemonModelChannelPublicKind(
  kind: string,
): kind is SparkDaemonModelChannelPublicKind {
  return (
    kind === "session.model.set.request" ||
    kind === "session.thinking.set.request" ||
    kind === "model.catalog.request" ||
    kind === "model.default.set.request" ||
    kind === "provider.auth.logout.request" ||
    kind === "provider.auth.login.start.request" ||
    kind === "provider.auth.login.status.request" ||
    kind === "provider.auth.login.cancel.request" ||
    kind === "channel.status.request" ||
    kind === "channel.reload.request"
  );
}

export async function executeSparkDaemonModelChannelPublicControl(
  options: SparkDaemonModelChannelControlOptions,
  input: {
    kind: SparkDaemonModelChannelPublicKind;
    scope: "daemon" | "workspace";
    workspaceId?: string;
    payload: Record<string, unknown>;
  },
): Promise<SparkDaemonModelChannelPublicResult> {
  switch (input.kind) {
    case "session.model.set.request": {
      const request = parseSparkSessionSetModelRequest(input.payload);
      await requireSessionRoute(options, request.sessionId, input.scope, input.workspaceId);
      const session = await requireModelControl(options).setSessionModel(
        request.sessionId,
        request.model,
      );
      return sessionResult(session);
    }
    case "session.thinking.set.request": {
      const request = parseSparkSessionSetThinkingRequest(input.payload);
      await requireSessionRoute(options, request.sessionId, input.scope, input.workspaceId);
      const session = await requireModelControl(options).setSessionThinkingLevel(
        request.sessionId,
        request.thinkingLevel,
      );
      return sessionResult(session);
    }
    case "model.catalog.request": {
      const sessionId = optionalString(input.payload.sessionId);
      if (sessionId) {
        await requireSessionRoute(options, sessionId, input.scope, input.workspaceId);
      }
      const snapshot = publicModelSnapshot(await requireModelControl(options).snapshot(sessionId));
      const data = publicObject(snapshot);
      return {
        result: { snapshot: data },
        projection: { kind: "model.catalog", data },
      };
    }
    case "model.default.set.request": {
      const request = parseSparkDefaultModelSetRequest(input.payload);
      const snapshot = publicModelSnapshot(
        await requireModelControl(options).setDefaultModel(request.model),
      );
      const data = publicObject(snapshot);
      return {
        result: { snapshot: data },
        projection: { kind: "model.catalog", data },
      };
    }
    case "provider.auth.logout.request": {
      const providerName = requiredString(input.payload.providerName, "providerName");
      const loggedOut = await requireModelControl(options).logout(providerName);
      const snapshot = publicObject(publicModelSnapshot(loggedOut.snapshot));
      return {
        result: { removed: loggedOut.removed, snapshot },
        projection: { kind: "model.catalog", data: snapshot },
      };
    }
    case "provider.auth.login.start.request": {
      const flow = await requireModelControl(options).startOAuth(
        requiredString(input.payload.providerName, "providerName"),
      );
      const projected = publicObject(publicAuthFlow(flow));
      return {
        result: { flow: projected },
        projection: { kind: "provider.auth.flow", data: projected },
      };
    }
    case "provider.auth.login.status.request": {
      const flow = await requireModelControl(options).oauthStatus(
        requiredString(input.payload.flowId, "flowId"),
      );
      const projected = publicObject(publicAuthFlow(flow));
      return {
        result: { flow: projected },
        projection: { kind: "provider.auth.flow", data: projected },
      };
    }
    case "provider.auth.login.cancel.request": {
      const flow = await requireModelControl(options).cancelOAuth(
        requiredString(input.payload.flowId, "flowId"),
      );
      const projected = publicObject(publicAuthFlow(flow));
      return {
        result: { flow: projected },
        projection: { kind: "provider.auth.flow", data: projected },
      };
    }
    case "channel.status.request": {
      const workspaceId = requireWorkspaceId(input.workspaceId, input.payload.workspaceId);
      const snapshot = await channelSnapshot(options, workspaceId);
      const data = publicObject(snapshot);
      return {
        result: { snapshot: data },
        projection: { kind: "channel.status", data },
      };
    }
    case "channel.reload.request": {
      const workspaceId = requireWorkspaceId(input.workspaceId, input.payload.workspaceId);
      await requireChannelIngress(options).reload(workspaceId);
      const snapshot = await channelSnapshot(options, workspaceId);
      const data = publicObject(snapshot);
      return {
        result: { snapshot: data },
        projection: { kind: "channel.status", data },
      };
    }
  }
}

export async function executeSparkDaemonEphemeralSecretControl(
  options: SparkDaemonModelChannelControlOptions,
  request: RuntimeEphemeralSecretRequestPayload,
): Promise<RuntimeEphemeralSecretResultPayload> {
  const completedAt = new Date().toISOString();
  try {
    switch (request.operation) {
      case "provider.auth.api_key.set":
        return {
          operation: request.operation,
          status: "succeeded",
          result: publicModelSnapshot(
            await requireModelControl(options).setApiKey(request.providerName, request.apiKey),
          ),
          completedAt,
        };
      case "provider.auth.login.respond":
        return {
          operation: request.operation,
          status: "succeeded",
          result: publicAuthFlow(
            await requireModelControl(options).respondOAuth(
              request.flowId,
              request.promptId,
              request.value,
            ),
          ),
          completedAt,
        };
      case "channel.configure": {
        const config = await mergePrivateChannelConfig(
          options,
          request.workspaceId,
          request.config,
        );
        await requireChannelIngress(options).configure(request.workspaceId, config);
        return {
          operation: request.operation,
          status: "succeeded",
          result: await channelSnapshot(options, request.workspaceId),
          completedAt,
        };
      }
    }
  } catch {
    return {
      operation: request.operation,
      status: "failed",
      reasonCode: "SECRET_OPERATION_FAILED",
      message: publicFailureMessage(request.operation),
      completedAt,
    } as RuntimeEphemeralSecretResultPayload;
  }
}

export async function channelSnapshot(
  options: SparkDaemonModelChannelControlOptions,
  workspaceId: string,
): Promise<SparkChannelControlSnapshot> {
  const runtime = requireChannelIngress(options).status(workspaceId);
  const loaded = options.sparkHome
    ? await loadDaemonChannelsConfig(options.sparkHome, workspaceId)
    : { config: null };
  return parseSparkChannelControlSnapshot({
    workspaceId,
    available: true,
    configured: runtime.configured,
    ingressEnabled: runtime.ingressEnabled,
    state: runtime.state,
    adapters: runtime.adapters.map((adapter) => ({
      id: adapter.id,
      type: adapter.type,
      running: adapter.running,
      state: adapter.state,
      ...(adapter.error ? { error: "Channel adapter reported an error." } : {}),
    })),
    routes: runtime.routes,
    configuration: channelConfigurationProjection(loaded.config),
    lastReloadedAt: runtime.lastReloadedAt,
    observedAt: runtime.observedAt,
    ...(runtime.error ? { error: "Channel runtime reported an error." } : {}),
    text: `channels workspace=${workspaceId} ${runtime.state} adapters=${runtime.adapters.length} routes=${runtime.routes.length} ingress=${runtime.ingressEnabled ? "on" : "off"}\n`,
  });
}

export function channelConfigurationProjection(
  config: ChannelsConfig | null,
): SparkChannelConfigurationProjection {
  const feishu = adapterOfType(config, "feishu");
  const infoflow = adapterOfType(config, "infoflow");
  const qqbot = adapterOfType(config, "qqbot");
  return {
    ...(feishu
      ? {
          feishu: {
            appId: feishu.app_id ?? "",
            appSecretSet: Boolean(feishu.app_secret?.trim()),
          },
        }
      : {}),
    ...(infoflow
      ? {
          infoflow: {
            endpoint: infoflow.endpoint ?? "",
            appKeySet: Boolean(infoflow.app_key?.trim()),
            appAgentId: infoflow.app_agent_id ?? "",
            appSecretSet: Boolean(infoflow.app_secret?.trim()),
            allowedUserIds: infoflow.allowed_user_ids ?? [],
            groupPolicy: infoflow.group_policy ?? "disabled",
            groupTrigger: infoflow.group_trigger ?? "mention",
            allowedGroupIds: infoflow.allowed_group_ids ?? [],
            systemPrompt: infoflow.system_prompt ?? "",
          },
        }
      : {}),
    ...(qqbot
      ? {
          qqbot: {
            appId: qqbot.app_id ?? "",
            clientSecretSet: Boolean(qqbot.client_secret?.trim()),
            sandbox: qqbot.api_environment === "sandbox",
            allowedUserIds: qqbot.allowed_user_ids ?? [],
            groupPolicy: qqbot.group_policy ?? "disabled",
            groupTrigger: qqbot.group_trigger ?? "mention",
            allowedGroupIds: qqbot.allowed_group_ids ?? [],
            systemPrompt: qqbot.system_prompt ?? "",
          },
        }
      : {}),
    routes: Object.entries(config?.routes ?? {}).map(([name, route]) => ({
      name,
      adapter: route.adapter,
      recipient: route.recipient,
    })),
    onUnbound: config?.ingress?.on_unbound === "reject" ? "reject" : "create",
  };
}

async function mergePrivateChannelConfig(
  options: SparkDaemonModelChannelControlOptions,
  workspaceId: string,
  value: Record<string, SparkProtocolJsonValue>,
): Promise<ChannelsConfig> {
  const incoming = parseChannelsConfig(value);
  const previous = options.sparkHome
    ? (await loadDaemonChannelsConfig(options.sparkHome, workspaceId)).config
    : null;
  const previousByType = {
    feishu: adapterOfType(previous, "feishu"),
    infoflow: adapterOfType(previous, "infoflow"),
    qqbot: adapterOfType(previous, "qqbot"),
  };
  const adapters: ChannelsConfig["adapters"] = {};
  for (const [id, adapter] of Object.entries(incoming.adapters)) {
    if (adapter.type === "feishu") {
      adapters[id] = {
        ...adapter,
        ...(adapter.app_secret?.trim()
          ? {}
          : previousByType.feishu?.app_secret
            ? { app_secret: previousByType.feishu.app_secret }
            : {}),
      };
    } else if (adapter.type === "infoflow") {
      adapters[id] = {
        ...adapter,
        ...(adapter.app_key?.trim()
          ? {}
          : previousByType.infoflow?.app_key
            ? { app_key: previousByType.infoflow.app_key }
            : {}),
        ...(adapter.app_secret?.trim()
          ? {}
          : previousByType.infoflow?.app_secret
            ? { app_secret: previousByType.infoflow.app_secret }
            : {}),
      };
    } else {
      adapters[id] = {
        ...adapter,
        ...(adapter.client_secret?.trim()
          ? {}
          : previousByType.qqbot?.client_secret
            ? { client_secret: previousByType.qqbot.client_secret }
            : {}),
      };
    }
  }
  return parseChannelsConfig({ ...incoming, adapters });
}

function sessionResult(session: SparkSessionRegistryRecord): SparkDaemonModelChannelPublicResult {
  const projected = publicObject(session);
  return {
    result: { session: projected },
    projection: { kind: "session.detail", data: { session: projected } },
  };
}

function publicObject(value: unknown): Record<string, SparkProtocolJsonValue> {
  return sparkProtocolJsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
}

function publicModelSnapshot(snapshot: SparkModelControlSnapshot): SparkModelControlSnapshot {
  return {
    providers: snapshot.providers,
    ...(snapshot.defaultModel ? { defaultModel: snapshot.defaultModel } : {}),
    ...(snapshot.session ? { session: snapshot.session } : {}),
    diagnostics:
      snapshot.diagnostics.length > 0 ? ["Provider diagnostics are available on the daemon."] : [],
  };
}

function publicAuthFlow(flow: SparkAuthFlow): SparkAuthFlow {
  return {
    id: flow.id,
    providerName: flow.providerName,
    ...(flow.providerLabel ? { providerLabel: flow.providerLabel } : {}),
    ...(flow.oauthProviderId ? { oauthProviderId: flow.oauthProviderId } : {}),
    status: flow.status,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    ...(flow.authorization
      ? {
          authorization: {
            url: flow.authorization.url,
            ...(flow.authorization.instructions
              ? { instructions: "Continue authorization in the provider window." }
              : {}),
          },
        }
      : {}),
    ...(flow.deviceCode ? { deviceCode: flow.deviceCode } : {}),
    ...(flow.prompt
      ? {
          prompt: {
            ...flow.prompt,
            message: "Complete the provider authorization prompt.",
            ...(flow.prompt.kind !== "select" && flow.prompt.placeholder
              ? { placeholder: "" }
              : {}),
          },
        }
      : {}),
    progress: flow.progress.length > 0 ? ["Provider authorization is in progress."] : [],
    ...(flow.error ? { error: "Provider authorization failed." } : {}),
  };
}

async function requireSessionRoute(
  options: SparkDaemonModelChannelControlOptions,
  sessionId: string,
  scope: "daemon" | "workspace",
  workspaceId?: string,
): Promise<void> {
  if (!options.sessionRegistry) {
    throw new Error("Spark daemon session registry is not available.");
  }
  const session = await options.sessionRegistry.get(sessionId);
  if (!session) throw new Error("Session does not belong to the routed runtime owner.");
  const matches =
    scope === "daemon"
      ? session.scope.kind === "daemon"
      : session.scope.kind === "workspace" && session.scope.workspaceId === workspaceId;
  if (!matches) throw new Error("Session does not belong to the routed runtime owner.");
}

function requireModelControl(
  options: SparkDaemonModelChannelControlOptions,
): SparkDaemonModelControl {
  if (!options.modelControl) throw new Error("Spark daemon model/auth control is not available.");
  return options.modelControl;
}

function requireChannelIngress(
  options: SparkDaemonModelChannelControlOptions,
): Pick<DaemonChannelIngressRuntime, "status" | "configure" | "reload"> {
  if (!options.channelIngress) throw new Error("Spark daemon channel runtime is not available.");
  return options.channelIngress;
}

function requireWorkspaceId(routeValue: string | undefined, payloadValue: unknown): string {
  const route = routeValue?.trim();
  const payload = optionalString(payloadValue);
  if (!route || (payload && payload !== route)) {
    throw new Error("Channel control requires one matching workspace route.");
  }
  return route;
}

function requiredString(value: unknown, name: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${name} is required.`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function adapterOfType(
  config: ChannelsConfig | null,
  type: "feishu",
): FeishuAdapterConfig | undefined;
function adapterOfType(
  config: ChannelsConfig | null,
  type: "infoflow",
): InfoflowAdapterConfig | undefined;
function adapterOfType(
  config: ChannelsConfig | null,
  type: "qqbot",
): QqbotAdapterConfig | undefined;
function adapterOfType(
  config: ChannelsConfig | null,
  type: "feishu" | "infoflow" | "qqbot",
): FeishuAdapterConfig | InfoflowAdapterConfig | QqbotAdapterConfig | undefined {
  return Object.values(config?.adapters ?? {}).find((adapter) => adapter.type === type) as
    | FeishuAdapterConfig
    | InfoflowAdapterConfig
    | QqbotAdapterConfig
    | undefined;
}

function publicFailureMessage(
  operation: RuntimeEphemeralSecretRequestPayload["operation"],
): string {
  if (operation === "channel.configure") return "Spark daemon rejected the channel configuration.";
  if (operation === "provider.auth.api_key.set") {
    return "Spark daemon rejected the provider credential.";
  }
  return "Spark daemon could not complete the provider authorization operation.";
}
