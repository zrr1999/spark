import { FeishuAdapter } from "./feishu-adapter.ts";
import { InfoflowAdapter } from "./infoflow-adapter.ts";
import type {
  ChannelAdapter,
  ChannelAdapterConfig,
  ChannelNotifyInput,
  ChannelNotifyResult,
  ChannelRegistryOptions,
  ChannelRouteConfig,
  ChannelsConfig,
  ChannelTransport,
  IncomingMessage,
  ResolvedChannelRoute,
} from "./types.ts";
import type { ChannelReplyStream, ChannelReplyTarget } from "./reply.ts";

export class ChannelRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ChannelRegistryError";
    this.code = code;
  }
}

export class ChannelRegistry {
  private readonly options: ChannelRegistryOptions;
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly running = new Set<string>();

  constructor(options: ChannelRegistryOptions) {
    this.options = options;
    this.loadConfig(options.config);
  }

  get ingressEnabled(): boolean {
    // Channel enable/disable is adapter presence; inbound follows that (default on when configured).
    return this.adapters.size > 0;
  }

  get onUnboundPolicy(): "reject" | "create" {
    return this.options.config.ingress?.on_unbound ?? "create";
  }

  listAdapters() {
    return [...this.adapters.values()].map((adapter) => ({
      ...adapter.status(),
      running: this.running.has(adapter.id),
    }));
  }

  resolveRoute(name: string): ResolvedChannelRoute {
    const route = this.options.config.routes[name];
    if (!route) {
      throw new ChannelRegistryError("route_not_found", `unknown route: ${name}`);
    }
    return this.resolveRouteConfig(name, route);
  }

  listRoutes(): ResolvedChannelRoute[] {
    return Object.entries(this.options.config.routes).map(([name, route]) =>
      this.resolveRouteConfig(name, route),
    );
  }

  getAdapter(adapterId: string): ChannelAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  registerAdapter(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new ChannelRegistryError("adapter_exists", `adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  async startAll(): Promise<void> {
    if (!this.ingressEnabled) return;
    for (const adapter of this.adapters.values()) {
      await this.startAdapter(adapter.id);
    }
  }

  async stopAll(): Promise<void> {
    for (const adapterId of [...this.running]) {
      await this.stopAdapter(adapterId);
    }
  }

  async startAdapter(adapterId: string): Promise<void> {
    const adapter = this.requireAdapter(adapterId);
    if (this.running.has(adapterId)) return;
    await adapter.start();
    this.running.add(adapterId);
  }

  async stopAdapter(adapterId: string): Promise<void> {
    const adapter = this.requireAdapter(adapterId);
    if (!this.running.has(adapterId)) return;
    await adapter.stop();
    this.running.delete(adapterId);
  }

  async notify(input: ChannelNotifyInput): Promise<ChannelNotifyResult> {
    switch (input.action) {
      case "list":
        return {
          action: "list",
          adapters: this.listAdapters(),
          routes: this.listRoutes(),
        };
      case "send":
        return await this.notifySend(input, input.text ?? "");
      case "test":
        return await this.notifySend(input, input.text ?? "Spark channel test");
      default: {
        const unexpected = String(input.action);
        throw new ChannelRegistryError(
          "invalid_action",
          `unsupported notify action: ${unexpected}`,
        );
      }
    }
  }

  async openReplyStream(
    adapterId: string,
    target: ChannelReplyTarget,
  ): Promise<ChannelReplyStream | undefined> {
    return await this.requireAdapter(adapterId).reply?.openReplyStream(target);
  }

  async sendReply(adapterId: string, input: ChannelReplyTarget & { text: string }): Promise<void> {
    const adapter = this.requireAdapter(adapterId);
    if (adapter.reply) {
      await adapter.reply.sendReply(input);
      return;
    }
    await adapter.send({ recipient: input.recipient, text: input.text });
  }

  private loadConfig(config: ChannelsConfig): void {
    for (const [adapterId, adapterConfig] of Object.entries(config.adapters)) {
      const adapter = this.createAdapter(adapterId, adapterConfig);
      this.registerAdapter(adapter);
    }
  }

  private createAdapter(adapterId: string, config: ChannelAdapterConfig): ChannelAdapter {
    const transport = this.options.createTransport?.(adapterId, config);
    const onMessage = this.options.onMessage;
    switch (config.type) {
      case "feishu":
        return new FeishuAdapter({
          id: adapterId,
          config,
          ...(transport ? { transport } : {}),
          ...(onMessage ? { onMessage } : {}),
        });
      case "infoflow":
        return new InfoflowAdapter({
          id: adapterId,
          config,
          ...(transport ? { transport } : {}),
          ...(onMessage ? { onMessage } : {}),
        });
      default: {
        const unexpected: never = config;
        throw new ChannelRegistryError(
          "unsupported_adapter",
          `unsupported adapter config: ${(unexpected as ChannelAdapterConfig).type}`,
        );
      }
    }
  }

  private resolveRouteConfig(name: string, route: ChannelRouteConfig): ResolvedChannelRoute {
    const adapter = this.requireAdapter(route.adapter);
    return {
      name,
      adapterId: adapter.id,
      adapterType: adapter.type,
      recipient: route.recipient,
    };
  }

  private requireAdapter(adapterId: string): ChannelAdapter {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new ChannelRegistryError("adapter_not_found", `unknown adapter: ${adapterId}`);
    }
    return adapter;
  }

  private async notifySend(input: ChannelNotifyInput, text: string): Promise<ChannelNotifyResult> {
    const target = this.resolveNotifyTarget(input);
    const adapter = this.requireAdapter(target.adapterId);
    await adapter.send({ recipient: target.recipient, text });
    return {
      action: input.action === "test" ? "test" : "send",
      adapter: adapter.id,
      recipient: target.recipient,
      text,
    };
  }

  private resolveNotifyTarget(input: ChannelNotifyInput): {
    adapterId: string;
    recipient: string;
  } {
    if (input.route) {
      const route = this.resolveRoute(input.route);
      return { adapterId: route.adapterId, recipient: route.recipient };
    }
    if (!input.adapter) {
      throw new ChannelRegistryError(
        "adapter_required",
        "notify send/test requires adapter or route",
      );
    }
    const adapter = this.requireAdapter(input.adapter);
    const recipient = input.recipient ?? this.defaultRecipientForAdapter(adapter.id);
    if (!recipient) {
      throw new ChannelRegistryError(
        "recipient_required",
        `notify send/test requires recipient for adapter ${adapter.id}`,
      );
    }
    return { adapterId: adapter.id, recipient };
  }

  private defaultRecipientForAdapter(adapterId: string): string | undefined {
    const route = Object.values(this.options.config.routes).find(
      (entry) => entry.adapter === adapterId,
    );
    return route?.recipient;
  }
}

export function parseChannelsConfig(value: unknown): ChannelsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChannelRegistryError("invalid_config", "channels config must be an object");
  }
  const record = value as Record<string, unknown>;
  const adapters = record.adapters;
  const routes = record.routes;
  if (!adapters || typeof adapters !== "object" || Array.isArray(adapters)) {
    throw new ChannelRegistryError("invalid_config", "channels.adapters must be an object");
  }
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) {
    throw new ChannelRegistryError("invalid_config", "channels.routes must be an object");
  }
  const parsedAdapters: ChannelsConfig["adapters"] = {};
  for (const [id, config] of Object.entries(adapters as Record<string, unknown>)) {
    parsedAdapters[id] = parseAdapterConfig(config);
  }
  const parsedRoutes: ChannelsConfig["routes"] = {};
  for (const [name, route] of Object.entries(routes as Record<string, unknown>)) {
    parsedRoutes[name] = parseRouteConfig(route);
  }
  const ingress = record.ingress;
  return {
    adapters: parsedAdapters,
    routes: parsedRoutes,
    ...(ingress && typeof ingress === "object" && !Array.isArray(ingress)
      ? { ingress: parseIngressConfig(ingress as Record<string, unknown>) }
      : {}),
  };
}

function parseAdapterConfig(value: unknown): ChannelAdapterConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChannelRegistryError("invalid_config", "adapter config must be an object");
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type === "feishu") {
    if (record.event_mode !== undefined && record.event_mode !== "websocket") {
      throw new ChannelRegistryError("invalid_config", "feishu.event_mode must be websocket");
    }
    return {
      type: "feishu",
      ...(record.event_mode === "websocket" ? { event_mode: "websocket" } : {}),
      ...(typeof record.app_id === "string" ? { app_id: record.app_id } : {}),
      ...(typeof record.app_secret === "string" ? { app_secret: record.app_secret } : {}),
    };
  }
  if (type === "infoflow") {
    return {
      type: "infoflow",
      ...(typeof record.endpoint === "string" ? { endpoint: record.endpoint } : {}),
      ...(typeof record.app_key === "string" ? { app_key: record.app_key } : {}),
      ...(typeof record.app_secret === "string" ? { app_secret: record.app_secret } : {}),
      ...(typeof record.app_agent_id === "string" || typeof record.app_agent_id === "number"
        ? { app_agent_id: String(record.app_agent_id) }
        : {}),
      ...(typeof record.ws_gateway === "string" ? { ws_gateway: record.ws_gateway } : {}),
      ...(record.connection_mode === "websocket" ? { connection_mode: "websocket" } : {}),
      ...(record.allowed_user_ids !== undefined
        ? { allowed_user_ids: parseStringList(record.allowed_user_ids, "allowed_user_ids") }
        : {}),
      ...(record.group_policy !== undefined
        ? { group_policy: parseInfoflowGroupPolicy(record.group_policy) }
        : {}),
      ...(record.group_trigger !== undefined
        ? { group_trigger: parseInfoflowGroupTrigger(record.group_trigger) }
        : {}),
      ...(record.allowed_group_ids !== undefined
        ? { allowed_group_ids: parseStringList(record.allowed_group_ids, "allowed_group_ids") }
        : {}),
      ...(typeof record.system_prompt === "string" && record.system_prompt.trim()
        ? { system_prompt: record.system_prompt.trim() }
        : {}),
    };
  }
  throw new ChannelRegistryError("invalid_config", `unsupported adapter type: ${String(type)}`);
}

function parseRouteConfig(value: unknown): ChannelRouteConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChannelRegistryError("invalid_config", "route config must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.adapter !== "string" || !record.adapter.trim()) {
    throw new ChannelRegistryError("invalid_config", "route.adapter must be a non-empty string");
  }
  if (typeof record.recipient !== "string" || !record.recipient.trim()) {
    throw new ChannelRegistryError("invalid_config", "route.recipient must be a non-empty string");
  }
  return { adapter: record.adapter, recipient: record.recipient };
}

function parseIngressConfig(record: Record<string, unknown>): ChannelsConfig["ingress"] {
  if (typeof record.enabled !== "boolean") {
    throw new ChannelRegistryError("invalid_config", "ingress.enabled must be a boolean");
  }
  const onUnbound = record.on_unbound;
  if (onUnbound !== undefined && onUnbound !== "reject" && onUnbound !== "create") {
    throw new ChannelRegistryError("invalid_config", "ingress.on_unbound must be reject or create");
  }
  return {
    enabled: record.enabled,
    ...(onUnbound ? { on_unbound: onUnbound } : {}),
  };
}

function parseInfoflowGroupPolicy(value: unknown): "disabled" | "allowlist" | "open" {
  if (value === "disabled" || value === "allowlist" || value === "open") {
    return value;
  }
  throw new ChannelRegistryError(
    "invalid_config",
    "infoflow.group_policy must be disabled, allowlist, or open",
  );
}

function parseInfoflowGroupTrigger(value: unknown): "mention" | "command" | "all" {
  if (value === "mention" || value === "command" || value === "all") return value;
  throw new ChannelRegistryError(
    "invalid_config",
    "infoflow.group_trigger must be mention, command, or all",
  );
}

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ChannelRegistryError(
      "invalid_config",
      `infoflow.${field} must be an array of strings`,
    );
  }
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new ChannelRegistryError(
        "invalid_config",
        `infoflow.${field} must be an array of non-empty strings`,
      );
    }
    items.push(entry.trim());
  }
  return items;
}

export type { IncomingMessage, ChannelTransport };
