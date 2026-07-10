import type { SparkChannelAdapter } from "@zendev-lab/spark-protocol/session-assignment";

export type ChannelAdapterType = SparkChannelAdapter;

export interface IncomingMessage {
  adapter: ChannelAdapterType;
  externalKey: string;
  senderId?: string;
  chatId?: string;
  text: string;
  messageId?: string;
  raw?: unknown;
}

export interface ChannelAdapter {
  readonly id: string;
  readonly type: ChannelAdapterType;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(input: { recipient: string; text: string }): Promise<void>;
}

export interface FeishuAdapterConfig {
  type: "feishu";
  event_mode?: "websocket";
  app_id?: string;
  app_secret?: string;
}

export type InfoflowChatType = "private" | "group";

export type InfoflowGroupPolicy = "disabled" | "allowlist" | "open";

export interface InfoflowAdapterConfig {
  type: "infoflow";
  endpoint?: string;
  app_key?: string;
  app_secret?: string;
  /** Optional Baidu Infoflow app agent id (numeric string), used for some DM APIs. */
  app_agent_id?: string;
  /** WebSocket gateway host for inbound events. */
  ws_gateway?: string;
  /** Prefer websocket inbound; webhook is not implemented in v1. */
  connection_mode?: "websocket";
  /**
   * Private-chat allowlist (sender id or display name). Empty / omitted = allow all
   * private senders (nyakore-aligned).
   */
  allowed_user_ids?: string[];
  /**
   * Group ingress policy. Default when omitted: `disabled`.
   * - disabled: drop all group messages
   * - allowlist: only `allowed_group_ids`
   * - open: accept every group
   */
  group_policy?: InfoflowGroupPolicy;
  /** Used when `group_policy` is `allowlist`. */
  allowed_group_ids?: string[];
}

export type ChannelAdapterConfig = FeishuAdapterConfig | InfoflowAdapterConfig;

export interface ChannelRouteConfig {
  adapter: string;
  recipient: string;
}

export type ChannelUnboundPolicy = "reject" | "create";

export interface ChannelIngressConfig {
  /**
   * Legacy/explicit flag. Runtime treats channel enable as adapter presence:
   * any configured adapter means inbound is on.
   */
  enabled: boolean;
  on_unbound?: ChannelUnboundPolicy;
}

export interface ChannelsConfig {
  adapters: Record<string, ChannelAdapterConfig>;
  routes: Record<string, ChannelRouteConfig>;
  ingress?: ChannelIngressConfig;
}

export interface ResolvedChannelRoute {
  name: string;
  adapterId: string;
  adapterType: ChannelAdapterType;
  recipient: string;
}

export type ChannelNotifyAction = "send" | "list" | "test";

export interface ChannelNotifyInput {
  action: ChannelNotifyAction;
  adapter?: string;
  route?: string;
  recipient?: string;
  text?: string;
}

export interface ChannelNotifyListResult {
  action: "list";
  adapters: Array<{ id: string; type: ChannelAdapterType; running: boolean }>;
  routes: ResolvedChannelRoute[];
}

export interface ChannelNotifySendResult {
  action: "send" | "test";
  adapter: string;
  recipient: string;
  text: string;
}

export type ChannelNotifyResult = ChannelNotifyListResult | ChannelNotifySendResult;

export interface ChannelRegistryOptions {
  config: ChannelsConfig;
  onMessage?: (message: IncomingMessage) => void;
  /** Override transport factory per adapter id (used by tests and production SDK wiring). */
  createTransport?: (
    adapterId: string,
    config: ChannelAdapterConfig,
  ) => ChannelTransport | undefined;
}

export interface ChannelTransport {
  start(onMessage: (raw: unknown) => void): Promise<void>;
  stop(): Promise<void>;
  send(recipient: string, text: string): Promise<void>;
}

export interface FeishuInboundRaw {
  chat_id: string;
  sender_id?: string;
  text: string;
  message_id?: string;
}

export interface InfoflowInboundRaw {
  user_id: string;
  text: string;
  chat_type: InfoflowChatType;
  chat_id?: string;
  message_id?: string;
  sender_name?: string;
}
