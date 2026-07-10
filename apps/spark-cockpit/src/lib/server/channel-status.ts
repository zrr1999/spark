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

export interface CockpitChannelStatusSnapshot {
  workspaceId: string;
  configPath: string;
  available: boolean;
  configured: boolean;
  ingressEnabled: boolean;
  state: "unavailable" | "unconfigured" | "running" | "stopped" | "degraded";
  adapters: Array<{ id: string; type: string; running: boolean }>;
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
  /** Comma/space-separated group ids when policy is allowlist. */
  infoflowAllowedGroupIds: string;
  routeName: string;
  routeAdapter: "feishu" | "infoflow";
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
    infoflowAllowedGroupIds: "",
    routeName: "ops",
    routeAdapter: "infoflow",
    routeRecipient: "",
    // Derived from adapter enable; kept for form/status compatibility.
    ingressEnabled: false,
    onUnbound: "create",
  };
}

export function channelEditorCredentialsComplete(values: CockpitChannelEditorValues): boolean {
  if (!values.feishuEnabled && !values.infoflowEnabled) return false;
  if (
    values.feishuEnabled &&
    (!values.feishuAppId.trim() || !(values.feishuAppSecret.trim() || values.feishuAppSecretSet))
  ) {
    return false;
  }
  if (
    values.infoflowEnabled &&
    (!(values.infoflowEndpoint.trim() || DEFAULT_INFOFLOW_ENDPOINT) ||
      !values.infoflowAppKey.trim() ||
      !(values.infoflowAppSecret.trim() || values.infoflowAppSecretSet))
  ) {
    return false;
  }
  return true;
}

export function isFeishuAdapterReady(config: { app_id?: string; app_secret?: string }): boolean {
  return Boolean(config.app_id?.trim() && config.app_secret?.trim());
}

export function isInfoflowAdapterReady(config: {
  endpoint?: string;
  app_key?: string;
  app_secret?: string;
}): boolean {
  return Boolean(config.endpoint?.trim() && config.app_key?.trim() && config.app_secret?.trim());
}

export function channelsConfigIsReady(config: ChannelsConfig | null): boolean {
  if (!config) return false;
  return Object.values(config.adapters).some((adapter) => {
    if (adapter.type === "feishu") return isFeishuAdapterReady(adapter);
    if (adapter.type === "infoflow") return isInfoflowAdapterReady(adapter);
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
  const feishuAdapter = feishuEntry?.[1];
  const infoflowAdapter = infoflowEntry?.[1];
  const routeEntry = Object.entries(config.routes)[0];
  const routeAdapterId = routeEntry?.[1]?.adapter;
  const routeAdapterType =
    routeAdapterId && config.adapters[routeAdapterId]?.type === "infoflow" ? "infoflow" : "feishu";

  const feishuReady = feishuAdapter?.type === "feishu" && isFeishuAdapterReady(feishuAdapter);
  const infoflowReady =
    infoflowAdapter?.type === "infoflow" && isInfoflowAdapterReady(infoflowAdapter);

  const feishuSecret =
    feishuEntry && feishuEntry[1].type === "feishu" ? (feishuEntry[1].app_secret ?? "") : "";
  const infoflowSecret =
    infoflowEntry && infoflowEntry[1].type === "infoflow"
      ? (infoflowEntry[1].app_secret ?? "")
      : "";

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
    infoflowAllowedGroupIds:
      infoflowEntry && infoflowEntry[1].type === "infoflow"
        ? (infoflowEntry[1].allowed_group_ids ?? []).join(", ")
        : "",
    routeName: routeEntry?.[0] ?? defaults.routeName,
    routeAdapter: infoflowReady
      ? "infoflow"
      : feishuReady
        ? "feishu"
        : routeAdapterType === "infoflow"
          ? "infoflow"
          : defaults.routeAdapter,
    routeRecipient: routeEntry?.[1]?.recipient ?? "",
    ingressEnabled: feishuReady || infoflowReady,
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
      ...(values.infoflowGroupPolicy === "allowlist" &&
      parseIdList(values.infoflowAllowedGroupIds).length > 0
        ? { allowed_group_ids: parseIdList(values.infoflowAllowedGroupIds) }
        : values.infoflowGroupPolicy === "allowlist"
          ? { allowed_group_ids: [] }
          : {}),
    };
  }

  const routes: ChannelsConfig["routes"] = {};
  const routeName = values.routeName.trim() || "ops";
  const routeRecipient = values.routeRecipient.trim();
  const routeAdapter =
    values.routeAdapter === "infoflow" && adapters.infoflow
      ? "infoflow"
      : adapters.feishu
        ? "feishu"
        : values.routeAdapter === "infoflow"
          ? "infoflow"
          : "feishu";

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
      enabled: Boolean(adapters.feishu || adapters.infoflow),
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
  return { id: value.id, type: value.type, running: value.running };
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
