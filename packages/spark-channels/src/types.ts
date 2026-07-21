import type { SparkChannelAdapter } from "@zendev-lab/spark-protocol/session-assignment";
import type { ChannelImage, ChannelImageSource } from "./channel-images.ts";
import type { InfoflowAttachment } from "./infoflow-content.ts";
import type {
  ChannelInteractionCapability,
  ChannelInteractionEvent,
  RoutedChannelInteractionEvent,
} from "./interaction.ts";
import type {
  ChannelMessageReference,
  ChannelMessageReferenceSource,
} from "./message-reference.ts";
import type {
  ChannelDeliveryFacts,
  ChannelDeliveryResult,
  ChannelMessageTarget,
  ChannelReplyCapability,
} from "./reply.ts";

export type ChannelAdapterType = SparkChannelAdapter;

export type { ChannelMessageReference, ChannelMessageReferenceSource };

export interface IncomingMessage {
  /** Configured adapter instance that received this message. */
  adapterId?: string;
  /** Opaque provider-account identity that survives local adapter renames. */
  adapterAccountIdentity?: string;
  adapter: ChannelAdapterType;
  externalKey: string;
  senderId?: string;
  senderName?: string;
  chatId?: string;
  text: string;
  messageId?: string;
  /** Structured quote/reply reference; separate from the user reply body. */
  messageReference?: ChannelMessageReference;
  /** Infoflow platform event source (for example MESSAGE_RECEIVE / ALL_MESSAGE_FORWARD). */
  eventType?: string;
  /** Normalized Infoflow payload kind (text, markdown, richtext, mixed, image, file, voice). */
  contentType?: string;
  /** Display-safe attachment facts; never raw bytes or signed download URLs. */
  attachments?: InfoflowAttachment[];
  /** Provider-ready images; source URLs are discarded before this boundary. */
  images?: ChannelImage[];
  /** Display names / ids extracted from AT body parts (Infoflow). */
  mentions?: string[];
  /** True when an AT targeted this bot (when detectable). */
  mentionedSelf?: boolean;
  raw?: unknown;
}

export interface ChannelAdapter {
  readonly id: string;
  readonly type: ChannelAdapterType;
  /** Whether this adapter has a concrete runtime transport in this process. */
  readonly runtimeCapable?: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Replay policy for an ordinary proactive message. Missing means unsafe. */
  messageDeliveryFacts?(target: ChannelMessageTarget): ChannelDeliveryFacts;
  send(input: {
    recipient: string;
    text: string;
    /** Optional only for compatibility callers; durable sends use the registry. */
    deliveryId?: string;
  }): Promise<ChannelDeliveryResult | void>;
  /** Optional richer reply lifecycle used by daemon-owned channel conversations. */
  readonly reply?: ChannelReplyCapability;
  /** Optional image-message capability. */
  readonly image?: ChannelImageCapability;
  /** Optional native ask/button capability. */
  readonly interaction?: ChannelInteractionCapability;
  /** Runtime connection health; process lifecycle alone is not transport liveness. */
  status(): ChannelAdapterStatus;
}

export type ChannelConnectionState =
  | "stopped"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "degraded";

export interface ChannelTransportStatus {
  state: ChannelConnectionState;
  error?: string;
}

export interface ChannelAdapterStatus extends ChannelTransportStatus {
  id: string;
  type: ChannelAdapterType;
  adapterAccountIdentity?: string;
  running: boolean;
}

export interface FeishuAdapterConfig {
  type: "feishu";
  event_mode?: "websocket";
  app_id?: string;
  app_secret?: string;
}

export type InfoflowChatType = "private" | "group";

export type InfoflowGroupPolicy = "disabled" | "allowlist" | "open";

export type InfoflowGroupTrigger = "mention" | "command" | "all";

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
  /** Which allowed group messages become Spark turns. Default: mention. */
  group_trigger?: InfoflowGroupTrigger;
  /** Used when `group_policy` is `allowlist`. */
  allowed_group_ids?: string[];
  /**
   * Custom system-prompt overlay for Infoflow channel sessions.
   * Policy/surface facts are generated in code; this field is operator copy only.
   */
  system_prompt?: string;
}

export type QqbotGroupPolicy = "disabled" | "allowlist" | "open";

export type QqbotGroupTrigger = "mention" | "command" | "all";

export interface QqbotAdapterConfig {
  type: "qqbot";
  /** QQ Open Platform AppID. */
  app_id?: string;
  /** QQ Open Platform AppSecret (client secret). */
  client_secret?: string;
  /** Prefer websocket inbound; webhook is out of scope for v1. */
  connection_mode?: "websocket";
  /**
   * OpenAPI + gateway host. Default: `production` (`api.sgroup.qq.com`).
   * `sandbox` uses `sandbox.api.sgroup.qq.com` (no IP whitelist; sandbox peers only).
   */
  api_environment?: "production" | "sandbox";
  /**
   * Private-chat allowlist (sender openid). Empty / omitted = allow all
   * private senders.
   */
  allowed_user_ids?: string[];
  /**
   * Group ingress policy. Default when omitted: `disabled`.
   * - disabled: drop all group messages
   * - allowlist: only `allowed_group_ids`
   * - open: accept every group
   */
  group_policy?: QqbotGroupPolicy;
  /** Which allowed group messages become Spark turns. Default: mention. */
  group_trigger?: QqbotGroupTrigger;
  /** Used when `group_policy` is `allowlist`. */
  allowed_group_ids?: string[];
  /**
   * Custom system-prompt overlay for QQ Bot channel sessions.
   * Policy/surface facts are generated in code; this field is operator copy only.
   */
  system_prompt?: string;
}

export type ChannelAdapterConfig = FeishuAdapterConfig | InfoflowAdapterConfig | QqbotAdapterConfig;

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
  /** Image-only message. `text`, when present, is a provider-supported caption. */
  image?: ChannelImageSource;
  /** Stable for this explicit one-shot request. */
  deliveryId?: string;
}

export interface ChannelNotifyListResult {
  action: "list";
  adapters: ChannelAdapterStatus[];
  routes: ResolvedChannelRoute[];
}

export interface ChannelNotifySendResult {
  action: "send" | "test";
  adapter: string;
  recipient: string;
  text: string;
  image?: { source: "url" | "data"; mediaType?: string; name?: string };
  /** Present for registry-owned sends; omitted by legacy test/adaptor shims. */
  deliveryId?: string;
  delivery?: ChannelDeliveryResult;
  /** channel.notify is an operator/test side effect, not a durable retry queue. */
  deliverySemantics?: "one-shot";
}

export type ChannelNotifyResult = ChannelNotifyListResult | ChannelNotifySendResult;

export interface ChannelRegistryOptions {
  config: ChannelsConfig;
  onMessage?: (message: IncomingMessage) => void;
  /** Native controls are delivered separately from ordinary text ingress. */
  onInteraction?: (event: RoutedChannelInteractionEvent) => void | Promise<void>;
  /** Override transport factory per adapter id (used by tests and production SDK wiring). */
  createTransport?: (
    adapterId: string,
    config: ChannelAdapterConfig,
  ) => ChannelTransport | undefined;
}

export interface ChannelTransport {
  start(
    onMessage: (raw: unknown) => void,
    onInteraction?: (event: ChannelInteractionEvent) => void | Promise<void>,
  ): Promise<void>;
  stop(): Promise<void>;
  /** Replay policy for an ordinary proactive message. Missing means unsafe. */
  messageDeliveryFacts?(target: ChannelMessageTarget): ChannelDeliveryFacts;
  send(
    recipient: string,
    text: string,
    /** Optional only for compatibility callers; durable sends use the registry. */
    deliveryId?: string,
  ): Promise<ChannelDeliveryResult | void>;
  /** Optional richer reply lifecycle; platform SDK objects remain behind this boundary. */
  readonly reply?: ChannelReplyCapability;
  /** Optional image-message capability. */
  readonly image?: ChannelImageCapability;
  /** Optional native ask/button lifecycle. */
  readonly interaction?: ChannelInteractionCapability;
  status?(): ChannelTransportStatus;
}

export interface ChannelImageSendInput {
  recipient: string;
  image: ChannelImageSource;
  caption?: string;
  deliveryId?: string;
  /** Original platform message id for a passive reply when supported. */
  messageId?: string;
}

export interface ChannelImageCapability {
  sendImage(input: ChannelImageSendInput): Promise<ChannelDeliveryResult | void>;
}

export interface FeishuInboundRaw {
  chat_id: string;
  sender_id?: string;
  text: string;
  message_id?: string;
  message_reference?: ChannelMessageReference;
}

export interface InfoflowInboundRaw {
  user_id: string;
  text: string;
  chat_type: InfoflowChatType;
  chat_id?: string;
  message_id?: string;
  message_reference?: ChannelMessageReference;
  event_type?: string;
  content_type?: string;
  attachments?: InfoflowAttachment[];
  images?: ChannelImage[];
  sender_name?: string;
  mentions?: string[];
  /** Transport-detected self mention after platform ids are still available. */
  mentioned_self?: boolean;
}
