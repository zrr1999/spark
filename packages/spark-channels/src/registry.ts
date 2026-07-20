import { FeishuAdapter } from "./feishu-adapter.ts";
import { createHash, randomUUID } from "node:crypto";
import { InfoflowAdapter } from "./infoflow-adapter.ts";
import type {
  ChannelAskRequest,
  ChannelAskSendResult,
  ChannelInteractionAckStatus,
} from "./interaction.ts";
import { QqbotAdapter } from "./qqbot-adapter.ts";
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
import {
  channelDeliveryNotSent,
  normalizeChannelDeliveryResult,
  requireChannelDeliveryId,
  type ChannelDeliveryFacts,
  type ChannelDeliveryResult,
  type ChannelMessageSendInput,
  type ChannelMessageTarget,
  type ChannelReplyRecovery,
  type ChannelReplySendInput,
  type ChannelReplyStream,
  type ChannelReplyTarget,
} from "./reply.ts";

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
    return [...this.adapters.values()].some((adapter) => adapter.runtimeCapable !== false);
  }

  get onUnboundPolicy(): "reject" | "create" {
    return this.options.config.ingress?.on_unbound ?? "create";
  }

  listAdapters() {
    return [...this.adapters.values()].map((adapter) => {
      const config = this.options.config.adapters[adapter.id];
      return {
        ...adapter.status(),
        ...(config ? { adapterAccountIdentity: channelAdapterAccountIdentity(config) } : {}),
        running: this.running.has(adapter.id),
      };
    });
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
      if (adapter.runtimeCapable === false) continue;
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
    if (adapter.runtimeCapable === false) {
      throw new ChannelRegistryError(
        "adapter_unavailable",
        `adapter does not have a runtime transport: ${adapterId}`,
      );
    }
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
    options: { onCreated?: (stream: ChannelReplyStream) => void | Promise<void> } = {},
  ): Promise<ChannelReplyStream | undefined> {
    let adapter: ChannelAdapter;
    try {
      adapter = this.requireAdapter(adapterId);
    } catch (error) {
      throw channelDeliveryNotSent(error);
    }
    const stream = await adapter.reply?.openReplyStream(target);
    if (!stream || !options.onCreated) return stream;
    try {
      await options.onCreated(stream);
    } catch (error) {
      try {
        await stream.fail("无法开始处理，请重新发送");
      } catch (closeError) {
        console.error("[spark-channels] failed to close undurable reply stream", closeError);
      }
      throw error;
    }
    return stream;
  }

  messageDeliveryFacts(adapterId: string, target: ChannelMessageTarget): ChannelDeliveryFacts {
    const adapter = this.requireAdapter(adapterId);
    return adapter.messageDeliveryFacts?.(target) ?? { replaySafety: "unsafe" };
  }

  async sendMessage(
    adapterId: string,
    input: ChannelMessageSendInput,
  ): Promise<ChannelDeliveryResult> {
    let adapter: ChannelAdapter;
    let facts: ChannelDeliveryFacts;
    let deliveryId: string;
    try {
      deliveryId = requireChannelDeliveryId(input.deliveryId);
      adapter = this.requireAdapter(adapterId);
      facts = adapter.messageDeliveryFacts?.(input) ?? { replaySafety: "unsafe" };
    } catch (error) {
      throw channelDeliveryNotSent(error);
    }
    return normalizeChannelDeliveryResult(await adapter.send({ ...input, deliveryId }), facts);
  }

  replyDeliveryFacts(adapterId: string, target: ChannelReplyTarget): ChannelDeliveryFacts {
    const adapter = this.requireAdapter(adapterId);
    return (
      adapter.reply?.deliveryFacts?.(target) ??
      adapter.messageDeliveryFacts?.(target) ?? { replaySafety: "unsafe" }
    );
  }

  async sendReply(adapterId: string, input: ChannelReplySendInput): Promise<ChannelDeliveryResult> {
    let adapter: ChannelAdapter;
    let facts: ChannelDeliveryFacts;
    let deliveryId: string;
    try {
      deliveryId = requireChannelDeliveryId(input.deliveryId);
      adapter = this.requireAdapter(adapterId);
      facts = adapter.reply?.deliveryFacts?.(input) ??
        adapter.messageDeliveryFacts?.(input) ?? { replaySafety: "unsafe" };
    } catch (error) {
      throw channelDeliveryNotSent(error);
    }
    if (adapter.reply) {
      return normalizeChannelDeliveryResult(
        await adapter.reply.sendReply({ ...input, deliveryId }),
        facts,
      );
    }
    return normalizeChannelDeliveryResult(await adapter.send({ ...input, deliveryId }), facts);
  }

  async recoverReply(
    adapterId: string,
    input: ChannelReplyTarget & {
      text: string;
      deliveryId: string;
      recovery: ChannelReplyRecovery;
    },
  ): Promise<void> {
    const reply = this.requireAdapter(adapterId).reply;
    if (!reply?.recoverReply) {
      throw new ChannelRegistryError(
        "unsupported_operation",
        `adapter ${adapterId} cannot recover an interrupted streamed reply`,
      );
    }
    await reply.recoverReply(input);
  }

  async sendAsk(
    adapterId: string,
    recipient: string,
    request: ChannelAskRequest,
  ): Promise<ChannelAskSendResult> {
    const interaction = this.requireAdapter(adapterId).interaction;
    if (!interaction) {
      throw new ChannelRegistryError(
        "interaction_not_supported",
        `adapter does not support native interactions: ${adapterId}`,
      );
    }
    return await interaction.sendAsk(recipient, request);
  }

  async ackInteraction(
    adapterId: string,
    interactionId: string,
    status: ChannelInteractionAckStatus = "success",
  ): Promise<void> {
    const interaction = this.requireAdapter(adapterId).interaction;
    if (!interaction) {
      throw new ChannelRegistryError(
        "interaction_not_supported",
        `adapter does not support native interactions: ${adapterId}`,
      );
    }
    await interaction.ackInteraction(interactionId, status);
  }

  private loadConfig(config: ChannelsConfig): void {
    for (const [adapterId, adapterConfig] of Object.entries(config.adapters)) {
      const adapter = this.createAdapter(adapterId, adapterConfig);
      this.registerAdapter(adapter);
    }
  }

  private createAdapter(adapterId: string, config: ChannelAdapterConfig): ChannelAdapter {
    const transport = this.options.createTransport?.(adapterId, config);
    const handleMessage = this.options.onMessage;
    const adapterAccountIdentity = channelAdapterAccountIdentity(config);
    const onMessage = handleMessage
      ? (message: IncomingMessage) =>
          handleMessage({ ...message, adapterId, adapterAccountIdentity })
      : undefined;
    const onInteraction = this.options.onInteraction;
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
      case "qqbot":
        return new QqbotAdapter({
          id: adapterId,
          config,
          ...(transport ? { transport } : {}),
          ...(onMessage ? { onMessage } : {}),
          ...(onInteraction ? { onInteraction } : {}),
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
    const deliveryId = input.deliveryId?.trim() || `channel.notify:${randomUUID()}`;
    const adapter = this.requireAdapter(target.adapterId);
    const delivery = input.image
      ? await this.sendNotifyImage(adapter, target.recipient, input, deliveryId)
      : await this.sendMessage(target.adapterId, {
          recipient: target.recipient,
          text,
          deliveryId,
        });
    return {
      action: input.action === "test" ? "test" : "send",
      adapter: target.adapterId,
      recipient: target.recipient,
      text,
      ...(input.image ? { image: channelNotifyImageSummary(input.image) } : {}),
      deliveryId,
      delivery,
      deliverySemantics: "one-shot",
    };
  }

  private async sendNotifyImage(
    adapter: ChannelAdapter,
    recipient: string,
    input: ChannelNotifyInput,
    deliveryId: string,
  ): Promise<ChannelDeliveryResult> {
    if (!adapter.image) {
      throw new ChannelRegistryError(
        "image_not_supported",
        `adapter does not support image messages: ${adapter.id}`,
      );
    }
    const facts = adapter.messageDeliveryFacts?.({ recipient }) ?? { replaySafety: "unsafe" };
    return normalizeChannelDeliveryResult(
      await adapter.image.sendImage({
        recipient,
        image: input.image!,
        ...(input.text?.trim() ? { caption: input.text.trim() } : {}),
        deliveryId,
      }),
      facts,
    );
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

function channelNotifyImageSummary(image: NonNullable<ChannelNotifyInput["image"]>): {
  source: "url" | "data";
  mediaType?: string;
  name?: string;
} {
  return {
    source: image.url?.trim() ? "url" : "data",
    ...(image.mediaType?.trim() ? { mediaType: image.mediaType.trim() } : {}),
    ...(image.name?.trim() ? { name: image.name.trim() } : {}),
  };
}

/**
 * Rename-stable account identity for inbound idempotency and account routing.
 * Secrets and the operator-owned adapter key deliberately do not participate.
 */
export function channelAdapterAccountIdentity(config: ChannelAdapterConfig): string {
  const publicIdentity = (() => {
    switch (config.type) {
      case "feishu":
        return [config.app_id?.trim() ?? ""];
      case "infoflow":
        return [config.app_key?.trim() ?? "", config.app_agent_id?.trim() ?? ""];
      case "qqbot":
        return [config.app_id?.trim() ?? "", config.api_environment ?? "production"];
    }
  })();
  const digest = createHash("sha256")
    .update(JSON.stringify([1, config.type, ...publicIdentity]))
    .digest("hex");
  return `channel-account:${config.type}:${digest}`;
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
        ? {
            allowed_user_ids: parseStringList(record.allowed_user_ids, "infoflow.allowed_user_ids"),
          }
        : {}),
      ...(record.group_policy !== undefined
        ? { group_policy: parseGroupPolicy(record.group_policy, "infoflow") }
        : {}),
      ...(record.group_trigger !== undefined
        ? { group_trigger: parseGroupTrigger(record.group_trigger, "infoflow") }
        : {}),
      ...(record.allowed_group_ids !== undefined
        ? {
            allowed_group_ids: parseStringList(
              record.allowed_group_ids,
              "infoflow.allowed_group_ids",
            ),
          }
        : {}),
      ...(typeof record.system_prompt === "string" && record.system_prompt.trim()
        ? { system_prompt: record.system_prompt.trim() }
        : {}),
    };
  }
  if (type === "qqbot") {
    if (record.connection_mode !== undefined && record.connection_mode !== "websocket") {
      throw new ChannelRegistryError("invalid_config", "qqbot.connection_mode must be websocket");
    }
    if (
      record.api_environment !== undefined &&
      record.api_environment !== "production" &&
      record.api_environment !== "sandbox"
    ) {
      throw new ChannelRegistryError(
        "invalid_config",
        "qqbot.api_environment must be production or sandbox",
      );
    }
    return {
      type: "qqbot",
      ...(typeof record.app_id === "string" ? { app_id: record.app_id } : {}),
      ...(typeof record.client_secret === "string" ? { client_secret: record.client_secret } : {}),
      ...(record.connection_mode === "websocket" ? { connection_mode: "websocket" } : {}),
      ...(record.api_environment === "production" || record.api_environment === "sandbox"
        ? { api_environment: record.api_environment }
        : {}),
      ...(record.allowed_user_ids !== undefined
        ? {
            allowed_user_ids: parseStringList(record.allowed_user_ids, "qqbot.allowed_user_ids"),
          }
        : {}),
      ...(record.group_policy !== undefined
        ? { group_policy: parseGroupPolicy(record.group_policy, "qqbot") }
        : {}),
      ...(record.group_trigger !== undefined
        ? { group_trigger: parseGroupTrigger(record.group_trigger, "qqbot") }
        : {}),
      ...(record.allowed_group_ids !== undefined
        ? {
            allowed_group_ids: parseStringList(record.allowed_group_ids, "qqbot.allowed_group_ids"),
          }
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

function parseGroupPolicy(
  value: unknown,
  adapter: "infoflow" | "qqbot",
): "disabled" | "allowlist" | "open" {
  if (value === "disabled" || value === "allowlist" || value === "open") {
    return value;
  }
  throw new ChannelRegistryError(
    "invalid_config",
    `${adapter}.group_policy must be disabled, allowlist, or open`,
  );
}

function parseGroupTrigger(
  value: unknown,
  adapter: "infoflow" | "qqbot",
): "mention" | "command" | "all" {
  if (value === "mention" || value === "command" || value === "all") return value;
  throw new ChannelRegistryError(
    "invalid_config",
    `${adapter}.group_trigger must be mention, command, or all`,
  );
}

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ChannelRegistryError("invalid_config", `${field} must be an array of strings`);
  }
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new ChannelRegistryError(
        "invalid_config",
        `${field} must be an array of non-empty strings`,
      );
    }
    items.push(entry.trim());
  }
  return items;
}

export type { IncomingMessage, ChannelTransport };
