import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseChannelsConfig, type ChannelsConfig } from "@zendev-lab/spark-channels";
import {
  requestSparkDaemonLocalRpc,
  SparkDaemonLocalRpcUnavailableError,
  touchPrivateFile,
} from "@zendev-lab/spark-system";
import type { CreateChannelAdapter } from "../create-channel";

export interface CockpitChannelStatusSnapshot {
  workspaceId: string;
  configPath: string;
  available: boolean;
  configured: boolean;
  ingressEnabled: boolean;
  state: "unavailable" | "unconfigured" | "running" | "stopped" | "degraded";
  adapters: Array<{
    id: string;
    type: string;
    running: boolean;
    state: "stopped" | "connecting" | "connected" | "reconnecting" | "degraded";
    error?: string;
  }>;
  routes: Array<{ name: string; adapter: string; recipient: string }>;
  observedAt: string;
  error?: string;
  text: string;
}

export interface CockpitChannelDaemonClient {
  status(workspaceId: string): Promise<unknown>;
  configure(workspaceId: string, config: ChannelsConfig): Promise<unknown>;
}

export interface CockpitChannelEditorValues {
  feishuEnabled: boolean;
  feishuAppId: string;
  /** Empty in the editor when a secret is already stored; leave blank to keep it. */
  feishuAppSecret: string;
  feishuAppSecretSet: boolean;
  infoflowEnabled: boolean;
  infoflowEndpoint: string;
  infoflowAppKey: string;
  infoflowAppAgentId: string;
  /** Empty in the editor when a secret is already stored; leave blank to keep it. */
  infoflowAppSecret: string;
  infoflowAppSecretSet: boolean;
  /** Comma/space-separated private sender allowlist; empty = allow all private. */
  infoflowAllowedUserIds: string;
  infoflowGroupPolicy: "disabled" | "allowlist" | "open";
  /** Which messages in an allowed group become Spark turns. */
  infoflowGroupTrigger: "mention" | "command" | "all";
  /** Comma/space-separated group ids when policy is allowlist. */
  infoflowAllowedGroupIds: string;
  /** Custom Infoflow system-prompt overlay (operator copy). */
  infoflowSystemPrompt: string;
  qqbotEnabled: boolean;
  qqbotAppId: string;
  /** Empty in the editor when a secret is already stored; leave blank to keep it. */
  qqbotClientSecret: string;
  qqbotClientSecretSet: boolean;
  /** Prefer QQ Bot sandbox OpenAPI (no IP whitelist). */
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

/** Baidu Infoflow Open API root used when the form leaves endpoint blank. */
export const DEFAULT_INFOFLOW_ENDPOINT = "https://api.im.baidu.com";

function sparkHome(): string {
  return process.env.SPARK_HOME?.trim() || join(homedir(), ".spark");
}

export function channelsConfigPath(workspaceId: string): string {
  const id = workspaceId.trim();
  if (!id) throw new Error("workspaceId is required for channel config");
  return join(sparkHome(), "workspaces", id, "channels", "config.json");
}

export function legacyChannelsConfigPath(): string {
  return join(sparkHome(), "channels", "config.json");
}

export async function migrateLegacyChannelsConfigForCockpit(workspaceId: string): Promise<boolean> {
  const dest = channelsConfigPath(workspaceId);
  if (existsSync(dest)) return false;
  const legacy = legacyChannelsConfigPath();
  if (!existsSync(legacy)) return false;
  const raw = await readFile(legacy, "utf8");
  parseChannelsConfig(JSON.parse(raw) as unknown);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, raw.endsWith("\n") ? raw : `${raw}\n`, { mode: 0o600 });
  touchPrivateFile(dest);
  try {
    await rename(legacy, `${legacy}.migrated`);
  } catch {
    // best-effort
  }
  return true;
}

export async function loadChannelsConfigForCockpit(workspaceId: string): Promise<{
  path: string;
  config: ChannelsConfig | null;
}> {
  await migrateLegacyChannelsConfigForCockpit(workspaceId);
  const path = channelsConfigPath(workspaceId);
  try {
    if (existsSync(path)) touchPrivateFile(path);
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return { path, config: parseChannelsConfig(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, config: null };
    }
    throw error;
  }
}

export function emptyChannelEditorValues(): CockpitChannelEditorValues {
  return {
    feishuEnabled: false,
    feishuAppId: "",
    feishuAppSecret: "",
    feishuAppSecretSet: false,
    infoflowEnabled: false,
    infoflowEndpoint: DEFAULT_INFOFLOW_ENDPOINT,
    infoflowAppKey: "",
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
    // Derived from adapter enable; kept for form/status compatibility.
    ingressEnabled: false,
    onUnbound: "create",
  };
}

export type CreateChannelCredentialPatch = {
  adapter: CreateChannelAdapter;
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

/** Merge create-form credentials onto existing editor values without dropping other adapters. */
export function mergeAdapterCredentialsForCreate(
  previous: CockpitChannelEditorValues,
  patch: CreateChannelCredentialPatch,
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
      if (patch.infoflowEndpoint?.trim()) {
        next.infoflowEndpoint = patch.infoflowEndpoint.trim();
      }
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
    default: {
      const _exhaustive: never = patch.adapter;
      throw new Error(`unsupported create-channel adapter: ${String(_exhaustive)}`);
    }
  }

  return next;
}

export function channelAdapterCredentialsComplete(
  values: CockpitChannelEditorValues,
  adapter: CreateChannelAdapter,
): boolean {
  switch (adapter) {
    case "feishu":
      return Boolean(
        values.feishuAppId.trim() && (values.feishuAppSecret.trim() || values.feishuAppSecretSet),
      );
    case "infoflow":
      return Boolean(
        (values.infoflowEndpoint.trim() || DEFAULT_INFOFLOW_ENDPOINT) &&
        values.infoflowAppKey.trim() &&
        values.infoflowAppAgentId.trim() &&
        (values.infoflowAppSecret.trim() || values.infoflowAppSecretSet),
      );
    case "qqbot":
      return Boolean(
        values.qqbotAppId.trim() &&
        (values.qqbotClientSecret.trim() || values.qqbotClientSecretSet),
      );
    default: {
      const _exhaustive: never = adapter;
      throw new Error(`unsupported create-channel adapter: ${String(_exhaustive)}`);
    }
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

export function isFeishuAdapterReady(config: { app_id?: string; app_secret?: string }): boolean {
  return Boolean(config.app_id?.trim() && config.app_secret?.trim());
}

export function isInfoflowAdapterReady(config: {
  endpoint?: string;
  app_key?: string;
  app_agent_id?: string;
  app_secret?: string;
}): boolean {
  return Boolean(
    config.endpoint?.trim() &&
    config.app_key?.trim() &&
    config.app_agent_id?.trim() &&
    config.app_secret?.trim(),
  );
}

export function isQqbotAdapterReady(config: { app_id?: string; client_secret?: string }): boolean {
  return Boolean(config.app_id?.trim() && config.client_secret?.trim());
}

export function channelsConfigIsReady(config: ChannelsConfig | null): boolean {
  if (!config) return false;
  return Object.values(config.adapters).some((adapter) => {
    if (adapter.type === "feishu") return isFeishuAdapterReady(adapter);
    if (adapter.type === "infoflow") return isInfoflowAdapterReady(adapter);
    if (adapter.type === "qqbot") return isQqbotAdapterReady(adapter);
    return false;
  });
}

export function channelEditorValuesFromConfig(
  config: ChannelsConfig | null,
): CockpitChannelEditorValues {
  const defaults = emptyChannelEditorValues();
  if (!config) return defaults;

  const feishuEntry = Object.entries(config.adapters).find(
    ([, adapter]) => adapter.type === "feishu",
  );
  const infoflowEntry = Object.entries(config.adapters).find(
    ([, adapter]) => adapter.type === "infoflow",
  );
  const qqbotEntry = Object.entries(config.adapters).find(
    ([, adapter]) => adapter.type === "qqbot",
  );
  const feishuAdapter = feishuEntry?.[1];
  const infoflowAdapter = infoflowEntry?.[1];
  const qqbotAdapter = qqbotEntry?.[1];
  const routeEntry = Object.entries(config.routes)[0];
  const routeAdapterId = routeEntry?.[1]?.adapter;
  const routeAdapterConfigured = routeAdapterId ? config.adapters[routeAdapterId]?.type : undefined;
  const routeAdapterType: CockpitChannelEditorValues["routeAdapter"] =
    routeAdapterConfigured === "infoflow" ||
    routeAdapterConfigured === "qqbot" ||
    routeAdapterConfigured === "feishu"
      ? routeAdapterConfigured
      : "feishu";

  const feishuReady = feishuAdapter?.type === "feishu" && isFeishuAdapterReady(feishuAdapter);
  const infoflowReady =
    infoflowAdapter?.type === "infoflow" && isInfoflowAdapterReady(infoflowAdapter);
  const qqbotReady = qqbotAdapter?.type === "qqbot" && isQqbotAdapterReady(qqbotAdapter);

  const feishuSecret =
    feishuEntry && feishuEntry[1].type === "feishu" ? (feishuEntry[1].app_secret ?? "") : "";
  const infoflowSecret =
    infoflowEntry && infoflowEntry[1].type === "infoflow"
      ? (infoflowEntry[1].app_secret ?? "")
      : "";
  const qqbotSecret =
    qqbotEntry && qqbotEntry[1].type === "qqbot" ? (qqbotEntry[1].client_secret ?? "") : "";

  return {
    // Incomplete stubs must not force toggles on — that made autosave fail forever.
    feishuEnabled: feishuReady,
    feishuAppId:
      feishuEntry && feishuEntry[1].type === "feishu" ? (feishuEntry[1].app_id ?? "") : "",
    // Never round-trip secrets into HTML; blank means "keep existing" when *Set is true.
    feishuAppSecret: "",
    feishuAppSecretSet: Boolean(feishuSecret.trim()),
    infoflowEnabled: infoflowReady,
    infoflowEndpoint:
      infoflowEntry && infoflowEntry[1].type === "infoflow"
        ? infoflowEntry[1].endpoint?.trim() || DEFAULT_INFOFLOW_ENDPOINT
        : DEFAULT_INFOFLOW_ENDPOINT,
    infoflowAppKey:
      infoflowEntry && infoflowEntry[1].type === "infoflow" ? (infoflowEntry[1].app_key ?? "") : "",
    infoflowAppAgentId:
      infoflowEntry && infoflowEntry[1].type === "infoflow"
        ? (infoflowEntry[1].app_agent_id ?? "")
        : "",
    infoflowAppSecret: "",
    infoflowAppSecretSet: Boolean(infoflowSecret.trim()),
    infoflowAllowedUserIds:
      infoflowEntry && infoflowEntry[1].type === "infoflow"
        ? (infoflowEntry[1].allowed_user_ids ?? []).join(", ")
        : "",
    infoflowGroupPolicy:
      infoflowEntry && infoflowEntry[1].type === "infoflow"
        ? (infoflowEntry[1].group_policy ?? "disabled")
        : "disabled",
    infoflowGroupTrigger:
      infoflowEntry && infoflowEntry[1].type === "infoflow"
        ? (infoflowEntry[1].group_trigger ?? "mention")
        : "mention",
    infoflowAllowedGroupIds:
      infoflowEntry && infoflowEntry[1].type === "infoflow"
        ? (infoflowEntry[1].allowed_group_ids ?? []).join(", ")
        : "",
    infoflowSystemPrompt:
      infoflowEntry && infoflowEntry[1].type === "infoflow"
        ? (infoflowEntry[1].system_prompt ?? "")
        : "",
    qqbotEnabled: qqbotReady,
    qqbotAppId: qqbotEntry && qqbotEntry[1].type === "qqbot" ? (qqbotEntry[1].app_id ?? "") : "",
    qqbotClientSecret: "",
    qqbotClientSecretSet: Boolean(qqbotSecret.trim()),
    qqbotSandbox:
      qqbotEntry && qqbotEntry[1].type === "qqbot"
        ? qqbotEntry[1].api_environment === "sandbox"
        : true,
    qqbotAllowedUserIds:
      qqbotEntry && qqbotEntry[1].type === "qqbot"
        ? (qqbotEntry[1].allowed_user_ids ?? []).join(", ")
        : "",
    qqbotGroupPolicy:
      qqbotEntry && qqbotEntry[1].type === "qqbot"
        ? (qqbotEntry[1].group_policy ?? "disabled")
        : "disabled",
    qqbotGroupTrigger:
      qqbotEntry && qqbotEntry[1].type === "qqbot"
        ? (qqbotEntry[1].group_trigger ?? "mention")
        : "mention",
    qqbotAllowedGroupIds:
      qqbotEntry && qqbotEntry[1].type === "qqbot"
        ? (qqbotEntry[1].allowed_group_ids ?? []).join(", ")
        : "",
    qqbotSystemPrompt:
      qqbotEntry && qqbotEntry[1].type === "qqbot" ? (qqbotEntry[1].system_prompt ?? "") : "",
    routeName: routeEntry?.[0] ?? defaults.routeName,
    routeAdapter: infoflowReady
      ? "infoflow"
      : qqbotReady
        ? "qqbot"
        : feishuReady
          ? "feishu"
          : routeAdapterType,
    routeRecipient: routeEntry?.[1]?.recipient ?? "",
    ingressEnabled: feishuReady || infoflowReady || qqbotReady,
    onUnbound: config.ingress?.on_unbound === "reject" ? "reject" : "create",
  };
}

export function channelsConfigFromEditorValues(
  values: CockpitChannelEditorValues,
  previous: ChannelsConfig | null = null,
): ChannelsConfig {
  const adapters: ChannelsConfig["adapters"] = {};
  const previousFeishu = previous
    ? Object.values(previous.adapters).find((adapter) => adapter.type === "feishu")
    : undefined;
  const previousInfoflow = previous
    ? Object.values(previous.adapters).find((adapter) => adapter.type === "infoflow")
    : undefined;
  const previousQqbot = previous
    ? Object.values(previous.adapters).find((adapter) => adapter.type === "qqbot")
    : undefined;

  if (values.feishuEnabled) {
    const appSecret =
      values.feishuAppSecret.trim() ||
      (values.feishuAppSecretSet && previousFeishu?.type === "feishu"
        ? (previousFeishu.app_secret?.trim() ?? "")
        : "") ||
      "";
    adapters.feishu = {
      type: "feishu",
      event_mode: "websocket",
      ...(values.feishuAppId.trim() ? { app_id: values.feishuAppId.trim() } : {}),
      ...(appSecret ? { app_secret: appSecret } : {}),
    };
  }
  if (values.infoflowEnabled) {
    const endpoint = values.infoflowEndpoint.trim() || DEFAULT_INFOFLOW_ENDPOINT;
    const appSecret =
      values.infoflowAppSecret.trim() ||
      (values.infoflowAppSecretSet && previousInfoflow?.type === "infoflow"
        ? (previousInfoflow.app_secret?.trim() ?? "")
        : "") ||
      "";
    adapters.infoflow = {
      type: "infoflow",
      endpoint,
      ...(values.infoflowAppKey.trim() ? { app_key: values.infoflowAppKey.trim() } : {}),
      ...(values.infoflowAppAgentId.trim()
        ? { app_agent_id: values.infoflowAppAgentId.trim() }
        : {}),
      ...(appSecret ? { app_secret: appSecret } : {}),
      ...(previousInfoflow?.type === "infoflow" && previousInfoflow.ws_gateway
        ? { ws_gateway: previousInfoflow.ws_gateway }
        : {}),
      ...(previousInfoflow?.type === "infoflow" && previousInfoflow.connection_mode
        ? { connection_mode: previousInfoflow.connection_mode }
        : { connection_mode: "websocket" }),
      ...(parseIdList(values.infoflowAllowedUserIds).length > 0
        ? { allowed_user_ids: parseIdList(values.infoflowAllowedUserIds) }
        : {}),
      group_policy: values.infoflowGroupPolicy,
      group_trigger: values.infoflowGroupTrigger,
      ...(values.infoflowGroupPolicy === "allowlist" &&
      parseIdList(values.infoflowAllowedGroupIds).length > 0
        ? { allowed_group_ids: parseIdList(values.infoflowAllowedGroupIds) }
        : values.infoflowGroupPolicy === "allowlist"
          ? { allowed_group_ids: [] }
          : {}),
      ...(values.infoflowSystemPrompt.trim()
        ? { system_prompt: values.infoflowSystemPrompt.trim() }
        : {}),
    };
  }
  if (values.qqbotEnabled) {
    const clientSecret =
      values.qqbotClientSecret.trim() ||
      (values.qqbotClientSecretSet && previousQqbot?.type === "qqbot"
        ? (previousQqbot.client_secret?.trim() ?? "")
        : "") ||
      "";
    adapters.qqbot = {
      type: "qqbot",
      connection_mode: "websocket",
      api_environment: values.qqbotSandbox ? "sandbox" : "production",
      ...(values.qqbotAppId.trim() ? { app_id: values.qqbotAppId.trim() } : {}),
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      ...(parseIdList(values.qqbotAllowedUserIds).length > 0
        ? { allowed_user_ids: parseIdList(values.qqbotAllowedUserIds) }
        : {}),
      group_policy: values.qqbotGroupPolicy,
      group_trigger: values.qqbotGroupTrigger,
      ...(values.qqbotGroupPolicy === "allowlist" &&
      parseIdList(values.qqbotAllowedGroupIds).length > 0
        ? { allowed_group_ids: parseIdList(values.qqbotAllowedGroupIds) }
        : values.qqbotGroupPolicy === "allowlist"
          ? { allowed_group_ids: [] }
          : {}),
      ...(values.qqbotSystemPrompt.trim()
        ? { system_prompt: values.qqbotSystemPrompt.trim() }
        : {}),
    };
  }

  const routes: ChannelsConfig["routes"] = {};
  const routeName = values.routeName.trim() || "ops";
  const routeRecipient = values.routeRecipient.trim();
  const routeAdapter =
    values.routeAdapter === "infoflow" && adapters.infoflow
      ? "infoflow"
      : values.routeAdapter === "qqbot" && adapters.qqbot
        ? "qqbot"
        : adapters.feishu
          ? "feishu"
          : adapters.infoflow
            ? "infoflow"
            : adapters.qqbot
              ? "qqbot"
              : values.routeAdapter;

  if (routeRecipient) {
    routes[routeName] = {
      adapter: routeAdapter,
      recipient: routeRecipient,
    };
  }

  return {
    adapters,
    routes,
    ingress: {
      // Channel enable/disable is the adapter toggle; inbound follows automatically.
      enabled: Boolean(adapters.feishu || adapters.infoflow || adapters.qqbot),
      on_unbound: values.onUnbound,
    },
  };
}

export async function saveChannelsConfigForCockpit(
  workspaceId: string,
  values: CockpitChannelEditorValues,
  client: CockpitChannelDaemonClient = defaultCockpitChannelDaemonClient,
): Promise<{
  path: string;
  config: ChannelsConfig;
  status: CockpitChannelStatusSnapshot;
}> {
  const previous = (await loadChannelsConfigForCockpit(workspaceId)).config;
  const config = parseChannelsConfig(channelsConfigFromEditorValues(values, previous));
  const status = channelStatusFromDaemon(await client.configure(workspaceId, config));
  return { path: status.configPath, config, status };
}

export async function loadChannelStatusForCockpit(
  workspaceId: string,
  client: CockpitChannelDaemonClient = defaultCockpitChannelDaemonClient,
): Promise<CockpitChannelStatusSnapshot> {
  try {
    return channelStatusFromDaemon(await client.status(workspaceId));
  } catch (error) {
    if (!(error instanceof SparkDaemonLocalRpcUnavailableError)) throw error;
    return {
      workspaceId,
      configPath: channelsConfigPath(workspaceId),
      available: false,
      configured: false,
      ingressEnabled: false,
      state: "unavailable",
      adapters: [],
      routes: [],
      observedAt: new Date().toISOString(),
      error: error.message,
      text: `channel runtime unavailable: ${error.message}`,
    };
  }
}

const defaultCockpitChannelDaemonClient: CockpitChannelDaemonClient = {
  status: async (workspaceId) =>
    await requestSparkDaemonLocalRpc("channel.status", { workspaceId }),
  configure: async (workspaceId, config) =>
    await requestSparkDaemonLocalRpc("channel.configure", { workspaceId, config }),
};

function channelStatusFromDaemon(value: unknown): CockpitChannelStatusSnapshot {
  if (
    !isRecord(value) ||
    value.plane !== "daemon" ||
    value.resource !== "channel" ||
    value.available !== true ||
    typeof value.workspaceId !== "string" ||
    typeof value.configPath !== "string" ||
    typeof value.configured !== "boolean" ||
    typeof value.ingressEnabled !== "boolean" ||
    !isRuntimeState(value.state) ||
    !Array.isArray(value.adapters) ||
    !Array.isArray(value.routes) ||
    typeof value.text !== "string"
  ) {
    throw new Error("Invalid Spark daemon channel status response.");
  }
  return {
    workspaceId: value.workspaceId,
    configPath: value.configPath,
    available: true,
    configured: value.configured,
    ingressEnabled: value.ingressEnabled,
    state: value.state,
    adapters: value.adapters.map(channelAdapterStatus),
    routes: value.routes.map(channelRouteStatus),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : new Date().toISOString(),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    text: value.text,
  };
}

function channelAdapterStatus(value: unknown): CockpitChannelStatusSnapshot["adapters"][number] {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    typeof value.running !== "boolean"
  ) {
    throw new Error("Invalid Spark daemon channel adapter status.");
  }
  const state = isConnectionState(value.state)
    ? value.state
    : value.running
      ? "connected"
      : "stopped";
  return {
    id: value.id,
    type: value.type,
    running: value.running,
    state,
    ...(typeof value.error === "string" && value.error.trim() ? { error: value.error } : {}),
  };
}

function isConnectionState(
  value: unknown,
): value is CockpitChannelStatusSnapshot["adapters"][number]["state"] {
  return (
    value === "stopped" ||
    value === "connecting" ||
    value === "connected" ||
    value === "reconnecting" ||
    value === "degraded"
  );
}

function channelRouteStatus(value: unknown): CockpitChannelStatusSnapshot["routes"][number] {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.adapter !== "string" ||
    typeof value.recipient !== "string"
  ) {
    throw new Error("Invalid Spark daemon channel route status.");
  }
  return { name: value.name, adapter: value.adapter, recipient: value.recipient };
}

function isRuntimeState(
  value: unknown,
): value is Exclude<CockpitChannelStatusSnapshot["state"], "unavailable"> {
  return (
    value === "unconfigured" || value === "running" || value === "stopped" || value === "degraded"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIdList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
