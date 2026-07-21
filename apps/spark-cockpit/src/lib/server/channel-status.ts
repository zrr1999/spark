import { parseChannelsConfig, type ChannelsConfig } from "@zendev-lab/spark-channels";
import type { RuntimeEphemeralSecretRequestContext } from "@zendev-lab/spark-cockpit-coordination/runtime-model-channel-control";
import {
  parseSparkChannelControlSnapshot,
  type SparkChannelConfigurationProjection,
  type SparkChannelControlSnapshot,
} from "@zendev-lab/spark-protocol";
import type { MessagePlatformAdapter } from "../message-platform";
import { createCockpitRuntimeModelChannelClient } from "./cockpit-runtime-model-channel-client.ts";

export type CockpitChannelStatusSnapshot =
  | SparkChannelControlSnapshot
  | {
      workspaceId: string;
      available: false;
      configured: false;
      ingressEnabled: false;
      state: "unavailable";
      adapters: [];
      routes: [];
      configuration: SparkChannelConfigurationProjection;
      observedAt: string;
      error: string;
      text: string;
    };

export interface CockpitChannelDaemonClient {
  status(workspaceId: string): Promise<unknown>;
  configure(
    workspaceId: string,
    config: ChannelsConfig,
    context: RuntimeEphemeralSecretRequestContext,
  ): Promise<unknown>;
  reload(workspaceId: string): Promise<unknown>;
}

export interface CockpitChannelEditorValues {
  feishuEnabled: boolean;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuAppSecretSet: boolean;
  infoflowEnabled: boolean;
  infoflowEndpoint: string;
  infoflowAppKey: string;
  infoflowAppKeySet: boolean;
  infoflowAppAgentId: string;
  infoflowAppSecret: string;
  infoflowAppSecretSet: boolean;
  infoflowAllowedUserIds: string;
  infoflowGroupPolicy: "disabled" | "allowlist" | "open";
  infoflowGroupTrigger: "mention" | "command" | "all";
  infoflowAllowedGroupIds: string;
  infoflowSystemPrompt: string;
  qqbotEnabled: boolean;
  qqbotAppId: string;
  qqbotClientSecret: string;
  qqbotClientSecretSet: boolean;
  qqbotSandbox: boolean;
  qqbotAllowedUserIds: string;
  qqbotGroupPolicy: "disabled" | "allowlist" | "open";
  qqbotGroupTrigger: "mention" | "command" | "all";
  qqbotAllowedGroupIds: string;
  qqbotSystemPrompt: string;
  routeName: string;
  routeAdapter: "feishu" | "infoflow" | "qqbot";
  routeRecipient: string;
  ingressEnabled: boolean;
  onUnbound: "reject" | "create";
}

export type MessagePlatformCredentialPatch = {
  adapter: MessagePlatformAdapter;
  feishuAppId?: string;
  feishuAppSecret?: string;
  infoflowEndpoint?: string;
  infoflowAppKey?: string;
  infoflowAppAgentId?: string;
  infoflowAppSecret?: string;
  qqbotAppId?: string;
  qqbotClientSecret?: string;
  qqbotSandbox?: boolean;
};

export const DEFAULT_INFOFLOW_ENDPOINT = "https://api.im.baidu.com";

const runtimeClient = createCockpitRuntimeModelChannelClient();
const defaultCockpitChannelDaemonClient: CockpitChannelDaemonClient = {
  status: async (workspaceId) => await runtimeClient.channelStatus(workspaceId),
  configure: async (workspaceId, config, context) =>
    await runtimeClient.configureChannel({ workspaceId, config, context }),
  reload: async (workspaceId) => await runtimeClient.reloadChannel({ workspaceId }),
};

export function emptyChannelEditorValues(): CockpitChannelEditorValues {
  return {
    feishuEnabled: false,
    feishuAppId: "",
    feishuAppSecret: "",
    feishuAppSecretSet: false,
    infoflowEnabled: false,
    infoflowEndpoint: DEFAULT_INFOFLOW_ENDPOINT,
    infoflowAppKey: "",
    infoflowAppKeySet: false,
    infoflowAppAgentId: "",
    infoflowAppSecret: "",
    infoflowAppSecretSet: false,
    infoflowAllowedUserIds: "",
    infoflowGroupPolicy: "disabled",
    infoflowGroupTrigger: "mention",
    infoflowAllowedGroupIds: "",
    infoflowSystemPrompt: "",
    qqbotEnabled: false,
    qqbotAppId: "",
    qqbotClientSecret: "",
    qqbotClientSecretSet: false,
    qqbotSandbox: true,
    qqbotAllowedUserIds: "",
    qqbotGroupPolicy: "disabled",
    qqbotGroupTrigger: "mention",
    qqbotAllowedGroupIds: "",
    qqbotSystemPrompt: "",
    routeName: "ops",
    routeAdapter: "infoflow",
    routeRecipient: "",
    ingressEnabled: false,
    onUnbound: "create",
  };
}

export function channelEditorValuesFromProjection(
  projection: SparkChannelConfigurationProjection | null,
): CockpitChannelEditorValues {
  const defaults = emptyChannelEditorValues();
  if (!projection) return defaults;
  const route = projection.routes[0];
  const routeAdapter =
    route?.adapter === "feishu" || route?.adapter === "infoflow" || route?.adapter === "qqbot"
      ? route.adapter
      : "infoflow";
  return {
    ...defaults,
    feishuEnabled: Boolean(projection.feishu),
    feishuAppId: projection.feishu?.appId ?? "",
    feishuAppSecretSet: projection.feishu?.appSecretSet ?? false,
    infoflowEnabled: Boolean(projection.infoflow),
    infoflowEndpoint: projection.infoflow?.endpoint || DEFAULT_INFOFLOW_ENDPOINT,
    infoflowAppKeySet: projection.infoflow?.appKeySet ?? false,
    infoflowAppAgentId: projection.infoflow?.appAgentId ?? "",
    infoflowAppSecretSet: projection.infoflow?.appSecretSet ?? false,
    infoflowAllowedUserIds: (projection.infoflow?.allowedUserIds ?? []).join(", "),
    infoflowGroupPolicy: projection.infoflow?.groupPolicy ?? "disabled",
    infoflowGroupTrigger: projection.infoflow?.groupTrigger ?? "mention",
    infoflowAllowedGroupIds: (projection.infoflow?.allowedGroupIds ?? []).join(", "),
    infoflowSystemPrompt: projection.infoflow?.systemPrompt ?? "",
    qqbotEnabled: Boolean(projection.qqbot),
    qqbotAppId: projection.qqbot?.appId ?? "",
    qqbotClientSecretSet: projection.qqbot?.clientSecretSet ?? false,
    qqbotSandbox: projection.qqbot?.sandbox ?? true,
    qqbotAllowedUserIds: (projection.qqbot?.allowedUserIds ?? []).join(", "),
    qqbotGroupPolicy: projection.qqbot?.groupPolicy ?? "disabled",
    qqbotGroupTrigger: projection.qqbot?.groupTrigger ?? "mention",
    qqbotAllowedGroupIds: (projection.qqbot?.allowedGroupIds ?? []).join(", "),
    qqbotSystemPrompt: projection.qqbot?.systemPrompt ?? "",
    routeName: route?.name ?? defaults.routeName,
    routeAdapter,
    routeRecipient: route?.recipient ?? "",
    ingressEnabled: Boolean(projection.feishu || projection.infoflow || projection.qqbot),
    onUnbound: projection.onUnbound,
  };
}

export function mergeMessagePlatformCredentials(
  previous: CockpitChannelEditorValues,
  patch: MessagePlatformCredentialPatch,
): CockpitChannelEditorValues {
  const next: CockpitChannelEditorValues = {
    ...previous,
    ingressEnabled: true,
    onUnbound: "create",
  };
  switch (patch.adapter) {
    case "feishu":
      next.feishuEnabled = true;
      if (patch.feishuAppId?.trim()) next.feishuAppId = patch.feishuAppId.trim();
      if (patch.feishuAppSecret?.trim()) next.feishuAppSecret = patch.feishuAppSecret.trim();
      break;
    case "infoflow":
      next.infoflowEnabled = true;
      if (patch.infoflowEndpoint?.trim()) next.infoflowEndpoint = patch.infoflowEndpoint.trim();
      if (patch.infoflowAppKey?.trim()) next.infoflowAppKey = patch.infoflowAppKey.trim();
      if (patch.infoflowAppAgentId?.trim()) {
        next.infoflowAppAgentId = patch.infoflowAppAgentId.trim();
      }
      if (patch.infoflowAppSecret?.trim()) {
        next.infoflowAppSecret = patch.infoflowAppSecret.trim();
      }
      break;
    case "qqbot":
      next.qqbotEnabled = true;
      if (patch.qqbotAppId?.trim()) next.qqbotAppId = patch.qqbotAppId.trim();
      if (patch.qqbotClientSecret?.trim()) {
        next.qqbotClientSecret = patch.qqbotClientSecret.trim();
      }
      if (patch.qqbotSandbox !== undefined) next.qqbotSandbox = patch.qqbotSandbox;
      break;
  }
  return next;
}

export function channelAdapterCredentialsComplete(
  values: CockpitChannelEditorValues,
  adapter: MessagePlatformAdapter,
): boolean {
  switch (adapter) {
    case "feishu":
      return Boolean(
        values.feishuAppId.trim() && (values.feishuAppSecret.trim() || values.feishuAppSecretSet),
      );
    case "infoflow":
      return Boolean(
        (values.infoflowEndpoint.trim() || DEFAULT_INFOFLOW_ENDPOINT) &&
        (values.infoflowAppKey.trim() || values.infoflowAppKeySet) &&
        values.infoflowAppAgentId.trim() &&
        (values.infoflowAppSecret.trim() || values.infoflowAppSecretSet),
      );
    case "qqbot":
      return Boolean(
        values.qqbotAppId.trim() &&
        (values.qqbotClientSecret.trim() || values.qqbotClientSecretSet),
      );
  }
}

export function channelEditorCredentialsComplete(values: CockpitChannelEditorValues): boolean {
  if (!values.feishuEnabled && !values.infoflowEnabled && !values.qqbotEnabled) return false;
  if (values.feishuEnabled && !channelAdapterCredentialsComplete(values, "feishu")) return false;
  if (values.infoflowEnabled && !channelAdapterCredentialsComplete(values, "infoflow")) {
    return false;
  }
  if (values.qqbotEnabled && !channelAdapterCredentialsComplete(values, "qqbot")) return false;
  return true;
}

export function channelsConfigFromEditorValues(values: CockpitChannelEditorValues): ChannelsConfig {
  const adapters: ChannelsConfig["adapters"] = {};
  if (values.feishuEnabled) {
    adapters.feishu = {
      type: "feishu",
      event_mode: "websocket",
      ...(values.feishuAppId.trim() ? { app_id: values.feishuAppId.trim() } : {}),
      ...(values.feishuAppSecret.trim() ? { app_secret: values.feishuAppSecret.trim() } : {}),
    };
  }
  if (values.infoflowEnabled) {
    adapters.infoflow = {
      type: "infoflow",
      endpoint: values.infoflowEndpoint.trim() || DEFAULT_INFOFLOW_ENDPOINT,
      ...(values.infoflowAppKey.trim() ? { app_key: values.infoflowAppKey.trim() } : {}),
      ...(values.infoflowAppAgentId.trim()
        ? { app_agent_id: values.infoflowAppAgentId.trim() }
        : {}),
      ...(values.infoflowAppSecret.trim() ? { app_secret: values.infoflowAppSecret.trim() } : {}),
      connection_mode: "websocket",
      ...(parseIdList(values.infoflowAllowedUserIds).length > 0
        ? { allowed_user_ids: parseIdList(values.infoflowAllowedUserIds) }
        : {}),
      group_policy: values.infoflowGroupPolicy,
      group_trigger: values.infoflowGroupTrigger,
      ...(values.infoflowGroupPolicy === "allowlist"
        ? { allowed_group_ids: parseIdList(values.infoflowAllowedGroupIds) }
        : {}),
      ...(values.infoflowSystemPrompt.trim()
        ? { system_prompt: values.infoflowSystemPrompt.trim() }
        : {}),
    };
  }
  if (values.qqbotEnabled) {
    adapters.qqbot = {
      type: "qqbot",
      connection_mode: "websocket",
      api_environment: values.qqbotSandbox ? "sandbox" : "production",
      ...(values.qqbotAppId.trim() ? { app_id: values.qqbotAppId.trim() } : {}),
      ...(values.qqbotClientSecret.trim()
        ? { client_secret: values.qqbotClientSecret.trim() }
        : {}),
      ...(parseIdList(values.qqbotAllowedUserIds).length > 0
        ? { allowed_user_ids: parseIdList(values.qqbotAllowedUserIds) }
        : {}),
      group_policy: values.qqbotGroupPolicy,
      group_trigger: values.qqbotGroupTrigger,
      ...(values.qqbotGroupPolicy === "allowlist"
        ? { allowed_group_ids: parseIdList(values.qqbotAllowedGroupIds) }
        : {}),
      ...(values.qqbotSystemPrompt.trim()
        ? { system_prompt: values.qqbotSystemPrompt.trim() }
        : {}),
    };
  }

  const routes: ChannelsConfig["routes"] = {};
  const routeRecipient = values.routeRecipient.trim();
  if (routeRecipient) {
    routes[values.routeName.trim() || "ops"] = {
      adapter: preferredRouteAdapter(values, adapters),
      recipient: routeRecipient,
    };
  }
  return parseChannelsConfig({
    adapters,
    routes,
    ingress: {
      enabled: Object.keys(adapters).length > 0,
      on_unbound: values.onUnbound,
    },
  });
}

export async function saveChannelsConfigForCockpit(
  workspaceId: string,
  values: CockpitChannelEditorValues,
  context: RuntimeEphemeralSecretRequestContext,
  client: CockpitChannelDaemonClient = defaultCockpitChannelDaemonClient,
): Promise<{ config: ChannelsConfig; status: SparkChannelControlSnapshot }> {
  const config = channelsConfigFromEditorValues(values);
  const status = parseSparkChannelControlSnapshot(
    await client.configure(workspaceId, config, context),
  );
  return { config, status };
}

export async function loadChannelStatusForCockpit(
  workspaceId: string,
  client: CockpitChannelDaemonClient = defaultCockpitChannelDaemonClient,
): Promise<CockpitChannelStatusSnapshot> {
  try {
    return parseSparkChannelControlSnapshot(await client.status(workspaceId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      workspaceId,
      available: false,
      configured: false,
      ingressEnabled: false,
      state: "unavailable",
      adapters: [],
      routes: [],
      configuration: { routes: [], onUnbound: "create" },
      observedAt: new Date().toISOString(),
      error: message,
      text: `channel runtime unavailable: ${message}`,
    };
  }
}

function preferredRouteAdapter(
  values: CockpitChannelEditorValues,
  adapters: ChannelsConfig["adapters"],
): "feishu" | "infoflow" | "qqbot" {
  if (values.routeAdapter === "infoflow" && adapters.infoflow) return "infoflow";
  if (values.routeAdapter === "qqbot" && adapters.qqbot) return "qqbot";
  if (values.routeAdapter === "feishu" && adapters.feishu) return "feishu";
  if (adapters.feishu) return "feishu";
  if (adapters.infoflow) return "infoflow";
  if (adapters.qqbot) return "qqbot";
  return values.routeAdapter;
}

function parseIdList(raw: string): string[] {
  return raw
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
